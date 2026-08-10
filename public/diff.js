/**
 * 保存競合の行差分 (Issue #57)。
 *
 * DOM に触れない純粋関数として切り出し、bun test から直接テストする
 * (quick-open.js / new-file.js / navigation.js と同じ方針)。
 *
 * ## なぜ行単位か
 *
 * 競合の場面で人が答えたいのは「**どちらを残すか**」であって、文字単位のどこが違うかでは
 * ない。Markdown は行が意味の単位 (見出し・箇条書き・段落) なので、行で見せれば
 * 「この段落を足したのは自分だ」と判断できる。文字単位の差分はノイズが増えて逆に読みにくい。
 *
 * ## 自動マージはしない
 *
 * 3-way merge は「共通祖先」が要るが、yomi のクライアントは保存に失敗した時点で
 * 祖先 (= 編集を始めたときのサーバ内容) を保持していない。中途半端にマージすると
 * **どちらでもない第三の内容**ができてしまうので、初期スコープでは比較だけを提供する。
 *
 * ## 大きな文書では諦める
 *
 * 差分計算は最悪 O(n*m) なので、上限を超えたら**計算せずに諦める** (`truncated`)。
 * 呼び出し側は差分表示を省略して従来の 2 択にフォールバックする。
 * 固まった画面を見せるくらいなら、差分が無いほうがましという判断。
 */

/** 差分を計算する上限 (トリム後の行数)。これを超えたら諦める。 */
export const MAX_DIFF_LINES = 2000;

/** 差分を計算する上限 (トリム後・片側のバイト数)。長い 1 行だけのファイルを弾く。 */
export const MAX_DIFF_BYTES = 512 * 1024;

/**
 * トリムする前に諦める倍率。
 *
 * 上限判定はトリム後に行うが (そうしないと「長い文書の 1 行直し」まで諦める)、
 * **行に割る前の文字列操作すら重い大きさ**はここで落とす。桁を分けてあるので、
 * 通常の文書がこの保険に引っかかることはない。
 */
const HARD_BYTE_FACTOR = 64;

/**
 * テキストを行に割る。
 *
 * 末尾の改行で空行が 1 つ増えるのは**意図どおり** —— 「末尾に改行があるか」は
 * 実際の差分なので、消してしまうと画面に出せなくなる。
 *
 * @param {string} text
 * @returns {string[]}
 */
function toLines(text) {
  // CRLF / CR は LF に寄せる。改行コードの違いだけで全行が差分になるのを避ける
  return text.replace(/\r\n?/g, "\n").split("\n");
}

/** UTF-8 でのバイト数。 */
function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * 2 つの行配列の LCS (最長共通部分列) の長さ表を作り、後ろから辿って差分を組み立てる。
 *
 * **共通の先頭・末尾を削ってから呼ぶ**こと (この関数は素朴な O(n*m))。
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {{ type: "equal" | "del" | "add", text: string }[]}
 */
function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  // (n+1) x (m+1) の DP。行ごとに Int32Array を持つ (数値配列より密で速い)
  const table = [];
  for (let i = 0; i <= n; i++) table.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i];
    const next = table[i + 1];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "equal", text: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

/**
 * 行差分を作る。
 *
 * `del` は**左 (ローカル) にしかない行**、`add` は**右 (サーバ) にしかない行**。
 * 「変更」は `del` + `add` の並びとして表現する (行単位なので変更と置換を区別しない)。
 *
 * @param {string} localText ローカルの編集内容
 * @param {string} serverText サーバの最新内容
 * @param {{ maxLines?: number, maxBytes?: number }} [options]
 * @returns {{
 *   rows: { type: "equal" | "del" | "add", text: string, leftNo: number | null, rightNo: number | null }[],
 *   truncated: boolean,
 *   reason: "lines" | "bytes" | null,
 *   stats: { added: number, removed: number },
 * }} `truncated` なら `rows` は空。呼び出し側は差分表示を省く
 */
export function diffLines(localText, serverText, options = {}) {
  const maxLines = options.maxLines ?? MAX_DIFF_LINES;
  const maxBytes = options.maxBytes ?? MAX_DIFF_BYTES;

  // **行にすら割れない大きさだけ、ここで落とす。** 上限そのものはトリム後に見るので、
  // ここは「文字列操作で固まらせない」ためだけの保険。桁を分けてある
  if (
    byteLength(localText) > maxBytes * HARD_BYTE_FACTOR ||
    byteLength(serverText) > maxBytes * HARD_BYTE_FACTOR
  ) {
    return { rows: [], truncated: true, reason: "bytes", stats: { added: 0, removed: 0 } };
  }

  const left = toLines(localText);
  const right = toLines(serverText);

  // **共通の先頭・末尾を先に削る。** 実際の競合は「一部の段落だけ違う」ことが多いので、
  // これだけで DP に渡る行数が桁で減る (前後が全部同じなら 0 行になる)
  let head = 0;
  while (head < left.length && head < right.length && left[head] === right[head]) head++;
  let tail = 0;
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) {
    tail++;
  }

  const midLeft = left.slice(head, left.length - tail);
  const midRight = right.slice(head, right.length - tail);

  // **上限は「トリムした後に残った量」で見る。** ここが実際に DP へ渡る部分で、
  // 計算量を決めるのもここ。文書全体の大きさで判断すると、**長い文書の 1 行直し**
  // (比較対象は 1 行 vs 1 行) まで諦めることになる。
  //
  // バイト数も同じ理由でトリム後に見る。「巨大な 1 行」はトリムで消えずに
  // 1 行 vs 1 行として残るので、ここで確実に捕まる。
  if (midLeft.length > maxLines || midRight.length > maxLines) {
    return { rows: [], truncated: true, reason: "lines", stats: { added: 0, removed: 0 } };
  }
  if (byteLength(midLeft.join("\n")) > maxBytes || byteLength(midRight.join("\n")) > maxBytes) {
    return { rows: [], truncated: true, reason: "bytes", stats: { added: 0, removed: 0 } };
  }

  const parts = [
    ...left.slice(0, head).map((text) => ({ type: "equal", text })),
    ...lcsDiff(midLeft, midRight),
    ...left.slice(left.length - tail).map((text) => ({ type: "equal", text })),
  ];

  // 行番号を振る。equal は両側、del は左だけ、add は右だけ
  const rows = [];
  let leftNo = 0;
  let rightNo = 0;
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    if (part.type === "equal") {
      leftNo++;
      rightNo++;
      rows.push({ type: "equal", text: part.text, leftNo, rightNo });
    } else if (part.type === "del") {
      leftNo++;
      removed++;
      rows.push({ type: "del", text: part.text, leftNo, rightNo: null });
    } else {
      rightNo++;
      added++;
      rows.push({ type: "add", text: part.text, leftNo: null, rightNo });
    }
  }

  return { rows, truncated: false, reason: null, stats: { added, removed } };
}

/**
 * 差分の前後だけを残して、離れた `equal` の連なりを畳む。
 *
 * 数百行の同一部分をそのまま出すと、**変わった箇所を探すのに縦スクロールが要る**。
 * git の `--unified=N` と同じ考え方で、変更の周り `context` 行だけを残す。
 *
 * @param {ReturnType<typeof diffLines>["rows"]} rows
 * @param {number} [context] 変更の前後に残す行数
 * @returns {({ type: "equal" | "del" | "add", text: string, leftNo: number | null, rightNo: number | null }
 *   | { type: "skip", count: number })[]} 畳んだ部分は `{ type: "skip", count }` になる
 */
export function collapseUnchanged(rows, context = 3) {
  // 残す行に印を付ける (変更行そのものと、その前後 context 行)。
  // **変更行は context に関わらず必ず残す** —— 負値を渡されると内側のループが
  // 1 度も回らず、変更行まで畳まれて「差分が無い」ように見えてしまう
  const span = Math.max(0, context);
  const keep = new Array(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type === "equal") continue;
    keep[i] = true;
    for (let j = Math.max(0, i - span); j <= Math.min(rows.length - 1, i + span); j++) {
      keep[j] = true;
    }
  }

  const out = [];
  let skipped = 0;
  const flushSkip = () => {
    if (skipped > 0) {
      out.push({ type: "skip", count: skipped });
      skipped = 0;
    }
  };
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      flushSkip();
      out.push(rows[i]);
    } else {
      skipped++;
    }
  }
  flushSkip();
  return out;
}
