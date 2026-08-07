import { expect, test } from "@playwright/test";

/**
 * E2E 基盤が動くことを示す最小フロー (Issue #80)。
 *
 * **ここには「基盤が生きているか」だけを置く。** 主要ユーザーフロー 6 種は #82 が追加する。
 * 基盤の疎通確認と機能の網羅を同じファイルに混ぜると、基盤が壊れたときに何本落ちたかで
 * 原因を切り分けられなくなる。
 *
 * 固定 sleep は使わない (`playwright.config.ts` の方針)。`expect(locator)` の
 * auto-retry で同期する。
 */
test("ファイルを選ぶとプレビューに描画される", async ({ page }) => {
  await page.goto("/");

  const tree = page.locator("#tree");
  await expect(tree.getByRole("button", { name: "README.md" })).toBeVisible();

  // **起動時に開くのはツリー先頭のファイル。** scanner がディレクトリを先に並べるので
  // (`sortTree`)、fixture では `docs/guide.md` が先頭になる。README.md ではない。
  await expect(page.locator("#current-path")).toHaveText("docs/guide.md");
  await expect(page.locator("#preview h1")).toHaveText("ガイド");

  // ルート直下のファイルへ遷移する
  await tree.getByRole("button", { name: "README.md" }).click();

  await expect(page.locator("#current-path")).toHaveText("README.md");
  await expect(page.locator("#preview h1")).toHaveText("yomi E2E fixture");
  // 遷移が URL にも反映される (リロード復元・URL 共有の前提)
  await expect(page).toHaveURL(/\?path=README\.md/);
});
