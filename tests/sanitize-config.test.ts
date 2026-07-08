import { describe, expect, test } from "bun:test";
import { SANITIZE_CONFIG } from "../public/sanitize-config.js";

/**
 * Issue #59: プレビューのサニタイザ設定が `<style>` タグと style 属性を禁止し、
 * CSS インジェクション (exfiltration) を防ぐことを検証する。
 * DOMPurify 本体の挙動は DOM が必要で bun test では動かせないため、設定内容を検証する
 * (実挙動は /ef-verify のブラウザ検証で確認する)。
 */
describe("SANITIZE_CONFIG (Issue #59)", () => {
  test("<style> タグを禁止する (FORBID_TAGS)", () => {
    expect(SANITIZE_CONFIG.FORBID_TAGS).toContain("style");
  });

  test("style 属性を禁止する (FORBID_ATTR)", () => {
    expect(SANITIZE_CONFIG.FORBID_ATTR).toContain("style");
  });

  test("既存の data-i18n* 禁止 (Issue #48) を維持する", () => {
    for (const attr of [
      "data-i18n",
      "data-i18n-title",
      "data-i18n-aria-label",
      "data-i18n-placeholder",
    ]) {
      expect(SANITIZE_CONFIG.FORBID_ATTR).toContain(attr);
    }
  });

  test("html profile を使い、target/rel は許可する (リンクの別タブ遷移を維持)", () => {
    expect(SANITIZE_CONFIG.USE_PROFILES).toEqual({ html: true });
    expect(SANITIZE_CONFIG.ADD_ATTR).toContain("target");
    expect(SANITIZE_CONFIG.ADD_ATTR).toContain("rel");
  });
});
