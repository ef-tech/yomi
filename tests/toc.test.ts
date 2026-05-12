import { describe, expect, test } from "bun:test";
// public/toc.js はブラウザ用 ES module。Bun は .js モジュールを直接 import 可能。
// @ts-expect-error public/toc.js に対する型情報を作らないので一旦無視
import { buildTocTree } from "../public/toc.js";

interface Heading {
  level: number;
  text: string;
  id: string;
}

const h = (level: number, text: string): Heading => ({ level, text, id: text });

describe("buildTocTree", () => {
  test("空配列なら []", () => {
    expect(buildTocTree([])).toEqual([]);
  });

  test("平坦 (全 H2) は同階層 N 件", () => {
    const tree = buildTocTree([h(2, "A"), h(2, "B"), h(2, "C")]);
    expect(tree).toHaveLength(3);
    expect(tree[0].text).toBe("A");
    expect(tree[1].text).toBe("B");
    expect(tree[2].text).toBe("C");
    expect(tree.every((n: { children: Heading[] }) => n.children.length === 0)).toBe(true);
  });

  test("基本的なネスト (h1 > h2 > h3)", () => {
    const tree = buildTocTree([h(1, "T"), h(2, "S1"), h(3, "SS1"), h(2, "S2")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].text).toBe("T");
    expect(tree[0].children.map((c: Heading) => c.text)).toEqual(["S1", "S2"]);
    expect(tree[0].children[0].children.map((c: Heading) => c.text)).toEqual(["SS1"]);
    expect(tree[0].children[1].children).toEqual([]);
  });

  test("複数の H1 が並ぶ", () => {
    const tree = buildTocTree([h(1, "A"), h(2, "A1"), h(1, "B"), h(2, "B1")]);
    expect(tree.map((n: Heading) => n.text)).toEqual(["A", "B"]);
    expect(tree[0].children.map((c: Heading) => c.text)).toEqual(["A1"]);
    expect(tree[1].children.map((c: Heading) => c.text)).toEqual(["B1"]);
  });

  test("階層スキップ (H1 直後に H3) は親不在なので H1 の直下に置く", () => {
    const tree = buildTocTree([h(1, "T"), h(3, "Deep"), h(2, "S")]);
    expect(tree[0].text).toBe("T");
    expect(tree[0].children.map((c: Heading) => c.text)).toEqual(["Deep", "S"]);
  });

  test("先頭が H3 から始まる (親不在) → root に並ぶ", () => {
    const tree = buildTocTree([h(3, "A"), h(3, "B")]);
    expect(tree.map((n: Heading) => n.text)).toEqual(["A", "B"]);
  });

  test("maxLevel=3 なら H4 以下を除外", () => {
    const tree = buildTocTree([h(1, "T"), h(2, "S"), h(3, "SS"), h(4, "SSS"), h(5, "SSSS")], 3);
    expect(tree[0].text).toBe("T");
    expect(tree[0].children[0].text).toBe("S");
    expect(tree[0].children[0].children[0].text).toBe("SS");
    expect(tree[0].children[0].children[0].children).toEqual([]);
  });

  test("maxLevel=6 (デフォルト) なら H1-H6 全部含む", () => {
    const tree = buildTocTree([h(1, "L1"), h(6, "L6")]);
    expect(tree[0].children.map((c: Heading) => c.text)).toEqual(["L6"]);
  });
});
