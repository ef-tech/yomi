export interface CliOptions {
  port: number | null;
  host: string;
  open: boolean;
  help: boolean;
}

export const DEFAULT_OPTIONS: CliOptions = {
  port: null,
  host: "0.0.0.0",
  open: true,
  help: false,
};

export const HELP_TEXT = `yomi (読み) — ローカル Markdown ビューア

使い方:
  yomi [options]

オプション:
  --port <n>      ポートを指定（デフォルト: 3939 から自動探索）
  --no-open       ブラウザを自動で開かない
  --host <addr>   バインドアドレス（デフォルト: 0.0.0.0、同 LAN から閲覧可）
                  ローカル限定にするには --host 127.0.0.1
  --help, -h      このヘルプを表示

例:
  cd /path/to/docs && yomi
  yomi --port 8080 --no-open
  yomi --host 127.0.0.1            # 自端末からのみ
`;

export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { ...DEFAULT_OPTIONS };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--no-open":
        opts.open = false;
        break;
      case "--port": {
        const next = argv[i + 1];
        if (next === undefined) throw new Error("--port には値が必要です");
        const n = Number(next);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          throw new Error(`--port は 1〜65535 の整数で指定してください: ${next}`);
        }
        opts.port = n;
        i++;
        break;
      }
      case "--host": {
        const next = argv[i + 1];
        if (next === undefined) throw new Error("--host には値が必要です");
        opts.host = next;
        i++;
        break;
      }
      default:
        if (arg && arg.startsWith("--port=")) {
          const value = arg.slice("--port=".length);
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1 || n > 65535) {
            throw new Error(`--port は 1〜65535 の整数で指定してください: ${value}`);
          }
          opts.port = n;
        } else if (arg && arg.startsWith("--host=")) {
          opts.host = arg.slice("--host=".length);
        } else {
          throw new Error(`不明なオプション: ${arg}`);
        }
    }
  }

  return opts;
}
