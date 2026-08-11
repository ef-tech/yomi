/**
 * オーバーレイの重なり順の判定そのもの (Issue #112)。
 *
 * `tests/app-overlays.test.ts` は**実際のアプリを起動して**キー操作の結果を見る。
 * こちらは判定ロジックだけを直接叩く —— アプリを起こさずに全組み合わせを回せるのと、
 * **「新しいオーバーレイを足すときはここに 1 行足すだけ」という契約**（DoD 3）を
 * 明文化しておくため。
 */

import { describe, expect, test } from "bun:test";
import {
  isTopOverlay,
  OVERLAY_LAYERS,
  shortcutsBlocked,
  topOverlay,
} from "../public/app-overlays.js";

type Name = (typeof OVERLAY_LAYERS)[number]["name"];

/** 開いているものだけを渡して、`els` の必要な部分だけを作る。 */
function fakeEls(...open: Name[]) {
  const isOpen = (name: Name) => open.includes(name);
  const els = {
    sidebar: { classList: { contains: (c: string) => c === "is-open" && isOpen("sidebar") } },
    overflowMenu: { hidden: !isOpen("overflowMenu") },
    quickOpen: { hidden: !isOpen("quickOpen") },
    externalLinkBanner: { hidden: !isOpen("externalLinkBanner") },
    conflictDiff: { hidden: !isOpen("conflictDiff") },
  };
  return els as unknown as import("../public/app-context.js").Elements;
}

describe("重なり順の判定 (Issue #112)", () => {
  test("どれも開いていなければ null", () => {
    expect(topOverlay(fakeEls())).toBeNull();
  });

  test.each(OVERLAY_LAYERS.map((e) => e.name))("単独で開いていれば最前面 (%s)", (name) => {
    expect(topOverlay(fakeEls(name))).toBe(name);
  });

  // **登録順ではなく宣言された重なり順で決まる。** `wireX()` を並べ替えても変わらない
  test("重なったら layer が大きいほうが勝つ", () => {
    expect(topOverlay(fakeEls("quickOpen", "conflictDiff"))).toBe("conflictDiff");
    expect(topOverlay(fakeEls("sidebar", "quickOpen"))).toBe("quickOpen");
    expect(topOverlay(fakeEls("sidebar", "overflowMenu"))).toBe("overflowMenu");
    expect(topOverlay(fakeEls("sidebar", "externalLinkBanner"))).toBe("externalLinkBanner");
    expect(topOverlay(fakeEls("overflowMenu", "externalLinkBanner"))).toBe("externalLinkBanner");
    // バナーは全画面モーダルより下（スクリムの下に隠れる）
    expect(topOverlay(fakeEls("externalLinkBanner", "quickOpen"))).toBe("quickOpen");
    expect(topOverlay(fakeEls("sidebar", "overflowMenu", "quickOpen", "conflictDiff"))).toBe(
      "conflictDiff",
    );
  });

  // 引数の並び順に依存しないこと（`fakeEls` の配列順は判定に関係ない）
  test("渡す順序を変えても結果が変わらない", () => {
    expect(topOverlay(fakeEls("conflictDiff", "quickOpen"))).toBe("conflictDiff");
    expect(topOverlay(fakeEls("quickOpen", "conflictDiff"))).toBe("conflictDiff");
  });

  test("isTopOverlay は最前面のものにだけ true", () => {
    const els = fakeEls("sidebar", "quickOpen", "conflictDiff");
    expect(isTopOverlay("conflictDiff", els)).toBe(true);
    expect(isTopOverlay("quickOpen", els)).toBe(false);
    expect(isTopOverlay("sidebar", els)).toBe(false);
  });

  test("layer が重複していない（最前面がただ 1 つに決まる）", () => {
    const layers = OVERLAY_LAYERS.map((e) => e.layer);
    expect(new Set(layers).size).toBe(layers.length);
  });
});

describe("ショートカットの抑止 (Issue #112)", () => {
  test("何も開いていなければ抑止しない", () => {
    expect(shortcutsBlocked(fakeEls())).toBe(false);
  });

  test("全画面モーダルが最前面なら抑止する", () => {
    expect(shortcutsBlocked(fakeEls("quickOpen"))).toBe(true);
    expect(shortcutsBlocked(fakeEls("conflictDiff"))).toBe(true);
  });

  // **塞ぐと引き出しを開いたまま保存できなくなる。** これらは「背後に別のパネルが開く」
  // 問題を起こさないので止める理由がない
  test("全画面でないものは抑止しない", () => {
    expect(shortcutsBlocked(fakeEls("sidebar"))).toBe(false);
    expect(shortcutsBlocked(fakeEls("overflowMenu"))).toBe(false);
    expect(shortcutsBlocked(fakeEls("externalLinkBanner"))).toBe(false);
  });

  test("自分自身のショートカット（開閉トグル）は通す", () => {
    expect(shortcutsBlocked(fakeEls("quickOpen"), "quickOpen")).toBe(false);
    // ただし自分より手前に別のモーダルがあれば通さない
    expect(shortcutsBlocked(fakeEls("quickOpen", "conflictDiff"), "quickOpen")).toBe(true);
  });

  test("判定に使うのは最前面だけ（背後の重なりは見ない）", () => {
    // conflictDiff が最前面で、それは modal なので抑止される
    expect(shortcutsBlocked(fakeEls("quickOpen", "conflictDiff"))).toBe(true);
    // バナーが最前面なら、背後に sidebar が居ても抑止しない
    expect(shortcutsBlocked(fakeEls("sidebar", "externalLinkBanner"))).toBe(false);
    // **バナーは全画面モーダルより下。** `position: static` のインラインバナーなので、
    // クイックオープンのスクリムの下に隠れる（元の実装でも capture の quickOpen が勝っていた）
    expect(shortcutsBlocked(fakeEls("externalLinkBanner", "quickOpen"))).toBe(true);
  });
});
