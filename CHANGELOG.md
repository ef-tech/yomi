# Changelog

yomi の主要な変更点をこのファイルに記録します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に倣い、
バージョン番号は [Semantic Versioning](https://semver.org/lang/ja/) を採用しています。

設計の出発点は [`docs/design-yomi-20260430.md`](docs/design-yomi-20260430.md)。
設計書は APPROVED 時点の合意記録としてそのまま保持し、その後の追加・変更はこの CHANGELOG で追跡します。

## [Unreleased]

### Added (Issue #140)

- **記事が参照している画像を zip でまとめてダウンロードできるようになった**: 表示中の Markdown の画像を 1 回の操作で保存できる（右上の「画像 zip」ボタン、スマホは ⋮ メニュー）。**元のディレクトリ構成のまま入る**ので、展開して md の隣に置けば相対リンクがそのまま通る。`GET /api/images.zip?path=<md>` として API からも使える
- **入らなかった参照は zip の中の `SKIPPED.txt` に理由つきで残る**: 除外設定の配下・ルート外を指す symlink・実体が無いもの・外部 URL。**1 枚が入らなくても zip 全体は成功する**
- **外部 URL の画像は取得しない**: yomi はサーバから外へ出ていく通信を持たない設計なので、取得を足すと Markdown に書かれた任意の URL へサーバが接続することになる（SSRF）。URL は `SKIPPED.txt` に残す
- **圧縮ライブラリは足していない**: 対象が既に圧縮済みの画像なので無圧縮（store）で十分。実行時依存は `chokidar` と `marked` の 2 つのまま
- **zip に入るのは画像だけ**: `/api/asset` と同じ拡張子の許可リストを、**解決後のパス**にも掛ける。`![](.env%23a.png)` のように「拡張子を検査した文字列」と「実際に開くパス」がずれる書き方でも、画像以外は入らない
- **同時に作るのは 1 本まで**: 重なったリクエストには `Retry-After` つきの 503 を返す（zip はメモリ上で組み立てるため）

### Fixed (Issue #119)

- **保存した内容が、同じフォルダを開いている別の yomi に反映されないことがあったのを修正した**: 保存は一時ファイルを作って差し替える方式（#101）だが、**作成と差し替えが速すぎるとファイル監視が変更に気づかない**。実測では 40 回中 5 回しか届いていなかった。差し替えの直前に 5ms 待つようにして 40/40 になった。**自分の画面はもともと影響を受けない**（自己保存として抑止されるため）
- **原因は chokidar ではなく Bun の `fs.watch` だった**: chokidar を通さずに測ると、間隔なしの差し替えは **Bun で 0/10、Node で 10/10**。監視側の設定（`atomic` / `alwaysStat` / `awaitWriteFinish`）が効かないのは、いずれも**イベントが届いて初めて動く**分岐のため。上流への報告と、直ったら回避策を外す話は #138
- **ファイル監視をポーリングに倒さなかった**: 確実なのは `usePolling` だけ（`fs.watch` を経路から外すため）だが、**アイドル時の CPU が 5,000 ファイルで 7 倍**（10 秒あたり 62ms → 455ms）になり、ファイル数に比例して増える。**保存 1 回あたり 5ms** のほうが安いと判断した。計測は `scripts/probe-watcher-poll-cost.ts` で再現できる
### Fixed (Issue #118)

- **`..cache` のように `..` で始まるだけの通常のエントリ名が読めるようになった**: ルート外への参照かどうかを `..` で始まるかだけで見ていたため、**通常のディレクトリ名やファイル名**が「ルートディレクトリの外を参照しています」で拒否されていた。親をたどる `../` と、単に `..` で始まる名前を区別する。**親ディレクトリ参照と symlink でのルート外への脱出は従来どおり拒否する**（受理範囲を広げる変更なので、拒否側を回帰テストで固定した）
### Fixed (Issue #112)

- **パネルが重なっているときに `Esc` 1 回で 2 つ閉じることがなくなった**: クイックオープンと競合の差分ダイアログが独立に `Esc` を処理していたため、両方開いていると 1 回で両方閉じていた（`stopPropagation()` は**同じ要素に付いた他のハンドラを止めない**）。**手前のものから 1 枚ずつ閉じる**
- **競合ダイアログの裏でクイックオープンが開かなくなった**: `Ctrl/Cmd+P` が手前のダイアログを見ていなかったので、スクリムの下にパネルが開き、**フォーカスだけがトラップの外へ出て**いた。`Ctrl/Cmd+S`（保存）と `Ctrl/Cmd+Shift+O`（目次）も同様に、全画面のパネルが開いている間は発火しない。**引き出しや ⋮ メニューは塞がない**（全画面ではないため）
- **どれが最前面かの判定を 1 か所にまとめた**: `public/app-overlays.js`。パネルを足すときはそこに 1 行足すだけで済み、**`wire*()` の呼び出し順を変えても優先順位が変わらない**（3 通りに並べ替えて確認）
- **ツリーの新規作成の入力欄を `Esc` で閉じても、引き出しが一緒に閉じなくなった**: 同じ原因（`Esc` を誰が処理したかを共有していなかった）で、スマホで引き出しを開いたまま新規作成すると 1 回の `Esc` で両方閉じていた
### Fixed (Issue #108)

- **残骸の記録が残っていても、ポートが空いていれば起動できるようになった**: 起動前の検査が記録の pid が生きているかだけを見ていたため、**残骸の pid が別プロセスに再利用されている**と、ポートが空いていても「既に yomi が起動しています」で拒否していた。残骸は SIGHUP や SIGKILL で普通に残る。**`yomi list` には出ないのに起動できない**という食い違いになっていたので、判定を list / down と同じ基準（pid 生存 **かつ** そのポートで listen）に揃えた。本当に起動中の yomi がいる場合は従来どおり `yomi down --port <n>` を案内する

### Fixed (Issue #107)

- **ポートを奪われたときにスタックトレースが出なくなった**: #94 で事前検査を入れたが、**検査と `Bun.serve` の間には隙間がある**。その窓で別プロセスがポートを掴むと、ソースの抜粋つきスタックトレース（絶対パス入り）が出て #94 以前の状態に戻っていた。事前検査を通らない経路（切り離された子）でも同じ。`createServer` を捕まえて**利用者向けの 1 行**に変換する。相手が yomi かどうかの出し分けは `assertPortIsFree` を正本にしているので、どの経路でも同じ案内になる
### Fixed (Issue #120)

- **保存に失敗したとき、同じファイルを保存中の別リクエストを巻き添えにしなくなった**: これまではパス単位でマークを無条件に消していたため、失敗したリクエストが**別リクエストのマーク**まで消していた。巻き添えになったリクエストの保存は watcher から「他人の変更」に見え、編集中の画面が再読み込みされる。**自分が立てたマークだけを消す**ようにした（`SaveMark.clear` が sha を必須になり、全削除は `clearAll()` に分かれた）。**並行保存で余計なリロードが飛ぶ経路そのものは、まだ塞がっていない** —— マークを立てる側が 1 パス 1 値で上書きするため。そちらは #129

### Fixed (Issue #99)

- **500 応答がファイルシステムの生のエラーを返さなくなった**: これまでは `EACCES: permission denied, open '/home/<利用者>/…/x.md'` のような**絶対パス入りのメッセージ**がそのまま返っていた。汎用の文言と `code` を返し、詳細はサーバ側のログにだけ出す。対象は読み取り (`read_failed`)・アセット配信 (`asset_failed`)・競合判定の読み取り (`read_failed`)・ツリーの取得 (`tree_failed`) の 4 経路で、新規作成 (`create_failed`) と保存 (`write_failed`) は既に汎用化されていたので、それに揃えた
- **想定外の例外でも内部情報を返さなくなった**: 個別の対処を抜けた例外は Bun の開発用エラーページ（HTML 約 70KB）になり、ソース断片・スタック・絶対パスが載っていた。**20KB ほどの Markdown を保存しようとするだけで起きる**（Markdown の解析が再帰上限に達する）。受け皿を用意して、一律に短い JSON を返す
- **大きな Markdown が「保存できたのにエラー」にならなくなった**: 上の経路では**ファイルは書けているのに 500 が返って**いた。保存後の表示用 HTML を作るところで失敗しても、保存自体は成功として扱う
- **保存エラーの文言が翻訳されるようになった**: `write_failed` は code を返すのに翻訳キーの対応表へ入れ忘れており、英語表示でも日本語の文言が出ていた。**あわせて、保存失敗の表示からファイルパスが消える**（翻訳された定型文になるため。パスはサーバのログに残る）

### Changed (Issue #79)

- **ブラウザ側のコードも型検査するようになった**: `public/*.js` は `tsconfig` の除外に入っており、`tsc --noEmit` の対象外だった。ビルドステップを入れない方針は変えずに（ブラウザが直接読める `.js` のまま）、JSDoc と `checkJs` で型を付けた。`bun run typecheck` がサーバ側とブラウザ側の両方を走らせる
- **型の置き場所を実装に一本化した**: 一部のモジュールだけ `.d.ts` を併記していたが、利用側は `.d.ts` を見て検査は `.js` に掛かるので、**食い違っても誰も気づかない**構造だった。`.d.ts` 11 本を削除し、型を実装の JSDoc へ移した
- **API 応答の型を 1 か所にまとめた**: ツリーのノード型が 3 モジュールで別々に定義され、しかも形が食い違っていた（`name` が必須だったり optional だったり無かったり）。`public/api-types.js` に集約し、**サーバ側 (`src/scanner.ts`) と同じ形であることを型レベルのテストで固定**した
- **利用者から見た挙動は変えていない**: `getElementById` の結果に存在チェックを足す、`instanceof` で絞る、といった実行時の分岐は入れていない。型は元からあった前提を書き写すだけに留めている

### Fixed (Issue #79)

- **クイックオープンの遷移が失敗したとき、エラー表示の代わりに例外で落ちていたのを修正した**: `app-quick-open.js` が `errorText` を import せずに使っており、`navigateTo` が reject すると `ReferenceError` になっていた。上の型検査を入れた結果として見つかったもので、回帰テストも追加した

### Added (Issue #82)

- **主要ユーザーフロー 6 種をブラウザ E2E で守るようにした**: ファイル選択と履歴（戻る・進む）、編集と保存と未保存確認と競合表示、新規 Markdown 作成、Mermaid 描画、目次とキーボードショートカット、スマホ幅のメニュー開閉。**実ブラウザでしか出ない部分**（実 history API・実 `window.confirm`・実 SVG 描画・実スクロール・実 CSS のブレークポイント）に絞ってあり、ロジックの網羅は従来どおりユニットテストが持つ
- 固定 sleep は使っていない（Playwright の auto-retry で同期）。**連続 3 回 green を確認済み**（Issue #45 の flaky を持ち込まない方針）

### Changed (Issue #84)

- **ファイルを保存するたびにツリー全体を作り直していたのをやめた**: これまでは内容が変わっただけの通知でも `/api/tree` を取り直してツリーを描き直しており、10,000 ファイルの環境では**保存 1 回につき 216ms と 724 KiB**を使っていた。構造が変わっていないので、いまは何もしない
- **ファイルの追加・削除では、変わったところだけを描き替えるようにした**: 同じファイル・同じディレクトリの要素は作り直さず、位置が合っていれば DOM に触れない。10,000 ファイルで **216ms → 18ms（12 倍）**。消えた要素を先に片付けるので、**先頭を消しても末尾を消しても速さが変わらない**
- **`/api/tree` の応答をサーバで使い回すようにした**: 応答時間の 9 割が毎回のフルスキャンだった。構造が変わるまで使い回すので、10,000 ファイルで **19.6ms → 0.6ms**。外部での追加・削除（ファイル監視）と、保存・新規作成の API で捨てる
- **接続が切れて復帰したときにツリーを取り直すようにした**: これまでは「誰かがファイルを保存するたびに全部取り直す」のが結果的に再同期になっていた。それをやめたぶん、切れている間の追加・削除を拾う経路を明示的に用意した
- **副次的に、ツリーを描き替えてもフォーカスとスクロール位置が失われなくなった**
- 前後比較は [`docs/bench/tree-diff-update.md`](docs/bench/tree-diff-update.md)。残る 18ms はクライアント側の走査で、削るにはサーバが「どこが変わったか」を通知する必要がある（Issue #126）

### Added (Issue #97)

- **`.yomiignore` に否定パターン (`!name`) を追加した**: 既定の除外 (`node_modules` / `dist` / `build` / `vendor` / `coverage` / `.cache` 等) を解除できるようになった。v0.20.0 の Issue #65 で除外が読み書きの拒否にも使われるようになり、`build/` に生成した md や画像へ到達する手段が失われていた。**これがその退避弁**
- **適用順を固定した**: 「既定 + `.yomiignore` の追加の和集合 → 否定を減算」の 2 段。否定は既定にも追加行にも等しく効き、同じ名前を `foo` と `!foo` の両方に書いたら**書き順に関わらず否定が勝つ**（行順に依存させない）
- **意図どおり効かない行を起動時に警告する**: `/` を含む行と `!` だけの行は照合が成立しないので無視し、行番号つきで stderr に出す。`yomi up -d` のときは**親プロセスでも出す**（子の stderr はログファイルへ流れるため、そこだけでは端末で気づけない）
- **グロブ文字を含む名前は除外として残す**: `*.log` や `foo[1].md` は「グロブとして展開しない」だけで、**名前そのものとの完全一致では従来どおり当たる**。捨てると除外が消えてファイルが読めるようになる（fail-open）ため、警告だけを出す

### Changed (Issue #97) — 後方互換の注意

- **`!` で始まる行の意味が変わった**: これまでは「`!foo` という名前の除外」だったが、**否定として解釈される**ようになった。`!` から始まる名前を除外したい場合は `\!name` と書くこと。**変わる向きが「除外が消える」＝ fail-open** なので、`.yomiignore` に `!` 始まりの行がある場合は確認すること（実在は稀）
- **エラー文言を実態に合わせた**: 英語の `excluded_dir` / `excluded_path` が "excluded from the tree"（ツリーからの除外）のままだったが、v0.20.0 以降は読み書きの可否も決めるため "excluded by .yomiignore or the default excludes" に改めた。**コード自体は変えていない**（i18n 辞書とテストが前提にしており、API の破壊的変更に見合う利益が無い）

### Fixed (Issue #98)

- **除外配下のファイルの実在が、応答の差から読み取れていたのを修正した**: `.yomiignore` や既定で除外したディレクトリについて、Issue #65 は「実在しても存在しなくても同じ 400」を保証していたが、**パス解決が綴りを正規化できない経路**でそれが崩れていた。除外配下を指す symlink があると `alias/<推測>/x.md` の応答が 400 と 404 に分かれ、**中のディレクトリ構成を列挙できた**
- **原因はパス解決が 1 段しか正規化していなかったこと**: 対象が存在しないと `realpath` が解決できず要求の綴りがそのまま残る。**実在する最深の祖先まで遡って**組み立て直すようにした
- **macOS など大小を区別しないファイルシステムでも同じ穴があった**（`Private/nope.md` が 404 を返して実在を漏らす）。**GitHub Actions の macOS ランナーで実測して確認**し、修正後に両者が同じ 400 へ揃うことも実測した
- **副次的な改善**: symlink ディレクトリ経由で作成したファイルの `path` が実体側の名前で返るようになった（従来はリンク名）。ファイル監視や自己保存マークが使う名前と揃うので、**自分の保存を外部変更と誤検知することがなくなる**
### Fixed (Issue #101)

- **保存を原子的にした**: `POST /api/file` の書き込みを「同じディレクトリの一時ファイルへ書く → rename で差し替える」方式に変えた。従来は `O_TRUNC` でファイルを開いてから書いていたため、**truncate 後・write 完了前にプロセスが落ちると原稿が空や途中で残る**可能性があった。v0.20.0 の watchdog (Issue #91) が応答停止時に **SIGKILL でプロセスを落とす**経路を新設したぶん、現実味が増していた
- **保証する範囲はプロセスの異常終了まで**（SIGKILL を含む）。`fsync` はしていないので、電源断・カーネルパニックは対象外
- **元のパーミッションを引き継ぐ**: rename は新しい inode を作るため、明示的に継がないと `0600` のファイルが保存のたびに umask 既定（`0664` など）へ**緩んでしまう**。レビューで実測して見つけ、塞いだ
- **一時ファイルは `O_CREAT|O_EXCL` + 暗号学的乱数の名前**で作る。他ユーザも書けるディレクトリで、先回りして置かれた symlink を追って書き込むことがない
- **保存失敗時のエラーを汎用化した**: 一時ファイルの絶対パスと pid が載っていたため、`ファイルの保存に失敗しました: <要求パス>` (`write_failed`) に統一し、詳細はサーバ側のログにだけ出す
- **同じ実装を `src/util/atomic-write.ts` に集約**し、レジストリの記録 (`saveInstance`) からも使うようにした（同じ懸念に別々の答えを持たない）

### Changed (Issue #101) — 既知のトレードオフ

- **書き込み先ディレクトリに write 権限が必要になった**: 一時ファイルの作成に要るため。従来は「ディレクトリは読み取り専用だがファイル自体は書き込み可能」でも保存できていた。失敗時は 500 とエラーメッセージが返る
- **ハードリンクが切れる**: rename は inode を差し替えるので、対象にハードリンクが張られていると**片方だけが更新され、もう片方は古い内容で残る**。エディタの atomic save と同じ挙動
- **上書き保存をファイル監視がほとんど取りこぼす**: 一時ファイルへの書き込みと rename が近すぎると、chokidar が変更イベントを落とす。実測（Linux / Bun 1.3.12 / chokidar 5、tmpfs と ext4）では、この保存経路は 80 回中 15 回しか検知されず、間隔を 2ms 空けた場合は 80/80 検知された。効いているのは rename そのものではなくタイミング。**自分の保存は元々二重リロードされない**ので利用者から見た挙動は変わらず、実害は**同じディレクトリを開いている別の yomi インスタンス**に限られる。**外部エディタの atomic save は未測定**（保存に要する時間から影響を受けないと考えられるが、確かめていない）。計測は `scripts/probe-watcher-atomic.ts`。**→ 同じリリースの Issue #119 で解消**（原因は chokidar ではなく Bun の `fs.watch` だった）

## [0.20.0] - 2026-08-10

**ファイルの切り替えと保存競合の扱いが大きく変わりました。** `Ctrl/Cmd+P` のクイックオープン (Issue #54) でマウスを使わずファイルを行き来でき、保存が競合したときはローカルとサーバの差分を見てから選べます (Issue #57)。

**⚠️ 破壊的変更が 1 件あります** (Issue #65)。`.yomiignore` と `DEFAULT_EXCLUDES` で除外したファイルが、これまでは URL を直接叩くと取得できていました。今回から読み取りも保存も拒否されます。除外ディレクトリに置いた画像を Markdown から参照していた場合、**表示されなくなります**。詳細と退避手段は下記を参照してください。

あわせて、応答しなくなったプロセスから抜けられるようになり (Issue #91)、ブラウザ E2E テスト基盤 (Issue #80) とツリー性能のベースライン (Issue #83) が入りました。内部では `public/app.js` を責務単位の 7 モジュールへ分割しています (Issue #78)。

### Changed (Issue #65) — ⚠️ 破壊的変更

- **除外設定が読み取りと保存にも効くようになった**: `.yomiignore` と `DEFAULT_EXCLUDES` で走査対象外になったパスは、`/api/file`（Markdown 本文）と `/api/asset`（画像・添付ファイル）のどちらからも取得できなくなり、`/api/file` への保存も拒否される。URL を直接叩くと 400 (`excluded_path`) を返す。**これまでは `.yomiignore` に `private` と書いてもツリーに出なくなるだけで、`GET /api/asset?path=private/creds.csv` は 200 で中身を返していた**（Issue #64 以前からの挙動）。README の例が「個人メモは除外」であるため、利用者は「見せない」と読む可能性が高く、ツリーに出る/出ないと取得できる/できないが食い違っていた
- **保存を塞いだのは読み取り迂回路を潰すため**: `POST /api/file` に不一致な `baseSha` を渡すと、**書き込みを行わないまま 409 の競合レスポンスに現在の中身 (`raw`) が載る**。読み取り経路だけを塞いでも、この経路で同じ内容が取得できてしまう。あわせて除外配下の上書きも拒否される（`/api/file/create` は以前から `excluded_dir` で拒否していた）
- **除外配下の画像は表示されなくなる**: 除外ディレクトリに置いた画像を Markdown から参照していた場合、これまで表示できていたものが表示されなくなる。除外したのに見えるほうが期待と食い違うため、揃える方向を選んだ
- **退避手段は除外の出どころで異なる**: `.yomiignore` に自分で書いた名前は、その行を消せば従来どおり読める。一方 **`DEFAULT_EXCLUDES`（`node_modules` / `dist` / `build` / `vendor` / `coverage` / `.cache` 等）は現状は解除できない**（`.yomiignore` は既定集合との和集合を作るだけで、否定パターンを持たない）。`build/` に画像や md を生成しているプロジェクトなどは、対象を除外対象外のディレクトリへ移す必要がある。否定パターンの追加は #97 で扱う
- **判定は要求パスの字句と、シンボリックリンク解決後のパスの両方で行う**: 除外配下を指すリンクをルート直下に置いても、逆に除外名そのものがシンボリックリンクでも迂回できない
- **存在の有無を漏らさない**: 除外判定はファイルを開く前・パス解決の前に行うため、除外配下のパスは実在しても、存在しなくても、ルート外を指すリンクであっても同じ 400 になる。エラーが echo するのは要求パスだけで、解決後の実パスは返さない
- **`--depth` の説明を実態に合わせた**: ヘルプと README の「深い md は読み込まず」は、正しくは「起動時のスキャン対象に含まれず（ツリーに中身が並ばず）」。リンクを辿れば従来どおり開ける。`--depth` を秘匿手段と誤解させない表現に改めた
- **`--depth` は読み取りを制限しない**: `--depth` は `tree -L` 相当の走査深さの上限であり、境界のディレクトリはツリーに残る（中を見ていないことの表明であって除外ではない）。読み取りまで塞ぐと浅い md から深い md への内部リンク遷移が動かなくなるため、除外とは扱いを分けた
### Added (Issue #54)

- **クイックオープン (`Ctrl/Cmd+P`) を追加した**: ファイル名・相対パスのインクリメンタル検索で、マウスを使わずにファイルを切り替えられる。スマホは ⋮ メニューの「🔍 ファイルを検索」から開ける
- **部分列マッチ**で途中を飛ばして打てる（`dsgn` → `design/design-notes.md`）。並び順はファイル名一致 > マッチの密度 > 前方一致 > パスの短さで、同じ入力なら常に同じ並びになる
- **同名ファイルは相対パスで区別できる**（ファイル名を主、ディレクトリを従として並べる）
- **候補は左ツリーと同じもの**。`.yomiignore` の除外と `--depth` はサーバ側の適用結果がそのまま効くので、クライアント側に判定を二重に持たない
- **遷移は既存の `navigateTo` に委ねる**ので、未保存編集中の確認・履歴・ツリーのハイライトが従来どおり働く。独自の遷移経路を作らない
- 一致文字のハイライトは `innerHTML` を使わずテキストノードと要素で組み立てる（ファイル名は利用者のディスク上の名前で `<` や `&` を含みうるため、エスケープ漏れの経路そのものを作らない）
### Added (Issue #57)

- **保存競合時に差分を表示**: 競合バナーに「差分を見る」を追加。ローカルの編集内容とサーバの最新内容を**行単位**で比べてからどちらを残すか選べる。追加・削除は色に加えて `-` / `+` の記号と左の縦線でも示し（light / dark 両対応）、変更から離れた同じ行は「N 行省略」に畳む
- **差分画面から既存の 2 択を実行できる**: 「サーバ内容を取り込む」「強制上書き」に加え、ローカル版・サーバ版それぞれのコピーに対応。**選ぶまでローカルの編集内容は失われない**
- **キーボードと支援技術で操作できる**: `role="dialog"` + `aria-modal` に加えて実際にフォーカスを閉じ込め（`Tab` はダイアログ内で循環）、`Esc` で閉じる。件数は `role="status"` で読み上げる
- **大きな文書では差分を省略する**: **トリム後**に 2000 行 / 512 KB を超えたら計算せずに諦め、選択肢とコピーだけを残す。共通の先頭・末尾を先に削ってから上限を見るので、**長い文書でも変更が一部なら差分は表示される**（40 KB 超の文書の 1 行直しも表示できる）
- **自動 3-way merge は行わない**: 保存に失敗した時点でクライアントは共通祖先を持っていないため、マージするとどちらでもない第三の内容ができてしまう。初期スコープでは比較だけを提供する
### Added (Issue #91)

- **応答しなくなったら自力で復旧するようになった**: メインスレッドが 60 秒間 event loop に戻らなくなったら、監視スレッド（watchdog）が理由とスレッドの状態を出力してプロセスを強制終了する。Issue #89 で観測した「接続はできるが応答が返らず、Ctrl+C も `kill` も効かない」状態から、再起動だけで抜けられる
- **なぜシグナルでは抜けられないか**: `process.on("SIGINT")` / `("SIGTERM")` のハンドラは event loop から dispatch されるため、メインスレッドが停止していると呼ばれない。**実測で確認した** — メインスレッドを futex でブロックした状態へ SIGINT を 3 回・SIGTERM を 1 回送っても、いずれも dispatch されずプロセスは生き続けた（残るのは SIGKILL のみ）。監視は独立したスレッド（Worker）で動くので、メインスレッドが止まっていても働く
- **落とす前に診断情報を残す**: 全スレッドの `comm` / `wchan` と稼働時間を stderr に出力する。**根本原因は未特定**で、この情報が唯一の手がかりになるため。次に踏んだ人が #91 に報告できる
- **サスペンド復帰では誤検知しない**: ノート PC のスリープ等でプロセス全体が凍結すると心拍は古く見えるが、監視スレッド自身の遅れと突き合わせて凍結を見分ける
- **通常の停止経路は変わらない**: Ctrl+C / `yomi down` での graceful shutdown はこれまでどおり。監視スレッドはプロセスの生存を延ばさない（`unref` 済み）
- **無効化できる**: `YOMI_NO_WATCHDOG=1` で監視を止め、`YOMI_WATCHDOG_TIMEOUT_MS` で閾値（既定 60 秒）を変えられる。根本原因が未特定である以上この判定が全環境で正しく振る舞う保証は無く、**プロセスを強制終了する機能に無効化手段が無いのは可逆性の点で釣り合わない**ため逃げ道を残した
- **強制終了の副作用**: 終了コードが 137 になる（systemd 等では「クラッシュ」扱い）。レジストリの記録は残るが、次の `yomi list` / `yomi down` で除去される

**根本原因は依然として未特定**（churn 仮説は 53 万サイクルの負荷試験で否定済み）。これは踏んだときの逃げ道であって修正ではない。
### Fixed (Issue #94)

- **フォアグラウンド起動のポート衝突で、スタックトレースではなく利用者向けの 1 行を出すようにした**: `yomi --port <使用中>` は `Bun.serve` の throw がそのまま `main().catch` へ流れ、**無関係なソースの抜粋が並んだあとに理由が出る**という読み取りにくいエラーになっていた。`up -d` は同じ状況で 1 行の案内を出しており、その非対称を解消した
- **相手が yomi かどうかで案内を出し分ける**: 既に yomi が使っていれば `yomi down --port <n>`（pid と起動ディレクトリつき）、yomi 以外なら「別のポートを指定してください」。判定と文面は `assertPortIsFree` に集約し、バックグラウンドと同じものを使う
- **終了コードが 1 になる**（従来も 1 だったが、これを回帰テストで固定した）
- **`--port` を省略したときの挙動は変わらない**: `findAvailablePort` が空きを探すので事前検査に掛からない
### Added (Issue #83)

- **ツリー走査・描画のベンチマークを追加した**: `bun run bench` でスキャン時間・`/api/tree` 応答と response size・DOM 更新時間の 3 指標を 1,000 / 5,000 / 10,000 ファイル規模で計測できる。fixture は `scripts/bench-fixture.ts` が生成する（追跡しない）
- **現行実装のベースラインを記録した**: `docs/bench/tree-baseline.md`。10,000 ファイルでスキャン 21ms（うち `readdir` は 7ms）、`/api/tree` 19ms・724 KiB、jsdom 上の DOM 構築 177ms。**「`readdir` 律速」ではなく、サーバ側で効くのは「再スキャンしない」ほう**という読み取りを申し送りとして残した
- **各値は warmup 3 回を捨てたあと 11 回計測した中央値（最小–最大）**: warmup 1 回では JIT が温まりきらず、中央値が定常状態より 3 割ほど高く出る。幅を記録しないと #84 が「改善なのか誤差なのか」を判定できない
- **DOM 構築の値は jsdom 上のもの**でレイアウト・ペイントを含まない。実物は既定で全ディレクトリが閉じており（501 個中 500 個が `display:none`）、実ブラウザのコスト構造とは一致しない。実機値が要るなら E2E（#80）側で測る
- **計測はプロダクトコードを変えていない**: 既存の `scanMarkdownTree` / `createServer` を呼ぶだけで、注入点の追加もしていない。DOM 構築だけは app.js の写しになるため、`tests/bench-dom-parity.test.ts` が実物と骨格を突き合わせて固定している
### Added (Issue #80)

- **ブラウザ E2E テスト基盤を追加した**: Playwright で実 Chromium を動かす E2E を `e2e/` に置き、`bun run test:e2e` で実行できる。`e2e/fixtures/` の固定ドキュメントに対して yomi を自動起動し、疎通確認用の最小 1 フロー（ファイル選択 → プレビュー表示 → URL 反映）を CI で通す
- **失敗時に screenshot と trace を残す**: `test-results/` に出力され、CI では artifact として取得できる。trace は `playwright show-trace` で操作を再生できる
- **CI は test ジョブと分けた**: ブラウザ導入だけで 100MB 超・数十秒かかるため、ユニットテストのフィードバックを遅らせない。E2E が落ちても test の結果は独立して読める。ブラウザバイナリは版ごとにキャッシュする
- **chromium のみ・ubuntu のみで走らせる**: E2E が守るのは「実ブラウザでしか出ない結合」であって OS 差ではない（OS 差はユニット側の matrix が見ている）。macOS でも回すと CI 時間が倍になり、Issue #45 で踏んだ macOS 固有の flaky を E2E でも抱え込む
- **flaky を持ち込まない方針を明文化した**: 固定 sleep を使わない / `retries` は CI でも 0 / `workers: 1`。責務分担（jsdom で書けるものは E2E に書かない）とあわせて README に記載
- **E2E は `*.e2e.ts` という命名にした**: bun のランナーは `.test` / `_test_` / `.spec` / `_spec_` を拾うため、`.spec.ts` だと素の `bun test` が Playwright のテストを実行しようとして落ちる。命名で排他にすれば探索範囲を狭める設定が要らず、「`tests/` 外に置いたテストが黙ってスキップされる」罠も避けられる
- **fixture は毎回 tmp へコピーする**: yomi は書き込み API を持つので、追跡下の `e2e/fixtures/` を直接見せると編集・新規作成のフロー（#82）が git のワークツリーを書き換える。失敗して途中終了すると fixture が壊れたまま残り、次の実行が flaky に見える
- **UI 言語とタイムゾーンを固定した**: Chromium はホストの locale を継承するため、指定しないとローカル（ja）と CI（en）で yomi の表示言語が変わり、ラベル依存のロケータが環境で分岐する
### Fixed

- **テーマを切り替えると言語トグルの押下状態が消えるのを直した** (Issue #85): テーマボタンのセレクタが言語トグルまで拾っており、テーマを切り替えるたびに言語トグルの `aria-pressed` が全て `false` になっていた。スクリーンリーダーには「どの言語が選ばれているか分からない」状態に見えていた
- **フォアグラウンド起動も `yomi list` / `yomi down` から扱えるようにした** (Issue #90): これまでレジストリに記録していたのはバックグラウンド起動だけで、フォアグラウンドで起動した yomi は一覧にも出ず `yomi down` でも止められなかった
- **CI が間欠的に落ちるのを直した** (Issue #92): テストハーネスが app.js の保留中タイマーを破棄しておらず、後続のテストへ影響していた

### Changed

- **`public/app.js` を責務単位の 7 モジュールへ分割した** (Issue #78): 1,892 行あった単一ファイルを `app-context` / `app-tree` / `app-document` / `app-editor` / `app-preview` / `app-mobile` / `app-websocket` に分け、`app.js` は画面初期化と結線だけを持つ 246 行にした。モジュール間の相互参照は `ctx` 経由の遅延束縛にして import の循環を避けている。**利用者から見た挙動は変えていない**（分割前に特性テストを整備し、それが通り続けることで担保した。Issue #77）
- **テストの土台を整えた**: app.js の主要 controller に特性テストを追加 (Issue #77)、E2E のためのテスト容易性注入点を整備 (Issue #81)、dependabot の更新で vendor bundle も自動再生成 (Issue #75)

### Security

- **同梱している DOMPurify を 3.4.13 に更新した**（HTML サニタイザ）。あわせて Mermaid を 11.16.1 に更新。どちらも `public/vendor/` にバンドルして配布しているため、更新版が配布物に入る

## [0.19.0] - 2026-08-04

**バックグラウンド実行**に対応しました (Issue #67 / #68 / #69)。`yomi up -d` でターミナルを占有せず常駐させ、`yomi list` で起動中の一覧を確認し、`yomi down` で停止できます。`docker compose` の `up -d` / `down` と同じ感覚で、複数のプロジェクトを同時に開いたままにできます。引数なしの `yomi` は従来どおりフォアグラウンド起動のままです。あわせて、リンクした csv 等のダウンロード (Issue #64) と、dependabot の依存更新 PR が CI で必ず落ちていた問題の解消 (Issue #72) が入っています。

### Added (Issue #68, #69)

- **サブコマンド体系を導入**: `yomi up` / `yomi down` / `yomi list` を追加。**引数なしの `yomi` と既存オプション (`--port` / `--host` / `--share` / `--depth` / `--no-open`) は `yomi up` の別名として従来どおり動作する**（後方互換）
- **`yomi up -d` でバックグラウンド起動**: プロセスグループを分離して起動するため、起動したターミナルで Ctrl+C を押しても常駐プロセスは生き続ける。起動時に pid・URL・ログパスを表示し、標準出力/標準エラーは状態ディレクトリのログへ追記する。`-d` のときは既定でブラウザを開かない（`--open` の明示指定でのみ開く）
- **`yomi down` で停止**: 既定は**カレントディレクトリで起動したインスタンスのみ**を停止する。別プロジェクトで開いている yomi を巻き添えで落とさないため、全部止めるときは `--all`、個別指定は `--port <n>` を使う。SIGTERM で終わらなければ 5 秒後に SIGKILL へフォールバックする
- **`yomi list` で起動中インスタンスを一覧**: PID / ポート / 公開有無 (`local` = 自端末のみ / `share` = LAN 公開中) / 起動ディレクトリを表で表示する。起動ディレクトリは最終列に置くため、パスが長く 80 桁を超えても見出しと値の対応が崩れない
- **インスタンスレジストリ**: `${XDG_STATE_HOME:-~/.local/state}/yomi/` にポート単位の JSON とログを置く (`instances/<port>.json` / `logs/<port>.log`)。1 インスタンス 1 ファイルにすることで、複数ディレクトリで同時に起動しても記録を潰し合わない。ディレクトリは 0700 で作成する
- **残骸の自動除去と誤操作の防止**: 異常終了で残った記録は `yomi list` / `yomi down` の実行時に除去される。停止・一覧の判定は「pid の生存」だけでなく「記録したポートで listen しているか」も確認するため、pid が再利用されていても無関係なプロセスを停止させない。使用中ポートへの二重起動も拒否する

### Added (Issue #64)

- **リンクした csv 等をダウンロードできるようにした**: `/api/asset` の許可拡張子に、ブラウザが実行も描画もしないデータ / 文書 / アーカイブ形式 (`.csv` / `.tsv` / `.txt` / `.json` / `.yaml` / `.yml` / `.zip` / `.xlsx` / `.docx` / `.pptx`) を追加。これまでは許可リストが画像 + `.pdf` のみだったため、`[売上](data/sales.csv)` のようなリンクは 400 で弾かれ保存できなかった
- **表示できる形式は inline、それ以外は attachment で配信**: 画像と PDF は従来どおり `Content-Disposition: inline`（プレビュー表示 / 内蔵 PDF ビューア）を維持し、新たに追加した形式は `attachment` でダウンロードさせる。ファイル名は `filename*=UTF-8''` で渡すため日本語名でも保存名が壊れない（ASCII fallback も併記）
- **許可リスト方式は維持**: `.html` / `.htm` / `.xhtml` / `.js` / `.mjs` は追加していない。配信するとスクリプト実行・HTML 描画の経路になり、Issue #21 / #22 の XSS 対策を迂回するため

### Changed (Issue #64)

- **リンク書き換えを `.pdf` 決め打ちから allowlist 判定へ一般化**: `rewritePdfLinkHref` を `rewriteAssetLinkHref` に改名し、判定を `isAssetExtension()` に一本化した。配信できる拡張子が増えても renderer 側の正規表現を都度足す必要がなくなる。attachment 対象のリンクには `download` 属性を付与し、空タブを開かずそのまま保存させる（`target="_blank"` は app.js の click ハンドラが素通り条件にしているため維持）
- **画像へのテキストリンクも解決されるようになった**: `[図を見る](foo.png)` のような画像へのリンクは、これまで内部 md ナビゲーション扱いで「ファイルが見つかりません」になっていたが、`/api/asset` 経由で新規タブに表示される

### Changed (Issue #72)

- **dependabot の依存更新 PR に `bun.lock` を自動追記するようにした**: dependabot は `package.json` しか書き換えられず `bun.lock` を更新しないため、依存更新 PR が CI の `bun install --frozen-lockfile` で必ず落ち、マージできないまま溜まっていた。CI の完了を契機に lockfile を再生成して PR へ追記する `Dependabot lockfile` ワークフローを追加した (`.github/workflows/dependabot-lockfile.yml`)
- **利用にはリポジトリ側の準備が必要**: dependabot がトリガーした workflow の `GITHUB_TOKEN` は read-only に固定され `permissions:` でも昇格できず、`GITHUB_TOKEN` による push では PR の check が approval-required で止まる。このため `workflow_run` + PAT（Actions secrets の `DEPENDABOT_LOCKFILE_TOKEN`）で push する。手順は README の「開発」を参照。PAT を持った環境で更新先パッケージの lifecycle script を走らせないよう `--ignore-scripts` で install する
- **dompurify / mermaid の更新は引き続き手当てが必要**: この 2 つは `public/vendor/` に生成物を持つため、更新時は `bun run build` での再生成が要る（自動化は Issue #75）

### Dependencies

- typescript 6.0.3 → 7.0.2 (#62)
- dompurify 3.4.11 → 3.4.12 (#63)
- jsdom 29.1.1 → 30.0.1 (#70)

## [0.18.1] - 2026-07-08

プレビューのサニタイザに起因する **CSS exfiltration 脆弱性を修正** しました (Issue #59)。悪意ある Markdown を開くと、`<style>` タグ・`style` 属性、および Mermaid の `themeCSS` init directive 経由で文書全体に CSS を注入でき、属性セレクタ + `background: url(...)` でファイルパス等の推測・外部送信が可能でした。sanitizer 経路と Mermaid 経路の両方を塞いで遮断します。

### Security (Issue #59)

- **サニタイザで `<style>` タグと `style` 属性を禁止**: `SANITIZE_CONFIG`（`public/sanitize-config.js` に切り出し）に `FORBID_TAGS: ["style"]` と `FORBID_ATTR` へ `style` を追加。DOMPurify の html profile が既定でこれらを許可していたため、悪意ある md が文書全体へ CSS を注入できた。marked の table 配置は `align` 属性、コードブロックは class ベース、Mermaid 図は sanitize 後に SVG を生成するため、いずれも影響を受けない
- **Mermaid の `themeCSS` init directive による post-sanitize CSS 注入を遮断**: `securityLevel: "strict"` の既定 secure リストは `themeCSS`/`fontFamily` を保護しないため、`%%{init: {themeCSS: ...}}%%` で mermaid.run() が sanitize 後に生成する SVG の `<style>` に任意 CSS を注入でき（インライン SVG の `<style>` は文書全体へ作用）、同種の exfiltration が成立した。`mermaid.initialize` の `secure` に `themeCSS`/`fontFamily`/`altFontFamily` を追加し directive での上書きを禁止。正当な `theme`/`themeVariables` directive は従来どおり動作する
- **jsdom による行動検証テストを追加**: 実 DOMPurify / 実 Mermaid で `<style>`/`style`/themeCSS の遮断（対照込み）と正当機能の維持を CI で回帰検知する

## [0.18.0] - 2026-07-06

DOMPurify と Mermaid を **配布物へ同梱** し、jsDelivr への実行時依存を排除しました (Issue #52)。オフライン / CDN 障害 / ネットワーク制限下でもプレビューのサニタイズと Mermaid 描画が動作します。あわせてプレビュー HTML に **Content-Security-Policy** を付与し、外部 script を禁止 (`script-src 'self'`) しました。`bun run build` で `public/vendor/*.js` を生成し、CI で鮮度・改竄を検証します。

### Changed (Issue #52)

- **DOMPurify と Mermaid を配布物へ同梱し CDN 依存を排除**: これまで `public/app.js` は DOMPurify と Mermaid を jsDelivr から実行時 import していた。オフライン / CDN 障害 / ネットワーク制限下ではサニタイズや Mermaid 描画が動かず、外部コードの自動更新で再現性も低下していた。両ライブラリをバージョン固定の devDependencies として `bun build` で `public/vendor/*.js` に bundle し、`app.js` はローカルの `./vendor/dompurify.js` / `./vendor/mermaid.js` を import するよう変更。`public/` は npm の files に含まれるため GitHub からの global install でもそのまま同梱される
- **`bun run build` を追加**: `scripts/build-vendor.ts` が vendor bundle を生成する。CDN 参照・余計なチャンクの残存を検出して fail する。CI で build 健全性と生成物の未コミット/欠落を検証する

### Added (Issue #52)

- **プレビュー HTML に Content-Security-Policy を付与**: `script-src 'self'` で外部 script を禁止（同梱 bundle のみ許可）。Mermaid の inline style 用に `style-src 'unsafe-inline'`、user markdown のリモート画像を壊さないよう `img-src` に `http:`/`https:`、ライブリロード用に `connect-src` へ Host 由来の `ws://` を明示。`object-src 'none'` / `frame-ancestors 'none'` / `base-uri 'self'` / `form-action 'self'` も付与

## [0.17.0] - 2026-07-06

既定の bind アドレスを **自端末のみ (`127.0.0.1`)** に変更し、LAN 公開を明示フラグ **`--share`** に限定しました (Issue #51)。これまで引数なし起動は `0.0.0.0` にバインドし、認証のない読み書き API が同一 LAN に公開されていました。安全側の既定値に改め、LAN 共有は意図した操作でのみ有効化されます。設計書の「localhost バインドのみ」方針にコードを揃え直したものです。

### Changed (Issue #51) — ⚠️ 破壊的変更

- **既定の bind アドレスを `0.0.0.0` から `127.0.0.1` に変更**: 引数なしで起動すると自端末 (loopback) のみにバインドし、同 LAN の別端末からは接続できなくなった。認証なしの読み書き API が既定で LAN に公開される状態を解消するための安全側の既定値。設計書 [`docs/design-yomi-20260430.md`](docs/design-yomi-20260430.md) の「localhost バインドのみ」方針にコードを揃え直したもの
- **LAN 公開は `--share` フラグで明示的に有効化**: `yomi --share` で `0.0.0.0` にバインドし、従来どおり LAN IP から閲覧できる。`--share` と `--host` は同時指定できない（矛盾する指定を排他エラーで中止）。特定アドレスへの固定は従来どおり `--host <addr>` を使う（`--host 0.0.0.0` の明示指定は後方互換で許可）
- **README（日英）と CLI ヘルプを更新**: 既定 loopback / `--share` / セキュリティ注意書きを反映

### Security (Issue #51)

- **空 / オプション始まりの引数値を拒否**: `--host --share` で `--share` が host 値として消費され `--share`/`--host` の排他検証を（指定順によって）迂回する問題と、`--host=`（空値）が空 bind = 全インターフェース公開（LAN 露出）になる footgun を、値エラーで fail-fast に遮断。単一ダッシュの負数値（`-1` 等）は従来どおり各 parser の範囲検証に委ねる

#### 移行方法

- これまで `yomi` を LAN 共有目的で使っていた場合は **`yomi --share`** に置き換える
- スクリプト等で `--host 0.0.0.0` を明示していた場合はそのまま動作する（変更不要）
- 自端末のみで使っていた場合は変更不要（既定が自端末のみになったため、むしろ安全）

## [0.16.1] - 2026-07-03

macOS の CI で間欠的に失敗していたファイル監視テストを決定論化しました (Issue #45)。本番挙動に変更はなく、テストの信頼性 (CI が再実行なしに安定して green になる) の改善のみです。

### Fixed (Issue #45)

- **watcher テストの flaky を解消**: `tests/watcher.test.ts` の自己保存マーク抑止テストが macOS の FSEvents 配信遅延・結合により間欠 fail していた。監視ロジック (拡張子フィルタ / kind マッピング / debounce 集約 / save-mark 抑止 / close) は注入フェイクイベントで決定論的に検証し、chokidar 固有挙動 (作成・ネスト・rename・削除・除外dir・depth) は実 chokidar で残しつつ固定 sleep を poll (`waitFor`) と `ready` 待ちに置換

### Changed

- **`createWatcher` にテスト用の注入口を追加**: `WatcherOptions.watch` (監視実装の差し替え) と `WatcherOptions.onReady` (初期スキャン完了通知)。本番は未指定のままで挙動不変

## [0.16.0] - 2026-07-02

ブラウザ UI を **日本語 / English に切り替え** られるようになりました (Issue #48)。トップバー（スマホは ⋮ メニュー）の言語トグル（自動 / EN / 日本語）で、ラベル・ステータス・API エラーメッセージを含む UI 全体が即時に言語を切り替えます。「自動」はブラウザの言語（`navigator.language`）に追従し、選択は `localStorage` に保存されてリロード後も維持されます。ビルドステップは増やさず、純粋な JS メッセージ辞書で実現しています。Markdown 本文・ファイル名・パスは翻訳対象外です。

### Added (Issue #48)

- **UI 言語切替（日本語 / English）**: トップバーとスマホ ⋮ メニューに言語トグル（自動 / EN / 日本語）を追加。「自動」は `navigator.language` が `en*` なら英語、それ以外は日本語。選択は `localStorage`（`yomi:lang:v1`）に永続化され、`<html lang>` も追従する
- **i18n メッセージ辞書 (`public/i18n.js`)**: ビルド不要の純 JS 辞書。ja / en が同一キー集合を持つ（テストで保証）。`t(key, params)` はプレースホルダ `{name}` を 1 パスで置換し、未翻訳キーは ja へフォールバック。`data-i18n` / `data-i18n-title` / `data-i18n-aria-label` / `data-i18n-placeholder` 属性で静的文言を宣言的に翻訳
- **API エラーメッセージの多言語化**: サーバのエラー応答に `code` を付与し、フロントで翻訳キーへ対応づけ（`already_exists` / `not_markdown` / `unsafe_path` / `not_found` など）。未知 code はサーバの文字列にフォールバック
- **README の日英 2 ファイル化**: `README.en.md`（全訳）を追加し、両 README 冒頭に相互リンクを設置

### Changed

- **`renderMarkdown` のサニタイズ**: プレビュー内 Markdown から `data-i18n*` 属性を除去（`FORBID_ATTR`）。言語切替時の `applyI18n` がユーザーコンテンツを書き換えないようにする

## [0.15.0] - 2026-06-24

起動時に **読み込む階層の深さを指定** できるようになりました (Issue #44)。`tree -L` のように `yomi --depth 2`（短縮 `-L 2`）で 2 階層までに絞れます。深い Markdown は読み込まず監視もしないので、巨大なディレクトリツリーでも起動が速くなり、ファイル監視の watch 数も減ります（[#39](https://github.com/ef-tech/yomi/issues/39) の inotify ENOSPC 軽減）。

### Added (Issue #44)

- **`--depth <n>` / `-L <n>` オプション**: 走査・監視するディレクトリ階層を深さ `N` で制限。`tree -L <level>` と同義で、ルート直下を深さ 1 として数える。デフォルトは無制限（現行動作を維持）。`n` は 1 以上の 10 進整数のみ許可し、`0` / 負数 / `0x10` / `1e3` 等は起動時エラーで中止。設定時は起動バナーに走査階層を表示
- **`scanMarkdownTree` の `maxDepth`**: 深さ超過の再帰を停止。境界（最深スキャン階層）のディレクトリは中を見ずにノードだけ残す（`tree -L` 準拠）
- **watcher の深さ連動**: chokidar の depth（= 深さ - 1）に変換し、深い dir を監視しないことで inotify watch 数を削減。スキャン深さと監視深さを一致させる

### Fixed

- `--depth` で truncate された境界ディレクトリには新規作成「＋」を出さないようにした。出すと深さ超過の場所にファイルが作られ、直後のツリー再取得に現れず "消えた" ように見え、監視もされない問題があった（ルートのツールバー「＋」は引き続き利用可）

## [0.14.0] - 2026-06-16

左ツリーから **新規 Markdown ファイルを作成** できるようになりました (Issue #6)。ターミナルに戻って `touch` する必要はもうありません — ツールバーの「＋」やディレクトリの「＋」から作成して、そのまま編集モードで書き始められます。キーボードやスクリーンリーダーからも操作でき、ルート外への書き込みや巨大リクエストはサーバ側で防がれます。

### Added (Issue #6)

- **`POST /api/file/create`**: 空の Markdown ファイルを新規作成するエンドポイント。上書き保存 (`POST /api/file`) とは分離。`resolveSafe` によるパストラバーサル拒否、許可拡張子 (`.md` / `.markdown` / `.mdx`) 以外の 400、既存ファイルの 409 (存在チェックと作成は `O_CREAT | O_EXCL` でアトミック、TOCTOU 回避)、親ディレクトリ不存在の 400 (再帰作成しない)、除外ディレクトリ (`DEFAULT_EXCLUDES` / `.yomiignore`) 配下への作成拒否。自己保存マークを登録するため、作成によるライブリロードの二重発火は起きない
- **左ツリーの新規作成 UI**: ツールバー左端の「＋」でルート直下に、ディレクトリ行 hover の「＋」でそのディレクトリの子として、インライン入力欄を表示。`Enter` で確定 / `Esc`・フォーカス喪失でキャンセル。拡張子なし入力は `.md` を自動補完 (`foo` → `foo.md`)、`.markdown` / `.mdx` はそのまま。作成成功でツリーを再取得して新規ファイルを選択し、自動で編集モードに入る (キャレットは先頭)。失敗 (409 / 400) はヘッダにエラー表示

### Security

- **symlink 親ディレクトリ経由のルート外作成を防止**: 新規作成は leaf が未存在のため `realpath` が親の symlink を解決できず、root 内→外を指すシンボリックリンク経由でルート外にファイルを作れてしまう穴があった。`resolveSafe` で親ディレクトリの `realpath` がルート内かを再検証して塞いだ
- **`POST /api/file/create` のボディサイズ上限**: `POST /api/file` と同じく `content-length` / 実バイト数を `MAX_WRITE_BYTES` で制限し、巨大ボディによる LAN 経由のメモリ枯渇 (DoS) を防止 (413)
- 想定外の FS エラー時の 500 レスポンスは生のエラーメッセージを返さず汎用文言に統一 (内部状態の漏洩防止)

### Changed

- **アクセシビリティ**: ディレクトリの「＋」を `display:none` から `opacity:0` + `pointer-events:none` に変更し、フォーカス可能なまま視覚的に隠す方式へ。キーボード (`Tab` → `Enter`) とスクリーンリーダーからサブディレクトリ内に作成できるようになった。インライン入力欄を閉じた後はフォーカスをトリガーの「＋」へ復帰。入力欄を 16px にして iOS のフォーカスズームを防止

### Fixed

- 同一パスへの作成と保存が競合した際に自己保存マークを誤って消し、偽のライブリロードを発火させる競合を解消 (マークは作成成功後にのみ登録)
- 編集中 (未保存) に作成して破棄確認をキャンセルした場合に、古いエディタへキャレット移動や誤った「作成しました」表示が出る UI 不整合を解消

### Tests

- `tests/server.test.ts`: 作成系の正常 / 異常系を網羅 (3 拡張子・サブディレクトリ・409・トラバーサル・絶対パス・拡張子・親不存在・ENOTDIR・除外ディレクトリ・JSON 不正・Origin 403・405・大文字 `.MD`・symlink 親エスケープ 400・save-mark 登録 / クロバー回帰・413)
- `tests/new-file.test.ts`: ファイル名補完ロジック + クライアント↔サーバの許可拡張子パリティ + 末尾ドット境界

### Docs

- `README.md`: 「編集機能」に「新規作成」節を追加

## [0.13.0] - 2026-06-06

左ツリーに **「全て開く / 全て閉じる」ボタン** が付きました (Issue #41)。深いディレクトリ構成でも一括でツリーを開閉できます。

### Added (Issue #41)

- **ツリーツールバー**: 左ツリー上部（`#tree` 直上）にツールバーを新設。「⊞ 全て開く」で全ディレクトリを一括展開、「⊟ 全て閉じる」で初期状態（ルート直下のみ表示）に戻す。選択中ファイルの祖先も閉じる（プレビュー表示は維持、ファイル再選択時は従来どおり自動展開）。開閉状態は従来の `localStorage` (`yomi:openDirs:v1`) にそのまま保存される。ディレクトリが 1 つもない間（読み込み中・フラット構成）はボタンを disabled にして誤操作を防ぐ。キーボードフォーカスは `:focus-visible` のテーマ色 outline で明示（`.copy-path-btn` と同基準）。
- **スマホ対応**: ツールバーは sidebar 内のため drawer にもそのまま表示。タップターゲットは 44px 基準を踏襲。

### Changed (Issue #41)

- **「全て開く」が stale path を剪定**: 開閉状態の保存値はリネーム・削除で消えたディレクトリの path を残し続けるが、「全て開く」実行時に現存ディレクトリのみで保存し直すため、溜まった死んだ path が自然に掃除される。

### Tests

- `tests/tree-toolbar.test.ts`: ツールバーの状態遷移ロジックを `public/tree-toolbar.js`（pure module、`navigation.js` 等と同方針）に切り出し、開集合の生成・剪定・disabled 判定のユニットテスト 11 件を追加。

### Docs

- `README.md`: 「使い方」に「ファイルツリー」節を追加。

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
