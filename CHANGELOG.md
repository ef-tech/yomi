# Changelog

yomi の主要な変更点をこのファイルに記録します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に倣い、
バージョン番号は [Semantic Versioning](https://semver.org/lang/ja/) を採用しています。

設計の出発点は [`docs/design-yomi-20260430.md`](docs/design-yomi-20260430.md)。
設計書は APPROVED 時点の合意記録としてそのまま保持し、その後の追加・変更はこの CHANGELOG で追跡します。

## [Unreleased]

### Changed

- 編集モードの「完了」ボタンを「**保存して閉じる**」に変更。クリックで未保存があれば自動保存 → 成功で編集モード解除、失敗時はステータス表示 + 編集モード継続。保存を忘れる事故と「Ctrl/Cmd+S を知らないと保存できない」UX 問題を解消。
- 編集モード中に「**破棄**」ボタンを追加。未保存の変更を捨てて編集モードから抜ける明示的な経路を提供。
- `Ctrl/Cmd+S` のキーボードハンドラを capture phase + `ev.code === "KeyS"` 判定に変更。IME / Caps Lock / ブラウザ拡張機能による干渉に強くした。

### Added

- **Markdown 編集機能 (Issue #5)**: 右ペインに「編集」ボタンを追加し、`<textarea>` でその場編集 → `Ctrl/Cmd+S` または「保存して閉じる」で保存できるようにした。
  - `POST /api/file` (新規): body 上限 10MB、`.md` / `.markdown` / `.mdx` のみ受理、`resolveSafe` で path 検証
  - `POST /api/open-editor` (新規): `YOMI_EDITOR` > `EDITOR` > `VISUAL` > `code` の優先順で外部エディタを起動
  - **CSRF 防御**: mutating エンドポイントは `Origin` ヘッダを検証し、サーバ自身と同じオリジン以外からの POST を 403 で拒否
  - **同時編集 (Lost Update) 検知**: `GET /api/file` のレスポンスに sha256 を含め、`POST /api/file` の `baseSha` と現状ファイルが一致しない場合は 409 + 現状内容を返却。クライアントは「サーバ内容を取り込む / 強制上書き / 閉じる」を選択
  - **Watcher フィードバックループ防止**: `src/save-mark.ts` の `SaveMark` (LRU 64 entries, content-hash ベース) で「自分が書き込んだ直後の sha」を記録、watcher イベントの現状 sha と一致するイベントは publish スキップ
  - 未保存状態のトップバー表示と `beforeunload` 警告
  - `Tab` キーで 2 スペース挿入

### Tests

- `tests/save-mark.test.ts` (新規, 11 cases)
- `tests/watcher.test.ts` (新規, 5 cases)
- `tests/open-editor.test.ts` (新規, 13 cases)
- `tests/server.test.ts` (新規, 27 cases): GET /api/file の sha 返却、POST /api/file の Origin / safepath / 拡張子 / body サイズ / baseSha 検証 / 405、POST /api/open-editor の Origin / safepath / 拡張子 / 正常系

## [0.1.0] - 2026-04-30

最初の公式リリース。設計書に沿った機能一式 + 後続の追加機能 (テーマ手動切替、表示モード切替、YAML フロントマター対応、ファイル削除通知、GFM ソフト改行、`.yomiignore` 等) を含む。

### Added — 設計書に沿った初期機能

- `yomi` コマンド (CLI): カレントディレクトリ配下の `.md` を再帰収集
- 2 ペイン UI: 左ファイルツリー + 右プレビュー
- `marked` (GFM) による Markdown レンダリング
- Mermaid フェンスのクライアント側描画 (`mermaid@11` を CDN 経由で ESM import)
- ファイル変更検知 + WebSocket ライブリロード (表示中ファイルなら再フェッチ、追加/削除ならツリー再描画)
- GitHub 風 CSS + `prefers-color-scheme` によるダーク/ライト自動切替
- 空きポート自動探索 (3939 起点)
- ブラウザ自動オープン (macOS=open / Windows=cmd start / Linux=xdg-open)
- パストラバーサル防止 (`..` / 絶対パス / ルート外を拒否)
- CLI オプション: `--port`, `--host`, `--no-open`, `--help`

### Added — 設計書未記載の追加機能

- GFM ソフト改行を有効化 (`marked` の `breaks: true`、1 行改行 → `<br>`)
- YAML フロントマター対応: 先頭の `--- ... ---` を本文から切り離し、メタデータボックスとして整形表示。URL はリンク化、ネストは 1 段階までフラット表示
- 右ペインに表示モード切替を追加: プレビューのみ / 並列 / MD (ソース) のみ。状態は localStorage 永続化
- テーマ手動切替を追加: 自動 (システム追従) / ライト / ダーク。トップバーから切替可、Mermaid テーマも連動。状態は localStorage 永続化
- localStorage に「開いているディレクトリ」と「最後に表示していたファイル」を保存
- 対応拡張子を `.md` / `.markdown` / `.mdx` に拡張 (設計書では `.md` のみ言及)
- デフォルト除外パターンを 8 種から 16 種に拡張: 設計書の `node_modules` `.git` `dist` `build` `.next` `.cache` `coverage` `vendor` に加え、`.svn` `.hg` `.nyc_output` `.bun` `.turbo` `.vercel` `.idea` `.vscode` を追加
- 起動時にローカルと LAN の URL を一覧表示
- 非ループバックバインド時に認証なし警告を表示
- README にアップデート手順・アンインストール手順を追加

### Changed — 設計書からの仕様変更

- **デフォルトバインドアドレス**: 設計書では `127.0.0.1` 固定だったが、利用者要望で `0.0.0.0` をデフォルトに変更。同 LAN の他端末から閲覧可能になる。`--host 127.0.0.1` でループバック専用に戻せる。
  - 影響範囲: 設計書の `Constraints` (L22), `Security Considerations` (L152), `CLI フラグまとめ` (L171) の記述は元の方針のまま残置。実際の挙動は本 CHANGELOG と実装、`yomi --help` で確認できる。
  - セキュリティ補足: 認証機能はないため、信頼できないネットワーク上では `--host 127.0.0.1` を強く推奨。

### Fixed

- プレビューのみモードで `.preview` の `max-width:1024px;margin:0 auto` によりスクロールバーが画面右端ではなく中央寄せボックスの右端に表示されていた問題。`.preview` を全幅維持にし、内容は `padding-inline: max(2.5rem, calc((100% - 1024px) / 2))` で中央寄せに変更

### Implementation notes — 設計書 API からの代替

機能・出力は設計書と等価だが、API・実装手段が異なる項目。

- ファイル監視: 設計書では `Bun.watch` を想定していたが、Bun には該当 API が存在しないため Node 互換の `fs.watch(rootDir, { recursive: true })` を採用。再帰監視と md 拡張子フィルタ・除外パターンを組み合わせて等価な挙動を実現。
- Mermaid renderer: 設計書サンプルは `marked.Renderer()` を直接オーバーライドする旧 API だったが、marked v14 推奨の `new Marked({...}).use({ renderer })` 拡張 API に変更。出力は同一。
- GitHub 風スタイル: `github-markdown-css` パッケージの取込ではなく、`public/styles.css` に手書きで GitHub 風スタイルを実装。表示結果は同等。

### Project structure — 設計書からの構成差分

設計書のモジュール分割に加えて、責務分離・再利用性のため以下を分離した。

- `src/cli.ts` — CLI 引数パース
- `src/port.ts` — 空きポート自動探索
- `src/safepath.ts` — パストラバーサル検証
- `src/network.ts` — LAN IP 列挙、URL 組み立て、ブラウザオープン用 URL 選択
- `src/open-browser.ts` — プラットフォーム別ブラウザ自動オープン
- `src/banner.ts` — 起動時バナー組み立て (リファクタで分離)
- `src/frontmatter.ts` — YAML フロントマター処理 (リファクタで renderer から分離)
- `src/util/path-util.ts` / `markdown-ext.ts` / `excludes.ts` / `html.ts` — 共通ユーティリティ
- `public/prefs.js` — クライアント側 localStorage アクセス (リファクタで分離)

設計書記載のモジュール (`server.ts` / `scanner.ts` / `watcher.ts` / `renderer.ts`) はそのまま実装。

### CI / Templates (post-MVP)

- GitHub Actions ワークフロー `.github/workflows/ci.yml` を追加。push to main / PR で `bun install --frozen-lockfile` → `bun run typecheck` → `bun test` を Linux + macOS の matrix で実行。同一ブランチへの連続 push は古いジョブをキャンセル
- Issue テンプレート 2 種を追加 (YAML form 形式)
  - `bug_report.yml` — 概要 / 再現手順 / 期待・実際 / yomi・Bun のバージョン / OS / 補足
  - `feature_request.yml` — 概要 / 動機 / 提案する解決策 / 代替案 / 補足
  - `config.yml` で blank issue を無効化
- PR テンプレート (`pull_request_template.md`) を追加。タイトル形式の hint、関連 issue 欄、`bun run typecheck` / `bun test` / 手動スモークのチェックリスト
- README に CI / License バッジを追加

### Tests (post-MVP)

`bun test` ベースのユニットテストを 11 ファイルで導入。サーバー側のロジックをカバー（クライアント `app.js` は対象外）。

- `tests/util/{path-util,markdown-ext,excludes,html}.test.ts` — 純関数 4 種
- `tests/cli.test.ts` — `parseArgs` 全分岐 (`--port` の N と N=、範囲外、複合、不明オプション)
- `tests/frontmatter.test.ts` — parse/render の境界条件 (CRLF、ネスト、コメント、URL リンク化、HTML エスケープ)
- `tests/safepath.test.ts` — `mkdtemp` fixtures で `resolveSafe` のセキュリティ確認 (絶対パス・`..`・root 外を全て拒否)
- `tests/scanner.test.ts` — 多階層 fixtures で `scanMarkdownTree` (再帰、除外、空ディレクトリ削除、ソート、POSIX 区切り)
- `tests/network.test.ts` — `isLoopback` / `isWildcard` / `pickBrowserUrl` / `buildAccessibleUrls`
- `tests/renderer.test.ts` — `marked` 統合 (見出し/段落/GFM/Mermaid/フロントマター/テーブル/リンク)
- `tests/banner.test.ts` — `buildStartupBanner` の 3 ケース (loopback / wildcard / 固定 IP)

合計 98 tests / 228 expect 呼び出し。実行時間 ~30ms。

### Refactor (post-MVP)

サーバー側・クライアント側に渡る全体リファクタ。挙動は完全互換、内部構造のみ整理。

- 共通ユーティリティ集約: `toPosix`, `isMarkdownExtension`, `isExcludedPath`, `escapeHtml` を `src/util/` に切り出し、scanner/safepath/watcher/renderer/frontmatter での重複を解消
- `renderer.ts` を marked + Mermaid 専用に縮小 (127→38 行)、フロントマター処理は `frontmatter.ts` に
- `parseArgs` を `--name=value` 正規化 + ヘルパー (`parsePort`, `takeValue`) で簡素化、二重ロジックを解消
- `bin/yomi.ts` の起動ログ整形を `src/banner.ts` に切り出し、`main()` をリニア化
- クライアント `app.js` の `localStorage` アクセスを `public/prefs.js` の prefs オブジェクトに集約
- ツリー DOM 再走査を `state.dirNodes` Map に置換 (`querySelector` 廃止、`cssAttrEscape` 削除)
- テーマ切替時のサーバー再フェッチを廃止し、キャッシュ済み HTML を再描画して Mermaid のみテーマ反映
