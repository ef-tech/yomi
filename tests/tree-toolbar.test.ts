import { describe, expect, test } from "bun:test";
import {
  collapseAllDirs,
  expandAllDirs,
  isTreeToolbarEnabled,
  ROOT_DIR,
} from "../public/tree-toolbar.js";

describe("expandAllDirs", () => {
  test("ROOT_DIR + 全ディレクトリ path の開集合を返す", () => {
    const next = expandAllDirs(["docs", "docs/guide", "src"]);
    expect(next).toEqual(new Set([ROOT_DIR, "docs", "docs/guide", "src"]));
  });

  test("現存しない stale path は引き継がない (剪定)", () => {
    // 過去に "old-dir" を開いていても、現ツリーに無ければ捨てる
    const next = expandAllDirs(["docs"]);
    expect(next.has("old-dir")).toBe(false);
    expect(next).toEqual(new Set([ROOT_DIR, "docs"]));
  });

  test("dirPaths が空 (フラット構成) なら ROOT_DIR のみ", () => {
    expect(expandAllDirs([])).toEqual(new Set([ROOT_DIR]));
  });

  test("dirPaths の重複は 1 つにまとまる", () => {
    const next = expandAllDirs(["docs", "docs"]);
    expect(next.size).toBe(2); // ROOT_DIR + docs
  });

  test("Map.keys() のような Iterable も受け付ける", () => {
    const dirNodes = new Map([
      ["docs", {}],
      ["src", {}],
    ]);
    const next = expandAllDirs(dirNodes.keys());
    expect(next).toEqual(new Set([ROOT_DIR, "docs", "src"]));
  });

  test("毎回新しい Set インスタンスを返す", () => {
    const a = expandAllDirs(["docs"]);
    const b = expandAllDirs(["docs"]);
    expect(a).not.toBe(b);
  });
});

describe("collapseAllDirs", () => {
  test("初期状態 (ROOT_DIR のみ) を返す", () => {
    expect(collapseAllDirs()).toEqual(new Set([ROOT_DIR]));
  });

  test("毎回新しい Set インスタンスを返す (共有による状態汚染を防ぐ)", () => {
    const a = collapseAllDirs();
    const b = collapseAllDirs();
    expect(a).not.toBe(b);
    a.add("docs");
    expect(b.has("docs")).toBe(false);
  });
});

describe("isTreeToolbarEnabled", () => {
  test("ディレクトリ 0 件 (読み込み中・フラット構成) は無効", () => {
    expect(isTreeToolbarEnabled(0)).toBe(false);
  });

  test("ディレクトリ 1 件以上で有効", () => {
    expect(isTreeToolbarEnabled(1)).toBe(true);
    expect(isTreeToolbarEnabled(100)).toBe(true);
  });
});

describe("expandAllDirs / collapseAllDirs の往復", () => {
  test("全て開く → 全て閉じるで初期状態に戻る", () => {
    const expanded = expandAllDirs(["docs", "docs/guide", "src"]);
    expect(expanded.size).toBe(4);
    const collapsed = collapseAllDirs();
    expect(collapsed).toEqual(new Set([ROOT_DIR]));
  });
});
