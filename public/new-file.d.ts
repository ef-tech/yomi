/**
 * Type declarations for public/new-file.js (browser ES module).
 *
 * これにより tests/new-file.test.ts から型安全に import できる。
 * 実装は public/new-file.js 側にある (yomi はビルドステップなしで
 * ブラウザに直接配る哲学なので、ソースは .js のまま)。
 */

/** クライアント側で受け入れる Markdown 拡張子 (サーバの MD_EXTENSIONS と同値であるべき) */
export declare const MD_EXTENSIONS: ReadonlySet<string>;
export declare function completeMarkdownFileName(input: string): string | null;
export declare function joinTreePath(dirPath: string, fileName: string): string;
