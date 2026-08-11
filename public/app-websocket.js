/**
 * ライブリロード (WebSocket) の受信と反映 (Issue #78 で app.js から分離)。
 *
 * サーバの watcher が拾った変更を受けて、表示中ファイルの再読込とツリーの再取得を行う。
 * 再接続は指数バックオフ (500ms → 最大 5s)。
 *
 * 依存は `ctx` 経由で遅延束縛する (document / tree / editor を呼ぶため。`app-context.js` の
 * 冒頭を参照)。
 */

import { errorText, fetchJson } from "./app-context.js";
import { t } from "./i18n.js";

const WS_RETRY_INITIAL = 500;
const WS_RETRY_MAX = 5000;

/** @param {import("./app-context.js").Ctx} ctx */
export function createWebSocketClient(ctx) {
  let retryDelay = WS_RETRY_INITIAL;

  /**
   * @param {{ type?: string, path?: string } | null | undefined} msg
   * @returns {Promise<void>}
   */
  async function handleLiveEvent(msg) {
    if (!msg || typeof msg !== "object") return;
    const { state } = ctx;

    const changedPath = msg.path;
    if (msg.type === "changed" && changedPath && changedPath === state.currentPath) {
      if (state.editing) {
        // 編集中にライブリロードが来た = 外部で書き換えられた可能性。
        // 編集内容を保護するため、サーバの最新を取得して競合バナーを出す。
        try {
          const latest = await fetchJson(`/api/file?path=${encodeURIComponent(changedPath)}`);
          ctx.editor.showConflict(latest, ctx.els.editor.value);
          ctx.setStatus("error", t("status.fileUpdatedElsewhere"));
        } catch (err) {
          ctx.setStatus("error", errorText(err));
        }
        return;
      }
      try {
        const data = await ctx.document.loadFile(state.currentPath);
        ctx.document.applyFile(data);
        ctx.setStatus("ok", t("status.reloaded", { path: data.path }));
      } catch (err) {
        ctx.setStatus("error", errorText(err));
      }
      return;
    }

    if (msg.type === "tree" || msg.type === "changed") {
      try {
        const tree = await fetchJson("/api/tree");
        ctx.tree.renderTree(tree);
        if (state.currentPath) {
          if (state.fileButtons.has(state.currentPath)) {
            ctx.tree.highlightSelected(state.currentPath);
          } else {
            ctx.setStatus("error", t("status.fileDeleted", { path: state.currentPath }));
          }
        }
      } catch (err) {
        ctx.setStatus("error", t("status.treeFetchFailed", { msg: errorText(err) }));
      }
    }
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    const ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      retryDelay = WS_RETRY_INITIAL;
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
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, WS_RETRY_MAX);
    });

    ws.addEventListener("error", () => {
      ws.close();
    });
  }

  return { connect, handleLiveEvent };
}
