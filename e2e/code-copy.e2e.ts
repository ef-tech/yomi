import { expect, test } from "@playwright/test";
import { openFile } from "./helpers.ts";

/**
 * コードブロックのコピーボタン (Issue #165) の E2E。
 *
 * ## ここでしか見られないもの
 *
 * **実ブラウザのクリップボード**。jsdom の特性テストはハーネスが差し込んだ偽の
 * `navigator.clipboard` を見ているだけで、**実際に書き込めるか**は分からない。
 * ここは実 Chromium の Clipboard API で読み戻して確かめる。
 *
 * Mermaid にボタンが出ないことも、**実描画（`mermaid.run()` が `<pre>` を SVG に
 * 差し替える）を通したうえで**確かめられるのはここだけ。
 */

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await openFile(page, "docs/code.md");
});

test("コードブロックのボタンを押すと、その中身がクリップボードに入る", async ({ page }) => {
  // **ボタンは `<pre>` の外**（スクロールしない `.code-block` の直下）。
  // 中に入れると横に長い行でスクロールして流れる
  const button = page.locator("#preview .code-block > .code-copy-btn");
  await expect(button).toHaveCount(1);

  // **ホバーで出る（PC 幅）。** `click` は自動で hover するので、そのまま押せる
  await button.click();

  // 押した手応え
  await expect(button).toHaveClass(/is-copied/);

  // **実クリップボードから読み戻す。** 生テキストで、ハイライトの span もボタンの
  // ラベル（⧉）も混ざっていないこと
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toBe("const greet = (name) => `hello ${name}`;\n");
  expect(text).not.toContain("<span");
  expect(text).not.toContain("⧉");
});

test("Mermaid の図にはボタンが出ない（実描画を通しても）", async ({ page }) => {
  // 図が SVG になるまで待つ（描画前に数えると、まだ `<pre>` のままで判定が甘くなる）
  await expect(page.locator("#preview pre.mermaid svg")).toHaveCount(1);
  await expect(page.locator("#preview pre.mermaid .code-copy-btn")).toHaveCount(0);
  // 通常のコードブロックには出ている（セレクタが空振りしているだけ、を除外する）
  await expect(page.locator("#preview .code-copy-btn")).toHaveCount(1);
});

test("読み取り専用のテキストファイル表示にも出て、全体をコピーできる", async ({ page }) => {
  await openFile(page, "config.json");
  const button = page.locator("#preview .code-copy-btn");
  await expect(button).toHaveCount(1);

  await button.click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const raw = await page.evaluate(async () => {
    const res = await fetch(`/api/file?path=${encodeURIComponent("config.json")}`);
    return (await res.json()).raw as string;
  });
  expect(text).toBe(raw);
});
