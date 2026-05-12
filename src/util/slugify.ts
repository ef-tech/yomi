/**
 * 見出しテキストから HTML id / URL fragment に使える slug を生成する。
 *
 * 方針:
 * - 英数字は小文字化 + 連続空白を単一ハイフンに
 * - 日本語などの非 ASCII は基本そのまま残す (GitHub README の anchor 同様)
 * - 記号類は除去 (HTML id として safe にする)
 * - 結果が空になる場合は空文字を返す。呼び出し側で `section-N` 等の fallback 推奨
 */
export function slugify(text: string): string {
  if (!text) return "";
  return (
    text
      .trim()
      .toLowerCase()
      // 記号類を除去 (ASCII の英数字、Unicode の文字/数字、空白とハイフンを残す)
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      // 連続空白/ハイフンを単一ハイフンに
      .replace(/[\s-]+/g, "-")
      // 先頭末尾のハイフンを除去
      .replace(/^-+|-+$/g, "")
  );
}

/**
 * 同一 slug の衝突を解消する。
 * 初回はそのまま、N 回目は `id-(N-1)` を返す。
 * 呼び出し側で `usedSet` を保持して状態管理する想定。
 */
export function uniqueSlug(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 1;
  while (used.has(`${base}-${n}`)) n++;
  const result = `${base}-${n}`;
  used.add(result);
  return result;
}
