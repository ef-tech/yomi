/**
 * 重なったオーバーレイの `Esc` とショートカットの優先順位 (Issue #112)。
 *
 * ## なぜ重なりを直接見るのか
 *
 * #54（クイックオープン）と #57（競合の差分ダイアログ）は**それぞれ単体では正しく動く**。
 * どちらも `document` の capture に keydown を登録し、自分の `hidden` だけを門番にして
 * いたので、**両方がマージされて初めて**壊れた:
 *
 * - `Esc` 1 回で両方閉じる（`stopPropagation()` は**同じノードの他のリスナーを止めない**）
 * - `Ctrl/Cmd+P` が競合ダイアログ（z-index 70）の裏でクイックオープン（60）を開く
 *
 * つまり**各パネルのテストをいくら足しても捕まらない**。ここは「重なった状態」だけを見る。
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type AppHarness,
  type BootOptions,
  bootApp,
  resetAppEnvironment,
} from "./helpers/app-harness.ts";

/**
 * **`README.md` を開いた状態で起動する** (Issue #145)。
 *
 * このファイルの主題は**どのファイルが開くかではない**。`bootApp()` の既定は
 * **ツリー最初のファイル**で、`defaultTree()` を実サーバの並び（ディレクトリが先）に
 * 直した結果それは `docs/deep/note.md` になった。以前はここが偶然 `README.md` だったので、
 * テストは**何も指定せずに README を前提**に書かれていた。前提を明示に変えれば、
 * fixture の並びが変わっても壊れない。
 */
const boot = (options: BootOptions = {}) =>
  bootApp({ url: "http://localhost:3944/?path=README.md", ...options });

let h: AppHarness;

afterEach(resetAppEnvironment);

const quickOpen = () => h.el("quick-open");
const conflictDiff = () => h.el("conflict-diff");
const sidebar = () => h.el("sidebar");
const banner = () => h.el("external-link-banner");
const overflowMenu = () => h.el("overflow-menu");
const tocPanel = () => h.el("toc-panel");

const pressEsc = () => h.keydown(h.document, { key: "Escape" });
const pressCtrlP = () => h.keydown(h.document, { key: "p", code: "KeyP", ctrlKey: true });
const pressCtrlS = () => h.keydown(h.document, { key: "s", code: "KeyS", ctrlKey: true });
const pressCtrlShiftO = () =>
  h.keydown(h.document, { key: "O", code: "KeyO", ctrlKey: true, shiftKey: true });

/**
 * 開いた状態を**直接作る**。
 *
 * 本来の導線（保存の競合を起こす・リンクを踏む）を通すと、この検証に関係のない
 * 前提を大量に積むことになる。**見たいのは「重なったときにどのハンドラが動くか」**なので、
 * 各ハンドラが門番に使っているのと同じ状態（`hidden` と class）を直接立てる。
 */
function open(
  name: "quickOpen" | "conflictDiff" | "banner" | "overflowMenu" | "sidebar" | "tocPanel",
) {
  if (name === "sidebar") sidebar().classList.add("is-open");
  else if (name === "quickOpen") quickOpen().hidden = false;
  else if (name === "conflictDiff") conflictDiff().hidden = false;
  else if (name === "banner") banner().hidden = false;
  else if (name === "tocPanel") tocPanel().hidden = false;
  else overflowMenu().hidden = false;
}

const openState = () => ({
  quickOpen: !quickOpen().hidden,
  conflictDiff: !conflictDiff().hidden,
  banner: !banner().hidden,
  overflowMenu: !overflowMenu().hidden,
  tocPanel: !tocPanel().hidden,
  sidebar: sidebar().classList.contains("is-open"),
});

describe("重なったオーバーレイの Esc (Issue #112)", () => {
  test("Esc 1 回で最前面だけが閉じる（クイックオープン + 競合ダイアログ）", async () => {
    h = await boot();
    open("quickOpen");
    open("conflictDiff");

    pressEsc();
    // **最前面は競合ダイアログ (z-index 70)。** 以前はここで両方閉じていた
    expect(openState()).toMatchObject({ quickOpen: true, conflictDiff: false });

    pressEsc();
    expect(openState()).toMatchObject({ quickOpen: false, conflictDiff: false });
  });

  test("Esc 1 回で最前面だけが閉じる（sidebar + 外部リンクバナー）", async () => {
    h = await boot();
    open("sidebar");
    open("banner");

    pressEsc();
    expect(openState()).toMatchObject({ sidebar: true, banner: false });

    pressEsc();
    expect(openState()).toMatchObject({ sidebar: false, banner: false });
  });

  test("Esc 1 回で最前面だけが閉じる（sidebar + ⋮ メニュー）", async () => {
    h = await boot();
    open("sidebar");
    open("overflowMenu");

    pressEsc();
    expect(openState()).toMatchObject({ sidebar: true, overflowMenu: false });

    pressEsc();
    expect(openState()).toMatchObject({ sidebar: false, overflowMenu: false });
  });

  test("3 枚重なっても 1 回に 1 枚ずつ手前から閉じる", async () => {
    h = await boot();
    open("sidebar");
    open("quickOpen");
    open("conflictDiff");

    pressEsc();
    expect(openState()).toMatchObject({ sidebar: true, quickOpen: true, conflictDiff: false });
    pressEsc();
    expect(openState()).toMatchObject({ sidebar: true, quickOpen: false, conflictDiff: false });
    pressEsc();
    expect(openState()).toMatchObject({ sidebar: false, quickOpen: false, conflictDiff: false });
  });
});

describe("Esc の消費 (Issue #112)", () => {
  // **判定だけでは足りない。** 先に走ったハンドラが自分を閉じると、後続からは
  // 自分が最前面に見える（`topOverlay` は毎回 live な DOM を読み直す）。
  // 各ハンドラが `preventDefault()` し、先頭で `defaultPrevented` を見て譲ることで
  // 「1 イベントにつき 1 枚」が**登録順と無関係に**決まる
  test("Esc を処理したら必ず消費する（後続のハンドラが 2 枚目を閉じない）", async () => {
    h = await boot();
    open("sidebar");

    const ev = new h.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    h.document.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(openState().sidebar).toBe(false);
  });

  test("ツリーの新規入力欄を Esc で閉じても、背後の sidebar は残る", async () => {
    h = await boot({ mobile: true });
    open("sidebar");
    h.click(h.el("tree-new-file"));
    await h.flush();
    const input = h.q<HTMLInputElement>(".tree-new-input");

    h.keydown(input, { key: "Escape" });
    await h.flush();

    // 入力欄は `preventDefault()` するので、`document` の sidebar ハンドラが譲る。
    // **以前は引き出しまで一緒に閉じていた**（#112 と同じクラスのバグ）
    expect(h.qa(".tree-new-input")).toHaveLength(0);
    expect(openState().sidebar).toBe(true);
  });
});

describe("重なりを解いたあとのフォーカス (Issue #112)", () => {
  /**
   * **重なった状態で一番壊れやすいのがフォーカスの戻り先。**
   *
   * 上の Esc テストは `hidden` を直接立てているので、`openQuickOpen` /
   * `openConflictDiff` の「戻す先を覚える」を通らない。**ここだけは実導線を通す** ——
   * 直接立てると `conflictDiffReturnFocus` が空のまま閉じることになり、
   * 復帰の検証にならない（実際に一度そう書いて、クイックオープンの入力欄から
   * フォーカスが外れて落ちた）。
   */
  test("競合ダイアログを閉じたら、下のクイックオープンに操作が戻る", async () => {
    h = await boot();

    // 外部でファイルが書き換わった状態を作り、保存して競合させる
    h.click(h.el("edit-btn"));
    await h.flush(6);
    const editor = h.el<HTMLTextAreaElement>("editor");
    editor.value = "ローカル版\n";
    editor.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    const file = h.files["README.md"];
    if (file) {
      file.raw = "サーバ版\n";
      file.html = "<p>サーバ版</p>";
      file.sha = "sha-readme-2";
    }
    h.click(h.el("edit-btn"));
    await h.flush(6);
    h.click(h.el("conflict-show-diff"));
    await h.flush();
    expect(conflictDiff().hidden).toBe(false);

    // その上にクイックオープンは開けない（手前が競合ダイアログなので）
    pressCtrlP();
    await h.flush();
    expect(quickOpen().hidden).toBe(true);

    // Esc で競合ダイアログだけが閉じ、フォーカスが呼び出し元へ戻る
    pressEsc();
    await h.flush();
    expect(conflictDiff().hidden).toBe(true);
    expect(h.document.activeElement).not.toBe(h.document.body);

    // 閉じたのでクイックオープンが開けるようになる
    pressCtrlP();
    await h.flush();
    expect(quickOpen().hidden).toBe(false);
    expect(h.document.activeElement).toBe(h.el("quick-open-input"));
  });
});

describe("全画面モーダルが開いている間のショートカット (Issue #112)", () => {
  test("競合ダイアログの裏でクイックオープンが開かない", async () => {
    h = await boot();
    open("conflictDiff");

    pressCtrlP();
    await h.flush();

    // 以前は z-index 60 のパネルが 70 のスクリムの下に開き、
    // **フォーカスだけがトラップの外へ出て**いた
    expect(openState()).toMatchObject({ quickOpen: false, conflictDiff: true });
  });

  test("競合ダイアログの裏で TOC が開かない", async () => {
    // TOC は「ファイルを開いている」ことが前提（`state.currentPath` を見る）
    h = await boot({ url: "http://localhost:3944/?path=docs/guide.md" });
    open("conflictDiff");

    pressCtrlShiftO();
    await h.flush();

    expect(h.el("toc-panel").hidden).toBe(true);
  });

  test("競合ダイアログの裏で保存が走らない", async () => {
    h = await boot({ url: "http://localhost:3944/?path=docs/guide.md" });
    h.el<HTMLButtonElement>("edit-btn").click();
    await h.flush();
    const before = h.fetchCalls.length;

    open("conflictDiff");
    pressCtrlS();
    await h.flush();

    // **保存の失敗で出たダイアログの上から、同じ保存が走るのは筋が通らない**
    expect(h.fetchCalls.length).toBe(before);
  });

  test("クイックオープン自身のトグルは通る（自分が最前面なら閉じられる）", async () => {
    h = await boot();
    pressCtrlP();
    await h.flush();
    expect(quickOpen().hidden).toBe(false);

    pressCtrlP();
    await h.flush();
    expect(quickOpen().hidden).toBe(true);
  });

  test("抑止したショートカットはブラウザ既定にも渡さない", async () => {
    h = await boot();
    open("conflictDiff");

    // **抑止するときも奪う。** 奪わないと `Ctrl/Cmd+P` はブラウザの印刷ダイアログ、
    // `Ctrl/Cmd+S` は「名前を付けてページを保存」に抜ける
    // （`app-quick-open.js` 自身が「印刷ダイアログを奪うので preventDefault は必須」と
    //  書いている不変条件を、抑止を足したときに壊していた）
    const ctrlP = new h.window.KeyboardEvent("keydown", {
      key: "p",
      code: "KeyP",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    h.document.dispatchEvent(ctrlP);
    await h.flush();

    expect(ctrlP.defaultPrevented).toBe(true);
    expect(quickOpen().hidden).toBe(true);
  });

  test("全画面でないもの（sidebar・⋮ メニュー）はショートカットを塞がない", async () => {
    h = await boot();
    open("sidebar");
    open("overflowMenu");

    pressCtrlP();
    await h.flush();

    // **塞ぐと引き出しを開いたままファイルを探せなくなる。**
    // これらは「背後に別のパネルが開く」問題を起こさないので止める理由がない
    expect(quickOpen().hidden).toBe(false);
  });
});

/**
 * スマホ幅の全画面 TOC (Issue #135)。
 *
 * #112 は TOC を優先順位の表に載せなかった。**`Esc` で閉じる導線が無いのに最前面として
 * 登録すると「最前面なのに誰も閉じない」状態になり、背後の sidebar まで `Esc` で
 * 閉じられなくなる**ため。閉じる導線とセットで入れるのがこの Issue。
 *
 * ここは**重なった状態**だけを見る（単体の開閉は `tests/app-preview.test.ts`）。
 */
describe("スマホ幅の全画面 TOC (Issue #135)", () => {
  test("Esc で閉じる", async () => {
    h = await boot({ url: "http://localhost:3944/?path=docs/guide.md", mobile: true });
    open("tocPanel");

    pressEsc();
    expect(openState()).toMatchObject({ tocPanel: false });
  });

  /**
   * **これが #112 が恐れていた壊れ方。** TOC を表に載せただけで `Esc` を足さないと、
   * TOC が最前面を占め続けて sidebar が閉じられなくなる。
   */
  test("TOC を閉じたら、次の Esc で背後の sidebar が閉じる", async () => {
    h = await boot({ url: "http://localhost:3944/?path=docs/guide.md", mobile: true });
    open("sidebar");
    open("tocPanel");

    pressEsc();
    // 最前面の TOC だけが閉じる。sidebar は残る
    expect(openState()).toMatchObject({ tocPanel: false, sidebar: true });

    pressEsc();
    expect(openState()).toMatchObject({ tocPanel: false, sidebar: false });
  });

  /**
   * **クイックオープンは TOC より手前。**
   *
   * どちらも `z-index: 60` だが、`index.html` で後に置かれているクイックオープンが
   * 上に描かれる。優先順位を同着（どちらも 60）にすると `topOverlay` が先勝ちで TOC を
   * 返し、**上に見えているクイックオープンが `Esc` で閉じられなくなる**。
   */
  test("TOC の上に開いたクイックオープンが先に閉じる", async () => {
    h = await boot({ url: "http://localhost:3944/?path=docs/guide.md", mobile: true });
    open("tocPanel");
    open("quickOpen");

    pressEsc();
    expect(openState()).toMatchObject({ quickOpen: false, tocPanel: true });

    pressEsc();
    expect(openState()).toMatchObject({ quickOpen: false, tocPanel: false });
  });

  /**
   * **これが `blocksShortcuts: false` の一番効く根拠。**
   *
   * `Ctrl/Cmd+Shift+O` は `shortcutsBlocked(els)` を `exceptFor` 無しで通すので、
   * TOC が「塞ぐ層」になった瞬間に**開いた TOC を同じキーで閉じられなくなる**。
   */
  test("TOC が開いていても Ctrl/Cmd+Shift+O で閉じられる", async () => {
    h = await boot({ url: "http://localhost:3944/?path=docs/guide.md", mobile: true });

    // **本来の導線で開ける。** `hidden` を直接外すと `state.tocVisible` が立たず、
    // トグルが「閉じる」ではなく「開く」に倒れて、この検証が成立しない
    pressCtrlShiftO();
    await h.flush();
    expect(openState()).toMatchObject({ tocPanel: true });

    pressCtrlShiftO();
    await h.flush();
    expect(openState()).toMatchObject({ tocPanel: false });
  });

  /**
   * **TOC の上からクイックオープンを開ける。**
   *
   * `Ctrl/Cmd+P` も `shortcutsBlocked` を通るので、`true` にすると塞がれる。
   */
  test("TOC が開いていても Ctrl/Cmd+P でクイックオープンを開ける", async () => {
    h = await boot({ url: "http://localhost:3944/?path=docs/guide.md", mobile: true });
    open("tocPanel");

    pressCtrlP();
    await h.flush();

    expect(openState()).toMatchObject({ quickOpen: true, tocPanel: true });
  });

  /**
   * **`Ctrl/Cmd+S` は現状の UI では TOC と共存しない。**
   *
   * 編集モードに入ると TOC は自動で閉じる（`app-editor.js` の `tocSuspended`）ので、
   * ここは**直接 `hidden` を外して**その状態を作っている。UI からは到達できないが、
   * 表の値が変わったときに気づけるようにしておく。
   */
  test("TOC が開いていても Ctrl/Cmd+S で保存できる", async () => {
    h = await boot({ url: "http://localhost:3944/?path=docs/guide.md" });
    h.el<HTMLButtonElement>("edit-btn").click();
    await h.flush();
    h.el<HTMLTextAreaElement>("editor").value = "# 変更\n";
    h.el("editor").dispatchEvent(new h.window.Event("input", { bubbles: true }));
    await h.flush();

    open("tocPanel");
    const before = h.fetchCalls.filter((c) => c.method === "POST").length;
    pressCtrlS();
    await h.flush(4);

    expect(h.fetchCalls.filter((c) => c.method === "POST").length).toBe(before + 1);
  });

  /** 競合ダイアログ（70）は TOC より手前。開いている間は TOC の Esc を通さない。 */
  test("競合ダイアログの裏の TOC は Esc で閉じない", async () => {
    h = await boot({ url: "http://localhost:3944/?path=docs/guide.md", mobile: true });
    open("tocPanel");
    open("conflictDiff");

    pressEsc();
    expect(openState()).toMatchObject({ conflictDiff: false, tocPanel: true });
  });
});
