/** 配信を許可する画像の拡張子と MIME マッピング (大文字小文字を区別しない) */
export const IMAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

/** 与えられたファイル名・パスが画像拡張子で終わるかを判定 */
export function isImageExtension(nameOrPath: string): boolean {
  const dot = nameOrPath.lastIndexOf(".");
  if (dot < 0) return false;
  return nameOrPath.slice(dot).toLowerCase() in IMAGE_CONTENT_TYPES;
}

/** 拡張子から Content-Type を返す。許可されていない拡張子は null。 */
export function imageContentType(nameOrPath: string): string | null {
  const dot = nameOrPath.lastIndexOf(".");
  if (dot < 0) return null;
  return IMAGE_CONTENT_TYPES[nameOrPath.slice(dot).toLowerCase()] ?? null;
}
