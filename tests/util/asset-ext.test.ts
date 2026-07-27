import { describe, expect, test } from "bun:test";
import { assetContentType, assetDisposition, isAssetExtension } from "../../src/util/asset-ext.ts";

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

  test("Issue #64: データ / 文書 / アーカイブ形式が許可される", () => {
    expect(isAssetExtension("sales.csv")).toBe(true);
    expect(isAssetExtension("dir/report.TSV")).toBe(true);
    expect(isAssetExtension("a.txt")).toBe(true);
    expect(isAssetExtension("a.json")).toBe(true);
    expect(isAssetExtension("a.yaml")).toBe(true);
    expect(isAssetExtension("a.yml")).toBe(true);
    expect(isAssetExtension("a.zip")).toBe(true);
    expect(isAssetExtension("a.xlsx")).toBe(true);
    expect(isAssetExtension("a.docx")).toBe(true);
    expect(isAssetExtension("a.pptx")).toBe(true);
  });

  test("Issue #64: 実行 / 描画される形式は許可しない (許可リスト方式の維持)", () => {
    expect(isAssetExtension("a.html")).toBe(false);
    expect(isAssetExtension("a.htm")).toBe(false);
    expect(isAssetExtension("a.xhtml")).toBe(false);
    expect(isAssetExtension("a.js")).toBe(false);
    expect(isAssetExtension("a.mjs")).toBe(false);
  });

  test("非対応は false", () => {
    expect(isAssetExtension("a.md")).toBe(false);
    expect(isAssetExtension("a.exe")).toBe(false);
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

  test("Issue #64: 追加した形式の Content-Type", () => {
    expect(assetContentType("a.csv")).toBe("text/csv; charset=utf-8");
    expect(assetContentType("a.tsv")).toBe("text/tab-separated-values; charset=utf-8");
    expect(assetContentType("a.txt")).toBe("text/plain; charset=utf-8");
    expect(assetContentType("a.json")).toBe("application/json; charset=utf-8");
    expect(assetContentType("a.yml")).toBe("application/yaml; charset=utf-8");
    expect(assetContentType("a.zip")).toBe("application/zip");
    expect(assetContentType("B.XLSX")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  test("非対応は null", () => {
    expect(assetContentType("a.md")).toBeNull();
    expect(assetContentType("a.html")).toBeNull();
    expect(assetContentType("noext")).toBeNull();
  });

  test("Object.prototype 継承キーは null (プロトタイプ汚染防御)", () => {
    expect(assetContentType("foo.toString")).toBeNull();
    expect(assetContentType("foo.__proto__")).toBeNull();
  });
});

describe("assetDisposition (Issue #64)", () => {
  test("画像 / PDF は inline", () => {
    expect(assetDisposition("a.png")).toBe("inline");
    expect(assetDisposition("b.svg")).toBe("inline");
    expect(assetDisposition("c.pdf")).toBe("inline");
    expect(assetDisposition("D.PDF")).toBe("inline");
  });

  test("データ / 文書 / アーカイブ形式は attachment", () => {
    expect(assetDisposition("a.csv")).toBe("attachment");
    expect(assetDisposition("a.txt")).toBe("attachment");
    expect(assetDisposition("a.zip")).toBe("attachment");
    expect(assetDisposition("A.DOCX")).toBe("attachment");
  });

  test("許可リスト外・拡張子なしは安全側の attachment に倒す", () => {
    expect(assetDisposition("a.html")).toBe("attachment");
    expect(assetDisposition("noext")).toBe("attachment");
    expect(assetDisposition("foo.")).toBe("attachment");
    expect(assetDisposition("foo.__proto__")).toBe("attachment");
  });
});
