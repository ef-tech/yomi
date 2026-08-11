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
import { type AppHarness, bootApp, resetAppEnvironment } from "./helpers/app-harness.ts";

let h: AppHarness;

afterEach(resetAppEnvironment);

const quickOpen = () => h.el("quick-open");
const conflictDiff = () => h.el("conflict-diff");
const sidebar = () => h.el("sidebar");
const banner = () => h.el("external-link-banner");
const overflowMenu = () => h.el("overflow-menu");

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
function open(name: "quickOpen" | "conflictDiff" | "banner" | "overflowMenu" | "sidebar") {
  if (name === "sidebar") sidebar().classList.add("is-open");
  else if (name === "quickOpen") quickOpen().hidden = false;
  else if (name === "conflictDiff") conflictDiff().hidden = false;
  else if (name === "banner") banner().hidden = false;
  else overflowMenu().hidden = false;
}

const openState = () => ({
  quickOpen: !quickOpen().hidden,
  conflictDiff: !conflictDiff().hidden,
  banner: !banner().hidden,
  overflowMenu: !overflowMenu().hidden,
  sidebar: sidebar().classList.contains("is-open"),
});

describe("重なったオーバーレイの Esc (Issue #112)", () => {
  test("Esc 1 回で最前面だけが閉じる（クイックオープン + 競合ダイアログ）", async () => {
    h = await bootApp();
    open("quickOpen");
    open("conflictDiff");

    pressEsc();
    // **最前面は競合ダイアログ (z-index 70)。** 以前はここで両方閉じていた
    expect(openState()).toMatchObject({ quickOpen: true, conflictDiff: false });

    pressEsc();
    expect(openState()).toMatchObject({ quickOpen: false, conflictDiff: false });
  });

  test("Esc 1 回で最前面だけが閉じる（sidebar + 外部リンクバナー）", async () => {
    h = await bootApp();
    open("sidebar");
    open("banner");

    pressEsc();
    expect(openState()).toMatchObject({ sidebar: true, banner: false });

    pressEsc();
    expect(openState()).toMatchObject({ sidebar: false, banner: false });
  });

  test("Esc 1 回で最前面だけが閉じる（sidebar + ⋮ メニュー）", async () => {
    h = await bootApp();
    open("sidebar");
    open("overflowMenu");

    pressEsc();
    expect(openState()).toMatchObject({ sidebar: true, overflowMenu: false });

    pressEsc();
    expect(openState()).toMatchObject({ sidebar: false, overflowMenu: false });
  });

  test("3 枚重なっても 1 回に 1 枚ずつ手前から閉じる", async () => {
    h = await bootApp();
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

describe("全画面モーダルが開いている間のショートカット (Issue #112)", () => {
  test("競合ダイアログの裏でクイックオープンが開かない", async () => {
    h = await bootApp();
    open("conflictDiff");

    pressCtrlP();
    await h.flush();

    // 以前は z-index 60 のパネルが 70 のスクリムの下に開き、
    // **フォーカスだけがトラップの外へ出て**いた
    expect(openState()).toMatchObject({ quickOpen: false, conflictDiff: true });
  });

  test("競合ダイアログの裏で TOC が開かない", async () => {
    // TOC は「ファイルを開いている」ことが前提（`state.currentPath` を見る）
    h = await bootApp({ url: "http://localhost:3944/?path=docs/guide.md" });
    open("conflictDiff");

    pressCtrlShiftO();
    await h.flush();

    expect(h.el("toc-panel").hidden).toBe(true);
  });

  test("競合ダイアログの裏で保存が走らない", async () => {
    h = await bootApp({ url: "http://localhost:3944/?path=docs/guide.md" });
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
    h = await bootApp();
    pressCtrlP();
    await h.flush();
    expect(quickOpen().hidden).toBe(false);

    pressCtrlP();
    await h.flush();
    expect(quickOpen().hidden).toBe(true);
  });

  test("全画面でないもの（sidebar・⋮ メニュー）はショートカットを塞がない", async () => {
    h = await bootApp();
    open("sidebar");
    open("overflowMenu");

    pressCtrlP();
    await h.flush();

    // **塞ぐと引き出しを開いたままファイルを探せなくなる。**
    // これらは「背後に別のパネルが開く」問題を起こさないので止める理由がない
    expect(quickOpen().hidden).toBe(false);
  });
});
