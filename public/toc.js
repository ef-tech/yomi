/**
 * 平坦な heading 配列を階層付きの TOC ツリーに変換する。
 *
 * @param {Array<{level:number, text:string, id:string}>} headings
 * @param {number} [maxLevel=6]
 * @returns {Array<{level:number, text:string, id:string, children:Array}>}
 *
 * - `maxLevel`: 含めるレベル上限 (3 なら H1-H3、H4 以下は除外)
 * - 階層スキップ (H1 直後に H3) は、直近の浅いノードの子として配置
 * - 親不在 (先頭が H3 等) は root に並ぶ
 */
export function buildTocTree(headings, maxLevel = 6) {
  const roots = [];
  const stack = [];

  for (const h of headings) {
    if (h.level > maxLevel) continue;
    const node = { ...h, children: [] };

    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }

    stack.push(node);
  }

  return roots;
}
