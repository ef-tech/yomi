import { describe, expect, test } from "bun:test";
import { DEFAULT_EXCLUDES, isExcludedPath } from "../../src/util/excludes.ts";

describe("DEFAULT_EXCLUDES", () => {
  test("代表的な無視ディレクトリを含む", () => {
    expect(DEFAULT_EXCLUDES.has("node_modules")).toBe(true);
    expect(DEFAULT_EXCLUDES.has(".git")).toBe(true);
    expect(DEFAULT_EXCLUDES.has("dist")).toBe(true);
    expect(DEFAULT_EXCLUDES.has(".vscode")).toBe(true);
  });

  test("通常のファイル名は含まない", () => {
    expect(DEFAULT_EXCLUDES.has("src")).toBe(false);
    expect(DEFAULT_EXCLUDES.has("README.md")).toBe(false);
  });
});

describe("isExcludedPath", () => {
  test("単一の除外名にマッチ", () => {
    expect(isExcludedPath("node_modules")).toBe(true);
    expect(isExcludedPath(".git")).toBe(true);
  });

  test("中間セグメントの除外名にマッチ", () => {
    expect(isExcludedPath("a/node_modules/b.md")).toBe(true);
    expect(isExcludedPath("project/.git/HEAD")).toBe(true);
    expect(isExcludedPath("x/dist/y/z.md")).toBe(true);
  });

  test("除外名を含まないパスは false", () => {
    expect(isExcludedPath("src/index.ts")).toBe(false);
    expect(isExcludedPath("a/b/c.md")).toBe(false);
    expect(isExcludedPath("README.md")).toBe(false);
  });

  test("除外名の部分一致は false (完全一致のみ)", () => {
    // "node_modules2" は "node_modules" と完全一致しない
    expect(isExcludedPath("node_modules2/x.md")).toBe(false);
    expect(isExcludedPath("anode_modules/x.md")).toBe(false);
  });

  test("カスタム excludes を渡せる", () => {
    const custom = new Set(["secret", "private"]);
    expect(isExcludedPath("a/secret/x", custom)).toBe(true);
    expect(isExcludedPath("a/node_modules/x", custom)).toBe(false);
  });

  test("空文字パスは false", () => {
    expect(isExcludedPath("")).toBe(false);
  });
});
