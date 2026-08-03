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
  DETACHED_ENV,
  describeNoStopTarget,
  describeStop,
  selectStopTargets,
  startDetached,
  stopInstance,
} from "../src/daemon.ts";
import { liveInstances } from "../src/instances.ts";
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
  await runUp(parsed.options);
}

async function runUp(options: CliOptions) {
  const rootDir = process.cwd();
  // ポートは親側で確定させる。子に自動探索させると親が実ポートを知れず、
  // レジストリに書けない (= down / list から辿れない)。
  const port = options.port !== null ? options.port : await findAvailablePort(options.host);

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

  installShutdownHandlers(handle);
}

async function runDetached(options: CliOptions, rootDir: string, port: number) {
  try {
    const record = await startDetached({
      rootDir,
      host: options.host,
      port,
      depth: options.depth,
    });

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
  } catch (err) {
    console.error(`エラー: ${(err as Error).message}`);
    process.exit(1);
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
    console.log(describeStop(await stopInstance(target)));
  }
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

function installShutdownHandlers(handle: ServerHandle): void {
  process.on("SIGINT", () => {
    console.log("\n終了します…");
    handle.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    handle.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("起動失敗:", err);
  process.exit(1);
});
