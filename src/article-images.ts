import { Marked, type Token, type Tokens } from "marked";
import { rewriteImageHref } from "./renderer.ts";
import { isImageExtension } from "./util/image-ext.ts";

/**
 * Markdown が参照している画像を集める (Issue #140)。
 *
 * ## 判定はプレビューと同じものを使う
 *
 * 集めるかどうかは {@link rewriteImageHref} の**戻り値で決める**。あれはプレビューが
 * `<img src>` を作るのに使っている関数そのもので、**ここで判定を書き直すと必ずずれる**
 * （スキーム allowlist・画像拡張子・相対パス解決の 3 つを写すことになる）。
 *
 * 戻り値の形で 3 つに分かれる:
 *
 * | 戻り値 | 意味 | 扱い |
 * |---|---|---|
 * | `/api/asset?path=…` | root 内のローカル画像 | **zip に入れる** |
 * | `http(s)://…` / `data:image/…` | 外部・埋め込み | **入れない**（一覧に残す） |
 * | それ以外の文字列 | 画像拡張子でないので書き換えられなかった | **入れない**（一覧に残す） |
 * | `""` | 危険スキーム等で弾かれた | **入れない**（表示もされていない） |
 *
 * ## 解決後のパスでも拡張子を見る
 *
 * `rewriteImageHref` が拡張子を見るのは**生の href** で、`resolveRelativePath` は
 * **デコードしてから `#` / `?` で切る**。この 2 つは同じ文字列を見ていないので、
 * `![](.env%23a.png)` は「`.png` で終わる」と判定されたうえで `.env` に解決される。
 *
 * **これを塞がないと、`/api/asset` が 400 で拒否する `.env` や `id_rsa` が zip に入る**
 * （実測で再現した）。解決後のパスにも {@link isImageExtension} を掛ける。
 *
 * ## 生の HTML の `<img>` は対象外
 *
 * `renderMarkdown` が書き換えるのは marked の `image` トークンだけで、Markdown 内に
 * 直接書いた `<img src="foo.png">` は書き換えない。**そのため相対パスの生 `<img>` は
 * そもそも表示されない**（ブラウザがページ URL 基準で解決し、サーバはそのパスを配信しない）。
 * 表示されていないものを zip に入れるほうが説明できないので、ここでも対象外にする。
 */

/** 集めた結果。順序は Markdown の出現順で、重複は取り除いてある。 */
export interface ArticleImages {
  /** root からの相対パス。zip のエントリ名にそのまま使える */
  local: string[];
  /** 取得しなかった外部 URL・`data:` URI（zip 内の一覧に載せる） */
  external: string[];
  /**
   * ローカルを指しているが**画像ではない**参照。
   *
   * `external` と分けているのは、`SKIPPED.txt` に書く理由が違うから
   * （「外部だから取りに行かない」と「そもそも画像ではない」は別）。
   */
  notImage: string[];
}

/** `/api/asset?path=` を剥がして、元の root 相対パスへ戻す。 */
function decodeAssetPath(url: string): string | null {
  const prefix = "/api/asset?path=";
  if (!url.startsWith(prefix)) return null;
  const encoded = url.slice(prefix.length);
  try {
    // `encodePathForUrl` は `/` を残してセグメントごとに encodeURIComponent する
    return encoded
      .split("/")
      .map((seg) => decodeURIComponent(seg))
      .join("/");
  } catch {
    // 壊れたエンコードは集めない（`/api/asset` 側でも同じように弾かれる）
    return null;
  }
}

/** トークン木を辿って `image` を集める。`walkTokens` は非同期版しか無いので自前で辿る。 */
function collectImageTokens(tokens: readonly Token[], out: Tokens.Image[]): void {
  for (const token of tokens) {
    if (token.type === "image") {
      out.push(token as Tokens.Image);
    }
    // marked のトークンは `tokens` / `items` / `rows` / `header` に子を持つ
    const t = token as unknown as Record<string, unknown>;
    for (const key of ["tokens", "items", "header"]) {
      const child = t[key];
      if (Array.isArray(child)) collectImageTokens(child as Token[], out);
    }
    const rows = t.rows;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (Array.isArray(row)) {
          for (const cell of row) {
            const cellTokens = (cell as { tokens?: Token[] }).tokens;
            if (Array.isArray(cellTokens)) collectImageTokens(cellTokens, out);
          }
        }
      }
    }
  }
}

/**
 * `markdown` が参照している画像を集める。
 *
 * @param markdown Markdown の本文
 * @param currentPath その Markdown の root 相対パス（相対リンクの解決に使う）
 */
export function collectArticleImages(markdown: string, currentPath: string): ArticleImages {
  // **描画用のインスタンスを使い回さない。** `renderMarkdown` は heading の id 衝突回避で
  // 状態を持つが、ここは字句解析だけなので素の Marked で足りる
  const tokens = new Marked().lexer(markdown);
  const images: Tokens.Image[] = [];
  collectImageTokens(tokens, images);

  const local: string[] = [];
  const external: string[] = [];
  const notImage: string[] = [];
  const seen = {
    local: new Set<string>(),
    external: new Set<string>(),
    notImage: new Set<string>(),
  };

  /** 同じ値を 2 度入れない */
  const push = (bucket: "local" | "external" | "notImage", value: string, into: string[]) => {
    if (seen[bucket].has(value)) return;
    seen[bucket].add(value);
    into.push(value);
  };

  for (const token of images) {
    const rewritten = rewriteImageHref(token.href ?? "", currentPath);
    if (!rewritten) continue; // 危険スキーム等。プレビューでも表示されない

    const path = decodeAssetPath(rewritten);
    if (path !== null) {
      // **解決後のパスでも拡張子を見る。** 上の docstring のとおり、`rewriteImageHref` が
      // 見た文字列と実際に開くパスは別物になりうる（`.env%23a.png` → `.env`）
      if (isImageExtension(path)) push("local", path, local);
      else push("notImage", path, notImage);
      continue;
    }

    // 外部 URL・`data:` URI のほか、画像拡張子でないため書き換えられなかった相対パスも来る
    if (
      rewritten.startsWith("http://") ||
      rewritten.startsWith("https://") ||
      rewritten.startsWith("data:")
    ) {
      push("external", rewritten, external);
    } else {
      push("notImage", rewritten, notImage);
    }
  }

  return { local, external, notImage };
}
