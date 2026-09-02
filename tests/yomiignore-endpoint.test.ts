import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, MAX_YOMIIGNORE_BYTES, type ServerHandle } from "../src/server.ts";
import { YOMIIGNORE_FILENAME } from "../src/yomiignore.ts";

/**
 * `/api/yomiignore`（Issue #164）。
 *
 * **見るのは「保存できること」ではなく「保存が全経路に効くこと」。** 除外は #65 以降
 * 読み書きの可否を決めるゲートなので、`/api/tree` だけ差し替わって `/api/file` が
 * 古い集合を見ている、という状態が最も危ない（塞いだはずのファイルが読める）。
 */
describe("/api/yomiignore", () => {
  let root: string;
  let handle: ServerHandle;
  let url: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-ignore-api-"));
    await writeFile(join(root, "readme.md"), "# readme");
    await mkdir(join(root, "secret"), { recursive: true });
    await writeFile(join(root, "secret", "note.md"), "# secret");
    await mkdir(join(root, "build"), { recursive: true });
    await writeFile(join(root, "build", "out.md"), "# built");
    await writeFile(join(root, "build", "logo.png"), "png-bytes");
    // watch: false。**watcher の張り直しは別テストで見る**（chokidar を起こすと遅い）
    handle = createServer({ rootDir: root, hostname: "127.0.0.1", port: 0, watch: false });
    url = `http://127.0.0.1:${handle.server.port}`;
  });

  afterEach(async () => {
    handle.close();
    await rm(root, { recursive: true, force: true });
  });

  /** `.yomiignore` を保存する。既定で同一 Origin を名乗る。 */
  async function save(text: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${url}/api/yomiignore`, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json", ...(init.headers ?? {}) },
      body: JSON.stringify({ text }),
      ...init,
    });
  }

  test("GET はファイルが無ければ空文字を返す", async () => {
    const res = await fetch(`${url}/api/yomiignore`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "", invalid: [] });
  });

  test("GET は中身と、照合できない行を行番号つきで返す", async () => {
    await writeFile(join(root, YOMIIGNORE_FILENAME), "# comment\nsecret\ndocs/private\n*.log\n");
    const res = await fetch(`${url}/api/yomiignore`);
    const data = (await res.json()) as {
      text: string;
      invalid: { line: number; reason: string; dropped: boolean; message: string }[];
    };
    expect(data.text).toContain("secret");
    expect(data.invalid).toHaveLength(2);
    expect(data.invalid[0]).toMatchObject({ line: 3, reason: "path-separator", dropped: true });
    expect(data.invalid[1]).toMatchObject({ line: 4, reason: "glob", dropped: false });
    // **文言はサーバが組み立てる**（画面が判定も文言も写さないため）
    expect(data.invalid[0]?.message).toStartWith(`${YOMIIGNORE_FILENAME}:3: docs/private — `);
    expect(data.invalid[1]?.message).toContain("グロブ");
  });

  test("POST でファイルが作られ、保存した内容がそのまま読み戻せる", async () => {
    const res = await save("secret\n");
    expect(res.status).toBe(200);
    expect(await readFile(join(root, YOMIIGNORE_FILENAME), "utf-8")).toBe("secret\n");
    const got = (await (await fetch(`${url}/api/yomiignore`)).json()) as { text: string };
    expect(got.text).toBe("secret\n");
  });

  test("保存した除外がツリー・/api/file・/api/asset の全経路に同時に効く", async () => {
    // 保存前は読める
    expect((await fetch(`${url}/api/file?path=secret/note.md`)).status).toBe(200);
    expect((await fetch(`${url}/api/tree`)).status).toBe(200);
    await expect((await fetch(`${url}/api/tree`)).text()).resolves.toContain("secret");

    await save("secret\n");

    // ツリーから消える（キャッシュを捨てているので次の取得に効く）
    await expect((await fetch(`${url}/api/tree`)).text()).resolves.not.toContain("secret");
    // 読み取りが塞がる（除外は 400 + excluded_path。`excludedPathResponse` の契約）
    const read = await fetch(`${url}/api/file?path=secret/note.md`);
    expect(read.status).toBe(400);
    expect((await read.json()).code).toBe("excluded_path");
    // 書き込みも塞がる（#65 の迂回路を開け直さない）
    const write = await fetch(`${url}/api/file`, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "secret/note.md", body: "x" }),
    });
    expect(write.status).toBe(400);
    expect((await write.json()).code).toBe("excluded_path");
  });

  test("否定パターンで DEFAULT_EXCLUDES を解除すると読めるようになる", async () => {
    // `build` は DEFAULT_EXCLUDES なので、既定では読めない
    expect((await fetch(`${url}/api/file?path=build/out.md`)).status).toBe(400);
    expect((await fetch(`${url}/api/asset?path=build/logo.png`)).status).toBe(400);

    await save("!build\n");

    expect((await fetch(`${url}/api/file?path=build/out.md`)).status).toBe(200);
    expect((await fetch(`${url}/api/asset?path=build/logo.png`)).status).toBe(200);
    await expect((await fetch(`${url}/api/tree`)).text()).resolves.toContain("out.md");
  });

  test("保存のたびにツリーの版が進む（クライアントが取りこぼしに気づける）", async () => {
    const gen = async () => Number((await fetch(`${url}/api/tree`)).headers.get("X-Yomi-Tree-Gen"));
    const before = await gen();
    await save("secret\n");
    expect(await gen()).toBeGreaterThan(before);
  });

  test("照合できない行は保存の応答でも返る（起動時 warn と同じ文言）", async () => {
    const res = await save("docs/private\n");
    const data = (await res.json()) as { invalid: { line: number; message: string }[] };
    expect(data.invalid).toHaveLength(1);
    expect(data.invalid[0]?.line).toBe(1);
    expect(data.invalid[0]?.message).toContain("`/` を含む行は照合できません");
  });

  test("Origin が違えば 403（既存の書き込み経路と同じ CSRF 対策）", async () => {
    const res = await save("secret\n", { headers: { Origin: "http://evil.example" } });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("origin_forbidden");
    // 書かれていないこと
    await expect(readFile(join(root, YOMIIGNORE_FILENAME), "utf-8")).rejects.toThrow();
  });

  test("text が文字列でなければ 400", async () => {
    const res = await fetch(`${url}/api/yomiignore`, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify({ text: 42 }),
    });
    expect(res.status).toBe(400);
  });

  test("壊れた JSON は 400", async () => {
    const res = await fetch(`${url}/api/yomiignore`, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_json");
  });

  test("上限を超える body は 413", async () => {
    const res = await save("a".repeat(MAX_YOMIIGNORE_BYTES + 1));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("body_too_large");
  });

  test("GET / POST 以外は 405", async () => {
    const res = await fetch(`${url}/api/yomiignore`, {
      method: "DELETE",
      headers: { Origin: url },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, POST");
  });

  test("除外を差し替えると /api/images.zip にも同時に効く", async () => {
    await writeFile(join(root, "article.md"), "# article\n\n![logo](build/logo.png)\n");
    // `build` は DEFAULT_EXCLUDES なので、既定では zip に入らない
    const before = await fetch(`${url}/api/images.zip?path=article.md`);
    expect(before.status).toBe(200);
    expect(Number(before.headers.get("X-Yomi-Images"))).toBe(0);

    await save("!build\n");

    const after = await fetch(`${url}/api/images.zip?path=article.md`);
    expect(after.status).toBe(200);
    expect(Number(after.headers.get("X-Yomi-Images"))).toBe(1);
  });

  test("root 外を指す symlink の .yomiignore は読めない（#156 の経路を開け直さない）", async () => {
    // **`/api/file` は 400 で拒否するのに専用経路だけ素通り、という食い違いを作らない。**
    // 実測でこの穴を踏んだ（`.yomiignore -> ../outside/secret.txt` で中身が返っていた）
    const outside = await mkdtemp(join(tmpdir(), "yomi-ignore-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "SECRET\n");
      await symlink(join(outside, "secret.txt"), join(root, YOMIIGNORE_FILENAME));

      const res = await fetch(`${url}/api/yomiignore`);
      expect(res.status).toBe(400);
      const data = (await res.json()) as { code: string };
      expect(data.code).toBe("unsafe_path");
      expect(JSON.stringify(data)).not.toContain("SECRET");

      // `/api/file` と同じ答えになっていること（入口ごとに違わない）
      const viaFile = await fetch(
        `${url}/api/file?path=${encodeURIComponent(YOMIIGNORE_FILENAME)}`,
      );
      expect(viaFile.status).toBe(400);
      expect((await viaFile.json()).code).toBe("unsafe_path");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("root 外を指す symlink の .yomiignore へは書き込めない（リンクも壊さない）", async () => {
    const outside = await mkdtemp(join(tmpdir(), "yomi-ignore-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "SECRET\n");
      await symlink(join(outside, "secret.txt"), join(root, YOMIIGNORE_FILENAME));

      const res = await save("secret\n");
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("unsafe_path");
      // **リンク先を上書きしていない**（拒否したつもりで書いていた、を防ぐ）
      expect(await readFile(join(outside, "secret.txt"), "utf-8")).toBe("SECRET\n");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("root 内を指す symlink の .yomiignore は従来どおり読み書きできる", async () => {
    // ルート内で完結する symlink まで拒否すると、正常な使い方を壊す
    await writeFile(join(root, "ignore-src.txt"), "secret\n");
    await symlink(join(root, "ignore-src.txt"), join(root, YOMIIGNORE_FILENAME));

    const got = (await (await fetch(`${url}/api/yomiignore`)).json()) as { text: string };
    expect(got.text).toBe("secret\n");
    expect((await save("readme.md\n")).status).toBe(200);
    // リンク先に書かれる（`/api/file` が safe.abs へ書くのと同じ挙動）
    expect(await readFile(join(root, "ignore-src.txt"), "utf-8")).toBe("readme.md\n");
  });

  test("`.yomiignore` 自身を除外に書いても設定画面からは読み書きできる", async () => {
    // **自分で自分を締め出せない。** `/api/file` の除外判定を通す設計にすると、
    // この 1 行を書いた瞬間にパネルが開かなくなる
    await save(`${YOMIIGNORE_FILENAME}\n`);
    const got = (await (await fetch(`${url}/api/yomiignore`)).json()) as { text: string };
    expect(got.text).toBe(`${YOMIIGNORE_FILENAME}\n`);
    expect((await save("secret\n")).status).toBe(200);
  });
});

/**
 * 除外を差し替えたら **watcher も張り直す**（Issue #164）。
 *
 * chokidar は `ignored` を生成時に受け取り、**既に張った watch を作り直さない**。
 * 張り直さないと「除外を解除したのでツリーには出るが、そのファイルを編集しても
 * ライブリロードだけ来ない」という、画面を見ていても気づけないずれ方をする。
 *
 * ここは**実 chokidar** を起こす（フェイクでは張り直しの有無が現れない）。
 */
describe("除外の差し替えと watcher", () => {
  let root: string;
  let handle: ServerHandle | null = null;
  let url: string;
  let readyCount = 0;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-ignore-watch-"));
    await writeFile(join(root, "readme.md"), "# readme");
    await mkdir(join(root, "build"), { recursive: true });
    await writeFile(join(root, "build", "out.md"), "# built");
    readyCount = 0;
    handle = createServer({
      rootDir: root,
      hostname: "127.0.0.1",
      port: 0,
      onWatcherReady: () => {
        readyCount++;
      },
    });
    url = `http://127.0.0.1:${handle.server.port}`;
    await waitFor(() => readyCount >= 1, "初期スキャンが終わらない");
  });

  afterEach(async () => {
    handle?.close();
    handle = null;
    await rm(root, { recursive: true, force: true });
  });

  /** 条件が満たされるまで待つ（固定 sleep は遅い環境で破れる）。 */
  async function waitFor(cond: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    if (!cond()) throw new Error(message);
  }

  /** WebSocket を開いて、届いたメッセージを溜める。 */
  async function openSocket(): Promise<{ messages: Record<string, unknown>[]; close(): void }> {
    const ws = new WebSocket(`${url.replace("http", "ws")}/ws`);
    const messages: Record<string, unknown>[] = [];
    ws.addEventListener("message", (ev) => {
      messages.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    });
    await waitFor(() => messages.some((m) => m.type === "hello"), "WebSocket が開かない");
    return { messages, close: () => ws.close() };
  }

  test("否定で解除したディレクトリが監視に戻る（張り直しが効いている）", async () => {
    const sock = await openSocket();
    try {
      // 解除前: `build` は DEFAULT_EXCLUDES なので watch されていない
      await writeFile(join(root, "build", "before.md"), "# before");
      await new Promise((r) => setTimeout(r, 300));
      expect(sock.messages.some((m) => m.path === "build/before.md")).toBe(false);

      const res = await fetch(`${url}/api/yomiignore`, {
        method: "POST",
        headers: { Origin: url, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "!build\n" }),
      });
      expect(res.status).toBe(200);
      // 保存すると「全量取り直し」が飛ぶ（除外集合が丸ごと入れ替わるので差分では表せない）。
      // **WebSocket の到着は非同期**なので待つ（fetch の解決と同時ではない）
      await waitFor(
        () => sock.messages.some((m) => m.type === "tree" && m.op === undefined),
        "全量取り直しの通知が来ない",
      );
      // 張り直した watcher の初期スキャンを待つ
      await waitFor(() => readyCount >= 2, "張り直した watcher の初期スキャンが終わらない");

      await writeFile(join(root, "build", "after.md"), "# after");
      await waitFor(
        () => sock.messages.some((m) => m.type === "tree" && m.path === "build/after.md"),
        "解除したディレクトリの追加が通知されない",
      );
    } finally {
      sock.close();
    }
  }, 20_000);

  test("追加した除外のディレクトリは監視から外れる", async () => {
    await mkdir(join(root, "scratch"), { recursive: true });
    const sock = await openSocket();
    try {
      const res = await fetch(`${url}/api/yomiignore`, {
        method: "POST",
        headers: { Origin: url, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "scratch\n" }),
      });
      expect(res.status).toBe(200);
      await waitFor(() => readyCount >= 2, "張り直した watcher の初期スキャンが終わらない");

      await writeFile(join(root, "scratch", "tmp.md"), "# tmp");
      await new Promise((r) => setTimeout(r, 300));
      expect(sock.messages.some((m) => m.path === "scratch/tmp.md")).toBe(false);

      // 監視自体は生きている（除外していないファイルは通知される）
      await writeFile(join(root, "watched.md"), "# watched");
      await waitFor(
        () => sock.messages.some((m) => m.type === "tree" && m.path === "watched.md"),
        "除外していないファイルの追加が通知されない",
      );
    } finally {
      sock.close();
    }
  }, 20_000);
});
