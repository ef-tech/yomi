# yomi (読み)

ローカル Markdown ビューア。カレントディレクトリ配下の `.md` ファイルを再帰的に集めて、2 ペインのブラウザ UI（左：ツリー、右：プレビュー）で読むためのコマンドラインツール。

## 特徴

- `cd <ドキュメント置き場> && yomi` で立ち上がる
- Mermaid 図のインライン描画
- ファイル保存で自動リロード（ライブプレビュー）
- GitHub 風 CSS、システムのダーク/ライト追従
- localhost バインドのみ（個人利用前提）

## 必要環境

- [Bun](https://bun.sh) v1.0+

## インストール

```bash
bun install -g github:ef-tech/yomi
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
  --host <addr>   バインドアドレス（デフォルト: 127.0.0.1）
  --help, -h      ヘルプ
```

## 開発

設計の詳細は [`docs/design-yomi-20260430.md`](docs/design-yomi-20260430.md) を参照。

## ライセンス

MIT
