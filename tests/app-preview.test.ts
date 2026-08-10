/**
 * 特性テスト: プレビュー / 表示モード / テーマ / TOC 責務 (Issue #77)
 *
 * 表示モードとテーマの永続化、Mermaid 再描画の呼び出し条件、目次の生成と
 * 展開レベル、タスクリストのチェック操作を固定する。
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type AppHarness,
  bootApp,
  type FakeFile,
  mermaidStub,
  resetAppEnvironment,
} from "./helpers/app-harness.ts";

let h: AppHarness;

afterEach(resetAppEnvironment);

const VIEW_KEY = "yomi:viewMode:v1";
const THEME_KEY = "yomi:themeMode:v1";
const TOC_VISIBLE_KEY = "yomi:tocVisible:v1";
const TOC_LEVEL_KEY = "yomi:tocExpandLevel:v1";

const HEADINGS_HTML =
  '<h1 id="h-1">章</h1><h2 id="h-2">節</h2><h3 id="h-3">項</h3><h4 id="h-4">細目</h4>';

/** 見出しを持つ README.md だけのツリー / ファイル */
function headingFixture(html = HEADINGS_HTML): { files: Record<string, FakeFile> } {
  return { files: { "README.md": { raw: "# 章\n## 節\n### 項\n#### 細目\n", html, sha: "s1" } } };
}

function viewBtn(harness: AppHarness, mode: string) {
  return harness.q<HTMLButtonElement>(`.view-toggle-btn[data-mode="${mode}"]`);
}

function themeBtn(harness: AppHarness, mode: string) {
  return harness.q<HTMLButtonElement>(`.theme-toggle-btn[data-theme-mode="${mode}"]`);
}

describe("表示モード", () => {
  test("既定は preview で、aria-selected が同期している", async () => {
    h = await bootApp();
    expect(h.el("content-body").dataset.mode).toBe("preview");
    expect(viewBtn(h, "preview").getAttribute("aria-selected")).toBe("true");
    expect(viewBtn(h, "md").getAttribute("aria-selected")).toBe("false");
  });

  test("切り替えると data-mode / aria-selected / localStorage が揃って変わる", async () => {
    h = await bootApp();
    h.click(viewBtn(h, "split"));
    await h.flush();

    expect(h.el("content-body").dataset.mode).toBe("split");
    expect(viewBtn(h, "split").getAttribute("aria-selected")).toBe("true");
    expect(viewBtn(h, "preview").getAttribute("aria-selected")).toBe("false");
    expect(h.storageValue(VIEW_KEY)).toBe("split");
  });

  test("保存済みの表示モードを起動時に復元する", async () => {
    h = await bootApp({ storage: { [VIEW_KEY]: "md" } });
    expect(h.el("content-body").dataset.mode).toBe("md");
    expect(viewBtn(h, "md").getAttribute("aria-selected")).toBe("true");
  });

  test("不正な保存値は無視して preview に落とす", async () => {
    h = await bootApp({ storage: { [VIEW_KEY]: "bogus" } });
    expect(h.el("content-body").dataset.mode).toBe("preview");
  });

  test("同じモードを押しても再描画しない", async () => {
    h = await bootApp();
    const before = mermaidStub.runCalls.length;
    h.click(viewBtn(h, "preview"));
    await h.flush();
    expect(mermaidStub.runCalls).toHaveLength(before);
  });
});

describe("Mermaid の描画", () => {
  const mermaidFile: Record<string, FakeFile> = {
    "README.md": {
      raw: "```mermaid\ngraph LR\n```\n",
      html: '<pre class="mermaid">graph LR</pre>',
      sha: "s1",
    },
  };

  test("mermaid ブロックがあれば表示時に run する", async () => {
    h = await bootApp({ files: mermaidFile });
    expect(mermaidStub.runCalls.length).toBeGreaterThan(0);
  });

  test("mermaid ブロックが無ければ run しない", async () => {
    h = await bootApp();
    expect(mermaidStub.runCalls).toHaveLength(0);
  });

  test("md モードでは run しない", async () => {
    h = await bootApp({ files: mermaidFile, storage: { [VIEW_KEY]: "md" } });
    expect(mermaidStub.runCalls).toHaveLength(0);
  });

  test("描画に失敗したら status をエラーにする", async () => {
    h = await bootApp();
    mermaidStub.failNextRun = true;
    h.el("preview").innerHTML = '<pre class="mermaid">graph LR</pre>';
    h.click(viewBtn(h, "split"));
    await h.flush(6);

    expect(mermaidStub.runCalls.length).toBeGreaterThan(0);
    expect(h.el("status").classList.contains("is-error")).toBe(true);
  });
});

describe("テーマ", () => {
  test("auto は data-theme を付けず、light / dark は付ける", async () => {
    h = await bootApp();
    expect(h.document.documentElement.hasAttribute("data-theme")).toBe(false);

    h.click(themeBtn(h, "dark"));
    await h.flush();
    expect(h.document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(themeBtn(h, "dark").getAttribute("aria-pressed")).toBe("true");
    expect(themeBtn(h, "auto").getAttribute("aria-pressed")).toBe("false");
    expect(h.storageValue(THEME_KEY)).toBe("dark");

    h.click(themeBtn(h, "auto"));
    await h.flush();
    expect(h.document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  // Issue #85: 言語トグルは見た目を揃えるため `.theme-toggle-btn` も持っているので、
  // 素の class セレクタで集めると applyThemeMode が言語ボタンの aria-pressed を潰す。
  // 起動時は applyThemeMode → applyLang の順なので初期表示は正しく、**テーマを操作した
  // 後だけ**壊れる（気づきにくい）。両方向とも固定する。
  test("テーマを切り替えても言語トグルの aria-pressed が壊れない (Issue #85)", async () => {
    h = await bootApp();
    const langPressed = () =>
      [...h.document.querySelectorAll<HTMLElement>(".lang-toggle-btn")].map(
        (b) => `${b.dataset.langMode}=${b.getAttribute("aria-pressed")}`,
      );
    expect(langPressed()).toEqual(["auto=true", "en=false", "ja=false"]);

    h.click(themeBtn(h, "dark"));
    await h.flush();
    // テーマ操作は言語トグルに触らない
    expect(langPressed()).toEqual(["auto=true", "en=false", "ja=false"]);

    h.click(themeBtn(h, "light"));
    await h.flush();
    expect(langPressed()).toEqual(["auto=true", "en=false", "ja=false"]);
  });

  test("言語を切り替えてもテーマトグルの aria-pressed が壊れない (Issue #85)", async () => {
    h = await bootApp();
    h.click(themeBtn(h, "dark"));
    await h.flush();

    const langBtn = [...h.document.querySelectorAll<HTMLElement>(".lang-toggle-btn")].find(
      (b) => b.dataset.langMode === "en",
    );
    h.click(langBtn as HTMLElement);
    await h.flush();

    expect(themeBtn(h, "dark").getAttribute("aria-pressed")).toBe("true");
    expect(themeBtn(h, "auto").getAttribute("aria-pressed")).toBe("false");
    expect(themeBtn(h, "light").getAttribute("aria-pressed")).toBe("false");
  });

  test("テーマ変更で Mermaid を初期化し直し、プレビューを再描画する", async () => {
    h = await bootApp({
      files: {
        "README.md": {
          raw: "x",
          html: '<pre class="mermaid">graph LR</pre>',
          sha: "s1",
        },
      },
    });
    const initBefore = mermaidStub.initializeCalls.length;
    const runBefore = mermaidStub.runCalls.length;

    h.click(themeBtn(h, "dark"));
    await h.flush(6);

    expect(mermaidStub.initializeCalls.length).toBe(initBefore + 1);
    expect(mermaidStub.runCalls.length).toBeGreaterThan(runBefore);
  });

  test("auto のときシステムのダーク切替に追従して Mermaid を初期化し直す", async () => {
    h = await bootApp();
    const before = mermaidStub.initializeCalls.length;

    h.setDark(true);
    await h.flush();
    expect(mermaidStub.initializeCalls.length).toBe(before + 1);

    // 明示モードのときはシステム変化に追従しない
    h.click(themeBtn(h, "light"));
    await h.flush();
    const afterLight = mermaidStub.initializeCalls.length;
    h.setDark(false);
    await h.flush();
    expect(mermaidStub.initializeCalls.length).toBe(afterLight);
  });
});

describe("目次 (TOC)", () => {
  test("開くとパネルが出て見出しツリーを描画し、localStorage に永続する", async () => {
    h = await bootApp(headingFixture());
    expect(h.el("toc-panel").hidden).toBe(true);

    h.click(h.el("toc-btn"));
    await h.flush();

    expect(h.el("toc-panel").hidden).toBe(false);
    expect(h.el("toc-btn").getAttribute("aria-pressed")).toBe("true");
    expect(h.storageValue(TOC_VISIBLE_KEY)).toBe("true");
    expect(h.qa("#toc-list .toc-entry").map((b) => b.textContent)).toEqual(["章", "節", "項"]);
  });

  test("既定の展開レベルは h3 までで、切り替えると h4 以降も出る", async () => {
    h = await bootApp({ ...headingFixture(), storage: { [TOC_VISIBLE_KEY]: "true" } });
    expect(h.qa("#toc-list .toc-entry")).toHaveLength(3);

    h.click(h.el("toc-expand-toggle"));
    await h.flush();

    expect(h.qa("#toc-list .toc-entry").map((b) => b.textContent)).toEqual([
      "章",
      "節",
      "項",
      "細目",
    ]);
    expect(h.el("toc-expand-toggle").getAttribute("aria-pressed")).toBe("true");
    expect(h.storageValue(TOC_LEVEL_KEY)).toBe("h6");
  });

  test("見出しが無ければ空表示にする", async () => {
    h = await bootApp({
      files: { "README.md": { raw: "text", html: "<p>text</p>", sha: "s1" } },
      storage: { [TOC_VISIBLE_KEY]: "true" },
    });
    expect(h.q("#toc-list .toc-empty")).toBeTruthy();
    expect(h.qa("#toc-list .toc-entry")).toHaveLength(0);
  });

  test("見出しをクリックするとその要素へスクロールする", async () => {
    h = await bootApp({ ...headingFixture(), storage: { [TOC_VISIBLE_KEY]: "true" } });
    h.scrollIntoViewCalls.length = 0;

    const entries = h.qa("#toc-list .toc-entry");
    const second = entries[1];
    if (!second) throw new Error("TOC entry が足りません");
    h.click(second);

    expect(h.scrollIntoViewCalls).toEqual([
      { id: "h-2", options: { behavior: "smooth", block: "start" } },
    ]);
  });

  test("閉じると IntersectionObserver を破棄する", async () => {
    h = await bootApp({ ...headingFixture(), storage: { [TOC_VISIBLE_KEY]: "true" } });
    const observer = h.observers.at(-1);
    expect(observer?.observed.length).toBeGreaterThan(0);

    h.click(h.el("toc-close"));
    await h.flush();

    expect(h.el("toc-panel").hidden).toBe(true);
    expect(observer?.disconnected).toBe(true);
    expect(h.storageValue(TOC_VISIBLE_KEY)).toBe("false");
  });

  test("交差した見出しのうち上端に近いものが is-active になる", async () => {
    h = await bootApp({ ...headingFixture(), storage: { [TOC_VISIBLE_KEY]: "true" } });
    const observer = h.observers.at(-1);
    if (!observer) throw new Error("IntersectionObserver が作られていません");

    const h1 = h.el("h-1");
    const h2 = h.el("h-2");
    observer.emit([
      { target: h1, isIntersecting: true, top: 120 },
      { target: h2, isIntersecting: true, top: 20 },
    ]);

    const active = h.qa("#toc-list .toc-entry.is-active").map((b) => b.textContent);
    expect(active).toEqual(["節"]);
  });

  test("md モードで開くと一時的に preview へ切り替え、閉じると元へ戻る", async () => {
    h = await bootApp({ ...headingFixture(), storage: { [VIEW_KEY]: "md" } });
    expect(h.el("content-body").dataset.mode).toBe("md");

    h.click(h.el("toc-btn"));
    await h.flush();
    expect(h.el("content-body").dataset.mode).toBe("preview");
    // 一時切替なので保存値は md のまま
    expect(h.storageValue(VIEW_KEY)).toBe("md");

    h.click(h.el("toc-btn"));
    await h.flush();
    expect(h.el("content-body").dataset.mode).toBe("md");
  });
});

describe("タスクリストのチェック", () => {
  // 保存に成功するとハーネスのフェイクサーバが files を書き換えるため、
  // テスト間で共有すると 2 件目以降のチェックボックスが消える。毎回作り直す。
  const taskFixture = (): Record<string, FakeFile> => ({
    "README.md": {
      raw: "- [ ] one\n- [ ] two\n",
      html: '<ul><li><input type="checkbox"> one</li><li><input type="checkbox"> two</li></ul>',
      sha: "sha-task-1",
    },
  });

  test("チェックすると該当行だけを反転した body を POST する", async () => {
    h = await bootApp({ files: taskFixture() });
    const boxes = h.qa<HTMLInputElement>('#preview input[type="checkbox"]');
    expect(boxes.map((b) => b.dataset.taskIndex)).toEqual(["0", "1"]);

    const second = boxes[1];
    if (!second) throw new Error("チェックボックスが足りません");
    second.checked = true;
    second.dispatchEvent(new h.window.Event("change", { bubbles: true }));
    await h.flush(6);

    const post = h.fetchCalls.find((c) => c.url === "/api/file" && c.method === "POST");
    expect(post?.body).toEqual({
      path: "README.md",
      body: "- [ ] one\n- [x] two\n",
      baseSha: "sha-task-1",
    });
    expect(h.el("status").classList.contains("is-ok")).toBe(true);
  });

  test("保存に失敗したらチェック状態を元に戻す", async () => {
    h = await bootApp({ files: taskFixture() });
    h.intercept = (url, method) =>
      url === "/api/file" && method === "POST"
        ? { status: 500, body: { error: "boom" } }
        : undefined;

    const box = h.qa<HTMLInputElement>('#preview input[type="checkbox"]')[0];
    if (!box) throw new Error("チェックボックスがありません");
    box.checked = true;
    box.dispatchEvent(new h.window.Event("change", { bubbles: true }));
    await h.flush(6);

    expect(box.checked).toBe(false);
    expect(h.el("status").classList.contains("is-error")).toBe(true);
  });

  test("編集モード中は disabled になり、抜けると戻る", async () => {
    h = await bootApp({ files: taskFixture() });
    const box = h.qa<HTMLInputElement>('#preview input[type="checkbox"]')[0];
    if (!box) throw new Error("チェックボックスがありません");
    expect(box.disabled).toBe(false);

    h.click(h.el("edit-btn"));
    await h.flush();
    expect(box.disabled).toBe(true);

    h.click(h.el("edit-btn"));
    await h.flush();
    expect(h.qa<HTMLInputElement>('#preview input[type="checkbox"]')[0]?.disabled).toBe(false);
  });
});
