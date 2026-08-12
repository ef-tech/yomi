import {
  createElements,
  createState,
  createStatus,
  errorText,
  fetchJson,
  fetchTree,
  LANG_MODES,
  MOBILE_MEDIA_QUERY,
  restorePreferences,
} from "./app-context.js";
import { createDocument } from "./app-document.js";
import { createEditor } from "./app-editor.js";
import { createImageDownload } from "./app-images.js";
import { createMobileUi } from "./app-mobile.js";
import { isTopOverlay, shortcutsBlocked } from "./app-overlays.js";
import { createPreview } from "./app-preview.js";
import { createQuickOpen } from "./app-quick-open.js";
import { createTree } from "./app-tree.js";
import { createWebSocketClient } from "./app-websocket.js";
import { applyI18n, onLangChange, resolveLang, setLang, t } from "./i18n.js";
import { getHashFromUrl, seedNavCounter } from "./navigation.js";
import { prefs } from "./prefs.js";

/**
 * yomi のブラウザ側エントリポイント。
 *
 * **このファイルの責務は「画面初期化とモジュール結線」だけ** (Issue #78)。機能は
 * 責務ごとのモジュールに分かれている:
 *
 * | モジュール | 担当 |
 * |---|---|
 * | `app-context.js` | els / state / 定数 / 共有ユーティリティ (fetchJson・sanitize・status) |
 * | `app-tree.js` | 左ツリー、ディレクトリ開閉、新規 md 作成 |
 * | `app-document.js` | ファイル読込、遷移 (`navigateTo`)、履歴、リンク、パスコピー |
 * | `app-editor.js` | 編集モード、保存、競合バナーと差分ダイアログ |
 * | `app-preview.js` | Mermaid、表示モード、テーマ、スクロール同期、TOC、タスクリスト |
 * | `app-mobile.js` | sidebar overlay、⋮ メニュー、FAB、topbar 自動 hide、スワイプ |
 * | `app-quick-open.js` | クイックオープン (`Ctrl/Cmd+P` のファイル検索) |
 * | `app-images.js` | 記事の参照画像を zip でダウンロード |
 * | `app-overlays.js` | 重なったオーバーレイの優先順位 (`Esc` とショートカットの門番) |
 * | `app-websocket.js` | ライブリロード |
 *
 * ここに残しているのは、どのモジュールにも属さない横断的なもの
 * (UI 言語切替・グローバルキーボードショートカット・起動シーケンス) だけ。
 *
 * **els / state はここで 1 度だけ作る。** モジュール側に持たせるとテストの boot をまたいで
 * 前の jsdom の要素を掴む (理由は `app-context.js` の冒頭)。
 *
 * モジュール間の相互参照は `ctx` 経由の遅延束縛にする。document ⇄ preview ⇄ editor ⇄ tree
 * は循環しているが、`ctx` を挟むので import は循環しない。
 */
const els = createElements();
const state = createState();
// mobileQuery は横断的関心事なので els / state と同格に置く (status の内部詳細ではない)。
//
// **型は完成形 (`Ctx`) で受ける。** ここでは 3 つしか入っていないが、直後の
// `Object.assign` と `ctx.xxx = createXxx(ctx)` で埋まる (このファイル冒頭の遅延束縛)。
// 途中の部分的な形を型にすると、各モジュールが受け取る `ctx` の型と食い違う。
const ctx = /** @type {import("./app-context.js").Ctx} */ (
  /** @type {unknown} */ ({ els, state, mobileQuery: window.matchMedia(MOBILE_MEDIA_QUERY) })
);
Object.assign(ctx, createStatus(ctx));
const { setStatus, clearStatus } = ctx;

// **モジュールを先に全部組み立ててから配線する。** 互いを `ctx` 経由で呼ぶので、
// 生成順は関係ない (document ⇄ preview ⇄ editor ⇄ tree は循環している)。
// 各モジュールは生成時に副作用を持たず、DOM への接続は下の wire* で行う。
ctx.document = createDocument(ctx);
ctx.preview = createPreview(ctx);
ctx.tree = createTree(ctx);
ctx.editor = createEditor(ctx);
ctx.mobile = createMobileUi(ctx);
ctx.ws = createWebSocketClient(ctx);
ctx.quickOpen = createQuickOpen(ctx);
ctx.images = createImageDownload(ctx);

// 言語変更のたびに静的 (data-i18n) + 動的 DOM 文言を再適用する (Issue #48)。
// applyLang → setLang の中で発火するため、最初の applyLang より前に購読する。
onLangChange(reapplyDynamicI18n);

restorePreferences(state);
ctx.preview.applyViewMode(state.viewMode);
ctx.preview.applyThemeMode(state.themeMode);
applyLang(state.langMode);
ctx.preview.initMermaid(state.themeMode);
ctx.preview.wireSystemThemeFollow();
ctx.preview.wireViewToggle();
ctx.preview.wireThemeToggle();
wireLangToggle();
ctx.editor.wireEditActions();
ctx.document.wireCopyPath();
// **登録順に依存しない (Issue #112)。** 最前面の判定は `app-overlays.js` が
// 宣言された重なり順で行い、Esc は「誰かが消費済みなら譲る」(`defaultPrevented`)
// で 1 回 1 枚に絞る。どちらも登録順を見ないので、ここを並べ替えても優先順位は
// 変わらない（3 通りに並べ替えて既存テストが green のままであることを実測した）。
ctx.mobile.wireSidebar();
ctx.tree.wireTreeToolbar();
ctx.mobile.wireOverflowMenu();
ctx.mobile.wireTocFab();
ctx.mobile.wireTopbarAutohide();
ctx.mobile.wireSidebarSwipe();
ctx.preview.wireTocActions();
ctx.document.wireLinkNavigation();
ctx.quickOpen.wire();
ctx.images.wire();
ctx.editor.wireConflictDiff();
wireKeyboard();
ctx.editor.wireBeforeUnload();
ctx.document.wireHistoryNavigation();
ctx.preview.wireScrollSync();

init();
ctx.ws.connect();

async function init() {
  // リロード時に history.state.navIndex が残っていれば、それ以上の値で再開
  // （forward 履歴に残る古い entry と衝突しないため）
  seedNavCounter(window.history.state?.navIndex);

  try {
    // **版も受け取る (Issue #126)。** これが初期値になり、以降の `tree` 通知を
    // 差分で当てられるかどうかの基準になる
    const { root: tree, gen } = await fetchTree();
    ctx.tree.renderTree(tree, gen);
    setStatus("ok", t("status.fileCount", { count: state.fileButtons.size }));

    const initial = ctx.document.chooseInitialFile(tree);
    if (initial) {
      // URL に `#見出し` があれば scroll 対象として渡す（deep-link 復元）
      const hash = getHashFromUrl();
      await ctx.document.navigateTo(initial, { history: "replace", hash });
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

/* ===== UI 言語切替 (Issue #48) ===== */

/**
 * 言語モード (auto | ja | en) を適用する。
 * - resolveLang で実効言語を決め、<html lang> とトグルの押下状態を同期
 * - setLang でメッセージ辞書を切替 → onLangChange 経由で reapplyDynamicI18n が
 *   静的 (data-i18n) + 動的 (JS で組み立てた) 文言を一括再描画する
 */
/**
 * @param {string} mode
 * @returns {void}
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
  /** @param {string | null | undefined} mode */
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
  for (const el of els.tree.querySelectorAll(".dir-new-btn")) {
    const btn = /** @type {HTMLElement} */ (el);
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
  // 競合の差分は件数と「N 行省略」を組み立てているので、開いていれば作り直す
  // (data-i18n では戻せない = applyI18n の対象外)
  if (ctx.editor.isConflictDiffOpen()) ctx.editor.renderConflictDiff();
  // ステータスは key を保持しない一過性メッセージのため、言語切替時はクリアする
  // (旧言語の文言が残らないように。次の操作で新言語で再表示される。
  //  競合バナー等の操作可能な UI は別要素なので消えない)。
  clearStatus();
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
      // **先にキーを奪う。** 抑止するときも奪わないと「名前を付けてページを保存」へ抜ける
      ev.preventDefault();
      ev.stopPropagation();
      // **全画面モーダルの裏で走らせない (Issue #112)。** 競合ダイアログは
      // 「保存が失敗した」直後に出るものなので、その上から保存が走るのは筋が通らない
      if (shortcutsBlocked(els)) return;
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
      // 先にキーを奪う（抑止するときも同じ。理由は Ctrl/Cmd+S と同じ）
      ev.preventDefault();
      ev.stopPropagation();
      // 全画面モーダルの裏で TOC を開かない (Issue #112)
      if (shortcutsBlocked(els)) return;
      ctx.preview.toggleToc();
    },
    { capture: true },
  );

  // Esc で外部 URL バナーを閉じる。最前面のときだけ (Issue #112)
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!isTopOverlay("externalLinkBanner", els)) return;
    // もう誰かが Esc を消費していたら譲る (Issue #112)
    if (ev.defaultPrevented) return;
    ev.preventDefault();
    ctx.document.hideExternalLinkBanner();
  });

  // textarea で Tab を押したら 2 スペース挿入
  els.editor.addEventListener("keydown", (ev) => {
    if (ev.key !== "Tab") return;
    ev.preventDefault();
    const ta = /** @type {HTMLTextAreaElement} */ (ev.currentTarget);
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
