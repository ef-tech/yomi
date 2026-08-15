/**
 * 「yomi のツリーに載せて開けるファイル」の判定 (Issue #155)。
 *
 * `scanner.ts`（ツリーに載せる）と `watcher.ts`（変更を通知する）が**同じ集合**を見るための
 * 1 か所。片方だけ広げると、**ツリーに出るのにライブリロードされない**（またはその逆）という
 * ちぐはぐが生まれるので、両者はここだけを参照する。
 *
 * 中身は Markdown（レンダリングして見せる）とテキスト（raw を読み取り専用で見せる）の和。
 * **どちらとして扱うかは呼び出し側が決める** —— この関数が答えるのは「載せるかどうか」だけで、
 * 表示の分岐は `src/server.ts` の `handleFileRead` が `textLanguageOf` を引いて行う。
 */
import { isMarkdownExtension } from "./markdown-ext.ts";
import { isTextExtension } from "./text-ext.ts";

/** ツリーに載せて `/api/file` で開けるファイルか（Markdown またはテキスト）。 */
export function isViewableFile(nameOrPath: string): boolean {
  return isMarkdownExtension(nameOrPath) || isTextExtension(nameOrPath);
}
