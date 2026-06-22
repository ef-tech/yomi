import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { DEFAULT_EXCLUDES, isExcludedPath } from "./util/excludes.ts";
import { isMarkdownExtension } from "./util/markdown-ext.ts";
import { toPosix } from "./util/path-util.ts";

export { DEFAULT_EXCLUDES };

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
}

export interface ScanOptions {
  excludes?: ReadonlySet<string>;
  followSymlinks?: boolean;
  /**
   * 走査するディレクトリ階層の上限 (Issue #44)。`tree -L <level>` と同義。
   * ルートを level 0 とし、その直下を level 1 と数える。
   * 1 ならルート直下のエントリのみ、未指定 (undefined) なら無制限 (現行動作)。
   * 境界 (= maxDepth) のディレクトリは中を見ずにノードだけ残す。
   */
  maxDepth?: number;
}

export async function scanMarkdownTree(root: string, options: ScanOptions = {}): Promise<TreeNode> {
  const excludes = options.excludes ?? DEFAULT_EXCLUDES;
  const followSymlinks = options.followSymlinks ?? false;
  const maxDepth = options.maxDepth;
  // 深さ境界で中を見ずに残したディレクトリ。pruneEmpty が空でも消さないよう記録する。
  const truncatedDirs = new WeakSet<TreeNode>();
  const rootNode: TreeNode = {
    name: ".",
    path: "",
    type: "dir",
    children: [],
  };
  await walk(root, root, rootNode, excludes, followSymlinks, 0, maxDepth, truncatedDirs);
  pruneEmpty(rootNode, truncatedDirs);
  sortTree(rootNode);
  return rootNode;
}

async function walk(
  root: string,
  current: string,
  parent: TreeNode,
  excludes: ReadonlySet<string>,
  followSymlinks: boolean,
  currentDepth: number,
  maxDepth: number | undefined,
  truncatedDirs: WeakSet<TreeNode>,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  const children = parent.children ?? [];

  for (const entry of entries) {
    if (isExcludedPath(entry.name, excludes)) continue;

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
      children.push(dirNode);
      const childDepth = currentDepth + 1;
      if (maxDepth === undefined || childDepth < maxDepth) {
        // まだ深さに余裕がある: 中まで走査する
        await walk(
          root,
          absPath,
          dirNode,
          excludes,
          followSymlinks,
          childDepth,
          maxDepth,
          truncatedDirs,
        );
      } else {
        // 深さ境界 (childDepth === maxDepth): 中は見ないが dir ノードは残す (tree -L 準拠)
        truncatedDirs.add(dirNode);
      }
    } else if (entry.isFile() && isMarkdownExtension(entry.name)) {
      children.push({
        name: entry.name,
        path: relPath,
        type: "file",
      });
    }
  }

  parent.children = children;
}

function pruneEmpty(node: TreeNode, truncatedDirs: WeakSet<TreeNode>): boolean {
  if (node.type === "file") return true;
  const kept: TreeNode[] = [];
  for (const child of node.children ?? []) {
    if (pruneEmpty(child, truncatedDirs)) kept.push(child);
  }
  node.children = kept;
  // 深さ境界で truncate した dir は、中を見ていない (= 深い md があるかもしれない) ので
  // 空でも残す。それ以外の本当に空の dir は従来どおり除去する。
  return kept.length > 0 || truncatedDirs.has(node) || node.path === "";
}

function sortTree(node: TreeNode): void {
  if (!node.children) return;
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) sortTree(child);
}
