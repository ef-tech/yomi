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
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { scanMarkdownTree, type TreeNode } from "../src/scanner.ts";
import { createServer } from "../src/server.ts";

/** 各規模で計測する回数（中央値を採る）。 */
const RUNS = 5;

const DEFAULT_SIZES = [1000, 5000, 10000];
const BENCH_ROOT = ".bench";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

const ms = (n: number) => `${n.toFixed(1)} ms`;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;

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
  await scanMarkdownTree(dir); // warmup（ページキャッシュを温める）
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await scanMarkdownTree(dir);
    times.push(performance.now() - start);
  }
  return times;
}

/** 2) `/api/tree` の応答時間と response size */
async function measureApi(dir: string): Promise<{ times: number[]; bytes: number }> {
  const handle = createServer({ rootDir: dir, hostname: "127.0.0.1", port: 0, watch: false });
  const url = `http://127.0.0.1:${handle.server.port}/api/tree`;
  try {
    await fetch(url); // warmup
    const times: number[] = [];
    let bytes = 0;
    for (let i = 0; i < RUNS; i++) {
      const start = performance.now();
      const res = await fetch(url);
      const text = await res.text();
      times.push(performance.now() - start);
      bytes = Buffer.byteLength(text, "utf-8");
    }
    return { times, bytes };
  } finally {
    handle.close();
  }
}

/**
 * 3) DOM 更新時間。
 *
 * `public/app.js` の `renderNode` と**同じ形の DOM を作る**（ボタン + アイコン +
 * 名前 + ディレクトリなら子 `<ul>`、ファイルなら click ハンドラ）。app.js を
 * そのまま呼ばないのは、init / fetch / WebSocket まで動いてしまい**ツリー描画だけを
 * 切り出せない**ため。#84 が比べたいのは「ノード生成の回数」なので、形が同じなら足りる。
 */
function measureDom(tree: TreeNode): number[] {
  const dom = new JSDOM("<!doctype html><div id='tree'></div>");
  const { document } = dom.window;
  const host = document.getElementById("tree") as HTMLElement;

  const renderNode = (node: TreeNode): HTMLElement => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
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
      button.addEventListener("click", () => {});
    } else {
      button.addEventListener("click", () => {});
    }
    return li;
  };

  const render = () => {
    host.innerHTML = "";
    const ul = document.createElement("ul");
    for (const child of tree.children ?? []) ul.appendChild(renderNode(child));
    host.appendChild(ul);
  };

  render(); // warmup
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    render();
    times.push(performance.now() - start);
  }
  dom.window.close();
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
  const sizes = process.argv.slice(2).map(Number).filter(Number.isInteger);
  const targets = sizes.length > 0 ? sizes : DEFAULT_SIZES;

  const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { version: string };
  const rows: string[] = [];

  await mkdir(BENCH_ROOT, { recursive: true });

  for (const count of targets) {
    const dir = join(BENCH_ROOT, `n${count}`);
    process.stderr.write(`\n[${count}] fixture を生成中…\n`);
    await buildFixture(dir, count);

    process.stderr.write(`[${count}] スキャン時間を計測中 (${RUNS} 回)…\n`);
    const scan = await measureScan(dir);

    process.stderr.write(`[${count}] /api/tree を計測中 (${RUNS} 回)…\n`);
    const api = await measureApi(dir);

    process.stderr.write(`[${count}] DOM 更新を計測中 (${RUNS} 回)…\n`);
    const tree = await scanMarkdownTree(dir);
    const dom = measureDom(tree);

    const { files, dirs } = countNodes(tree);
    rows.push(
      `| ${count} | ${files} | ${dirs} | ${ms(median(scan))} | ${ms(median(api.times))} | ${kb(api.bytes)} | ${ms(median(dom))} |`,
    );
  }

  console.log(`<!-- yomi v${pkg.version} / bun ${Bun.version} / ${process.platform} -->`);
  console.log("");
  console.log(
    "| ファイル数 | 実 md 数 | ディレクトリ数 | スキャン | /api/tree 応答 | response size | DOM 更新 |",
  );
  console.log("|---|---|---|---|---|---|---|");
  for (const row of rows) console.log(row);
  console.log("");
  console.log(`各値は ${RUNS} 回の**中央値**（warmup 1 回を捨てたあと）。`);

  process.stderr.write(`\n計測が終わりました。fixture は ${BENCH_ROOT}/ に残っています\n`);
  process.stderr.write(`(消すには: rm -rf ${BENCH_ROOT})\n`);
}

await main();
