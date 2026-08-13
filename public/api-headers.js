/**
 * サーバと取り決めた HTTP ヘッダ名。
 *
 * **依存を持たない。** ここを `app-context.js` に置くと、名前を 1 つ読みたいだけの
 * テストが DOMPurify と i18n まで評価することになる（`tests/mermaid-secure.test.ts` が
 * dompurify の評価順で壊れる件 —— Issue #133 —— に触れる）。
 */

/**
 * `/api/tree` が返すツリーの版 (Issue #126)。
 *
 * **`src/server.ts` の `TREE_GEN_HEADER` と同じ文字列でなければならない。** 片方だけ
 * 変えると、クライアントは版を読めず「知らない」に倒れて**差分を 1 件も当てなくなる**
 * —— 表示は正しいまま遅くなるだけなので気づけない。`tests/tree-notify.test.ts` が
 * 両者の一致を検査している。
 */
export const TREE_GEN_HEADER = "X-Yomi-Tree-Gen";
