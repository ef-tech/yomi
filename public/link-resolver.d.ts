/**
 * Type declarations for public/link-resolver.js (browser ES module).
 *
 * これにより tests/util/link-resolver.test.ts から型安全に import できる。
 * 実装は public/link-resolver.js 側にある (yomi はビルドステップなしで
 * ブラウザに直接配る哲学なので、ソースは .js のまま)。
 */

export declare function isAnchor(href: string): boolean;
export declare function isExternalUrl(href: string): boolean;
export declare function isJavascriptUrl(href: string): boolean;
export declare function isUnsafeScheme(href: string): boolean;
export declare function isSafeImageHref(href: string): boolean;
export declare function hasScheme(href: string): boolean;
export declare function splitHrefHash(href: string): { path: string; hash: string | null };
export declare function resolveRelativePath(currentPath: string, href: string): string;
