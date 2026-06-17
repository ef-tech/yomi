/**
 * 新規 Markdown ファイル作成 (Issue #6) の入力補完ロジック。
 *
 * DOM に触れない純粋関数として app.js から切り出し、bun test から
 * 直接テストする (tree-toolbar.js / navigation.js と同じ方針)。
 * サーバ側の最終検証 (resolveSafe / 拡張子 / 除外判定) とは独立した
 * クライアント側の入力整形であり、セキュリティ境界はサーバが持つ。
 */

/** クライアント側で受け入れる Markdown 拡張子 (サーバの MD_EXTENSIONS と同値) */
export const MD_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);

/**
 * インライン入力されたファイル名を Markdown ファイル名に補完する。
 *
 * - 前後の空白は trim
 * - 空 / "." / ".." / パス区切り (\/) を含む名前は不正として null
 * - 許可拡張子 (.md / .markdown / .mdx、大文字小文字無視) で終わればそのまま
 * - それ以外は ".md" を付与 ("foo" → "foo.md", "foo.v2" → "foo.v2.md")
 *
 * @param {string} input ユーザー入力
 * @returns {string | null} 補完済みファイル名。不正入力は null
 */
export function completeMarkdownFileName(input) {
  const name = input.trim();
  if (!name || name === "." || name === "..") return null;
  if (/[\\/]/.test(name)) return null;
  const dot = name.lastIndexOf(".");
  // dot === 0 は ".md" のような拡張子だけの名前 → ベース名がないので補完対象
  if (dot > 0 && MD_EXTENSIONS.has(name.slice(dot).toLowerCase())) {
    return name;
  }
  return `${name}.md`;
}

/**
 * ディレクトリ path とファイル名を結合してツリー相対 path を作る。
 *
 * @param {string} dirPath 親ディレクトリの相対 path ("" はルート)
 * @param {string} fileName ファイル名
 * @returns {string}
 */
export function joinTreePath(dirPath, fileName) {
  return dirPath ? `${dirPath}/${fileName}` : fileName;
}
