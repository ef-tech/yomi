import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import pkg from "../package.json" with { type: "json" };
import {
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

  const record: InstanceRecord = {
    pid,
    port: opts.port,
    host: opts.host,
    rootDir: opts.rootDir,
    startedAt: new Date().toISOString(),
    logPath: log,
    version: pkg.version,
  };
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
 */
async function assertPortIsFree(host: string, port: number, paths: RegistryPaths): Promise<void> {
  const existing = (await readInstances(paths)).find((r) => r.port === port);
  if (existing && isAlive(existing.pid)) {
    throw new Error(
      `ポート ${port} では既に yomi が起動しています (pid ${existing.pid}, ${existing.rootDir})。` +
        `停止するには yomi down --port ${port}`,
    );
  }
  if (!(await isPortAvailable(host, port))) {
    throw new Error(`ポート ${port} は既に使用されています。別のポートを指定してください`);
  }
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
}

export interface StopOptions {
  paths?: RegistryPaths;
  timeoutMs?: number;
}

/**
 * インスタンスを停止してレジストリから削除する。
 * SIGTERM → 猶予 → SIGKILL の順で、どちらに転んでも記録は必ず消す。
 */
export async function stopInstance(
  record: InstanceRecord,
  opts: StopOptions = {},
): Promise<StopOutcome> {
  const paths = opts.paths ?? resolvePaths();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

  if (!isAlive(record.pid)) {
    await removeInstance(record.port, paths);
    return { record, forced: false, alreadyGone: true };
  }

  killQuietly(record.pid, "SIGTERM");
  let forced = false;
  if (!(await waitUntilGone(record.pid, timeoutMs))) {
    killQuietly(record.pid, "SIGKILL");
    forced = true;
    await waitUntilGone(record.pid, timeoutMs);
  }

  await removeInstance(record.port, paths);
  return { record, forced, alreadyGone: false };
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
