#!/usr/bin/env bun
import { parseArgs, HELP_TEXT } from "../src/cli.ts";
import { findAvailablePort } from "../src/port.ts";
import { createServer } from "../src/server.ts";

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`エラー: ${(err as Error).message}\n`);
    console.error(HELP_TEXT);
    process.exit(1);
  }

  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  const port =
    options.port !== null
      ? options.port
      : await findAvailablePort(options.host);

  const rootDir = process.cwd();

  const handle = createServer({
    rootDir,
    hostname: options.host,
    port,
  });

  const url = `http://${handle.server.hostname}:${handle.server.port}`;
  console.log(`yomi が起動しました: ${url}`);
  console.log(`対象ディレクトリ: ${rootDir}`);
  console.log("停止するには Ctrl+C");

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
