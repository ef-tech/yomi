import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { toPosix } from "./util/path-util.ts";

export { isMarkdownExtension as isMarkdownPath } from "./util/markdown-ext.ts";

export class UnsafePathError extends Error {
  constructor(
    public readonly requestedPath: string,
    message: string,
  ) {
    super(message);
    this.name = "UnsafePathError";
  }
}

export interface ResolvedPath {
  /**
   * rootDir からの**正規化された**相対パス (POSIX 区切り)。
   *
   * 除外判定・自己保存マーク (`saveMark`)・クライアントへ返す `path` はこれを使う。
   * **`abs` の文字列表現ではない** —— leaf が存在しないときの `abs` は要求の綴りを
   * 保つが、`rel` は**実在する祖先の realpath 由来**になる (Issue #98)。
   * 両者は同じエントリを指すが綴りが違いうる。
   *
   * 例: `link -> inner` があるとき `link/new.md` (未作成) は
   * `rel = "inner/new.md"` / `abs = ".../link/new.md"`。
   * `rel` が実体側に揃うことで、watcher が emit する名前や saveMark と一致する。
   */
  rel: string;
  /**
   * 実際にファイル読み取り・作成に使う絶対パス。
   *
   * **leaf が解決できたときは realpath 済み**（symlink も大小も正規化される）で、
   * **解決できなかったときだけ要求の綴りを保つ**（realpath が lexical fallback するため）。
   *
   * 「常に要求の綴りを保つ」と書いていたが誤りで、`resolveSafe` の親 realpath チェックが
   * 冗長かどうかの判断を難しくしていた（#118 のレビューで判明）。
   */
  abs: string;
}

export async function resolveSafe(rootDir: string, requested: string): Promise<ResolvedPath> {
  if (!requested) {
    throw new UnsafePathError(requested, "path が空です");
  }
  // NUL byte は Node の fs API で例外になり、その例外文字列がレスポンスに漏れる。
  // ここで早期に reject して 400 で揃える
  if (requested.includes("\0")) {
    throw new UnsafePathError(requested, "path に NUL byte が含まれます");
  }
  if (isAbsolute(requested)) {
    throw new UnsafePathError(requested, "絶対パスは指定できません");
  }
  if (requested.split(/[\\/]/).some((seg) => seg === "..")) {
    throw new UnsafePathError(requested, "親ディレクトリ参照 (..) は禁止です");
  }

  const rootAbs = await safeRealpath(rootDir);
  const requestedAbs = resolve(rootAbs, requested);
  const candidate = await safeRealpathWithFlag(requestedAbs);
  const candidateAbs = candidate.path;
  const resolved = candidate.resolved;
  const rel = relative(rootAbs, candidateAbs);

  // root 外の判定は `isOutsideRoot` に集約してある (Issue #118)
  if (isOutsideRoot(rel)) {
    throw new UnsafePathError(requested, "ルートディレクトリの外を参照しています");
  }

  // leaf が存在しないと realpath は candidateAbs を解決できず lexical fallback する。
  // その結果、root 内のシンボリックリンク先ディレクトリ (root 外を指す) を経由した
  // 新規ファイル作成を上の rel チェックだけでは検知できない。実在する親ディレクトリの
  // realpath を取り、ルート内に収まっているか再検証する (親は実在するので realpath で
  // symlink が解決される。親自体が存在しなければ呼び出し側の open が ENOENT で弾く)。
  //
  // 既知の限界 (TOCTOU): この realpath チェックと呼び出し側の open(abs) の間に、
  // 親ディレクトリを symlink にすり替えるレースは防げない。完全に塞ぐには各パス成分を
  // O_NOFOLLOW / openat(dirfd) で開く必要があるが、その攻撃にはローカル FS への書き込み
  // 権限が前提で (その攻撃者は既に直接ファイルを作れる)、ローカル/LAN 向けの本ツールには
  // 過剰なため対応しない。静的な symlink エスケープはこのチェックで防げる。
  const parentReal = await safeRealpath(dirname(requestedAbs));
  const parentRel = relative(rootAbs, parentReal);
  if (isOutsideRoot(parentRel)) {
    throw new UnsafePathError(requested, "ルートディレクトリの外を参照しています");
  }

  // **解決できなかったときは、実在する最深の祖先から rel を組み立て直す** (Issue #98)。
  //
  // 上の `rel` は realpath が失敗すると lexical fallback した `candidateAbs` 由来になり、
  // **要求の綴りをそのまま持つ**。これが存在オラクルになる:
  //
  // - `Private/secret.md` (実在)   → realpath が `private/secret.md` へ正規化 → 除外され 400
  // - `Private/nope.md`   (非実在) → 正規化されず `Private/nope.md` のまま → 通り抜けて 404
  //
  // **400 と 404 が分かれるので、綴りを変えるだけで除外配下の実在が分かる**
  // (Issue #65 が塞いだオラクルの復活。macOS の CI で実測した)。
  //
  // **大小の区別だけの話ではない。** 同じ形は symlink でも踏める ——
  // `alias -> private` があるとき `alias/sub/nope.md` は「`private/sub` が実在するか」で
  // 400 と 404 に分かれ、**除外配下のディレクトリ構成を列挙できる** (Linux で実証済み)。
  //
  // したがって **1 段だけでは足りない**。実在する祖先まで遡り、そこから先は要求の
  // セグメントを繋ぐ。`rootAbs` は必ず解決できるので走査は必ず止まる。
  const relResolved = resolved ? rel : await relFromDeepestReal(rootAbs, requestedAbs, requested);

  return { rel: toPosix(relResolved), abs: candidateAbs };
}

/**
 * 実在する最深の祖先の realpath に、残りの要求セグメントを繋いで rel を作る。
 *
 * `resolveSafe` が leaf を解決できなかったときだけ呼ぶ。**祖先の綴りが正規化される**ので、
 * 大小の違いや symlink があっても、実在・非実在で rel の形が変わらなくなる
 * (存在オラクルを塞ぐ。Issue #98)。
 *
 * 追加の `realpath` は解決に失敗した深さのぶんだけで、通常は 1〜2 回で止まる。
 */
async function relFromDeepestReal(
  rootAbs: string,
  requestedAbs: string,
  requested: string,
): Promise<string> {
  const tail: string[] = [];
  let cur = requestedAbs;

  for (;;) {
    const probe = await safeRealpathWithFlag(cur);
    if (probe.resolved) {
      const base = relative(rootAbs, probe.path);
      // **祖先が root 外を指していたら弾く。** 上の `parentRel` チェックと同じ判定を
      // 遡った先にも掛ける (深い階層の symlink エスケープを見逃さない)
      if (isOutsideRoot(base)) {
        throw new UnsafePathError(requested, "ルートディレクトリの外を参照しています");
      }
      tail.reverse();
      return join(base, ...tail);
    }
    // root まで遡っても解決できないことは無い (root は resolveSafe の冒頭で解決済み)
    if (cur === dirname(cur)) return relative(rootAbs, requestedAbs);
    tail.push(basename(cur));
    cur = dirname(cur);
  }
}

/**
 * root からの相対パスが**ルートの外**を指しているか (Issue #118)。
 *
 * **`startsWith("..")` では駄目。** `..cache` のような**通常のエントリ名**にも当たり、
 * root 内の正当なパスを弾いてしまう（実際に `..cache/x.md` が 400 になっていた）。
 * 親を辿っているのは、
 *
 * - `..` そのもの（= root の親）
 * - `../` で始まる（区切りまで見て初めて「親へ 1 つ上がった」と言える）
 * - そもそも絶対パス（`relative` が相対で表せなかった＝別のドライブ等）
 *
 * の 3 つだけ。**3 箇所で同じ判定を書き写していた**ので関数にした
 * （1 箇所だけ `startsWith("..")` のままで、作法が割れていた）。
 *
 * ## 区切り文字
 *
 * `..${sep}` に加えて **`../` も見る。** 呼び出し元はいまどれも `relative()` の
 * 生出力（ネイティブ区切り）だが、このモジュールは `toPosix` 済みの `rel` も
 * 公開しており、**Windows でそれを渡されると `..\` しか見ない実装は
 * fail-open する**（`../other` を「root 内」と判定する）。
 *
 * **逆に `..\` を無条件で足してはいけない** —— POSIX では `\` が合法な
 * ファイル名文字なので、`..\x.md` という正当な名前を弾いて #118 と同じバグを作る。
 * `/` は Windows でもファイル名に使えないので、こちらは足しても誤検知しない。
 *
 * ## `isAbsolute` は Windows 専用
 *
 * POSIX の `relative()` は絶対パスを返さない（両引数が絶対パスなので）。
 * 効くのは win32 の**別ドライブ**（`D:\x`）と **UNC**（`\\srv\share\x`）だけ。
 * **POSIX のテストでは落ちないが、消さないこと。**
 *
 * @param rel `relative(rootAbs, ...)` の結果、または `toPosix` 済みのそれ
 */
function isOutsideRoot(rel: string): boolean {
  return rel === ".." || rel.startsWith("../") || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * realpath を試し、失敗したら lexical に解決する。
 *
 * `resolved` は **realpath が成功したか**（＝返り値が正規化済みか）。**失敗理由は問わない** ——
 * ENOENT だけでなく EACCES / ELOOP / ENOTDIR でも `false` になる。呼び出し側はこれを
 * 「rel が正規形か」の判断にだけ使い、実在の有無の判定には使わない (Issue #98)。
 */
async function safeRealpathWithFlag(p: string): Promise<{ path: string; resolved: boolean }> {
  try {
    return { path: await realpath(p), resolved: true };
  } catch {
    return { path: resolve(p), resolved: false };
  }
}

async function safeRealpath(p: string): Promise<string> {
  return (await safeRealpathWithFlag(p)).path;
}
