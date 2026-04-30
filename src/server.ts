import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanMarkdownTree } from "./scanner.ts";
import { renderMarkdown } from "./renderer.ts";
import { isMarkdownPath, resolveSafe, UnsafePathError } from "./safepath.ts";

const PUBLIC_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
);

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

export interface ServerConfig {
  rootDir: string;
  hostname: string;
  port: number;
}

export function createServer(config: ServerConfig) {
  return Bun.serve({
    hostname: config.hostname,
    port: config.port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/tree") {
        return handleTree(config.rootDir);
      }

      if (url.pathname === "/api/file") {
        return handleFile(config.rootDir, url.searchParams.get("path"));
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return serveAsset("index.html");
      }

      if (url.pathname.startsWith("/assets/")) {
        return serveAsset(url.pathname.slice("/assets/".length));
      }

      return new Response("Not Found", { status: 404 });
    },
  });
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

async function handleTree(rootDir: string): Promise<Response> {
  try {
    const tree = await scanMarkdownTree(rootDir);
    return Response.json(tree);
  } catch (err) {
    return Response.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

async function handleFile(
  rootDir: string,
  requested: string | null,
): Promise<Response> {
  if (!requested) {
    return Response.json({ error: "path クエリが必要です" }, { status: 400 });
  }
  if (!isMarkdownPath(requested)) {
    return Response.json(
      { error: "Markdown ファイル以外は読み取れません" },
      { status: 400 },
    );
  }

  try {
    const safe = await resolveSafe(rootDir, requested);
    const raw = await readFile(safe.abs, "utf-8");
    const html = await renderMarkdown(raw);
    return Response.json({ path: safe.rel, raw, html });
  } catch (err) {
    if (err instanceof UnsafePathError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return Response.json(
        { error: `ファイルが見つかりません: ${requested}` },
        { status: 404 },
      );
    }
    return Response.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
