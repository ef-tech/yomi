/**
 * 特性テスト: ライブリロード (WebSocket) 責務 (Issue #77)
 *
 * サーバからの changed / tree 通知を受けたときの再読込・競合検出・ツリー更新と、
 * 切断からの再接続を固定する。
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type AppHarness,
  type BootOptions,
  bootApp,
  resetAppEnvironment,
  type TreeNode,
} from "./helpers/app-harness.ts";

/**
 * **`README.md` を開いた状態で起動する** (Issue #145)。
 *
 * このファイルの主題は**どのファイルが開くかではない**。`bootApp()` の既定は
 * **ツリー最初のファイル**で、`defaultTree()` を実サーバの並び（ディレクトリが先）に
 * 直した結果それは `docs/deep/note.md` になった。以前はここが偶然 `README.md` だったので、
 * テストは**何も指定せずに README を前提**に書かれていた。前提を明示に変えれば、
 * fixture の並びが変わっても壊れない。
 */
const boot = (options: BootOptions = {}) =>
  bootApp({ url: "http://localhost:3944/?path=README.md", ...options });

let h: AppHarness;

afterEach(resetAppEnvironment);

function fileGets(harness: AppHarness) {
  return harness.fetchCalls.filter((c) => c.url.startsWith("/api/file?") && c.method === "GET");
}

function treeGets(harness: AppHarness) {
  return harness.fetchCalls.filter((c) => c.url.startsWith("/api/tree"));
}

describe("接続", () => {
  test("起動時に /ws へ接続する", async () => {
    h = await boot();
    expect(h.sockets).toHaveLength(1);
    expect(h.ws.url).toBe("ws://localhost:3944/ws");
  });

  test("切断されたら再接続する", async () => {
    h = await boot();
    h.ws.close();

    // 初回のリトライ間隔は 500ms。実時間で待つ (fake timer を使うと app.js 側の
    // setTimeout(connectLiveReload) が動かない)
    const deadline = Date.now() + 3000;
    while (h.sockets.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(h.sockets.length).toBeGreaterThanOrEqual(2);
    expect(h.sockets.at(-1)?.closed).toBe(false);
  });

  test("error を受けたら close する (close ハンドラ経由で再接続に入る)", async () => {
    h = await boot();
    const first = h.ws;
    first.dispatch("error", {});
    expect(first.closed).toBe(true);
  });
});

describe("changed 通知", () => {
  test("表示中のファイルが変わったら読み直して status を ok にする", async () => {
    h = await boot();
    const before = fileGets(h).length;
    const file = h.files["README.md"];
    if (file) {
      file.raw = "# 外部で更新\n";
      file.html = "<h1>外部で更新</h1>";
      file.sha = "sha-readme-2";
    }

    h.ws.emit({ type: "changed", path: "README.md" });
    await h.flush(6);

    expect(fileGets(h)).toHaveLength(before + 1);
    expect(h.el("preview").innerHTML).toContain("外部で更新");
    expect(h.el("source").textContent).toBe("# 外部で更新\n");
    expect(h.el("status").classList.contains("is-ok")).toBe(true);
    // 履歴は動かさない (ユーザー操作ではないため)
    expect(h.historyCalls).toHaveLength(1);
  });

  // **`changed` はツリーを取り直さない (Issue #84)。**
  //
  // 以前は取り直していたが、**内容が変わっただけで構造は変わっていない**ので無駄だった。
  // 10,000 ファイルでは 1 イベントあたり 216ms + 724 KiB 掛かっていた
  // （実測は `docs/bench/tree-baseline.md`）。構造が変わるのは `rename` 由来の
  // `tree` イベントだけで、サーバはそれを型で区別して送っている。
  test("表示していないファイルの変更では何も取り直さない", async () => {
    h = await boot();
    const fileBefore = fileGets(h).length;
    const treeBefore = treeGets(h).length;

    h.ws.emit({ type: "changed", path: "docs/guide.md" });
    await h.flush(6);

    expect(fileGets(h)).toHaveLength(fileBefore);
    expect(treeGets(h)).toHaveLength(treeBefore);
  });

  // **再接続したらツリーを取り直す (Issue #84)。**
  //
  // `changed` で毎回取り直すのをやめたぶん、取りこぼしの自動復旧が無くなった。
  // 切れている間の追加・削除は誰も拾わないし、chokidar 自体も取りこぼす (#119)。
  test("再接続したらツリーを取り直す", async () => {
    h = await boot();
    // **初回の `open` を先に起こす。** 実ブラウザでは接続が確立した時点で必ず発火するが、
    // ハーネスは socket を作るだけで発火させない。ここを省くと、再接続時の `open` が
    // 「1 回目」と見なされて取り直しが走らない
    h.ws.dispatch("open", {});
    await h.flush();
    const before = treeGets(h).length;

    // 切断すると `close` ハンドラが再接続をスケジュールする。
    // **実タイマー 500ms（`WS_RETRY_INITIAL`）なので、新しい socket ができるまで待つ。**
    // 固定 sleep にすると、遅いマシンで足りずに flaky になる
    const socketsBefore = h.sockets.length;
    h.ws.close();
    const deadline = Date.now() + 3000;
    while (h.sockets.length === socketsBefore && Date.now() < deadline) {
      await h.flush(1);
    }
    expect(h.sockets.length).toBe(socketsBefore + 1);

    // 接続が確立したことをサーバ側から知らせる
    h.ws.dispatch("open", {});
    await h.flush(6);

    expect(treeGets(h)).toHaveLength(before + 1);
  });

  test("ファイルの追加・削除 (tree) ではツリーを取り直す", async () => {
    h = await boot();
    const treeBefore = treeGets(h).length;

    h.ws.emit({ type: "tree", path: "docs/new.md" });
    await h.flush(6);

    expect(treeGets(h)).toHaveLength(treeBefore + 1);
  });

  test("編集中に変更通知が来たら競合バナーを出し、編集内容は保持する", async () => {
    h = await boot();
    h.click(h.el("edit-btn"));
    await h.flush();
    const editor = h.el<HTMLTextAreaElement>("editor");
    editor.value = "編集中の内容\n";
    editor.dispatchEvent(new h.window.Event("input", { bubbles: true }));

    const file = h.files["README.md"];
    if (file) {
      file.raw = "外から書き換え\n";
      file.html = "<p>外から書き換え</p>";
      file.sha = "sha-readme-9";
    }

    h.ws.emit({ type: "changed", path: "README.md" });
    await h.flush(6);

    expect(h.el("conflict-banner").hidden).toBe(false);
    expect(h.el("status").classList.contains("is-error")).toBe(true);
    expect(editor.value).toBe("編集中の内容\n");
    expect(h.el("content-body").classList.contains("is-editing")).toBe(true);

    // バナーの「サーバ版を採用」で外部の変更を取り込める
    h.click(h.el("conflict-take-server"));
    await h.flush();
    expect(editor.value).toBe("外から書き換え\n");
    expect(h.el("dirty-indicator").hidden).toBe(true);
  });

  test("読み直しに失敗したら status をエラーにする", async () => {
    h = await boot();
    h.intercept = (url) =>
      url.startsWith("/api/file?") ? { status: 500, body: { error: "boom" } } : undefined;

    h.ws.emit({ type: "changed", path: "README.md" });
    await h.flush(6);

    expect(h.el("status").classList.contains("is-error")).toBe(true);
  });
});

describe("tree 通知", () => {
  test("ツリーを取り直して再描画する", async () => {
    h = await boot();
    const added: TreeNode = {
      type: "dir",
      name: "",
      path: "",
      children: [
        { type: "file", name: "README.md", path: "README.md" },
        { type: "file", name: "new.md", path: "new.md" },
      ],
    };
    h.tree = added;

    h.ws.emit({ type: "tree" });
    await h.flush(6);

    expect(h.treeItem("new.md")).toBeTruthy();
    // 表示中のファイルは選択されたまま
    expect(h.treeItem("README.md").classList.contains("is-selected")).toBe(true);
  });

  test("表示中のファイルがツリーから消えたらエラーを出す", async () => {
    h = await boot();
    h.tree = {
      type: "dir",
      name: "",
      path: "",
      children: [{ type: "file", name: "other.md", path: "other.md" }],
    };

    h.ws.emit({ type: "tree" });
    await h.flush(6);

    expect(h.el("status").classList.contains("is-error")).toBe(true);
    // プレビューは消さない (読んでいた内容を失わせない)
    expect(h.el("preview").innerHTML).toContain("README");
  });

  test("ツリー取得に失敗したら status をエラーにする", async () => {
    h = await boot();
    h.intercept = (url) =>
      url.startsWith("/api/tree") ? { status: 500, body: { error: "boom" } } : undefined;

    h.ws.emit({ type: "tree" });
    await h.flush(6);

    expect(h.el("status").classList.contains("is-error")).toBe(true);
    // 既存のツリーは残す
    expect(h.treeItem("README.md")).toBeTruthy();
  });
});

describe("不正なメッセージ", () => {
  test("JSON として壊れたフレームは黙って捨てる", async () => {
    h = await boot();
    const before = h.fetchCalls.length;

    h.ws.emitRaw("{ not json");
    await h.flush();

    expect(h.fetchCalls).toHaveLength(before);
    expect(h.el("status").classList.contains("is-error")).toBe(false);
  });

  test("未知の type や null は何もしない", async () => {
    h = await boot();
    const before = h.fetchCalls.length;

    h.ws.emit(null);
    h.ws.emit({ type: "unknown" });
    h.ws.emit("文字列");
    await h.flush();

    expect(h.fetchCalls).toHaveLength(before);
  });
});
