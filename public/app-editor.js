/**
 * ブラウザ内編集と保存 (Issue #78 で app.js から分離)。
 *
 * 担当:
 *
 * - 編集モードの出入り (TOC の一時退避 / 復元、ボタン表記とアクセシビリティ属性の同期)
 * - 未保存 (dirty) の管理と離脱確認
 * - 保存 (`POST /api/file`) と楽観的ロックによる競合検出
 * - 競合バナー (サーバ内容の取り込み / 強制上書き)
 *
 * プレビューの再描画と TOC の開閉は `ctx.preview` に委ねる (描画は preview の責務)。
 */

import { errorText, fetchJson, sanitize } from "./app-context.js";
import { collapseUnchanged, diffLines } from "./diff.js";
import { t } from "./i18n.js";

export function createEditor(ctx) {
  const { els, state } = ctx;

  /** 409 で受け取ったサーバ側スナップショット (取り込み時に使う)。 */
  let conflictServerSnapshot = null;

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

  function setDirty(dirty) {
    state.dirty = dirty;
    els.dirtyIndicator.hidden = !dirty;
  }

  function enableEditActions(enabled) {
    els.editBtn.disabled = !enabled;
    els.tocBtn.disabled = !enabled;
    els.tocFab.disabled = !enabled;
    els.currentPath.disabled = !enabled;
    if (els.overflowEdit) els.overflowEdit.disabled = !enabled;
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
    if (state.tocVisible) ctx.preview.applyTocVisibility(false, { persist: false });
    els.tocBtn.disabled = true;
    els.tocFab.disabled = true;
    // 編集中はプレビューのチェックボックスを disabled に
    ctx.preview.wireTaskCheckboxes();
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
      ctx.preview.applyTocVisibility(true, { persist: false });
      state.tocSuspended = false;
    }
    // 編集終了でチェックボックスを再びクリック可能に
    ctx.preview.wireTaskCheckboxes();
    // Issue #9: 編集モード中は同期 OFF だったので、出た時に pair を再構築して復活させる
    if (state.viewMode === "split") {
      requestAnimationFrame(() => ctx.preview.rebuildScrollSyncPairs());
    }
  }

  function confirmDiscard() {
    if (!state.dirty) return true;
    return window.confirm(t("confirm.discardEditEnd"));
  }

  /** 遷移前の未保存確認。false なら遷移を中止する。 */
  function confirmLeaveEdit() {
    if (!state.editing || !state.dirty) return true;
    return window.confirm(t("confirm.unsavedContinue"));
  }

  /**
   * 編集内容を保存する。
   *
   * `body` を明示すると**編集モードでなくても保存する**。競合の「強制上書き」は
   * エディタ以外の経路 (プレビューのチェックボックス) からも起こりうるが、そのときは
   * 編集モードでないのでエディタから本文を取れない。明示しなければ従来どおり
   * エディタの中身を保存し、編集モードでなければ何もしない。
   */
  async function saveEdit({ force = false, body: overrideBody = null } = {}) {
    if (overrideBody === null && !state.editing) return false;
    if (!state.currentPath) {
      ctx.setStatus("error", t("status.saveNoFile"));
      return false;
    }
    const body = overrideBody ?? els.editor.value;
    const payload = { path: state.currentPath, body };
    if (!force && state.currentSha) payload.baseSha = state.currentSha;

    try {
      const data = await fetchJson("/api/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      hideConflict();
      if (overrideBody !== null) {
        // エディタ以外の経路。**applyFile に任せる** —— チェックボックスの再 attach や
        // TOC の作り直しまで含めて、通常のファイル反映と同じ状態に戻す
        ctx.document.applyFile(data);
        ctx.setStatus("ok", t("status.saved", { path: state.currentPath }));
        return true;
      }
      state.currentRaw = data.raw;
      state.currentHtml = sanitize(data.html);
      state.currentSha = data.sha;
      setDirty(false);
      if (state.viewMode !== "md") {
        els.preview.innerHTML = state.currentHtml;
        ctx.preview.renderMermaid().catch(() => {});
      }
      els.source.textContent = data.raw;
      ctx.setStatus("ok", t("status.saved", { path: state.currentPath }));
      return true;
    } catch (err) {
      if (err.status === 409 && err.payload) {
        showConflict(err.payload, body);
        ctx.setStatus("error", t("status.conflict"));
      } else {
        ctx.setStatus("error", t("status.saveFailed", { msg: errorText(err) }));
      }
      return false;
    }
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

  /** 編集モードの toggle (編集ボタンと ⋮ メニューの両方から使う)。 */
  function toggleEditMode() {
    if (state.editing) {
      // 編集モード中の「完了」: 未保存があれば保存 → 成功で閉じる、失敗なら編集モード継続
      handleFinishEdit().catch((err) => ctx.setStatus("error", errorText(err)));
    } else {
      enterEditMode();
    }
  }

  /* ===== 競合バナー ===== */

  /**
   * 競合したときに**保存しようとした本文**。
   *
   * **`els.editor.value` では代用できない。** 競合はエディタ以外からも起きる ——
   * プレビューのチェックボックスを切り替えた保存は**編集モードでない**ので、
   * エディタは空のまま。それを「ローカル版」として差分に出すと
   * 「自分の変更が全部消えている」という嘘を見せることになる。
   */
  let conflictLocalBody = null;

  /**
   * 競合を伝える。
   *
   * @param {object} payload 409 のレスポンス (サーバの最新内容)
   * @param {string} localBody 保存しようとした本文
   */
  function showConflict(payload, localBody) {
    conflictServerSnapshot = payload;
    conflictLocalBody = localBody;
    els.conflictBanner.hidden = false;
    // **開いたまま差し替わることがある。** watcher の連続通知でここへ再入すると、
    // 画面は古い差分のままスナップショットだけが新しくなる。そのまま
    // 「サーバ内容を取り込む」を押すと**見ていない内容**が入ってしまう。
    if (!els.conflictDiff.hidden) renderConflictDiff();
  }

  function hideConflict() {
    conflictServerSnapshot = null;
    conflictLocalBody = null;
    els.conflictBanner.hidden = true;
    closeConflictDiff();
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
    if (state.viewMode !== "md") ctx.preview.renderMermaid().catch(() => {});
    hideConflict();
    ctx.setStatus("ok", t("status.serverTaken"));
  }

  function forceOverwrite() {
    // **`hideConflict` より先に読む。** そこで `conflictLocalBody` が捨てられる。
    //
    // 編集中ならエディタから取れるので渡さない (従来どおり)。編集モードでない経路
    // (プレビューのチェックボックス) では、競合したときに保存しようとした本文が
    // ここにしかない。渡さないと editing ガードに弾かれて**無言で何も起きない**。
    const body = state.editing ? null : conflictLocalBody;
    hideConflict();
    saveEdit({ force: true, body });
  }

  /* ===== 競合の差分ダイアログ (Issue #57) ===== */

  /**
   * 変更行の前後に残す同一行の数。
   *
   * 3 行あると「どの段落の話か」が分かる (git の既定と同じ)。増やすほど文脈は増えるが、
   * 差分そのものを探すスクロールも増える。
   */
  const CONFLICT_DIFF_CONTEXT = 3;

  /** 差分ダイアログを閉じたときのフォーカス戻り先。 */
  let conflictDiffReturnFocus = null;

  function wireConflictDiff() {
    els.conflictShowDiff.addEventListener("click", () => openConflictDiff());
    els.conflictDiffClose.addEventListener("click", () => closeConflictDiff());
    els.conflictDiffTakeServer.addEventListener("click", () => takeServerVersion());
    els.conflictDiffOverwrite.addEventListener("click", () => forceOverwrite());
    els.conflictDiffCopyLocal.addEventListener("click", (ev) =>
      copyConflictSide(conflictLocalBody ?? "", "conflict.diff.copiedLocal", ev.currentTarget),
    );
    els.conflictDiffCopyServer.addEventListener("click", (ev) =>
      copyConflictSide(
        conflictServerSnapshot?.raw ?? "",
        "conflict.diff.copiedServer",
        ev.currentTarget,
      ),
    );

    // 背景 (パネルの外) をクリックしたら閉じる
    els.conflictDiff.addEventListener("click", (ev) => {
      if (ev.target === els.conflictDiff) closeConflictDiff();
    });

    // **`document` の capture で拾う。** パネル要素に付けると、フォーカスがパネル外へ
    // 落ちた瞬間に Esc も Tab も届かなくなる (クイックオープンで踏んだのと同じ罠。
    // `wireQuickOpen` のコメントに理由を書いてある)。
    document.addEventListener(
      "keydown",
      (ev) => {
        if (els.conflictDiff.hidden) return;
        handleConflictDiffKeydown(ev);
      },
      true,
    );
  }

  function handleConflictDiffKeydown(ev) {
    if (ev.isComposing) return;

    if (ev.key === "Escape") {
      // **バブルさせない。** 最前面 (z-index 70) なので、1 回の Esc で背後の
      // sidebar や外部リンクバナーまで閉じてはいけない
      ev.preventDefault();
      ev.stopPropagation();
      closeConflictDiff();
      return;
    }

    if (ev.key === "Tab") {
      // **フォーカスをダイアログに閉じ込める。** `aria-modal="true"` を宣言している以上、
      // 背後のエディタやツリーへ抜けられるのは宣言と実体の食い違いになる。
      // ここはクイックオープンと違って**フォーカスできる要素が複数ある**ので、
      // 端で折り返す本来のフォーカストラップが要る。
      const focusables = conflictDiffFocusables();
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (!els.conflictDiff.contains(active)) {
        ev.preventDefault();
        (ev.shiftKey ? last : first).focus();
        return;
      }
      if (ev.shiftKey && active === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && active === last) {
        ev.preventDefault();
        first.focus();
      }
    }
  }

  /** ダイアログ内でフォーカスを取れる要素を、DOM 順で返す。 */
  function conflictDiffFocusables() {
    return Array.from(
      els.conflictDiff.querySelectorAll("button:not([disabled]), [tabindex='0']"),
    ).filter((el) => {
      // **祖先の hidden まで見る。** `Element.hidden` は自要素の属性しか反映しないので、
      // 隠したラッパーの中のボタンを拾ってしまう。`checkVisibility` があればそれを使う
      // (jsdom には無いので、無ければ祖先を辿る。`offsetParent` はレイアウトが要るので使わない)
      if (typeof el.checkVisibility === "function") return el.checkVisibility();
      for (
        let node = el;
        node && node !== els.conflictDiff.parentElement;
        node = node.parentElement
      ) {
        if (node.hidden) return false;
      }
      return true;
    });
  }

  function openConflictDiff() {
    if (!conflictServerSnapshot) return;
    // 再入すると戻り先がダイアログ内の要素で上書きされ、閉じたときの復帰が壊れる
    if (!els.conflictDiff.hidden) return;
    conflictDiffReturnFocus = document.activeElement;
    els.conflictDiffNotice.hidden = true;
    els.conflictDiffNotice.textContent = "";
    // **先に表示してから中身を書く。** live region (`role="status"`) の更新は
    // 「表示されている領域が変化したとき」に通知される。hidden な祖先の中で
    // textContent を書き換えてから表示しても、多くの支援技術は読み上げない。
    // (開いた瞬間の読み上げには `aria-describedby` でも件数が乗る)
    els.conflictDiff.hidden = false;
    renderConflictDiff();
    // 最初のフォーカスは先頭の要素へ。通常は差分本体なので、**まず中身を読ませる**形になる
    // (いきなり「サーバ内容を取り込む」に当てない —— 誤爆すると編集が消える)。
    // 大きすぎて差分を出せなかったときは本体が hidden なので、自動的に次の要素へ回る
    conflictDiffFocusables()[0]?.focus();
  }

  function closeConflictDiff() {
    if (els.conflictDiff.hidden) return;
    els.conflictDiff.hidden = true;
    els.conflictDiffBody.replaceChildren();
    const back = conflictDiffReturnFocus;
    conflictDiffReturnFocus = null;
    // **`<body>` は戻り先として採用しない。** 「どこにも当たっていない」のと同じで、
    // キーボード操作の起点が消える。
    //
    // **戻り先が消えていることがある。** 採用・上書きを選ぶとバナーごと閉じるので、
    // ダイアログやバナーの中にあった戻り先は非表示になる。`isConnected` は true のままで
    // 空振りを検出できないため、`focus()` が実際に効いたかを見る。
    const candidates = [
      back,
      els.conflictBanner.hidden ? null : els.conflictShowDiff,
      // まだ編集中なら本文へ返す (競合は編集中に起きるので、ここが自然な続き)
      state.editing ? els.editor : null,
      els.editBtn,
    ];
    for (const el of candidates) {
      if (!el || el === document.body || !el.isConnected || typeof el.focus !== "function")
        continue;
      el.focus();
      if (document.activeElement === el) return;
    }
  }

  function renderConflictDiff() {
    const localText = conflictLocalBody ?? "";
    const serverText = conflictServerSnapshot?.raw ?? "";
    const result = diffLines(localText, serverText);

    // サーバ側でファイルが消えていると `raw` は null。コピーしても空文字なので押させない
    const serverGone = conflictServerSnapshot?.raw == null;
    els.conflictDiffCopyServer.disabled = serverGone;
    els.conflictDiffCopyServer.title = serverGone ? t("conflict.diff.serverGone") : "";

    els.conflictDiffTruncated.hidden = !result.truncated;
    els.conflictDiffBody.replaceChildren();
    // **差分が無いなら枠も凡例も出さない。** 空の枠と「- ローカル / + サーバ」だけが
    // 残ると、差分を出そうとして失敗したように見える
    els.conflictDiffBody.hidden = result.truncated;
    els.conflictDiffLegend.hidden = result.truncated;

    if (result.truncated) {
      // 差分は出さないが、**選択肢は残す**。人は中身をコピーして自分で比べられる
      els.conflictDiffSummary.textContent = "";
      return;
    }

    // **`diffLines` はローカル → サーバの向き**なので、`removed` が「ローカルにしかない行」、
    // `added` が「サーバにしかない行」。文言も左右で言い切り、増えた/減ったと言わない
    // (どちらを基準に増減と呼ぶかは読み手によって逆になる)。
    els.conflictDiffSummary.textContent =
      result.stats.added === 0 && result.stats.removed === 0
        ? t("conflict.diff.identical")
        : t("conflict.diff.summary", {
            local: String(result.stats.removed),
            server: String(result.stats.added),
          });

    const frag = document.createDocumentFragment();
    for (const row of collapseUnchanged(result.rows, CONFLICT_DIFF_CONTEXT)) {
      frag.appendChild(
        row.type === "skip" ? buildConflictSkipRow(row.count) : buildConflictDiffRow(row),
      );
    }
    els.conflictDiffBody.appendChild(frag);
  }

  /**
   * 差分 1 行を組み立てる。
   *
   * **innerHTML を使わない。** 中身は Markdown の生テキストなので `<script>` も `&` も
   * 入りうる。テキストノードで組み立てれば、エスケープ漏れの経路そのものが無い
   * (Issue #21 / #59 のサニタイズ方針を迂回しない)。
   */
  function buildConflictDiffRow(row) {
    const div = document.createElement("div");
    div.className = `conflict-diff-row is-${row.type}`;

    const no = document.createElement("span");
    no.className = "conflict-diff-no";
    // 片側にしか無い行は、その側の番号だけを出す
    no.textContent = row.type === "add" ? String(row.rightNo) : String(row.leftNo);
    div.appendChild(no);

    const sign = document.createElement("span");
    sign.className = "conflict-diff-sign";
    // **色だけに頼らない。** 記号があれば白黒でも色覚特性があっても読み取れる
    sign.textContent = row.type === "del" ? "-" : row.type === "add" ? "+" : " ";
    div.appendChild(sign);

    const text = document.createElement("span");
    text.className = "conflict-diff-text";
    text.textContent = row.text;
    div.appendChild(text);

    return div;
  }

  function buildConflictSkipRow(count) {
    const div = document.createElement("div");
    div.className = "conflict-diff-skip";
    div.textContent = t("conflict.diff.skipped", { count: String(count) });
    return div;
  }

  async function copyConflictSide(text, messageKey, button) {
    let message;
    try {
      await ctx.document.copyTextToClipboard(text);
      message = t(messageKey);
      ctx.setStatus("ok", message);
    } catch {
      message = t("conflict.diff.copyFailed");
      ctx.setStatus("error", message);
    }
    // **パネルの中にも出す。** `#status` は topbar にあり、このダイアログのスクリムの下
    // (z-index 70) に隠れて見えない
    els.conflictDiffNotice.textContent = message;
    els.conflictDiffNotice.hidden = false;
    // **フォーカスを押したボタンへ戻す。** 非セキュアコンテキスト (LAN の HTTP = yomi の
    // 主用途) では `execCommand` フォールバックが一時 textarea を作って消すので、
    // 終わったときフォーカスが `<body>` に落ちている
    if (button?.isConnected) button.focus();
  }

  function wireEditActions() {
    enableEditActions(false);
    els.editBtn.addEventListener("click", toggleEditMode);

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

  /** タブを閉じようとしたときに未保存を警告する。 */
  function wireBeforeUnload() {
    window.addEventListener("beforeunload", (ev) => {
      if (state.editing && state.dirty) {
        ev.preventDefault();
        ev.returnValue = "";
      }
    });
  }

  return {
    wireEditActions,
    wireBeforeUnload,
    enterEditMode,
    exitEditMode,
    toggleEditMode,
    handleFinishEdit,
    setDirty,
    enableEditActions,
    confirmLeaveEdit,
    saveEdit,
    syncEditButtonLabels,
    showConflict,
    hideConflict,
    wireConflictDiff,
    renderConflictDiff,
    isConflictDiffOpen: () => !els.conflictDiff.hidden,
  };
}
