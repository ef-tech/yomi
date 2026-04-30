const els = {
  tree: document.getElementById("tree"),
  preview: document.getElementById("preview"),
  status: document.getElementById("status"),
  currentPath: document.getElementById("current-path"),
};

const state = {
  /** path -> tree-item ボタン要素 */
  fileButtons: new Map(),
  /** 開いているディレクトリ path のセット */
  openDirs: new Set([""]),
  /** 現在表示中のファイル path */
  currentPath: null,
};

const STORAGE_KEY_OPEN = "yomi:openDirs:v1";
const STORAGE_KEY_CURRENT = "yomi:currentPath:v1";

restorePreferences();
init();

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
  saveCurrentPath();
  els.currentPath.textContent = data.path;
  els.preview.innerHTML = data.html;
  highlightSelected(data.path);
  expandAncestors(data.path);
  els.preview.scrollTop = 0;
  setStatus("ok", `${data.path} を表示`);
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
  }
  saveOpenDirs();
  // 既に DOM 構築済みなのでクラス更新
  for (const dir of state.openDirs) {
    const escaped = cssAttrEscape(dir);
    const btn = els.tree.querySelector(`.tree-item.is-dir[title="${escaped}"]`);
    if (btn) {
      const ul = btn.parentElement?.querySelector(":scope > ul");
      if (ul) setDirOpen(btn, ul, true);
    }
  }
}

function cssAttrEscape(s) {
  return s.replace(/["\\]/g, "\\$&");
}

function setStatus(kind, text) {
  els.status.textContent = text;
  els.status.classList.remove("is-ok", "is-error");
  if (kind === "ok") els.status.classList.add("is-ok");
  else if (kind === "error") els.status.classList.add("is-error");
}

function restorePreferences() {
  try {
    const open = localStorage.getItem(STORAGE_KEY_OPEN);
    if (open) {
      const arr = JSON.parse(open);
      if (Array.isArray(arr)) {
        state.openDirs = new Set([...arr, ""]);
      }
    }
    const cur = localStorage.getItem(STORAGE_KEY_CURRENT);
    if (cur) state.currentPath = cur;
  } catch {
    /* localStorage 不可 */
  }
}

function saveOpenDirs() {
  try {
    localStorage.setItem(
      STORAGE_KEY_OPEN,
      JSON.stringify([...state.openDirs]),
    );
  } catch {}
}

function saveCurrentPath() {
  try {
    if (state.currentPath) {
      localStorage.setItem(STORAGE_KEY_CURRENT, state.currentPath);
    }
  } catch {}
}
