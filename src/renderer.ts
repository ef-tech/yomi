import { Marked } from "marked";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.ts";
import { escapeHtml } from "./util/html.ts";

function createMarked(): Marked {
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
    },
  });

  return marked;
}

const marked = createMarked();

/**
 * Markdown ソースをレンダリングして HTML を返す。
 * 先頭の YAML フロントマターはメタデータカードとして整形し、本文の先頭に付加する。
 */
export async function renderMarkdown(source: string): Promise<string> {
  const { body, entries } = parseFrontmatter(source);
  const fmHtml = renderFrontmatter(entries);
  const bodyHtml = await marked.parse(body);
  return fmHtml + bodyHtml;
}
