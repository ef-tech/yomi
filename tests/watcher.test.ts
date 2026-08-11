import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FSWatcher } from "chokidar";
import { SaveMark, sha256 } from "../src/save-mark.ts";
import { WATCH_GAP_MS, writeFileAtomic } from "../src/util/atomic-write.ts";
import {
  type ChangeListener,
  createWatcher,
  toChokidarDepth,
  type WatcherHandle,
  type WatcherOptions,
} from "../src/watcher.ts";

/** イベントの落ち着き (debounce 80ms + 配送) を待つ猶予。 */
const DEBOUNCE_MARGIN_MS = 300;
/** フェイクイベント経路の settle 余裕 (debounce 80ms + isOwnSave の readFile を十分に超える固定値)。 */
const SETTLE_MS = 200;

function wait(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * predicate が真になるまで上限付きで poll する。固定 sleep + assert だと、macOS の
 * FSEvents 配信遅延で「まだ届いていないだけ」を失敗と誤判定してしまう (Issue #45)。
 * timeout は Bun のテストタイムアウト (5s) より短くし、退行時に waitFor 側が先に
 * reject して失敗を正しく帰属できるようにする。
 */
async function waitFor(
  predicate: () => boolean,
  { timeout = 3000, interval = 20 }: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout)
      throw new Error("waitFor: 条件が時間内に満たされませんでした");
    await wait(interval);
  }
}

/**
 * 実 chokidar 統合テスト用。初期スキャン完了 (ready) を Promise で待てるようにする。
 * 固定 sleep で ready を推測すると、初期スキャンが遅い CI で ready 前の書き込みが
 * 初期ファイル扱い (ignoreInitial) で取りこぼされ flaky になる (Issue #45)。
 */
function startWatcher(
  root: string,
  onChange: ChangeListener,
  options: WatcherOptions = {},
): { handle: WatcherHandle; ready: Promise<void> } {
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((res) => {
    resolveReady = res;
  });
  const handle = createWatcher(root, onChange, { ...options, onReady: () => resolveReady() });
  return { handle, ready };
}

type FakeEvent = "add" | "change" | "unlink";

/** createWatcher が watchFn に渡す options のうち、テストで直接検証したい項目。 */
interface CapturedWatchOptions {
  ignored: (path: string) => boolean;
  depth: number | undefined;
}

/**
 * chokidar の実ファイル監視を差し替えるフェイク。createWatcher が使う最小 API
 * (`.on(event, handler)` チェーン + `.close()`) だけを実装し、`emit()` でテストが
 * イベントの内容とタイミングを完全に制御できる。渡された options も捕捉して、除外・
 * depth 設定を実 FS のタイミングに依存せず決定論的に検証できる (Issue #45)。
 */
function createFakeWatch() {
  const handlers = new Map<string, (arg: string) => void>();
  let closed = false;
  let root = "";
  let captured: CapturedWatchOptions | null = null;

  const fake = {
    on(event: string, handler: (arg: string) => void) {
      handlers.set(event, handler);
      return fake;
    },
    close() {
      closed = true;
    },
  };

  // createWatcher は watch(rootDir, options) の形で呼ぶ。rootDir と options を捕まえる。
  const watch = ((paths: string, opts: CapturedWatchOptions) => {
    root = paths;
    captured = opts;
    return fake as unknown as FSWatcher;
  }) as unknown as NonNullable<WatcherOptions["watch"]>;

  /** テストからイベントを発火する (rel は rootDir 基準の相対名)。close 後は何もしない。 */
  const emit = (event: FakeEvent, rel: string) => {
    if (closed) return;
    handlers.get(event)?.(join(root, rel));
  };

  /** watchFn に渡された chokidar options (ignored / depth 等) を返す。 */
  const options = (): CapturedWatchOptions => {
    if (!captured) throw new Error("watch はまだ呼ばれていません");
    return captured;
  };

  return { watch, emit, options };
}

describe("createWatcher — 決定論的ユニット (フェイクイベント)", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-watcher-fake-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("md 以外の拡張子のイベントは onChange を呼ばない", async () => {
    const calls: string[] = [];
    const { watch, emit } = createFakeWatch();
    const handle = createWatcher(root, (p) => calls.push(p), { watch });

    try {
      emit("change", "note.txt");
      emit("change", "keep.md");
      await waitFor(() => calls.includes("keep.md"));
      expect(calls).not.toContain("note.txt");
    } finally {
      handle.close();
    }
  });

  test("add / unlink は kind='rename'、change は kind='change'", async () => {
    const calls: Array<{ path: string; kind: string }> = [];
    const { watch, emit } = createFakeWatch();
    const handle = createWatcher(root, (path, kind) => calls.push({ path, kind }), { watch });

    try {
      emit("add", "added.md");
      emit("change", "changed.md");
      emit("unlink", "removed.md");
      await waitFor(
        () =>
          calls.some((c) => c.path === "added.md") &&
          calls.some((c) => c.path === "changed.md") &&
          calls.some((c) => c.path === "removed.md"),
      );
      expect(calls.find((c) => c.path === "added.md")?.kind).toBe("rename");
      expect(calls.find((c) => c.path === "changed.md")?.kind).toBe("change");
      expect(calls.find((c) => c.path === "removed.md")?.kind).toBe("rename");
    } finally {
      handle.close();
    }
  });

  test("debounce 内の同一ファイルへの連続イベントは 1 回に集約される", async () => {
    const calls: string[] = [];
    const { watch, emit } = createFakeWatch();
    const handle = createWatcher(root, (p) => calls.push(p), { watch });

    try {
      emit("change", "burst.md");
      emit("change", "burst.md");
      emit("change", "burst.md");
      await waitFor(() => calls.includes("burst.md"));
      await wait(SETTLE_MS); // 追加発火がないことを確認する猶予
      expect(calls.filter((p) => p === "burst.md").length).toBe(1);
    } finally {
      handle.close();
    }
  });

  test("自己保存マークと一致する内容のイベントは publish されない (Issue #45 の flaky を決定論化)", async () => {
    const saveMark = new SaveMark();
    const body = "self-saved content";
    // isOwnSave は実ファイルを読んで sha 比較するので、実ファイルを用意しておく
    await writeFile(join(root, "self.md"), body);
    saveMark.set("self.md", sha256(body));

    const calls: string[] = [];
    const { watch, emit } = createFakeWatch();
    const handle = createWatcher(root, (p) => calls.push(p), { watch, saveMark });

    try {
      emit("change", "self.md");
      await wait(SETTLE_MS); // 単一イベントなので固定 settle で確実に判定できる (FS タイミング非依存)
      expect(calls).not.toContain("self.md");
    } finally {
      handle.close();
    }
  });

  test("save-mark 登録済みでも内容が違えば publish される (外部書き換えを見逃さない)", async () => {
    const saveMark = new SaveMark();
    saveMark.set("ext.md", sha256("expected-content"));
    await writeFile(join(root, "ext.md"), "actually-different"); // mark とは異なる内容

    const calls: string[] = [];
    const { watch, emit } = createFakeWatch();
    const handle = createWatcher(root, (p) => calls.push(p), { watch, saveMark });

    try {
      emit("change", "ext.md");
      await waitFor(() => calls.includes("ext.md"));
      expect(calls).toContain("ext.md");
    } finally {
      handle.close();
    }
  });

  test("close() 後は publish されない (発火待ちのイベントも抑止)", async () => {
    const calls: string[] = [];
    const { watch, emit } = createFakeWatch();
    const handle = createWatcher(root, (p) => calls.push(p), { watch });

    emit("change", "pending.md"); // debounce タイマー開始
    handle.close(); // 発火前に close
    await wait(SETTLE_MS);
    expect(calls).toHaveLength(0);
  });

  test("chokidar に渡す ignored / depth が正しい (除外・深さ制限の設定を決定論的に検証)", () => {
    const { watch, options } = createFakeWatch();
    const handle = createWatcher(root, () => {}, { watch, depth: 1 });

    try {
      const opts = options();
      // depth=1 (tree level, ルート直下) → chokidar depth 0
      expect(opts.depth).toBe(0);
      // 除外ディレクトリ配下は ignored=true、通常の md は false
      expect(opts.ignored(join(root, "node_modules", "x.md"))).toBe(true);
      expect(opts.ignored(join(root, "docs", "a.md"))).toBe(false);
    } finally {
      handle.close();
    }
  });
});

describe("createWatcher — chokidar 統合 (実ファイル監視)", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-watcher-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("md ファイルの作成/変更で onChange が呼ばれる", async () => {
    const calls: Array<{ path: string; kind: string }> = [];
    const { handle, ready } = startWatcher(root, (path, kind) => {
      calls.push({ path, kind });
    });

    try {
      await ready;
      await writeFile(join(root, "a.md"), "hello");
      await waitFor(() => calls.some((c) => c.path === "a.md"));
      expect(calls.every((c) => c.path === "a.md")).toBe(true);
    } finally {
      handle.close();
    }
  });

  test("ネストしたサブディレクトリ内の md 変更で onChange が呼ばれる", async () => {
    const sub = join(root, "docs", "guide");
    await mkdir(sub, { recursive: true });

    const calls: string[] = [];
    const { handle, ready } = startWatcher(root, (path) => {
      calls.push(path);
    });

    try {
      await ready;
      await writeFile(join(sub, "nested.md"), "deep");
      await waitFor(() => calls.includes("docs/guide/nested.md"));
      expect(calls).toContain("docs/guide/nested.md");
    } finally {
      handle.close();
    }
  });

  test("深いネスト (3 階層以上) の最深部 md も検知する", async () => {
    const deep = join(root, "l1", "l2", "l3");
    await mkdir(deep, { recursive: true });

    const calls: string[] = [];
    const { handle, ready } = startWatcher(root, (path) => {
      calls.push(path);
    });

    try {
      await ready;
      await writeFile(join(deep, "deepest.md"), "x");
      await waitFor(() => calls.includes("l1/l2/l3/deepest.md"));
      expect(calls).toContain("l1/l2/l3/deepest.md");
    } finally {
      handle.close();
    }
  });

  test("監視開始後に新規作成したディレクトリと中身がほぼ同時に出現しても md を取りこぼさない", async () => {
    // F2: git checkout / cp -r / tar 展開のように mkdir 直後に中身が現れるケース
    const calls: string[] = [];
    const { handle, ready } = startWatcher(root, (path) => {
      calls.push(path);
    });

    try {
      await ready;
      const fresh = join(root, "atomic");
      await mkdir(fresh, { recursive: true });
      // debounce 待ちを挟まず即座に書き込む (レース再現)
      await writeFile(join(fresh, "race.md"), "appeared");
      await waitFor(() => calls.includes("atomic/race.md"));
      expect(calls).toContain("atomic/race.md");
    } finally {
      handle.close();
    }
  });

  test("ディレクトリをリネームすると新パスでツリーに現れる", async () => {
    // F1 回帰ガード: 旧実装はディレクトリ rename で移動先を検知できなかった。
    // chokidar では rename 時に移動先 (add) が正しく検知される。
    const d1 = join(root, "ren-src");
    await mkdir(d1, { recursive: true });
    await writeFile(join(d1, "a.md"), "v0");

    const calls: Array<{ path: string; kind: string }> = [];
    const { handle, ready } = startWatcher(root, (path, kind) => {
      calls.push({ path, kind });
    });

    try {
      await ready;
      await rename(d1, join(root, "ren-dst"));
      // 移動先の新パスでツリーに現れる (旧コードはこれを満たせなかった)
      await waitFor(() => calls.some((c) => c.path === "ren-dst/a.md"));
      expect(calls.some((c) => c.path === "ren-dst/a.md")).toBe(true);
    } finally {
      handle.close();
    }
  });

  test("ディレクトリ削除→同名再作成でも再び検知できる (watcher が死なない)", async () => {
    const sub = join(root, "to-remove");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "x.md"), "v1");

    const calls: string[] = [];
    const { handle, ready } = startWatcher(root, (path) => {
      calls.push(path);
    });

    try {
      await ready;
      await rm(sub, { recursive: true, force: true });
      await wait(DEBOUNCE_MARGIN_MS); // 削除イベントが落ち着くのを待つ

      calls.length = 0;
      await mkdir(sub, { recursive: true });
      await writeFile(join(sub, "x.md"), "v2");
      // 再作成が検知されること (発火回数は FSEvents の重複/遅延で保証できないため presence のみ)
      await waitFor(() => calls.includes("to-remove/x.md"));
      expect(calls).toContain("to-remove/x.md");
    } finally {
      handle.close();
    }
  });

  test("除外ディレクトリ配下は監視されない (実 chokidar 統合スモーク)", async () => {
    const nm = join(root, "node_modules");
    await mkdir(nm, { recursive: true });

    const calls: string[] = [];
    const { handle, ready } = startWatcher(root, (path) => {
      calls.push(path);
    });

    try {
      await ready;
      await writeFile(join(nm, "skip.md"), "skip"); // 除外対象 (chokidar は descend しない)
      await writeFile(join(root, "included.md"), "yes"); // positive control
      // included が届いた = watcher は生きている。除外ファイルは chokidar が emit しない
      await waitFor(() => calls.includes("included.md"));
      expect(calls.find((p) => p.includes("node_modules"))).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  test("depth 指定で深い階層の変更は publish されない (Issue #44)", async () => {
    // 共有 root とは別の専用ツリーで検証する
    const droot = await mkdtemp(join(tmpdir(), "yomi-watcher-depth-"));
    await mkdir(join(droot, "d1"), { recursive: true });
    await writeFile(join(droot, "shallow.md"), "x"); // level 1
    await writeFile(join(droot, "d1", "deep.md"), "x"); // level 2

    const calls: string[] = [];
    // depth=1: ルート直下のみ監視 (chokidar depth 0)
    const { handle, ready } = startWatcher(droot, (path) => calls.push(path), { depth: 1 });

    try {
      await ready;
      await writeFile(join(droot, "shallow.md"), "changed"); // 監視内 (level 1)
      await writeFile(join(droot, "d1", "deep.md"), "changed"); // 監視外 (level 2)

      // positive control: 浅い変更は届く (= watcher は生きている)
      await waitFor(() => calls.includes("shallow.md"));
      // depth 制限: 深い変更は chokidar が descend しないので届かない
      expect(calls).not.toContain("d1/deep.md");
    } finally {
      handle.close();
      await rm(droot, { recursive: true, force: true });
    }
  });
});

/**
 * **`writeFileAtomic` の上書きが取りこぼされない (Issue #119)。**
 *
 * ## 1 回試すテストでは足りない
 *
 * 取りこぼしは**タイミング次第**なので、1 回だけ試すテストは**壊れた状態でも
 * 5 回に 1 回は通る**。だから **N 回中 N 回**を見る。
 *
 * 実測（`scripts/probe-watcher-atomic.ts`、tmpfs / 20 試行 × 昇降 2 パス）:
 *
 * | 間隔 | `change` の発火 |
 * |---|---|
 * | 0ms（修正前の `writeFileAtomic`） | 5/40 |
 * | 1ms | 33/40 |
 * | **{@link WATCH_GAP_MS}（5ms）** | **40/40** |
 *
 * ## ここが落ちたら
 *
 * `WATCH_GAP_MS` は **chokidar の実装依存**の値。版を上げて落ちたら、
 * `scripts/probe-watcher-atomic.ts` を回して境界を測り直すこと
 * （`docs/` の表と CHANGELOG の数字もそこの出力が正本）。
 */
describe("writeFileAtomic の上書きを取りこぼさない (Issue #119)", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-atomic-watch-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** 実 chokidar を通して N 回上書きし、届いた回数を数える */
  async function detectionRate(name: string, gapMs: number | undefined, trials: number) {
    const target = join(root, name);
    await writeFile(target, "# 初期\n");

    const calls: string[] = [];
    const { handle, ready } = startWatcher(root, (path) => calls.push(path));
    try {
      await ready;
      let hit = 0;
      for (let i = 0; i < trials; i++) {
        calls.length = 0;
        await writeFileAtomic(target, Buffer.from(`# ${i}\n`, "utf-8"), undefined, gapMs);
        // debounce(80ms) + 配送を超える猶予。届かない試行はここを使い切る
        await wait(DEBOUNCE_MARGIN_MS);
        if (calls.includes(name)) hit++;
      }
      return hit;
    } finally {
      handle.close();
    }
  }

  test("既定の間隔なら 10 回中 10 回届く", async () => {
    expect(await detectionRate("atomic.md", undefined, 10)).toBe(10);
  }, 30_000);

  /**
   * **「間隔 0 なら取りこぼす」を自動テストにはしない。**
   *
   * 取りこぼしは確率的なので、遅いマシンでは syscall のあいだに 2ms 経ってしまい
   * **偶然 10/10 届いて落ちる**。このリポジトリは watcher の結合テストが macOS でだけ
   * 間欠 fail した既往があり、そこへ確率的な negative control を足すのは割に合わない。
   * **修正前の再現は変異テスト**（`WATCH_GAP_MS` を 0 にして上の 10/10 が落ちることを
   * 確認）で見て、レポートに残す。
   *
   * 代わりにここでは、**間隔が実際に効いていること**を決定的に固定する。
   */
  test("gapMs のぶんだけ待ってから rename する", async () => {
    const target = join(root, "gap.md");
    await writeFile(target, "# 初期\n");

    const t0 = Date.now();
    await writeFileAtomic(target, Buffer.from("# 待つ\n", "utf-8"), undefined, 120);
    const waited = Date.now() - t0;

    // 待っていなければ数 ms で終わる。**下限だけを見る**（上限を見ると負荷で落ちる）
    expect(waited).toBeGreaterThanOrEqual(120);
    expect(await readFile(target, "utf8")).toBe("# 待つ\n");
  });

  test("WATCH_GAP_MS は実測の境界 (2ms) より余裕がある", () => {
    // 境界ぎりぎりだと、負荷や FS が変わったときに黙って取りこぼしへ戻る
    expect(WATCH_GAP_MS).toBeGreaterThanOrEqual(2);
  });
});

describe("toChokidarDepth (Issue #44)", () => {
  // tree level (ルート直下 = 1) → chokidar depth (降りる段数、ルート直下 = 0)
  test("tree depth N → chokidar depth N-1", () => {
    expect(toChokidarDepth(1)).toBe(0);
    expect(toChokidarDepth(2)).toBe(1);
    expect(toChokidarDepth(5)).toBe(4);
  });

  test("undefined は無制限のまま undefined", () => {
    expect(toChokidarDepth(undefined)).toBeUndefined();
  });
});
