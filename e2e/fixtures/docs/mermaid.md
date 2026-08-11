# Mermaid

実ブラウザでしか確認できない図の描画に使う (#82)。
jsdom には SVG のレイアウトが無いので、ここは E2E でしか守れない。

```mermaid
graph TD
  A[開始] --> B[終了]
```
