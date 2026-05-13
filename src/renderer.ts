import { Marked } from "marked";
import { isExternalUrl, isJavascriptUrl, resolveRelativePath } from "../public/link-resolver.js";
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
 * - 空文字 / 危険スキーム (`javascript:`) → 空文字
 * - 外部 URL (`http(s)://`, `data:`, `mailto:` 等) → そのまま
 * - currentPath が未指定 → そのまま (フォールバック)
 * - 画像拡張子以外 → そのまま (`/api/asset` は弾くので壊れリンクになるだけ)
 * - 上記以外 (相対 / 絶対パス) → `/api/asset?path=<resolved>` に変換
 */
export function rewriteImageHref(href: string, currentPath?: string): string {
  if (!href) return "";
  if (isJavascriptUrl(href)) return "";
  if (isExternalUrl(href)) return href;
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
function createMarked(opts: RenderOptions): Marked {
  const usedIds = new Set<string>();

  const marked = new Marked({
    gfm: true,
    breaks: true,
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
        return `<h${depth} id="${escapeHtml(id)}">${inner}</h${depth}>\n`;
      },
      image(token) {
        const href = rewriteImageHref(token.href ?? "", opts.currentPath);
        const title = token.title ?? "";
        const text = token.text ?? "";
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${titleAttr}>`;
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
  const marked = createMarked(options);
  const bodyHtml = await marked.parse(body);
  return fmHtml + bodyHtml;
}
