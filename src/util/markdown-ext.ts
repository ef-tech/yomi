/** 認識する Markdown の拡張子 (大文字小文字を区別しない) */
export const MD_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".markdown", ".mdx"]);

/** 与えられたファイル名・パスが Markdown 拡張子で終わるかを判定 */
export function isMarkdownExtension(nameOrPath: string): boolean {
  const dot = nameOrPath.lastIndexOf(".");
  if (dot < 0) return false;
  return MD_EXTENSIONS.has(nameOrPath.slice(dot).toLowerCase());
}
