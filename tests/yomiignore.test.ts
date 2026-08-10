import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EXCLUDES } from "../src/util/excludes.ts";
import {
  describeInvalidLines,
  loadYomiignore,
  parseYomiignore,
  resolveExcludes,
  YOMIIGNORE_FILENAME,
} from "../src/yomiignore.ts";

/** 除外だけを取り出す（大半のテストは否定・無効行を見ない） */
const ex = (text: string) => parseYomiignore(text).excludes;

describe("parseYomiignore", () => {
  test("空文字なら空", () => {
    expect(parseYomiignore("")).toEqual({
      excludes: new Set(),
      negations: new Set(),
      invalid: [],
    });
  });

  test("シンプルな名前を抽出", () => {
    expect(ex("private\nbackup\n.archive")).toEqual(new Set(["private", "backup", ".archive"]));
  });

  test("空行・コメント (#) はスキップ", () => {
    expect(ex("# コメント\nprivate\n\n# 別のコメント\nbackup\n")).toEqual(
      new Set(["private", "backup"]),
    );
  });

  test("前後の空白はトリム", () => {
    expect(ex("  private  \n\tbackup\t")).toEqual(new Set(["private", "backup"]));
  });

  test("CRLF 改行に対応", () => {
    expect(ex("a\r\nb\r\nc")).toEqual(new Set(["a", "b", "c"]));
  });

  test("重複は Set で 1 件に", () => {
    const set = ex("dup\ndup\ndup");
    expect(set).toEqual(new Set(["dup"]));
    expect(set.size).toBe(1);
  });

  // **否定パターン (Issue #97)。** 既定除外を解除する唯一の手段なので、
  // ここが壊れると #65 の破壊的変更に退避弁が無い状態へ戻る
  describe("否定パターン", () => {
    test("`!name` は negations に入り、excludes には入らない", () => {
      const r = parseYomiignore("!build\n!vendor");
      expect(r.negations).toEqual(new Set(["build", "vendor"]));
      expect(r.excludes).toEqual(new Set());
    });

    test("除外と否定が混在しても取り違えない", () => {
      const r = parseYomiignore("private\n!build\nbackup");
      expect(r.excludes).toEqual(new Set(["private", "backup"]));
      expect(r.negations).toEqual(new Set(["build"]));
    });

    test("`!` の後ろの空白はトリムする", () => {
      expect(parseYomiignore("!  build  ").negations).toEqual(new Set(["build"]));
    });

    // 否定記法を足したことで「`!` から始まる名前」が書けなくなるのを避ける
    test("`\\!name` はエスケープされ、`!name` という名前の除外になる", () => {
      const r = parseYomiignore("\\!important");
      expect(r.excludes).toEqual(new Set(["!important"]));
      expect(r.negations).toEqual(new Set());
    });

    test("`!` だけの行は無効として拾う", () => {
      const r = parseYomiignore("!\n!   ");
      expect(r.negations).toEqual(new Set());
      expect(r.invalid.map((v) => v.reason)).toEqual(["empty-negation", "empty-negation"]);
    });
  });

  // **黙って無効にしない (Issue #97)。** `isExcludedPath` はセグメント完全一致なので
  // `/` や `*` を含む行はどれにも当たらない。除外が読み書きの可否を決める今、
  // 「書いたのに効いていない」は「除外したつもりのファイルが読める」を意味する
  describe("照合できない行を検出する", () => {
    test("`/` を含む行", () => {
      const r = parseYomiignore("docs/private");
      expect(r.excludes).toEqual(new Set());
      expect(r.invalid).toEqual([{ line: 1, text: "docs/private", reason: "path-separator" }]);
    });

    test("グロブを含む行", () => {
      const r = parseYomiignore("*.log\ntmp?\n[abc]");
      expect(r.excludes).toEqual(new Set());
      expect(r.invalid.map((v) => v.reason)).toEqual(["glob", "glob", "glob"]);
    });

    test("否定側でも検出する", () => {
      const r = parseYomiignore("!docs/build");
      expect(r.negations).toEqual(new Set());
      expect(r.invalid[0]?.reason).toBe("path-separator");
    });

    test("行番号は 1 始まりで、元テキストを保つ（直す場所が分かるように）", () => {
      const r = parseYomiignore("ok\n\n# c\n*.log");
      expect(r.invalid).toEqual([{ line: 4, text: "*.log", reason: "glob" }]);
    });

    test("無効な行があっても有効な行は生きる", () => {
      const r = parseYomiignore("private\n*.log\n!build");
      expect(r.excludes).toEqual(new Set(["private"]));
      expect(r.negations).toEqual(new Set(["build"]));
      expect(r.invalid).toHaveLength(1);
    });
  });
});

describe("describeInvalidLines", () => {
  test("行番号・元テキスト・理由を含む", () => {
    const msg = describeInvalidLines(parseYomiignore("docs/x\n*.log\n!").invalid);
    expect(msg).toContain(".yomiignore:1: docs/x");
    expect(msg).toContain(".yomiignore:2: *.log");
    expect(msg).toContain(".yomiignore:3: !");
    expect(msg).toContain("3 件");
  });
});

describe("loadYomiignore", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-yomiignore-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test(".yomiignore が無ければ空", async () => {
    expect(await loadYomiignore(root)).toEqual({
      excludes: new Set(),
      negations: new Set(),
      invalid: [],
    });
  });

  test(".yomiignore があればパースして返す", async () => {
    await writeFile(join(root, YOMIIGNORE_FILENAME), "# 個人メモ\nprivate\nbackup\n!build\n");
    const r = await loadYomiignore(root);
    expect(r.excludes).toEqual(new Set(["private", "backup"]));
    expect(r.negations).toEqual(new Set(["build"]));
  });

  test("読み取り失敗時 (パーミッション等) は空でフォールバック", async () => {
    // 実際の権限テストは難しいので、存在しないディレクトリで代用
    const r = await loadYomiignore(join(root, "nonexistent-subdir"));
    expect(r).toEqual({ excludes: new Set(), negations: new Set(), invalid: [] });
  });
});

// **DoD: 否定は DEFAULT_EXCLUDES にも .yomiignore の他の行にも効き、適用順が決まっている**
describe("resolveExcludes", () => {
  test("既定と追加の和集合を作る", () => {
    const r = resolveExcludes(parseYomiignore("private"), new Set(["node_modules"]));
    expect(r).toEqual(new Set(["node_modules", "private"]));
  });

  // これができないと #65 の破壊的変更に退避弁が無い（この Issue の主目的）
  test("否定で DEFAULT_EXCLUDES を解除できる", () => {
    const r = resolveExcludes(parseYomiignore("!build"), new Set(["node_modules", "build"]));
    expect(r.has("build")).toBe(false);
    expect(r.has("node_modules")).toBe(true);
  });

  test("否定は .yomiignore が自分で足した行にも効く", () => {
    const r = resolveExcludes(parseYomiignore("private\n!private"), new Set());
    expect(r.has("private")).toBe(false);
  });

  // 行の順序で結果が変わると「なぜ効かないか」が読み取れなくなる
  test("同じ名前を追加と否定の両方に書いたら、書き順に関わらず否定が勝つ", () => {
    const a = resolveExcludes(parseYomiignore("foo\n!foo"), new Set());
    const b = resolveExcludes(parseYomiignore("!foo\nfoo"), new Set());
    expect(a.has("foo")).toBe(false);
    expect(b.has("foo")).toBe(false);
  });

  test("存在しない名前を否定しても壊れない", () => {
    const r = resolveExcludes(parseYomiignore("!nonexistent"), new Set(["node_modules"]));
    expect(r).toEqual(new Set(["node_modules"]));
  });

  test("既定値を省略すると DEFAULT_EXCLUDES を使う", () => {
    const r = resolveExcludes(parseYomiignore(""));
    expect(r).toEqual(new Set(DEFAULT_EXCLUDES));
    // 呼び出し側が書き換えても DEFAULT_EXCLUDES 自体は汚れない
    r.add("x");
    expect(DEFAULT_EXCLUDES.has("x")).toBe(false);
  });
});
