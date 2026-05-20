import { describe, expect, test } from "bun:test";
import { findHeadingLines, mapScrollTop } from "../../public/scroll-sync.js";

describe("findHeadingLines", () => {
  test("シンプルな見出しを 1-indexed で抽出", () => {
    const md = "# h1\n\n本文\n\n## h2\n\nさらに\n\n### h3";
    expect(findHeadingLines(md)).toEqual([1, 5, 9]);
  });

  test("見出し 0 個 → 空配列", () => {
    expect(findHeadingLines("ただの本文\nもう少し")).toEqual([]);
  });

  test("frontmatter があっても source 全体の行番号で返す", () => {
    const md = "---\ntitle: T\n---\n# 本文\n\n## 詳細";
    expect(findHeadingLines(md)).toEqual([4, 6]);
  });

  test("```fence``` 内の `## not a heading` は無視", () => {
    const md = "# Real\n\n```\n## fake1\n```\n\n## Real2\n\n~~~\n## fake2\n~~~\n\n### Real3";
    expect(findHeadingLines(md)).toEqual([1, 7, 13]);
  });

  test("# だけ (空白なし) は見出しでない", () => {
    expect(findHeadingLines("#nope\n\n# real")).toEqual([3]);
  });

  test("非文字列入力は空配列", () => {
    // @ts-expect-error - testing runtime defensive behavior
    expect(findHeadingLines(null)).toEqual([]);
    // @ts-expect-error
    expect(findHeadingLines(undefined)).toEqual([]);
    // @ts-expect-error
    expect(findHeadingLines(42)).toEqual([]);
  });
});

describe("mapScrollTop", () => {
  test("pair 空 → scrollTop をそのまま返す (独立スクロール)", () => {
    expect(mapScrollTop(123, [])).toBe(123);
  });

  test("最初の pair より上 → 0 ↔ first 間で比例", () => {
    const pairs = [
      { from: 100, to: 200 },
      { from: 500, to: 600 },
    ];
    expect(mapScrollTop(0, pairs)).toBe(0);
    expect(mapScrollTop(50, pairs)).toBe(100); // 50/100 * 200
    expect(mapScrollTop(100, pairs)).toBe(200);
  });

  test("最初の pair の from = 0 → 即 to を返す", () => {
    const pairs = [{ from: 0, to: 50 }];
    expect(mapScrollTop(-10, pairs)).toBe(50);
    expect(mapScrollTop(0, pairs)).toBe(50);
  });

  test("最後の pair より下 → 末尾 to で打ち止め", () => {
    const pairs = [
      { from: 100, to: 200 },
      { from: 500, to: 600 },
    ];
    expect(mapScrollTop(500, pairs)).toBe(600);
    expect(mapScrollTop(9999, pairs)).toBe(600);
  });

  test("中間 → 線形補間", () => {
    const pairs = [
      { from: 100, to: 200 },
      { from: 300, to: 400 },
    ];
    // scrollTop = 200 → (200 - 100) / (300 - 100) = 0.5 → 200 + 0.5 * (400-200) = 300
    expect(mapScrollTop(200, pairs)).toBe(300);
    // scrollTop = 150 → 0.25 * 200 + 200 = 250
    expect(mapScrollTop(150, pairs)).toBe(250);
  });

  test("複数 pair 間で正しい区間を選ぶ", () => {
    const pairs = [
      { from: 0, to: 0 },
      { from: 100, to: 50 },
      { from: 300, to: 200 },
      { from: 600, to: 500 },
    ];
    expect(mapScrollTop(50, pairs)).toBe(25); // 0..100 区間
    expect(mapScrollTop(200, pairs)).toBe(125); // 100..300 区間
    expect(mapScrollTop(450, pairs)).toBe(350); // 300..600 区間
  });

  test("from が同値の 2 pair → 区間 span 0 を回避", () => {
    const pairs = [
      { from: 100, to: 50 },
      { from: 100, to: 70 },
      { from: 300, to: 200 },
    ];
    // 同値 from で割り算で NaN にならないこと
    const result = mapScrollTop(100, pairs);
    expect(result).toBeGreaterThanOrEqual(50);
    expect(result).toBeLessThanOrEqual(70);
  });
});
