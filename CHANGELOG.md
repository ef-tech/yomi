# Changelog

yomi の主要な変更点をこのファイルに記録します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に倣い、
バージョン番号は [Semantic Versioning](https://semver.org/lang/ja/) を採用しています。

設計の出発点は [`docs/design-yomi-20260430.md`](docs/design-yomi-20260430.md)。
設計書は APPROVED 時点の合意記録としてそのまま保持し、その後の追加・変更はこの CHANGELOG で追跡します。

## [Unreleased]

## [0.12.1] - 2026-05-25

大規模な `node_modules` (特に pnpm の `.pnpm` 配下) を含むディレクトリで `yomi` を実行した際に、ファイル監視が `ENOSPC` で失敗してライブリロードが効かなくなる問題を修正しました (Issue #39)。

### Fixed (Issue #39)

- **ファイル監視を chokidar に置き換え**: `src/watcher.ts` の `fs.watch({ recursive: true })` を廃止し chokidar を採用。再帰監視は Linux で除外ディレクトリ (node_modules 等) を含む全サブディレクトリに inotify watch を張り、watch 上限 (`fs.inotify.max_user_watches`) を枯渇させて `ENOSPC` を招いていた。chokidar の `ignored` で `DEFAULT_EXCLUDES` / カスタム excludes を走査・監視の前段で弾くため、node_modules 配下に watch を張らず `ENOSPC` を回避する。ディレクトリの作成・リネーム・削除、エディタのアトミック保存 (swap+rename) も chokidar 側が一貫して扱う。
- **`ENOSPC` を分かりやすいメッセージで案内**: watch 上限に達した場合、ディスク容量不足ではなく inotify watch 上限の枯渇である旨と `sudo sysctl fs.inotify.max_user_watches=524288` による回避策を 1 度だけ警告する。それ以外の watcher エラーは従来どおりログ出力。
- **`close()` を終端化**: 停止後にデバウンス済みコールバックが `onChange` を発火しないよう `closed` ガードを追加。

### Dependencies

- **`chokidar` を追加** (^5.0.0)。クロスプラットフォームのファイル監視を実績ある実装に委譲し、除外ディレクトリの非監視・rename・アトミック保存を一貫して扱う。

### Tests

- `tests/watcher.test.ts`: ネスト (深い階層含む) の変更検知、新規ディレクトリと中身がほぼ同時に出現するケース (git checkout / 展開) の取りこぼし防止、ディレクトリ rename で旧パスの幻イベントが出ないこと、ディレクトリ削除後の再作成検知を追加。

### Docs

- `README.md`: トラブルシューティング節に inotify watch 上限の引き上げ手順を追記。

## [0.12.0] - 2026-05-22

md 内 `[X](foo.pdf)` のような **PDF リンクが新しいタブで開く** ようになりました (Issue #37)。これまでは「ファイルが見つかりません」エラーになっていたものが、ブラウザ内蔵の PDF ビューアで閲覧できます。

### Added (Issue #37)

- **PDF を `/api/asset` 経由で配信**: `src/util/asset-ext.ts` に `ASSET_CONTENT_TYPES = { ...IMAGE_CONTENT_TYPES, ".pdf": "application/pdf" }` を新設し、server の asset エンドポイント入口バリデーションを `isAssetExtension` に置き換え。Content-Disposition は `inline` のまま (ブラウザ内蔵 PDF ビューア → 保存も可能)。
- **renderer 側で `<a href="foo.pdf">` を `/api/asset?path=...` + `target="_blank" rel="noopener noreferrer"` に rewrite**: src/renderer.ts の link renderer で相対 PDF リンクを書き換える。これにより左クリックだけでなく **中クリック / Ctrl-Cmd-クリック / 右クリック「リンクを新しいタブで開く」/「リンクアドレスをコピー」もブラウザネイティブに動作**する。`[Report](foo.pdf#page=3)` のような Chrome PDF ビューアの page jump hash も保持。
- **クライアント側のクリック判定を単純化**: `a.target === "_blank"` であれば renderer 出力 (画像 wrap / PDF rewrite) として一様にブラウザに任せる。`navigateInternal` の PDF 分岐は撤去。

### Changed

- **`/api/asset` の入口判定が画像専用 → asset 全般 (画像 + PDF)**: 既存の TOCTOU 対策 / 強 ETag / 50MB 上限 / Content-Disposition: inline / X-Content-Type-Options: nosniff はそのまま PDF にも適用される (defense-in-depth)。
- **`isAssetExtension` / `assetContentType` を `Object.hasOwn` 判定に変更**: `in` 演算子が `Object.prototype` 継承キー (`.toString` / `.__proto__` 等) でフィルタを通過する経路を塞ぐ (defense-in-depth)。
- **`encodePathForUrl` を `public/link-resolver.js` に統合**: server-side renderer.ts と client-side app.js の重複を解消し、URL エンコーディングポリシーの drift を防ぐ。
- **エラーメッセージ**: 「画像ファイル以外は読み取れません」→「対応していない拡張子です」、「画像サイズが大きすぎます」→「ファイルサイズが大きすぎます」。

### Tests

- `tests/util/asset-ext.test.ts`: PDF / 大文字拡張子 / 末尾ドット / プロトタイプ汚染 (`.toString` 等) の edge case をカバー。
- `tests/server.test.ts`: PDF が application/pdf + inline で配信されること、PDF が path traversal で 400、PDF が MAX_ASSET_BYTES 超で 413 + 統一エラー文言を検証。
- `tests/renderer.test.ts`: `rewritePdfLinkHref` の unit テスト + renderMarkdown が `<a target="_blank" href="/api/asset?path=...">` を出力すること、md / 外部 URL リンクは rewrite しないこと、hash (#page=N) 保持を検証。

## [0.11.1] - 2026-05-20

PR #20 (v0.7.0) の maintainability specialist が指摘した重複統合 + helper 切り出しを follow-up (Issue #23)。動作変更なし、internal refactor のみ。

### Changed (Issue #23)

- **Content-Type マッピングの single source of truth 化**: `src/server.ts` の `ASSET_TYPES` から `.svg` / `.png` / `.ico` の重複を排除し、`src/util/image-ext.ts` の `IMAGE_CONTENT_TYPES` (全 9 拡張子) を spread で取り込むよう変更。これにより `.jpg` / `.jpeg` / `.gif` / `.webp` / `.avif` / `.bmp` も自動的に `/public/` 配下から正しい MIME で配信される。
- **`computeStrongEtag(buffer)` helper を `src/util/etag.ts` に切り出し**: handleAssetRead 内で inline 計算していた sha256 prefix 強 ETag を共通化。unit テスト 5 ケース追加で決定性 / 内容差分 / 入力型 (Uint8Array/Buffer/ArrayBuffer) を担保。
- **`?? "application/octet-stream"` フォールバックに safety net コメント追加**: handleAssetRead は前段で `isImageExtension` を gate するため事実上到達不能だが、型安全のため残してあることを明示。

## [0.11.0] - 2026-05-20

並列モードでソースとプレビューのスクロール位置が**見出し基準で左右同期**するようになりました (Issue #9)。長文 md でも「プレビューで見ている場所がソースのどこか」が見失われません。

### Added (Issue #9)

- **並列モードのスクロール同期**: source 側 `<pre id="source">` と preview 側を相互に追従。
  - 見出しベース: `<h1>` 〜 `<h6>` に `data-line` 属性 (source 上の絶対行番号) を埋め、source の行ベース Y 座標と preview の `offsetTop` を線形補間
  - 純関数 `mapScrollTop` / `findHeadingLines` を `public/scroll-sync.js` に切り出し、unit テストでカバー
  - ループ防止: `scrollSyncing` フラグ + `requestAnimationFrame` で 1 フレーム後にクリア
  - 編集モード時は自動 OFF (textarea のキャレット位置を乱さないため)、出ると `rebuildScrollSyncPairs()` で復活
  - 見出し 0 個の md では pair が作れないので独立スクロール
  - Mermaid async 描画完了後に pair を再構築 (描画前後で `offsetTop` が変わるため)
  - 設定は `localStorage` (`yomi:scrollSync:v1`、デフォルト ON) に保存

## [0.10.1] - 2026-05-20

`/api/asset` 画像配信エンドポイントの defense-in-depth 強化 (Issue #22)。PR #20 (v0.7.0) の adversarial review で見つかった MEDIUM / LOW 指摘をまとめて follow-up。

### Security (Issue #22)

- **`/api/asset` の TOCTOU 対策**: `stat → Bun.file()` の間で symlink がすり替えられる経路を塞ぐため、ファイル取得を `fs.open` で取得した fd 経由に変更。`fstat` → `readFile` を同一 fd で行うので、resolveSafe 後にディスク上の inode が swap されてもサーバが意図しないファイルを返さない。
- **画像 / リンクのスキーム制限を allowlist 化**: 旧 `isExternalUrl` は RFC 3986 全スキーム (`ftp:` / `sms:` / `vbscript:` / `file:` / `chrome-extension:` 等) を一律 true にしていた。
  - リンクは `https / http / mailto / tel` のみを「外部リンク」と認識し、`javascript:` / `vbscript:` / `file:` / `chrome-extension:` / `intent:` / `view-source:` / `wyciwyg:` / `jar:` / `data:` は新規 `isUnsafeScheme` で明示拒否してエラー表示。
  - 画像 src は `http(s)://` と `data:image/(png|jpeg|jpg|gif|webp|avif|bmp|svg+xml|x-icon);base64,...` 形式の data URI のみ許可 (新規 `isSafeImageHref`)。それ以外の scheme は空 href に書き換えて拒否。
- **ETag を内容ベース (sha256) に変更**: 旧 `W/"mtime-size"` 弱 ETag は `cp -a` 等で mtime + size を維持して内容を書き換えると stale 304 を返していた。現在は読み込んだ内容の sha256 先頭 16 byte (32 hex 文字) を強 ETag (`"<hex>"`) として返すので、内容変更を確実に検出できる。
- **405 レスポンスに `Allow` ヘッダ追加**: `/api/file` には `Allow: GET, POST`、`/api/asset` には `Allow: GET, HEAD` を付加 (RFC 9110 §15.5.6 準拠)。

## [0.10.0] - 2026-05-20

プレビュー内の画像をクリックしたら、その画像 URL を新しいタブで開けるようになりました。md ドキュメントから画像の詳細をブラウザネイティブのズーム / パン / 保存で確認できます。

### Added (Issue #32)

- **プレビュー内画像クリックで新しいタブに表示**: markdown 由来の `<img>` を `<a target="_blank" rel="noopener noreferrer">` で wrap し、クリックで画像 URL を新タブで開く。ブラウザネイティブのズーム / パン / 保存をそのまま使える。hover で `cursor: zoom-in` を表示。
  - `[![](img)](url)` のようにリンクで囲まれた画像は markdown の意図を尊重してリンク先が優先（二重 wrap しない）
  - `javascript:` で空 href になった画像は wrap せず、誤クリックで何も起きないようにしている
  - Mermaid 図 / raw HTML の `<img>` は対象外

### Fixed

- **プレビュー内画像クリックが「ファイルが見つかりません」エラーになる問題** (QA で発見): `wireLinkNavigation` が preview pane の全 `<a>` クリックを横取りしていたため、Issue #32 の image-wrap `<a target="_blank">` が新タブを開けなかった。`target="_blank"` + 単一 `<img>` child の wrap はブラウザネイティブの新タブ動作に任せるよう bypass を追加。

## [0.9.0] - 2026-05-14

スマホ UI を抜本リファクタ。topbar に詰まっていた **9 要素を 3 要素 + FAB に削減**して、読む体験を最優先に整理。PC レイアウト (≥1024px) は完全現状維持。

### Added (Issue #30)

- **⋮ Overflow menu (スマホ < 768px)**: テーマ / 表示モード / 編集モードを一つの popover に集約。topbar から個別ボタンを撤去。
  - 外クリック / Esc / scroll で自動 close
  - 既存 PC 用 theme-toggle / view-toggle と aria-pressed が同期
- **📖 FAB 目次 (スマホ < 768px)**: 右下 floating button から目次フルスクリーン modal を起動。長文 md でスクロールしても親指で届く。
- **Sticky topbar 自動 hide/show (スマホ < 768px)**: 下スクロールで topbar が一時非表示、上スクロールで再表示、最上端では常に表示。preview / source 両方のスクロールに反応。
- **端スワイプで drawer 開閉 (スマホ < 768px)**: 画面左端 24px 以内から右へスワイプで sidebar を開く、drawer 内で左へスワイプで閉じる。`prefers-reduced-motion` 配慮。
- **パス自体タップでコピー**: 📋 ボタンを廃止し、`#current-path` を `<button>` 化。タップで `state.currentPath` をコピー (HTTP / HTTPS 両対応の `copyTextToClipboard` 経由)。フィードバックは緑系の背景 1.5 秒。

### Changed

- `setStatus()` がスマホ表示時に **toast 化** (`.is-toast` クラス + 3 秒 fade)。常時表示の status バーが画面を圧迫しなくなる。
- `applyThemeMode` / `applyViewMode` が overflow menu 内のボタンも同時に aria-pressed 同期。
- `enterEditMode` / `exitEditMode` が overflow menu の編集ボタン text/aria-pressed と FAB disabled も同期。

### Removed (スマホ < 768px のみ)

- yomi ロゴ (brand) の表示
- topbar 上のテーマ切替 (3 ボタン) と 📖 目次ボタンの常時表示
- content-header 上の 📋 コピーボタン (パス自体に統合)
- content-header 上の 編集 / プレビュー・並列・MD ボタン (overflow menu に集約)
- dirty indicator (●) の常時表示 (`confirmLeaveEdit` 等の警告は健在)
- 常時 status テキスト (toast 化)

### スマホ要素数 Before vs After

| 領域 | Before (v0.8.1) | After (v0.9.0) |
|---|---|---|
| topbar 常時表示 | 9 (折り返し) | **3** (☰ / パス / ⋮) |
| 全画面合計 | 13 | **4** (drawer / overflow は折りたたみ時 0) |

## [0.8.1] - 2026-05-14

v0.8.0 のブラウザ QA で見つかった 2 件のバグ修正。

### Fixed

- **`Uncaught ReferenceError: Cannot access 'MOBILE_QUERY' before initialization`**: `wireSidebar()` 呼び出し時点で `const MOBILE_QUERY` が temporal dead zone にあり初期化前に参照していた問題。`MOBILE_QUERY` 宣言をファイル早期に移動して解消。
- **LAN 越し HTTP アクセス時にパスコピーボタンが動かない問題**: `navigator.clipboard.writeText` は Secure Context (HTTPS / localhost) のみで公開されるため、`http://192.168.0.100:3944` のような LAN 越しアクセスでは undefined になっていた。`copyTextToClipboard()` ヘルパーで Secure Context の場合は modern API、それ以外は非表示 textarea + `document.execCommand("copy")` のフォールバックに切り替えるよう変更。これで実機 (iPhone / Android) からの LAN 越しアクセスでもコピーボタンが動作するようになる。

## [0.8.0] - 2026-05-14

スマホ / タブレットでも実用的に使えるレスポンシブ対応を追加。プレビュー XSS の同オリジン script 実行リスクを DOMPurify で塞ぐ。右ペインのファイルパスをワンクリックでコピー可能に。

### Added

- **レスポンシブ対応 (Issue #25)**: スマホ・タブレットでも見やすい UI に。
  - **ブレイクポイント**: `≥ 1024px` デスクトップ (現行 2 ペイン固定) / `768〜1023px` タブレット (sidebar 幅縮小) / `< 768px` スマホ (1 ペイン + sidebar overlay drawer)
  - **ハンバーガーボタン** (`☰`) を topbar に追加。タップで sidebar を overlay 表示、backdrop タップ / `Esc` / ファイル選択で自動 close
  - **タップターゲット 44×44px 以上**: edit / discard / view-toggle / theme / TOC / copy / menu の全ボタンと tree-item を拡大
  - **スマホでは split モードを非表示**: 狭くて使いにくいため `display: none` + `[data-mode="split"]` でも preview のみ表示
  - **iOS Safari 自動ズーム回避**: editor の `font-size: 16px` を保証
  - **TOC フルスクリーン modal**: スマホでは floating panel → 全画面 modal
  - **テーブル・コードブロック横スクロール**: `overflow-x: auto` で長い表 / コードもはみ出さない
  - **タスクリストのタップ拡大**: スマホで `transform: scale(1.3)`
  - **`prefers-reduced-motion`** 配慮で sidebar transition を 0 に
- **パスコピーボタン (Issue #24)**: 右ペインヘッダーのファイルパス右隣に 📋 ボタンを追加。クリックで `state.currentPath` (root 起点の相対パス) を `navigator.clipboard.writeText` でコピー。成功時は 1.5 秒間アイコンが ✓ に切り替わり、status バーに通知。ファイル未選択時は disabled。

### Security

- **raw HTML / SVG-XSS 対策 (Issue #21)**: プレビュー preview への innerHTML 書き換え前に [DOMPurify](https://github.com/cure53/DOMPurify) (CDN ESM, v3) で sanitize するように変更。
  - `<script>` / `<object>` / `<iframe>` / `<embed>` 系を除去
  - inline event handler (`onerror` / `onload` / `onclick` 等) を除去
  - `<a href="javascript:...">` / `<a href="vbscript:...">` / `<svg>` 内の `<script>` を除去
  - `<pre class="mermaid">` や GFM タスクリスト `<input type="checkbox">` は保持
  - Mermaid 描画後の SVG は DOMPurify を通らないが、Mermaid 自身の `securityLevel: "strict"` に委任
  - 対策箇所: `applyFile` / `saveEdit` / `takeServerVersion` で `state.currentHtml` 格納時に sanitize 済み

## [0.7.0] - 2026-05-13

プレビュー内の画像 (相対パス) が表示できるようになる。md の隣に置いた `screenshot.png` や `../images/logo.svg` のような参照が、これまで 404 だったのが正しく表示される。

### Added

- **プレビュー内画像配信 (Issue #19)**: Markdown の `![](foo.png)` の相対 src を、新エンドポイント `GET /api/asset?path=...` 経由で配信。
  - 対応拡張子: `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` / `.svg` / `.avif` / `.bmp` / `.ico`
  - `resolveSafe` で path traversal を遮断（絶対パス・`..`・root 外は 400）
  - 画像以外の拡張子は 400
  - SVG は `X-Content-Type-Options: nosniff` + `Content-Disposition: inline` で MIME sniff 経由の XSS を抑制
  - サイズ上限 50 MB を超える画像は 413
  - 弱 ETag (`W/"mtime-size"`) + `Cache-Control: no-cache` で `If-None-Match` 304 をサポート（編集後の即時更新と再フェッチ抑制の両立）
- **renderer の image トークン書き換え**: 外部 URL (`http(s)://`, `data:`) はそのまま、`javascript:` は空 src に、相対パスは `currentPath` のディレクトリから解決して `/api/asset?path=...` に変換

### Internal

- `src/util/image-ext.ts` (新規): 画像拡張子ホワイトリストと Content-Type マッピング
- `src/renderer.ts`: `renderMarkdown(source, options?: { currentPath?: string })` にシグネチャ拡張、`public/link-resolver.js` の `resolveRelativePath` / `isExternalUrl` / `isJavascriptUrl` を再利用
- `src/server.ts`: `handleFileRead` / `handleFileWrite` (競合時の HTML 再生成含む) で `renderMarkdown` に `currentPath` を渡す

### Tests

- `tests/util/image-ext.test.ts` (新規, 4 cases): 拡張子判定 / Content-Type
- `tests/renderer.test.ts` (+13 cases): 画像 src の書き換え（同階層 / サブディレクトリ / `../` / 絶対 path / 外部 URL / data: / javascript: / 非画像 / URL エンコード / title 属性 / 日本語ファイル名 / クエリ・フラグメント仕様）と `rewriteImageHref` 単体
- `tests/server.test.ts` (+16 cases): `/api/asset` の Content-Type / ETag / 304 / HEAD / SVG / 拡張子拒否 / path 未指定 / `..` / 絶対 path / 404 / 405 / If-None-Match 不一致 / ディレクトリ 400 / ETag 更新 / symlink / サイズ上限、`/api/file` の HTML 内 src 書き換え
- `tests/safepath.test.ts` (+1 case): NUL byte 入り path の reject

### Security

- `resolveSafe` で path に NUL byte が含まれる場合を早期 reject（内部例外文字列の 500 漏洩を防止）
- `/api/asset` の ETag 計算で `mtimeMs` が NaN になる環境（一部 NFS / Docker）でも ETag が衝突しないよう `Number.isFinite` でガード

## [0.6.0] - 2026-05-13

プレビュー内の GFM タスクリストを編集モードに入らずクリックで ON/OFF できるようになる。チェック状態は md ファイルに書き戻されるので、TODO リストや手順書を「読みながら進捗管理」できる。

### Added

- **インタラクティブ タスクリスト (Issue #17)**: プレビュー内の `<input type="checkbox">` をクリック可能にし、対応する md ソース行の `- [ ]` ⇄ `- [x]` を反転して `POST /api/file` で保存。
  - 既存の楽観的ロック (`baseSha`) を流用、競合は既存バナーで通知
  - インデント済みネスト タスク、`*` / `+` の bullet マーカーと **ordered list** (`1. [ ]` / `2) [ ]`)、大文字 `[X]` にも対応
  - **CRLF 改行 (Windows / 一部エディタ保存)** でも正しくトグルできる（regex で `\r` を保持）
  - code fence (```、~~~) 内のタスク風文字列は無視
  - 編集モード中はクリック不可（編集モード優先）
  - 連続クリック中は disabled で再入防止
  - 保存後は `applyFile` 経由で TOC / source / preview / Mermaid を一括更新（タスク変更で見出しが変化したケースでも TOC が古くならない）

### Internal

- `public/task-list.js` (新規): `toggleTaskInMarkdown(body, index)` と `countTasksInMarkdown(body)` の純関数モジュール
- `public/task-list.d.ts` (新規): TypeScript 用型情報
- `public/app.js` に `wireTaskCheckboxes` / `onTaskCheckboxToggle` を追加、`applyFile` / `enterEditMode` / `exitEditMode` から呼ぶ
- `public/styles.css` でプレビュー内チェックボックスを `cursor: pointer`、`:disabled` 時は `default`

### Tests

- `tests/util/task-list.test.ts` (新規, 25 cases): `toggleTaskInMarkdown` / `countTasksInMarkdown` の境界条件をカバー（ネスト、bullet 違い、ordered list、CRLF 改行、code fence 無視、空文字、非整数 index など）

### Known Limitations

- 4-space インデントされた code block 内（fence なし）の `- [ ]` は marked が input を出さない一方、`toggleTaskInMarkdown` の正規表現は拾うため、稀なケースで DOM/md index がズレる可能性あり（実装は将来 Issue で対応）
- blockquote 内 (`> - [ ]`) のタスクは marked が input を出すが、現状の正規表現は `>` を許容していないので index ズレが起きる可能性あり（将来 Issue で対応）
- 高速な連続クリック（複数チェックボックスを並行で叩く）で 2 番目以降が 409 conflict になる場合がある（baseSha 楽観的ロックの仕様）

## [0.5.1] - 2026-05-13

URL `?path=foo.md#見出し` 形式の deep-link でスクロール復元するようになる。リンクを共有すれば相手の画面で同じ見出しが見える。

### Fixed

- **アンカー deep-link が効かない問題 (Issue #15)**: v0.5.0 で URL クエリ `?path=foo.md` を導入したとき、`#見出し` 部分が捨てられスクロールしない問題を修正。
  - URL `?path=foo.md#見出し` を直接開くと該当見出しまでスクロールする
  - プレビュー内リンク `[X](other.md#見出し)` クリックでも遷移先ファイルの見出しまでスクロール
  - ブラウザの戻る / 進むでもスクロール位置を含めて復元（`history.state` に hash を保存）
  - 編集モード中は scroll を skip（URL の hash は維持）

### Added

- `splitHrefHash(href)` 純関数を `public/link-resolver.js` に追加: href を `{ path, hash }` に分解。URL エンコードされた日本語見出しも `decodeURIComponent` で復号、さらに NFC 正規化で `getElementById` のミスマッチを防ぐ
- `getHashFromUrl(location)` と `buildUrl(path, hash)` を `public/navigation.js` に追加: URL の hash 部分を安全に取得・構築（取得時に NFC 正規化）
- `scrollIntoHash(hash)` を `public/app.js` に追加: `requestAnimationFrame` 経由で `document.getElementById(hash).scrollIntoView({ behavior: "auto", block: "start" })`（ファイル切替直後は instant スクロールで違和感を回避）

### Tests

- `tests/util/link-resolver.test.ts`: `splitHrefHash` の境界テスト 10 ケース追加（NFC 正規化と空文字含む、合計 38 cases）
- `tests/util/navigation.test.ts`: `buildUrl(path, hash)` / `getHashFromUrl` の境界テスト 5 ケース追加（NFD 入力の NFC 復号含む、合計 18 cases）

### Known Limitations

- Mermaid 図ありの md では描画完了前に scrollIntoView するため、位置がズレる可能性あり（将来 Issue で対応）
- TOC クリック時の URL 同期、`IntersectionObserver` スクロールでの URL 更新は別 Issue として扱う
- `navigateTo` 進行中に popstate が同期発火するレース、対象 ID 要素が見つからないケースの通知などは別 Issue で対応予定

## [0.5.0] - 2026-05-12

ブラウザの戻る / 進むがプレビュー内リンクと左ツリー選択にちゃんと効くようになる。URL `?path=foo.md` で「いま読んでるファイル」が表現されるようになり、リロードで復元、URL コピペで再現できる。

### Added

- **ブラウザ履歴対応 (Issue #13)**: `history.pushState` で「ユーザー操作によるファイル切替」を履歴に積み、`popstate` で戻る / 進むに対応。
  - プレビュー内リンク (`navigateInternal`) と左ツリー選択がどちらも履歴に積まれる
  - 初期化 (`init`) は `replaceState` で履歴を増やさず、URL を整える
  - ライブリロード (`handleLiveEvent` の `changed`) は履歴を積まない (`loadFile + applyFile` 直呼び)
  - アンカーリンク (`#見出し`) は既存挙動を維持、履歴に積まない
- **URL クエリ `?path=foo.md` で現在ファイルを表現**: リロード復元 / URL コピペで同じ画面の再現 / ブックマーク可能
- **編集モード中の戻る/進む確認**: `popstate` 時に未保存変更があれば既存の `confirmLeaveEdit` で確認。Cancel すると `history.go(delta)` で編集中エントリへジャンプし戻る (re-push しないため forward 履歴を壊さない)

### Changed

- `prefs.currentPath` (localStorage `yomi:currentPath:v1`) を廃止: 現在ファイルは URL を single source of truth とする。旧 key は次回読まれないため自然消滅 (ブラウザの localStorage に値が残るのみで実害なし)
- `chooseInitialFile` は `getPathFromUrl()` 優先に変更: URL に `?path=...` があり実在すればそれを開き、なければ tree の先頭ファイル
- `selectFile` を撤廃: 全ナビゲーション起点は `navigateTo(path, { history: "push" | "replace" | "none" })` に統一

### Internal

- `public/navigation.js` (新規): `getPathFromUrl` / `buildUrl` / `nextNavIndex` / `currentNavIndex` / `seedNavCounter` の純関数モジュール
- `public/navigation.d.ts` (新規): TypeScript 用型情報
- `popstate` キャンセル時の `pendingCancelRestore` フラグに `setTimeout` フォールバックを追加：`history.go` が popstate を発火させなかった場合でも次の tick でフラグを解除し、後続の戻る/進むを取りこぼさない
- `selectFile` を `loadFile(path)` (fetch のみ) と `applyFile(data)` (state / DOM 反映) に責務分離
- `wireHistoryNavigation`: `popstate` リスナを 1 箇所に集約。`pendingCancelRestore` フラグで自前 `history.go` の popstate を 1 回飲んで二重 confirm を防ぐ
- `seedNavCounter(history.state?.navIndex)` を `init()` 冒頭で呼び、リロード時の navIndex を復元（forward 履歴に残る古い entry との衝突回避）

### Tests

- `tests/util/navigation.test.ts` (新規, 13 cases): `getPathFromUrl` / `buildUrl` / navCounter API の境界条件をカバー

## [0.4.0] - 2026-05-12

プレビュー内のリンクが「ちゃんと使える」ようになる。md 内に書いた相対リンクで yomi 内をジャンプできて、外部 URL は警告つきで安全に開ける。`javascript:` リンクは無条件ブロックで信頼できない md の読み込みも安全に。

### Added

- **プレビュー内リンク遷移 (Issue #11)**: プレビューの `<a>` リンクをクリックした際の挙動を整備。
  - 相対 md パス (`[X](other.md)` / `[Y](../bar.md)` / `[Z](sub/foo.md)`) は yomi 内で遷移 (404 にならない)
  - 拡張子なしリンク (`[X](foo)`) は `foo.md` → `.markdown` → `.mdx` の順に fallback
  - 外部 URL (`http(s)://`, `mailto:`, `tel:` 等) は inline 警告バナー → 「閉じる」/「開く」(`window.open` with `noopener,noreferrer`)
  - 警告バナーは Esc キーで閉じる。デフォルトフォーカスは「閉じる」 (誤発火防止)
  - `javascript:` スキームは難読化対策込み (`/^\s*javascript\s*:/i`) で **無条件ブロック**
  - 編集モード中の内部リンクは `confirmLeaveEdit` で未保存変更を確認してから遷移
  - アンカーリンク (`#fragment`) は既存の見出しジャンプ動作を維持

### Internal

- `public/link-resolver.js` (新規): `slugify` パターンと同じく純関数モジュール。`resolveRelativePath` / `isExternalUrl` / `isJavascriptUrl` / `isAnchor` を提供
- `public/link-resolver.d.ts` (新規): TypeScript 用型情報。bun test から型安全に import 可能

### Tests

- `tests/util/link-resolver.test.ts` (新規, 28 cases): 純関数 4 つの境界条件を完全カバー (英数字 / 日本語 / 記号 / URL エンコード / フラグメント / クエリ / 絶対パス / null fallback)

## [0.3.0] - 2026-05-12

長文 Markdown の読みやすさを底上げする目次 (TOC) パネルを追加。見出しからジャンプでき、スクロールに合わせて現在地もハイライトされるので、CHANGELOG / PR レビュー / 技術メモのような長い md でも「今どこ」を見失わない。

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
