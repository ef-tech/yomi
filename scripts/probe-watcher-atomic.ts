#!/usr/bin/env bun

/**
 * atomic save (temp + rename) を chokidar が検知するかの計測 (Issue #119 / #122)。
 *
 * ```
 * bun run scripts/probe-watcher-atomic.ts              # 各条件 20 回、tmpdir で
 * bun run scripts/probe-watcher-atomic.ts 50           # 試行回数を指定
 * bun run scripts/probe-watcher-atomic.ts 20 ~/docs    # 計測先を指定 (FS 種別を変えて測る)
 * ```
 *
 * ## なぜ残すか
 *
 * `writeFileAtomic` (Issue #101) は temp へ書いてから rename で差し替えるが、**この経路の
 * 変更を watcher が取りこぼしていた**（#119 で rename の直前に待って解消）。
 * #122 までに **同じ計測を 2 度間違えた**:
 *
 * 1. 1 回きりの計測で「chokidar は既存ファイルへの rename で `change` を発火しない」と
 *    決定論的に一般化した
 * 2. 訂正時の計測が `startsWith("change:a.md")` を判定に使い、**一時ファイル
 *    (`a.md.<pid>.<hex>.tmp`) のイベントまで数えて**検知率を 4 倍近く過大に出した
 *
 * だから**何をどう測ったかをコードとして残す**。数値は環境依存なので、
 * **docstring や CHANGELOG の数字を疑ったらこれを回して測り直すこと。**
 *
 * ## 原因は Bun の `fs.watch`（chokidar ではない）
 *
 * chokidar を通さず素の `node:fs` の `watch` だけで測ると、**Bun は間隔 0ms で 0/10、
 * Node は 10/10**（同じスクリプト・同じマシン）。chokidar の `atomic` /
 * `alwaysStat` / `awaitWriteFinish` が効かないのは、いずれも**イベントが届いて
 * 初めて動く**分岐だから。`usePolling` だけが効くのは `fs.watchFile` に分岐して
 * **`fs.watch` を経路から外す**ため。詳細と上流への報告は **#138**。
 *
 * **つまり境界の値を左右するのは Bun の版。** `bun upgrade` のあとに疑うならここを回す。
 *
 * ## 測り方の方針（過去 2 回の失敗が全部ここに効いている）
 *
 * - **素の chokidar で測る。** `createWatcher` 経由だと 80ms の debounce と `isOwnSave` が
 *   経路に入り、「watcher が取りこぼした」のか「yomi が意図的に抑止した」のか区別できない
 * - **判定は完全一致。** 上の失敗 2 がこれ。`startsWith` は temp ファイルに当たる
 * - **`change` だけでなく「対象ファイルに関する何らかのイベント」も数える。** yomi は
 *   `add` を kind `"rename"` に写す (`src/watcher.ts`) ので、`add` が飛んでいれば
 *   ツリー再取得というかたちで**検知はできている**。`change` の不発だけを見て
 *   「検知できない」と結論すると、測った対象より広く言うことになる（失敗 1 と同じ形）
 * - **静穏期間で試行を区切る。** 固定の待ち時間だと、chokidar のディレクトリ再走査
 *   (`handler.js` の 1000ms スロットル) 由来のイベントが**次の試行の窓に染み出す**のを
 *   実測している。イベントが止まるまで待って初めてその試行を閉じる
 * - **昇順と降順の 2 パス回す。** 条件の実行順が固定だと、時間とともに単調変化する要因
 *   （watch 登録の蓄積など）と間隔の効果を分離できない
 */

import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watch } from "chokidar";
import { WATCH_GAP_MS, writeFileAtomic } from "../src/util/atomic-write.ts";

/** イベントが来なくなってから、この時間だけ静かなら試行を閉じる */
const QUIET_MS = 300;
/**
 * **最初の 1 件を待つ上限。** これを過ぎて何も来なければ「取りこぼし」と判定する。
 * chokidar のディレクトリ再走査スロットル (1000ms) より長く取る —— レビューで
 * 「700ms の窓を超えて届くイベントがある」と実測されたのがこの経路。
 */
const FIRST_EVENT_MS = 1_500;
/** 1 試行の上限。静穏に達しなくてもここで打ち切る */
const MAX_WAIT_MS = 3_000;
/** 振る間隔 (ms)。0 は「書いた直後に rename」 */
const GAPS = [0, 1, 2, 5, 20, 50];

const trials = Number(process.argv[2] ?? 20);
if (!Number.isInteger(trials) || trials <= 0) {
  // **黙って `0/NaN` の表を出さない。** 誤った表を静かに吐くのが #122 の発端そのもの
  console.error(`使い方: bun run scripts/probe-watcher-atomic.ts [試行回数] [計測先ディレクトリ]
  試行回数は正の整数。指定なしなら 20。受け取った値: ${JSON.stringify(process.argv[2])}`);
  process.exit(1);
}

const baseDir = process.argv[3] ?? tmpdir();
const root = await mkdtemp(join(baseDir, "yomi-watch-probe-"));
const target = join(root, "a.md");
let events: string[] = [];

// **素の chokidar。** yomi の createWatcher が挟む debounce / isOwnSave を経路から外す
const w = watch(root, { ignoreInitial: true, followSymlinks: false, persistent: true });
w.on("all", (ev, p) => events.push(`${ev}:${p.slice(root.length + 1)}`));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * イベントが `QUIET_MS` 止まるまで待つ。試行境界の染み出しを防ぐ。
 *
 * **1 件も来ない試行は `FIRST_EVENT_MS` で切り上げる。** そうしないと取りこぼし条件
 * （間隔 0ms は 1 件も飛ばない）が毎回 `MAX_WAIT_MS` を使い切り、全体の実行時間が
 * 数倍になる（実測: 20 試行 × 8 条件 × 2 パスで 15 分を超えた）。
 */
const settle = async () => {
  const started = Date.now();
  const deadline = started + MAX_WAIT_MS;
  let seen = events.length;
  let quietSince = started;
  while (Date.now() < deadline) {
    await sleep(50);
    if (events.length !== seen) {
      seen = events.length;
      quietSince = Date.now();
    } else if (events.length === 0) {
      if (Date.now() - started >= FIRST_EVENT_MS) return;
    } else if (Date.now() - quietSince >= QUIET_MS) {
      return;
    }
  }
};

interface Row {
  label: string;
  /** `change:a.md` が来た試行数 */
  change: number;
  /** `a.md` に関する何らかのイベントが来た試行数（`add` = ツリー再取得も検知のうち） */
  any: number;
}

const measure = async (label: string, op: (i: number) => Promise<void>): Promise<Row> => {
  let change = 0;
  let any = 0;
  for (let i = 0; i < trials; i++) {
    events = [];
    await op(i);
    await settle();
    if (events.includes("change:a.md")) change++;
    if (events.some((e) => e.endsWith(":a.md"))) any++;
  }
  console.log(
    `  ${label.padEnd(30, "…")} change ${change}/${trials} / 何らかのイベント ${any}/${trials}`,
  );
  return { label, change, any };
};

const conditions: Array<[string, (i: number) => Promise<void>]> = [
  ["既存ファイルへ直書き", async (i) => void (await writeFile(target, `d${i}\n`))],
  ...GAPS.map(
    (gap) =>
      [
        `temp + rename（間隔 ${gap}ms）`,
        async (i: number) => {
          const temp = `${target}.probe${i}.tmp`;
          await writeFile(temp, `g${i}\n`);
          if (gap) await sleep(gap);
          await rename(temp, target);
        },
      ] as [string, (i: number) => Promise<void>],
  ),
  // **修正前と修正後を並べる。** 既定だけを測ると「間隔 5ms」と同じものを二度測るだけになり、
  // このスクリプトが本来見たかった取りこぼしが表から消える (Issue #119)
  [
    "writeFileAtomic（gapMs=0・修正前）",
    async (i) => void (await writeFileAtomic(target, `a${i}\n`, { gapMs: 0 })),
  ],
  [
    `writeFileAtomic（既定 ${WATCH_GAP_MS}ms）`,
    async (i) => void (await writeFileAtomic(target, `a${i}\n`)),
  ],
];

try {
  await sleep(1200); // watcher が ready になるまで
  await writeFile(target, "v0\n");
  await settle();

  console.log("── 昇順パス ──");
  const asc: Row[] = [];
  for (const [label, op] of conditions) asc.push(await measure(label, op));

  // **降順でもう 1 パス。** 実行順に依存する交絡を切り分ける
  console.log("── 降順パス ──");
  const desc = new Map<string, Row>();
  for (const [label, op] of [...conditions].reverse()) desc.set(label, await measure(label, op));

  const fsType = (await Bun.$`df -PT ${root}`.text().catch(() => ""))
    .split("\n")[1]
    ?.split(/\s+/)[1];
  const chokidarVersion = (
    JSON.parse(
      await Bun.file(
        join(Bun.resolveSync("chokidar", import.meta.dir), "..", "package.json"),
      ).text(),
    ) as { version: string }
  ).version;

  const caption = `platform=${process.platform} fs=${fsType ?? "?"} bun=${Bun.version} chokidar=${chokidarVersion} trials=${trials}`;
  console.log(`\n> ${caption}\n`);
  console.log("| 操作 | `change` の発火（昇順 / 降順） | 何らかのイベント |");
  console.log("|---|---|---|");
  for (const r of asc) {
    const d = desc.get(r.label);
    console.log(
      `| ${r.label} | ${r.change}/${trials} · ${d?.change ?? "?"}/${trials} | ${r.any}/${trials} · ${d?.any ?? "?"}/${trials} |`,
    );
  }
} finally {
  await w.close();
  await rm(root, { recursive: true, force: true });
}
