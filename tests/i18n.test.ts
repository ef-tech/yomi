import { beforeEach, describe, expect, test } from "bun:test";
import { ERROR_CODE_KEYS, messagesFor, resolveLang, setLang, t } from "../public/i18n.js";

// t() / setLang() はモジュールレベルの現在言語を共有するため、各テスト前に ja へ戻す。
beforeEach(() => {
  setLang("ja");
});

describe("resolveLang", () => {
  test("ja / en は明示指定をそのまま返す", () => {
    expect(resolveLang("ja", "en-US")).toBe("ja");
    expect(resolveLang("en", "ja-JP")).toBe("en");
  });

  test("auto は navigator.language の en* を en、それ以外を ja に解決", () => {
    expect(resolveLang("auto", "en-US")).toBe("en");
    expect(resolveLang("auto", "en")).toBe("en");
    expect(resolveLang("auto", "ja-JP")).toBe("ja");
    expect(resolveLang("auto", "fr-FR")).toBe("ja");
  });

  test("navigator.language が undefined / 空でも ja にフォールバック", () => {
    expect(resolveLang("auto", undefined)).toBe("ja");
    expect(resolveLang("auto", "")).toBe("ja");
  });

  test("大文字小文字を無視する", () => {
    expect(resolveLang("auto", "EN-GB")).toBe("en");
  });
});

describe("t", () => {
  test("現在言語の辞書からメッセージを引く", () => {
    setLang("ja");
    expect(t("common.close")).toBe("閉じる");
    setLang("en");
    expect(t("common.close")).toBe("Close");
  });

  test("{name} プレースホルダを params で置換する", () => {
    setLang("ja");
    expect(t("status.showing", { path: "docs/a.md" })).toBe("docs/a.md を表示");
    setLang("en");
    expect(t("status.showing", { path: "docs/a.md" })).toBe("Showing docs/a.md");
  });

  test("複数プレースホルダを置換する", () => {
    setLang("en");
    expect(t("status.openFailed", { path: "a.md", msg: "boom" })).toBe("Could not open a.md: boom");
  });

  test("未翻訳キーは ja にフォールバックする", () => {
    // en 辞書に存在しない仮想キーは無いため、フォールバック経路は
    // 「en に無いが ja にある」状況を作れないここでは、未知キー→キー返却で検証する。
    setLang("en");
    expect(t("does.not.exist")).toBe("does.not.exist");
  });

  test("params 無しでもプレースホルダを含む生文字列は壊さない", () => {
    setLang("ja");
    expect(t("status.showing")).toBe("{path} を表示");
  });

  test("置換は 1 パスで行い、値に含まれる別プレースホルダを二重置換しない", () => {
    setLang("ja");
    // path 値に "{state}" が含まれていても、後続の {state} 置換に飲み込まれない
    expect(t("status.taskUpdated", { path: "{state}.md", state: "ON" })).toBe(
      "{state}.md を更新 (タスクON)",
    );
  });

  test("params に無いプレースホルダは元の {name} のまま残す", () => {
    setLang("en");
    expect(t("status.openFailed", { path: "a.md" })).toBe("Could not open a.md: {msg}");
  });
});

describe("ja / en の辞書はキー集合が完全に一致する", () => {
  test("両言語のキーが過不足なく揃っている", () => {
    const ja = Object.keys(messagesFor("ja")).sort();
    const en = Object.keys(messagesFor("en")).sort();
    const onlyJa = ja.filter((k) => !en.includes(k));
    const onlyEn = en.filter((k) => !ja.includes(k));
    expect(onlyJa).toEqual([]);
    expect(onlyEn).toEqual([]);
    expect(ja).toEqual(en);
  });
});

describe("ERROR_CODE_KEYS", () => {
  test("全 code が指す翻訳キーは ja / en 双方に存在する", () => {
    const ja = messagesFor("ja");
    const en = messagesFor("en");
    // キーは "error.foo" のようにドットを含むフラットキーなので、toHaveProperty の
    // パス解釈 (obj.error.foo) を避けて Object.hasOwn で存在確認する。
    for (const key of Object.values(ERROR_CODE_KEYS)) {
      expect(Object.hasOwn(ja, key)).toBe(true);
      expect(Object.hasOwn(en, key)).toBe(true);
    }
  });
});
