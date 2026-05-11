import { Marked } from "marked";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.ts";
import { escapeHtml } from "./util/html.ts";
import { slugify, uniqueSlug } from "./util/slugify.ts";

/**
 * renderMarkdown ごとに新しい Marked インスタンスを作る。
 *
 * 理由: heading の id 衝突回避 (uniqueSlug) のために `usedIds` Set を
 * このインスタンス内のクロージャに閉じ込める必要があるため。
 * 単一の marked を使い回すと、過去のレンダリングで作った id 集合が
 * 残り続けて新しい文書でも `id-1`, `id-2`... と無駄にカウントが進む。
 */
function createMarked(): Marked {
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
 */
export async function renderMarkdown(source: string): Promise<string> {
  const { body, entries } = parseFrontmatter(source);
  const fmHtml = renderFrontmatter(entries);
  const marked = createMarked();
  const bodyHtml = await marked.parse(body);
  return fmHtml + bodyHtml;
}
