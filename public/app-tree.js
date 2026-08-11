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
    // 差分更新の鍵 (Issue #84)。**種類も含める** —— 同じパスがファイルとディレクトリで
    // 入れ替わったら、`<li>` の中身の作りが違うので作り直す
    li.dataset.nodeKey = `${node.type}:${node.path}`;
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
      rendered.set(nodeKey(node), { li, button, nameEl: name, name: node.name, ul });

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
      rendered.set(nodeKey(node), { li, button, nameEl: name, name: node.name, ul: null });
      button.addEventListener("click", () => {
        ctx.document.navigateTo(node.path, { history: "push" }).catch((err) => {
          ctx.setStatus("error", errorText(err));
        });
      });
    }

    return li;
  }

  /**
   * 差分更新のために、描画したノードの参照を鍵で引けるようにしておく (Issue #84)。
   *
   * **`querySelector` を使わない**ためのもの。最初は `li.querySelector(":scope > .tree-item")`
   * で引いていたが、10,000 ノードを毎回引くと**全部作り直すより遅かった**
   * （実測 216ms → 362ms）。参照は作った時点で分かっているので、その場で控える。
   *
   * @typedef {{
   *   li: HTMLLIElement,
   *   button: HTMLButtonElement,
   *   nameEl: HTMLElement,
   *   name: string,
   *   ul: HTMLUListElement | null,
   * }} RenderedNode
   */
  /** @type {Map<string, RenderedNode>} 鍵は `${type}:${path}` */
  const rendered = new Map();

  /** @param {TreeNode} node @returns {string} */
  const nodeKey = (node) => `${node.type}:${node.path}`;

  /**
   * `<ul>` の中身を新しい子リストへ寄せる。**同じパス・同じ種類のノードは作り直さない**
   * (Issue #84)。
   *
   * 全部作り直すと 10,000 ファイルで 1 イベントあたり 216ms 掛かっていた
   * （実測は `docs/bench/tree-baseline.md`）。追加・削除は普通 1 件なので、
   * **変わったところだけ差し替える**。
   *
   * **DOM を触る回数を最小にするのが要点。** 位置が合っているノードは動かさない
   * （`appendChild` は既存ノードでも「取り外して付け直す」ので、無条件に呼ぶと
   * 全ノードぶんの DOM 操作が発生し、作り直すのと変わらなくなる）。
   *
   * 再利用すると開閉状態・フォーカス・スクロール位置がそのまま残るという利点もある。
   *
   * @param {HTMLUListElement} ul
   * @param {TreeNode[]} children
   * @returns {void}
   */
  function reconcileChildren(ul, children) {
    // **鍵の集合は必要になってから作る。** カーソルが「消えたノード」に当たったときに
    // 要る（これが無いと**以降の兄弟を全部 `insertBefore` で前へ寄せる**ことになり、
    // 先頭の 1 件を消すだけで 2,000 兄弟が動く）。ただし**大半のディレクトリでは
    // 何も消えない**ので、毎回作ると 10,000 ノードぶんの Set 挿入が丸ごと無駄になる
    /** @type {Set<string> | null} */
    let next = null;
    const keySet = () => {
      if (!next) {
        next = new Set();
        for (const child of children) next.add(nodeKey(child));
      }
      return next;
    };

    // **`children` を前から順に、`ul` の子と突き合わせる。** 一致していれば何もしない
    let cursor = ul.firstElementChild;
    for (const child of children) {
      const key = nodeKey(child);
      const known = rendered.get(key);

      if (known && known.li === cursor) {
        // 位置も一致。**DOM を一切触らない**（ここが最頻ケース）
        refreshNode(known, child);
        cursor = cursor.nextElementSibling;
        continue;
      }
      // ここへ来たということは何かがずれている。消えたノードを先に捨ててから見直す
      cursor = skipDead(cursor, keySet());
      if (known && known.li === cursor) {
        refreshNode(known, child);
        cursor = cursor.nextElementSibling;
        continue;
      }
      if (known) {
        refreshNode(known, child);
        ul.insertBefore(known.li, cursor);
        continue;
      }
      ul.insertBefore(renderNode(child), cursor);
    }

    // 末尾に残ったものも消えたノード
    while (cursor) {
      const dead = /** @type {HTMLElement} */ (cursor);
      cursor = cursor.nextElementSibling;
      if (isDisposable(dead, keySet())) {
        dropSubtree(dead);
        dead.remove();
      }
    }
  }

  /**
   * 新しいリストに無いカーソルを捨てながら進める。
   *
   * @param {Element | null} cursor
   * @param {Set<string>} next
   * @returns {Element | null}
   */
  function skipDead(cursor, next) {
    let at = cursor;
    while (at && isDisposable(/** @type {HTMLElement} */ (at), next)) {
      const dead = at;
      at = at.nextElementSibling;
      dropSubtree(/** @type {HTMLElement} */ (dead));
      dead.remove();
    }
    return at;
  }

  /**
   * その `<li>` を捨ててよいか。
   *
   * **鍵を持たない `<li>` は残す。** 新規ファイル名のインライン入力欄 (`tree-new-li`) が
   * これに当たる。捨てると、利用者が名前を打っている最中に入力欄が消える
   * （しかも `state.newFileInput` は外れた要素を指したまま残る）。
   *
   * @param {HTMLElement} li
   * @param {Set<string>} next
   * @returns {boolean}
   */
  function isDisposable(li, next) {
    const key = li.dataset.nodeKey;
    return Boolean(key) && !next.has(/** @type {string} */ (key));
  }

  /**
   * 取り除く `<li>` とその配下を、各種マップから外す。
   *
   * **配下まで辿る。** ディレクトリを 1 つ消すと、その中のファイルも同時に消える。
   * 親だけ外すと `state.fileButtons` に幽霊が残り、**表示中のファイルが消えたことに
   * 気づけない**（`app-websocket.js` が `fileButtons.has(currentPath)` で判定する）。
   * status に出るファイル数もずれる。
   *
   * なおクイックオープンは影響を受けない —— あちらは `syncPaths(root)` でツリーのデータから
   * 母集団を作り直すため。**マップの汚れはそこでは観測できない**ので、テストは
   * 「削除されました」の経路で見ている。
   *
   * @param {HTMLElement} li
   * @returns {void}
   */
  function dropSubtree(li) {
    const key = li.dataset.nodeKey;
    if (!key) return;
    const path = key.slice(key.indexOf(":") + 1);
    // **`delete` より先に取る。** 後から引くと必ず undefined になる
    const known = rendered.get(key);
    rendered.delete(key);
    // **自分の登録だけを消す。** 同じパスがファイル ⇄ ディレクトリで入れ替わると、
    // 先に新ノードが登録されている。パスだけ見て消すと**新しいほうの登録を潰す**
    // （選択ハイライトが付かない・「すべて開く」で開かない、という形で出る）
    if (known && state.fileButtons.get(path) === known.button) state.fileButtons.delete(path);
    if (known && state.dirNodes.get(path)?.button === known.button) state.dirNodes.delete(path);

    const ul = known?.ul ?? li.lastElementChild;
    if (ul && ul.tagName === "UL") {
      for (const child of Array.from(ul.children)) dropSubtree(/** @type {HTMLElement} */ (child));
    }
  }

  /**
   * 再利用するノードを新しい内容に合わせ直す。
   *
   * リスナは `path` をクロージャで掴んでいるが、**鍵にパスを含めているので再利用されるのは
   * 同じパスのときだけ** —— 張り直す必要はない。
   *
   * @param {RenderedNode} known
   * @param {TreeNode} node
   * @returns {void}
   */
  function refreshNode(known, node) {
    // **名前は更新しない。** 鍵にパスが入っており、`name` はパスの basename
    // (`src/scanner.ts`) なので、同じ鍵なら名前も必ず同じ
    if (node.type !== "dir") {
      state.fileButtons.set(node.path, known.button);
      return;
    }
    if (!known.ul) return;
    state.dirNodes.set(node.path, { button: known.button, ul: known.ul });
    // 開閉は利用者の状態なので `state.openDirs` を正とする（DOM をそのまま信じない）。
    // **食い違っているときだけ書く** —— 実際にはクリックも「全て開く」も両方を同時に
    // 更新するので普段は一致しており、無条件に書くとディレクトリ数ぶんの DOM 書き込みが
    // 毎イベント発生する。これは念のための同期であって、日常的に効く経路ではない
    const shouldOpen = state.openDirs.has(node.path);
    if (known.button.classList.contains("is-open") !== shouldOpen) {
      setDirOpen(known.button, known.ul, shouldOpen);
    }
    reconcileChildren(known.ul, node.children ?? []);
  }

  /**
   * @param {TreeNode} root
   * @returns {void}
   */
  function renderTree(root) {
    els.tree.removeAttribute("aria-busy");
    // 起動時プレースホルダ "読み込み中…" の data-i18n を除去する (Issue #48)。
    // これを残すと、言語切替時の applyI18n() が #tree.textContent を loading 文言で
    // 上書きし、描画済みのツリー (ファイル/ディレクトリ) が消えてしまう。
    els.tree.removeAttribute("data-i18n");

    // **2 回目以降は差分更新する (Issue #84)。** 初回だけ `<ul>` を作る。
    // マップは `reconcileChildren` が消えたぶんを外し、`renderNode` / `refreshNode` が
    // 残るぶんを入れ直すので、ここで clear すると**再利用したノードの登録まで落ちる**
    let ul = /** @type {HTMLUListElement | null} */ (els.tree.querySelector(":scope > ul"));
    if (!ul) {
      state.fileButtons.clear();
      state.dirNodes.clear();
      rendered.clear();
      els.tree.innerHTML = "";
      ul = document.createElement("ul");
      els.tree.appendChild(ul);
    }
    reconcileChildren(ul, root.children ?? []);

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
