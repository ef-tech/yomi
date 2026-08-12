/**
 * npm `dompurify` の共有インスタンスが使える状態であること (Issue #133)。
 *
 * ## これが落ちるとき何が起きるか
 *
 * `dompurify` は**モジュールを評価した瞬間の `globalThis.window`** で使えるかどうかが
 * 決まり、無ければ `addHook` すら生えていない張りぼてを作る。それが**プロセス全体で
 * 共有される**ので、`mermaid` が `DOMPurify.addHook(...)` を呼んだところで
 * `TypeError: DOMPurify.addHook is not a function` になり、
 * `tests/mermaid-secure.test.ts` が落ちる。
 *
 * **`bun test` はファイルを指定順に走らせず、レジストリはファイルをまたいで共有される**
 * ので、「どのファイルが最初に評価したか」で結果が変わる —— これが #133 の間欠性の正体。
 *
 * `tests/helpers/preload-dom.ts`（`bunfig.toml` の `[test] preload`）が先に評価して
 * 塞いでいる。**この 1 本が、その仕掛けが生きていることの見張り。**
 */

import { describe, expect, test } from "bun:test";

describe("共有 dompurify インスタンス (Issue #133)", () => {
  test("DOM 付きで評価されている（mermaid が addHook を呼べる）", async () => {
    const DOMPurify = (await import("dompurify")).default as unknown as Record<string, unknown>;
    expect(DOMPurify.isSupported).toBe(true);
    // mermaid の `setupDompurifyHooks` が実際に呼ぶもの
    expect(typeof DOMPurify.addHook).toBe("function");
    expect(typeof DOMPurify.removeHook).toBe("function");
  });

  /**
   * **preload が `window` を残していないこと。**
   *
   * 残すと「ブラウザが居る」前提で全テストが走り、`window` の有無で分岐するコードを
   * 本番と違う条件で検証することになる。DOMPurify は渡された window を自分で
   * 保持するので、戻しても動き続ける。
   */
  test("preload はグローバルに window を残さない", () => {
    expect((globalThis as Record<string, unknown>).window).toBeUndefined();
    expect((globalThis as Record<string, unknown>).document).toBeUndefined();
  });
});
