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
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    // Firefox は DOM に無い要素の click を無視するので、付けてから押して外す
    document.body.appendChild(a);
    a.click();
    a.remove();
    // **同期的に revoke しない。** `click()` から戻った時点で保存が始まっているとは
    // 限らず、ブラウザによってはダウンロードが中断される。次のタスクまで待ってから解放する
    // （解放を忘れると、タブを閉じるまで zip がメモリに残る）
    setTimeout(() => URL.revokeObjectURL(url), 0);
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
    // **押している間の手応えを出す。** 画像の多い記事では数秒かかるのに、
    // 無言だと「押せていない」ようにしか見えない（`#status` は aria-live なので
    // 支援技術にも伝わる）
    setBusy(true);
    ctx.setStatus(null, t("images.download.running"));
    try {
      const res = await fetch(`/api/images.zip?path=${encodeURIComponent(path)}`);
      if (!res.ok) {
        // エラーはこのエンドポイントも JSON で返す（`code` は i18n の対応表にある）
        const data = await res.json().catch(() => null);
        throw data ?? new Error(String(res.status));
      }

      const skipped = Number(res.headers.get("X-Yomi-Skipped") ?? "0");
      // **zip を解析しない。** EOCD を読むとサーバの zip 実装に結合し、
      // 形式を変えたときに無言で「画像がありません」に化ける
      const count = Number(res.headers.get("X-Yomi-Images") ?? "0");
      const blob = await res.blob();
      const stem =
        path
          .split("/")
          .pop()
          ?.replace(/\.[^.]*$/, "") ?? "images";
      const filename = filenameFrom(res.headers.get("Content-Disposition"), `${stem}-images.zip`);

      // **「参照が無い」と「参照はあったが 1 枚も入らなかった」を分ける。**
      // 後者こそ理由が書いてある `SKIPPED.txt` を渡すべき場面で、
      // 「画像を参照していません」と言って捨てると利用者は原因に辿り着けない
      if (count === 0 && skipped === 0) {
        ctx.setStatus("ok", t("images.download.none"));
        return;
      }

      saveBlob(blob, filename);
      if (count === 0) {
        ctx.setStatus("error", t("images.download.allSkipped", { skipped: String(skipped) }));
      } else {
        ctx.setStatus(
          "ok",
          skipped > 0
            ? t("images.download.partial", { count: String(count), skipped: String(skipped) })
            : t("images.download.done", { count: String(count) }),
        );
      }
    } catch (err) {
      ctx.setStatus("error", t("images.download.failed", { msg: errorText(err) }));
    } finally {
      running = false;
      setBusy(false);
    }
  }

  /**
   * 実行中はボタンを押せなくする（`enableEditActions` の状態を壊さないよう戻す）。
   *
   * @param {boolean} busy
   */
  function setBusy(busy) {
    els.downloadImagesBtn.disabled = busy || !state.currentPath;
    els.overflowDownloadImages.disabled = busy || !state.currentPath;
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
