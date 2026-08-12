/**
 * プロセスの起動時刻の読み取り (Issue #132)。
 *
 * ここが壊れると **pid の同定が黙って効かなくなる** —— `isThisInstance` は
 * 「読めなければ本人ではない」に倒すので、常に null を返すようになっても
 * エラーにはならず、`yomi down` が「既に終了していました」を返し続ける。
 * だから**値が取れること**と**プロセスごとに違うこと**の両方を見る。
 */

import { describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartedAt } from "../src/util/proc-start.ts";

/**
 * `/proc/<pid>/stat` から starttime（22 番目）を、実装とは**独立に**取り出す。
 *
 * 実装と同じ関数を使うと「同じ間違いで書いて読む」ことになるので、ここは
 * `stat` の仕様どおりに素直に書く。
 */
function starttimeOf(stat: string): string {
  const after = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  // `)` の次が state（3 番目）。22 番目はそこから 19 個先
  return after[19] as string;
}

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

  /**
   * **`/proc/<pid>/stat` の 2 番目 (comm) は括弧で囲まれ、中に括弧や空白が入りうる。**
   *
   * 単純な `split(" ")` や `indexOf(")")` では位置がずれるので、実装は**最後の `)`**
   * から数えている。**実際にそういう名前のプロセスを起こして確かめる** ——
   * `sleep` のような普通の名前だけで試すと、この堅牢化を何も守れない。
   */
  test.skipIf(process.platform !== "linux")(
    "名前に空白や括弧を含むプロセスでも読める",
    async () => {
      // comm は実行ファイル名から取られる。**Linux では括弧も空白も合法なファイル名**
      const dir = await mkdtemp(join(tmpdir(), "yomi-comm-"));
      const weird = join(dir, "ev ) il (x");
      // **`sh` を使う。** `sleep` は uutils の multicall（argv[0] で動きを決める）で、
      // 名前を変えると起動に失敗する環境がある（実際に踏んだ）
      const shBin = Bun.which("sh");
      expect(shBin).not.toBeNull();
      await copyFile(shBin as string, weird);
      // `copyFile` がモードを引き継がない環境があるので実行権を明示する
      await chmod(weird, 0o755);
      // `read` で標準入力を待たせる。**`exec` で別コマンドに変えない** ——
      // comm がそちらの名前になってしまい、狙った名前で試せなくなる
      const proc = Bun.spawn([weird, "-c", "read x"], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        await new Promise((r) => setTimeout(r, 300));
        // 前提: 狙った comm になっていること（なっていなければこのテストは無意味）
        const stat = await readFile(`/proc/${proc.pid}/stat`, "utf-8");
        expect(stat).toContain(") il (x)");

        // **値そのものを独立に検算する。** 「数値が入っている」だけだと、
        // 読み取り位置がずれていても通ってしまう（別のフィールドも数値なので）
        const expected = starttimeOf(stat);
        const got = await processStartedAt(proc.pid);
        expect(got).not.toBeNull();
        expect((got as string).endsWith(`:${expected}`)).toBe(true);
      } finally {
        proc.kill(9);
        await proc.exited;
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
