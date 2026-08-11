import type { FileHandle } from "node:fs/promises";
import { open, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "./renderer.ts";
import { isMarkdownPath, resolveSafe, UnsafePathError } from "./safepath.ts";
import { SaveMark, sha256 } from "./save-mark.ts";
import { scanMarkdownTree } from "./scanner.ts";
import { assetContentType, assetDisposition, isAssetExtension } from "./util/asset-ext.ts";
import { writeFileAtomic } from "./util/atomic-write.ts";
import { buildContentDisposition } from "./util/content-disposition.ts";
import { computeStrongEtag } from "./util/etag.ts";
import { DEFAULT_EXCLUDES, isExcludedPath } from "./util/excludes.ts";
import { IMAGE_CONTENT_TYPES } from "./util/image-ext.ts";
import { createWatcher, type WatcherHandle } from "./watcher.ts";

const WS_TOPIC = "yomi:file-events";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");

// Issue #23: 画像 MIME は IMAGE_CONTENT_TYPES (全 9 拡張子) を single source of truth として spread。
// ここでは public/ 配下の静的アセット固有 (テキスト系) のみ追加する。
const ASSET_TYPES: Record<string, string> = {
  ...IMAGE_CONTENT_TYPES,
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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
  /** 走査/監視する階層の上限 (Issue #44, tree -L 相当)。省略時は無制限。 */
  maxDepth?: number;
}

export interface ServerHandle {
  server: ReturnType<typeof Bun.serve>;
  /** 自己保存マーク。テストから作成/書き込み後のマーク状態を検証するために公開する。 */
  saveMark: SaveMark;
  close(): void;
}

export function createServer(config: ServerConfig): ServerHandle {
  const excludes = config.excludes ?? DEFAULT_EXCLUDES;

  /**
   * `/api/tree` の直列化済み応答 (Issue #84)。
   *
   * **毎回フルスキャンしていた。** 10,000 ファイルの環境では応答 34.7ms のうち
   * **30.8ms が `scanMarkdownTree`** で、`JSON.stringify` は 0.8ms しかない
   * （実測は `docs/bench/tree-diff-update.md`）。ツリーが変わるのは watcher が
   * `rename` を拾ったときだけなので、そこまでは使い回せる。
   *
   * **直列化まで含めて持つ。** オブジェクトを持って毎回 `Response.json` すると
   * `stringify` のぶんが残る。構造は変わらないので文字列で構わない。
   *
   * 常駐メモリは応答サイズぶん（10,000 ファイルで 724 KiB）。
   */
  let treeCache: string | null = null;
  const invalidateTree = () => {
    treeCache = null;
  };
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
        if (treeCache === null) {
          try {
            // **成功したときだけ載せる。** 失敗を載せると、次に構造が変わるまで
            // エラーを返し続ける（自力で復帰できない）
            treeCache = await serializeTree(config.rootDir, excludes, config.maxDepth);
          } catch (err) {
            // **生のメッセージを返さない。** FS のエラーには絶対パスが載る (Issue #99)
            console.error("ツリーの走査に失敗しました:", err);
            return Response.json(
              { error: "ツリーの取得に失敗しました", code: "tree_failed" },
              { status: 500 },
            );
          }
        }
        return new Response(treeCache, { headers: JSON_HEADERS });
      }

      if (url.pathname === "/api/file") {
        if (req.method === "GET") {
          return handleFileRead(config.rootDir, url.searchParams.get("path"), excludes);
        }
        // **書き込みは watcher を待たずに捨てる (Issue #84)。** 保存で新しいパスができると
        // ツリーが変わるが (`writeFileAtomic` は存在しないパスにも書ける)、watcher の
        // 通知は debounce のぶん遅れる。その間に `/api/tree` を引かれると
        // **できたはずのファイルが無いツリー**を返してしまう
        invalidateTree();
        if (req.method === "POST") {
          if (!checkOrigin(req))
            return forbidden("Origin が許可されていません", "origin_forbidden");
          return handleFileWrite(config.rootDir, req, saveMark, excludes);
        }
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, POST" },
        });
      }

      if (url.pathname === "/api/file/create") {
        // 作成直後にクライアントが `/api/tree` を引く (`app-tree.js` の `submitNewFile`)。
        // watcher の到着を待つと、作ったファイルが出ないツリーを返す
        invalidateTree();
        if (req.method === "POST") {
          if (!checkOrigin(req))
            return forbidden("Origin が許可されていません", "origin_forbidden");
          return handleFileCreate(config.rootDir, req, saveMark, excludes);
        }
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }

      if (url.pathname === "/api/asset") {
        if (req.method === "GET" || req.method === "HEAD") {
          return handleAssetRead(config.rootDir, url.searchParams.get("path"), req, excludes);
        }
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        const res = await serveAsset("index.html");
        // CSP は HTML ドキュメントにのみ付与する (JS/CSS レスポンスには不要)。
        // meta ではなく HTTP ヘッダで返し、パース開始前に効かせる (Issue #52)。
        if (res.status === 200) res.headers.set("Content-Security-Policy", buildCsp(req));
        return res;
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
        // **構造が変わったときだけ捨てる (Issue #84)。** 内容の変更 (`change`) は
        // ツリーの形に影響しないので、キャッシュはそのまま使える
        if (kind === "rename") invalidateTree();
        server.publish(
          WS_TOPIC,
          JSON.stringify({ type: kind === "rename" ? "tree" : "changed", path }),
        );
      },
      { excludes, saveMark, depth: config.maxDepth },
    );
  }

  return {
    server,
    saveMark,
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

function forbidden(message: string, code?: string): Response {
  return Response.json({ error: message, code }, { status: 403 });
}

/** Host ヘッダとして妥当な文字だけ (hostname / IPv4 / IPv6 / :port)。CSP へのヘッダ注入を防ぐ。 */
const HOST_PATTERN = /^[a-zA-Z0-9.\-:[\]]+$/;

/**
 * index.html に付与する Content-Security-Policy (Issue #52)。
 * - `script-src 'self'`: 外部 script を禁止 (jsDelivr 依存を排し vendor bundle のみ許可)
 * - `style-src 'unsafe-inline'`: Mermaid が生成する SVG の inline style / <style> に必要
 * - `img-src ... http: https:`: user markdown 内のリモート画像は維持 (閲覧を壊さない)
 * - `media-src ... http: https:`: 同様に user markdown 内のリモート <video>/<audio> を維持
 * - `connect-src 'self' ws://<host> wss://<host>`: 同一オリジンの API と ライブリロード
 *   WebSocket (/ws)。'self' だけでは一部ブラウザで ws:// が通らないため Host から明示許可。
 *   TLS リバースプロキシ配下 (https) ではクライアントが wss:// を使うため両方を許可する。
 */
export function buildCsp(req: Request): string {
  const host = req.headers.get("host");
  const wsSelf = host && HOST_PATTERN.test(host) ? ` ws://${host} wss://${host}` : "";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: http: https:",
    "media-src 'self' http: https:",
    "font-src 'self' data:",
    `connect-src 'self'${wsSelf}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
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

/**
 * ツリーを直列化して返す。**キャッシュに載せるため文字列で返す** (Issue #84)。
 *
 * `Response` を返して呼び出し側で `clone().text()` すると、body を 2 度読むぶんの
 * コピーが要る。ここは構造が変わらないので文字列のまま持ち回るほうが素直。
 */
async function serializeTree(
  rootDir: string,
  excludes: ReadonlySet<string>,
  maxDepth?: number,
): Promise<string> {
  const tree = await scanMarkdownTree(rootDir, { excludes, maxDepth });
  return JSON.stringify(tree);
}

const JSON_HEADERS = { "Content-Type": "application/json;charset=utf-8" } as const;

/**
 * 除外配下へのアクセスを拒否するレスポンス (Issue #65)。
 *
 * **ファイルの存在確認より前に返す**ため、除外配下にあるパスは実在しても存在しなくても
 * 同じ 400 になる (存在有無を漏らさない)。
 *
 * 読み取り (`/api/file` GET・`/api/asset`) と保存 (`/api/file` POST) の両方で使う。
 * 保存を塞ぐのは整合性のためだけでなく、**書き込み経路が読み取りの迂回路になる**ため:
 * baseSha を故意に外すと 409 の競合レスポンスに現在の中身 (`raw`) が載る。
 *
 * 対象は `.yomiignore` と `DEFAULT_EXCLUDES` だけで、**`--depth` 超過は含めない**。
 * depth は `tree -L` 相当の走査深さの上限で、境界のディレクトリはツリーに残る
 * (`scanner.ts` の `truncatedDirs`) = 「中を見ていない」ことの表明であって除外ではない。
 * README も起動時間と inotify watch 数を下げるための指定として説明している。
 * 読み取りまで塞ぐと、浅い md から深い md への内部リンク遷移が動かなくなる。
 */
function excludedPathResponse(requested: string): Response {
  // echo するのは **クライアントが送った文字列**。解決後の `rel` を返すと、symlink 名で
  // 要求したときに除外ディレクトリ内の実パスを教えてしまい、さらに「echo が要求と違う」
  // こと自体がリンク先の実在を証明する。not_found が requested を echo しているのにも揃う。
  return Response.json(
    { error: `除外設定により読み書きできません: ${requested}`, code: "excluded_path" },
    { status: 400 },
  );
}

/**
 * 除外配下への **作成** を拒否するレスポンス (`/api/file/create`)。
 *
 * ## 2 つのコードの使い分け (Issue #97 で整理)
 *
 * | code | 返す場所 | 意味 |
 * |---|---|---|
 * | `excluded_path` | `/api/file`（読み書き）/ `/api/asset` | 除外配下を**読もう・書こう**とした |
 * | `excluded_dir` | `/api/file/create` | 除外配下に**作ろう**とした |
 *
 * **判定式は同一** (`isExcludedPath`)。**分かれているのはエンドポイントの違いだけ**で、
 * 除外の判定に違いは無い。クライアントが操作ごとに文言を出し分けられるように 2 つある。
 *
 * **`_dir` という名前は正確ではない** —— `.yomiignore` はファイル名も書けるので、
 * ファイル名の除外でもこのコードが返る。それでも**改名しない**: Issue #48 の i18n 辞書
 * (`public/i18n.js`) と `tests/server.test.ts` がこのコードを前提にしており、
 * **API の破壊的変更に見合う利益が無い** (意味は上の表で確定しており、誤解するのは名前だけ)。
 */
function excludedDirResponse(requested: string): Response {
  return Response.json(
    { error: `除外設定により作成できません: ${requested}`, code: "excluded_dir" },
    { status: 400 },
  );
}

/**
 * 解決前の要求パスを、字句のまま除外判定する (Issue #65)。
 *
 * `resolveSafe` の後だけで判定すると 2 つ穴が残る:
 *
 * 1. **存在オラクル**: 除外配下にルート外を指す symlink があると `resolveSafe` が先に
 *    throw し、`excluded_path` ではなく `unsafe_path` が返る。応答の differ で
 *    「除外配下にそのエントリがある」ことが分かってしまう
 * 2. **除外名が symlink のときのすり抜け**: `.yomiignore` に書いた名前が実ディレクトリ
 *    でなく symlink だと、realpath がその名前を消すので除外に一致しなくなる
 *
 * 字句側で先に弾けばどちらも塞がる。解決後のチェックは symlink でルート内の除外配下へ
 * 入る経路を止めるために残す (両方要る。片方では不足)。
 */
function isRequestExcluded(requested: string, excludes: ReadonlySet<string>): boolean {
  // resolveSafe は `[\\/]` の両方をセパレータとして扱うので、判定側も合わせる
  // (`private\creds.csv` で素通りさせない)。
  return isExcludedPath(requested.replace(/\\/g, "/"), excludes);
}

async function handleFileRead(
  rootDir: string,
  requested: string | null,
  excludes: ReadonlySet<string>,
): Promise<Response> {
  if (!requested) {
    return Response.json({ error: "path クエリが必要です" }, { status: 400 });
  }
  if (!isMarkdownPath(requested)) {
    return Response.json({ error: "Markdown ファイル以外は読み取れません" }, { status: 400 });
  }
  // 解決前に字句で弾く (unsafe_path オラクルと symlink 除外名のすり抜けを塞ぐ)
  if (isRequestExcluded(requested, excludes)) {
    return excludedPathResponse(requested);
  }

  try {
    const safe = await resolveSafe(rootDir, requested);
    // 除外設定に一致するものは読めない。解決後の rel でも判定するので、除外配下を指す
    // リンクを root 直下に置いても迂回できない。
    if (isExcludedPath(safe.rel, excludes)) {
      return excludedPathResponse(requested);
    }
    const buf = await readFile(safe.abs);
    const raw = buf.toString("utf-8");
    const html = await renderMarkdown(raw, { currentPath: safe.rel });
    return Response.json({ path: safe.rel, raw, html, sha: sha256(buf) });
  } catch (err) {
    if (err instanceof UnsafePathError) {
      return Response.json({ error: err.message, code: "unsafe_path" }, { status: 400 });
    }
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return Response.json(
        { error: `ファイルが見つかりません: ${requested}`, code: "not_found" },
        { status: 404 },
      );
    }
    // 想定外の FS エラー (EACCES / EIO 等) は生メッセージを返さず汎用化する (Issue #99)。
    // `EACCES: permission denied, open '/home/<user>/…/x.md'` のように**絶対パスが載る**
    console.error(`ファイルの読み取りに失敗しました (${requested}):`, err);
    return Response.json(
      { error: `ファイルの読み取りに失敗しました: ${requested}`, code: "read_failed" },
      { status: 500 },
    );
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
  excludes: ReadonlySet<string>,
): Promise<Response> {
  const lengthHeader = req.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > MAX_WRITE_BYTES) {
    return Response.json({ error: "body が大きすぎます", code: "body_too_large" }, { status: 413 });
  }

  let parsed: FileWriteBody;
  try {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf-8") > MAX_WRITE_BYTES) {
      return Response.json(
        { error: "body が大きすぎます", code: "body_too_large" },
        { status: 413 },
      );
    }
    parsed = JSON.parse(text) as FileWriteBody;
  } catch {
    return Response.json(
      { error: "JSON の解析に失敗しました", code: "invalid_json" },
      { status: 400 },
    );
  }

  const { path, body, baseSha } = parsed;
  if (typeof path !== "string" || path.length === 0) {
    return Response.json({ error: "path が必要です", code: "path_required" }, { status: 400 });
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
    return Response.json({ error: "body が大きすぎます", code: "body_too_large" }, { status: 413 });
  }
  // 除外配下は保存もできない (Issue #65)。読み取りだけ塞いでも、baseSha を故意に外して
  // 409 を引けば競合レスポンスの `raw` で中身が返るため、**書き込み経路が読み取りの
  // 迂回路になる**。ここで先に弾くことで、その経路と除外配下の上書きの両方を止める。
  // /api/file/create は同種のチェックを持つが、歴史的に別コード (excluded_dir) を返す。
  if (isRequestExcluded(path, excludes)) {
    return excludedPathResponse(path);
  }

  let safe: { rel: string; abs: string };
  try {
    safe = await resolveSafe(rootDir, path);
  } catch (err) {
    if (err instanceof UnsafePathError) {
      return Response.json({ error: err.message, code: "unsafe_path" }, { status: 400 });
    }
    throw err;
  }

  if (isExcludedPath(safe.rel, excludes)) {
    return excludedPathResponse(path);
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
        // 競合判定のための読み取り。ここも生メッセージを返さない (Issue #99)
        console.error(`競合判定の読み取りに失敗しました (${safe.rel}):`, err);
        return Response.json(
          { error: `ファイルの読み取りに失敗しました: ${path}`, code: "read_failed" },
          { status: 500 },
        );
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
    await writeFileAtomic(safe.abs, buf);
  } catch (err) {
    saveMark.clear(safe.rel);
    // **生のメッセージを返さない。** 一時ファイルの絶対パスと pid が載るので、
    // 内部状態が漏れる（`handleFileCreate` が同じ理由で汎用化しているのに揃える）
    console.error(`保存に失敗しました (${safe.rel}):`, err);
    return Response.json(
      { error: `ファイルの保存に失敗しました: ${path}`, code: "write_failed" },
      { status: 500 },
    );
  }

  const html = await renderMarkdown(body, { currentPath: safe.rel });
  return Response.json({ path: safe.rel, raw: body, html, sha: newSha });
}

interface FileCreateBody {
  path?: unknown;
}

/**
 * POST /api/file/create — 空の Markdown ファイルを新規作成する (Issue #6)。
 *
 * POST /api/file (上書き保存) とエンドポイントを分けているのは、
 * 「既存がなければ 404 ではなく作る」のような曖昧な意味論を避けるため。
 * 存在チェックと作成は open(flag: "wx") = O_CREAT | O_EXCL でアトミックに行い、
 * 既存ファイルは 409、親ディレクトリ不存在は 400 (再帰作成しない)。
 */
async function handleFileCreate(
  rootDir: string,
  req: Request,
  saveMark: SaveMark,
  excludes: ReadonlySet<string>,
): Promise<Response> {
  // body は {path} のみだが、上限なしだと巨大ボディで LAN クライアントが
  // メモリを枯渇させられる。handleFileWrite と同じく MAX_WRITE_BYTES で上限を課す。
  const lengthHeader = req.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > MAX_WRITE_BYTES) {
    return Response.json({ error: "body が大きすぎます", code: "body_too_large" }, { status: 413 });
  }

  let parsed: FileCreateBody;
  try {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf-8") > MAX_WRITE_BYTES) {
      return Response.json(
        { error: "body が大きすぎます", code: "body_too_large" },
        { status: 413 },
      );
    }
    parsed = JSON.parse(text) as FileCreateBody;
  } catch {
    return Response.json(
      { error: "JSON の解析に失敗しました", code: "invalid_json" },
      { status: 400 },
    );
  }

  const { path } = parsed;
  if (typeof path !== "string" || path.length === 0) {
    return Response.json({ error: "path が必要です", code: "path_required" }, { status: 400 });
  }
  if (!isMarkdownPath(path)) {
    return Response.json(
      { error: "Markdown ファイル以外は作成できません", code: "not_markdown" },
      { status: 400 },
    );
  }
  // 解決前にも弾く (Issue #65)。他エンドポイントと同じく unsafe_path オラクルを塞ぎ、
  // already_exists(409) / parent_missing(400) による存在オラクルも除外配下には効かせない。
  if (isRequestExcluded(path, excludes)) {
    return excludedDirResponse(path);
  }

  let safe: { rel: string; abs: string };
  try {
    safe = await resolveSafe(rootDir, path);
  } catch (err) {
    if (err instanceof UnsafePathError) {
      return Response.json({ error: err.message, code: "unsafe_path" }, { status: 400 });
    }
    throw err;
  }

  // 除外ディレクトリ配下はツリーに表示されないファイルが出来て混乱するため拒否
  if (isExcludedPath(safe.rel, excludes)) {
    return excludedDirResponse(path);
  }

  let handle: FileHandle;
  try {
    // O_CREAT | O_EXCL: 存在チェックと作成をアトミックに (TOCTOU 回避)
    handle = await open(safe.abs, "wx");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return Response.json(
        { error: `既に存在します: ${safe.rel}`, code: "already_exists" },
        { status: 409 },
      );
    }
    if (code === "ENOENT" || code === "ENOTDIR") {
      return Response.json(
        { error: `親ディレクトリが存在しません: ${safe.rel}`, code: "parent_missing" },
        { status: 400 },
      );
    }
    // 想定外の FS エラー (EACCES / ENOSPC 等) は生メッセージを返さず汎用化する。
    // safepath.ts の NUL 処理と同じく、内部状態 (絶対パス等) の漏洩を避ける。
    console.error(`handleFileCreate 失敗 (${safe.rel}):`, err);
    return Response.json(
      { error: "ファイルの作成に失敗しました", code: "create_failed" },
      { status: 500 },
    );
  }
  await handle.close();

  // 作成に成功した時だけ自己保存マークを登録する。watcher は DEBOUNCE_MS(80ms) 後に
  // 内容 sha を照合するため、close 直後の同期的な set がそれに先行し二重発火を防ぐ。
  // 失敗時はマークを触らないので、同一パスを保存中の別リクエストのマークを壊さない。
  saveMark.set(safe.rel, sha256(Buffer.from("")));

  return Response.json({ path: safe.rel });
}

/** /api/asset 配信サイズ上限 (50 MB)。DoS / 誤配信抑制のため。 */
export const MAX_ASSET_BYTES = 50 * 1024 * 1024;

async function handleAssetRead(
  rootDir: string,
  requested: string | null,
  req: Request,
  excludes: ReadonlySet<string>,
): Promise<Response> {
  if (!requested) {
    return Response.json({ error: "path クエリが必要です" }, { status: 400 });
  }
  if (!isAssetExtension(requested)) {
    return Response.json({ error: "対応していない拡張子です" }, { status: 400 });
  }
  // 除外配下は開く前に弾く (Issue #65)。fd を取る前に返すので、除外配下のファイルは
  // 実在しても ENOENT との区別がつかない。
  if (isRequestExcluded(requested, excludes)) {
    return excludedPathResponse(requested);
  }

  let safe: { rel: string; abs: string };
  try {
    safe = await resolveSafe(rootDir, requested);
  } catch (err) {
    if (err instanceof UnsafePathError) {
      return Response.json({ error: err.message, code: "unsafe_path" }, { status: 400 });
    }
    throw err;
  }

  if (isExcludedPath(safe.rel, excludes)) {
    return excludedPathResponse(requested);
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
      return Response.json({ error: "ファイルサイズが大きすぎます" }, { status: 413 });
    }

    const buffer = await fh.readFile();
    const etag = computeStrongEtag(buffer);

    // safety net: handleAssetRead は前段で isAssetExtension をチェック済みなので、
    // safe.rel の拡張子は必ず ASSET_CONTENT_TYPES に存在する。
    // この `?? "application/octet-stream"` は事実上到達しないが、型安全のため残す。
    const contentType = assetContentType(safe.rel) ?? "application/octet-stream";
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      ETag: etag,
      // MIME sniff 経由の XSS を抑制 (特に SVG)
      "X-Content-Type-Options": "nosniff",
      // 画像 / PDF は <img src> や内蔵ビューアで表示するため inline を明示。
      // Issue #64: csv 等の表示に向かない形式は attachment + ファイル名で
      // ダウンロードさせる (日本語名は filename*=UTF-8'' で壊さない)。
      "Content-Disposition": buildContentDisposition(
        assetDisposition(safe.rel),
        basename(safe.rel),
      ),
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
    // 想定外の FS エラーは生メッセージを返さず汎用化する (Issue #99)
    console.error(`アセットの配信に失敗しました (${requested}):`, err);
    return Response.json(
      { error: `ファイルの読み取りに失敗しました: ${requested}`, code: "asset_failed" },
      { status: 500 },
    );
  } finally {
    // fd close 失敗 (極稀な EBADF 等) は response に影響させない
    await fh?.close().catch(() => {});
  }
}
