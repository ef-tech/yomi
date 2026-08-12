/**
 * プロセスの起動時刻の読み取り (Issue #132)。
 *
 * ここが壊れると **pid の同定が黙って効かなくなる** —— `isThisInstance` は
 * 「読めなければ本人ではない」に倒すので、常に null を返すようになっても
 * エラーにはならず、`yomi down` が「既に終了していました」を返し続ける。
 * だから**値が取れること**と**プロセスごとに違うこと**の両方を見る。
 */

import { describe, expect, test } from "bun:test";
import { processStartedAt } from "../src/util/proc-start.ts";

/** この OS で読み取りに対応しているか。未対応なら常に null が正しい挙動 */
const SUPPORTED = process.platform === "linux" || process.platform === "darwin";

describe("processStartedAt", () => {
  test.each([[0], [-1], [1.5], [Number.NaN]])("不正な pid (%p) は null", async (pid) => {
    expect(await processStartedAt(pid)).toBeNull();
  });

  test("居ない pid は null", async () => {
    // 32bit の pid 上限に近い値。実在する見込みはほぼ無い
    expect(await processStartedAt(2 ** 22 - 1)).toBeNull();
  });

  test.skipIf(!SUPPORTED)("自分の pid からは値が取れる", async () => {
    const got = await processStartedAt(process.pid);
    expect(got).not.toBeNull();
    expect(got).toContain(`${process.platform}:`);
  });

  test.skipIf(!SUPPORTED)("同じプロセスを 2 回読んでも変わらない", async () => {
    const first = await processStartedAt(process.pid);
    await new Promise((r) => setTimeout(r, 300));
    expect(await processStartedAt(process.pid)).toBe(first as string);
  });

  /**
   * **ここが同定の要。**
   *
   * 別プロセスなら別の値になることを見る。`/proc/<pid>/stat` の読み取り位置を 1 つ
   * ずらすと、そこは常に 0 のフィールド（`itrealvalue`）なので**どのプロセスでも
   * 同じ値**になり、pid 再利用を見分けられなくなる。
   */
  test.skipIf(!SUPPORTED)("別々のプロセスは別の値になる", async () => {
    const a = Bun.spawn(["sleep", "10"], { stdout: "ignore", stderr: "ignore" });
    // 起動時刻の分解能を跨ぐ（Linux は clock tick、macOS は 1 秒）
    await new Promise((r) => setTimeout(r, 1100));
    const b = Bun.spawn(["sleep", "10"], { stdout: "ignore", stderr: "ignore" });
    await new Promise((r) => setTimeout(r, 100));
    try {
      const [sa, sb] = await Promise.all([processStartedAt(a.pid), processStartedAt(b.pid)]);
      expect(sa).not.toBeNull();
      expect(sb).not.toBeNull();
      expect(sa).not.toBe(sb as string);
    } finally {
      a.kill(9);
      b.kill(9);
      await Promise.all([a.exited, b.exited]);
    }
  });

  test.skipIf(!SUPPORTED)("終了したプロセスの pid は null に戻る", async () => {
    const proc = Bun.spawn(["sleep", "10"], { stdout: "ignore", stderr: "ignore" });
    await new Promise((r) => setTimeout(r, 200));
    expect(await processStartedAt(proc.pid)).not.toBeNull();

    proc.kill(9);
    await proc.exited;
    // reap されるまで少し待つ（zombie のあいだは /proc が残る）
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await processStartedAt(proc.pid)) !== null) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await processStartedAt(proc.pid)).toBeNull();
  });

  test.skipIf(process.platform !== "linux")(
    "名前に空白や括弧を含むプロセスでも読める",
    async () => {
      // `/proc/<pid>/stat` の 2 番目 (comm) は括弧で囲まれ、**中に括弧や空白が入りうる**。
      // 単純な split では位置がずれるので、最後の `)` から数える実装になっている
      const dir = await Bun.file("/proc/self/stat").text();
      expect(dir).toContain("(");

      const proc = Bun.spawn(["sleep", "10"], { stdout: "ignore", stderr: "ignore" });
      await new Promise((r) => setTimeout(r, 200));
      try {
        expect(await processStartedAt(proc.pid)).toMatch(/^linux:\d+$/);
      } finally {
        proc.kill(9);
        await proc.exited;
      }
    },
  );
});
