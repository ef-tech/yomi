/**
 * スマホ向け UI (Issue #78 で app.js から分離)。
 *
 * 担当は Issue #25 / #30 で入れた 4 つ:
 *
 * - sidebar overlay (ハンバーガー / backdrop / Esc / 幅が戻ったら自動で閉じる)
 * - ⋮ overflow メニュー (テーマ・表示モード・編集の複製)
 * - FAB 目次
 * - sticky topbar の自動 hide/show とエッジスワイプでの drawer 開閉
 *
 * テーマ / 表示モード / 編集の実処理は PC 側と同じものを `ctx` 経由で呼ぶ。
 * **overflow メニューは操作の入口が増えただけ**で、挙動を二重に持たせない。
 */

import { isTopOverlay } from "./app-overlays.js";

const TOPBAR_HIDE_THRESHOLD = 5; // この px 以上下スクロールで hide
const TOPBAR_TOP_GUARD = 30; // 上端 30px 以内では常に show

const SWIPE_EDGE_PX = 24;
const SWIPE_MIN_DX = 60;
const SWIPE_MAX_DY = 50;

/** @param {import("./app-context.js").Ctx} ctx */
export function createMobileUi(ctx) {
  const { els, state } = ctx;
  // **生成時に他モジュールを読まない。** ctx.mobileQuery は app.js が els / state と一緒に
  // 作るので、ここで掴んでもモジュールの生成順に依存しない。
  const { mobileQuery } = ctx;

  /**
   * @param {boolean} open
   * @returns {void}
   */
  function setSidebarOpen(open) {
    els.sidebar.classList.toggle("is-open", open);
    els.sidebarBackdrop.hidden = !open;
    els.menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  /** スマホ表示でファイルを選んだら自動で sidebar を閉じる */
  function closeSidebarIfMobile() {
    if (mobileQuery.matches) setSidebarOpen(false);
  }

  /**
   * @param {boolean} open
   * @returns {void}
   */
  function setOverflowOpen(open) {
    els.overflowMenu.hidden = !open;
    els.overflowBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function wireSidebar() {
    els.menuBtn.addEventListener("click", () => {
      const isOpen = els.sidebar.classList.contains("is-open");
      setSidebarOpen(!isOpen);
    });
    els.sidebarBackdrop.addEventListener("click", () => setSidebarOpen(false));
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      // **最前面のときだけ閉じる (Issue #112)。** 以前は「外部 URL バナーが開いていたら
      // 譲る」を各所に個別に書いていたので、オーバーレイが増えるたびに条件が増え、
      // しかも書き忘れても片方だけ使う限り気づけなかった
      if (!isTopOverlay("sidebar", els)) return;
      // もう誰かが Esc を消費していたら譲る (Issue #112)
      if (ev.defaultPrevented) return;
      // **必ず奪う。** 奪わないと、後続のハンドラが「まだ誰も処理していない」と見て
      // 同じ Esc でもう 1 枚閉じる
      ev.preventDefault();
      setSidebarOpen(false);
    });
    // viewport がデスクトップ幅に戻ったら自動で閉じる (overlay 状態が残ると視覚的に変)
    mobileQuery.addEventListener("change", (ev) => {
      if (!ev.matches) setSidebarOpen(false);
    });
  }

  function wireOverflowMenu() {
    els.overflowBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      // `hidden` は `boolean | "until-found"`。どちらも「隠れている」なので真偽に潰す
      // （従来の JS も truthy 判定で同じ結果になっていた）
      setOverflowOpen(Boolean(els.overflowMenu.hidden));
    });
    // 外クリックで閉じる
    document.addEventListener("click", (ev) => {
      if (els.overflowMenu.hidden) return;
      // `EventTarget` は `Node` とは限らないが、click の実物は常に要素。
      // **`instanceof` で絞らない** —— 実行時チェックを足すと挙動が変わる
      // (理由の詳細は i18n.js の applyI18n)
      const target = /** @type {Node | null} */ (ev.target);
      if (els.overflowMenu.contains(target)) return;
      if (els.overflowBtn.contains(target)) return;
      setOverflowOpen(false);
    });
    // Esc で閉じる。優先順位の判定は `app-overlays.js` に一本化してある (Issue #112)
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (!isTopOverlay("overflowMenu", els)) return;
      if (ev.defaultPrevented) return;
      ev.preventDefault();
      setOverflowOpen(false);
    });

    // **PC 側トグルと同じ関数を呼ぶ。** overflow メニューは操作の入口が増えただけで、
    // 挙動を二重に持たせない (分割前は同じ本文が 2 箇所に重複していた)。
    for (const btn of els.overflowThemeBtns) {
      btn.addEventListener("click", () => ctx.preview.selectThemeMode(btn.dataset.themeMode));
    }
    for (const btn of els.overflowViewBtns) {
      btn.addEventListener("click", () => ctx.preview.selectViewMode(btn.dataset.mode));
    }

    // overflow-edit → 編集モード toggle (既存 editBtn と同じ動作)
    els.overflowEdit.addEventListener("click", () => {
      setOverflowOpen(false);
      ctx.editor.toggleEditMode();
    });
  }

  function wireTocFab() {
    els.tocFab.addEventListener("click", () => {
      if (state.editing) return;
      ctx.preview.toggleToc();
    });
  }

  function wireTopbarAutohide() {
    const topbar = document.querySelector(".topbar");
    if (!topbar) return;
    const targets = [els.preview, els.source];
    const lastY = new WeakMap();
    /**
     * @param {HTMLElement} target
     * @returns {void}
     */
    const onScroll = (target) => {
      if (!mobileQuery.matches) return;
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

  function wireSidebarSwipe() {
    /** @type {number | null} */
    let startX = null;
    /** @type {number | null} */
    let startY = null;
    let startedFromEdge = false;
    let startedInDrawer = false;

    document.addEventListener(
      "touchstart",
      (ev) => {
        if (!mobileQuery.matches) return;
        if (ev.touches.length !== 1) return;
        const t = ev.touches[0];
        if (!t) return;
        startX = t.clientX;
        startY = t.clientY;
        const open = els.sidebar.classList.contains("is-open");
        startedFromEdge = !open && t.clientX <= SWIPE_EDGE_PX;
        startedInDrawer = open && els.sidebar.contains(/** @type {Node | null} */ (ev.target));
      },
      { passive: true },
    );

    document.addEventListener(
      "touchend",
      (ev) => {
        if (!mobileQuery.matches) return;
        if (startX === null || startY === null) return;
        const t = ev.changedTouches[0];
        if (!t) return;
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

  // **wire は 1 本にまとめず個別に公開する。** Esc の扱いは*リスナーの登録順*に依存する:
  // sidebar の Esc ハンドラは「外部 URL バナーが開いていたら何もしない」で譲り、後から
  // 登録される app.js 側のハンドラがバナーを閉じる。まとめて後で呼ぶと順序が逆転し、
  // 「Esc 1 回でバナーも sidebar も閉じる」という別の挙動になる (特性テストが検出した)。
  return {
    setSidebarOpen,
    closeSidebarIfMobile,
    setOverflowOpen,
    wireSidebar,
    wireOverflowMenu,
    wireTocFab,
    wireTopbarAutohide,
    wireSidebarSwipe,
  };
}
