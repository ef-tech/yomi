#!/usr/bin/env bun
import { printStartupBanner } from "../src/banner.ts";
import { HELP_TEXT, parseArgs } from "../src/cli.ts";
import { pickBrowserUrl } from "../src/network.ts";
import { openBrowser } from "../src/open-browser.ts";
import { findAvailablePort } from "../src/port.ts";
import { createServer, type ServerHandle } from "../src/server.ts";
import { DEFAULT_EXCLUDES } from "../src/util/excludes.ts";
import { loadYomiignore } from "../src/yomiignore.ts";

async function main() {
  const options = parseOptionsOrExit();
  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  const port = options.port !== null ? options.port : await findAvailablePort(options.host);

  const rootDir = process.cwd();
  const userExcludes = await loadYomiignore(rootDir);
  const excludes = new Set([...DEFAULT_EXCLUDES, ...userExcludes]);

  const handle = createServer({
    rootDir,
    hostname: options.host,
    port,
    excludes,
  });

  printStartupBanner({ rootDir, host: options.host, port });
  if (userExcludes.size > 0) {
    console.log(`.yomiignore: ${userExcludes.size} 件追加 (${[...userExcludes].join(", ")})`);
  }

  if (options.open) {
    openBrowser(pickBrowserUrl(options.host, port));
  }

  installShutdownHandlers(handle);
}

function parseOptionsOrExit() {
  try {
    return parseArgs(process.argv.slice(2));
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
