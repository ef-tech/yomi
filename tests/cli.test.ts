import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DOWN_OPTIONS,
  DEFAULT_LIST_OPTIONS,
  DEFAULT_OPTIONS,
  parseArgs,
  parseCommand,
  parseDownArgs,
  parseListArgs,
  shouldOpenBrowser,
} from "../src/cli.ts";

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
    test("デフォルトは 127.0.0.1 (自端末のみ, Issue #51)", () => {
      expect(parseArgs([]).host).toBe("127.0.0.1");
      expect(DEFAULT_OPTIONS.host).toBe("127.0.0.1");
    });

    test("--host addr 形式", () => {
      expect(parseArgs(["--host", "127.0.0.1"]).host).toBe("127.0.0.1");
    });

    test("--host=addr 形式", () => {
      expect(parseArgs(["--host=192.168.1.10"]).host).toBe("192.168.1.10");
    });

    test("--host 0.0.0.0 の明示指定は後方互換で許可 (Issue #51)", () => {
      expect(parseArgs(["--host", "0.0.0.0"]).host).toBe("0.0.0.0");
      expect(parseArgs(["--host=0.0.0.0"]).host).toBe("0.0.0.0");
    });

    test("値がないとエラー", () => {
      expect(() => parseArgs(["--host"])).toThrow("--host には値が必要です");
    });
  });

  describe("--share (Issue #51)", () => {
    test("--share で host が 0.0.0.0 になる", () => {
      expect(parseArgs(["--share"]).host).toBe("0.0.0.0");
    });

    test("--share を付けなければ既定は loopback のまま", () => {
      expect(parseArgs([]).host).toBe("127.0.0.1");
    });

    test("--share と --host の同時指定はエラー (指定順に依存しない)", () => {
      expect(() => parseArgs(["--share", "--host", "127.0.0.1"])).toThrow(
        /--share と --host は同時に指定できません/,
      );
      expect(() => parseArgs(["--host", "127.0.0.1", "--share"])).toThrow(
        /--share と --host は同時に指定できません/,
      );
      expect(() => parseArgs(["--share", "--host=0.0.0.0"])).toThrow(
        /--share と --host は同時に指定できません/,
      );
    });

    test("他オプションとは併用可", () => {
      const opts = parseArgs(["--share", "--port", "8080", "--no-open"]);
      expect(opts.host).toBe("0.0.0.0");
      expect(opts.port).toBe(8080);
      expect(opts.open).toBe(false);
    });
  });

  describe("値トークンの堅牢化 (Issue #51)", () => {
    test("--host の直後に別オプションが来たら値エラー (--share を値として飲み込み排他を迂回しない)", () => {
      // `--host --share` で --share が host 値に消費されると host="--share" となり
      // 排他検証を素通りしてしまう。値エラーで fail-fast にする。
      expect(() => parseArgs(["--host", "--share"])).toThrow("--host には値が必要です");
      expect(() => parseArgs(["--host", "--port", "8080"])).toThrow("--host には値が必要です");
    });

    test("--host= / --host '' の空値はエラー (空 bind による LAN 露出を防ぐ)", () => {
      // 空 host は全インターフェース bind = 無認証 API の LAN 露出につながる footgun。
      expect(() => parseArgs(["--host="])).toThrow("--host には値が必要です");
      expect(() => parseArgs(["--host", ""])).toThrow("--host には値が必要です");
    });

    test("単一ダッシュの負数値は従来どおり各 parser の範囲エラーになる", () => {
      // "-1" は値として通し、port/depth の範囲検証に委ねる (値エラーにしない)。
      expect(() => parseArgs(["--port", "-1"])).toThrow(/1〜65535/);
      expect(() => parseArgs(["--depth", "-1"])).toThrow(/1 以上の整数/);
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

    test("16 進 / 指数 / 符号付き / 空白は 10 進整数でないため拒否", () => {
      // Number() は黙って受理してしまうが parseDepth は 10 進整数表記のみ許可
      expect(() => parseArgs(["--depth", "0x10"])).toThrow(/1 以上の整数/);
      expect(() => parseArgs(["--depth", "1e3"])).toThrow(/1 以上の整数/);
      expect(() => parseArgs(["--depth", "+2"])).toThrow(/1 以上の整数/);
      expect(() => parseArgs(["--depth", "2.0"])).toThrow(/1 以上の整数/);
      expect(() => parseArgs(["--depth", " 2"])).toThrow(/1 以上の整数/);
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

  describe("-d / --detach (Issue #68)", () => {
    test("既定は false", () => {
      expect(parseArgs([]).detach).toBe(false);
    });

    test("-d / --detach で true", () => {
      expect(parseArgs(["-d"]).detach).toBe(true);
      expect(parseArgs(["--detach"]).detach).toBe(true);
    });

    test("他オプションと併用できる", () => {
      const opts = parseArgs(["-d", "--port", "8080", "--share", "-L", "2"]);
      expect(opts.detach).toBe(true);
      expect(opts.port).toBe(8080);
      expect(opts.host).toBe("0.0.0.0");
      expect(opts.depth).toBe(2);
    });
  });

  describe("--open (Issue #68)", () => {
    test("未指定なら open: true だが明示扱いにはしない", () => {
      expect(parseArgs([]).open).toBe(true);
      expect(parseArgs([]).openExplicit).toBe(false);
    });

    test("--open / --no-open は明示指定として記録される", () => {
      expect(parseArgs(["--open"])).toMatchObject({ open: true, openExplicit: true });
      expect(parseArgs(["--no-open"])).toMatchObject({ open: false, openExplicit: true });
    });
  });
});

describe("shouldOpenBrowser (Issue #68)", () => {
  test("フォアグラウンドは既定で開く", () => {
    expect(shouldOpenBrowser(parseArgs([]))).toBe(true);
  });

  test("フォアグラウンドで --no-open なら開かない", () => {
    expect(shouldOpenBrowser(parseArgs(["--no-open"]))).toBe(false);
  });

  test("-d は既定で開かない (ターミナルを離れる操作なのでタブを増やさない)", () => {
    expect(shouldOpenBrowser(parseArgs(["-d"]))).toBe(false);
  });

  test("-d でも --open を明示すれば開く", () => {
    expect(shouldOpenBrowser(parseArgs(["-d", "--open"]))).toBe(true);
  });

  test("-d --no-open は当然開かない", () => {
    expect(shouldOpenBrowser(parseArgs(["-d", "--no-open"]))).toBe(false);
  });
});

describe("parseCommand (Issue #68)", () => {
  test("引数なしは up (従来どおりカレントディレクトリを開く)", () => {
    expect(parseCommand([])).toEqual({ name: "up", options: { ...DEFAULT_OPTIONS } });
  });

  test("先頭がオプションなら up として従来の引数をそのまま解釈する (後方互換)", () => {
    const parsed = parseCommand(["--port", "8080", "--no-open"]);
    expect(parsed.name).toBe("up");
    expect(parsed.options).toMatchObject({ port: 8080, open: false });
  });

  test("up サブコマンドは残りをオプションとして解釈する", () => {
    const parsed = parseCommand(["up", "-d", "--port", "8080"]);
    expect(parsed.name).toBe("up");
    expect(parsed.options).toMatchObject({ detach: true, port: 8080 });
  });

  test("down サブコマンドは down のオプションを解釈する", () => {
    const parsed = parseCommand(["down", "--all"]);
    expect(parsed).toEqual({ name: "down", options: { ...DEFAULT_DOWN_OPTIONS, all: true } });
  });

  test("list サブコマンド (Issue #69)", () => {
    expect(parseCommand(["list"])).toEqual({
      name: "list",
      options: { ...DEFAULT_LIST_OPTIONS },
    });
  });

  test("未知のサブコマンドはエラー (オプションの打ち間違いと区別する)", () => {
    expect(() => parseCommand(["bogus"])).toThrow(/不明なサブコマンド: bogus/);
    expect(() => parseCommand(["Up"])).toThrow(/不明なサブコマンド: Up/);
  });

  test("--help はどのコマンドでも受け付ける", () => {
    expect(parseCommand(["--help"]).options.help).toBe(true);
    expect(parseCommand(["up", "--help"]).options.help).toBe(true);
    expect(parseCommand(["down", "-h"]).options.help).toBe(true);
    expect(parseCommand(["list", "--help"]).options.help).toBe(true);
  });
});

describe("parseListArgs (Issue #69)", () => {
  test("既定は help: false のみ", () => {
    expect(parseListArgs([])).toEqual({ ...DEFAULT_LIST_OPTIONS });
  });

  test("--help / -h", () => {
    expect(parseListArgs(["--help"]).help).toBe(true);
    expect(parseListArgs(["-h"]).help).toBe(true);
  });

  test("他コマンドのオプションは受け付けない (list は絞り込みを持たない)", () => {
    expect(() => parseListArgs(["--all"])).toThrow(/不明なオプション/);
    expect(() => parseListArgs(["--port", "3939"])).toThrow(/不明なオプション/);
    expect(() => parseListArgs(["-d"])).toThrow(/不明なオプション/);
  });

  test("DEFAULT_LIST_OPTIONS は変更されない (immutable check)", () => {
    const before = { ...DEFAULT_LIST_OPTIONS };
    parseListArgs(["--help"]);
    expect(DEFAULT_LIST_OPTIONS).toEqual(before);
  });
});

describe("parseDownArgs (Issue #68)", () => {
  test("既定はカレントディレクトリ対象 (all: false, port: null)", () => {
    expect(parseDownArgs([])).toEqual({ ...DEFAULT_DOWN_OPTIONS });
  });

  test("--all", () => {
    expect(parseDownArgs(["--all"]).all).toBe(true);
  });

  test("--port N / --port=N", () => {
    expect(parseDownArgs(["--port", "3939"]).port).toBe(3939);
    expect(parseDownArgs(["--port=3939"]).port).toBe(3939);
  });

  test("--port の値の検証は up と同じ", () => {
    expect(() => parseDownArgs(["--port"])).toThrow("--port には値が必要です");
    expect(() => parseDownArgs(["--port", "0"])).toThrow(/1〜65535/);
  });

  test("--all と --port の同時指定はエラー (対象が二重に決まる)", () => {
    expect(() => parseDownArgs(["--all", "--port", "3939"])).toThrow(/同時に指定できません/);
    expect(() => parseDownArgs(["--port", "3939", "--all"])).toThrow(/同時に指定できません/);
  });

  test("up 専用のオプションは受け付けない", () => {
    expect(() => parseDownArgs(["--share"])).toThrow(/不明なオプション/);
    expect(() => parseDownArgs(["-d"])).toThrow(/不明なオプション/);
  });

  test("DEFAULT_DOWN_OPTIONS は変更されない (immutable check)", () => {
    const before = { ...DEFAULT_DOWN_OPTIONS };
    parseDownArgs(["--all"]);
    expect(DEFAULT_DOWN_OPTIONS).toEqual(before);
  });
});
