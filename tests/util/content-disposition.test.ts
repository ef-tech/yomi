import { describe, expect, test } from "bun:test";
import { buildContentDisposition } from "../../src/util/content-disposition.ts";

describe("buildContentDisposition (Issue #64)", () => {
  test("inline はファイル名を付けない (従来の挙動を維持)", () => {
    expect(buildContentDisposition("inline", "pic.png")).toBe("inline");
  });

  test("ASCII 名は filename と filename* の両方を出す", () => {
    expect(buildContentDisposition("attachment", "sales.csv")).toBe(
      `attachment; filename="sales.csv"; filename*=UTF-8''sales.csv`,
    );
  });

  test("日本語名は filename* で percent-encode し、fallback は `_` に落とす", () => {
    const value = buildContentDisposition("attachment", "売上.csv");
    expect(value).toBe(
      `attachment; filename="__.csv"; filename*=UTF-8''${encodeURIComponent("売上.csv")}`,
    );
  });

  test("スペースはエンコードされる (filename* に生のスペースを出さない)", () => {
    const value = buildContentDisposition("attachment", "my data.csv");
    expect(value).toContain(`filename*=UTF-8''my%20data.csv`);
    expect(value).toContain(`filename="my data.csv"`);
  });

  test("RFC 5987 の attr-char 外 (' ( ) *) もエンコードする", () => {
    const value = buildContentDisposition("attachment", "a'b(c)d*e.csv");
    expect(value).toContain(`filename*=UTF-8''a%27b%28c%29d%2Ae.csv`);
  });

  test("引用符・バックスラッシュ・改行はヘッダに素で載らない (ヘッダインジェクション防止)", () => {
    const value = buildContentDisposition("attachment", 'a"b\\c\r\nX-Injected: 1.csv');
    // fallback 側は `_` 化、filename* 側は percent-encode されるので生の CR/LF も `"` も残らない
    expect(value).not.toContain("\r");
    expect(value).not.toContain("\n");
    expect(value).toBe(
      `attachment; filename="a_b_c__X-Injected: 1.csv"; filename*=UTF-8''${encodeURIComponent(
        'a"b\\c\r\nX-Injected: 1.csv',
      )}`,
    );
  });

  test("非 ASCII だけの名前でも filename= が空にならない", () => {
    // 全角スペースは `_` に落ちるので空にならない
    expect(buildContentDisposition("attachment", "　")).toBe(
      `attachment; filename="_"; filename*=UTF-8''${encodeURIComponent("　")}`,
    );
    // 空白のみ / 空文字は "download" にフォールバックする (filename="" を出さない)
    expect(buildContentDisposition("attachment", " ")).toBe(
      `attachment; filename="download"; filename*=UTF-8''%20`,
    );
    expect(buildContentDisposition("attachment", "")).toBe(
      `attachment; filename="download"; filename*=UTF-8''`,
    );
  });
});
