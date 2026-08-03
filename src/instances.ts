import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * バックグラウンド起動した yomi 1 インスタンスの記録 (Issue #68)。
 * `yomi list` / `yomi down` はこの内容だけを見て対象を決める。
 */
export interface InstanceRecord {
  pid: number;
  port: number;
  /** バインドしたアドレス。公開有無 (local / share) の判定に使う */
  host: string;
  /** 起動したディレクトリ (--depth などと違い down の既定対象を決める鍵になる) */
  rootDir: string;
  /** ISO8601。PID 再利用を疑うときの手がかりとして残す */
  startedAt: string;
  logPath: string;
  version: string;
}

export interface RegistryPaths {
  root: string;
  instances: string;
  logs: string;
}

/**
 * 状態ディレクトリを解決する (XDG Base Directory 準拠)。
 *
 * cwd 直下の `.yomi/` は採らない — プロジェクトごとに .gitignore の追記が要るうえ、
 * 別ディレクトリで起動したインスタンスを `yomi list` からまとめて見られなくなる。
 */
export function resolvePaths(env: Record<string, string | undefined> = process.env): RegistryPaths {
  const xdg = env.XDG_STATE_HOME?.trim();
  const root = xdg ? join(xdg, "yomi") : join(homedir(), ".local", "state", "yomi");
  return { root, instances: join(root, "instances"), logs: join(root, "logs") };
}

/**
 * ポート単位でファイルを分ける。単一 JSON への read-modify-write だと
 * 複数ディレクトリで同時に `yomi up -d` したときに片方の記録が消える。
 */
export function recordPath(port: number, paths: RegistryPaths = resolvePaths()): string {
  return join(paths.instances, `${port}.json`);
}

export function logPath(port: number, paths: RegistryPaths = resolvePaths()): string {
  return join(paths.logs, `${port}.log`);
}

export async function ensureDirs(paths: RegistryPaths = resolvePaths()): Promise<void> {
  // 起動中のディレクトリ一覧は本人以外に見せる必要がない
  await mkdir(paths.instances, { recursive: true, mode: 0o700 });
  await mkdir(paths.logs, { recursive: true, mode: 0o700 });
}

/**
 * インスタンスを記録する。
 * 一時ファイルへ書いてから rename する — 書き込みの途中で電源が落ちると
 * 壊れた JSON が残り、その記録は読み飛ばされる = 生きているプロセスが
 * down からも list からも辿れない孤児になる。rename は同一ディレクトリ内なら原子的。
 */
export async function saveInstance(
  record: InstanceRecord,
  paths: RegistryPaths = resolvePaths(),
): Promise<void> {
  await ensureDirs(paths);
  const target = recordPath(record.port, paths);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

export async function removeInstance(
  port: number,
  paths: RegistryPaths = resolvePaths(),
): Promise<void> {
  await rm(recordPath(port, paths), { force: true });
}

/**
 * レジストリの全エントリを読む (ポート昇順)。
 * 壊れたファイル・想定外の内容は黙って読み飛ばす — 1 件の破損で down / list 全体を
 * 落とすと、残りの生きたインスタンスを止める手段まで失われる。
 */
export async function readInstances(
  paths: RegistryPaths = resolvePaths(),
): Promise<InstanceRecord[]> {
  let names: string[];
  try {
    names = await readdir(paths.instances);
  } catch {
    return []; // ディレクトリ未作成 = 一度もバックグラウンド起動していない
  }

  const records: InstanceRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = parseRecord(JSON.parse(await readFile(join(paths.instances, name), "utf8")));
      if (parsed) records.push(parsed);
    } catch {
      // JSON として読めない / 読み取り権限がない: このエントリだけ無視する
    }
  }
  return records.sort((a, b) => a.port - b.port);
}

function parseRecord(value: unknown): InstanceRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  if (!isPositiveInt(r.pid) || !isPositiveInt(r.port)) return null;
  if (typeof r.host !== "string" || typeof r.rootDir !== "string") return null;
  return {
    pid: r.pid,
    port: r.port,
    host: r.host,
    rootDir: r.rootDir,
    startedAt: typeof r.startedAt === "string" ? r.startedAt : "",
    logPath: typeof r.logPath === "string" ? r.logPath : "",
    version: typeof r.version === "string" ? r.version : "",
  };
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * プロセスの生存確認。signal 0 は実際にはシグナルを送らず、到達可能かだけを返す。
 * /proc に依存しないので macOS / Linux で同じように動く。
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM は「別ユーザーのプロセスだが存在はする」= 生きている
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 生きているインスタンスだけを返し、死んだエントリはレジストリから削除する。
 * `yomi down` と `yomi list` の双方から呼ぶ — 片方だけで掃除すると、
 * そのコマンドを使わない利用者の手元に残骸が溜まり続ける。
 */
export async function liveInstances(
  paths: RegistryPaths = resolvePaths(),
): Promise<InstanceRecord[]> {
  const live: InstanceRecord[] = [];
  for (const record of await readInstances(paths)) {
    if (isAlive(record.pid)) {
      live.push(record);
    } else {
      await removeInstance(record.port, paths);
    }
  }
  return live;
}

/** シンボリックリンク経由で起動した場合も同一視できるよう realpath で突き合わせる */
export function matchesRoot(record: InstanceRecord, dir: string): boolean {
  return canonicalize(record.rootDir) === canonicalize(dir);
}

function canonicalize(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir); // 既に削除されたディレクトリ: 解決できる範囲で比較する
  }
}
