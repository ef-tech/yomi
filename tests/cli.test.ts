import { describe, expect, test } from "bun:test";
import { DEFAULT_OPTIONS, parseArgs } from "../src/cli.ts";

describe("parseArgs", () => {
  test("引数なしならデフォルト", () => {
    expect(parseArgs([])).toEqual({ ...DEFAULT_OPTIONS });
  });

  describe("--help / -h", () => {
    test("--help で help: true", () => {
      expect(parseArgs(["--help"]).help).toBe(true);
    });
    test("-h で help: true", () => {
      expect(parseArgs(["-h"]).help).toBe(true);
    });
  });

  describe("--no-open", () => {
    test("open: false に切替", () => {
      expect(parseArgs(["--no-open"]).open).toBe(false);
    });
    test("引数なしならデフォルト true", () => {
      expect(parseArgs([]).open).toBe(true);
    });
  });

  describe("--port (--port N 形式)", () => {
    test("正常値", () => {
      expect(parseArgs(["--port", "8080"]).port).toBe(8080);
      expect(parseArgs(["--port", "1"]).port).toBe(1);
      expect(parseArgs(["--port", "65535"]).port).toBe(65535);
    });

    test("値がないとエラー", () => {
      expect(() => parseArgs(["--port"])).toThrow("--port には値が必要です");
    });

    test("0 や 65536 など範囲外でエラー", () => {
      expect(() => parseArgs(["--port", "0"])).toThrow(/1〜65535/);
      expect(() => parseArgs(["--port", "65536"])).toThrow(/1〜65535/);
      expect(() => parseArgs(["--port", "-1"])).toThrow(/1〜65535/);
    });

    test("非整数でエラー", () => {
      expect(() => parseArgs(["--port", "abc"])).toThrow(/1〜65535/);
      expect(() => parseArgs(["--port", "3.14"])).toThrow(/1〜65535/);
    });
  });

  describe("--port=N 形式", () => {
    test("正常値", () => {
      expect(parseArgs(["--port=8080"]).port).toBe(8080);
    });

    test("範囲外でエラー", () => {
      expect(() => parseArgs(["--port=0"])).toThrow(/1〜65535/);
    });
  });

  describe("--host", () => {
    test("--host addr 形式", () => {
      expect(parseArgs(["--host", "127.0.0.1"]).host).toBe("127.0.0.1");
    });

    test("--host=addr 形式", () => {
      expect(parseArgs(["--host=192.168.1.10"]).host).toBe("192.168.1.10");
    });

    test("値がないとエラー", () => {
      expect(() => parseArgs(["--host"])).toThrow("--host には値が必要です");
    });
  });

  describe("--depth / -L (Issue #44)", () => {
    test("デフォルトは null (無制限)", () => {
      expect(parseArgs([]).depth).toBeNull();
    });

    test("--depth N 形式", () => {
      expect(parseArgs(["--depth", "1"]).depth).toBe(1);
      expect(parseArgs(["--depth", "3"]).depth).toBe(3);
    });

    test("--depth=N 形式", () => {
      expect(parseArgs(["--depth=2"]).depth).toBe(2);
    });

    test("-L は --depth のエイリアス", () => {
      expect(parseArgs(["-L", "2"]).depth).toBe(2);
      expect(parseArgs(["-L", "2"]).depth).toBe(parseArgs(["--depth", "2"]).depth);
    });

    test("値がないとエラー", () => {
      expect(() => parseArgs(["--depth"])).toThrow("--depth には値が必要です");
      expect(() => parseArgs(["-L"])).toThrow("-L には値が必要です");
    });

    test("0 / 負数 / 非整数はエラー", () => {
      expect(() => parseArgs(["--depth", "0"])).toThrow(/1 以上の整数/);
      expect(() => parseArgs(["--depth", "-1"])).toThrow(/1 以上の整数/);
      expect(() => parseArgs(["--depth", "abc"])).toThrow(/1 以上の整数/);
      expect(() => parseArgs(["--depth", "2.5"])).toThrow(/1 以上の整数/);
    });
  });

  describe("複合", () => {
    test("複数オプションを組み合わせ", () => {
      const opts = parseArgs(["--port", "3000", "--host=127.0.0.1", "--no-open", "-L", "2"]);
      expect(opts.port).toBe(3000);
      expect(opts.host).toBe("127.0.0.1");
      expect(opts.open).toBe(false);
      expect(opts.help).toBe(false);
      expect(opts.depth).toBe(2);
    });
  });

  describe("不明オプション", () => {
    test("--foo はエラー", () => {
      expect(() => parseArgs(["--foo"])).toThrow(/不明なオプション/);
    });

    test("--unknown=value もエラー", () => {
      expect(() => parseArgs(["--unknown=value"])).toThrow(/不明なオプション/);
    });
  });

  test("DEFAULT_OPTIONS は変更されない (immutable check)", () => {
    const before = { ...DEFAULT_OPTIONS };
    parseArgs(["--port", "9999", "--host=x", "--no-open"]);
    expect(DEFAULT_OPTIONS).toEqual(before);
  });
});
