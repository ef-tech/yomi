import { describe, expect, test } from "bun:test";
import { countTasksInMarkdown, toggleTaskInMarkdown } from "../../public/task-list.js";

describe("toggleTaskInMarkdown", () => {
  test("単一の未チェックを ON にする", () => {
    expect(toggleTaskInMarkdown("- [ ] foo", 0)).toEqual({
      body: "- [x] foo",
      newChecked: true,
    });
  });

  test("単一のチェック済みを OFF にする", () => {
    expect(toggleTaskInMarkdown("- [x] foo", 0)).toEqual({
      body: "- [ ] foo",
      newChecked: false,
    });
  });

  test("大文字 [X] も OFF にできる", () => {
    expect(toggleTaskInMarkdown("- [X] foo", 0)).toEqual({
      body: "- [ ] foo",
      newChecked: false,
    });
  });

  test("N 番目のタスクだけが切り替わる (他はそのまま)", () => {
    const body = "- [ ] a\n- [ ] b\n- [ ] c";
    expect(toggleTaskInMarkdown(body, 1)).toEqual({
      body: "- [ ] a\n- [x] b\n- [ ] c",
      newChecked: true,
    });
  });

  test("ネスト・インデント済みタスクも対応 (インデント保持)", () => {
    const body = "- [ ] parent\n  - [ ] child\n    - [ ] grandchild";
    expect(toggleTaskInMarkdown(body, 1)).toEqual({
      body: "- [ ] parent\n  - [x] child\n    - [ ] grandchild",
      newChecked: true,
    });
    expect(toggleTaskInMarkdown(body, 2)).toEqual({
      body: "- [ ] parent\n  - [ ] child\n    - [x] grandchild",
      newChecked: true,
    });
  });

  test("`*` や `+` の bullet もマッチする", () => {
    expect(toggleTaskInMarkdown("* [ ] star", 0)).toEqual({
      body: "* [x] star",
      newChecked: true,
    });
    expect(toggleTaskInMarkdown("+ [ ] plus", 0)).toEqual({
      body: "+ [x] plus",
      newChecked: true,
    });
  });

  test("code fence 内のタスク風文字列は無視する (``` バリエーション)", () => {
    const body = "- [ ] real\n```\n- [ ] fake in code\n```\n- [ ] real2";
    // index 0 は最初の real、index 1 は real2 (fake は数えない)
    expect(toggleTaskInMarkdown(body, 0)).toEqual({
      body: "- [x] real\n```\n- [ ] fake in code\n```\n- [ ] real2",
      newChecked: true,
    });
    expect(toggleTaskInMarkdown(body, 1)).toEqual({
      body: "- [ ] real\n```\n- [ ] fake in code\n```\n- [x] real2",
      newChecked: true,
    });
  });

  test("code fence 内のタスク風文字列は無視する (~~~ バリエーション)", () => {
    const body = "- [ ] real\n~~~\n- [ ] fake\n~~~\n- [ ] real2";
    expect(toggleTaskInMarkdown(body, 1)).toEqual({
      body: "- [ ] real\n~~~\n- [ ] fake\n~~~\n- [x] real2",
      newChecked: true,
    });
  });

  test("言語指定付き fence (```js) 内も無視する", () => {
    const body = "- [ ] real\n```js\n- [ ] fake\n```\n- [ ] real2";
    expect(toggleTaskInMarkdown(body, 1)).toEqual({
      body: "- [ ] real\n```js\n- [ ] fake\n```\n- [x] real2",
      newChecked: true,
    });
  });

  test("index 範囲外: 元の body そのまま、newChecked: null", () => {
    const body = "- [ ] only";
    expect(toggleTaskInMarkdown(body, 1)).toEqual({ body, newChecked: null });
    expect(toggleTaskInMarkdown(body, 99)).toEqual({ body, newChecked: null });
  });

  test("タスクが 1 つもない body: 元のまま、newChecked: null", () => {
    expect(toggleTaskInMarkdown("# 普通の見出し\n\n段落です。", 0)).toEqual({
      body: "# 普通の見出し\n\n段落です。",
      newChecked: null,
    });
  });

  test("中途半端な記法は無視: `普通の文章 [ ] かっこ` はタスクではない", () => {
    expect(toggleTaskInMarkdown("普通の文章 [ ] かっこ", 0)).toEqual({
      body: "普通の文章 [ ] かっこ",
      newChecked: null,
    });
  });

  test("string でない body: 空文字 / null 戻り", () => {
    // @ts-expect-error 非 string を渡して空が返ることを確認
    expect(toggleTaskInMarkdown(null, 0)).toEqual({ body: "", newChecked: null });
    // @ts-expect-error
    expect(toggleTaskInMarkdown(undefined, 0)).toEqual({ body: "", newChecked: null });
  });

  test("非整数の index は無視", () => {
    const body = "- [ ] foo";
    expect(toggleTaskInMarkdown(body, -1)).toEqual({ body, newChecked: null });
    expect(toggleTaskInMarkdown(body, 1.5)).toEqual({ body, newChecked: null });
    // @ts-expect-error 非 number を渡して無視されることを確認
    expect(toggleTaskInMarkdown(body, "0")).toEqual({ body, newChecked: null });
  });

  test("行末の追加情報も保持する (`- [ ] task // comment`)", () => {
    expect(toggleTaskInMarkdown("- [ ] task // 補足", 0)).toEqual({
      body: "- [x] task // 補足",
      newChecked: true,
    });
  });

  test("複数の bullet マーカーが混在しても順序通りカウント", () => {
    const body = "- [ ] a\n* [ ] b\n+ [ ] c";
    expect(toggleTaskInMarkdown(body, 2)).toEqual({
      body: "- [ ] a\n* [ ] b\n+ [x] c",
      newChecked: true,
    });
  });
});

describe("countTasksInMarkdown", () => {
  test("タスクなし: 0", () => {
    expect(countTasksInMarkdown("# heading\n\nparagraph")).toBe(0);
  });

  test("単一タスク: 1", () => {
    expect(countTasksInMarkdown("- [ ] foo")).toBe(1);
  });

  test("複数タスク: 全部数える (チェック状態によらず)", () => {
    expect(countTasksInMarkdown("- [ ] a\n- [x] b\n- [X] c")).toBe(3);
  });

  test("code fence 内は除外", () => {
    expect(countTasksInMarkdown("- [ ] real\n```\n- [ ] fake\n```\n- [x] real2")).toBe(2);
  });

  test("string でない入力: 0", () => {
    // @ts-expect-error
    expect(countTasksInMarkdown(null)).toBe(0);
  });
});
