/**
 * ツリーのデータへ、追加・削除を 1 件だけ適用する (Issue #126)。
 *
 * ## なぜ要るか
 *
 * これまでは `tree` 通知を受けるたびに `/api/tree` を全量取り直し、10,500 ノードを
 * 突き合わせていた（10,000 ファイルで 1 イベント 18ms。`docs/bench/tree-diff-update.md`）。
 * **1 件の追加・削除しか起きていないのに、全ノードを見る**のが効かない理由なので、
 * サーバから「どこが」「どう」変わったかを受け取り、**その 1 か所だけ**を動かす。
 *
 * ## サーバの走査規則をここで再現する
 *
 * 手元のツリーが `/api/tree` の結果と 1 バイトでも食い違うと、そこから先ずっとずれる。
 * `src/scanner.ts` が作る形に合わせる規則は 2 つ:
 *
 * - **並び順**: ディレクトリが先、その中で名前順 (`localeCompare`)
 * - **空のディレクトリは残さない**（`pruneEmpty`）。最後の md を消したら、その
 *   ディレクトリも消える。連鎖して上まで畳む
 *
 * **渡される木が既にこの並びであることを前提にする。** 挿入位置は前から走査して
 * 「自分より後ろになる最初の要素」の手前に入れる決め方なので、**整列していない
 * 子リストへ入れると位置がずれる**。土台は必ず `/api/tree`（＝`scanMarkdownTree` の
 * 出力）なので本番では成り立つが、テストの fixture を手書きするときは要注意。
 *
 * **`--depth` 指定時はサーバが差分を送らない**ので、深さ境界の扱い（中を見ていない
 * ディレクトリは空でも残す）はここで考えなくてよい（`src/server.ts` の `canSendTreeDiff`）。
 *
 * ## 監視されているのは md ファイルだけ
 *
 * `src/watcher.ts` は `add` / `unlink` を md 拡張子に絞って通知する（ディレクトリ自体の
 * 作成・削除は購読していない）。**追加されるのは常にファイル**で、途中のディレクトリは
 * その巻き添えで生えるだけ。
 */

/** @typedef {import("./api-types.js").TreeNode} TreeNode */

/**
 * 子の並び順。**`src/scanner.ts` の `sortTree` と同じ規則**にすること。
 *
 * @param {TreeNode} a
 * @param {TreeNode} b
 * @returns {number}
 */
function compareNodes(a, b) {
  if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * 子リストを取り出す。**無ければ空配列を張ってから返す。**
 *
 * `children` は省略可能（ファイルは持たない）なので、足す側は必ずここを通す。
 *
 * @param {TreeNode} node
 * @returns {TreeNode[]}
 */
function childrenOf(node) {
  if (!node.children) node.children = [];
  return node.children;
}

/**
 * 並びを保ったまま挿入する位置を返す。
 *
 * 線形に探す。**ディレクトリ 1 つあたりの子はふつう数十件**で、二分探索にする価値が無い
 * （10,000 ファイルのベンチでも 1 ディレクトリあたり十数件）。
 *
 * @param {TreeNode[]} children
 * @param {TreeNode} node
 * @returns {number}
 */
function insertionIndex(children, node) {
  let i = 0;
  while (i < children.length && compareNodes(/** @type {TreeNode} */ (children[i]), node) < 0) i++;
  return i;
}

/**
 * 差分を適用した結果。
 *
 * @typedef {{
 *   ok: boolean,
 *   dirtyPath: string | null,
 * }} TreeDiffResult
 */

/**
 * `ok`: 手元のツリーがサーバと同じ状態になったか。**`false` なら全量へ逃げる**。
 * `dirtyPath`: 子リストが変わったディレクトリの path（`""` はルート）。
 *   **`null` は「変える必要が無かった」**（既にその状態）で、描き直しも要らない。
 *
 * ## 「既にその状態」を成功として扱う理由
 *
 * 手抜きではなく、**これが無いと収束しない**。`/api/tree` の走査は await を挟むので、
 * その最中に起きた変更が**結果に入っていることも入っていないこともある**。サーバは
 * 走査を始めた時点の版を名乗る (`src/server.ts`) ので、クライアントは
 * **既に反映済みの差分をもう一度当てる**ことがある。
 *
 * 各操作を「**在るようにする / 無いようにする**」（冪等）と定義しておけば、
 * どの時点のスナップショットから積み直しても最終状態は同じになる。ここを
 * `ok: false` にすると、その競合のたびに全量を取り直すことになる。
 */

/**
 * ファイルを 1 件足す。
 *
 * 途中のディレクトリが無ければ作る。**変わるのは 1 つの `children` 配列だけ** ——
 * 足りない階層は繋いだ塊にしてから、いちばん深い既存ディレクトリへ差し込む。
 * 呼び出し側はそこだけ描き直せばよい。
 *
 * @param {TreeNode} root
 * @param {string} path root からの相対パス（`/` 区切り）
 * @returns {TreeDiffResult}
 */
export function addPath(root, path) {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return { ok: false, dirtyPath: null };

  let dir = root;
  let acc = "";
  // 最後のセグメント（ファイル名）の手前まで降りる
  for (let i = 0; i < segments.length - 1; i++) {
    acc = acc ? `${acc}/${segments[i]}` : /** @type {string} */ (segments[i]);
    const children = childrenOf(dir);
    const found = children.find((c) => c.path === acc);
    if (found) {
      // **ファイルとディレクトリが入れ替わっている。** 手元が壊れているので全量へ逃げる
      if (found.type !== "dir") return { ok: false, dirtyPath: null };
      dir = found;
      continue;
    }
    // ここから下は全部無い。繋いだ塊を作って 1 回で差し込む
    const chain = buildDirChain(segments, i, path);
    const idx = insertionIndex(children, chain);
    children.splice(idx, 0, chain);
    return { ok: true, dirtyPath: dir.path };
  }

  const children = childrenOf(dir);
  const name = /** @type {string} */ (segments[segments.length - 1]);
  const existing = children.find((c) => c.path === path);
  if (existing) {
    // **既にある。** ディレクトリと入れ替わっているなら手元が壊れている
    if (existing.type !== "file") return { ok: false, dirtyPath: null };
    // 同じ状態なので描き直す必要が無い（サーバとずれてもいない）
    return { ok: true, dirtyPath: null };
  }
  /** @type {TreeNode} */
  const node = { name, path, type: "file" };
  children.splice(insertionIndex(children, node), 0, node);
  return { ok: true, dirtyPath: dir.path };
}

/**
 * `segments[from]` 以降のディレクトリと、末尾のファイルを繋いだ塊を作る。
 *
 * @param {string[]} segments
 * @param {number} from
 * @param {string} filePath
 * @returns {TreeNode}
 */
function buildDirChain(segments, from, filePath) {
  const prefix = segments.slice(0, from).join("/");
  let acc = prefix;
  /** @type {TreeNode | null} */
  let head = null;
  /** @type {TreeNode | null} */
  let tail = null;
  for (let i = from; i < segments.length - 1; i++) {
    acc = acc ? `${acc}/${segments[i]}` : /** @type {string} */ (segments[i]);
    /** @type {TreeNode} */
    const dirNode = {
      name: /** @type {string} */ (segments[i]),
      path: acc,
      type: "dir",
      children: [],
    };
    if (tail) tail.children = [dirNode];
    else head = dirNode;
    tail = dirNode;
  }
  /** @type {TreeNode} */
  const file = {
    name: /** @type {string} */ (segments[segments.length - 1]),
    path: filePath,
    type: "file",
  };
  if (tail) {
    tail.children = [file];
    return /** @type {TreeNode} */ (head);
  }
  return file;
}

/**
 * ファイルを 1 件消す。**空になったディレクトリは上へ畳む**（`pruneEmpty` と同じ）。
 *
 * @param {TreeNode} root
 * @param {string} path
 * @returns {TreeDiffResult}
 */
export function removePath(root, path) {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return { ok: false, dirtyPath: null };

  // ルートから対象までの経路を控える。**畳むときに上へ戻る必要がある**
  /** @type {TreeNode[]} */
  const chain = [root];
  let dir = root;
  let acc = "";
  for (let i = 0; i < segments.length - 1; i++) {
    acc = acc ? `${acc}/${segments[i]}` : /** @type {string} */ (segments[i]);
    const found = (dir.children ?? []).find((c) => c.path === acc);
    // **無いなら既に消えている。** サーバと同じ状態なので、描き直しも全量取り直しも要らない
    if (!found || found.type !== "dir") return { ok: true, dirtyPath: null };
    chain.push(found);
    dir = found;
  }

  const children = dir.children ?? [];
  const idx = children.findIndex((c) => c.path === path && c.type === "file");
  if (idx < 0) return { ok: true, dirtyPath: null };
  children.splice(idx, 1);

  // 空になったディレクトリを上へ畳む。**ルートは残す**（`pruneEmpty` と同じ）
  let dirtyIndex = chain.length - 1;
  while (dirtyIndex > 0) {
    const node = /** @type {TreeNode} */ (chain[dirtyIndex]);
    if ((node.children ?? []).length > 0) break;
    const parent = /** @type {TreeNode} */ (chain[dirtyIndex - 1]);
    const kids = parent.children ?? [];
    const at = kids.findIndex((c) => c === node);
    if (at >= 0) kids.splice(at, 1);
    dirtyIndex--;
  }
  return { ok: true, dirtyPath: /** @type {TreeNode} */ (chain[dirtyIndex]).path };
}

/**
 * 差分を 1 件適用する。
 *
 * @param {TreeNode} root
 * @param {"add" | "remove"} op
 * @param {string} path
 * @returns {TreeDiffResult}
 */
export function applyTreeDiff(root, op, path) {
  // **`..` を含むパスは受け取らない。** サーバ由来とはいえ、手元のツリーを
  // 壊しうる形は入口で落とす（`path` は root 相対の `/` 区切りである約束）
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    return { ok: false, dirtyPath: null };
  }
  return op === "add" ? addPath(root, path) : removePath(root, path);
}
