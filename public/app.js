import {
  createElements,
  createState,
  createStatus,
  errorText,
  fetchJson,
  LANG_MODES,
  restorePreferences as restorePrefsInto,
  sanitize,
} from "./app-context.js";
import { createEditor } from "./app-editor.js";
import { createMobileUi } from "./app-mobile.js";
import { createPreview } from "./app-preview.js";
import { createTree } from "./app-tree.js";
import { createWebSocketClient } from "./app-websocket.js";
import { applyI18n, onLangChange, resolveLang, setLang, t } from "./i18n.js";
import {
  isAnchor,
  isExternalUrl,
  isUnsafeScheme,
  resolveRelativePath,
  splitHrefHash,
} from "./link-resolver.js";
import {
  buildUrl,
  currentNavIndex,
  getHashFromUrl,
  getPathFromUrl,
  nextNavIndex,
  seedNavCounter,
} from "./navigation.js";
import { prefs } from "./prefs.js";

/**
 * 画面全体の配線コンテキスト (Issue #78)。
 *
 * **els / state をここで 1 度だけ作る。** モジュール側に持たせるとテストの boot をまたいで
 * 前の jsdom の要素を掴む (理由は `app-context.js` の冒頭)。
 *
 * モジュール間の相互参照は `ctx` 経由の遅延束縛にする。生成順に依存しないので、
 * websocket → document → tree のような循環があっても import が循環しない。
 */
const els = createElements();
const state = createState();
const ctx = { els, state };
ctx.status = createStatus(ctx);
const { setStatus, clearStatus } = ctx.status;

// **モジュールを先に組み立てて ctx に差し込む。** 配線 (wire*) の中で参照されるので、
// 起動シーケンスより前に揃えておく。まだ app.js に残っている責務は、切り出し済みの
// モジュールから同じ形で見えるようオブジェクトにして公開する (段階的分割の足場。
// 分割が終われば createXxx(ctx) の戻り値に置き換わる)。
ctx.document = { loadFile, applyFile, navigateTo };
ctx.preview = createPreview(ctx);
ctx.tree = createTree(ctx);
ctx.editor = createEditor(ctx);
ctx.mobile = createMobileUi(ctx);
ctx.ws = createWebSocketClient(ctx);

// 言語変更のたびに静的 (data-i18n) + 動的 DOM 文言を再適用する (Issue #48)。
// applyLang → setLang の中で発火するため、最初の applyLang より前に購読する。
onLangChange(reapplyDynamicI18n);

restorePreferences();
ctx.preview.applyViewMode(state.viewMode);
ctx.preview.applyThemeMode(state.themeMode);
applyLang(state.langMode);
ctx.preview.initMermaid(state.themeMode);
ctx.preview.wireSystemThemeFollow();
ctx.preview.wireViewToggle();
ctx.preview.wireThemeToggle();
wireLangToggle();
ctx.editor.wireEditActions();
wireCopyPath();
// **登録順を変えない。** sidebar の Esc ハンドラは外部 URL バナーが開いていたら譲る
// 設計で、後から登録される wireKeyboard 側がバナーを閉じる。順序が逆転すると
// 「Esc 1 回で両方閉じる」に変わってしまう。
ctx.mobile.wireSidebar();
ctx.tree.wireTreeToolbar();
ctx.mobile.wireOverflowMenu();
ctx.mobile.wireTocFab();
ctx.mobile.wireTopbarAutohide();
ctx.mobile.wireSidebarSwipe();
ctx.preview.wireTocActions();
wireLinkNavigation();
wireKeyboard();
ctx.editor.wireBeforeUnload();
wireHistoryNavigation();
ctx.preview.wireScrollSync();

init();
ctx.ws.connect();

async function init() {
  // リロード時に history.state.navIndex が残っていれば、それ以上の値で再開
  // （forward 履歴に残る古い entry と衝突しないため）
  seedNavCounter(window.history.state?.navIndex);

  try {
    const tree = await fetchJson("/api/tree");
    ctx.tree.renderTree(tree);
    setStatus("ok", t("status.fileCount", { count: state.fileButtons.size }));

    const initial = chooseInitialFile(tree);
    if (initial) {
      // URL に `#見出し` があれば scroll 対象として渡す（deep-link 復元）
      const hash = getHashFromUrl();
      await navigateTo(initial, { history: "replace", hash });
    } else {
      const p = document.createElement("p");
      p.className = "placeholder";
      // data-i18n を付けて言語切替時に applyI18n が再翻訳できるようにする (Issue #48)
      p.dataset.i18n = "preview.noFiles";
      p.textContent = t("preview.noFiles");
      els.preview.replaceChildren(p);
    }
  } catch (err) {
    setStatus("error", t("status.initFailed", { msg: errorText(err) }));
    els.tree.removeAttribute("aria-busy");
    els.tree.textContent = t("status.loadError", { msg: errorText(err) });
  }
}

function chooseInitialFile(tree) {
  const fromUrl = getPathFromUrl();
  if (fromUrl && state.fileButtons.has(fromUrl)) {
    return fromUrl;
  }
  return findFirstFile(tree);
}

function findFirstFile(node) {
  if (node.type === "file") return node.path;
  for (const child of node.children ?? []) {
    const found = findFirstFile(child);
    if (found) return found;
  }
  return null;
}

async function loadFile(path) {
  return await fetchJson(`/api/file?path=${encodeURIComponent(path)}`);
}

function applyFile(data) {
  state.currentPath = data.path;
  state.currentRaw = data.raw;
  state.currentHtml = sanitize(data.html);
  state.currentSha = data.sha ?? null;
  els.currentPath.textContent = data.path;
  ctx.editor.hideConflict();
  if (state.editing) {
    // applyFile で別ファイルに切替 = 編集解除
    ctx.editor.exitEditMode();
  }
  ctx.preview.renderCurrentFile();
  ctx.tree.highlightSelected(data.path);
  ctx.tree.expandAncestors(data.path);
  ctx.editor.enableEditActions(true);
  ctx.preview.refreshToc();
  ctx.preview.wireTaskCheckboxes();
}

/**
 * 全てのファイル遷移の起点。
 *
 * mode:
 *   "push"    ユーザー操作によるファイル切替（tree クリック / リンククリック）。
 *             history.pushState で履歴を積む
 *   "replace" 初期化・URL からの復元。history.replaceState で履歴は増やさない
 *   "none"    ライブリロード等、履歴も URL も触らない
 *
 * loadFile が失敗した場合は URL も history も触らず status 表示のみ。
 */
// 戻り値: 実際にファイルへ遷移/表示できたら true、編集中の破棄キャンセルや
// 読み込み失敗で遷移しなかったら false (呼び出し側はこれを見て後続処理を分岐できる)。
async function navigateTo(path, { history: mode = "push", hash = null } = {}) {
  if (mode === "push" && !ctx.editor.confirmLeaveEdit()) return false;

  let data;
  try {
    data = await loadFile(path);
  } catch (err) {
    setStatus("error", t("status.openFailed", { path, msg: errorText(err) }));
    return false;
  }

  applyFile(data);
  scrollIntoHash(hash);
  // スマホ表示ではファイル選択後に sidebar overlay を自動で閉じる
  if (mode === "push") ctx.mobile.closeSidebarIfMobile();

  if (mode === "none") {
    setStatus("ok", t("status.showing", { path: data.path }));
    return true;
  }

  const url = buildUrl(data.path, hash);
  const navIndex = mode === "push" ? nextNavIndex() : currentNavIndex();
  const entry = { path: data.path, hash, navIndex };

  if (mode === "push") {
    window.history.pushState(entry, "", url);
  } else {
    window.history.replaceState(entry, "", url);
  }

  setStatus("ok", t("status.showing", { path: data.path }));
  return true;
}

/**
 * hash が指定されていれば、次フレームで該当 ID 要素までスクロールする。
 *
 * - hash が null / 空文字なら何もしない
 * - 編集モード中は preview が隠れているケースがあるため skip（URL/state は維持）
 * - Mermaid 図ありの md では描画完了前なので位置がズレる可能性あり（将来 Issue）
 * - behavior: "auto" (instant) を使う：ファイル切替直後は `renderCurrentFile` で
 *   scrollTop が一旦 0 にリセットされており、そこから "smooth" でスクロールすると
 *   「一瞬先頭が見えてから見出しまで滑る」という 2 段階の挙動になり違和感が出る。
 *   即時ジャンプなら初期位置の見え時間が最小化される。
 */
function scrollIntoHash(hash) {
  if (!hash || state.editing) return;
  requestAnimationFrame(() => {
    const target = document.getElementById(hash);
    if (target) {
      target.scrollIntoView({ behavior: "auto", block: "start" });
    }
  });
}

/**
 * popstate（戻る/進む）に対応する。
 *
 * 編集モード中に popstate が発火し、未保存変更があれば確認ダイアログを出す。
 * Cancel された場合は history.go(delta) で元のエントリにジャンプし戻す。
 * その re-navigation も popstate を発火させるが、`pendingCancelRestore` フラグで
 * 1 回だけ無視して二重 confirm ループを防ぐ。
 */
let pendingCancelRestore = false;
function wireHistoryNavigation() {
  window.addEventListener("popstate", async (ev) => {
    if (pendingCancelRestore) {
      pendingCancelRestore = false;
      return;
    }

    const target = ev.state ?? {
      path: getPathFromUrl(),
      hash: getHashFromUrl(),
      navIndex: currentNavIndex(),
    };

    if (state.editing) {
      if (!ctx.editor.confirmLeaveEdit()) {
        // キャンセル: history.go(delta) で編集中のエントリへ戻す
        // re-push しない（forward 履歴と scroll restoration を壊さないため）
        const delta = currentNavIndex() - target.navIndex;
        if (delta !== 0) {
          pendingCancelRestore = true;
          // history.go が popstate を発火させなかった場合のフォールバック:
          // 次の tick でフラグを必ず解除し、後続の戻る/進むを 1 回飲んでしまうのを防ぐ
          setTimeout(() => {
            pendingCancelRestore = false;
          }, 0);
          window.history.go(delta);
        }
        return;
      }
      ctx.editor.exitEditMode();
    }

    // 到達先 navIndex まで進めておく。次の push は target.navIndex+1 から
    seedNavCounter(target.navIndex);

    if (!target.path) return;
    try {
      const data = await loadFile(target.path);
      applyFile(data);
      scrollIntoHash(target.hash);
      setStatus("ok", t("status.showing", { path: data.path }));
    } catch (err) {
      setStatus("error", t("status.openFailed", { path: target.path, msg: errorText(err) }));
    }
  });
}

function restorePreferences() {
  restorePrefsInto(state);
}

/* ===== UI 言語切替 (Issue #48) ===== */

/**
 * 言語モード (auto | ja | en) を適用する。
 * - resolveLang で実効言語を決め、<html lang> とトグルの押下状態を同期
 * - setLang でメッセージ辞書を切替 → onLangChange 経由で reapplyDynamicI18n が
 *   静的 (data-i18n) + 動的 (JS で組み立てた) 文言を一括再描画する
 */
function applyLang(mode) {
  state.langMode = mode;
  const effective = resolveLang(mode, navigator.language);
  document.documentElement.lang = effective;
  for (const btn of [...els.langButtons, ...els.overflowLangBtns]) {
    btn.setAttribute("aria-pressed", btn.dataset.langMode === mode ? "true" : "false");
  }
  setLang(effective);
}

function wireLangToggle() {
  const onSelect = (mode) => {
    if (!mode || !LANG_MODES.includes(mode)) return;
    if (state.langMode === mode) return;
    applyLang(mode);
    prefs.lang.save(mode);
  };
  for (const btn of [...els.langButtons, ...els.overflowLangBtns]) {
    btn.addEventListener("click", () => onSelect(btn.dataset.langMode));
  }
}

/**
 * 言語変更時に、data-i18n 属性で宣言できない「JS が組み立てた文言」を再適用する。
 * 静的属性は applyI18n が担当。ここではツリーの「＋」ツールチップ・編集ボタン表記・
 * TOC ラベル・開いている新規入力欄など、動的に生成した DOM を現在言語へ更新する。
 */
function reapplyDynamicI18n() {
  applyI18n(document);
  // ツリーの「＋」ボタンのツールチップ (ディレクトリ path / name 入り)
  for (const btn of els.tree.querySelectorAll(".dir-new-btn")) {
    btn.title = t("tree.newFileInDir.title", { path: btn.dataset.dirPath ?? "" });
    btn.setAttribute(
      "aria-label",
      t("tree.newFileInDir.aria", { name: btn.dataset.dirName ?? "" }),
    );
  }
  // 開いているインライン新規ファイル入力欄
  if (state.newFileInput) {
    state.newFileInput.input.placeholder = t("tree.newFileInput.placeholder");
    state.newFileInput.input.setAttribute("aria-label", t("tree.newFileInput.aria"));
  }
  // 編集モードのボタン表記 (applyI18n が data-i18n で編集前ラベルに戻すため、この後に上書き)
  ctx.editor.syncEditButtonLabels();
  // TOC の展開トグル + (表示中なら) 見出しツリーを再描画
  ctx.preview.updateExpandToggleUi();
  if (state.tocVisible) ctx.preview.refreshToc();
  // ステータスは key を保持しない一過性メッセージのため、言語切替時はクリアする
  // (旧言語の文言が残らないように。次の操作で新言語で再表示される。
  //  競合バナー等の操作可能な UI は別要素なので消えない)。
  clearStatus();
}

/* ===== パスコピー (Issue #24, パス自体タップ — Issue #30) ===== */

const COPY_FEEDBACK_MS = 1500;

function wireCopyPath() {
  els.currentPath.addEventListener("click", async () => {
    if (!state.currentPath) return;
    try {
      await copyTextToClipboard(state.currentPath);
      flashCopied();
      setStatus("ok", t("status.pathCopied", { path: state.currentPath }));
    } catch (err) {
      setStatus("error", t("status.copyFailed", { msg: err.message }));
    }
  });
}

/**
 * クリップボードにテキストをコピーする。
 *
 * モダンブラウザでは `navigator.clipboard.writeText` を使うが、これは
 * Secure Context (HTTPS / localhost) でのみ公開される。yomi は LAN 越しに
 * HTTP で公開されるため (例: http://192.168.0.100:3944)、その経路では
 * `navigator.clipboard` が undefined になる。
 *
 * フォールバックとして、非表示 textarea を作って select → execCommand("copy")
 * を使う古典的手法を採用。`execCommand` は deprecated だが、現状すべての
 * 主要ブラウザで動作する (HTTP context でも OK)。将来 execCommand が消えた
 * 場合は、別途 modal でテキスト選択 UI を提供する形に切り替える。
 */
async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
  if (!ok) throw new Error(t("error.copyExec"));
}

let copyResetTimer = null;
function flashCopied() {
  els.currentPath.classList.add("is-copied");
  if (copyResetTimer) clearTimeout(copyResetTimer);
  copyResetTimer = setTimeout(() => {
    els.currentPath.classList.remove("is-copied");
    copyResetTimer = null;
  }, COPY_FEEDBACK_MS);
}

/* ===== リンクナビゲーション ===== */

let pendingExternalUrl = null;

function wireLinkNavigation() {
  els.preview.addEventListener("click", (ev) => {
    const a = ev.target.closest("a");
    if (!a || !els.preview.contains(a)) return;
    const href = a.getAttribute("href");
    if (!href) return;

    // ページ内アンカーは既存挙動 (見出しジャンプ) に任せる
    if (isAnchor(href)) return;

    // Issue #32 / #37: renderer 側で `target="_blank"` を付与した <a>
    // (画像 wrap, PDF rewrite) はブラウザネイティブの新タブ動作に任せる。
    // 左クリックだけでなく中クリック / Ctrl-Cmd-クリック / 右クリックの
    // 「リンクを新しいタブで開く」「リンクアドレスをコピー」もそのまま動く。
    if (a.target === "_blank") return;

    ev.preventDefault();

    // Issue #22: javascript: 以外の危険スキーム (vbscript / file / chrome-extension / data 等) も同じ扱い
    if (isUnsafeScheme(href)) {
      setStatus("error", t("status.blockedLink"));
      return;
    }

    if (isExternalUrl(href)) {
      showExternalLinkBanner(href);
      return;
    }

    navigateInternal(href);
  });

  els.externalLinkCancel.addEventListener("click", () => hideExternalLinkBanner());
  els.externalLinkOpen.addEventListener("click", () => {
    const url = pendingExternalUrl;
    hideExternalLinkBanner();
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  });
}

function navigateInternal(href) {
  if (!state.currentPath) return;

  // `[X](other.md#見出し)` の hash 部分を分離して navigateTo に渡す
  const { path: hrefPath, hash } = splitHrefHash(href);
  const resolved = resolveRelativePath(state.currentPath, hrefPath);
  if (!resolved) {
    setStatus("error", t("status.fileNotFound", { href }));
    return;
  }

  // 拡張子なし fallback: foo → foo.md → foo.markdown → foo.mdx
  const candidates = state.fileButtons.has(resolved)
    ? [resolved]
    : [`${resolved}.md`, `${resolved}.markdown`, `${resolved}.mdx`];

  const hit = candidates.find((c) => state.fileButtons.has(c));
  if (!hit) {
    setStatus("error", t("status.fileNotFound", { href }));
    return;
  }

  navigateTo(hit, { history: "push", hash }).catch((err) => setStatus("error", errorText(err)));
}

function showExternalLinkBanner(url) {
  pendingExternalUrl = url;
  els.externalLinkUrl.textContent = url;
  els.externalLinkUrl.title = url;
  els.externalLinkBanner.hidden = false;
  // 誤クリックで Enter 連打で開いてしまわないように、デフォルトは「閉じる」にフォーカス
  setTimeout(() => els.externalLinkCancel.focus(), 0);
}

function hideExternalLinkBanner() {
  pendingExternalUrl = null;
  els.externalLinkBanner.hidden = true;
  els.externalLinkUrl.textContent = "";
}

/* ===== キーボード ===== */

function wireKeyboard() {
  // Ctrl/Cmd+S で保存。capture phase + ev.code で IME / Caps Lock / 拡張機能干渉に強くする。
  // Shift などのモディファイアが余計に付いていても受ける (Cmd+Shift+S は除外で、Ctrl+S/Cmd+S のみ)。
  document.addEventListener(
    "keydown",
    (ev) => {
      const isSaveKey = ev.code === "KeyS" || ev.key === "s" || ev.key === "S";
      const isModifier = ev.metaKey || ev.ctrlKey;
      if (!isModifier || !isSaveKey || ev.altKey || ev.shiftKey) return;
      if (!state.editing) return;
      ev.preventDefault();
      ev.stopPropagation();
      ctx.editor
        .saveEdit()
        .catch((err) => setStatus("error", t("status.saveFailed", { msg: errorText(err) })));
    },
    { capture: true },
  );

  // Ctrl/Cmd+Shift+O で TOC トグル
  document.addEventListener(
    "keydown",
    (ev) => {
      const isTocKey = ev.code === "KeyO" || ev.key === "o" || ev.key === "O";
      const isModifier = ev.metaKey || ev.ctrlKey;
      if (!isModifier || !isTocKey || !ev.shiftKey || ev.altKey) return;
      if (!state.currentPath || state.editing) return;
      ev.preventDefault();
      ev.stopPropagation();
      ctx.preview.toggleToc();
    },
    { capture: true },
  );

  // Esc で外部 URL バナーを閉じる
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (els.externalLinkBanner.hidden) return;
    ev.preventDefault();
    hideExternalLinkBanner();
  });

  // textarea で Tab を押したら 2 スペース挿入
  els.editor.addEventListener("keydown", (ev) => {
    if (ev.key !== "Tab") return;
    ev.preventDefault();
    const ta = ev.currentTarget;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    ta.value = `${before}  ${after}`;
    ta.selectionStart = ta.selectionEnd = start + 2;
    // input イベントは自動発火しないので明示
    ta.dispatchEvent(new Event("input"));
  });
}
