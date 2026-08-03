import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type InstanceRecord,
  isAlive,
  liveInstances,
  matchesRoot,
  type RegistryPaths,
  readInstances,
  recordPath,
  removeInstance,
  resolvePaths,
  saveInstance,
} from "../src/instances.ts";

/** 確実に存在しない pid を得る (定数の大きな pid は環境依存で当たりうる) */
async function reapedPid(): Promise<number> {
  const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  const pid = proc.pid;
  proc.kill(9);
  await proc.exited;
  return pid;
}

function record(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    pid: process.pid,
    port: 3939,
    host: "127.0.0.1",
    rootDir: "/tmp/docs",
    startedAt: "2026-08-03T00:00:00.000Z",
    logPath: "/tmp/state/yomi/logs/3939.log",
    version: "0.0.0-test",
    ...overrides,
  };
}

describe("resolvePaths", () => {
  test("XDG_STATE_HOME 配下に yomi/ を掘る", () => {
    const paths = resolvePaths({ XDG_STATE_HOME: "/xdg/state" });
    expect(paths.root).toBe(join("/xdg/state", "yomi"));
    expect(paths.instances).toBe(join("/xdg/state", "yomi", "instances"));
    expect(paths.logs).toBe(join("/xdg/state", "yomi", "logs"));
  });

  test("XDG_STATE_HOME が未設定 / 空白なら ~/.local/state にフォールバック", () => {
    const expected = join(homedir(), ".local", "state", "yomi");
    expect(resolvePaths({}).root).toBe(expected);
    expect(resolvePaths({ XDG_STATE_HOME: "   " }).root).toBe(expected);
  });
});

describe("レジストリの読み書き", () => {
  let dir: string;
  let paths: RegistryPaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yomi-registry-"));
    paths = resolvePaths({ XDG_STATE_HOME: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("保存した内容をそのまま読み戻せる", async () => {
    const rec = record();
    await saveInstance(rec, paths);
    expect(await readInstances(paths)).toEqual([rec]);
  });

  test("ポート単位でファイルが分かれる (同時起動で記録を潰さない)", async () => {
    await saveInstance(record({ port: 3939 }), paths);
    await saveInstance(record({ port: 3940, rootDir: "/tmp/other" }), paths);

    expect(recordPath(3939, paths)).toBe(join(paths.instances, "3939.json"));
    const ports = (await readInstances(paths)).map((r) => r.port);
    expect(ports).toEqual([3939, 3940]); // ポート昇順
  });

  test("レジストリ未作成なら空配列 (エラーにしない)", async () => {
    expect(await readInstances(paths)).toEqual([]);
  });

  test("removeInstance は存在しないポートでも失敗しない", async () => {
    await removeInstance(9999, paths);
    expect(await readInstances(paths)).toEqual([]);
  });

  describe("壊れたエントリは無視して続行する", () => {
    test("JSON として壊れているファイル", async () => {
      await saveInstance(record({ port: 3939 }), paths);
      await writeFile(join(paths.instances, "4000.json"), "{ this is not json", "utf8");

      const found = await readInstances(paths);
      expect(found.map((r) => r.port)).toEqual([3939]);
    });

    test("必須フィールドが欠けている / 型が違うエントリ", async () => {
      await mkdir(paths.instances, { recursive: true });
      await writeFile(join(paths.instances, "4001.json"), JSON.stringify({ port: 4001 }), "utf8");
      await writeFile(
        join(paths.instances, "4002.json"),
        JSON.stringify({ pid: "abc", port: 4002, host: "127.0.0.1", rootDir: "/x" }),
        "utf8",
      );
      await writeFile(join(paths.instances, "4003.json"), JSON.stringify(null), "utf8");

      expect(await readInstances(paths)).toEqual([]);
    });

    test(".json 以外のファイルは読まない", async () => {
      await mkdir(paths.instances, { recursive: true });
      await writeFile(join(paths.instances, "README.txt"), "not a record", "utf8");
      expect(await readInstances(paths)).toEqual([]);
    });

    test("欠けていてもよい項目は空文字で補う", async () => {
      await mkdir(paths.instances, { recursive: true });
      await writeFile(
        join(paths.instances, "4004.json"),
        JSON.stringify({ pid: 1, port: 4004, host: "127.0.0.1", rootDir: "/x" }),
        "utf8",
      );
      expect(await readInstances(paths)).toEqual([
        {
          pid: 1,
          port: 4004,
          host: "127.0.0.1",
          rootDir: "/x",
          startedAt: "",
          logPath: "",
          version: "",
        },
      ]);
    });
  });
});

describe("isAlive", () => {
  test("自分自身は生きている", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  test("終了済みプロセスの pid は死んでいる", async () => {
    expect(isAlive(await reapedPid())).toBe(false);
  });
});

describe("liveInstances", () => {
  let dir: string;
  let paths: RegistryPaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yomi-live-"));
    paths = resolvePaths({ XDG_STATE_HOME: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("死んだエントリを取り除き、レジストリからも消す", async () => {
    const dead = await reapedPid();
    await saveInstance(record({ port: 3939, pid: process.pid }), paths);
    await saveInstance(record({ port: 3940, pid: dead }), paths);

    const live = await liveInstances(paths);
    expect(live.map((r) => r.port)).toEqual([3939]);
    // 掃除は永続化される (次回以降も残骸が並ばない)
    expect((await readInstances(paths)).map((r) => r.port)).toEqual([3939]);
  });
});

describe("matchesRoot", () => {
  test("同じディレクトリなら一致する", () => {
    expect(matchesRoot(record({ rootDir: tmpdir() }), tmpdir())).toBe(true);
  });

  test("別ディレクトリなら一致しない", () => {
    expect(matchesRoot(record({ rootDir: tmpdir() }), join(tmpdir(), "child"))).toBe(false);
  });

  test("末尾スラッシュや相対表記の違いを吸収する", () => {
    expect(matchesRoot(record({ rootDir: tmpdir() }), `${tmpdir()}/`)).toBe(true);
    expect(matchesRoot(record({ rootDir: tmpdir() }), join(tmpdir(), "x", ".."))).toBe(true);
  });

  test("存在しないディレクトリでも文字列として比較できる", () => {
    const missing = join(tmpdir(), "yomi-does-not-exist-12345");
    expect(matchesRoot(record({ rootDir: missing }), missing)).toBe(true);
  });
});
