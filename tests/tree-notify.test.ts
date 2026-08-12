/**
 * ツリーの差分通知と版 (Issue #126)。
 *
 * ## 何を守るか
 *
 * クライアントは `/api/tree` を取り直さず、**差分を積んで**手元のツリーを更新する。
 * 成立に要るのは 2 つで、どちらが欠けても「画面は動いているが中身がずれる」という
 * 気づけない壊れ方をする:
 *
 * 1. 通知に**どこがどう変わったか**（`op` / `path`）が載っていること
 * 2. **取りこぼしに気づけること**（`gen` が 1 つずつ進み、`/api/tree` も同じ版を名乗る）
 *
 * ここでは実サーバを起動し、**本物の WebSocket で受け取った通知**を見る。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TREE_GEN_HEADER as CLIENT_TREE_GEN_HEADER } from "../public/api-headers.js";
import { createServer, type ServerHandle, TREE_GEN_HEADER } from "../src/server.ts";

let dir: string;
let handle: ServerHandle | null = null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yomi-treenotify-"));
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs", "guide.md"), "# guide\n");
});

afterEach(async () => {
  handle?.close();
  handle = null;
  await rm(dir, { recursive: true, force: true });
});

/**
 * サーバを起動し、**ファイル監視の初期スキャンが終わるまで待つ**。
 *
 * `ignoreInitial: true` なので、**初期スキャンの最中に書いたファイルは通知されない**。
 * 待たずに書くと間欠的に落ちる（実測で 3 回に 1 回）。固定 sleep で待つと遅い環境で
 * 破れるので ready を待つ —— `tests/watcher.test.ts` が Issue #45 で採った手と同じ。
 */
async function start(
  options: { maxDepth?: number } = {},
): Promise<{ handle: ServerHandle; url: string }> {
  let ready = false;
  const h = createServer({
    rootDir: dir,
    hostname: "127.0.0.1",
    port: 0,
    maxDepth: options.maxDepth,
    onWatcherReady: () => {
      ready = true;
    },
  });
  handle = h;
  const deadline = Date.now() + 10_000;
  while (!ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!ready) throw new Error("ファイル監視の初期スキャンが終わらない");
  return { handle: h, url: `http://127.0.0.1:${h.server.port}` };
}

/** `/api/tree` を引いて、本文と版を返す。 */
async function getTree(url: string): Promise<{ gen: string | null; paths: string[] }> {
  const res = await fetch(`${url}/api/tree`);
  const root = (await res.json()) as { children?: unknown[] };
  const paths: string[] = [];
  const walk = (n: { path?: string; type?: string; children?: unknown[] }) => {
    if (n.type === "file" && n.path) paths.push(n.path);
    for (const c of n.children ?? []) walk(c as never);
  };
  walk(root as never);
  return { gen: res.headers.get(TREE_GEN_HEADER), paths: paths.sort() };
}

/**
 * 通知を溜める WebSocket。
 *
 * **「n 件目が来た」で待たない (macOS)。** FSEvents は**監視を始める前に起きた変更**を
 * 遅れて配送することがあり（`beforeEach` が置いた `docs/guide.md` など）、`messages[0]` が
 * 無関係な通知になる。**欲しい通知が来るまで待つ**形にして、順序と無関係な混入に
 * 影響されないようにする。
 */
async function listen(url: string): Promise<{
  messages: Array<Record<string, unknown>>;
  /** 条件に合う通知が来るまで待って、それを返す。 */
  await1: (
    pred: (m: Record<string, unknown>) => boolean,
    what: string,
  ) => Promise<Record<string, unknown>>;
  /** 条件に合う通知だけを取り出す。 */
  filter: (pred: (m: Record<string, unknown>) => boolean) => Array<Record<string, unknown>>;
  close: () => void;
}> {
  const ws = new WebSocket(`${url.replace("http", "ws")}/ws`);
  const messages: Array<Record<string, unknown>> = [];
  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(String((ev as MessageEvent).data));
      // 接続時の挨拶は変更通知ではないので数えない (`src/server.ts` の `open`)
      if (msg?.type === "hello") return;
      messages.push(msg);
    } catch {
      /* 壊れた通知は無視（このテストの対象外） */
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket が開かない")), 5_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket でエラー"));
    });
  });
  const filter = (pred: (m: Record<string, unknown>) => boolean) => messages.filter(pred);
  return {
    messages,
    filter,
    async await1(pred, what) {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const hit = messages.find(pred);
        if (hit) return hit;
        if (Date.now() >= deadline) {
          throw new Error(`${what} の通知が来ない: ${JSON.stringify(messages)}`);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    close: () => ws.close(),
  };
}

/** その path についての `tree` 通知か。 */
const treeOf = (path: string) => (m: Record<string, unknown>) =>
  m.type === "tree" && m.path === path;

describe("/api/tree の版ヘッダ", () => {
  test("版を返し、構造が変わるまで同じ値のまま", async () => {
    const { url } = await start();
    const first = await getTree(url);
    expect(first.gen).not.toBeNull();
    // **2 回引いても進まない。** 引くたびに進むと、クライアントは常に
    // 「取りこぼした」と判断して差分を捨てることになる
    expect((await getTree(url)).gen).toBe(first.gen as string);
  });

  test("ファイルが増えると版が進み、内容にも現れる", async () => {
    const { url } = await start();
    const before = await getTree(url);
    const sock = await listen(url);
    try {
      await writeFile(join(dir, "docs", "new.md"), "# new\n");
      // **その追加の通知が来るまで待つ。** 件数で待つと、FSEvents が遅れて配送した
      // 無関係な通知で先に抜けてしまう (macOS)
      await sock.await1(treeOf("docs/new.md"), "docs/new.md の追加");
      const after = await getTree(url);
      expect(Number(after.gen)).toBeGreaterThan(Number(before.gen));
      expect(after.paths).toEqual(["docs/guide.md", "docs/new.md"]);
    } finally {
      sock.close();
    }
  });

  /**
   * **保存でも版が進む。** ツリーの形は変わらないが、`writeFileAtomic` は
   * 存在しないパスにも書けるので「形が変わっていない」と言い切れない。
   * 進めておけば、クライアントは次の構造変化で 1 回だけ取り直して追いつく ——
   * **取りこぼしを見逃すより安い**（`src/server.ts` の `treeGen` のコメント）。
   */
  test("保存 (POST /api/file) でも版が進む", async () => {
    const { url } = await start();
    const before = await getTree(url);
    const res = await fetch(`${url}/api/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ path: "docs/guide.md", body: "# guide 2\n" }),
    });
    expect(res.status).toBe(200);
    expect(Number((await getTree(url)).gen)).toBeGreaterThan(Number(before.gen));
  });
});

describe("tree 通知の差分", () => {
  test("追加は op='add' と path と版を載せて届く", async () => {
    const { url } = await start();
    const before = await getTree(url);
    const sock = await listen(url);
    try {
      await writeFile(join(dir, "docs", "added.md"), "# added\n");
      const msg = await sock.await1(treeOf("docs/added.md"), "docs/added.md の追加");
      expect(msg).toEqual({
        type: "tree",
        op: "add",
        path: "docs/added.md",
        gen: Number(before.gen) + 1,
      });
    } finally {
      sock.close();
    }
  });

  test("削除は op='remove' で届く", async () => {
    const { url } = await start();
    await getTree(url);
    const sock = await listen(url);
    try {
      await rm(join(dir, "docs", "guide.md"));
      const msg = await sock.await1(treeOf("docs/guide.md"), "docs/guide.md の削除");
      expect(msg).toMatchObject({
        type: "tree",
        op: "remove",
        path: "docs/guide.md",
      });
    } finally {
      sock.close();
    }
  });

  /**
   * **版は 1 つずつ進む。** 飛んだり戻ったりすると、受け取った側は
   * 「取りこぼした」と判断して毎回全量を取り直す（差分の意味が消える）。
   */
  test("連続した追加で版が 1 つずつ進み、/api/tree もその版を名乗る", async () => {
    const { url } = await start();
    const before = Number((await getTree(url)).gen);
    const sock = await listen(url);
    try {
      for (const name of ["a.md", "b.md", "c.md"]) {
        await writeFile(join(dir, "docs", name), `# ${name}\n`);
        // **1 件ずつ待つ。** まとめて書くと debounce (80ms) で畳まれうる
        await sock.await1(treeOf(`docs/${name}`), `docs/${name} の追加`);
      }
      // **`tree` 通知だけを見る。** 追加は `add` と `change` の両方を生むことがあり
      // (`src/watcher.ts`)、path だけで絞ると版を持たない `changed` が混ざる
      const gens = sock
        .filter(
          (m) =>
            m.type === "tree" && ["docs/a.md", "docs/b.md", "docs/c.md"].includes(m.path as string),
        )
        .map((m) => m.gen);
      expect(gens).toEqual([before + 1, before + 2, before + 3]);
      expect((await getTree(url)).gen).toBe(String(before + 3));
    } finally {
      sock.close();
    }
  });

  test("内容の変更は changed のままで、差分も版も載らない", async () => {
    const { url } = await start();
    await getTree(url);
    const sock = await listen(url);
    try {
      await writeFile(join(dir, "docs", "guide.md"), "# guide 2\n");
      const msg = await sock.await1((m) => m.path === "docs/guide.md", "docs/guide.md の内容変更");
      expect(msg).toEqual({ type: "changed", path: "docs/guide.md" });
    } finally {
      sock.close();
    }
  });

  /**
   * **`--depth` のときは差分を送らない。**
   *
   * 深さ境界のディレクトリは「中を見ていないので空でも残す」扱い
   * (`src/scanner.ts` の `truncatedDirs`)。クライアントはそれを空ディレクトリと
   * 区別できないので、差分で畳んでしまう。送らなければ全量取り直しに倒れる。
   */
  test("--depth 指定時は op を載せず、従来どおりの tree 通知になる", async () => {
    await mkdir(join(dir, "docs", "deep"), { recursive: true });
    const { url } = await start({ maxDepth: 2 });
    await getTree(url);
    const sock = await listen(url);
    try {
      await writeFile(join(dir, "docs", "shallow.md"), "# x\n");
      // **`--depth` のときは path が載らない**ので、`tree` が来たことだけを待つ
      const msg = await sock.await1((m) => m.type === "tree", "ツリーの変化");
      expect(msg).toEqual({ type: "tree" });
    } finally {
      sock.close();
    }
  });
});

/**
 * **ヘッダ名はサーバとクライアントで二重定義になっている。**
 *
 * `src/` は TypeScript、`public/` はブラウザに配る JS で、片方から他方を import できない。
 * ずれると**クライアントが版を読めず、差分を 1 件も当てなくなる** —— 表示は正しいまま
 * 遅くなるだけなので、テストが無いと気づけない。
 */
test("版ヘッダ名がサーバとクライアントで一致している", () => {
  expect(CLIENT_TREE_GEN_HEADER).toBe(TREE_GEN_HEADER);
});
