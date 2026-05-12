/**
 * GFM タスクリスト (`- [ ] xxx` / `- [x] xxx`) の純関数操作。
 * ブラウザから直接 import される (yomi はビルドステップなしの哲学)。
 * bun test からも import 可能 (.js モジュール)。
 */

/** 行頭インデント + bullet + `[ ]` または `[x]` */
const TASK_LINE_RE = /^(\s*[-*+]\s+)\[([ xX])\](.*)$/;

/** code fence の開始/終了マーカー (``` または ~~~) */
const FENCE_RE = /^(\s*)(```+|~~~+)\s*(.*)?$/;

/**
 * body 内の N 番目 (0-indexed) のタスクリスト行をトグルする。
 *
 * - index 範囲外、type 不正、対象なしの場合: body 不変、newChecked: null
 * - code fence (``` または ~~~) 内のタスク風文字列は無視
 * - インデント (ネスト) はそのまま保持
 * - `[X]` (大文字) も off にできる
 *
 * 戻り値: { body, newChecked }
 *   body: トグル後の本文 (失敗時は元の body)
 *   newChecked: トグル後の状態 (true = checked, false = unchecked, null = 該当なし)
 */
export function toggleTaskInMarkdown(body, index) {
  if (typeof body !== "string") return { body: "", newChecked: null };
  if (!Number.isInteger(index) || index < 0) return { body, newChecked: null };

  const lines = body.split("\n");
  let taskNo = 0;
  let inFence = false;
  /** @type {string | null} */
  let fenceMarker = null;
  let newChecked = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // fence boundary detect
    const fm = line.match(FENCE_RE);
    if (fm) {
      const marker = fm[2];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
        continue;
      }
      // 閉じは「同じ種類で同等以上の長さ」(GFM 仕様)
      if (fenceMarker && marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length) {
        inFence = false;
        fenceMarker = null;
        continue;
      }
    }
    if (inFence) continue;

    const m = line.match(TASK_LINE_RE);
    if (!m) continue;

    if (taskNo === index) {
      const checked = m[2].toLowerCase() === "x";
      newChecked = !checked;
      lines[i] = `${m[1]}[${newChecked ? "x" : " "}]${m[3]}`;
      return { body: lines.join("\n"), newChecked };
    }
    taskNo++;
  }

  return { body, newChecked: null };
}

/**
 * body 内のタスクリスト行の総数を返す (code fence 内は除外、document order)。
 * テスト/UI 用のヘルパ。
 */
export function countTasksInMarkdown(body) {
  if (typeof body !== "string") return 0;
  const lines = body.split("\n");
  let n = 0;
  let inFence = false;
  let fenceMarker = null;
  for (const line of lines) {
    const fm = line.match(FENCE_RE);
    if (fm) {
      const marker = fm[2];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
        continue;
      }
      if (fenceMarker && marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length) {
        inFence = false;
        fenceMarker = null;
        continue;
      }
    }
    if (inFence) continue;
    if (TASK_LINE_RE.test(line)) n++;
  }
  return n;
}
