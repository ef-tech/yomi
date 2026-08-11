/**
 * ブラウザ側の API 応答型が、サーバ側の型と食い違っていないことを検証する (Issue #79)。
 *
 * `public/api-types.js` は `/api/tree` などの応答を JSDoc の typedef で持つが、
 * **応答の形を決めているのはサーバ側 (`src/`)**。写しである以上、片方だけ直して
 * もう片方が古くなる事故が起きる。ここで型レベルの等価性を固定しておけば、
 * どちらを変えても `tsc` が落ちる。
 *
 * **実行時のアサーションではなく型で検証する。** 形が違えば `bun run typecheck` が
 * 落ちるので、テストが 1 本も走らなくても壊れたことは分かる。`bun test` から見えるのは
 * 「この検証が存在すること」だけなので、下に 1 本だけ実体のあるテストを置いてある。
 */

import { describe, expect, test } from "bun:test";
import { collectFilePaths } from "../public/quick-open.js";
import type { TreeNode as ServerTreeNode } from "../src/scanner.ts";

/** 双方向に代入できる = 同じ形。片方向だけだと、足りない/余分なフィールドを見逃す。 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** `public/api-types.js` の `TreeNode`（JSDoc typedef を型として引く）。 */
type BrowserTreeNode = import("../public/api-types.js").TreeNode;

// **ここが検証の本体。** 形が食い違うと `true` に代入できず typecheck が落ちる。
const _treeNodeShapesMatch: Exact<BrowserTreeNode, ServerTreeNode> = true;

describe("API 応答型の突き合わせ (Issue #79)", () => {
  test("ブラウザ側の TreeNode がサーバ側の TreeNode と同じ形である", () => {
    // 型の検証は上の代入が担う。ここはその代入が生きていることを示すだけ。
    expect(_treeNodeShapesMatch).toBe(true);
  });

  test("サーバ側の TreeNode をそのまま走査関数へ渡せる", () => {
    // 走査系は `TreeNodeLike`（name を要求しない）を受けるので、完全な TreeNode も通る。
    // **実物を渡せることを型と実行の両方で確かめる** —— ここが通らないなら
    // `TreeNodeLike` が実物より広い前提を置いている。
    const tree: ServerTreeNode = {
      name: "",
      path: "",
      type: "dir",
      children: [
        { name: "a.md", path: "a.md", type: "file" },
        {
          name: "docs",
          path: "docs",
          type: "dir",
          children: [{ name: "b.md", path: "docs/b.md", type: "file" }],
        },
      ],
    };
    expect(collectFilePaths(tree)).toEqual(["a.md", "docs/b.md"]);
  });
});
