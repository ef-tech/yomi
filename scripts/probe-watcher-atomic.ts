#!/usr/bin/env bun

/**
 * atomic save (temp + rename) を chokidar が検知するかの計測 (Issue #119 / #122)。
 *
 * ```
 * bun run scripts/probe-watcher-atomic.ts        # 各条件 20 回
 * bun run scripts/probe-watcher-atomic.ts 50     # 試行回数を指定
 * ```
 *
 * ## なぜ残すか
 *
 * `writeFileAtomic` (Issue #101) は temp へ書いてから rename で差し替えるが、**この経路の
 * 変更を watcher が取りこぼすことがある**。当初これを「chokidar は既存ファイルへの rename で
 * `change` を発火しない」と決定論的に記録してしまったが、**1 回きりの計測を一般化した誤り**
 * だった (#122)。同じ失敗を繰り返さないよう、**何をどう測ったかをコードとして残す**。
 *
 * 数値は環境依存なので、**docstring や CHANGELOG の数字を疑ったらこれを回して測り直す**こと。
 *
 * ## 測り方の方針
 *
 * - **素の chokidar で測る。** `createWatcher` 経由だと 80ms の debounce と `isOwnSave` が
 *   経路に入り、「watcher が取りこぼした」のか「yomi が意図的に抑止した」のか区別できない
 * - **温度差を消すため、対象ファイルを先に作って watcher に認識させてから計測に入る**
 * - **1 試行ごとに `SETTLE_MS` 待つ。** 遅れて届いたイベントを「取りこぼし」と数えないため
 * - **temp → rename の間隔を振る。** これが効くというのが #122 で分かったこと
 */

import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watch } from "chokidar";
import { writeFileAtomic } from "../src/util/atomic-write.ts";

/** 1 試行ごとにイベントを待つ時間。遅延到着を取りこぼしと誤判定しないための余裕 */
const SETTLE_MS = 700;
/** 振る間隔 (ms)。0 は「書いた直後に rename」 */
const GAPS = [0, 1, 2, 5, 20, 50];

const trials = Number(process.argv[2] ?? 20);

const root = await mkdtemp(join(tmpdir(), "yomi-watch-probe-"));
const target = join(root, "a.md");
let events: string[] = [];

// **素の chokidar。** yomi の createWatcher が挟む debounce / isOwnSave を経路から外す
const w = watch(root, { ignoreInitial: true, followSymlinks: false, persistent: true });
w.on("all", (ev, p) => events.push(`${ev}:${p.slice(root.length + 1)}`));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fired = () => events.some((e) => e === "change:a.md");

await wait(1200); // watcher が ready になるまで
await writeFile(target, "v0\n");
await wait(SETTLE_MS);

const rows: string[] = [];
const run = async (label: string, op: (i: number) => Promise<void>) => {
  let hit = 0;
  for (let i = 0; i < trials; i++) {
    events = [];
    await op(i);
    await wait(SETTLE_MS);
    if (fired()) hit++;
  }
  rows.push(`| ${label} | ${hit}/${trials} |`);
  console.log(`${label.padEnd(34)} change:a.md = ${hit}/${trials}`);
};

await run("既存ファイルへ直書き", async (i) => {
  await writeFile(target, `d${i}\n`);
});

for (const gap of GAPS) {
  await run(`temp + rename（間隔 ${gap}ms）`, async (i) => {
    const temp = `${target}.probe${i}.tmp`;
    await writeFile(temp, `g${i}\n`);
    if (gap) await wait(gap);
    await rename(temp, target);
  });
}

await run("writeFileAtomic での上書き", async (i) => {
  await writeFileAtomic(target, `a${i}\n`);
});

w.close();
await rm(root, { recursive: true, force: true });

// **版を実物から読む。** 数値の再現性は chokidar の版に依存するので、実行のたびに刻む
const chokidarVersion = (
  JSON.parse(
    await Bun.file(new URL("../node_modules/chokidar/package.json", import.meta.url)).text(),
  ) as { version: string }
).version;

console.log(`\nplatform=${process.platform} bun=${Bun.version} trials=${trials}`);
console.log(`chokidar=${chokidarVersion}`);
console.log(`\n| 操作 | \`change\` の発火 |\n|---|---|\n${rows.join("\n")}`);
