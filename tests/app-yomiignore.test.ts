/**
 * 除外設定パネル (Issue #164) の特性テスト。
 *
 * ## 何を守るか
 *
 * 1. **開いたときにサーバの現在値を出す**（空の textarea を見せて丸ごと書き直させない）
 * 2. **保存したらツリーを取り直す** —— サーバの `tree` 通知に頼り切ると、WebSocket が
 *    切れている間の保存で「保存したのにツリーが変わらない」になり、利用者は保存の失敗と
 *    区別できない
 * 3. **警告行はサーバの文言をそのまま出す**（判定も文言もクライアントに写さない）
 * 4. **`aria-modal` の宣言どおりフォーカスを閉じ込める**
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type AppHarness, bootApp, resetAppEnvironment } from "./helpers/app-harness.ts";

let h: AppHarness;

afterEach(resetAppEnvironment);

/** `/api/yomiignore` の応答を差し替える。GET と POST で別の中身を返せる。 */
function stubYomiignore(
  harness: AppHarness,
  replies: { get?: unknown; post?: unknown; postStatus?: number },
): void {
  harness.intercept = (url, method) => {
    if (!url.startsWith("/api/yomiignore")) return undefined;
    if (method === "POST") {
      return { status: replies.postStatus ?? 200, body: replies.post ?? { text: "", invalid: [] } };
    }
    return { body: replies.get ?? { text: "", invalid: [] } };
  };
}

/** `/api/yomiignore` の呼び出しだけを抜き出す。 */
function ignoreCalls(harness: AppHarness, method: string) {
  return harness.fetchCalls.filter(
    (c) => c.url.startsWith("/api/yomiignore") && c.method === method,
  );
}

describe("除外設定パネル", () => {
  test("開くとサーバの現在値が textarea に入る", async () => {
    h = await bootApp();
    stubYomiignore(h, { get: { text: "secret\n!build\n", invalid: [] } });

    h.click(h.el("tree-yomiignore"));
    await h.flush(4);

    expect(h.el("yomiignore-panel").hidden).toBe(false);
    expect(h.el<HTMLTextAreaElement>("yomiignore-text").value).toBe("secret\n!build\n");
    expect(ignoreCalls(h, "GET")).toHaveLength(1);
  });

  test("照合できない行はサーバの文言をそのまま出し、捨てた行と区別できる", async () => {
    h = await bootApp();
    stubYomiignore(h, {
      get: {
        text: "docs/private\n*.log\n",
        invalid: [
          { line: 1, dropped: true, message: ".yomiignore:1: docs/private — 捨てた行の説明" },
          { line: 2, dropped: false, message: ".yomiignore:2: *.log — 残した行の説明" },
        ],
      },
    });

    h.click(h.el("tree-yomiignore"));
    await h.flush(4);

    const items = h.qa("#yomiignore-invalid .yomiignore-invalid-item");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe(".yomiignore:1: docs/private — 捨てた行の説明");
    // **捨てた行だけに `is-dropped`** —— グロブは除外として生きているので同じ見た目にしない
    expect(items[0]?.classList.contains("is-dropped")).toBe(true);
    expect(items[1]?.classList.contains("is-dropped")).toBe(false);
    expect(h.el("yomiignore-invalid").hidden).toBe(false);
  });

  test("警告が 0 件ならリストごと隠す", async () => {
    h = await bootApp();
    stubYomiignore(h, { get: { text: "secret\n", invalid: [] } });

    h.click(h.el("tree-yomiignore"));
    await h.flush(4);

    expect(h.el("yomiignore-invalid").hidden).toBe(true);
  });

  test("取得に失敗したらパネルを開かない（空の設定に見せない）", async () => {
    h = await bootApp();
    h.intercept = (url) =>
      url.startsWith("/api/yomiignore")
        ? { status: 500, body: { error: "boom", code: "read_failed" } }
        : undefined;

    h.click(h.el("tree-yomiignore"));
    await h.flush(4);

    expect(h.el("yomiignore-panel").hidden).toBe(true);
    expect(h.el("status").textContent).toContain("読み込みに失敗");
  });

  test("保存すると textarea の中身が POST され、ツリーを取り直す", async () => {
    h = await bootApp();
    stubYomiignore(h, {
      get: { text: "", invalid: [] },
      post: { text: "secret\n", invalid: [] },
    });

    h.click(h.el("tree-yomiignore"));
    await h.flush(4);
    h.el<HTMLTextAreaElement>("yomiignore-text").value = "secret\n";

    const treeGetsBefore = h.fetchCalls.filter((c) => c.url.startsWith("/api/tree")).length;
    h.click(h.el("yomiignore-save"));
    await h.flush(6);

    const posts = ignoreCalls(h, "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ text: "secret\n" });
    // **WebSocket の通知に頼らず自分でも取り直す**（切れている間の保存で止まらないように）
    expect(h.fetchCalls.filter((c) => c.url.startsWith("/api/tree")).length).toBeGreaterThan(
      treeGetsBefore,
    );
    expect(h.el("yomiignore-notice").hidden).toBe(false);
    expect(h.el("yomiignore-notice").className).toContain("is-ok");
  });

  test("保存の応答で警告が更新される", async () => {
    h = await bootApp();
    stubYomiignore(h, {
      get: { text: "", invalid: [] },
      post: {
        text: "docs/private\n",
        invalid: [{ line: 1, dropped: true, message: ".yomiignore:1: docs/private — だめ" }],
      },
    });

    h.click(h.el("tree-yomiignore"));
    await h.flush(4);
    h.click(h.el("yomiignore-save"));
    await h.flush(6);

    expect(h.qa("#yomiignore-invalid .yomiignore-invalid-item")).toHaveLength(1);
  });

  test("保存に失敗したらパネル内にエラーを出す（topbar の status は隠れて見えない）", async () => {
    h = await bootApp();
    stubYomiignore(h, {
      get: { text: "", invalid: [] },
      post: { error: "だめ", code: "write_failed" },
      postStatus: 500,
    });

    h.click(h.el("tree-yomiignore"));
    await h.flush(4);
    h.click(h.el("yomiignore-save"));
    await h.flush(6);

    expect(h.el("yomiignore-notice").hidden).toBe(false);
    expect(h.el("yomiignore-notice").className).toContain("is-error");
    // パネルは開いたまま（書き直せるように）
    expect(h.el("yomiignore-panel").hidden).toBe(false);
  });

  test("Esc で閉じ、フォーカスが開いたボタンへ戻る", async () => {
    h = await bootApp();
    stubYomiignore(h, { get: { text: "", invalid: [] } });

    h.el("tree-yomiignore").focus();
    h.click(h.el("tree-yomiignore"));
    await h.flush(4);
    expect(h.document.activeElement).toBe(h.el("yomiignore-text"));

    h.keydown(h.document, { key: "Escape" });
    await h.flush(2);

    expect(h.el("yomiignore-panel").hidden).toBe(true);
    expect(h.document.activeElement).toBe(h.el("tree-yomiignore"));
  });

  test("Ctrl+Enter で保存できる（textarea では Enter が改行のため）", async () => {
    h = await bootApp();
    stubYomiignore(h, { get: { text: "", invalid: [] }, post: { text: "x\n", invalid: [] } });

    h.click(h.el("tree-yomiignore"));
    await h.flush(4);
    h.keydown(h.el("yomiignore-text"), { key: "Enter", ctrlKey: true });
    await h.flush(6);

    expect(ignoreCalls(h, "POST")).toHaveLength(1);
  });

  test("背景のクリックで閉じるが、パネル内のクリックでは閉じない", async () => {
    h = await bootApp();
    stubYomiignore(h, { get: { text: "", invalid: [] } });

    h.click(h.el("tree-yomiignore"));
    await h.flush(4);

    h.click(h.q(".yomiignore-panel"));
    await h.flush(2);
    expect(h.el("yomiignore-panel").hidden).toBe(false);

    h.click(h.el("yomiignore-panel"));
    await h.flush(2);
    expect(h.el("yomiignore-panel").hidden).toBe(true);
  });

  test("開いている間はクイックオープンのショートカットを飲み込む", async () => {
    h = await bootApp();
    stubYomiignore(h, { get: { text: "", invalid: [] } });

    h.click(h.el("tree-yomiignore"));
    await h.flush(4);

    h.keydown(h.document, { key: "p", code: "KeyP", ctrlKey: true });
    await h.flush(2);

    // 背後にクイックオープンが開かない（開くとフォーカスがトラップの外へ出る。#112）
    expect(h.el("quick-open").hidden).toBe(true);
    expect(h.el("yomiignore-panel").hidden).toBe(false);
  });

  test("表示中のファイルが除外配下になったらパネル上で伝える", async () => {
    // **topbar の `#status` はこのパネルのスクリムの下で見えない。** 「保存しました」だけが
    // 見えて、裏で本文が孤立している状態を作らない
    h = await bootApp();
    stubYomiignore(h, { get: { text: "", invalid: [] }, post: { text: "docs\n", invalid: [] } });
    // 保存後のツリーから `docs/` を丸ごと落とす（除外した状態のサーバ応答を模す）
    const openPath = h.el("current-path").textContent ?? "";
    expect(openPath).not.toBe("");

    h.click(h.el("tree-yomiignore"));
    await h.flush(4);
    h.tree = { type: "dir", name: "", path: "", children: [] };
    h.click(h.el("yomiignore-save"));
    await h.flush(6);

    expect(h.el("yomiignore-notice").className).toContain("is-error");
    expect(h.el("yomiignore-notice").textContent).toContain(openPath);
  });

  test("取得中に連打しても GET は 1 本しか飛ばない", async () => {
    h = await bootApp();
    stubYomiignore(h, { get: { text: "", invalid: [] } });

    // **`isOpen()` だけでは防げない** —— 応答が返るまでパネルは閉じたままに見える
    h.click(h.el("tree-yomiignore"));
    h.click(h.el("tree-yomiignore"));
    await h.flush(6);

    expect(ignoreCalls(h, "GET")).toHaveLength(1);
    expect(h.el("yomiignore-panel").hidden).toBe(false);
  });

  test("Tab は端で折り返してパネル内に留まる", async () => {
    h = await bootApp();
    stubYomiignore(h, { get: { text: "", invalid: [] } });

    h.click(h.el("tree-yomiignore"));
    await h.flush(4);

    // 末尾（閉じる）から Tab → 先頭（textarea）へ
    h.el("yomiignore-close").focus();
    h.keydown(h.document, { key: "Tab" });
    expect(h.document.activeElement).toBe(h.el("yomiignore-text"));

    // 先頭から Shift+Tab → 末尾へ
    h.keydown(h.document, { key: "Tab", shiftKey: true });
    expect(h.document.activeElement).toBe(h.el("yomiignore-close"));
  });
});
