import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SaveMark, sha256 } from "../src/save-mark.ts";
import { createWatcher, type WatcherHandle } from "../src/watcher.ts";

/** chokidar の初期スキャン完了 (ready) を待つための余裕。これより前の書き込みは初期ファイル扱いで取りこぼす。 */
const READY_MS = 350;
/** debounce(80ms) + イベント配送を待つ余裕。 */
const DEBOUNCE_MARGIN_MS = 300;

async function wait(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

describe("createWatcher", () => {
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
      const target = join(root, "a.md");
      await writeFile(target, "hello");
      await wait(DEBOUNCE_MARGIN_MS);

      await writeFile(target, "hello world");
      await wait(DEBOUNCE_MARGIN_MS);

      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls.every((c) => c.path === "a.md")).toBe(true);
    } finally {
      handle.close();
    }
  });

  test("md 以外の拡張子は無視される", async () => {
    const calls: string[] = [];
    const handle = createWatcher(root, (path) => {
      calls.push(path);
    });

    try {
      await wait(READY_MS);
      await writeFile(join(root, "ignore-me.txt"), "noop");
      await wait(DEBOUNCE_MARGIN_MS);
      expect(calls).not.toContain("ignore-me.txt");
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
      await wait(DEBOUNCE_MARGIN_MS);
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
      await wait(DEBOUNCE_MARGIN_MS);
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
      await wait(DEBOUNCE_MARGIN_MS);
      expect(calls).toContain("atomic/race.md");
    } finally {
      handle.close();
    }
  });

  test("ディレクトリをリネームすると新パスでツリーに現れ、旧パスの幻イベントは出ない", async () => {
    // F1 回帰ガード: 旧実装はディレクトリ rename で watcher をリークさせ、移動先の変更を
    // 旧パス (幻パス) の "change" として誤発火していた。chokidar では rename が
    // 新パスの追加 (kind "rename") + 旧パスの削除 (kind "rename") として正しく出る。
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
      await wait(DEBOUNCE_MARGIN_MS);

      // 移動先の新パスでツリーに現れる
      expect(calls.some((c) => c.path === "ren-dst/a.md")).toBe(true);
      // 旧パスに対する内容変更 (幻パス) は出ない。削除 (kind "rename") は許容。
      expect(calls.some((c) => c.path === "ren-src/a.md" && c.kind === "change")).toBe(false);
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
      await wait(DEBOUNCE_MARGIN_MS);

      const fired = calls.filter((p) => p === "to-remove/x.md");
      expect(fired.length).toBe(1);
    } finally {
      handle.close();
    }
  });

  test("除外ディレクトリ配下のイベントは無視される", async () => {
    const sub = join(root, "node_modules");
    await mkdir(sub, { recursive: true });

    const calls: string[] = [];
    const handle = createWatcher(root, (path) => {
      calls.push(path);
    });

    try {
      await wait(READY_MS);
      await writeFile(join(sub, "skip.md"), "skip");
      await wait(DEBOUNCE_MARGIN_MS);
      expect(calls.find((p) => p.includes("node_modules"))).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  test("自己保存マークと一致する内容のイベントは publish されない", async () => {
    const saveMark = new SaveMark();
    const body = "self-saved content";
    const sha = sha256(body);

    const target = join(root, "self.md");
    await writeFile(target, "initial");

    const calls: string[] = [];
    const handle = createWatcher(
      root,
      (path) => {
        calls.push(path);
      },
      { saveMark },
    );

    try {
      await wait(READY_MS);
      // 「自分で書いた」マークを先に登録してから書き込む
      saveMark.set("self.md", sha);
      await writeFile(target, body);
      await wait(DEBOUNCE_MARGIN_MS);

      expect(calls.find((p) => p === "self.md")).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  test("save-mark が登録済みでも内容が違えば publish される (外部書き換えを見逃さない)", async () => {
    const saveMark = new SaveMark();
    saveMark.set("ext.md", sha256("expected-content"));

    const target = join(root, "ext.md");
    await writeFile(target, "initial");

    const calls: string[] = [];
    const handle = createWatcher(
      root,
      (path) => {
        calls.push(path);
      },
      { saveMark },
    );

    try {
      await wait(READY_MS);
      // mark の sha とは異なる内容で書く (= 外部からの変更想定)
      await writeFile(target, "actually-different");
      await wait(DEBOUNCE_MARGIN_MS);

      expect(calls).toContain("ext.md");
    } finally {
      handle.close();
    }
  });
});
