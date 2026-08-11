/**
 * `mermaid.js` は bundle された生成物なので `tsc` に読ませない (Issue #79)。
 * **型は本体パッケージのものを再輸出する** —— 手書きすると本体の更新に追随できない。
 * `mermaid` は devDependencies にあり、実行時は使わない (bundle を配る)。
 */
export { default } from "mermaid";
