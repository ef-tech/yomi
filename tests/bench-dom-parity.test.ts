/**
 * ベンチマークの DOM 構築が実物 (`public/app.js` の `renderTree`) とずれていないことを固定する
 * (Issue #83)。
 *
 * `scripts/bench-tree.ts` は app.js の `renderTree` / `renderNode` を**写している**。
 * app.js は import しただけで `init()` / `connectLiveReload()` まで走るため、ツリー描画だけを
 * 切り出せないのが理由。
 *
 * **写しは黙ってずれる。** #84 が `renderNode` を書き換えると、写しは自動的に陳腐化し、
 * 「前後比較」が別物同士の比較になる。実際、最初の写しは `state` の Map 挿入・`setDirOpen`・
 * ディレクトリごとの「＋」ボタンを落としており、要素数が 10,500 対 11,000 で食い違い、
 * 計測値も実物より約 8% 低く出ていた。
 *
 * ここでは**同じツリーを両方に描かせて、生成される DOM の骨格が一致する**ことを見る。
 * 完全一致（`outerHTML`）までは要求しない —— 実物は i18n の文言を含み、テストの
 * 実行環境（言語）に依存してしまうため。**要素の種類と数**が一致すれば、
 * 計測対象（ノード生成とリスナ登録の回数）としては等価。
 */

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderTreeInto } from "../scripts/bench-tree.ts";
import type { TreeNode } from "../src/scanner.ts";
import { type AppHarness, bootApp, resetAppEnvironment } from "./helpers/app-harness.ts";

let h: AppHarness;
afterEach(resetAppEnvironment);

/** ディレクトリとファイルが混ざり、ネストもあるツリー (「＋」ボタンの有無を両方含む)。 */
const TREE: TreeNode = {
  name: ".",
  path: "",
  type: "dir",
  children: [
    {
      name: "docs",
      path: "docs",
      type: "dir",
      children: [
        { name: "a.md", path: "docs/a.md", type: "file" },
        {
          name: "deep",
          path: "docs/deep",
          type: "dir",
          children: [{ name: "b.md", path: "docs/deep/b.md", type: "file" }],
        },
      ],
    },
    { name: "README.md", path: "README.md", type: "file" },
  ],
};

/** DOM の骨格を「タグ + class」の出現回数で表す (文言は含めない = i18n 非依存)。 */
function skeleton(root: Element): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const el of root.querySelectorAll("*")) {
    const key = `${el.tagName.toLowerCase()}.${el.className || "-"}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

test("ベンチの DOM 構築が app.js の renderTree と同じ骨格を作る", async () => {
  // 実物: 特性テストのハーネスで app.js を起動し、同じツリーを描かせる
  h = await bootApp({
    tree: TREE,
    files: { "README.md": { raw: "x", html: "<p>x</p>", sha: "s" } },
  });
  const real = skeleton(h.el("tree"));

  // 写し: ベンチが使う関数で同じツリーを描く
  const dom = new JSDOM("<!doctype html><div id='tree'></div>");
  const host = dom.window.document.getElementById("tree") as unknown as HTMLElement;
  renderTreeInto(dom.window.document as unknown as Document, host, TREE);
  const copy = skeleton(host as unknown as Element);
  dom.window.close();

  expect(copy).toEqual(real);
});
