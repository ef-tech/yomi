import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FSWatcher } from "chokidar";
import { SaveMark, sha256 } from "../src/save-mark.ts";
import {
  createWatcher,
  toChokidarDepth,
  type WatcherHandle,
  type WatcherOptions,
} from "../src/watcher.ts";

/** chokidar の初期スキャン完了 (ready) を待つための余裕。これより前の書き込みは初期ファイル扱いで取りこぼす。 */
const READY_MS = 350;
/** イベントの落ち着き (debounce 80ms + 配送) を待つ猶予。否定確認・二重発火確認に使う。 */
const DEBOUNCE_MARGIN_MS = 300;
/** フェイクイベント経路の settle 余裕 (debounce 80ms + isOwnSave の readFile を十分に超える固定値)。 */
const SETTLE_MS = 200;

function wait(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * predicate が真になるまで上限付きで poll する。固定 sleep + assert だと、macOS の
 * FSEvents 配信遅延で「まだ届いていないだけ」を失敗と誤判定してしまう (Issue #45)。
 * 肯定条件は「期待イベントが届くまで待つ」ことで頑健化する。
 */
async function waitFor(
  predicate: () => boolean,
  { timeout = 5000, interval = 20 }: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout)
      throw new Error("waitFor: 条件が時間内に満たされませんでした");
    await wait(interval);
  }
}

type FakeEvent = "add" | "change" | "unlink";

/**
 * chokidar の実ファイル監視を差し替えるフェイク。createWatcher が使う最小 API
 * (`.on(event, handler)` チェーン + `.close()`) だけを実装し、`emit()` でテストが
 * イベントの内容とタイミングを完全に制御できる。macOS FSEvents の非決定性を排除し、
 * fire()→debounce→isOwnSave→onChange のロジックを決定論的に検証するための注入口 (Issue #45)。
 */
function createFakeWatch() {
  const handlers = new Map<string, (arg: string) => void>();
  let closed = false;
  let root = "";

  const fake = {
    on(event: string, handler: (arg: string) => void) {
      handlers.set(event, handler);
      return fake;
    },
    close() {
      closed = true;
    },
  };

  // createWatcher は watch(rootDir, options) の形で呼ぶ。rootDir を捕まえて相対名から
  // 絶対パスを組み立てられるようにする。戻り値は FSWatcher として扱われるので cast する。
  const watch = ((paths: string) => {
    root = paths;
    return fake as unknown as FSWatcher;
  }) as unknown as NonNullable<WatcherOptions["watch"]>;

  /** テストからイベントを発火する (rel は rootDir 基準の相対名)。close 後は何もしない。 */
  const emit = (event: FakeEvent, rel: string) => {
    if (closed) return;
    handlers.get(event)?.(join(root, rel));
  };

  return { watch, emit };
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

  test("close() は発火待ち (debounce 中) のイベントも抑止する", async () => {
    const calls: string[] = [];
    const { watch, emit } = createFakeWatch();
    const handle = createWatcher(root, (p) => calls.push(p), { watch });

    emit("change", "pending.md"); // debounce タイマー開始
    handle.close(); // 発火前に close → 保留タイマーは clear され publish されない
    await wait(SETTLE_MS);
    expect(calls).toHaveLength(0);
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
    const handle: WatcherHandle = createWatcher(root, (path, kind) => {
      calls.push({ path, kind });
    });

    try {
      await wait(READY_MS);
      await writeFile(join(root, "a.md"), "hello");
      await waitFor(() => calls.some((c) => c.path === "a.md"));
      await writeFile(join(root, "a.md"), "hello world");
      await waitFor(() => calls.filter((c) => c.path === "a.md").length >= 1);
      expect(calls.every((c) => c.path === "a.md")).toBe(true);
    } finally {
      handle.close();
    }
  });

  test("ネストしたサブディレクトリ内の md 変更で onChange が呼ばれる", async () => {
    const sub = join(root, "docs", "guide");
    await mkdir(sub, { recursive: true });

    const calls: string[] = [];
    const handle = createWatcher(root, (path) => {
      calls.push(path);
    });

    try {
      await wait(READY_MS);
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
    const handle = createWatcher(root, (path) => {
      calls.push(path);
    });

    try {
      await wait(READY_MS);
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
    const handle = createWatcher(root, (path) => {
      calls.push(path);
    });

    try {
      await wait(READY_MS);
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
    // F1 回帰ガード: 旧実装はディレクトリ rename で移動先を検知できず (新パスのイベント 0 件)、
    // 旧 watcher がリークして移動先の変更を旧パス (幻パス) で永続的に誤発火していた。
    // chokidar では rename 時に移動先 (add) が正しく検知される。
    const d1 = join(root, "ren-src");
    await mkdir(d1, { recursive: true });
    await writeFile(join(d1, "a.md"), "v0");

    const calls: Array<{ path: string; kind: string }> = [];
    const handle = createWatcher(root, (path, kind) => {
      calls.push({ path, kind });
    });

    try {
      await wait(READY_MS);
      await rename(d1, join(root, "ren-dst"));
      // 移動先の新パスでツリーに現れる (旧コードはこれを満たせなかった)
      await waitFor(() => calls.some((c) => c.path === "ren-dst/a.md"));
      expect(calls.some((c) => c.path === "ren-dst/a.md")).toBe(true);
    } finally {
      handle.close();
    }
  });

  test("ディレクトリ削除後はその配下の変更を検知しない", async () => {
    const sub = join(root, "to-remove");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "x.md"), "v1");

    const calls: string[] = [];
    const handle = createWatcher(root, (path) => {
      calls.push(path);
    });

    try {
      await wait(READY_MS);
      await rm(sub, { recursive: true, force: true });
      await wait(DEBOUNCE_MARGIN_MS);

      calls.length = 0;
      // 削除後に同名で別ファイルを作っても二重監視で誤発火しないこと、かつ
      // 削除→再作成が正しく 1 回検知されること
      await mkdir(sub, { recursive: true });
      await writeFile(join(sub, "x.md"), "v2");
      await waitFor(() => calls.includes("to-remove/x.md"));
      await wait(DEBOUNCE_MARGIN_MS); // 二重発火がないことを確認する猶予
      expect(calls.filter((p) => p === "to-remove/x.md").length).toBe(1);
    } finally {
      handle.close();
    }
  });

  test("除外ディレクトリ配下のイベントは無視される", async () => {
    const nm = join(root, "node_modules");
    await mkdir(nm, { recursive: true });

    const calls: string[] = [];
    const handle = createWatcher(root, (path) => {
      calls.push(path);
    });

    try {
      await wait(READY_MS);
      await writeFile(join(nm, "skip.md"), "skip"); // 除外対象 (chokidar は descend しない)
      await writeFile(join(root, "included.md"), "yes"); // positive control
      // included が届いた = watcher は生きている。除外ファイルは chokidar が emit しないので届かない
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
    const handle: WatcherHandle = createWatcher(droot, (path) => calls.push(path), { depth: 1 });

    try {
      await wait(READY_MS);
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
