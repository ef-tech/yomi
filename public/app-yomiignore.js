import { errorText, fetchJson } from "./app-context.js";
import { isTopOverlay } from "./app-overlays.js";
import { t } from "./i18n.js";

/**
 * 除外設定 (`.yomiignore`) の編集パネル (Issue #164)。
 *
 * ## なぜ画面から編集するのか
 *
 * `.yomiignore` はカレント直下のファイルを手で開くしかなく、**yomi を見ながら直せない**。
 * さらに「照合できない行」の警告は起動時の stderr にしか出ないので、画面だけを見ていると
 * **書いたのに効いていない行**に気づけない。ここで警告ごと見せる。
 *
 * ## 判定も文言もここには置かない
 *
 * 照合できない行の判定 (`classifyInvalid`) と説明文 (`INVALID_REASON_TEXT`) は
 * `src/yomiignore.ts` が正本で、サーバが**整形済みの 1 行**を返す。ここでそれを
 * 組み立て直すと、理由を 1 つ足したときに**画面だけ空欄になる**（型で守れない）。
 *
 * ## 保存後にツリーを取り直す
 *
 * サーバは保存時に「全量取り直し」の `tree` 通知を送るので、WebSocket が生きていれば
 * それだけで更新される。**それでもここから明示的に取り直す** —— 再接続待ちの間に
 * 保存すると通知が届かず、**「保存したのにツリーが変わらない」**という、利用者が
 * 保存の失敗と区別できない見え方になるため。二重に取り直しても実害はない。
 */
/** @param {import("./app-context.js").Ctx} ctx */
export function createYomiignorePanel(ctx) {
  const { els } = ctx;

  /** @type {HTMLElement | null} 閉じたときにフォーカスを戻す先 */
  let returnFocus = null;
  /** 保存中か。二重送信を防ぐ */
  let saving = false;

  /** @returns {boolean} */
  function isOpen() {
    return !els.yomiignorePanel.hidden;
  }

  /**
   * サーバが返した警告行を描く。**0 件ならリストごと隠す**（空の枠を残さない）。
   *
   * @param {{ message?: unknown, dropped?: unknown }[]} invalid
   * @returns {void}
   */
  function renderInvalid(invalid) {
    const items = invalid.map((v) => {
      const li = document.createElement("li");
      // **捨てた行と残した行を見分けられるようにする。** グロブ文字を含む名前は
      // 「展開されない」だけで除外としては生きているので、同じ見た目にすると
      // 「消えた」と誤解して書き直すことになる
      li.className = v.dropped ? "yomiignore-invalid-item is-dropped" : "yomiignore-invalid-item";
      // **`textContent` で入れる。** 中身には利用者が書いた行がそのまま入る
      li.textContent = String(v.message ?? "");
      return li;
    });
    els.yomiignoreInvalid.replaceChildren(...items);
    els.yomiignoreInvalid.hidden = items.length === 0;
  }

  /**
   * パネル内の一過性メッセージ。`#status` は topbar にあり、このパネルのスクリムの
   * 下に隠れて見えない（競合ダイアログが `conflict-diff-notice` を持つのと同じ理由）。
   *
   * @param {string | null} message
   * @param {"ok" | "error"} [kind]
   * @returns {void}
   */
  function setNotice(message, kind) {
    els.yomiignoreNotice.textContent = message ?? "";
    els.yomiignoreNotice.className = kind ? `yomiignore-notice is-${kind}` : "yomiignore-notice";
    els.yomiignoreNotice.hidden = !message;
  }

  async function open() {
    if (isOpen()) return;
    returnFocus = /** @type {HTMLElement | null} */ (document.activeElement);
    // **開くのは取得できてから。** 先に開いて空の textarea を見せると、
    // 取得に失敗したときに「除外設定が空だ」と誤読して丸ごと書き直されうる
    try {
      const data = /** @type {{ text: string, invalid: any[] }} */ (
        await fetchJson("/api/yomiignore")
      );
      els.yomiignoreText.value = data.text ?? "";
      renderInvalid(data.invalid ?? []);
    } catch (err) {
      ctx.setStatus("error", t("yomiignore.loadFailed", { msg: errorText(err) }));
      returnFocus = null;
      return;
    }
    setNotice(null);
    els.yomiignorePanel.hidden = false;
    els.yomiignoreText.focus();
  }

  function close() {
    if (!isOpen()) return;
    els.yomiignorePanel.hidden = true;
    const back = returnFocus;
    returnFocus = null;
    // **`<body>` は戻り先にしない**（キーボード操作の起点が消える）。
    // 戻り先が消えている場合に備えて、開くボタンへ落とす
    for (const el of [back, els.treeYomiignore]) {
      if (!el || el === document.body || !el.isConnected || typeof el.focus !== "function")
        continue;
      el.focus();
      if (document.activeElement === el) return;
    }
  }

  async function save() {
    if (saving) return;
    saving = true;
    els.yomiignoreSave.disabled = true;
    setNotice(t("yomiignore.saving"));
    try {
      const data = /** @type {{ text: string, invalid: any[] }} */ (
        await fetchJson("/api/yomiignore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: els.yomiignoreText.value }),
        })
      );
      renderInvalid(data.invalid ?? []);
      // 上のクラスコメントのとおり、WebSocket の通知に依存せず自分でも取り直す
      await ctx.ws.refreshTree();
      setNotice(t("yomiignore.saved"), "ok");
    } catch (err) {
      setNotice(t("yomiignore.saveFailed", { msg: errorText(err) }), "error");
    } finally {
      saving = false;
      els.yomiignoreSave.disabled = false;
    }
  }

  /** パネル内でフォーカスを取れる要素を DOM 順で返す。 */
  function focusables() {
    return /** @type {HTMLElement[]} */ (
      Array.from(
        els.yomiignorePanel.querySelectorAll("textarea, button:not([disabled]), [tabindex='0']"),
      )
    );
  }

  /**
   * @param {KeyboardEvent} ev
   * @returns {void}
   */
  function handleKeydown(ev) {
    if (ev.isComposing) return;

    if (ev.key === "Escape") {
      // ここへ来た時点で最前面なので、1 回の Esc で背後まで閉じない (Issue #112)
      ev.preventDefault();
      ev.stopPropagation();
      close();
      return;
    }

    // **Ctrl/Cmd+Enter で保存。** textarea では Enter が改行なので、保存に割り当てられない
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
      ev.preventDefault();
      void save();
      return;
    }

    if (ev.key === "Tab") {
      // `aria-modal="true"` を宣言している以上、背後のツリーやエディタへ抜けさせない
      const list = focusables();
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (!els.yomiignorePanel.contains(active)) {
        ev.preventDefault();
        (ev.shiftKey ? last : first).focus();
        return;
      }
      if (ev.shiftKey && active === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && active === last) {
        ev.preventDefault();
        first.focus();
      }
    }
  }

  function wire() {
    els.treeYomiignore.addEventListener("click", () => {
      void open();
    });
    els.yomiignoreSave.addEventListener("click", () => {
      void save();
    });
    els.yomiignoreClose.addEventListener("click", close);
    // 背景（パネルの外）をクリックしたら閉じる
    els.yomiignorePanel.addEventListener("click", (ev) => {
      if (ev.target === els.yomiignorePanel) close();
    });
    // **`document` の capture で拾う。** パネル要素に付けると、フォーカスが外へ落ちた
    // 瞬間に Esc も Tab も届かなくなる（`app-editor.js` の競合ダイアログと同じ理由）
    document.addEventListener(
      "keydown",
      (ev) => {
        if (!isTopOverlay("yomiignorePanel", els)) return;
        if (ev.key === "Escape" && ev.defaultPrevented) return;
        handleKeydown(ev);
      },
      true,
    );
  }

  return { wire, open, close, save, isOpen };
}
