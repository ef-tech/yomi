/**
 * `/api/asset` 経由で配信できる拡張子 → MIME マッピング。
 *
 * 画像 (IMAGE_CONTENT_TYPES) に加え、ブラウザがネイティブで表示できる
 * 添付ファイル系を許可する。Issue #37: md 内 `[X](foo.pdf)` を別タブで
 * 開くため PDF を追加。PDF は Content-Disposition: inline で配信され、
 * Chrome 等の内蔵 PDF ビューアでそのまま閲覧できる。
 *
 * Issue #64: md からリンクした csv 等をローカルに保存できるよう、ブラウザが
 * 実行も描画もしないデータ / 文書 / アーカイブ形式を追加した。これらは
 * Content-Disposition: attachment で配信する (DOWNLOAD_CONTENT_TYPES)。
 * **許可リスト方式は維持する**: `.html` / `.htm` / `.xhtml` / `.js` / `.mjs` は
 * top-level navigation でスクリプトが動く経路になるため追加しない
 * (Issue #21 / #22 の XSS 対策を迂回させない)。
 */
import { IMAGE_CONTENT_TYPES } from "./image-ext.ts";

/**
 * ブラウザ上でそのまま表示する (Content-Disposition: inline) アセット。
 * 画像は `<img src>`、PDF は内蔵ビューアで表示される。
 */
export const INLINE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ...IMAGE_CONTENT_TYPES,
  ".pdf": "application/pdf",
};

/**
 * ダウンロード (Content-Disposition: attachment) で配信するアセット (Issue #64)。
 * ブラウザが script として実行せず、HTML としても描画しない形式に限る。
 */
export const DOWNLOAD_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".yaml": "application/yaml; charset=utf-8",
  ".yml": "application/yaml; charset=utf-8",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ...INLINE_CONTENT_TYPES,
  ...DOWNLOAD_CONTENT_TYPES,
};

/**
 * 小文字化した拡張子 (先頭ドット込み) を返す。拡張子なし・末尾ドットは null。
 * 判定関数がこれを共有するので、`foo.` や `noext` の扱いが関数間でずれない。
 */
function extensionOf(nameOrPath: string): string | null {
  const dot = nameOrPath.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = nameOrPath.slice(dot).toLowerCase();
  return ext === "." ? null : ext;
}

export function isAssetExtension(nameOrPath: string): boolean {
  const ext = extensionOf(nameOrPath);
  // Object.hasOwn で `.toString` / `.__proto__` 等の Object.prototype 継承
  // プロパティ経由でフィルタを通過する経路を塞ぐ (defense-in-depth)。
  return ext !== null && Object.hasOwn(ASSET_CONTENT_TYPES, ext);
}

export function assetContentType(nameOrPath: string): string | null {
  const ext = extensionOf(nameOrPath);
  if (ext === null || !Object.hasOwn(ASSET_CONTENT_TYPES, ext)) return null;
  return ASSET_CONTENT_TYPES[ext] ?? null;
}

/**
 * 配信時の Content-Disposition 種別 (Issue #64)。
 *
 * inline は画像 / PDF に限る。許可リストに無い拡張子は安全側の attachment に
 * 倒す (呼び出し側は isAssetExtension を先に通すので通常は到達しないが、
 * 「表示させる」判断を明示的な allowlist だけに依存させるため)。
 */
export function assetDisposition(nameOrPath: string): "inline" | "attachment" {
  const ext = extensionOf(nameOrPath);
  return ext !== null && Object.hasOwn(INLINE_CONTENT_TYPES, ext) ? "inline" : "attachment";
}
