import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const YOMIIGNORE_FILENAME = ".yomiignore";

/**
 * `.yomiignore` の中身を Set にパースする。
 *
 * 書式 (現在は単純なディレクトリ/ファイル名のみ対応、グロブは未対応):
 * - 1 行 1 パターン
 * - 先頭が `#` の行はコメント、空行は無視
 * - 前後の空白はトリム
 *
 * 将来的にグロブを足すなら `**`, `*`, `?` などを判別して別経路に流す。
 */
export function parseYomiignore(text: string): Set<string> {
  const result = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    result.add(trimmed);
  }
  return result;
}

/**
 * 指定ディレクトリ直下の `.yomiignore` を読み込んで Set を返す。
 * ファイルが存在しない、読めない場合は空 Set。
 */
export async function loadYomiignore(rootDir: string): Promise<Set<string>> {
  try {
    const text = await readFile(join(rootDir, YOMIIGNORE_FILENAME), "utf-8");
    return parseYomiignore(text);
  } catch {
    return new Set<string>();
  }
}
