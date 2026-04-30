import { watch } from "node:fs";
import { sep } from "node:path";
import { DEFAULT_EXCLUDES, MD_EXTENSIONS } from "./scanner.ts";

export type ChangeKind = "rename" | "change";

export type ChangeListener = (path: string, kind: ChangeKind) => void;

export interface WatcherHandle {
  close(): void;
}

const DEBOUNCE_MS = 80;

export function createWatcher(
  rootDir: string,
  onChange: ChangeListener,
): WatcherHandle {
  const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();

  const fire = (path: string, kind: ChangeKind) => {
    const existing = debounceMap.get(path);
    if (existing) clearTimeout(existing);
    debounceMap.set(
      path,
      setTimeout(() => {
        debounceMap.delete(path);
        onChange(path, kind);
      }, DEBOUNCE_MS),
    );
  };

  let watcher;
  try {
    watcher = watch(
      rootDir,
      { recursive: true },
      (eventType, filename) => {
        if (!filename) return;
        const rel = toPosix(String(filename));
        if (!rel) return;
        if (isExcluded(rel)) return;
        if (!isMarkdownFile(rel)) return;
        fire(rel, eventType === "rename" ? "rename" : "change");
      },
    );
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

function isExcluded(rel: string): boolean {
  const segs = rel.split("/");
  return segs.some((s) => DEFAULT_EXCLUDES.has(s));
}

function isMarkdownFile(rel: string): boolean {
  const dot = rel.lastIndexOf(".");
  if (dot < 0) return false;
  return MD_EXTENSIONS.has(rel.slice(dot).toLowerCase());
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}
