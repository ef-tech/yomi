/**
 * クイックオープンの候補検索 (Issue #54) の単体テスト。
 *
 * DOM に依存しない純粋関数なので、jsdom を通さず直接呼ぶ。
 * UI とキーボード操作は `tests/app-quick-open.test.ts` (特性テストのハーネス) が見る。
 */

import { describe, expect, test } from "bun:test";
import {
  collectFilePaths,
  moveSelection,
  type QuickOpenTreeNode,
  searchPaths,
} from "../public/quick-open.js";

const TREE: QuickOpenTreeNode = {
  type: "dir",
  path: "",
  children: [
    {
      type: "dir",
      path: "docs",
      children: [
        { type: "file", path: "docs/design.md" },
        { type: "file", path: "docs/guide.md" },
        {
          type: "dir",
          path: "docs/api",
          children: [{ type: "file", path: "docs/api/guide.md" }],
        },
      ],
    },
    { type: "file", path: "README.md" },
  ],
};

describe("collectFilePaths", () => {
  test("ファイルだけを document order で集める", () => {
    expect(collectFilePaths(TREE)).toEqual([
      "docs/design.md",
      "docs/guide.md",
      "docs/api/guide.md",
      "README.md",
    ]);
  });

  test("ディレクトリは候補にしない", () => {
    expect(collectFilePaths(TREE)).not.toContain("docs");
    expect(collectFilePaths(TREE)).not.toContain("docs/api");
  });

  test("空ツリーでも壊れない", () => {
    expect(collectFilePaths({ type: "dir", path: "", children: [] })).toEqual([]);
  });
});

describe("searchPaths", () => {
  const paths = collectFilePaths(TREE);

  test("クエリが空なら全件を document order で返す", () => {
    expect(searchPaths(paths, "").map((h) => h.path)).toEqual(paths);
  });

  test("空白だけのクエリも空扱いにする", () => {
    expect(searchPaths(paths, "   ").map((h) => h.path)).toEqual(paths);
  });

  test("部分列で一致する (途中を飛ばして打てる)", () => {
    // d-s-g が docs/design.md の中にこの順で現れる
    expect(searchPaths(paths, "dsg").map((h) => h.path)).toContain("docs/design.md");
  });

  test("大文字小文字を無視する", () => {
    expect(searchPaths(paths, "README").map((h) => h.path)).toContain("README.md");
    expect(searchPaths(paths, "readme").map((h) => h.path)).toContain("README.md");
    expect(searchPaths(paths, "ReAdMe").map((h) => h.path)).toContain("README.md");
  });

  test("一致しないものは返さない", () => {
    expect(searchPaths(paths, "zzz")).toEqual([]);
  });

  // **同名ファイルを相対パスで区別できる** (DoD 2 行目)
  test("同名ファイルは両方返り、パスで区別できる", () => {
    const hits = searchPaths(paths, "guide").map((h) => h.path);
    expect(hits).toContain("docs/guide.md");
    expect(hits).toContain("docs/api/guide.md");
    // パスが短いほうが上 (同じくらい一致するなら浅い場所を先に)
    expect(hits.indexOf("docs/guide.md")).toBeLessThan(hits.indexOf("docs/api/guide.md"));
  });

  test("ファイル名に一致したものがディレクトリ名だけの一致より上に来る", () => {
    const tree: QuickOpenTreeNode = {
      type: "dir",
      path: "",
      children: [
        {
          type: "dir",
          path: "guide-images",
          children: [{ type: "file", path: "guide-images/photo.md" }],
        },
        { type: "file", path: "guide.md" },
      ],
    };
    const hits = searchPaths(collectFilePaths(tree), "guide").map((h) => h.path);
    expect(hits[0]).toBe("guide.md");
  });

  test("マッチが密なほうが上に来る", () => {
    const hits = searchPaths(["abc.md", "a-b-c.md"], "abc").map((h) => h.path);
    expect(hits[0]).toBe("abc.md");
  });

  test("ハイライト用の位置を返す", () => {
    const [hit] = searchPaths(["README.md"], "rme");
    expect(hit?.positions).toHaveLength(3);
    // 返る位置の文字が実際にクエリと一致する
    const chars = hit?.positions.map((p) => "README.md"[p]?.toLowerCase()).join("");
    expect(chars).toBe("rme");
  });

  test("クエリが空なら positions も空", () => {
    expect(searchPaths(paths, "")[0]?.positions).toEqual([]);
  });

  test("limit で件数を制限する", () => {
    expect(searchPaths(paths, "", 2)).toHaveLength(2);
    expect(searchPaths(["a.md", "ab.md", "abc.md"], "a", 2)).toHaveLength(2);
  });

  // 同じ入力で毎回同じ並びになること (順序が揺れると候補移動が使えない)
  test("同じ入力なら並びが安定する", () => {
    const first = searchPaths(paths, "md").map((h) => h.path);
    const second = searchPaths(paths, "md").map((h) => h.path);
    expect(second).toEqual(first);
  });

  // **除外・depth はサーバ側で適用済み**なので、母集団に無いものは出ない (DoD 3 行目)
  test("母集団に無いパスは候補に出ない", () => {
    const visible = ["docs/guide.md"];
    expect(searchPaths(visible, "secret")).toEqual([]);
    expect(searchPaths(visible, "").map((h) => h.path)).toEqual(visible);
  });
});

describe("moveSelection", () => {
  test("下へ移動する", () => {
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(1, 1, 3)).toBe(2);
  });

  test("上へ移動する", () => {
    expect(moveSelection(2, -1, 3)).toBe(1);
  });

  // 端で止まると「押したのに動かない」という無反応に見える
  test("末尾から下へ押すと先頭へ回る", () => {
    expect(moveSelection(2, 1, 3)).toBe(0);
  });

  test("先頭から上へ押すと末尾へ回る", () => {
    expect(moveSelection(0, -1, 3)).toBe(2);
  });

  test("候補が無ければ -1", () => {
    expect(moveSelection(0, 1, 0)).toBe(-1);
    expect(moveSelection(-1, -1, 0)).toBe(-1);
  });

  test("候補が 1 件ならどちらへ押しても 0", () => {
    expect(moveSelection(0, 1, 1)).toBe(0);
    expect(moveSelection(0, -1, 1)).toBe(0);
  });
});
