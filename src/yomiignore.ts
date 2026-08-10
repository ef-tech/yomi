import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_EXCLUDES } from "./util/excludes.ts";

export const YOMIIGNORE_FILENAME = ".yomiignore";

/**
 * `.yomiignore` のパース結果。
 *
 * `excludes` と `negations` を分けて返すのは、**合成の順序を呼び出し側が決められるように**するため。
 * 「既定 + 追加 → 否定を引く」の 2 段にしないと、`DEFAULT_EXCLUDES` を解除できない
 * (Issue #97。`bin/yomi.ts` の `resolveExcludes` がその合成を持つ)。
 */
export interface YomiignoreParseResult {
  /** 除外に追加する名前 */
  excludes: Set<string>;
  /** 除外から取り除く名前 (`!name`)。既定・追加のどちらにも効く */
  negations: Set<string>;
  /** 照合できないため無視した行 (警告用) */
  invalid: InvalidYomiignoreLine[];
}

export interface InvalidYomiignoreLine {
  /** 1 始まりの行番号 (利用者が直す場所を指すため) */
  line: number;
  /** トリム後の元テキスト */
  text: string;
  reason: InvalidReason;
}

export type InvalidReason = "path-separator" | "glob" | "empty-negation";

/**
 * 照合できない行かどうかを判定する。
 *
 * **`isExcludedPath` はセグメントの完全一致でしか照合しない**ので、`/` や `*` を含む行は
 * どのセグメントにも一致せず**黙って無効**になる。ツリー表示だけの設定だった頃は実害が
 * 小さかったが、Issue #65 で読み書きの可否を決めるようになったため、
 * **「書いたのに効いていない」を黙って通すのは危ない** (除外したつもりのファイルが読める)。
 */
function classifyInvalid(name: string): InvalidReason | null {
  if (name.includes("/")) return "path-separator";
  if (/[*?[\]]/.test(name)) return "glob";
  return null;
}

/**
 * `.yomiignore` の中身をパースする。
 *
 * 書式:
 * - 1 行 1 パターン。セグメント名の完全一致で照合する (グロブは未対応)
 * - 先頭が `#` の行はコメント、空行は無視
 * - 前後の空白はトリム
 * - **先頭が `!` の行は否定** —— その名前を除外集合から取り除く (Issue #97)
 * - `\!` で始めると、`!` から始まる名前そのものを除外できる (エスケープ)
 *
 * **照合できない行は捨てて `invalid` に積む。** 呼び出し側が起動時に警告を出す。
 */
export function parseYomiignore(text: string): YomiignoreParseResult {
  const excludes = new Set<string>();
  const negations = new Set<string>();
  const invalid: InvalidYomiignoreLine[] = [];

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("#")) return;

    const isNegation = trimmed.startsWith("!");
    // `\!foo` は「`!foo` という名前」を指す。`!` を先頭に持つファイル名は稀だが、
    // 否定記法を足したことで**書けなくなる**のは避ける (後方互換の逃げ道)
    const name = isNegation ? trimmed.slice(1).trim() : trimmed.replace(/^\\!/, "!");

    if (isNegation && !name) {
      invalid.push({ line: index + 1, text: trimmed, reason: "empty-negation" });
      return;
    }
    const reason = classifyInvalid(name);
    if (reason) {
      invalid.push({ line: index + 1, text: trimmed, reason });
      return;
    }
    (isNegation ? negations : excludes).add(name);
  });

  return { excludes, negations, invalid };
}

/**
 * 指定ディレクトリ直下の `.yomiignore` を読み込む。
 * ファイルが存在しない、読めない場合は空の結果。
 */
export async function loadYomiignore(rootDir: string): Promise<YomiignoreParseResult> {
  try {
    const text = await readFile(join(rootDir, YOMIIGNORE_FILENAME), "utf-8");
    return parseYomiignore(text);
  } catch {
    return { excludes: new Set(), negations: new Set(), invalid: [] };
  }
}

/** 無効行の警告文を組み立てる (起動時に stderr へ出す)。 */
export function describeInvalidLines(invalid: readonly InvalidYomiignoreLine[]): string {
  const reasonText: Record<InvalidReason, string> = {
    "path-separator": "`/` を含む行は照合できません (セグメント名のみ指定できます)",
    glob: "グロブ (`*` `?` `[]`) は未対応です",
    "empty-negation": "`!` の後ろに名前がありません",
  };
  const lines = invalid.map(
    (v) => `  ${YOMIIGNORE_FILENAME}:${v.line}: ${v.text} — ${reasonText[v.reason]}`,
  );
  return `警告: .yomiignore に無視した行があります (${invalid.length} 件)\n${lines.join("\n")}`;
}

/**
 * 実効の除外集合を組み立てる (Issue #97)。
 *
 * **「既定 + 追加」を作ってから否定を引く 2 段**にする。和集合だけだと
 * `DEFAULT_EXCLUDES` を解除する手段が無く、Issue #65 で除外が読み書きの拒否にも
 * 使われるようになった結果、`build/` や `vendor/` に置いた md・画像へ到達できなくなった
 * 利用者に退避弁が無くなっていた。
 *
 * **適用順は「和集合 → 減算」に固定する。** これにより:
 * - 否定は `DEFAULT_EXCLUDES` にも `.yomiignore` の追加行にも等しく効く
 * - 同じ名前を `foo` と `!foo` の両方で書いたら**否定が勝つ**（行の順序に依存しない）
 *
 * 順序を「行順に適用」にすると、`.yomiignore` の書き順で結果が変わり、
 * 「なぜ効かないのか」が読み取れなくなる。
 */
export function resolveExcludes(
  parsed: YomiignoreParseResult,
  defaults: ReadonlySet<string> = DEFAULT_EXCLUDES,
): Set<string> {
  const excludes = new Set([...defaults, ...parsed.excludes]);
  for (const name of parsed.negations) excludes.delete(name);
  return excludes;
}
