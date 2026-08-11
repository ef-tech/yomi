import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isMarkdownPath, resolveSafe, UnsafePathError } from "../src/safepath.ts";

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
    await expect(resolveSafe(root, "/etc/passwd")).rejects.toThrow(/絶対パス/);
  });

  test("親ディレクトリ参照 (..) は拒否", async () => {
    await expect(resolveSafe(root, "../a.md")).rejects.toThrow(/\.\./);
    await expect(resolveSafe(root, "sub/../../etc")).rejects.toThrow(/\.\./);
    await expect(resolveSafe(root, "sub/..")).rejects.toThrow(/\.\./);
  });

  test("NUL byte 入りパスは拒否 (内部例外メッセージ漏れ防止)", async () => {
    await expect(resolveSafe(root, "a\0.md")).rejects.toThrow(/NUL/);
    await expect(resolveSafe(root, "sub/\0evil")).rejects.toThrow(/NUL/);
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

/**
 * **`..` で始まるだけの正当な名前 (Issue #118)。**
 *
 * `rel.startsWith("..")` でルート外を判定していたので、`..cache` のような
 * **通常のエントリ名**にも当たり、root 内の正当なパスが `UnsafePathError`（400）になっていた。
 * 同じ関数の 15 行下は元から `parentRel === ".." || parentRel.startsWith(`..${sep}`)` と
 * 正しく書けており、**1 ファイル内で作法が割れていた**。
 *
 * **受理範囲が広がる変更**（セキュリティ境界に触れる）なので、
 * **ルート外参照が本当に弾かれ続けること**を同じ describe で固定する。
 */
describe("`..` で始まるだけの名前 (Issue #118)", () => {
  let dotRoot: string;
  let outside: string;

  beforeAll(async () => {
    dotRoot = await mkdtemp(join(tmpdir(), "yomi-dotdot-"));
    outside = await mkdtemp(join(tmpdir(), "yomi-dotdot-out-"));
    await writeFile(join(outside, "outside.md"), "# 外");

    await mkdir(join(dotRoot, "..cache"), { recursive: true });
    await mkdir(join(dotRoot, "..a", "..b"), { recursive: true });
    await mkdir(join(dotRoot, "normal"), { recursive: true });
    await writeFile(join(dotRoot, "..cache", "x.md"), "# キャッシュ内");
    await writeFile(join(dotRoot, "..a", "..b", "z.md"), "# 深い");
    await writeFile(join(dotRoot, "normal", "y.md"), "# 普通");
    await writeFile(join(dotRoot, "...md"), "# 三点");

    // **root 外へ出る symlink。** 受理範囲を広げても、これが通ってはいけない
    await symlink(outside, join(dotRoot, "..link"));
    await symlink(join(outside, "outside.md"), join(dotRoot, "..cache", "escape.md"));
    // **root の親そのものを指す symlink。** これだけが `rel === ".."` ちょうどになる経路
    await symlink(dirname(dotRoot), join(dotRoot, "..up"));
  });

  afterAll(async () => {
    await rm(dotRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  test.each([
    ["..cache/x.md", "..cache/x.md"],
    ["..cache", "..cache"],
    ["..a/..b/z.md", "..a/..b/z.md"],
    ["normal/y.md", "normal/y.md"],
    ["...md", "...md"],
  ])("`%s` は root 内の正当なパスとして解決する", async (requested, rel) => {
    const r = await resolveSafe(dotRoot, requested);
    expect(r.rel).toBe(rel);
  });

  // **ここが本体。** 受理範囲を広げたので、親参照が緩んでいないことを同時に固定する
  test.each([
    ["../outside.md"],
    [".."],
    ["../"],
    ["../../etc/passwd"],
    ["a/../normal/y.md"],
    ["..cache/../normal/y.md"],
    ["/etc/passwd"],
    // symlink で root の外へ出る経路（`..` で始まる名前でも塞がったまま）
    ["..link/outside.md"],
    ["..cache/escape.md"],
    // **root の親ちょうど**を指す symlink（`rel === ".."` になる唯一の経路）
    ["..up"],
  ])("`%s` は従来どおり拒否する", async (requested) => {
    await expect(resolveSafe(dotRoot, requested)).rejects.toBeInstanceOf(UnsafePathError);
  });

  /**
   * **まだ存在しないファイルは別の関門が守る。**
   *
   * leaf が無いと realpath は解決できず lexical fallback するので、
   * `relative()` の結果は `..link/new.md` —— **`../` で始まらないので 1 つ目の判定を通る**。
   * ここを止めているのは**親ディレクトリの realpath チェック**のほう。
   *
   * `..` で始まる名前を受理するようになったぶん、この経路に到達しやすくなった
   * （新規作成 `POST /api/file/create` がまさにこれを通る）。
   */
  test.each([
    ["..link/new.md"],
    ["..link/sub/new.md"],
  ])("存在しないファイルでも、symlink で root の外へは出られない (`%s`)", async (requested) => {
    await expect(resolveSafe(dotRoot, requested)).rejects.toThrow(/ルートディレクトリの外/);
  });

  test("root 内なら、存在しないファイルも解決できる（新規作成の経路）", async () => {
    const r = await resolveSafe(dotRoot, "..cache/new.md");
    expect(r.rel).toBe("..cache/new.md");
  });
});
