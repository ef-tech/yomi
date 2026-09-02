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
 * ## ボタンは `<pre>` の外に置く
 *
 * **`<pre>` の中に絶対配置すると、横に長い行で流れて見えなくなる。** `.markdown-body pre` は
 * `overflow-x: auto` なので、`right: 6px` は**スクロールする内容側**に貼り付く ——
 * 右へスクロールした量だけボタンが左へ動き、幅の広いブロックでは画面外へ出る（実測:
 * `scrollLeft` を最大にすると `right` が 1626px → 1580px へ移動した）。
 * スクロールしない包み（`.code-block`）を挟み、そこへ絶対配置すれば、
 * **どこまでスクロールしても右上に留まる**。
 *
 * 既存の CSS はすべて子孫セレクタ（`.markdown-body pre` / `.text-view code` 等）なので、
 * 1 段挟んでも当たり方は変わらない。Mermaid は `<code>` を持たないので包まない
 * （`renderMermaid` の `els.preview.querySelectorAll("pre.mermaid")` もそのまま効く）。
 *
 * ## 中身は `code.textContent` から取る
 *
 * ハイライト（`highlight.js` / `highlight.js` 由来の `<span class="hljs-*">`）が入っている
 * ので、`innerHTML` を渡すとタグごとクリップボードへ入る。`textContent` なら
 * **生テキストのまま**取れる。ボタン自身は `<pre>` 直下（`<code>` の外）へ置くので、
 * ボタンのラベルが中身に混ざることもない。
 */
/**
 * ボタンに付けるクラス。**見た目と、言語切替で拾い直すためだけに使う。**
 *
 * **二重付与の判定には使わない** —— サニタイザが `<button class="…">` を通すので、
 * 利用者の Markdown で同じ class の要素を作れてしまう（下の `decorated` を参照）。
 */
export const COPY_BUTTON_CLASS = "code-copy-btn";

/** ボタンを右上に留めるための包み。**スクロールしないのが役目**。 */
export const CODE_BLOCK_CLASS = "code-block";

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

  /**
   * 表示中のフィードバック。**`WeakMap` にする** —— キーは再描画のたびに DOM ごと
   * 捨てられるボタンなので、強参照で持つと外れた要素をタイマーが切れるまで掴む。
   *
   * @type {WeakMap<HTMLElement, ReturnType<typeof setTimeout>>}
   */
  const feedbackTimers = new WeakMap();

  /**
   * ボタンを付け終えた `<pre>`。**DOM の class で判定しない。**
   *
   * サニタイザは `USE_PROFILES: { html: true }` なので **`<button class="…">` を通す**
   * （`public/sanitize-config.js` が落とすのは `<style>` / `style` / `data-i18n*` だけ）。
   * つまり利用者が Markdown に raw HTML で `<pre><button class="code-copy-btn">` と書くと、
   * **「もう付いている」と誤判定して本物のボタンが出なくなる**（実測で成立する）。
   * 判定を JS 側に置けば、文書の中身では騙せない。
   *
   * `WeakSet` なので、再描画で `<pre>` ごと捨てられれば自動的に消える
   * （＝新しい `<pre>` には改めて付く）。
   *
   * @type {WeakSet<HTMLElement>}
   */
  const decorated = new WeakSet();

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
   * ボタンは DOM ごと消えている。**それでも二重付与を防ぐ** —— 将来ここが部分更新に
   * 変わったときに黙って 2 つ並ぶのを避けたい。判定は上の `decorated`（`WeakSet`）で、
   * **DOM の中身では騙せない**。
   *
   * @returns {void}
   */
  function decorate() {
    for (const code of copyableCodeBlocks(els.preview)) {
      const pre = code.parentElement;
      if (!pre) continue;
      if (decorated.has(pre)) continue;
      decorated.add(pre);

      // **スクロールしない包みを挟む**（上の「ボタンは `<pre>` の外に置く」）。
      // `replaceWith` → `appendChild` の順にすると、`<pre>` は文書内の同じ位置に残る
      const wrap = document.createElement("div");
      wrap.className = CODE_BLOCK_CLASS;
      pre.replaceWith(wrap);
      wrap.appendChild(pre);

      const button = document.createElement("button");
      button.type = "button";
      button.className = COPY_BUTTON_CLASS;
      // **`data-i18n` は使えない。** `applyI18n` は静的 DOM を対象にしており、
      // ここは描画のたびに作り直されるので、言語切替時は `refresh` が呼び直す
      button.setAttribute("aria-label", t("code.copy.aria"));
      button.title = t("code.copy.title");
      // **アイコンは装飾。** 読み上げ名は `aria-label` が持つので「⧉」とは言われない
      button.textContent = "⧉";
      button.addEventListener("click", () => {
        void copyBlock(code, button);
      });
      // **`<pre>` の外（包みの直下）へ置く。** 中に入れると (1) ラベルが
      // `code.textContent` に混ざって中身が汚れ、(2) 横スクロールで流れる
      wrap.appendChild(button);
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
