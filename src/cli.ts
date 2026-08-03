export interface CliOptions {
  port: number | null;
  host: string;
  open: boolean;
  help: boolean;
  /** 走査する階層の上限 (Issue #44)。null なら無制限。`tree -L <level>` と同義。 */
  depth: number | null;
  /** バックグラウンド起動 (Issue #68)。`docker compose up -d` と同じ位置づけ。 */
  detach: boolean;
  /**
   * --open / --no-open が明示指定されたか (Issue #68)。
   * -d のときは既定でブラウザを開かないので、「既定の true」と
   * 「利用者が --open と書いた true」を区別する必要がある。
   */
  openExplicit: boolean;
}

export const DEFAULT_OPTIONS: CliOptions = {
  port: null,
  host: "127.0.0.1",
  open: true,
  help: false,
  depth: null,
  detach: false,
  openExplicit: false,
};

/** `yomi down` のオプション (Issue #68) */
export interface DownOptions {
  /** 起動中のインスタンスをすべて停止する */
  all: boolean;
  /** 指定ポートのインスタンスだけを停止する */
  port: number | null;
  help: boolean;
}

export const DEFAULT_DOWN_OPTIONS: DownOptions = {
  all: false,
  port: null,
  help: false,
};

export type ParsedCommand =
  | { name: "up"; options: CliOptions }
  | { name: "down"; options: DownOptions };

/** --share を指定したときにバインドする全インターフェースアドレス (Issue #51) */
export const SHARE_HOST = "0.0.0.0";

export const HELP_TEXT = `yomi (読み) — ローカル Markdown ビューア

使い方:
  yomi [options]        カレントディレクトリを開く (yomi up と同じ)
  yomi up [options]     起動する (-d でバックグラウンド)
  yomi down [options]   バックグラウンド起動した yomi を停止する

up のオプション:
  -d, --detach    バックグラウンドで起動しターミナルを解放する
                  停止は yomi down。ログは状態ディレクトリに出力される
  --port <n>      ポートを指定（デフォルト: 3939 から自動探索）
  --no-open       ブラウザを自動で開かない
  --open          ブラウザを開く（-d は既定で開かないため、その打ち消し）
  --host <addr>   バインドアドレス（デフォルト: 127.0.0.1、自端末からのみ）
  --share         同 LAN の別端末からも閲覧できるよう 0.0.0.0 にバインド
                  （認証なしで公開されるため信頼できるネットワークでのみ）
                  --host とは同時に指定できない
  --depth <n>, -L <n>
                  読み込む階層の深さを制限（tree -L 相当。デフォルト: 無制限）
                  1 でルート直下のみ。深い md は読み込まず監視もしない
  --help, -h      このヘルプを表示

down のオプション:
  （指定なし）    カレントディレクトリで起動した yomi を停止する
  --all           起動中の yomi をすべて停止する
  --port <n>      指定したポートの yomi を停止する

例:
  cd /path/to/docs && yomi              # 自端末からのみ (127.0.0.1)
  yomi up -d                            # バックグラウンドで起動
  yomi down                             # このディレクトリの yomi を停止
  yomi down --all                       # 起動中のものをすべて停止
  yomi --port 8080 --no-open
  yomi --share                          # 同 LAN の別端末からも閲覧可
  yomi --depth 2                        # 2 階層までスキャン
  yomi -L 1                             # ルート直下のみ
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
  // Number() は 0x10 / 1e3 / +2 / 2.0 等を黙って受理してしまうため、
  // 10 進整数表記だけを許可する (エラー文言「1 以上の整数」と一致させる)。
  if (!/^\d+$/.test(value)) {
    throw new Error(`--depth は 1 以上の整数で指定してください: ${value}`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--depth は 1 以上の整数で指定してください: ${value}`);
  }
  return n;
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  // 値の欠損・空文字・次のオプション ("--xxx") を値として飲み込むのを拒否する。
  // これにより `--host --share` が --share を host 値として消費して排他検証を
  // 迂回する問題や、`--host=` の空値が空 bind (全インターフェース公開 = LAN 露出)
  // になる footgun を、明確なエラーで fail-fast にする (Issue #51)。
  // 単一ダッシュ ("-1" 等) は負数の値としてそのまま通し、各 parser の範囲検証に委ねる。
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error(`${flag} には値が必要です`);
  }
  return value;
}

/**
 * サブコマンドを解決する (Issue #68)。
 * 先頭がオプション、または引数なしのときは `up` とみなす — 従来の
 * `yomi --port 8080` をそのまま動かし続けるため (後方互換)。
 */
export function parseCommand(argv: readonly string[]): ParsedCommand {
  const [first, ...rest] = argv;
  if (first === "up") return { name: "up", options: parseArgs(rest) };
  if (first === "down") return { name: "down", options: parseDownArgs(rest) };
  if (first !== undefined && !first.startsWith("-")) {
    throw new Error(`不明なサブコマンド: ${first}`);
  }
  return { name: "up", options: parseArgs(argv) };
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { ...DEFAULT_OPTIONS };
  const args = normalize(argv);

  // --host と --share は排他 (Issue #51)。指定順に依存せず判定するため、
  // ループ後にまとめて解決する。
  let hostExplicit = false;
  let share = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--no-open":
        opts.open = false;
        opts.openExplicit = true;
        break;
      case "--open":
        opts.open = true;
        opts.openExplicit = true;
        break;
      case "--detach":
      case "-d":
        opts.detach = true;
        break;
      case "--port":
        opts.port = parsePort(takeValue(args, i, "--port"));
        i++;
        break;
      case "--host":
        opts.host = takeValue(args, i, "--host");
        hostExplicit = true;
        i++;
        break;
      case "--share":
        share = true;
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

  if (share) {
    if (hostExplicit) {
      throw new Error(
        "--share と --host は同時に指定できません（--share は 0.0.0.0 バインドの明示指定です）",
      );
    }
    opts.host = SHARE_HOST;
  }

  return opts;
}

export function parseDownArgs(argv: readonly string[]): DownOptions {
  const opts: DownOptions = { ...DEFAULT_DOWN_OPTIONS };
  const args = normalize(argv);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--all":
        opts.all = true;
        break;
      case "--port":
        opts.port = parsePort(takeValue(args, i, "--port"));
        i++;
        break;
      default:
        throw new Error(`不明なオプション: ${arg}`);
    }
  }

  if (opts.all && opts.port !== null) {
    throw new Error("--all と --port は同時に指定できません（停止対象が二重に決まります）");
  }

  return opts;
}

/**
 * 実際にブラウザを開くか (Issue #68)。
 * -d のときは既定で開かない — バックグラウンド起動は「ターミナルを離れる」操作で、
 * 毎回タブが増えるのは期待と違う。--open を明示したときだけ開く。
 */
export function shouldOpenBrowser(opts: CliOptions): boolean {
  if (!opts.open) return false;
  return opts.detach ? opts.openExplicit : true;
}
