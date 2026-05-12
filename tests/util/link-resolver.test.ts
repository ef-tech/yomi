import { describe, expect, test } from "bun:test";
import {
  isAnchor,
  isExternalUrl,
  isJavascriptUrl,
  resolveRelativePath,
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
