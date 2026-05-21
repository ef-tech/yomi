/**
 * `/api/asset` 経由で配信できる拡張子 → MIME マッピング。
 *
 * 画像 (IMAGE_CONTENT_TYPES) に加え、ブラウザがネイティブで表示できる
 * 添付ファイル系を許可する。Issue #37: md 内 `[X](foo.pdf)` を別タブで
 * 開くため PDF を追加。PDF は Content-Disposition: inline で配信され、
 * Chrome 等の内蔵 PDF ビューアでそのまま閲覧できる。
 */
import { IMAGE_CONTENT_TYPES } from "./image-ext.ts";

export const ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ...IMAGE_CONTENT_TYPES,
  ".pdf": "application/pdf",
};

export function isAssetExtension(nameOrPath: string): boolean {
  const dot = nameOrPath.lastIndexOf(".");
  if (dot < 0) return false;
  return nameOrPath.slice(dot).toLowerCase() in ASSET_CONTENT_TYPES;
}

export function assetContentType(nameOrPath: string): string | null {
  const dot = nameOrPath.lastIndexOf(".");
  if (dot < 0) return null;
  return ASSET_CONTENT_TYPES[nameOrPath.slice(dot).toLowerCase()] ?? null;
}
