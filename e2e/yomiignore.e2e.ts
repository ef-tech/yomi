import { expect, test } from "@playwright/test";
import { treeItem } from "./helpers.ts";

/**
 * 除外設定パネル (Issue #164) の E2E。
 *
 * ## ここでしか見られないもの
 *
 * 「パネルで編集 → 保存 → **ツリーが本当に変わる**」は、`tests/` の特性テストでは
 * フェイクサーバの応答を見ているだけで、**実サーバが除外集合を差し替えたか**は分からない。
 * ここは実ブラウザ・実サーバ・実ファイルで、**保存が読み取り経路まで効く**ことを見る。
 *
 * ## 状態を持ち越さない
 *
 * `workers: 1` で fixture を共有するので、書き換えたら `afterEach` で必ず戻す
 * （`user-flows.e2e.ts` と同じ流儀。本文の末尾に置くと、途中で落ちたとき後続まで巻き添え）。
 */

/** 除外設定を API 経由で書き戻す（パネルを開かずに済ませる後始末用）。 */
async function resetYomiignore(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const res = await fetch("/api/yomiignore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    if (!res.ok) throw new Error(`POST /api/yomiignore が ${res.status}`);
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(treeItem(page, "README.md")).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await resetYomiignore(page);
});

test("パネルで除外を編集して保存すると、ツリーから消えて読めなくなる", async ({ page }) => {
  // 除外前: `docs/` がツリーにあり、中身も読める
  await expect(treeItem(page, "docs")).toBeVisible();

  await page.locator("#tree-yomiignore").click();
  await expect(page.locator("#yomiignore-panel")).toBeVisible();
  // 開いた時点でサーバの現在値（空）が入っている
  await expect(page.locator("#yomiignore-text")).toHaveValue("");

  await page.locator("#yomiignore-text").fill("docs\n");
  await page.locator("#yomiignore-save").click();

  // **ツリーから消える。** 保存の応答ではなく、実際の描画で確かめる
  await expect(treeItem(page, "docs")).toHaveCount(0);
  await expect(treeItem(page, "README.md")).toBeVisible();

  // 読み取り経路も塞がっている（除外は #65 以降 読み書きのゲート）
  const status = await page.evaluate(async () => {
    const res = await fetch(`/api/file?path=${encodeURIComponent("docs/guide.md")}`);
    return res.status;
  });
  expect(status).toBe(400);
});

test("否定パターンで既定の除外を解除すると、ツリーに現れる", async ({ page }) => {
  // `vendor` は DEFAULT_EXCLUDES なので、既定ではツリーに出ない
  await expect(treeItem(page, "vendor")).toHaveCount(0);

  await page.locator("#tree-yomiignore").click();
  await expect(page.locator("#yomiignore-panel")).toBeVisible();
  await page.locator("#yomiignore-text").fill("!vendor\n");
  await page.locator("#yomiignore-save").click();
  await expect(page.locator("#yomiignore-notice")).toHaveClass(/is-ok/);

  // **再読み込みせずにツリーへ現れる**（保存後にクライアントが取り直している）。
  // パネルは開いたままなので、背後で更新されていることをここで確かめられる
  await expect(treeItem(page, "vendor")).toBeVisible();

  // ツリーを触る前にパネルを閉じる（モーダルなのでポインタイベントを奪う）
  await page.keyboard.press("Escape");
  await expect(page.locator("#yomiignore-panel")).toBeHidden();
  await treeItem(page, "vendor").click();
  await expect(treeItem(page, "vendor/bundled.md")).toBeVisible();

  // 読み取りも通るようになる（ツリーに出るだけでなくゲートが開いている）
  const status = await page.evaluate(async () => {
    const res = await fetch(`/api/file?path=${encodeURIComponent("vendor/bundled.md")}`);
    return res.status;
  });
  expect(status).toBe(200);
});

test("照合できない行は行番号つきでパネルに出る", async ({ page }) => {
  await page.locator("#tree-yomiignore").click();
  await expect(page.locator("#yomiignore-panel")).toBeVisible();

  await page.locator("#yomiignore-text").fill("secret\ndocs/private\n*.log\n");
  await page.locator("#yomiignore-save").click();

  const items = page.locator("#yomiignore-invalid .yomiignore-invalid-item");
  await expect(items).toHaveCount(2);
  // 行番号は 1 始まりで、書いた行を指す
  await expect(items.nth(0)).toContainText(".yomiignore:2: docs/private");
  await expect(items.nth(1)).toContainText(".yomiignore:3: *.log");
  // **捨てた行と残した行を見分けられる**（グロブは除外として生きている）
  await expect(items.nth(0)).toHaveClass(/is-dropped/);
  await expect(items.nth(1)).not.toHaveClass(/is-dropped/);
});

test("Esc で閉じ、開いたボタンにフォーカスが戻る", async ({ page }) => {
  await page.locator("#tree-yomiignore").click();
  await expect(page.locator("#yomiignore-panel")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("#yomiignore-panel")).toBeHidden();
  await expect(page.locator("#tree-yomiignore")).toBeFocused();
});
