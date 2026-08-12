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
});

/**
 * ## 「preload が `window` を残していない」はここでは検査できない
 *
 * 最初はそれを 1 本のテストにしていたが、**CI（macOS / ubuntu の両方）で落ちた**。
 * `globalThis.window` は**プロセス全体で共有される**うえ、
 * `tests/mermaid-secure.test.ts` の `beforeAll` が立てたまま**戻さない**ので、
 * そのファイルより後に走ったかどうかで結果が変わる。
 *
 * **つまりその検査自体が、この Issue が直している「実行順に依存するテスト」だった。**
 * 観測できないものを観測しようとしていたので消した。preload が後始末していることは
 * `tests/helpers/preload-dom.ts` を読めば分かる（記録した descriptor へ戻している）。
 */
