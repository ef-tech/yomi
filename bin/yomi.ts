#!/usr/bin/env bun
import { printStartupBanner } from "../src/banner.ts";
import {
  type CliOptions,
  type DownOptions,
  HELP_TEXT,
  type ParsedCommand,
  parseCommand,
  shouldOpenBrowser,
} from "../src/cli.ts";
import {
  assertPortIsFree,
  DETACHED_ENV,
  describeNoStopTarget,
  describeStop,
  selectStopTargets,
  servingInstances,
  startDetached,
  stopInstance,
} from "../src/daemon.ts";
import { buildListOutput } from "../src/instance-table.ts";
import {
  buildInstanceRecord,
  type InstanceRecord,
  liveInstances,
  removeInstanceSync,
  saveInstance,
} from "../src/instances.ts";
import { pickBrowserUrl } from "../src/network.ts";
import { openBrowser } from "../src/open-browser.ts";
import { findAvailablePort } from "../src/port.ts";
import { createServer, type ServerHandle } from "../src/server.ts";
import { DEFAULT_EXCLUDES } from "../src/util/excludes.ts";
import { loadYomiignore } from "../src/yomiignore.ts";

async function main() {
  const parsed = parseCommandOrExit();
  if (parsed.options.help) {
    console.log(HELP_TEXT);
    return;
  }

  if (parsed.name === "down") {
    await runDown(parsed.options);
    return;
  }
  if (parsed.name === "list") {
    await runList();
    return;
  }
  await runUp(parsed.options);
}

async function runUp(options: CliOptions) {
  const rootDir = process.cwd();
  // ポートは親側で確定させる。子に自動探索させると親が実ポートを知れず、
  // レジストリに書けない (= down / list から辿れない)。
  // **--port を明示したときは事前に空きを確かめる (Issue #94)。**
  // 省略時は findAvailablePort が空きを探すので衝突しない。明示指定だけが
  // 検査されずに createServer へ渡り、Bun.serve の throw が生のまま出ていた。
  //
  // **切り離された子 (up -d の実体) では検査しない。** 親の startDetached が
  // 起動直前に同じ検査を済ませており、子でもう一度読むとレジストリに書かれた
  // 「自分自身の記録」を見つけて「既に起動しています」と誤判定する。
  const port = options.port !== null ? options.port : await findAvailablePort(options.host);
  if (options.port !== null && !options.detach && process.env[DETACHED_ENV] !== "1") {
    try {
      await assertPortIsFree(options.host, port);
    } catch (err) {
      console.error(`エラー: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  if (options.detach) {
    await runDetached(options, rootDir, port);
    return;
  }
  await runForeground(options, rootDir, port);
}

async function runForeground(options: CliOptions, rootDir: string, port: number) {
  const userExcludes = await loadYomiignore(rootDir);
  const excludes = new Set([...DEFAULT_EXCLUDES, ...userExcludes]);

  const handle = createServer({
    rootDir,
    hostname: options.host,
    port,
    excludes,
    maxDepth: options.depth ?? undefined,
  });

  // 切り離された子が自分のログへ出す場合は、届かない Ctrl+C ではなく yomi down を案内する
  const detachedChild = process.env[DETACHED_ENV] === "1";

  // レジストリに記録して yomi list / yomi down の対象にする (Issue #90)。
  //
  // **createServer より後に置く。** 二重起動が先に動いているインスタンスの記録を
  // 上書きしないようにするため。Issue #94 で `runUp` に `assertPortIsFree` を足したので
  // **`--port` 明示時はここへ来る前に落ちる**が、この順序自体は残す ——
  // 事前検査と `Bun.serve` の間には隙間があり (別プロセスがその間に掴みうる)、
  // 検査を通り抜けた二重起動を最終的に止めるのは `Bun.serve` の throw だから。
  //
  // **切り離された子 (up -d の実体) は記録しない。** 親の startDetached が
  // logPath 付きの記録を書くので、ここでも書くと logPath が空の記録で上書きしてしまう。
  //
  // **記録に失敗しても起動は続ける。** ビューアの主機能は記録に依存しておらず、
  // フォアグラウンドは Ctrl+C で止められる。状態ディレクトリが書けない環境
  // (読み取り専用・容量不足) で「読めなくなる」ほうが損失が大きい。
  // ただし黙って続けると list / down で見つからない理由が分からないので警告は出す。
  // (バックグラウンドは記録が無いと停止手段そのものを失うため startDetached は失敗させる)
  let registered = false;
  if (!detachedChild) {
    try {
      await saveInstance(
        buildInstanceRecord({ pid: process.pid, port, host: options.host, rootDir }),
      );
      registered = true;
    } catch (err) {
      console.warn(
        `警告: インスタンスの記録に失敗しました (${(err as Error).message})\n` +
          "  yomi list / yomi down からは操作できません。停止するには Ctrl+C を使ってください",
      );
    }
  }

  printStartupBanner({
    rootDir,
    host: options.host,
    port,
    depth: options.depth,
    detached: detachedChild ? { pid: process.pid } : null,
  });
  if (userExcludes.size > 0) {
    console.log(`.yomiignore: ${userExcludes.size} 件追加 (${[...userExcludes].join(", ")})`);
  }

  if (shouldOpenBrowser(options)) {
    openBrowser(pickBrowserUrl(options.host, port));
  }

  // 記録した本人だけが後始末する (切り離された子の記録は親のもの = stopInstance が消す)
  installShutdownHandlers(handle, registered ? port : null);
}

async function runDetached(options: CliOptions, rootDir: string, port: number) {
  let record: InstanceRecord;
  try {
    record = await startDetached({ rootDir, host: options.host, port, depth: options.depth });
  } catch (err) {
    console.error(`エラー: ${(err as Error).message}`);
    process.exit(1);
  }

  printStartupBanner({
    rootDir,
    host: options.host,
    port: record.port,
    depth: options.depth,
    detached: { pid: record.pid, logPath: record.logPath },
  });

  if (shouldOpenBrowser(options)) {
    openBrowser(pickBrowserUrl(options.host, record.port));
  }
}

async function runDown(options: DownOptions) {
  const cwd = process.cwd();
  const targets = selectStopTargets(await liveInstances(), options, cwd);

  if (targets.length === 0) {
    console.log(describeNoStopTarget({ all: options.all, port: options.port, cwd }));
    return;
  }

  for (const target of targets) {
    const outcome = await stopInstance(target);
    if (outcome.stopped) {
      console.log(describeStop(outcome));
    } else {
      // 記録は残してあるので、原因を直したうえで再実行できる
      console.error(describeStop(outcome));
      process.exitCode = 1;
    }
  }
}

async function runList() {
  // servingInstances は「pid 生存 + 記録したポートで listen」で絞り、外れた記録を掃除する。
  // down の停止判定と同じ基準なので、一覧に出たものは必ず down で止められる。
  console.log(buildListOutput(await servingInstances()));
}

function parseCommandOrExit(): ParsedCommand {
  try {
    return parseCommand(process.argv.slice(2));
  } catch (err) {
    console.error(`エラー: ${(err as Error).message}\n`);
    console.error(HELP_TEXT);
    process.exit(1);
  }
}

/**
 * 終了シグナルでサーバを閉じ、レジストリの記録を片付ける。
 *
 * `registeredPort` が null なら記録の削除はしない (自分が書いた記録ではないため)。
 * 削除は**同期版**を使う —— ここで await すると exit が遅れ、await しないと
 * 消える前にプロセスが落ちる (`removeInstanceSync` のコメント)。
 */
function installShutdownHandlers(handle: ServerHandle, registeredPort: number | null): void {
  const shutdown = (message?: string) => {
    if (message !== undefined) console.log(message);
    handle.close();
    if (registeredPort !== null) removeInstanceSync(registeredPort);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("\n終了します…"));
  process.on("SIGTERM", () => shutdown());
}

main().catch((err) => {
  console.error("起動失敗:", err);
  process.exit(1);
});
