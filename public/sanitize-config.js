/**
 * プレビュー HTML の DOMPurify サニタイズ設定 (Issue #21 / #59)。
 *
 * ブラウザから直接 import される (yomi はビルドステップなしの哲学)。
 * bun test からも import 可能 (.js モジュール)。DOMPurify の実行には DOM が要るため、
 * ここでは設定オブジェクトだけを切り出し、設定内容を tests/sanitize-config.test.ts で検証する。
 *
 * marked 出力の標準 HTML + GFM 拡張 (table / task list / code) + Mermaid 用
 * `<pre class="mermaid">` を保持しつつ、悪意ある md に含まれ得る:
 *   - <script> / <object> / <iframe> / <embed> / <frame> 系
 *   - inline event handler (onerror / onload / onclick 等)
 *   - <a href="javascript:..."> / <a href="vbscript:..."> 等の危険スキーム
 *   - <svg> 内の <script> や <foreignObject> 経由の script
 *   - <style> タグ / style 属性経由の CSS インジェクション (Issue #59)
 * を除去する。
 *
 * Issue #59: DOMPurify の html profile は既定で `<style>` タグと `style` 属性を許可するため、
 * 悪意ある md が文書全体へ CSS を注入でき、属性セレクタ + `background: url(...)` で
 * ファイルパス等の推測・外部送信 (CSS exfiltration) が可能だった。両者を除去する。
 * marked の table alignment は `align` 属性を使う (`style` ではない) ため配置は壊れない。
 * コードブロックは CSS class で色付けし inline style を使わない。Mermaid 図は sanitize 後に
 * `mermaid.run()` が SVG を生成する (再 sanitize しない) ため図中の style も影響を受けない。
 */
export const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  ADD_ATTR: ["target", "rel"],
  // data-* 属性 (data-task-index 等) は DOMPurify デフォルトで保持。
  // ただし data-i18n* は禁止する (Issue #48): プレビュー内の md に紛れ込むと
  // applyI18n(document) が言語切替時にその要素の textContent/属性を辞書値で
  // 上書きしてしまうため、i18n 機構がユーザーコンテンツに漏れないようにする。
  // style 属性は禁止する (Issue #59): CSS インジェクション (exfiltration) を防ぐ。
  FORBID_ATTR: [
    "data-i18n",
    "data-i18n-title",
    "data-i18n-aria-label",
    "data-i18n-placeholder",
    "style",
  ],
  // <style> タグは禁止する (Issue #59): 文書全体へ作用する CSS 注入を防ぐ。
  FORBID_TAGS: ["style"],
};
