import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
import { prefs } from "./prefs.js";

const els = {
  tree: document.getElementById("tree"),
  preview: document.getElementById("preview"),
  source: document.getElementById("source"),
  contentBody: document.getElementById("content-body"),
  status: document.getElementById("status"),
  currentPath: document.getElementById("current-path"),
  toggleButtons: Array.from(
    document.querySelectorAll(".view-toggle-btn"),
  ),
  themeButtons: Array.from(
    document.querySelectorAll(".theme-toggle-btn"),
  ),
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
  // テーマだけ変わってもサーバー側の HTML は同じなので、再フェッチせず
  // キャッシュから innerHTML を再設定して Mermaid を新テーマで描き直す
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
  /** 表示モード: preview | split | md */
  viewMode: DEFAULT_VIEW_MODE,
  /** テーマモード: auto | light | dark */
  themeMode: DEFAULT_THEME_MODE,
};

restorePreferences();
applyViewMode(state.viewMode);
applyThemeMode(state.themeMode);
initMermaid(state.themeMode);
wireViewToggle();
wireThemeToggle();
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

async function fetchJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
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
  saveCurrentPath();
  els.currentPath.textContent = data.path;
  renderCurrentFile();
  highlightSelected(data.path);
  expandAncestors(data.path);
  setStatus("ok", `${data.path} を表示`);
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
      // プレビュー or 並列に切替時は Mermaid を再描画
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
      // テーマだけ変わってもサーバー HTML は同じ。キャッシュから再描画して
      // Mermaid を新テーマで描き直す
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
          setStatus(
            "error",
            `ファイルが削除されました: ${state.currentPath}`,
          );
        }
      }
    } catch (err) {
      setStatus("error", `ツリー再取得失敗: ${err.message}`);
    }
  }
}
