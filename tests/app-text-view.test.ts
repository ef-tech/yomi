/**
 * 特性テスト: テキストファイルの読み取り専用表示 (Issue #155)
 *
 * ツリーに載るのが Markdown だけでなくなったので、「開いたものが md かテキストか」で
 * 画面がどう変わるかを固定する。判定は DOM と fetch 呼び出しだけで行う。
 *
 * **`defaultTree()` は変えていない。** ツリーの並び・件数を前提にした既存テストが
 * 多く、そこへテキストを足すと主題と関係のないところが壊れる。ここでは必要な木を
 * その都度組み立てる。
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type AppHarness,
  type BootOptions,
  bootApp,
  defaultFiles,
  defaultTree,
  resetAppEnvironment,
  type TreeNode,
} from "./helpers/app-harness.ts";

let h: AppHarness;

afterEach(resetAppEnvironment);

/** ルート直下に `notes.txt` / `config.json` を足したツリー（`README.md` はそのまま）。 */
function treeWithText(): TreeNode {
  const tree = defaultTree();
  tree.children = [
    ...(tree.children ?? []),
    { type: "file", name: "config.json", path: "config.json" },
    { type: "file", name: "notes.txt", path: "notes.txt" },
  ];
  return tree;
}

const TEXT_RAW = "plain text\nsecond line\n";
const JSON_RAW = '{\n  "a": 1\n}\n';

function filesWithText() {
  return {
    ...defaultFiles(),
    "notes.txt": {
      raw: TEXT_RAW,
      html: "",
      sha: "sha-notes-1",
      kind: "text" as const,
      lang: "plaintext",
    },
    "config.json": {
      raw: JSON_RAW,
      html: "",
      sha: "sha-config-1",
      kind: "text" as const,
      lang: "json",
    },
  };
}

/** `README.md`（Markdown）を開いた状態で起動する。テキストへはテスト内で遷移する。 */
const boot = (options: BootOptions = {}) =>
  bootApp({
    url: "http://localhost:3944/?path=README.md",
    tree: treeWithText(),
    files: filesWithText(),
    ...options,
  });

describe("テキストファイルの表示 (Issue #155)", () => {
  test("ツリーから開くと preview に pre.text-view が入り、中身は raw そのもの", async () => {
    h = await boot();
    h.click(h.treeItem("notes.txt"));
    await h.flush();

    expect(h.el("current-path").textContent).toBe("notes.txt");
    const code = h.q("#preview pre.text-view > code");
    expect(code.textContent).toBe(TEXT_RAW);
    expect(h.el("preview").classList.contains("is-text")).toBe(true);
  });

  test("ハイライト言語が language-* クラスとして載る", async () => {
    h = await boot();
    h.click(h.treeItem("config.json"));
    await h.flush();

    expect(h.q("#preview pre.text-view > code").className).toBe("language-json");
  });

  /**
   * **`innerHTML` を使っていないことの担保。** ここが `innerHTML` に戻ると、
   * ファイルの中身が HTML として解釈される（#21 / #59 が塞いだ経路が開く）。
   */
  test("HTML に見える中身も文字として表示し、要素にしない", async () => {
    h = await boot({
      files: {
        ...filesWithText(),
        "notes.txt": {
          raw: "<script>alert(1)</script><b>bold</b>",
          html: "",
          sha: "sha-notes-evil",
          kind: "text" as const,
          lang: "plaintext",
        },
      },
    });
    h.click(h.treeItem("notes.txt"));
    await h.flush();

    const code = h.q("#preview pre.text-view > code");
    expect(code.textContent).toBe("<script>alert(1)</script><b>bold</b>");
    // 要素として生えていないこと（textContent に入れているので子要素は無い）
    expect(code.querySelector("script")).toBeNull();
    expect(code.querySelector("b")).toBeNull();
    expect(code.children.length).toBe(0);
  });

  test("Markdown に戻ると通常のプレビューに戻る", async () => {
    h = await boot();
    h.click(h.treeItem("notes.txt"));
    await h.flush();
    h.click(h.treeItem("docs/guide.md"));
    await h.flush();

    expect(h.el("preview").classList.contains("is-text")).toBe(false);
    expect(h.el("preview").innerHTML).toContain("Guide");
    expect(h.el("preview").querySelector("pre.text-view")).toBeNull();
  });
});

describe("テキスト表示中の UI (Issue #155)", () => {
  test("編集・TOC・画像 zip は無効、パスのコピーは使える", async () => {
    h = await boot();
    h.click(h.treeItem("notes.txt"));
    await h.flush();

    expect(h.el<HTMLButtonElement>("edit-btn").disabled).toBe(true);
    expect(h.el<HTMLButtonElement>("toc-btn").disabled).toBe(true);
    expect(h.el<HTMLButtonElement>("toc-fab").disabled).toBe(true);
    expect(h.el<HTMLButtonElement>("download-images-btn").disabled).toBe(true);
    expect(h.el<HTMLButtonElement>("overflow-download-images").disabled).toBe(true);
    // パスは種別を問わず配りたいので落とさない
    expect(h.el<HTMLButtonElement>("current-path").disabled).toBe(false);
  });

  test("Markdown へ戻ると編集系が復帰する", async () => {
    h = await boot();
    h.click(h.treeItem("notes.txt"));
    await h.flush();
    h.click(h.treeItem("docs/guide.md"));
    await h.flush();

    expect(h.el<HTMLButtonElement>("edit-btn").disabled).toBe(false);
    expect(h.el<HTMLButtonElement>("toc-btn").disabled).toBe(false);
    expect(h.el<HTMLButtonElement>("download-images-btn").disabled).toBe(false);
  });

  test("読み取り専用バッジがテキストのときだけ出る", async () => {
    h = await boot();
    expect(h.el("readonly-badge").hidden).toBe(true);

    h.click(h.treeItem("notes.txt"));
    await h.flush();
    expect(h.el("readonly-badge").hidden).toBe(false);

    h.click(h.treeItem("docs/guide.md"));
    await h.flush();
    expect(h.el("readonly-badge").hidden).toBe(true);
  });

  test("表示モード切替は無効になり、preview 固定で描かれる", async () => {
    h = await boot({ storage: { "yomi:viewMode:v1": "split" } });
    h.click(h.treeItem("notes.txt"));
    await h.flush();

    expect(h.el("content-body").dataset.mode).toBe("preview");
    for (const btn of h.qa<HTMLButtonElement>(".view-toggle-btn")) {
      expect(btn.disabled).toBe(true);
    }
  });

  test("Markdown へ戻ると利用者が選んでいたモードに復帰する", async () => {
    h = await boot({ storage: { "yomi:viewMode:v1": "split" } });
    h.click(h.treeItem("notes.txt"));
    await h.flush();
    h.click(h.treeItem("docs/guide.md"));
    await h.flush();

    expect(h.el("content-body").dataset.mode).toBe("split");
    for (const btn of h.qa<HTMLButtonElement>(".view-toggle-btn")) {
      expect(btn.disabled).toBe(false);
    }
  });
});

describe("テキストファイルとツリー / クイックオープン (Issue #155)", () => {
  test("ツリーのアイコンが md と分かれる", async () => {
    h = await boot();
    expect(h.treeItem("README.md").classList.contains("is-text")).toBe(false);
    expect(h.treeItem("notes.txt").classList.contains("is-text")).toBe(true);
    expect(h.treeItem("config.json").classList.contains("is-text")).toBe(true);
    // ディレクトリには付かない
    expect(h.treeItem("docs").classList.contains("is-text")).toBe(false);
  });

  test("クイックオープンの候補にテキストも出る", async () => {
    h = await boot();
    h.keydown(h.document, { key: "p", ctrlKey: true });
    await h.flush();

    const input = h.el<HTMLInputElement>("quick-open-input");
    input.value = "notes";
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    await h.flush();

    const labels = h.qa("#quick-open-list .quick-open-item").map((el) => el.textContent ?? "");
    expect(labels.join("\n")).toContain("notes.txt");
  });
});
