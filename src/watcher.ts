import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { type FSWatcher, watch } from "chokidar";
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
  /**
   * 監視する階層の上限 (Issue #44)。scanMarkdownTree の maxDepth と同義
   * (ルート直下 = 1)。スキャンで読み込まない深い dir は監視もしないことで、
   * inotify watch 数を抑える。未指定なら無制限 (現行動作)。
   */
  depth?: number;
}

const DEBOUNCE_MS = 80;

/**
 * ディレクトリツリーを監視し、md ファイルの変更を通知する。
 *
 * 監視は chokidar に委譲する。`ignored` で除外ディレクトリ (node_modules 等) を
 * 走査・監視の前段で弾くため、Linux で `fs.inotify.max_user_watches` を枯渇させて
 * ENOSPC を招くことがない (再帰監視が node_modules 全体に watch を張る問題の回避)。
 * ディレクトリの作成・リネーム・削除、エディタのアトミック保存 (swap+rename) も
 * chokidar 側が一貫して扱う。
 *
 * onChange の kind:
 * - "rename": ファイルの追加/削除 (ツリー構造が変化) → クライアントはツリーを再取得
 * - "change": 既存ファイルの内容変更 → クライアントは表示中ファイルを再読込
 */
export function createWatcher(
  rootDir: string,
  onChange: ChangeListener,
  options: WatcherOptions = {},
): WatcherHandle {
  const excludes = options.excludes ?? DEFAULT_EXCLUDES;
  const saveMark = options.saveMark;
  // scanMarkdownTree の maxDepth (ルート直下 = 1) を chokidar の depth に変換する。
  // chokidar の depth は「降りるサブディレクトリの段数」(0 = ルート直下のみ監視) なので
  // maxDepth - 1。未指定なら無制限 (undefined を渡して全段監視)。
  const chokidarDepth = options.depth !== undefined ? options.depth - 1 : undefined;
  const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;
  let enospcWarned = false;

  const fire = (rel: string, kind: ChangeKind) => {
    if (closed) return;
    const existing = debounceMap.get(rel);
    if (existing) clearTimeout(existing);
    debounceMap.set(
      rel,
      setTimeout(async () => {
        debounceMap.delete(rel);
        if (closed) return;
        if (saveMark && (await isOwnSave(rootDir, rel, saveMark))) return;
        if (closed) return; // close() が isOwnSave の await 中に走った場合の保険
        onChange(rel, kind);
      }, DEBOUNCE_MS),
    );
  };

  // 除外ディレクトリ配下は走査・監視しない (ENOSPC 回避の要)。
  // chokidar はこの matcher が true を返すパスへ descend しない。
  const ignored = (absPath: string): boolean => {
    const rel = toPosix(relative(rootDir, absPath));
    // rootDir 自身 (rel === "") や rootDir 外 (".." / "../...") は除外判定の対象外。
    // 単に ".." で始まる名前 (例: "..cache") は通常の in-tree パスなので除外対象に残す。
    if (!rel || rel === ".." || rel.startsWith("../")) return false;
    return isExcludedPath(rel, excludes);
  };

  const emit = (kind: ChangeKind) => (absPath: string) => {
    const rel = toPosix(relative(rootDir, absPath));
    if (!rel || !isMarkdownExtension(rel)) return;
    fire(rel, kind);
  };

  const watcher: FSWatcher = watch(rootDir, {
    ignored,
    ignoreInitial: true,
    followSymlinks: false,
    persistent: true,
    depth: chokidarDepth,
  });

  watcher
    .on("add", emit("rename"))
    .on("change", emit("change"))
    .on("unlink", emit("rename"))
    .on("error", (err) => {
      if (closed) return; // close() 後の teardown エラーはログに出さない
      if ((err as NodeJS.ErrnoException)?.code === "ENOSPC") {
        if (!enospcWarned) {
          enospcWarned = true;
          console.warn(
            "ファイル監視の上限に達しました (ENOSPC)。ディスク容量不足ではなく、" +
              "Linux の inotify watch 上限 (fs.inotify.max_user_watches) の枯渇です。\n" +
              "一部ファイルのライブリロードが無効化されます。次のコマンドで上限を引き上げられます:\n" +
              "  sudo sysctl fs.inotify.max_user_watches=524288",
          );
        }
        return;
      }
      console.error("watcher エラー:", err);
    });

  return {
    close() {
      closed = true;
      for (const t of debounceMap.values()) clearTimeout(t);
      debounceMap.clear();
      void watcher.close();
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
