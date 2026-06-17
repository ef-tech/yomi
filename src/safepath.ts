import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { toPosix } from "./util/path-util.ts";

export { isMarkdownExtension as isMarkdownPath } from "./util/markdown-ext.ts";

export class UnsafePathError extends Error {
  constructor(
    public readonly requestedPath: string,
    message: string,
  ) {
    super(message);
    this.name = "UnsafePathError";
  }
}

export interface ResolvedPath {
  /** rootDir からの正規化された相対パス (POSIX 区切り) */
  rel: string;
  /** 実際にファイル読み取りに使う絶対パス */
  abs: string;
}

export async function resolveSafe(rootDir: string, requested: string): Promise<ResolvedPath> {
  if (!requested) {
    throw new UnsafePathError(requested, "path が空です");
  }
  // NUL byte は Node の fs API で例外になり、その例外文字列がレスポンスに漏れる。
  // ここで早期に reject して 400 で揃える
  if (requested.includes("\0")) {
    throw new UnsafePathError(requested, "path に NUL byte が含まれます");
  }
  if (isAbsolute(requested)) {
    throw new UnsafePathError(requested, "絶対パスは指定できません");
  }
  if (requested.split(/[\\/]/).some((seg) => seg === "..")) {
    throw new UnsafePathError(requested, "親ディレクトリ参照 (..) は禁止です");
  }

  const rootAbs = await safeRealpath(rootDir);
  const requestedAbs = resolve(rootAbs, requested);
  const candidateAbs = await safeRealpath(requestedAbs);
  const rel = relative(rootAbs, candidateAbs);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new UnsafePathError(requested, "ルートディレクトリの外を参照しています");
  }

  // leaf が存在しないと realpath は candidateAbs を解決できず lexical fallback する。
  // その結果、root 内のシンボリックリンク先ディレクトリ (root 外を指す) を経由した
  // 新規ファイル作成を上の rel チェックだけでは検知できない。実在する親ディレクトリの
  // realpath を取り、ルート内に収まっているか再検証する (親は実在するので realpath で
  // symlink が解決される。親自体が存在しなければ呼び出し側の open が ENOENT で弾く)。
  //
  // 既知の限界 (TOCTOU): この realpath チェックと呼び出し側の open(abs) の間に、
  // 親ディレクトリを symlink にすり替えるレースは防げない。完全に塞ぐには各パス成分を
  // O_NOFOLLOW / openat(dirfd) で開く必要があるが、その攻撃にはローカル FS への書き込み
  // 権限が前提で (その攻撃者は既に直接ファイルを作れる)、ローカル/LAN 向けの本ツールには
  // 過剰なため対応しない。静的な symlink エスケープはこのチェックで防げる。
  const parentReal = await safeRealpath(dirname(requestedAbs));
  const parentRel = relative(rootAbs, parentReal);
  if (parentRel === ".." || parentRel.startsWith(`..${sep}`) || isAbsolute(parentRel)) {
    throw new UnsafePathError(requested, "ルートディレクトリの外を参照しています");
  }

  return { rel: toPosix(rel), abs: candidateAbs };
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}
