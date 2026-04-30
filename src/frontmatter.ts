import { escapeHtml } from "./util/html.ts";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface FrontmatterEntry {
  key: string;
  value: string;
  /** ネスト下の子要素 (1 段階のみ対応) */
  children?: FrontmatterEntry[];
}

export interface ParsedFrontmatter {
  /** フロントマターを除いた本文 */
  body: string;
  /** トップレベルのキー一覧 (空配列 = フロントマターなし) */
  entries: FrontmatterEntry[];
}

/**
 * 先頭の YAML フロントマター (--- ... ---) を切り出す。
 * 厳密な YAML パーサではなく、key: value の単純な行のみ抽出する。
 */
export function parseFrontmatter(source: string): ParsedFrontmatter {
  const match = source.match(FRONTMATTER_RE);
  if (!match) return { body: source, entries: [] };

  const raw = match[1] ?? "";
  const lines = raw.split(/\r?\n/);
  const entries: FrontmatterEntry[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.trim().startsWith("#")) continue; // YAML コメント
    const indent = line.length - line.trimStart().length;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key) continue;

    if (indent === 0) {
      entries.push({ key, value });
    } else {
      const parent = entries[entries.length - 1];
      if (!parent) continue;
      if (!parent.children) parent.children = [];
      parent.children.push({ key, value });
    }
  }

  return { body: source.slice(match[0].length), entries };
}

function renderValue(value: string): string {
  let v = value;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (!v) return "";
  if (/^https?:\/\/\S+$/.test(v)) {
    return `<a href="${escapeHtml(v)}" target="_blank" rel="noopener">${escapeHtml(v)}</a>`;
  }
  return escapeHtml(v);
}

/** entries を <dl class="frontmatter"> として整形 (空なら空文字) */
export function renderFrontmatter(entries: FrontmatterEntry[]): string {
  if (entries.length === 0) return "";
  const rows: string[] = [];
  for (const e of entries) {
    if (e.value) {
      rows.push(`<dt>${escapeHtml(e.key)}</dt><dd>${renderValue(e.value)}</dd>`);
      continue;
    }
    if (e.children && e.children.length > 0) {
      const inner = e.children
        .map(
          (c) =>
            `<span class="fm-pair"><span class="fm-k">${escapeHtml(c.key)}</span>: <span class="fm-v">${renderValue(c.value)}</span></span>`,
        )
        .join("");
      rows.push(`<dt>${escapeHtml(e.key)}</dt><dd class="fm-nested">${inner}</dd>`);
    }
  }
  if (rows.length === 0) return "";
  return `<dl class="frontmatter">${rows.join("")}</dl>\n`;
}
