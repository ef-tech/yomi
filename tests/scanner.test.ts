import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanMarkdownTree, type TreeNode } from "../src/scanner.ts";

let root: string;

async function makeDir(rel: string) {
  await mkdir(join(root, rel), { recursive: true });
}
async function makeFile(rel: string, content = "") {
  await writeFile(join(root, rel), content);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "yomi-scanner-"));

  // 構造:
  //   /a.md
  //   /b.markdown
  //   /c.mdx
  //   /not.txt
  //   /sub/d.md
  //   /sub/empty/      (md なし、削られるべき)
  //   /node_modules/x.md  (除外されるべき)
  //   /.git/HEAD          (除外されるべき)
  //   /deep/lvl2/lvl3/x.md
  await makeFile("a.md");
  await makeFile("b.markdown");
  await makeFile("c.mdx");
  await makeFile("not.txt");
  await makeDir("sub");
  await makeFile("sub/d.md");
  await makeDir("sub/empty");
  await makeDir("node_modules");
  await makeFile("node_modules/x.md");
  await makeDir(".git");
  await makeFile(".git/HEAD");
  await makeDir("deep/lvl2/lvl3");
  await makeFile("deep/lvl2/lvl3/x.md");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function findChild(node: TreeNode, name: string): TreeNode | undefined {
  return node.children?.find((c) => c.name === name);
}

describe("scanMarkdownTree", () => {
  test("ルートノードの形式", async () => {
    const tree = await scanMarkdownTree(root);
    expect(tree.name).toBe(".");
    expect(tree.path).toBe("");
    expect(tree.type).toBe("dir");
    expect(Array.isArray(tree.children)).toBe(true);
  });

  test("非 Markdown ファイルは含まれない", async () => {
    const tree = await scanMarkdownTree(root);
    expect(findChild(tree, "not.txt")).toBeUndefined();
  });

  test("md / markdown / mdx をすべて拾う", async () => {
    const tree = await scanMarkdownTree(root);
    const names = (tree.children ?? []).map((c) => c.name);
    expect(names).toContain("a.md");
    expect(names).toContain("b.markdown");
    expect(names).toContain("c.mdx");
  });

  test("デフォルト除外パターン (node_modules / .git) が効く", async () => {
    const tree = await scanMarkdownTree(root);
    expect(findChild(tree, "node_modules")).toBeUndefined();
    expect(findChild(tree, ".git")).toBeUndefined();
  });

  test("空のサブディレクトリは結果から削られる", async () => {
    const tree = await scanMarkdownTree(root);
    const sub = findChild(tree, "sub");
    expect(sub).toBeDefined();
    expect(findChild(sub as TreeNode, "empty")).toBeUndefined();
  });

  test("再帰スキャン: 深いネストもたどる", async () => {
    const tree = await scanMarkdownTree(root);
    const deep = findChild(tree, "deep");
    expect(deep).toBeDefined();
    const lvl2 = findChild(deep as TreeNode, "lvl2");
    const lvl3 = findChild(lvl2 as TreeNode, "lvl3");
    const file = findChild(lvl3 as TreeNode, "x.md");
    expect(file?.path).toBe("deep/lvl2/lvl3/x.md");
    expect(file?.type).toBe("file");
  });

  test("ソート: ディレクトリ -> ファイル、それぞれ alphabetical", async () => {
    const tree = await scanMarkdownTree(root);
    // dirs before files
    const dirIdxs = (tree.children ?? [])
      .map((c, i) => (c.type === "dir" ? i : -1))
      .filter((i) => i >= 0);
    const fileIdxs = (tree.children ?? [])
      .map((c, i) => (c.type === "file" ? i : -1))
      .filter((i) => i >= 0);
    if (dirIdxs.length > 0 && fileIdxs.length > 0) {
      expect(Math.max(...dirIdxs)).toBeLessThan(Math.min(...fileIdxs));
    }
    // ファイル名は alphabetical
    const fileNames = (tree.children ?? []).filter((c) => c.type === "file").map((c) => c.name);
    const sorted = [...fileNames].sort((a, b) => a.localeCompare(b));
    expect(fileNames).toEqual(sorted);
  });

  test("path は POSIX 形式の相対パス", async () => {
    const tree = await scanMarkdownTree(root);
    const sub = findChild(tree, "sub");
    const d = findChild(sub as TreeNode, "d.md");
    expect(d?.path).toBe("sub/d.md");
    expect(d?.path.includes("\\")).toBe(false);
  });

  test("カスタム excludes を渡せる", async () => {
    // sub も除外してみる
    const tree = await scanMarkdownTree(root, {
      excludes: new Set(["sub", "node_modules", ".git"]),
    });
    expect(findChild(tree, "sub")).toBeUndefined();
  });
});

describe("scanMarkdownTree — maxDepth (Issue #44)", () => {
  // root 構造 (level): a.md/b.markdown/c.mdx(1), sub(1)/d.md(2),
  //   deep(1)/lvl2(2)/lvl3(3)/x.md(4)
  function allPaths(node: TreeNode): string[] {
    const out: string[] = [];
    for (const c of node.children ?? []) {
      out.push(c.path);
      out.push(...allPaths(c));
    }
    return out;
  }

  test("maxDepth=1 はルート直下のみ (境界 dir は中を見ず表示)", async () => {
    const paths = allPaths(await scanMarkdownTree(root, { maxDepth: 1 }));
    // ルート直下の md とディレクトリは出る
    expect(paths).toContain("a.md");
    expect(paths).toContain("sub");
    expect(paths).toContain("deep");
    // 2 階層目以降は出ない
    expect(paths).not.toContain("sub/d.md");
    expect(paths).not.toContain("deep/lvl2");
    // 境界 dir (sub) は中を見ないので子は空
    const sub = findChild(await scanMarkdownTree(root, { maxDepth: 1 }), "sub");
    expect(sub?.children).toEqual([]);
  });

  test("maxDepth=2 は 2 階層まで、3 階層目以降は出ない", async () => {
    const paths = allPaths(await scanMarkdownTree(root, { maxDepth: 2 }));
    expect(paths).toContain("a.md");
    expect(paths).toContain("sub/d.md");
    expect(paths).toContain("deep/lvl2"); // 境界 dir として表示
    expect(paths).not.toContain("deep/lvl2/lvl3");
    expect(paths).not.toContain("deep/lvl2/lvl3/x.md");
  });

  test("maxDepth 未指定は無制限 (深い md も拾う)", async () => {
    const paths = allPaths(await scanMarkdownTree(root, {}));
    expect(paths).toContain("deep/lvl2/lvl3/x.md");
    // 深さ無制限と maxDepth 省略は同一結果
    expect(allPaths(await scanMarkdownTree(root))).toEqual(paths);
  });

  test("非境界の本当に空な dir は maxDepth 下でも従来どおり削られる", async () => {
    // maxDepth=3 では sub(1) は境界でない → 中を見て sub/empty(空) は prune される
    const sub = findChild(await scanMarkdownTree(root, { maxDepth: 3 }), "sub");
    expect(sub).toBeDefined();
    expect(findChild(sub as TreeNode, "empty")).toBeUndefined();
  });
});
