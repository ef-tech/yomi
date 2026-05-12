import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
import { prefs } from "./prefs.js";
import { buildTocTree } from "./toc.js";

const els = {
  tree: document.getElementById("tree"),
  preview: document.getElementById("preview"),
  source: document.getElementById("source"),
  editor: document.getElementById("editor"),
  contentBody: document.getElementById("content-body"),
  status: document.getElementById("status"),
  currentPath: document.getElementById("current-path"),
  dirtyIndicator: document.getElementById("dirty-indicator"),
  editBtn: document.getElementById("edit-btn"),
  discardBtn: document.getElementById("discard-btn"),
  conflictBanner: document.getElementById("conflict-banner"),
  conflictTakeServer: document.getElementById("conflict-take-server"),
  conflictOverwrite: document.getElementById("conflict-overwrite"),
  conflictDismiss: document.getElementById("conflict-dismiss"),
  toggleButtons: Array.from(document.querySelectorAll(".view-toggle-btn")),
  themeButtons: Array.from(document.querySelectorAll(".theme-toggle-btn")),
  // TOC
  tocBtn: document.getElementById("toc-btn"),
  tocPanel: document.getElementById("toc-panel"),
  tocList: document.getElementById("toc-list"),
  tocClose: document.getElementById("toc-close"),
  tocExpandToggle: document.getElementById("toc-expand-toggle"),
};

const VIEW_MODES = ["preview", "split", "md"];
const DEFAULT_VIEW_MODE = "preview";

const THEME_MODES = ["auto", "light", "dark"];
const DEFAULT_THEME_MODE = "auto";

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
};

restorePreferences();
applyViewMode(state.viewMode);
applyThemeMode(state.themeMode);
initMermaid(state.themeMode);
wireViewToggle();
wireThemeToggle();
wireEditActions();
wireTocActions();
wireKeyboard();
wireBeforeUnload();
init();
connectLiveReload();

async function init() {
  try {
    const tree = await fetchJson("/api/tree");
    renderTree(tree);
    setStatus("ok", `ファイル ${state.fileButtons.size} 件`);

    const initial = chooseInitialFile(tree);
    if (initial) {
      await selectFile(initial);
    } else {
      els.preview.innerHTML =
        '<p class="placeholder">このディレクトリには Markdown ファイルが見つかりませんでした。</p>';
    }
  } catch (err) {
    setStatus("error", `初期化失敗: ${err.message}`);
    els.tree.removeAttribute("aria-busy");
    els.tree.textContent = `読み込みエラー: ${err.message}`;
  }
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

function renderTree(root) {
  state.fileButtons.clear();
  state.dirNodes.clear();
  els.tree.removeAttribute("aria-busy");
  els.tree.innerHTML = "";

  const ul = document.createElement("ul");
  for (const child of root.children ?? []) {
    ul.appendChild(renderNode(child));
  }
  els.tree.appendChild(ul);
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
  } else {
    state.fileButtons.set(node.path, button);
    button.addEventListener("click", () => {
      if (!confirmLeaveEdit()) return;
      selectFile(node.path).catch((err) => {
        setStatus("error", err.message);
      });
    });
  }

  return li;
}

function setDirOpen(button, ul, open) {
  button.classList.toggle("is-open", open);
  ul.style.display = open ? "" : "none";
}

function chooseInitialFile(tree) {
  if (state.currentPath && state.fileButtons.has(state.currentPath)) {
    return state.currentPath;
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

async function selectFile(path) {
  const data = await fetchJson(`/api/file?path=${encodeURIComponent(path)}`);
  state.currentPath = data.path;
  state.currentRaw = data.raw;
  state.currentHtml = data.html;
  state.currentSha = data.sha ?? null;
  saveCurrentPath();
  els.currentPath.textContent = data.path;
  hideConflict();
  if (state.editing) {
    // selectFile で別ファイルに切替 = 編集解除
    exitEditMode();
  }
  renderCurrentFile();
  highlightSelected(data.path);
  expandAncestors(data.path);
  setStatus("ok", `${data.path} を表示`);
  enableEditActions(true);
  refreshToc();
}

function renderCurrentFile() {
  els.preview.innerHTML = state.currentHtml;
  els.source.textContent = state.currentRaw;
  els.preview.scrollTop = 0;
  els.source.scrollTop = 0;
  if (state.viewMode !== "md") {
    renderMermaid().catch(() => {});
  }
}

async function renderMermaid() {
  const nodes = els.preview.querySelectorAll("pre.mermaid");
  if (nodes.length === 0) return;
  try {
    await mermaid.run({ nodes });
  } catch (err) {
    console.error("Mermaid render error:", err);
    setStatus("error", `Mermaid 描画エラー: ${err.message ?? err}`);
  }
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
  els.status.classList.remove("is-ok", "is-error");
  if (kind === "ok") els.status.classList.add("is-ok");
  else if (kind === "error") els.status.classList.add("is-error");
}

function restorePreferences() {
  const open = prefs.openDirs.load();
  if (open) state.openDirs = new Set([...open, ""]);

  const cur = prefs.currentPath.load();
  if (cur) state.currentPath = cur;

  const view = prefs.viewMode.load();
  if (view && VIEW_MODES.includes(view)) state.viewMode = view;

  const theme = prefs.themeMode.load();
  if (theme && THEME_MODES.includes(theme)) state.themeMode = theme;

  const tocVis = prefs.tocVisible.load();
  if (tocVis === true) state.tocVisible = true;

  const tocLv = prefs.tocExpandLevel.load();
  if (tocLv && TOC_EXPAND_LEVELS.includes(tocLv)) state.tocExpandLevel = tocLv;
}

function saveOpenDirs() {
  prefs.openDirs.save([...state.openDirs]);
}

function saveCurrentPath() {
  if (state.currentPath) prefs.currentPath.save(state.currentPath);
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
}

function saveThemeMode() {
  prefs.themeMode.save(state.themeMode);
}

/* ===== 編集モード ===== */

function wireEditActions() {
  enableEditActions(false);
  els.editBtn.addEventListener("click", () => {
    if (state.editing) {
      // 編集モード中の「完了」: 未保存があれば保存 → 成功で閉じる、失敗なら編集モード継続
      handleFinishEdit().catch((err) => setStatus("error", err.message));
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
  return window.confirm("未保存の変更を破棄して編集を終了しますか?");
}

function enableEditActions(enabled) {
  els.editBtn.disabled = !enabled;
  els.tocBtn.disabled = !enabled;
}

function enterEditMode() {
  if (!state.currentPath) return;
  state.editing = true;
  els.contentBody.classList.add("is-editing");
  els.editor.value = state.currentRaw;
  els.editor.hidden = false;
  els.editBtn.setAttribute("aria-pressed", "true");
  els.editBtn.textContent = "保存して閉じる";
  els.editBtn.title = "保存して編集モードを終了 (Ctrl/Cmd+S でも保存可)";
  els.discardBtn.hidden = false;
  setDirty(false);
  // TOC を一時退避 (編集終了で復元)
  state.tocSuspended = state.tocVisible;
  if (state.tocVisible) applyTocVisibility(false, { persist: false });
  els.tocBtn.disabled = true;
  setTimeout(() => els.editor.focus(), 0);
}

function exitEditMode() {
  state.editing = false;
  els.contentBody.classList.remove("is-editing");
  els.editor.hidden = true;
  els.editBtn.setAttribute("aria-pressed", "false");
  els.editBtn.textContent = "編集";
  els.editBtn.title = "ブラウザ内で編集する";
  els.discardBtn.hidden = true;
  setDirty(false);
  // TOC 復元 (編集前に開いていれば再表示)。currentPath がなければ disabled のまま
  els.tocBtn.disabled = !state.currentPath;
  if (state.tocSuspended) {
    applyTocVisibility(true, { persist: false });
    state.tocSuspended = false;
  }
}

function setDirty(dirty) {
  state.dirty = dirty;
  els.dirtyIndicator.hidden = !dirty;
}

function confirmLeaveEdit() {
  if (!state.editing || !state.dirty) return true;
  return window.confirm("未保存の変更があります。破棄して続行しますか?");
}

async function saveEdit({ force = false } = {}) {
  if (!state.editing) return false;
  if (!state.currentPath) {
    setStatus("error", "保存失敗: 表示中のファイルがありません");
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
    state.currentHtml = data.html;
    state.currentSha = data.sha;
    setDirty(false);
    hideConflict();
    if (state.viewMode !== "md") {
      els.preview.innerHTML = data.html;
      renderMermaid().catch(() => {});
    }
    els.source.textContent = data.raw;
    setStatus("ok", `${state.currentPath} を保存`);
    return true;
  } catch (err) {
    if (err.status === 409 && err.payload) {
      showConflict(err.payload);
      setStatus("error", "競合: ファイルが他で更新されています");
    } else {
      setStatus("error", `保存失敗: ${err.message}`);
    }
    return false;
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
  state.currentHtml = snap.html ?? "";
  state.currentSha = snap.sha ?? null;
  els.editor.value = state.currentRaw;
  setDirty(false);
  els.preview.innerHTML = state.currentHtml;
  els.source.textContent = state.currentRaw;
  if (state.viewMode !== "md") renderMermaid().catch(() => {});
  hideConflict();
  setStatus("ok", "サーバ側の内容を取り込みました");
}

function forceOverwrite() {
  hideConflict();
  saveEdit({ force: true });
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
  els.tocExpandToggle.textContent = isExpanded ? "▴ H4- 折りたたみ" : "▾ H4- 展開";
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
    empty.textContent = "目次がありません";
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
      saveEdit().catch((err) => setStatus("error", `保存失敗: ${err.message}`));
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
        setStatus("error", "ファイルが他で更新されています");
      } catch (err) {
        setStatus("error", err.message);
      }
      return;
    }
    try {
      await selectFile(state.currentPath);
      setStatus("ok", `${state.currentPath} を再読込`);
    } catch (err) {
      setStatus("error", err.message);
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
          setStatus("error", `ファイルが削除されました: ${state.currentPath}`);
        }
      }
    } catch (err) {
      setStatus("error", `ツリー再取得失敗: ${err.message}`);
    }
  }
}
