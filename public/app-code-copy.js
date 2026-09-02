import { messageOf } from "./app-context.js";
import { COPY_FEEDBACK_MS } from "./app-document.js";
import { t } from "./i18n.js";

/**
 * プレビュー内のコードブロックにコピーボタンを出す (Issue #165)。
 *
 * ## なぜ描画後の DOM に足すのか
 *
 * **Markdown → HTML の段階で混ぜない。** HTML 文字列にボタンを混ぜると、サニタイザ
 * (#21 / #59) の許可設定を広げることになり、**raw HTML の持ち込み経路を増やす**。
 * サニタイズ後の DOM へ後付けすれば、許可設定は 1 ミリも触らずに済む。
 *
 * ## Mermaid には出ない
 *
 * `src/renderer.ts` は Mermaid を `<pre class="mermaid">`（`<code>` を持たない）として
 * 出すので、**`pre > code` で選ぶだけで自然に外れる**。クラス名で除外する必要はない
 * —— 除外リストを持つと、`renderer.ts` の出力を変えたときに黙って壊れる。
 *
 * ## テキストファイルの表示にも出す
 *
 * `#155` で読めるようになった `.json` / `.ts` などの読み取り専用表示も、DOM の形は
 * 同じ `pre > code` （`app-preview.js` の `renderTextFile`）。**同じ形のものに同じ
 * ボタンを出す**ほうが、特例を設けるより説明が要らない。「ファイル全体をコピー」は
 * 読み取り専用で開いたときにこそ欲しい操作でもある。
 *
 * ## 中身は `code.textContent` から取る
 *
 * ハイライト（`highlight.js` / `highlight.js` 由来の `<span class="hljs-*">`）が入っている
 * ので、`innerHTML` を渡すとタグごとクリップボードへ入る。`textContent` なら
 * **生テキストのまま**取れる。ボタン自身は `<pre>` 直下（`<code>` の外）へ置くので、
 * ボタンのラベルが中身に混ざることもない。
 */
/** ボタンに付けるクラス。**二重付与の判定にも使う**（再描画のたびに呼ばれるため）。 */
export const COPY_BUTTON_CLASS = "code-copy-btn";

/**
 * コピー対象のコードブロックを DOM 順で返す。
 *
 * **`pre > code` の直下関係で選ぶ。** `pre code` にすると、将来 `<pre>` の中へ
 * 入れ子の要素を足したときに意図しないものを拾う。
 *
 * @param {ParentNode} root
 * @returns {HTMLElement[]}
 */
export function copyableCodeBlocks(root) {
  return /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll("pre > code")));
}

/** @param {import("./app-context.js").Ctx} ctx */
export function createCodeCopy(ctx) {
  const { els } = ctx;

  /** @type {Map<HTMLElement, ReturnType<typeof setTimeout>>} 表示中のフィードバック */
  const feedbackTimers = new Map();

  /**
   * 押した手応えを出す。**`app-document.js` の `flashCopied` と同じ見せ方**
   * （`is-copied` を付けて `COPY_FEEDBACK_MS` で外す）。
   *
   * @param {HTMLElement} button
   * @returns {void}
   */
  function flash(button) {
    button.classList.add("is-copied");
    const running = feedbackTimers.get(button);
    if (running) clearTimeout(running);
    feedbackTimers.set(
      button,
      setTimeout(() => {
        button.classList.remove("is-copied");
        feedbackTimers.delete(button);
      }, COPY_FEEDBACK_MS),
    );
  }

  /**
   * @param {HTMLElement} code
   * @param {HTMLElement} button
   * @returns {Promise<void>}
   */
  async function copyBlock(code, button) {
    try {
      // **`ctx.document` のものを使う。** `navigator.clipboard` が使えない
      // 非セキュアコンテキスト（`--share` で LAN から HTTP で開いたとき）の
      // フォールバックを既に持っているので、ここで書き直さない
      await ctx.document.copyTextToClipboard(code.textContent ?? "");
      flash(button);
      ctx.setStatus("ok", t("code.copied"));
    } catch (err) {
      ctx.setStatus("error", t("status.copyFailed", { msg: messageOf(err) }));
    }
  }

  /**
   * プレビュー内のコードブロックにボタンを付ける。**描画のたびに呼ぶ。**
   *
   * `renderCurrentFile` は `innerHTML` の代入でプレビューを作り直すので、前回の
   * ボタンは DOM ごと消えている。**それでも二重付与を防ぐ** —— テキスト表示
   * (`renderTextFile`) は `replaceChildren` で作り直すが、将来ここが部分更新に
   * 変わったときに黙って 2 つ並ぶのを避けたい。
   *
   * @returns {void}
   */
  function decorate() {
    for (const code of copyableCodeBlocks(els.preview)) {
      const pre = code.parentElement;
      if (!pre) continue;
      if (pre.querySelector(`:scope > .${COPY_BUTTON_CLASS}`)) continue;
      pre.classList.add("has-code-copy");

      const button = document.createElement("button");
      button.type = "button";
      button.className = COPY_BUTTON_CLASS;
      // **`data-i18n` は使えない。** `applyI18n` は静的 DOM を対象にしており、
      // ここは描画のたびに作り直されるので、言語切替時は `refresh` が呼び直す
      button.setAttribute("aria-label", t("code.copy.aria"));
      button.title = t("code.copy.title");
      // **アイコンは装飾。** ラベルは `aria-label` が持つ（読み上げで「⧉」と言わせない）
      button.textContent = "⧉";
      button.setAttribute("aria-hidden", "false");
      button.addEventListener("click", () => {
        void copyBlock(code, button);
      });
      // **`<code>` の外・`<pre>` の直下に置く。** 中に入れるとラベルが
      // `code.textContent` に混ざり、コピーした中身が汚れる
      pre.appendChild(button);
    }
  }

  /**
   * 言語切替のときにボタンの文言を当て直す (Issue #48 の `reapplyDynamicI18n` から呼ぶ)。
   *
   * @returns {void}
   */
  function refresh() {
    for (const el of els.preview.querySelectorAll(`.${COPY_BUTTON_CLASS}`)) {
      const button = /** @type {HTMLElement} */ (el);
      button.setAttribute("aria-label", t("code.copy.aria"));
      button.title = t("code.copy.title");
    }
  }

  return { decorate, refresh };
}
