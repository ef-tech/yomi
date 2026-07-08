/**
 * Mermaid の secure 設定 (Issue #59)。
 *
 * ブラウザから直接 import される (yomi はビルドステップなしの哲学)。bun test からも import 可能。
 *
 * `mermaid.initialize({ secure })` に渡すと、init directive (`%%{init: {...}}%%`) から
 * 上書きできない設定キーを固定できる。`securityLevel: "strict"` の既定 secure リストは
 * themeCSS / fontFamily などの CSS 系キーを保護しないため、悪意ある Markdown が themeCSS を
 * directive で注入でき、mermaid.run() が sanitize 後に生成する SVG の `<style>` に任意 CSS が
 * 入る (インライン SVG の `<style>` は文書全体へ作用) → CSS exfiltration が成立していた。
 *
 * 既定 secure (mermaid 11.x: secure/securityLevel/startOnLoad/maxTextSize/
 * suppressErrorRendering/maxEdges) に CSS を注入し得るキー (themeCSS/fontFamily/
 * altFontFamily) を加える。yomi は theme のみを渡し themeCSS 等を直接使わないため、
 * これらを secure にしても正当な描画は壊れない (mermaid 内部のテーマ適用は initialize 側の
 * 設定であり directive 制限の対象外)。
 */
export const MERMAID_SECURE_KEYS = [
  // mermaid 11.x の既定 secure リスト
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  // Issue #59: CSS を注入し得るキーを directive から保護する
  "themeCSS",
  "fontFamily",
  "altFontFamily",
];
