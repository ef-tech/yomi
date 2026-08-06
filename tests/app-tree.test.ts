/**
 * 特性テスト: ツリー責務 (Issue #77)
 *
 * `public/app.js` のツリー描画・開閉の永続化・ツールバー・新規 md 作成について、
 * **分割前 (#78) の観測可能な振る舞い**を固定する。内部関数や state には触れず、
 * DOM と fetch 呼び出しだけを見る。
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type AppHarness,
  bootApp,
  resetAppEnvironment,
  type TreeNode,
} from "./helpers/app-harness.ts";

let h: AppHarness;

afterEach(resetAppEnvironment);

const OPEN_DIRS_KEY = "yomi:openDirs:v1";

/** ディレクトリの子リスト (li > [button, +btn, ul] の ul) */
function dirUl(harness: AppHarness, path: string): HTMLElement {
  const ul = harness.treeItem(path).closest("li")?.querySelector("ul");
  if (!ul) throw new Error(`ディレクトリの子リストが見つかりません: ${path}`);
  return ul as HTMLElement;
}

/** ディレクトリが開いているか。setDirOpen は class と display の両方で表現する */
function isDirOpen(harness: AppHarness, path: string): boolean {
  const open = harness.treeItem(path).classList.contains("is-open");
  // class と display がずれていたら setDirOpen の回帰なので、テスト側で気づけるようにする
  expect(dirUl(harness, path).style.display).toBe(open ? "" : "none");
  return open;
}

describe("ツリー描画", () => {
  test("起動時に /api/tree を 1 回取得し、ファイルとディレクトリを描画する", async () => {
    h = await bootApp();

    const treeCalls = h.fetchCalls.filter((c) => c.url.startsWith("/api/tree"));
    expect(treeCalls).toHaveLength(1);

    expect(h.treeItem("README.md").classList.contains("is-file")).toBe(true);
    expect(h.treeItem("docs").classList.contains("is-dir")).toBe(true);
    expect(h.treeItem("docs/guide.md").textContent).toContain("guide.md");
    expect(h.treeItem("docs/deep/note.md")).toBeTruthy();
  });

  test("aria-busy と読み込み中プレースホルダを描画後に外す", async () => {
    h = await bootApp();
    const tree = h.el("tree");
    expect(tree.hasAttribute("aria-busy")).toBe(false);
    // data-i18n が残っていると言語切替でツリーが loading 文言に潰される (Issue #48 の回帰)
    expect(tree.hasAttribute("data-i18n")).toBe(false);
  });

  test("初期状態ではルート直下だけが開いている", async () => {
    h = await bootApp();
    expect(isDirOpen(h, "docs")).toBe(false);
    expect(isDirOpen(h, "docs/deep")).toBe(false);
  });

  test("起動時に /api/tree が失敗したら、ツリー領域にエラーを出し status は error になる", async () => {
    h = await bootApp({
      intercept: (url) =>
        url.startsWith("/api/tree") ? { status: 500, body: { error: "boom" } } : undefined,
    });

    const tree = h.el("tree");
    expect(tree.hasAttribute("aria-busy")).toBe(false);
    expect(tree.textContent).toContain("boom");
    expect(tree.querySelectorAll(".tree-item")).toHaveLength(0);
    expect(h.el("status").classList.contains("is-error")).toBe(true);
    // ファイルを開く段まで進まない
    expect(h.fetchCalls.filter((c) => c.url.startsWith("/api/file"))).toHaveLength(0);
  });
});

describe("ディレクトリの開閉", () => {
  test("クリックで開閉が切り替わり、localStorage に永続する", async () => {
    h = await bootApp();

    h.click(h.treeItem("docs"));
    await h.flush();
    expect(isDirOpen(h, "docs")).toBe(true);
    expect(JSON.parse(h.storageValue(OPEN_DIRS_KEY) ?? "[]")).toContain("docs");

    h.click(h.treeItem("docs"));
    await h.flush();
    expect(isDirOpen(h, "docs")).toBe(false);
    expect(JSON.parse(h.storageValue(OPEN_DIRS_KEY) ?? "[]")).not.toContain("docs");
  });

  test("localStorage に保存された開閉状態を起動時に復元する", async () => {
    h = await bootApp({
      storage: { [OPEN_DIRS_KEY]: JSON.stringify(["", "docs", "docs/deep"]) },
    });
    expect(isDirOpen(h, "docs")).toBe(true);
    expect(isDirOpen(h, "docs/deep")).toBe(true);
  });

  test("ファイルを開くと祖先ディレクトリが自動で開く", async () => {
    h = await bootApp({ url: "http://localhost:3944/?path=docs/deep/note.md" });
    expect(isDirOpen(h, "docs")).toBe(true);
    expect(isDirOpen(h, "docs/deep")).toBe(true);
  });
});

describe("ツリーツールバー", () => {
  test("「すべて開く」で全ディレクトリが開き、永続する", async () => {
    h = await bootApp();
    h.click(h.el("tree-expand-all"));
    await h.flush();

    expect(isDirOpen(h, "docs")).toBe(true);
    expect(isDirOpen(h, "docs/deep")).toBe(true);
    const saved = JSON.parse(h.storageValue(OPEN_DIRS_KEY) ?? "[]") as string[];
    expect(saved).toEqual(expect.arrayContaining(["", "docs", "docs/deep"]));
  });

  test("「すべて閉じる」でルート直下だけの状態に戻る", async () => {
    h = await bootApp({
      storage: { [OPEN_DIRS_KEY]: JSON.stringify(["", "docs", "docs/deep"]) },
    });
    h.click(h.el("tree-collapse-all"));
    await h.flush();

    expect(isDirOpen(h, "docs")).toBe(false);
    expect(isDirOpen(h, "docs/deep")).toBe(false);
    expect(JSON.parse(h.storageValue(OPEN_DIRS_KEY) ?? "[]")).toEqual([""]);
  });

  test("ディレクトリが 1 つも無ければ開閉ボタンは無効、新規作成は有効のまま", async () => {
    const flat: TreeNode = {
      type: "dir",
      name: "",
      path: "",
      children: [{ type: "file", name: "a.md", path: "a.md" }],
    };
    h = await bootApp({
      tree: flat,
      files: { "a.md": { raw: "# a\n", html: "<h1>a</h1>", sha: "sha-a" } },
    });

    expect(h.el<HTMLButtonElement>("tree-expand-all").disabled).toBe(true);
    expect(h.el<HTMLButtonElement>("tree-collapse-all").disabled).toBe(true);
    expect(h.el<HTMLButtonElement>("tree-new-file").disabled).toBe(false);
  });
});

describe("ファイル選択", () => {
  test("クリックしたファイルだけが is-selected になる", async () => {
    h = await bootApp();
    expect(h.treeItem("README.md").classList.contains("is-selected")).toBe(true);

    h.click(h.treeItem("docs/guide.md"));
    await h.flush();

    expect(h.treeItem("docs/guide.md").classList.contains("is-selected")).toBe(true);
    expect(h.treeItem("README.md").classList.contains("is-selected")).toBe(false);
  });
});

describe("新規 Markdown 作成", () => {
  test("ツールバーの新規作成でルート直下に入力欄が出る", async () => {
    h = await bootApp();
    h.click(h.el("tree-new-file"));
    await h.flush();

    const input = h.q<HTMLInputElement>(".tree-new-input");
    expect(input).toBeTruthy();
    // ルート直下 = #tree 直下の ul の先頭
    expect(h.q("#tree > ul > li").classList.contains("tree-new-li")).toBe(true);
  });

  test("ディレクトリの「＋」は そのディレクトリを開いて入力欄を子に置く", async () => {
    h = await bootApp();
    const addBtn = h.q<HTMLButtonElement>('#tree .dir-new-btn[data-dir-path="docs"]');
    h.click(addBtn);
    await h.flush();

    expect(isDirOpen(h, "docs")).toBe(true);
    // 入力欄は docs の子リストの先頭に置かれる (ルート直下ではない)
    const li = h.q(".tree-new-li");
    expect(li.parentElement).toBe(dirUl(h, "docs"));
    expect(dirUl(h, "docs").firstElementChild).toBe(li);
    expect(h.qa("#tree .tree-new-li")).toHaveLength(1);
  });

  test("Esc で入力欄を閉じ、POST は発生しない", async () => {
    h = await bootApp();
    h.click(h.el("tree-new-file"));
    await h.flush();

    const input = h.q<HTMLInputElement>(".tree-new-input");
    h.keydown(input, { key: "Escape" });
    await h.flush();

    expect(h.qa(".tree-new-input")).toHaveLength(0);
    expect(h.fetchCalls.filter((c) => c.url.startsWith("/api/file/create"))).toHaveLength(0);
  });

  test("Enter で拡張子を補完して POST し、ツリーを取り直して編集モードで開く", async () => {
    h = await bootApp();
    h.click(h.el("tree-new-file"));
    await h.flush();

    const input = h.q<HTMLInputElement>(".tree-new-input");
    input.value = "memo";
    // 作成後にツリー再取得で現れるように、サーバ側のツリーも更新しておく
    h.tree = {
      type: "dir",
      name: "",
      path: "",
      children: [
        { type: "file", name: "README.md", path: "README.md" },
        { type: "file", name: "memo.md", path: "memo.md" },
      ],
    };
    h.keydown(input, { key: "Enter" });
    await h.flush(8);

    const create = h.fetchCalls.find((c) => c.url.startsWith("/api/file/create"));
    expect(create?.method).toBe("POST");
    expect(create?.body).toEqual({ path: "memo.md" });

    // 作成直後にツリーを取り直す (自己保存マークで watcher が鳴らないため)
    expect(h.fetchCalls.filter((c) => c.url.startsWith("/api/tree"))).toHaveLength(2);
    // 新規ファイルを編集モードで開く
    expect(h.el("current-path").textContent).toBe("memo.md");
    expect(h.el<HTMLTextAreaElement>("editor").hidden).toBe(false);
    expect(h.el("content-body").classList.contains("is-editing")).toBe(true);
  });

  test("パス区切りを含む名前は不正として POST しない", async () => {
    h = await bootApp();
    h.click(h.el("tree-new-file"));
    await h.flush();

    const input = h.q<HTMLInputElement>(".tree-new-input");
    input.value = "a/b";
    h.keydown(input, { key: "Enter" });
    await h.flush();

    expect(h.fetchCalls.filter((c) => c.url.startsWith("/api/file/create"))).toHaveLength(0);
    expect(h.el("status").classList.contains("is-error")).toBe(true);
  });

  test("作成に失敗したら status がエラーになり、編集モードに入らない", async () => {
    h = await bootApp();
    h.intercept = (url) =>
      url.startsWith("/api/file/create")
        ? { status: 409, body: { error: "exists", code: "already_exists" } }
        : undefined;

    h.click(h.el("tree-new-file"));
    await h.flush();
    const input = h.q<HTMLInputElement>(".tree-new-input");
    input.value = "dup";
    h.keydown(input, { key: "Enter" });
    await h.flush(6);

    expect(h.el("status").classList.contains("is-error")).toBe(true);
    expect(h.el("content-body").classList.contains("is-editing")).toBe(false);
  });
});
