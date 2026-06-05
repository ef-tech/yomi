/**
 * Type declarations for public/tree-toolbar.js (browser ES module).
 *
 * これにより tests/tree-toolbar.test.ts から型安全に import できる。
 * 実装は public/tree-toolbar.js 側にある (yomi はビルドステップなしで
 * ブラウザに直接配る哲学なので、ソースは .js のまま)。
 */

export declare const ROOT_DIR: "";
export declare function expandAllDirs(dirPaths: Iterable<string>): Set<string>;
export declare function collapseAllDirs(): Set<string>;
export declare function isTreeToolbarEnabled(dirCount: number): boolean;
