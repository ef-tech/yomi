import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isMarkdownPath,
  resolveSafe,
  UnsafePathError,
} from "../src/safepath.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "yomi-safepath-"));
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "a.md"), "# A");
  await writeFile(join(root, "sub", "b.md"), "# B");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("isMarkdownPath (re-export)", () => {
  test("md / markdown / mdx を許可", () => {
    expect(isMarkdownPath("a.md")).toBe(true);
    expect(isMarkdownPath("a.markdown")).toBe(true);
    expect(isMarkdownPath("a.mdx")).toBe(true);
  });
  test("非 Markdown を拒否", () => {
    expect(isMarkdownPath("a.txt")).toBe(false);
    expect(isMarkdownPath("a")).toBe(false);
  });
});

describe("resolveSafe", () => {
  test("ルート直下のファイルを解決", async () => {
    const r = await resolveSafe(root, "a.md");
    expect(r.rel).toBe("a.md");
    expect(r.abs).toContain(root);
    expect(r.abs.endsWith("a.md")).toBe(true);
  });

  test("サブディレクトリのファイルを解決", async () => {
    const r = await resolveSafe(root, "sub/b.md");
    expect(r.rel).toBe("sub/b.md");
    expect(r.abs.endsWith("sub/b.md")).toBe(true);
  });

  test("空パスは UnsafePathError", async () => {
    await expect(resolveSafe(root, "")).rejects.toThrow(UnsafePathError);
    await expect(resolveSafe(root, "")).rejects.toThrow(/path が空/);
  });

  test("絶対パスは拒否", async () => {
    await expect(resolveSafe(root, "/etc/passwd")).rejects.toThrow(
      /絶対パス/,
    );
  });

  test("親ディレクトリ参照 (..) は拒否", async () => {
    await expect(resolveSafe(root, "../a.md")).rejects.toThrow(/\.\./);
    await expect(resolveSafe(root, "sub/../../etc")).rejects.toThrow(
      /\.\./,
    );
    await expect(resolveSafe(root, "sub/..")).rejects.toThrow(/\.\./);
  });

  test("UnsafePathError は requestedPath プロパティを持つ", async () => {
    try {
      await resolveSafe(root, "../x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafePathError);
      expect((err as UnsafePathError).requestedPath).toBe("../x");
    }
  });

  test("存在しないファイルでも resolveSafe 自体は成功 (実在チェックは別)", async () => {
    const r = await resolveSafe(root, "missing.md");
    expect(r.rel).toBe("missing.md");
    // realpath が失敗しても safeRealpath は resolve(p) で fallback するので例外なし
  });
});
