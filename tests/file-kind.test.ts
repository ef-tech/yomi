import { describe, expect, test } from "bun:test";
import { isMarkdownName, MD_EXTENSIONS } from "../public/file-kind.js";
import { isMarkdownExtension } from "../src/util/markdown-ext.ts";

/**
 * Issue #155: ツリーの描画がここで種別を見分ける。
 *
 * **サーバ側の `isMarkdownExtension` と同じ判定でなければならない** —— ずれると、
 * ツリーで「テキスト」のアイコンが付いたファイルを開いたらプレビューが出る（またはその逆）
 * という食い違いになる。同じ入力で突き合わせて固定する。
 */
describe("isMarkdownName (Issue #155)", () => {
  const CASES = [
    "README.md",
    "a.markdown",
    "a.mdx",
    "A.MD",
    "docs/deep/note.md",
    "notes.txt",
    "config.json",
    "Dockerfile",
    ".gitignore",
    "noext",
    "trailing.",
    "",
    "x.mdd",
    "mdx",
  ];

  test("サーバ側の isMarkdownExtension と同じ判定になる", () => {
    for (const name of CASES) {
      expect({ name, md: isMarkdownName(name) }).toEqual({
        name,
        md: isMarkdownExtension(name),
      });
    }
  });

  test("Markdown を true、それ以外を false にする", () => {
    expect(isMarkdownName("README.md")).toBe(true);
    expect(isMarkdownName("a.markdown")).toBe(true);
    expect(isMarkdownName("a.mdx")).toBe(true);
    // 大文字小文字は問わない
    expect(isMarkdownName("A.MD")).toBe(true);

    expect(isMarkdownName("notes.txt")).toBe(false);
    expect(isMarkdownName("Dockerfile")).toBe(false);
    expect(isMarkdownName(".gitignore")).toBe(false);
    expect(isMarkdownName("noext")).toBe(false);
  });

  test("MD_EXTENSIONS はサーバ側と同じ集合", () => {
    // `tests/new-file.test.ts` も同じ検証をしているが、あちらは new-file.js 経由の
    // 再エクスポートを見ている。定義そのものはここで押さえる
    expect([...MD_EXTENSIONS].sort()).toEqual([".markdown", ".md", ".mdx"]);
  });
});
