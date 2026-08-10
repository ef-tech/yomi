import { randomBytes } from "node:crypto";
import { chmod, rename as fsRename, open, rm, stat } from "node:fs/promises";

/**
 * 一時ファイルへ書いてから rename する、原子的なファイル書き込み (Issue #101)。
 *
 * `writeFile` は `O_TRUNC` でファイルを開いてから書くので、**truncate 後・write 完了前に
 * プロセスが落ちると内容が失われる**（空や途中までのファイルが残る）。Markdown を書き戻す
 * 経路 (`POST /api/file`) とレジストリの記録 (`saveInstance`) は、どちらもそれが起きると
 * 利用者の資産を壊すので、**同じ答えを 1 箇所に置く**。
 *
 * ## 保証する範囲
 *
 * **プロセスの異常終了まで**（SIGKILL を含む）。書き終わった temp を rename で差し替えるので、
 * どの時点で落ちても対象は「元の内容」か「新しい内容」のどちらかになる。
 *
 * **電源断・カーネルパニックは対象外。** `fsync` していないため、rename 後でも
 * ページキャッシュ上の内容がディスクに届いていない窓が残る。保存のたびに数 ms〜数十 ms の
 * コストが乗るので、必要になったら費用対効果を測って別途入れる。
 *
 * ## 副作用（inode が変わること）
 *
 * rename は**別の inode で差し替える**ので、次のものは影響を受ける:
 *
 * - **ハードリンク**が切れる。リンクの片方だけが更新され、もう片方は古い内容で残る
 * - **開いている fd** は古い内容を見続ける
 * - **ファイル監視**が inode ベースなら追随しない。chokidar は「既存ファイルへの rename」で
 *   `change` を発火しない（実測）ため、上書き保存では watcher イベントが飛ばない
 *
 * モード（パーミッション）は**明示的に引き継ぐ** —— 引き継がないと、新規 inode が umask
 * 既定で作られるので **0600 のファイルが保存のたびに 0664 へ緩む**（実測）。
 * 所有者は非特権では引き継げないため、対象が別ユーザ所有のときは呼び出し元の所有になる。
 *
 * @param target 書き込み先
 * @param data 書き込む内容
 * @param rename `fs.rename` 相当。**テストから差し替えて EXDEV / EACCES を再現する**ための
 *   注入点で、既定は本番実装そのもの (`src/network.ts` の `readInterfaces` と同じ作法)
 */
export async function writeFileAtomic(
  target: string,
  data: Buffer | string,
  rename: typeof fsRename = fsRename,
): Promise<void> {
  // **同じディレクトリに置く。** `rename` が原子的なのは同一ファイルシステム内だけで、
  // `/tmp` に置くとマウントが分かれている環境で EXDEV になる。
  // **拡張子は `.tmp`** —— watcher は Markdown 拡張子で絞っているので、一時ファイルの
  // 作成・削除でイベントが飛ばない。
  // **名前は暗号学的乱数**。`Math.random()` だと予測できるので、他ユーザも書けるディレクトリで
  // 先回りして symlink を置かれる余地が残る。
  const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;

  try {
    // **`wx` で開く** (`O_CREAT|O_EXCL`)。既存ファイルや symlink があれば EEXIST で弾く ——
    // `writeFile` の既定 (`w` = `O_CREAT|O_TRUNC`) は**リンクを追って書き込んでしまう**。
    // `handleFileCreate` が同じ理由で `wx` を使っているのに揃える。
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }

    // **元のモードを引き継ぐ。** 対象が無ければ新規作成なので何もしない（既定のまま）
    const mode = await stat(target)
      .then((s) => s.mode & 0o7777)
      .catch(() => null);
    if (mode !== null) await chmod(temp, mode);

    await rename(temp, target);
  } catch (err) {
    // **後始末の失敗で原因を隠さない。** `rm` は `force: true` でも EACCES 等では throw するので、
    // 独立した try で包む（包まないと本来のエラーが失われ、しかも temp が残る）
    try {
      await rm(temp, { force: true });
    } catch {
      /* 残骸を消せなくても、元のエラーを伝えるほうが優先 */
    }
    throw err;
  }
}
