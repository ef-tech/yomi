/** スキャン・監視で無視するディレクトリ名 (再帰的に該当する全要素を除外) */
export const DEFAULT_EXCLUDES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  ".nyc_output",
  "vendor",
  ".bun",
  ".turbo",
  ".vercel",
  ".idea",
  ".vscode",
]);

/**
 * 与えられた相対パスのいずれかのセグメントが excludes に含まれていれば true。
 * 単一名 (例: "node_modules") にも複数セグメント (例: "a/.git/HEAD") にも対応。
 */
export function isExcludedPath(
  relOrName: string,
  excludes: ReadonlySet<string> = DEFAULT_EXCLUDES,
): boolean {
  return relOrName.split("/").some((seg) => excludes.has(seg));
}
