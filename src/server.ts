import { scanMarkdownTree } from "./scanner.ts";

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

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(
          "<!doctype html><title>yomi</title><pre>yomi: hello world\n/api/tree で md ツリーを取得できます。</pre>",
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }

      return new Response("Not Found", { status: 404 });
    },
  });
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
