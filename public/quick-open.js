/**
 * クイックオープンの候補検索 (Issue #54)。
 *
 * DOM に触れない純粋関数として app.js から切り出し、bun test から直接テストする
 * (new-file.js / navigation.js と同じ方針)。
 *
 * ## 母集団は「クライアントが持っているツリー」だけ
 *
 * 検索対象は `/api/tree` で受け取った結果そのもの。**除外設定 (`.yomiignore` /
 * `DEFAULT_EXCLUDES`) と `--depth` はサーバ側で既に適用済み**なので、クライアントは
 * 何も判定しなくてよい —— ツリーに無いものは候補にも出ない。判定を二重に持つと
 * 必ず片方が古くなる。
 *
 * ## 絞り込みは「部分列マッチ」
 *
 * `abc` が `a...b...c` の順で現れれば一致とする (いわゆる fuzzy)。エディタの
 * クイックオープンで慣れている挙動で、`dsg` → `docs/design.md` のように
 * 途中を飛ばして打てる。**大文字小文字は無視**する。
 */

/**
 * ツリーからファイルの相対パスを document order で集める。
 *
 * ディレクトリは候補にしない (開く対象ではないため)。
 *
 * @param {{ type: string, path: string, children?: unknown[] }} node
 * @returns {string[]}
 */
export function collectFilePaths(node) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.type === "file") {
      out.push(n.path);
      return;
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);
  return out;
}

/** パスからファイル名部分を取り出す。 */
function baseName(path) {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * `query` の各文字が `text` にこの順で現れるか (部分列マッチ)。
 *
 * 一致したときは**マッチした位置の配列**も返す。呼び出し側がハイライトに使う。
 *
 * @param {string} text
 * @param {string} query 小文字化済みであること
 * @returns {number[] | null} マッチ位置。不一致は null
 */
function subsequenceMatch(text, query) {
  const lower = text.toLowerCase();
  const positions = [];
  let at = 0;
  for (const ch of query) {
    const found = lower.indexOf(ch, at);
    if (found === -1) return null;
    positions.push(found);
    at = found + 1;
  }
  return positions;
}

/**
 * 候補の並び順を決めるスコア。**小さいほど上**。
 *
 * 優先順:
 * 1. **ファイル名にマッチしたものが上**。`guide` と打った人は
 *    `docs/guide.md` を探しているのであって `guide-images/photo.md` ではない
 * 2. **マッチが密なものが上**。`abc` に対して `abc.md` は `a-b-c.md` より上
 * 3. **前方に寄っているものが上**
 * 4. **パスが短いものが上**。同じくらい一致するなら浅い場所を先に出す
 *
 * @param {string} path
 * @param {number[]} positions パス全体でのマッチ位置
 * @param {number[] | null} namePositions ファイル名部分でのマッチ位置 (無ければ null)
 * @returns {number}
 */
function score(path, positions, namePositions) {
  const inName = namePositions !== null;
  const used = inName ? namePositions : positions;
  const first = used[0] ?? 0;
  const last = used[used.length - 1] ?? 0;
  // マッチが広がっているほど (= 途中を飛ばしているほど) 大きくなる
  const spread = last - first - (used.length - 1);
  return (inName ? 0 : 10_000) + spread * 100 + first * 10 + path.length / 1000;
}

/**
 * クイックオープンの候補を返す。
 *
 * - `query` が空なら**全件を document order で**返す (開いた直後に一覧が出る)
 * - 一致は部分列マッチ。大文字小文字は無視
 * - 同名ファイルは相対パスで区別できるよう、常にパス全体を返す
 *
 * @param {string[]} paths 母集団 (ツリーのファイル相対パス)
 * @param {string} query 入力文字列
 * @param {number} [limit] 返す最大件数
 * @returns {{ path: string, positions: number[] }[]} positions はパス全体での
 *   マッチ位置 (ハイライト用)。query が空なら空配列
 */
export function searchPaths(paths, query, limit = 50) {
  const q = query.trim().toLowerCase();
  if (!q) return paths.slice(0, limit).map((path) => ({ path, positions: [] }));

  const hits = [];
  for (const path of paths) {
    const positions = subsequenceMatch(path, q);
    if (positions === null) continue;
    const name = baseName(path);
    const namePositions = subsequenceMatch(name, q);
    // ファイル名側の位置はパス全体の座標へ寄せる (ハイライトはパス全体に対して行う)
    const offset = path.length - name.length;
    hits.push({
      path,
      positions: namePositions ? namePositions.map((p) => p + offset) : positions,
      _score: score(path, positions, namePositions),
    });
  }
  // **安定した順序にする。** スコアが同じなら辞書順にして、同じ入力で毎回同じ並びにする
  hits.sort((a, b) => a._score - b._score || a.path.localeCompare(b.path));
  return hits.slice(0, limit).map(({ path, positions }) => ({ path, positions }));
}

/**
 * 候補リスト内の選択位置を移動する (循環する)。
 *
 * 一覧の端で止まると「もう 1 回押したのに動かない」という無反応に見えるので、
 * 上端から上へ押したら末尾、下端から下へ押したら先頭へ回す。
 *
 * @param {number} current 現在の index
 * @param {number} delta -1 (上) または 1 (下)
 * @param {number} total 候補数
 * @returns {number} 移動後の index。候補が無ければ -1
 */
export function moveSelection(current, delta, total) {
  if (total <= 0) return -1;
  const next = current + delta;
  if (next < 0) return total - 1;
  if (next >= total) return 0;
  return next;
}
