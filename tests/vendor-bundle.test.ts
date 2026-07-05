import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Issue #52: DOMPurify / Mermaid を配布物へ同梱し jsDelivr 依存を排したことの回帰テスト。
 * bundle を消したり app.js を CDN import に戻したりしたら落ちる。
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "public", "vendor");
const APP_JS = join(ROOT, "public", "app.js");

// CDN / URL からのモジュール取得を示すパターン (ライセンスコメント中の URL 文字列は対象外)。
const CDN_HOSTS = /\b(jsdelivr\.net|unpkg\.com|esm\.sh|esm\.run|cdnjs\.cloudflare|skypack\.dev)/;
const URL_MODULE_LOAD = /(?:\bimport\s*\(\s*|\bfrom\s*)["'`]https?:\/\//;

describe("vendor bundle (Issue #52)", () => {
  test("dompurify.js / mermaid.js が同梱され、ライセンスバナーを持つ", async () => {
    for (const name of ["dompurify.js", "mermaid.js"]) {
      const text = await readFile(join(VENDOR, name), "utf8");
      expect(text.length).toBeGreaterThan(1000);
      expect(text).toContain("yomi vendored bundle");
    }
  });

  test("bundle は CDN / URL からコードを取得しない", async () => {
    for (const name of ["dompurify.js", "mermaid.js"]) {
      const text = await readFile(join(VENDOR, name), "utf8");
      expect(CDN_HOSTS.test(text)).toBe(false);
      expect(URL_MODULE_LOAD.test(text)).toBe(false);
    }
  });

  test("app.js は vendor bundle を import し、jsDelivr / URL import を持たない", async () => {
    const app = await readFile(APP_JS, "utf8");
    expect(app).toContain('from "./vendor/dompurify.js"');
    expect(app).toContain('from "./vendor/mermaid.js"');
    expect(CDN_HOSTS.test(app)).toBe(false);
    expect(URL_MODULE_LOAD.test(app)).toBe(false);
  });

  test("bundle の版数が package.json のピン留めと一致する (依存 bump 時の再ビルド忘れ検出)", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    const dompurify = await readFile(join(VENDOR, "dompurify.js"), "utf8");
    const mermaid = await readFile(join(VENDOR, "mermaid.js"), "utf8");
    // バナーは build-vendor.ts が package.json のピン留め版数から刻む。ズレ = 再ビルド忘れ。
    expect(dompurify).toContain(`DOMPurify v${pkg.devDependencies.dompurify}`);
    expect(mermaid).toContain(`Mermaid v${pkg.devDependencies.mermaid}`);
    // 固定版であること (キャレット等の範囲指定を許さない)
    expect(pkg.devDependencies.dompurify).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies.mermaid).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
