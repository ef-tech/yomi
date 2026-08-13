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

  /**
   * **同じ path への set が既存のマークを消さない (Issue #129)。**
   *
   * 以前は 1 パス 1 値で、後から来た保存が先のマークを消していた。それが
   * 「先の保存が watcher から他人の変更に見える → 余計なリロード」の直接の原因。
   * **並行する保存のマークが共存する**ことがこの Issue の要。
   */
  test("同じ path に set し直しても、前のマークが残る", () => {
    const m = new SaveMark();
    m.set("a.md", "v1");
    m.set("a.md", "v2");
    expect(m.has("a.md", "v1")).toBe(true);
    expect(m.has("a.md", "v2")).toBe(true);
    // `size` はパス数なので 1 のまま。マークの数は `markCount` で見る
    expect(m.size).toBe(1);
    expect(m.markCount).toBe(2);
  });

  test("同じ sha を 2 回 set しても二重に持たない", () => {
    const m = new SaveMark();
    m.set("a.md", "v1");
    m.set("a.md", "v1");
    expect(m.markCount).toBe(1);
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
  /**
   * **1 パスあたりのマークも上限を持つ (Issue #129 の DoD 2)。**
   *
   * 保存が成功したマークは**誰も消さない**（watcher の debounce が読むまで残す必要がある）。
   * 1 パスに無制限に積むと、同じファイルを保存し続けるだけで溜まり続ける。
   */
  test("1 パスに残るマークは上限で頭打ちになる", () => {
    const m = new SaveMark(64, 3);
    for (const v of ["v1", "v2", "v3", "v4", "v5"]) m.set("a.md", v);
    expect(m.markCount).toBe(3);
    // 古いものから落ちる
    expect(m.has("a.md", "v1")).toBe(false);
    expect(m.has("a.md", "v2")).toBe(false);
    expect(m.has("a.md", "v3")).toBe(true);
    expect(m.has("a.md", "v5")).toBe(true);
  });

  test("既定の 1 パス上限は 4 件", () => {
    const m = new SaveMark();
    for (let i = 0; i < 20; i++) m.set("a.md", `v${i}`);
    expect(m.markCount).toBe(4);
  });

  /**
   * **誤抑止の幅（Issue #129 の DoD 3）。**
   *
   * マークは**内容の同一性**で引くので、残っている sha と同じ内容を外部エディタが
   * 書くと「自分の保存」と誤認してリロードを飛ばさない。
   *
   * - **変更前**: 1 パス 1 値 → 誤抑止するのは「**直前に保存した内容**へ戻したとき」だけ
   * - **変更後**: 1 パス 4 値 → 「**直近 4 回ぶんのどれか**へ戻したとき」に広がる
   *
   * **広がったことをここで固定する。** 5 回前へ戻した場合は従来どおり通知される。
   */
  test("誤抑止は直近 4 件ぶんまで（5 回前の内容へ戻せば通知される）", () => {
    const m = new SaveMark();
    for (const v of ["v1", "v2", "v3", "v4", "v5"]) m.set("a.md", v);
    // 直近 4 件は「自分の保存」と誤認する（広がった幅）
    for (const v of ["v2", "v3", "v4", "v5"]) expect(m.has("a.md", v)).toBe(true);
    // それより前は忘れているので、外部書き換えとして通知される
    expect(m.has("a.md", "v1")).toBe(false);
  });

  test("clear は自分の 1 件だけを消し、同じ path の他は残す", () => {
    const m = new SaveMark();
    m.set("a.md", "x");
    m.set("a.md", "y");
    expect(m.clear("a.md", "x")).toBe(true);
    expect(m.has("a.md", "x")).toBe(false);
    expect(m.has("a.md", "y")).toBe(true);
    expect(m.size).toBe(1);
  });

  test("最後の 1 件を消したら path ごと消える（幽霊を残さない）", () => {
    const m = new SaveMark();
    m.set("a.md", "x");
    expect(m.clear("a.md", "x")).toBe(true);
    expect(m.size).toBe(0);
    expect(m.markCount).toBe(0);
  });

  test("無いマークの clear は false（自分のぶんが既に押し出された場合）", () => {
    const m = new SaveMark(64, 1);
    m.set("a.md", "old");
    m.set("a.md", "new"); // old は上限で押し出される
    expect(m.clear("a.md", "old")).toBe(false);
    expect(m.has("a.md", "new")).toBe(true);
  });
});
