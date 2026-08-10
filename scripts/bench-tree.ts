#!/usr/bin/env bun

/**
 * ツリー走査・`/api/tree` 応答・クライアント描画のベンチマーク (Issue #83)。
 *
 * ```
 * bun run scripts/bench-tree.ts              # 1000 / 5000 / 10000 で計測
 * bun run scripts/bench-tree.ts 1000 5000    # 規模を指定
 * ```
 *
 * ## 何を測るか（親 #56 が挙げた 3 指標）
 *
 * | 指標 | 測り方 | 何が効くか |
 * |---|---|---|
 * | スキャン時間 | `scanMarkdownTree` を直接呼ぶ | `readdir` の回数と除外判定 |
 * | `/api/tree` の response size | 実サーバへ HTTP して byte 数 | ツリーの JSON 表現の冗長さ |
 * | DOM 更新時間 | jsdom 上で `renderTree` 相当を回す | ノード生成とイベント登録の回数 |
 *
 * ## 測り方の方針
 *
 * - **各規模で `RUNS` 回まわして中央値を採る。** 平均だと 1 回の GC や
 *   ページキャッシュミスに引きずられる。最小値だと「理想状態」しか見えない
 * - **計測前に 1 回捨てる (warmup)。** 初回は OS のページキャッシュが冷えており、
 *   ディスク I/O を測ってしまう。#84 が比較したいのは実装の差であってキャッシュの差ではない
 * - **DOM 更新は実ブラウザではなく jsdom で測る。** 目的は #84 の前後比較なので、
 *   絶対値の正確さより**同じ条件で繰り返せること**を優先する。実ブラウザの数値が要るなら
 *   E2E (#80) 側に足す
 *
 * 結果は Markdown の表で標準出力へ出す。`docs/bench/` に貼って比較する。
 */

import { readFileSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { scanMarkdownTree, type TreeNode } from "../src/scanner.ts";
import { createServer } from "../src/server.ts";
import { BENCH_ROOT } from "./bench-fixture.ts";

/**
 * 計測回数と warmup。
 *
 * **warmup 1 回では足りない。** DOM 構築を独立プロセスで何度も回すと、1 本目 ~215ms →
 * 4 本目 ~135ms と単調に速くなり続ける (最大 61% の開き)。JIT が温まりきるまでに
 * 数回かかるので、少なく捨てると中央値が定常状態より 3 割ほど高く出る。
 */
const WARMUP = 3;
const RUNS = 11;

const DEFAULT_SIZES = [1000, 5000, 10000];

interface Stat {
  min: number;
  median: number;
  max: number;
}

/**
 * 中央値だけでなく min / max も返す。
 *
 * **散らばりが記録されていないと「改善したのか誤差なのか」を判定できない。**
 * #84 が「178 → 160 になった」と言うとき、幅が ±40 なら何も言えていない。
 */
function stat(values: number[]): Stat {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
      : (sorted[mid] as number);
  return { min: sorted[0] as number, median, max: sorted[sorted.length - 1] as number };
}

/** `12.3 ms (10.1–15.2)` の形。中央値と幅を 1 セルに収める。 */
const ms = (s: Stat) => `${s.median.toFixed(1)} (${s.min.toFixed(1)}–${s.max.toFixed(1)})`;
const kib = (bytes: number) => `${(bytes / 1024).toFixed(0)} KiB`;

/** warmup を捨てたうえで RUNS 回まわす。 */
async function bench(fn: () => unknown | Promise<unknown>): Promise<number[]> {
  for (let i = 0; i < WARMUP; i++) await fn();
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  return times;
}

/** fixture を作る（生成スクリプトを再利用する）。 */
async function buildFixture(dir: string, count: number) {
  const proc = Bun.spawn(["bun", "run", "scripts/bench-fixture.ts", dir, String(count)], {
    stdout: "pipe",
    stderr: "inherit",
  });
  await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`fixture の生成に失敗: ${dir}`);
}

/** 1) スキャン時間 */
async function measureScan(dir: string): Promise<number[]> {
  return bench(() => scanMarkdownTree(dir));
}

/**
 * 1b) スキャンのうち `readdir` そのものが占める時間。
 *
 * **内訳を測らずに「readdir 律速」と決めつけない。** 実測すると `readdir` は全体の
 * 1/3 程度で、残りは 1 エントリごとの JS 処理 (`join` / `relative` / `toPosix` の
 * 文字列生成、除外判定、`TreeNode` の割り当て) と `pruneEmpty`。#84 が最適化対象を
 * 決めるとき、ここを取り違えると効かない場所を触ることになる。
 */
async function measureReaddir(dir: string): Promise<number[]> {
  const walk = async (cur: string): Promise<void> => {
    const entries = await readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) await walk(join(cur, e.name));
    }
  };
  return bench(() => walk(dir));
}

/** 2) `/api/tree` の応答時間と response size */
async function measureApi(dir: string): Promise<{ times: number[]; bytes: number }> {
  const handle = createServer({ rootDir: dir, hostname: "127.0.0.1", port: 0, watch: false });
  const url = `http://127.0.0.1:${handle.server.port}/api/tree`;
  try {
    // size は 1 回取れば足りる (毎周同じ値を上書きしていた)
    const bytes = Buffer.byteLength(await (await fetch(url)).text(), "utf-8");
    // **クライアント側のデコードまで含む区間**。サーバとクライアントが同一プロセス・
    // 同一イベントループ上にある点も実運用 (別プロセスのブラウザ) とは違う。
    const times = await bench(async () => {
      await (await fetch(url)).text();
    });
    return { times, bytes };
  } finally {
    handle.close();
  }
}

/**
 * 3) DOM 更新時間。
 *
 * `public/app.js` の `renderTree` / `renderNode` と**同じ処理を行う**。app.js を
 * そのまま呼ばないのは、import しただけで `init()` / `connectLiveReload()` まで走り
 * (`public/app.js` の top-level)、ツリー描画だけを切り出せないため。
 *
 * **写しは実物とずれうる。** `tests/bench-dom-parity.test.ts` が、この関数が作る DOM の
 * 要素数を実物 (特性テストのハーネスで起動した app.js) と突き合わせて固定している。
 * ずれたまま #84 の前後比較に使うと、別物同士を比べることになる。
 *
 * **jsdom はレイアウトもペイントもしない。** ここで測れるのは DOM オブジェクトの生成
 * コストだけで、実ブラウザの描画コストではない。実物は既定で全ディレクトリが閉じており
 * (`openDirs` の初期値)、実ブラウザでは非表示サブツリーのレイアウトが省かれるので、
 * 実機のコスト構造とは一致しない。実機値が要るなら E2E (#80) 側で測る。
 */
export function renderTreeInto(document: Document, host: HTMLElement, tree: TreeNode): void {
  // 実物と同じく Map を張り直す (10,000 規模では挿入回数が無視できない)
  const fileButtons = new Map<string, HTMLElement>();
  const dirNodes = new Map<string, { button: HTMLElement; ul: HTMLElement }>();
  const openDirs = new Set<string>([""]); // 既定では全ディレクトリが閉じている

  const setDirOpen = (button: HTMLElement, ul: HTMLElement, open: boolean) => {
    button.classList.toggle("is-open", open);
    ul.style.display = open ? "" : "none";
  };

  const renderNode = (node: TreeNode): HTMLElement => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.setAttribute("type", "button");
    button.className = `tree-item is-${node.type}`;
    button.title = node.path;

    const icon = document.createElement("span");
    icon.className = "icon";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = node.name;
    button.appendChild(icon);
    button.appendChild(name);
    li.appendChild(button);

    if (node.type === "dir") {
      const ul = document.createElement("ul");
      for (const child of node.children ?? []) ul.appendChild(renderNode(child));
      li.appendChild(ul);
      dirNodes.set(node.path, { button, ul });
      setDirOpen(button, ul, openDirs.has(node.path));
      button.addEventListener("click", NOOP);

      // ディレクトリごとの「＋」ボタン (Issue #6)。これを落とすと要素数が実物と食い違う
      if ((node.children?.length ?? 0) > 0) {
        const addBtn = document.createElement("button");
        addBtn.setAttribute("type", "button");
        addBtn.className = "dir-new-btn";
        addBtn.textContent = "＋";
        addBtn.dataset.dirPath = node.path;
        addBtn.dataset.dirName = node.name;
        addBtn.title = `${node.path} に新規 md ファイル`;
        addBtn.setAttribute("aria-label", `${node.name} に新規 Markdown ファイルを作成`);
        addBtn.addEventListener("click", NOOP);
        li.insertBefore(addBtn, ul);
      }
    } else {
      fileButtons.set(node.path, button);
      button.addEventListener("click", NOOP);
    }
    return li;
  };

  host.removeAttribute("aria-busy");
  host.removeAttribute("data-i18n");
  host.innerHTML = "";
  const ul = document.createElement("ul");
  for (const child of tree.children ?? []) ul.appendChild(renderNode(child));
  host.appendChild(ul);
}

// 実物ではハンドラの中身が異なるが、ここで測りたいのは**リスナ登録のコスト**なので揃える
const NOOP = () => {};

function measureDom(tree: TreeNode): number[] {
  const dom = new JSDOM("<!doctype html><div id='tree'></div>");
  const { document } = dom.window;
  const host = document.getElementById("tree") as HTMLElement;
  const times = benchSync(() => renderTreeInto(document as unknown as Document, host, tree));
  dom.window.close();
  return times;
}

/** 同期版の bench（DOM 構築は同期なので await のオーバーヘッドを乗せない）。 */
function benchSync(fn: () => void): number[] {
  for (let i = 0; i < WARMUP; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  return times;
}

function countNodes(node: TreeNode): { files: number; dirs: number } {
  let files = 0;
  let dirs = 0;
  const walk = (n: TreeNode) => {
    if (n.type === "file") files++;
    else {
      if (n.path !== "") dirs++;
      for (const c of n.children ?? []) walk(c);
    }
  };
  walk(node);
  return { files, dirs };
}

async function main() {
  const raw = process.argv.slice(2);
  // **解釈できない引数を黙って捨てない。** filter で落とすと `bench 10k` が
  // 「規模を絞ったつもりでフルセットが走る」ことになり、数分待った末に気づく。
  const sizes = raw.map((a) => Number(a));
  if (sizes.some((n) => !Number.isInteger(n) || n < 1)) {
    console.error("使い方: bun run bench [ファイル数...]   例: bun run bench 1000 5000");
    process.exit(1);
  }
  const targets = sizes.length > 0 ? sizes : DEFAULT_SIZES;

  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8")) as {
    version: string;
  };

  await mkdir(BENCH_ROOT, { recursive: true });

  // **ヘッダと行を都度出す。** 最後にまとめて出すと、いちばん時間のかかる規模で
  // 落ちたときに、それまでに集めた結果まで失う。
  const cpu = cpus()[0];
  console.log(
    `<!-- yomi v${pkg.version} / bun ${Bun.version} / ${process.platform} / ` +
      `${cpu?.model ?? "unknown CPU"} x${cpus().length} / ` +
      `RAM ${(totalmem() / 1024 ** 3).toFixed(0)} GB -->`,
  );
  console.log("");
  console.log(
    "| ファイル数 | 実 md 数 | ディレクトリ数 | スキャン (ms) | うち readdir (ms) | /api/tree (ms) | response size | DOM 構築 (ms) |",
  );
  console.log("|---|---|---|---|---|---|---|---|");

  for (const count of targets) {
    const dir = join(BENCH_ROOT, `n${count}`);
    process.stderr.write(`\n[${count}] fixture を生成中…\n`);
    await buildFixture(dir, count);

    process.stderr.write(`[${count}] スキャンを計測中 (warmup ${WARMUP} + ${RUNS} 回)…\n`);
    const scan = stat(await measureScan(dir));
    const rd = stat(await measureReaddir(dir));

    process.stderr.write(`[${count}] /api/tree を計測中…\n`);
    const api = await measureApi(dir);

    process.stderr.write(`[${count}] DOM 構築を計測中…\n`);
    const tree = await scanMarkdownTree(dir);
    const dom = stat(measureDom(tree));

    const { files, dirs } = countNodes(tree);
    console.log(
      `| ${count} | ${files} | ${dirs} | ${ms(scan)} | ${ms(rd)} | ${ms(stat(api.times))} | ${kib(api.bytes)} | ${ms(dom)} |`,
    );
  }

  console.log("");
  console.log(`各セルは **中央値 (最小–最大)**。warmup ${WARMUP} 回を捨てたあと ${RUNS} 回計測。`);
  console.log("");
  console.log(
    "**DOM 構築は jsdom 上の値**でレイアウト・ペイントを含まない。実ブラウザの描画コストではない。",
  );

  process.stderr.write(`\n計測が終わりました。fixture は ${BENCH_ROOT}/ に残っています\n`);
  process.stderr.write(`(消すには: rm -rf ${BENCH_ROOT})\n`);
}

// **import されただけでは走らせない。** テストがこのモジュールから関数を import するので、
// top-level で実行すると import しただけでベンチが始まってしまう。
if (import.meta.main) await main();
