import type { Dirent, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, readdir, readFile, realpath, rm, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectArticleImages } from "./article-images.ts";
import { renderMarkdown } from "./renderer.ts";
import { isMarkdownPath, resolveSafe, UnsafePathError } from "./safepath.ts";
import { SaveMark, sha256 } from "./save-mark.ts";
import { scanViewableTree } from "./scanner.ts";
import { assetContentType, assetDisposition, isAssetExtension } from "./util/asset-ext.ts";
import { writeFileAtomic } from "./util/atomic-write.ts";
import { buildContentDisposition } from "./util/content-disposition.ts";
import type { ErrorCode } from "./util/error-codes.ts";
import { computeStrongEtag } from "./util/etag.ts";
import { DEFAULT_EXCLUDES, isExcludedPath } from "./util/excludes.ts";
import { IMAGE_CONTENT_TYPES, isImageExtension } from "./util/image-ext.ts";
import { toPosix } from "./util/path-util.ts";
import { textLanguageOf } from "./util/text-ext.ts";
import { isViewableFile } from "./util/viewable.ts";
import { createZip, type ZipEntry } from "./util/zip.ts";
import { createWatcher, isStructuralChange, type WatcherHandle } from "./watcher.ts";
import {
  describeInvalidLine,
  type InvalidYomiignoreLine,
  loadYomiignore,
  parseYomiignore,
  resolveExcludes,
  YOMIIGNORE_FILENAME,
} from "./yomiignore.ts";

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

/**
 * `.yomiignore` の書き込み上限 (bytes)。**md の 10MB とは別に、小さく取る** (Issue #164)。
 *
 * 中身は 1 行 1 パターンの名前だけで、実データは数十行に収まる。`MAX_WRITE_BYTES` を
 * 使い回すと、**パースが 10MB の文字列を `split(/\r?\n/)` する経路**を画面から
 * 開いてしまう（保存のたびに全行を再パースするので、そのコストが除外の差し替えに乗る）。
 */
export const MAX_YOMIIGNORE_BYTES = 64 * 1024;

/**
 * テキストファイル (非 Markdown) を `/api/file` で返すときのサイズ上限 (bytes)。Issue #155。
 *
 * **クライアントは受け取った raw を丸ごと DOM に入れ、ハイライトまで掛ける。** 巨大なログを
 * そのまま流すとブラウザが固まるので、届く前にここで止める。超過は 413 (`file_too_large`) で、
 * 切り詰めて返すことはしない —— 途中まで表示されたものを「全部」と誤読されるほうが害が大きい。
 *
 * **Markdown には掛けない。** これまで上限なしで読めていたので、ここで課すと既存の挙動が変わる。
 */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/**
 * `/api/images.zip` が返す zip の上限 (Issue #140)。
 *
 * **zip はメモリ上で組み立てる**ので、上限が無いと画像の多い記事でサーバが詰まる。
 * 超えたぶんは**入れずに一覧へ記録**し、応答自体は成功させる —— 1 枚のせいで
 * まるごと失敗するより、入った画像を渡して「入らなかったもの」を伝えるほうが使える。
 */
export const MAX_ZIP_BYTES = 200 * 1024 * 1024;

/** zip に入れなかった参照を記録するファイルの名前。 */
export const ZIP_SKIPPED_ENTRY = "SKIPPED.txt";

/**
 * `SKIPPED.txt` の 1 行に載せる参照の最大長。
 *
 * `data:image/png;base64,…` は数 MB になりうるので、切らないと**一覧だけが
 * 際限なく膨らむ**（zip 本体の上限は画像しか数えていない）。
 */
const SKIP_FIELD_MAX = 300;

/** `SKIPPED.txt` に載せる最大行数。超えた分は件数だけ書く。 */
const SKIP_MAX_LINES = 1000;

/**
 * 同時に走らせる zip 生成の本数 (Issue #140)。
 *
 * **zip はメモリ上で組み立てる**ので、並べられるとその本数ぶん積み上がる。
 * クライアントは 1 タブ内で二重送信を防いでいるが、**別タブや curl からは何本でも
 * 並べられる**。ローカルで読むための道具なので、直列でも実用上困らない。
 */
const ZIP_CONCURRENCY = 1;

/** いま走っている zip 生成の本数。 */
let zipInFlight = 0;

export interface ServerConfig {
  rootDir: string;
  hostname: string;
  port: number;
  watch?: boolean;
  /**
   * ファイル監視の初期スキャンが終わったときに呼ばれる。**テスト専用の注入口** (Issue #126)。
   *
   * chokidar は `ignoreInitial: true` で動いているので、**初期スキャンの最中に書いた
   * ファイルは「最初からあった」とみなされて通知されない**。サーバを起動した直後に
   * 書くテストは、この完了を待たないと**間欠的に通知が来ない**（実際に 3 回に 1 回
   * 落ちた）。固定 sleep で待つと遅い環境で破れるので、ready を待つ。
   *
   * `WatcherOptions.onReady` (Issue #45) と同じ理由・同じ形。あちらは watcher を
   * 直接組み立てるテスト用で、こちらは**サーバ越し**に同じことをするためのもの。
   * 本番では未指定。
   */
  onWatcherReady?: () => void;
  /**
   * 除外するディレクトリ/ファイル名の**起動時の初期値** (省略時は DEFAULT_EXCLUDES)。
   *
   * **`.yomiignore` を画面から保存すると破棄される** (Issue #164)。`reloadExcludes` は
   * `DEFAULT_EXCLUDES` + ファイルの内容 − 否定 で**作り直す**ので、ここに渡した集合は
   * 最初の保存で失われる。いまは `bin/yomi.ts` が同じ式で組み立てているので本番では
   * 一致するが、**その一致は偶然の同型であって型でも規約でも守られていない** ——
   * 埋め込み用途で狭い集合を渡すと、保存 1 回で除外が緩む（＝読み取り範囲が広がる）。
   */
  excludes?: ReadonlySet<string>;
  /** 走査/監視する階層の上限 (Issue #44, tree -L 相当)。省略時は無制限。 */
  maxDepth?: number;
  /**
   * `/api/images.zip` が返す zip の上限 (Issue #140)。省略時は {@link MAX_ZIP_BYTES}。
   *
   * **テストから小さい値を入れて上限の分岐を踏む**ための注入点
   * （200MB ぶんの画像を fixture に置くわけにいかない）。
   */
  maxZipBytes?: number;
}

export interface ServerHandle {
  server: ReturnType<typeof Bun.serve>;
  /** 自己保存マーク。テストから作成/書き込み後のマーク状態を検証するために公開する。 */
  saveMark: SaveMark;
  close(): void;
}

export function createServer(config: ServerConfig): ServerHandle {
  /**
   * 実効の除外集合。**`let` で持つ** (Issue #164)。
   *
   * `.yomiignore` を画面から保存できるようになったので、**起動時の固定値ではなくなった**。
   * 下の各ハンドラはこの変数をクロージャで読むので、ここを差し替えれば
   * `/api/tree` / `/api/file` / `/api/asset` / `/api/images.zip` の**全経路が同時に
   * 新しい集合を見る**（#65 で塞いだ迂回路を開け直さないための要）。
   *
   * **watcher だけは追随しない** —— `createWatcher` は生成時の集合を `ignored` の
   * クロージャに捕まえ、chokidar は張り終えた watch を張り直さないので、
   * `reloadExcludes` が watcher ごと作り直す。
   */
  let excludes: ReadonlySet<string> = config.excludes ?? DEFAULT_EXCLUDES;

  /**
   * `/api/tree` の直列化済み応答 (Issue #84)。
   *
   * **毎回フルスキャンしていた。** 10,000 ファイルの環境では応答 34.7ms のうち
   * **30.8ms が `scanViewableTree`** で、`JSON.stringify` は 0.8ms しかない
   * （実測は `docs/bench/tree-diff-update.md`）。ツリーが変わるのは watcher が
   * `rename` を拾ったときだけなので、そこまでは使い回せる。
   *
   * **直列化まで含めて持つ。** オブジェクトを持って毎回 `Response.json` すると
   * `stringify` のぶんが残る。構造は変わらないので文字列で構わない。
   *
   * 常駐メモリは応答サイズぶん（10,000 ファイルで 724 KiB）。
   */
  let treeCache: string | null = null;

  /**
   * ツリーの版 (Issue #126)。**キャッシュを捨てるたびに 1 つ進める。**
   *
   * クライアントは差分 (`tree` 通知) を積んで手元のツリーを更新するので、
   * **1 通でも落ちると以後ずっとずれる**。連番を振っておけば、受け取った側が
   * 「自分の版 + 1 か」を見るだけで取りこぼしに気づけ、全量へ逃げられる
   * (`public/app-websocket.js`)。
   *
   * **`invalidateTree` と同じ場所で進める。** 別々にすると「キャッシュは捨てたが
   * 版は据え置き」という状態が生まれ、**クライアントが古いツリーを最新だと信じる**。
   * 保存 (`/api/file`) のようにツリーの形が変わらない操作でも版が進むので、
   * そのぶん**次の構造変化で 1 回だけ全量を取り直す**ことになる —— 取りこぼしを
   * 見逃すより、余分に 1 回取り直すほうが安い。
   */
  let treeGen = 0;
  const invalidateTree = () => {
    treeCache = null;
    treeGen++;
  };

  /**
   * 差分を送れるか (Issue #126)。
   *
   * **`--depth` を指定しているときは送らない。** 深さ境界のディレクトリは
   * 「中を見ていないので空でも残す」という扱いで (`scanner.ts` の `truncatedDirs`)、
   * **クライアントはそれを空ディレクトリと区別できない**。差分で最後のファイルを
   * 消したときに、サーバは残すのにクライアントは畳む、というずれ方をする。
   * 深さ制限つきのときは従来どおり全量を取り直させる。
   */
  const canSendTreeDiff = config.maxDepth === undefined;
  const saveMark = new SaveMark();

  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    /**
     * `fetch` を抜けた例外の受け皿 (Issue #99)。
     *
     * **これが無いと Bun の開発用エラーページ（HTML 約 70KB）が返る。** ソース断片・
     * スタック・**絶対パス**が載るので、個別の catch を丁寧に書いても 1 箇所漏れれば
     * 台無しになる。実際、20KB の Markdown を保存しようとすると `marked` が
     * `RangeError: Maximum call stack size exceeded` を投げてここへ抜けていた。
     *
     * **個別の catch の代わりではなく、最後の砦。** ここに落ちること自体が想定外なので、
     * 詳細はサーバのログに出して調査できるようにする。
     */
    error: internalErrorResponse,
    async fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("Upgrade Required", { status: 426 });
      }

      if (url.pathname === "/api/tree") {
        // **走査を待つ間に版が進みうる。** `serializeTree` は await を挟むので、
        // その間に watcher の通知や保存が入ると、**走り終えたときには古い内容**に
        // なっている。捕まえておいて、返す版・載せる版の両方に使う (Issue #126)
        // キャッシュに当たったときは、載せた後に版が進んでいない（進めば捨てられる）
        // ので、この値がそのままキャッシュの版になる
        const genAtScan = treeGen;
        if (treeCache === null) {
          try {
            // **成功したときだけ載せる。** 失敗を載せると、次に構造が変わるまで
            // エラーを返し続ける（自力で復帰できない）
            const serialized = await serializeTree(config.rootDir, excludes, config.maxDepth);
            if (treeGen === genAtScan) {
              treeCache = serialized;
            } else {
              // **追い越された。** キャッシュには載せず (次の要求で取り直す)、
              // 走査した内容だけをこの応答に使う。版は走査時のものを名乗る ——
              // **最新を名乗ると、クライアントが取りこぼした差分に気づけなくなる**
              return new Response(serialized, { headers: treeHeaders(genAtScan) });
            }
          } catch (err) {
            // **生のメッセージを返さない。** FS のエラーには絶対パスが載る (Issue #99)。
            //
            // **通常は到達しない。** `scanner.ts` の `walk` が `readdir` の失敗を
            // root も含めて握り潰すので、対象を消しても「空のツリー」を 200 で返す。
            // ここは `JSON.stringify` の失敗など、それ以外の想定外に対する備え
            console.error("ツリーの走査に失敗しました:", err);
            return Response.json(
              { error: "ツリーの取得に失敗しました", code: "tree_failed" },
              { status: 500 },
            );
          }
        }
        return new Response(treeCache, { headers: treeHeaders(genAtScan) });
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

      if (url.pathname === "/api/file/delete") {
        // 作成 (`/api/file/create`) と同じ理由でキャッシュを先に捨てる。watcher の
        // `unlink` は debounce のぶん遅れるので、待つと**消したファイルが残るツリー**を返す
        invalidateTree();
        if (req.method === "POST") {
          if (!checkOrigin(req))
            return forbidden("Origin が許可されていません", "origin_forbidden");
          return handleFileDelete(config.rootDir, req, excludes);
        }
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }

      if (url.pathname === "/api/dir/delete") {
        // **GET は数えるだけ**（消える内訳のプレビュー）。ツリーは変わらないので
        // キャッシュを捨てない —— 捨てると、確認ダイアログを開くたびに全走査が走る
        if (req.method === "GET") {
          return handleDirDeletePreview(config.rootDir, url.searchParams.get("path"), excludes);
        }
        if (req.method === "POST") {
          if (!checkOrigin(req))
            return forbidden("Origin が許可されていません", "origin_forbidden");
          invalidateTree();
          return handleDirDelete(config.rootDir, req, excludes);
        }
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, POST" },
        });
      }

      if (url.pathname === "/api/yomiignore") {
        if (req.method === "GET" || req.method === "POST") {
          if (req.method === "POST" && !checkOrigin(req))
            return forbidden("Origin が許可されていません", "origin_forbidden");
          try {
            return req.method === "GET"
              ? Response.json(await readYomiignoreState(config.rootDir))
              : await runYomiignoreWrite(() =>
                  handleYomiignoreWrite(config.rootDir, req, saveMark, reloadExcludes),
                );
          } catch (err) {
            // **ルート外を指す symlink は読み書きさせない (Issue #156)。**
            // `/api/file` と同じ code / status に揃える（入口ごとに答えが違わないように）
            if (err instanceof UnsafePathError) {
              return Response.json({ error: err.message, code: "unsafe_path" }, { status: 400 });
            }
            throw err;
          }
        }
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, POST" },
        });
      }

      if (url.pathname === "/api/images.zip") {
        if (req.method === "GET" || req.method === "HEAD") {
          return handleArticleImagesZip(
            config.rootDir,
            url.searchParams.get("path"),
            excludes,
            req.method === "HEAD",
            config.maxZipBytes ?? MAX_ZIP_BYTES,
          );
        }
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
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
  /**
   * watcher を張る。**除外集合を差し替えたら張り直す** (Issue #164)。
   *
   * chokidar は `ignored` を生成時に受け取り、**既に張った watch を作り直さない**ので、
   * 除外を解除しただけでは監視対象に戻らない（そのディレクトリはツリーに出るのに
   * ライブリロードだけ効かない、という気づきにくい壊れ方をする）。作り直すのが確実。
   */
  const startWatcher = () => {
    if (config.watch === false) return;
    watcher = createWatcher(
      config.rootDir,
      (path, kind) => {
        // **構造が変わったときだけ捨てる (Issue #84)。** 内容の変更 (`change`) は
        // ツリーの形に影響しないので、キャッシュはそのまま使える
        if (!isStructuralChange(kind)) {
          server.publish(WS_TOPIC, JSON.stringify({ type: "changed", path }));
          return;
        }
        invalidateTree();
        // **どこがどう変わったかを送る (Issue #126)。** これが無いと、受け取った側は
        // `/api/tree` を全量取り直して 10,500 ノードを突き合わせるしかない
        // （実測 18ms。`docs/bench/tree-diff-update.md`）
        server.publish(
          WS_TOPIC,
          JSON.stringify(
            canSendTreeDiff
              ? { type: "tree", op: kind === "add" ? "add" : "remove", path, gen: treeGen }
              : { type: "tree" },
          ),
        );
      },
      { excludes, saveMark, depth: config.maxDepth, onReady: config.onWatcherReady },
    );
  };
  startWatcher();

  /**
   * `.yomiignore` を読み直して除外集合を差し替える (Issue #164)。
   *
   * **`bin/yomi.ts` の起動時と同じ経路を通る** (`loadYomiignore` → `resolveExcludes`)。
   * 「和集合 → 減算」の合成順が 2 か所に散ると、画面から保存したときだけ否定 (`!name`) の
   * 効き方が変わる、という追いにくいずれ方をする。
   *
   * 差し替えたら:
   * - **watcher を張り直す** (`startWatcher` の説明のとおり、解除したディレクトリを監視に戻す)
   * - **ツリーのキャッシュを捨てて版を進める** (`invalidateTree`)
   * - **全量取り直しを通知する。** 除外集合が丸ごと入れ替わるので、`add` / `remove` 1 件の
   *   差分では表せない (`public/app-websocket.js` は `op` の無い `tree` を全量へ倒す)
   */
  const reloadExcludes = async (): Promise<YomiignoreState> => {
    // **ディスクから読み直す**（保存した文字列を使い回さない）。書けた内容が実際に
    // 読み直せることまで含めて「反映できた」なので、応答もここで作った値から組む。
    // **読めなかったら差し替えない**（`loadYomiignore` が投げる。fail-closed）——
    // 黙って `DEFAULT_EXCLUDES` へ戻すと、利用者が足した除外が消えて読み取り範囲が広がる。
    const state = await readYomiignoreState(config.rootDir);
    const parsed = await loadYomiignore(config.rootDir);
    excludes = resolveExcludes(parsed);
    watcher?.close();
    watcher = null;
    startWatcher();
    invalidateTree();
    server.publish(WS_TOPIC, JSON.stringify({ type: "tree" }));
    return state;
  };

  /**
   * `.yomiignore` の保存を**直列化する** (Issue #164)。
   *
   * 保存は `await` を跨ぐので、2 本が交差すると「ディスクは B・メモリの `excludes` は A」で
   * 確定しうる（後から代入したほうが勝つ）。除外はゲートなので、**除外したつもりの集合が
   * 効いていない状態が次の保存まで残る**。2 タブ・`Ctrl+Enter` の連打・再送で現実に交差する
   * （クライアントの `saving` フラグはそのタブ内の二重送信しか防がない）。
   *
   * **`Promise` の鎖 1 本で足りる**（サーバは単一プロセスで、書き込み先はこの 1 ファイル）。
   */
  let yomiignoreChain: Promise<unknown> = Promise.resolve();
  const runYomiignoreWrite = <T>(task: () => Promise<T>): Promise<T> => {
    // **前段の失敗を引き継がない**（1 本落ちたら以降が全部落ちる、を避ける）
    const next = yomiignoreChain.then(task, task);
    yomiignoreChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    server,
    saveMark,
    close() {
      // **順序が効いている。** watcher を先に閉じること —— 先にマークを消すと、
      // debounce 待ちの `isOwnSave` がマークを見失って「他人の変更」と判定し、
      // まさに消したかった余計なリロードを自分で作る (Issue #120)
      watcher?.close();
      server.stop();
      // マークは「いま保存中のリクエスト」を指すので、サーバを閉じたら意味を失う
      saveMark.clearAll();
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

/**
 * `fetch` を抜けた例外の受け皿 (Issue #99)。
 *
 * **これが無いと Bun の開発用エラーページ（HTML 約 70KB）が返る。** ソース断片・
 * スタック・**絶対パス**が載るので、個別の catch を丁寧に書いても 1 箇所漏れれば
 * 台無しになる。実際、20KB の Markdown を保存しようとすると `marked` が
 * `RangeError: Maximum call stack size exceeded` を投げてここへ抜けていた。
 *
 * **個別の catch の代わりではなく、最後の砦。** いまは全ハンドラが捕捉するので
 * 通常は到達しないが、経路が増えたときの保険として置く。ここに落ちること自体が
 * 想定外なので、詳細はサーバのログに出して調査できるようにする。
 */
export function internalErrorResponse(err: unknown): Response {
  console.error("未捕捉のエラー:", err);
  return Response.json(
    { error: "サーバ内部エラーが発生しました", code: "internal_error" },
    { status: 500 },
  );
}

function forbidden(message: string, code?: ErrorCode): Response {
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
  const tree = await scanViewableTree(rootDir, { excludes, maxDepth });
  return JSON.stringify(tree);
}

const JSON_HEADERS = { "Content-Type": "application/json;charset=utf-8" } as const;

/** `/api/tree` の版を伝えるヘッダ名 (Issue #126)。 */
export const TREE_GEN_HEADER = "X-Yomi-Tree-Gen";

/**
 * `/api/tree` の応答ヘッダ。**版をボディに入れずヘッダで返す。**
 *
 * ボディを `{ gen, tree }` で包むと `TreeNode` の形が変わり、`public/api-types.js` との
 * 一致 (`tests/api-types.test.ts` が型で検証している) と、既に配布した版のクライアントが
 * 壊れる。ヘッダなら**読まない側は今までどおり**動く。
 */
function treeHeaders(gen: number): Record<string, string> {
  return { ...JSON_HEADERS, [TREE_GEN_HEADER]: String(gen) };
}

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
  // **ツリーに載る集合と揃える (Issue #155)。** Markdown はレンダリングして返し、
  // テキストは raw だけを返す。どちらでもない拡張子は従来どおり弾く（allowlist）。
  if (!isViewableFile(requested)) {
    return Response.json(
      { error: "このファイルは表示できません", code: "not_viewable" },
      { status: 400 },
    );
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
    // **解決後のパスにも許可リストを掛ける (Issue #156)。** 要求文字列と解決後の rel は
    // symlink で食い違う。`note.md → secret.bin` のようなリンクがルート内にあると、
    // 要求側の判定（`isViewableFile(requested)`）は通り、種別判定（`textLanguageOf`）は
    // null を返すので、**許可リストに無い実体が Markdown としてレンダリングされて返る**。
    // 除外判定を解決前と解決後の両方で掛けているのと同じ形にする（Issue #65）。
    if (!isViewableFile(safe.rel)) {
      return Response.json(
        { error: "このファイルは表示できません", code: "not_viewable" },
        { status: 400 },
      );
    }
    const buf = await readFile(safe.abs);
    // **種別も解決後のパスで引く。** 実際に読んだファイルの名前で決めるので、
    // `note.md → data.json` のリンクは（どちらも許可リスト内なので通り）テキストとして返る。
    const lang = textLanguageOf(safe.rel);
    if (lang !== null) {
      // **上限は Markdown に掛けない。** md は無制限で読めていた（既存の挙動を変えない）。
      // テキストは巨大なログを掴みうるので、DOM へ流す前にここで止める。
      if (buf.byteLength > MAX_TEXT_BYTES) {
        return Response.json(
          {
            // **要求されたパスを返す**（`safe.rel` ではなく）。他のエラー応答と揃うし、
            // symlink 越しに開いたときに利用者が知らない実体名を返さずに済む
            error: `ファイルが大きすぎます (上限 ${Math.floor(MAX_TEXT_BYTES / 1024 / 1024)}MB): ${requested}`,
            code: "file_too_large",
          },
          { status: 413 },
        );
      }
      return Response.json({
        path: safe.rel,
        raw: buf.toString("utf-8"),
        kind: "text",
        lang,
        sha: sha256(buf),
      });
    }
    const raw = buf.toString("utf-8");
    const html = await renderMarkdown(raw, { currentPath: safe.rel });
    return Response.json({ path: safe.rel, raw, html, kind: "markdown", sha: sha256(buf) });
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
    // **要求文字列を連結しない。** 改行や ANSI エスケープを含みうるので、
    // 端末に偽のログ行を差し込まれない形（オブジェクト）で渡す
    console.error("ファイルの読み取りに失敗しました:", { path: requested }, err);
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
      // 描画に失敗しても競合の通知自体は返す（`raw` があれば差分は出せる）
      let currentHtml = "";
      if (currentRaw !== null) {
        try {
          currentHtml = await renderMarkdown(currentRaw, { currentPath: safe.rel });
        } catch (err) {
          console.error("競合レスポンスの描画に失敗しました:", {
            path: safe.rel,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
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
    // **自分が立てたマークだけを消す (Issue #120)。** 同じファイルを別のリクエストが
    // 保存中でも、そちらのマークは残る（#129 で 1 パスに複数持てるようにした）。
    // 無条件に消すと、そのリクエストの正常な保存が watcher から「他人の変更」に
    // 見えて余計なリロードが飛ぶ
    const cleared = saveMark.clear(safe.rel, newSha);
    // **生のメッセージを返さない。** 一時ファイルの絶対パスと pid が載るので、
    // 内部状態が漏れる（`handleFileCreate` が同じ理由で汎用化しているのに揃える）。
    // **パスも連結しない** —— ファイル名に改行や ANSI を入れられると偽のログ行を
    // 差し込めるので、オブジェクトで渡す（#99 が同じ理由で立てた作法）
    console.error("保存に失敗しました:", {
      path: safe.rel,
      // `false` = 自分のマークがもう無かった（上限で押し出された等）。#129 で
      // 1 パスに複数持てるようになったので、**「別リクエストに上書きされた」ではない**。
      // 余計なリロードの報告を切り分けるときの手掛かりになる (Issue #120 / #129)
      mark: cleared ? "cleared" : "自分のマークが既に無い",
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { error: `ファイルの保存に失敗しました: ${path}`, code: "write_failed" },
      { status: 500 },
    );
  }

  // **保存は成功しているので、描画に失敗しても 200 を返す (Issue #99)。**
  // ここを覆っていなかったため、`marked` が落ちると「ファイルは書けたのに 500」という
  // 事実と食い違う応答になっていた（しかも Bun のエラーページで内部情報が漏れる）。
  // 本文は返せているので、クライアントは `raw` から再描画できる
  let html = "";
  try {
    html = await renderMarkdown(body, { currentPath: safe.rel });
  } catch (err) {
    // **メッセージだけを出す。** ここに来る典型は `marked` の再帰上限で、スタックには
    // 縮小済みのライブラリのソースが数十行ぶん載る。原因の特定にはメッセージで足り、
    // 全部出すとテストや運用のログが読めなくなる
    console.error("保存後の描画に失敗しました:", {
      path: safe.rel,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return Response.json({ path: safe.rel, raw: body, html, sha: newSha });
}

/** `/api/yomiignore` が返す 1 行ぶんの警告。**文言はサーバが組み立てる**。 */
export interface YomiignoreInvalidLine extends InvalidYomiignoreLine {
  /** `describeInvalidLine` の結果。画面はこれをそのまま出す (判定も文言も写さない) */
  message: string;
}

export interface YomiignoreState {
  /** `.yomiignore` の中身。ファイルが無ければ空文字 */
  text: string;
  invalid: YomiignoreInvalidLine[];
}

/**
 * `.yomiignore` の現在の中身と警告を返す (Issue #164)。
 *
 * **`/api/file` では読ませない。** あちらは除外配下を拒否するので、
 * `.yomiignore` に `.yomiignore` と書いた瞬間に**設定画面を開けなくなる**
 * （自分で自分を締め出せてしまう）。設定は専用経路で、除外判定を通さない。
 */
export async function readYomiignoreState(rootDir: string): Promise<YomiignoreState> {
  // **symlink を解決してからルート内に収まっているか確かめる (Issue #156)。**
  // `join(rootDir, …)` を素で `readFile` に渡すと、`.yomiignore` がルート外を指す
  // symlink のとき**その中身をそのまま返してしまう** —— v0.22.1 で `/api/file` /
  // `/api/asset` に塞いだ穴が、専用エンドポイントを足したことで別経路に開き直る
  // （実測: `.yomiignore -> ../outside/secret.txt` で秘密が読めた）。
  // **除外判定は通さない**（自分で自分を締め出さないため）が、**パスの安全性は通す**。
  const safe = await resolveYomiignore(rootDir);
  let text = "";
  try {
    text = await readFile(safe.abs, "utf-8");
  } catch (err) {
    // **存在しないのは正常。** それ以外は読めなかったことを画面へ伝えず空として扱うが、
    // ログには残す（権限などで読めていないのに「空です」と見えるのを追えるように）
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`${YOMIIGNORE_FILENAME} の読み取りに失敗しました:`, err);
    }
  }
  return { text, invalid: describeParsed(text) };
}

/**
 * `.yomiignore` の実体パスを解決する (Issue #156 / #164)。
 *
 * **`resolveSafe` に通す。** パスは固定なので traversal は起きないが、**そこに置かれた
 * symlink がルート外を指す**ことはあり、`/api/file` はそれを 400 で拒否している。
 * この経路だけ素通しにすると、**同じファイルが片方の入口からは読めない・もう片方からは
 * 読める**という食い違いになる。
 *
 * 解決できたパスは**ルート内**なので、読み書きの対象として使ってよい。
 *
 * **`rel` も返す。** `saveMark` と watcher は**実体側の名前**で噛み合う必要がある
 * （`ResolvedPath.rel` の JSDoc）。`.yomiignore` がルート内の別ファイルを指す symlink だと
 * watcher は `ignore-src.txt` の `change` を emit するので、マークを `.yomiignore` の
 * リテラルで立てると当たらず、**保存のたびに余計なリロードが飛ぶ**（#120 が塞いだ壊れ方）。
 * `handleFileWrite` が `safe.rel` を使っているのに揃える。
 */
async function resolveYomiignore(rootDir: string): Promise<{ rel: string; abs: string }> {
  return resolveSafe(rootDir, YOMIIGNORE_FILENAME);
}

function describeParsed(text: string): YomiignoreInvalidLine[] {
  return parseYomiignore(text).invalid.map((v) => ({ ...v, message: describeInvalidLine(v) }));
}

interface YomiignoreWriteBody {
  text?: unknown;
}

/**
 * POST /api/yomiignore — `.yomiignore` を保存して除外集合を差し替える (Issue #164)。
 *
 * **`/api/file` (Markdown 保存) のゲートを緩めない。** あちらの `isMarkdownPath` は
 * 「書けるのは md だけ」という約束で、ここを通すために広げると**任意のテキストファイルへの
 * 書き込み経路**が開く。パスを取らない専用エンドポイントにすれば、書ける先は
 * ルート直下の `.yomiignore` 1 つに固定される。
 *
 * **共有起動 (`--share`) でも編集できる。** 除外は #65 以降「読み書きの可否を決めるゲート」
 * なので、`!node_modules` のような否定を書けば起動ディレクトリ配下を広く読めるようになる。
 * README が `--share` を「LAN 内の全員が信頼できる前提」と宣言しているので、md の保存・
 * 新規作成と同じ扱いに揃える (2026-08-30 の判断)。**権限で分けるなら別 Issue**。
 */
async function handleYomiignoreWrite(
  rootDir: string,
  req: Request,
  saveMark: SaveMark,
  reloadExcludes: () => Promise<YomiignoreState>,
): Promise<Response> {
  const lengthHeader = req.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > MAX_YOMIIGNORE_BYTES) {
    return Response.json({ error: "body が大きすぎます", code: "body_too_large" }, { status: 413 });
  }

  let parsed: YomiignoreWriteBody;
  try {
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf-8") > MAX_YOMIIGNORE_BYTES) {
      return Response.json(
        { error: "body が大きすぎます", code: "body_too_large" },
        { status: 413 },
      );
    }
    parsed = JSON.parse(raw) as YomiignoreWriteBody;
  } catch {
    return Response.json(
      { error: "JSON の解析に失敗しました", code: "invalid_json" },
      { status: 400 },
    );
  }

  const { text } = parsed;
  if (typeof text !== "string") {
    return Response.json({ error: "text は string です", code: "invalid_json" }, { status: 400 });
  }
  if (Buffer.byteLength(text, "utf-8") > MAX_YOMIIGNORE_BYTES) {
    return Response.json({ error: "body が大きすぎます", code: "body_too_large" }, { status: 413 });
  }

  // **書き込み先も解決してから使う (Issue #156)。** ルート外を指す symlink なら
  // ここで `UnsafePathError` になり、呼び出し側が 400 に変える。**素の `join` に書くと
  // symlink を破壊してルート直下に実ファイルを作る**ので、「拒否した」ように見えて
  // 実際には利用者のリンクを消している、という別の壊れ方をする
  const safe = await resolveYomiignore(rootDir);

  const buf = Buffer.from(text, "utf-8");
  // **自己保存マークを立てる。** `.yomiignore` は `text-ext.ts` に載っていてツリーから
  // 読めるので、これが無いと保存のたびに watcher が「他人の変更」として通知を撒く
  // (Issue #120 と同じ理由)。**`safe.rel` を使う** —— watcher が emit するのは
  // **解決後の実体の名前**なので、リテラルで立てると symlink 経由で噛み合わない
  const newSha = sha256(buf);
  saveMark.set(safe.rel, newSha);
  try {
    await writeFileAtomic(safe.abs, buf);
  } catch (err) {
    saveMark.clear(safe.rel, newSha);
    // 生のメッセージを返さない (Issue #99。一時ファイルの絶対パスと pid が載る)
    console.error(`${YOMIIGNORE_FILENAME} の保存に失敗しました:`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { error: `${YOMIIGNORE_FILENAME} の保存に失敗しました`, code: "write_failed" },
      { status: 500 },
    );
  }

  // **応答は読み直した内容から組む** (Issue #164)。リクエスト本文を echo すると、
  // 並行保存や外部エディタの割り込みがあったときに**画面が自分の書いた内容を
  // 「保存された現在値」として表示し続ける**。`reloadExcludes` が読み直すので、
  // その結果をそのまま返せば経路が 1 本になる
  try {
    return Response.json(await reloadExcludes());
  } catch (err) {
    // **ルート外 symlink は呼び出し側が 400 にする**（`/api/file` と揃えるため）
    if (err instanceof UnsafePathError) throw err;
    // **「書けたが反映できなかった」を `write_failed` と混ぜない。** 書けているのに
    // 「保存に失敗」と言うと、利用者は同じ操作を繰り返すことになる。**除外は
    // 差し替えていない**（fail-closed）ので、いま効いているのは 1 つ前の集合
    console.error(`${YOMIIGNORE_FILENAME} の読み直しに失敗しました:`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      {
        error: `${YOMIIGNORE_FILENAME} は保存しましたが、読み直せなかったため除外を差し替えていません`,
        code: "reload_failed",
      },
      { status: 500 },
    );
  }
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

/* ===== 削除 (Issue #171) ===== */

/**
 * 削除プレビュー (`GET /api/dir/delete`) が走査するエントリ数の上限。
 *
 * 確認ダイアログに出す数のためだけの走査なので、`node_modules` を抱えたディレクトリで
 * 何十万エントリも歩かない。超えたら `truncated: true` を返し、クライアントは
 * 「これ以上」と示す（**消す処理は上限を持たない** —— 数え切れなくても消すものは消す）。
 */
const DELETE_PREVIEW_MAX_ENTRIES = 20000;

interface DeleteBody {
  path?: unknown;
}

/** 削除対象が見つからない (`/api/file/delete` / `/api/dir/delete`)。 */
function deleteNotFoundResponse(requested: string): Response {
  return Response.json(
    { error: `見つかりません: ${requested}`, code: "not_found" },
    { status: 404 },
  );
}

/**
 * 削除リクエストの body から `path` を取り出す。
 *
 * body は `{path}` のみだが、上限なしだと巨大ボディで LAN クライアントがメモリを
 * 枯渇させられる。`handleFileCreate` と同じく `MAX_WRITE_BYTES` で上限を課す。
 */
async function readDeletePath(req: Request): Promise<{ path: string } | { res: Response }> {
  const lengthHeader = req.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > MAX_WRITE_BYTES) {
    return {
      res: Response.json({ error: "body が大きすぎます", code: "body_too_large" }, { status: 413 }),
    };
  }

  let parsed: DeleteBody;
  try {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf-8") > MAX_WRITE_BYTES) {
      return {
        res: Response.json(
          { error: "body が大きすぎます", code: "body_too_large" },
          { status: 413 },
        ),
      };
    }
    parsed = JSON.parse(text) as DeleteBody;
  } catch {
    return {
      res: Response.json(
        { error: "JSON の解析に失敗しました", code: "invalid_json" },
        { status: 400 },
      ),
    };
  }

  const { path } = parsed;
  if (typeof path !== "string" || path.length === 0) {
    return {
      res: Response.json({ error: "path が必要です", code: "path_required" }, { status: 400 }),
    };
  }
  return { path };
}

interface DeleteTarget {
  /** クライアントへ返す相対パス (`resolveSafe` の `rel`)。 */
  rel: string;
  /** 実際に消す絶対パス。**leaf を realpath しない** (下記)。 */
  abs: string;
}

/**
 * 削除対象を検証して、消してよい絶対パスを返す (Issue #171)。
 *
 * ## `resolveSafe` の `abs` をそのまま消さない
 *
 * `resolveSafe` は leaf が実在すると **realpath 済みの絶対パス**を返す
 * (`safepath.ts` の `ResolvedPath.abs`)。symlink を渡すとリンク先の実体を指すので、
 * それを消すと**実体が消えてリンクだけが残る** —— 利用者がツリーで見ていたものと
 * 違うものが消える。ルート内の symlink はルート内の別ファイルも指せるので実害が出る。
 *
 * そこで**親までを解決して leaf は綴りのまま繋ぐ**。親の realpath がルート内に
 * 収まっていることは `resolveSafe` が既に検証している (ここでも同じ計算をする) ので、
 * ルート外へ抜ける経路は増えない。
 *
 * ## 除外の判定は 2 段
 *
 * 解決前の字句 (`isRequestExcluded`) と解決後の `rel` (`isExcludedPath`) の両方を見る。
 * `excludedPathResponse` のコメントにある理由 (存在オラクルと symlink 除外名の
 * すり抜け) がそのまま当てはまる。
 */
async function resolveDeleteTarget(
  rootDir: string,
  requested: string,
  excludes: ReadonlySet<string>,
): Promise<{ ok: true; target: DeleteTarget } | { ok: false; res: Response }> {
  if (isRequestExcluded(requested, excludes)) {
    return { ok: false, res: excludedPathResponse(requested) };
  }

  let safe: { rel: string; abs: string };
  try {
    safe = await resolveSafe(rootDir, requested);
  } catch (err) {
    if (err instanceof UnsafePathError) {
      return {
        ok: false,
        res: Response.json({ error: err.message, code: "unsafe_path" }, { status: 400 }),
      };
    }
    throw err;
  }

  // **ルート自身を消させない。** `resolveSafe` は `.` を通す (root の内側なので
  // `isOutsideRoot` に掛からず `rel` が空になる)。ここで止めないと、`{"path":"."}`
  // ひとつで**閲覧しているディレクトリごと消える**。
  if (safe.rel === "" || safe.rel === ".") {
    return {
      ok: false,
      res: Response.json(
        { error: "ルートディレクトリは削除できません", code: "unsafe_path" },
        { status: 400 },
      ),
    };
  }

  if (isExcludedPath(safe.rel, excludes)) {
    return { ok: false, res: excludedPathResponse(requested) };
  }

  const rootAbs = await realpath(rootDir);
  const requestedAbs = resolve(rootAbs, requested);
  let parentReal: string;
  try {
    parentReal = await realpath(dirname(requestedAbs));
  } catch {
    // 親が無い = 対象も無い。`lstat` を待たずにここで 404 にする
    return { ok: false, res: deleteNotFoundResponse(requested) };
  }
  return {
    ok: true,
    target: {
      // **応答に載せるのは要求の綴り。** `resolveSafe` の `rel` は leaf も realpath 済みで、
      // symlink だと**リンク先の名前**になる (`link-dir` を消したのに `real-dir` を返す)。
      // クライアントはこれをツリーの path と突き合わせて「開いていたものが消えたか」を
      // 見るので、実体名を返すと**消したものを見失う**。除外の判定には解決後の
      // `safe.rel` を使ってあるので、ここを要求側にしても判定は緩まない。
      rel: toPosix(relative(rootAbs, requestedAbs)),
      abs: join(parentReal, basename(requestedAbs)),
    },
  };
}

/** 想定外の FS エラー。**生メッセージを返さない** (絶対パスが載る。Issue #99)。 */
function deleteFailedResponse(rel: string, err: unknown): Response {
  console.error(`削除に失敗しました (${rel}):`, err);
  return Response.json({ error: "削除に失敗しました", code: "delete_failed" }, { status: 500 });
}

/**
 * POST /api/file/delete — ファイル 1 個を削除する (Issue #171)。
 *
 * **ツリーに出るファイルだけを消せる** (`isViewableFile`)。ツリーに出ないもの
 * (`.env` のような非表示ファイル) まで画面越しに消せると、**見えないものが消える**。
 * ディレクトリ側 (`/api/dir/delete`) は配下の全部を対象にするが、あちらは
 * 「配下ごと消える」ことを確認ダイアログで示してから消す。
 */
async function handleFileDelete(
  rootDir: string,
  req: Request,
  excludes: ReadonlySet<string>,
): Promise<Response> {
  const body = await readDeletePath(req);
  if ("res" in body) return body.res;
  const requested = body.path;

  if (!isViewableFile(requested)) {
    return Response.json(
      { error: "このファイルは削除できません", code: "not_viewable" },
      { status: 400 },
    );
  }

  const resolved = await resolveDeleteTarget(rootDir, requested, excludes);
  if (!resolved.ok) return resolved.res;
  const { rel, abs } = resolved.target;

  let stat: Stats;
  try {
    // **`stat` ではなく `lstat`。** symlink を辿ると、リンク先の種類で分岐してしまう
    stat = await lstat(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return deleteNotFoundResponse(requested);
    return deleteFailedResponse(rel, err);
  }
  if (stat.isDirectory()) {
    return Response.json(
      { error: `ディレクトリです: ${rel}`, code: "not_a_file" },
      { status: 400 },
    );
  }

  try {
    // symlink なら**リンクだけ**が消える (`unlink` は辿らない)
    await unlink(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return deleteNotFoundResponse(requested);
    return deleteFailedResponse(rel, err);
  }
  return Response.json({ path: rel });
}

/** `GET /api/dir/delete` が返す内訳。 */
interface DeleteCount {
  /** 配下の Markdown ファイル数。 */
  markdown: number;
  /** 配下のそれ以外のファイル数 (画像・テキスト・symlink など)。 */
  other: number;
  /** 配下のディレクトリ数 (対象自身は含まない)。 */
  dirs: number;
  /** 走査上限に当たって数え切れなかった。 */
  truncated: boolean;
}

/**
 * 削除したときに消えるものを数える (Issue #171)。
 *
 * **symlink は辿らない。** `readdir` の dirent は `lstat` 相当なので、symlink は
 * `isDirectory()` が false になり「その他のファイル 1 個」として数える。辿ると
 * ルート外まで数えることになり、**実際に消える量と食い違う** (`rm --recursive` も
 * リンクとして消す)。
 *
 * **除外設定 (`.yomiignore` / `DEFAULT_EXCLUDES`) は適用しない。** ここで数えるのは
 * 「消えるもの」であって「ツリーに出るもの」ではない —— 除外されたファイルも
 * ディレクトリごと消えるので、数から落とすと**確認ダイアログが実態より少なく見える**。
 */
async function countDeletable(absDir: string): Promise<DeleteCount> {
  const count: DeleteCount = { markdown: 0, other: 0, dirs: 0, truncated: false };
  const stack: string[] = [absDir];
  let seen = 0;

  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // **読めないディレクトリは数えない。** 消す処理も同じところで失敗するので、
      // 数に入れて多く見せるより実態に近い
      continue;
    }
    for (const entry of entries) {
      if (++seen > DELETE_PREVIEW_MAX_ENTRIES) {
        count.truncated = true;
        return count;
      }
      if (entry.isDirectory()) {
        count.dirs++;
        stack.push(join(dir, entry.name));
      } else if (isMarkdownPath(entry.name)) {
        count.markdown++;
      } else {
        count.other++;
      }
    }
  }
  return count;
}

/**
 * GET /api/dir/delete — **消さずに**、消える内訳だけを返す (Issue #171)。
 *
 * 確認ダイアログに出す数をクライアントが自前で数えられないため置いている ——
 * ツリーは除外設定と `--depth` の適用後なので、**実際に消える量とは一致しない**。
 *
 * 読み取りしかしないので `checkOrigin` は掛けない (`/api/tree` と同じ扱い)。
 */
async function handleDirDeletePreview(
  rootDir: string,
  requested: string | null,
  excludes: ReadonlySet<string>,
): Promise<Response> {
  if (!requested) {
    return Response.json({ error: "path が必要です", code: "path_required" }, { status: 400 });
  }

  const resolved = await resolveDeleteTarget(rootDir, requested, excludes);
  if (!resolved.ok) return resolved.res;
  const { rel, abs } = resolved.target;

  let stat: Stats;
  try {
    stat = await lstat(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return deleteNotFoundResponse(requested);
    return deleteFailedResponse(rel, err);
  }

  // **symlink は中を数えない。** 消えるのはリンク 1 個だけ
  if (stat.isSymbolicLink()) {
    return Response.json({
      path: rel,
      symlink: true,
      markdown: 0,
      other: 0,
      dirs: 0,
      truncated: false,
    });
  }
  if (!stat.isDirectory()) {
    return Response.json(
      { error: `ディレクトリではありません: ${rel}`, code: "not_a_dir" },
      { status: 400 },
    );
  }

  return Response.json({ path: rel, symlink: false, ...(await countDeletable(abs)) });
}

/**
 * POST /api/dir/delete — ディレクトリを**配下ごと**削除する (Issue #171)。
 *
 * 配下の非 Markdown ファイル・除外設定で隠れているファイルも一緒に消える。
 * 消える内訳は `GET /api/dir/delete` で先に取れるので、クライアントはそれを
 * 確認ダイアログに出してから叩く。
 */
async function handleDirDelete(
  rootDir: string,
  req: Request,
  excludes: ReadonlySet<string>,
): Promise<Response> {
  const body = await readDeletePath(req);
  if ("res" in body) return body.res;
  const requested = body.path;

  const resolved = await resolveDeleteTarget(rootDir, requested, excludes);
  if (!resolved.ok) return resolved.res;
  const { rel, abs } = resolved.target;

  let stat: Stats;
  try {
    stat = await lstat(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return deleteNotFoundResponse(requested);
    return deleteFailedResponse(rel, err);
  }

  // **ディレクトリへの symlink はリンクだけを消す。** `rm --recursive` に渡すと
  // 実装によってはリンク先を歩きうる。ここで分けておけば、**ルート外を指すリンクでも
  // 消えるのはリンク 1 個**であることが読んで分かる
  if (stat.isSymbolicLink()) {
    try {
      await unlink(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return deleteNotFoundResponse(requested);
      return deleteFailedResponse(rel, err);
    }
    return Response.json({ path: rel, symlink: true });
  }

  if (!stat.isDirectory()) {
    return Response.json(
      { error: `ディレクトリではありません: ${rel}`, code: "not_a_dir" },
      { status: 400 },
    );
  }

  try {
    // `recursive` は**配下の symlink を辿らない** (リンクとして消す)。
    // `force` は付けない —— 消えていたら 404 で知らせたい
    await rm(abs, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return deleteNotFoundResponse(requested);
    return deleteFailedResponse(rel, err);
  }
  return Response.json({ path: rel, symlink: false });
}

/**
 * `SKIPPED.txt` の 1 フィールドとして安全な文字列にする (Issue #140)。
 *
 * パスは Markdown の href 由来で、**改行やタブを含みうる**（POSIX では合法な
 * ファイル名文字で、`resolveSafe` も通す）。そのまま「参照\t理由」の行に連結すると
 * **偽の行を作れる** —— `![](nope%0A%2Fetc%2Fpasswd.png)` で
 * 「yomi が `/etc/passwd.png` を見に行った」ように見せられる（実測）。
 *
 * `Content-Disposition` 側は同じ理由で既に落としている（`util/content-disposition.ts`）。
 */
function skipField(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を落とすのが目的
  const oneLine = value.replace(/[\x00-\x1f\x7f]/g, "\ufffd");
  // **長すぎるものは切る。** `data:image/png;base64,…` は数 MB になりうるので、
  // 一覧だけが際限なく膨らむ
  return oneLine.length <= SKIP_FIELD_MAX ? oneLine : `${oneLine.slice(0, SKIP_FIELD_MAX)}…`;
}

/**
 * 記事が参照する画像を zip にまとめて返す (Issue #140)。
 *
 * ## 何を入れるか
 *
 * **表示中の Markdown 1 本が参照するローカル画像だけ。** 集めるのは
 * {@link collectArticleImages}（プレビューと同じ判定を使う）で、外部 URL・`data:` URI は
 * 取りに行かない —— yomi は既定で 127.0.0.1 にバインドし、**サーバから外へ出ていく通信を
 * 持たない**設計。取得を足すと Markdown に書かれた任意の URL へサーバが接続することになる。
 *
 * ## 1 枚ずつ `/api/asset` と同じ関門を通す
 *
 * 除外設定（`.yomiignore` / 既定除外）配下と root 外は**入れずに飛ばす**。ここを緩めると、
 * **zip が `/api/asset` の迂回路**になる（Issue #65 が塞いだ穴を開け直す）。
 *
 * **飛ばしてもエラーにしない。** 1 枚の除外で zip 全体が失敗すると使えないので、
 * 入らなかったものは {@link ZIP_SKIPPED_ENTRY} に理由つきで残す。
 *
 * ## zip のエントリ名は「Markdown が参照しているパス」
 *
 * `resolveSafe` が返す実体のパス（realpath 済み）**ではなく**、Markdown の href を
 * root 起点に解決したパスを使う。**展開して Markdown の隣に置いたときにリンクが通る**のが
 * この機能の目的だから。
 *
 * 違いが出るのは symlink のとき。`docs/alias.png -> shared/b.png` を
 * `![](alias.png)` と書いている場合、
 *
 * | 名前に使うもの | 展開後 | `![](alias.png)` は |
 * |---|---|---|
 * | 参照パス `docs/alias.png` | `docs/alias.png` に実体ができる | **通る** |
 * | 実体パス `shared/b.png` | `docs/alias.png` が無い | 壊れる |
 *
 * `resolveRelativePath` は `..` を root で打ち切る（`../../x.png` → `x.png`）ので、
 * **参照パスに `..` は残らない**（実測）。それでも {@link createZip} が名前を検証する。
 */
async function handleArticleImagesZip(
  rootDir: string,
  requested: string | null,
  excludes: ReadonlySet<string>,
  headOnly: boolean,
  maxZipBytes: number,
): Promise<Response> {
  if (!requested) {
    return Response.json(
      { error: "path クエリが必要です", code: "path_required" },
      { status: 400 },
    );
  }
  if (!isMarkdownPath(requested)) {
    return Response.json(
      { error: "Markdown ファイル以外は指定できません", code: "not_markdown" },
      { status: 400 },
    );
  }
  // 解決前に字句で弾く（`handleFileRead` と同じ順序）
  if (isRequestExcluded(requested, excludes)) {
    return excludedPathResponse(requested);
  }

  let safe: Awaited<ReturnType<typeof resolveSafe>>;
  let markdown: string;
  try {
    safe = await resolveSafe(rootDir, requested);
    if (isExcludedPath(safe.rel, excludes)) {
      return excludedPathResponse(requested);
    }
    // **解決後のパスでも Markdown であることを確かめる (Issue #156)。** 他の 2 経路と違い、
    // ここは中身をそのまま返さない（返るのは参照された画像だけ）ので情報は漏れないが、
    // **3 経路で関門の形を揃える** —— 1 つだけ緩いと、次に触る人がどれが正しいか判断できない。
    if (!isMarkdownPath(safe.rel)) {
      return Response.json(
        { error: "Markdown ファイル以外は指定できません", code: "not_markdown" },
        { status: 400 },
      );
    }
    markdown = (await readFile(safe.abs)).toString("utf-8");
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
    console.error("記事の読み取りに失敗しました:", {
      path: requested,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { error: "ファイルの読み取りに失敗しました", code: "read_failed" },
      { status: 500 },
    );
  }

  // **同時に走らせない。** 並べられると zip のぶんだけメモリが積み上がる
  if (zipInFlight >= ZIP_CONCURRENCY) {
    return Response.json(
      {
        error: "zip の作成が混み合っています。少し待ってからもう一度お試しください",
        code: "zip_busy",
      },
      { status: 503, headers: { "Retry-After": "2" } },
    );
  }

  // **HEAD で zip を組み立てない。** 全画像を読んで捨てるだけになり、
  // 帯域ゼロでサーバ側の全コストを引ける（`handleAssetRead` も HEAD を短絡している）
  if (headOnly) {
    return new Response(null, {
      headers: {
        "Content-Type": "application/zip",
        "Cache-Control": "no-store",
      },
    });
  }

  zipInFlight++;
  try {
    return await buildImagesZip(rootDir, safe, markdown, excludes, maxZipBytes);
  } finally {
    zipInFlight--;
  }
}

/** {@link handleArticleImagesZip} の本体。同時実行の数え上げから切り離すために分けてある。 */
async function buildImagesZip(
  rootDir: string,
  safe: Awaited<ReturnType<typeof resolveSafe>>,
  markdown: string,
  excludes: ReadonlySet<string>,
  maxZipBytes: number,
): Promise<Response> {
  let found: ReturnType<typeof collectArticleImages>;
  try {
    found = collectArticleImages(markdown, safe.rel);
  } catch (err) {
    // **marked が落ちうる。** 深くネストした構造で再帰上限に達する（#99 が同じ形を潰した）。
    // 捕まえないと未捕捉ハンドラへ落ち、`internal_error` と巨大なスタックが出る
    console.error("記事の解析に失敗しました:", {
      path: safe.rel,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { error: "ファイルの読み取りに失敗しました", code: "read_failed" },
      { status: 500 },
    );
  }
  const entries: ZipEntry[] = [];
  /** 入らなかった参照とその理由。zip の中に置く */
  const skipped: string[] = [
    ...found.external.map((url) => `${skipField(url)}\t外部の参照は取得しない`),
    ...found.notImage.map((ref) => `${skipField(ref)}\t画像ではない`),
  ];
  let totalBytes = 0;

  for (const rel of found.local) {
    // **`/api/asset` と同じ関門。** 順序も揃える（拡張子 → 字句 → 解決 → 解決後の除外）。
    //
    // **拡張子をここでも見る。** `collectArticleImages` が既に見ているが、`/api/asset` が
    // `isAssetExtension(requested)` を独立に掛けているのと同じ理由で二重に持つ ——
    // ここが唯一の関門だと、集める側の判定が緩んだ瞬間に**任意ファイルの吸い出し**になる
    // （実際、解決前の href だけを見ていたときは `![](.env%23a.png)` で `.env` が入った）
    if (!isImageExtension(rel)) {
      skipped.push(`${skipField(rel)}\t画像ではない`);
      continue;
    }
    // **`SKIPPED.txt` と衝突する名前は入れない。** `createZip` が重複で投げ、
    // zip 全体が 500 になる（「1 枚のせいで全部失敗させない」に反する）
    if (rel === ZIP_SKIPPED_ENTRY) {
      skipped.push(`${skipField(rel)}\t一覧ファイルと名前が衝突する`);
      continue;
    }
    // **zip の名前にできないものは飛ばす。** `createZip` は投げるので、通すと
    // 1 枚のせいで zip 全体が 500 になる（`C:\x.png` は POSIX では合法なファイル名）
    if (rel.includes("\\") || /^[A-Za-z]:/.test(rel)) {
      skipped.push(`${skipField(rel)}\tzip のエントリ名にできない`);
      continue;
    }
    if (isRequestExcluded(rel, excludes)) {
      skipped.push(`${skipField(rel)}\t除外設定の配下`);
      continue;
    }
    try {
      const image = await resolveSafe(rootDir, rel);
      if (isExcludedPath(image.rel, excludes)) {
        skipped.push(`${skipField(rel)}\t除外設定の配下`);
        continue;
      }
      // **`handleAssetRead` と同じく fd 経由で stat してから読む。** 直に `readFile`
      // すると、ディレクトリは EISDIR で「読み取りに失敗」になり（本当は「ファイルではない」）、
      // FIFO は**永久にブロックして zip 全体が返らなくなる**
      const fh = await open(image.abs, "r");
      let data: Buffer;
      try {
        const st = await fh.stat();
        if (!st.isFile()) {
          skipped.push(`${skipField(rel)}\tファイルではない`);
          continue;
        }
        if (st.size > MAX_ASSET_BYTES) {
          skipped.push(`${skipField(rel)}\t1 枚あたりの上限 ${MAX_ASSET_BYTES} バイトを超える`);
          continue;
        }
        if (totalBytes + st.size > maxZipBytes) {
          skipped.push(`${skipField(rel)}\t上限 ${maxZipBytes} バイトを超えるため`);
          continue;
        }
        data = await fh.readFile();
      } finally {
        await fh.close().catch(() => {});
      }
      totalBytes += data.length;
      // **`image.rel`（realpath 済み）ではなく `rel`（参照どおり）を名前にする。**
      // 理由は上の表。除外と root 外の判定には `image.rel` を使うので、
      // 名前の選択で関門が緩むことはない
      entries.push({ name: rel, data: new Uint8Array(data) });
    } catch (err) {
      if (err instanceof UnsafePathError) {
        skipped.push(`${skipField(rel)}\tルートディレクトリの外`);
        continue;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        skipped.push(`${skipField(rel)}\tファイルが見つからない`);
        continue;
      }
      // **1 枚の失敗で zip 全体を諦めない。** 理由だけ残して次へ
      console.error("画像の読み取りに失敗しました:", {
        path: rel,
        error: err instanceof Error ? err.message : String(err),
      });
      skipped.push(`${skipField(rel)}\t読み取りに失敗`);
    }
  }

  if (skipped.length > 0) {
    const header = [
      "# zip に入らなかった参照 (yomi)",
      `# 元のファイル: ${safe.rel}`,
      "# 1 行につき「参照\t理由」",
      "",
    ].join("\n");
    // **バイト数で切らない。** 途中で切ると理由が読めなくなり、この一覧の意味が消える。
    // **行数と 1 行の長さで抑える**（`skipField` が 1 行を切る）
    const shown = skipped.slice(0, SKIP_MAX_LINES);
    const rest = skipped.length - shown.length;
    if (rest > 0) shown.push(`… 他 ${rest} 件（多すぎるため省略）`);
    entries.push({
      name: ZIP_SKIPPED_ENTRY,
      data: new TextEncoder().encode(`${header}${shown.join("\n")}\n`),
    });
  }

  let zip: Uint8Array;
  try {
    zip = createZip(entries);
  } catch (err) {
    console.error("zip の組み立てに失敗しました:", {
      path: safe.rel,
      entries: entries.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { error: "zip の作成に失敗しました", code: "zip_failed" },
      { status: 500 },
    );
  }

  // 元のファイル名から `.md` を外して `<名前>-images.zip` にする
  const stem = basename(safe.rel).replace(/\.[^.]*$/, "");
  // **コピーしない。** `createZip` はちょうどのサイズのバッファを専有して返すので、
  // `slice` すると zip のサイズぶん無駄に積む（上限 200MB のとき丸ごと 1 本ぶん）
  return new Response(zip.buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zip.length),
      "Content-Disposition": buildContentDisposition("attachment", `${stem}-images.zip`),
      // **キャッシュさせない。** 画像が差し替わっても古い zip が返ると混乱する
      "Cache-Control": "no-store",
      // 入った枚数と入らなかった件数を、展開せずに読めるようにする。
      // **クライアントが zip を解析しなくて済む** —— EOCD を読ませると
      // `createZip` の実装詳細に結合し、形式を変えたときに無言で壊れる
      "X-Yomi-Images": String(entries.length - (skipped.length > 0 ? 1 : 0)),
      "X-Yomi-Skipped": String(skipped.length),
    },
  });
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

  // **解決後のパスにも許可リストを掛ける (Issue #156)。** `photo.png → secret.bin` のような
  // symlink がルート内にあると、要求側の `isAssetExtension(requested)` は通るのに実体は
  // 許可リスト外で、**中身がそのまま配信される**（下の `?? "application/octet-stream"` に落ちる）。
  if (!isAssetExtension(safe.rel)) {
    return Response.json({ error: "対応していない拡張子です" }, { status: 400 });
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

    // safety net: **解決後の `safe.rel` に対しても** isAssetExtension を通してあるので
    // (Issue #156)、拡張子は必ず ASSET_CONTENT_TYPES に存在する。
    //
    // **以前は「要求側だけ検査すれば到達しない」と書いていたが、それは誤りだった** ——
    // symlink で要求と実体が食い違うと、許可リスト外の実体がここへ来て
    // `application/octet-stream` として配信されていた（#156）。いまは解決後にも
    // 検査しているので到達しないが、その根拠が変わったことを残しておく。
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
    console.error("アセットの配信に失敗しました:", { path: requested }, err);
    return Response.json(
      { error: `ファイルの読み取りに失敗しました: ${requested}`, code: "asset_failed" },
      { status: 500 },
    );
  } finally {
    // fd close 失敗 (極稀な EBADF 等) は response に影響させない
    await fh?.close().catch(() => {});
  }
}
