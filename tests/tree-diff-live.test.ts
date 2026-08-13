/**
 * 特性テスト: `tree` 通知を差分で当てる経路 (Issue #126)。
 *
 * ## 何を守るか
 *
 * これまでは `tree` を受けるたびに `/api/tree` を全量取り直していた。**取り直さない**
 * ことがこの Issue の目的なので、まず「取り直していないこと」を見る —— ここが緩むと、
 * 差分の実装が入ったまま**黙って元の遅さに戻る**（画面は正しいので誰も気づかない）。
 *
 * そのうえで、**当ててはいけない場面で当てていないこと**を見る。差分は取りこぼすと
 * 以後ずっとずれるので、逃げ道（全量取り直し）が働かないことのほうが被害が大きい。
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type AppHarness,
  bootApp,
  defaultTree,
  resetAppEnvironment,
} from "./helpers/app-harness.ts";

let h: AppHarness;

afterEach(resetAppEnvironment);

/**
 * **ハーネスの既定ツリーをそのまま使う** (Issue #145)。
 *
 * 以前はここに `sortedTree()` を自前で持っていた —— `defaultTree()` がファイルを
 * ディレクトリより前に置いており、**実サーバが返さない並び**だったため。差分の挿入位置は
 * 「渡された子リストが整列済み」を前提にする (`public/tree-diff.js`) ので、それで測ると
 * 位置がずれて見えた。
 *
 * **#145 で `defaultTree()` 自体を実サーバの並びに直した**ので、回避策は要らなくなった。
 * 同じ形を 2 か所に持つと片方が古くなるので、こちらを消して既定へ寄せる。
 */
const sortedTree = defaultTree;

/** `/api/tree` を引いた回数。**差分が効いていれば増えない。** */
function treeGets(harness: AppHarness): number {
  return harness.fetchCalls.filter((c) => c.url.startsWith("/api/tree")).length;
}

/** ツリーに描かれているファイルのパス（`title` 属性は path そのもの）。 */
function renderedFiles(harness: AppHarness): string[] {
  return Array.from(harness.el("tree").querySelectorAll(".tree-item.is-file")).map((el) =>
    el.getAttribute("title"),
  ) as string[];
}

/** ツリーに描かれているディレクトリのパス。 */
function renderedDirs(harness: AppHarness): string[] {
  return Array.from(harness.el("tree").querySelectorAll(".tree-item.is-dir")).map((el) =>
    el.getAttribute("title"),
  ) as string[];
}

describe("差分を当てる", () => {
  test("追加は /api/tree を引かずにツリーへ現れる", async () => {
    h = await bootApp({ tree: sortedTree(), treeGen: 7 });
    const before = treeGets(h);

    h.ws.emit({ type: "tree", op: "add", path: "docs/added.md", gen: 8 });
    await h.flush(4);

    expect(treeGets(h)).toBe(before);
    expect(renderedFiles(h)).toEqual([
      "docs/deep/note.md",
      "docs/added.md",
      "docs/guide.md",
      "README.md",
    ]);
  });

  test("削除は /api/tree を引かずにツリーから消える", async () => {
    h = await bootApp({ tree: sortedTree(), treeGen: 7 });
    const before = treeGets(h);

    h.ws.emit({ type: "tree", op: "remove", path: "docs/guide.md", gen: 8 });
    await h.flush(4);

    expect(treeGets(h)).toBe(before);
    expect(renderedFiles(h)).toEqual(["docs/deep/note.md", "README.md"]);
  });

  /**
   * **空になったディレクトリが DOM からも消えること。** データだけ畳んで `<li>` が
   * 残ると、押しても何も無いディレクトリが画面に残る。
   */
  test("最後のファイルを消すとディレクトリごと DOM から消える", async () => {
    h = await bootApp({ tree: sortedTree(), treeGen: 7 });
    expect(renderedDirs(h)).toEqual(["docs", "docs/deep"]);

    h.ws.emit({ type: "tree", op: "remove", path: "docs/deep/note.md", gen: 8 });
    await h.flush(4);

    expect(renderedDirs(h)).toEqual(["docs"]);
    expect(renderedFiles(h)).toEqual(["docs/guide.md", "README.md"]);
  });

  test("新しいディレクトリごと生える追加も差分で描かれる", async () => {
    h = await bootApp({ tree: sortedTree(), treeGen: 7 });
    const before = treeGets(h);

    h.ws.emit({ type: "tree", op: "add", path: "docs/newdir/x.md", gen: 8 });
    await h.flush(4);

    expect(treeGets(h)).toBe(before);
    expect(renderedDirs(h)).toEqual(["docs", "docs/deep", "docs/newdir"]);
    expect(renderedFiles(h)).toContain("docs/newdir/x.md");
  });

  test("差分を続けて当てると版が追随する（毎回 1 つずつ進む）", async () => {
    h = await bootApp({ tree: sortedTree(), treeGen: 7 });
    const before = treeGets(h);

    h.ws.emit({ type: "tree", op: "add", path: "a.md", gen: 8 });
    await h.flush(4);
    h.ws.emit({ type: "tree", op: "add", path: "b.md", gen: 9 });
    await h.flush(4);
    h.ws.emit({ type: "tree", op: "remove", path: "a.md", gen: 10 });
    await h.flush(4);

    expect(treeGets(h)).toBe(before);
    expect(renderedFiles(h)).toEqual(["docs/deep/note.md", "docs/guide.md", "b.md", "README.md"]);
  });

  /**
   * **表示中のファイルが差分で消えたら気づけること。**
   *
   * 全量取り直しの経路にはこの判定があったが、差分の経路にも要る ——
   * 無いと「開いているファイルが消えたのに何も言われない」ことになる。
   */
  test("表示中のファイルが差分で消えたら status に出る", async () => {
    h = await bootApp({
      url: "http://localhost:3944/?path=docs/guide.md",
      tree: sortedTree(),
      treeGen: 7,
    });
    await h.flush(4);

    h.ws.emit({ type: "tree", op: "remove", path: "docs/guide.md", gen: 8 });
    await h.flush(4);

    expect(h.el("status").textContent).toContain("docs/guide.md");
    expect(h.el("status").className).toContain("error");
  });
});

describe("差分を当てず全量へ逃げる", () => {
  /**
   * **版が飛んだら当てない。** 途中の通知を取りこぼしているので、差分だけ当てると
   * その 1 件ぶん永久にずれる。
   */
  test("版が飛んでいたら /api/tree を取り直す", async () => {
    h = await bootApp({ tree: sortedTree(), treeGen: 7 });
    const before = treeGets(h);

    h.ws.emit({ type: "tree", op: "add", path: "docs/added.md", gen: 9 });
    await h.flush(6);

    expect(treeGets(h)).toBe(before + 1);
  });

  test("版が戻っていたら /api/tree を取り直す", async () => {
    h = await bootApp({ tree: sortedTree(), treeGen: 7 });
    const before = treeGets(h);

    h.ws.emit({ type: "tree", op: "add", path: "docs/added.md", gen: 7 });
    await h.flush(6);

    expect(treeGets(h)).toBe(before + 1);
  });

  /**
   * **版ヘッダを返さないサーバ**（この版より前の yomi、間に挟まった proxy）では
   * 差分を当てない。当てると、基準が無いまま積むことになる。
   */
  test("版を知らなければ /api/tree を取り直す", async () => {
    h = await bootApp({ tree: sortedTree(), treeGen: null });
    const before = treeGets(h);

    h.ws.emit({ type: "tree", op: "add", path: "docs/added.md", gen: 1 });
    await h.flush(6);

    expect(treeGets(h)).toBe(before + 1);
  });

  /** `--depth` 指定時のサーバは `op` を載せない (`src/server.ts` の `canSendTreeDiff`)。 */
  test("op の無い tree 通知は従来どおり /api/tree を取り直す", async () => {
    h = await bootApp({ tree: sortedTree(), treeGen: 7 });
    const before = treeGets(h);

    h.ws.emit({ type: "tree" });
    await h.flush(6);

    expect(treeGets(h)).toBe(before + 1);
  });

  test.each([["add"], ["remove"]])("op=%s でも path が無ければ取り直す", async (op) => {
    h = await bootApp({ tree: sortedTree(), treeGen: 7 });
    const before = treeGets(h);

    h.ws.emit({ type: "tree", op, gen: 8 });
    await h.flush(6);

    expect(treeGets(h)).toBe(before + 1);
  });

  test("知らない op は取り直す", async () => {
    h = await bootApp({ tree: sortedTree(), treeGen: 7 });
    const before = treeGets(h);

    h.ws.emit({ type: "tree", op: "move", path: "docs/guide.md", gen: 8 });
    await h.flush(6);

    expect(treeGets(h)).toBe(before + 1);
  });

  /**
   * **取り直したら版も拾い直す。** ここを忘れると、以後ずっと版が古いままになり
   * 差分が 1 件も当たらなくなる（動きは正しいので気づけない）。
   */
  test("取り直した後は、続く差分がまた当たるようになる", async () => {
    h = await bootApp({ tree: sortedTree(), treeGen: 7 });

    // 版が飛ぶ → 全量取り直し。ハーネスのサーバは版 20 を名乗る
    h.treeGen = 20;
    h.ws.emit({ type: "tree", op: "add", path: "docs/added.md", gen: 9 });
    await h.flush(6);
    const afterRefetch = treeGets(h);

    // 続く 21 は当たるはず（取り直しで版を拾い直せていれば）
    h.ws.emit({ type: "tree", op: "add", path: "zz.md", gen: 21 });
    await h.flush(4);

    expect(treeGets(h)).toBe(afterRefetch);
    expect(renderedFiles(h)).toContain("zz.md");
  });
});
