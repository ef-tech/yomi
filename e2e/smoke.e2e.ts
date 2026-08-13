import { expect, test } from "@playwright/test";
import { openFile, treeItem } from "./helpers.ts";

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

  await expect(treeItem(page, "README.md")).toBeVisible();

  // **起動時に開くのはルート直下の README** (Issue #150)。無ければツリー先頭のファイル
  // （`sortTree` がディレクトリを先に並べるので fixture では `docs/guide.md`）に落ちる。
  await expect(page.locator("#current-path")).toHaveText("README.md");
  await expect(page.locator("#preview h1")).toHaveText("yomi E2E fixture");
  // README はルート直下なので、祖先の自動展開が起きない
  await expect(treeItem(page, "docs")).not.toHaveClass(/is-open/);

  // ディレクトリを開いて、その中のファイルへ遷移する
  await openFile(page, "docs/guide.md");

  await expect(page.locator("#preview h1")).toHaveText("ガイド");
  // 遷移が URL にも反映される (リロード復元・URL 共有の前提)
  await expect(page).toHaveURL(/\?path=docs%2Fguide\.md/);
});
