import { expect, type Page, test } from "@playwright/test";

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
/**
 * ツリーの項目は `title` 属性にフルパスを持つ。
 *
 * **`getByRole("button", { name })` を使わない。** `.tree-item` の accessible name には
 * 装飾アイコン (`.icon::before` の `≡` / `▸`) が混ざるため完全一致にできず、部分一致だと
 * `README.md` が `SUB-README.md` にもマッチして strict mode violation になる (#82 で
 * fixture が増えたときに踏む)。`title` なら一意で完全一致。
 */
const treeItem = (page: Page, path: string) => page.locator(`#tree .tree-item[title="${path}"]`);

test("ファイルを選ぶとプレビューに描画される", async ({ page }) => {
  await page.goto("/");

  await expect(treeItem(page, "README.md")).toBeVisible();

  // **起動時に開くのはツリー先頭のファイル。** scanner がディレクトリを先に並べるので
  // (`sortTree`)、fixture では `docs/guide.md` が先頭になる。README.md ではない。
  await expect(page.locator("#current-path")).toHaveText("docs/guide.md");
  await expect(page.locator("#preview h1")).toHaveText("ガイド");

  // ルート直下のファイルへ遷移する
  await treeItem(page, "README.md").click();

  await expect(page.locator("#current-path")).toHaveText("README.md");
  await expect(page.locator("#preview h1")).toHaveText("yomi E2E fixture");
  // 遷移が URL にも反映される (リロード復元・URL 共有の前提)
  await expect(page).toHaveURL(/\?path=README\.md/);
});
