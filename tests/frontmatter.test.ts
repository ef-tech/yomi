import { describe, expect, test } from "bun:test";
import { parseFrontmatter, renderFrontmatter } from "../src/frontmatter.ts";

describe("parseFrontmatter", () => {
  test("フロントマターなしならそのまま body", () => {
    const r = parseFrontmatter("# Hello\nworld");
    expect(r.entries).toEqual([]);
    expect(r.body).toBe("# Hello\nworld");
  });

  test("基本的な key: value", () => {
    const src = "---\ntitle: Test\nauthor: ef-tech\n---\n# Body";
    const r = parseFrontmatter(src);
    expect(r.entries).toEqual([
      { key: "title", value: "Test" },
      { key: "author", value: "ef-tech" },
    ]);
    expect(r.body).toBe("# Body");
  });

  test("空行と YAML コメント (#) をスキップ", () => {
    const src = "---\ntitle: A\n\n# これはコメント\nauthor: B\n---\n本文";
    const r = parseFrontmatter(src);
    expect(r.entries).toEqual([
      { key: "title", value: "A" },
      { key: "author", value: "B" },
    ]);
  });

  test("ネスト (1 段階) を children として保持", () => {
    const src = "---\nsummary:\n  good: 5\n  bad: 0\ntitle: T\n---\n本文";
    const r = parseFrontmatter(src);
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]).toEqual({
      key: "summary",
      value: "",
      children: [
        { key: "good", value: "5" },
        { key: "bad", value: "0" },
      ],
    });
    expect(r.entries[1]).toEqual({ key: "title", value: "T" });
  });

  test("コロンを含む値", () => {
    const src = "---\nurl: https://example.com\n---\n本文";
    const r = parseFrontmatter(src);
    expect(r.entries[0]).toEqual({
      key: "url",
      value: "https://example.com",
    });
  });

  test("CRLF 改行にも対応", () => {
    const src = "---\r\ntitle: A\r\n---\r\n本文";
    const r = parseFrontmatter(src);
    expect(r.entries[0]?.value).toBe("A");
    expect(r.body).toBe("本文");
  });

  test("末尾 --- 後の改行が無くても OK", () => {
    const src = "---\ntitle: A\n---";
    // 末尾改行なしの場合の挙動 (regex は \r?\n? で吸う)
    const r = parseFrontmatter(src);
    expect(r.entries[0]?.value).toBe("A");
  });

  test("コロンのない行はスキップ", () => {
    const src = "---\ntitle: A\nbroken line\nauthor: B\n---\n本文";
    const r = parseFrontmatter(src);
    expect(r.entries).toHaveLength(2);
    expect(r.entries.map((e) => e.key)).toEqual(["title", "author"]);
  });

  test("キーが空の行はスキップ", () => {
    const src = "---\n: value\ntitle: A\n---\n本文";
    const r = parseFrontmatter(src);
    expect(r.entries).toEqual([{ key: "title", value: "A" }]);
  });
});

describe("renderFrontmatter", () => {
  test("空配列なら空文字", () => {
    expect(renderFrontmatter([])).toBe("");
  });

  test("単純なキー値を <dl> として出力", () => {
    const html = renderFrontmatter([
      { key: "title", value: "Test" },
      { key: "author", value: "ef-tech" },
    ]);
    expect(html).toContain('<dl class="frontmatter">');
    expect(html).toContain("<dt>title</dt><dd>Test</dd>");
    expect(html).toContain("<dt>author</dt><dd>ef-tech</dd>");
  });

  test("URL はリンクに変換 (新規タブ)", () => {
    const html = renderFrontmatter([{ key: "url", value: "https://example.com/foo" }]);
    expect(html).toContain('<a href="https://example.com/foo" target="_blank" rel="noopener">');
  });

  test("クォートで囲まれた値はクォートを除去", () => {
    const html = renderFrontmatter([{ key: "title", value: '"Quoted"' }]);
    expect(html).toContain("<dd>Quoted</dd>");
  });

  test("HTML 特殊文字をエスケープ", () => {
    const html = renderFrontmatter([
      { key: "title", value: "<script>" },
      { key: "owner", value: "a&b" },
    ]);
    expect(html).toContain("<dd>&lt;script&gt;</dd>");
    expect(html).toContain("<dd>a&amp;b</dd>");
  });

  test("ネスト children をフラット表示", () => {
    const html = renderFrontmatter([
      {
        key: "stats",
        value: "",
        children: [
          { key: "good", value: "5" },
          { key: "bad", value: "0" },
        ],
      },
    ]);
    expect(html).toContain('<dd class="fm-nested">');
    expect(html).toContain('<span class="fm-pair">');
    expect(html).toContain('<span class="fm-k">good</span>');
    expect(html).toContain('<span class="fm-v">5</span>');
  });

  test("値も children も無いキーは出力しない", () => {
    const html = renderFrontmatter([{ key: "empty", value: "" }]);
    expect(html).toBe("");
  });
});
