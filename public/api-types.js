/**
 * サーバ API の応答の型 (Issue #79)。
 *
 * **型だけのモジュール。** 実行時の値を何も持たないので、ブラウザは読み込まない
 * (`import` されるのは JSDoc の `import("./api-types.js").X` の形だけ)。
 *
 * ## なぜ 1 箇所に置くか
 *
 * ツリーのノード型が `app-document.js` / `app-tree.js` / `quick-open.js` で
 * **別々に 3 回定義され、しかも形が食い違っていた** (`name` が必須だったり
 * optional だったり無かったり)。応答の形はサーバが決めるので、写しを増やすほど
 * 実態からずれる。
 *
 * ## `src/` 側との対応
 *
 * `TreeNode` は `src/scanner.ts` の同名 interface と同じ形にすること。
 * **一致は `tests/api-types.test.ts` が型レベルで検証する** —— どちらかを変えたら
 * 落ちるので、片方だけ直して気づかない事故を防げる。
 */

/**
 * `/api/tree` が返すノード。**`src/scanner.ts` の `TreeNode` と同じ形。**
 *
 * @typedef {{
 *   name: string,
 *   path: string,
 *   type: "file" | "dir",
 *   children?: TreeNode[],
 * }} TreeNode
 */

/**
 * ツリーを**走査する**のに要る最小の形。
 *
 * `name` を読まない関数（クイックオープンの候補集めなど）はこちらを受ける。
 * 完全な `TreeNode` はこの形を満たすので、実物をそのまま渡せる。**必要以上を
 * 要求しない**ことで、テストの fixture が実物と同じ大きさになるのを避けられる。
 *
 * @typedef {{ type: "file" | "dir", path: string, children?: TreeNodeLike[] }} TreeNodeLike
 */

/**
 * `GET /api/file` と `POST /api/file` の 200 応答。
 *
 * @typedef {{
 *   path: string,
 *   raw: string,
 *   html: string,
 *   sha: string,
 * }} FileResponse
 */

/**
 * `POST /api/file` の 409 (競合) 応答。
 *
 * **`raw` は null になりうる。** 保存しようとした間にサーバ側でファイルが消えていると、
 * `src/server.ts` は `currentRaw`（= null）をそのまま載せる。`app-editor.js` の
 * 「サーバ側で消えている」分岐がこれを見ている。
 *
 * @typedef {{
 *   error: string,
 *   path: string,
 *   raw: string | null,
 *   html: string,
 *   sha: string | null,
 * }} ConflictPayload
 */

// 型だけのモジュールでも ES module として扱わせる (これが無いとグローバルスクリプト扱いになる)
export {};
