import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.YOMI_E2E_PORT ?? "39901";

/**
 * ブラウザ E2E の設定 (Issue #80)。
 *
 * ## ユニットテストとの責務分担
 *
 * | | 何を守るか | 実行 |
 * |---|---|---|
 * | `bun test` (`tests/`) | サーバの API・pure function・**jsdom 上での app.js の状態遷移**（特性テスト、Issue #77） | 常時。速い |
 * | `bun run test:e2e` (`e2e/`) | **実ブラウザでしか出ない結合** —— 実 CSS のレイアウト、実 DOM イベント、実 WebSocket、Mermaid の実描画、履歴 API | CI と手動。遅い |
 *
 * **jsdom で書けるものは E2E に書かない。** jsdom はレイアウトを持たず (`scrollTop` が常に 0)、
 * `IntersectionObserver` も `TouchEvent` も無いので特性テスト側はそこをスタブで埋めている。
 * E2E はその「スタブで埋めた部分が実物でも成り立つか」を見る場所であって、ロジックの網羅は
 * ユニット側の仕事。E2E を増やしすぎると CI が遅く不安定になる (Issue #45 の教訓)。
 *
 * ## flaky を持ち込まない方針 (Issue #45)
 *
 * - **固定 sleep を使わない。** Playwright の auto-waiting と `expect(locator)` の
 *   リトライで同期する。`waitForTimeout` は原則禁止
 * - `retries` は CI でも **0**。「たまに落ちるが再実行で通る」を許すと flaky が沈殿する
 *   (#45 がまさにそれ)。落ちたら直すか、その検証をユニット側へ移す
 * - `workers: 1`。yomi は 1 プロセス 1 ディレクトリを見るサーバで、並列にすると
 *   同じ fixture を複数のテストが書き換えて干渉する
 */
export default defineConfig({
  testDir: "./e2e",
  // fixture の md 自体はテストではない
  testMatch: /.*\.spec\.ts/,

  // 落ちたら直す。再実行で隠さない (Issue #45)
  retries: 0,
  workers: 1,
  // CI で `test.only` の付け忘れを検出する (一部しか走っていないのに green になるのを防ぐ)
  forbidOnly: !!process.env.CI,

  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // **失敗時の証跡** (DoD)。成功時は残さないので CI の artifact が膨らまない
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  /**
   * テスト対象の yomi を Playwright に起動させる。
   *
   * `--no-open` は必須 (CI にブラウザを開かせない)。`reuseExistingServer` はローカルでのみ
   * 有効にして、開発中に手で立てた yomi を掴めるようにする。CI では毎回新しく起動する。
   */
  webServer: {
    // **bin/yomi.ts は絶対パスで渡す。** cwd を fixture に向けるので、相対パスだと
    // fixture 側から解決されて Module not found になる。
    command: `bun run ${join(ROOT, "bin", "yomi.ts")} --port ${PORT} --no-open`,
    cwd: join(ROOT, "e2e", "fixtures"),
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  },
});
