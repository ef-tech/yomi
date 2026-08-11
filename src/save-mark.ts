import { createHash } from "node:crypto";

const DEFAULT_MAX_ENTRIES = 64;

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * 「自分でファイルを書き込んだ直後の sha」を path 単位で記録する。
 * watcher が拾った変更イベントの現状 sha がこれと一致すれば、
 * 自分の書き込みによるイベントとみなして publish しない。
 *
 * timer ベースではないので遅い FS でも安定。
 * メモリリーク防止のため LRU で上限を持つ。
 */
export class SaveMark {
  private readonly map = new Map<string, string>();
  private readonly max: number;

  constructor(max: number = DEFAULT_MAX_ENTRIES) {
    this.max = max;
  }

  set(path: string, sha: string): void {
    if (this.map.has(path)) {
      this.map.delete(path);
    } else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(path, sha);
  }

  has(path: string, sha: string): boolean {
    return this.map.get(path) === sha;
  }

  /**
   * **自分が立てたマークだけを消す** (Issue #120)。
   *
   * 以前はパス単位の無条件削除だった。同じファイルを 2 つのリクエストが保存すると、
   * こう壊れる:
   *
   * 1. リクエスト 1 がマーク A を立てる
   * 2. リクエスト 2 がマーク B で上書きする
   * 3. リクエスト 1 が失敗して消す → **B が消える**
   * 4. リクエスト 2 の正常な保存が watcher から「他人の変更」に見え、余計なリロードが飛ぶ
   *
   * **`sha` を必須にして、うっかり値を見ずに消せないようにしてある**（全削除が要るなら
   * {@link SaveMark.clearAll} を明示的に呼ぶ）。`handleFileCreate` は同じ不変条件を
   * 「失敗時はマークを触らない」という形で既に守っており、それに揃える。
   *
   * ## ここで直らないもの
   *
   * - **`set` 側は無条件上書きのまま。** 1 パス 1 値なので、そもそも 2 つのリクエストの
   *   マークは共存できない。上の 2 で A は失われており、**R1 の保存が成功していれば
   *   そちらに余計なリロードが飛ぶ**。直すには構造ごと変える必要があるので #129 に分けた
   * - **見ているのは内容の同一性で、リクエストの同一性ではない。** 同じパスへ同じバイト列を
   *   保存する 2 本（2 タブ・500 後のリトライ・同じ最終状態へのトグル）は sha が一致するので
   *   区別できない。厳密にやるなら `set` が token を返す形になる
   *
   * @param path 対象のパス
   * @param sha 自分が `set` した値。いま入っている値と違えば**何もしない**
   * @returns 実際に消したか。`false` は**別リクエストのマークが載っていた**ことを意味する
   *   （並行保存が実際に起きた、数少ない観測点）
   */
  clear(path: string, sha: string): boolean {
    if (this.map.get(path) !== sha) return false;
    this.map.delete(path);
    return true;
  }

  /**
   * すべてのマークを捨てる（サーバ停止時など）。
   *
   * **これは値を見ない削除**なので、`clear` が型で防いでいるものをすり抜けられる。
   * 「全部いらなくなった」と言い切れる場所からだけ呼ぶこと。**呼ぶ前に watcher を
   * 閉じる** —— 先に消すと、debounce 待ちの `isOwnSave` がマークを見失って
   * 「他人の変更」と判定し、まさに消したかった余計なリロードを自分で作る。
   */
  clearAll(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
