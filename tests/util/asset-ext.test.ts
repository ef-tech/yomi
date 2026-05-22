import { describe, expect, test } from "bun:test";
import { assetContentType, isAssetExtension } from "../../src/util/asset-ext.ts";

describe("isAssetExtension", () => {
  test("画像拡張子は許可される", () => {
    expect(isAssetExtension("a.png")).toBe(true);
    expect(isAssetExtension("dir/b.jpg")).toBe(true);
    expect(isAssetExtension("c.svg")).toBe(true);
  });

  test("Issue #37: PDF が許可される", () => {
    expect(isAssetExtension("foo.pdf")).toBe(true);
    expect(isAssetExtension("dir/bar.PDF")).toBe(true);
  });

  test("非対応は false", () => {
    expect(isAssetExtension("a.md")).toBe(false);
    expect(isAssetExtension("a.txt")).toBe(false);
    expect(isAssetExtension("a.docx")).toBe(false);
    expect(isAssetExtension("noext")).toBe(false);
    expect(isAssetExtension("")).toBe(false);
  });

  test("末尾ドットは false (空拡張子)", () => {
    expect(isAssetExtension("foo.")).toBe(false);
  });

  test("画像拡張子の大文字も許可される (case-insensitive)", () => {
    expect(isAssetExtension("A.PNG")).toBe(true);
    expect(isAssetExtension("B.JPG")).toBe(true);
    expect(isAssetExtension("C.WebP")).toBe(true);
  });

  test("Object.prototype 継承キー (`.toString`, `.__proto__`) は false (プロトタイプ汚染防御)", () => {
    // `lastIndexOf('.') > -1` で `.toString` 等の文字列が "拡張子" として渡された
    // 場合に `in` 演算子が Object.prototype を見て true を返さないことを保証。
    expect(isAssetExtension("foo.toString")).toBe(false);
    expect(isAssetExtension("foo.hasOwnProperty")).toBe(false);
    expect(isAssetExtension("foo.constructor")).toBe(false);
  });
});

describe("assetContentType", () => {
  test("画像 / PDF とも正しい Content-Type を返す", () => {
    expect(assetContentType("a.png")).toBe("image/png");
    expect(assetContentType("b.svg")).toBe("image/svg+xml");
    expect(assetContentType("c.pdf")).toBe("application/pdf");
    expect(assetContentType("D.PDF")).toBe("application/pdf");
  });

  test("非対応は null", () => {
    expect(assetContentType("a.md")).toBeNull();
    expect(assetContentType("a.zip")).toBeNull();
    expect(assetContentType("noext")).toBeNull();
  });

  test("Object.prototype 継承キーは null (プロトタイプ汚染防御)", () => {
    expect(assetContentType("foo.toString")).toBeNull();
    expect(assetContentType("foo.__proto__")).toBeNull();
  });
});
