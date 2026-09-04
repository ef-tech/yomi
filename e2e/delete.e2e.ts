import { expect, test } from "@playwright/test";
import { treeItem } from "./helpers.ts";

/**
 * ツリーからの削除 (Issue #171)。
 *
 * **実ブラウザでしか確かめられないところだけを見る** —— hover で現れる削除ボタンが
 * 実 CSS で押せること、実 `window.confirm` を承認/キャンセルしたときの分岐。
 * 拒否条件（除外配下・symlink・ルート）は `tests/server.test.ts`、確認文言の組み立ては
 * `tests/app-tree.test.ts` が持つ。
 *
 * **fixture を消さない。** 自分で作ったファイルだけを消すので、失敗しても
 * `e2e/fixtures/` は元のまま（後始末の afterEach が要らない）。
 */

/** hover してから削除ボタンを押す。`opacity: 0` + `pointer-events: none` で隠れているため */
async function clickDelete(page: import("@playwright/test").Page, path: string) {
  const li = page.locator(`#tree li:has(> .tree-item[title="${path}"])`);
  await li.hover();
  await li.locator("> .tree-del-btn").click();
}

/** ツールバーから新規 md を作る（削除の対象を用意する） */
async function createFile(page: import("@playwright/test").Page, name: string) {
  await page.locator("#tree-new-file").click();
  const input = page.locator(".tree-new-input");
  await input.fill(name);
  await input.press("Enter");
  await expect(treeItem(page, `${name}.md`)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(treeItem(page, "README.md")).toBeVisible();
});

test("ディレクトリ行では「＋」と「×」が重ならない", async ({ page }) => {
  // **実 CSS でしか出ない**（jsdom はレイアウトを計算しない）。`is-in-dir` のずらし量が
  // 「＋」の幅より小さいと 1px 単位で重なり、「×」の右端が押せなくなる（実際に踏んだ）
  const boxes = await page.evaluate(() => {
    const li = document.querySelector('.tree-item[title="docs"]')?.closest("li");
    const add = li?.querySelector(":scope > .dir-new-btn")?.getBoundingClientRect();
    const del = li?.querySelector(":scope > .tree-del-btn")?.getBoundingClientRect();
    return add && del ? { addLeft: add.left, delRight: del.right } : null;
  });
  expect(boxes).not.toBeNull();
  expect(boxes?.delRight).toBeLessThanOrEqual(boxes?.addLeft ?? 0);
});

test("新規作成したファイルを、確認してから削除できる", async ({ page }) => {
  await createFile(page, "e2e-delete-target");

  // 実 confirm を承認する。**文言にパスが出ていること**も一緒に見る
  const messages: string[] = [];
  page.once("dialog", (dialog) => {
    messages.push(dialog.message());
    dialog.accept();
  });
  await clickDelete(page, "e2e-delete-target.md");

  await expect(treeItem(page, "e2e-delete-target.md")).toHaveCount(0);
  expect(messages[0]).toContain("e2e-delete-target.md");
  // API からも消えている（ツリーの描画だけでなく実体が消えたことを見る）
  const status = await page.evaluate(
    async () => (await fetch("/api/file?path=e2e-delete-target.md")).status,
  );
  expect(status).toBe(404);
});

test("確認をキャンセルすればファイルは残る", async ({ page }) => {
  await createFile(page, "e2e-delete-keep");

  page.once("dialog", (dialog) => dialog.dismiss());
  await clickDelete(page, "e2e-delete-keep.md");

  await expect(treeItem(page, "e2e-delete-keep.md")).toBeVisible();

  // 後始末: 承認して消す（fixture を汚したまま終わらない）
  page.once("dialog", (dialog) => dialog.accept());
  await clickDelete(page, "e2e-delete-keep.md");
  await expect(treeItem(page, "e2e-delete-keep.md")).toHaveCount(0);
});
