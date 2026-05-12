/**
 * Type declarations for public/task-list.js (browser ES module).
 *
 * link-resolver.d.ts と同じパターン: 実装は .js のまま、テストから型安全に
 * import するための宣言ファイル。
 */

export declare function toggleTaskInMarkdown(
  body: string,
  index: number,
): { body: string; newChecked: boolean | null };

export declare function countTasksInMarkdown(body: string): number;
