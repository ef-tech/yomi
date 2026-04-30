import { sep } from "node:path";

/** プラットフォーム依存の区切り文字 (\\) を POSIX 風 (/) に正規化する */
export function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}
