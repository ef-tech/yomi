#!/usr/bin/env bun

/**
 * inotify とポーリングの常駐コストを比べる (Issue #119)。
 *
 * ```
 * bun run scripts/probe-watcher-poll-cost.ts           # アイドル 10 秒で測る
 * bun run scripts/probe-watcher-poll-cost.ts 30000     # アイドル時間を指定
 * ```
 *
 * ## なぜ残すか
 *
 * #119 は「取りこぼしを watcher 側で直すなら `usePolling` しかない」と実測したうえで、
 * **ポーリングへ倒さず書き込み側で 5ms 待つ**ことを選んだ。その判断を支えているのが
 * ここで測る**アイドル時の CPU**で、**却下した選択肢の数値こそ再現できる必要がある**
 * （数字だけ散文に書くと、次に誰かが「ポーリングでいいのでは」と考えたときに測り直せない）。
 *
 * 検知率のほうは `scripts/probe-watcher-atomic.ts` が測る。
 *
 * ## 測り方
 *
 * - **アイドルで測る。** ファイルを触らずに置いておくときの常駐コストが論点。
 *   yomi は「読むだけで置きっぱなし」が普通の使い方
 * - **`process.cpuUsage()` の差分。** user + system。壁時計ではなく CPU 時間
 * - **ファイル数を振る。** ポーリングはファイル数に比例するので、1 点では判断できない
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChokidarOptions, watch } from "chokidar";

const IDLE_MS = Number(process.argv[2] ?? 10_000);
if (!Number.isInteger(IDLE_MS) || IDLE_MS <= 0) {
  console.error(`使い方: bun run scripts/probe-watcher-poll-cost.ts [アイドル ms]
  正の整数。指定なしなら 10000。受け取った値: ${JSON.stringify(process.argv[2])}`);
  process.exit(1);
}

const COUNTS = [100, 1_000, 5_000];
const CASES: { label: string; opts: ChokidarOptions }[] = [
  { label: "inotify（既定）", opts: {} },
  { label: "ポーリング 100ms", opts: { usePolling: true, interval: 100 } },
  { label: "ポーリング 250ms", opts: { usePolling: true, interval: 250 } },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 1 ディレクトリ 20 件で `count` 個の md を作る（実際のドキュメントツリーに近い形） */
async function makeTree(count: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yomi-poll-cost-"));
  const perDir = 20;
  for (let i = 0; i < count; i++) {
    const dir = join(root, `d${Math.floor(i / perDir)}`);
    if (i % perDir === 0) await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `f${i}.md`), `# ${i}\n`);
  }
  return root;
}

interface Row {
  count: number;
  label: string;
  readyMs: number;
  cpuMs: number;
}

async function measure(
  root: string,
  count: number,
  label: string,
  opts: ChokidarOptions,
): Promise<Row> {
  const t0 = Date.now();
  const w = watch(root, { ignoreInitial: true, followSymlinks: false, persistent: true, ...opts });
  await new Promise<void>((r) => w.on("ready", () => r()));
  const readyMs = Date.now() - t0;

  const cpu0 = process.cpuUsage();
  await sleep(IDLE_MS);
  const cpu = process.cpuUsage(cpu0);
  await w.close();
  return { count, label, readyMs, cpuMs: Math.round((cpu.user + cpu.system) / 1000) };
}

const rows: Row[] = [];
for (const count of COUNTS) {
  const root = await makeTree(count);
  try {
    for (const c of CASES) {
      const r = await measure(root, count, c.label, c.opts);
      console.error(
        `  ${String(count).padStart(5)} ファイル  ${c.label.padEnd(18)} ready ${String(r.readyMs).padStart(5)}ms / アイドル CPU ${String(r.cpuMs).padStart(5)}ms`,
      );
      rows.push(r);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

console.log(`\n> platform=${process.platform} bun=${Bun.version} idle=${IDLE_MS / 1000}s\n`);
console.log(`**アイドル ${IDLE_MS / 1000} 秒あたりの CPU 時間**\n`);
console.log(`| ファイル数 | ${CASES.map((c) => c.label).join(" | ")} |`);
console.log(`|---|${CASES.map(() => "---").join("|")}|`);
for (const count of COUNTS) {
  const cells = CASES.map((c) => {
    const r = rows.find((x) => x.count === count && x.label === c.label);
    return r ? `${r.cpuMs}ms` : "-";
  });
  console.log(`| ${count.toLocaleString()} | ${cells.join(" | ")} |`);
}
