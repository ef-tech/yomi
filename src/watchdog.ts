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
 *   Ctrl+C も `kill`(SIGTERM) も効かず、SIGKILL しか残らない
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
 * 動き続ける。実プロセスでも Worker スレッドが `ep_poll` のまま動くことを確認している。
 *
 * ## 検知の仕組み
 *
 * メインスレッドが `SharedArrayBuffer` 上のタイムスタンプ (心拍) を定期更新し、Worker が
 * その古さを見る。閾値を超えたら stderr に理由と診断情報を出して `SIGKILL` する。
 *
 * **SIGTERM ではなく SIGKILL を送る。** 上記のとおりブロック中は SIGTERM も dispatch されない
 * ので、graceful shutdown は原理的に不可能。レジストリの残骸は `yomi list` / `yomi down` の
 * 実行時に除去される (Issue #90) ので、停止手段そのものを失うよりは落とすほうがよい。
 *
 * ## 止めたいとき
 *
 * `YOMI_NO_WATCHDOG=1` で無効化、`YOMI_WATCHDOG_TIMEOUT_MS` で閾値を変更できる。
 * **根本原因が未特定である以上、この heuristic が全環境で正しく振る舞う保証はない。**
 * プロセスを強制終了する機能に無効化手段が無いのは可逆性の点で釣り合わないため、逃げ道を残す。
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
 * (サスペンド / SIGSTOP / 極端な CPU 枯渇 / 時刻の前方ジャンプ) とみなす。
 *
 * **これが無いとサスペンド復帰で健全なサーバを殺す。** ノート PC が 1 時間スリープすると
 * 壁時計は 1 時間進むが、その間メインスレッドも Worker も止まっているだけで異常ではない。
 * 復帰直後の心拍は「1 時間古い」ように見えるので、Worker 側の tick 遅延と突き合わせて
 * 見分ける必要がある。
 */
export const DEFAULT_FREEZE_TICK_FACTOR = 4;

/**
 * 凍結を検知した後、判定を再開するまでに空ける猶予。
 *
 * 復帰直後は Worker が先に tick してメインスレッドがまだ心拍を更新していないことがあり、
 * その 1 回を見て殺さないために置く。健全なら次の tick までに心拍が更新される。
 */
export const DEFAULT_RESUME_GRACE_MS = 5_000;

/** 無効化する環境変数。 */
export const DISABLE_ENV = "YOMI_NO_WATCHDOG";

/** 閾値 (ms) を上書きする環境変数。 */
export const TIMEOUT_ENV = "YOMI_WATCHDOG_TIMEOUT_MS";

/**
 * Worker の起動確認をこの時間待つ。
 *
 * `new Worker()` は非同期にロードするため、**Worker ソースの構文エラーは同期の try/catch では
 * 捕まらない**。握り潰すと「watchdog があるつもりで無い」状態になるので、起動の往復を取って
 * 届かなければ警告する。
 */
const READY_TIMEOUT_MS = 10_000;

export interface WatchdogOptions {
  /** 心拍がこの時間途切れたら停止とみなす (既定: 60 秒)。 */
  stallThresholdMs?: number;
  /** 心拍を書く間隔 (既定: 1 秒)。 */
  heartbeatIntervalMs?: number;
  /** Worker が心拍を見る間隔 (既定: 1 秒)。 */
  checkIntervalMs?: number;
  /** Worker の tick 遅延がこの倍率を超えたら凍結とみなす (既定: 4)。テスト専用。 */
  freezeTickFactor?: number;
  /** 凍結検知後、判定を再開するまでの猶予 (既定: 5 秒)。テスト専用。 */
  resumeGraceMs?: number;
  /** 環境変数による無効化・閾値上書きを無視する。テスト専用。 */
  ignoreEnv?: boolean;
}

export interface WatchdogHandle {
  /** watchdog を止める (Worker を terminate し、心拍タイマーを解除する)。 */
  close(): void;
  /** 監視が実際に動いているか (無効化・起動失敗なら false)。 */
  readonly enabled: boolean;
}

const NOOP_HANDLE: WatchdogHandle = { close() {}, enabled: false };

/**
 * Worker 側のソース。**文字列として埋め込む。**
 *
 * 別ファイルにすると `new Worker(new URL("./watchdog-worker.ts", import.meta.url))` の
 * 解決が実行形態 (リポジトリ直実行 / グローバル導入 / バンドル) に依存する。watchdog は
 * 「他が壊れているとき」に動く部品なので、**解決に失敗しうる書き方をしない**。
 *
 * 代償として型検査もリントも効かないため、`tests/watchdog.test.ts` が**実際に発火させて**
 * 動作を担保している (構文エラーは起動確認の往復が拾う)。
 */
const WORKER_SOURCE = String.raw`
import { readdirSync, readFileSync } from "node:fs";

/**
 * 落とす前にスレッドの状態を採る (Issue #91)。
 *
 * **SIGKILL すると原因を追う材料が消える。** #91 の根本原因は未特定で、手がかりは
 * 「どのスレッドがどこで待っているか」しかない。Linux 以外や読めない環境では黙って諦める
 * (診断が採れないことを理由に復旧を止めない)。
 *
 * **メインスレッドに印を付ける。** Bun の worker スレッドは平常時から全部 futex_do_wait に
 * いるので、印が無いと「どれが異常か」が読み取れない (Linux では tid === pid がメイン)。
 */
function threadSnapshot(pid) {
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
      // /proc/<tid>/stat の 3 番目が状態 (R=実行中 / S=割込み可能待ち / D=割込み不可 I/O 待ち)。
      // comm に空白や括弧が入りうるので、最後の ")" より後ろを見る。
      let state = "?";
      try {
        const stat = read("stat");
        const after = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
        if (after[0]) state = after[0];
      } catch {}
      const isMain = String(tid) === String(pid);
      return (
        "    tid=" + tid +
        " comm=" + read("comm") +
        " state=" + state +
        " wchan=" + read("wchan") +
        (isMain ? "   <<< メインスレッド" : "")
      );
    });
  } catch {
    return [];
  }
}

self.onmessage = (event) => {
  const {
    buffer,
    stallThresholdMs,
    checkIntervalMs,
    freezeTickFactor,
    resumeGraceMs,
    pid,
    startedAtMs,
  } = event.data;
  const beat = new BigInt64Array(buffer);
  let lastTick = Date.now();
  let graceUntil = 0;
  let consecutiveFreezes = 0;
  let degradedWarned = false;

  // 起動できたことを親へ知らせる。届かなければ親が警告を出す (無音の起動失敗を防ぐ)。
  self.postMessage({ type: "ready" });

  const timer = setInterval(() => {
    const now = Date.now();
    const tickDelta = now - lastTick;
    lastTick = now;

    // プロセスごと凍結していた (サスペンド / SIGSTOP / 時刻の前方ジャンプ) なら
    // 心拍の古さは当てにならない。判定を猶予期間だけ止め、メインスレッドが
    // 心拍を打ち直す機会を与える。
    if (tickDelta > checkIntervalMs * freezeTickFactor) {
      graceUntil = now + resumeGraceMs;
      consecutiveFreezes++;
      // 慢性的に遅延している環境 (コンテナの CPU quota 等) では判定に一度も到達しない。
      // 安全側ではあるが、無言で機能停止しているのは分からないので 1 度だけ知らせる。
      if (consecutiveFreezes >= 10 && !degradedWarned) {
        degradedWarned = true;
        console.error(
          "yomi: 応答監視のスケジューリングが継続的に遅延しています。" +
          "停止検知が働いていない可能性があります (Issue #91)。"
        );
      }
      return;
    }
    consecutiveFreezes = 0;
    if (now < graceUntil) return;

    const last = Number(Atomics.load(beat, 0));
    // 親が起動前に seed するので通常は通らない。SAB が壊れた場合の最終防御。
    if (last === 0) return;
    const age = now - last;
    // 時刻が後方へ飛ぶと age が負になる。次の心拍で自己修復するので何もしない。
    if (age <= stallThresholdMs) return;

    clearInterval(timer);
    const threads = threadSnapshot(pid);
    const diag = threads.length > 0
      ? "\n  スレッドの状態 (この情報が原因究明の手がかりになります):\n" + threads.join("\n")
      : "";
    // **落とす理由と診断材料を残さずに殺さない。**
    console.error(
      "\nyomi: メインスレッドが " + Math.round(age / 1000) + " 秒間応答していません (pid=" + pid + ")。\n" +
      "  event loop が停止しており、Ctrl+C も kill(SIGTERM) も効かない状態です (Issue #91)。\n" +
      "  復旧のためプロセスを強制終了します (終了コード 137)。再起動してください。\n" +
      "  稼働時間: " + Math.round((now - startedAtMs) / 1000) + " 秒\n" +
      "  この状態を踏んだことを https://github.com/ef-tech/yomi/issues/91 に報告してもらえると助かります。\n" +
      "  誤検知の場合は YOMI_NO_WATCHDOG=1 で監視を無効にできます。" +
      diag
    );
    process.kill(pid, "SIGKILL");
  }, checkIntervalMs);
};
`;

/** 環境変数から閾値を読む。不正な値は無視して既定値を使う (保険なので throw しない)。 */
function thresholdFromEnv(): number | null {
  const raw = process.env[TIMEOUT_ENV];
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`警告: ${TIMEOUT_ENV} が不正です (${raw})。既定値を使います`);
    return null;
  }
  return n;
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
  const useEnv = !options.ignoreEnv;
  if (useEnv && process.env[DISABLE_ENV] === "1") return NOOP_HANDLE;

  let stallThresholdMs =
    options.stallThresholdMs ?? (useEnv ? thresholdFromEnv() : null) ?? DEFAULT_STALL_THRESHOLD_MS;
  let heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  let checkIntervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS;
  const freezeTickFactor = options.freezeTickFactor ?? DEFAULT_FREEZE_TICK_FACTOR;
  const resumeGraceMs = options.resumeGraceMs ?? DEFAULT_RESUME_GRACE_MS;

  // **誤設定は「健全なプロセスの即殺」になる。** 心拍が閾値より粗いと必ず誤検知するので、
  // 成立しない組み合わせは受け付けず既定値へ戻す (保険なので throw はしない)。
  const sane =
    stallThresholdMs > 0 &&
    heartbeatIntervalMs > 0 &&
    checkIntervalMs > 0 &&
    heartbeatIntervalMs * 3 <= stallThresholdMs &&
    checkIntervalMs * 3 <= stallThresholdMs;
  if (!sane) {
    console.warn(
      "警告: 応答監視の設定が不正です " +
        `(閾値 ${stallThresholdMs}ms / 心拍 ${heartbeatIntervalMs}ms / 確認 ${checkIntervalMs}ms)。` +
        "\n  心拍と確認は閾値の 1/3 以下である必要があります。既定値で起動します",
    );
    stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS;
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;
    checkIntervalMs = CHECK_INTERVAL_MS;
  }

  let worker: Worker | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let objectUrl: string | null = null;
  let closed = false;

  const warnDisabled = (reason: string) => {
    if (closed) return;
    console.warn(
      `警告: 応答監視 (watchdog) が動いていません (${reason})。` +
        "\n  yomi の動作には影響しませんが、event loop が停止した場合の自動復旧は働きません",
    );
  };

  try {
    const buffer = new SharedArrayBuffer(8);
    const beat = new BigInt64Array(buffer);
    Atomics.store(beat, 0, BigInt(Date.now()));

    objectUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "application/javascript" }));
    worker = new Worker(objectUrl, { type: "module" });
    // **ここで revoke してはいけない。** Bun の Worker は遅延ロードなので、
    // `new Worker()` の直後に解放すると `BuildMessage: Blob URL is missing` で
    // 起動に失敗する (実測)。解放は close() で行う。プロセス終了時は OS が回収する。

    // **非同期の起動失敗を握り潰さない。** 構文エラー等は同期の catch には来ない。
    worker.addEventListener("error", (e) =>
      warnDisabled((e as ErrorEvent).message || "Worker エラー"),
    );
    worker.addEventListener("messageerror", () => warnDisabled("Worker との通信に失敗"));
    worker.addEventListener("message", (e) => {
      if ((e as MessageEvent).data?.type !== "ready") return;
      if (readyTimer) clearTimeout(readyTimer);
      readyTimer = null;
    });

    worker.postMessage({
      buffer,
      stallThresholdMs,
      checkIntervalMs,
      freezeTickFactor,
      resumeGraceMs,
      pid: process.pid,
      // **Worker 内の process.uptime() は Worker の起動からの経過を返す** (実測)。
      // #89 の最重要データは稼働時間なので、親の時刻を渡して壊さない。
      startedAtMs: Date.now() - Math.round(process.uptime() * 1000),
    });

    timer = setInterval(() => {
      Atomics.store(beat, 0, BigInt(Date.now()));
    }, heartbeatIntervalMs);

    readyTimer = setTimeout(() => warnDisabled("起動確認が取れませんでした"), READY_TIMEOUT_MS);

    // 主機能が終わったらプロセスを終わらせる (watchdog が居座らない)
    timer.unref?.();
    readyTimer.unref?.();
    (worker as unknown as { unref?: () => void }).unref?.();
  } catch (err) {
    if (timer) clearInterval(timer);
    if (readyTimer) clearTimeout(readyTimer);
    console.warn(
      `警告: 応答監視 (watchdog) を開始できませんでした (${(err as Error).message})。` +
        "\n  yomi の動作には影響しませんが、event loop が停止した場合の自動復旧は働きません",
    );
    return NOOP_HANDLE;
  }

  return {
    enabled: true,
    close() {
      closed = true;
      // **Worker を先に止める。** 心拍を先に止めると、terminate が効くまでの一瞬だけ
      // 「心拍が止まっているのに監視は生きている」窓ができる。
      void worker?.terminate();
      worker = null;
      if (timer) clearInterval(timer);
      timer = null;
      if (readyTimer) clearTimeout(readyTimer);
      readyTimer = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    },
  };
}
