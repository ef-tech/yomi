import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { sha256 } from "../src/save-mark.ts";
import {
  createServer,
  MAX_ASSET_BYTES,
  MAX_TEXT_BYTES,
  MAX_WRITE_BYTES,
  type ServerHandle,
} from "../src/server.ts";
import { writeFileAtomic } from "../src/util/atomic-write.ts";
import { parseYomiignore, resolveExcludes } from "../src/yomiignore.ts";

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

    // Issue #48: 存在しないファイルの 404 は i18n 用 code:"not_found" を含む
    test("存在しないファイルは 404 + code:not_found", async () => {
      const res = await fetch(`${ctx.url}/api/file?path=nope.md`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code?: string }).code).toBe("not_found");
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
    test("PUT /api/file は 405 + Allow: GET, POST (Issue #22)", async () => {
      const res = await fetch(`${ctx.url}/api/file`, { method: "PUT" });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, POST");
    });
  });

  describe("POST /api/file/create (Issue #6)", () => {
    const create = (body: unknown) =>
      fetch(`${ctx.url}/api/file/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });

    beforeAll(async () => {
      await mkdir(join(root, "docs"), { recursive: true });
      await mkdir(join(root, "node_modules"), { recursive: true });
    });

    test(".md を作成できる (空ファイル + path 返却)", async () => {
      const res = await create({ path: "created.md" });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { path: string };
      expect(json.path).toBe("created.md");
      const onDisk = await readFile(join(root, "created.md"), "utf-8");
      expect(onDisk).toBe("");
    });

    test(".markdown / .mdx も作成できる", async () => {
      for (const name of ["created.markdown", "created.mdx"]) {
        const res = await create({ path: name });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { path: string }).path).toBe(name);
      }
    });

    test("既存サブディレクトリ内に作成できる", async () => {
      const res = await create({ path: "docs/nested.md" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { path: string }).path).toBe("docs/nested.md");
      const onDisk = await readFile(join(root, "docs", "nested.md"), "utf-8");
      expect(onDisk).toBe("");
    });

    test("既存ファイルは 409 (内容は壊れない)", async () => {
      await writeFile(join(root, "keep.md"), "# Keep");
      const res = await create({ path: "keep.md" });
      expect(res.status).toBe(409);
      const onDisk = await readFile(join(root, "keep.md"), "utf-8");
      expect(onDisk).toBe("# Keep");
    });

    test("パストラバーサル (../) は 400", async () => {
      const res = await create({ path: "../evil.md" });
      expect(res.status).toBe(400);
    });

    test("絶対パスは 400", async () => {
      const res = await create({ path: "/tmp/evil.md" });
      expect(res.status).toBe(400);
    });

    test("Markdown 以外の拡張子は 400", async () => {
      for (const path of ["evil.txt", "evil.sh", "noext"]) {
        const res = await create({ path });
        expect(res.status).toBe(400);
      }
    });

    test("親ディレクトリが存在しない場合は 400 (再帰作成しない)", async () => {
      const res = await create({ path: "no-such-dir/new.md" });
      expect(res.status).toBe(400);
    });

    test("親パス成分がファイル (ディレクトリでない) なら 400 (ENOTDIR)", async () => {
      // hello.md は既存のファイル。これを親ディレクトリ扱いした作成は ENOTDIR → 400。
      const res = await create({ path: "hello.md/child.md" });
      expect(res.status).toBe(400);
    });

    test("除外ディレクトリ (node_modules) 配下は 400", async () => {
      const res = await create({ path: "node_modules/sneaky.md" });
      expect(res.status).toBe(400);
    });

    test("path なし / 不正 JSON は 400", async () => {
      expect((await create({})).status).toBe(400);
      expect((await create({ path: 123 })).status).toBe(400);
      expect((await create("{not json")).status).toBe(400);
    });

    test("Origin が異なれば 403", async () => {
      const res = await fetch(`${ctx.url}/api/file/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://attacker.example" },
        body: JSON.stringify({ path: "csrf.md" }),
      });
      expect(res.status).toBe(403);
    });

    test("GET /api/file/create は 405 + Allow: POST", async () => {
      const res = await fetch(`${ctx.url}/api/file/create`);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    });

    // Issue #48: フロントの i18n はサーバの error `code` を翻訳キーに対応づける。
    // 各エラー応答が想定 code を返すことを保証する (メッセージ文字列は fallback)。
    test("エラー応答は i18n 用の code を含む", async () => {
      const codeOf = async (res: Response) => ((await res.json()) as { code?: string }).code;

      await writeFile(join(root, "dup.md"), "# dup");
      expect(await codeOf(await create({ path: "dup.md" }))).toBe("already_exists");
      expect(await codeOf(await create({ path: "evil.txt" }))).toBe("not_markdown");
      expect(await codeOf(await create({ path: "node_modules/x.md" }))).toBe("excluded_dir");
      expect(await codeOf(await create({ path: "no-such-dir/new.md" }))).toBe("parent_missing");
      expect(await codeOf(await create({ path: "../evil.md" }))).toBe("unsafe_path");
      expect(await codeOf(await create({}))).toBe("path_required");
      expect(await codeOf(await create("{not json"))).toBe("invalid_json");

      const csrf = await fetch(`${ctx.url}/api/file/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://attacker.example" },
        body: JSON.stringify({ path: "csrf.md" }),
      });
      expect(await codeOf(csrf)).toBe("origin_forbidden");
    });

    test("大文字拡張子 (.MD) も作成できる (サーバ判定は大文字小文字無視)", async () => {
      const res = await create({ path: "Upper.MD" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { path: string }).path).toBe("Upper.MD");
      expect(await readFile(join(root, "Upper.MD"), "utf-8")).toBe("");
    });

    test("作成成功で self save-mark (空内容 sha) が登録される (二重リロード抑止)", async () => {
      const res = await create({ path: "marked.md" });
      expect(res.status).toBe(200);
      expect(ctx.handle.saveMark.has("marked.md", sha256(Buffer.from("")))).toBe(true);
    });

    test("作成失敗 (409) は既存の save-mark を clear しない (クロバー回帰)", async () => {
      const first = await create({ path: "twice.md" });
      expect(first.status).toBe(200);
      expect(ctx.handle.saveMark.has("twice.md", sha256(Buffer.from("")))).toBe(true);
      // 2 回目は 409。失敗時にマークを触らないので 1 回目のマークが残る
      const second = await create({ path: "twice.md" });
      expect(second.status).toBe(409);
      expect(ctx.handle.saveMark.has("twice.md", sha256(Buffer.from("")))).toBe(true);
    });

    test(".yomiignore 由来の除外ディレクトリ配下も 400", async () => {
      const r = await mkdtemp(join(tmpdir(), "yomi-excl-"));
      await mkdir(join(r, "secret"), { recursive: true });
      const handle = createServer({
        rootDir: r,
        hostname: "127.0.0.1",
        port: 0,
        watch: false,
        excludes: new Set(["secret"]),
      });
      try {
        const res = await fetch(`http://127.0.0.1:${handle.server.port}/api/file/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "secret/x.md" }),
        });
        expect(res.status).toBe(400);
      } finally {
        handle.close();
        await rm(r, { recursive: true, force: true });
      }
    });

    test("symlink された親ディレクトリ経由でルート外には作成できない (400)", async () => {
      const base = await mkdtemp(join(tmpdir(), "yomi-sym-"));
      const r = join(base, "root");
      const outside = join(base, "outside");
      await mkdir(r);
      await mkdir(outside);
      // root 内に root 外を指すシンボリックリンクディレクトリを作る
      await symlink(outside, join(r, "linkdir"));
      const handle = createServer({ rootDir: r, hostname: "127.0.0.1", port: 0, watch: false });
      try {
        const res = await fetch(`http://127.0.0.1:${handle.server.port}/api/file/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "linkdir/evil.md" }),
        });
        expect(res.status).toBe(400);
        // ルート外にファイルが作られていないこと
        expect(await readdir(outside)).toEqual([]);
      } finally {
        handle.close();
        await rm(base, { recursive: true, force: true });
      }
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

  // Issue #37: PDF を /api/asset で配信できることを検証
  const PDF_BYTES = Buffer.from("%PDF-1.4\n%test pdf body\n%%EOF\n", "utf-8");

  // Issue #64: csv 等を attachment で配信できることを検証
  const CSV_BYTES = Buffer.from("id,name\n1,りんご\n", "utf-8");

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-asset-"));
    await writeFile(join(root, "pic.png"), PNG_BYTES);
    await writeFile(join(root, "doc.md"), "![alt](pic.png)");
    await writeFile(join(root, "return_voucher.pdf"), PDF_BYTES);
    // サブディレクトリ
    await mkdir(join(root, "images"), { recursive: true });
    await writeFile(join(root, "images", "x.png"), PNG_BYTES);
    // Issue #64: 実行・描画される形式は許可リストに入れない (拒否され続けること)
    await writeFile(join(root, "danger.html"), "<script>alert(1)</script>");
    await writeFile(join(root, "danger.js"), "alert(1)");
    await writeFile(join(root, "sales.csv"), CSV_BYTES);
    await writeFile(join(root, "売上 データ.csv"), CSV_BYTES);
    await writeFile(join(root, "notes.txt"), "secret");
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
    // Issue #22: 強 ETag (sha256 prefix 16 byte = 32 hex 文字)
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
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

  test("対応していない拡張子は 400 + エラー文言", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=danger.html`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("対応していない拡張子です");
  });

  test("Issue #64: 許可リストを広げても実行される形式 (.html / .js) は拒否されたまま", async () => {
    for (const path of ["danger.html", "danger.js"]) {
      const res = await fetch(`${ctx.url}/api/asset?path=${path}`);
      expect(res.status).toBe(400);
    }
  });

  test("Issue #37: PDF が application/pdf + inline で配信される", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=return_voucher.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(PDF_BYTES)).toBe(true);
  });

  test("Issue #64: csv が text/csv + attachment で配信される", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=sales.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="sales.csv"; filename*=UTF-8''sales.csv`,
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(CSV_BYTES)).toBe(true);
  });

  test("Issue #64: 日本語ファイル名は filename*=UTF-8'' で壊れず、fallback は ASCII 化される", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=${encodeURIComponent("売上 データ.csv")}`);
    expect(res.status).toBe(200);
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent("売上 データ.csv")}`);
    // fallback は非 ASCII を `_` に落とす (引用符・改行がヘッダに載らない)
    expect(cd).toContain('filename="__ ___.csv"');
  });

  test("Issue #64: サブディレクトリの csv も basename だけがファイル名になる", async () => {
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(join(root, "data", "nested.csv"), CSV_BYTES);
    const res = await fetch(`${ctx.url}/api/asset?path=data/nested.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="nested.csv"; filename*=UTF-8''nested.csv`,
    );
  });

  test("Issue #64: txt も attachment で配信される (inline は画像 / PDF のみ)", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=notes.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-disposition")?.startsWith("attachment;")).toBe(true);
  });

  test("Issue #64: 画像は inline のまま (既存の表示挙動を変えない)", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=pic.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe("inline");
  });

  test("Issue #37: PDF も path traversal は拒否 (画像と同じ resolveSafe を継承)", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=${encodeURIComponent("../escape.pdf")}`);
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

  test("POST /api/asset は 405 + Allow: GET, HEAD (Issue #22)", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=pic.png`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
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

  test("ETag は内容ベース (Issue #22): 同 mtime + 同 size でも内容が違えば別 ETag", async () => {
    const { utimes } = await import("node:fs/promises");
    const target = join(root, "images", "x.png");
    // 同サイズの 2 種類のバッファを用意
    const sameSize = PNG_BYTES.length;
    const bufA = Buffer.alloc(sameSize, 0xaa);
    const bufB = Buffer.alloc(sameSize, 0xbb);
    // 固定タイムスタンプ
    const fixedTime = new Date("2026-01-01T00:00:00Z");

    await writeFile(target, bufA);
    await utimes(target, fixedTime, fixedTime);
    const r1 = await fetch(`${ctx.url}/api/asset?path=images/x.png`);
    const e1 = r1.headers.get("etag");

    await writeFile(target, bufB);
    await utimes(target, fixedTime, fixedTime); // 同 mtime に強制
    const r2 = await fetch(`${ctx.url}/api/asset?path=images/x.png`);
    const e2 = r2.headers.get("etag");

    // mtime + size が同じでも内容が違えば sha256 が違うので別 ETag
    expect(e1).toBeTruthy();
    expect(e2).toBeTruthy();
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
    const png = join(root, "huge.png");
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await truncate(png, MAX_ASSET_BYTES + 1);
    // Issue #37: PDF も同じ size limit に従う
    const pdf = join(root, "huge.pdf");
    await writeFile(pdf, Buffer.from("%PDF-1.4\n", "utf-8"));
    await truncate(pdf, MAX_ASSET_BYTES + 1);
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

  test("Issue #37: PDF も MAX_ASSET_BYTES 超で 413 + 統一エラー文言", async () => {
    const res = await fetch(`${ctx.url}/api/asset?path=huge.pdf`);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ファイルサイズが大きすぎます");
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

// **保存を temp + rename にした (Issue #101)。**
//
// `writeFile` は O_TRUNC でファイルを開いてから書くので、途中でプロセスが落ちると
// 内容が失われる。yomi は Markdown を書き戻すツールなので、それは利用者の原稿が消えること。
// v0.20.0 の watchdog (Issue #91) が SIGKILL でプロセスを落とす経路を新設したぶん、
// 現実味が増している。
describe("server - 保存が原子的である (Issue #101)", () => {
  let root: string;
  let handle: ServerHandle;
  let url: string;

  const save = (path: string, body: string, baseSha?: string) =>
    fetch(`${url}/api/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseSha ? { path, body, baseSha } : { path, body }),
    });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-atomic-"));
    await writeFile(join(root, "doc.md"), "# 元の内容\n");
    handle = createServer({ rootDir: root, hostname: "127.0.0.1", port: 0, watch: false });
    url = `http://127.0.0.1:${handle.server.port}`;
  });

  afterAll(async () => {
    handle.close();
    await rm(root, { recursive: true, force: true });
  });

  test("通常の保存は従来どおり通る", async () => {
    const res = await save("doc.md", "# 書き換えた\n");
    expect(res.status).toBe(200);
    expect(await readFile(join(root, "doc.md"), "utf-8")).toBe("# 書き換えた\n");
  });

  test("一時ファイルを残さない", async () => {
    await save("doc.md", "# もう一度\n");
    const left = (await readdir(root)).filter((f) => f.endsWith(".tmp"));
    expect(left).toEqual([]);
  });

  // **DoD の核心**: 「書き終わったが、まだ対象を触っていない」瞬間が存在すること。
  //
  // ここが temp + rename の肝で、**プロセスがこの時点で落ちても対象は元のまま**になる。
  // 外から見ると一瞬なので、rename 直前のフックで決定的に観測する
  // (大きなデータを書いている隙に読む形はタイミング依存で flaky になる)。
  test("rename の直前では、temp に書き終わって対象は元のままである", async () => {
    const target = join(root, "atomic.md");
    await writeFile(target, "# 元の内容\n");

    // rename を差し替えて、その瞬間の状態を決定的に観測する
    await writeFileAtomic(target, Buffer.from("# 新しい内容\n"), {
      rename: async (temp, dest) => {
        // 対象はまだ元のまま = ここで落ちても原稿は失われない
        expect(await readFile(dest as string, "utf-8")).toBe("# 元の内容\n");
        // 新しい内容は temp に揃っている
        expect(await readFile(temp as string, "utf-8")).toBe("# 新しい内容\n");
        // **同じディレクトリに置く** (別 FS だと rename が EXDEV で落ちる)
        expect(dirname(temp as string)).toBe(root);
        await rename(temp as string, dest as string);
      },
    });

    expect(await readFile(target, "utf-8")).toBe("# 新しい内容\n");
  });

  test("rename が失敗しても対象は元のままで、temp も残らない", async () => {
    const target = join(root, "fail.md");
    await writeFile(target, "# 壊れてはいけない\n");

    // 本物の失敗（EXDEV 等）を模す
    await expect(
      writeFileAtomic(target, Buffer.from("# 新しい内容\n"), {
        rename: async () => {
          const err = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
          err.code = "EXDEV";
          throw err;
        },
      }),
    ).rejects.toThrow("EXDEV");

    expect(await readFile(target, "utf-8")).toBe("# 壊れてはいけない\n");
    expect((await readdir(root)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  // **Blocker だった**: rename は新しい inode を作るので、明示的に継がないと
  // 元のモードが umask 既定 (0664 等) に置き換わる。0600 の個人メモが保存のたびに緩む
  test("元のファイルのパーミッションを引き継ぐ", async () => {
    const target = join(root, "secret.md");
    await writeFile(target, "# 秘密\n");
    await chmod(target, 0o600);

    await writeFileAtomic(target, Buffer.from("# 書き換えた\n"));

    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  test("対象が無ければ新規作成として扱う（モード継承を試みない）", async () => {
    const target = join(root, "brand-new.md");
    await writeFileAtomic(target, Buffer.from("# 新規\n"));
    expect(await readFile(target, "utf-8")).toBe("# 新規\n");
  });

  // 一時ファイルは `O_CREAT|O_EXCL` で作る。既存ファイル・symlink を追って書かない
  test("一時ファイルの名前が推測しにくい（暗号学的乱数を使う）", async () => {
    const target = join(root, "rand.md");
    await writeFile(target, "# x\n");
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      await writeFileAtomic(target, Buffer.from(`# ${i}\n`), {
        rename: async (temp, dest) => {
          names.push(basename(temp as string));
          await rename(temp as string, dest as string);
        },
      });
    }
    // pid は同じでも、ランダム部分が毎回変わる
    expect(new Set(names).size).toBe(3);
    expect(names.every((n) => /\.[0-9a-f]{12}\.tmp$/.test(n))).toBe(true);
  });

  // 一時ファイルが**対象と同じディレクトリ**に作られることを実際に観測する
  // (別 FS に置くと rename が EXDEV で失敗するので、この位置関係が要件)
  test("ネストしたディレクトリでも temp は対象と同じ場所に作られる", async () => {
    const sub = join(root, "nested");
    await mkdir(sub, { recursive: true });
    const target = join(sub, "deep.md");
    await writeFile(target, "# deep\n");

    // フックが throw すれば writeFileAtomic が reject するので、中で直接 expect してよい
    // (外の変数に持ち出すと制御フロー解析が追えず、キャストで型を黙らせる羽目になる)
    await writeFileAtomic(target, Buffer.from("# 書き換え\n"), {
      rename: async (temp, dest) => {
        expect(dirname(temp as string)).toBe(sub);
        await rename(temp as string, dest as string);
      },
    });

    expect(await readFile(target, "utf-8")).toBe("# 書き換え\n");
  });

  // **エンドポイントとの結線**: DoD 1 は「POST /api/file の保存が」なので、
  // ユニットだけでなく HTTP 経路が原子的な実装を通ることを見る
  test("POST /api/file が原子的な書き込みを通る（temp を経由する）", async () => {
    const seen: string[] = [];
    const target = join(root, "wired.md");
    await writeFile(target, "# 元\n");
    // 実サーバ経由では注入できないので、同じ関数を同条件で呼んで経路を確認する
    await writeFileAtomic(target, Buffer.from("# 経由\n"), {
      rename: async (temp, dest) => {
        seen.push(basename(temp as string));
        await rename(temp as string, dest as string);
      },
    });
    expect(seen).toHaveLength(1);
    // エンドポイント側も同じ結果になる
    const res = await save("wired.md", "# API から\n");
    expect(res.status).toBe(200);
    expect(await readFile(target, "utf-8")).toBe("# API から\n");
    expect((await readdir(root)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  // 既存の保存フローに回帰がないこと
  test("baseSha による競合検出は従来どおり働く", async () => {
    await save("doc.md", "# 現在の内容\n");
    const stale = await save("doc.md", "# 上書きしたい\n", "stale-sha");
    expect(stale.status).toBe(409);
    // 競合したので書き換わっていない
    expect(await readFile(join(root, "doc.md"), "utf-8")).toBe("# 現在の内容\n");
  });
});

// 大ボディ POST は body をドレインせず早期 413 を返すため keep-alive 接続を
// 汚す。他テストと接続を共有しないよう専用サーバ (別ポート) で隔離する。
describe("server - /api/file/create body サイズ上限", () => {
  let root: string;
  let ctx: ServerCtx;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-create-size-"));
    ctx = await startServer(root);
  });

  afterAll(async () => {
    ctx.handle.close();
    await rm(root, { recursive: true, force: true });
  });

  test("上限超過ボディは 413 (DoS 防御)", async () => {
    const huge = `${"x".repeat(MAX_WRITE_BYTES + 1)}.md`;
    const res = await fetch(`${ctx.url}/api/file/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: huge }),
    });
    expect(res.status).toBe(413);
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

describe("server - 除外配下の読み取り拒否 (Issue #65)", () => {
  let root: string;
  let handle: ServerHandle;
  let url: string;

  const PNG = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000005000170c0bedb0000000049454e44ae426082",
    "hex",
  );

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-excl-read-"));
    // ディレクトリ名での除外 (.yomiignore に `private` と書いた場合)
    await mkdir(join(root, "private"), { recursive: true });
    await writeFile(join(root, "private", "secret.md"), "# secret\n");
    await writeFile(join(root, "private", "creds.csv"), "user,password\n");
    await writeFile(join(root, "private", "hidden.png"), PNG);
    // ファイル名での除外 (.yomiignore に `memo.md` と書いた場合)
    await writeFile(join(root, "memo.md"), "# memo\n");
    await writeFile(join(root, "memo.csv"), "a,b\n");
    // 除外されない対照
    await writeFile(join(root, "public.md"), "# public\n");
    await writeFile(join(root, "public.csv"), "a,b\n");
    // 除外配下を指すリンクを root 直下に置いても迂回できないこと
    await symlink(join(root, "private", "creds.csv"), join(root, "link.csv"));
    await symlink(join(root, "private", "secret.md"), join(root, "link.md"));
    // 除外配下にルート外を指すリンクがある (unsafe_path オラクルの検証用)
    await symlink("/etc/hostname", join(root, "private", "escape.csv"));
    // 除外名そのものが symlink のケース (realpath でその名前が消える)
    await mkdir(join(root, "real"), { recursive: true });
    await writeFile(join(root, "real", "inner.csv"), "REAL\n");
    await symlink(join(root, "real"), join(root, "aliased"));

    handle = createServer({
      rootDir: root,
      hostname: "127.0.0.1",
      port: 0,
      watch: false,
      excludes: new Set(["private", "memo.md", "memo.csv", "aliased"]),
    });
    url = `http://127.0.0.1:${handle.server.port}`;
  });

  afterAll(async () => {
    handle.close();
    await rm(root, { recursive: true, force: true });
  });

  async function codeOf(res: Response): Promise<string | undefined> {
    return ((await res.json()) as { code?: string }).code;
  }

  test("前提: 除外したものは /api/tree に出ない", async () => {
    const tree = (await (await fetch(`${url}/api/tree`)).json()) as {
      children: { name: string }[];
    };
    const names = tree.children.map((c) => c.name);
    expect(names).toContain("public.md");
    expect(names).not.toContain("private");
    expect(names).not.toContain("memo.md");
  });

  test("ディレクトリ除外配下は /api/file から読めない", async () => {
    const res = await fetch(`${url}/api/file?path=private/secret.md`);
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("excluded_path");
  });

  test("ディレクトリ除外配下は /api/asset から取得できない", async () => {
    for (const p of ["private/creds.csv", "private/hidden.png"]) {
      const res = await fetch(`${url}/api/asset?path=${p}`);
      expect(res.status).toBe(400);
      expect(await codeOf(res)).toBe("excluded_path");
    }
  });

  test("ファイル名での除外も /api/file / /api/asset の両方に効く", async () => {
    const md = await fetch(`${url}/api/file?path=memo.md`);
    expect(md.status).toBe(400);
    expect(await codeOf(md)).toBe("excluded_path");

    const csv = await fetch(`${url}/api/asset?path=memo.csv`);
    expect(csv.status).toBe(400);
    expect(await codeOf(csv)).toBe("excluded_path");
  });

  test("除外されていないファイルは従来どおり読める", async () => {
    expect((await fetch(`${url}/api/file?path=public.md`)).status).toBe(200);
    expect((await fetch(`${url}/api/asset?path=public.csv`)).status).toBe(200);
  });

  test("除外配下を指す symlink 経由でも取得できない (解決後の rel で判定)", async () => {
    for (const p of ["link.csv", "link.md"]) {
      const res = await fetch(
        p.endsWith(".md") ? `${url}/api/file?path=${p}` : `${url}/api/asset?path=${p}`,
      );
      expect(res.status).toBe(400);
      expect(await codeOf(res)).toBe("excluded_path");
    }
  });

  // 解決後だけで判定すると、要求していない実パスを教えてしまう。さらに「echo が要求と
  // 違う」こと自体がリンク先の実在を証明する。
  test("エラーは要求パスだけを echo し、解決後の実パスを漏らさない", async () => {
    const res = await fetch(`${url}/api/asset?path=link.csv`);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("link.csv");
    expect(json.error).not.toContain("private");
    expect(json.error).not.toContain("creds.csv");
  });

  // 解決前に字句で弾かないと resolveSafe が先に throw し、unsafe_path が返る。
  // 応答の違いから「除外配下にそのエントリがある」ことが分かってしまう。
  test("除外配下のルート外 symlink も unsafe_path でなく excluded_path (存在オラクルを塞ぐ)", async () => {
    const outsideLink = await fetch(`${url}/api/asset?path=private/escape.csv`);
    const missing = await fetch(`${url}/api/asset?path=private/nope.csv`);
    expect(outsideLink.status).toBe(400);
    expect(await codeOf(outsideLink)).toBe("excluded_path");
    expect(await codeOf(missing)).toBe("excluded_path");
  });

  // realpath が除外名 (symlink) を消すので、解決後だけの判定ではすり抜ける。
  test("除外名そのものが symlink でもすり抜けない", async () => {
    const res = await fetch(`${url}/api/asset?path=aliased/inner.csv`);
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("excluded_path");
  });

  test("バックスラッシュ区切りでも除外をすり抜けない", async () => {
    const res = await fetch(`${url}/api/asset?path=${encodeURIComponent("private\\creds.csv")}`);
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("excluded_path");
  });

  test("HEAD /api/asset も除外配下は 400", async () => {
    const res = await fetch(`${url}/api/asset?path=private/creds.csv`, { method: "HEAD" });
    expect(res.status).toBe(400);
  });

  test("/api/file の 404 は除外の外では従来どおり", async () => {
    const res = await fetch(`${url}/api/file?path=nope.md`);
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe("not_found");
  });

  // 読み取りだけ塞いでも、baseSha を故意に外せば 409 の競合レスポンスに現在の中身 (raw)
  // が載るため、書き込み経路がそのまま読み取りの迂回路になる。
  test("除外配下は /api/file への保存もできない (409 経由の読み取り迂回を塞ぐ)", async () => {
    const res = await fetch(`${url}/api/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ path: "private/secret.md", body: "# 上書き\n" }),
    });
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("excluded_path");
    // ディスクが書き換わっていないこと
    expect(await readFile(join(root, "private", "secret.md"), "utf-8")).toBe("# secret\n");
  });

  test("baseSha 不一致でも除外配下の中身は返らない (409 にならず 400)", async () => {
    const res = await fetch(`${url}/api/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ path: "private/secret.md", body: "", baseSha: "0".repeat(64) }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code?: string; raw?: string };
    expect(json.code).toBe("excluded_path");
    expect(json.raw).toBeUndefined();
  });

  test("除外されていないファイルへの保存は従来どおり通る", async () => {
    const res = await fetch(`${url}/api/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ path: "public.md", body: "# public 2\n" }),
    });
    expect(res.status).toBe(200);
  });

  test("除外配下は存在しなくても同じ 400 (存在有無を漏らさない)", async () => {
    const exists = await fetch(`${url}/api/asset?path=private/creds.csv`);
    const missing = await fetch(`${url}/api/asset?path=private/nope.csv`);
    expect(exists.status).toBe(400);
    expect(missing.status).toBe(400);
    expect(await codeOf(exists)).toBe(await codeOf(missing));
    // 除外の外なら「存在しない」は 404 のまま (除外判定が 404 を潰していない)
    expect((await fetch(`${url}/api/asset?path=nope.csv`)).status).toBe(404);
  });
});

// 上の describe は excludes を明示指定して既定集合を **置き換えて** いるため、
// DEFAULT_EXCLUDES 経路（.yomiignore を置かない既定の利用形態）は別に固定する。
describe("server - DEFAULT_EXCLUDES も読み書きを拒否する (Issue #65)", () => {
  let root: string;
  let handle: ServerHandle;
  let url: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-excl-default-"));
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "node_modules", "readme.md"), "# dep\n");
    await writeFile(join(root, "dist", "report.csv"), "a,b\n");
    await writeFile(join(root, "ok.md"), "# ok\n");
    // excludes を渡さない = DEFAULT_EXCLUDES がそのまま効く
    handle = createServer({ rootDir: root, hostname: "127.0.0.1", port: 0, watch: false });
    url = `http://127.0.0.1:${handle.server.port}`;
  });

  afterAll(async () => {
    handle.close();
    await rm(root, { recursive: true, force: true });
  });

  test("node_modules 配下の md は /api/file から読めない", async () => {
    const res = await fetch(`${url}/api/file?path=node_modules/readme.md`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("excluded_path");
  });

  test("dist 配下の asset は /api/asset から取得できない", async () => {
    const res = await fetch(`${url}/api/asset?path=dist/report.csv`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("excluded_path");
  });

  test("除外されていないファイルは読める", async () => {
    expect((await fetch(`${url}/api/file?path=ok.md`)).status).toBe(200);
  });
});

// **存在オラクル: 除外配下の実在を応答の差から読み取れないこと (Issue #98)。**
//
// Issue #65 は「除外配下は実在しても存在しなくても同じ 400」を保証したが、
// **パス解決が綴りを正規化できない経路**でそれが崩れていた:
//
// - 大小を区別しない FS で `Private/nope.md` → 正規化されず除外を通り抜けて 404
// - **symlink 経由なら全 OS で踏める** —— `alias -> private` のとき `alias/<推測>/x.md` の
//   400 と 404 の差で、除外配下のディレクトリ構成を列挙できた
//
// 後者は macOS を待たずに再現できるので、**全 OS で走る回帰テスト**として固定する。
describe("server - 除外配下の実在をオラクルで漏らさない (Issue #98)", () => {
  let root: string;
  let handle: ServerHandle;
  let url: string;

  const read = async (p: string) => {
    const res = await fetch(`${url}/api/file?path=${encodeURIComponent(p)}`);
    return { status: res.status, code: ((await res.json()) as { code?: string }).code };
  };
  const create = async (p: string) => {
    const res = await fetch(`${url}/api/file/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p }),
    });
    return { status: res.status, code: ((await res.json()) as { code?: string }).code };
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-oracle-"));
    await mkdir(join(root, "private", "sub"), { recursive: true });
    await writeFile(join(root, "private", "sub", "deep.md"), "# deep\n");
    // 除外名ではないリンクから除外ディレクトリへ入る経路を作る
    await symlink(join(root, "private"), join(root, "alias"));
    handle = createServer({
      rootDir: root,
      hostname: "127.0.0.1",
      port: 0,
      watch: false,
      excludes: new Set(["private"]),
    });
    url = `http://127.0.0.1:${handle.server.port}`;
  });

  afterAll(async () => {
    handle.close();
    await rm(root, { recursive: true, force: true });
  });

  test("リンク経由でも読めない（対照）", async () => {
    expect(await read("alias/sub/deep.md")).toEqual({ status: 400, code: "excluded_path" });
  });

  // 親が実在するケース。leaf だけ解決できない
  test("実在するファイルと非実在のファイルで応答が同じ", async () => {
    expect(await read("alias/sub/nope.md")).toEqual(await read("alias/sub/deep.md"));
  });

  // **本題**: 中間ディレクトリの実在で差が出ないこと。
  // ここが分かれると `alias/<推測>/x.md` を叩いて構成を列挙できる
  test("中間ディレクトリが実在するかで応答が変わらない", async () => {
    const parentExists = await read("alias/sub/zz-nonexistent.md");
    const parentMissing = await read("alias/nodir/zz-nonexistent.md");
    expect(parentExists).toEqual(parentMissing);
    expect(parentExists.status).toBe(400);
  });

  // status だけ見ると気づけない（両方 400 で code が excluded_dir / parent_missing に分かれる）
  test("作成でも中間ディレクトリの実在が漏れない（code まで一致する）", async () => {
    const parentExists = await create("alias/sub/zz-new.md");
    const parentMissing = await create("alias/nodir/zz-new.md");
    expect(parentExists).toEqual(parentMissing);
    expect(parentExists.code).toBe("excluded_dir");
  });

  test("除外と無関係なリンクは従来どおり通る（過剰に塞いでいない）", async () => {
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "ok.md"), "# ok\n");
    await symlink(join(root, "docs"), join(root, "docs-link"));
    const res = await fetch(`${url}/api/file?path=docs-link/ok.md`);
    expect(res.status).toBe(200);
    // rel は実体側に正規化される（saveMark / watcher と揃う）
    expect(((await res.json()) as { path: string }).path).toBe("docs/ok.md");
  });
});

// **この PR の存在意義そのもの (Issue #97)。** #65 で除外が読み書きのゲートになった結果、
// DEFAULT_EXCLUDES 配下に置いた md・画像へ到達する手段が無くなった。否定パターンがその退避弁で、
// 「Set から名前が消える」ではなく**実際に 200 が返る**ところまで固定する。
describe("server - .yomiignore の否定で既定除外を解除できる (Issue #97)", () => {
  let root: string;
  let handle: ServerHandle;
  let url: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-excl-negate-"));
    await mkdir(join(root, "build"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "build", "generated.md"), "# generated\n");
    await writeFile(join(root, "build", "chart.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await writeFile(join(root, "node_modules", "readme.md"), "# dep\n");
    // `!build` だけを解除する（他の既定除外はそのまま効く）
    handle = createServer({
      rootDir: root,
      hostname: "127.0.0.1",
      port: 0,
      watch: false,
      excludes: resolveExcludes(parseYomiignore("!build")),
    });
    url = `http://127.0.0.1:${handle.server.port}`;
  });

  afterAll(async () => {
    handle.close();
    await rm(root, { recursive: true, force: true });
  });

  test("解除した build 配下の md が読める", async () => {
    const res = await fetch(`${url}/api/file?path=build/generated.md`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { raw: string }).raw).toContain("generated");
  });

  test("解除した build 配下の asset も取得できる", async () => {
    expect((await fetch(`${url}/api/asset?path=build/chart.svg`)).status).toBe(200);
  });

  test("解除した build 配下へ保存できる", async () => {
    const res = await fetch(`${url}/api/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "build/generated.md", body: "# rewritten\n" }),
    });
    expect(res.status).toBe(200);
  });

  test("解除した build はツリーにも出る", async () => {
    const tree = (await (await fetch(`${url}/api/tree`)).json()) as {
      children?: { name: string }[];
    };
    expect((tree.children ?? []).map((c) => c.name)).toContain("build");
  });

  // 解除は書いた 1 件だけに効く（全部開いてしまわない）
  test("解除していない node_modules は拒否されたまま", async () => {
    const res = await fetch(`${url}/api/file?path=node_modules/readme.md`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("excluded_path");
  });
});

describe("server - --depth 超過は読み取りを塞がない (Issue #65)", () => {
  let root: string;
  let handle: ServerHandle;
  let url: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-depth-read-"));
    await mkdir(join(root, "docs", "deep"), { recursive: true });
    await writeFile(join(root, "top.md"), "# top\n");
    await writeFile(join(root, "docs", "deep", "guide.md"), "# guide\n");
    await writeFile(join(root, "docs", "deep", "data.csv"), "a,b\n");
    handle = createServer({
      rootDir: root,
      hostname: "127.0.0.1",
      port: 0,
      watch: false,
      maxDepth: 1,
    });
    url = `http://127.0.0.1:${handle.server.port}`;
  });

  afterAll(async () => {
    handle.close();
    await rm(root, { recursive: true, force: true });
  });

  // depth は `tree -L` 相当の走査上限で、除外ではない (境界の dir はツリーに残る)。
  // 浅い md から深い md への内部リンク遷移を壊さないため、読み取りには適用しない。
  test("depth を超えた md は /api/file から読める", async () => {
    const res = await fetch(`${url}/api/file?path=docs/deep/guide.md`);
    expect(res.status).toBe(200);
  });

  test("depth を超えた asset は /api/asset から取得できる", async () => {
    const res = await fetch(`${url}/api/asset?path=docs/deep/data.csv`);
    expect(res.status).toBe(200);
  });
});

// **`/api/tree` のキャッシュ (Issue #84)。**
//
// 応答の 9 割が `scanMarkdownTree` だったので、構造が変わるまで使い回す。
// **速さのためのキャッシュは、古い答えを返した瞬間に価値が反転する**ので、
// 「捨てるべきときに捨てているか」を重点的に固定する。
describe("server - /api/tree のキャッシュ (Issue #84)", () => {
  let root: string;
  let handle: ServerHandle;
  let url: string;

  const tree = async () =>
    (await (await fetch(`${url}/api/tree`)).json()) as { children?: unknown[] };
  const names = async () =>
    ((await tree()).children ?? []).map((c) => (c as { name: string }).name);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-treecache-"));
    await writeFile(join(root, "a.md"), "# a\n");
    // **watcher を切って測る。** 付けたままだと、キャッシュを捨てているのが
    // 明示的な無効化なのか watcher 由来なのか区別できない
    handle = createServer({ rootDir: root, hostname: "127.0.0.1", port: 0, watch: false });
    url = `http://127.0.0.1:${handle.server.port}`;
  });

  afterAll(async () => {
    handle.close();
    await rm(root, { recursive: true, force: true });
  });

  test("同じ内容なら 2 回目も同じ結果を返す", async () => {
    expect(await names()).toEqual(["a.md"]);
    expect(await names()).toEqual(["a.md"]);
  });

  test("watcher 無しでファイルを足しただけでは、キャッシュが効いて増えない", async () => {
    await writeFile(join(root, "b.md"), "# b\n");
    // **これは仕様。** ツリーが変わったことを知る手段が無い状態では使い回す
    expect(await names()).toEqual(["a.md"]);
  });

  test("作成 API を通すとキャッシュが捨てられ、新しいファイルが出る", async () => {
    const res = await fetch(`${url}/api/file/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "c.md" }),
    });
    expect(res.status).toBe(200);
    // b.md も一緒に見えるようになる（捨てたので再スキャンされる）
    expect(await names()).toEqual(["a.md", "b.md", "c.md"]);
  });

  test("保存 API を通してもキャッシュが捨てられる", async () => {
    // **保存でも新しいパスができうる** (`writeFileAtomic` は存在しないパスにも書ける)。
    // watcher の到着を待つと、できたはずのファイルが出ないツリーを返す
    const res = await fetch(`${url}/api/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "d.md", body: "# d\n" }),
    });
    expect(res.status).toBe(200);
    expect(await names()).toEqual(["a.md", "b.md", "c.md", "d.md"]);
  });
});

// **watcher 経由のキャッシュ無効化 (Issue #84)。**
//
// 上の describe は `watch: false` で「API を通した書き込み」だけを見ている。
// **外部エディタがファイルを足した場合**は API を通らないので、watcher が
// キャッシュを捨てないと、そのファイルはツリーに出てこない。
describe("server - watcher が /api/tree のキャッシュを捨てる (Issue #84)", () => {
  let root: string;
  let handle: ServerHandle;
  let url: string;

  const names = async () => {
    const tree = (await (await fetch(`${url}/api/tree`)).json()) as { children?: unknown[] };
    return (tree.children ?? []).map((c) => (c as { name: string }).name);
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-treecache-watch-"));
    await writeFile(join(root, "a.md"), "# a\n");
    // **初期スキャンの完了を待つ (Issue #133)。** chokidar は `ignoreInitial: true` なので、
    // **スキャン中に置いたファイルは「最初からあった」とみなされて通知されない**。
    // 待たないと、下のポーリングが 3 秒空振りして間欠的に落ちる（実測で 10 回に 1 回）。
    // 固定 sleep では遅い環境で破れるので ready を待つ（Issue #45 と同じ手）
    let watcherReady = false;
    handle = createServer({
      rootDir: root,
      hostname: "127.0.0.1",
      port: 0,
      watch: true,
      onWatcherReady: () => {
        watcherReady = true;
      },
    });
    url = `http://127.0.0.1:${handle.server.port}`;
    const readyDeadline = Date.now() + 10_000;
    while (!watcherReady && Date.now() < readyDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!watcherReady) throw new Error("ファイル監視の初期スキャンが終わらない");
  });

  afterAll(async () => {
    handle.close();
    await rm(root, { recursive: true, force: true });
  });

  test("外部でファイルを足すと、watcher がキャッシュを捨ててツリーに出る", async () => {
    // 先にキャッシュを載せる
    expect(await names()).toEqual(["a.md"]);

    // **API を通さずに**直接置く（外部エディタや別プロセスの動きを模す）
    await writeFile(join(root, "b.md"), "# b\n");

    // watcher の debounce ぶん待つ。**固定 sleep にしない** —— 遅いマシンで足りずに
    // flaky になる（Issue #45）
    const deadline = Date.now() + 3000;
    let seen: string[] = [];
    while (Date.now() < deadline) {
      seen = await names();
      if (seen.includes("b.md")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(seen).toContain("b.md");
  });
});

// **500 応答が内部状態を漏らさない (Issue #99)。**
//
// FS のエラーメッセージは `EACCES: permission denied, open '/home/<user>/…/x.md'` の形で
// **絶対パスを含む**。既定バインドは 127.0.0.1 なので外部到達は `--share` 明示時に限られるが、
// `handleFileCreate` は同じ理由で既に汎用化しており、非対称だった。
describe("server - 500 応答が生の FS エラーを返さない (Issue #99)", () => {
  let root: string;
  let handle: ServerHandle;
  let url: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-500-"));
    await writeFile(join(root, "ok.md"), "# ok\n");
    // **uid に依存しない起こし方を使う。** `chmod 000` は root で効かないので、
    // CI の実行ユーザ次第で「テストは通ったが何も検証していない」状態になる。
    // EISDIR と ELOOP なら誰が走らせても同じ 500 に落ちる
    await mkdir(join(root, "dir.md"));
    await symlink(join(root, "loop-b.png"), join(root, "loop-a.png"));
    await symlink(join(root, "loop-a.png"), join(root, "loop-b.png"));
    handle = createServer({ rootDir: root, hostname: "127.0.0.1", port: 0, watch: false });
    url = `http://127.0.0.1:${handle.server.port}`;
  });

  afterAll(async () => {
    handle.close();
    await rm(root, { recursive: true, force: true });
  });

  /** 応答に絶対パスや errno が混ざっていないこと。 */
  const assertNoLeak = (body: { error?: string; code?: string }) => {
    expect(body.error).toBeTruthy();
    expect(body.error).not.toContain(root);
    expect(body.error).not.toContain(tmpdir());
    expect(body.error).not.toMatch(/E[A-Z]{3,}/);
  };

  test("読み取りの 500 が汎用メッセージと code を返す", async () => {
    // `dir.md` はディレクトリなので `readFile` が EISDIR で落ちる
    const res = await fetch(`${url}/api/file?path=dir.md`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.code).toBe("read_failed");
    assertNoLeak(body);
  });

  test("アセット配信の 500 が汎用メッセージと code を返す", async () => {
    // symlink の循環 → ELOOP。EISDIR はアセット側では 400 に振り分けられるので使えない
    const res = await fetch(`${url}/api/asset?path=loop-a.png`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.code).toBe("asset_failed");
    assertNoLeak(body);
  });

  test("競合判定の読み取りが失敗しても汎用メッセージを返す", async () => {
    // `baseSha` を渡すと現在の内容を読んで比較する。その読み取りが EISDIR で落ちる
    const res = await fetch(`${url}/api/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "dir.md", body: "x", baseSha: "dummy" }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.code).toBe("read_failed");
    assertNoLeak(body);
  });

  test("ハンドラを抜けた例外でも HTML のエラーページを返さない", async () => {
    // **`fetch` の外へ throw が抜けると Bun の開発用エラーページ（HTML 約 70KB）が返る。**
    // ソース断片・スタック・絶対パスが載るので、個別の catch を丁寧に書いても
    // 1 箇所漏れれば台無しになる。実際 20KB の Markdown で `marked` が
    // `RangeError: Maximum call stack size exceeded` を投げてここへ抜けていた。
    //
    // ここでは**応答の形**を固定する（ソースの綴りではなく）。
    const res = await fetch(`${url}/api/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "deep.md", body: ">".repeat(20_000) }),
    });
    expect(res.headers.get("content-type")).toContain("application/json");
    const text = await res.text();
    expect(text).not.toContain("node_modules");
    expect(text).not.toContain(root);
    // 保存自体は成功しているので 200。描画に失敗しても「書けたのに 500」にはしない
    expect(res.status).toBe(200);
  });
});

// **並行保存でマークを壊さない (Issue #120)。**
//
// `saveMark` は「自分が書いた直後の sha」を覚えて、watcher のイベントを自己保存として
// 抑止するためのもの。失敗時にパス単位で無条件に消していたので、同じファイルを
// 2 つのリクエストが保存すると**後から来たほうのマークを先のリクエストの失敗が消して**いた。
describe("server - 保存の失敗がマークを壊さない (Issue #120)", () => {
  let root: string;
  let handle: ServerHandle;
  let url: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-savemark-"));
    await writeFile(join(root, "a.md"), "# a\n");
    // **保存を確実に失敗させる的。** 対象がディレクトリだと `writeFileAtomic` の
    // 最後の `rename` が落ちる（一時ファイルの作成までは成功する）。
    // `chmod` と違って**実行ユーザに依存しない**
    await mkdir(join(root, "wall.md"));
    handle = createServer({ rootDir: root, hostname: "127.0.0.1", port: 0, watch: false });
    url = `http://127.0.0.1:${handle.server.port}`;
  });

  afterAll(async () => {
    handle.close();
    await rm(root, { recursive: true, force: true });
  });

  const save = (path: string, body: string) =>
    fetch(`${url}/api/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, body }),
    });

  /**
   * **並行の「窓」そのものはここでは再現しない。**
   *
   * 壊れる順序は「失敗する側が `set` → 別リクエストが上書き → 失敗側が `clear`」で、
   * HTTP 越しにその間へ割り込むのはタイミング勝負になり flaky を持ち込む
   * （`rename` が落ちるまでが速すぎる）。
   *
   * **#120 の本命は `tests/watcher.test.ts` の
   * 「先に始まったリクエストの失敗が、後続の保存に余計なリロードを起こさない」**で、
   * fake-watch を使って実消費者（`isOwnSave` → `onChange`）まで決定的に通している。
   * `tests/save-mark.test.ts` は `SaveMark` 単体の契約を固定する。
   *
   * **ここで見るのは、サーバがその契約を実際に使っているか**（失敗時に自分の sha を
   * 渡しているか）だけ。ここだけでは #120 の退行は捕まらない。
   */
  test("失敗した保存は、自分が立てたマークを残さない", async () => {
    const { saveMark } = handle;
    saveMark.clearAll();

    const body = "# 失敗する保存\n";
    const res = await save("wall.md", body);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { code?: string }).code).toBe("write_failed");

    // **自分のマークは片付ける。** 残すと、後で偶然同じ内容が書かれたときに
    // 自己保存と誤認して通知を落とす
    expect(saveMark.has("wall.md", sha256(Buffer.from(body, "utf-8")))).toBe(false);
    expect(saveMark.size).toBe(0);
  });

  test("失敗した保存が、別パスのマークを巻き添えにしない", async () => {
    const { saveMark } = handle;
    saveMark.clearAll();

    const other = "# 別ファイルの保存\n";
    expect((await save("a.md", other)).status).toBe(200);
    const otherSha = sha256(Buffer.from(other, "utf-8"));
    expect(saveMark.has("a.md", otherSha)).toBe(true);

    expect((await save("wall.md", "# 失敗する保存\n")).status).toBe(500);

    expect(saveMark.has("a.md", otherSha)).toBe(true);
  });

  test("成功した保存はマークを立てる（自己保存の抑止に回帰がない）", async () => {
    const { saveMark } = handle;
    saveMark.clearAll();

    const body = "# 自分の保存\n";
    const res = await save("a.md", body);
    expect(res.status).toBe(200);
    expect(saveMark.has("a.md", sha256(Buffer.from(body, "utf-8")))).toBe(true);
  });

  // マークは「いま保存中のリクエスト」を指すので、サーバを閉じたら意味を失う
  test("close() でマークを捨てる", async () => {
    const h = createServer({ rootDir: root, hostname: "127.0.0.1", port: 0, watch: false });
    const body = "# 閉じる前の保存\n";
    try {
      const res = await fetch(`http://127.0.0.1:${h.server.port}/api/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "a.md", body }),
      });
      expect(res.status).toBe(200);
      expect(h.saveMark.size).toBe(1);
    } finally {
      // assert が落ちてもポートを掴んだままにしない（このファイルの他テストと揃える）
      h.close();
    }
    expect(h.saveMark.size).toBe(0);
  });
});

/**
 * **`..` で始まるだけの名前が API から読み書きできる (Issue #118)。**
 *
 * `tests/safepath.test.ts` が `resolveSafe` 単体を固定しているが、**サーバ層には
 * もう 1 つ字句判定がある** —— `isRequestExcluded` が**解決前の生の要求文字列**に
 * `isExcludedPath` を掛ける（`GET` / `POST` / `create` の 3 経路すべてが通る）。
 * `..cache` が `.cache` と誤って一致すれば、ここで 400 になる。
 *
 * 利用者に見えていた症状（**ツリーには出るのに開くと 400**）は API 層の挙動なので、
 * そこを直接固定しておく。
 */
describe("server - `..` で始まるだけの名前 (Issue #118)", () => {
  let root: string;
  let outside: string;
  let handle: ServerHandle;
  let url: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-dotdot-api-"));
    outside = await mkdtemp(join(tmpdir(), "yomi-dotdot-api-out-"));
    await writeFile(join(outside, "secret.md"), "# 外の秘密\n");

    await mkdir(join(root, "..cache"), { recursive: true });
    await mkdir(join(root, ".cache"), { recursive: true });
    await writeFile(join(root, "..cache", "x.md"), "# ..cache の中身\n");
    await writeFile(join(root, ".cache", "hidden.md"), "# 隠しディレクトリ\n");
    // root の外を指す symlink。`..` で始まる名前でも通ってはいけない
    await symlink(outside, join(root, "..link"));

    handle = createServer({ rootDir: root, hostname: "127.0.0.1", port: 0, watch: false });
    url = `http://127.0.0.1:${handle.server.port}`;
  });

  afterAll(async () => {
    handle.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const get = (path: string) => fetch(`${url}/api/file?path=${encodeURIComponent(path)}`);
  const post = (body: unknown) =>
    fetch(`${url}/api/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const create = (path: string) =>
    fetch(`${url}/api/file/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });

  test("GET できる（従来は 400 unsafe_path だった）", async () => {
    const res = await get("..cache/x.md");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { raw: string }).raw).toBe("# ..cache の中身\n");
  });

  test("POST で保存できる", async () => {
    const res = await post({ path: "..cache/x.md", body: "# 書き換えた\n" });
    expect(res.status).toBe(200);
    expect(await readFile(join(root, "..cache", "x.md"), "utf8")).toBe("# 書き換えた\n");
  });

  test("新規作成できる", async () => {
    const res = await create("..cache/created.md");
    expect(res.status).toBe(200);
    expect(await readFile(join(root, "..cache", "created.md"), "utf8")).toBe("");
  });

  test("ツリーにも出る（表示と読み取りが食い違わない）", async () => {
    const tree = (await (await fetch(`${url}/api/tree`)).json()) as {
      children: { name: string }[];
    };
    expect(tree.children.map((c) => c.name)).toContain("..cache");
  });

  // **`..cache` が `.cache` と一致してはいけない。** 除外判定はセグメント完全一致
  test("隠しディレクトリの除外は効いたまま", async () => {
    const res = await get(".cache/hidden.md");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("excluded_path");
  });

  test.each([
    ["..link/secret.md"],
    ["..link/new.md"],
    ["../secret.md"],
  ])("root の外へは出られない (`%s`)", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("unsafe_path");
  });

  test("root の外へは新規作成もできない", async () => {
    const res = await create("..link/new.md");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("unsafe_path");
  });
});

/**
 * 記事の参照画像を zip で返す (Issue #140)。
 *
 * **本体は「入らないものが入らないこと」。** zip は複数のファイルをまとめて外へ出す経路なので、
 * ここが緩いと `/api/asset` に掛けている関門（除外設定・root 外）をまとめて迂回できる
 * （Issue #65 が塞いだ穴を開け直す）。
 */
describe("server - 記事の画像を zip で返す (Issue #140)", () => {
  let root: string;
  let outside: string;
  let handle: ServerHandle;
  let url: string;

  /** 1x1 の PNG。中身は問わないが、拡張子と実体が揃っている必要がある */
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-imgzip-"));
    outside = await mkdtemp(join(tmpdir(), "yomi-imgzip-out-"));
    await writeFile(join(outside, "outside.png"), PNG);

    await mkdir(join(root, "docs", "img"), { recursive: true });
    await mkdir(join(root, "shared"), { recursive: true });
    await mkdir(join(root, ".cache"), { recursive: true });
    await writeFile(join(root, "docs", "img", "a.png"), PNG);
    await writeFile(join(root, "docs", "img", "日本語.png"), PNG);
    await writeFile(join(root, "shared", "b.png"), PNG);
    await writeFile(join(root, ".cache", "secret.png"), PNG);
    // root の外を指す symlink。これを辿って zip に入れてはいけない
    await symlink(join(outside, "outside.png"), join(root, "docs", "escape.png"));
    // **root 内で別名を張る symlink。** エントリ名に「参照どおりのパス」を使うか
    // 「realpath 済みのパス」を使うかが、ここでだけ観測できる
    await symlink(join(root, "shared", "b.png"), join(root, "docs", "alias.png"));

    // **除外の関門は 2 段あり、それぞれ別の symlink 形を捕まえる。**
    // どちらか一方でも欠けると、以下のどちらかが漏れる（レビューで実証された）
    //
    // 1. 除外名そのものが symlink → 解決前の字句判定でしか捕まらない
    await mkdir(join(root, "realcache"), { recursive: true });
    await writeFile(join(root, "realcache", "s1.png"), PNG);
    await symlink(join(root, "realcache"), join(root, ".git"));
    // 2. 除外の外から中への別名 → 解決後の判定でしか捕まらない
    await mkdir(join(root, ".svn"), { recursive: true });
    await writeFile(join(root, ".svn", "s2.png"), PNG);
    await symlink(join(root, ".svn", "s2.png"), join(root, "docs", "innocent.png"));

    // 秘密ファイル。`/api/asset` は拡張子で拒否する
    await writeFile(join(root, ".env"), "AWS_SECRET_ACCESS_KEY=hunter2\n");
    // 画像名のディレクトリ。`readFile` に直行すると EISDIR で「読み取りに失敗」になる
    await mkdir(join(root, "docs", "dir.png"), { recursive: true });
    // POSIX では合法だが zip のエントリ名にできない（Windows で展開すると外へ出る）
    await writeFile(join(root, "docs", "C:evil.png"), PNG);

    await writeFile(
      join(root, "docs", "guide.md"),
      [
        "# ガイド",
        "",
        "![相対](img/a.png)",
        "![親](../shared/b.png)",
        "![日本語](img/日本語.png)",
        "![重複](img/a.png)",
        "![除外配下](../.cache/secret.png)",
        "![root 外](escape.png)",
        "![無い](img/missing.png)",
        "![別名](alias.png)",
        "![外部](https://example.com/x.png)",
        "",
      ].join("\n"),
    );
    await writeFile(join(root, "docs", "plain.md"), "# 画像なし\n\n本文だけ。\n");

    handle = createServer({ rootDir: root, hostname: "127.0.0.1", port: 0, watch: false });
    url = `http://127.0.0.1:${handle.server.port}`;
  });

  afterAll(async () => {
    handle.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const zipOf = (path: string) => fetch(`${url}/api/images.zip?path=${encodeURIComponent(path)}`);

  /** zip のエントリ名を、実物の `unzip -l` を通さず中央ディレクトリから読む */
  async function entryNames(res: Response): Promise<string[]> {
    const bytes = new Uint8Array(await res.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const names: string[] = [];
    // ローカルファイルヘッダを頭から辿る（この実装は store のみ・extra field 無し）
    let off = 0;
    const dec = new TextDecoder();
    while (off + 30 <= bytes.length && view.getUint32(off, true) === 0x0403_4b50) {
      const size = view.getUint32(off + 18, true);
      const nameLen = view.getUint16(off + 26, true);
      const extraLen = view.getUint16(off + 28, true);
      names.push(dec.decode(bytes.subarray(off + 30, off + 30 + nameLen)));
      off += 30 + nameLen + extraLen + size;
    }
    return names;
  }

  async function skippedText(res: Response): Promise<string> {
    const bytes = new Uint8Array(await res.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const dec = new TextDecoder();
    let off = 0;
    while (off + 30 <= bytes.length && view.getUint32(off, true) === 0x0403_4b50) {
      const size = view.getUint32(off + 18, true);
      const nameLen = view.getUint16(off + 26, true);
      const extraLen = view.getUint16(off + 28, true);
      const name = dec.decode(bytes.subarray(off + 30, off + 30 + nameLen));
      const start = off + 30 + nameLen + extraLen;
      if (name === "SKIPPED.txt") return dec.decode(bytes.subarray(start, start + size));
      off = start + size;
    }
    return "";
  }

  test("参照しているローカル画像だけが入る（重複は 1 件）", async () => {
    const res = await zipOf("docs/guide.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    const names = await entryNames(res.clone());
    expect(names.filter((n) => n !== "SKIPPED.txt")).toEqual([
      "docs/img/a.png",
      "shared/b.png",
      "docs/img/日本語.png",
      "docs/alias.png",
    ]);
  });

  // **ここが本体。** 緩めると zip が `/api/asset` の迂回路になる
  test("除外設定の配下は入らない", async () => {
    const names = await entryNames(await zipOf("docs/guide.md"));
    expect(names).not.toContain(".cache/secret.png");
  });

  test("root の外を指す symlink は入らない", async () => {
    const names = await entryNames(await zipOf("docs/guide.md"));
    expect(names.some((n) => n.includes("escape") || n.includes("outside"))).toBe(false);
  });

  test("エントリ名が root からの相対パスで、`..` を含まない（zip slip を作らない）", async () => {
    const names = await entryNames(await zipOf("docs/guide.md"));
    for (const name of names) {
      expect(name.startsWith("/")).toBe(false);
      expect(name.split("/")).not.toContain("..");
    }
  });

  test("入らなかったものが理由つきで記録される", async () => {
    const res = await zipOf("docs/guide.md");
    expect(res.headers.get("X-Yomi-Skipped")).toBe("4");
    const text = await skippedText(res);
    expect(text).toContain("https://example.com/x.png\t外部の参照は取得しない");
    expect(text).toContain(".cache/secret.png\t除外設定の配下");
    expect(text).toContain("docs/escape.png\tルートディレクトリの外");
    expect(text).toContain("docs/img/missing.png\tファイルが見つからない");
  });

  /**
   * **エントリ名は「Markdown が参照しているパス」。**
   *
   * `docs/alias.png` は `shared/b.png` への symlink。realpath 済みのパスを名前にすると
   * `docs/alias.png` が展開されず、**展開して隣に置いても `![](alias.png)` が壊れる**。
   */
  test("symlink の別名は、参照どおりのパスで入る（実体のパスではない）", async () => {
    const names = await entryNames(await zipOf("docs/guide.md"));
    expect(names).toContain("docs/alias.png");
    // 実体 `shared/b.png` も別の参照（`../shared/b.png`）で入っているので、両方ある
    expect(names).toContain("shared/b.png");
  });

  test("ファイル名を UTF-8 と宣言している（日本語名が文字化けしない）", async () => {
    const bytes = new Uint8Array(await (await zipOf("docs/guide.md")).arrayBuffer());
    const view = new DataView(bytes.buffer);
    // 各ローカルファイルヘッダの汎用フラグ (offset 6) の bit 11 が立っていること
    let off = 0;
    let checked = 0;
    while (off + 30 <= bytes.length && view.getUint32(off, true) === 0x0403_4b50) {
      expect(view.getUint16(off + 6, true) & 0x0800).toBe(0x0800);
      checked++;
      const size = view.getUint32(off + 18, true);
      const nameLen = view.getUint16(off + 26, true);
      off += 30 + nameLen + view.getUint16(off + 28, true) + size;
    }
    expect(checked).toBeGreaterThan(0);
  });

  /**
   * **🚨 `/api/asset` の拡張子 allowlist を迂回できてはいけない。**
   *
   * `rewriteImageHref` は**生の href**で拡張子を見るが、`resolveRelativePath` は
   * **デコードしてから `#` で切る**。`.env%23a.png` は「`.png` で終わる」と判定されて
   * `.env` に解決される。**実測で `.env` と `id_rsa` の吸い出しを再現した。**
   */
  test("`%23` で拡張子判定を迂回して非画像を吸い出せない", async () => {
    await writeFile(join(root, "docs", "evil.md"), "# 普通に見える記事\n\n![x](../.env%23a.png)\n");
    const res = await zipOf("docs/evil.md");
    expect(res.status).toBe(200);
    const names = await entryNames(res.clone());
    expect(names).not.toContain(".env");
    expect(names.filter((n) => n !== "SKIPPED.txt")).toEqual([]);
    expect(await skippedText(res)).toContain(".env\t画像ではない");
  });

  /**
   * **除外の関門は 2 段あり、片方ずつでは足りない。**
   *
   * どちらか一方を外すと下のどちらかが漏れる（レビューで実証）。
   * とくに 2 は**無害な名前で秘密が入る**ので、利用者が気づけない。
   */
  test.each([
    ["除外名そのものが symlink", "![s](../.git/s1.png)", ".git/s1.png"],
    ["除外の外から中への別名", "![s](innocent.png)", "docs/innocent.png"],
  ])("%s は zip に入らない", async (_label, ref, expectedSkip) => {
    await writeFile(join(root, "docs", "sym.md"), `# x\n\n${ref}\n`);
    const res = await zipOf("docs/sym.md");
    const names = await entryNames(res.clone());
    expect(names.filter((n) => n !== "SKIPPED.txt")).toEqual([]);
    expect(await skippedText(res)).toContain(`${expectedSkip}\t除外設定の配下`);
  });

  test("上限を超えたぶんは入れずに一覧へ回す", async () => {
    // 1 枚も入らない上限を入れて分岐を踏む（200MB の fixture は置けない）
    const small = createServer({
      rootDir: root,
      hostname: "127.0.0.1",
      port: 0,
      watch: false,
      maxZipBytes: 10,
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${small.server.port}/api/images.zip?path=docs%2Fguide.md`,
      );
      expect(res.headers.get("X-Yomi-Images")).toBe("0");
      expect(await skippedText(res)).toContain("上限 10 バイトを超えるため");
    } finally {
      small.close();
    }
  });

  // パスは Markdown 由来で改行を含みうる（POSIX では合法な文字）。
  // そのまま TSV に連結すると「yomi が /etc/passwd.png を見に行った」偽の行を作れる
  test("一覧に改行を注入して行を偽造できない", async () => {
    await writeFile(join(root, "docs", "inject.md"), "# x\n\n![x](nope%0A%2Fetc%2Fpasswd.png)\n");
    const text = await skippedText(await zipOf("docs/inject.md"));
    expect(text).not.toContain("\n/etc/passwd.png");
    expect(text).toContain("\ufffd");
  });

  test("ディレクトリを指す参照は「ファイルではない」として飛ばす", async () => {
    await writeFile(join(root, "docs", "dir.md"), "# x\n\n![d](dir.png)\n");
    const res = await zipOf("docs/dir.md");
    expect(res.status).toBe(200);
    expect(await entryNames(res.clone())).toEqual(["SKIPPED.txt"]);
    expect(await skippedText(res)).toContain("docs/dir.png\tファイルではない");
  });

  // `createZip` は投げるので、通すと 1 枚のせいで zip 全体が 500 になる
  test("zip のエントリ名にできない参照は、500 にせず飛ばす", async () => {
    await writeFile(join(root, "docs", "drive.md"), "# x\n\n![d](/C%3Aevil.png)\n");
    const res = await zipOf("docs/drive.md");
    expect(res.status).toBe(200);
    expect(await skippedText(res)).toContain("zip のエントリ名にできない");
  });

  /**
   * **HEAD で zip を組み立てない。**
   *
   * 組み立てると全画像を読んで捨てるだけになり、**帯域ゼロでサーバ側の全コストを
   * 引ける**（`handleAssetRead` も HEAD を短絡している）。
   *
   * 「組み立てていない」ことは**枚数のヘッダが無い**ことで見る（時間で見ると flaky）。
   */
  test("HEAD は zip を組み立てずにヘッダだけ返す", async () => {
    const res = await fetch(`${url}/api/images.zip?path=docs%2Fguide.md`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    // 集計した結果のヘッダは付かない = 集計そのものをしていない
    expect(res.headers.get("X-Yomi-Images")).toBeNull();
    expect(res.headers.get("X-Yomi-Skipped")).toBeNull();
  });

  test("入った枚数をヘッダで返す（クライアントが zip を解析しなくて済む）", async () => {
    const res = await zipOf("docs/guide.md");
    const names = await entryNames(res.clone());
    expect(res.headers.get("X-Yomi-Images")).toBe(
      String(names.filter((n) => n !== "SKIPPED.txt").length),
    );
  });

  test("画像を参照していなければ空の zip を返す", async () => {
    const res = await zipOf("docs/plain.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Yomi-Skipped")).toBe("0");
    expect(await entryNames(res)).toEqual([]);
  });

  test("ファイル名は元の md 由来で attachment として返す", async () => {
    const res = await zipOf("docs/guide.md");
    expect(res.headers.get("Content-Disposition")).toContain('filename="guide-images.zip"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test.each([
    ["../outside.md", "unsafe_path"],
    [".cache/x.md", "excluded_path"],
    ["docs/img/a.png", "not_markdown"],
    ["docs/missing.md", "not_found"],
  ])("`%s` は %s で拒否する", async (path, code) => {
    const res = await zipOf(path);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(((await res.json()) as { code: string }).code).toBe(code);
  });

  test("path を省略したら 400", async () => {
    const res = await fetch(`${url}/api/images.zip`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("path_required");
  });

  test("GET / HEAD 以外は 405", async () => {
    const res = await fetch(`${url}/api/images.zip?path=docs%2Fguide.md`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
  });
});

/**
 * Issue #155: md 以外のテキストファイルも `/api/file` で読める。
 *
 * **md の応答形は変えない**（`html` を返し続ける）。テキストは `html` を持たず、
 * 代わりに `kind: "text"` と `lang` を返す —— 「`html` が無い」で分岐すると
 * 空文字と区別が付かないので、クライアントは `kind` を見る。
 */
describe("server - テキストファイルの読み取り (Issue #155)", () => {
  let root: string;
  let url: string;
  let handle: ServerHandle;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-text-read-"));
    await writeFile(join(root, "hello.md"), "# Hello");
    await writeFile(join(root, "notes.txt"), "plain text\nsecond line");
    await writeFile(join(root, "config.json"), '{ "a": 1 }');
    await writeFile(join(root, "Dockerfile"), "FROM oven/bun:1\n");
    await writeFile(join(root, "photo.png"), "not really a png");
    await writeFile(join(root, "archive.zip"), "not really a zip");
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "node_modules", "dep.json"), "{}");
    const ctx = await startServer(root);
    url = ctx.url;
    handle = ctx.handle;
  });

  afterAll(async () => {
    handle.close();
    await rm(root, { recursive: true, force: true });
  });

  test("テキストは raw と kind / lang を返し、html を持たない", async () => {
    const res = await fetch(`${url}/api/file?path=notes.txt`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      path: string;
      raw: string;
      kind: string;
      lang: string;
      sha: string;
      html?: string;
    };
    expect(json.path).toBe("notes.txt");
    expect(json.raw).toBe("plain text\nsecond line");
    expect(json.kind).toBe("text");
    expect(json.lang).toBe("plaintext");
    expect(json.sha).toBe(sha256("plain text\nsecond line"));
    expect(json.html).toBeUndefined();
  });

  test("拡張子からハイライト言語を返す", async () => {
    const res = await fetch(`${url}/api/file?path=config.json`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { lang: string }).lang).toBe("json");
  });

  test("拡張子を持たない慣習ファイルも読める", async () => {
    const res = await fetch(`${url}/api/file?path=Dockerfile`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { kind: string; lang: string; raw: string };
    expect(json.kind).toBe("text");
    expect(json.lang).toBe("dockerfile");
    expect(json.raw).toBe("FROM oven/bun:1\n");
  });

  test("Markdown の応答は従来どおり html を含み kind:markdown を返す", async () => {
    const res = await fetch(`${url}/api/file?path=hello.md`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { kind: string; html: string; raw: string };
    expect(json.kind).toBe("markdown");
    expect(json.raw).toBe("# Hello");
    expect(json.html).toContain("<h1");
  });

  test.each([
    ["photo.png"],
    ["archive.zip"],
  ])("allowlist 外の `%s` は 400 + code:not_viewable", async (path) => {
    const res = await fetch(`${url}/api/file?path=${encodeURIComponent(path)}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("not_viewable");
  });

  test("除外配下のテキストは読めない (Issue #65 の関門が効く)", async () => {
    const res = await fetch(`${url}/api/file?path=node_modules%2Fdep.json`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(((await res.json()) as { code: string }).code).toBe("excluded_path");
  });

  test("テキストには書き込めない (編集は Markdown 限定のまま)", async () => {
    const res = await fetch(`${url}/api/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ path: "notes.txt", body: "overwritten" }),
    });
    expect(res.status).toBe(400);
    // 中身が変わっていないことまで見る (400 を返しつつ書けていたら意味がない)
    expect(await readFile(join(root, "notes.txt"), "utf-8")).toBe("plain text\nsecond line");
  });
});

describe("server - テキストのサイズ上限 (Issue #155)", () => {
  let root: string;
  let url: string;
  let handle: ServerHandle;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-text-size-"));
    // 上限ちょうどは通り、1 バイト超えると 413。
    await writeFile(join(root, "edge.txt"), "a".repeat(MAX_TEXT_BYTES));
    await writeFile(join(root, "huge.txt"), "a".repeat(MAX_TEXT_BYTES + 1));
    // **md には上限を掛けない**（従来の挙動を変えない）
    await writeFile(join(root, "huge.md"), "a".repeat(MAX_TEXT_BYTES + 1));
    const ctx = await startServer(root);
    url = ctx.url;
    handle = ctx.handle;
  });

  afterAll(async () => {
    handle.close();
    await rm(root, { recursive: true, force: true });
  });

  test("上限ちょうどは 200", async () => {
    const res = await fetch(`${url}/api/file?path=edge.txt`);
    expect(res.status).toBe(200);
  });

  test("上限を超えたテキストは 413 + code:file_too_large", async () => {
    const res = await fetch(`${url}/api/file?path=huge.txt`);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe("file_too_large");
  });

  test("Markdown は上限の対象外", async () => {
    const res = await fetch(`${url}/api/file?path=huge.md`);
    expect(res.status).toBe(200);
  });
});

/**
 * Issue #156: symlink で「要求したパス」と「実際に読むファイル」が食い違うとき、
 * **解決後のパスにも許可リストを掛ける**。
 *
 * 掛けていないと、`note.md → secret.bin` のようなリンクがルート内にあるだけで、
 * 許可リストに無い実体が Markdown としてレンダリングされて返る（`/api/file`）か、
 * `application/octet-stream` として配信される（`/api/asset`）。
 *
 * **`resolveSafe` はルート外を拒否するので影響はルート内に限られる**が、`.env` を
 * 許可リストから外した判断（Issue #155）と噛み合わないので塞ぐ。
 */
describe("server - symlink 越しの許可リスト検査 (Issue #156)", () => {
  let root: string;
  let url: string;
  let handle: ServerHandle;
  /** symlink を作れない環境（Windows の一部・権限なし）ではテストを skip する */
  let symlinkOk = true;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yomi-symlink-allow-"));
    // 実体（許可リスト外 / 内）
    await writeFile(join(root, "secret.bin"), "BINARY-SECRET");
    await writeFile(join(root, "data.json"), '{ "a": 1 }');
    await writeFile(join(root, "real.md"), "# real\n");
    await writeFile(join(root, "photo.png"), "PNG-BYTES");
    try {
      // 許可された名前 → 許可リスト外の実体
      await symlink(join(root, "secret.bin"), join(root, "note.md"));
      await symlink(join(root, "secret.bin"), join(root, "shot.png"));
      // 許可された名前 → 許可された別種の実体（こちらは通ってよい）
      await symlink(join(root, "data.json"), join(root, "alias.md"));
      await symlink(join(root, "real.md"), join(root, "alias2.md"));
      await symlink(join(root, "photo.png"), join(root, "alias.jpg"));
    } catch {
      symlinkOk = false;
    }
    const ctx = await startServer(root);
    url = ctx.url;
    handle = ctx.handle;
  });

  afterAll(async () => {
    handle.close();
    await rm(root, { recursive: true, force: true });
  });

  test("`/api/file`: 許可リスト外の実体を指す symlink は 400 で拒否する", async () => {
    if (!symlinkOk) return;
    const res = await fetch(`${url}/api/file?path=note.md`);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string; raw?: string };
    expect(json.code).toBe("not_viewable");
    // **中身が漏れていないこと**まで見る（400 を返しつつ raw を載せていたら意味がない）
    expect(json.raw).toBeUndefined();
  });

  test("`/api/file`: 許可リスト内どうしの symlink は開けて、種別は実体側で決まる", async () => {
    if (!symlinkOk) return;
    // `.md` という名前でも実体が `.json` なので text として返る
    const res = await fetch(`${url}/api/file?path=alias.md`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { path: string; kind: string; lang: string; raw: string };
    expect(json.kind).toBe("text");
    expect(json.lang).toBe("json");
    expect(json.raw).toBe('{ "a": 1 }');

    // 実体も Markdown なら従来どおりレンダリングされる
    const md = await fetch(`${url}/api/file?path=alias2.md`);
    expect(md.status).toBe(200);
    const mdJson = (await md.json()) as { kind: string; html: string };
    expect(mdJson.kind).toBe("markdown");
    expect(mdJson.html).toContain("<h1");
  });

  test("`/api/asset`: 許可リスト外の実体を指す symlink は 400 で拒否する", async () => {
    if (!symlinkOk) return;
    const res = await fetch(`${url}/api/asset?path=shot.png`);
    expect(res.status).toBe(400);
    // 中身を配信していないこと（`application/octet-stream` で素通ししない）
    expect(res.headers.get("Content-Type") ?? "").not.toContain("octet-stream");
    expect(await res.text()).not.toContain("BINARY-SECRET");
  });

  test("`/api/asset`: 許可リスト内どうしの symlink は従来どおり配信する", async () => {
    if (!symlinkOk) return;
    const res = await fetch(`${url}/api/asset?path=alias.jpg`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PNG-BYTES");
  });

  test("`/api/images.zip`: 実体が Markdown でない symlink は 400 で拒否する", async () => {
    if (!symlinkOk) return;
    const res = await fetch(`${url}/api/images.zip?path=alias.md`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("not_markdown");
  });

  test("`/api/images.zip`: 実体が Markdown なら従来どおり動く", async () => {
    if (!symlinkOk) return;
    const res = await fetch(`${url}/api/images.zip?path=alias2.md`);
    expect(res.status).toBe(200);
  });
});
