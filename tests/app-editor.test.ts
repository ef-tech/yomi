/**
 * 特性テスト: エディタ / 保存 / 競合 責務 (Issue #77)
 *
 * 編集モードの出入り、dirty 表示、楽観ロック (baseSha) 付き保存、409 競合バナーの
 * 3 択の振る舞いを固定する。判定は DOM と POST の中身だけで行う。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type AppHarness, bootApp, resetAppEnvironment } from "./helpers/app-harness.ts";

let h: AppHarness;

afterEach(resetAppEnvironment);

/** editor に文字を入れて input を発火する (ユーザーのタイプ相当) */
function type(harness: AppHarness, value: string) {
  const editor = harness.el<HTMLTextAreaElement>("editor");
  editor.value = value;
  editor.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
}

/** 保存 POST だけを取り出す */
function savePosts(harness: AppHarness) {
  return harness.fetchCalls.filter((c) => c.url === "/api/file" && c.method === "POST");
}

async function enterEdit(harness: AppHarness) {
  harness.click(harness.el("edit-btn"));
  await harness.flush();
}

describe("編集モードの出入り", () => {
  test("編集ボタンで editor が現れ、TOC は一時的に無効になる", async () => {
    h = await bootApp();
    expect(h.el<HTMLTextAreaElement>("editor").hidden).toBe(true);

    await enterEdit(h);

    const editor = h.el<HTMLTextAreaElement>("editor");
    expect(editor.hidden).toBe(false);
    expect(editor.value).toBe(h.files["README.md"]?.raw ?? "");
    expect(h.el("content-body").classList.contains("is-editing")).toBe(true);
    expect(h.el("edit-btn").getAttribute("aria-pressed")).toBe("true");
    expect(h.el<HTMLButtonElement>("discard-btn").hidden).toBe(false);
    expect(h.el<HTMLButtonElement>("toc-btn").disabled).toBe(true);
    expect(h.el<HTMLButtonElement>("toc-fab").disabled).toBe(true);
  });

  test("未編集のまま完了すると保存せずに編集モードを抜ける", async () => {
    h = await bootApp();
    await enterEdit(h);
    h.click(h.el("edit-btn"));
    await h.flush();

    expect(savePosts(h)).toHaveLength(0);
    expect(h.el<HTMLTextAreaElement>("editor").hidden).toBe(true);
    expect(h.el("edit-btn").getAttribute("aria-pressed")).toBe("false");
    expect(h.el<HTMLButtonElement>("toc-btn").disabled).toBe(false);
  });

  test("開いているファイルが無ければ編集モードに入れない", async () => {
    h = await bootApp({ tree: { type: "dir", name: "", path: "", children: [] }, files: {} });
    expect(h.el<HTMLButtonElement>("edit-btn").disabled).toBe(true);

    h.click(h.el("edit-btn"));
    await h.flush();
    expect(h.el("content-body").classList.contains("is-editing")).toBe(false);
  });

  test("別ファイルを開くと編集モードは解除される", async () => {
    h = await bootApp();
    await enterEdit(h);

    h.click(h.treeItem("docs/guide.md"));
    await h.flush();

    expect(h.el("content-body").classList.contains("is-editing")).toBe(false);
    expect(h.el<HTMLTextAreaElement>("editor").hidden).toBe(true);
  });
});

describe("dirty 表示", () => {
  test("内容を変えると dirty インジケータが出て、戻すと消える", async () => {
    h = await bootApp();
    await enterEdit(h);
    const original = h.files["README.md"]?.raw ?? "";

    expect(h.el("dirty-indicator").hidden).toBe(true);
    type(h, `${original}追記`);
    expect(h.el("dirty-indicator").hidden).toBe(false);

    type(h, original);
    expect(h.el("dirty-indicator").hidden).toBe(true);
  });

  test("dirty なら beforeunload を preventDefault する", async () => {
    h = await bootApp();
    await enterEdit(h);

    const clean = new h.window.Event("beforeunload", { cancelable: true });
    h.window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    type(h, "変更");
    const dirty = new h.window.Event("beforeunload", { cancelable: true });
    h.window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});

describe("保存", () => {
  test("完了ボタンで baseSha 付きの POST を送り、成功したら編集モードを抜ける", async () => {
    h = await bootApp();
    await enterEdit(h);
    type(h, "# 新しい内容\n");

    h.click(h.el("edit-btn"));
    await h.flush(6);

    expect(savePosts(h)).toHaveLength(1);
    expect(savePosts(h)[0]?.body).toEqual({
      path: "README.md",
      body: "# 新しい内容\n",
      baseSha: "sha-readme-1",
    });
    expect(h.el("content-body").classList.contains("is-editing")).toBe(false);
    expect(h.el("dirty-indicator").hidden).toBe(true);
    expect(h.el("status").classList.contains("is-ok")).toBe(true);
  });

  test("保存に成功するとプレビューと md ソースがサーバ応答で置き換わる", async () => {
    h = await bootApp();
    h.renderHtml = (raw) => `<h1 id="saved">${raw.trim()}</h1>`;
    await enterEdit(h);
    type(h, "保存後\n");

    h.keydown(h.document, { key: "s", code: "KeyS", ctrlKey: true });
    await h.flush(6);

    expect(h.el("preview").innerHTML).toContain("保存後");
    expect(h.el("source").textContent).toBe("保存後\n");
    // 編集モードは維持されたまま (Ctrl+S は保存だけ)
    expect(h.el("content-body").classList.contains("is-editing")).toBe(true);
  });

  test("Ctrl/Cmd+S は編集モードのときだけ保存する", async () => {
    h = await bootApp();
    h.keydown(h.document, { key: "s", code: "KeyS", metaKey: true });
    await h.flush();
    expect(savePosts(h)).toHaveLength(0);

    await enterEdit(h);
    type(h, "内容\n");
    h.keydown(h.document, { key: "s", code: "KeyS", metaKey: true });
    await h.flush(6);
    expect(savePosts(h)).toHaveLength(1);
  });

  test("2 回目の保存は 1 回目で返ってきた sha を baseSha に使う", async () => {
    h = await bootApp();
    await enterEdit(h);
    type(h, "1回目\n");
    h.keydown(h.document, { key: "s", code: "KeyS", ctrlKey: true });
    await h.flush(6);

    type(h, "2回目\n");
    h.keydown(h.document, { key: "s", code: "KeyS", ctrlKey: true });
    await h.flush(6);

    const posts = savePosts(h);
    expect(posts).toHaveLength(2);
    // 1 回目は起動時に読んだ sha。2 回目は 1 回目の応答が返した新しい sha を使うので、
    // 競合せずに反映される (古い sha のままなら 409 になり conflict バナーが出る)
    expect(posts[0]?.body?.baseSha).toBe("sha-readme-1");
    expect(posts[1]?.body?.baseSha).not.toBe(posts[0]?.body?.baseSha);
    expect(h.el("conflict-banner").hidden).toBe(true);
    expect(h.files["README.md"]?.raw).toBe("2回目\n");
  });

  test("保存に失敗したら編集モードを維持し status をエラーにする", async () => {
    h = await bootApp();
    await enterEdit(h);
    type(h, "だめ\n");
    h.intercept = (url, method) =>
      url === "/api/file" && method === "POST"
        ? { status: 500, body: { error: "disk full" } }
        : undefined;

    h.click(h.el("edit-btn"));
    await h.flush(6);

    expect(h.el("content-body").classList.contains("is-editing")).toBe(true);
    expect(h.el("dirty-indicator").hidden).toBe(false);
    expect(h.el("status").classList.contains("is-error")).toBe(true);
  });

  test("Tab で 2 スペースを挿入し dirty になる", async () => {
    h = await bootApp();
    await enterEdit(h);
    const editor = h.el<HTMLTextAreaElement>("editor");
    editor.value = "ab";
    editor.selectionStart = 1;
    editor.selectionEnd = 1;

    h.keydown(editor, { key: "Tab" });

    expect(editor.value).toBe("a  b");
    expect(editor.selectionStart).toBe(3);
    expect(h.el("dirty-indicator").hidden).toBe(false);
  });
});

describe("破棄と離脱の確認", () => {
  test("dirty なら破棄ボタンで確認し、キャンセルすると編集を続ける", async () => {
    h = await bootApp();
    await enterEdit(h);
    type(h, "捨てたくない\n");

    h.confirmResult = false;
    h.click(h.el("discard-btn"));
    await h.flush();

    expect(h.confirmMessages).toHaveLength(1);
    expect(h.el("content-body").classList.contains("is-editing")).toBe(true);
    expect(h.el<HTMLTextAreaElement>("editor").value).toBe("捨てたくない\n");
  });

  test("確認を了承すると保存せずに編集モードを抜ける", async () => {
    h = await bootApp();
    await enterEdit(h);
    type(h, "捨てる\n");

    h.confirmResult = true;
    h.click(h.el("discard-btn"));
    await h.flush();

    expect(savePosts(h)).toHaveLength(0);
    expect(h.el("content-body").classList.contains("is-editing")).toBe(false);
  });

  test("dirty で別ファイルへ移ろうとすると確認し、キャンセルすると遷移しない", async () => {
    h = await bootApp();
    await enterEdit(h);
    type(h, "未保存\n");
    h.confirmResult = false;
    const calls = h.historyCalls.length;

    h.click(h.treeItem("docs/guide.md"));
    await h.flush();

    expect(h.confirmMessages).toHaveLength(1);
    expect(h.el("current-path").textContent).toBe("README.md");
    expect(h.historyCalls).toHaveLength(calls);
    expect(h.el("content-body").classList.contains("is-editing")).toBe(true);
  });

  test("dirty でなければ確認せずに遷移する", async () => {
    h = await bootApp();
    await enterEdit(h);

    h.click(h.treeItem("docs/guide.md"));
    await h.flush();

    expect(h.confirmMessages).toHaveLength(0);
    expect(h.el("current-path").textContent).toBe("docs/guide.md");
  });
});

describe("保存競合 (409)", () => {
  /** 外部でファイルが書き換わった状態を作り、編集内容を保存しようとする */
  async function provokeConflict(harness: AppHarness) {
    await enterEdit(harness);
    type(harness, "ローカル版\n");
    const file = harness.files["README.md"];
    if (file) {
      file.raw = "サーバ版\n";
      file.html = "<p>サーバ版</p>";
      file.sha = "sha-readme-2";
    }
    harness.click(harness.el("edit-btn"));
    await harness.flush(6);
  }

  test("競合するとバナーが出て、編集内容は保持される", async () => {
    h = await bootApp();
    await provokeConflict(h);

    expect(h.el("conflict-banner").hidden).toBe(false);
    expect(h.el("content-body").classList.contains("is-editing")).toBe(true);
    expect(h.el<HTMLTextAreaElement>("editor").value).toBe("ローカル版\n");
    expect(h.el("status").classList.contains("is-error")).toBe(true);
  });

  test("「サーバ版を採用」でサーバ内容に置き換わり dirty が落ちる", async () => {
    h = await bootApp();
    await provokeConflict(h);

    h.click(h.el("conflict-take-server"));
    await h.flush();

    expect(h.el<HTMLTextAreaElement>("editor").value).toBe("サーバ版\n");
    expect(h.el("source").textContent).toBe("サーバ版\n");
    expect(h.el("preview").innerHTML).toContain("サーバ版");
    expect(h.el("dirty-indicator").hidden).toBe(true);
    expect(h.el("conflict-banner").hidden).toBe(true);
    // 採用は再保存しない (POST は競合した 1 回だけ)
    expect(savePosts(h)).toHaveLength(1);
  });

  test("「ローカル版で上書き」は baseSha 無しで再送する", async () => {
    h = await bootApp();
    await provokeConflict(h);

    h.click(h.el("conflict-overwrite"));
    await h.flush(6);

    const posts = savePosts(h);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toEqual({ path: "README.md", body: "ローカル版\n" });
    expect(posts[1]?.body).not.toHaveProperty("baseSha");
    expect(h.el("conflict-banner").hidden).toBe(true);
    expect(h.el("dirty-indicator").hidden).toBe(true);
    expect(h.files["README.md"]?.raw).toBe("ローカル版\n");
  });

  test("「閉じる」はバナーだけ閉じ、編集内容もサーバ内容も変えない", async () => {
    h = await bootApp();
    await provokeConflict(h);

    h.click(h.el("conflict-dismiss"));
    await h.flush();

    expect(h.el("conflict-banner").hidden).toBe(true);
    expect(h.el<HTMLTextAreaElement>("editor").value).toBe("ローカル版\n");
    expect(h.files["README.md"]?.raw).toBe("サーバ版\n");
    expect(savePosts(h)).toHaveLength(1);
  });
});
