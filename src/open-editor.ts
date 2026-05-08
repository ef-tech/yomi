import { spawn } from "node:child_process";

/**
 * 外部エディタで指定された絶対パスを開く。
 *
 * 環境変数の優先順:
 *   YOMI_EDITOR > EDITOR > VISUAL > "code"
 *
 * 例: `YOMI_EDITOR="code --wait"` → ['code', '--wait', absPath] で spawn。
 *
 * spawn は `shell: false` で行うので、シェル経由のメタ文字解釈は発生しない。
 * ただし環境変数自体は実行者の制御下にあり、yomi が信頼する。
 */
export interface EditorEnv {
  YOMI_EDITOR?: string | undefined;
  EDITOR?: string | undefined;
  VISUAL?: string | undefined;
}

export function resolveEditorCommand(env: EditorEnv): readonly string[] {
  const raw =
    pickNonEmpty(env.YOMI_EDITOR) ?? pickNonEmpty(env.EDITOR) ?? pickNonEmpty(env.VISUAL) ?? "code";
  return splitCommand(raw);
}

function pickNonEmpty(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t;
}

/** 単純なスペース split。クォートは扱わない (yomi のスコープでは過剰)。 */
export function splitCommand(raw: string): readonly string[] {
  return raw
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0);
}

export interface OpenEditorOptions {
  env?: EditorEnv;
  /** spawn を差し替えたい場合 (テスト用)。実装は spawn と同じシグネチャを期待。 */
  spawnFn?: typeof spawn;
}

export function openEditor(absPath: string, options: OpenEditorOptions = {}): void {
  const env = options.env ?? (process.env as EditorEnv);
  const spawnImpl = options.spawnFn ?? spawn;
  const [cmd, ...args] = resolveEditorCommand(env);
  if (!cmd) {
    throw new Error("エディタコマンドを解決できませんでした");
  }
  const child = spawnImpl(cmd, [...args, absPath], {
    stdio: "ignore",
    detached: true,
  });
  child.on("error", (err) => {
    console.warn(`エディタ起動失敗 (${cmd}): ${err.message}`);
  });
  child.unref();
}
