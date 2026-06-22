export interface CliOptions {
  port: number | null;
  host: string;
  open: boolean;
  help: boolean;
  /** 走査する階層の上限 (Issue #44)。null なら無制限。`tree -L <level>` と同義。 */
  depth: number | null;
}

export const DEFAULT_OPTIONS: CliOptions = {
  port: null,
  host: "0.0.0.0",
  open: true,
  help: false,
  depth: null,
};

export const HELP_TEXT = `yomi (読み) — ローカル Markdown ビューア

使い方:
  yomi [options]

オプション:
  --port <n>      ポートを指定（デフォルト: 3939 から自動探索）
  --no-open       ブラウザを自動で開かない
  --host <addr>   バインドアドレス（デフォルト: 0.0.0.0、同 LAN から閲覧可）
                  ローカル限定にするには --host 127.0.0.1
  --depth <n>, -L <n>
                  読み込む階層の深さを制限（tree -L 相当。デフォルト: 無制限）
                  1 でルート直下のみ。深い md は読み込まず監視もしない
  --help, -h      このヘルプを表示

例:
  cd /path/to/docs && yomi
  yomi --port 8080 --no-open
  yomi --host 127.0.0.1            # 自端末からのみ
  yomi --depth 2                   # 2 階層までスキャン
  yomi -L 1                        # ルート直下のみ
`;

/** "--name=value" 形式を "--name" "value" に分割し、引数列を統一形式に正規化する */
function normalize(argv: readonly string[]): string[] {
  const result: string[] = [];
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 2) {
      result.push(arg.slice(0, eq), arg.slice(eq + 1));
    } else {
      result.push(arg);
    }
  }
  return result;
}

function parsePort(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`--port は 1〜65535 の整数で指定してください: ${value}`);
  }
  return n;
}

function parseDepth(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--depth は 1 以上の整数で指定してください: ${value}`);
  }
  return n;
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${flag} には値が必要です`);
  return value;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { ...DEFAULT_OPTIONS };
  const args = normalize(argv);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--no-open":
        opts.open = false;
        break;
      case "--port":
        opts.port = parsePort(takeValue(args, i, "--port"));
        i++;
        break;
      case "--host":
        opts.host = takeValue(args, i, "--host");
        i++;
        break;
      case "--depth":
      case "-L":
        opts.depth = parseDepth(takeValue(args, i, arg));
        i++;
        break;
      default:
        throw new Error(`不明なオプション: ${arg}`);
    }
  }

  return opts;
}
