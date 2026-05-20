import type { FileHandle } from "node:fs/promises";
import { open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "./renderer.ts";
import { isMarkdownPath, resolveSafe, UnsafePathError } from "./safepath.ts";
import { SaveMark, sha256 } from "./save-mark.ts";
import { scanMarkdownTree } from "./scanner.ts";
import { DEFAULT_EXCLUDES } from "./util/excludes.ts";
import { imageContentType, isImageExtension } from "./util/image-ext.ts";
import { createWatcher, type WatcherHandle } from "./watcher.ts";

const WS_TOPIC = "yomi:file-events";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");

const ASSET_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** 書き込み API の body サイズ上限 (bytes) */
export const MAX_WRITE_BYTES = 10 * 1024 * 1024;

export interface ServerConfig {
  rootDir: string;
  hostname: string;
  port: number;
  watch?: boolean;
  /** 除外するディレクトリ/ファイル名 (省略時は DEFAULT_EXCLUDES) */
  excludes?: ReadonlySet<string>;
}

export interface ServerHandle {
  server: ReturnType<typeof Bun.serve>;
  close(): void;
}

export function createServer(config: ServerConfig): ServerHandle {
  const excludes = config.excludes ?? DEFAULT_EXCLUDES;
  const saveMark = new SaveMark();

  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    async fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("Upgrade Required", { status: 426 });
      }

      if (url.pathname === "/api/tree") {
        return handleTree(config.rootDir, excludes);
      }

      if (url.pathname === "/api/file") {
        if (req.method === "GET") {
          return handleFileRead(config.rootDir, url.searchParams.get("path"));
        }
        if (req.method === "POST") {
          if (!checkOrigin(req)) return forbidden("Origin が許可されていません");
          return handleFileWrite(config.rootDir, req, saveMark);
        }
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, POST" },
        });
      }

      if (url.pathname === "/api/asset") {
        if (req.method === "GET" || req.method === "HEAD") {
          return handleAssetRead(config.rootDir, url.searchParams.get("path"), req);
        }
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return serveAsset("index.html");
      }

      if (url.pathname.startsWith("/assets/")) {
        return serveAsset(url.pathname.slice("/assets/".length));
      }

      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.subscribe(WS_TOPIC);
        ws.send(JSON.stringify({ type: "hello" }));
      },
      close(ws) {
        ws.unsubscribe(WS_TOPIC);
      },
      message() {
        /* クライアントからのメッセージは現状不要 */
      },
    },
  });

  let watcher: WatcherHandle | null = null;
  if (config.watch !== false) {
    watcher = createWatcher(
      config.rootDir,
      (path, kind) => {
        server.publish(
          WS_TOPIC,
          JSON.stringify({ type: kind === "rename" ? "tree" : "changed", path }),
        );
      },
      { excludes, saveMark },
    );
  }

  return {
    server,
    close() {
      watcher?.close();
      server.stop();
    },
  };
}

/**
 * Origin ヘッダによる CSRF 防御。
 * - Origin がない (curl 等) → 許可 (ブラウザ CSRF の脅威モデル外)
 * - Origin がある場合は Host ヘッダの値とホスト部 (host:port) が一致すれば許可
 *
 * yomi 自身は HTTP のみ。Origin が `http://<dest-host>:<port>` で Host が `<dest-host>:<port>` のとき
 * 同一オリジンとみなす。攻撃者ページからのリクエストは Origin が外部のため Host と一致せず 403。
 */
export function checkOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("host");
  if (!host) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return originHost === host;
}

function forbidden(message: string): Response {
  return Response.json({ error: message }, { status: 403 });
}

async function serveAsset(name: string): Promise<Response> {
  if (name.includes("..") || name.startsWith("/")) {
    return new Response("Forbidden", { status: 403 });
  }
  const path = join(PUBLIC_DIR, name);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return new Response("Not Found", { status: 404 });
  }
  const ext = name.slice(name.lastIndexOf("."));
  const type = ASSET_TYPES[ext] ?? "application/octet-stream";
  return new Response(file, { headers: { "Content-Type": type } });
}

async function handleTree(rootDir: string, excludes: ReadonlySet<string>): Promise<Response> {
  try {
    const tree = await scanMarkdownTree(rootDir, { excludes });
    return Response.json(tree);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

async function handleFileRead(rootDir: string, requested: string | null): Promise<Response> {
  if (!requested) {
    return Response.json({ error: "path クエリが必要です" }, { status: 400 });
  }
  if (!isMarkdownPath(requested)) {
    return Response.json({ error: "Markdown ファイル以外は読み取れません" }, { status: 400 });
  }

  try {
    const safe = await resolveSafe(rootDir, requested);
    const buf = await readFile(safe.abs);
    const raw = buf.toString("utf-8");
    const html = await renderMarkdown(raw, { currentPath: safe.rel });
    return Response.json({ path: safe.rel, raw, html, sha: sha256(buf) });
  } catch (err) {
    if (err instanceof UnsafePathError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return Response.json({ error: `ファイルが見つかりません: ${requested}` }, { status: 404 });
    }
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

interface FileWriteBody {
  path?: unknown;
  body?: unknown;
  baseSha?: unknown;
}

async function handleFileWrite(
  rootDir: string,
  req: Request,
  saveMark: SaveMark,
): Promise<Response> {
  const lengthHeader = req.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > MAX_WRITE_BYTES) {
    return Response.json({ error: "body が大きすぎます" }, { status: 413 });
  }

  let parsed: FileWriteBody;
  try {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf-8") > MAX_WRITE_BYTES) {
      return Response.json({ error: "body が大きすぎます" }, { status: 413 });
    }
    parsed = JSON.parse(text) as FileWriteBody;
  } catch {
    return Response.json({ error: "JSON の解析に失敗しました" }, { status: 400 });
  }

  const { path, body, baseSha } = parsed;
  if (typeof path !== "string" || path.length === 0) {
    return Response.json({ error: "path が必要です" }, { status: 400 });
  }
  if (typeof body !== "string") {
    return Response.json({ error: "body は string です" }, { status: 400 });
  }
  if (baseSha !== undefined && typeof baseSha !== "string") {
    return Response.json({ error: "baseSha は string です" }, { status: 400 });
  }
  if (!isMarkdownPath(path)) {
    return Response.json({ error: "Markdown ファイル以外には書き込めません" }, { status: 400 });
  }
  if (Buffer.byteLength(body, "utf-8") > MAX_WRITE_BYTES) {
    return Response.json({ error: "body が大きすぎます" }, { status: 413 });
  }

  let safe: { rel: string; abs: string };
  try {
    safe = await resolveSafe(rootDir, path);
  } catch (err) {
    if (err instanceof UnsafePathError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  if (typeof baseSha === "string") {
    let currentSha: string | null;
    let currentRaw: string | null;
    try {
      const currentBuf = await readFile(safe.abs);
      currentSha = sha256(currentBuf);
      currentRaw = currentBuf.toString("utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        currentSha = null;
        currentRaw = null;
      } else {
        return Response.json({ error: (err as Error).message }, { status: 500 });
      }
    }
    if (currentSha !== baseSha) {
      const currentHtml =
        currentRaw === null ? "" : await renderMarkdown(currentRaw, { currentPath: safe.rel });
      return Response.json(
        {
          error: "ファイルが他で更新されています",
          path: safe.rel,
          raw: currentRaw,
          html: currentHtml,
          sha: currentSha,
        },
        { status: 409 },
      );
    }
  }

  const buf = Buffer.from(body, "utf-8");
  const newSha = sha256(buf);
  saveMark.set(safe.rel, newSha);
  try {
    await writeFile(safe.abs, buf);
  } catch (err) {
    saveMark.clear(safe.rel);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }

  const html = await renderMarkdown(body, { currentPath: safe.rel });
  return Response.json({ path: safe.rel, raw: body, html, sha: newSha });
}

/** /api/asset 配信サイズ上限 (50 MB)。DoS / 誤配信抑制のため。 */
export const MAX_ASSET_BYTES = 50 * 1024 * 1024;

async function handleAssetRead(
  rootDir: string,
  requested: string | null,
  req: Request,
): Promise<Response> {
  if (!requested) {
    return Response.json({ error: "path クエリが必要です" }, { status: 400 });
  }
  if (!isImageExtension(requested)) {
    return Response.json({ error: "画像ファイル以外は読み取れません" }, { status: 400 });
  }

  let safe: { rel: string; abs: string };
  try {
    safe = await resolveSafe(rootDir, requested);
  } catch (err) {
    if (err instanceof UnsafePathError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  // Issue #22: TOCTOU 対策 + 強 ETag (sha256 ベース)。
  // fd を先に取得して fstat → readFile を **同一 fd** から行うことで、
  // resolveSafe → stat → open の間に symlink swap されてもアクセス先は固定される。
  // また内容を読み終えた buffer から sha256 を取って ETag にするので、`cp -a` 等で
  // mtime+size を維持して書き換えても 304 stale を返さない (内容ベース判定)。
  let fh: FileHandle | null = null;
  try {
    fh = await open(safe.abs, "r");
    const st = await fh.stat();

    if (!st.isFile()) {
      return Response.json({ error: "ファイルではありません" }, { status: 400 });
    }
    if (st.size > MAX_ASSET_BYTES) {
      return Response.json({ error: "画像サイズが大きすぎます" }, { status: 413 });
    }

    const buffer = await fh.readFile();
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(buffer);
    const etag = `"${hasher.digest("hex").slice(0, 32)}"`;

    const contentType = imageContentType(safe.rel) ?? "application/octet-stream";
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      ETag: etag,
      // MIME sniff 経由の XSS を抑制 (特に SVG)
      "X-Content-Type-Options": "nosniff",
      // <img src> から参照されたときに download にならないよう inline を明示
      "Content-Disposition": "inline",
    };

    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers });
    }

    if (req.method === "HEAD") {
      headers["Content-Length"] = String(st.size);
      return new Response(null, { status: 200, headers });
    }

    headers["Content-Length"] = String(buffer.byteLength);
    return new Response(buffer, { status: 200, headers });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return Response.json({ error: `ファイルが見つかりません: ${requested}` }, { status: 404 });
    }
    if (code === "EISDIR") {
      return Response.json({ error: "ファイルではありません" }, { status: 400 });
    }
    return Response.json({ error: (err as Error).message }, { status: 500 });
  } finally {
    // fd close 失敗 (極稀な EBADF 等) は response に影響させない
    await fh?.close().catch(() => {});
  }
}
