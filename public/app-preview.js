/**
 * プレビュー描画まわり (Issue #78 で app.js から分離)。
 *
 * 担当:
 *
 * - Mermaid の初期化と描画 (Issue #52 / #59 のセキュリティ設定を含む)
 * - 表示モード切替 (preview / split / md) とテーマ切替
 * - split モードのスクロール同期 (Issue #9)
 * - GFM タスクリストのチェックボックス (Issue #17)
 * - 目次 (TOC) の生成・開閉・追従ハイライト
 *
 * まとまりとしては「右ペインに出るもの」。テーマがここにあるのは、切り替えると
 * Mermaid を初期化し直して再描画する必要があるため (描画と不可分)。
 */

import { errorText, fetchJson, messageOf, THEME_MODES, VIEW_MODES } from "./app-context.js";
import { isTopOverlay } from "./app-overlays.js";
import { t } from "./i18n.js";
import { MERMAID_SECURE_KEYS } from "./mermaid-config.js";
import { prefs } from "./prefs.js";
import { findHeadingLines, mapScrollTop } from "./scroll-sync.js";
import { toggleTaskInMarkdown } from "./task-list.js";
import { buildTocTree } from "./toc.js";
import mermaid from "./vendor/mermaid.js";

/** @param {import("./app-context.js").Ctx} ctx */
export function createPreview(ctx) {
  const { els, state } = ctx;

  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  // pair: { sourceY: number, previewY: number } の配列 (sourceY 昇順)
  /** @type {{ sourceY: number, previewY: number }[]} */
  let scrollSyncPairs = [];
  let scrollSyncing = false;

  /* ===== Mermaid ===== */

  /**
   * @param {string} mode
   * @returns {"light" | "dark"}
   */
  function effectiveTheme(mode) {
    if (mode === "light") return "light";
    if (mode === "dark") return "dark";
    return darkQuery.matches ? "dark" : "light";
  }

  /**
   * @param {string} mode
   * @returns {void}
   */
  function initMermaid(mode) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // Issue #59: init directive (`%%{init: ...}%%`) による CSS 注入を防ぐ。
      // securityLevel:"strict" の既定 secure リストは themeCSS 等の CSS 系キーを保護しないため、
      // 悪意ある md が themeCSS を上書きすると mermaid.run() が sanitize 後に生成する SVG の
      // <style> に任意 CSS が入る。インライン SVG の <style> は文書全体へ作用するため、
      // 属性セレクタ + background:url(...) で CSS exfiltration が成立してしまう。
      // 既定 secure (mermaid 11.x) に CSS 系キーを加えて directive での上書きを禁止する。
      secure: [...MERMAID_SECURE_KEYS],
      theme: effectiveTheme(mode) === "dark" ? "dark" : "default",
    });
  }

  async function renderMermaid() {
    const nodes = /** @type {NodeListOf<HTMLElement>} */ (
      els.preview.querySelectorAll("pre.mermaid")
    );
    if (nodes.length === 0) return;
    try {
      await mermaid.run({ nodes });
    } catch (err) {
      console.error("Mermaid render error:", err);
      ctx.setStatus("error", t("status.mermaidError", { msg: messageOf(err) }));
    }
  }

  /**
   * ハイライト言語 ID として CSS クラスに載せてよい形か (Issue #155)。
   *
   * 値はサーバの allowlist (`src/util/text-ext.ts`) 由来なので現実には安全だが、
   * **`class` 属性へ値を流す唯一の経路**なので、ここでも形を確かめる
   * (`asset-ext.ts` が `isAssetExtension` を二重に掛けているのと同じ考え方)。
   *
   * @param {string | null} lang
   * @returns {boolean}
   */
  function isSafeLanguageId(lang) {
    return typeof lang === "string" && /^[a-z0-9+#-]{1,32}$/.test(lang);
  }

  /**
   * テキストファイルを読み取り専用で描く (Issue #155)。
   *
   * **`innerHTML` を使わない。** 中身は利用者のファイルそのもので、HTML として解釈させる
   * 理由がない（#21 / #59 の経緯。サニタイズに頼るより、そもそも解釈させないほうが強い）。
   * `textContent` に入れればブラウザは文字として扱う。
   *
   * ハイライトは Issue #155 のコミット C で `code` 要素へ後から当てる。ここでは
   * `language-*` クラスを付けるところまでを担う。
   */
  function renderTextFile() {
    const pre = document.createElement("pre");
    pre.className = "text-view";
    const code = document.createElement("code");
    if (isSafeLanguageId(state.currentLang)) code.className = `language-${state.currentLang}`;
    code.textContent = state.currentRaw;
    pre.appendChild(code);
    els.preview.replaceChildren(pre);
    els.preview.classList.add("is-text");
    // **表示モードは preview に固定する。** split / md は「ソースとプレビュー」を
    // 出し分けるものなので、raw しか無いテキストでは同じ中身が 2 つ並ぶだけになる。
    // `state.viewMode` は書き換えない —— 利用者が選んだモードは Markdown へ戻ったときに戻す
    els.contentBody.dataset.mode = "preview";
    setViewToggleEnabled(false);
    return code;
  }

  /**
   * 表示モードの切替ボタンをまとめて有効・無効にする (Issue #155)。
   *
   * @param {boolean} enabled
   * @returns {void}
   */
  function setViewToggleEnabled(enabled) {
    for (const btn of els.toggleButtons) {
      /** @type {HTMLButtonElement} */ (btn).disabled = !enabled;
    }
    for (const btn of els.overflowViewBtns) {
      /** @type {HTMLButtonElement} */ (btn).disabled = !enabled;
    }
  }

  function renderCurrentFile() {
    els.source.textContent = state.currentRaw;
    els.source.scrollTop = 0;

    if (state.currentKind === "text") {
      renderTextFile();
      els.preview.scrollTop = 0;
      // 見出しが無いので同期する対がない（残しておくと前のファイルの対で飛ぶ）
      scrollSyncPairs = [];
      return;
    }

    els.preview.classList.remove("is-text");
    els.preview.innerHTML = state.currentHtml;
    // テキストから戻ってきたときに、利用者が選んでいたモードへ復帰する
    els.contentBody.dataset.mode = state.viewMode;
    setViewToggleEnabled(true);
    els.preview.scrollTop = 0;
    if (state.viewMode !== "md") {
      renderMermaid()
        .catch(() => {})
        .finally(() => rebuildScrollSyncPairs());
    } else {
      rebuildScrollSyncPairs();
    }
  }

  /** OS のダーク設定が変わったら、テーマが auto のときだけ追従する。 */
  function wireSystemThemeFollow() {
    darkQuery.addEventListener("change", () => {
      if (state.themeMode !== "auto") return;
      initMermaid(state.themeMode);
      if (state.currentHtml && state.viewMode !== "md") {
        renderCurrentFile();
      }
    });
  }

  /* ===== Issue #9: split mode スクロール同期 ===== */

  function rebuildScrollSyncPairs() {
    scrollSyncPairs = [];
    if (!state.currentRaw) return;
    const headingLines = findHeadingLines(state.currentRaw);
    if (headingLines.length === 0) return;
    // preview 側の data-line 付き要素を line→Y で索引化
    const previewHeadings = /** @type {NodeListOf<HTMLElement>} */ (
      els.preview.querySelectorAll("[data-line]")
    );
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

  /* ===== 表示モード切替 ===== */

  function saveViewMode() {
    prefs.viewMode.save(state.viewMode);
  }

  /**
   * @param {string} mode
   * @returns {void}
   */
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

  /**
   * 表示モードを選ぶ。**PC のトグルとスマホの ⋮ メニューが共有する**
   * (入口が違うだけで挙動は同じ)。不正値・同一モードは無視する。
   */
  /**
   * @param {string | null | undefined} mode
   * @returns {void}
   */
  function selectViewMode(mode) {
    if (!mode || !VIEW_MODES.includes(mode)) return;
    // **テキスト表示中は preview 固定 (Issue #155)。** ボタンは無効化してあるが、
    // ショートカットや ⋮ メニュー経由でも同じ判断になるようここでも止める
    if (state.currentKind === "text") return;
    if (state.viewMode === mode) return;
    // ユーザが手動で viewMode を変えたなら、TOC による一時的な preview override は破棄
    // (後から TOC を閉じても、ユーザの選択を尊重する)
    state.tocPreviewOverride = false;
    applyViewMode(mode);
    saveViewMode();
    if (state.currentHtml && mode !== "md") {
      renderMermaid().catch(() => {});
    }
  }

  function wireViewToggle() {
    for (const btn of els.toggleButtons) {
      btn.addEventListener("click", () => selectViewMode(btn.dataset.mode));
    }
  }

  /* ===== テーマ切替 ===== */

  function saveThemeMode() {
    prefs.themeMode.save(state.themeMode);
  }

  /**
   * @param {string} mode
   * @returns {void}
   */
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

  /** テーマを選ぶ。**PC のトグルとスマホの ⋮ メニューが共有する**。 */
  /**
   * @param {string | null | undefined} mode
   * @returns {void}
   */
  function selectThemeMode(mode) {
    if (!mode || !THEME_MODES.includes(mode)) return;
    if (state.themeMode === mode) return;
    applyThemeMode(mode);
    saveThemeMode();
    initMermaid(mode);
    if (state.currentHtml && state.viewMode !== "md") {
      renderCurrentFile();
    }
  }

  function wireThemeToggle() {
    for (const btn of els.themeButtons) {
      btn.addEventListener("click", () => selectThemeMode(btn.dataset.themeMode));
    }
  }

  /* ===== インタラクティブ チェックボックス (Issue #17) ===== */

  /**
   * @param {Event} ev
   * @returns {Promise<void>}
   */
  async function onTaskCheckboxToggle(ev) {
    const target = /** @type {HTMLInputElement | null} */ (ev.currentTarget);
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
      ctx.setStatus("error", t("status.taskLocateFailed"));
      return;
    }

    /** @type {{ path: string, body: string, baseSha?: string }} */
    const payload = { path: state.currentPath, body };
    if (state.currentSha) payload.baseSha = state.currentSha;

    // 再入防止: 連続クリックを 1 回分だけ受け付ける
    target.disabled = true;

    try {
      // 保存の応答は Markdown 専用（テキストには書き込めない。Issue #155）
      /** @type {import("./api-types.js").MarkdownFileResponse} */
      const data = await fetchJson("/api/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      // applyFile 経由で再描画: state 更新 + DOM + TOC + チェックボックス再 attach を一括
      ctx.document.applyFile(data);
      ctx.setStatus(
        "ok",
        t("status.taskUpdated", {
          path: state.currentPath,
          state: newChecked ? t("task.on") : t("task.off"),
        }),
      );
    } catch (err) {
      target.checked = !target.checked; // revert UI
      target.disabled = state.editing;
      const e = /** @type {import("./app-context.js").ApiError} */ (err);
      if (e.status === 409 && e.payload) {
        // **エディタの中身ではなく、チェックを反映した本文を渡す。**
        // この経路は編集モードでないのでエディタは空
        ctx.editor.showConflict(/** @type {any} */ (e.payload), body);
        ctx.setStatus("error", t("status.conflict"));
      } else {
        ctx.setStatus("error", t("status.saveFailed", { msg: errorText(err) }));
      }
    }
  }

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
    const boxes = /** @type {NodeListOf<HTMLInputElement>} */ (
      els.preview.querySelectorAll('input[type="checkbox"]')
    );
    boxes.forEach((box, idx) => {
      box.dataset.taskIndex = String(idx);
      box.disabled = state.editing;
      box.removeEventListener("change", onTaskCheckboxToggle);
      box.addEventListener("change", onTaskCheckboxToggle);
    });
  }

  /* ===== TOC (目次) ===== */

  function teardownTocObserver() {
    if (state.tocObserver) {
      state.tocObserver.disconnect();
      state.tocObserver = null;
    }
  }

  /**
   * @param {HTMLElement} previewEl
   * @returns {{ level: number, text: string, id: string, el: Element }[]}
   */
  function collectHeadings(previewEl) {
    return Array.from(previewEl.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((el) => ({
      level: Number(el.tagName.substring(1)),
      text: el.textContent ?? "",
      id: el.id,
      el,
    }));
  }

  /**
   * @param {import("./toc.js").TocNode} node
   * @returns {HTMLLIElement}
   */
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

  /**
   * @param {import("./toc.js").TocNode[]} tree
   * @returns {void}
   */
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

  /**
   * @param {{ level: number, text: string, id: string, el: Element }[]} headings
   * @param {number} maxLevel
   * @returns {void}
   */
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

  function refreshToc() {
    if (!state.tocVisible) return;
    const headings = collectHeadings(els.preview);
    const maxLevel = state.tocExpandLevel === "h6" ? 6 : 3;
    const tree = buildTocTree(headings, maxLevel);
    renderTocTree(tree);
    setupTocHighlight(headings, maxLevel);
  }

  function updateExpandToggleUi() {
    const isExpanded = state.tocExpandLevel === "h6";
    els.tocExpandToggle.setAttribute("aria-pressed", isExpanded ? "true" : "false");
    els.tocExpandToggle.textContent = isExpanded ? t("toc.collapseH4") : t("toc.expandH4");
    // title も状態に追従させる (data-i18n-title は常に展開側なので、ここで上書き)
    els.tocExpandToggle.title = isExpanded ? t("toc.collapseH4.title") : t("toc.expandH4.title");
  }

  /**
   * @param {boolean} visible
   * @param {{ persist?: boolean }} [options]
   * @returns {void}
   */
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

  function wireTocActions() {
    els.tocBtn.disabled = true;
    els.tocBtn.addEventListener("click", () => toggleToc());
    els.tocClose.addEventListener("click", () => applyTocVisibility(false));
    // **Esc で閉じる (Issue #135)。** スマホ幅では全画面パネルになるのに閉じる導線が
    // `×` ボタンしか無く、他の全画面パネルと作法が揃っていなかった。
    // 優先順位の判定は `app-overlays.js` に一本化してある (Issue #112)
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (!isTopOverlay("tocPanel", els)) return;
      // もう誰かが Esc を消費していたら譲る (Issue #112)
      if (ev.defaultPrevented) return;
      // **必ず奪う。** 奪わないと、後続のハンドラが「まだ誰も処理していない」と見て
      // 同じ Esc でもう 1 枚閉じる
      ev.preventDefault();
      applyTocVisibility(false);
    });
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

  return {
    initMermaid,
    renderMermaid,
    renderCurrentFile,
    renderTextFile,
    setViewToggleEnabled,
    wireSystemThemeFollow,
    rebuildScrollSyncPairs,
    wireScrollSync,
    applyViewMode,
    saveViewMode,
    selectViewMode,
    wireViewToggle,
    applyThemeMode,
    saveThemeMode,
    selectThemeMode,
    wireThemeToggle,
    wireTaskCheckboxes,
    wireTocActions,
    toggleToc,
    applyTocVisibility,
    refreshToc,
    updateExpandToggleUi,
  };
}
