import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeNoStopTarget,
  describeStop,
  type StopOutcome,
  selectStopTargets,
} from "../src/daemon.ts";
import {
  type InstanceRecord,
  isAlive,
  type RegistryPaths,
  readInstances,
  resolvePaths,
} from "../src/instances.ts";
import { findAvailablePort } from "../src/port.ts";

const ENTRY = join(import.meta.dir, "..", "bin", "yomi.ts");

function record(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    pid: 1,
    port: 3939,
    host: "127.0.0.1",
    rootDir: "/tmp/docs",
    startedAt: "2026-08-03T00:00:00.000Z",
    logPath: "/tmp/state/yomi/logs/3939.log",
    version: "0.0.0-test",
    ...overrides,
  };
}

describe("selectStopTargets", () => {
  const here = record({ port: 3939, rootDir: tmpdir() });
  const elsewhere = record({ port: 3940, rootDir: join(tmpdir(), "elsewhere") });
  const all = [here, elsewhere];

  test("既定はカレントディレクトリのものだけ (他プロジェクトを巻き添えにしない)", () => {
    const picked = selectStopTargets(all, { all: false, port: null }, tmpdir());
    expect(picked.map((r) => r.port)).toEqual([3939]);
  });

  test("--all はすべて", () => {
    const picked = selectStopTargets(all, { all: true, port: null }, tmpdir());
    expect(picked.map((r) => r.port)).toEqual([3939, 3940]);
  });

  test("--port は該当ポートだけ (cwd を問わない)", () => {
    const picked = selectStopTargets(all, { all: false, port: 3940 }, tmpdir());
    expect(picked.map((r) => r.port)).toEqual([3940]);
  });

  test("該当なしなら空", () => {
    expect(selectStopTargets(all, { all: false, port: 9999 }, tmpdir())).toEqual([]);
    expect(selectStopTargets([], { all: true, port: null }, tmpdir())).toEqual([]);
  });
});

describe("停止結果のメッセージ", () => {
  const base: StopOutcome = {
    record: record({ pid: 4242, port: 3939 }),
    forced: false,
    alreadyGone: false,
  };

  test("通常の停止", () => {
    expect(describeStop(base)).toBe("yomi を停止しました (pid 4242 / :3939)");
  });

  test("SIGKILL に至ったことが分かる", () => {
    expect(describeStop({ ...base, forced: true })).toContain("SIGKILL");
  });

  test("既に終了していた場合は記録削除だと分かる", () => {
    const message = describeStop({ ...base, alreadyGone: true });
    expect(message).toContain("既に終了していました");
    expect(message).toContain("記録を削除");
  });
});

describe("停止対象なしの案内", () => {
  test("cwd 指定時は --all のヒントを添える", () => {
    const message = describeNoStopTarget({ all: false, port: null, cwd: "/tmp/docs" });
    expect(message).toContain("/tmp/docs");
    expect(message).toContain("yomi down --all");
  });

  test("--all 指定時は起動中が無いことだけ伝える", () => {
    const message = describeNoStopTarget({ all: true, port: null, cwd: "/tmp/docs" });
    expect(message).toContain("起動中の yomi はありません");
    expect(message).not.toContain("--all");
  });

  test("--port 指定時はポート番号を示す", () => {
    expect(describeNoStopTarget({ all: false, port: 8080, cwd: "/tmp/docs" })).toContain(
      "ポート 8080",
    );
  });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], opts: { cwd: string; state: string }): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, ENTRY, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, XDG_STATE_HOME: opts.state },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

// 実プロセスを起こすため既定の 5 秒では足りない (起動確認の上限が 10 秒)
const INTEGRATION_TIMEOUT_MS = 40_000;

describe("バックグラウンド起動 → 停止 (結合)", () => {
  let workDir: string;
  let stateDir: string;
  let paths: RegistryPaths;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "yomi-daemon-work-"));
    stateDir = await mkdtemp(join(tmpdir(), "yomi-daemon-state-"));
    paths = resolvePaths({ XDG_STATE_HOME: stateDir });
    await writeFile(join(workDir, "README.md"), "# テスト\n", "utf8");
  });

  afterEach(async () => {
    // 取りこぼしたプロセスを残さない (テストが CI のポートを掴んだままになる)
    for (const rec of await readInstances(paths)) {
      try {
        process.kill(rec.pid, "SIGKILL");
      } catch {
        // 既に終了している
      }
    }
    await rm(workDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  test(
    "up -d でサーバが常駐し、down で停止して記録も消える",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 39500);

      const up = await runCli(["up", "-d", "--port", String(port)], {
        cwd: workDir,
        state: stateDir,
      });
      expect(up.code).toBe(0);
      expect(up.stdout).toContain("バックグラウンドで起動しました");

      // レジストリに 1 件だけ記録される
      const records = await readInstances(paths);
      expect(records).toHaveLength(1);
      const rec = records[0] as InstanceRecord;
      expect(rec.port).toBe(port);
      expect(rec.rootDir).toBe(workDir);
      expect(isAlive(rec.pid)).toBe(true);

      // 親が終了した後もサーバは応答し続ける
      const res = await fetch(`http://127.0.0.1:${port}/api/tree`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("README.md");

      const down = await runCli(["down"], { cwd: workDir, state: stateDir });
      expect(down.code).toBe(0);
      expect(down.stdout).toContain("yomi を停止しました");

      expect(isAlive(rec.pid)).toBe(false);
      expect(await readInstances(paths)).toEqual([]);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    "使用中のポートを指定した up -d は失敗し、レジストリを汚さない",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 39600);

      const first = await runCli(["up", "-d", "--port", String(port)], {
        cwd: workDir,
        state: stateDir,
      });
      expect(first.code).toBe(0);
      const before = await readInstances(paths);
      expect(before).toHaveLength(1);

      // 同じポートへの二重起動: 生きている記録を上書きして孤児化させてはいけない
      const second = await runCli(["up", "-d", "--port", String(port)], {
        cwd: workDir,
        state: stateDir,
      });
      expect(second.code).toBe(1);
      expect(second.stderr).toContain("既に yomi が起動しています");
      expect(await readInstances(paths)).toEqual(before);

      await runCli(["down", "--all"], { cwd: workDir, state: stateDir });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    "別ディレクトリの yomi は down の巻き添えにならない",
    async () => {
      const otherDir = await mkdtemp(join(tmpdir(), "yomi-daemon-other-"));
      await writeFile(join(otherDir, "other.md"), "# other\n", "utf8");
      const portA = await findAvailablePort("127.0.0.1", 39700);
      const portB = await findAvailablePort("127.0.0.1", portA + 1);

      try {
        expect(
          (await runCli(["up", "-d", "--port", String(portA)], { cwd: workDir, state: stateDir }))
            .code,
        ).toBe(0);
        expect(
          (await runCli(["up", "-d", "--port", String(portB)], { cwd: otherDir, state: stateDir }))
            .code,
        ).toBe(0);

        const down = await runCli(["down"], { cwd: workDir, state: stateDir });
        expect(down.code).toBe(0);

        const left = await readInstances(paths);
        expect(left.map((r) => r.port)).toEqual([portB]);
        expect(isAlive((left[0] as InstanceRecord).pid)).toBe(true);
      } finally {
        await runCli(["down", "--all"], { cwd: workDir, state: stateDir });
        await rm(otherDir, { recursive: true, force: true });
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    "停止対象が無くても成功扱い (終了コード 0)",
    async () => {
      const down = await runCli(["down"], { cwd: workDir, state: stateDir });
      expect(down.code).toBe(0);
      expect(down.stdout).toContain("停止対象がありません");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
