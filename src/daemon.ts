import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import {
  buildInstanceRecord,
  ensureDirs,
  type InstanceRecord,
  isAlive,
  logPath,
  matchesRoot,
  type RegistryPaths,
  readInstances,
  removeInstance,
  resolvePaths,
  saveInstance,
} from "./instances.ts";
import { isWildcard } from "./network.ts";
import { isPortAvailable } from "./port.ts";

/** 子プロセスが listen を始めるまで待つ既定の上限 */
export const DEFAULT_READY_TIMEOUT_MS = 10_000;
/** SIGTERM を送ってから SIGKILL に切り替えるまでの既定の猶予 */
export const DEFAULT_STOP_TIMEOUT_MS = 5_000;

const POLL_INTERVAL_MS = 100;

/**
 * 切り離された子であることを本人に伝える内部フラグ。
 * 子はログ先頭のバナーで「Ctrl+C で停止」と案内してはいけない
 * (端末から切り離されているので届かない) ため、案内を yomi down に切り替える。
 */
export const DETACHED_ENV = "YOMI_DETACHED";

export interface StartDetachedOptions {
  rootDir: string;
  host: string;
  port: number;
  depth: number | null;
  paths?: RegistryPaths;
  readyTimeoutMs?: number;
  /** 子として起動するエントリスクリプト (既定: 現在実行中の bin/yomi.ts) */
  entry?: string;
  /** 子を動かすランタイム (既定: 現在の bun) */
  runtime?: string;
}

/**
 * yomi サーバを切り離したプロセスとして起動し、レジストリに記録する (Issue #68)。
 *
 * ポートは呼び出し側で確定させてから渡す。子に自動探索させると親が実ポートを知れず、
 * レジストリに書けない (= down / list から辿れない) ため。
 */
export async function startDetached(opts: StartDetachedOptions): Promise<InstanceRecord> {
  const paths = opts.paths ?? resolvePaths();
  await assertPortIsFree(opts.host, opts.port, paths);
  await ensureDirs(paths);

  const log = logPath(opts.port, paths);
  // 追記で開く。切り詰めると直前の起動失敗の手がかりが消える。
  const logFd = openSync(log, "a");

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(opts.runtime ?? process.execPath, [opts.entry ?? Bun.main, ...childArgs(opts)], {
      cwd: opts.rootDir,
      env: { ...process.env, [DETACHED_ENV]: "1" },
      // setsid 相当。プロセスグループを分けないと、起動したターミナルで Ctrl+C を
      // 押したときに切り離したはずのサーバまで巻き添えで死ぬ。
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd); // fd は子に複製済み
  }

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("バックグラウンドプロセスを起動できませんでした");
  }

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.unref();

  const ready = await waitUntilReady(
    opts.host,
    opts.port,
    opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    () => !exited,
  );

  // ready だけでは足りない: 事前チェックの直後に別プロセスがポートを奪うと、
  // 死んだ子のまま接続だけ成功しうる。最後に生存を見て取りこぼしを潰す。
  if (!ready || !isAlive(pid)) {
    // 起動できなかったプロセスの記録は残さない (list に幽霊が並ぶ)
    killQuietly(pid, "SIGKILL");
    throw new Error(`バックグラウンド起動に失敗しました。${await describeLogTail(log)}`);
  }

  const record = buildInstanceRecord({
    pid,
    port: opts.port,
    host: opts.host,
    rootDir: opts.rootDir,
    logPath: log,
  });
  await saveInstance(record, paths);
  return record;
}

/**
 * 起動前にポートの空きを確かめる。
 *
 * 「子が listen できたか」を TCP 接続だけで判定すると、**別プロセスが同じポートを
 * 掴んでいる場合に、子が即死していても接続に成功して「起動できた」と誤判定**する。
 * その状態でレジストリを書くと、先に動いていたインスタンスの記録を死んだ pid で
 * 上書きし、生きているプロセスが down からも list からも辿れない孤児になる。
 *
 * **フォアグラウンド起動 (`bin/yomi.ts` の `runUp`) からも使う (Issue #94)。**
 * バックグラウンドだけに掛けていたため、`yomi --port <使用中>` は `Bun.serve` の
 * throw がそのまま `main().catch` へ流れ、ソースの抜粋つきスタックトレースが出ていた。
 * 判定と文面をここに集約して、どちらの経路でも同じ案内を出す。
 */
export async function assertPortIsFree(
  host: string,
  port: number,
  paths: RegistryPaths,
): Promise<void> {
  const reason = await describePortInUse(host, port, paths);
  if (reason !== null) throw new Error(reason);
}

/**
 * **そのポートが使えない理由を 1 行で返す。使えるなら `null`** (Issue #107)。
 *
 * 文面の正本。{@link assertPortIsFree} は「非 null なら throw」するだけの薄い皮で、
 * {@link describeServeFailure} はこれをそのまま返す。
 *
 * **例外ではなく値で返す形にしてある。** 以前は `describeServeFailure` が
 * `assertPortIsFree` を呼び直して**「throw されること」に依存**していた。判定に
 * 非 throw の分岐が 1 本増えるだけで、黙って「確保できませんでした」に落ちる
 * —— 例外も出ずテストも落ちない壊れ方をする。
 *
 * ## 残る誤り (Issue #108)
 *
 * `isThisInstance` は pid の生存とポートの listen を**独立に**見るので、
 * 「残骸記録の pid が再利用されて生きている」＋「**無関係な第三者**がそのポートを
 * 掴んでいる」が同時に成り立つと、`pid <無関係な pid>` で「yomi が起動しています」と
 * 誤って名指しする。とくに `describeServeFailure` の経路は**ポートが必ず誰かに
 * 掴まれている状態**で呼ばれるので、この誤認が起きやすい。
 *
 * `isAlive` 単独だった頃も同じ誤答なので**悪化はしていない**。**が、案内どおり
 * `yomi down --port <n>` を打つと、`stopInstance` からも `isThisInstance` が true に
 * 見えるので、無関係なプロセスへ SIGTERM が飛ぶ**（実測。`yomi list` にも同じ理由で並ぶ）。
 * つまり list / 起動検査 / down が**揃って同じ間違いをする**。→ **#132**
 *
 * ここを直すには「そのポートで listen している = yomi 本人」という同定そのものを
 * 変える必要があり、`stopInstance` も巻き込むので #108 のスコープを超える。
 */
export async function describePortInUse(
  host: string,
  port: number,
  paths: RegistryPaths,
): Promise<string | null> {
  const existing = (await readInstances(paths)).find((r) => r.port === port);
  // **判定は list / down と同じ基準（pid 生存 + 記録したポートで listen）(Issue #108)。**
  // pid の生存だけを見ていたので、**残骸記録の pid が別プロセスに再利用されている**と、
  // ポートが空いていても拒否していた。残骸は SIGHUP や SIGKILL で普通に発生する
  // （`installShutdownHandlers` は SIGINT / SIGTERM しか捕まえない）。
  //
  // その状態は「`yomi list` には出ないのに起動できない」という食い違いになる。
  // #94 が事前検査をフォアグラウンドからも呼ぶようにしたことで露出した。
  if (existing && (await isThisInstance(existing))) {
    return (
      `ポート ${port} では既に yomi が起動しています (pid ${existing.pid}, ${existing.rootDir})。` +
      `停止するには yomi down --port ${port}`
    );
  }
  if (!(await isPortAvailable(host, port))) {
    return `ポート ${port} は既に使用されています。別のポートを指定してください`;
  }
  return null;
}

/**
 * `Bun.serve` の失敗を、{@link describePortInUse} と同じ文面へ変換する (Issue #107)。
 *
 * ## なぜ要るか
 *
 * #94 が事前検査を入れたが、**検査と `Bun.serve` の間には隙間がある**。その窓で
 * 別プロセスがポートを掴むと、throw が `main().catch` へ流れて**ソースの抜粋つき
 * スタックトレース**が出る（#94 以前の出力に戻る）。事前検査を通らない経路
 * （切り離された子＝`YOMI_DETACHED=1`）でも同じことが起きる。
 *
 * 事前検査は「レジストリ由来の案内を先出しする」役割に純化し、**最後の砦はここ**にする。
 *
 * **レジストリ読み込みと bind 試行を行う**（名前から想像するより重い）。
 *
 * @returns 利用者向けの 1 行。**ポート衝突でなければ `null`**（呼び出し元はそのまま
 *   投げ直すこと —— 別の原因を「ポートが使われています」に化けさせない）
 */
export async function describeServeFailure(
  err: unknown,
  host: string,
  port: number,
  paths: RegistryPaths,
): Promise<string | null> {
  if (!isAddrInUse(err)) return null;
  const reason = await describePortInUse(host, port, paths);
  if (reason !== null) return reason;
  // **調べたら空いていた** = EADDRINUSE を受けてから相手が消えた。
  // もう「使用中」とは言えないので、そう書かずに再試行を促す
  return `ポート ${port} を確保できませんでした。もう一度お試しください`;
}

/**
 * bind に失敗したことを示すエラーか。
 *
 * **「ポートが埋まっている」とまでは言えない。** Bun は EADDRNOTAVAIL
 * （その `--host` が自分のアドレスでない）も `EADDRINUSE` に寄せてくるので、
 * ここが true でも原因がポートとは限らない。文面の精度は
 * {@link describePortInUse} 側の判定に依存する。
 *
 * `code` を第一の根拠にしつつ、**メッセージも見る** —— ランタイムが `code` を
 * 載せない形に変わると、黙ってスタックトレースに戻る（この Issue が直したかったもの）。
 * **Bun の現行メッセージに `EADDRINUSE` の文字列は入っていない**（実測:
 * `Failed to start server. Is port 39777 in use?`）ので、その言い回しも拾う。
 */
function isAddrInUse(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "EADDRINUSE") return true;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== "string") return false;
  return message.includes("EADDRINUSE") || /is port \d+ in use/i.test(message);
}

function childArgs(opts: StartDetachedOptions): string[] {
  // 子は通常のフォアグラウンド起動。--no-open は親側でブラウザを開くため常に付ける。
  const args = ["up", "--port", String(opts.port), "--host", opts.host, "--no-open"];
  if (opts.depth !== null) args.push("--depth", String(opts.depth));
  return args;
}

export interface StopOutcome {
  record: InstanceRecord;
  /** SIGTERM で終わらず SIGKILL まで至ったか */
  forced: boolean;
  /** シグナルを送る時点で既に居なかったか (レジストリだけ残っていた) */
  alreadyGone: boolean;
  /** 実際に終了させられたか。SIGKILL でも消えなかった場合は false */
  stopped: boolean;
}

export interface StopOptions {
  paths?: RegistryPaths;
  timeoutMs?: number;
}

/**
 * インスタンスを停止してレジストリから削除する。
 * SIGTERM → 猶予 → SIGKILL の順に試し、終了を見届けてから記録を消す。
 */
export async function stopInstance(
  record: InstanceRecord,
  opts: StopOptions = {},
): Promise<StopOutcome> {
  const paths = opts.paths ?? resolvePaths();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

  if (!(await isThisInstance(record))) {
    await removeInstance(record.port, paths);
    return { record, forced: false, alreadyGone: true, stopped: true };
  }

  killQuietly(record.pid, "SIGTERM");
  let forced = false;
  let stopped = await waitUntilGone(record.pid, timeoutMs);
  if (!stopped) {
    killQuietly(record.pid, "SIGKILL");
    forced = true;
    stopped = await waitUntilGone(record.pid, timeoutMs);
  }

  // 落とせていないのに記録を消すと、二度と down から辿れない孤児になる
  if (stopped) await removeInstance(record.port, paths);
  return { record, forced, alreadyGone: false, stopped };
}

/**
 * 実際に応答しているインスタンスだけを返し、外れた記録は削除する (Issue #69)。
 *
 * `liveInstances` は pid の生存しか見ないので、pid が再利用されていると「生きている」と
 * 誤判定する。**一覧に出したものは down で止められるべき**なので、表示にもシグナル送信と
 * 同じ基準（pid 生存 + 記録したポートで listen）を使い、判定を食い違わせない。
 *
 * `yomi down` 側があえて `liveInstances`（pid だけ）を使うのは、拾える記録は拾ったうえで
 * `stopInstance` に「既に終了していました。記録を削除しました」と報告させるため。
 */
export async function servingInstances(
  paths: RegistryPaths = resolvePaths(),
): Promise<InstanceRecord[]> {
  const serving: InstanceRecord[] = [];
  for (const record of await readInstances(paths)) {
    if (await isThisInstance(record)) {
      serving.push(record);
    } else {
      await removeInstance(record.port, paths);
    }
  }
  return serving;
}

/**
 * 記録された pid が本当にこのインスタンスか。
 *
 * pid の生存だけを信じると、yomi が異常終了したあとに OS が pid を再利用した場合、
 * **無関係なプロセスへ SIGKILL を送ってしまう**（取り返しがつかない）。
 * 記録したポートで実際に listen していることを合わせて確認し、
 * どちらか一方でも満たさなければシグナルを送らずに記録だけ片付ける。
 */
async function isThisInstance(record: InstanceRecord): Promise<boolean> {
  if (!isAlive(record.pid)) return false;
  const target = isWildcard(record.host) ? "127.0.0.1" : record.host;
  return canConnect(target, record.port);
}

/**
 * `yomi down` の停止対象を選ぶ。
 * 既定がカレントディレクトリなのは、別プロジェクトで開いている yomi を
 * 巻き添えで落とさないため (全部止めたいときは --all を明示する)。
 */
export function selectStopTargets(
  instances: readonly InstanceRecord[],
  options: { all: boolean; port: number | null },
  cwd: string,
): InstanceRecord[] {
  if (options.all) return [...instances];
  if (options.port !== null) return instances.filter((r) => r.port === options.port);
  return instances.filter((r) => matchesRoot(r, cwd));
}

/** 停止結果を利用者向けの 1 行にする */
export function describeStop(outcome: StopOutcome): string {
  const where = `pid ${outcome.record.pid} / :${outcome.record.port}`;
  if (!outcome.stopped) {
    // 別ユーザーのプロセスなど、SIGKILL が届かなかった場合。記録は残してある
    return `yomi を停止できませんでした (${where})。手動で終了してください: kill -9 ${outcome.record.pid}`;
  }
  if (outcome.alreadyGone) {
    return `yomi は既に終了していました (${where})。記録を削除しました`;
  }
  if (outcome.forced) {
    return `yomi を強制終了しました (${where}, SIGTERM に応答しないため SIGKILL)`;
  }
  return `yomi を停止しました (${where})`;
}

/** 停止対象が無かったときの案内。異常ではないので終了コードは 0 のまま */
export function describeNoStopTarget(options: {
  all: boolean;
  port: number | null;
  cwd: string;
}): string {
  if (options.all) {
    return "停止対象がありません（バックグラウンドで起動中の yomi はありません）";
  }
  if (options.port !== null) {
    return `停止対象がありません（ポート ${options.port} で起動中の yomi はありません）`;
  }
  return `停止対象がありません（${options.cwd} で起動した yomi はありません）
ほかの場所で起動したものを止めるには yomi down --all`;
}

function killQuietly(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // 既に消えている / 権限がない: 呼び出し側は生存確認で判断する
  }
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return !isAlive(pid);
}

async function waitUntilReady(
  host: string,
  port: number,
  timeoutMs: number,
  childAlive: () => boolean,
): Promise<boolean> {
  // 0.0.0.0 宛には接続できないのでループバックで確認する
  const target = isWildcard(host) ? "127.0.0.1" : host;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 生存確認を先に置く。接続を先に見ると、別プロセスが同じポートを
    // 掴んでいる間に子が死んでいても「起動できた」と読めてしまう。
    if (!childAlive()) return false;
    if (await canConnect(target, port)) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(POLL_INTERVAL_MS * 5);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

/** 起動失敗時にログ末尾を添える (ログパスだけ示されても原因が分からない) */
async function describeLogTail(file: string, lines = 5): Promise<string> {
  try {
    const tail = (await readFile(file, "utf8")).trimEnd().split("\n").slice(-lines).join("\n");
    if (tail === "") return `ログ: ${file}`;
    return `ログ: ${file}\n${tail}`;
  } catch {
    return `ログ: ${file}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
