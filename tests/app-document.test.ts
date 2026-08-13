/**
 * 特性テスト: ドキュメント遷移 / 履歴 責務 (Issue #77)
 *
 * navigateTo を起点とする「ファイルを開く」経路と、URL・history・プレビュー内リンクの
 * 振る舞いを固定する。判定は URL / history.state / fetch 呼び出し / DOM のみで行う。
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type AppHarness,
  type BootOptions,
  bootApp,
  type FakeFile,
  resetAppEnvironment,
} from "./helpers/app-harness.ts";

/**
 * **`README.md` を開いた状態で起動する** (Issue #145)。
 *
 * リンク遷移・パスのコピーなどは「開いているファイル」を起点にするが、**どのファイルが
 * 開くかは主題ではない**。`bootApp()` の既定は**ツリー最初のファイル**で、`defaultTree()`
 * を実サーバの並び（ディレクトリが先）に直した結果それは `docs/deep/note.md` になった。
 *
 * **「初期ファイル選択」の describe だけは `bootApp()` を直接使う** —— あちらは
 * 「何が最初に開くか」そのものが主題なので、明示してしまうと検証にならない。
 */
const boot = (options: BootOptions = {}) =>
  bootApp({ url: "http://localhost:3944/?path=README.md", ...options });

let h: AppHarness;

afterEach(resetAppEnvironment);

/** プレビューに任意の <a> を差し込む。DOMPurify が落とすスキームも検証したいので DOM 直挿し */
function putLink(harness: AppHarness, attrs: Record<string, string>, text = "link"): HTMLElement {
  const a = harness.document.createElement("a");
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  a.textContent = text;
  harness.el("preview").appendChild(a);
  return a;
}

const linkFile = (html: string): FakeFile => ({ raw: "# x\n", html, sha: "sha-x" });

describe("起動時の初期ファイル選択", () => {
  // **「ツリー最初のファイル」はディレクトリを先に見る** (Issue #145)。fixture を実サーバの
  // 並びに直した結果、最初のファイルは `README.md` ではなく `docs/deep/note.md` になった。
  // これは fake だけの話ではなく、**実サーバでも同じ挙動**（`chooseInitialFile` は
  // `findFirstFile` を呼ぶだけで README を優先しない）。以前の期待値は
  // **fixture の誤った並びが作っていた幻**だった
  test("?path= が無ければツリー最初のファイルを replaceState で開く", async () => {
    h = await bootApp();

    expect(h.el("current-path").textContent).toBe("docs/deep/note.md");
    expect(h.historyCalls).toHaveLength(1);
    expect(h.historyCalls[0]?.mode).toBe("replace");
    expect(h.window.location.search).toBe("?path=docs%2Fdeep%2Fnote.md");
    expect(h.window.history.state).toEqual({
      path: "docs/deep/note.md",
      hash: null,
      navIndex: 0,
    });
  });

  test("?path= があればそのファイルを開く", async () => {
    h = await bootApp({ url: "http://localhost:3944/?path=docs/guide.md" });

    expect(h.el("current-path").textContent).toBe("docs/guide.md");
    expect(h.el("preview").innerHTML).toContain("Guide");
  });

  test("?path= がツリーに無ければ最初のファイルにフォールバックする", async () => {
    h = await bootApp({ url: "http://localhost:3944/?path=gone.md" });
    expect(h.el("current-path").textContent).toBe("docs/deep/note.md");
  });

  test("URL の #見出し を復元してスクロールする", async () => {
    h = await bootApp({ url: "http://localhost:3944/?path=docs/guide.md#section" });
    await h.flush();

    expect(h.scrollIntoViewCalls.map((c) => c.id)).toContain("section");
    expect(h.window.history.state).toMatchObject({ path: "docs/guide.md", hash: "section" });
  });

  test("ファイルが 1 つも無ければプレースホルダを出し、/api/file を叩かない", async () => {
    h = await bootApp({
      tree: { type: "dir", name: "", path: "", children: [] },
      files: {},
    });

    expect(h.q("#preview .placeholder")).toBeTruthy();
    expect(h.fetchCalls.filter((c) => c.url.startsWith("/api/file"))).toHaveLength(0);
    expect(h.historyCalls).toHaveLength(0);
  });
});

describe("ツリーからの遷移", () => {
  test("クリックは pushState で履歴を積み、navIndex が増える", async () => {
    h = await boot();
    h.click(h.treeItem("docs/guide.md"));
    await h.flush();

    const last = h.historyCalls.at(-1);
    expect(last?.mode).toBe("push");
    expect(last?.url).toBe("?path=docs%2Fguide.md");
    expect(h.window.history.state).toEqual({ path: "docs/guide.md", hash: null, navIndex: 1 });
  });

  test("読み込みに失敗したら URL も history も動かさず status だけエラーにする", async () => {
    h = await boot();
    const before = h.window.location.search;
    const calls = h.historyCalls.length;

    h.intercept = (url) =>
      url.includes("path=docs%2Fguide.md") ? { status: 500, body: { error: "boom" } } : undefined;
    h.click(h.treeItem("docs/guide.md"));
    await h.flush();

    expect(h.window.location.search).toBe(before);
    expect(h.historyCalls).toHaveLength(calls);
    expect(h.el("current-path").textContent).toBe("README.md");
    expect(h.el("status").classList.contains("is-error")).toBe(true);
  });
});

describe("戻る / 進む (popstate)", () => {
  test("popstate の state から復元し、履歴は増やさない", async () => {
    h = await boot();
    h.click(h.treeItem("docs/guide.md"));
    await h.flush();
    const calls = h.historyCalls.length;

    const ev = new h.window.PopStateEvent("popstate", {
      state: { path: "README.md", hash: null, navIndex: 0 },
    });
    h.window.dispatchEvent(ev);
    await h.flush();

    expect(h.el("current-path").textContent).toBe("README.md");
    expect(h.historyCalls).toHaveLength(calls);
    expect(h.treeItem("README.md").classList.contains("is-selected")).toBe(true);
  });

  test("popstate の state に hash があればその見出しへスクロールする", async () => {
    h = await boot();
    h.scrollIntoViewCalls.length = 0;

    const ev = new h.window.PopStateEvent("popstate", {
      state: { path: "docs/guide.md", hash: "section", navIndex: 1 },
    });
    h.window.dispatchEvent(ev);
    await h.flush();

    expect(h.scrollIntoViewCalls.map((c) => c.id)).toContain("section");
  });

  test("popstate 先の読み込みに失敗したら status をエラーにする", async () => {
    h = await boot();
    h.intercept = () => ({ status: 404, body: { error: "gone", code: "not_found" } });

    const ev = new h.window.PopStateEvent("popstate", {
      state: { path: "docs/guide.md", hash: null, navIndex: 1 },
    });
    h.window.dispatchEvent(ev);
    await h.flush();

    expect(h.el("status").classList.contains("is-error")).toBe(true);
    expect(h.el("current-path").textContent).toBe("README.md");
  });
});

describe("プレビュー内リンク", () => {
  test("内部 md リンクは yomi 内で遷移する", async () => {
    h = await boot({
      files: {
        "README.md": linkFile('<a href="docs/guide.md">g</a>'),
        "docs/guide.md": { raw: "# Guide\n", html: "<h1>Guide</h1>", sha: "sha-g" },
      },
    });

    h.click(h.q("#preview a"));
    await h.flush();

    expect(h.el("current-path").textContent).toBe("docs/guide.md");
    expect(h.historyCalls.at(-1)?.mode).toBe("push");
  });

  test("拡張子なしのリンクは .md / .markdown / .mdx で補完する", async () => {
    h = await boot({
      files: {
        "README.md": linkFile('<a href="docs/guide">g</a>'),
        "docs/guide.md": { raw: "# Guide\n", html: "<h1>Guide</h1>", sha: "sha-g" },
      },
    });

    h.click(h.q("#preview a"));
    await h.flush();
    expect(h.el("current-path").textContent).toBe("docs/guide.md");
  });

  test("`other.md#見出し` は hash を URL と scroll に引き継ぐ", async () => {
    h = await boot({
      files: {
        "README.md": linkFile('<a href="docs/guide.md#section">g</a>'),
        "docs/guide.md": {
          raw: "# Guide\n\n## Section\n",
          html: '<h1 id="guide">Guide</h1><h2 id="section">Section</h2>',
          sha: "sha-g",
        },
      },
    });
    h.scrollIntoViewCalls.length = 0;

    h.click(h.q("#preview a"));
    await h.flush();

    expect(h.historyCalls.at(-1)?.url).toBe("?path=docs%2Fguide.md#section");
    expect(h.scrollIntoViewCalls.map((c) => c.id)).toContain("section");
  });

  test("ツリーに無いファイルへのリンクはエラー表示だけで遷移しない", async () => {
    h = await boot({
      files: { "README.md": linkFile('<a href="missing.md">x</a>') },
    });

    h.click(h.q("#preview a"));
    await h.flush();

    expect(h.el("current-path").textContent).toBe("README.md");
    expect(h.el("status").classList.contains("is-error")).toBe(true);
    expect(h.fetchCalls.some((c) => c.url.includes("missing.md"))).toBe(false);
  });

  test("外部 URL は警告バナーを出し、開くまで window.open しない", async () => {
    h = await boot();
    putLink(h, { href: "https://example.com/x" });

    h.click(h.q("#preview a"));
    await h.flush();

    expect(h.el("external-link-banner").hidden).toBe(false);
    expect(h.el("external-link-url").textContent).toBe("https://example.com/x");
    expect(h.openedUrls).toHaveLength(0);

    h.click(h.el("external-link-open"));
    expect(h.openedUrls).toEqual(["https://example.com/x"]);
    expect(h.el("external-link-banner").hidden).toBe(true);
  });

  test("外部 URL バナーはキャンセルと Esc で閉じ、開かない", async () => {
    h = await boot();
    putLink(h, { href: "https://example.com/y" });

    h.click(h.q("#preview a"));
    h.click(h.el("external-link-cancel"));
    expect(h.el("external-link-banner").hidden).toBe(true);

    h.click(h.q("#preview a"));
    expect(h.el("external-link-banner").hidden).toBe(false);
    h.keydown(h.document, { key: "Escape" });
    expect(h.el("external-link-banner").hidden).toBe(true);
    expect(h.openedUrls).toHaveLength(0);
  });

  test("危険スキームはブロックし、遷移もバナーも出さない", async () => {
    h = await boot();
    // 通常は DOMPurify が落とすので DOM に直挿しして click ハンドラの分岐を突く
    for (const href of ["javascript:alert(1)", "file:///etc/passwd", "vbscript:msgbox"]) {
      h.el("preview").innerHTML = "";
      putLink(h, { href });
      h.click(h.q("#preview a"));
      await h.flush();

      expect(h.el("external-link-banner").hidden).toBe(true);
      expect(h.openedUrls).toHaveLength(0);
      expect(h.el("status").classList.contains("is-error")).toBe(true);
      expect(h.el("current-path").textContent).toBe("README.md");
    }
  });

  test('target="_blank" のリンクはブラウザ既定に任せる (preventDefault しない)', async () => {
    h = await boot();
    const a = putLink(h, { href: "/api/asset?path=sales.csv", target: "_blank" });

    const ev = new h.window.MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    await h.flush();

    expect(ev.defaultPrevented).toBe(false);
    expect(h.el("external-link-banner").hidden).toBe(true);
    expect(h.el("current-path").textContent).toBe("README.md");
  });

  test("ページ内アンカーはブラウザ既定に任せる", async () => {
    h = await boot();
    const a = putLink(h, { href: "#section" });

    const ev = new h.window.MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    await h.flush();

    expect(ev.defaultPrevented).toBe(false);
    expect(h.historyCalls).toHaveLength(1); // 起動時の replace だけ
  });
});

describe("パスのコピー", () => {
  test("パス表示をクリックすると現在パスをクリップボードへ入れる", async () => {
    h = await boot();
    h.click(h.el("current-path"));
    await h.flush();

    expect(h.clipboard).toEqual(["README.md"]);
    expect(h.el("current-path").classList.contains("is-copied")).toBe(true);
    expect(h.el("status").classList.contains("is-ok")).toBe(true);
  });
});
