import { describe, expect, test } from "bun:test";
import { isMarkdownExtension } from "../../src/util/markdown-ext.ts";
import {
  isTextExtension,
  PLAIN_LANGUAGE,
  TEXT_FILENAMES,
  TEXT_LANGUAGES,
  textLanguageOf,
} from "../../src/util/text-ext.ts";
import { isViewableFile } from "../../src/util/viewable.ts";

describe("isTextExtension (Issue #155)", () => {
  test("テキスト系の拡張子を通す", () => {
    expect(isTextExtension("notes.txt")).toBe(true);
    expect(isTextExtension("data.csv")).toBe(true);
    expect(isTextExtension("config.json")).toBe(true);
    expect(isTextExtension("compose.yaml")).toBe(true);
    expect(isTextExtension("src/server.ts")).toBe(true);
  });

  test("大文字小文字を区別しない", () => {
    expect(isTextExtension("DATA.CSV")).toBe(true);
    expect(isTextExtension("Notes.TxT")).toBe(true);
  });

  test("allowlist 外は通さない", () => {
    // 画像・PDF・アーカイブ・実行ファイルは「ツリーから開いて読むもの」ではない
    expect(isTextExtension("photo.png")).toBe(false);
    expect(isTextExtension("manual.pdf")).toBe(false);
    expect(isTextExtension("archive.zip")).toBe(false);
    expect(isTextExtension("app.exe")).toBe(false);
    expect(isTextExtension("sheet.xlsx")).toBe(false);
    // 未知の拡張子も通さない (allowlist 方式)
    expect(isTextExtension("weird.qqq")).toBe(false);
  });

  test("拡張子なし・末尾ドットは通さない", () => {
    expect(isTextExtension("noext")).toBe(false);
    expect(isTextExtension("trailing.")).toBe(false);
    expect(isTextExtension("")).toBe(false);
  });

  test("Object.prototype のプロパティ名で素通りしない", () => {
    // `.toString` / `.__proto__` が「登録済み」に見える経路を塞いでいる
    expect(isTextExtension("evil.toString")).toBe(false);
    expect(isTextExtension("evil.constructor")).toBe(false);
    expect(isTextExtension("evil.__proto__")).toBe(false);
  });

  test("Markdown は含まない (別経路で扱う)", () => {
    expect(isTextExtension("README.md")).toBe(false);
    expect(isTextExtension("a.markdown")).toBe(false);
    expect(isTextExtension("a.mdx")).toBe(false);
  });

  test("秘密情報を含みがちな .env は既定で載せない", () => {
    expect(isTextExtension(".env")).toBe(false);
    expect(isTextExtension(".env.local")).toBe(false);
  });
});

describe("textLanguageOf (Issue #155)", () => {
  test("拡張子から highlight.js の言語 ID を引く", () => {
    expect(textLanguageOf("src/server.ts")).toBe("typescript");
    expect(textLanguageOf("app.js")).toBe("javascript");
    expect(textLanguageOf("config.json")).toBe("json");
    expect(textLanguageOf("compose.yml")).toBe("yaml");
    expect(textLanguageOf("Cargo.toml")).toBe("ini");
    expect(textLanguageOf("index.html")).toBe("xml");
    expect(textLanguageOf("style.scss")).toBe("scss");
    expect(textLanguageOf("run.sh")).toBe("bash");
  });

  test("ハイライトしないものは plaintext", () => {
    expect(textLanguageOf("notes.txt")).toBe(PLAIN_LANGUAGE);
    expect(textLanguageOf("data.csv")).toBe(PLAIN_LANGUAGE);
    expect(textLanguageOf("app.log")).toBe(PLAIN_LANGUAGE);
  });

  test("拡張子を持たない慣習ファイル名を拾う", () => {
    expect(textLanguageOf("Dockerfile")).toBe("dockerfile");
    expect(textLanguageOf("Makefile")).toBe("makefile");
    expect(textLanguageOf(".gitignore")).toBe(PLAIN_LANGUAGE);
    expect(textLanguageOf(".editorconfig")).toBe("ini");
    expect(textLanguageOf("LICENSE")).toBe(PLAIN_LANGUAGE);
  });

  test("ディレクトリ付きパスでも basename で判定する", () => {
    expect(textLanguageOf("docker/Dockerfile")).toBe("dockerfile");
    expect(textLanguageOf("a/b/c/.gitignore")).toBe(PLAIN_LANGUAGE);
    // Windows 由来の区切りも吸収する
    expect(textLanguageOf("a\\b\\Dockerfile")).toBe("dockerfile");
  });

  test("慣習ファイル名に拡張子が付いたものは拡張子側で判定する", () => {
    // `Dockerfile.dev` は TEXT_FILENAMES に無く、`.dev` も allowlist に無いので落ちる
    expect(textLanguageOf("Dockerfile.dev")).toBeNull();
  });

  test("対象外は null", () => {
    expect(textLanguageOf("photo.png")).toBeNull();
    expect(textLanguageOf("README.md")).toBeNull();
  });
});

describe("TEXT_LANGUAGES / TEXT_FILENAMES の整合", () => {
  test("Markdown 拡張子を含まない", () => {
    for (const ext of Object.keys(TEXT_LANGUAGES)) {
      expect(isMarkdownExtension(`x${ext}`)).toBe(false);
    }
  });

  test("拡張子キーはドット始まりの小文字", () => {
    for (const ext of Object.keys(TEXT_LANGUAGES)) {
      expect(ext.startsWith(".")).toBe(true);
      expect(ext).toBe(ext.toLowerCase());
    }
  });

  test("ファイル名キーは小文字 (basename を小文字化して引くため)", () => {
    for (const name of Object.keys(TEXT_FILENAMES)) {
      expect(name).toBe(name.toLowerCase());
    }
  });
});

describe("isViewableFile (Issue #155)", () => {
  test("Markdown とテキストの和になる", () => {
    expect(isViewableFile("README.md")).toBe(true);
    expect(isViewableFile("notes.txt")).toBe(true);
    expect(isViewableFile("Dockerfile")).toBe(true);
  });

  test("どちらでもないものは false", () => {
    expect(isViewableFile("photo.png")).toBe(false);
    expect(isViewableFile("archive.zip")).toBe(false);
    expect(isViewableFile("noext")).toBe(false);
  });
});
