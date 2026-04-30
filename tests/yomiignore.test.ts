import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadYomiignore, parseYomiignore, YOMIIGNORE_FILENAME } from "../src/yomiignore.ts";

describe("parseYomiignore", () => {
  test("空文字なら空 Set", () => {
    expect(parseYomiignore("")).toEqual(new Set());
  });

  test("シンプルな名前を抽出", () => {
    const set = parseYomiignore("private\nbackup\n.archive");
    expect(set).toEqual(new Set(["private", "backup", ".archive"]));
  });

  test("空行・コメント (#) はスキップ", () => {
    const set = parseYomiignore("# コメント\nprivate\n\n# 別のコメント\nbackup\n");
    expect(set).toEqual(new Set(["private", "backup"]));
  });

  test("前後の空白はトリム", () => {
    const set = parseYomiignore("  private  \n\tbackup\t");
    expect(set).toEqual(new Set(["private", "backup"]));
  });

  test("CRLF 改行に対応", () => {
    const set = parseYomiignore("a\r\nb\r\nc");
    expect(set).toEqual(new Set(["a", "b", "c"]));
  });

  test("重複は Set で 1 件に", () => {
    const set = parseYomiignore("dup\ndup\ndup");
    expect(set).toEqual(new Set(["dup"]));
    expect(set.size).toBe(1);
  });
});

describe("loadYomiignore", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-yomiignore-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test(".yomiignore が無ければ空 Set", async () => {
    const set = await loadYomiignore(root);
    expect(set).toEqual(new Set());
  });

  test(".yomiignore があればパースして返す", async () => {
    await writeFile(join(root, YOMIIGNORE_FILENAME), "# 個人メモ\nprivate\nbackup\n");
    const set = await loadYomiignore(root);
    expect(set).toEqual(new Set(["private", "backup"]));
  });

  test("読み取り失敗時 (パーミッション等) は空 Set でフォールバック", async () => {
    // 実際の権限テストは難しいので、存在しないディレクトリで代用
    const set = await loadYomiignore(join(root, "nonexistent-subdir"));
    expect(set).toEqual(new Set());
  });
});
