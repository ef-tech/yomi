/**
 * スキャン・監視で無視するディレクトリ名 (再帰的に該当する全要素を除外)。
 *
 * **入れる基準は「中身が Markdown の読み物でない」こと**で、更新が多いかどうかではない。
 * 並んでいるのはビルド生成物・依存・キャッシュ・エディタ設定で、いずれも人が yomi で
 * 読む対象ではない。監視コストが下がるのは結果であって目的ではない。
 *
 * **`.ef` は入れない (Issue #91)。** ef-devkit の作業ディレクトリで作成・削除が激しく、
 * #89 で応答しなくなったプロセスが `.ef/verify` 配下の fd を掴んでいたため候補に挙がったが、
 * 次の 2 点から除外しないと判断した:
 *
 * 1. **`.ef/verify/issue-N/REPORT.md` は yomi で読むために書かれている。** 除外すると、
 *    読ませたい動作確認レポートがツリーから消える (上の「読み物でない」基準に反する)
 * 2. **churn が原因という裏付けが取れていない。** `.ef/` 相当の作成/削除を人工的に
 *    再現し、churn のみで 15,375 サイクル、WebSocket クライアント 6 本を足して 33,800 サイクル
 *    回しても、メインスレッドは `ep_poll` のままで応答も 1〜12ms を保った。
 *    根拠のない対症療法で読めるものを減らすほうが損失が大きい
 *
 * 個別に外したい利用者は `.yomiignore` に書けばよい (README「除外パターンのカスタマイズ」)。
 */
export const DEFAULT_EXCLUDES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  ".nyc_output",
  "vendor",
  ".bun",
  ".turbo",
  ".vercel",
  ".idea",
  ".vscode",
]);

/**
 * 与えられた相対パスのいずれかのセグメントが excludes に含まれていれば true。
 * 単一名 (例: "node_modules") にも複数セグメント (例: "a/.git/HEAD") にも対応。
 */
export function isExcludedPath(
  relOrName: string,
  excludes: ReadonlySet<string> = DEFAULT_EXCLUDES,
): boolean {
  return relOrName.split("/").some((seg) => excludes.has(seg));
}
