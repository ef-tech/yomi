/**
 * Content-Disposition ヘッダの組み立て (RFC 6266 / RFC 5987)。
 *
 * Issue #64: csv 等を attachment で配信する際にファイル名を伝える。
 * 日本語ファイル名を壊さないため `filename*=UTF-8''<percent-encoded>` を付け、
 * 古い実装向けに ASCII へ落とした `filename="..."` も併記する。
 *
 * ファイル名は利用者のディスク上の任意文字列なので、引用符・バックスラッシュ・
 * 改行がそのままヘッダへ載るとヘッダインジェクションになる。filename* は
 * percent-encode、fallback は ASCII 印字可能文字以外を `_` に落として防ぐ。
 */

/**
 * RFC 5987 の attr-char 以外を percent-encode する。
 * encodeURIComponent が残す `'` `(` `)` `*` は attr-char ではないので追加で潰す。
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * ASCII 印字可能文字 (0x20-0x7E) 以外と `"` `\` を `_` に落とした fallback 名。
 * 空になった場合は "download" を使う (`filename=""` を出さない)。
 */
function asciiFallbackName(filename: string): string {
  const replaced = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return replaced.trim() === "" ? "download" : replaced;
}

/**
 * Content-Disposition の値を組み立てる。
 * inline は従来どおりファイル名を付けない (画像 / PDF はブラウザが表示するだけ)。
 */
export function buildContentDisposition(
  disposition: "inline" | "attachment",
  filename: string,
): string {
  if (disposition === "inline") return "inline";
  return `attachment; filename="${asciiFallbackName(filename)}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}
