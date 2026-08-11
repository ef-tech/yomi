/**
 * 平坦な heading 配列を階層付きの TOC ツリーに変換する。
 *
 * @typedef {{ level: number, text: string, id: string }} Heading
 * @typedef {Heading & { children: TocNode[] }} TocNode
 *
 * @param {Heading[]} headings
 * @param {number} [maxLevel=6]
 * @returns {TocNode[]}
 *
 * - `maxLevel`: 含めるレベル上限 (3 なら H1-H3、H4 以下は除外)
 * - 階層スキップ (H1 直後に H3) は、直近の浅いノードの子として配置
 * - 親不在 (先頭が H3 等) は root に並ぶ
 */
export function buildTocTree(headings, maxLevel = 6) {
  /** @type {TocNode[]} */
  const roots = [];
  /** @type {TocNode[]} */
  const stack = [];

  for (const h of headings) {
    if (h.level > maxLevel) continue;
    /** @type {TocNode} */
    const node = { ...h, children: [] };

    // `noUncheckedIndexedAccess` により添字アクセスは undefined を含む。
    // 長さを見てから引いているので実際には存在するが、変数に受けて型でも示す。
    while (true) {
      const top = stack[stack.length - 1];
      if (!top || top.level < h.level) break;
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);

    stack.push(node);
  }

  return roots;
}
