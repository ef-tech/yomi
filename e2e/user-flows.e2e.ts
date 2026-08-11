import { expect, type Page, test } from "@playwright/test";

/**
 * 主要ユーザーフロー 6 種の E2E (Issue #82)。
 *
 * **基盤の疎通確認は `smoke.e2e.ts` が持つ。** ここは機能の網羅で、基盤が壊れたときに
 * 「何本落ちたか」で原因を切り分けられるようファイルを分けている (#80 の申し送り)。
 *
 * ## ここに書くもの / 書かないもの
 *
 * `playwright.config.ts` の分担どおり、**実ブラウザでしか出ない結合**だけを置く ——
 * 実 CSS のレイアウト（モバイルの drawer）、実 DOM イベント、Mermaid の実描画、
 * 実 history API（戻る・進む）、実 `window.confirm`。
 * ロジックの網羅は `tests/` の特性テストの仕事で、E2E を増やすほど CI は遅く不安定になる。
 *
 * ## flaky を持ち込まないために
 *
 * - **固定 sleep を使わない。** `expect(locator)` の auto-retry で同期する
 * - **状態を持ち越さない。** yomi は書き込み API を持つので、fixture を書き換えるテストは
 *   **自分で後始末する**（`playwright.config.ts` が tmp へコピーしているので git は汚れないが、
 *   同じ実行内の後続テストには影響する。`workers: 1` なので順に走る）
 * - **UI ラベルに依存しすぎない。** `locale: "en-US"` 固定だが、文言は i18n で変わりうるので
 *   ID とロール中心でロケータを書く
 */

/**
 * ツリーの項目は `title` 属性にフルパスを持つ。
 *
 * `smoke.e2e.ts` と同じ理由（accessible name に装飾アイコンが混ざる）。
 */
const treeItem = (page: Page, path: string) => page.locator(`#tree .tree-item[title="${path}"]`);

/** 表示中のファイルが切り替わるまで待つ。全フローの起点になるので 1 箇所に置く。 */
async function openFile(page: Page, path: string) {
  await treeItem(page, path).click();
  await expect(page.locator("#current-path")).toHaveText(path);
}

/**
 * fixture の中身を API から読む。
 *
 * **`#editor` の値で代用しない。** エディタが埋まるのは編集モードに入ってからで、
 * それ以前は空文字。それを「元の内容」として後始末に使うと**ファイルを空で上書きする**
 * （実際に踏んで、後続 2 テストが「見出しが無い」「リンクが無い」で落ちた）。
 */
async function readFile(page: Page, path: string): Promise<string> {
  return await page.evaluate(
    async (p) => (await fetch(`/api/file?path=${encodeURIComponent(p)}`).then((r) => r.json())).raw,
    path,
  );
}

/** fixture を元に戻す。**書き換えたテストは必ず呼ぶ**（`workers: 1` なので後続に効く）。 */
async function restoreFile(page: Page, path: string, raw: string) {
  await page.evaluate(
    async ({ p, body }) => {
      const cur = await fetch(`/api/file?path=${encodeURIComponent(p)}`).then((r) => r.json());
      await fetch("/api/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p, body, baseSha: cur.sha }),
      });
    },
    { p: path, body: raw },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // 初期表示が終わるまで待つ（ツリーの描画と最初のファイルの反映）
  await expect(treeItem(page, "README.md")).toBeVisible();
  await expect(page.locator("#current-path")).toHaveText("docs/guide.md");
});

// ───────────────────────────────────────────────────────────
// 1. ファイル選択、内部リンク、戻る・進む
// ───────────────────────────────────────────────────────────

test("ファイル選択 → 内部リンク → 戻る・進むで履歴を行き来できる", async ({ page }) => {
  await openFile(page, "README.md");
  await expect(page.locator("#preview h1")).toHaveText("yomi E2E fixture");

  // **本文中の相対リンク**を踏む。`navigateTo` を通るので URL も履歴も更新される
  await page.locator("#preview a", { hasText: "ガイド" }).click();
  await expect(page.locator("#current-path")).toHaveText("docs/guide.md");
  await expect(page).toHaveURL(/\?path=docs%2Fguide\.md/);

  // **実 history API。** jsdom の特性テストはスタブなので、ここは E2E でしか守れない
  await page.goBack();
  await expect(page.locator("#current-path")).toHaveText("README.md");
  await expect(page.locator("#preview h1")).toHaveText("yomi E2E fixture");

  await page.goForward();
  await expect(page.locator("#current-path")).toHaveText("docs/guide.md");
  await expect(page.locator("#preview h1")).toHaveText("ガイド");

  // ツリーの選択ハイライトも履歴に追随する（現在地を見失わない）
  await expect(treeItem(page, "docs/guide.md")).toHaveClass(/is-selected/);
});

// ───────────────────────────────────────────────────────────
// 2. 編集、保存、未保存確認、競合表示
// ───────────────────────────────────────────────────────────

test("編集して保存でき、未保存のまま離れようとすると確認が出る", async ({ page }) => {
  await openFile(page, "docs/links.md");
  const original = await readFile(page, "docs/links.md");

  await page.locator("#edit-btn").click();
  await expect(page.locator("#content-body")).toHaveClass(/is-editing/);

  const editor = page.locator("#editor");
  await editor.fill(`${await editor.inputValue()}\n\nE2E で追記した行。\n`);
  // 未保存の印が出る
  await expect(page.locator("#dirty-indicator")).toBeVisible();

  // **未保存のまま別ファイルへ行こうとすると confirm が出る。** キャンセルすると留まる
  page.once("dialog", (d) => d.dismiss());
  await treeItem(page, "README.md").click();
  await expect(page.locator("#current-path")).toHaveText("docs/links.md");
  await expect(page.locator("#content-body")).toHaveClass(/is-editing/);

  // **Ctrl+S で保存**（主要ショートカット）
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toBeHidden();
  await expect(page.locator("#status")).toContainText("docs/links.md");

  // プレビューに反映されている（保存後の再描画）
  await page.locator("#edit-btn").click();
  await expect(page.locator("#content-body")).not.toHaveClass(/is-editing/);
  await expect(page.locator("#preview")).toContainText("E2E で追記した行。");

  // **後始末。** 同じ実行の後続テストに持ち越さない
  await restoreFile(page, "docs/links.md", original);
  expect(await readFile(page, "docs/links.md")).toBe(original);
});

test("他所で更新されたファイルを保存しようとすると競合が出る", async ({ page }) => {
  await openFile(page, "docs/outline.md");
  const original = await readFile(page, "docs/outline.md");

  // 編集モードに入った時点の sha が基準になる
  await page.locator("#edit-btn").click();
  await expect(page.locator("#content-body")).toHaveClass(/is-editing/);

  // **裏で別の誰かが保存した状態を作る。** ブラウザが持つ sha が古くなる
  await page.evaluate(async () => {
    const cur = await fetch("/api/file?path=docs/outline.md").then((r) => r.json());
    await fetch("/api/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "docs/outline.md",
        body: `${cur.raw}\n\n別の誰かが書いた行。\n`,
        baseSha: cur.sha,
      }),
    });
  });

  const editor = page.locator("#editor");
  await editor.fill(`${await editor.inputValue()}\n\nこちらの編集。\n`);
  await page.keyboard.press("Control+s");

  // **競合バナーが出て、上書きされていない**
  await expect(page.locator("#conflict-banner")).toBeVisible();
  await expect(page.locator("#conflict-show-diff")).toBeVisible();

  // 差分ダイアログを開くと、両者の違いが行として並ぶ (Issue #57)
  await page.locator("#conflict-show-diff").click();
  await expect(page.locator("#conflict-diff")).toBeVisible();
  await expect(page.locator("#conflict-diff-body .conflict-diff-row.is-add")).toHaveCount(1);
  await expect(page.locator("#conflict-diff-body")).toContainText("こちらの編集。");

  // Esc で差分だけ閉じる（背後のバナーは残る = 判断がまだ済んでいない）
  await page.keyboard.press("Escape");
  await expect(page.locator("#conflict-diff")).toBeHidden();
  await expect(page.locator("#conflict-banner")).toBeVisible();

  // 後始末: サーバ版を取り込んでから元へ戻す
  await page.locator("#conflict-take-server").click();
  await expect(page.locator("#conflict-banner")).toBeHidden();
  await restoreFile(page, "docs/outline.md", original);
  expect(await readFile(page, "docs/outline.md")).toBe(original);
});

// ───────────────────────────────────────────────────────────
// 3. 新規 Markdown 作成
// ───────────────────────────────────────────────────────────

test("新規 Markdown を作るとツリーに現れ、そのまま編集モードで開く", async ({ page }) => {
  await page.locator("#tree-new-file").click();

  // インライン入力欄が出てフォーカスが当たる（キーボードだけで完結する）
  const input = page.locator(".tree-new-input");
  await expect(input).toBeFocused();

  await input.fill("e2e-new");
  await input.press("Enter");

  // 拡張子が補完され、ツリーに現れて編集モードで開く
  await expect(treeItem(page, "e2e-new.md")).toBeVisible();
  await expect(page.locator("#current-path")).toHaveText("e2e-new.md");
  await expect(page.locator("#content-body")).toHaveClass(/is-editing/);

  // 後始末はできない（削除 API が無い）ので、**後続に影響しないことを確かめておく**。
  // ルート直下にファイルが 1 つ増えるだけで、ディレクトリ優先の並びは崩れない
  // （`.tree-item` にはディレクトリのボタンも含まれるので、先頭は `docs`）
  await expect(page.locator("#tree .tree-item").first()).toHaveAttribute("title", "docs");
  await expect(page.locator("#tree .tree-item.is-file").first()).toHaveAttribute(
    "title",
    "docs/guide.md",
  );
});

// ───────────────────────────────────────────────────────────
// 4. Mermaid 描画
// ───────────────────────────────────────────────────────────

test("Mermaid のコードブロックが SVG として描画される", async ({ page }) => {
  await openFile(page, "docs/mermaid.md");

  // **実描画を見る。** jsdom は SVG のレイアウトを持たないので、ここは E2E でしか守れない
  const svg = page.locator("#preview pre.mermaid svg");
  await expect(svg).toBeVisible();
  await expect(svg).toContainText("開始");
  await expect(svg).toContainText("終了");

  // 別ファイルへ移って戻っても描き直される（再描画の取りこぼしが無い）
  await openFile(page, "README.md");
  await openFile(page, "docs/mermaid.md");
  await expect(page.locator("#preview pre.mermaid svg")).toBeVisible();
});

// ───────────────────────────────────────────────────────────
// 5. TOC と主要キーボードショートカット
// ───────────────────────────────────────────────────────────

test("TOC とクイックオープンがショートカットで開閉できる", async ({ page }) => {
  await openFile(page, "docs/outline.md");

  // **Ctrl+Shift+O で目次**
  await page.keyboard.press("Control+Shift+O");
  await expect(page.locator("#toc-panel")).toBeVisible();
  // H1-H3 が既定（"h3" レベル）。fixture は H1×1 + H2×3 + H3×1
  await expect(page.locator("#toc-list button")).toHaveCount(5);

  // **見出しをクリックすると本文がそこへ動く。** 実レイアウトが要るので jsdom では見られない
  // （`scrollTop` が常に 0）。**どのコンテナがスクロールするかに依存しない形**で見るため、
  // 対象の見出しがビューポートに入ったことを確かめる
  const target = page.locator("#preview h2", { hasText: "節 3" });
  await expect(target).not.toBeInViewport();
  await page.locator("#toc-list button", { hasText: "節 3" }).click();
  await expect(target).toBeInViewport();

  await page.keyboard.press("Control+Shift+O");
  await expect(page.locator("#toc-panel")).toBeHidden();

  // **Ctrl+P でクイックオープン**
  await page.keyboard.press("Control+p");
  await expect(page.locator("#quick-open")).toBeVisible();
  await expect(page.locator("#quick-open-input")).toBeFocused();

  await page.locator("#quick-open-input").fill("mermaid");
  await expect(page.locator(".quick-open-item")).toHaveCount(1);
  await page.locator("#quick-open-input").press("Enter");

  await expect(page.locator("#quick-open")).toBeHidden();
  await expect(page.locator("#current-path")).toHaveText("docs/mermaid.md");

  // Esc で閉じられる（開いたまま閉じ込められない）
  await page.keyboard.press("Control+p");
  await expect(page.locator("#quick-open")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#quick-open")).toBeHidden();
});

test("外部リンクは警告バナーを挟み、Esc で閉じられる", async ({ page }) => {
  await openFile(page, "docs/links.md");

  await page.locator("#preview a", { hasText: "外部サイトへ" }).click();

  // **いきなり開かない。** 行き先を見せてから確認する
  await expect(page.locator("#external-link-banner")).toBeVisible();
  await expect(page.locator("#external-link-url")).toHaveText("https://example.com/");

  await page.keyboard.press("Escape");
  await expect(page.locator("#external-link-banner")).toBeHidden();
});

// ───────────────────────────────────────────────────────────
// 6. モバイルメニューの開閉
// ───────────────────────────────────────────────────────────

test("スマホ幅では drawer と ⋮ メニューが開閉する", async ({ page }) => {
  // **実 CSS のブレークポイント**を通す（`MOBILE_MEDIA_QUERY` は max-width: 767px）
  await page.setViewportSize({ width: 390, height: 844 });

  const sidebar = page.locator("#sidebar");
  const backdrop = page.locator("#sidebar-backdrop");

  // 既定では畳まれている
  await expect(sidebar).not.toHaveClass(/is-open/);

  await page.locator("#menu-btn").click();
  await expect(sidebar).toHaveClass(/is-open/);
  await expect(backdrop).toBeVisible();

  // ファイルを選ぶと自動で閉じる（狭い画面で本文が隠れたままにならない）
  await treeItem(page, "README.md").click();
  await expect(page.locator("#current-path")).toHaveText("README.md");
  await expect(sidebar).not.toHaveClass(/is-open/);

  // backdrop でも閉じられる
  await page.locator("#menu-btn").click();
  await expect(sidebar).toHaveClass(/is-open/);
  await backdrop.click();
  await expect(sidebar).not.toHaveClass(/is-open/);

  // **⋮ メニュー**（スマホ専用）
  const overflow = page.locator("#overflow-menu");
  await expect(overflow).toBeHidden();
  await page.locator("#overflow-btn").click();
  await expect(overflow).toBeVisible();

  // 外側クリックで閉じる
  await page.locator("#preview").click({ position: { x: 10, y: 10 } });
  await expect(overflow).toBeHidden();
});
