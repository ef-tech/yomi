import { describe, expect, test } from "bun:test";
import { imageContentType, isImageExtension } from "../../src/util/image-ext.ts";

describe("isImageExtension", () => {
  test("代表的な画像拡張子を許可", () => {
    expect(isImageExtension("a.png")).toBe(true);
    expect(isImageExtension("dir/b.jpg")).toBe(true);
    expect(isImageExtension("C.JPEG")).toBe(true);
    expect(isImageExtension("d.gif")).toBe(true);
    expect(isImageExtension("e.webp")).toBe(true);
    expect(isImageExtension("f.svg")).toBe(true);
    expect(isImageExtension("g.avif")).toBe(true);
    expect(isImageExtension("h.bmp")).toBe(true);
    expect(isImageExtension("i.ico")).toBe(true);
  });

  test("非画像は false", () => {
    expect(isImageExtension("a.md")).toBe(false);
    expect(isImageExtension("a.txt")).toBe(false);
    expect(isImageExtension("noext")).toBe(false);
    expect(isImageExtension("")).toBe(false);
    expect(isImageExtension("a.exe")).toBe(false);
  });
});

describe("imageContentType", () => {
  test("正しい Content-Type を返す", () => {
    expect(imageContentType("a.png")).toBe("image/png");
    expect(imageContentType("b.JPG")).toBe("image/jpeg");
    expect(imageContentType("c.svg")).toBe("image/svg+xml");
    expect(imageContentType("d.ico")).toBe("image/x-icon");
  });

  test("非画像は null", () => {
    expect(imageContentType("a.md")).toBeNull();
    expect(imageContentType("noext")).toBeNull();
  });
});
