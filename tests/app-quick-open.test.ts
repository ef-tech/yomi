/**
 * クイックオープンの UI とキーボード操作 (Issue #54)。
 *
 * 候補の絞り込み・順位づけは `tests/quick-open.test.ts` が純粋関数として見る。
 * ここは **DOM とキーボードの結線**だけを見る —— Ctrl/Cmd+P で開くか、↑↓ で
 * 選択が動くか、Enter で `navigateTo` を通るか、未保存確認が働くか。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type AppHarness, bootApp, resetAppEnvironment } from "./helpers/app-harness.ts";

let h: AppHarness;

afterEach(resetAppEnvironment);

const panel = () => h.el("quick-open");
const input = () => h.el<HTMLInputElement>("quick-open-input");
const items = () => h.qa<HTMLButtonElement>(".quick-open-item");
const activeItem = () => h.q<HTMLButtonElement>(".quick-open-item.is-active");

/** 入力欄に値を入れて input を発火する（ハーネスに type ヘルパは無い） */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.value = value;
  el.dispatchEvent(new h.window.Event("input", { bubbles: true }));
}

/** Ctrl+P（capture phase で拾われる） */
function pressCtrlP() {
  h.keydown(h.document, { key: "p", code: "KeyP", ctrlKey: true });
}

async function open() {
  pressCtrlP();
  await h.flush();
}

describe("クイックオープン", () => {
  test("Ctrl/Cmd+P で開き、入力欄にフォーカスが移る", async () => {
    h = await bootApp();
    expect(panel().hidden).toBe(true);

    await open();

    expect(panel().hidden).toBe(false);
    expect(h.document.activeElement).toBe(input());
  });

  test("もう一度押すと閉じる", async () => {
    h = await bootApp();
    await open();
    await open();
    expect(panel().hidden).toBe(true);
  });

  test("Esc で閉じる", async () => {
    h = await bootApp();
    await open();

    h.keydown(input(), { key: "Escape" });
    await h.flush();
    expect(panel().hidden).toBe(true);
  });

  test("背景をクリックすると閉じる（パネル内は閉じない）", async () => {
    h = await bootApp();
    await open();

    h.click(panel());
    await h.flush();
    expect(panel().hidden).toBe(true);
  });

  test("開いた直後は全ファイルが候補に出て、先頭が選択されている", async () => {
    h = await bootApp();
    await open();

    // ハーネスの既定 fixture は README.md / docs/guide.md / docs/deep/note.md。
    // クエリが空なら document order (= ツリーの並び) で返る。
    expect(items().map((b) => b.dataset.path)).toEqual([
      "README.md",
      "docs/guide.md",
      "docs/deep/note.md",
    ]);
    expect(activeItem()?.dataset.path).toBe("README.md");
    expect(activeItem()?.getAttribute("aria-selected")).toBe("true");
  });

  test("入力で候補が絞られ、選択は先頭へ戻る", async () => {
    h = await bootApp();
    await open();

    typeInto(input(), "readme");
    await h.flush();

    expect(items().map((b) => b.dataset.path)).toEqual(["README.md"]);
    expect(activeItem()?.dataset.path).toBe("README.md");
  });

  test("一致しなければ空表示にする", async () => {
    h = await bootApp();
    await open();

    typeInto(input(), "zzzz");
    await h.flush();

    expect(items()).toHaveLength(0);
    expect(h.el("quick-open-empty").hidden).toBe(false);
  });

  // **マウスなしで完結する** (DoD 1 行目)
  test("↑↓ で選択が動き、端で循環する", async () => {
    h = await bootApp();
    await open();
    expect(activeItem()?.dataset.path).toBe("README.md");

    h.keydown(input(), { key: "ArrowDown" });
    expect(activeItem()?.dataset.path).toBe("docs/guide.md");

    h.keydown(input(), { key: "ArrowDown" });
    expect(activeItem()?.dataset.path).toBe("docs/deep/note.md");

    // 末尾から下 → 先頭へ回る
    h.keydown(input(), { key: "ArrowDown" });
    expect(activeItem()?.dataset.path).toBe("README.md");

    // 先頭から上 → 末尾へ回る
    h.keydown(input(), { key: "ArrowUp" });
    expect(activeItem()?.dataset.path).toBe("docs/deep/note.md");
  });

  test("Enter で選択中のファイルを開き、パネルを閉じる", async () => {
    h = await bootApp();
    await open();

    h.keydown(input(), { key: "ArrowDown" }); // docs/guide.md
    h.keydown(input(), { key: "Enter" });
    await h.flush();

    expect(panel().hidden).toBe(true);
    expect(h.el("current-path").textContent).toBe("docs/guide.md");
  });

  test("候補をクリックしても開ける", async () => {
    h = await bootApp();
    await open();

    const target = items().find((b) => b.dataset.path === "docs/deep/note.md");
    if (!target) throw new Error("候補が見つかりません");
    h.click(target);
    await h.flush();

    expect(panel().hidden).toBe(true);
    expect(h.el("current-path").textContent).toBe("docs/deep/note.md");
  });

  test("候補が無いまま Enter を押しても何も起きない", async () => {
    h = await bootApp();
    await open();
    typeInto(input(), "zzzz");
    await h.flush();

    const before = h.el("current-path").textContent;
    h.keydown(input(), { key: "Enter" });
    await h.flush();

    expect(h.el("current-path").textContent).toBe(before);
    // 候補が無いときは開いたまま (誤って閉じない)
    expect(panel().hidden).toBe(false);
  });

  // **遷移は navigateTo に委ねているので、未保存確認が従来どおり働く** (DoD 4 行目)
  test("未保存編集中に開こうとすると確認が出て、キャンセルすれば遷移しない", async () => {
    h = await bootApp();
    h.click(h.el("edit-btn"));
    await h.flush();
    typeInto(h.el<HTMLTextAreaElement>("editor"), "編集中");
    await h.flush();

    // 編集中は Ctrl+P で開かない (テキスト入力を邪魔しない)
    pressCtrlP();
    await h.flush();
    expect(panel().hidden).toBe(true);
  });

  test("編集モードを抜ければ再び開ける", async () => {
    h = await bootApp();
    h.click(h.el("edit-btn"));
    await h.flush();
    h.click(h.el("discard-btn"));
    await h.flush();

    await open();
    expect(panel().hidden).toBe(false);
  });

  // 除外・depth はサーバ側で適用済みなので、ツリーに無いものは候補にも出ない (DoD 3 行目)
  test("ツリーに無いファイルは候補に出ない", async () => {
    h = await bootApp();
    await open();

    typeInto(input(), "secret");
    await h.flush();
    expect(items()).toHaveLength(0);
  });

  test("一致した文字がハイライトされる", async () => {
    h = await bootApp();
    await open();
    typeInto(input(), "rdm");
    await h.flush();

    const marks = h.qa("#quick-open-list mark");
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.map((m) => m.textContent?.toLowerCase()).join("")).toBe("rdm");
  });

  test("閉じるとフォーカスが元の要素へ戻る", async () => {
    h = await bootApp();
    const editBtn = h.el("edit-btn");
    editBtn.focus();

    await open();
    expect(h.document.activeElement).toBe(input());

    h.keydown(input(), { key: "Escape" });
    await h.flush();
    expect(h.document.activeElement).toBe(editBtn);
  });

  test("ファイル名は主、ディレクトリは従として並べる（同名の区別）", async () => {
    h = await bootApp({
      tree: {
        name: ".",
        path: "",
        type: "dir",
        children: [
          {
            name: "a",
            path: "a",
            type: "dir",
            children: [{ name: "guide.md", path: "a/guide.md", type: "file" }],
          },
          {
            name: "b",
            path: "b",
            type: "dir",
            children: [{ name: "guide.md", path: "b/guide.md", type: "file" }],
          },
        ],
      },
      files: {
        "a/guide.md": { raw: "a", html: "<p>a</p>", sha: "s1" },
        "b/guide.md": { raw: "b", html: "<p>b</p>", sha: "s2" },
      },
    });
    await open();
    typeInto(input(), "guide");
    await h.flush();

    const paths = items().map((b) => b.dataset.path);
    expect(paths).toEqual(["a/guide.md", "b/guide.md"]);
    // 同名でもディレクトリで区別できる
    expect(items()[0]?.querySelector(".qo-dir")?.textContent).toBe("a");
    expect(items()[1]?.querySelector(".qo-dir")?.textContent).toBe("b");
  });
});
