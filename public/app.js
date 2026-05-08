import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
import { prefs } from "./prefs.js";

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
  openEditorBtn: document.getElementById("open-editor-btn"),
  conflictBanner: document.getElementById("conflict-banner"),
  conflictTakeServer: document.getElementById("conflict-take-server"),
  conflictOverwrite: document.getElementById("conflict-overwrite"),
  conflictDismiss: document.getElementById("conflict-dismiss"),
  toggleButtons: Array.from(document.querySelectorAll(".view-toggle-btn")),
  themeButtons: Array.from(document.querySelectorAll(".theme-toggle-btn")),
};

const VIEW_MODES = ["preview", "split", "md"];
const DEFAULT_VIEW_MODE = "preview";

const THEME_MODES = ["auto", "light", "dark"];
const DEFAULT_THEME_MODE = "auto";

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
};

restorePreferences();
applyViewMode(state.viewMode);
applyThemeMode(state.themeMode);
initMermaid(state.themeMode);
wireViewToggle();
wireThemeToggle();
wireEditActions();
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
      if (!confirmLeaveEdit()) return;
      exitEditMode();
    } else {
      enterEditMode();
    }
  });

  els.openEditorBtn.addEventListener("click", () => {
    requestOpenEditor().catch((err) => setStatus("error", err.message));
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

function enableEditActions(enabled) {
  els.editBtn.disabled = !enabled;
  els.openEditorBtn.disabled = !enabled;
}

function enterEditMode() {
  if (!state.currentPath) return;
  state.editing = true;
  els.contentBody.classList.add("is-editing");
  els.editor.value = state.currentRaw;
  els.editor.hidden = false;
  els.editBtn.setAttribute("aria-pressed", "true");
  els.editBtn.textContent = "完了";
  setDirty(false);
  setTimeout(() => els.editor.focus(), 0);
}

function exitEditMode() {
  state.editing = false;
  els.contentBody.classList.remove("is-editing");
  els.editor.hidden = true;
  els.editBtn.setAttribute("aria-pressed", "false");
  els.editBtn.textContent = "編集";
  setDirty(false);
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
  if (!state.editing || !state.currentPath) return;
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
  } catch (err) {
    if (err.status === 409 && err.payload) {
      showConflict(err.payload);
      setStatus("error", "競合: ファイルが他で更新されています");
    } else {
      setStatus("error", `保存失敗: ${err.message}`);
    }
  }
}

async function requestOpenEditor() {
  if (!state.currentPath) return;
  const res = await fetch("/api/open-editor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: state.currentPath }),
  });
  if (res.status === 204) {
    setStatus("ok", "外部エディタで開きました");
    return;
  }
  let msg = `HTTP ${res.status}`;
  try {
    const data = await res.json();
    if (data?.error) msg = data.error;
  } catch {
    /* ignore */
  }
  throw new Error(msg);
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

/* ===== キーボード ===== */

function wireKeyboard() {
  document.addEventListener("keydown", (ev) => {
    // Ctrl/Cmd+S で保存
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "s") {
      if (state.editing) {
        ev.preventDefault();
        saveEdit().catch((err) => setStatus("error", err.message));
      }
    }
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
