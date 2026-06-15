import { describe, expect, test } from "bun:test";
import {
  MD_EXTENSIONS as CLIENT_MD_EXTENSIONS,
  completeMarkdownFileName,
  joinTreePath,
} from "../public/new-file.js";
import { MD_EXTENSIONS as SERVER_MD_EXTENSIONS } from "../src/util/markdown-ext.ts";

describe("completeMarkdownFileName", () => {
  test("拡張子なしは .md を補完", () => {
    expect(completeMarkdownFileName("foo")).toBe("foo.md");
  });

  test("許可拡張子はそのまま (.md / .markdown / .mdx)", () => {
    expect(completeMarkdownFileName("foo.md")).toBe("foo.md");
    expect(completeMarkdownFileName("foo.markdown")).toBe("foo.markdown");
    expect(completeMarkdownFileName("foo.mdx")).toBe("foo.mdx");
  });

  test("許可拡張子は大文字小文字を無視して受け入れる", () => {
    expect(completeMarkdownFileName("foo.MD")).toBe("foo.MD");
    expect(completeMarkdownFileName("foo.MdX")).toBe("foo.MdX");
  });

  test("非許可拡張子には .md を追加 (foo.txt → foo.txt.md)", () => {
    expect(completeMarkdownFileName("foo.txt")).toBe("foo.txt.md");
    expect(completeMarkdownFileName("foo.v2")).toBe("foo.v2.md");
  });

  test("前後の空白は trim", () => {
    expect(completeMarkdownFileName("  foo  ")).toBe("foo.md");
  });

  test("空・空白のみは null", () => {
    expect(completeMarkdownFileName("")).toBeNull();
    expect(completeMarkdownFileName("   ")).toBeNull();
  });

  test("'.' と '..' は null", () => {
    expect(completeMarkdownFileName(".")).toBeNull();
    expect(completeMarkdownFileName("..")).toBeNull();
  });

  test("パス区切り (/, \\) を含む名前は null", () => {
    expect(completeMarkdownFileName("docs/foo")).toBeNull();
    expect(completeMarkdownFileName("docs\\foo")).toBeNull();
    expect(completeMarkdownFileName("../evil")).toBeNull();
  });

  test("先頭ドットのみの名前 (.md) はベース名なしとして .md を補完", () => {
    // ".md" はベース名が空なので ".md.md" になる (隠しファイル風の入力は維持)
    expect(completeMarkdownFileName(".md")).toBe(".md.md");
    expect(completeMarkdownFileName(".hidden")).toBe(".hidden.md");
  });

  test("末尾ドットは許可拡張子ではないため .md を補完 (foo. → foo..md)", () => {
    // lastIndexOf('.') > 0 だが slice('.') === '.' は MD_EXTENSIONS に無い → 補完対象
    expect(completeMarkdownFileName("foo.")).toBe("foo..md");
  });
});

describe("MD_EXTENSIONS", () => {
  test("クライアントとサーバの許可拡張子は完全一致する (ドリフト防止)", () => {
    // public/new-file.js はビルドステップなしのため server の .ts を import できず
    // 拡張子集合を手動コピーしている。両者がずれると UI とサーバの判定が食い違うため
    // ここで不変条件として固定する。
    const client = [...CLIENT_MD_EXTENSIONS].sort();
    const server = [...SERVER_MD_EXTENSIONS].sort();
    expect(client).toEqual(server);
  });
});

describe("joinTreePath", () => {
  test("ルート ('') はファイル名のみ", () => {
    expect(joinTreePath("", "foo.md")).toBe("foo.md");
  });

  test("ディレクトリと結合", () => {
    expect(joinTreePath("docs", "foo.md")).toBe("docs/foo.md");
    expect(joinTreePath("docs/guide", "foo.md")).toBe("docs/guide/foo.md");
  });
});
