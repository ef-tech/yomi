/**
 * ベンダー bundle 生成 (Issue #52)。
 *
 * DOMPurify と Mermaid を jsDelivr から実行時 import する代わりに、ローカルの
 * `public/vendor/*.js` へ bundle して同梱する。これにより、
 * - オフライン / CDN 障害 / ネットワーク制限下でもプレビューと Mermaid が動く
 * - ブラウザが外部ホスト (jsdelivr 等) へリクエストしない (CSP `script-src 'self'`)
 * - 外部コードの自動更新に依存しない (バージョン固定で再現性を確保)
 *
 * 生成物は `public/` (package.json の files に含まれる) にコミットするため、
 * GitHub からの global install でもそのまま同梱される。ビルドは開発時のみ必要で、
 * dompurify / mermaid は devDependencies (実行時は committed bundle を使う)。
 *
 * 使い方: `bun run build`
 * CI では build 後に `git diff --exit-code` で生成物の鮮度を検証する。
 */
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = "public/vendor";

// バージョンは package.json のピン留めから読み、バナーに刻む (再現性 / ライセンス表記)。
const pkg = (await import("../package.json", { with: { type: "json" } })).default as {
  devDependencies: Record<string, string>;
};

const banner = [
  "/*!",
  " * yomi vendored bundle — Issue #52 (do not edit by hand; run `bun run build`)",
  ` * DOMPurify v${pkg.devDependencies.dompurify} — (c) Cure53, Apache-2.0 OR MPL-2.0 — https://github.com/cure53/DOMPurify`,
  ` * Mermaid v${pkg.devDependencies.mermaid} — MIT — https://github.com/mermaid-js/mermaid`,
  " */",
].join("\n");

// **手書きの型定義 (`*.d.ts`) を残して、それ以外を消す。** ディレクトリごと消すと型定義まで
// 巻き添えになる —— それらは bundle の型を `tsc` へ渡すために必要で (Issue #79)、
// `bun run build` のたびに消えると CI の `git diff --exit-code -- public/vendor` が落ちる。
for (const name of await readdir(OUT_DIR).catch(() => [] as string[])) {
  // **「`.d.ts` 以外」で判定する。** 「`.js` だけ消す」にすると、Bun.build が想定外の
  // 拡張子 (`.map` 等) を吐いたときに削除も検出もされず、下の「想定外のファイル」検査を
  // すり抜ける (新規ファイルは untracked なので CI の `git diff --exit-code` にも出ない)。
  if (!name.endsWith(".d.ts")) await rm(join(OUT_DIR, name), { force: true });
}

const result = await Bun.build({
  entrypoints: ["scripts/vendor/dompurify.js", "scripts/vendor/mermaid.js"],
  outdir: OUT_DIR,
  target: "browser",
  format: "esm",
  minify: true,
  splitting: false,
  sourcemap: "none",
  banner,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("vendor bundle のビルドに失敗しました");
}

// 生成物の検証: bundle が実行時に外部からコードを取得しないこと。
// ライブラリの埋め込みライセンスコメントには github/w3.org 等の URL 文字列が
// 含まれるが、それらは fetch ではない。ここでは「URL からのモジュール読み込み」と
// 「既知 JS CDN ホスト」だけを検出する (これが Issue #52 の狙い = jsDelivr 依存の排除)。
// 実行時は CSP `script-src 'self'` が最終防壁として外部 script を遮断する。
// **手書きの型定義 (`*.d.ts`) だけを検査対象から外す** (Issue #79)。それ以外は
// すべて生成物とみなして検査に掛ける —— 想定外の拡張子が出たら気づきたい。
const files = (await readdir(OUT_DIR)).filter((f) => !f.endsWith(".d.ts"));
const CDN_HOSTS = /\b(jsdelivr\.net|unpkg\.com|esm\.sh|esm\.run|cdnjs\.cloudflare|skypack\.dev)/;
const URL_MODULE_LOAD = /(?:\bimport\s*\(\s*|\bfrom\s*)["'`]https?:\/\//;
const offenders: string[] = [];
for (const f of files) {
  const text = await readFile(join(OUT_DIR, f), "utf8");
  if (CDN_HOSTS.test(text)) offenders.push(`${f}: 既知の CDN ホスト参照`);
  if (URL_MODULE_LOAD.test(text)) offenders.push(`${f}: URL からのモジュール import`);
  // 追加チャンクの動的 import はコード分割が起きた証拠 (splitting:false で起きないはず)。
  if (/\bimport\s*\(\s*["'`]\.\//.test(text)) offenders.push(`${f}: 相対チャンクの動的 import`);
}
if (offenders.length > 0) {
  throw new Error(`vendor bundle の検証に失敗:\n${offenders.join("\n")}`);
}

// 生成物が想定の 2 ファイルだけであること (余計なチャンクが出ていない)。
const unexpected = files.filter((f) => f !== "dompurify.js" && f !== "mermaid.js");
if (unexpected.length > 0) {
  throw new Error(`vendor bundle に想定外のファイル: ${unexpected.join(", ")}`);
}

const sizes = await Promise.all(
  files.sort().map(async (f) => {
    const { size } = await Bun.file(join(OUT_DIR, f)).stat();
    return `  ${f}: ${(size / 1024).toFixed(0)} KB`;
  }),
);
console.log(`vendor bundle 生成完了 (${OUT_DIR}):\n${sizes.join("\n")}`);
