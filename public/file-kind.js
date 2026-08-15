/**
 * クライアント側でファイルの種別を見分ける (Issue #155)。
 *
 * ツリーには Markdown とテキストが並ぶようになったので、**アイコンを出し分けるために
 * 描画時点で種別が要る**。サーバは `/api/tree` のノードに種別を載せていない —— 10,000
 * ノード規模で 1 ノードあたり数バイトが効いてくる経路 (Issue #84 / #126 が削ってきた
 * ところ) なので、名前から引けるものを転送しない。
 *
 * **判定できるのは「Markdown かどうか」だけ**で十分。ツリーに載っている時点で
 * サーバの allowlist を通っているので、**Markdown でなければテキスト**になる
 * （クライアントがテキストの allowlist を持つ必要はない = `src/util/text-ext.ts` の
 * 写しを作らずに済む）。
 *
 * 開いた後の種別は**サーバの応答の `kind`** が正本（`state.currentKind`）。こちらは
 * 描画のための先読みで、判断の最終根拠ではない。
 */

/** クライアント側で受け入れる Markdown 拡張子 (サーバの MD_EXTENSIONS と同値) */
/** @type {ReadonlySet<string>} */
export const MD_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);

/**
 * ファイル名・パスが Markdown 拡張子で終わるか (`src/util/markdown-ext.ts` と同じ判定)。
 *
 * @param {string} nameOrPath
 * @returns {boolean}
 */
export function isMarkdownName(nameOrPath) {
  const dot = nameOrPath.lastIndexOf(".");
  if (dot < 0) return false;
  return MD_EXTENSIONS.has(nameOrPath.slice(dot).toLowerCase());
}
