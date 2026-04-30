import { describe, expect, test } from "bun:test";
import { sep } from "node:path";
import { toPosix } from "../../src/util/path-util.ts";

describe("toPosix", () => {
  test("既に POSIX 形式ならそのまま返す", () => {
    expect(toPosix("a/b/c.md")).toBe("a/b/c.md");
    expect(toPosix("file.md")).toBe("file.md");
    expect(toPosix("")).toBe("");
  });

  if (sep === "\\") {
    test("Windows 区切りを / に変換 (sep === '\\\\' のときのみ実行)", () => {
      expect(toPosix("a\\b\\c.md")).toBe("a/b/c.md");
    });
  } else {
    test("POSIX 環境ではバックスラッシュは保持 (パス区切りではないため)", () => {
      expect(toPosix("a\\b")).toBe("a\\b");
    });
  }
});
