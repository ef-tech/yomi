/**
 * API がエラー応答に載せる `code` の一覧 (Issue #99)。
 *
 * ## なぜ型にするか
 *
 * クライアントは `code` を翻訳キーへ引き当てる（`public/i18n.js` の `ERROR_CODE_KEYS`）。
 * **サーバとクライアントで別々に書いていたので、片方だけ足して気づかない事故が起きた** ——
 * Issue #101 が `write_failed` を返すようにしたのに対応表へ入れ忘れ、英語表示でも
 * 日本語の文言が出ていた。
 *
 * ここを唯一の出所にして、
 *
 * - **サーバ側**は `ErrorCode` 型で受けるので、綴り間違いと未定義の code が `tsc` で落ちる
 * - **クライアント側**との一致は `tests/error-codes.test.ts` が型レベルで突き合わせる
 *
 * ソースを正規表現で拾う形も試したが、**`forbidden(message, code)` のように位置引数で
 * 渡している箇所を取りこぼす**（実際 `origin_forbidden` が漏れていた）。
 */
export const ERROR_CODES = [
  "invalid_json",
  "path_required",
  "not_found",
  "not_markdown",
  // Issue #155: ツリーに載らない拡張子を `/api/file` で開こうとした（読み取りのみ）。
  // `not_markdown` と分けるのは、**書き込み/作成は今も Markdown 限定**だから ——
  // 同じ code にすると「読めないのか書けないのか」が文言から分からなくなる。
  "not_viewable",
  "file_too_large",
  "unsafe_path",
  "excluded_dir",
  "excluded_path",
  "already_exists",
  "parent_missing",
  "create_failed",
  "write_failed",
  "read_failed",
  "asset_failed",
  "zip_failed",
  "zip_busy",
  "tree_failed",
  "internal_error",
  "body_too_large",
  "origin_forbidden",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
