import { describe, expect, test } from "bun:test";
import { SaveMark, sha256 } from "../src/save-mark.ts";

describe("sha256", () => {
  test("文字列の sha256 を hex で返す", () => {
    expect(sha256("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  test("空文字でも安定", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("Buffer も受け取れる", () => {
    expect(sha256(Buffer.from("hello"))).toBe(sha256("hello"));
  });
});

describe("SaveMark", () => {
  test("set した sha に対しては has が true", () => {
    const m = new SaveMark();
    m.set("a.md", "abc");
    expect(m.has("a.md", "abc")).toBe(true);
  });

  test("別の sha だと has が false", () => {
    const m = new SaveMark();
    m.set("a.md", "abc");
    expect(m.has("a.md", "xyz")).toBe(false);
  });

  test("未登録の path は has が false", () => {
    const m = new SaveMark();
    expect(m.has("nope.md", "abc")).toBe(false);
  });

  test("同じ path に set し直すと最新が反映される", () => {
    const m = new SaveMark();
    m.set("a.md", "v1");
    m.set("a.md", "v2");
    expect(m.has("a.md", "v1")).toBe(false);
    expect(m.has("a.md", "v2")).toBe(true);
    expect(m.size).toBe(1);
  });

  test("clear(path, sha) で個別削除できる", () => {
    const m = new SaveMark();
    m.set("a.md", "x");
    m.set("b.md", "y");
    expect(m.clear("a.md", "x")).toBe(true);
    expect(m.has("a.md", "x")).toBe(false);
    expect(m.has("b.md", "y")).toBe(true);
    expect(m.size).toBe(1);
  });

  // **並行保存で別リクエストのマークを壊さない (Issue #120)。**
  //
  // 以前はパス単位の無条件削除だったので、後から来たリクエストのマークを
  // 先のリクエストの失敗が消していた。結果、後のリクエストの正常な保存が
  // watcher から「他人の変更」に見えて余計なリロードが飛んでいた。
  test("値が食い違うときは消さない", () => {
    const m = new SaveMark();
    m.set("a.md", "後から来たリクエストの sha");

    // 先に始まったリクエストが失敗して、自分の sha で消そうとする
    expect(m.clear("a.md", "先に始まったリクエストの sha")).toBe(false);

    // 後から来たリクエストのマークは生きている
    expect(m.has("a.md", "後から来たリクエストの sha")).toBe(true);
    expect(m.size).toBe(1);
  });

  test("そもそもマークが無ければ何もしない", () => {
    const m = new SaveMark();
    expect(m.clear("none.md", "x")).toBe(false);
    expect(m.size).toBe(0);
  });

  test("clearAll() で全削除", () => {
    const m = new SaveMark();
    m.set("a.md", "x");
    m.set("b.md", "y");
    m.clearAll();
    expect(m.size).toBe(0);
  });

  test("LRU 上限を超えると古い entry から削除される", () => {
    const m = new SaveMark(3);
    m.set("a", "1");
    m.set("b", "2");
    m.set("c", "3");
    expect(m.size).toBe(3);

    m.set("d", "4"); // 'a' が押し出される想定
    expect(m.size).toBe(3);
    expect(m.has("a", "1")).toBe(false);
    expect(m.has("b", "2")).toBe(true);
    expect(m.has("c", "3")).toBe(true);
    expect(m.has("d", "4")).toBe(true);
  });

  test("LRU: 既存 path の更新は上限に影響しない", () => {
    const m = new SaveMark(2);
    m.set("a", "1");
    m.set("b", "2");
    m.set("a", "1b"); // 既存更新、size は 2 のまま
    expect(m.size).toBe(2);
    expect(m.has("a", "1b")).toBe(true);
    expect(m.has("b", "2")).toBe(true);
  });
});
