import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/save-mark.ts";
import {
  createServer,
  MAX_ASSET_BYTES,
  MAX_WRITE_BYTES,
  type ServerHandle,
} from "../src/server.ts";

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

describe("server - /api/asset (Issue #19)", () => {
  let root: string;
  let ctx: ServerCtx;
  const PNG_BYTES = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000005000170c0bedb0000000049454e44ae426082",
    "hex",
  );

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-asset-"));
    await writeFile(join(root, "pic.png"), PNG_BYTES);
    await writeFile(join(root, "doc.md"), "![alt](pic.png)");
    // サブディレクトリ
    await mkdir(join(root, "images"), { recursive: true });
    await writeFile(join(root, "images", "x.png"), PNG_BYTES);
    await writeFile(join(root, "danger.txt"), "secret");
    await writeFile(join(root, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    // 画像拡張子に見えるディレクトリ (isFile() 偽の経路)
    await mkdir(join(root, "dir.png"), { recursive: true });
    // root 外を指す symlink (resolveSafe で 400 になるべき)
    await symlink("/etc/hosts", join(root, "evil.png")).catch(() => {
      /* 環境によっては symlink 不可、その場合はテストを skip */
    });
    ctx = await startServer(root);
  });

  afterAll(async () => {
    ctx.handle.close();
    await rm(root, { recursive: true, force: true });
  });

  test("ルート直下の png が配信される (Content-Type / ETag / Cache-Control)", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=pic.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("etag")).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(PNG_BYTES)).toBe(true);
  });

  test("サブディレクトリの画像も配信される", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=images/x.png`);
    expect(res.status).toBe(200);
  });

  test("If-None-Match で 304 を返す", async () => {
    const first = await fetch(`${ctx.url}/api/asset?path=pic.png`);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await fetch(`${ctx.url}/api/asset?path=pic.png`, {
      headers: { "If-None-Match": etag ?? "" },
    });
    expect(second.status).toBe(304);
  });

  test("HEAD は body なしで Content-Length を返す", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=pic.png`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(PNG_BYTES.length));
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(0);
  });

  test("SVG は image/svg+xml + nosniff", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=logo.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("画像以外の拡張子は 400", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=danger.txt`);
    expect(res.status).toBe(400);
  });

  test("path 未指定は 400", async () => {
    const res = await fetch(`${ctx.url}/api/asset`);
    expect(res.status).toBe(400);
  });

  test("親ディレクトリ参照 (..) は 400", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=../escape.png`);
    expect(res.status).toBe(400);
  });

  test("絶対パスは 400", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=/etc/passwd.png`);
    expect(res.status).toBe(400);
  });

  test("存在しない画像は 404", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=missing.png`);
    expect(res.status).toBe(404);
  });

  test("POST /api/asset は 405", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=pic.png`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  test("GET /api/file は html 内の img を /api/asset?path=... に書き換える", async () => {
    const res = await fetch(`${ctx.url}/api/file?path=doc.md`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { html: string };
    expect(json.html).toContain('<img src="/api/asset?path=pic.png"');
  });

  test("If-None-Match 不一致なら 200 + body を返す", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=pic.png`, {
      headers: { "If-None-Match": 'W/"deadbeef-1"' },
    });
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(PNG_BYTES)).toBe(true);
  });

  test("画像拡張子のディレクトリは 400", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=dir.png`);
    expect(res.status).toBe(400);
  });

  test("ファイル更新後は ETag が変化する", async () => {
    const target = "images/x.png";
    const r1 = await fetch(`${ctx.url}/api/asset?path=${target}`);
    const e1 = r1.headers.get("etag");
    // バイト数を変えて mtime + size の両方が変わるようにする
    const bigger = Buffer.concat([PNG_BYTES, Buffer.from([0x00])]);
    await writeFile(join(root, "images", "x.png"), bigger);
    const r2 = await fetch(`${ctx.url}/api/asset?path=${target}`);
    const e2 = r2.headers.get("etag");
    expect(e2).not.toBe(e1);
  });

  test("root 外を指す symlink は 400", async () => {
    // beforeAll で symlink が作れなかった環境はスキップ
    const { stat } = await import("node:fs/promises");
    const exists = await stat(join(root, "evil.png"))
      .then(() => true)
      .catch(() => false);
    if (!exists) return;
    const res = await fetch(`${ctx.url}/api/asset?path=evil.png`);
    expect(res.status).toBe(400);
  });
});

describe("server - /api/asset サイズ上限 (Issue #19)", () => {
  let root: string;
  let ctx: ServerCtx;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-asset-size-"));
    // sparse file: 実体は最小限でも size は MAX_ASSET_BYTES + 1
    const p = join(root, "huge.png");
    await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await truncate(p, MAX_ASSET_BYTES + 1);
    ctx = await startServer(root);
  });

  afterAll(async () => {
    ctx.handle.close();
    await rm(root, { recursive: true, force: true });
  });

  test("MAX_ASSET_BYTES 超は 413", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=huge.png`);
    expect(res.status).toBe(413);
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
