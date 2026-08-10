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

  async function saveEdit({ force = false } = {}) {
    if (!state.editing) return false;
    if (!state.currentPath) {
      ctx.setStatus("error", t("status.saveNoFile"));
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
      state.currentHtml = sanitize(data.html);
      state.currentSha = data.sha;
      setDirty(false);
      hideConflict();
      if (state.viewMode !== "md") {
        els.preview.innerHTML = state.currentHtml;
        ctx.preview.renderMermaid().catch(() => {});
      }
      els.source.textContent = data.raw;
      ctx.setStatus("ok", t("status.saved", { path: state.currentPath }));
      return true;
    } catch (err) {
      if (err.status === 409 && err.payload) {
        showConflict(err.payload);
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
    hideConflict();
    saveEdit({ force: true });
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
  };
}
