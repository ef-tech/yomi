import { errorText } from "./app-context.js";
import { t } from "./i18n.js";

/**
 * 記事が参照している画像を zip でまとめてダウンロードする (Issue #140)。
 *
 * ## なぜ `<a download>` ではなく fetch するか
 *
 * `<a href="/api/images.zip?..." download>` だけでも保存はできるが、**結果が分からない**。
 * このエンドポイントは「入らなかった画像がある」場合も 200 を返す（1 枚の除外で zip 全体を
 * 失敗させないため）ので、**何枚入って何枚落ちたか**を伝える経路が要る。
 * `X-Yomi-Skipped` ヘッダを読むには fetch が必要。
 *
 * エラーも同じ理由 —— `<a download>` だと 400/500 の JSON がそのまま
 * ファイルとして保存され、利用者には「壊れた zip が落ちてきた」ようにしか見えない。
 */
/** @param {import("./app-context.js").Ctx} ctx */
export function createImageDownload(ctx) {
  const { els, state } = ctx;

  /** 保存中かどうか。二重送信を防ぐ */
  let running = false;

  /**
   * Blob をダウンロードさせる。
   *
   * `URL.createObjectURL` の解放を忘れると、閉じるまでメモリに残る（zip は大きい）。
   */
  /**
   * @param {Blob} blob
   * @param {string} filename
   */
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      // Firefox は DOM に無い要素の click を無視するので、付けてから押して外す
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      // click は同期なので、この時点で読み終わっている
      URL.revokeObjectURL(url);
    }
  }

  /**
   * `Content-Disposition` から実際のファイル名を取る。取れなければ呼び出し側の既定を使う。
   *
   * @param {string | null} header
   * @param {string} fallback
   * @returns {string}
   */
  function filenameFrom(header, fallback) {
    if (!header) return fallback;
    // `filename*=UTF-8''...` を優先する（日本語のファイル名はこちらにしか入らない）
    const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (star?.[1]) {
      try {
        return decodeURIComponent(star[1]);
      } catch {
        // 壊れたエンコードは既定にフォールバック
      }
    }
    const plain = /filename="([^"]+)"/i.exec(header);
    return plain?.[1] ?? fallback;
  }

  async function downloadImages() {
    if (running || !state.currentPath) return;
    running = true;
    const path = state.currentPath;
    try {
      const res = await fetch(`/api/images.zip?path=${encodeURIComponent(path)}`);
      if (!res.ok) {
        // エラーはこのエンドポイントも JSON で返す（`code` は i18n の対応表にある）
        const data = await res.json().catch(() => null);
        throw data ?? new Error(String(res.status));
      }

      const skipped = Number(res.headers.get("X-Yomi-Skipped") ?? "0");
      const blob = await res.blob();
      const stem =
        path
          .split("/")
          .pop()
          ?.replace(/\.[^.]*$/, "") ?? "images";
      const filename = filenameFrom(res.headers.get("Content-Disposition"), `${stem}-images.zip`);

      // **画像が 1 枚も無いなら保存しない。** 中身が `SKIPPED.txt` だけ、あるいは空の zip が
      // 落ちてくるのは「動いていない」ようにしか見えない
      const count = await countImageEntries(blob, skipped);
      if (count === 0) {
        ctx.setStatus("ok", t("images.download.none"));
        return;
      }

      saveBlob(blob, filename);
      ctx.setStatus(
        "ok",
        skipped > 0
          ? t("images.download.partial", { count: String(count), skipped: String(skipped) })
          : t("images.download.done", { count: String(count) }),
      );
    } catch (err) {
      ctx.setStatus("error", t("images.download.failed", { msg: errorText(err) }));
    } finally {
      running = false;
    }
  }

  /**
   * zip に入っている**画像の枚数**を数える。
   *
   * `SKIPPED.txt` は数えない —— 利用者が知りたいのは「何枚入ったか」で、
   * 一覧ファイルは中身ではなく注記だから。**サーバは skipped が 1 件以上のときだけ
   * その 1 件を足す**ので、`skipped` から引く枚数が決まる。
   *
   * セントラルディレクトリのエントリ数（EOCD の該当フィールド）を読む。全体を展開せずに
   * 末尾だけ見れば足りる。**コメント長は常に 0 で書いている**ので、EOCD は末尾 22 バイト。
   *
   * @param {Blob} blob zip の中身
   * @param {number} skipped 応答の `X-Yomi-Skipped`
   * @returns {Promise<number>}
   */
  async function countImageEntries(blob, skipped) {
    const EOCD_SIZE = 22;
    if (blob.size < EOCD_SIZE) return 0;
    const tail = await blob.slice(blob.size - EOCD_SIZE).arrayBuffer();
    const view = new DataView(tail);
    if (view.getUint32(0, true) !== 0x0605_4b50) return 0; // EOCD が末尾に無い（想定外）
    const total = view.getUint16(10, true);
    return Math.max(0, total - (skipped > 0 ? 1 : 0));
  }

  function wire() {
    els.downloadImagesBtn.addEventListener("click", () => {
      void downloadImages();
    });
    els.overflowDownloadImages.addEventListener("click", () => {
      ctx.mobile.setOverflowOpen(false);
      void downloadImages();
    });
  }

  return { wire, downloadImages };
}
