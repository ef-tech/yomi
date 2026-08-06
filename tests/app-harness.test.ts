/**
 * テストハーネス自身の後始末を守る回帰テスト (Issue #92)。
 *
 * `tests/helpers/app-harness.ts` は app.js を動かすために global を差し込む。
 * **差し込んだものを畳み切れていないと、壊れるのは別のテストファイル**になる
 * （原因から遠い場所で落ちるので追いにくい）。ここではその契約だけを検証する。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { bootApp, resetAppEnvironment } from "./helpers/app-harness.ts";

afterEach(resetAppEnvironment);

describe("resetAppEnvironment", () => {
  test("app.js が仕込んだ再接続タイマーを破棄する", async () => {
    const h = await bootApp();
    expect(h.sockets).toHaveLength(1);

    // close すると app.js が setTimeout(connectLiveReload, 500) を仕込む
    h.ws.close();
    resetAppEnvironment();

    // 再接続が起きる時刻を十分に越えて待つ。破棄できていないと、復元済みの global を
    // 触って `ReferenceError: location is not defined` になり、bun が
    // `0 fail / 1 error` で exit 1 する（テスト一覧に出ないまま CI が赤くなる）
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(h.sockets).toHaveLength(1);
  });

  test("toast の消去タイマー (3s) を残さない", async () => {
    // スマホ幅では setStatus が 3 秒後に class を外すタイマーを仕込む
    const h = await bootApp({ mobile: true });
    expect(h.el("status").classList.contains("is-toast")).toBe(true);
    resetAppEnvironment();
    // 破棄されていれば、待っても誰も DOM を触りに来ない
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.el("status").classList.contains("is-toast")).toBe(true);
  });

  test("差し込んだ global を素の状態へ戻す", async () => {
    await bootApp();
    expect(typeof globalThis.window).not.toBe("undefined");
    expect(typeof globalThis.document).not.toBe("undefined");

    resetAppEnvironment();

    // 戻し切れていないと server.test.ts / daemon.test.ts が偽 fetch を掴んで壊れる
    expect(typeof globalThis.window).toBe("undefined");
    expect(typeof globalThis.document).toBe("undefined");
    expect(typeof globalThis.location).toBe("undefined");
  });

  test("boot し直せば再び使える (冪等)", async () => {
    const first = await bootApp();
    expect(first.el("current-path").textContent).toBe("README.md");
    resetAppEnvironment();

    const second = await bootApp({ url: "http://localhost:3944/?path=docs/guide.md" });
    expect(second.el("current-path").textContent).toBe("docs/guide.md");
    expect(second.el("preview").innerHTML).toContain("Guide");
  });
});
