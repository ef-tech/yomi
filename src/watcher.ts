import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import { type SaveMark, sha256 } from "./save-mark.ts";
import { DEFAULT_EXCLUDES, isExcludedPath } from "./util/excludes.ts";
import { isMarkdownExtension } from "./util/markdown-ext.ts";
import { toPosix } from "./util/path-util.ts";

/**
 * 何が起きたか。
 *
 * **`add` と `unlink` を畳まない (Issue #126)。** 以前はどちらも `"rename"` の一語で、
 * 受け取った側は「ツリーの形が変わった」ことしか分からず、**全量を取り直す以外に
 * 手が無かった**。追加と削除を区別して初めて、サーバは「どこが」「どう」変わったかを
 * 送れる（`src/server.ts` の `tree` 通知）。
 */
export type ChangeKind = "add" | "unlink" | "change";

/** ツリーの形が変わる種類か（内容だけの変更と分ける）。 */
export function isStructuralChange(kind: ChangeKind): boolean {
  return kind === "add" || kind === "unlink";
}

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
  /**
   * ファイル監視の実装を差し替える (既定は chokidar の `watch`)。テスト専用の注入口。
   * 実 OS のファイル監視 (macOS の FSEvents はイベント配信遅延・重複/結合がある) に
   * 依存せず、フェイクイベントで fire()→isOwnSave→onChange の経路を決定論的に検証するため。
   * 本番では未指定 (= chokidar) のまま (Issue #45)。
   */
  watch?: typeof watch;
  /**
   * chokidar の初期スキャン完了 (ready イベント) 時に呼ばれる。テスト専用の注入口。
   * 実 chokidar 統合テストが固定 sleep ではなく ready を待ってから書き込むことで、
   * 初期スキャンが想定より遅い CI でもイベントを取りこぼさない (Issue #45)。
   */
  onReady?: () => void;
}

const DEBOUNCE_MS = 80;

/**
 * tree level の深さ (ルート直下 = 1、scanMarkdownTree の maxDepth と同義) を
 * chokidar の depth (降りるサブディレクトリの段数、ルート直下 = 0) へ変換する。
 * 両者の規約差 (-1 オフセット) をこの 1 箇所に閉じ込める。undefined は無制限。
 */
export function toChokidarDepth(treeDepth: number | undefined): number | undefined {
  return treeDepth !== undefined ? treeDepth - 1 : undefined;
}

/**
 * ディレクトリツリーを監視し、md ファイルの変更を通知する。
 *
 * 監視は chokidar に委譲する。`ignored` で除外ディレクトリ (node_modules 等) を
 * 走査・監視の前段で弾くため、Linux で `fs.inotify.max_user_watches` を枯渇させて
 * ENOSPC を招くことがない (再帰監視が node_modules 全体に watch を張る問題の回避)。
 * ディレクトリの作成・リネーム・削除、エディタのアトミック保存 (swap+rename) も
 * chokidar 側が扱う（外部エディタの保存は未測定）。
 *
 * **別の話として、書き込みと rename が近すぎると Bun の `fs.watch` が取りこぼす。**
 * `writeFileAtomic` (Issue #101) の上書きが 5 回に 4 回ほど届かなかった ——
 * **rename の直前に待つことで解消済み** (Issue #119 の `WATCH_GAP_MS`)。
 *
 * **yomi 以外が同じ速さで temp + rename すると、依然として取りこぼす。**
 * 原因は chokidar ではなく Bun（Node の `fs.watch` は同条件で取りこぼさない）。
 * 上流への報告は #138。計測は `scripts/probe-watcher-atomic.ts`。
 *
 * onChange の kind ({@link ChangeKind}):
 * - "add" / "unlink": ファイルの追加/削除 (ツリー構造が変化) → サーバは差分を通知する
 * - "change": 既存ファイルの内容変更 → クライアントは表示中ファイルを再読込
 */
export function createWatcher(
  rootDir: string,
  onChange: ChangeListener,
  options: WatcherOptions = {},
): WatcherHandle {
  const excludes = options.excludes ?? DEFAULT_EXCLUDES;
  const saveMark = options.saveMark;
  // tree level の depth を chokidar の depth へ変換 (toChokidarDepth 参照)。
  const chokidarDepth = toChokidarDepth(options.depth);
  let closed = false;
  let enospcWarned = false;

  /**
   * debounce 中に何が起きたかを覚えておく (Issue #126)。
   *
   * **最後の kind で上書きしてはいけない。** `writeFile` 1 回でも chokidar は
   * `add` の直後に `change` を出すことがあり、上書きすると**「追加」が「内容変更」に
   * 化ける**。受け取った側はツリーを更新しないので、**新しいファイルが一覧に出ない**
   * （#84 で `changed` がツリーを取り直さなくなって以来の穴。実測で踏んだ）。
   *
   * 構造の変化（`add` / `unlink`）と内容の変化（`change`）は**別のことを伝える**ので、
   * 片方でもう片方を消さず、両方あったら両方伝える。
   */
  interface Pending {
    timer: ReturnType<typeof setTimeout>;
    /** この窓で最後に起きた構造の変化。**後のものが勝つ**（add → unlink なら消えている） */
    structural: ChangeKind | null;
    /** この窓で内容の変化があったか */
    changed: boolean;
  }
  const debounceMap = new Map<string, Pending>();

  const fire = (rel: string, kind: ChangeKind) => {
    if (closed) return;
    const existing = debounceMap.get(rel);
    if (existing) clearTimeout(existing.timer);
    const structural = isStructuralChange(kind) ? kind : (existing?.structural ?? null);
    const changed = kind === "change" ? true : (existing?.changed ?? false);
    const timer = setTimeout(async () => {
      debounceMap.delete(rel);
      if (closed) return;
      if (saveMark && (await isOwnSave(rootDir, rel, saveMark))) return;
      if (closed) return; // close() が isOwnSave の await 中に走った場合の保険
      if (structural) onChange(rel, structural);
      // **消えたファイルの再読込は促さない。** `unlink` で終わっているならもう無い
      if (changed && structural !== "unlink") onChange(rel, "change");
    }, DEBOUNCE_MS);
    debounceMap.set(rel, { timer, structural, changed });
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

  // 既定は chokidar の watch。テストは options.watch でフェイクを注入して決定論化する (Issue #45)。
  const watchFn = options.watch ?? watch;
  const watcher: FSWatcher = watchFn(rootDir, {
    ignored,
    ignoreInitial: true,
    followSymlinks: false,
    persistent: true,
    depth: chokidarDepth,
  });

  watcher
    .on("add", emit("add"))
    .on("change", emit("change"))
    .on("unlink", emit("unlink"))
    // 初期スキャン完了。テストが固定 sleep でなく ready を待って書き込めるようにする (Issue #45)
    .on("ready", () => options.onReady?.())
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
      for (const p of debounceMap.values()) clearTimeout(p.timer);
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
