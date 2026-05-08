import { type FSWatcher, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type SaveMark, sha256 } from "./save-mark.ts";
import { DEFAULT_EXCLUDES, isExcludedPath } from "./util/excludes.ts";
import { isMarkdownExtension } from "./util/markdown-ext.ts";
import { toPosix } from "./util/path-util.ts";

export type ChangeKind = "rename" | "change";

export type ChangeListener = (path: string, kind: ChangeKind) => void;

export interface WatcherHandle {
  close(): void;
}

export interface WatcherOptions {
  /** 除外するディレクトリ/ファイル名のセット (省略時は DEFAULT_EXCLUDES) */
  excludes?: ReadonlySet<string>;
  /** 自己保存マーク。イベントの現状ファイル sha がここに登録された値と一致する場合は publish しない */
  saveMark?: SaveMark;
}

const DEBOUNCE_MS = 80;

export function createWatcher(
  rootDir: string,
  onChange: ChangeListener,
  options: WatcherOptions = {},
): WatcherHandle {
  const excludes = options.excludes ?? DEFAULT_EXCLUDES;
  const saveMark = options.saveMark;
  const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();

  const fire = (path: string, kind: ChangeKind) => {
    const existing = debounceMap.get(path);
    if (existing) clearTimeout(existing);
    debounceMap.set(
      path,
      setTimeout(async () => {
        debounceMap.delete(path);
        if (saveMark && (await isOwnSave(rootDir, path, saveMark))) return;
        onChange(path, kind);
      }, DEBOUNCE_MS),
    );
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(rootDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const rel = toPosix(String(filename));
      if (!rel) return;
      if (isExcludedPath(rel, excludes)) return;
      if (!isMarkdownExtension(rel)) return;
      fire(rel, eventType === "rename" ? "rename" : "change");
    });
  } catch (err) {
    console.warn(
      `ファイル監視を開始できません: ${(err as Error).message}\n` +
        "ライブリロードは無効化されます。",
    );
    return { close: () => {} };
  }

  watcher.on("error", (err) => {
    console.error("watcher エラー:", err);
  });

  return {
    close() {
      for (const t of debounceMap.values()) clearTimeout(t);
      debounceMap.clear();
      watcher.close();
    },
  };
}

async function isOwnSave(rootDir: string, rel: string, saveMark: SaveMark): Promise<boolean> {
  try {
    const buf = await readFile(resolve(rootDir, rel));
    return saveMark.has(rel, sha256(buf));
  } catch {
    // 削除済み等で読めない場合はマーク無関係 (= 通常通り publish)
    return false;
  }
}
