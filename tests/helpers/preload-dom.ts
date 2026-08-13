/**
 * `bun test` の全ファイルより先に走る前処理 (Issue #133)。
 *
 * ## 何を直しているか
 *
 * **npm の `dompurify` は「モジュールを評価した瞬間の `globalThis.window`」で
 * 使えるかどうかが決まる。** 無ければ `isSupported: false` の張りぼて（`addHook` すら
 * 生えていない）を作り、それが**プロセス全体で共有される**。
 *
 * `mermaid` はその共有インスタンスに対して `DOMPurify.addHook(...)` を呼ぶので、
 * 張りぼてを掴むと `TypeError: DOMPurify.addHook is not a function` で描画が落ちる。
 *
 * ## なぜ間欠的だったか
 *
 * **`bun test` はファイルを指定順に走らせない**（実測: `bun test a b` で b が先に走る）。
 * そして**モジュールレジストリはファイルをまたいで共有される**。つまり
 * **どのファイルが最初に `dompurify` を評価したか**で結果が決まっていた:
 *
 * - `tests/mermaid-secure.test.ts` が先 → `beforeAll` が `window` を立ててから
 *   `import("mermaid")` するので、まともなインスタンスができる → 全部通る
 * - `tests/sanitize-behavior.test.ts`（`import createDOMPurify from "dompurify"` を
 *   **静的に**持つ）が先 → `window` が無い状態で評価され張りぼてになる → mermaid が落ちる
 *
 * 実行順は実行のたびに変わりうるので、**同じコードのまま通ったり落ちたりして**いた。
 *
 * ## なぜ preload で直すか
 *
 * 「静的 import をやめて `beforeAll` で動的に読む」でも直るが、**次に誰かが
 * `import ... from "dompurify"` と書いた瞬間に戻る**。ここで先に評価しておけば、
 * 以後どのファイルがどの順で読んでも、掴むのは DOM 付きのインスタンスになる。
 *
 * ## 副作用を最小にする
 *
 * `globalThis.window` / `document` は**この評価のためだけ**に立てて、すぐ元へ戻す。
 * 残すと、`window` の有無で分岐するコードの検証が本番と違う条件で走ってしまう
 * （`src/` は現状 `window` を見ていないが、この前処理はそこに依存しない）。
 * DOMPurify は渡された window への参照を自分で保持するので、戻しても動き続ける。
 */

import { JSDOM } from "jsdom";

/**
 * **閉じない。** DOMPurify がこの window の `document` を掴み続けるので、
 * 閉じると以後の `sanitize` が壊れる（`tests/helpers/app-harness.ts` の
 * `bindDomPurifyOnce` が同じ理由で専用 window を持っている）。
 */
const dom = new JSDOM("");

const g = globalThis as unknown as Record<string, unknown>;
const hadWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const hadDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

g.window = dom.window;
g.document = dom.window.document;

// **ここで評価させるのが目的。** 戻り値は使わない
await import("dompurify");

if (hadWindow) Object.defineProperty(globalThis, "window", hadWindow);
else delete g.window;
if (hadDocument) Object.defineProperty(globalThis, "document", hadDocument);
else delete g.document;
