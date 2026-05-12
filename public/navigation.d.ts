/**
 * Type declarations for public/navigation.js (browser ES module).
 *
 * link-resolver.d.ts と同じパターン: 実装は .js のまま、テストから型安全に import
 * するための宣言ファイル。
 */

export declare function getPathFromUrl(location?: { search: string } | null): string | null;
export declare function getHashFromUrl(location?: { hash: string } | null): string | null;
export declare function buildUrl(path: string | null | undefined, hash?: string | null): string;
export declare function nextNavIndex(): number;
export declare function currentNavIndex(): number;
export declare function seedNavCounter(from: number | null | undefined): void;
export declare function __resetNavCounterForTest(): void;
