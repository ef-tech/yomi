import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/renderer.ts";

describe("renderMarkdown", () => {
  test("見出しと段落をレンダリング", async () => {
    const html = await renderMarkdown("# Title\n\n本文");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<p>本文</p>");
  });

  test("GFM ソフト改行: 1 行改行 → <br>", async () => {
    const html = await renderMarkdown("1 行目\n2 行目\n\n別段落");
    expect(html).toContain("1 行目<br>2 行目");
    // 空行は段落区切り
    expect(html).toContain("<p>別段落</p>");
  });

  test("Mermaid フェンスは <pre class=\"mermaid\"> に変換", async () => {
    const html = await renderMarkdown(
      "```mermaid\nflowchart LR\nA-->B\n```",
    );
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain("flowchart LR");
    expect(html).toContain("A--&gt;B");
  });

  test("Mermaid 以外のフェンスは通常の <pre><code> のまま", async () => {
    const html = await renderMarkdown("```js\nconsole.log(1)\n```");
    expect(html).toContain('<pre><code class="language-js">');
    expect(html).not.toContain('<pre class="mermaid">');
  });

  test("YAML フロントマターは <dl class=\"frontmatter\"> として先頭に", async () => {
    const html = await renderMarkdown(
      "---\ntitle: T\nurl: https://example.com\n---\n# 本文",
    );
    expect(html).toContain('<dl class="frontmatter">');
    expect(html).toContain("<dt>title</dt><dd>T</dd>");
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain("<h1>本文</h1>");
    // dl が h1 より前
    expect(html.indexOf("<dl")).toBeLessThan(html.indexOf("<h1"));
  });

  test("フロントマターなしでも本文がレンダリングされる", async () => {
    const html = await renderMarkdown("# Hello");
    expect(html).not.toContain('<dl class="frontmatter">');
    expect(html).toContain("<h1>Hello</h1>");
  });

  test("テーブル (GFM) をレンダリング", async () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |";
    const html = await renderMarkdown(md);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  test("リンク変換", async () => {
    const html = await renderMarkdown("[ex](https://example.com)");
    expect(html).toContain('<a href="https://example.com">ex</a>');
  });

  test("Mermaid フェンス内の HTML 特殊文字をエスケープ", async () => {
    const html = await renderMarkdown(
      '```mermaid\ngraph TD\nA["<script>"]-->B\n```',
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
