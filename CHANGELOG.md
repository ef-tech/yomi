# Changelog

yomi の主要な変更点をこのファイルに記録します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に倣い、
バージョン番号は [Semantic Versioning](https://semver.org/lang/ja/) を採用しています。

設計の出発点は [`docs/design-yomi-20260430.md`](docs/design-yomi-20260430.md)。
設計書は APPROVED 時点の合意記録としてそのまま保持し、その後の追加・変更はこの CHANGELOG で追跡します。

## [Unreleased]

### Added

- **目次 (TOC) 機能 (Issue #8)**: トップバーの「📖 目次」ボタン (または `Ctrl/Cmd+Shift+O`) でフローティングパネルを開閉。Markdown の見出しから階層構造の目次を生成し、`IntersectionObserver` でスクロールに合わせて現在地をハイライト。デフォルトは H1-H3 表示、「▾ H4- 展開」で H1-H6 全表示に切替可。パネル開閉状態と階層レベルは `localStorage` に永続化。
  - エントリクリックで該当見出しへスムーズスクロール
  - 編集モード中は TOC を一時非表示にし、終了時に元の状態へ復元
  - `MD` モード時にボタンを押すと一時的に `プレビュー` 切替 (TOC を閉じると元のモードへ戻る、`localStorage` は変更しない)
  - 見出し 0 個のドキュメントでは「目次がありません」を表示

### Changed

- `renderMarkdown` が見出しに `id` 属性を自動付与するようになった (`<h2 id="使い方">`)。slug 生成は英数字小文字化 + 日本語保持 + 記号除去。同名見出しの衝突は `-1`, `-2` サフィックスで回避。`renderMarkdown` は呼び出しごとに新規 Marked インスタンスを生成し、ドキュメント間で id 採番が独立する。

### Internal

- `src/util/slugify.ts` (新規): `slugify()` + `uniqueSlug()` の純関数
- `public/toc.js` (新規): `buildTocTree(headings, maxLevel)` の純関数 (ブラウザから直接 import)

### Tests

- `tests/util/slugify.test.ts` (新規, 15 cases)
- `tests/toc.test.ts` (新規, 8 cases — `public/toc.js` を import)
- `tests/renderer.test.ts` (+4 cases): heading id 付与、日本語 id、重複サフィックス、複数文書間の独立採番

## [0.2.0] - 2026-05-08

ブラウザ内での Markdown 編集に対応。これまで読み取り専用だった yomi が、軽い文言修正なら yomi 単体で完結するようになる。

### Added

- **ブラウザ内 Markdown 編集 (Issue #5)**: 右ペインの「編集」ボタンで `<textarea>` に切り替わり、Ctrl/Cmd+S または「保存して閉じる」で保存できる。「破棄」ボタンで未保存の変更を捨てて終了。未保存状態のトップバー表示 + タブ閉じ警告つき。
- **同時編集 (Lost Update) 検知**: 編集中に他プロセスが同じファイルを書き換えた場合、保存時に競合バナー (「サーバ内容を取り込む / 強制上書き / 閉じる」3 択) を表示。
- **CSRF 防御**: 書き込みエンドポイントは `Origin` ヘッダを検証し、yomi 自身と同じオリジン以外からの POST を 403 で拒否。LAN 越しの正規利用 (例: Ubuntu 起動 + Mac 編集) は許可される。

### Changed

- `GET /api/file` のレスポンスに `sha` (sha256) を含めるようになった。クライアント側は次の保存時にこれを `baseSha` として送信し、サーバが現状ファイルと比較して 409 を返せるようにする。

### Internal

- 新エンドポイント `POST /api/file` (body 上限 10MB、`.md` / `.markdown` / `.mdx` のみ受理、`resolveSafe` で path 検証)
- 新モジュール `src/save-mark.ts` (LRU 64 entries, content-hash ベース) と watcher 統合: 自分で書き込んだ直後の sha を記録し、watcher イベントの sha と一致するものは publish スキップ。これにより保存→ライブリロードのフィードバックループを防ぐ。
- `Ctrl/Cmd+S` のキーボードハンドラを capture phase + `ev.code === "KeyS"` 判定に補強 (IME / Caps Lock / ブラウザ拡張機能の干渉に対する頑健化)。

### Tests

- `tests/save-mark.test.ts` (新規, 11 cases)
- `tests/watcher.test.ts` (新規, 5 cases)
- `tests/server.test.ts` (新規): GET /api/file の sha 返却、POST /api/file の Origin / safepath / 拡張子 / body サイズ / baseSha 検証 / 405

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
