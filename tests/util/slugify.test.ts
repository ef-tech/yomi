import { describe, expect, test } from "bun:test";
import { slugify, uniqueSlug } from "../../src/util/slugify.ts";

describe("slugify", () => {
  test("英数字は小文字 + kebab-case", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  test("連続空白は単一ハイフン", () => {
    expect(slugify("a   b  c")).toBe("a-b-c");
  });

  test("先頭末尾の空白を trim", () => {
    expect(slugify("  abc  ")).toBe("abc");
  });

  test("特殊文字は除去", () => {
    expect(slugify("What's up?")).toBe("whats-up");
    expect(slugify("Foo & Bar / Baz!")).toBe("foo-bar-baz");
  });

  test("日本語見出しはそのまま残る", () => {
    expect(slugify("使い方")).toBe("使い方");
  });

  test("英数字と日本語の混在", () => {
    expect(slugify("ABC 見出し テスト")).toBe("abc-見出し-テスト");
  });

  test("既存ハイフンは保持、連続なら 1 つに", () => {
    expect(slugify("foo-bar")).toBe("foo-bar");
    expect(slugify("foo--bar")).toBe("foo-bar");
    expect(slugify("foo - bar")).toBe("foo-bar");
  });

  test("先頭末尾のハイフンを除去", () => {
    expect(slugify("-foo-")).toBe("foo");
    expect(slugify("---foo---")).toBe("foo");
  });

  test("空文字は空", () => {
    expect(slugify("")).toBe("");
    expect(slugify("   ")).toBe("");
    expect(slugify("!?&")).toBe("");
  });

  test("数字のみ", () => {
    expect(slugify("123")).toBe("123");
    expect(slugify("ver 1.0.0")).toBe("ver-100");
  });
});

describe("uniqueSlug", () => {
  test("初回はそのまま", () => {
    const used = new Set<string>();
    expect(uniqueSlug("intro", used)).toBe("intro");
    expect(used.has("intro")).toBe(true);
  });

  test("2 回目は -1", () => {
    const used = new Set<string>(["intro"]);
    expect(uniqueSlug("intro", used)).toBe("intro-1");
  });

  test("3 回目は -2、4 回目は -3", () => {
    const used = new Set<string>(["intro"]);
    expect(uniqueSlug("intro", used)).toBe("intro-1");
    expect(uniqueSlug("intro", used)).toBe("intro-2");
    expect(uniqueSlug("intro", used)).toBe("intro-3");
  });

  test("既に -1 が使われていれば -2 を返す", () => {
    const used = new Set<string>(["intro", "intro-1"]);
    expect(uniqueSlug("intro", used)).toBe("intro-2");
  });

  test("異なる base は独立して採番", () => {
    const used = new Set<string>();
    expect(uniqueSlug("a", used)).toBe("a");
    expect(uniqueSlug("b", used)).toBe("b");
    expect(uniqueSlug("a", used)).toBe("a-1");
    expect(uniqueSlug("b", used)).toBe("b-1");
  });
});
