/**
 * Type declarations for public/new-file.js (browser ES module).
 *
 * これにより tests/new-file.test.ts から型安全に import できる。
 * 実装は public/new-file.js 側にある (yomi はビルドステップなしで
 * ブラウザに直接配る哲学なので、ソースは .js のまま)。
 */

export declare function completeMarkdownFileName(input: string): string | null;
export declare function joinTreePath(dirPath: string, fileName: string): string;
