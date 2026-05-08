import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/save-mark.ts";
import { createServer, MAX_WRITE_BYTES, type ServerHandle } from "../src/server.ts";

interface ServerCtx {
  url: string;
  origin: string;
  handle: ServerHandle;
}

async function startServer(rootDir: string): Promise<ServerCtx> {
  const handle = createServer({
    rootDir,
    hostname: "127.0.0.1",
    port: 0,
    watch: false,
  });
  const port = handle.server.port;
  const url = `http://127.0.0.1:${port}`;
  return { url, origin: url, handle };
}

describe("server", () => {
  let root: string;
  let ctx: ServerCtx;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-server-"));
    await writeFile(join(root, "hello.md"), "# Hello");
    await writeFile(join(root, "doc.markdown"), "doc");
    await writeFile(join(root, "ext.mdx"), "mdx");
    ctx = await startServer(root);
  });

  afterAll(async () => {
    ctx.handle.close();
    await rm(root, { recursive: true, force: true });
  });

  describe("GET /api/file", () => {
    test("sha が含まれる", async () => {
      const res = await fetch(`${ctx.url}/api/file?path=hello.md`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { path: string; raw: string; sha: string };
      expect(json.path).toBe("hello.md");
      expect(json.raw).toBe("# Hello");
      expect(json.sha).toBe(sha256("# Hello"));
    });
  });

  describe("POST /api/file - 正常系", () => {
    test(".md に書き込める", async () => {
      const res = await fetch(`${ctx.url}/api/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "hello.md", body: "# Hello updated" }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { sha: string; raw: string };
      expect(json.raw).toBe("# Hello updated");
      expect(json.sha).toBe(sha256("# Hello updated"));

      const onDisk = await readFile(join(root, "hello.md"), "utf-8");
      expect(onDisk).toBe("# Hello updated");
    });

    test(".markdown / .mdx も許可", async () => {
      const r1 = await fetch(`${ctx.url}/api/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "doc.markdown", body: "doc updated" }),
      });
      expect(r1.status).toBe(200);

      const r2 = await fetch(`${ctx.url}/api/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "ext.mdx", body: "mdx updated" }),
      });
      expect(r2.status).toBe(200);
    });
  });

  describe("POST /api/file - Origin 検証", () => {
    test("Origin が一致するなら 200", async () => {
      const res = await fetch(`${ctx.url}/api/file`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ctx.origin,
        },
        body: JSON.stringify({ path: "hello.md", body: "ok" }),
      });
      expect(res.status).toBe(200);
    });

    test("Origin が異なれば 403", async () => {
      const res = await fetch(`${ctx.url}/api/file`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://attacker.example",
        },
        body: JSON.stringify({ path: "hello.md", body: "evil" }),
      });
      expect(res.status).toBe(403);
    });

    test("Origin がなければ許可される (curl 等)", async () => {
      // fetch は通常 Origin を付けるので、これはあくまで checkOrigin の挙動確認。
      // Bun の fetch だと Origin が常に付くため、別途 server.ts の checkOrigin の単体テストを参照。
      // ここではコメントのみとし、ユニットテストで補完する。
      expect(true).toBe(true);
    });
  });

  describe("POST /api/file - パストラバーサル", () => {
    test("絶対パスは 400", async () => {
      const res = await fetch(`${ctx.url}/api/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/etc/passwd.md", body: "x" }),
      });
      expect(res.status).toBe(400);
    });

    test("親ディレクトリ参照は 400", async () => {
      const res = await fetch(`${ctx.url}/api/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "../escape.md", body: "x" }),
      });
      expect(res.status).toBe(400);
    });

    test("空 path は 400", async () => {
      const res = await fetch(`${ctx.url}/api/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "", body: "x" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/file - 拡張子チェック", () => {
    test(".txt は 400", async () => {
      const res = await fetch(`${ctx.url}/api/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "danger.txt", body: "x" }),
      });
      expect(res.status).toBe(400);
    });

    test("拡張子なしは 400", async () => {
      const res = await fetch(`${ctx.url}/api/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "noext", body: "x" }),
      });
      expect(res.status).toBe(400);
    });
  });

  // サイズ上限の挙動は専用 describe ブロックで後ろに置く (10MB POST が前段テストの状態に影響しないように)

  describe("POST /api/file - baseSha 検証 (Lost Update 対策)", () => {
    test("baseSha 一致なら 200 + 新 sha 返却", async () => {
      const target = "doc.markdown";
      const get = await fetch(`${ctx.url}/api/file?path=${target}`);
      const cur = (await get.json()) as { sha: string };

      const res = await fetch(`${ctx.url}/api/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: target, body: "after", baseSha: cur.sha }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { sha: string };
      expect(json.sha).toBe(sha256("after"));
    });

    test("baseSha 不一致なら 409 + 現状内容を返却", async () => {
      const target = "ext.mdx";
      // 直接ディスクを書き換えて baseSha が古くなる状況を作る
      await writeFile(join(root, target), "actual on disk");

      const res = await fetch(`${ctx.url}/api/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: target, body: "client edit", baseSha: "stale-sha" }),
      });
      expect(res.status).toBe(409);
      const json = (await res.json()) as { sha: string; raw: string; error: string };
      expect(json.sha).toBe(sha256("actual on disk"));
      expect(json.raw).toBe("actual on disk");
      expect(json.error).toMatch(/更新されて/);

      // 上書きされていないこと
      const onDisk = await readFile(join(root, target), "utf-8");
      expect(onDisk).toBe("actual on disk");
    });

    test("baseSha 省略は強制上書き", async () => {
      const target = "hello.md";
      const res = await fetch(`${ctx.url}/api/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: target, body: "force overwrite" }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/file - JSON / 型エラー", () => {
    test("不正な JSON で 400", async () => {
      const res = await fetch(`${ctx.url}/api/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    test("body が string でないと 400", async () => {
      const res = await fetch(`${ctx.url}/api/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "hello.md", body: 123 }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("HTTP method", () => {
    test("PUT /api/file は 405", async () => {
      const res = await fetch(`${ctx.url}/api/file`, { method: "PUT" });
      expect(res.status).toBe(405);
    });
  });
});

describe("server - body サイズ上限", () => {
  let root: string;
  let ctx: ServerCtx;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-server-size-"));
    await writeFile(join(root, "target.md"), "");
    ctx = await startServer(root);
  });

  afterAll(async () => {
    ctx.handle.close();
    await rm(root, { recursive: true, force: true });
  });

  test("body の実 byte 数が上限超過なら 413", async () => {
    const huge = "x".repeat(MAX_WRITE_BYTES + 1);
    const res = await fetch(`${ctx.url}/api/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "target.md", body: huge }),
    });
    expect(res.status).toBe(413);

    // 上書きされていないこと (空のまま)
    const onDisk = await readFile(join(root, "target.md"), "utf-8");
    expect(onDisk).toBe("");
  });
});

describe("checkOrigin (unit)", () => {
  // 直接 unit test (fetch が常に Origin を付けるケースで「Origin なし」が試せないため)
  test("Origin なしなら true", async () => {
    const { checkOrigin } = await import("../src/server.ts");
    const req = new Request("http://yomi.local/api/file", {
      method: "POST",
      headers: { Host: "yomi.local" },
    });
    expect(checkOrigin(req)).toBe(true);
  });

  test("Origin と Host のホスト部が一致すれば true", async () => {
    const { checkOrigin } = await import("../src/server.ts");
    const req = new Request("http://yomi.local/api/file", {
      method: "POST",
      headers: { Origin: "http://yomi.local", Host: "yomi.local" },
    });
    expect(checkOrigin(req)).toBe(true);
  });

  test("Origin と Host が一致しなければ false", async () => {
    const { checkOrigin } = await import("../src/server.ts");
    const req = new Request("http://yomi.local/api/file", {
      method: "POST",
      headers: { Origin: "http://attacker.example", Host: "yomi.local" },
    });
    expect(checkOrigin(req)).toBe(false);
  });

  test("Origin が不正な URL なら false", async () => {
    const { checkOrigin } = await import("../src/server.ts");
    const req = new Request("http://yomi.local/api/file", {
      method: "POST",
      headers: { Origin: "not-a-url", Host: "yomi.local" },
    });
    expect(checkOrigin(req)).toBe(false);
  });
});
