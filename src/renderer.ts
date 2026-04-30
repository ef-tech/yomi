import { Marked } from "marked";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

export async function renderMarkdown(source: string): Promise<string> {
  return await marked.parse(source);
}
