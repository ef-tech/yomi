import { beforeEach, describe, expect, test } from "bun:test";
import {
  __resetNavCounterForTest,
  buildUrl,
  currentNavIndex,
  getPathFromUrl,
  nextNavIndex,
  seedNavCounter,
} from "../../public/navigation.js";

describe("getPathFromUrl", () => {
  test("?path=foo.md を抽出する", () => {
    expect(getPathFromUrl({ search: "?path=foo.md" })).toBe("foo.md");
  });

  test("URL エンコード済みの path をデコードする", () => {
    expect(getPathFromUrl({ search: "?path=docs%2Fguide.md" })).toBe("docs/guide.md");
  });

  test("path クエリがなければ null", () => {
    expect(getPathFromUrl({ search: "" })).toBeNull();
    expect(getPathFromUrl({ search: "?other=value" })).toBeNull();
  });

  test("他のクエリと混在しても path だけ取れる", () => {
    expect(getPathFromUrl({ search: "?a=1&path=foo.md&b=2" })).toBe("foo.md");
  });
});

describe("buildUrl", () => {
  // buildUrl は window.location.pathname を参照するので、テスト時の値を確認だけする
  const PATHNAME = typeof window !== "undefined" ? window.location.pathname : "/";

  test("path を ?path=... に詰める", () => {
    expect(buildUrl("foo.md")).toBe("?path=foo.md");
  });

  test("path に / が含まれていれば URL エンコードされる", () => {
    expect(buildUrl("docs/guide.md")).toBe("?path=docs%2Fguide.md");
  });

  test("path が null / 空なら pathname を返す", () => {
    expect(buildUrl(null)).toBe(PATHNAME);
    expect(buildUrl("")).toBe(PATHNAME);
  });
});

describe("navCounter (nextNavIndex / currentNavIndex / seedNavCounter)", () => {
  beforeEach(() => {
    __resetNavCounterForTest();
  });

  test("nextNavIndex は 1 から始まり単調増加する", () => {
    expect(nextNavIndex()).toBe(1);
    expect(nextNavIndex()).toBe(2);
    expect(nextNavIndex()).toBe(3);
  });

  test("currentNavIndex は最後に発行した値を返す", () => {
    expect(currentNavIndex()).toBe(0);
    nextNavIndex();
    nextNavIndex();
    expect(currentNavIndex()).toBe(2);
  });

  test("seedNavCounter は現在値より大きい値で進めるが、小さい値は無視", () => {
    nextNavIndex(); // 1
    seedNavCounter(5);
    expect(currentNavIndex()).toBe(5);
    expect(nextNavIndex()).toBe(6);

    // 後退させない
    seedNavCounter(2);
    expect(currentNavIndex()).toBe(6);
  });

  test("seedNavCounter は null / undefined / 非 number を無視する", () => {
    nextNavIndex(); // 1
    seedNavCounter(null);
    seedNavCounter(undefined);
    // @ts-expect-error 非 number を渡して無視されることを確認
    seedNavCounter("9");
    expect(currentNavIndex()).toBe(1);
  });
});
