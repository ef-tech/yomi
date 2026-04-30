# yomi (読み)

ローカル Markdown ビューア。カレントディレクトリ配下の `.md` ファイルを再帰的に集めて、2 ペインのブラウザ UI（左：ツリー、右：プレビュー）で読むためのコマンドラインツール。

## 特徴

- `cd <ドキュメント置き場> && yomi` で立ち上がる
- Mermaid 図のインライン描画
- ファイル保存で自動リロード（ライブプレビュー）
- GitHub 風 CSS、システムのダーク/ライト追従
- 同 LAN 内の別端末からも閲覧可（`--host 127.0.0.1` でローカル限定）

## 必要環境

- [Bun](https://bun.sh) v1.0+

## インストール

```bash
bun install -g github:ef-tech/yomi
```

## アップデート

最新の `main` を取得するには、もう一度同じコマンドを実行します。
Bun は同じパッケージ名で再インストールするとリモートの最新ソースを取得して上書きします。

```bash
bun install -g github:ef-tech/yomi
```

特定のタグ・ブランチ・コミットを使いたい場合：

```bash
bun install -g github:ef-tech/yomi#v0.2.0    # タグ
bun install -g github:ef-tech/yomi#main      # ブランチ
bun install -g github:ef-tech/yomi#abc1234   # コミット SHA
```

## アンインストール

```bash
bun remove -g yomi
```

インストール済みのバージョンを確認したい場合：

```bash
bun pm ls -g | grep yomi
```

## 使い方

```bash
cd /path/to/docs
yomi
```

ブラウザが自動で開きます。

### オプション

```
yomi [options]
  --port <n>      ポートを指定（デフォルト: 3939 から自動探索）
  --no-open       ブラウザを自動で開かない
  --host <addr>   バインドアドレス（デフォルト: 0.0.0.0、同 LAN から閲覧可）
                  ローカル限定にするには --host 127.0.0.1
  --help, -h      ヘルプ
```

### LAN からの閲覧

デフォルトでは `0.0.0.0` にバインドするため、同じネットワーク上のスマートフォンや別端末から起動時に表示される LAN IP の URL でアクセスできます。

```
yomi が起動しました
  ローカル   http://127.0.0.1:3939
  LAN        http://192.168.0.100:3939
```

**注意**: 認証機能はないため、信頼できないネットワーク上では `--host 127.0.0.1` で自端末のみに制限してください。

## 開発

設計の詳細は [`docs/design-yomi-20260430.md`](docs/design-yomi-20260430.md) を参照。

## ライセンス

MIT
