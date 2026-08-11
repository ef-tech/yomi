/**
 * 記事が参照する画像の収集 (Issue #140)。
 *
 * **判定を書き直さずプレビューと同じ `rewriteImageHref` を使う**のが要点なので、
 * ここでは「プレビューが `<img src>` にするもの」と一致することを見る。
 */

import { describe, expect, test } from "bun:test";
import { collectArticleImages } from "../src/article-images.ts";
import { rewriteImageHref } from "../src/renderer.ts";

const CURRENT = "docs/guide.md";

describe("collectArticleImages", () => {
  test("相対パスを root 起点に解決する", () => {
    const md = "![a](img/a.png)\n\n![b](../shared/b.jpg)\n";
    expect(collectArticleImages(md, CURRENT).local).toEqual(["docs/img/a.png", "shared/b.jpg"]);
  });

  test("同じ画像を 2 度参照しても 1 件になる", () => {
    const md = "![1](img/a.png)\n\n![2](./img/a.png)\n\n![3](img/a.png)\n";
    expect(collectArticleImages(md, CURRENT).local).toEqual(["docs/img/a.png"]);
  });

  test("出現順を保つ", () => {
    const md = "![c](img/c.png)\n\n![a](img/a.png)\n\n![b](img/b.png)\n";
    expect(collectArticleImages(md, CURRENT).local).toEqual([
      "docs/img/c.png",
      "docs/img/a.png",
      "docs/img/b.png",
    ]);
  });

  // **段落の外にある画像も拾う。** 表・リスト・引用・リンクの中を辿っていないと落ちる
  test.each([
    ["表のセル", "| h |\n|---|\n| ![t](img/t.png) |\n"],
    ["リスト", "- ![l](img/t.png)\n"],
    ["引用", "> ![q](img/t.png)\n"],
    ["リンクの中", "[![linked](img/t.png)](https://example.com)\n"],
    ["見出しの中", "# 見出し ![h](img/t.png)\n"],
  ])("%s の画像も拾う", (_label, md) => {
    expect(collectArticleImages(md, CURRENT).local).toEqual(["docs/img/t.png"]);
  });

  test("外部 URL と data: URI は local に入れず external へ回す", () => {
    const md = "![x](https://example.com/x.png)\n\n![d](data:image/png;base64,iVBORw0KGgo=)\n";
    const got = collectArticleImages(md, CURRENT);
    expect(got.local).toEqual([]);
    expect(got.external).toEqual([
      "https://example.com/x.png",
      "data:image/png;base64,iVBORw0KGgo=",
    ]);
  });

  // プレビューでも `<img src>` が空になり表示されない。zip にも入れない
  test.each([
    ["javascript:alert(1)"],
    ["vbscript:msgbox"],
    ["file:///etc/passwd"],
  ])("危険なスキーム (`%s`) はどちらにも入れない", (href) => {
    const got = collectArticleImages(`![x](${href})\n`, CURRENT);
    expect(got).toEqual({ local: [], external: [] });
  });

  /**
   * **生の HTML の `<img>` は対象外。**
   *
   * `renderMarkdown` は marked の `image` トークンしか書き換えないので、相対パスの
   * 生 `<img>` は `/api/asset` にならず**そもそも表示されない**。表示されないものを
   * zip に入れるほうが説明できない。
   */
  test("生の HTML の `<img>` は集めない", () => {
    const md = '<img src="raw.png">\n\n![md](img/a.png)\n';
    expect(collectArticleImages(md, CURRENT).local).toEqual(["docs/img/a.png"]);
  });

  test("画像拡張子でないものは local に入らない", () => {
    // `rewriteImageHref` が書き換えないので `/api/asset` にならず、配信もされない
    expect(collectArticleImages("![x](notes.txt)\n", CURRENT).local).toEqual([]);
  });

  test("URL エンコードされた名前を元に戻す", () => {
    const md = "![ja](img/%E6%97%A5%E6%9C%AC%E8%AA%9E.png)\n";
    expect(collectArticleImages(md, CURRENT).local).toEqual(["docs/img/日本語.png"]);
  });

  test("画像が無ければ両方とも空", () => {
    expect(collectArticleImages("# 見出し\n\n本文\n", CURRENT)).toEqual({
      local: [],
      external: [],
    });
  });

  /**
   * **プレビューと食い違わないこと。**
   *
   * ここが崩れると「画面には出ているのに zip に入らない」「その逆」が起きる。
   * 判定を写していない（`rewriteImageHref` をそのまま使っている）ことの確認でもある。
   */
  test.each([
    ["img/a.png"],
    ["../shared/b.jpg"],
    ["./sub/c.webp"],
    ["https://example.com/x.png"],
    ["notes.txt"],
    ["javascript:alert(1)"],
  ])("`%s` の扱いがプレビューと一致する", (href) => {
    const got = collectArticleImages(`![x](${href})\n`, CURRENT);
    const rewritten = rewriteImageHref(href, CURRENT);

    if (!rewritten) {
      expect(got).toEqual({ local: [], external: [] });
    } else if (rewritten.startsWith("/api/asset?path=")) {
      // プレビューが `/api/asset` にするものは、必ず zip の対象になる
      expect(got.local).toHaveLength(1);
      expect(got.external).toEqual([]);
    } else {
      expect(got.local).toEqual([]);
      expect(got.external).toEqual([rewritten]);
    }
  });
});
