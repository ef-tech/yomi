import DOMPurify from "https://cdn.jsdelivr.net/npm/dompurify@3/+esm";
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
import { applyI18n, ERROR_CODE_KEYS, onLangChange, resolveLang, setLang, t } from "./i18n.js";
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
import { completeMarkdownFileName, joinTreePath } from "./new-file.js";
import { prefs } from "./prefs.js";
import { findHeadingLines, mapScrollTop } from "./scroll-sync.js";
import { toggleTaskInMarkdown } from "./task-list.js";
import { buildTocTree } from "./toc.js";
import { collapseAllDirs, expandAllDirs, isTreeToolbarEnabled } from "./tree-toolbar.js";

const els = {
  sidebar: document.getElementById("sidebar"),
  sidebarBackdrop: document.getElementById("sidebar-backdrop"),
  menuBtn: document.getElementById("menu-btn"),
  tree: document.getElementById("tree"),
  // ツリーツールバー (Issue #41)
  treeExpandAll: document.getElementById("tree-expand-all"),
  treeCollapseAll: document.getElementById("tree-collapse-all"),
  // 新規 md 作成 (Issue #6)
  treeNewFile: document.getElementById("tree-new-file"),
  preview: document.getElementById("preview"),
  source: document.getElementById("source"),
  editor: document.getElementById("editor"),
  contentBody: document.getElementById("content-body"),
  status: document.getElementById("status"),
  currentPath: document.getElementById("current-path"),
  dirtyIndicator: document.getElementById("dirty-indicator"),
  // ⋮ overflow menu (Issue #30, スマホ専用)
  overflowBtn: document.getElementById("overflow-btn"),
  overflowMenu: document.getElementById("overflow-menu"),
  overflowEdit: document.getElementById("overflow-edit"),
  overflowThemeBtns: Array.from(document.querySelectorAll(".overflow-theme-btn")),
  overflowViewBtns: Array.from(document.querySelectorAll(".overflow-view-btn")),
  // FAB 目次 (Issue #30, スマホ専用)
  tocFab: document.getElementById("toc-fab"),
  editBtn: document.getElementById("edit-btn"),
  discardBtn: document.getElementById("discard-btn"),
  conflictBanner: document.getElementById("conflict-banner"),
  conflictTakeServer: document.getElementById("conflict-take-server"),
  conflictOverwrite: document.getElementById("conflict-overwrite"),
  conflictDismiss: document.getElementById("conflict-dismiss"),
  toggleButtons: Array.from(document.querySelectorAll(".view-toggle-btn")),
  themeButtons: Array.from(document.querySelectorAll(".theme-toggle-btn")),
  // UI 言語トグル (Issue #48)
  langButtons: Array.from(document.querySelectorAll(".lang-toggle-btn")),
  overflowLangBtns: Array.from(document.querySelectorAll(".overflow-lang-btn")),
  // TOC
  tocBtn: document.getElementById("toc-btn"),
  tocPanel: document.getElementById("toc-panel"),
  tocList: document.getElementById("toc-list"),
  tocClose: document.getElementById("toc-close"),
  tocExpandToggle: document.getElementById("toc-expand-toggle"),
  // 外部 URL 警告バナー
  externalLinkBanner: document.getElementById("external-link-banner"),
  externalLinkUrl: document.getElementById("external-link-url"),
  externalLinkCancel: document.getElementById("external-link-cancel"),
  externalLinkOpen: document.getElementById("external-link-open"),
};

/**
 * DOMPurify による innerHTML サニタイズ設定 (Issue #21)。
 *
 * marked 出力の標準 HTML + GFM 拡張 (table / task list / code) + Mermaid 用
 * `<pre class="mermaid">` を保持しつつ、悪意ある md に含まれ得る:
 *   - <script> / <object> / <iframe> / <embed> / <frame> 系
 *   - inline event handler (onerror / onload / onclick 等)
 *   - <a href="javascript:..."> / <a href="vbscript:..."> 等の危険スキーム
 *   - <svg> 内の <script> や <foreignObject> 経由の script
 * を除去する。
 *
 * Mermaid 図は `<pre class="mermaid">` のテキストを mermaid.run() が後から
 * SVG に変換する。Mermaid 側は securityLevel: "strict" で初期化されており、
 * Mermaid 自身のサニタイズ層に依存する (DOMPurify はテキスト段階のみ通過)。
 */
const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  ADD_ATTR: ["target", "rel"],
  // data-* 属性 (data-task-index 等) は DOMPurify デフォルトで保持。
  // ただし data-i18n* は禁止する (Issue #48): プレビュー内の md に紛れ込むと
  // applyI18n(document) が言語切替時にその要素の textContent/属性を辞書値で
  // 上書きしてしまうため、i18n 機構がユーザーコンテンツに漏れないようにする。
  FORBID_ATTR: ["data-i18n", "data-i18n-title", "data-i18n-aria-label", "data-i18n-placeholder"],
};

function sanitize(html) {
  return DOMPurify.sanitize(html ?? "", SANITIZE_CONFIG);
}

const VIEW_MODES = ["preview", "split", "md"];
const DEFAULT_VIEW_MODE = "preview";

/**
 * スマホ判定 (Issue #25)。767px 以下を sidebar overlay モードとする。
 * 初期化順序の関係で wireSidebar より前に評価したいため、ここで宣言。
 */
const MOBILE_QUERY = window.matchMedia("(max-width: 767px)");

const THEME_MODES = ["auto", "light", "dark"];
const DEFAULT_THEME_MODE = "auto";

// UI 言語モード (Issue #48): auto はブラウザ言語に追従、ja / en は固定
const LANG_MODES = ["auto", "ja", "en"];
const DEFAULT_LANG_MODE = "auto";

const TOC_EXPAND_LEVELS = ["h3", "h6"];
const DEFAULT_TOC_EXPAND_LEVEL = "h3";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function effectiveTheme(mode) {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  return darkQuery.matches ? "dark" : "light";
}

function initMermaid(mode) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: effectiveTheme(mode) === "dark" ? "dark" : "default",
  });
}

darkQuery.addEventListener("change", () => {
  if (state.themeMode !== "auto") return;
  initMermaid(state.themeMode);
  if (state.currentHtml && state.viewMode !== "md") {
    renderCurrentFile();
  }
});

const state = {
  /** path -> tree-item ボタン要素 */
  fileButtons: new Map(),
  /** path -> { button, ul } (ディレクトリの開閉に使用) */
  dirNodes: new Map(),
  /** 開いているディレクトリ path のセット */
  openDirs: new Set([""]),
  /** 現在表示中のファイル path */
  currentPath: null,
  /** 現在のファイル内容 */
  currentRaw: "",
  currentHtml: "",
  /** 直近 GET / POST 時のサーバ側 sha (Lost Update 検知のベース) */
  currentSha: null,
  /** 表示モード: preview | split | md */
  viewMode: DEFAULT_VIEW_MODE,
  /** テーマモード: auto | light | dark */
  themeMode: DEFAULT_THEME_MODE,
  /** UI 言語モード: auto | ja | en (localStorage 永続、Issue #48) */
  langMode: DEFAULT_LANG_MODE,
  /** 編集モード中かどうか */
  editing: false,
  /** 編集中で未保存の差分があるかどうか */
  dirty: false,
  /** TOC パネルが表示中か (localStorage 永続化) */
  tocVisible: false,
  /** TOC の展開レベル: "h3" (H1-H3) / "h6" (H1-H6) */
  tocExpandLevel: DEFAULT_TOC_EXPAND_LEVEL,
  /** 編集モード進入時に TOC が開いていたら、終了時に復元するためのフラグ */
  tocSuspended: false,
  /** md モード時に TOC ボタン押下で一時的に preview 切替したかのフラグ (戻すため) */
  tocPreviewOverride: false,
  /** path -> button 要素 (現在地ハイライト用) */
  tocEntries: new Map(),
  /** IntersectionObserver (再構築のたびに破棄して作り直す) */
  tocObserver: null,
  /** Issue #9: split mode のスクロール同期 ON/OFF (デフォルト ON) */
  scrollSyncEnabled: true,
  /** Issue #6: 表示中の新規ファイル名インライン入力 { li, input } (非表示時は null) */
  newFileInput: null,
};

// スマホの toast 表示タイマー (setStatus / clearStatus で共有)。startup の
// applyLang が clearStatus を呼ぶため、TDZ 回避に init シーケンスより前で宣言する。
let statusToastTimer = null;

// 言語変更のたびに静的 (data-i18n) + 動的 DOM 文言を再適用する (Issue #48)。
// applyLang → setLang の中で発火するため、最初の applyLang より前に購読する。
onLangChange(reapplyDynamicI18n);

restorePreferences();
applyViewMode(state.viewMode);
applyThemeMode(state.themeMode);
applyLang(state.langMode);
initMermaid(state.themeMode);
wireViewToggle();
wireThemeToggle();
wireLangToggle();
wireEditActions();
wireCopyPath();
wireSidebar();
wireTreeToolbar();
wireOverflowMenu();
wireTocFab();
wireTopbarAutohide();
wireSidebarSwipe();
wireTocActions();
wireLinkNavigation();
wireKeyboard();
wireBeforeUnload();
wireHistoryNavigation();
wireScrollSync();
init();
connectLiveReload();

async function init() {
  // リロード時に history.state.navIndex が残っていれば、それ以上の値で再開
  // （forward 履歴に残る古い entry と衝突しないため）
  seedNavCounter(window.history.state?.navIndex);

  try {
    const tree = await fetchJson("/api/tree");
    renderTree(tree);
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

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data.code;
    err.payload = data;
    throw err;
  }
  return data;
}

/**
 * fetch エラーを表示用文字列に変換する (Issue #48)。
 * サーバが返した code を翻訳キーに対応づけ、未知 code / code 無しは
 * サーバの error 文字列 (err.message) にフォールバックする。
 */
function errorText(err) {
  const key = err?.code ? ERROR_CODE_KEYS[err.code] : undefined;
  return key ? t(key) : (err?.message ?? String(err));
}

function renderTree(root) {
  state.fileButtons.clear();
  state.dirNodes.clear();
  els.tree.removeAttribute("aria-busy");
  // 起動時プレースホルダ "読み込み中…" の data-i18n を除去する (Issue #48)。
  // これを残すと、言語切替時の applyI18n() が #tree.textContent を loading 文言で
  // 上書きし、描画済みのツリー (ファイル/ディレクトリ) が消えてしまう。
  els.tree.removeAttribute("data-i18n");
  els.tree.innerHTML = "";

  const ul = document.createElement("ul");
  for (const child of root.children ?? []) {
    ul.appendChild(renderNode(child));
  }
  els.tree.appendChild(ul);
  updateTreeToolbarState();
}

function renderNode(node) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tree-item is-${node.type}`;
  button.title = node.path;

  const icon = document.createElement("span");
  icon.className = "icon";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = node.name;
  button.appendChild(icon);
  button.appendChild(name);
  li.appendChild(button);

  if (node.type === "dir") {
    const ul = document.createElement("ul");
    for (const child of node.children ?? []) {
      ul.appendChild(renderNode(child));
    }
    li.appendChild(ul);
    state.dirNodes.set(node.path, { button, ul });

    const isOpen = state.openDirs.has(node.path);
    setDirOpen(button, ul, isOpen);

    button.addEventListener("click", () => {
      const open = !button.classList.contains("is-open");
      setDirOpen(button, ul, open);
      if (open) state.openDirs.add(node.path);
      else state.openDirs.delete(node.path);
      saveOpenDirs();
    });

    // Issue #6: hover で表示される「+」(このディレクトリの子として新規 md)
    // Issue #44: --depth で truncate された境界ディレクトリ (中身を読み込んでいない)
    // には「+」を出さない。出すと深さ超過の場所にファイルが作られ、直後のツリー
    // 再取得 (同じ深さ制限) に現れず "消えた" ように見える + 監視もされないため。
    // 通常モードでは pruneEmpty により dir は必ず子を持つので、この条件は常に真。
    const hasLoadedChildren = (node.children?.length ?? 0) > 0;
    if (hasLoadedChildren) {
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "dir-new-btn";
      addBtn.textContent = "＋";
      // 言語切替時に再翻訳できるよう path / name を data 属性で保持 (reapplyDynamicI18n)
      addBtn.dataset.dirPath = node.path;
      addBtn.dataset.dirName = node.name;
      addBtn.title = t("tree.newFileInDir.title", { path: node.path });
      addBtn.setAttribute("aria-label", t("tree.newFileInDir.aria", { name: node.name }));
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openNewFileInput(node.path, addBtn);
      });
      li.insertBefore(addBtn, ul);
    }
  } else {
    state.fileButtons.set(node.path, button);
    button.addEventListener("click", () => {
      navigateTo(node.path, { history: "push" }).catch((err) => {
        setStatus("error", errorText(err));
      });
    });
  }

  return li;
}

function setDirOpen(button, ul, open) {
  button.classList.toggle("is-open", open);
  ul.style.display = open ? "" : "none";
}

/* ===== ツリーツールバー (Issue #41) ===== */

/**
 * ディレクトリが 1 つもない間はツールバーを無効化する。
 * 初期 HTML は disabled で始まり、renderTree のたびに再評価する
 * (読み込み中・読み込み失敗・フラット構成では押せない)。
 */
function updateTreeToolbarState() {
  const enabled = isTreeToolbarEnabled(state.dirNodes.size);
  els.treeExpandAll.disabled = !enabled;
  els.treeCollapseAll.disabled = !enabled;
  // 新規作成はルート直下に作れるため、ツリーが一度でも描画されたら常に有効 (Issue #6)
  els.treeNewFile.disabled = false;
}

function wireTreeToolbar() {
  els.treeExpandAll.addEventListener("click", () => {
    state.openDirs = expandAllDirs(state.dirNodes.keys());
    for (const { button, ul } of state.dirNodes.values()) {
      setDirOpen(button, ul, true);
    }
    saveOpenDirs();
  });

  els.treeCollapseAll.addEventListener("click", () => {
    // 初期状態 (ルート直下のみ表示) に戻す
    state.openDirs = collapseAllDirs();
    for (const { button, ul } of state.dirNodes.values()) {
      setDirOpen(button, ul, false);
    }
    saveOpenDirs();
  });

  els.treeNewFile.addEventListener("click", () => {
    openNewFileInput("", els.treeNewFile);
  });
}

/* ===== 新規 Markdown ファイル作成 (Issue #6) ===== */

/**
 * 新規ファイル名のインライン入力をツリーに表示する。
 * dirPath="" はルート直下、それ以外はそのディレクトリの子として作成する。
 * Enter で確定、Esc / フォーカス喪失でキャンセル。
 * trigger は呼び出し元のボタン (ツールバー / ディレクトリの「＋」)。入力欄を
 * 閉じたときにフォーカスをここへ戻し、キーボード利用者がツリー内の位置を失わないようにする。
 */
function openNewFileInput(dirPath, trigger = null) {
  closeNewFileInput();

  // 挿入先の <ul>: ルートはツリー直下、ディレクトリはその子リスト
  let parentUl;
  if (dirPath) {
    const dirNode = state.dirNodes.get(dirPath);
    if (!dirNode) return;
    // 閉じているディレクトリは開いてから入力欄を見せる
    setDirOpen(dirNode.button, dirNode.ul, true);
    state.openDirs.add(dirPath);
    saveOpenDirs();
    parentUl = dirNode.ul;
  } else {
    parentUl = els.tree.querySelector("ul");
    if (!parentUl) return;
  }

  const li = document.createElement("li");
  li.className = "tree-new-li";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tree-new-input";
  input.placeholder = t("tree.newFileInput.placeholder");
  input.setAttribute("aria-label", t("tree.newFileInput.aria"));
  li.appendChild(input);
  parentUl.prepend(li);
  state.newFileInput = { li, input, trigger };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitNewFile(input.value, dirPath);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeNewFileInput();
    }
  });
  // フォーカスが外れたらキャンセル (Enter 確定時は submitNewFile が先に閉じる)
  input.addEventListener("blur", () => closeNewFileInput());
  input.focus();
}

function closeNewFileInput() {
  if (!state.newFileInput) return;
  const { li, trigger } = state.newFileInput;
  state.newFileInput = null;
  li.remove();
  // フォーカスをトリガーの「＋」へ戻す。ツリー再描画でトリガーが DOM から外れた
  // 場合 (作成成功時など) は戻さない。成功時は呼び出し側が editor にフォーカスする。
  if (trigger?.isConnected) trigger.focus();
}

/**
 * 入力名を補完して POST /api/file/create → ツリー再取得 → 新規ファイルを
 * 編集モードで開く。失敗 (409 / 400) は status にエラー表示する。
 */
async function submitNewFile(rawName, dirPath) {
  const name = completeMarkdownFileName(rawName);
  if (name === null) {
    setStatus("error", t("status.invalidName"));
    return;
  }
  const path = joinTreePath(dirPath, name);
  closeNewFileInput();

  try {
    const created = await fetchJson("/api/file/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    // 自己保存マークで watcher は発火しないため、自分でツリーを更新する
    const tree = await fetchJson("/api/tree");
    renderTree(tree);
    const moved = await navigateTo(created.path, { history: "push" });
    if (!moved) {
      // 編集中に破棄をキャンセルした等で遷移がブロックされた場合、ファイルは
      // 作成済みだが古いエディタは触らない (誤ったキャレット移動・状態表示を避ける)
      setStatus("ok", t("status.createdNotOpened", { path: created.path }));
      return;
    }
    if (!state.editing) enterEditMode();
    els.editor.setSelectionRange(0, 0);
    setStatus("ok", t("status.created", { path: created.path }));
  } catch (err) {
    setStatus("error", t("status.createFailed", { path, msg: errorText(err) }));
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
  hideConflict();
  if (state.editing) {
    // applyFile で別ファイルに切替 = 編集解除
    exitEditMode();
  }
  renderCurrentFile();
  highlightSelected(data.path);
  expandAncestors(data.path);
  enableEditActions(true);
  refreshToc();
  wireTaskCheckboxes();
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
  if (mode === "push" && !confirmLeaveEdit()) return false;

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
  if (mode === "push") closeSidebarIfMobile();

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
      if (!confirmLeaveEdit()) {
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
      exitEditMode();
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

function renderCurrentFile() {
  els.preview.innerHTML = state.currentHtml;
  els.source.textContent = state.currentRaw;
  els.preview.scrollTop = 0;
  els.source.scrollTop = 0;
  if (state.viewMode !== "md") {
    renderMermaid()
      .catch(() => {})
      .finally(() => rebuildScrollSyncPairs());
  } else {
    rebuildScrollSyncPairs();
  }
}

async function renderMermaid() {
  const nodes = els.preview.querySelectorAll("pre.mermaid");
  if (nodes.length === 0) return;
  try {
    await mermaid.run({ nodes });
  } catch (err) {
    console.error("Mermaid render error:", err);
    setStatus("error", t("status.mermaidError", { msg: err.message ?? err }));
  }
}

/* ===== Issue #9: split mode スクロール同期 ===== */

// pair: { sourceY: number, previewY: number } の配列 (sourceY 昇順)
let scrollSyncPairs = [];
let scrollSyncing = false;

function rebuildScrollSyncPairs() {
  scrollSyncPairs = [];
  if (!state.currentRaw) return;
  const headingLines = findHeadingLines(state.currentRaw);
  if (headingLines.length === 0) return;
  // preview 側の data-line 付き要素を line→Y で索引化
  const previewHeadings = els.preview.querySelectorAll("[data-line]");
  const previewLineToY = new Map();
  for (const el of previewHeadings) {
    const line = Number(el.dataset.line);
    if (Number.isFinite(line)) previewLineToY.set(line, el.offsetTop);
  }
  // source 側の行 → Y の換算 (scrollHeight / 全行数 で line 高さを推定)
  const totalLines = state.currentRaw.split("\n").length;
  if (totalLines <= 0 || els.source.scrollHeight <= 0) return;
  const lineHeightPx = els.source.scrollHeight / totalLines;

  const pairs = [];
  for (const line of headingLines) {
    const previewY = previewLineToY.get(line);
    if (previewY === undefined) continue;
    const sourceY = (line - 1) * lineHeightPx;
    pairs.push({ sourceY, previewY });
  }
  pairs.sort((a, b) => a.sourceY - b.sourceY);
  scrollSyncPairs = pairs;
}

function isScrollSyncActive() {
  return state.viewMode === "split" && !state.editing && state.scrollSyncEnabled;
}

function onSourceScroll() {
  if (scrollSyncing || !isScrollSyncActive()) return;
  if (scrollSyncPairs.length === 0) return;
  scrollSyncing = true;
  const pairs = scrollSyncPairs.map((p) => ({ from: p.sourceY, to: p.previewY }));
  els.preview.scrollTop = mapScrollTop(els.source.scrollTop, pairs);
  requestAnimationFrame(() => {
    scrollSyncing = false;
  });
}

function onPreviewScroll() {
  if (scrollSyncing || !isScrollSyncActive()) return;
  if (scrollSyncPairs.length === 0) return;
  scrollSyncing = true;
  const pairs = scrollSyncPairs
    .map((p) => ({ from: p.previewY, to: p.sourceY }))
    .sort((a, b) => a.from - b.from);
  els.source.scrollTop = mapScrollTop(els.preview.scrollTop, pairs);
  requestAnimationFrame(() => {
    scrollSyncing = false;
  });
}

function wireScrollSync() {
  els.source.addEventListener("scroll", onSourceScroll, { passive: true });
  els.preview.addEventListener("scroll", onPreviewScroll, { passive: true });
}

function highlightSelected(path) {
  for (const [p, btn] of state.fileButtons) {
    btn.classList.toggle("is-selected", p === path);
  }
}

function expandAncestors(path) {
  const segments = path.split("/");
  segments.pop();
  let acc = "";
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg;
    state.openDirs.add(acc);
    const node = state.dirNodes.get(acc);
    if (node) setDirOpen(node.button, node.ul, true);
  }
  saveOpenDirs();
}

function setStatus(kind, text) {
  els.status.textContent = text;
  els.status.classList.remove("is-ok", "is-error", "is-toast");
  if (kind === "ok") els.status.classList.add("is-ok");
  else if (kind === "error") els.status.classList.add("is-error");
  // スマホでは toast 表示 (Issue #30): CSS animation 完了後に class を除去
  if (MOBILE_QUERY.matches && text) {
    els.status.classList.add("is-toast");
    if (statusToastTimer) clearTimeout(statusToastTimer);
    statusToastTimer = setTimeout(() => {
      els.status.classList.remove("is-toast");
      statusToastTimer = null;
    }, 3000);
  }
}

function restorePreferences() {
  const open = prefs.openDirs.load();
  if (open) state.openDirs = new Set([...open, ""]);

  const view = prefs.viewMode.load();
  if (view && VIEW_MODES.includes(view)) state.viewMode = view;

  const theme = prefs.themeMode.load();
  if (theme && THEME_MODES.includes(theme)) state.themeMode = theme;

  // Issue #48: UI 言語モード (auto|ja|en)。未保存/不正値はデフォルト auto を維持
  const lang = prefs.lang.load();
  if (lang && LANG_MODES.includes(lang)) state.langMode = lang;

  const tocVis = prefs.tocVisible.load();
  if (tocVis === true) state.tocVisible = true;

  const tocLv = prefs.tocExpandLevel.load();
  if (tocLv && TOC_EXPAND_LEVELS.includes(tocLv)) state.tocExpandLevel = tocLv;

  // Issue #9: scrollSync は load 値が null (未保存) ならデフォルト true を維持
  const ss = prefs.scrollSync.load();
  if (ss === false) state.scrollSyncEnabled = false;
}

function saveOpenDirs() {
  prefs.openDirs.save([...state.openDirs]);
}

function saveViewMode() {
  prefs.viewMode.save(state.viewMode);
}

/* ===== 表示モード切替 ===== */

function wireViewToggle() {
  for (const btn of els.toggleButtons) {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      if (!mode || !VIEW_MODES.includes(mode)) return;
      if (state.viewMode === mode) return;
      // ユーザが手動で viewMode を変えたなら、TOC による一時的な preview override は破棄
      // (後から TOC を閉じても、ユーザの選択を尊重する)
      state.tocPreviewOverride = false;
      applyViewMode(mode);
      saveViewMode();
      if (state.currentHtml && mode !== "md") {
        renderMermaid().catch(() => {});
      }
    });
  }
}

function applyViewMode(mode) {
  state.viewMode = mode;
  els.contentBody.dataset.mode = mode;
  for (const btn of els.toggleButtons) {
    const active = btn.dataset.mode === mode;
    btn.setAttribute("aria-selected", active ? "true" : "false");
  }
  // Issue #30: スマホ用 overflow menu 内の表示モードボタンも同期
  for (const btn of els.overflowViewBtns) {
    const active = btn.dataset.mode === mode;
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  }
  // Issue #9: split に切り替わる/中身が再レイアウトされるタイミングで pair を再構築
  // (DOM 反映待ちのため次フレーム)
  if (mode === "split") {
    requestAnimationFrame(() => rebuildScrollSyncPairs());
  }
}

/* ===== テーマ切替 ===== */

function wireThemeToggle() {
  for (const btn of els.themeButtons) {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.themeMode;
      if (!mode || !THEME_MODES.includes(mode)) return;
      if (state.themeMode === mode) return;
      applyThemeMode(mode);
      saveThemeMode();
      initMermaid(mode);
      if (state.currentHtml && state.viewMode !== "md") {
        renderCurrentFile();
      }
    });
  }
}

function applyThemeMode(mode) {
  state.themeMode = mode;
  if (mode === "auto") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", mode);
  }
  for (const btn of els.themeButtons) {
    const active = btn.dataset.themeMode === mode;
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  }
  // Issue #30: スマホ用 overflow menu 内のテーマボタンも同期
  for (const btn of els.overflowThemeBtns) {
    const active = btn.dataset.themeMode === mode;
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function saveThemeMode() {
  prefs.themeMode.save(state.themeMode);
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
  syncEditButtonLabels();
  // TOC の展開トグル + (表示中なら) 見出しツリーを再描画
  updateExpandToggleUi();
  if (state.tocVisible) refreshToc();
  // ステータスは key を保持しない一過性メッセージのため、言語切替時はクリアする
  // (旧言語の文言が残らないように。次の操作で新言語で再表示される。
  //  競合バナー等の操作可能な UI は別要素なので消えない)。
  clearStatus();
}

/** ステータス表示を空にする (テキスト + 装飾クラス + toast タイマーを解除)。 */
function clearStatus() {
  if (statusToastTimer) {
    clearTimeout(statusToastTimer);
    statusToastTimer = null;
  }
  els.status.textContent = "";
  els.status.classList.remove("is-ok", "is-error", "is-toast");
}

/** 編集モードの状態に応じて編集ボタン / overflow ボタンの表記を現在言語で設定する。 */
function syncEditButtonLabels() {
  if (state.editing) {
    els.editBtn.textContent = t("edit.saveClose");
    els.editBtn.title = t("edit.saveClose.title");
    if (els.overflowEdit) els.overflowEdit.textContent = t("edit.saveClose.emoji");
  } else {
    els.editBtn.textContent = t("edit.button");
    els.editBtn.title = t("edit.button.title");
    if (els.overflowEdit) els.overflowEdit.textContent = t("overflow.editMode");
  }
}

/* ===== 編集モード ===== */

function wireEditActions() {
  enableEditActions(false);
  els.editBtn.addEventListener("click", () => {
    if (state.editing) {
      // 編集モード中の「完了」: 未保存があれば保存 → 成功で閉じる、失敗なら編集モード継続
      handleFinishEdit().catch((err) => setStatus("error", errorText(err)));
    } else {
      enterEditMode();
    }
  });

  els.discardBtn.addEventListener("click", () => {
    if (!confirmDiscard()) return;
    exitEditMode();
  });

  els.editor.addEventListener("input", () => {
    const dirty = els.editor.value !== state.currentRaw;
    setDirty(dirty);
  });

  // 競合バナー
  els.conflictTakeServer.addEventListener("click", () => takeServerVersion());
  els.conflictOverwrite.addEventListener("click", () => forceOverwrite());
  els.conflictDismiss.addEventListener("click", () => hideConflict());
}

async function handleFinishEdit() {
  if (!state.editing) return;
  if (!state.dirty) {
    exitEditMode();
    return;
  }
  const ok = await saveEdit();
  if (ok) exitEditMode();
}

function confirmDiscard() {
  if (!state.dirty) return true;
  return window.confirm(t("confirm.discardEditEnd"));
}

function enableEditActions(enabled) {
  els.editBtn.disabled = !enabled;
  els.tocBtn.disabled = !enabled;
  els.tocFab.disabled = !enabled;
  els.currentPath.disabled = !enabled;
  if (els.overflowEdit) els.overflowEdit.disabled = !enabled;
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

/* ===== Sidebar overlay (Issue #25, スマホ専用) ===== */

function wireSidebar() {
  els.menuBtn.addEventListener("click", () => {
    const isOpen = els.sidebar.classList.contains("is-open");
    setSidebarOpen(!isOpen);
  });
  els.sidebarBackdrop.addEventListener("click", () => setSidebarOpen(false));
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!els.sidebar.classList.contains("is-open")) return;
    // 外部 URL バナーが開いている時は banner 側の Esc ハンドラを優先
    if (!els.externalLinkBanner.hidden) return;
    setSidebarOpen(false);
  });
  // viewport がデスクトップ幅に戻ったら自動で閉じる (overlay 状態が残ると視覚的に変)
  MOBILE_QUERY.addEventListener("change", (ev) => {
    if (!ev.matches) setSidebarOpen(false);
  });
}

function setSidebarOpen(open) {
  els.sidebar.classList.toggle("is-open", open);
  els.sidebarBackdrop.hidden = !open;
  els.menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

/** スマホ表示でファイルを選んだら自動で sidebar を閉じる */
function closeSidebarIfMobile() {
  if (MOBILE_QUERY.matches) setSidebarOpen(false);
}

/* ===== ⋮ Overflow menu (Issue #30, スマホ専用) ===== */

function wireOverflowMenu() {
  els.overflowBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setOverflowOpen(els.overflowMenu.hidden);
  });
  // 外クリックで閉じる
  document.addEventListener("click", (ev) => {
    if (els.overflowMenu.hidden) return;
    if (els.overflowMenu.contains(ev.target)) return;
    if (els.overflowBtn.contains(ev.target)) return;
    setOverflowOpen(false);
  });
  // Esc で閉じる (外部 URL バナー優先は既存 keydown リスナーと衝突しないよう個別判定)
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (els.overflowMenu.hidden) return;
    if (!els.externalLinkBanner.hidden) return;
    setOverflowOpen(false);
  });

  // overflow-theme-btn → applyThemeMode (PC 側 wireThemeToggle と同じロジックを再利用)
  for (const btn of els.overflowThemeBtns) {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.themeMode;
      if (!mode || !THEME_MODES.includes(mode)) return;
      if (state.themeMode === mode) return;
      applyThemeMode(mode);
      saveThemeMode();
      initMermaid(mode);
      if (state.currentHtml && state.viewMode !== "md") {
        renderCurrentFile();
      }
    });
  }

  // overflow-view-btn → applyViewMode
  for (const btn of els.overflowViewBtns) {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      if (!mode || !VIEW_MODES.includes(mode)) return;
      if (state.viewMode === mode) return;
      state.tocPreviewOverride = false;
      applyViewMode(mode);
      saveViewMode();
      if (state.currentHtml && mode !== "md") {
        renderMermaid().catch(() => {});
      }
    });
  }

  // overflow-edit → 編集モード toggle (既存 editBtn と同じ動作)
  els.overflowEdit.addEventListener("click", () => {
    setOverflowOpen(false);
    if (state.editing) {
      handleFinishEdit().catch((err) => setStatus("error", errorText(err)));
    } else {
      enterEditMode();
    }
  });
}

function setOverflowOpen(open) {
  els.overflowMenu.hidden = !open;
  els.overflowBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

/* ===== FAB 目次 (Issue #30, スマホ専用) ===== */

function wireTocFab() {
  els.tocFab.addEventListener("click", () => {
    if (state.editing) return;
    toggleToc();
  });
}

/* ===== sticky topbar 自動 hide/show on scroll (Issue #30, スマホ専用) ===== */

const TOPBAR_HIDE_THRESHOLD = 5; // この px 以上下スクロールで hide
const TOPBAR_TOP_GUARD = 30; // 上端 30px 以内では常に show

function wireTopbarAutohide() {
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;
  const targets = [els.preview, els.source];
  const lastY = new WeakMap();
  const onScroll = (target) => {
    if (!MOBILE_QUERY.matches) return;
    const y = target.scrollTop;
    const prev = lastY.get(target) ?? 0;
    const dy = y - prev;
    if (y < TOPBAR_TOP_GUARD) {
      topbar.classList.remove("is-hidden");
    } else if (dy > TOPBAR_HIDE_THRESHOLD) {
      topbar.classList.add("is-hidden");
      // overflow menu が開いていたら一緒に閉じる (見た目上違和感を避ける)
      if (!els.overflowMenu.hidden) setOverflowOpen(false);
    } else if (dy < -TOPBAR_HIDE_THRESHOLD) {
      topbar.classList.remove("is-hidden");
    }
    lastY.set(target, y);
  };
  for (const t of targets) {
    if (t) t.addEventListener("scroll", () => onScroll(t), { passive: true });
  }
}

/* ===== 端スワイプで drawer 開閉 (Issue #30, スマホ専用) ===== */

const SWIPE_EDGE_PX = 24;
const SWIPE_MIN_DX = 60;
const SWIPE_MAX_DY = 50;

function wireSidebarSwipe() {
  let startX = null;
  let startY = null;
  let startedFromEdge = false;
  let startedInDrawer = false;

  document.addEventListener(
    "touchstart",
    (ev) => {
      if (!MOBILE_QUERY.matches) return;
      if (ev.touches.length !== 1) return;
      const t = ev.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      const open = els.sidebar.classList.contains("is-open");
      startedFromEdge = !open && t.clientX <= SWIPE_EDGE_PX;
      startedInDrawer = open && els.sidebar.contains(ev.target);
    },
    { passive: true },
  );

  document.addEventListener(
    "touchend",
    (ev) => {
      if (!MOBILE_QUERY.matches) return;
      if (startX === null) return;
      const t = ev.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);
      const fromEdge = startedFromEdge;
      const inDrawer = startedInDrawer;
      startX = startY = null;
      startedFromEdge = startedInDrawer = false;
      if (dy > SWIPE_MAX_DY) return;
      if (fromEdge && dx > SWIPE_MIN_DX) {
        setSidebarOpen(true);
      } else if (inDrawer && dx < -SWIPE_MIN_DX) {
        setSidebarOpen(false);
      }
    },
    { passive: true },
  );
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

function enterEditMode() {
  if (!state.currentPath) return;
  state.editing = true;
  els.contentBody.classList.add("is-editing");
  els.editor.value = state.currentRaw;
  els.editor.hidden = false;
  els.editBtn.setAttribute("aria-pressed", "true");
  // Issue #30: スマホ用 overflow menu の編集ボタンも同期
  if (els.overflowEdit) els.overflowEdit.setAttribute("aria-pressed", "true");
  syncEditButtonLabels();
  els.discardBtn.hidden = false;
  setDirty(false);
  // TOC を一時退避 (編集終了で復元)
  state.tocSuspended = state.tocVisible;
  if (state.tocVisible) applyTocVisibility(false, { persist: false });
  els.tocBtn.disabled = true;
  els.tocFab.disabled = true;
  // 編集中はプレビューのチェックボックスを disabled に
  wireTaskCheckboxes();
  setTimeout(() => els.editor.focus(), 0);
}

function exitEditMode() {
  state.editing = false;
  els.contentBody.classList.remove("is-editing");
  els.editor.hidden = true;
  els.editBtn.setAttribute("aria-pressed", "false");
  // Issue #30: スマホ用 overflow menu の編集ボタンも同期
  if (els.overflowEdit) els.overflowEdit.setAttribute("aria-pressed", "false");
  syncEditButtonLabels();
  els.discardBtn.hidden = true;
  setDirty(false);
  // TOC 復元 (編集前に開いていれば再表示)。currentPath がなければ disabled のまま
  els.tocBtn.disabled = !state.currentPath;
  els.tocFab.disabled = !state.currentPath;
  if (state.tocSuspended) {
    applyTocVisibility(true, { persist: false });
    state.tocSuspended = false;
  }
  // 編集終了でチェックボックスを再びクリック可能に
  wireTaskCheckboxes();
  // Issue #9: 編集モード中は同期 OFF だったので、出た時に pair を再構築して復活させる
  if (state.viewMode === "split") {
    requestAnimationFrame(() => rebuildScrollSyncPairs());
  }
}

function setDirty(dirty) {
  state.dirty = dirty;
  els.dirtyIndicator.hidden = !dirty;
}

function confirmLeaveEdit() {
  if (!state.editing || !state.dirty) return true;
  return window.confirm(t("confirm.unsavedContinue"));
}

async function saveEdit({ force = false } = {}) {
  if (!state.editing) return false;
  if (!state.currentPath) {
    setStatus("error", t("status.saveNoFile"));
    return false;
  }
  const body = els.editor.value;
  const payload = { path: state.currentPath, body };
  if (!force && state.currentSha) payload.baseSha = state.currentSha;

  try {
    const data = await fetchJson("/api/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.currentRaw = data.raw;
    state.currentHtml = sanitize(data.html);
    state.currentSha = data.sha;
    setDirty(false);
    hideConflict();
    if (state.viewMode !== "md") {
      els.preview.innerHTML = state.currentHtml;
      renderMermaid().catch(() => {});
    }
    els.source.textContent = data.raw;
    setStatus("ok", t("status.saved", { path: state.currentPath }));
    return true;
  } catch (err) {
    if (err.status === 409 && err.payload) {
      showConflict(err.payload);
      setStatus("error", t("status.conflict"));
    } else {
      setStatus("error", t("status.saveFailed", { msg: errorText(err) }));
    }
    return false;
  }
}

/* ===== インタラクティブ チェックボックス (Issue #17) ===== */

/**
 * プレビュー内の `<input type="checkbox">` (GFM タスクリスト) を
 * クリック可能にし、document order の index を付与する。
 *
 * applyFile で innerHTML が書き換わるたびに呼ぶ。listener は DOM 削除と
 * 同時に消えるので重複 attach はしないが、enter/exit edit からも呼ぶため
 * 念のため removeEventListener してから addEventListener する。
 *
 * 編集モード中は disabled = true でクリック不可（編集モード優先）。
 */
function wireTaskCheckboxes() {
  const boxes = els.preview.querySelectorAll('input[type="checkbox"]');
  boxes.forEach((box, idx) => {
    box.dataset.taskIndex = String(idx);
    box.disabled = state.editing;
    box.removeEventListener("change", onTaskCheckboxToggle);
    box.addEventListener("change", onTaskCheckboxToggle);
  });
}

async function onTaskCheckboxToggle(ev) {
  const target = ev.currentTarget;
  if (!target || !state.currentPath || state.editing) {
    // 編集モード中は disabled なので通常は届かないが、保険
    if (target) target.checked = !target.checked;
    return;
  }

  const idx = Number(target.dataset.taskIndex);
  if (!Number.isInteger(idx) || idx < 0) return;

  const { body, newChecked } = toggleTaskInMarkdown(state.currentRaw, idx);
  if (newChecked === null) {
    // ソース上に該当タスクなし (markdown と DOM index がズレた)
    target.checked = !target.checked; // revert
    setStatus("error", t("status.taskLocateFailed"));
    return;
  }

  const payload = { path: state.currentPath, body };
  if (state.currentSha) payload.baseSha = state.currentSha;

  // 再入防止: 連続クリックを 1 回分だけ受け付ける
  target.disabled = true;

  try {
    const data = await fetchJson("/api/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    // applyFile 経由で再描画: state 更新 + DOM + TOC + チェックボックス再 attach を一括
    applyFile(data);
    setStatus(
      "ok",
      t("status.taskUpdated", {
        path: state.currentPath,
        state: newChecked ? t("task.on") : t("task.off"),
      }),
    );
  } catch (err) {
    target.checked = !target.checked; // revert UI
    target.disabled = state.editing;
    if (err.status === 409 && err.payload) {
      showConflict(err.payload);
      setStatus("error", t("status.conflict"));
    } else {
      setStatus("error", t("status.saveFailed", { msg: errorText(err) }));
    }
  }
}

/* ===== 競合バナー ===== */

let conflictServerSnapshot = null;

function showConflict(payload) {
  conflictServerSnapshot = payload;
  els.conflictBanner.hidden = false;
}

function hideConflict() {
  conflictServerSnapshot = null;
  els.conflictBanner.hidden = true;
}

function takeServerVersion() {
  if (!conflictServerSnapshot) return;
  const snap = conflictServerSnapshot;
  state.currentRaw = snap.raw ?? "";
  state.currentHtml = sanitize(snap.html);
  state.currentSha = snap.sha ?? null;
  els.editor.value = state.currentRaw;
  setDirty(false);
  els.preview.innerHTML = state.currentHtml;
  els.source.textContent = state.currentRaw;
  if (state.viewMode !== "md") renderMermaid().catch(() => {});
  hideConflict();
  setStatus("ok", t("status.serverTaken"));
}

function forceOverwrite() {
  hideConflict();
  saveEdit({ force: true });
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

/* ===== TOC (目次) ===== */

function wireTocActions() {
  els.tocBtn.disabled = true;
  els.tocBtn.addEventListener("click", () => toggleToc());
  els.tocClose.addEventListener("click", () => applyTocVisibility(false));
  els.tocExpandToggle.addEventListener("click", () => {
    const next = state.tocExpandLevel === "h3" ? "h6" : "h3";
    state.tocExpandLevel = next;
    prefs.tocExpandLevel.save(next);
    updateExpandToggleUi();
    refreshToc();
  });
  updateExpandToggleUi();
  applyTocVisibility(state.tocVisible, { persist: false });
}

function toggleToc() {
  if (state.tocVisible) {
    applyTocVisibility(false);
    return;
  }
  // md モードで TOC を開いた場合: 一時的に preview に切替 (localStorage は更新しない)
  if (state.viewMode === "md") {
    state.tocPreviewOverride = true;
    applyViewMode("preview");
  }
  applyTocVisibility(true);
}

function applyTocVisibility(visible, { persist = true } = {}) {
  state.tocVisible = visible;
  els.tocPanel.hidden = !visible;
  els.tocBtn.setAttribute("aria-pressed", visible ? "true" : "false");
  if (persist) prefs.tocVisible.save(visible);
  // preview override は「ユーザが TOC を明示的に閉じた (persist=true)」時のみ戻す。
  // persist=false の呼び出し (編集モード進入時の一時退避等) では override 状態を保持する。
  if (!visible && persist && state.tocPreviewOverride) {
    const stored = prefs.viewMode.load();
    if (stored && VIEW_MODES.includes(stored)) {
      applyViewMode(stored);
    }
    state.tocPreviewOverride = false;
  }
  if (visible) {
    refreshToc();
  } else {
    teardownTocObserver();
    state.tocEntries.clear();
  }
}

function updateExpandToggleUi() {
  const isExpanded = state.tocExpandLevel === "h6";
  els.tocExpandToggle.setAttribute("aria-pressed", isExpanded ? "true" : "false");
  els.tocExpandToggle.textContent = isExpanded ? t("toc.collapseH4") : t("toc.expandH4");
  // title も状態に追従させる (data-i18n-title は常に展開側なので、ここで上書き)
  els.tocExpandToggle.title = isExpanded ? t("toc.collapseH4.title") : t("toc.expandH4.title");
}

function refreshToc() {
  if (!state.tocVisible) return;
  const headings = collectHeadings(els.preview);
  const maxLevel = state.tocExpandLevel === "h6" ? 6 : 3;
  const tree = buildTocTree(headings, maxLevel);
  renderTocTree(tree);
  setupTocHighlight(headings, maxLevel);
}

function collectHeadings(previewEl) {
  return Array.from(previewEl.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((el) => ({
    level: Number(el.tagName.substring(1)),
    text: el.textContent ?? "",
    id: el.id,
    el,
  }));
}

function renderTocTree(tree) {
  state.tocEntries.clear();
  els.tocList.innerHTML = "";

  if (tree.length === 0) {
    const empty = document.createElement("p");
    empty.className = "toc-empty";
    empty.textContent = t("toc.empty");
    els.tocList.appendChild(empty);
    return;
  }

  const ul = document.createElement("ul");
  for (const node of tree) ul.appendChild(renderTocNode(node));
  els.tocList.appendChild(ul);
}

function renderTocNode(node) {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `toc-entry toc-level-${node.level}`;
  btn.textContent = node.text;
  btn.title = node.text;
  btn.addEventListener("click", () => {
    const target = document.getElementById(node.id);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  state.tocEntries.set(node.id, btn);
  li.appendChild(btn);

  if (node.children.length > 0) {
    const ul = document.createElement("ul");
    for (const child of node.children) ul.appendChild(renderTocNode(child));
    li.appendChild(ul);
  }
  return li;
}

function setupTocHighlight(headings, maxLevel) {
  teardownTocObserver();
  if (headings.length === 0) return;

  // ビューポート上端 10%-20% の帯に入った heading を current にする。
  // 同時に複数 entry が intersect する場合は、ビューポート上端に最も近いものを優先。
  const visible = new Map(); // id -> intersectionTop (boundingClientRect.top)

  state.tocObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = entry.target.id;
        if (entry.isIntersecting) {
          visible.set(id, entry.boundingClientRect.top);
        } else {
          visible.delete(id);
        }
      }
      // top に最も近い (= |top| が小さい) heading を current に
      let best = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const [id, top] of visible) {
        const dist = Math.abs(top);
        if (dist < bestDist) {
          best = id;
          bestDist = dist;
        }
      }
      for (const [id, btn] of state.tocEntries) {
        btn.classList.toggle("is-active", id === best);
      }
    },
    {
      root: els.preview,
      rootMargin: "-10% 0px -80% 0px",
      threshold: [0, 1],
    },
  );

  for (const h of headings) {
    if (h.level > maxLevel) continue;
    if (h.el) state.tocObserver.observe(h.el);
  }
}

function teardownTocObserver() {
  if (state.tocObserver) {
    state.tocObserver.disconnect();
    state.tocObserver = null;
  }
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
      saveEdit().catch((err) =>
        setStatus("error", t("status.saveFailed", { msg: errorText(err) })),
      );
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
      toggleToc();
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

function wireBeforeUnload() {
  window.addEventListener("beforeunload", (ev) => {
    if (state.editing && state.dirty) {
      ev.preventDefault();
      ev.returnValue = "";
    }
  });
}

/* ===== Live reload via WebSocket ===== */

let wsRetryDelay = 500;
const WS_RETRY_MAX = 5000;

function connectLiveReload() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws`;
  const ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    wsRetryDelay = 500;
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleLiveEvent(msg);
  });

  ws.addEventListener("close", () => {
    setTimeout(connectLiveReload, wsRetryDelay);
    wsRetryDelay = Math.min(wsRetryDelay * 2, WS_RETRY_MAX);
  });

  ws.addEventListener("error", () => {
    ws.close();
  });
}

async function handleLiveEvent(msg) {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "changed" && msg.path && msg.path === state.currentPath) {
    if (state.editing) {
      // 編集中にライブリロードが来た = 外部で書き換えられた可能性。
      // 編集内容を保護するため、サーバの最新を取得して競合バナーを出す。
      try {
        const latest = await fetchJson(`/api/file?path=${encodeURIComponent(state.currentPath)}`);
        showConflict(latest);
        setStatus("error", t("status.fileUpdatedElsewhere"));
      } catch (err) {
        setStatus("error", errorText(err));
      }
      return;
    }
    try {
      const data = await loadFile(state.currentPath);
      applyFile(data);
      setStatus("ok", t("status.reloaded", { path: data.path }));
    } catch (err) {
      setStatus("error", errorText(err));
    }
    return;
  }

  if (msg.type === "tree" || msg.type === "changed") {
    try {
      const tree = await fetchJson("/api/tree");
      renderTree(tree);
      if (state.currentPath) {
        if (state.fileButtons.has(state.currentPath)) {
          highlightSelected(state.currentPath);
        } else {
          setStatus("error", t("status.fileDeleted", { path: state.currentPath }));
        }
      }
    } catch (err) {
      setStatus("error", t("status.treeFetchFailed", { msg: errorText(err) }));
    }
  }
}
