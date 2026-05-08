import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { openEditor, resolveEditorCommand, splitCommand } from "../src/open-editor.ts";

describe("splitCommand", () => {
  test("単一コマンド", () => {
    expect(splitCommand("code")).toEqual(["code"]);
  });

  test("引数あり", () => {
    expect(splitCommand("code --wait")).toEqual(["code", "--wait"]);
  });

  test("複数の空白を圧縮", () => {
    expect(splitCommand("  code   --wait  ")).toEqual(["code", "--wait"]);
  });

  test("空文字なら空配列", () => {
    expect(splitCommand("")).toEqual([]);
    expect(splitCommand("   ")).toEqual([]);
  });
});

describe("resolveEditorCommand", () => {
  test("YOMI_EDITOR が最優先", () => {
    expect(
      resolveEditorCommand({
        YOMI_EDITOR: "yomi-ed",
        EDITOR: "vi",
        VISUAL: "emacs",
      }),
    ).toEqual(["yomi-ed"]);
  });

  test("YOMI_EDITOR が空なら EDITOR", () => {
    expect(
      resolveEditorCommand({
        YOMI_EDITOR: "",
        EDITOR: "vi",
        VISUAL: "emacs",
      }),
    ).toEqual(["vi"]);
  });

  test("YOMI_EDITOR / EDITOR が空なら VISUAL", () => {
    expect(
      resolveEditorCommand({
        EDITOR: "   ",
        VISUAL: "emacs",
      }),
    ).toEqual(["emacs"]);
  });

  test("全部未設定なら code がデフォルト", () => {
    expect(resolveEditorCommand({})).toEqual(["code"]);
  });

  test("引数つきコマンドは split される", () => {
    expect(resolveEditorCommand({ YOMI_EDITOR: "code --wait" })).toEqual(["code", "--wait"]);
  });

  test("undefined と空白のみは未設定扱い", () => {
    expect(
      resolveEditorCommand({
        YOMI_EDITOR: undefined,
        EDITOR: " \t ",
      }),
    ).toEqual(["code"]);
  });
});

describe("openEditor", () => {
  test("解決された cmd と args + absPath で spawn される", () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const fakeSpawn = mock((cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args: [...args] });
      const ee = new EventEmitter() as EventEmitter & { unref: () => void };
      ee.unref = () => {};
      return ee;
    });

    openEditor("/tmp/foo.md", {
      env: { YOMI_EDITOR: "code --wait" },
      spawnFn: fakeSpawn as unknown as typeof import("node:child_process").spawn,
    });

    expect(calls).toEqual([{ cmd: "code", args: ["--wait", "/tmp/foo.md"] }]);
  });

  test("env 未設定なら code がデフォルトで spawn される", () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const fakeSpawn = mock((cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args: [...args] });
      const ee = new EventEmitter() as EventEmitter & { unref: () => void };
      ee.unref = () => {};
      return ee;
    });

    openEditor("/tmp/foo.md", {
      env: {},
      spawnFn: fakeSpawn as unknown as typeof import("node:child_process").spawn,
    });

    expect(calls).toEqual([{ cmd: "code", args: ["/tmp/foo.md"] }]);
  });

  test("spawn 後の error イベントは握り潰されて throw しない", () => {
    const fakeSpawn = mock(() => {
      const ee = new EventEmitter() as EventEmitter & { unref: () => void };
      ee.unref = () => {};
      // 非同期で error を発火させる
      setImmediate(() => ee.emit("error", new Error("ENOENT")));
      return ee;
    });

    expect(() =>
      openEditor("/tmp/foo.md", {
        env: { YOMI_EDITOR: "nonexistent-cmd-xyz" },
        spawnFn: fakeSpawn as unknown as typeof import("node:child_process").spawn,
      }),
    ).not.toThrow();
  });
});
