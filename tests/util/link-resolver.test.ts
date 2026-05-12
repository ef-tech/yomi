import { describe, expect, test } from "bun:test";
import {
  isAnchor,
  isExternalUrl,
  isJavascriptUrl,
  resolveRelativePath,
  splitHrefHash,
} from "../../public/link-resolver.js";

describe("isAnchor", () => {
  test("#fragment は true", () => {
    expect(isAnchor("#foo")).toBe(true);
    expect(isAnchor("#")).toBe(true);
  });

  test("foo.md#bar は false (途中のアンカーは別扱い)", () => {
    expect(isAnchor("foo.md#bar")).toBe(false);
  });

  test("相対パスは false", () => {
    expect(isAnchor("foo.md")).toBe(false);
    expect(isAnchor("./foo.md")).toBe(false);
  });

  test("外部 URL は false", () => {
    expect(isAnchor("https://example.com")).toBe(false);
  });
});

describe("isExternalUrl", () => {
  test("http / https は true", () => {
    expect(isExternalUrl("http://example.com")).toBe(true);
    expect(isExternalUrl("https://example.com")).toBe(true);
  });

  test("mailto / tel / sms / ftp は true", () => {
    expect(isExternalUrl("mailto:x@y.com")).toBe(true);
    expect(isExternalUrl("tel:+819012345678")).toBe(true);
    expect(isExternalUrl("sms:+819012345678")).toBe(true);
    expect(isExternalUrl("ftp://example.com/file")).toBe(true);
  });

  test("javascript: スキームも true (スキーム判定としては正しい)", () => {
    expect(isExternalUrl("javascript:alert(1)")).toBe(true);
  });

  test("相対パスは false", () => {
    expect(isExternalUrl("foo.md")).toBe(false);
    expect(isExternalUrl("./foo.md")).toBe(false);
    expect(isExternalUrl("../bar.md")).toBe(false);
  });

  test("アンカーは false", () => {
    expect(isExternalUrl("#foo")).toBe(false);
  });

  test("ルート絶対パス (/foo) は false", () => {
    expect(isExternalUrl("/foo.md")).toBe(false);
  });
});

describe("isJavascriptUrl", () => {
  test("javascript:alert(1) は true", () => {
    expect(isJavascriptUrl("javascript:alert(1)")).toBe(true);
  });

  test("大文字混在も true (JavaScript:)", () => {
    expect(isJavascriptUrl("JavaScript:alert(1)")).toBe(true);
    expect(isJavascriptUrl("JAVASCRIPT:void(0)")).toBe(true);
  });

  test("前空白の難読化も true", () => {
    expect(isJavascriptUrl(" javascript:alert(1)")).toBe(true);
    expect(isJavascriptUrl("\tjavascript:alert(1)")).toBe(true);
    expect(isJavascriptUrl("javascript : alert(1)")).toBe(true);
  });

  test("https は false", () => {
    expect(isJavascriptUrl("https://example.com")).toBe(false);
  });

  test("javascriptfoo: のような偽スキームは false", () => {
    expect(isJavascriptUrl("javascriptfoo:alert(1)")).toBe(false);
  });
});

describe("resolveRelativePath", () => {
  test("同階層ファイル", () => {
    expect(resolveRelativePath("docs/guide.md", "api.md")).toBe("docs/api.md");
  });

  test("./ プレフィックスは同階層", () => {
    expect(resolveRelativePath("docs/guide.md", "./api.md")).toBe("docs/api.md");
  });

  test("../ で親階層", () => {
    expect(resolveRelativePath("docs/guide.md", "../README.md")).toBe("README.md");
  });

  test("サブディレクトリ", () => {
    expect(resolveRelativePath("docs/guide.md", "sub/foo.md")).toBe("docs/sub/foo.md");
  });

  test("ルート直下 (currentPath にディレクトリなし)", () => {
    expect(resolveRelativePath("root.md", "other.md")).toBe("other.md");
  });

  test("深い階層から root まで戻る", () => {
    expect(resolveRelativePath("a/b/c.md", "../../top.md")).toBe("top.md");
  });

  test("root を超える .. は root 止まり", () => {
    expect(resolveRelativePath("a.md", "../../foo.md")).toBe("foo.md");
    expect(resolveRelativePath("a/b.md", "../../../foo.md")).toBe("foo.md");
  });

  test("URL エンコードされた空白を decode", () => {
    expect(resolveRelativePath("docs/guide.md", "./hello%20world.md")).toBe("docs/hello world.md");
  });

  test("末尾のフラグメント (#anchor) は除外して path だけ解決", () => {
    expect(resolveRelativePath("docs/guide.md", "api.md#section")).toBe("docs/api.md");
  });

  test("末尾のクエリ (?query) も除外", () => {
    expect(resolveRelativePath("docs/guide.md", "api.md?v=1")).toBe("docs/api.md");
  });

  test("絶対パス (/foo.md) は root から解決", () => {
    expect(resolveRelativePath("docs/guide.md", "/top.md")).toBe("top.md");
    expect(resolveRelativePath("docs/sub/x.md", "/a/b.md")).toBe("a/b.md");
  });

  test("空文字や非文字列はランタイムで空文字 fallback", () => {
    expect(resolveRelativePath("", "foo.md")).toBe("foo.md");
    // 型定義上は string だが、ランタイム防御として null/undefined を空文字に変換することを確認
    expect(resolveRelativePath(null as unknown as string, "foo.md")).toBe("");
    expect(resolveRelativePath("foo.md", null as unknown as string)).toBe("");
  });

  test("連続スラッシュは空セグメントとして無視", () => {
    expect(resolveRelativePath("docs/guide.md", "sub//foo.md")).toBe("docs/sub/foo.md");
  });
});

describe("splitHrefHash", () => {
  test("hash なし: path のみ返す", () => {
    expect(splitHrefHash("foo.md")).toEqual({ path: "foo.md", hash: null });
    expect(splitHrefHash("../api.md")).toEqual({ path: "../api.md", hash: null });
    expect(splitHrefHash("./sub/foo.md")).toEqual({ path: "./sub/foo.md", hash: null });
  });

  test("hash あり: path と hash に分解する", () => {
    expect(splitHrefHash("foo.md#sec1")).toEqual({ path: "foo.md", hash: "sec1" });
    expect(splitHrefHash("../api.md#endpoints")).toEqual({
      path: "../api.md",
      hash: "endpoints",
    });
  });

  test("アンカー単独: path は空文字、hash のみ", () => {
    expect(splitHrefHash("#sec1")).toEqual({ path: "", hash: "sec1" });
    expect(splitHrefHash("#見出し")).toEqual({ path: "", hash: "見出し" });
  });

  test("URL エンコードされた日本語 hash は decode される", () => {
    expect(splitHrefHash("database.md#%E5%89%8A%E9%99%A4%E6%88%A6%E7%95%A5")).toEqual({
      path: "database.md",
      hash: "削除戦略",
    });
  });

  test("空文字 hash (`foo.md#`) は hash: null として扱う", () => {
    expect(splitHrefHash("foo.md#")).toEqual({ path: "foo.md", hash: null });
  });

  test("複数 # は最初の # で分割 (それ以降は hash に含む)", () => {
    expect(splitHrefHash("foo.md#a#b")).toEqual({ path: "foo.md", hash: "a#b" });
  });

  test("string でない入力は空のオブジェクト", () => {
    // @ts-expect-error 非 string を渡して空が返ることを確認
    expect(splitHrefHash(null)).toEqual({ path: "", hash: null });
    // @ts-expect-error
    expect(splitHrefHash(undefined)).toEqual({ path: "", hash: null });
  });

  test("不正な URL エンコードはそのまま使う", () => {
    expect(splitHrefHash("foo.md#%E5%89")).toEqual({ path: "foo.md", hash: "%E5%89" });
  });

  test("空文字は path も hash も空", () => {
    expect(splitHrefHash("")).toEqual({ path: "", hash: null });
  });

  test("hash は NFC に正規化される (NFD 入力でも NFC で返る)", () => {
    // 'が' の NFC (U+304C) と NFD (U+304B U+3099) は同じ文字列に正規化される
    const nfd = "が"; // か + 濁点
    const result = splitHrefHash(`foo.md#${nfd}`);
    expect(result.path).toBe("foo.md");
    expect(result.hash).toBe("が"); // NFC
    expect(result.hash).toBe("が");
  });
});
