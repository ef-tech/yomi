import { buildAccessibleUrls, isLoopback, isWildcard } from "./network.ts";

export interface BannerOptions {
  rootDir: string;
  host: string;
  port: number;
  /** 走査階層の上限 (Issue #44)。null / 未指定なら無制限で表示しない。 */
  depth?: number | null;
  /**
   * バックグラウンド起動に関する情報 (Issue #68)。未指定 / null ならフォアグラウンド。
   * 親が起動報告として出すときは pid と logPath を渡す。切り離された子が自分の
   * ログ先頭に出すときは pid だけ渡す (ログの中でログパスを案内しても仕方ない)。
   */
  detached?: { pid: number; logPath?: string } | null;
}

/** 起動時にコンソールへ表示するバナーを組み立てる (改行区切り 1 文字列) */
export function buildStartupBanner(opts: BannerOptions): string {
  const detached = opts.detached ?? null;
  const lines: string[] = [
    detached
      ? `yomi をバックグラウンドで起動しました (pid ${detached.pid})`
      : "yomi が起動しました",
  ];

  for (const u of buildAccessibleUrls(opts.host, opts.port)) {
    lines.push(`  ${u.label.padEnd(6)} ${u.url}`);
  }

  lines.push(`対象ディレクトリ: ${opts.rootDir}`);

  if (opts.depth != null) {
    lines.push(`走査階層: 深さ ${opts.depth} まで (--depth ${opts.depth})`);
  }

  if (detached?.logPath) {
    lines.push(`ログ: ${detached.logPath}`);
  }

  if (!isLoopback(opts.host)) {
    lines.push(
      "注意: 認証なしでネットワークに公開しています。" +
        "外部ネットワーク上では Markdown の内容が誰でも閲覧できます。",
    );
    if (isWildcard(opts.host)) {
      lines.push("ローカル限定にするには --host 127.0.0.1");
    }
  }

  lines.push(detached ? "停止するには yomi down" : "停止するには Ctrl+C");
  return lines.join("\n");
}

/** バナーを stdout に出力 */
export function printStartupBanner(opts: BannerOptions): void {
  console.log(buildStartupBanner(opts));
}
