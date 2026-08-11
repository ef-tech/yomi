import { expect, type Page } from "@playwright/test";

/**
 * E2E 共通のロケータとファイル操作 (Issue #82)。
 *
 * **`playwright.config.ts` の `testMatch` は `/.*\.e2e\.ts/`** なので、このファイルは
 * テストとして拾われない。`smoke.e2e.ts` と `user-flows.e2e.ts` で同じものを
 * 二重に持たないための置き場所。
 */

/**
 * ツリーの項目は `title` 属性にフルパスを持つ。
 *
 * **`getByRole("button", { name })` を使わない。** `.tree-item` の accessible name には
 * 装飾アイコン (`.icon::before` の `≡` / `▸`) が混ざるため完全一致にできず、部分一致だと
 * `README.md` が `SUB-README.md` にもマッチして strict mode violation になる。
 * `title` なら一意で完全一致。
 *
 * **パスに `"` が入ると壊れる**が、fixture の命名で避けている（`e2e/fixtures/README.md`）。
 */
export const treeItem = (page: Page, path: string) =>
  page.locator(`#tree .tree-item[title="${path}"]`);

/** 表示中のファイルが切り替わるまで待つ。全フローの起点になるので 1 箇所に置く。 */
export async function openFile(page: Page, path: string) {
  await treeItem(page, path).click();
  await expect(page.locator("#current-path")).toHaveText(path);
}

/**
 * fixture の中身を API から読む。
 *
 * **`#editor` の値で代用しない。** エディタが埋まるのは編集モードに入ってからで、
 * それ以前は空文字。それを「元の内容」として後始末に使うと**ファイルを空で上書きする**
 * （実際に踏んで、後続 2 テストが「見出しが無い」「リンクが無い」で落ちた）。
 *
 * **HTTP ステータスを検査する。** 握り潰すと `raw` が `undefined` のまま復元へ流れ、
 * `body` キーごと落ちた POST が 400 になり、「後始末が失敗した」ではなく
 * 「本文が全文 vs undefined」という読めない diff で落ちる。
 */
export async function readFile(page: Page, path: string): Promise<string> {
  const raw = await page.evaluate(async (p) => {
    const res = await fetch(`/api/file?path=${encodeURIComponent(p)}`);
    if (!res.ok) throw new Error(`GET /api/file?path=${p} が ${res.status}`);
    return (await res.json()).raw;
  }, path);
  if (typeof raw !== "string") throw new Error(`${path} の raw が文字列でない: ${typeof raw}`);
  return raw;
}

/** fixture を書き戻す。**HTTP ステータスを検査する**（理由は `readFile` と同じ）。 */
export async function writeFile(page: Page, path: string, body: string) {
  await page.evaluate(
    async ({ p, text }) => {
      const cur = await fetch(`/api/file?path=${encodeURIComponent(p)}`);
      if (!cur.ok) throw new Error(`GET /api/file?path=${p} が ${cur.status}`);
      const { sha } = await cur.json();
      const res = await fetch("/api/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p, body: text, baseSha: sha }),
      });
      if (!res.ok) throw new Error(`POST /api/file (${p}) が ${res.status}`);
    },
    { p: path, text: body },
  );
}
