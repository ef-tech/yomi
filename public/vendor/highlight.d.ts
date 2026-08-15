/**
 * `highlight.js` は bundle された生成物なので `tsc` に読ませない (Issue #79 / #155)。
 * **型は本体パッケージのものを再輸出する** —— 手書きすると本体の更新に追随できない。
 * `highlight.js` は devDependencies にあり、実行時は使わない (bundle を配る)。
 *
 * 実体は `highlight.js/lib/core` に言語を登録したもの (`scripts/vendor/highlight.js`) なので、
 * 型もそちらから取る。
 */
export { default } from "highlight.js/lib/core";
