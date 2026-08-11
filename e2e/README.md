# E2E テストと fixture

`e2e/fixtures/` は `e2e/*.e2e.ts` が読む固定のドキュメント。**内容を変えるとテストが落ちる**ので、
変更するときは期待値も合わせて直すこと。

**説明をここに置くのは、`fixtures/` の中身が yomi に配られる文書そのものだから。**
`fixtures/README.md` は「fixture の説明」ではなく**テスト対象の Markdown**で、
h1 と内部リンクを `smoke.e2e.ts` が assert している（実際に説明で上書きして壊した）。

`playwright.config.ts` が毎回 tmp へコピーしてから yomi に見せるので、
**テストが書き換えてもここは汚れない**（yomi は書き込み API を持つ）。

## 何のためのファイルか

| ファイル | 用途 | 守るべき不変条件 |
|---|---|---|
| `fixtures/README.md` | ツリー選択と内部リンク | h1 が `yomi E2E fixture` / `docs/guide.md` へのリンクを持つ |
| `fixtures/docs/guide.md` | 階層表示と遷移の起点 | **ツリーの先頭ファイルであること**（下記） |
| `fixtures/docs/links.md` | 編集・保存・外部リンクバナー | **外部リンクはちょうど 1 本**（strict locator で引く） |
| `fixtures/docs/mermaid.md` | Mermaid の実描画 | ```mermaid のコードブロックを 1 つ持ち、`開始` / `終了` を含む |
| `fixtures/docs/outline.md` | 目次と見出しジャンプ | **H1-H3 がちょうど 5 個** / **スクロールが要る長さ**（短いと見出しジャンプの確認にならない） |

## ファイル名の制約

**`docs/guide.md` がツリーの先頭ファイルでなければならない。** `smoke.e2e.ts` と
`user-flows.e2e.ts` の `beforeEach` が「起動時に開くのは `docs/guide.md`」を前提にしている。

`sortTree`（`src/scanner.ts`）は**ディレクトリ優先 → `localeCompare`** で並べるので、

- `docs/` 内に追加するなら `guide.md` より後ろに並ぶ名前にする（`g` < `l` < `m` < `o`）
- `docs/` より前に並ぶディレクトリを作らない

**パスに `"` を含めない。** ツリーのロケータが `[title="..."]` で引いている（`e2e/helpers.ts`）。

## テストが作るファイル

`user-flows.e2e.ts` の新規作成フローが `e2e-new-<worker>-<repeat>-<retry>.md` を
ルート直下に作る。**削除 API が無いので消せない**が、実行ごとに tmp を作り直すので
持ち越さない。名前を一意にしてあるのは `--repeat-each` / `retries` でも通るようにするため。
