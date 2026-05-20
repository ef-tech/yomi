/**
 * Type declarations for public/scroll-sync.js (browser ES module).
 *
 * これにより tests/util/scroll-sync.test.ts から型安全に import できる。
 * 実装は public/scroll-sync.js 側にある。
 */

export interface SyncPair {
  from: number;
  to: number;
}

export declare function findHeadingLines(sourceText: string): number[];
export declare function mapScrollTop(scrollTop: number, pairs: SyncPair[]): number;
