#!/usr/bin/env bun
/**
 * ベンチマーク用の大規模 Markdown ツリーを生成する (Issue #83)。
 *
 * ```
 * bun run scripts/bench-fixture.ts <.bench 配下の出力先> <ファイル数>
 * ```
 *
 * **出力先は `.bench/` 配下に限る。** このスクリプトは作り直しのために出力先を
 * `rm -rf` するので、任意パスを受け付けると `bun run scripts/bench-fixture.ts src 1000`
 * のようなタイプミス 1 つで `src/` を消せてしまう。`force: true` なので確認も出ない。
 *
 * ## 形を実プロジェクトに寄せる
 *
 * 全部を 1 ディレクトリに置くと `readdir` が 1 回で終わり、**実際に遅くなる要因
 * (ディレクトリを深く辿ること) を測れない**。逆に極端に深くしても現実離れする。
 * ここでは「1 ディレクトリあたり `FILES_PER_DIR` 個、それを超えたら次の階層」という
 * 素朴な割り方にして、docs / node_modules を持つ普通のリポジトリの形に寄せる。
 *
 * ## 中身も一定の大きさを持たせる
 *
 * 空ファイルだと `/api/tree` の response size は測れても、後段 (#84) が差分更新を
 * 入れたときの比較対象にならない。見出しを含む数百バイトの本文を入れて、
 * **ツリーの規模と本文の規模を切り離さない**。
 *
 * **生成物は追跡しない** (`.gitignore` の `.bench/`)。数万ファイルをコミットしても
 * レビューできず、生成スクリプトがあれば同じものを作れる。
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/** 生成先の根。ここから外へは絶対に書かない・消さない。 */
export const BENCH_ROOT = ".bench";

/** 1 ディレクトリに置くファイル数。実プロジェクトの体感に寄せた値。 */
const FILES_PER_DIR = 20;

/** 1 階層に作るサブディレクトリ数。これを超えたら 1 段深くする。 */
const DIRS_PER_LEVEL = 10;

/** 上限。桁を間違えてディスクを埋めないための歯止め。 */
const MAX_FILES = 200_000;

function body(index: number): string {
  // 見出しを複数持たせる (TOC 生成とスクロール同期の計測対象になる)
  return [
    `# ドキュメント ${index}`,
    "",
    "ベンチマーク用に生成したファイル。**内容に意味は無い。**",
    "",
    "## 概要",
    "",
    "本文本文本文本文本文本文本文本文本文本文本文本文本文本文本文本文本文本文。",
    "本文本文本文本文本文本文本文本文本文本文本文本文本文本文本文本文本文本文。",
    "",
    "## 詳細",
    "",
    `- 項目 A-${index}`,
    `- 項目 B-${index}`,
    `- 項目 C-${index}`,
    "",
    "### 補足",
    "",
    "補足補足補足補足補足補足補足補足補足補足補足補足補足補足補足補足補足補足。",
    "",
  ].join("\n");
}

/**
 * `index` 番目のファイルを置くディレクトリの相対パスを決める。
 *
 * FILES_PER_DIR ごとにディレクトリを変え、DIRS_PER_LEVEL ごとに 1 段深くする。
 * 例 (FILES_PER_DIR=20, DIRS_PER_LEVEL=10): 0-19 → `d00`、20-39 → `d01`、…
 * 200-219 → `d01/d00`、…
 *
 * 桁の繰り上がり方の帰結として **`d00` だけはサブディレクトリを持たない**
 * (`d00/d00` に相当する index が存在しない)。
 */
function dirFor(index: number): string {
  const dirIndex = Math.floor(index / FILES_PER_DIR);
  const segments: string[] = [];
  let remaining = dirIndex;
  do {
    segments.unshift(`d${String(remaining % DIRS_PER_LEVEL).padStart(2, "0")}`);
    remaining = Math.floor(remaining / DIRS_PER_LEVEL);
  } while (remaining > 0);
  return segments.join("/");
}

async function main() {
  const [outDir, countRaw] = process.argv.slice(2);
  if (!outDir || !countRaw) {
    console.error("使い方: bun run scripts/bench-fixture.ts <.bench 配下の出力先> <ファイル数>");
    console.error("例:     bun run scripts/bench-fixture.ts .bench/n1000 1000");
    process.exit(1);
  }
  const count = Number(countRaw);
  if (!Number.isInteger(count) || count < 1 || count > MAX_FILES) {
    console.error(`ファイル数は 1〜${MAX_FILES} の整数で指定してください: ${countRaw}`);
    process.exit(1);
  }

  // **`.bench/` の外は触らない。** 直後に rm -rf するので、ここを緩めると
  // タイプミスで任意のディレクトリを消せる (docstring 参照)。
  const rootAbs = resolve(BENCH_ROOT);
  const outAbs = resolve(outDir);
  if (outAbs !== rootAbs && !outAbs.startsWith(rootAbs + sep)) {
    console.error(`出力先は ${BENCH_ROOT}/ 配下でなければなりません: ${outDir}`);
    process.exit(1);
  }

  // **作り直す前に消す。** 前回の残骸が混ざると計測対象のファイル数がずれる。
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const created = new Set<string>();
  for (let i = 0; i < count; i++) {
    const rel = dirFor(i);
    const dir = join(outDir, rel);
    if (!created.has(dir)) {
      await mkdir(dir, { recursive: true });
      created.add(dir);
    }
    await writeFile(join(dir, `doc-${String(i).padStart(5, "0")}.md`), body(i));
  }

  console.log(`${outDir}: ${count} ファイル / ${created.size} ディレクトリ を生成しました`);
}

// **import されただけでは走らせない。** テストがこのモジュールから関数を import するので、
// top-level で実行すると import しただけでベンチが始まってしまう。
if (import.meta.main) await main();
