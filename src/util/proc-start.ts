import { readFile } from "node:fs/promises";

/**
 * プロセスの起動時刻を読む (Issue #132)。
 *
 * ## なぜ要るか
 *
 * pid だけでは**プロセスを同定できない**。yomi が異常終了したあと OS が pid を再利用すると、
 * レジストリの記録が**無関係なプロセス**を指す。そこへ `yomi down` が SIGTERM を送って
 * 「停止しました」と報告する事故が実際に起きた（#132）。
 *
 * **起動時刻を突き合わせれば pid 再利用を直接潰せる。** 同じ pid でも、別プロセスなら
 * 起動時刻が違う（同じ pid が同じ時刻に 2 回始まることはない）。
 *
 * ## ポートの疎通では代われない
 *
 * 「そのポートで listen しているか」も同定に使えそうだが、**2 つの理由で足りない**:
 *
 * - **第三者がそのポートを掴んでいれば true になる** —— これが #132 の穴そのもの
 * - **応答しなくなった yomi を落とせなくなる。** `down` が最も要るのはハングしたときで、
 *   疎通を条件にすると「記録だけ消して本体は生き残る」ことになる
 *
 * ## 返す値は不透明な文字列
 *
 * OS ごとに取れる形が違う（Linux は boot からの tick 数、macOS は日時の文字列）ので、
 * **中身を解釈せず、同じ OS 上で一致するかだけを見る**。記録した値と読み直した値を
 * 文字列比較する使い方を想定している。
 */

/** どの OS でどう読んだかを値に残す。書式が変わったときに古い記録と誤って一致しないため。 */
type Platform = "linux" | "darwin";

/**
 * `pid` のプロセスが始まった時刻を、その OS 固有の表現で返す。
 *
 * @returns 不透明な文字列（例: `linux:12345678`）。**プロセスが居ない・OS が未対応・
 *   読み取りに失敗したときは `null`**。呼び出し側は `null` を「同定できない」として扱う
 */
export async function processStartedAt(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const platform = process.platform;
  if (platform === "linux") return readLinux(pid);
  if (platform === "darwin") return readDarwin(pid);
  // それ以外の OS では同定できない。**推測で値を作らない**（誤って一致すると誤爆する）
  return null;
}

/**
 * Linux: `/proc/<pid>/stat` の 22 番目のフィールド（starttime、boot からの clock tick）。
 *
 * **`comm`（2 番目）は空白や括弧を含みうる**ので、単純な `split(" ")` では位置がずれる。
 * 仕様どおり**最後の `)` より後ろ**を数える。
 */
async function readLinux(pid: number): Promise<string | null> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf-8");
  } catch {
    return null; // プロセスが居ない / 読めない
  }
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  // `)` の次が state（3 番目）。starttime は 22 番目なので、そこから 19 個先
  const fields = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const startTicks = fields[19];
  if (!startTicks || !/^\d+$/.test(startTicks)) return null;
  // **boot_id を混ぜる。** `starttime` は boot からの tick 数なので、**再起動すると
  // 値域が先頭から走り直す** —— レジストリは再起動で消えないので、同じ `pid + tick` を
  // 持つ別プロセスを「本人」と誤認しうる。$HOME を複数ホストで共有している場合も同じ。
  const bootId = await readBootId();
  return format("linux", bootId ? `${bootId}:${startTicks}` : startTicks);
}

/** この boot を識別する UUID。読めなければ null（値から落とす）。 */
async function readBootId(): Promise<string | null> {
  try {
    return (await readFile("/proc/sys/kernel/random/boot_id", "utf-8")).trim() || null;
  } catch {
    return null;
  }
}

/**
 * macOS: `ps -p <pid> -o lstart=`。
 *
 * **`TZ` と `LC_ALL` を固定する。** `lstart` は**ローカル時刻の文字列**なので、
 * 記録したときと読み直すときで時間帯や言語が違うと、同じプロセスでも文字列が一致しない
 * （`水  8月 12 12:53:46 2026` と `Wed Aug 12 03:53:46 2026`）。macOS では GUI 起動と
 * ターミナルで `LANG` が違う・移動で時間帯が変わる・DST を跨ぐ、が普通に起きる。
 * 一致しないと**生きている本物を止められなくなる**（安全側だが `down` が壊れる）。
 *
 * **精度は 1 秒**なので、同じ秒のうちに pid が再利用されると見分けられない。
 * `/proc` が無いので他に安定して取れる手が無く、ここは限界として受け入れる
 * （pid の再利用は通常もっと長い周期で起きる）。
 */
async function readDarwin(pid: number): Promise<string | null> {
  const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "lstart="], {
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
  });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !out) return null;
  return format("darwin", out);
}

function format(platform: Platform, value: string): string {
  return `${platform}:${value}`;
}

/**
 * そのプロセスが **yomi かどうか**を、コマンドラインから見る (Issue #132)。
 *
 * ## 何に使うか
 *
 * {@link processStartedAt} で同定できないとき（**v0.21.0 以前の記録**・未対応 OS）の
 * 最後の関門。起動時刻が無くても、**「そもそも yomi ですらない」ものは弾ける**。
 *
 * これが無いと、古い記録に対して #132 の穴がそのまま残る —— しかも
 * 「pid が再利用されて生きている ＋ 第三者がポートを掴んでいる」という危険な配置では
 * **記録が掃除されないので窓が閉じない**（`liveInstances` は pid が死んだものだけ、
 * `servingInstances` は疎通しないものだけを消す）。
 *
 * ## 限界
 *
 * **「yomi である」までしか言えない。** 再利用された pid が偶然また別の yomi だった場合は
 * 見分けられない。それでも「無関係なプロセスを殺す」という #132 の被害は防げる
 * （報告された事例の犠牲者も yomi ではなかった）。
 *
 * @returns yomi らしければ `true`。**読めない・判定できないときは `null`**
 *   （呼び出し側が「分からない」を区別できるように、`false` と分ける）
 */
export async function looksLikeYomi(pid: number): Promise<boolean | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const cmdline = await readCmdline(pid);
  if (cmdline === null) return null;
  // 実物: `bun /…/bin/yomi.ts --port N --no-open` / `/…/bun /…/yomi.ts up --port N …`
  return /(^|[/\s])yomi(\.ts)?([/\s]|$)/.test(cmdline);
}

async function readCmdline(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      // NUL 区切り。空白に均してから見る
      return (await readFile(`/proc/${pid}/cmdline`, "utf-8")).replace(/\0/g, " ").trim() || null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, LC_ALL: "C" },
    });
    const out = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && out ? out : null;
  }
  return null;
}
