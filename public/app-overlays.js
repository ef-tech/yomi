/**
 * 重なっているオーバーレイの優先順位を 1 か所で決める (Issue #112)。
 *
 * ## なぜ要るか
 *
 * `Esc` とグローバルショートカットを、各パネルが**自分の `hidden` だけを門番にして**
 * 独立に処理していた。どれも「自分が最前面である」前提で書かれていたので、重なると壊れる:
 *
 * - **`Esc` 1 回で 2 つ閉じる。** `stopPropagation()` は**同じノードに付いた他のリスナーを
 *   止めない**（止めるのは `stopImmediatePropagation`）。`document` の capture に 2 つ
 *   登録してあれば両方走る
 * - **`Ctrl/Cmd+P` が競合ダイアログの裏でクイックオープンを開く。** ショートカット側が
 *   前面のパネルを見ていないので、z-index 60 のパネルが 70 のスクリムの下で開き、
 *   フォーカスだけがトラップの外へ出る
 *
 * ## 何をするか
 *
 * **「いまどれが最前面か」をここだけで答える。** 各ハンドラは先頭で自分が最前面かを
 * 確かめ、違えば何もしない。
 *
 * **`stopImmediatePropagation` は使わない。** 同じノードのリスナーを止められるが、
 * **登録順に依存する**ので `wireX()` を並べ替えた瞬間に優先順位が変わる。
 * 順序ではなく**宣言された重なり順**で決める。
 *
 * ## 足すとき
 *
 * {@link OVERLAY_LAYERS} に 1 行足して、ハンドラの先頭で {@link isTopOverlay} を呼ぶ。
 * それ以外の場所を触る必要はない。
 */

/**
 * @typedef {"sidebar" | "overflowMenu" | "quickOpen" | "externalLinkBanner" | "conflictDiff"} OverlayName
 */

/**
 * 重なり順。**大きいほど手前。**
 *
 * **値は `styles.css` の `z-index` に合わせてある**が、比較に使うのはここの大小だけ
 * （CSS を読みに行かない —— 判定の正本をここに置いて 1 か所を直す）。
 *
 * **`externalLinkBanner` だけは CSS に `z-index` が無い**（`position: static` の
 * インラインバナーで、重なりに参加していない）。それでもここに載せるのは、
 * **`Esc` の優先順位には参加している**ため —— sidebar と ⋮ メニューは元から
 * 「バナーが開いていたら譲る」設計だった。値はその設計をそのまま数値にしたもので、
 * **全画面モーダル（スクリムの下にバナーが隠れる）より下**に置く。
 *
 * @type {ReadonlyArray<{ name: OverlayName, layer: number, modal: boolean }>}
 */
export const OVERLAY_LAYERS = [
  // モバイルの引き出し。全画面ではないのでショートカットは止めない
  { name: "sidebar", layer: 50, modal: false },
  // ⋮ メニュー。ポップオーバーなのでショートカットは止めない
  { name: "overflowMenu", layer: 55, modal: false },
  // CSS に z-index は無い。sidebar / ⋮ より優先という元の設計を数値にしたもの
  { name: "externalLinkBanner", layer: 57, modal: false },
  { name: "quickOpen", layer: 60, modal: true },
  { name: "conflictDiff", layer: 70, modal: true },
];

/**
 * 開いているかどうかの判定。**`hidden` で見るものと class で見るものが混在する**ので、
 * ここに閉じ込めて呼び出し側から隠す。
 *
 * @param {OverlayName} name
 * @param {import("./app-context.js").Elements} els
 * @returns {boolean}
 */
function isOpen(name, els) {
  // sidebar だけ `hidden` ではなく class で開閉する（アニメーションを CSS に持たせているため）
  if (name === "sidebar") return els.sidebar.classList.contains("is-open");
  return !els[name].hidden;
}

/**
 * いま最前面のオーバーレイ。どれも開いていなければ `null`。
 *
 * @param {import("./app-context.js").Elements} els
 * @returns {OverlayName | null}
 */
export function topOverlay(els) {
  /** @type {OverlayName | null} */
  let top = null;
  let topLayer = -1;
  for (const entry of OVERLAY_LAYERS) {
    if (entry.layer > topLayer && isOpen(entry.name, els)) {
      top = entry.name;
      topLayer = entry.layer;
    }
  }
  return top;
}

/**
 * `name` が最前面か。**各キーハンドラの先頭で呼ぶ**のがこのモジュールの主な用途。
 *
 * @param {OverlayName} name
 * @param {import("./app-context.js").Elements} els
 * @returns {boolean}
 */
export function isTopOverlay(name, els) {
  return topOverlay(els) === name;
}

/**
 * グローバルショートカットを止めるべきか (DoD 2)。
 *
 * **止めるのは全画面のモーダルだけ。** sidebar や ⋮ メニューまで止めると、
 * 引き出しを開いたまま `Ctrl/Cmd+S` で保存できなくなる —— それらは
 * 「背後に別のパネルが開く」問題を起こさないので、止める理由がない。
 *
 * @param {import("./app-context.js").Elements} els
 * @param {OverlayName} [exceptFor] このオーバーレイ自身のショートカット（開閉トグル）は通す
 * @returns {boolean}
 */
export function shortcutsBlocked(els, exceptFor) {
  const top = topOverlay(els);
  if (top === null || top === exceptFor) return false;
  return OVERLAY_LAYERS.some((entry) => entry.name === top && entry.modal);
}
