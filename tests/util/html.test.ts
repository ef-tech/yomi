import { describe, expect, test } from "bun:test";
import { escapeHtml } from "../../src/util/html.ts";

describe("escapeHtml", () => {
  test("特殊文字をすべてエスケープ", () => {
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml('"')).toBe("&quot;");
    expect(escapeHtml("'")).toBe("&#39;");
  });

  test("通常文字は変更しない", () => {
    expect(escapeHtml("hello")).toBe("hello");
    expect(escapeHtml("日本語")).toBe("日本語");
    expect(escapeHtml("")).toBe("");
  });

  test("複合: タグ風文字列をエスケープ", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;",
    );
  });

  test("& を最初にエスケープ (二重エスケープを避ける)", () => {
    // 順序が逆だと &lt; → &amp;lt; になってしまう
    expect(escapeHtml("&<")).toBe("&amp;&lt;");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});
