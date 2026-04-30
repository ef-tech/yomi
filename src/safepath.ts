import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
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
