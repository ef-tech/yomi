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
});
