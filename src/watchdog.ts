/**
 * メインスレッドの停止を検知して自力でプロセスを終了させる watchdog (Issue #91)。
 *
 * ## なぜ要るか
 *
 * Issue #89 で、フォアグラウンドの yomi が**メインスレッドを `futex_do_wait` で寝かせたまま
 * event loop (`ep_poll`) に戻らない**状態に陥った。この状態では:
 *
 * - `accept()` が呼ばれないので接続が Recv-Q に溜まり、ブラウザから応答が返らない
 * - **`process.on("SIGINT")` / `("SIGTERM")` のハンドラも event loop から dispatch される**ため、
 *   Ctrl+C も `kill` も効かず、SIGKILL しか残らない
 *
 * 後者は実測で確認済み: メインスレッドを `Atomics.wait` で futex に落とした状態へ
 * SIGINT を 3 回・SIGTERM を 1 回送っても、いずれも dispatch されずプロセスは生き続けた
 * (`tests/watchdog.test.ts` が同じ手順を回帰テストとして固定している)。
 *
 * **根本原因は未特定のまま。** churn 仮説は 53 万サイクルの負荷試験でも再現せず否定された
 * (#91 のコメント)。この watchdog は原因を直すものではなく、**踏んだときに自力で抜ける**ための
 * 逃げ道である (Issue の DoD「起きても自力で復帰する」)。
 *
 * ## なぜ Worker なのか
 *
 * メインスレッドの event loop が止まっている以上、**メインスレッド上のどんな仕掛けも動かない**
 * (タイマーも Promise も signal ハンドラも event loop から dispatch されるため)。
 * Worker は独立したスレッドと event loop を持つので、メインスレッドが futex で寝ていても
 * 動き続ける。これも実測で確認している。
 *
 * ## 検知の仕組み
 *
 * メインスレッドが `SharedArrayBuffer` 上のタイムスタンプ (心拍) を定期更新し、Worker が
 * その古さを見る。閾値を超えたら stderr に理由を出して `SIGKILL` する。
 *
 * **SIGTERM ではなく SIGKILL を送る。** 上記のとおりブロック中は SIGTERM も dispatch されない
 * ので、graceful shutdown は原理的に不可能。レジストリの残骸は `yomi list` / `yomi down` の
 * 実行時に除去される (Issue #90) ので、停止手段そのものを失うよりは落とすほうがよい。
 */

/** 心拍を書く間隔。閾値に対して十分細かく、かつ無視できる負荷であること。 */
export const HEARTBEAT_INTERVAL_MS = 1_000;

/** Worker が心拍を見る間隔。 */
export const CHECK_INTERVAL_MS = 1_000;

/**
 * この時間だけ心拍が途切れたら「停止した」とみなす既定値。
 *
 * 健全な event loop は 1 秒間隔のタイマーを取りこぼさないので、60 秒の途絶は
 * 実質的に「戻ってこない」を意味する。長い同期処理での誤検知を避けるため、
 * 想定される最長の同期処理より一桁大きく取っている。
 */
export const DEFAULT_STALL_THRESHOLD_MS = 60_000;

/**
 * Worker 自身の tick 間隔がこの倍率を超えて延びたら、プロセス全体が凍結していた
 * (サスペンド / STOP シグナル / 極端な CPU 枯渇) とみなす。
 *
 * **これが無いとサスペンド復帰で健全なサーバを殺す。** ノート PC が 1 時間スリープすると
 * 壁時計は 1 時間進むが、その間メインスレッドも Worker も止まっているだけで異常ではない。
 * 復帰直後の心拍は「1 時間古い」ように見えるので、Worker 側の tick 遅延と突き合わせて
 * 見分ける必要がある。
 */
const FREEZE_TICK_FACTOR = 4;

/**
 * 凍結を検知した後、判定を再開するまでに空ける猶予。
 *
 * 復帰直後は Worker が先に tick してメインスレッドがまだ心拍を更新していないことがあり、
 * その 1 回を見て殺さないために置く。健全なら次の tick までに心拍が更新される。
 */
const RESUME_GRACE_MS = 5_000;

export interface WatchdogOptions {
  /** 心拍がこの時間途切れたら停止とみなす (既定: 60 秒)。テストから短縮する。 */
  stallThresholdMs?: number;
  /** 心拍を書く間隔 (既定: 1 秒)。テストから短縮する。 */
  heartbeatIntervalMs?: number;
  /** Worker が心拍を見る間隔 (既定: 1 秒)。テストから短縮する。 */
  checkIntervalMs?: number;
}

export interface WatchdogHandle {
  /** watchdog を止める (Worker を terminate し、心拍タイマーを解除する)。 */
  close(): void;
}

/**
 * Worker 側のソース。**文字列として埋め込む。**
 *
 * 別ファイルにすると `new Worker(new URL("./watchdog-worker.ts", import.meta.url))` の
 * 解決が実行形態 (リポジトリ直実行 / グローバル導入 / バンドル) に依存する。watchdog は
 * 「他が壊れているとき」に動く部品なので、**解決に失敗しうる書き方をしない**。
 */
function workerSource(): string {
  return `
import { readdirSync, readFileSync } from "node:fs";

const FREEZE_TICK_FACTOR = ${FREEZE_TICK_FACTOR};
const RESUME_GRACE_MS = ${RESUME_GRACE_MS};

/**
 * 落とす前にスレッドの状態を採る (Issue #91)。
 *
 * **SIGKILL すると原因を追う材料が消える。** #91 の根本原因は未特定で、手がかりは
 * 「どのスレッドがどこで待っているか」しかない。次に踏んだ人が報告できるよう、
 * 殺す直前に /proc から wchan を読む。Linux 以外や読めない環境では黙って諦める
 * (診断が採れないことを理由に復旧を止めない)。
 */
function threadSnapshot() {
  try {
    const dir = "/proc/self/task";
    return readdirSync(dir).map((tid) => {
      const read = (name) => {
        try {
          return readFileSync(dir + "/" + tid + "/" + name, "utf8").trim();
        } catch {
          return "?";
        }
      };
      return "    tid=" + tid + " comm=" + read("comm") + " wchan=" + read("wchan");
    });
  } catch {
    return [];
  }
}

self.onmessage = (event) => {
  const { buffer, stallThresholdMs, checkIntervalMs } = event.data;
  const beat = new BigInt64Array(buffer);
  let lastTick = Date.now();
  let graceUntil = 0;

  const timer = setInterval(() => {
    const now = Date.now();
    const tickDelta = now - lastTick;
    lastTick = now;

    // プロセスごと凍結していた (サスペンド等) なら心拍の古さは当てにならない。
    // 判定を猶予期間だけ止め、メインスレッドが心拍を打ち直す機会を与える。
    if (tickDelta > checkIntervalMs * FREEZE_TICK_FACTOR) {
      graceUntil = now + RESUME_GRACE_MS;
      return;
    }
    if (now < graceUntil) return;

    const last = Number(Atomics.load(beat, 0));
    if (last === 0) return;              // まだ 1 度も心拍が打たれていない
    const age = now - last;
    if (age <= stallThresholdMs) return;

    clearInterval(timer);
    // stderr に出す。**落とす理由と診断材料を残さずに殺さない。**
    const threads = threadSnapshot();
    const diag = threads.length > 0
      ? "\\n  スレッドの状態 (この情報が原因究明の手がかりになります):\\n" + threads.join("\\n")
      : "";
    console.error(
      "\\nyomi: メインスレッドが " + Math.round(age / 1000) + " 秒間応答していません。\\n" +
      "  event loop が停止しており、Ctrl+C も kill も効かない状態です (Issue #91)。\\n" +
      "  復旧のためプロセスを強制終了します。再起動してください。\\n" +
      "  稼働時間: " + Math.round(process.uptime()) + " 秒\\n" +
      "  この状態を踏んだことを https://github.com/ef-tech/yomi/issues/91 に報告してもらえると助かります。" +
      diag
    );
    process.kill(process.pid, "SIGKILL");
  }, checkIntervalMs);
};
`;
}

/**
 * watchdog を起動する。
 *
 * **プロセスの生存を延ばさない。** Worker も心拍タイマーも `unref()` するので、
 * 本来の仕事 (サーバ) が終わればプロセスは通常どおり終了する。
 *
 * **起動に失敗しても例外を投げない。** watchdog は保険であって主機能ではないので、
 * Worker が作れない環境 (SharedArrayBuffer 不可等) では警告だけ出して無効化する。
 */
export function startWatchdog(options: WatchdogOptions = {}): WatchdogHandle {
  const stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const checkIntervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS;

  let worker: Worker | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let objectUrl: string | null = null;

  try {
    const buffer = new SharedArrayBuffer(8);
    const beat = new BigInt64Array(buffer);
    Atomics.store(beat, 0, BigInt(Date.now()));

    objectUrl = URL.createObjectURL(new Blob([workerSource()], { type: "application/javascript" }));
    worker = new Worker(objectUrl);
    worker.postMessage({ buffer, stallThresholdMs, checkIntervalMs });

    timer = setInterval(() => {
      Atomics.store(beat, 0, BigInt(Date.now()));
    }, heartbeatIntervalMs);

    // 主機能が終わったらプロセスを終わらせる (watchdog が居座らない)
    timer.unref?.();
    (worker as unknown as { unref?: () => void }).unref?.();
  } catch (err) {
    console.warn(
      `警告: 応答監視 (watchdog) を開始できませんでした (${(err as Error).message})。` +
        "\n  yomi の動作には影響しませんが、event loop が停止した場合の自動復旧は働きません",
    );
    return { close() {} };
  }

  return {
    close() {
      if (timer) clearInterval(timer);
      timer = null;
      void worker?.terminate();
      worker = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    },
  };
}
