import { resolve, relative, sep, isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";

export class UnsafePathError extends Error {
  constructor(public readonly requestedPath: string, message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

const MD_PATTERN = /\.(md|markdown|mdx)$/i;

export function isMarkdownPath(p: string): boolean {
  return MD_PATTERN.test(p);
}

export interface ResolvedPath {
  /** rootDir からの正規化された相対パス (POSIX 区切り) */
  rel: string;
  /** 実際にファイル読み取りに使う絶対パス */
  abs: string;
}

export async function resolveSafe(
  rootDir: string,
  requested: string,
): Promise<ResolvedPath> {
  if (!requested) {
    throw new UnsafePathError(requested, "path が空です");
  }
  if (isAbsolute(requested)) {
    throw new UnsafePathError(requested, "絶対パスは指定できません");
  }
  if (requested.split(/[\\/]/).some((seg) => seg === "..")) {
    throw new UnsafePathError(requested, "親ディレクトリ参照 (..) は禁止です");
  }

  const rootAbs = await safeRealpath(rootDir);
  const candidateAbs = await safeRealpath(resolve(rootAbs, requested));
  const rel = relative(rootAbs, candidateAbs);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new UnsafePathError(
      requested,
      "ルートディレクトリの外を参照しています",
    );
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

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}
