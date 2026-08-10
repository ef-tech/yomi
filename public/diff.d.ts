/**
 * Type declarations for public/diff.js (browser ES module).
 *
 * これにより tests/diff.test.ts から型安全に import できる。
 * 実装は public/diff.js 側にある (yomi はビルドステップなしでブラウザに直接配る
 * 哲学なので、ソースは .js のまま)。
 */

export type DiffRowType = "equal" | "del" | "add";

export interface DiffRow {
  type: DiffRowType;
  text: string;
  /** ローカル側の行番号 (1 始まり)。サーバにしかない行なら null */
  leftNo: number | null;
  /** サーバ側の行番号 (1 始まり)。ローカルにしかない行なら null */
  rightNo: number | null;
}

/** 畳んだ同一行のかたまり。 */
export interface DiffSkip {
  type: "skip";
  count: number;
}

export interface DiffResult {
  /** `truncated` なら空 */
  rows: DiffRow[];
  /** 上限を超えて計算を諦めたか */
  truncated: boolean;
  /** 諦めた理由。計算できたなら null */
  reason: "lines" | "bytes" | null;
  stats: { added: number; removed: number };
}

/** 差分を計算する上限 (トリム後の行数)。 */
export declare const MAX_DIFF_LINES: number;

/** 差分を計算する上限 (片側のバイト数)。 */
export declare const MAX_DIFF_BYTES: number;

/** ローカルとサーバの行差分を作る。上限を超えたら `truncated` で諦める。 */
export declare function diffLines(
  localText: string,
  serverText: string,
  options?: { maxLines?: number; maxBytes?: number },
): DiffResult;

/** 変更の前後 `context` 行だけを残し、離れた同一行を `skip` に畳む。 */
export declare function collapseUnchanged(
  rows: DiffRow[],
  context?: number,
): (DiffRow | DiffSkip)[];
