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
 * ## `Esc` を 1 回に 1 枚だけにする第 2 の仕掛け
 *
 * 最前面かどうかの判定だけでは足りない。**先に走ったハンドラが自分を閉じると、
 * 後から走るハンドラには自分が最前面に見える**（`topOverlay` は毎回 live な DOM を
 * 読み直すため）。同じイベントの中で 2 枚閉じる、という #112 そのものが順序次第で戻る。
 *
 * そこで **`Esc` を扱うハンドラは全員 `preventDefault()` し、先頭で
 * `ev.defaultPrevented` を見て譲る**。これで「1 イベントにつき 1 枚」が
 * **登録順と無関係に**決まる。
 *
 * ## 足すとき
 *
 * {@link OVERLAY_LAYERS} に 1 行足して、ハンドラの先頭で {@link isTopOverlay} を呼ぶ。
 * それ以外の場所を触る必要はない。
 */

/**
 * **`Esc` とショートカットの優先順位。大きいほど手前。**
 *
 * ## 描画順ではない
 *
 * 値は `styles.css` の `z-index` に合わせてあるが、**`externalLinkBanner` だけは違う。**
 * あれは `position: static` のインラインバナーで（実測）、CSS の重なりでは
 * **positioned な sidebar (50) や ⋮ メニュー (55) より下**に描かれる。それでも 57 に
 * 置いているのは、**元から「バナーが開いていたら sidebar と ⋮ は譲る」設計だった**から。
 * ここは描画順の写しではなく**優先順位の宣言**で、その 1 点だけ実際の重なりと逆になる。
 *
 * 比較に使うのはここの大小だけで、CSS は読みに行かない（正本を 1 か所にする）。
 *
 * ## `tocPanel` の `blocksShortcuts` が `false` な理由
 *
 * **`true` にすると、TOC 自身のトグルが効かなくなる。** `Ctrl/Cmd+Shift+O` は
 * `shortcutsBlocked(els)` を `exceptFor` 無しで通すので（`app.js`）、TOC が
 * 「塞ぐ層」になった瞬間に**開いた TOC を同じキーで閉じられなくなる**（実測）。
 * `Ctrl/Cmd+P`（クイックオープン）も同様に、TOC の上から開けなくなる。
 *
 * **`Ctrl/Cmd+S` は理由にならない。** あれは `state.editing` のときだけ走るが、
 * **編集モードに入ると TOC は自動で閉じる**（`app-editor.js` の `tocSuspended`)ので、
 * 両者は共存しない（実測）。
 *
 * そもそもこの表は**ビューポート幅を持たない**ので、スマホ幅で全画面（`z-index: 60`）
 * であることを根拠に `true` にすると、**PC 幅のフローティング（10）でも同じ抑止が
 * 掛かる**。幅で変えたいなら表に「幅の条件」を持たせる設計変更が要る。
 */
export const OVERLAY_LAYERS = /** @type {const} */ ([
  // モバイルの引き出し。全画面ではないのでショートカットは止めない
  { name: "sidebar", priority: 50, blocksShortcuts: false },
  // ⋮ メニュー。ポップオーバーなのでショートカットは止めない
  { name: "overflowMenu", priority: 55, blocksShortcuts: false },
  // CSS に z-index は無い。sidebar / ⋮ より優先という元の設計を数値にしたもの
  { name: "externalLinkBanner", priority: 57, blocksShortcuts: false },
  // スマホ幅で全画面 (z-index: 60)。**クイックオープンと同じ値だが、`index.html` で
  // 先に置かれているぶん下に描かれる**（実測）。優先順位もそれに合わせて 58 にする ——
  // 60 にすると同着になり、`topOverlay` が先勝ちで TOC を返すので、**上に開いた
  // クイックオープンが Esc で閉じられなくなる** (Issue #135)
  { name: "tocPanel", priority: 58, blocksShortcuts: false },
  { name: "quickOpen", priority: 60, blocksShortcuts: true },
  { name: "conflictDiff", priority: 70, blocksShortcuts: true },
]);

/**
 * オーバーレイの名前。**表から導出する。**
 *
 * union を別に書いて表と二重管理すると、**union に足して表の行を足し忘れたときに
 * `isTopOverlay` が黙って `false` を返す**（型エラーにならない）。正本は表 1 つ。
 *
 * 逆向きも `tsc` が守る —— `els` に無いキーや、`hidden` を持たない値のキー
 * （`els` には `HTMLElement[]` もある）を書くと `isOpen` で落ちる。
 *
 * @typedef {(typeof OVERLAY_LAYERS)[number]["name"]} OverlayName
 */

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
  let topPriority = -1;
  for (const entry of OVERLAY_LAYERS) {
    if (entry.priority > topPriority && isOpen(entry.name, els)) {
      top = entry.name;
      topPriority = entry.priority;
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
 * グローバルショートカットを飲み込むべきか (DoD 2)。
 *
 * **見るのは「開いているもののうち、ショートカットを塞ぐ層の最前面」。**
 * 「最前面が塞ぐ層か」で判定すると、**塞がない層をより手前に 1 つ足しただけで抑止が
 * 外れる** —— 競合ダイアログの上にトーストを足した瞬間に #112 が復活する。
 * 「1 行足すだけで済む」(DoD 3) はそこまで含めて成り立たせる。
 *
 * **塞ぐのは全画面のモーダルだけ。** sidebar や ⋮ メニューまで塞ぐと、引き出しを
 * 開いたまま `Ctrl/Cmd+S` で保存できなくなる —— それらは「背後に別のパネルが開く」
 * 問題を起こさないので、止める理由がない。
 *
 * **呼び出し側は先に `preventDefault()` すること。** ここが true でも
 * キーを奪わないと、`Ctrl/Cmd+P` はブラウザの印刷ダイアログ、`Ctrl/Cmd+S` は
 * 「名前を付けてページを保存」に抜ける（実際に一度やらかした）。
 *
 * @param {import("./app-context.js").Elements} els
 * @param {OverlayName} [exceptFor] このオーバーレイ自身のショートカット（開閉トグル）は通す
 * @returns {boolean}
 */
export function shortcutsBlocked(els, exceptFor) {
  /** @type {OverlayName | null} */
  let top = null;
  let topPriority = -1;
  for (const entry of OVERLAY_LAYERS) {
    if (!entry.blocksShortcuts) continue;
    if (entry.priority > topPriority && isOpen(entry.name, els)) {
      top = entry.name;
      topPriority = entry.priority;
    }
  }
  return top !== null && top !== exceptFor;
}
