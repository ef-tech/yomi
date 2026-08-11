import { randomBytes } from "node:crypto";
import { chmod, rename as fsRename, open, rm, stat } from "node:fs/promises";

/**
 * 一時ファイルの作成から `rename` までに空ける間隔 (Issue #119)。
 *
 * **実測の境界は 1ms と 2ms のあいだ**（`scripts/probe-watcher-atomic.ts`）。
 * 境界ぎりぎりに置くと、負荷や FS が変わったときに黙って取りこぼしへ戻るので
 * **余裕を持たせて 5ms** にしてある。
 *
 * **この値は chokidar の実装依存**で、版が変われば変わりうる。
 * `tests/watcher.test.ts` の発火率テストが、変わったときに落ちる。
 */
export const WATCH_GAP_MS = 5;

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

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
 * ## ファイル監視がこの経路の上書きを取りこぼしていた (Issue #119)
 *
 * **inode の差し替えとは別の問題。** 効くのは **write と rename の間隔**で、
 * 空けないと **chokidar が対象ファイルのイベントを 1 件も出さない**
 * （`change` だけでなく `add` も来ないので、ツリー再取得でも拾われない）。
 *
 * 自分の保存は `saveMark` が抑止するので実害はないが、**同じディレクトリを開いた
 * 別インスタンス**には届かず、編集が反映されないままになる。
 *
 * **{@link WATCH_GAP_MS} だけ待って解消した。** watcher 側で直そうとすると
 * `usePolling` しかなく（`atomic: false` / `alwaysStat` / `awaitWriteFinish` は
 * いずれも改善しないことを実測）、ポーリングは**アイドル時の CPU が 5,000 ファイルで
 * 7 倍**になる。**保存 1 回あたり数 ms** のほうが安い。
 *
 * **計測の正本は `scripts/probe-watcher-atomic.ts`。** 条件つきの表はそこの出力と
 * Issue #119 にあり、ここには載せない（3 か所に置くと必ず片方が古くなる ——
 * それがこの記述を 2 度書き直す羽目になった原因）。**数字を疑ったら回して測り直すこと。**
 *
 * **機構は未特定。** 分かっているのは「間隔を空ければ取りこぼさない」という観測だけで、
 * chokidar のどの仕組みが効いているかは検証していない。
 *
 * **残る限界: yomi 以外が同じ速さで temp + rename すると、やはり取りこぼす。**
 * 外部エディタは保存に要する時間から境界を優に超えると考えられるが、測っていない。
 *
 * @param target 書き込み先
 * @param data 書き込む内容
 * @param rename `fs.rename` 相当。**テストから差し替えて EXDEV / EACCES を再現する**ための
 *   注入点で、既定は本番実装そのもの (`src/network.ts` の `readInterfaces` と同じ作法)
 * @param gapMs rename の直前に空ける間隔。**テストから 0 にして取りこぼしを再現する**ための
 *   注入点で、既定は {@link WATCH_GAP_MS}
 */
export async function writeFileAtomic(
  target: string,
  data: Buffer | string,
  rename: typeof fsRename = fsRename,
  gapMs: number = WATCH_GAP_MS,
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

    // **rename の直前に待つ (Issue #119)。** 空けないと chokidar が対象ファイルの
    // イベントを 1 件も出さず、同じディレクトリを開いた別インスタンスに届かない
    await sleep(gapMs);
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
