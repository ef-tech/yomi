import { buildAccessibleUrls, isLoopback, isWildcard } from "./network.ts";

export interface BannerOptions {
  rootDir: string;
  host: string;
  port: number;
}

/** 起動時にコンソールへ表示するバナーを組み立てる (改行区切り 1 文字列) */
export function buildStartupBanner(opts: BannerOptions): string {
  const lines: string[] = ["yomi が起動しました"];

  for (const u of buildAccessibleUrls(opts.host, opts.port)) {
    lines.push(`  ${u.label.padEnd(6)} ${u.url}`);
  }

  lines.push(`対象ディレクトリ: ${opts.rootDir}`);

  if (!isLoopback(opts.host)) {
    lines.push(
      "注意: 認証なしでネットワークに公開しています。" +
        "外部ネットワーク上では Markdown の内容が誰でも閲覧できます。",
    );
    if (isWildcard(opts.host)) {
      lines.push("ローカル限定にするには --host 127.0.0.1");
    }
  }

  lines.push("停止するには Ctrl+C");
  return lines.join("\n");
}

/** バナーを stdout に出力 */
export function printStartupBanner(opts: BannerOptions): void {
  console.log(buildStartupBanner(opts));
}
