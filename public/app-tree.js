/**
 * 左ファイルツリー (Issue #78 で app.js から分離)。
 *
 * 担当:
 *
 * - `/api/tree` の結果を DOM へ描画し、`state.fileButtons` / `state.dirNodes` を張り直す
 * - ディレクトリの開閉と `localStorage` への永続化
 * - ツールバー (全て開く / 閉じる / 新規作成、Issue #41)
 * - 新規 Markdown のインライン入力と作成 (Issue #6)
 * - 現在ファイルのハイライトと祖先ディレクトリの展開
 *
 * ファイルを開く実処理は持たない。クリックは `ctx.document.navigateTo` に委ねる
 * (履歴・未保存確認・スクロール復元が document 側の責務のため)。
 */

import { errorText, fetchJson } from "./app-context.js";
import { t } from "./i18n.js";
import { completeMarkdownFileName, joinTreePath } from "./new-file.js";
import { prefs } from "./prefs.js";
import { collapseAllDirs, expandAllDirs, isTreeToolbarEnabled } from "./tree-toolbar.js";

/** @param {import("./app-context.js").Ctx} ctx */
export function createTree(ctx) {
  const { els, state } = ctx;

  function saveOpenDirs() {
    prefs.openDirs.save([...state.openDirs]);
  }

  /**
   * @param {HTMLElement} button
   * @param {HTMLElement} ul
   * @param {boolean} open
   * @returns {void}
   */
  function setDirOpen(button, ul, open) {
    button.classList.toggle("is-open", open);
    ul.style.display = open ? "" : "none";
  }

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

  /**
   * @typedef {import("./api-types.js").TreeNode} TreeNode
   * @param {TreeNode} node
   * @returns {HTMLLIElement}
   */
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
        ctx.document.navigateTo(node.path, { history: "push" }).catch((err) => {
          ctx.setStatus("error", errorText(err));
        });
      });
    }

    return li;
  }

  /**
   * @param {TreeNode} root
   * @returns {void}
   */
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
    // クイックオープンの母集団を張り直す (Issue #54)。**ツリーと同じものを見る**ので、
    // 除外設定と --depth はサーバ側の適用結果がそのまま効く
    ctx.quickOpen.syncPaths(root);
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
  /**
   * @param {string} dirPath
   * @param {HTMLElement | null} [trigger]
   * @returns {void}
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
  /**
   * @param {string} rawName
   * @param {string} dirPath
   * @returns {Promise<void>}
   */
  async function submitNewFile(rawName, dirPath) {
    const name = completeMarkdownFileName(rawName);
    if (name === null) {
      ctx.setStatus("error", t("status.invalidName"));
      return;
    }
    const path = joinTreePath(dirPath, name);
    closeNewFileInput();

    try {
      /** @type {import("./api-types.js").FileResponse} */
      const created = await fetchJson("/api/file/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      // 自己保存マークで watcher は発火しないため、自分でツリーを更新する
      /** @type {import("./api-types.js").TreeNode} */
      const tree = await fetchJson("/api/tree");
      renderTree(tree);
      const moved = await ctx.document.navigateTo(created.path, { history: "push" });
      if (!moved) {
        // 編集中に破棄をキャンセルした等で遷移がブロックされた場合、ファイルは
        // 作成済みだが古いエディタは触らない (誤ったキャレット移動・状態表示を避ける)
        ctx.setStatus("ok", t("status.createdNotOpened", { path: created.path }));
        return;
      }
      if (!state.editing) ctx.editor.enterEditMode();
      els.editor.setSelectionRange(0, 0);
      ctx.setStatus("ok", t("status.created", { path: created.path }));
    } catch (err) {
      ctx.setStatus("error", t("status.createFailed", { path, msg: errorText(err) }));
    }
  }

  /* ===== 選択状態 ===== */

  /**
   * @param {string | null} path
   * @returns {void}
   */
  function highlightSelected(path) {
    for (const [p, btn] of state.fileButtons) {
      btn.classList.toggle("is-selected", p === path);
    }
  }

  /** 選択したファイルの祖先ディレクトリをすべて開く (deep-link からの復元用)。 */
  /**
   * @param {string} path
   * @returns {void}
   */
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

  return {
    renderTree,
    wireTreeToolbar,
    updateTreeToolbarState,
    openNewFileInput,
    closeNewFileInput,
    highlightSelected,
    expandAncestors,
    saveOpenDirs,
    setDirOpen,
  };
}
