import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * E2E で使うポート。
 *
 * **Linux の ephemeral port range (32768-60999) を避ける。** その範囲だと他プロセスの
 * outbound 接続が先に掴むことがあり、`--port` 明示時の yomi は空きポート探索へ
 * フォールバックしない (`bin/yomi.ts` の `runUp`) ため `Bun.serve` が throw して
 * webServer の起動ごと失敗する。`retries: 0` なので一発で赤になる。
 */
const PORT = process.env.YOMI_E2E_PORT ?? "3950";

/**
 * yomi に見せるドキュメントディレクトリ。
 *
 * **追跡下の `e2e/fixtures/` を直接見せない。** yomi は書き込み API を持つので
 * (`POST /api/file` / `/api/file/create`)、編集・新規作成のフロー (#82) を書いた瞬間に
 * E2E が git のワークツリーを書き換える。失敗して途中終了すると fixture が壊れたまま残り、
 * **次の実行が「fixture が違う」で落ちて flaky に見える**。
 *
 * そこで毎回 tmp へコピーして、そちらを見せる。追跡下のファイルは read-only な原本になる。
 */
const FIXTURE_SRC = join(ROOT, "e2e", "fixtures");
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "yomi-e2e-"));
cpSync(FIXTURE_SRC, FIXTURE_DIR, { recursive: true });
process.on("exit", () => rmSync(FIXTURE_DIR, { recursive: true, force: true }));

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
 * - **`locale` を固定する。** Chromium はホストの locale を継承するため、指定しないと
 *   ローカル (ja) と CI (en) で yomi の UI 言語が変わる (`i18n.js` の `resolveLang` が
 *   `navigator.language` を見る)。**UI ラベルでロケータを書くならこの locale が前提**になる
 */
export default defineConfig({
  testDir: "./e2e",
  /**
   * **`*.e2e.ts` を使う。** bun のランナーは `.test` / `_test_` / `.spec` / `_spec_` を
   * 拾うので、`.spec.ts` だと素の `bun test` が Playwright のテストを実行しようとして落ちる。
   * 命名で排他にすれば、bun 側の探索範囲を狭める設定（＝将来テストが黙ってスキップされる罠）が要らない。
   */
  testMatch: /.*\.e2e\.ts/,

  // 落ちたら直す。再実行で隠さない (Issue #45)
  retries: 0,
  workers: 1,
  // CI で `test.only` の付け忘れを検出する (一部しか走っていないのに green になるのを防ぐ)
  forbidOnly: !!process.env.CI,

  // vendor bundle (mermaid 3.5MB) の parse を待つので、2-core runner でも足りる幅を取る。
  // リトライ予算を増やすだけで、固定 sleep の導入ではない。
  expect: { timeout: 10_000 },

  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // ホスト環境に依存させない (上の「flaky を持ち込まない方針」を参照)
    locale: "en-US",
    timezoneId: "UTC",
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
   * `--no-open` は必須 (CI にブラウザを開かせない)。
   *
   * **`reuseExistingServer` は使わない。** Playwright は「URL が応答するか」しか見ないので、
   * そのポートで別ディレクトリの yomi が動いていると黙ってそれを掴み、`#current-path` の
   * アサートが意味不明に落ちる (原因に辿り着くのに時間がかかる)。毎回新しく起動する。
   */
  webServer: {
    // **パスはクォートする** (チェックアウト先にスペースが含まれても壊れないように)。
    // `cwd` を fixture に向けるので、`bin/yomi.ts` は絶対パスで渡す。
    command: `bun run "${join(ROOT, "bin", "yomi.ts")}" --port ${PORT} --no-open`,
    cwd: FIXTURE_DIR,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  },
});
