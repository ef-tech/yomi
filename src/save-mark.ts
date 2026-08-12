import { createHash } from "node:crypto";

const DEFAULT_MAX_ENTRIES = 64;

/**
 * 1 パスあたりに残すマークの数 (Issue #129)。
 *
 * **並行して走りうる保存の本数**を賄えればよい。実際に同じファイルへ同時に飛ぶのは
 * せいぜい 2〜3 本（エディタの多重送信、プレビューのチェックボックス連打）なので、
 * 4 で余裕がある。
 *
 * **大きくするほど誤抑止の窓が広がる。** マークは内容の同一性で判定するので、
 * 残っている sha と同じ内容を**外部エディタが書いた**ら「自分の保存」と誤認して
 * リロードを飛ばさない。1 本だけ残していた頃は「直前に保存した内容へ戻したとき」
 * だけだったが、4 本残すと「直近 4 回ぶんのどれかへ戻したとき」に広がる。
 * この幅は `tests/save-mark.test.ts` が固定している。
 */
const DEFAULT_MAX_PER_PATH = 4;

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
 *
 * ## 1 パスに複数のマークを持つ (Issue #129)
 *
 * **以前は 1 パス 1 値だった。** そのため同じファイルへ 2 本の保存が並行すると、
 * 後から来たほうが**先のマークを消してしまい**、先の保存が watcher から
 * 「他人の変更」に見えて余計なリロードが飛んだ:
 *
 * 1. R1 が `set(X)` → map = X
 * 2. R1 の書き込みが成功 → chokidar の `change` → 80ms の debounce が始まる
 * 3. R2 が `set(Y)` → map = Y ← **ここで R1 のマークが消える**
 * 4. debounce 発火 → `isOwnSave` が実ファイル（= X）を読む → 一致しない
 * 5. **X を保存した側の画面に余計なリロード**
 *
 * #120 は「消す側」（`clear`）だけを直しており、この経路は残っていた。
 * **並行する保存のマークが共存できる**ようにして塞ぐ。
 *
 * ## 限界（構造を変えても残るもの）
 *
 * **見ているのは内容の同一性で、リクエストの同一性ではない。** 同じパスへ同じバイト列を
 * 保存する 2 本（2 タブ・500 後のリトライ・同じ最終状態へのトグル）は sha が一致するので
 * 区別できない。厳密にやるなら `set` が token を返す形になるが、**`isOwnSave` は
 * ファイルを読んで sha を出すことしかできない**ので、判定側は内容でしか引けない
 * （token にしても `has` が引けなくなるだけ）。
 */
export class SaveMark {
  /** path -> その path に立っているマーク（挿入順 = 古い順）。 */
  private readonly map = new Map<string, Set<string>>();
  private readonly max: number;
  private readonly maxPerPath: number;

  constructor(max: number = DEFAULT_MAX_ENTRIES, maxPerPath: number = DEFAULT_MAX_PER_PATH) {
    this.max = max;
    this.maxPerPath = maxPerPath;
  }

  /**
   * マークを 1 つ立てる。**同じ path の既存マークは消さない** (Issue #129)。
   *
   * 上限は 2 段階:
   * - **パス数**は `max`（従来どおり LRU で古いパスから捨てる）
   * - **1 パスあたりのマーク数**は `maxPerPath`（古いマークから捨てる）
   */
  set(path: string, sha: string): void {
    let shas = this.map.get(path);
    if (shas) {
      // 触ったパスを最後尾へ（LRU）
      this.map.delete(path);
    } else {
      shas = new Set<string>();
      if (this.map.size >= this.max) {
        const oldest = this.map.keys().next().value;
        if (oldest !== undefined) this.map.delete(oldest);
      }
    }
    // 同じ sha を 2 つ持たない。再登録は「新しいほう」として並べ直す
    shas.delete(sha);
    shas.add(sha);
    // **古いマークから捨てる。** 残しすぎると誤抑止の窓が広がる（`DEFAULT_MAX_PER_PATH`）
    while (shas.size > this.maxPerPath) {
      const oldestSha = shas.keys().next().value;
      if (oldestSha === undefined) break;
      shas.delete(oldestSha);
    }
    this.map.set(path, shas);
  }

  has(path: string, sha: string): boolean {
    return this.map.get(path)?.has(sha) ?? false;
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
   * **`set` 側は #129 で直した。** 1 パスに複数のマークを持てるようになったので、
   * ここで消すのも**自分の 1 件だけ**で、並行する別リクエストのマークは残る。
   *
   * 残る限界はクラスの docstring（内容の同一性でしか引けない）を参照。
   *
   * @param path 対象のパス
   * @param sha 自分が `set` した値。**その 1 件だけ**を消す
   * @returns 実際に消したか。`false` は**自分のマークがもう無かった**ことを意味する
   *   （上限で押し出された・既に消した、など）
   */
  clear(path: string, sha: string): boolean {
    const shas = this.map.get(path);
    if (!shas?.delete(sha)) return false;
    // 空になった path は残さない（`size` はパス数を数えるので、幽霊が残ると狂う）
    if (shas.size === 0) this.map.delete(path);
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

  /** マークが立っている**パスの数**（マークの総数ではない）。LRU の上限はこちらに掛かる。 */
  get size(): number {
    return this.map.size;
  }

  /**
   * 立っているマークの**総数** (Issue #129)。
   *
   * `size`（パス数）と分ける。1 パスに複数持つようになったので、
   * **「溜まり続けていないか」はこちらでしか見られない**。
   */
  get markCount(): number {
    let n = 0;
    for (const shas of this.map.values()) n += shas.size;
    return n;
  }
}
