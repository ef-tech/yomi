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
          /** @type {import("./api-types.js").ConflictPayload} */
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

    // **`changed` ではツリーを取り直さない (Issue #84)。** 内容が変わっただけで
    // 構造は変わっていないのに、ここまで来ると `/api/tree` を取り直してツリー全体を
    // 作り直していた。10,000 ファイルで **1 イベントあたり 216ms + 724 KiB** の無駄
    // （実測は `docs/bench/tree-baseline.md`）。**構造が変わるのは `rename` 由来の
    // `tree` だけ**で、サーバはそれを型で区別して送っている (`src/server.ts`)。
    if (msg.type === "tree") await refreshTree();
  }

  /**
   * ツリーを取り直して描き直す。
   *
   * @returns {Promise<void>}
   */
  async function refreshTree() {
    const { state } = ctx;
    try {
      /** @type {import("./api-types.js").TreeNode} */
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

  /**
   * **再接続したら 1 回だけツリーを取り直す (Issue #84)。**
   *
   * `changed` で毎回取り直すのをやめたぶん、**取りこぼしの自動復旧が無くなった** ——
   * 以前は誰かがファイルを保存するたびに全量を取り直しており、それが事実上の
   * 再同期になっていた。切れている間の追加・削除は誰も拾わないし、
   * chokidar 自体も取りこぼす (`src/watcher.ts` / Issue #119)。
   *
   * 初回の取得は `app.js` の init が行うので、**2 回目以降の `open` でだけ**動かす。
   */
  let connectedOnce = false;

  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    const ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      retryDelay = WS_RETRY_INITIAL;
      if (connectedOnce) void refreshTree();
      connectedOnce = true;
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

  return { connect, handleLiveEvent, refreshTree };
}
