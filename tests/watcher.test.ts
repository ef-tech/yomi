import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SaveMark, sha256 } from "../src/save-mark.ts";
import { createWatcher, type WatcherHandle } from "../src/watcher.ts";

const DEBOUNCE_MARGIN_MS = 250;

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
      await writeFile(join(root, "ignore-me.txt"), "noop");
      await wait(DEBOUNCE_MARGIN_MS);
      expect(calls).not.toContain("ignore-me.txt");
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

    // 先にファイルを作って状態を安定させる (このイベントは saveMark 未登録なので publish される可能性あり)
    const target = join(root, "self.md");
    await writeFile(target, "initial");
    await wait(DEBOUNCE_MARGIN_MS);

    const calls: string[] = [];
    const handle = createWatcher(
      root,
      (path) => {
        calls.push(path);
      },
      { saveMark },
    );

    try {
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
    await wait(DEBOUNCE_MARGIN_MS);

    const calls: string[] = [];
    const handle = createWatcher(
      root,
      (path) => {
        calls.push(path);
      },
      { saveMark },
    );

    try {
      // mark の sha とは異なる内容で書く (= 外部からの変更想定)
      await writeFile(target, "actually-different");
      await wait(DEBOUNCE_MARGIN_MS);

      expect(calls).toContain("ext.md");
    } finally {
      handle.close();
    }
  });
});
