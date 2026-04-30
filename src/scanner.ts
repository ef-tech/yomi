import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const DEFAULT_EXCLUDES = new Set<string>([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  ".nyc_output",
  "vendor",
  ".bun",
  ".turbo",
  ".vercel",
  ".idea",
  ".vscode",
]);

export const MD_EXTENSIONS = new Set<string>([".md", ".markdown", ".mdx"]);

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
}

function isMarkdown(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return MD_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

export interface ScanOptions {
  excludes?: Set<string>;
  followSymlinks?: boolean;
}

export async function scanMarkdownTree(
  root: string,
  options: ScanOptions = {},
): Promise<TreeNode> {
  const excludes = options.excludes ?? DEFAULT_EXCLUDES;
  const followSymlinks = options.followSymlinks ?? false;
  const rootNode: TreeNode = {
    name: ".",
    path: "",
    type: "dir",
    children: [],
  };
  await walk(root, root, rootNode, excludes, followSymlinks);
  pruneEmpty(rootNode);
  sortTree(rootNode);
  return rootNode;
}

async function walk(
  root: string,
  current: string,
  parent: TreeNode,
  excludes: Set<string>,
  followSymlinks: boolean,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") && excludes.has(entry.name)) continue;
    if (excludes.has(entry.name)) continue;

    const absPath = join(current, entry.name);
    const relPath = toPosix(relative(root, absPath));

    if (entry.isSymbolicLink() && !followSymlinks) continue;

    if (entry.isDirectory()) {
      const dirNode: TreeNode = {
        name: entry.name,
        path: relPath,
        type: "dir",
        children: [],
      };
      parent.children!.push(dirNode);
      await walk(root, absPath, dirNode, excludes, followSymlinks);
    } else if (entry.isFile() && isMarkdown(entry.name)) {
      parent.children!.push({
        name: entry.name,
        path: relPath,
        type: "file",
      });
    }
  }
}

function pruneEmpty(node: TreeNode): boolean {
  if (node.type === "file") return true;
  const kept: TreeNode[] = [];
  for (const child of node.children ?? []) {
    if (pruneEmpty(child)) kept.push(child);
  }
  node.children = kept;
  return kept.length > 0 || node.path === "";
}

function sortTree(node: TreeNode): void {
  if (!node.children) return;
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) sortTree(child);
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}
