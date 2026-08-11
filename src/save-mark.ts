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
   * **`sha` を必須にして、無条件削除を書けなくしてある。** `handleFileCreate` は
   * 同じ不変条件を「失敗時はマークを触らない」という形で既に守っており、それに揃える。
   *
   * @param path 対象のパス
   * @param sha 自分が `set` した値。いま入っている値と違えば**何もしない**
   * @returns 実際に消したかどうか
   */
  clear(path: string, sha: string): boolean {
    if (this.map.get(path) !== sha) return false;
    this.map.delete(path);
    return true;
  }

  /** すべてのマークを捨てる（サーバ停止時など）。 */
  clearAll(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
