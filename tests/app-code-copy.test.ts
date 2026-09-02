/**
 * プレビュー内のコードブロックのコピーボタン (Issue #165)。
 *
 * ## 何を守るか
 *
 * 1. **コピーされるのは生テキスト** —— ハイライトの `<span>` もボタンのラベルも混ざらない
 * 2. **Mermaid には出ない** —— 図として描画されるので、コピーしても意味がない
 * 3. **サニタイザの設定を広げていない** —— ボタンは描画後の DOM に足す（#21 / #59）
 * 4. **再描画で二重に付かない**
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type AppHarness,
  bootApp,
  defaultFiles,
  defaultTree,
  resetAppEnvironment,
} from "./helpers/app-harness.ts";

let h: AppHarness;

afterEach(resetAppEnvironment);

/** コードブロックを含む README を返すファイル群。 */
function filesWithCode(): ReturnType<typeof defaultFiles> {
  const files = defaultFiles();
  files["README.md"] = {
    raw: "# README\n\n```js\nconst a = 1;\n```\n",
    // サーバが返す HTML を模す（`src/renderer.ts` の出力形）。
    // ハイライト済みの `<span>` を入れて、コピーが生テキストになることを見る
    html:
      '<h1 id="readme" data-line="1">README</h1>\n' +
      '<pre><code class="language-js">' +
      '<span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span>;\n' +
      "</code></pre>",
    sha: "sha-readme-code",
  };
  return files;
}

/** Mermaid ブロックと通常のコードブロックが両方ある README。 */
function filesWithMermaid(): ReturnType<typeof defaultFiles> {
  const files = defaultFiles();
  files["README.md"] = {
    raw: "# README\n",
    html:
      '<pre class="mermaid">graph TD; A--&gt;B;</pre>\n' +
      '<pre><code class="language-sh">echo hi\n</code></pre>',
    sha: "sha-readme-mermaid",
  };
  return files;
}

function copyButtons(harness: AppHarness): HTMLElement[] {
  return harness.qa("#preview .code-copy-btn");
}

describe("コードブロックのコピーボタン", () => {
  test("コードブロックごとにボタンが出る", async () => {
    h = await bootApp({ files: filesWithCode() });
    expect(copyButtons(h)).toHaveLength(1);
    // **`<code>` の外・`<pre>` の直下**（中に入れるとラベルがコピー内容に混ざる）
    const button = copyButtons(h)[0];
    expect(button?.parentElement?.tagName).toBe("PRE");
    expect(h.q("#preview pre > code").contains(button as Node)).toBe(false);
  });

  test("押すと生テキストがクリップボードへ入る（ハイライトの span が混ざらない）", async () => {
    h = await bootApp({ files: filesWithCode() });
    h.click(copyButtons(h)[0] as Element);
    await h.flush(4);

    expect(h.clipboard).toEqual(["const a = 1;\n"]);
    expect(h.clipboard[0]).not.toContain("<span");
    expect(h.clipboard[0]).not.toContain("⧉");
  });

  test("押した直後にフィードバックが出る（パスのコピーと同じ見せ方）", async () => {
    h = await bootApp({ files: filesWithCode() });
    const button = copyButtons(h)[0] as HTMLElement;
    expect(button.classList.contains("is-copied")).toBe(false);

    h.click(button);
    await h.flush(4);
    expect(button.classList.contains("is-copied")).toBe(true);
    expect(h.el("status").textContent).toContain("コピー");
  });

  test("Mermaid ブロックには出ない（図として描画されるため）", async () => {
    h = await bootApp({ files: filesWithMermaid() });
    // 通常のコードブロックだけに付く
    expect(copyButtons(h)).toHaveLength(1);
    expect(h.q("#preview pre.mermaid").querySelector(".code-copy-btn")).toBeNull();
  });

  test("再描画しても二重に付かない", async () => {
    h = await bootApp({ files: filesWithCode() });
    expect(copyButtons(h)).toHaveLength(1);

    // 別ファイルへ移って戻る（`renderCurrentFile` が 2 回走る）
    h.click(h.treeItem("docs/guide.md"));
    await h.flush(4);
    h.click(h.treeItem("README.md"));
    await h.flush(4);

    expect(copyButtons(h)).toHaveLength(1);
  });

  test("読み取り専用のテキストファイル表示にも出る", async () => {
    // #155 のテキスト表示も DOM の形は同じ `pre > code`。同じ扱いにすると決めた
    const tree = defaultTree();
    tree.children?.push({ type: "file", name: "data.json", path: "data.json" });
    const files = defaultFiles();
    files["data.json"] = {
      raw: '{ "a": 1 }\n',
      html: "",
      sha: "sha-json",
      kind: "text",
      lang: "json",
    } as (typeof files)[string];

    h = await bootApp({ tree, files });
    h.click(h.treeItem("data.json"));
    await h.flush(6);

    expect(h.el("preview").classList.contains("is-text")).toBe(true);
    expect(copyButtons(h)).toHaveLength(1);

    h.click(copyButtons(h)[0] as Element);
    await h.flush(4);
    expect(h.clipboard).toEqual(['{ "a": 1 }\n']);
  });

  test("言語を切り替えるとボタンの文言も切り替わる", async () => {
    h = await bootApp({ files: filesWithCode() });
    const button = copyButtons(h)[0] as HTMLElement;
    expect(button.getAttribute("aria-label")).toBe("このコードブロックをコピー");

    // ⋮ メニューではなく topbar の言語トグルを押す
    h.click(h.q('.lang-toggle-btn[data-lang-mode="en"]'));
    await h.flush(4);

    expect(button.getAttribute("aria-label")).toBe("Copy this code block");
  });

  test("コピーに失敗したらステータスにエラーを出す", async () => {
    h = await bootApp({ files: filesWithCode() });
    // クリップボード API を落とす（非セキュアコンテキストのフォールバックも失敗させる）
    const nav = h.window.navigator as unknown as { clipboard: { writeText: () => Promise<void> } };
    nav.clipboard.writeText = () => Promise.reject(new Error("boom"));
    (h.document as unknown as { execCommand: () => boolean }).execCommand = () => false;

    h.click(copyButtons(h)[0] as Element);
    await h.flush(4);

    expect(h.el("status").className).toContain("error");
    expect(copyButtons(h)[0]?.classList.contains("is-copied")).toBe(false);
  });
});
