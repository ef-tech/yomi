import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPortIsFree,
  describeNoStopTarget,
  describePortInUse,
  describeServeFailure,
  describeStop,
  type StopOutcome,
  selectStopTargets,
  stopInstance,
} from "../src/daemon.ts";
import {
  type InstanceRecord,
  isAlive,
  logPath,
  matchesRoot,
  type RegistryPaths,
  readInstances,
  resolvePaths,
  saveInstance,
} from "../src/instances.ts";
import { DEFAULT_START_PORT, findAvailablePort } from "../src/port.ts";

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
    stopped: true,
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

  test("落とせなかった場合は成功と言わず手当てを示す", () => {
    const message = describeStop({ ...base, forced: true, stopped: false });
    expect(message).toContain("停止できませんでした");
    expect(message).toContain("kill -9 4242");
    expect(message).not.toContain("停止しました");
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

async function runCli(
  args: string[],
  opts: { cwd: string; state: string; env?: Record<string, string> },
): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, ENTRY, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, XDG_STATE_HOME: opts.state, ...opts.env },
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
      // macOS の tmpdir は /var → /private/var のシンボリックリンクで、子プロセスの
      // process.cwd() は解決済みのパスを返す。down は matchesRoot が realpath で
      // 突き合わせるので実挙動に影響しないが、比較する側も正規化しておく。
      expect(rec.rootDir).toBe(realpathSync(workDir));
      expect(matchesRoot(rec, workDir)).toBe(true);
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
    "記録したポートで listen していない pid にはシグナルを送らない (PID 再利用対策)",
    async () => {
      // 生きてはいるが yomi ではないプロセス = pid が再利用された状況の再現
      const bystander = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
      const port = await findAvailablePort("127.0.0.1", 39800);
      const stale = record({ pid: bystander.pid, port, host: "127.0.0.1" });
      await saveInstance(stale, paths);

      try {
        const outcome = await stopInstance(stale, { paths });

        expect(outcome.alreadyGone).toBe(true);
        expect(outcome.stopped).toBe(true);
        // 無関係なプロセスを巻き添えにしていない
        expect(isAlive(bystander.pid)).toBe(true);
        // 記録は片付ける (次回以降 list / down に出てこない)
        expect(await readInstances(paths)).toEqual([]);
      } finally {
        bystander.kill(9);
        await bystander.exited;
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    "list に起動中のインスタンスが並び、down 後は 0 件になる (Issue #69)",
    async () => {
      const otherDir = await mkdtemp(join(tmpdir(), "yomi-list-other-"));
      await writeFile(join(otherDir, "other.md"), "# other\n", "utf8");
      const portA = await findAvailablePort("127.0.0.1", 39900);
      const portB = await findAvailablePort("127.0.0.1", portA + 1);

      try {
        const empty = await runCli(["list"], { cwd: workDir, state: stateDir });
        expect(empty.code).toBe(0);
        expect(empty.stdout).toContain("起動中の yomi はありません");

        await runCli(["up", "-d", "--port", String(portA)], { cwd: workDir, state: stateDir });
        await runCli(["up", "-d", "--port", String(portB), "--share"], {
          cwd: otherDir,
          state: stateDir,
        });

        const listed = await runCli(["list"], { cwd: workDir, state: stateDir });
        expect(listed.code).toBe(0);
        const lines = listed.stdout.trimEnd().split("\n");
        expect(lines).toHaveLength(3); // 見出し + 2 件
        expect(lines[0]).toMatch(/^PID\s+PORT\s+PUBLIC\s+DIR$/);
        // cwd は起動時に realpath 解決されるため、比較する側も揃える
        expect(listed.stdout).toContain(realpathSync(workDir));
        expect(listed.stdout).toContain(realpathSync(otherDir));
        expect(listed.stdout).toContain("local"); // portA は 127.0.0.1
        expect(listed.stdout).toContain("share"); // portB は --share

        await runCli(["down", "--all"], { cwd: workDir, state: stateDir });

        const after = await runCli(["list"], { cwd: workDir, state: stateDir });
        expect(after.stdout).toContain("起動中の yomi はありません");
      } finally {
        await runCli(["down", "--all"], { cwd: workDir, state: stateDir });
        await rm(otherDir, { recursive: true, force: true });
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    "list は死んだインスタンスの記録を掃除してから表示する (Issue #69)",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 39950);
      await runCli(["up", "-d", "--port", String(port)], { cwd: workDir, state: stateDir });

      const [started] = await readInstances(paths);
      process.kill((started as InstanceRecord).pid, "SIGKILL");
      // シグナル配送とプロセス消滅を待つ
      for (let i = 0; i < 50 && isAlive((started as InstanceRecord).pid); i++) {
        await Bun.sleep(100);
      }

      const listed = await runCli(["list"], { cwd: workDir, state: stateDir });
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain("起動中の yomi はありません");
      // 掃除は永続化される
      expect(await readInstances(paths)).toEqual([]);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    "list は pid が再利用された記録を表示しない (down の判定と食い違わせない・Issue #69)",
    async () => {
      // 生きてはいるが yomi ではないプロセス = pid 再利用の再現
      const bystander = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
      const port = await findAvailablePort("127.0.0.1", 39980);
      await saveInstance(
        record({ pid: bystander.pid, port, host: "127.0.0.1", rootDir: workDir }),
        paths,
      );

      try {
        const listed = await runCli(["list"], { cwd: workDir, state: stateDir });

        expect(listed.code).toBe(0);
        // pid は生きているが、そのポートで listen していないので一覧に出さない
        expect(listed.stdout).toContain("起動中の yomi はありません");
        expect(listed.stdout).not.toContain(String(bystander.pid));
        // 無関係なプロセスは巻き添えにしない
        expect(isAlive(bystander.pid)).toBe(true);
        expect(await readInstances(paths)).toEqual([]);
      } finally {
        bystander.kill(9);
        await bystander.exited;
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

describe("フォアグラウンド起動 → 停止 (結合・Issue #90)", () => {
  let workDir: string;
  let stateDir: string;
  let paths: RegistryPaths;
  /** 各テストが起こしたフォアグラウンドプロセス (afterEach で確実に落とす) */
  let spawned: ReturnType<typeof Bun.spawn>[];

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "yomi-fg-work-"));
    stateDir = await mkdtemp(join(tmpdir(), "yomi-fg-state-"));
    paths = resolvePaths({ XDG_STATE_HOME: stateDir });
    await writeFile(join(workDir, "README.md"), "# テスト\n", "utf8");
    spawned = [];
  });

  afterEach(async () => {
    for (const proc of spawned) {
      try {
        proc.kill(9);
        await proc.exited;
      } catch {
        // 既に終了している
      }
    }
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

  /** フォアグラウンドで起動し、listen を始めるまで待つ */
  async function startForeground(port: number): Promise<ReturnType<typeof Bun.spawn>> {
    const proc = Bun.spawn([process.execPath, ENTRY, "--port", String(port), "--no-open"], {
      cwd: workDir,
      env: { ...process.env, XDG_STATE_HOME: stateDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    spawned.push(proc);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/tree`);
        if (res.status === 200) return proc;
      } catch {
        // まだ listen していない
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`フォアグラウンド起動が ${port} で listen しませんでした`);
  }

  // Issue #94: フォアグラウンドは assertPortIsFree を通っておらず、Bun.serve の throw が
  // main().catch にそのまま流れて**ソースの抜粋つきスタックトレース**が出ていた。
  // up -d は同じ状況で利用者向けの 1 行を出しており、その非対称を解消する。
  describe("使用中ポートを指定したとき (Issue #94)", () => {
    test(
      "既に yomi が使っていれば yomi down を案内し、終了コード 1 で落ちる",
      async () => {
        const port = await findAvailablePort("127.0.0.1", 39340);
        const proc = await startForeground(port);

        const second = await runCli(["--port", String(port), "--no-open"], {
          cwd: workDir,
          state: stateDir,
        });

        expect(second.code).toBe(1);
        // スタックトレースではなく利用者向けの 1 行であること
        expect(second.stderr).toContain(`ポート ${port} では既に yomi が起動しています`);
        expect(second.stderr).toContain(`yomi down --port ${port}`);
        expect(second.stderr).toContain(String(proc.pid));
        expect(second.stderr).not.toContain("起動失敗");
        expect(second.stderr).not.toContain("EADDRINUSE");

        // 先に動いているインスタンスは無傷 (記録も上書きされていない)
        expect((await readInstances(paths)).map((r) => r.pid)).toEqual([proc.pid]);
        expect((await fetch(`http://127.0.0.1:${port}/api/tree`)).status).toBe(200);
      },
      INTEGRATION_TIMEOUT_MS,
    );

    test(
      "yomi 以外が使っていれば別ポートを案内し、終了コード 1 で落ちる",
      async () => {
        const port = await findAvailablePort("127.0.0.1", 39360);
        // yomi ではない何かがそのポートを掴んでいる状態を作る
        const holder = Bun.listen({
          hostname: "127.0.0.1",
          port,
          socket: { data() {}, open() {}, close() {} },
        });
        try {
          const res = await runCli(["--port", String(port), "--no-open"], {
            cwd: workDir,
            state: stateDir,
          });
          expect(res.code).toBe(1);
          expect(res.stderr).toContain(`ポート ${port} は既に使用されています`);
          expect(res.stderr).toContain("別のポートを指定してください");
          expect(res.stderr).not.toContain("起動失敗");
          expect(res.stderr).not.toContain("EADDRINUSE");
        } finally {
          holder.stop(true);
        }
      },
      INTEGRATION_TIMEOUT_MS,
    );

    // **findAvailablePort の走査範囲は 3939 から 50 個 (src/port.ts)。** 事前検査を
    // --port 明示時に限っているので、ここを誤ると省略時まで落とすようになる。
    // 走査範囲の先頭を塞いだうえで「別のポートで起動できる」ことまで見る
    // (走査範囲外を塞いでも、自動探索は素通りするので何も検証できない)。
    test(
      "--port を省略しても自動探索が働き、塞がれたポートを避けて起動する",
      async () => {
        const taken = await findAvailablePort("127.0.0.1", DEFAULT_START_PORT);
        // yomi ではない何かが走査範囲の先頭を掴んでいる状態を作る
        const holder = Bun.listen({
          hostname: "127.0.0.1",
          port: taken,
          socket: { data() {}, open() {}, close() {} },
        });
        try {
          const proc = Bun.spawn([process.execPath, ENTRY, "--no-open"], {
            cwd: workDir,
            env: { ...process.env, XDG_STATE_HOME: stateDir },
            stdout: "pipe",
            stderr: "pipe",
          });
          spawned.push(proc);

          const deadline = Date.now() + 15_000;
          let records: InstanceRecord[] = [];
          while (Date.now() < deadline && records.length === 0) {
            records = await readInstances(paths);
            if (records.length === 0) await new Promise((r) => setTimeout(r, 100));
          }
          expect(records).toHaveLength(1);
          // 塞がれたポートを避けて別のポートで起動している
          expect((records[0] as InstanceRecord).port).not.toBe(taken);
        } finally {
          holder.stop(true);
        }
      },
      INTEGRATION_TIMEOUT_MS,
    );
  });

  /**
   * **事前検査と `Bun.serve` の間の窓 (Issue #107)。**
   *
   * #94 は事前検査を足したが隙間が残り、その窓で別プロセスがポートを掴むと
   * throw が `main().catch` へ流れて**ソースの抜粋つきスタックトレース**が出ていた
   * （#94 以前の出力に戻る）。
   *
   * **窓そのものをテストから作るのはタイミング勝負**になるが、`YOMI_DETACHED=1` は
   * 事前検査を丸ごと飛ばす実在の経路（切り離された子）なので、**窓を通り抜けた後と
   * 同じ状態**を決定的に作れる。テスト専用のフックを足す必要がない。
   */
  describe("事前検査を通り抜けてポートを奪われたとき (Issue #107)", () => {
    const detached = { YOMI_DETACHED: "1" };

    test(
      "yomi 以外が掴んでいれば別ポートを案内し、終了コード 1 で落ちる",
      async () => {
        const port = await findAvailablePort("127.0.0.1", 39380);
        const holder = Bun.listen({
          hostname: "127.0.0.1",
          port,
          socket: { data() {}, open() {}, close() {} },
        });
        try {
          const res = await runCli(["up", "--port", String(port), "--no-open"], {
            cwd: workDir,
            state: stateDir,
            env: detached,
          });

          expect(res.code).toBe(1);
          expect(res.stderr).toContain(`ポート ${port} は既に使用されています`);
          expect(res.stderr).toContain("別のポートを指定してください");
          // **スタックトレースに戻っていないこと。** ここが Issue #107 の本体
          expect(res.stderr).not.toContain("EADDRINUSE");
          expect(res.stderr).not.toContain("Bun.serve");
          expect(res.stderr).not.toContain("at runForeground");
          expect(res.stderr).not.toContain("src/server.ts");
          expect(res.stderr.trim().split("\n")).toHaveLength(1);
        } finally {
          holder.stop(true);
        }
      },
      INTEGRATION_TIMEOUT_MS,
    );

    test(
      "先に動いている yomi が掴んでいれば yomi down を案内し、記録を汚さない",
      async () => {
        const port = await findAvailablePort("127.0.0.1", 39400);
        const proc = await startForeground(port);

        const res = await runCli(["up", "--port", String(port), "--no-open"], {
          cwd: workDir,
          state: stateDir,
          env: detached,
        });

        expect(res.code).toBe(1);
        // **相手が yomi なら #94 と同じ文面**（判定と文面は assertPortIsFree が正本）
        expect(res.stderr).toContain(`ポート ${port} では既に yomi が起動しています`);
        expect(res.stderr).toContain(`yomi down --port ${port}`);
        expect(res.stderr).toContain(String(proc.pid));
        expect(res.stderr).not.toContain("EADDRINUSE");
        expect(res.stderr.trim().split("\n")).toHaveLength(1);

        // 先に動いているインスタンスの記録が無傷であること。
        //
        // **この経路では強い保証にならない。** `YOMI_DETACHED=1` だと `saveInstance`
        // 自体を通らない（`bin/yomi.ts` の `if (!detachedChild)`）ので、修正の有無に
        // かかわらず通る。**DoD「レジストリが汚れない」を実際に守っているのは
        // 上の #94 のテスト**（事前検査の経路）。ここは出力の検証が本体
        expect((await readInstances(paths)).map((r) => r.pid)).toEqual([proc.pid]);
        expect((await fetch(`http://127.0.0.1:${port}/api/tree`)).status).toBe(200);
      },
      INTEGRATION_TIMEOUT_MS,
    );
  });

  test(
    "フォアグラウンド起動もレジストリに記録され、list に出る",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 39310);
      const proc = await startForeground(port);

      const records = await readInstances(paths);
      expect(records).toHaveLength(1);
      const rec = records[0] as InstanceRecord;
      expect(rec.pid).toBe(proc.pid);
      expect(rec.port).toBe(port);
      expect(rec.rootDir).toBe(realpathSync(workDir));
      // 端末に出るのでログファイルは持たない (バックグラウンドとの唯一の違い)
      expect(rec.logPath).toBe("");

      const listed = await runCli(["list"], { cwd: workDir, state: stateDir });
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain(String(proc.pid));
      expect(listed.stdout).toContain(String(port));
      // PUBLIC 列と起動ディレクトリがバックグラウンドと同じ形で出る
      expect(listed.stdout).toContain("local");
      expect(listed.stdout).toContain(realpathSync(workDir));
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    "フォアグラウンド起動を yomi down で停止でき、記録も消える",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 39320);
      const proc = await startForeground(port);

      const down = await runCli(["down"], { cwd: workDir, state: stateDir });
      expect(down.code).toBe(0);
      expect(down.stdout).toContain("yomi を停止しました");

      await proc.exited;
      expect(isAlive(proc.pid)).toBe(false);
      expect(await readInstances(paths)).toEqual([]);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    "SIGINT (Ctrl+C) で終了すると記録が残骸として残らない",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 39330);
      const proc = await startForeground(port);
      expect(await readInstances(paths)).toHaveLength(1);

      proc.kill("SIGINT");
      await proc.exited;

      expect(await readInstances(paths)).toEqual([]);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    "SIGTERM に応答しないフォアグラウンドも down が SIGKILL で落とす",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 39340);
      const proc = await startForeground(port);

      // SIGSTOP で「シグナルハンドラを処理できない」状態を作る。#89 で観測した
      // futex ブロック (event loop が回らず SIGTERM が届かない) と同じ見え方になる
      process.kill(proc.pid, "SIGSTOP");

      const down = await runCli(["down"], { cwd: workDir, state: stateDir });
      expect(down.code).toBe(0);
      expect(down.stdout).toContain("強制終了しました");
      expect(down.stdout).toContain("SIGKILL");

      await proc.exited;
      expect(isAlive(proc.pid)).toBe(false);
      expect(await readInstances(paths)).toEqual([]);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    "記録に失敗してもビューアとしては起動する (警告は出す)",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 39360);
      // 状態ディレクトリの位置に**ファイル**を置く → mkdir が失敗し saveInstance が throw する
      const blocked = join(await mkdtemp(join(tmpdir(), "yomi-fg-blocked-")), "not-a-dir");
      await writeFile(blocked, "", "utf8");

      const proc = Bun.spawn([process.execPath, ENTRY, "--port", String(port), "--no-open"], {
        cwd: workDir,
        env: { ...process.env, XDG_STATE_HOME: blocked },
        stdout: "pipe",
        stderr: "pipe",
      });
      spawned.push(proc);

      const deadline = Date.now() + 15_000;
      let served = false;
      while (Date.now() < deadline && !served) {
        try {
          served = (await fetch(`http://127.0.0.1:${port}/api/tree`)).status === 200;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      // 記録できなくても読める (主機能は記録に依存していない)
      expect(served).toBe(true);

      proc.kill("SIGINT");
      await proc.exited;
      // 何が起きたか分かる形で伝えている (黙って続けない)
      expect(await new Response(proc.stderr).text()).toContain("記録に失敗");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    "up -d の子はレジストリを上書きしない (親が書いた logPath 付きの記録が残る)",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 39350);

      const up = await runCli(["up", "-d", "--port", String(port)], {
        cwd: workDir,
        state: stateDir,
      });
      expect(up.code).toBe(0);

      const records = await readInstances(paths);
      expect(records).toHaveLength(1);
      // 子 (runForeground) が書くと logPath が空になる。親の記録が残っていること
      expect((records[0] as InstanceRecord).logPath).toBe(logPath(port, paths));
    },
    INTEGRATION_TIMEOUT_MS,
  );
});

/**
 * `Bun.serve` の EADDRINUSE を文面へ変換する部分 (Issue #107)。
 *
 * 上の結合テストは**実プロセスを起こす**ので遅く、境界（衝突以外のエラー・
 * 調べる前に相手が消えた場合）まで全部そちらで見ると時間が掛かる。
 * ここは変換だけを速く固定する。
 */
describe("describeServeFailure (Issue #107)", () => {
  let stateDir: string;
  let paths: RegistryPaths;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "yomi-conflict-state-"));
    paths = resolvePaths({ XDG_STATE_HOME: stateDir });
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  /** `Bun.serve` が投げるものの形（`code` を持つ Error）。 */
  const addrInUse = () =>
    Object.assign(new Error("Failed to start server."), {
      code: "EADDRINUSE",
    });

  test("ポート衝突でなければ null を返す（呼び出し元がそのまま投げ直せる）", async () => {
    // **これを取り違えると、無関係な失敗が「ポートが使われています」に化ける**
    const other = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    expect(await describeServeFailure(other, "127.0.0.1", 39900, paths)).toBeNull();
    expect(
      await describeServeFailure(new Error("何か別の失敗"), "127.0.0.1", 39900, paths),
    ).toBeNull();
    expect(await describeServeFailure(null, "127.0.0.1", 39900, paths)).toBeNull();
    expect(await describeServeFailure("文字列", "127.0.0.1", 39900, paths)).toBeNull();
  });

  // **`code` が消えたら黙ってスタックトレースへ戻る**ので、メッセージでも拾う。
  // Bun の現行メッセージに `EADDRINUSE` の文字列は入っていない（実測）ので、
  // **その言い回しを実物のまま**置いておく —— Node 形式だけ試しても保険にならない
  test.each([
    ["Bun の実物", "Failed to start server. Is port 39910 in use?"],
    ["Node 形式", "listen EADDRINUSE: address already in use"],
  ])("code が無くてもメッセージで拾う（%s）", async (_label, message) => {
    const port = 39910;
    const holder = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {}, open() {}, close() {} },
    });
    try {
      expect(await describeServeFailure(new Error(message), "127.0.0.1", port, paths)).toContain(
        `ポート ${port} は既に使用されています`,
      );
    } finally {
      holder.stop(true);
    }
  });

  // `assertPortIsFree` は「非 null なら throw」するだけの皮。ずれると
  // 事前検査と衝突時で文面が食い違う
  test("assertPortIsFree と同じ文面を返す", async () => {
    const port = 39940;
    await saveInstance(
      record({ pid: process.pid, port, host: "127.0.0.1", rootDir: "/tmp/same-wording" }),
      paths,
    );
    const reason = await describePortInUse("127.0.0.1", port, paths);
    expect(reason).not.toBeNull();
    await expect(assertPortIsFree("127.0.0.1", port, paths)).rejects.toThrow(reason as string);
  });

  test("空いていれば describePortInUse は null を返す", async () => {
    const port = await findAvailablePort("127.0.0.1", 39950);
    expect(await describePortInUse("127.0.0.1", port, paths)).toBeNull();
  });

  test("相手が yomi なら yomi down を案内する", async () => {
    const port = 39920;
    await saveInstance(
      record({ pid: process.pid, port, host: "127.0.0.1", rootDir: "/tmp/some-docs" }),
      paths,
    );
    const message = await describeServeFailure(addrInUse(), "127.0.0.1", port, paths);
    expect(message).toContain(`ポート ${port} では既に yomi が起動しています`);
    expect(message).toContain(`yomi down --port ${port}`);
    expect(message).toContain("/tmp/some-docs");
  });

  test("調べるまでの間に相手が消えていたら、使用中とは言わずに再試行を促す", async () => {
    // 記録も無く、ポートも空いている = EADDRINUSE を受けてから相手が終了した状態
    const port = await findAvailablePort("127.0.0.1", 39930);
    const message = await describeServeFailure(addrInUse(), "127.0.0.1", port, paths);
    expect(message).toBe(`ポート ${port} を確保できませんでした。もう一度お試しください`);
    // **「使用されています」と言わない。** 空いているので嘘になる
    expect(message).not.toContain("既に使用されています");
  });
});
