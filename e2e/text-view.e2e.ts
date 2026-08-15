import { expect, test } from "@playwright/test";
import { openFile, treeItem } from "./helpers.ts";

/**
 * md 以外のテキストファイルを読み取り専用で開くフロー (Issue #155)。
 *
 * **実ブラウザでしか確かめられないところ**に絞る:
 *
 * - 同梱した `public/vendor/highlight.js` が実際に読み込まれて色が付くか
 *   （jsdom 側の特性テストも実物を import しているが、CSP `script-src 'self'` の下で
 *   ブラウザが読めるかはここでしか分からない）
 * - `pre.text-view` が実 CSS で折り返して表示されるか
 * - 種別が切り替わったときにヘッダのボタン状態が実 DOM で追従するか
 *
 * 判定ロジックの網羅は `tests/app-text-view.test.ts` の担当。
 */

test("テキストファイルをツリーから開くと中身が読み取り専用で表示される", async ({ page }) => {
  await page.goto("/");

  // ツリーに md 以外も並ぶ（アイコンのクラスで種別が分かる）
  await expect(treeItem(page, "notes.txt")).toBeVisible();
  await expect(treeItem(page, "notes.txt")).toHaveClass(/is-text/);
  await expect(treeItem(page, "README.md")).not.toHaveClass(/is-text/);

  await openFile(page, "notes.txt");

  const code = page.locator("#preview pre.text-view > code");
  await expect(code).toBeVisible();
  await expect(code).toContainText("yomi E2E fixture (plain text)");
  await expect(page.locator("#preview")).toHaveClass(/is-text/);

  // 読み取り専用であることが画面に出て、編集の導線は押せない
  await expect(page.locator("#readonly-badge")).toBeVisible();
  await expect(page.locator("#edit-btn")).toBeDisabled();
  await expect(page.locator("#toc-btn")).toBeDisabled();
  await expect(page.locator("#download-images-btn")).toBeDisabled();
  // パスのコピーは種別を問わず使える
  await expect(page.locator("#current-path")).toBeEnabled();

  // 表示モードは preview 固定（split / md は raw しか無いと同じ中身が 2 つ並ぶ）
  await expect(page.locator("#content-body")).toHaveAttribute("data-mode", "preview");
  for (const mode of ["preview", "split", "md"]) {
    await expect(page.locator(`.view-toggle-btn[data-mode="${mode}"]`)).toBeDisabled();
  }
});

test("同梱した highlight.js で色が付く", async ({ page }) => {
  await page.goto("/");
  await openFile(page, "config.json");

  const code = page.locator("#preview pre.text-view > code");
  await expect(code).toHaveClass("language-json");
  // **実ブラウザで bundle が読めていること**の確認 (CSP `script-src 'self'` の下)
  await expect(code.locator("span.hljs-attr").first()).toBeVisible();
  // **色が実際に当たっている**ことを、地の文と違う色になることで見る
  // （具体的な色を固定するとテーマ変更のたびに落ちるので、差があることだけを見る）
  const colors = await code.evaluate((el) => {
    const token = el.querySelector("span.hljs-attr");
    return {
      base: getComputedStyle(el).color,
      token: token ? getComputedStyle(token).color : null,
      // inline style ではなく class で色を付けていること (Issue #59 でサニタイズが style を落とす)
      hasInlineStyle: token ? token.hasAttribute("style") : true,
    };
  });
  expect(colors.token).not.toBeNull();
  expect(colors.token).not.toBe(colors.base);
  expect(colors.hasInlineStyle).toBe(false);
});

test("Markdown へ戻ると編集できる状態に復帰する", async ({ page }) => {
  await page.goto("/");
  await openFile(page, "notes.txt");
  await expect(page.locator("#edit-btn")).toBeDisabled();

  await openFile(page, "README.md");

  await expect(page.locator("#preview")).not.toHaveClass(/is-text/);
  await expect(page.locator("#preview h1")).toHaveText("yomi E2E fixture");
  await expect(page.locator("#preview pre.text-view")).toHaveCount(0);
  await expect(page.locator("#readonly-badge")).toBeHidden();
  await expect(page.locator("#edit-btn")).toBeEnabled();
  await expect(page.locator(".view-toggle-btn[data-mode='split']")).toBeEnabled();
});
