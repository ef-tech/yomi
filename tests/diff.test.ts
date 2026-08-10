/**
 * 保存競合の行差分 (Issue #57) の単体テスト。
 *
 * DOM に依存しない純粋関数なので、jsdom を通さず直接呼ぶ。
 * 競合ダイアログの UI と状態遷移は `tests/app-editor.test.ts` が見る。
 */

import { describe, expect, test } from "bun:test";
import { collapseUnchanged, type DiffRow, diffLines } from "../public/diff.js";

/** 差分行を `+foo` / `-foo` / ` foo` の読みやすい形にする */
function sketch(rows: DiffRow[]): string[] {
  const mark = { equal: " ", del: "-", add: "+" };
  return rows.map((r) => `${mark[r.type]}${r.text}`);
}

describe("diffLines", () => {
  test("同じ内容なら差分が無い", () => {
    const result = diffLines("a\nb\nc", "a\nb\nc");
    expect(result.truncated).toBe(false);
    expect(result.stats).toEqual({ added: 0, removed: 0 });
    expect(result.rows.every((r) => r.type === "equal")).toBe(true);
  });

  test("追加された行を add として返す", () => {
    const result = diffLines("a\nc", "a\nb\nc");
    expect(sketch(result.rows)).toEqual([" a", "+b", " c"]);
    expect(result.stats).toEqual({ added: 1, removed: 0 });
  });

  test("削除された行を del として返す", () => {
    const result = diffLines("a\nb\nc", "a\nc");
    expect(sketch(result.rows)).toEqual([" a", "-b", " c"]);
    expect(result.stats).toEqual({ added: 0, removed: 1 });
  });

  // 行単位なので「変更」は del + add で表す
  test("変更された行は del と add の並びになる", () => {
    const result = diffLines("a\nBEFORE\nc", "a\nAFTER\nc");
    expect(sketch(result.rows)).toEqual([" a", "-BEFORE", "+AFTER", " c"]);
    expect(result.stats).toEqual({ added: 1, removed: 1 });
  });

  test("行番号を両側に振る（片側にしか無い行は null）", () => {
    const { rows } = diffLines("a\nb", "a\nX\nb");
    expect(rows.map((r) => [r.type, r.leftNo, r.rightNo])).toEqual([
      ["equal", 1, 1],
      ["add", null, 2],
      ["equal", 2, 3],
    ]);
  });

  test("空文字どうしでも壊れない", () => {
    const result = diffLines("", "");
    expect(result.truncated).toBe(false);
    expect(result.stats).toEqual({ added: 0, removed: 0 });
  });

  test("片方が空なら全行が差分になる", () => {
    expect(sketch(diffLines("", "a\nb").rows)).toEqual(["-", "+a", "+b"]);
    expect(sketch(diffLines("a\nb", "").rows)).toEqual(["-a", "-b", "+"]);
  });

  // **改行コードの違いだけで全行差分にしない。** Windows で編集したファイルを混ぜたときに
  // 「全部変わりました」と出ると、本当の差分が埋もれる
  test("CRLF と LF の違いは差分にしない", () => {
    const result = diffLines("a\r\nb\r\nc", "a\nb\nc");
    expect(result.stats).toEqual({ added: 0, removed: 0 });
  });

  // 末尾に改行があるかどうかは実際の差分なので、消さずに見せる
  test("末尾の改行の有無は差分として出す", () => {
    const result = diffLines("a\n", "a");
    expect(result.stats.removed).toBe(1);
  });

  describe("大きな文書では計算を諦める", () => {
    test("差分の行数が上限を超えたら truncated", () => {
      const local = Array.from({ length: 50 }, (_, i) => `L${i}`).join("\n");
      const server = Array.from({ length: 50 }, (_, i) => `S${i}`).join("\n");
      const result = diffLines(local, server, { maxLines: 10 });

      expect(result.truncated).toBe(true);
      expect(result.reason).toBe("lines");
      expect(result.rows).toEqual([]);
    });

    // **共通部分を先に削るので、長くても差分が小さければ計算できる。**
    // ここが効かないと、大きなファイルの 1 行直しですら諦めることになる
    test("長い文書でも差分が小さければ諦めない", () => {
      const common = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
      const local = common.join("\n");
      const server = [...common.slice(0, 2500), "変更した行", ...common.slice(2501)].join("\n");

      const result = diffLines(local, server, { maxLines: 10 });

      expect(result.truncated).toBe(false);
      expect(result.stats).toEqual({ added: 1, removed: 1 });
    });

    // 行数では弾けない「巨大な 1 行」を落とす
    test("バイト数が上限を超えたら truncated", () => {
      const result = diffLines("x".repeat(2000), "y".repeat(2000), { maxBytes: 100 });

      expect(result.truncated).toBe(true);
      expect(result.reason).toBe("bytes");
    });

    test("バイト数は UTF-8 で数える（日本語で上限をすり抜けない）", () => {
      // 「あ」「い」は UTF-8 で 3 バイト。100 文字 = 300 バイト
      const a = "あ".repeat(100);
      const b = "い".repeat(100);
      expect(diffLines(a, b, { maxBytes: 200 }).truncated).toBe(true);
      expect(diffLines(a, b, { maxBytes: 400 }).truncated).toBe(false);
    });

    // **上限はトリム後に見る。** 文書全体の大きさで判断すると、README が保証している
    // 「変更が一部なら長い文書でも差分は出る」が破れる（比較対象は 1 行 vs 1 行なのに諦める）
    test("上限を超える大きさの文書でも、差分が小さければバイト数で諦めない", () => {
      const common = Array.from({ length: 1000 }, (_, i) => `line ${i} ${"x".repeat(40)}`);
      const local = common.join("\n");
      const server = [...common.slice(0, 500), "直した行", ...common.slice(501)].join("\n");
      // 文書全体は 40KB 超。トリム後は 1 行 vs 1 行なので数十バイト
      expect(new TextEncoder().encode(local).length).toBeGreaterThan(40_000);

      const result = diffLines(local, server, { maxBytes: 1000 });

      expect(result.truncated).toBe(false);
      expect(result.stats).toEqual({ added: 1, removed: 1 });
    });

    // トリム前の保険。行に割ることすら重い大きさはここで落とす
    test("桁違いに大きければ、行に割る前に諦める", () => {
      // maxBytes の 64 倍がハード上限
      const huge = "x".repeat(7000);
      const result = diffLines(huge, huge, { maxBytes: 100 });

      expect(result.truncated).toBe(true);
      expect(result.reason).toBe("bytes");
    });
  });
});

describe("collapseUnchanged", () => {
  const build = (local: string, server: string) => diffLines(local, server).rows;

  test("変更の前後 context 行だけを残す", () => {
    const rows = build(
      Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n"),
      [
        ...Array.from({ length: 10 }, (_, i) => `line${i}`),
        "変更",
        ...Array.from({ length: 9 }, (_, i) => `line${i + 11}`),
      ].join("\n"),
    );
    const collapsed = collapseUnchanged(rows, 2);

    // 先頭と末尾の離れた同一行は畳まれている
    expect(collapsed[0]).toEqual({ type: "skip", count: 8 });
    expect(collapsed[collapsed.length - 1]).toEqual({ type: "skip", count: 7 });
    // 変更行そのものは残る
    expect(collapsed.some((r) => r.type === "del")).toBe(true);
    expect(collapsed.some((r) => r.type === "add")).toBe(true);
  });

  test("差分が無ければ全部 1 つの skip に畳まれる", () => {
    const rows = build("a\nb\nc", "a\nb\nc");
    expect(collapseUnchanged(rows, 2)).toEqual([{ type: "skip", count: 3 }]);
  });

  test("短い文書は畳まない（context に収まる）", () => {
    const rows = build("a\nb", "a\nX");
    const collapsed = collapseUnchanged(rows, 3);
    expect(collapsed.some((r) => r.type === "skip")).toBe(false);
  });

  test("context が 0 なら変更行だけが残る", () => {
    const rows = build("a\nb\nc\nd\ne", "a\nb\nX\nd\ne");
    const collapsed = collapseUnchanged(rows, 0);

    expect(collapsed).toEqual([
      { type: "skip", count: 2 },
      { type: "del", text: "c", leftNo: 3, rightNo: null },
      { type: "add", text: "X", leftNo: null, rightNo: 3 },
      { type: "skip", count: 2 },
    ]);
  });

  // 負値でも変更行を落とさない（内側のループが回らず全部畳まれるのを防ぐ）
  test("context が負でも変更行は残る", () => {
    const rows = build("a\nb\nc", "a\nX\nc");
    const collapsed = collapseUnchanged(rows, -1);

    expect(collapsed.some((r) => r.type === "del")).toBe(true);
    expect(collapsed.some((r) => r.type === "add")).toBe(true);
  });

  test("畳んだ行数の合計が元の行数と合う", () => {
    const rows = build(
      Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n"),
      [
        ...Array.from({ length: 15 }, (_, i) => `l${i}`),
        "x",
        ...Array.from({ length: 14 }, (_, i) => `l${i + 16}`),
      ].join("\n"),
    );
    const collapsed = collapseUnchanged(rows, 3);

    const shown = collapsed.filter((r) => r.type !== "skip").length;
    const hidden = collapsed
      .filter((r): r is { type: "skip"; count: number } => r.type === "skip")
      .reduce((sum, r) => sum + r.count, 0);
    expect(shown + hidden).toBe(rows.length);
  });
});
