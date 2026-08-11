/**
 * クイックオープン (Issue #54)。`Ctrl/Cmd+P` でファイルを検索して切り替える。
 *
 * Issue #78 のモジュール分割に合わせて独立させた。候補の絞り込みとスコアリングは
 * DOM に触れない純粋関数として `quick-open.js` に分けてあり、ここは**結線だけ**を持つ。
 *
 * 遷移は自前で書かず `ctx.document.navigateTo` に委ねる。未保存の確認・履歴・ツリーの
 * ハイライトがそこにまとまっているので、独自経路を作るとその全部を書き写すことになる。
 */

import { errorText } from "./app-context.js";
import { isTopOverlay, shortcutsBlocked } from "./app-overlays.js";
import { collectFilePaths, moveSelection, QUICK_OPEN_LIMIT, searchPaths } from "./quick-open.js";

/** @param {import("./app-context.js").Ctx} ctx */
export function createQuickOpen(ctx) {
  const { els, state } = ctx;
  const { setStatus } = ctx;

  function wire() {
    els.quickOpenInput.addEventListener("input", () => refreshQuickOpen());

    // **`document` の capture で拾う。** パネル要素に付けると、**フォーカスがパネルの外に
    // 落ちた瞬間にキー処理が丸ごと死ぬ**。パネル内には空リスト帯 (`#quick-open-empty`) や
    // リストの padding、スクロールバーといった**フォーカスを取れない可視領域**があり、
    // そこを mousedown すると `activeElement` は `<body>` に戻る。すると:
    //
    // - Esc がここに届かず、`document` の sidebar / 外部リンクバナーのハンドラにだけ届く
    //   → **パネルは開いたまま背後だけが閉じる**（stopPropagation で潰したはずの壊れ方が逆向きに出る）
    // - Tab の preventDefault が走らず、フォーカストラップをすり抜ける
    //
    // capture なら DOM のどこにフォーカスがあっても最初に通るので、この迂回路が消える。
    // 開いている間だけ効かせるため、先頭で**最前面かどうか**を門番にする (Issue #112)。
    document.addEventListener(
      "keydown",
      (ev) => {
        // **最前面のときだけ扱う (Issue #112)。** `hidden` だけを門番にしていたので、
        // 競合ダイアログと重なると Esc 1 回で両方閉じていた
        if (!isTopOverlay("quickOpen", els)) return;
        // **もう誰かが Esc を消費していたら譲る (Issue #112)。** 判定だけでは足りない
        // —— 先に走ったハンドラが自分を閉じると、後続からは自分が最前面に見える
        if (ev.key === "Escape" && ev.defaultPrevented) return;
        handleQuickOpenKeydown(ev);
      },
      true,
    );

    // **パネル内の空白でフォーカスを落とさない。** 上の capture で実害は消えているが、
    // フォーカスが `<body>` へ飛ぶこと自体が「閉じたときに元へ戻す」を壊す (戻り先ではなく
    // body から再開することになる)。入力欄だけは既定動作を残す (テキスト選択・カーソル移動)。
    els.quickOpen.addEventListener("mousedown", (ev) => {
      if (ev.target !== els.quickOpenInput) ev.preventDefault();
    });

    // 背景 (パネルの外) をクリックしたら閉じる
    els.quickOpen.addEventListener("click", (ev) => {
      if (ev.target === els.quickOpen) closeQuickOpen();
    });

    // スマホの ⋮ メニューからも開ける (マウス/キーボードが無い環境の導線)
    // `?.` を付けない。同じ ⋮ メニューの `overflowEdit` と同じく **必ず存在する要素**なので、
    // 欠けたら静かに無効化されるより落ちたほうがよい (index.html との不整合に気づける)。
    //
    // **開いてから閉じる。** 逆にすると `openQuickOpen` が戻り先を覚える時点で ⋮ メニューが
    // 既に `hidden` になっており、閉じたときの `focus()` が非表示要素相手で空振りして
    // フォーカスが `<body>` に落ちる。
    //
    // **ここには `shortcutsBlocked` を掛けていない (Issue #112)。** ⋮ メニュー (55) は
    // 競合ダイアログのスクリム (70) の下にあり、`handleConflictDiffKeydown` の
    // フォーカストラップで Tab でも辿り着けないので、**押せる状況がない**。
    // 押せるようになったら（例: ⋮ をより手前へ動かす）ここにも門番が要る。
    els.overflowQuickOpen.addEventListener("click", () => {
      openQuickOpen();
      ctx.mobile.setOverflowOpen(false);
    });

    // Ctrl/Cmd+P でクイックオープン (Issue #54)。
    // capture phase + ev.code は Ctrl/Cmd+S と同じ理由 (IME / Caps Lock / 拡張機能干渉)。
    // **ブラウザの印刷ダイアログを奪う**ので preventDefault は必須。
    document.addEventListener(
      "keydown",
      (ev) => {
        // **IME 変換中は横取りしない。** 変換中は `ev.key` が `"Process"` になるが、
        // ここは `ev.code === "KeyP"` も見ているので**変換中でも成立してしまう**。
        // macOS の日本語 IME は変換中の `Ctrl+P` を「前の候補へ」に割り当てているのが既定
        // なので、日本語のファイル名を打っている最中に変換操作でパネルが開閉してしまう。
        if (ev.isComposing) return;
        const isKey = ev.code === "KeyP" || ev.key === "p" || ev.key === "P";
        const isModifier = ev.metaKey || ev.ctrlKey;
        if (!isModifier || !isKey || ev.altKey || ev.shiftKey) return;
        // **先にキーを奪う。** 抑止するときも奪わないと、ブラウザの印刷ダイアログへ抜ける
        ev.preventDefault();
        ev.stopPropagation();
        // **手前に別のモーダルがあるなら開かない (Issue #112)。** 見ていなかったので、
        // 競合ダイアログ (z-index 70) のスクリムの下にパネル (60) が開き、
        // フォーカスだけがトラップの外へ出ていた。自分自身のトグルは通す
        if (shortcutsBlocked(els, "quickOpen")) return;
        // **編集中でも開ける。** 未保存の確認は navigateTo が持っているので、ここで
        // 止める必要がない。⋮ メニューからの導線とも挙動が揃う (片方だけ禁止すると
        // 「PC では開けないのにスマホでは開ける」という食い違いになる)。
        if (els.quickOpen.hidden) openQuickOpen();
        else closeQuickOpen();
      },
      { capture: true },
    );
  }

  /** クイックオープンが開いている間のキー操作。`wireQuickOpen` の capture リスナーから呼ぶ。 */
  /**
   * @param {KeyboardEvent} ev
   * @returns {void}
   */
  function handleQuickOpenKeydown(ev) {
    // **IME 変換中は何もしない。** yomi は日本語のドキュメントを読む道具なので、
    // ファイル名も日本語であることが普通にある。変換中のキーはすべて IME のもので、
    // 横取りすると次のように壊れる:
    //
    // - `Enter`: 変換の確定が**そのままファイルを開いてしまう**（打ち終わる前に飛ぶ）
    // - `↑` `↓`: IME の変換候補を選べない
    // - `Esc`:   変換のキャンセルのつもりがパネルごと閉じる
    if (ev.isComposing) return;

    // **処理したキーは伝播も止める。** パネルは最前面 (z-index 60) なので、拾ったキーは
    // ここで終わり。とくに Esc は、素通りさせると 1 回で sidebar や外部リンクバナーまで
    // 一緒に閉じる (それらは `document` の bubble で Esc を見ている)。capture で止めれば
    // bubble フェーズ自体が起きないので、ガードを増やさずに優先順位を表現できる。
    const consume = () => {
      ev.preventDefault();
      ev.stopPropagation();
    };

    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      consume();
      setQuickOpenIndex(
        moveSelection(
          state.quickOpenIndex,
          ev.key === "ArrowDown" ? 1 : -1,
          state.quickOpenHits.length,
        ),
      );
      return;
    }
    if (ev.key === "Enter") {
      consume();
      openSelectedQuickOpen();
      return;
    }
    if (ev.key === "Escape") {
      consume();
      closeQuickOpen();
      return;
    }
    if (ev.key === "Tab") {
      // **フォーカスをパネルから出さない。** `aria-modal="true"` を宣言している以上、
      // Tab で背後のヘッダやツリーへ抜けられるのは**宣言と実体の食い違い**になる
      // (支援技術には「背後は無い」と伝えているのに、実際には触れてしまう)。
      //
      // 戻す先が入力欄だけで足りるのは、**候補ボタンを `tabIndex = -1` にしてある**ため
      // (選択は `aria-activedescendant` で伝える)。パネル内でフォーカスを取れる要素は
      // 入力欄しかないので、一般的なフォーカストラップ (先頭/末尾で折り返す) は要らない。
      consume();
      els.quickOpenInput.focus();
    }
  }

  function openQuickOpen() {
    if (!els.quickOpen.hidden) return;
    // 閉じたときにフォーカスを戻す先を覚えておく (キーボード利用者が位置を失わないように)
    // `activeElement` は `Element | null`。戻す先は要素なので型だけで絞る
    // (`instanceof` は実行時チェックを足してしまう。理由は i18n.js の applyI18n)
    state.quickOpenReturnFocus = /** @type {HTMLElement | null} */ (document.activeElement);
    els.quickOpen.hidden = false;
    els.quickOpenInput.value = "";
    refreshQuickOpen();
    els.quickOpenInput.focus();
  }

  function closeQuickOpen() {
    if (els.quickOpen.hidden) return;
    els.quickOpen.hidden = true;
    els.quickOpenList.innerHTML = "";
    state.quickOpenHits = [];
    state.quickOpenIndex = -1;
    const back = state.quickOpenReturnFocus;
    state.quickOpenReturnFocus = null;
    restoreFocusAfterQuickOpen(back);
  }

  /**
   * クイックオープンを閉じたあとのフォーカス復帰。
   *
   * **`isConnected` だけでは足りない。** DOM に繋がっていても**祖先が `hidden`** なら
   * `focus()` は何も起こさず、フォーカスは `<body>` に落ちてキーボード操作の起点が消える。
   * スマホの ⋮ メニューから開いた場合がまさにこれで、戻り先の `#overflow-quick-open` は
   * パネルを開いた時点で既に閉じたメニューの中にいる（実機で確認した）。
   *
   * **順序を入れ替えても解決しない** —— メニューを閉じるのが先でも後でも、*閉じるとき*には
   * どのみち非表示になっているため。実際に効いたかどうかを見て、駄目ならフォールバックする。
   */
  /**
   * @param {HTMLElement | null} back
   * @returns {void}
   */
  function restoreFocusAfterQuickOpen(back) {
    if (back?.isConnected && typeof back.focus === "function") {
      back.focus();
      if (document.activeElement === back) return;
    }
    // 戻せなかったときの受け皿。**スマホは ⋮ ボタン**（そこから開いたのだから自然な帰り先）、
    // デスクトップは編集ボタン。`#tree` は `<nav>` でフォーカスを取れないので候補にしない。
    for (const el of [els.overflowBtn, els.editBtn]) {
      if (!el?.isConnected) continue;
      el.focus();
      if (document.activeElement === el) return;
    }
  }

  /** 入力に応じて候補を作り直す。選択は常に先頭へ戻す (絞り込むたびに 1 番上を見たいため)。 */
  function refreshQuickOpen() {
    state.quickOpenHits = searchPaths(
      state.quickOpenPaths,
      els.quickOpenInput.value,
      QUICK_OPEN_LIMIT,
    );
    renderQuickOpenList();
    // 候補が 0 件のときに「展開中」と読み上げられないようにする
    els.quickOpenInput.setAttribute(
      "aria-expanded",
      state.quickOpenHits.length > 0 ? "true" : "false",
    );
    setQuickOpenIndex(state.quickOpenHits.length > 0 ? 0 : -1);
  }

  function renderQuickOpenList() {
    els.quickOpenList.innerHTML = "";
    els.quickOpenEmpty.hidden = state.quickOpenHits.length > 0;

    state.quickOpenHits.forEach((hit, index) => {
      const li = document.createElement("li");
      li.setAttribute("role", "presentation");

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quick-open-item";
      btn.id = `quick-open-item-${index}`;
      // **tab 順から外す。** 選択は aria-activedescendant で伝えているので DOM フォーカスは
      // 入力欄に留める。外さないと Tab で候補 → 背後の要素へ抜けられ、aria-modal="true" の
      // 宣言と食い違う (背後は inert にしていない)。
      btn.tabIndex = -1;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", "false");
      btn.dataset.path = hit.path;
      btn.title = hit.path;

      // **同名ファイルを相対パスで区別できるようにする** (DoD 2 行目)。
      // ファイル名を主、ディレクトリを従として並べる。
      //
      // **コードポイントで切る。** `hit.positions` はコードポイント index なので、
      // `String#lastIndexOf` / `slice` の UTF-16 index と混ぜると絵文字入りのファイル名
      // (`📁メモ帳.md` 等) で 1 つずつずれ、ハイライトが**サロゲートの片割れ**を囲んで
      // `�` になる (実測で確認した)。
      const chars = Array.from(hit.path);
      const slash = chars.lastIndexOf("/");
      const dir = slash === -1 ? "" : chars.slice(0, slash).join("");
      const name = slash === -1 ? hit.path : chars.slice(slash + 1).join("");

      const nameEl = document.createElement("span");
      nameEl.className = "qo-name";
      appendHighlighted(
        nameEl,
        name,
        hit.positions.map((pos) => pos - (slash + 1)),
      );
      btn.appendChild(nameEl);

      if (dir) {
        const dirEl = document.createElement("span");
        dirEl.className = "qo-dir";
        appendHighlighted(dirEl, dir, hit.positions);
        btn.appendChild(dirEl);
      }

      btn.addEventListener("click", () => {
        setQuickOpenIndex(index);
        openSelectedQuickOpen();
      });

      li.appendChild(btn);
      els.quickOpenList.appendChild(li);
    });
  }

  /**
   * 一致した文字を `<mark>` で囲んで追加する。
   *
   * **innerHTML を使わない。** ファイル名は利用者のディスク上の名前で、`<` や `&` を
   * 含みうる。テキストノードと要素で組み立てれば、エスケープ漏れの経路そのものが無い。
   *
   * `positions` は**コードポイント index**（`searchPaths` の返り値と同じ単位）。
   * ここも `Array.from` でコードポイントに割ってから走らせる —— UTF-16 のコードユニットで
   * 数えると絵文字入りのファイル名でサロゲートペアが割れ、`<mark>` に孤立サロゲートが
   * 入って `�` が出る。
   */
  /**
   * @param {HTMLElement} host
   * @param {string} text
   * @param {number[]} positions
   * @returns {void}
   */
  function appendHighlighted(host, text, positions) {
    const chars = Array.from(text);
    const marks = new Set(
      positions.filter((/** @type {number} */ p) => p >= 0 && p < chars.length),
    );
    let buffer = "";
    let inMark = false;
    const flush = () => {
      if (!buffer) return;
      if (inMark) {
        const mark = document.createElement("mark");
        mark.textContent = buffer;
        host.appendChild(mark);
      } else {
        host.appendChild(document.createTextNode(buffer));
      }
      buffer = "";
    };
    for (let i = 0; i < chars.length; i++) {
      const hit = marks.has(i);
      if (hit !== inMark) {
        flush();
        inMark = hit;
      }
      buffer += chars[i];
    }
    flush();
  }

  /**
   * @param {number} index
   * @returns {void}
   */
  function setQuickOpenIndex(index) {
    state.quickOpenIndex = index;
    const items = els.quickOpenList.querySelectorAll(".quick-open-item");
    items.forEach((item, i) => {
      const active = i === index;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", active ? "true" : "false");
      if (active) item.scrollIntoView({ block: "nearest" });
    });
    // スクリーンリーダーに「いまどれを選んでいるか」を伝える
    if (index >= 0) {
      els.quickOpenInput.setAttribute("aria-activedescendant", `quick-open-item-${index}`);
    } else {
      els.quickOpenInput.removeAttribute("aria-activedescendant");
    }
  }

  /**
   * 選択中の候補を開く。
   *
   * **遷移は navigateTo に委ねる。** 未保存確認・履歴・ハイライト・祖先展開は
   * すべてそこが持っているので、独自の遷移経路を作らない (DoD 4 行目)。
   */
  function openSelectedQuickOpen() {
    const hit = state.quickOpenHits[state.quickOpenIndex];
    if (!hit) return;
    // **先に閉じる。** navigateTo が確認ダイアログを出す場合、その裏にパネルが
    // 残っていると操作対象が分からなくなる。
    closeQuickOpen();
    ctx.document.navigateTo(hit.path, { history: "push" }).catch((err) => {
      setStatus("error", errorText(err));
    });
  }

  return {
    wire,
    openQuickOpen,
    closeQuickOpen,
    refreshQuickOpen,
    /**
     * ツリー再描画のたびに母集団を張り直す (app-tree.js から呼ぶ)。
     * @param {import("./quick-open.js").QuickOpenTreeNode} root
     * @returns {void}
     */
    syncPaths(root) {
      state.quickOpenPaths = collectFilePaths(root);
      // 開いたまま watcher の tree イベントが来たら候補も引き直す。母集団だけ更新して
      // 表示を放置すると、消えたファイルが一覧に残って Enter で 404 になる
      if (!els.quickOpen.hidden) refreshQuickOpen();
    },
  };
}
