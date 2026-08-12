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
  servingInstances,
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
import { processStartedAt } from "../src/util/proc-start.ts";

const ENTRY = join(import.meta.dir, "..", "bin", "yomi.ts");

function record(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    pid: 1,
    port: 3939,
    host: "127.0.0.1",
    rootDir: "/tmp/docs",
    startedAt: "2026-08-03T00:00:00.000Z",
    // 既定は空 = 「起動時刻が読めなかった記録」。個別に必要なテストが上書きする
    procStartedAt: "",
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
    // **子の stderr を添える。** 捨てると、起動を拒否された理由（「既に yomi が
    // 起動しています」等）が一切出ず、15 秒待った末に「listen しなかった」しか分からない
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `フォアグラウンド起動が ${port} で listen しませんでした\n子の stderr: ${stderr}`,
    );
  }

  // Issue #94: フォアグラウンドは assertPortIsFree を通っておらず、Bun.serve の throw が
  // main().catch にそのまま流れて**ソースの抜粋つきスタックトレース**が出ていた。
  // up -d は同じ状況で利用者向けの 1 行を出しており、その非対称を解消する。
  //
  // **Issue #108 の DoD 3（生きている相手は従来どおり拒否する）もここが守っている。**
  // #108 で緩めたのは「残骸の扱い」だけなので、同じ内容のテストを増やさない。
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
   * **「list に出ないのに起動できない」を潰す (Issue #108)。**
   *
   * `assertPortIsFree` は記録の pid が生きているかだけを見ていた。**残骸記録の pid が
   * 別プロセスに再利用されている**と、ポートが空いていても拒否する。残骸は SIGHUP や
   * SIGKILL で普通に発生する（`installShutdownHandlers` は SIGINT / SIGTERM のみ）。
   *
   * #94 が事前検査をフォアグラウンドからも呼ぶようにしたことで露出した ——
   * それまでバックグラウンドだけに掛かっていた判定の粗さが、通常の `yomi --port <n>`
   * にも波及した（`main` では起動できていた）。
   */
  test(
    "残骸記録の pid が再利用されていても、ポートが空いていれば起動できる (Issue #108)",
    async () => {
      // 生きてはいるが yomi ではないプロセス = pid 再利用の再現
      const bystander = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
      const port = await findAvailablePort("127.0.0.1", 39420);
      await saveInstance(
        record({ pid: bystander.pid, port, host: "127.0.0.1", rootDir: workDir }),
        paths,
      );

      try {
        // **`yomi list` を先に打たないこと。** `servingInstances` が残骸を掃除するので、
        // 先に打つと記録が消えて**この検証が空振りする**（実際に一度そう書いて、
        // 修正を revert しても落ちないテストになっていた）。
        // 一覧との整合は下の describePortInUse のテストが決定的に見る

        // **残骸が残ったまま起動できる。** 以前はここで
        // 「既に yomi が起動しています」と拒否し、`main` では起動できていた
        const proc = await startForeground(port);
        expect((await fetch(`http://127.0.0.1:${port}/api/tree`)).status).toBe(200);

        // 残骸は自分の記録で置き換わり、list から辿れる
        const records = await readInstances(paths);
        expect(records.map((r) => r.pid)).toEqual([proc.pid]);

        // 無関係なプロセスは巻き添えにしない
        expect(isAlive(bystander.pid)).toBe(true);
      } finally {
        bystander.kill(9);
        await bystander.exited;
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

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

  // **`assertPortIsFree` は `startDetached` からも呼ばれる (Issue #108)。**
  // 記録の書き手が違う（親が logPath 付きで書き、子は書かない）ので、
  // フォアグラウンドだけ見ていると up -d 側の退行に気づけない。
  test(
    "up -d も残骸記録の pid 再利用で拒否されない (Issue #108)",
    async () => {
      // 生きてはいるが yomi ではないプロセス = pid 再利用の再現
      const bystander = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
      const port = await findAvailablePort("127.0.0.1", 39370);
      await saveInstance(
        record({ pid: bystander.pid, port, host: "127.0.0.1", rootDir: workDir }),
        paths,
      );

      try {
        const up = await runCli(["up", "-d", "--port", String(port)], {
          cwd: workDir,
          state: stateDir,
        });
        expect(up.code).toBe(0);

        // 残骸は**親の記録**（logPath 付き）で置き換わる。ここが空だと
        // 停止手段そのものを失う（`startDetached` は記録に失敗したら起動を失敗させる）
        const records = await readInstances(paths);
        expect(records).toHaveLength(1);
        expect((records[0] as InstanceRecord).logPath).toBe(logPath(port, paths));
        expect((records[0] as InstanceRecord).pid).not.toBe(bystander.pid);

        // 無関係なプロセスは巻き添えにしない
        expect(isAlive(bystander.pid)).toBe(true);
      } finally {
        bystander.kill(9);
        await bystander.exited;
      }
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
    const port = await findAvailablePort("127.0.0.1", 39940);
    const listening = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {}, open() {}, close() {} },
    });
    try {
      await saveInstance(
        record({
          pid: process.pid,
          port,
          host: "127.0.0.1",
          rootDir: "/tmp/same-wording",
          procStartedAt: (await processStartedAt(process.pid)) ?? "",
        }),
        paths,
      );
      const reason = await describePortInUse("127.0.0.1", port, paths);
      expect(reason).toContain("既に yomi が起動しています");
      await expect(assertPortIsFree("127.0.0.1", port, paths)).rejects.toThrow(reason as string);
    } finally {
      listening.stop(true);
    }
  });

  /**
   * **判定基準が list / down と揃っていること (Issue #108)。**
   *
   * 揃っていないと「`yomi list` には出ないのに `yomi --port N` は拒否する」という
   * 説明のつかない状態になる。#94 が事前検査をフォアグラウンドからも呼ぶように
   * したことで露出した。
   */
  test("残骸記録（pid 生存・listen なし）を list と同じく無視する", async () => {
    const bystander = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    const port = await findAvailablePort("127.0.0.1", 39960);
    try {
      await saveInstance(
        record({ pid: bystander.pid, port, host: "127.0.0.1", rootDir: "/tmp/stale" }),
        paths,
      );

      // **起動を拒否しない。** pid だけ見ていた頃はここで「既に yomi が起動しています」
      expect(await describePortInUse("127.0.0.1", port, paths)).toBeNull();

      // **一覧にも出ない。** 同じ判定を使っているので当然そうなる、を固定する
      // （`servingInstances` は残骸を掃除するので、上の検証より後に呼ぶ）
      expect(await servingInstances(paths)).toEqual([]);
    } finally {
      bystander.kill(9);
      await bystander.exited;
    }
  });

  test("空いていれば describePortInUse は null を返す", async () => {
    const port = await findAvailablePort("127.0.0.1", 39950);
    expect(await describePortInUse("127.0.0.1", port, paths)).toBeNull();
  });

  test("相手が yomi なら yomi down を案内する", async () => {
    const port = await findAvailablePort("127.0.0.1", 39920);
    // **記録の pid が生きているだけでは足りない (Issue #108)。** そのポートで
    // listen していることまで揃って初めて「起動中の yomi」とみなす
    const listening = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {}, open() {}, close() {} },
    });
    try {
      await saveInstance(
        record({
          pid: process.pid,
          port,
          host: "127.0.0.1",
          rootDir: "/tmp/some-docs",
          // **同定を通す (Issue #132)。** 起動時刻が一致しないと「本人ではない」と
          // 判定され、`yomi down` の案内が出なくなる
          procStartedAt: (await processStartedAt(process.pid)) ?? "",
        }),
        paths,
      );
      const message = await describeServeFailure(addrInUse(), "127.0.0.1", port, paths);
      expect(message).toContain(`ポート ${port} では既に yomi が起動しています`);
      expect(message).toContain(`yomi down --port ${port}`);
      expect(message).toContain("/tmp/some-docs");
    } finally {
      listening.stop(true);
    }
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

/**
 * **pid 再利用で無関係なプロセスを止めない (Issue #132)。**
 *
 * `isThisInstance` は pid の生存とポートの疎通を**独立に**見ていた。
 *
 * - 残骸記録の pid が別プロセスに再利用されて生きている
 * - **無関係な第三者**がそのポートを掴んでいる
 *
 * が同時に成り立つと true になり、`yomi down` が無関係なプロセスへ SIGTERM を送って
 * 「停止しました」と報告した（実測で再現済み）。
 *
 * **起動時刻を突き合わせて同定する**ようにしたのがこの Issue の修正。
 */
describe("pid 再利用で無関係なプロセスを止めない (Issue #132)", () => {
  let workDir: string;
  let stateDir: string;
  let paths: RegistryPaths;
  /** 後片付けで確実に殺す */
  const spawned: ReturnType<typeof Bun.spawn>[] = [];

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "yomi-132-work-"));
    stateDir = await mkdtemp(join(tmpdir(), "yomi-132-state-"));
    paths = resolvePaths({ XDG_STATE_HOME: stateDir });
    await writeFile(join(workDir, "README.md"), "# テスト\n", "utf8");
  });

  afterEach(async () => {
    for (const p of spawned.splice(0)) {
      try {
        p.kill(9);
        await p.exited;
      } catch {
        /* 既に終了している */
      }
    }
    await rm(workDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  /** そのポートを掴む、yomi ではないプロセス */
  async function portHolder(port: number) {
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `Bun.listen({hostname:"127.0.0.1",port:${port},socket:{data(){},open(){},close(){}}});setInterval(()=>{},1000)`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    spawned.push(proc);
    // listen が始まるまで待つ（固定 sleep にしない）
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } }).then((s) =>
          s.end(),
        );
        return proc;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw new Error(`ポート ${port} を掴めませんでした`);
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test(
    "🚨 無関係なプロセスへシグナルを送らない（生き残ることを assert する）",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 41500);
      const victim = await portHolder(port);
      const victimPid = victim.pid;

      // **残骸記録の pid が、その無関係なプロセスに再利用された状態。**
      // 記録の起動時刻は「死んだ yomi のもの」で、犠牲者のものとは一致しない
      await saveInstance(
        record({
          pid: victimPid,
          port,
          host: "127.0.0.1",
          rootDir: workDir,
          procStartedAt: "linux:1",
        }),
        paths,
      );

      const down = await runCli(["down", "--port", String(port)], {
        cwd: workDir,
        state: stateDir,
      });

      // **これが本体。** 以前はここで犠牲者が死に、「停止しました」と報告された
      expect(alive(victimPid)).toBe(true);
      expect(down.stdout + down.stderr).not.toContain("停止しました");
      // 記録は「本人ではない」ので片付けられる
      expect(await readInstances(paths)).toEqual([]);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    "list にも並べない",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 41530);
      const victim = await portHolder(port);
      await saveInstance(
        record({
          pid: victim.pid,
          port,
          host: "127.0.0.1",
          rootDir: workDir,
          procStartedAt: "linux:1",
        }),
        paths,
      );

      const listed = await runCli(["list"], { cwd: workDir, state: stateDir });

      expect(listed.stdout).toContain("起動中の yomi はありません");
      expect(listed.stdout).not.toContain(String(victim.pid));
      expect(alive(victim.pid)).toBe(true);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    "起動前検査が無関係なプロセスを yomi と名指ししない",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 41560);
      const victim = await portHolder(port);
      await saveInstance(
        record({
          pid: victim.pid,
          port,
          host: "127.0.0.1",
          rootDir: workDir,
          procStartedAt: "linux:1",
        }),
        paths,
      );

      const res = await runCli(["--port", String(port), "--no-open"], {
        cwd: workDir,
        state: stateDir,
      });

      expect(res.code).toBe(1);
      // ポートは実際に埋まっているので「使用されています」が正しい。
      // **「yomi が起動しています」と言ってはいけない**（無関係なプロセスなので）
      expect(res.stderr).toContain(`ポート ${port} は既に使用されています`);
      expect(res.stderr).not.toContain("既に yomi が起動しています");
      expect(alive(victim.pid)).toBe(true);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  /**
   * **応答しなくなった yomi は止められること。**
   *
   * 以前は疎通を同定の条件にしていたので、ハングして listen が落ちた yomi に対して
   * 「既に終了していました」と**記録だけ消して本体を生き残らせて**いた。
   * `down` が最も要るのはこの状況なので、同定から疎通を外した。
   */
  test(
    "ポートを掴んでいない本物の yomi も止められる",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 41590);
      // listen していないプロセス = ハングした yomi の代理
      const hung = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      spawned.push(hung);
      await new Promise((r) => setTimeout(r, 300));

      await saveInstance(
        record({
          pid: hung.pid,
          port,
          host: "127.0.0.1",
          rootDir: workDir,
          // **本人**の起動時刻
          procStartedAt: (await processStartedAt(hung.pid)) ?? "",
        }),
        paths,
      );

      const down = await runCli(["down", "--port", String(port)], {
        cwd: workDir,
        state: stateDir,
      });

      expect(down.stdout).toContain("停止しました");
      const deadline = Date.now() + 5_000;
      while (alive(hung.pid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(alive(hung.pid)).toBe(false);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  /**
   * **v0.21.0 以前の記録には起動時刻が無い。**
   *
   * 同定できないので従来の判定（pid 生存 + 疎通）へ落ちる。落とさないと、上げた直後に
   * 既存のインスタンスを `down` できなくなる。**記録は起動のたびに書き直される**ので、
   * この縮退は次の再起動までの窓に限られる。
   */
  /**
   * **記録に起動時刻が実際に入っていること。**
   *
   * 入っていないと `isThisInstance` が従来の判定へ落ちるので、**同定が黙って無効になる**
   * （他のテストは古い記録の縮退経路を通って通ってしまう）。書き手は 2 つあるので両方見る。
   */
  test(
    "起動した yomi の記録に、実際の起動時刻が入る（バックグラウンド）",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 41650);
      const up = await runCli(["up", "-d", "--port", String(port)], {
        cwd: workDir,
        state: stateDir,
      });
      expect(up.code).toBe(0);

      const records = await readInstances(paths);
      expect(records).toHaveLength(1);
      const rec = records[0] as InstanceRecord;
      expect(rec.procStartedAt).not.toBe("");
      // **実際にそのプロセスのものであること**（固定値を書いているだけではない）
      expect(rec.procStartedAt).toBe((await processStartedAt(rec.pid)) as string);

      await runCli(["down", "--port", String(port)], { cwd: workDir, state: stateDir });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    "起動した yomi の記録に、実際の起動時刻が入る（フォアグラウンド）",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 41680);
      const proc = Bun.spawn([process.execPath, ENTRY, "--port", String(port), "--no-open"], {
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
      const rec = records[0] as InstanceRecord;
      expect(rec.procStartedAt).not.toBe("");
      expect(rec.procStartedAt).toBe((await processStartedAt(rec.pid)) as string);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  /**
   * **`list` は「応答しているもの」を出す (Issue #69)。**
   *
   * 同定（起動時刻の一致）だけで出すと、ハングして listen が落ちた yomi まで
   * 「起動中」に見える。#69 が決めた「一覧に出したものは down で止められるべき」は
   * 保ったまま、疎通も条件に残す。
   */
  test(
    "同定できても応答していない記録は list に出ない",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 41710);
      // listen していない = 応答しない。ただし記録の起動時刻は本人のもの
      const quiet = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      spawned.push(quiet);
      await new Promise((r) => setTimeout(r, 300));
      await saveInstance(
        record({
          pid: quiet.pid,
          port,
          host: "127.0.0.1",
          rootDir: workDir,
          procStartedAt: (await processStartedAt(quiet.pid)) ?? "",
        }),
        paths,
      );

      const listed = await runCli(["list"], { cwd: workDir, state: stateDir });

      expect(listed.stdout).toContain("起動中の yomi はありません");
      expect(listed.stdout).not.toContain(String(quiet.pid));
    },
    INTEGRATION_TIMEOUT_MS,
  );

  /**
   * **🚨 古い記録（v0.21.0 以前）でも無関係なプロセスを殺さない。**
   *
   * 起動時刻を持たない記録では同定できないので、以前は「pid 生存 + 疎通」へ落ちていた。
   * **それだと #132 がそのまま残る** —— しかも危険な配置では記録が掃除されないので、
   * 「次の再起動までの窓」ではなく無期限に残る。実際に古い形式の記録で
   * 無関係なプロセスを殺せることを再現した。
   *
   * 縮退経路に「そもそも yomi か」を足して塞いだ。
   */
  /**
   * **`yomi list` が生きた yomi を孤児にしない (Issue #132)。**
   *
   * ハングした yomi に対して利用者が最初にやることが `list` で、そこで記録を消していた。
   * 消えると `down` から辿れなくなり、**生きたプロセスが恒久的に孤児**になる。
   * 一覧には出さないが、記録は残す。
   */
  test(
    "list は、同定できたが応答していない記録を消さない",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 41770);
      const quiet = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      spawned.push(quiet);
      await new Promise((r) => setTimeout(r, 300));
      await saveInstance(
        record({
          pid: quiet.pid,
          port,
          host: "127.0.0.1",
          rootDir: workDir,
          procStartedAt: (await processStartedAt(quiet.pid)) ?? "",
        }),
        paths,
      );

      const listed = await runCli(["list"], { cwd: workDir, state: stateDir });
      expect(listed.stdout).toContain("起動中の yomi はありません");

      // **記録が残っていること。** 消えていると、このあと down できない
      expect((await readInstances(paths)).map((r) => r.pid)).toEqual([quiet.pid]);

      // 実際に down できる
      const down = await runCli(["down", "--port", String(port)], {
        cwd: workDir,
        state: stateDir,
      });
      expect(down.stdout).toContain("停止しました");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    "起動時刻を持たない古い記録でも、yomi でないプロセスは止めない",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 41620);
      const victim = await portHolder(port);
      const victimPid = victim.pid;
      await saveInstance(
        record({
          pid: victimPid,
          port,
          host: "127.0.0.1",
          rootDir: workDir,
          procStartedAt: "", // v0.21.0 以前の記録
        }),
        paths,
      );

      // **`list` を先に打たない。** `servingInstances` が記録を掃除するので、
      // 先に打つと `down` に届く前に記録が消えて**この検証が空振りする**
      // （実際に一度そう書いて、down 側のガードを外しても落ちないテストになっていた）
      const down = await runCli(["down", "--port", String(port)], {
        cwd: workDir,
        state: stateDir,
      });
      expect(down.stdout + down.stderr).not.toContain("停止しました");
      expect(alive(victimPid)).toBe(true);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test(
    "起動時刻を持たない古い記録でも、list と起動検査が yomi と名指ししない",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 41800);
      const victim = await portHolder(port);
      const victimPid = victim.pid;
      await saveInstance(
        record({ pid: victimPid, port, host: "127.0.0.1", rootDir: workDir, procStartedAt: "" }),
        paths,
      );

      const listed = await runCli(["list"], { cwd: workDir, state: stateDir });
      expect(listed.stdout).not.toContain(String(victimPid));

      const start = await runCli(["--port", String(port), "--no-open"], {
        cwd: workDir,
        state: stateDir,
      });
      expect(start.stderr).not.toContain("既に yomi が起動しています");
      expect(alive(victimPid)).toBe(true);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  /**
   * **古い記録でも、本物の yomi なら従来どおり扱える。**
   *
   * 縮退を締めたことで「上げた直後に既存のインスタンスを down できない」を作っていないか。
   */
  test(
    "起動時刻を持たない古い記録でも、本物の yomi は止められる",
    async () => {
      const port = await findAvailablePort("127.0.0.1", 41740);
      const up = await runCli(["up", "-d", "--port", String(port)], {
        cwd: workDir,
        state: stateDir,
      });
      expect(up.code).toBe(0);

      // **記録を v0.21.0 以前の形式へ落とす**（起動時刻を消す）
      const before = await readInstances(paths);
      const rec = before[0] as InstanceRecord;
      await saveInstance({ ...rec, procStartedAt: "" }, paths);

      const listed = await runCli(["list"], { cwd: workDir, state: stateDir });
      expect(listed.stdout).toContain(String(rec.pid));

      const down = await runCli(["down", "--port", String(port)], {
        cwd: workDir,
        state: stateDir,
      });
      expect(down.stdout).toContain("停止しました");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
