import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_EXCLUDES } from "./util/excludes.ts";

export const YOMIIGNORE_FILENAME = ".yomiignore";

/**
 * `.yomiignore` のパース結果。
 *
 * `excludes` と `negations` を分けて返すのは、**合成の順序を呼び出し側が決められるように**するため。
 * 「既定 + 追加 → 否定を引く」の 2 段にしないと、`DEFAULT_EXCLUDES` を解除できない
 * (Issue #97。下の `resolveExcludes` がその合成を持つ)。
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
  /**
   * その行を**捨てたか**。
   *
   * **`false` なら除外としては生きている。** グロブ文字を含む名前は「グロブとして解釈しない」
   * だけで、**名前そのものとの完全一致では当たる** —— `foo[1].md` のような名前は実在しうるので、
   * 捨てると**除外していたつもりのファイルが読めるようになる** (Issue #65 でゲート化した趣旨に
   * 逆行する fail-open)。照合そのものが成立しない `/` や空の否定だけを捨てる。
   */
  dropped: boolean;
}

export type InvalidReason = "path-separator" | "glob" | "empty-negation";

/**
 * 意図どおりに効かない可能性がある行を判定する。
 *
 * **`isExcludedPath` はセグメントの完全一致でしか照合しない** (`excludes.has(seg)`)。
 * Issue #65 で読み書きの可否を決めるようになったので、
 * **「書いたのに効いていない」を黙って通さない**。ただし扱いは 2 つに分かれる:
 *
 * | 種類 | 例 | 照合 | 扱い |
 * |---|---|---|---|
 * | `path-separator` | `docs/private` | **どのセグメントにも当たらない** | 捨てる |
 * | `glob` | `*.log` / `foo[1].md` | **名前そのものとしては当たりうる** | 残す + 警告 |
 *
 * **glob を捨ててはいけない。** `foo[1].md` や `[archive]` は実在しうる名前で、
 * これまで完全一致で除外できていた。捨てると除外が消えて**ファイルが読めるようになる**
 * (fail-open)。「グロブとして展開されない」ことだけを警告する。
 */
function classifyInvalid(name: string): InvalidReason | null {
  if (name.includes("/")) return "path-separator";
  if (/[*?[\]]/.test(name)) return "glob";
  return null;
}

/** その理由の行を捨てるか。**捨てるのは照合そのものが成立しないものだけ**。 */
function isDropped(reason: InvalidReason): boolean {
  return reason !== "glob";
}

/**
 * 先頭の `!` のエスケープを外す。
 *
 * **否定・非否定の両方に掛ける。** 片方だけだと、`\!foo` で足した除外 (名前 `!foo`) を
 * 否定で打ち消せなくなる —— `!\!foo` と書いても `\!` が残って一致しない。
 * 両方に掛ければ「否定は `!` を 1 つ剥がす」「`\!` は `!` そのもの」の 2 規則で閉じる
 * (`!\!foo` も `!!foo` も名前 `!foo` の否定になる)。
 */
function unescapeName(s: string): string {
  return s.replace(/^\\!/, "!");
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
 * **意図どおりに効かない行は `invalid` に積む。** 照合が成立しないもの (`/` を含む・空の否定)
 * だけを捨て、**グロブ文字を含む名前は除外として残す** (`dropped` で区別する)。
 * 呼び出し側が起動時に警告を出す。
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
    const name = unescapeName(isNegation ? trimmed.slice(1).trim() : trimmed);

    if (isNegation && !name) {
      invalid.push({ line: index + 1, text: trimmed, reason: "empty-negation", dropped: true });
      return;
    }
    const reason = classifyInvalid(name);
    if (reason) {
      const dropped = isDropped(reason);
      invalid.push({ line: index + 1, text: trimmed, reason, dropped });
      if (dropped) return;
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

/**
 * 意図どおりに効かない行の警告文を組み立てる (起動時に stderr へ出す)。
 *
 * **捨てた行と残した行を書き分ける。** 「無視しました」で一括りにすると、
 * グロブ文字を含む名前が**除外として生きている**ことが伝わらない。
 */
export function describeInvalidLines(invalid: readonly InvalidYomiignoreLine[]): string {
  const reasonText: Record<InvalidReason, string> = {
    "path-separator":
      "`/` を含む行は照合できません (セグメント名のみ指定できます)。この行は無視しました",
    glob: "グロブ (`*` `?` `[]`) は展開されません。この名前そのものとの完全一致として扱います",
    "empty-negation": "`!` の後ろに名前がありません。この行は無視しました",
  };
  const lines = invalid.map(
    (v) => `  ${YOMIIGNORE_FILENAME}:${v.line}: ${v.text} — ${reasonText[v.reason]}`,
  );
  const dropped = invalid.filter((v) => v.dropped).length;
  const kept = invalid.length - dropped;
  const counts = [dropped > 0 ? `無視 ${dropped} 件` : "", kept > 0 ? `注意 ${kept} 件` : ""]
    .filter(Boolean)
    .join(" / ");
  return `警告: .yomiignore に意図どおり効かない行があります (${counts})\n${lines.join("\n")}`;
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
