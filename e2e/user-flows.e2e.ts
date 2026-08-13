import { expect, type Page, test } from "@playwright/test";
import { openFile, readFile, treeItem, writeFile } from "./helpers.ts";

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
 * **WebSocket（ライブリロード）は意図的に入れていない。** `playwright.config.ts` は
 * 実 WS を E2E の守備範囲に挙げているが、外部からの書き込みを再現するには fixture を
 * 直に書き換える必要があり、**chokidar が取りこぼしうる**（Issue #119 の実測: 直書きは
 * 20/20 届くが、`writeFileAtomic` 経由は 5 回に 4 回落ちる）。待ち条件を誤ると
 * Issue #45 の flaky を再び持ち込むので、**#119 が解けるまで保留**する。
 * なお API 経由の保存は `saveMark` が watcher を抑止するので、WS は 1 通も飛ばない。
 *
 * ## flaky を持ち込まないために
 *
 * - **固定 sleep を使わない。** `expect(locator)` の auto-retry で同期する
 * - **状態を持ち越さない。** yomi は書き込み API を持つので、fixture を書き換えるテストは
 *   `afterEach` で必ず戻す。**本文の末尾に置かない** —— 途中で落ちると復元が走らず、
 *   `workers: 1` なので後続まで巻き添えになる
 * - **UI ラベルに依存しすぎない。** `locale: "en-US"` 固定だが、文言は i18n で変わりうるので
 *   ID とロール中心でロケータを書く。「保存された」の確認も**ディスクの中身**で行う
 *   （`#status` は前のメッセージが残るので、パスを含むだけでは保存の証拠にならない）
 */

/** `afterEach` で戻すために控えた fixture の元の内容。 */
const snapshots = new Map<string, string>();

/** 書き換えるテストは**先にこれを呼ぶ**。以降は失敗しても `afterEach` が戻す。 */
async function snapshot(page: Page, path: string): Promise<string> {
  const raw = await readFile(page, path);
  snapshots.set(path, raw);
  return raw;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // 初期表示が終わるまで待つ（ツリーの描画と最初のファイルの反映）
  await expect(treeItem(page, "README.md")).toBeVisible();
  // **開くのはルート直下の README** (Issue #150)。README はルート直下なので
  // 祖先の自動展開が起きず、**`docs/` は畳まれた状態で始まる**
  // —— 中のファイルへ行くには `openFile` が先にディレクトリを開く（`helpers.ts`）
  await expect(page.locator("#current-path")).toHaveText("README.md");
  await expect(treeItem(page, "docs")).not.toHaveClass(/is-open/);
});

test.afterEach(async ({ page }) => {
  // **失敗しても必ず走る。** 途中で落ちたテストが後続を壊さないための保険
  for (const [path, raw] of snapshots) {
    await writeFile(page, path, raw);
    expect(await readFile(page, path)).toBe(raw);
  }
  snapshots.clear();
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
  await snapshot(page, "docs/links.md");

  await page.locator("#edit-btn").click();
  await expect(page.locator("#content-body")).toHaveClass(/is-editing/);

  const editor = page.locator("#editor");
  await editor.fill(`${await editor.inputValue()}\n\nE2E で追記した行。\n`);
  await expect(page.locator("#dirty-indicator")).toBeVisible();

  // **確認が「出たこと」を assert する。** Playwright はリスナが無いと全ダイアログを
  // 自動 dismiss するので、`d.dismiss()` を登録するだけでは既定と同じで何も確かめていない。
  // ここを見ていないと、`confirmLeaveEdit` が「聞かずに黙って遷移を止める」形に
  // 退化しても素通りする
  const dialogs: string[] = [];
  page.once("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await treeItem(page, "README.md").click();
  expect(dialogs).toHaveLength(1);
  await expect(page.locator("#current-path")).toHaveText("docs/links.md");
  await expect(page.locator("#content-body")).toHaveClass(/is-editing/);

  // **Ctrl+S で保存**（主要ショートカット）。
  // **ディスクの中身で確かめる** —— `#status` は前のメッセージが残るので、
  // パスを含むだけでは「表示した」のか「保存した」のか区別できない
  await page.keyboard.press("Control+s");
  await expect(page.locator("#dirty-indicator")).toBeHidden();
  await expect.poll(() => readFile(page, "docs/links.md")).toContain("E2E で追記した行。");

  // プレビューに反映されている（保存後の再描画）
  await page.locator("#edit-btn").click();
  await expect(page.locator("#content-body")).not.toHaveClass(/is-editing/);
  await expect(page.locator("#preview")).toContainText("E2E で追記した行。");
});

test("未保存のまま戻ろうとしても確認が出て、履歴が巻き戻らない", async ({ page }) => {
  // **フロー 1 と 2 の交点。** `popstate` 中に confirm をキャンセルすると
  // `history.go(delta)` で戻す、という経路は**実 history でしか確かめられない**
  // （特性テストは合成 `PopStateEvent` を dispatch するだけで `history.go` は走らない）。
  await openFile(page, "README.md");
  await openFile(page, "docs/links.md");
  await snapshot(page, "docs/links.md");

  await page.locator("#edit-btn").click();
  const editor = page.locator("#editor");
  await editor.fill(`${await editor.inputValue()}\n\n戻る前の編集。\n`);
  await expect(page.locator("#dirty-indicator")).toBeVisible();

  const dialogs: string[] = [];
  page.once("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.goBack();

  await expect.poll(() => dialogs.length).toBe(1);
  // 巻き戻っていない。編集内容も生きている
  await expect(page.locator("#current-path")).toHaveText("docs/links.md");
  await expect(page.locator("#content-body")).toHaveClass(/is-editing/);
  await expect(editor).toHaveValue(/戻る前の編集。/);
});

test("他所で更新されたファイルを保存しようとすると競合が出る", async ({ page }) => {
  await openFile(page, "docs/outline.md");
  await snapshot(page, "docs/outline.md");

  // 編集モードに入った時点の sha が基準になる
  await page.locator("#edit-btn").click();
  await expect(page.locator("#content-body")).toHaveClass(/is-editing/);

  // **裏で別の誰かが保存した状態を作る。** ブラウザが持つ sha が古くなる
  const server = `${await readFile(page, "docs/outline.md")}\n\n別の誰かが書いた行。\n`;
  await writeFile(page, "docs/outline.md", server);

  const editor = page.locator("#editor");
  await editor.fill(`${await editor.inputValue()}\n\nこちらの編集。\n`);
  await page.keyboard.press("Control+s");

  await expect(page.locator("#conflict-banner")).toBeVisible();
  await expect(page.locator("#conflict-show-diff")).toBeVisible();

  // **バナーが出たことより、上書きしていないことのほうが本質。**
  // 409 の判定が「書き込んだ後に返す」形に壊れても、バナーだけ見ていると素通りする
  const onDisk = await readFile(page, "docs/outline.md");
  expect(onDisk).toContain("別の誰かが書いた行。");
  expect(onDisk).not.toContain("こちらの編集。");

  // 差分ダイアログを開くと、両者の違いが行として並ぶ (Issue #57)
  await page.locator("#conflict-show-diff").click();
  await expect(page.locator("#conflict-diff")).toBeVisible();
  await expect(page.locator("#conflict-diff-body .conflict-diff-row.is-add")).toHaveCount(1);
  await expect(page.locator("#conflict-diff-body")).toContainText("こちらの編集。");
  await expect(page.locator("#conflict-diff-body")).toContainText("別の誰かが書いた行。");

  // Esc で差分だけ閉じる（背後のバナーは残る = 判断がまだ済んでいない）
  await page.keyboard.press("Escape");
  await expect(page.locator("#conflict-diff")).toBeHidden();
  await expect(page.locator("#conflict-banner")).toBeVisible();

  await page.locator("#conflict-take-server").click();
  await expect(page.locator("#conflict-banner")).toBeHidden();
});

// ───────────────────────────────────────────────────────────
// 3. 新規 Markdown 作成
// ───────────────────────────────────────────────────────────

test("新規 Markdown を作るとツリーに現れ、そのまま編集モードで開く", async ({ page }, info) => {
  // **名前を実行ごとに一意にする。** 削除 API が無いので後始末できず、固定名だと
  // 同じ yomi プロセスへの 2 回目が 409 (`already_exists`) で落ちる ——
  // `--repeat-each` や `retries` を上げた瞬間にこの 1 本だけ必ず赤になる
  const name = `e2e-new-${info.workerIndex}-${info.repeatEachIndex}-${info.retry}`;

  await page.locator("#tree-new-file").click();

  // インライン入力欄が出てフォーカスが当たる（キーボードだけで完結する）
  const input = page.locator(".tree-new-input");
  await expect(input).toBeFocused();

  await input.fill(name);
  await input.press("Enter");

  // 拡張子が補完され、ツリーに現れて編集モードで開く
  await expect(treeItem(page, `${name}.md`)).toBeVisible();
  await expect(page.locator("#current-path")).toHaveText(`${name}.md`);
  await expect(page.locator("#content-body")).toHaveClass(/is-editing/);

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
  // 対象の見出しがビューポートに入ったことを確かめる。
  // `ratio: 1` にする —— 既定の 0 は「1px でも覗けば合格」で、`block: "start"` が
  // 崩れても通ってしまう
  const target = page.locator("#preview h2", { hasText: "節 3" });
  await expect(target).toBeAttached();
  await expect(target).not.toBeInViewport();
  await page.locator("#toc-list button", { hasText: "節 3" }).click();
  await expect(target).toBeInViewport({ ratio: 1 });

  await page.keyboard.press("Control+Shift+O");
  await expect(page.locator("#toc-panel")).toBeHidden();

  // **Ctrl+P でクイックオープン**
  await page.keyboard.press("Control+p");
  await expect(page.locator("#quick-open")).toBeVisible();
  await expect(page.locator("#quick-open-input")).toBeFocused();

  await page.locator("#quick-open-input").fill("mermaid");
  // **件数ではなく中身を見る。** 件数だけだと fixture が 1 本増えただけで、
  // クイックオープンと無関係な理由で落ちる
  await expect(page.locator(".quick-open-item").first()).toHaveAttribute(
    "data-path",
    "docs/mermaid.md",
  );
  await page.locator("#quick-open-input").press("Enter");

  await expect(page.locator("#quick-open")).toBeHidden();
  await expect(page.locator("#current-path")).toHaveText("docs/mermaid.md");

  // Esc で閉じられる（開いたまま閉じ込められない）
  await page.keyboard.press("Control+p");
  await expect(page.locator("#quick-open")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#quick-open")).toBeHidden();
});

// ───────────────────────────────────────────────────────────
// 番外: 外部リンクの安全確認
//   DoD の 6 フローには無いが、Esc の伝播（フロー 5 と同じ経路）を別の入口から確かめる
// ───────────────────────────────────────────────────────────

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

  // **Esc で閉じる。** 閉じ方の第一の担保はこちら（座標にもレイアウトにも依存しない）
  await page.keyboard.press("Escape");
  await expect(overflow).toBeHidden();

  // **外側クリックでも閉じる。** メニューは `position: fixed; top: 3.2rem; right: .5rem` の
  // 右上に出るので、**左下の隅**を叩く。要素セレクタで「外側」を指そうとすると、
  // メニューに覆われた要素を掴んで pointer-events に阻まれる（実際に `#preview h1` で踏んだ）。
  // 左下は TOC の FAB（右下）とも重ならない
  await page.locator("#overflow-btn").click();
  await expect(overflow).toBeVisible();
  const size = page.viewportSize();
  if (!size) throw new Error("viewportSize が取れない");
  await page.mouse.click(5, size.height - 5);
  await expect(overflow).toBeHidden();
});
