import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECK_INTERVAL_MS,
  DEFAULT_STALL_THRESHOLD_MS,
  DISABLE_ENV,
  HEARTBEAT_INTERVAL_MS,
  startWatchdog,
  TIMEOUT_ENV,
} from "../src/watchdog.ts";

interface RunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  pid: number;
}

/**
 * 子プロセスを起こして終了コードと出力を返す。
 *
 * watchdog は **プロセスを SIGKILL する** のが仕事なので、同一プロセス内では検証できない
 * (テストランナーごと落ちる)。実際にプロセスを起こして殺されることを確認する。
 *
 * `onStart` には子の pid を渡す。SIGSTOP でプロセスを凍結させる等、外から操作するテスト用。
 */
async function runScript(
  source: string,
  timeoutMs: number,
  onStart?: (pid: number) => Promise<void>,
  env?: Record<string, string>,
): Promise<RunResult> {
  const dir = await mkdtemp(join(tmpdir(), "yomi-watchdog-"));
  const file = join(dir, "script.ts");
  await writeFile(file, source);
  try {
    const proc = Bun.spawn(["bun", "run", file], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: dir,
      env: { ...process.env, ...env },
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    const driver = onStart ? onStart(proc.pid) : Promise.resolve();
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      driver,
    ]);
    await proc.exited;
    clearTimeout(timer);
    return { exitCode: proc.exitCode, signal: proc.signalCode, stdout, stderr, pid: proc.pid };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** メインスレッドを futex で寝かせる (#89 が観測した `futex_do_wait` と同じ状態を作る)。 */
const BLOCK_MAIN_THREAD = `
  const lock = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(lock, 0, 0, 30000);   // 誰も notify しないので寝たまま
`;

const WATCHDOG_PATH = JSON.stringify(join(import.meta.dir, "..", "src", "watchdog.ts"));

/**
 * watchdog が**実際に起動している**ことを子プロセスの stdout で証明する。
 *
 * これが無いと「殺されないこと」を見るテストが、watchdog が一度も起動しなかった世界でも
 * 通ってしまう (vacuous)。`enabled` は起動の成否を返すので、これを出力させて assert する。
 */
const PROVE_ENABLED = `
  if (!wd.enabled) { console.log("WATCHDOG-DISABLED"); } else { console.log("WATCHDOG-ENABLED"); }
`;

describe("watchdog — event loop 停止の検知と自力復帰 (Issue #91)", () => {
  // Issue #89 の症状 2「Ctrl+C でも停止できない」の**因果そのもの**を固定する。
  // signal ハンドラは event loop から dispatch されるため、メインスレッドが futex で
  // 寝ていると SIGINT も SIGTERM も届かない。これが watchdog を入れた理由。
  test("メインスレッドがブロックすると SIGINT / SIGTERM が dispatch されない", async () => {
    const result = await runScript(
      `
      process.on("SIGINT", () => console.log("SIGINT-DISPATCHED"));
      process.on("SIGTERM", () => console.log("SIGTERM-DISPATCHED"));
      console.log("READY");
      setTimeout(() => { ${BLOCK_MAIN_THREAD} }, 300);
      `,
      8000,
      async (pid) => {
        await sleep(1500); // ブロックに入るのを待つ
        for (let i = 0; i < 3; i++) {
          process.kill(pid, "SIGINT");
          await sleep(200);
        }
        process.kill(pid, "SIGTERM");
        await sleep(500);
      },
    );
    expect(result.stdout).toContain("READY");
    expect(result.stdout).not.toContain("SIGINT-DISPATCHED");
    expect(result.stdout).not.toContain("SIGTERM-DISPATCHED");
    // シグナルでは死なず、親のタイムアウトによる SIGKILL でしか終われなかった
    expect(result.signal).toBe("SIGKILL");
  }, 20000);

  test("ブロックを検知してプロセスを終了させる", async () => {
    const result = await runScript(
      `
      import { startWatchdog } from ${WATCHDOG_PATH};
      const wd = startWatchdog({ stallThresholdMs: 1500, heartbeatIntervalMs: 100, checkIntervalMs: 100, ignoreEnv: true });
      ${PROVE_ENABLED}
      setTimeout(() => { ${BLOCK_MAIN_THREAD} }, 300);
      `,
      15000,
    );
    expect(result.stdout).toContain("WATCHDOG-ENABLED");
    expect(result.signal).toBe("SIGKILL");
    // **理由を残さずに殺さない。** 利用者が原因を追えるよう stderr に出す
    expect(result.stderr).toContain("応答していません");
    expect(result.stderr).toContain("issues/91");
    // 誤検知時の逃げ道を案内する
    expect(result.stderr).toContain(DISABLE_ENV);
  }, 25000);

  // SIGKILL すると原因を追う材料が消える。#91 の根本原因は未特定なので、
  // 次に踏んだ人が「どのスレッドがどこで待っていたか」を報告できる必要がある。
  test.skipIf(process.platform !== "linux")(
    "落とす前に診断情報を残し、メインスレッドを特定できる",
    async () => {
      const result = await runScript(
        `
      import { startWatchdog } from ${WATCHDOG_PATH};
      const wd = startWatchdog({ stallThresholdMs: 1500, heartbeatIntervalMs: 100, checkIntervalMs: 100, ignoreEnv: true });
      ${PROVE_ENABLED}
      setTimeout(() => { ${BLOCK_MAIN_THREAD} }, 300);
      `,
        15000,
      );
      expect(result.signal).toBe("SIGKILL");
      expect(result.stderr).toContain("スレッドの状態");
      // Bun の worker スレッドは平常時から全部 futex_do_wait にいるので、
      // 「futex_do_wait が含まれる」だけでは異常を捉えたことにならない。
      // **メインスレッドの印が付いた行**を見る (#89 の核心はメインが futex にいたこと)。
      const mainLine = result.stderr.split("\n").find((l) => l.includes("<<< メインスレッド"));
      expect(mainLine).toBeDefined();
      expect(mainLine).toContain("wchan=futex_do_wait");
      // pid が無いとどの tid がメインか受け取った側で判別できない
      expect(result.stderr).toContain(`pid=${result.pid}`);
      expect(mainLine).toContain(`tid=${result.pid}`);
      // 稼働時間は #89 の最重要データ。0 で通らないこと (Worker の uptime と取り違えない)
      const uptime = result.stderr.match(/稼働時間: (\d+) 秒/);
      expect(uptime).not.toBeNull();
      expect(Number(uptime?.[1])).toBeGreaterThan(0);
    },
    25000,
  );

  test("健全なプロセスは殺さず、仕事が終われば通常どおり終了する", async () => {
    const result = await runScript(
      `
      import { startWatchdog } from ${WATCHDOG_PATH};
      const wd = startWatchdog({ stallThresholdMs: 600, heartbeatIntervalMs: 50, checkIntervalMs: 50, ignoreEnv: true });
      ${PROVE_ENABLED}
      let ticks = 0;
      const timer = setInterval(() => {
        if (++ticks >= 60) { clearInterval(timer); console.log("SURVIVED"); }
      }, 50);
      `,
      15000,
    );
    expect(result.stdout).toContain("WATCHDOG-ENABLED");
    expect(result.stdout).toContain("SURVIVED");
    expect(result.signal).toBeNull();
    expect(result.exitCode).toBe(0);
  }, 25000);

  // **誤検知でユーザーの健全なサーバを殺さないことが最大の要件。**
  // ノート PC のスリープではプロセス全体が凍結し、復帰時に心拍が「古く」見える。
  // SIGSTOP はこれを決定論的に再現できる (プロセス全体が止まる点が同じ)。
  test.skipIf(process.platform !== "linux")(
    "サスペンド (SIGSTOP) からの復帰を停止と誤検知しない",
    async () => {
      const result = await runScript(
        `
      import { startWatchdog } from ${WATCHDOG_PATH};
      const wd = startWatchdog({ stallThresholdMs: 1000, heartbeatIntervalMs: 100, checkIntervalMs: 100, resumeGraceMs: 1000, ignoreEnv: true });
      ${PROVE_ENABLED}
      let ticks = 0;
      const timer = setInterval(() => {
        if (++ticks >= 120) { clearInterval(timer); console.log("SURVIVED"); }
      }, 100);
      `,
        30000,
        async (pid) => {
          await sleep(1000);
          // 閾値 (1 秒) の 5 倍だけ凍結させる。凍結判定が無ければ確実に殺される長さ
          process.kill(pid, "SIGSTOP");
          await sleep(5000);
          process.kill(pid, "SIGCONT");
          await sleep(3000);
        },
      );
      expect(result.stdout).toContain("WATCHDOG-ENABLED");
      expect(result.stdout).toContain("SURVIVED");
      expect(result.signal).toBeNull();
      expect(result.stderr).not.toContain("応答していません");
    },
    45000,
  );

  // 凍結からの復帰後も監視は生き続けなければならない。猶予が「以後ずっと無効」に
  // なっていたら、サスペンドを 1 度挟んだだけで watchdog が死ぬ。
  test.skipIf(process.platform !== "linux")(
    "サスペンド復帰後も本物の停止は検知する",
    async () => {
      const result = await runScript(
        `
      import { startWatchdog } from ${WATCHDOG_PATH};
      const wd = startWatchdog({ stallThresholdMs: 1000, heartbeatIntervalMs: 100, checkIntervalMs: 100, resumeGraceMs: 1000, ignoreEnv: true });
      ${PROVE_ENABLED}
      let ticks = 0;
      const timer = setInterval(() => { ticks++; }, 100);
      // 凍結が明けたずっと後で本物のブロックに入る
      setTimeout(() => { clearInterval(timer); ${BLOCK_MAIN_THREAD} }, 9000);
      `,
        30000,
        async (pid) => {
          await sleep(1000);
          process.kill(pid, "SIGSTOP");
          await sleep(4000);
          process.kill(pid, "SIGCONT");
        },
      );
      expect(result.stdout).toContain("WATCHDOG-ENABLED");
      expect(result.signal).toBe("SIGKILL");
      expect(result.stderr).toContain("応答していません");
    },
    45000,
  );

  // watchdog が unref されていないと、サーバを閉じてもプロセスが終わらない
  // (Worker と心拍タイマーが event loop を生かし続ける)。
  test("watchdog はプロセスの生存を延ばさない", async () => {
    const result = await runScript(
      `
      import { startWatchdog } from ${WATCHDOG_PATH};
      const wd = startWatchdog({ stallThresholdMs: 60000, heartbeatIntervalMs: 1000, checkIntervalMs: 1000, ignoreEnv: true });
      ${PROVE_ENABLED}
      console.log("DONE");
      // 他に保留中の仕事は無い。watchdog が unref されていればここで終了する
      `,
      8000,
    );
    expect(result.stdout).toContain("WATCHDOG-ENABLED");
    expect(result.stdout).toContain("DONE");
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
  }, 15000);

  test("close() すると監視が止まり、その後ブロックしても殺されない", async () => {
    const result = await runScript(
      `
      import { startWatchdog } from ${WATCHDOG_PATH};
      const wd = startWatchdog({ stallThresholdMs: 500, heartbeatIntervalMs: 50, checkIntervalMs: 50, ignoreEnv: true });
      ${PROVE_ENABLED}
      wd.close();
      const lock = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(lock, 0, 0, 3000);
      console.log("SURVIVED");
      `,
      15000,
    );
    expect(result.stdout).toContain("WATCHDOG-ENABLED");
    expect(result.stdout).toContain("SURVIVED");
    expect(result.signal).toBeNull();
  }, 25000);

  // **プロセスを強制終了する機能に無効化手段が無いのは可逆性の点で釣り合わない。**
  // 根本原因が未特定である以上、この heuristic が全環境で正しく振る舞う保証はない。
  test(`${DISABLE_ENV}=1 で無効化でき、ブロックしても殺されない`, async () => {
    const result = await runScript(
      `
      import { startWatchdog } from ${WATCHDOG_PATH};
      const wd = startWatchdog({ stallThresholdMs: 500, heartbeatIntervalMs: 50, checkIntervalMs: 50 });
      ${PROVE_ENABLED}
      const lock = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(lock, 0, 0, 3000);
      console.log("SURVIVED");
      `,
      15000,
      undefined,
      { [DISABLE_ENV]: "1" },
    );
    expect(result.stdout).toContain("WATCHDOG-DISABLED");
    expect(result.stdout).toContain("SURVIVED");
    expect(result.signal).toBeNull();
  }, 25000);

  test(`${TIMEOUT_ENV} で閾値を変更できる`, async () => {
    const result = await runScript(
      `
      import { startWatchdog } from ${WATCHDOG_PATH};
      const wd = startWatchdog({ heartbeatIntervalMs: 100, checkIntervalMs: 100 });
      ${PROVE_ENABLED}
      setTimeout(() => { ${BLOCK_MAIN_THREAD} }, 300);
      `,
      15000,
      undefined,
      { [TIMEOUT_ENV]: "1200" },
    );
    // 既定の 60 秒のままなら親のタイムアウト (15 秒) までに殺されない
    expect(result.stdout).toContain("WATCHDOG-ENABLED");
    expect(result.signal).toBe("SIGKILL");
    expect(result.stderr).toContain("応答していません");
  }, 25000);

  // 心拍が閾値より粗いと健全なプロセスを必ず殺す。誤設定は既定値へ戻す。
  test("心拍が閾値より粗い設定は既定値へ戻し、健全なプロセスを殺さない", async () => {
    const result = await runScript(
      `
      import { startWatchdog } from ${WATCHDOG_PATH};
      // 心拍 2 秒に対し閾値 300ms = そのまま使えば必ず誤検知する
      const wd = startWatchdog({ stallThresholdMs: 300, heartbeatIntervalMs: 2000, checkIntervalMs: 100, ignoreEnv: true });
      ${PROVE_ENABLED}
      let ticks = 0;
      const timer = setInterval(() => { if (++ticks >= 40) { clearInterval(timer); console.log("SURVIVED"); } }, 100);
      `,
      15000,
    );
    expect(result.stderr).toContain("応答監視の設定が不正です");
    expect(result.stdout).toContain("SURVIVED");
    expect(result.signal).toBeNull();
  }, 25000);

  test("既定値は誤検知しにくい側に倒してある", () => {
    // 健全な event loop は 1 秒間隔のタイマーを取りこぼさない。想定される最長の
    // 同期処理より一桁大きく取ることで、重い処理を停止と誤認しない。
    expect(DEFAULT_STALL_THRESHOLD_MS).toBeGreaterThanOrEqual(30_000);
    // 心拍とチェックは閾値より十分細かいこと (粗いと検知が閾値どおりに効かない)
    expect(HEARTBEAT_INTERVAL_MS * 10).toBeLessThanOrEqual(DEFAULT_STALL_THRESHOLD_MS);
    expect(CHECK_INTERVAL_MS * 10).toBeLessThanOrEqual(DEFAULT_STALL_THRESHOLD_MS);
  });

  test("close() は多重呼び出しでも壊れない", () => {
    const wd = startWatchdog({ stallThresholdMs: 60_000, ignoreEnv: true });
    expect(wd.enabled).toBe(true);
    expect(() => {
      wd.close();
      wd.close();
    }).not.toThrow();
  });
});
