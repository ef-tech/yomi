/**
 * ツリー差分の適用 (Issue #126)。
 *
 * ## ここが狂うと静かに壊れる
 *
 * 手元のツリーはもう `/api/tree` の写しではなく、**差分を積んだ結果**になる。
 * 積み方が 1 か所でもサーバの走査規則とずれると、そこから先ずっと違うツリーを
 * 表示し続ける —— **画面は普通に見えるので気づけない**。
 *
 * だから「適用できたこと」だけでなく、**`src/scanner.ts` を実際に走らせた結果と
 * 一致すること**を見る。自前の期待値を書くと、同じ勘違いで書いて読むことになる。
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyTreeDiff } from "../public/tree-diff.js";
import { scanMarkdownTree, type TreeNode } from "../src/scanner.ts";

/** 実ファイルを作って `scanMarkdownTree` に走らせ、正解のツリーを得る。 */
async function scanOf(paths: readonly string[]): Promise<TreeNode> {
  const dir = await mkdtemp(join(tmpdir(), "yomi-treediff-"));
  try {
    for (const p of paths) {
      const abs = join(dir, p);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, "# x\n");
    }
    return await scanMarkdownTree(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * **`name` / `path` / `type` / 子の順序だけを見る形に落とす。**
 *
 * `scanMarkdownTree` は葉に `children` を付けないが、差分側は付けうる。
 * 見たいのは「同じ木か」なので、そこは揃えてから比べる。
 */
function shape(node: TreeNode): unknown {
  const kids = node.children ?? [];
  return {
    name: node.name,
    path: node.path,
    type: node.type,
    children: kids.map(shape),
  };
}

describe("applyTreeDiff — scanner と同じ木になる", () => {
  /**
   * 走査結果に差分を当てた木が、**その差分を反映した実ファイルを走査した木**と
   * 一致することを見る。
   */
  async function expectMatchesScan(
    before: readonly string[],
    op: "add" | "remove",
    path: string,
    after: readonly string[],
  ) {
    const start = await scanOf(before);
    const result = applyTreeDiff(start, op, path);
    expect(result.ok).toBe(true);
    expect(shape(start)).toEqual(shape(await scanOf(after)));
    return result;
  }

  test("同じディレクトリへの追加が正しい位置に入る", async () => {
    // `b.md` の前でも後ろでもなく、**名前順の位置**に入ること
    await expectMatchesScan(["docs/a.md", "docs/c.md"], "add", "docs/b.md", [
      "docs/a.md",
      "docs/b.md",
      "docs/c.md",
    ]);
  });

  test("ルート直下への追加でも、ディレクトリが先という並びが崩れない", async () => {
    // **ファイルとディレクトリが混ざる場所**。名前だけで並べると `a.md` が `docs/` の
    // 前に来てしまう（scanner は type を先に見る）
    await expectMatchesScan(["docs/x.md", "z.md"], "add", "a.md", ["docs/x.md", "a.md", "z.md"]);
  });

  test("新しいディレクトリごと生える追加", async () => {
    await expectMatchesScan(["docs/a.md"], "add", "docs/deep/nest/new.md", [
      "docs/a.md",
      "docs/deep/nest/new.md",
    ]);
  });

  test("削除しても兄弟が残っていればディレクトリは残る", async () => {
    await expectMatchesScan(["docs/a.md", "docs/b.md"], "remove", "docs/b.md", ["docs/a.md"]);
  });

  /**
   * **空になったディレクトリを畳む (`pruneEmpty`)。**
   *
   * ここを実装し忘れると、サーバが返さないディレクトリが手元に残り続ける。
   * 見た目は「空のフォルダ」なので、間違いだと気づきにくい。
   */
  test("最後のファイルを消すとディレクトリごと消え、上まで連鎖する", async () => {
    await expectMatchesScan(
      ["keep.md", "docs/deep/nest/only.md"],
      "remove",
      "docs/deep/nest/only.md",
      ["keep.md"],
    );
  });

  test("畳むのはルートまでで、ルート自体は消えない", async () => {
    const start = await scanOf(["only.md"]);
    const result = applyTreeDiff(start, "remove", "only.md");
    expect(result).toEqual({ ok: true, dirtyPath: "" });
    expect(shape(start)).toEqual(shape(await scanOf([])));
  });
});

describe("applyTreeDiff — 描き直す範囲", () => {
  test("追加は、その親ディレクトリだけを dirty にする", async () => {
    const start = await scanOf(["a/b/c.md", "z.md"]);
    expect(applyTreeDiff(start, "add", "a/b/d.md")).toEqual({ ok: true, dirtyPath: "a/b" });
  });

  /**
   * **生えた階層のいちばん上を返す。** 親（`a/b`）を返すと、まだ描かれていない
   * ディレクトリの `<ul>` を探すことになって差分が当たらない。
   */
  test("ディレクトリごと生えた追加は、いちばん深い既存ディレクトリを dirty にする", async () => {
    const start = await scanOf(["a/b/c.md"]);
    expect(applyTreeDiff(start, "add", "a/b/deep/nest/new.md")).toEqual({
      ok: true,
      dirtyPath: "a/b",
    });
  });

  test("畳んだ削除は、生き残ったいちばん深いディレクトリを dirty にする", async () => {
    const start = await scanOf(["a/keep.md", "a/b/nest/only.md"]);
    expect(applyTreeDiff(start, "remove", "a/b/nest/only.md")).toEqual({
      ok: true,
      dirtyPath: "a",
    });
  });
});

describe("applyTreeDiff — 当てない / 何もしない場合", () => {
  test("既にあるファイルの追加は、木を変えずに成功扱い", async () => {
    const start = await scanOf(["docs/a.md"]);
    const before = shape(start);
    expect(applyTreeDiff(start, "add", "docs/a.md")).toEqual({ ok: true, dirtyPath: null });
    expect(shape(start)).toEqual(before);
  });

  test("無いファイルの削除は、木を変えずに成功扱い", async () => {
    const start = await scanOf(["docs/a.md"]);
    const before = shape(start);
    expect(applyTreeDiff(start, "remove", "docs/nope.md")).toEqual({ ok: true, dirtyPath: null });
    expect(shape(start)).toEqual(before);
  });

  test("親が無いファイルの削除も、木を変えずに成功扱い", async () => {
    const start = await scanOf(["docs/a.md"]);
    const before = shape(start);
    expect(applyTreeDiff(start, "remove", "nope/deep/x.md")).toEqual({
      ok: true,
      dirtyPath: null,
    });
    expect(shape(start)).toEqual(before);
  });

  /**
   * **ファイルとディレクトリが入れ替わっていたら諦める。**
   *
   * 手元が既にサーバとずれているということなので、差分を当てても直らない。
   * `ok: false` を返して全量取り直しへ倒す。
   */
  test("同じパスがファイルとして居る所に潜ろうとしたら諦める", async () => {
    const start = await scanOf(["docs/a.md"]);
    expect(applyTreeDiff(start, "add", "docs/a.md/inner.md")).toEqual({
      ok: false,
      dirtyPath: null,
    });
  });

  /**
   * **入口で落とす。** サーバ由来の値とはいえ、手元のツリーを壊しうる形は受けない。
   */
  test.each([
    [""],
    ["/abs.md"],
    ["../escape.md"],
    ["a/../../escape.md"],
  ])("`%s` のようなパスは当てない", async (path) => {
    const start = await scanOf(["docs/a.md"]);
    const before = shape(start);
    expect(applyTreeDiff(start, "add", path).ok).toBe(false);
    expect(shape(start)).toEqual(before);
  });
});

/**
 * **通知を積んだ結果が、走査結果と一致し続けること。**
 *
 * 1 件ずつの検査を全部通しても、**積み重ねてずれる**ことはありうる（挿入位置が
 * 1 つずれる、畳んだ後の親の子リストが壊れる、など）。実際に順番に当てて確かめる。
 */
describe("applyTreeDiff — 積み重ねてもずれない", () => {
  test("追加と削除を 12 回積んでも scanner と一致する", async () => {
    const files = ["docs/a.md", "docs/sub/b.md", "top.md"];
    const start = await scanOf(files);
    const live = new Set(files);

    const ops: Array<["add" | "remove", string]> = [
      ["add", "docs/aa.md"],
      ["add", "docs/sub/aa.md"],
      ["add", "alpha.md"],
      ["add", "docs/sub/deep/x.md"],
      ["remove", "docs/a.md"],
      ["add", "zeta/one.md"],
      ["remove", "docs/sub/deep/x.md"],
      ["add", "docs/sub/deep/y.md"],
      ["remove", "docs/sub/b.md"],
      ["remove", "docs/sub/aa.md"],
      ["remove", "docs/sub/deep/y.md"],
      ["add", "docs/sub/back.md"],
    ];

    for (const [op, path] of ops) {
      const result = applyTreeDiff(start, op, path);
      expect({ op, path, ok: result.ok }).toEqual({ op, path, ok: true });
      if (op === "add") live.add(path);
      else live.delete(path);
      // **毎回突き合わせる。** 最後だけ見ると、どの操作でずれたか分からない
      expect({ op, path, tree: shape(start) }).toEqual({
        op,
        path,
        tree: shape(await scanOf([...live])),
      });
    }
  });
});
