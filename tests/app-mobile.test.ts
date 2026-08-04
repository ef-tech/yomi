/**
 * 特性テスト: モバイル UI 責務 (Issue #77)
 *
 * sidebar overlay・⋮ overflow メニュー・sticky topbar の自動 hide・端スワイプという、
 * スマホ幅 (max-width: 767px) でだけ働く振る舞いを固定する。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type AppHarness, bootApp } from "./helpers/app-harness.ts";

let h: AppHarness;

afterEach(() => {
  h?.cleanup();
});

const isSidebarOpen = () => h.el("sidebar").classList.contains("is-open");

/** jsdom は TouchEvent を実装していないので、app.js が読む形だけを持つ Event を作る */
function touch(
  type: "touchstart" | "touchend",
  target: Element | Document,
  points: { clientX: number; clientY: number }[],
) {
  const ev = new h.window.Event(type, { bubbles: true });
  const key = type === "touchend" ? "changedTouches" : "touches";
  Object.defineProperty(ev, key, { value: points });
  target.dispatchEvent(ev);
}

/** jsdom はレイアウトを持たず scrollTop が常に 0 なので、書き換え可能にして値を注入する */
function setScrollTop(el: Element, value: number) {
  Object.defineProperty(el, "scrollTop", { value, configurable: true, writable: true });
  el.dispatchEvent(new h.window.Event("scroll", { bubbles: false }));
}

describe("sidebar overlay", () => {
  test("メニューボタンで開閉し、backdrop と aria-expanded が同期する", async () => {
    h = await bootApp({ mobile: true });
    expect(isSidebarOpen()).toBe(false);
    expect(h.el("sidebar-backdrop").hidden).toBe(true);

    h.click(h.el("menu-btn"));
    expect(isSidebarOpen()).toBe(true);
    expect(h.el("sidebar-backdrop").hidden).toBe(false);
    expect(h.el("menu-btn").getAttribute("aria-expanded")).toBe("true");

    h.click(h.el("menu-btn"));
    expect(isSidebarOpen()).toBe(false);
    expect(h.el("sidebar-backdrop").hidden).toBe(true);
    expect(h.el("menu-btn").getAttribute("aria-expanded")).toBe("false");
  });

  test("backdrop クリックで閉じる", async () => {
    h = await bootApp({ mobile: true });
    h.click(h.el("menu-btn"));
    h.click(h.el("sidebar-backdrop"));
    expect(isSidebarOpen()).toBe(false);
  });

  test("Esc で閉じる。ただし外部 URL バナーが出ていたらそちらを優先する", async () => {
    h = await bootApp({ mobile: true });
    h.click(h.el("menu-btn"));

    // 外部リンクバナーを開いた状態では sidebar は閉じない
    const a = h.document.createElement("a");
    a.setAttribute("href", "https://example.com/");
    h.el("preview").appendChild(a);
    h.click(a);
    expect(h.el("external-link-banner").hidden).toBe(false);

    h.keydown(h.document, { key: "Escape" });
    expect(h.el("external-link-banner").hidden).toBe(true);
    expect(isSidebarOpen()).toBe(true);

    h.keydown(h.document, { key: "Escape" });
    expect(isSidebarOpen()).toBe(false);
  });

  test("スマホ幅ではファイルを選ぶと自動で閉じる", async () => {
    h = await bootApp({ mobile: true });
    h.click(h.el("menu-btn"));
    expect(isSidebarOpen()).toBe(true);

    h.click(h.treeItem("docs/guide.md"));
    await h.flush();

    expect(isSidebarOpen()).toBe(false);
    expect(h.el("current-path").textContent).toBe("docs/guide.md");
  });

  test("デスクトップ幅ではファイルを選んでも閉じない", async () => {
    h = await bootApp({ mobile: false });
    h.click(h.el("menu-btn"));
    h.click(h.treeItem("docs/guide.md"));
    await h.flush();

    expect(isSidebarOpen()).toBe(true);
  });

  test("デスクトップ幅に戻ると overlay を閉じる", async () => {
    h = await bootApp({ mobile: true });
    h.click(h.el("menu-btn"));
    expect(isSidebarOpen()).toBe(true);

    h.setMobile(false);
    expect(isSidebarOpen()).toBe(false);
  });
});

describe("⋮ overflow メニュー", () => {
  test("ボタンで開閉し、aria-expanded が同期する", async () => {
    h = await bootApp({ mobile: true });
    expect(h.el("overflow-menu").hidden).toBe(true);

    h.click(h.el("overflow-btn"));
    expect(h.el("overflow-menu").hidden).toBe(false);
    expect(h.el("overflow-btn").getAttribute("aria-expanded")).toBe("true");

    h.click(h.el("overflow-btn"));
    expect(h.el("overflow-menu").hidden).toBe(true);
  });

  test("メニュー外のクリックで閉じ、メニュー内のクリックでは閉じない", async () => {
    h = await bootApp({ mobile: true });
    h.click(h.el("overflow-btn"));

    h.click(h.el("overflow-menu"));
    expect(h.el("overflow-menu").hidden).toBe(false);

    h.click(h.el("preview"));
    expect(h.el("overflow-menu").hidden).toBe(true);
  });

  test("Esc で閉じる", async () => {
    h = await bootApp({ mobile: true });
    h.click(h.el("overflow-btn"));
    h.keydown(h.document, { key: "Escape" });
    expect(h.el("overflow-menu").hidden).toBe(true);
  });

  test("メニュー内のテーマ / 表示モードは PC 側トグルと同じ結果になる", async () => {
    h = await bootApp({ mobile: true });
    h.click(h.el("overflow-btn"));

    h.click(h.q('.overflow-theme-btn[data-theme-mode="dark"]'));
    await h.flush();
    expect(h.document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(h.q('.theme-toggle-btn[data-theme-mode="dark"]').getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(h.q('.overflow-theme-btn[data-theme-mode="dark"]').getAttribute("aria-pressed")).toBe(
      "true",
    );

    h.click(h.q('.overflow-view-btn[data-mode="md"]'));
    await h.flush();
    expect(h.el("content-body").dataset.mode).toBe("md");
    expect(h.q('.view-toggle-btn[data-mode="md"]').getAttribute("aria-selected")).toBe("true");
    expect(h.storageValue("yomi:viewMode:v1")).toBe("md");
  });

  test("メニューの編集ボタンはメニューを閉じてから編集モードへ入る", async () => {
    h = await bootApp({ mobile: true });
    h.click(h.el("overflow-btn"));
    h.click(h.el("overflow-edit"));
    await h.flush();

    expect(h.el("overflow-menu").hidden).toBe(true);
    expect(h.el("content-body").classList.contains("is-editing")).toBe(true);
    expect(h.el("overflow-edit").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("sticky topbar の自動 hide", () => {
  test("スマホ幅で下スクロールすると隠れ、上スクロールで戻る", async () => {
    h = await bootApp({ mobile: true });
    const topbar = h.q(".topbar");
    const preview = h.el("preview");

    setScrollTop(preview, 200);
    expect(topbar.classList.contains("is-hidden")).toBe(true);

    setScrollTop(preview, 100);
    expect(topbar.classList.contains("is-hidden")).toBe(false);
  });

  test("上端 30px 以内では常に表示する", async () => {
    h = await bootApp({ mobile: true });
    const topbar = h.q(".topbar");
    const preview = h.el("preview");

    setScrollTop(preview, 200);
    expect(topbar.classList.contains("is-hidden")).toBe(true);

    setScrollTop(preview, 10);
    expect(topbar.classList.contains("is-hidden")).toBe(false);
  });

  test("隠すときは overflow メニューも閉じる", async () => {
    h = await bootApp({ mobile: true });
    h.click(h.el("overflow-btn"));
    expect(h.el("overflow-menu").hidden).toBe(false);

    setScrollTop(h.el("preview"), 300);
    expect(h.el("overflow-menu").hidden).toBe(true);
  });

  test("デスクトップ幅では何もしない", async () => {
    h = await bootApp({ mobile: false });
    setScrollTop(h.el("preview"), 500);
    expect(h.q(".topbar").classList.contains("is-hidden")).toBe(false);
  });
});

describe("端スワイプでの drawer 開閉", () => {
  test("左端から右へスワイプすると開く", async () => {
    h = await bootApp({ mobile: true });
    touch("touchstart", h.document, [{ clientX: 10, clientY: 300 }]);
    touch("touchend", h.document, [{ clientX: 120, clientY: 310 }]);
    expect(isSidebarOpen()).toBe(true);
  });

  test("端から離れた位置で始めたスワイプでは開かない", async () => {
    h = await bootApp({ mobile: true });
    touch("touchstart", h.document, [{ clientX: 200, clientY: 300 }]);
    touch("touchend", h.document, [{ clientX: 320, clientY: 300 }]);
    expect(isSidebarOpen()).toBe(false);
  });

  test("縦の移動が大きいスワイプは無視する", async () => {
    h = await bootApp({ mobile: true });
    touch("touchstart", h.document, [{ clientX: 10, clientY: 300 }]);
    touch("touchend", h.document, [{ clientX: 120, clientY: 400 }]);
    expect(isSidebarOpen()).toBe(false);
  });

  test("drawer 内から左へスワイプすると閉じる", async () => {
    h = await bootApp({ mobile: true });
    h.click(h.el("menu-btn"));
    expect(isSidebarOpen()).toBe(true);

    touch("touchstart", h.el("tree"), [{ clientX: 200, clientY: 300 }]);
    touch("touchend", h.el("tree"), [{ clientX: 100, clientY: 300 }]);
    expect(isSidebarOpen()).toBe(false);
  });

  test("マルチタッチは無視する", async () => {
    h = await bootApp({ mobile: true });
    touch("touchstart", h.document, [
      { clientX: 10, clientY: 300 },
      { clientX: 40, clientY: 300 },
    ]);
    touch("touchend", h.document, [{ clientX: 120, clientY: 300 }]);
    expect(isSidebarOpen()).toBe(false);
  });

  test("デスクトップ幅ではスワイプに反応しない", async () => {
    h = await bootApp({ mobile: false });
    touch("touchstart", h.document, [{ clientX: 10, clientY: 300 }]);
    touch("touchend", h.document, [{ clientX: 120, clientY: 300 }]);
    expect(isSidebarOpen()).toBe(false);
  });
});
