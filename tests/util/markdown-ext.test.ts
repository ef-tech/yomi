import { describe, expect, test } from "bun:test";
import { isMarkdownExtension, MD_EXTENSIONS } from "../../src/util/markdown-ext.ts";

describe("MD_EXTENSIONS", () => {
  test("md / markdown / mdx を含む", () => {
    expect(MD_EXTENSIONS.has(".md")).toBe(true);
    expect(MD_EXTENSIONS.has(".markdown")).toBe(true);
    expect(MD_EXTENSIONS.has(".mdx")).toBe(true);
  });

  test("関係ない拡張子は含まない", () => {
    expect(MD_EXTENSIONS.has(".txt")).toBe(false);
    expect(MD_EXTENSIONS.has(".html")).toBe(false);
    expect(MD_EXTENSIONS.has(".js")).toBe(false);
  });
});

describe("isMarkdownExtension", () => {
  test("Markdown 拡張子を認識する", () => {
    expect(isMarkdownExtension("a.md")).toBe(true);
    expect(isMarkdownExtension("path/to/b.markdown")).toBe(true);
    expect(isMarkdownExtension("c.mdx")).toBe(true);
  });

  test("大文字小文字を区別しない", () => {
    expect(isMarkdownExtension("README.MD")).toBe(true);
    expect(isMarkdownExtension("file.MarkDown")).toBe(true);
    expect(isMarkdownExtension("doc.MDX")).toBe(true);
  });

  test("Markdown 以外を拒否", () => {
    expect(isMarkdownExtension("a.txt")).toBe(false);
    expect(isMarkdownExtension("README")).toBe(false);
    expect(isMarkdownExtension("file.html")).toBe(false);
    expect(isMarkdownExtension("script.js")).toBe(false);
  });

  test("拡張子のないファイル名・空文字を拒否", () => {
    expect(isMarkdownExtension("")).toBe(false);
    expect(isMarkdownExtension("noext")).toBe(false);
  });

  test("ドットだけ・複数ドットも処理", () => {
    expect(isMarkdownExtension(".md")).toBe(true);
    expect(isMarkdownExtension("a.b.md")).toBe(true);
    expect(isMarkdownExtension("a.md.bak")).toBe(false);
  });
});
