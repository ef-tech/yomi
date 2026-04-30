#!/usr/bin/env bun
import { parseArgs, HELP_TEXT } from "../src/cli.ts";
import { findAvailablePort } from "../src/port.ts";
import { createServer } from "../src/server.ts";
import { openBrowser } from "../src/open-browser.ts";
import {
  buildAccessibleUrls,
  isLoopback,
  isWildcard,
  pickBrowserUrl,
} from "../src/network.ts";

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

  const portToUse =
    options.port !== null
      ? options.port
      : await findAvailablePort(options.host);

  const rootDir = process.cwd();

  const handle = createServer({
    rootDir,
    hostname: options.host,
    port: portToUse,
  });

  const host = options.host;
  const urls = buildAccessibleUrls(host, portToUse);

  console.log(`yomi が起動しました`);
  for (const u of urls) {
    console.log(`  ${u.label.padEnd(6)} ${u.url}`);
  }
  console.log(`対象ディレクトリ: ${rootDir}`);
  if (!isLoopback(host)) {
    console.log(
      "注意: 認証なしでネットワークに公開しています。" +
        "外部ネットワーク上では Markdown の内容が誰でも閲覧できます。",
    );
    if (isWildcard(host)) {
      console.log("ローカル限定にするには --host 127.0.0.1");
    }
  }
  console.log("停止するには Ctrl+C");

  if (options.open) {
    openBrowser(pickBrowserUrl(host, portToUse));
  }

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
