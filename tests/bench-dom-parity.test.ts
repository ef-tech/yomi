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
import { createCarry, renderTreeInto } from "../scripts/bench-tree.ts";
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

/** 追加が 1 件入ったツリー（2 回目の描画 = 差分更新の経路を通すため）。 */
const TREE_PLUS: TreeNode = {
  ...TREE,
  children: [
    ...(TREE.children ?? []).map((c) =>
      c.path === "docs"
        ? {
            ...c,
            children: [
              ...(c.children ?? []),
              { name: "c.md", path: "docs/c.md", type: "file" as const },
            ],
          }
        : c,
    ),
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

/** ノードの並びを `data-node-key` で表す（順序のずれを拾う。骨格の数だけでは見えない）。 */
function keys(root: Element): string[] {
  return [...root.querySelectorAll("li[data-node-key]")].map(
    (el) => (el as HTMLElement).dataset.nodeKey ?? "",
  );
}

/**
 * **2 回目の描画（差分更新）も突き合わせる (Issue #84)。**
 *
 * 1 回目だけだと `reconcileChildren` / `refreshNode` / `dropSubtree` が**一度も走らない**ので、
 * 差分更新の写しがずれても気づけない。#84 のベンチはこの経路を測っているのだから、
 * ここが一致していないと前後比較が別物同士の比較になる。
 */
test("ベンチの差分更新が app.js の renderTree と同じ結果になる", async () => {
  // 実物: 起動してから `tree` 通知でファイルを 1 件足す
  h = await bootApp({
    tree: TREE,
    files: { "README.md": { raw: "x", html: "<p>x</p>", sha: "s" } },
  });
  h.tree = TREE_PLUS;
  h.ws.emit({ type: "tree", path: "docs/c.md" });
  await h.flush(6);
  const real = skeleton(h.el("tree"));
  const realKeys = keys(h.el("tree"));

  // 写し: 同じ carry を使って 2 回描く（1 回目 = 初回、2 回目 = 差分更新）
  const dom = new JSDOM("<!doctype html><div id='tree'></div>");
  const host = dom.window.document.getElementById("tree") as unknown as HTMLElement;
  const carry = createCarry();
  const doc = dom.window.document as unknown as Document;
  renderTreeInto(doc, host, TREE, carry);
  renderTreeInto(doc, host, TREE_PLUS, carry);
  const copy = skeleton(host as unknown as Element);
  const copyKeys = keys(host as unknown as Element);
  dom.window.close();

  expect(copy).toEqual(real);
  expect(copyKeys).toEqual(realKeys);
});

/**
 * **両方が「ノードを再利用している」ことを突き合わせる (Issue #84)。**
 *
 * 上のテストは**結果の DOM** しか比べられない。作り直しても差分更新しても最終形は同じなので、
 * 写しが再利用をやめても気づけない —— ベンチが実物より遅い実装を測っていることになる。
 *
 * **限界: 操作回数までは比べられない。** 「消えたノードを先に捨てるか（`skipDead`）」の
 * ような違いは、要素の同一性にも最終形にも出ず、`insertBefore` を何回呼んだかにしか出ない。
 * そこがずれていないかは `bun run bench` の「末尾 / 先頭」の差で見る（差が出たら崖がある）。
 */
test("ベンチも実物もノードを再利用する", async () => {
  const stableFile = ".tree-item[title='README.md']";

  h = await bootApp({
    tree: TREE,
    files: { "README.md": { raw: "x", html: "<p>x</p>", sha: "s" } },
  });
  const realBefore = h.el("tree").querySelector(stableFile);
  h.tree = TREE_PLUS;
  h.ws.emit({ type: "tree", path: "docs/c.md" });
  await h.flush(6);
  const realAfter = h.el("tree").querySelector(stableFile);

  const dom = new JSDOM("<!doctype html><div id='tree'></div>");
  const host = dom.window.document.getElementById("tree") as unknown as HTMLElement;
  const carry = createCarry();
  const doc = dom.window.document as unknown as Document;
  renderTreeInto(doc, host, TREE, carry);
  const copyBefore = (host as unknown as Element).querySelector(stableFile);
  renderTreeInto(doc, host, TREE_PLUS, carry);
  const copyAfter = (host as unknown as Element).querySelector(stableFile);
  const copyReused = copyBefore !== null && copyBefore === copyAfter;
  dom.window.close();

  expect(realBefore).not.toBeNull();
  expect(realAfter).toBe(realBefore);
  expect(copyReused).toBe(true);
});
