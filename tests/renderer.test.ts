import { describe, expect, test } from "bun:test";
import { renderMarkdown, rewriteImageHref } from "../src/renderer.ts";

describe("renderMarkdown", () => {
  test("見出しと段落をレンダリング (h1 に id 付与)", async () => {
    const html = await renderMarkdown("# Title\n\n本文");
    expect(html).toContain('<h1 id="title">Title</h1>');
    expect(html).toContain("<p>本文</p>");
  });

  test("日本語見出しは id にも日本語が残る", async () => {
    const html = await renderMarkdown("## 使い方");
    expect(html).toContain('<h2 id="使い方">使い方</h2>');
  });

  test("同じ見出しが複数あれば id にサフィックスが付く", async () => {
    const html = await renderMarkdown("## intro\n\n## intro\n\n## intro");
    expect(html).toContain('<h2 id="intro">intro</h2>');
    expect(html).toContain('<h2 id="intro-1">intro</h2>');
    expect(html).toContain('<h2 id="intro-2">intro</h2>');
  });

  test("見出しテキストが記号のみ → section-N fallback", async () => {
    const html = await renderMarkdown("# !?&");
    expect(html).toMatch(/<h1 id="section-\d+">/);
  });

  test("複数文書で id 採番が独立 (Marked インスタンス分離)", async () => {
    const html1 = await renderMarkdown("## intro");
    const html2 = await renderMarkdown("## intro");
    // 2 つ目の文書でも -1 ではなく素の "intro" になる
    expect(html1).toContain('<h2 id="intro">intro</h2>');
    expect(html2).toContain('<h2 id="intro">intro</h2>');
  });

  test("GFM ソフト改行: 1 行改行 → <br>", async () => {
    const html = await renderMarkdown("1 行目\n2 行目\n\n別段落");
    expect(html).toContain("1 行目<br>2 行目");
    // 空行は段落区切り
    expect(html).toContain("<p>別段落</p>");
  });

  test('Mermaid フェンスは <pre class="mermaid"> に変換', async () => {
    const html = await renderMarkdown("```mermaid\nflowchart LR\nA-->B\n```");
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain("flowchart LR");
    expect(html).toContain("A--&gt;B");
  });

  test("Mermaid 以外のフェンスは通常の <pre><code> のまま", async () => {
    const html = await renderMarkdown("```js\nconsole.log(1)\n```");
    expect(html).toContain('<pre><code class="language-js">');
    expect(html).not.toContain('<pre class="mermaid">');
  });

  test('YAML フロントマターは <dl class="frontmatter"> として先頭に', async () => {
    const html = await renderMarkdown("---\ntitle: T\nurl: https://example.com\n---\n# 本文");
    expect(html).toContain('<dl class="frontmatter">');
    expect(html).toContain("<dt>title</dt><dd>T</dd>");
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('<h1 id="本文">本文</h1>');
    // dl が h1 より前
    expect(html.indexOf("<dl")).toBeLessThan(html.indexOf("<h1"));
  });

  test("フロントマターなしでも本文がレンダリングされる", async () => {
    const html = await renderMarkdown("# Hello");
    expect(html).not.toContain('<dl class="frontmatter">');
    expect(html).toContain('<h1 id="hello">Hello</h1>');
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
    const html = await renderMarkdown('```mermaid\ngraph TD\nA["<script>"]-->B\n```');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  describe("画像 (Issue #19)", () => {
    test("currentPath 未指定なら href はそのまま", async () => {
      const html = await renderMarkdown("![alt](foo.png)");
      expect(html).toContain('<img src="foo.png" alt="alt">');
    });

    test("相対 path は /api/asset?path=... に書き換え (同階層)", async () => {
      const html = await renderMarkdown("![alt](foo.png)", { currentPath: "guide.md" });
      expect(html).toContain('<img src="/api/asset?path=foo.png" alt="alt">');
    });

    test("相対 path は currentPath のディレクトリから解決", async () => {
      const html = await renderMarkdown("![alt](foo.png)", { currentPath: "docs/guide.md" });
      expect(html).toContain('<img src="/api/asset?path=docs/foo.png" alt="alt">');
    });

    test("`../` を含む相対 path も解決", async () => {
      const html = await renderMarkdown("![alt](../images/foo.png)", {
        currentPath: "docs/sub/guide.md",
      });
      expect(html).toContain('<img src="/api/asset?path=docs/images/foo.png" alt="alt">');
    });

    test("絶対 path (/foo.png) は root 起点で解決", async () => {
      const html = await renderMarkdown("![alt](/static/foo.png)", { currentPath: "docs/a.md" });
      expect(html).toContain('<img src="/api/asset?path=static/foo.png" alt="alt">');
    });

    test("http(s) URL はそのまま", async () => {
      const html = await renderMarkdown("![alt](https://example.com/x.png)", {
        currentPath: "a.md",
      });
      expect(html).toContain('<img src="https://example.com/x.png" alt="alt">');
    });

    test("data: URL はそのまま", async () => {
      const html = await renderMarkdown("![alt](data:image/png;base64,AAA)", {
        currentPath: "a.md",
      });
      expect(html).toContain('<img src="data:image/png;base64,AAA" alt="alt">');
    });

    test("javascript: スキームは空 href にされる", async () => {
      const html = await renderMarkdown("![alt](javascript:alert(1))", { currentPath: "a.md" });
      expect(html).toContain('<img src="" alt="alt">');
      expect(html).not.toContain("javascript:");
    });

    test("画像拡張子でない場合は書き換えない", async () => {
      const html = await renderMarkdown("![alt](foo.txt)", { currentPath: "a.md" });
      expect(html).toContain('<img src="foo.txt" alt="alt">');
      expect(html).not.toContain("/api/asset");
    });

    test("URL エンコード済みの相対 path もデコードして再構築", async () => {
      const html = await renderMarkdown("![alt](hello%20world.png)", { currentPath: "a.md" });
      expect(html).toContain('<img src="/api/asset?path=hello%20world.png" alt="alt">');
    });

    test("title 属性は保持", async () => {
      const html = await renderMarkdown('![alt](foo.png "T")', { currentPath: "a.md" });
      expect(html).toContain('<img src="/api/asset?path=foo.png" alt="alt" title="T">');
    });

    test("日本語ファイル名は URL エンコードされる", async () => {
      const html = await renderMarkdown("![alt](画像.png)", { currentPath: "a.md" });
      expect(html).toContain(`src="/api/asset?path=${encodeURIComponent("画像.png")}"`);
    });

    test("画像 href のクエリ/フラグメントは現状落ちる (仕様)", async () => {
      // resolveRelativePath が末尾のクエリ/フラグメントを切り落とすため、
      // /api/asset?path=... には反映されない。キャッシュバスター付き画像が必要なら
      // 別途設計が必要 (現状はサーバ側の no-cache + ETag で十分と判断)
      const h1 = await renderMarkdown("![a](foo.png?v=1)", { currentPath: "a.md" });
      expect(h1).toContain('src="/api/asset?path=foo.png"');
      const h2 = await renderMarkdown("![a](foo.png#x)", { currentPath: "a.md" });
      expect(h2).toContain('src="/api/asset?path=foo.png"');
    });
  });
});

describe("rewriteImageHref (unit)", () => {
  test("currentPath 未指定なら何もしない", () => {
    expect(rewriteImageHref("foo.png")).toBe("foo.png");
  });

  test("空文字は空文字", () => {
    expect(rewriteImageHref("", "a.md")).toBe("");
  });

  test("外部 URL はそのまま", () => {
    expect(rewriteImageHref("https://example.com/x.png", "a.md")).toBe("https://example.com/x.png");
  });

  test("javascript: は空", () => {
    expect(rewriteImageHref("javascript:alert(1)", "a.md")).toBe("");
  });

  test("相対画像は /api/asset URL", () => {
    expect(rewriteImageHref("foo.png", "docs/a.md")).toBe("/api/asset?path=docs/foo.png");
  });
});
