import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Issue #52: DOMPurify / Mermaid を配布物へ同梱し jsDelivr 依存を排したことの回帰テスト。
 * bundle を消したり CDN import に戻したりしたら落ちる。
 *
 * **検査対象は `public/*.js` 全体**にする (Issue #78)。責務分割で vendor の import が
 * app.js から app-context.js へ移ったように、置き場は変わりうる。app.js 決め打ちだと
 * 「別モジュールから CDN を読む」変更を素通りさせてしまう。
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const VENDOR = join(PUBLIC, "vendor");

/**
 * `public/` 配下のブラウザ側モジュール (vendor bundle 自体は別テストで検査する)。
 *
 * **再帰で集める。** 非再帰だと `public/js/foo.js` のようにサブディレクトリへ置いた
 * 瞬間、そのファイルが CDN 検査から静かに外れてテストは green のままになる
 * (「置き場は変わりうる」という上の設計意図に穴が開く)。
 */
async function browserModules(): Promise<{ name: string; text: string }[]> {
  const entries = await readdir(PUBLIC, { recursive: true, withFileTypes: true });
  const names = entries
    .filter((e) => e.isFile() && e.name.endsWith(".js"))
    .map((e) => relative(PUBLIC, join(e.parentPath, e.name)))
    // vendor bundle は生成物。別テスト (CDN_HOSTS / URL_MODULE_LOAD) で個別に検査する
    .filter((rel) => !rel.split(sep).includes("vendor"));
  return Promise.all(
    names.map(async (name) => ({ name, text: await readFile(join(PUBLIC, name), "utf8") })),
  );
}

// CDN / URL からのモジュール取得を示すパターン (ライセンスコメント中の URL 文字列は対象外)。
const CDN_HOSTS = /\b(jsdelivr\.net|unpkg\.com|esm\.sh|esm\.run|cdnjs\.cloudflare|skypack\.dev)/;
const URL_MODULE_LOAD = /(?:\bimport\s*\(\s*|\bfrom\s*)["'`]https?:\/\//;

/** 同梱する bundle。highlight.js は Issue #155 で追加。 */
const BUNDLES = ["dompurify.js", "mermaid.js", "highlight.js"];

describe("vendor bundle (Issue #52)", () => {
  test("bundle が同梱され、ライセンスバナーを持つ", async () => {
    for (const name of BUNDLES) {
      const text = await readFile(join(VENDOR, name), "utf8");
      expect(text.length).toBeGreaterThan(1000);
      expect(text).toContain("yomi vendored bundle");
    }
  });

  test("bundle は CDN / URL からコードを取得しない", async () => {
    for (const name of BUNDLES) {
      const text = await readFile(join(VENDOR, name), "utf8");
      expect(CDN_HOSTS.test(text)).toBe(false);
      expect(URL_MODULE_LOAD.test(text)).toBe(false);
    }
  });

  test("ブラウザ側コードは vendor bundle を import する", async () => {
    const modules = await browserModules();
    const all = modules.map((m) => m.text).join("\n");
    // どのモジュールから読んでいてもよいが、**必ず同梱 bundle から**読むこと
    for (const name of BUNDLES) {
      expect(all).toContain(`from "./vendor/${name}"`);
    }
  });

  test("ブラウザ側コードは jsDelivr / URL import を持たない", async () => {
    for (const { name, text } of await browserModules()) {
      // 失敗時にどのファイルかが分かるよう 1 ファイルずつ検査する
      expect({ name, cdn: CDN_HOSTS.test(text) }).toEqual({ name, cdn: false });
      expect({ name, url: URL_MODULE_LOAD.test(text) }).toEqual({ name, url: false });
    }
  });

  test("bundle の版数が package.json のピン留めと一致する (依存 bump 時の再ビルド忘れ検出)", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    const dompurify = await readFile(join(VENDOR, "dompurify.js"), "utf8");
    const mermaid = await readFile(join(VENDOR, "mermaid.js"), "utf8");
    const highlight = await readFile(join(VENDOR, "highlight.js"), "utf8");
    // バナーは build-vendor.ts が package.json のピン留め版数から刻む。ズレ = 再ビルド忘れ。
    expect(dompurify).toContain(`DOMPurify v${pkg.devDependencies.dompurify}`);
    expect(mermaid).toContain(`Mermaid v${pkg.devDependencies.mermaid}`);
    expect(highlight).toContain(`highlight.js v${pkg.devDependencies["highlight.js"]}`);
    // 固定版であること (キャレット等の範囲指定を許さない)
    expect(pkg.devDependencies.dompurify).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies.mermaid).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies["highlight.js"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

/**
 * Issue #155: サーバが返す `lang` は `src/util/text-ext.ts` の allowlist 由来なので、
 * **その値のぶんだけ highlight.js に言語が登録されていないと静かに無色になる**
 * （highlight.js は未登録の言語で例外を投げない）。両者の一致を機械的に見る。
 */
describe("ハイライト言語の登録漏れ (Issue #155)", () => {
  test("text-ext.ts が返しうる言語がすべて vendor エントリに登録されている", async () => {
    const { TEXT_FILENAMES, TEXT_LANGUAGES, PLAIN_LANGUAGE } = await import(
      "../src/util/text-ext.ts"
    );
    const entry = await readFile(join(ROOT, "scripts", "vendor", "highlight.js"), "utf8");

    const used = new Set([...Object.values(TEXT_LANGUAGES), ...Object.values(TEXT_FILENAMES)]);
    // plaintext は highlight.js の組み込みなので登録しない
    used.delete(PLAIN_LANGUAGE);

    const missing = [...used]
      .sort()
      .filter((lang) => !entry.includes(`hljs.registerLanguage("${lang}"`));
    expect(missing).toEqual([]);
  });

  test("登録した言語に対応する言語ファイルが highlight.js に存在する", async () => {
    const entry = await readFile(join(ROOT, "scripts", "vendor", "highlight.js"), "utf8");
    const registered = [...entry.matchAll(/hljs\.registerLanguage\("([^"]+)"/g)].map((m) => m[1]);
    expect(registered.length).toBeGreaterThan(0);
    for (const lang of registered) {
      // import できることまで見る (綴り違いは build でしか落ちないので、ここで拾う)
      const mod = await import(`highlight.js/lib/languages/${lang}`);
      expect(typeof mod.default).toBe("function");
    }
  });
});
