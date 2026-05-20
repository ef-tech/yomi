/**
 * split mode で source / preview ペインのスクロール位置を同期するための純関数群。
 * ブラウザから直接 import される (yomi はビルドステップなしの哲学)。
 * bun test からも import 可能 (.js モジュール)。
 *
 * 設計方針:
 * - DOM 読み書きは呼び出し側 (app.js) の責務
 * - このモジュールは座標と pair から target Y を線形補間する純関数のみ提供
 * - 見出し行検出はソーステキスト解析の純関数として提供 (jsdom 不要でテスト可能)
 */

/**
 * Markdown ソーステキストから見出し行の番号 (1-indexed) を抽出する。
 * フェンス内 (` ``` ... ``` ` や ` ~~~ ... ~~~ ` ) の "## " は見出しとして扱わない。
 *
 * @param {string} sourceText - markdown ソース全体 (frontmatter 込み)
 * @returns {number[]} 見出し行番号の配列 (1-indexed、現れた順)
 */
export function findHeadingLines(sourceText) {
  if (typeof sourceText !== "string") return [];
  const lines = sourceText.split("\n");
  const result = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^#{1,6}\s/.test(line)) {
      result.push(i + 1);
    }
  }
  return result;
}

/**
 * 同期 pair から、入力軸 scrollTop に対応する出力軸 Y 座標を線形補間する。
 *
 * pair は `{ from: number, to: number }` の配列で、`from` 昇順前提。
 *
 * - pair が空: scrollTop をそのまま返す (同期不能、独立スクロール)
 * - scrollTop が最初の pair より小さい: 0 ↔ pair[0] の間で比例計算
 * - scrollTop が最後の pair より大きい: 末尾 pair の `to` で打ち止め
 * - それ以外: 隣接 2 pair 間で線形補間
 *
 * @param {number} scrollTop
 * @param {Array<{from: number, to: number}>} pairs - from 昇順
 * @returns {number} 対応する出力 Y
 */
export function mapScrollTop(scrollTop, pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return scrollTop;
  const first = pairs[0];
  const last = pairs[pairs.length - 1];

  if (scrollTop <= first.from) {
    if (first.from <= 0) return first.to;
    const ratio = Math.max(0, scrollTop) / first.from;
    return first.to * ratio;
  }
  if (scrollTop >= last.from) {
    return last.to;
  }
  for (let i = 0; i < pairs.length - 1; i++) {
    const a = pairs[i];
    const b = pairs[i + 1];
    if (scrollTop >= a.from && scrollTop < b.from) {
      const span = b.from - a.from;
      if (span === 0) return a.to;
      const ratio = (scrollTop - a.from) / span;
      return a.to + ratio * (b.to - a.to);
    }
  }
  return scrollTop;
}
