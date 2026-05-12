import { beforeEach, describe, expect, test } from "bun:test";
import {
  __resetNavCounterForTest,
  buildUrl,
  currentNavIndex,
  getHashFromUrl,
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

  test("hash を付ければ末尾に encodeURIComponent されて付く", () => {
    expect(buildUrl("foo.md", "section-1")).toBe("?path=foo.md#section-1");
    expect(buildUrl("foo.md", "削除戦略")).toBe(
      "?path=foo.md#%E5%89%8A%E9%99%A4%E6%88%A6%E7%95%A5",
    );
  });

  test("hash が null / 空文字 / undefined は付かない", () => {
    expect(buildUrl("foo.md", null)).toBe("?path=foo.md");
    expect(buildUrl("foo.md", "")).toBe("?path=foo.md");
    expect(buildUrl("foo.md", undefined)).toBe("?path=foo.md");
  });

  test("path なし + hash あり: pathname + #hash", () => {
    expect(buildUrl(null, "sec")).toBe(`${PATHNAME}#sec`);
  });
});

describe("getHashFromUrl", () => {
  test("location.hash から見出し ID を取得 (decodeURIComponent 込み)", () => {
    expect(getHashFromUrl({ hash: "#%E5%89%8A%E9%99%A4%E6%88%A6%E7%95%A5" })).toBe("削除戦略");
    expect(getHashFromUrl({ hash: "#section-1" })).toBe("section-1");
  });

  test("hash が空 / # のみ / 未定義なら null", () => {
    expect(getHashFromUrl({ hash: "" })).toBeNull();
    expect(getHashFromUrl({ hash: "#" })).toBeNull();
    expect(getHashFromUrl(null)).toBeNull();
  });

  test("不正な URL エンコードは生文字列を返す", () => {
    expect(getHashFromUrl({ hash: "#%E5%89" })).toBe("%E5%89");
  });

  test("NFD で encode された hash は NFC に正規化される", () => {
    // 'が' の NFD = か (U+304B) + 濁点 (U+3099)
    // URL エンコード: %E3%81%8B%E3%82%99
    expect(getHashFromUrl({ hash: "#%E3%81%8B%E3%82%99" })).toBe("が");
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
