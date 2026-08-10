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

    // `\!foo` で足した除外を否定で打ち消せること（エスケープを両側に掛けた効果）
    test("`\\!name` で足した除外を `!\\!name` でも `!!name` でも打ち消せる", () => {
      for (const line of ["\\!important\n!\\!important", "\\!important\n!!important"]) {
        const r = parseYomiignore(line);
        expect(r.excludes).toEqual(new Set(["!important"]));
        expect(r.negations).toEqual(new Set(["!important"]));
        expect(resolveExcludes(r, new Set()).has("!important")).toBe(false);
      }
    });

    test("`!` だけの行は無効として拾う", () => {
      const r = parseYomiignore("!\n!   ");
      expect(r.negations).toEqual(new Set());
      expect(r.invalid.map((v) => v.reason)).toEqual(["empty-negation", "empty-negation"]);
      expect(r.invalid.every((v) => v.dropped)).toBe(true);
    });
  });

  // **黙って無効にしない (Issue #97)。** ただし扱いは 2 つに分かれる ——
  // 照合が成立しない行は捨て、グロブ文字を含む名前は**除外として残す**
  describe("意図どおり効かない行を検出する", () => {
    test("`/` を含む行は捨てる（どのセグメントにも当たらない）", () => {
      const r = parseYomiignore("docs/private");
      expect(r.excludes).toEqual(new Set());
      expect(r.invalid).toEqual([
        { line: 1, text: "docs/private", reason: "path-separator", dropped: true },
      ]);
    });

    // **捨ててはいけない。** `foo[1].md` は実在しうる名前で、これまで完全一致で
    // 除外できていた。捨てると除外が消えてファイルが読めるようになる（fail-open）
    test("グロブ文字を含む名前は除外として残し、警告だけ出す", () => {
      const r = parseYomiignore("*.log\ntmp?\nfoo[1].md");
      expect(r.excludes).toEqual(new Set(["*.log", "tmp?", "foo[1].md"]));
      expect(r.invalid.map((v) => v.reason)).toEqual(["glob", "glob", "glob"]);
      expect(r.invalid.every((v) => v.dropped)).toBe(false);
    });

    test("グロブ文字を含む否定も残る（解除できなくならない）", () => {
      const r = parseYomiignore("![build]");
      expect(r.negations).toEqual(new Set(["[build]"]));
      expect(r.invalid[0]?.dropped).toBe(false);
    });

    test("否定側の `/` は捨てる", () => {
      const r = parseYomiignore("!docs/build");
      expect(r.negations).toEqual(new Set());
      expect(r.invalid[0]).toMatchObject({ reason: "path-separator", dropped: true });
    });

    test("行番号は 1 始まりで、元テキストを保つ（直す場所が分かるように）", () => {
      const r = parseYomiignore("ok\n\n# c\ndocs/x");
      expect(r.invalid).toEqual([
        { line: 4, text: "docs/x", reason: "path-separator", dropped: true },
      ]);
    });

    test("捨てた行があっても他の行は生きる", () => {
      const r = parseYomiignore("private\ndocs/x\n!build");
      expect(r.excludes).toEqual(new Set(["private"]));
      expect(r.negations).toEqual(new Set(["build"]));
      expect(r.invalid).toHaveLength(1);
    });
  });
});

describe("describeInvalidLines", () => {
  const msg = () => describeInvalidLines(parseYomiignore("docs/x\n*.log\n!").invalid);

  test("行番号と元テキストを含む（直す場所が分かる）", () => {
    expect(msg()).toContain(".yomiignore:1: docs/x");
    expect(msg()).toContain(".yomiignore:2: *.log");
    expect(msg()).toContain(".yomiignore:3: !");
  });

  // 理由ごとに文面が違うことを見る（マッピングを取り違えても通らないように）
  test("理由ごとの説明を出し分ける", () => {
    const m = msg();
    expect(m).toMatch(/docs\/x — `\/` を含む行は照合できません/);
    expect(m).toMatch(/\*\.log — グロブ .* は展開されません/);
    expect(m).toMatch(/! — `!` の後ろに名前がありません/);
  });

  // 「無視した」と「そのまま使う」を混ぜない
  test("捨てた件数と、残して注意した件数を書き分ける", () => {
    const m = msg();
    expect(m).toContain("無視 2 件");
    expect(m).toContain("注意 1 件");
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

  test("存在しないディレクトリでも空でフォールバック", async () => {
    // 実 EACCES は root で走る CI では作れないので、ENOENT で代表させる
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
