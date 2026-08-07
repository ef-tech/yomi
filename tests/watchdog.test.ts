import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECK_INTERVAL_MS,
  DEFAULT_STALL_THRESHOLD_MS,
  HEARTBEAT_INTERVAL_MS,
  startWatchdog,
} from "../src/watchdog.ts";

/**
 * 子プロセスを起こして終了コードと出力を返す。
 *
 * watchdog は **プロセスを SIGKILL する** のが仕事なので、同一プロセス内では検証できない
 * (テストランナーごと落ちる)。実際にプロセスを起こして殺されることを確認する。
 */
async function runScript(
  source: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), "yomi-watchdog-"));
  const file = join(dir, "script.ts");
  await writeFile(file, source);
  try {
    const proc = Bun.spawn(["bun", "run", file], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: dir,
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    clearTimeout(timer);
    return {
      exitCode: proc.exitCode,
      signal: proc.signalCode,
      stdout,
      stderr,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** メインスレッドを futex で寝かせる (#89 が観測した `futex_do_wait` と同じ状態を作る)。 */
const BLOCK_MAIN_THREAD = `
  const lock = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(lock, 0, 0, 30000);   // 誰も notify しないので寝たまま
`;

const WATCHDOG_PATH = JSON.stringify(join(import.meta.dir, "..", "src", "watchdog.ts"));

describe("watchdog — event loop 停止の検知と自力復帰 (Issue #91)", () => {
  // Issue #89 の症状 2「Ctrl+C でも停止できない」の**因果そのもの**を固定する。
  // signal ハンドラは event loop から dispatch されるため、メインスレッドが futex で
  // 寝ていると SIGINT も SIGTERM も届かない。これが watchdog を入れた理由。
  test("メインスレッドがブロックすると SIGINT / SIGTERM が dispatch されない", async () => {
    const result = await runScript(
      `
      let received = 0;
      process.on("SIGINT", () => { received++; console.log("SIGINT-DISPATCHED"); });
      process.on("SIGTERM", () => { received++; console.log("SIGTERM-DISPATCHED"); });
      console.log("READY");
      // READY を読んだ親がシグナルを送れるよう、少しだけ event loop を回してからブロックする
      setTimeout(() => { ${BLOCK_MAIN_THREAD} }, 300);
      `,
      6000,
    );
    // 親のタイムアウトで SIGKILL される = シグナルで死ななかった
    expect(result.stdout).toContain("READY");
    expect(result.stdout).not.toContain("SIGINT-DISPATCHED");
    expect(result.stdout).not.toContain("SIGTERM-DISPATCHED");
  }, 15000);

  test("ブロックを検知してプロセスを終了させる", async () => {
    const result = await runScript(
      `
      import { startWatchdog } from ${WATCHDOG_PATH};
      startWatchdog({ stallThresholdMs: 1500, heartbeatIntervalMs: 100, checkIntervalMs: 100 });
      console.log("READY");
      setTimeout(() => { ${BLOCK_MAIN_THREAD} }, 300);
      `,
      15000,
    );
    expect(result.stdout).toContain("READY");
    expect(result.signal).toBe("SIGKILL");
    // **理由を残さずに殺さない。** 利用者が原因を追えるよう stderr に出す
    expect(result.stderr).toContain("メインスレッドが");
    expect(result.stderr).toContain("応答していません");
    expect(result.stderr).toContain("issues/91");
  }, 25000);

  // SIGKILL すると原因を追う材料が消える。#91 の根本原因は未特定なので、
  // 次に踏んだ人が「どのスレッドがどこで待っていたか」を報告できる必要がある。
  test.skipIf(process.platform !== "linux")(
    "落とす前にスレッドの wchan を記録する",
    async () => {
      const result = await runScript(
        `
      import { startWatchdog } from ${WATCHDOG_PATH};
      startWatchdog({ stallThresholdMs: 1500, heartbeatIntervalMs: 100, checkIntervalMs: 100 });
      console.log("READY");
      setTimeout(() => { ${BLOCK_MAIN_THREAD} }, 300);
      `,
        15000,
      );
      expect(result.signal).toBe("SIGKILL");
      expect(result.stderr).toContain("スレッドの状態");
      // メインスレッドが futex で寝ている = #89 が観測した壊れ方そのもの
      expect(result.stderr).toContain("wchan=futex_do_wait");
      expect(result.stderr).toMatch(/稼働時間: \d+ 秒/);
    },
    25000,
  );

  test("健全なプロセスは殺さず、仕事が終われば通常どおり終了する", async () => {
    const result = await runScript(
      `
      import { startWatchdog } from ${WATCHDOG_PATH};
      startWatchdog({ stallThresholdMs: 500, heartbeatIntervalMs: 50, checkIntervalMs: 50 });
      // 閾値の何倍も event loop を回し続ける (毎 tick 心拍が更新される)
      let ticks = 0;
      const timer = setInterval(() => {
        if (++ticks >= 60) { clearInterval(timer); console.log("SURVIVED"); }
      }, 50);
      `,
      15000,
    );
    expect(result.stdout).toContain("SURVIVED");
    expect(result.signal).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("応答していません");
  }, 25000);

  // watchdog が unref されていないと、サーバを閉じてもプロセスが終わらない
  // (Worker と心拍タイマーが event loop を生かし続ける)。
  test("watchdog はプロセスの生存を延ばさない", async () => {
    const result = await runScript(
      `
      import { startWatchdog } from ${WATCHDOG_PATH};
      startWatchdog({ stallThresholdMs: 60000, heartbeatIntervalMs: 1000, checkIntervalMs: 1000 });
      console.log("DONE");
      // 他に保留中の仕事は無い。watchdog が unref されていればここで終了する
      `,
      8000,
    );
    expect(result.stdout).toContain("DONE");
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
  }, 15000);

  test("close() すると監視が止まり、その後ブロックしても殺されない", async () => {
    const result = await runScript(
      `
      import { startWatchdog } from ${WATCHDOG_PATH};
      const wd = startWatchdog({ stallThresholdMs: 500, heartbeatIntervalMs: 50, checkIntervalMs: 50 });
      wd.close();
      console.log("CLOSED");
      // 閾値の何倍もブロックする。監視が生きていれば SIGKILL されるはず
      const lock = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(lock, 0, 0, 3000);
      console.log("SURVIVED");
      `,
      15000,
    );
    expect(result.stdout).toContain("CLOSED");
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
    const wd = startWatchdog({ stallThresholdMs: 60_000 });
    expect(() => {
      wd.close();
      wd.close();
    }).not.toThrow();
  });
});
