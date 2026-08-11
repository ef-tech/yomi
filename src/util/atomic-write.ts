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
 * - **ファイル監視**が inode ベースなら追随しない（`fs.watch(file)` は inotify watch を
 *   inode に張るので、差し替えられると古いほうを見続ける）。chokidar は inode の変化を見て
 *   watch を張り直す (`node_modules/chokidar/handler.js` の `prevStats.ino !== newStats.ino`)
 *
 * モード（パーミッション）は**明示的に引き継ぐ** —— 引き継がないと、新規 inode が umask
 * 既定で作られるので **0600 のファイルが保存のたびに 0664 へ緩む**（実測）。
 * 所有者は非特権では引き継げないため、対象が別ユーザ所有のときは呼び出し元の所有になる。
 *
 * ## ファイル監視がこの経路の上書きを取りこぼす (Issue #119)
 *
 * **inode の差し替えとは別の問題。** 効くのは **write と rename の間隔**で、
 * 空ければ取りこぼさない。**この関数は間を空けないので 5 回に 4 回ほど届かない**
 * （計測では 80 回中 15 回しか発火せず、間隔 2ms 以上は 80/80 発火した）。
 * 届かなかった試行には `change` だけでなく**どのイベントも来ていない**ので、
 * ツリー再取得 (`add`) で拾われることもない。
 * **0〜1ms 付近は実行ごとのばらつきが大きい**（20 回中 0〜8 回）ので、
 * 個々の率より「2ms 空ければ安定する」という境界のほうが再現性が高い。
 *
 * **計測の正本は `scripts/probe-watcher-atomic.ts`。** 条件つきの表はそこの出力と
 * Issue #119 にあり、ここには載せない（3 か所に置くと必ず片方が古くなる ——
 * それがこの記述を 2 度書き直す羽目になった原因）。**数字を疑ったら回して測り直すこと。**
 *
 * **機構は未特定。** chokidar 5 はファイル単位の watch リスナに 5ms のスロットルを持つが
 * (`handler.js` の `_throttle(THROTTLE_MODE_WATCH, file, 5)`)、これが原因かは検証していない。
 * **いずれにせよ閾値は chokidar の実装依存**で、版が変われば変わりうる。
 *
 * **測っていないこと**（断定しないための明示）:
 *
 * - **外部エディタ（vim / VSCode 等）は未測定。** 保存に要する時間から境界の 2ms は
 *   優に超えると考えられるが、確かめていない。そもそも保存方式が違う（原本を退避して
 *   新規作成する方式は unlink + add になり、chokidar の `atomic` オプションの経路に乗る）
 * - **Linux / inotify のみ**（tmpfs と ext4 では同じ結果）。macOS（Node の `fs.watch` 経由で
 *   FSEvents）と Windows は未測定。このリポジトリは FSEvents に配信遅延・結合があることを
 *   別途記録している
 *
 * 自分の保存は `saveMark` が元々抑止しているので、実害は**同じディレクトリを開いた
 * 別インスタンスが取りこぼす**ことに限られる。**取りこぼしても監視が壊れたままにはならない**
 * （全部取りこぼした直後の直書きが 20/20 で届くことを確認済み）。解消は Issue #119 で扱う。
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
  // **拡張子は `.tmp`** —— yomi 側が Markdown 拡張子で絞る (`src/watcher.ts` の `emit`) ので、
  // 一時ファイルの作成・削除は `onChange` に出ない。**chokidar 自体は `.tmp` も監視している**
  // （chokidar 自身の temp 除外は `atomic` 既定時の `*.sw[px]` / `*~` / `.subl*.tmp` だけで、
  // この命名は当たらない）ので、上の「取りこぼし」の話とは層が違う。
  // **名前を変えるならその除外に当たらないか確かめること。**
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
