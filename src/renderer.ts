import { Marked, type Tokens } from "marked";
import {
  hasScheme,
  isJavascriptUrl,
  isSafeImageHref,
  resolveRelativePath,
} from "../public/link-resolver.js";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.ts";
import { escapeHtml } from "./util/html.ts";
import { isImageExtension } from "./util/image-ext.ts";
import { slugify, uniqueSlug } from "./util/slugify.ts";

export interface RenderOptions {
  /**
   * 現在のドキュメントの相対パス (root 起点)。
   * 指定された場合、相対パスの画像 src を `/api/asset?path=...` に書き換える。
   * 省略時は画像 src は変換せずそのまま出力する。
   */
  currentPath?: string;
}

/**
 * 各セグメントを encodeURIComponent しつつ "/" を保持して URL 化する。
 * `path.split("/").map(encodeURIComponent).join("/")` のショートカット。
 */
function encodePathForUrl(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

/**
 * Markdown の image href を、画像配信エンドポイント `/api/asset?path=...` に
 * 書き換えるための解決ロジック。
 *
 * - 空文字 / 危険スキーム (`javascript:` / `vbscript:` / `file:` / `chrome-extension:` 等) → 空文字
 * - スキーム付き URL: 画像として安全 (`http(s)://` または `data:image/*;base64,`) のみ通過、それ以外は空文字
 * - currentPath が未指定 → そのまま (フォールバック)
 * - 画像拡張子以外 → そのまま (`/api/asset` は弾くので壊れリンクになるだけ)
 * - 上記以外 (相対 / 絶対パス) → `/api/asset?path=<resolved>` に変換
 *
 * Issue #22: スキーム allowlist 化。以前は RFC 3986 スキーム全部を `<img src>` に
 * そのまま出していたため `vbscript:` や `data:text/html` 等が src に乗る余地があった。
 */
export function rewriteImageHref(href: string, currentPath?: string): string {
  if (!href) return "";
  // 先頭空白を含む `\tjavascript :` 等の難読化に対応するため明示判定を残す
  if (isJavascriptUrl(href)) return "";

  // スキーム付き URL は画像として安全な scheme のみ通過 (http(s) / data:image/*;base64,)
  if (hasScheme(href)) {
    return isSafeImageHref(href) ? href : "";
  }

  if (!currentPath) return href;
  if (!isImageExtension(href.split(/[?#]/)[0] ?? "")) return href;

  const resolved = resolveRelativePath(currentPath, href);
  if (!resolved) return href;
  return `/api/asset?path=${encodePathForUrl(resolved)}`;
}

/**
 * renderMarkdown ごとに新しい Marked インスタンスを作る。
 *
 * 理由: heading の id 衝突回避 (uniqueSlug) のために `usedIds` Set を
 * このインスタンス内のクロージャに閉じ込める必要があるため。
 * 単一の marked を使い回すと、過去のレンダリングで作った id 集合が
 * 残り続けて新しい文書でも `id-1`, `id-2`... と無駄にカウントが進む。
 */
function createMarked(opts: RenderOptions, source: string, body: string): Marked {
  const usedIds = new Set<string>();
  const imageInsideLink = new WeakSet<Tokens.Image>();
  // Issue #9: heading に source 上の絶対行番号を付与する。split mode のスクロール同期で参照
  const headingLines = new WeakMap<Tokens.Heading, number>();

  // frontmatter が消費した行数 (source 内の \n 数)
  const fmChunkLen = source.length - body.length;
  const fmLines = fmChunkLen > 0 ? (source.slice(0, fmChunkLen).match(/\n/g)?.length ?? 0) : 0;

  // walkTokens は token tree を順走するので、body 内を前方検索しながら cursor を進める
  let cursor = 0;

  const marked = new Marked({
    gfm: true,
    breaks: true,
    walkTokens(token) {
      if (token.type === "link" && Array.isArray(token.tokens)) {
        for (const child of token.tokens) {
          if (child.type === "image") {
            imageInsideLink.add(child as Tokens.Image);
          }
        }
      }
      if (token.type === "heading") {
        // 行頭マッチに限定する: 段落内に同じ raw 文字列が偶然含まれていても拾わない。
        // 見つからない場合は次の候補へ ( idx + 1 から再検索)。
        let idx = body.indexOf(token.raw, cursor);
        while (idx > 0 && body[idx - 1] !== "\n") {
          idx = body.indexOf(token.raw, idx + 1);
        }
        if (idx >= 0) {
          const lineInBody = (body.slice(0, idx).match(/\n/g)?.length ?? 0) + 1;
          headingLines.set(token as Tokens.Heading, fmLines + lineInBody);
          cursor = idx + token.raw.length;
        }
      }
    },
  });

  marked.use({
    renderer: {
      code(token) {
        const lang = token.lang ?? "";
        const text = token.text ?? "";
        if (lang === "mermaid") {
          return `<pre class="mermaid">${escapeHtml(text)}</pre>\n`;
        }
        return false;
      },
      heading(token) {
        const depth = token.depth;
        const inner = this.parser.parseInline(token.tokens);
        const baseSlug = slugify(token.text);
        const id = uniqueSlug(baseSlug || `section-${usedIds.size + 1}`, usedIds);
        const line = headingLines.get(token as Tokens.Heading);
        const lineAttr = typeof line === "number" ? ` data-line="${line}"` : "";
        return `<h${depth} id="${escapeHtml(id)}"${lineAttr}>${inner}</h${depth}>\n`;
      },
      image(token) {
        const href = rewriteImageHref(token.href ?? "", opts.currentPath);
        const title = token.title ?? "";
        const text = token.text ?? "";
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        const img = `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${titleAttr}>`;
        if (!href || imageInsideLink.has(token)) return img;
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${img}</a>`;
      },
    },
  });

  return marked;
}

/**
 * Markdown ソースをレンダリングして HTML を返す。
 * 先頭の YAML フロントマターはメタデータカードとして整形し、本文の先頭に付加する。
 *
 * heading id は呼び出しごとに新規 Marked インスタンスを作ることで
 * ドキュメントごとに独立する (前のレンダリングの影響を受けない)。
 *
 * options.currentPath を渡すと、相対パスの画像が `/api/asset?path=...` に変換される。
 */
export async function renderMarkdown(source: string, options: RenderOptions = {}): Promise<string> {
  const { body, entries } = parseFrontmatter(source);
  const fmHtml = renderFrontmatter(entries);
  const marked = createMarked(options, source, body);
  const bodyHtml = await marked.parse(body);
  return fmHtml + bodyHtml;
}
