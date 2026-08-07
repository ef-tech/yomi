/**
 * Type declarations for public/quick-open.js (browser ES module).
 *
 * これにより tests/quick-open.test.ts から型安全に import できる。
 * 実装は public/quick-open.js 側にある (yomi はビルドステップなしで
 * ブラウザに直接配る哲学なので、ソースは .js のまま)。
 */

export interface QuickOpenTreeNode {
  type: "file" | "dir";
  path: string;
  children?: QuickOpenTreeNode[];
}

export interface QuickOpenHit {
  /** ルートからの相対パス */
  path: string;
  /** `path` 上でクエリ文字が一致した位置 (ハイライト用)。クエリが空なら空配列 */
  positions: number[];
}

/** 候補として出す既定の最大件数。app.js と共有する (同じ値を 2 箇所に置かない)。 */
export declare const QUICK_OPEN_LIMIT: number;

/** ツリーからファイルの相対パスを document order で集める (ディレクトリは含まない)。 */
export declare function collectFilePaths(node: QuickOpenTreeNode): string[];

/** 部分列マッチで候補を絞り、ファイル名一致・密度・前方一致・パス長の順で並べる。 */
export declare function searchPaths(
  paths: string[],
  query: string,
  limit?: number,
): QuickOpenHit[];

/** 候補リスト内の選択位置を循環させて移動する。候補が無ければ -1。 */
export declare function moveSelection(current: number, delta: number, total: number): number;
