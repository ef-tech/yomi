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

  clear(path?: string): void {
    if (path === undefined) this.map.clear();
    else this.map.delete(path);
  }

  get size(): number {
    return this.map.size;
  }
}
