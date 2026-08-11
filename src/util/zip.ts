/**
 * 無圧縮（store）だけの最小 ZIP 書き出し (Issue #140)。
 *
 * ## なぜ自前で書くか
 *
 * **圧縮しないので圧縮ライブラリが要らない。** この zip に入れるのは png / jpg / webp /
 * avif といった**既に圧縮済みの画像**で、deflate を掛けても縮まない（むしろ CPU を使う）。
 * store だけなら必要なのは CRC-32 とヘッダの組み立てだけで、この 1 ファイルに収まる。
 *
 * 実行時依存は `chokidar` と `marked` の 2 つに保ちたい（ローカルで動かす小さい道具なので、
 * 依存が増えるほど「入れて動かす」が重くなる）。**必要になったら差し替えられる**ように、
 * 外からは {@link createZip} 1 つだけを見せる。
 *
 * ## 作るもの
 *
 * PKZIP の最小形（APPNOTE 4.3）。1 エントリにつき
 *
 * - ローカルファイルヘッダ + ファイル名 + データ
 * - セントラルディレクトリのエントリ
 *
 * を書き、最後に EOCD を置く。**data descriptor は使わない**（サイズと CRC を先に
 * 計算できるので、ローカルヘッダにそのまま書ける）。
 *
 * ## 対象外
 *
 * - **ZIP64 は実装していない。** 4GiB 以上、または 65,535 エントリ以上は表現できないので
 *   {@link createZip} が投げる。呼び出し側が上限を掛ける前提（`MAX_ZIP_BYTES`）
 * - 暗号化・分割・タイムスタンプの保存（すべて固定値を書く）
 */

/** エントリ名の最大長（バイト）。ZIP の仕様上 16bit に収まる必要がある。 */
const MAX_NAME_BYTES = 0xffff;
/** ZIP64 なしで表現できる上限。超えたら投げる。 */
const MAX_UINT32 = 0xffff_ffff;
const MAX_ENTRIES = 0xffff;

/**
 * CRC-32（IEEE 802.3）のテーブル。**初回だけ作る。**
 *
 * 画像 1 枚ごとに全バイトを舐めるので、毎回テーブルを作り直すとエントリ数ぶん無駄になる。
 */
let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      // 0xedb88320 は 0x04c11db7 のビット反転（LSB-first の実装で使う定数）
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** CRC-32 を計算する。ZIP のヘッダに書く値。 */
export function crc32(data: Uint8Array): number {
  const table = getCrcTable();
  let c = 0xffff_ffff;
  for (let i = 0; i < data.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: 添字は length 未満、table は 256 要素で網羅
    c = table[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffff_ffff) >>> 0;
}

/** zip に入れる 1 件。`name` は zip 内のパス（`/` 区切り、`..` を含まないこと）。 */
export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** リトルエンディアンで書き進める小さなライタ。 */
class Writer {
  private readonly view: DataView;
  offset = 0;

  constructor(public readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u16(v: number): void {
    this.view.setUint16(this.offset, v, true);
    this.offset += 2;
  }

  u32(v: number): void {
    this.view.setUint32(this.offset, v, true);
    this.offset += 4;
  }

  raw(v: Uint8Array): void {
    this.bytes.set(v, this.offset);
    this.offset += v.length;
  }
}

/**
 * エントリを ZIP のバイト列にまとめる。
 *
 * **すべてメモリ上で組み立てる。** 呼び出し側が合計サイズに上限を掛けている前提
 * （画像をすべて載せるので、上限が無いと大きな記事で詰まる）。
 *
 * @throws エントリ名が重複している / 空 / `..` を含む / 65,535 バイトを超える場合
 * @throws エントリ数か合計サイズが ZIP64 なしの上限を超える場合
 */
export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) {
    throw new RangeError(`zip のエントリが多すぎます (${entries.length} > ${MAX_ENTRIES})`);
  }

  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const prepared = entries.map((e) => {
    // **エントリ名を検証する。** `..` を含む名前は展開時に外へ書き出せてしまう（zip slip）。
    // 呼び出し側が root 相対パスを渡す約束だが、**ここでも弾く**（この関数だけを見て安全と
    // 言えるようにする。将来ほかの用途で使われたときに約束が伝わらない）
    if (!e.name || e.name.startsWith("/") || e.name.split("/").includes("..")) {
      throw new RangeError(`zip のエントリ名が不正です: ${JSON.stringify(e.name)}`);
    }
    if (seen.has(e.name)) {
      throw new RangeError(`zip のエントリ名が重複しています: ${JSON.stringify(e.name)}`);
    }
    seen.add(e.name);

    const name = encoder.encode(e.name);
    if (name.length > MAX_NAME_BYTES) {
      throw new RangeError(`zip のエントリ名が長すぎます: ${JSON.stringify(e.name)}`);
    }
    if (e.data.length > MAX_UINT32) {
      throw new RangeError(`zip のエントリが大きすぎます: ${JSON.stringify(e.name)}`);
    }
    return { name, data: e.data, crc: crc32(e.data) };
  });

  const LOCAL_HEADER = 30;
  const CENTRAL_HEADER = 46;
  const EOCD = 22;

  const localSize = prepared.reduce((n, e) => n + LOCAL_HEADER + e.name.length + e.data.length, 0);
  const centralSize = prepared.reduce((n, e) => n + CENTRAL_HEADER + e.name.length, 0);
  const total = localSize + centralSize + EOCD;
  if (total > MAX_UINT32) {
    throw new RangeError(`zip が大きすぎます (${total} バイト)。ZIP64 は未対応です`);
  }

  const w = new Writer(new Uint8Array(total));
  const offsets: number[] = [];

  // **汎用フラグの bit 11 を立てる。** ファイル名を UTF-8 と宣言する印で、
  // 立てないと日本語のファイル名が展開側で CP437 と解釈されて文字化けする
  const FLAG_UTF8 = 0x0800;
  const METHOD_STORE = 0;
  // 日時は固定値（1980-01-01 00:00:00 = ZIP のエポック）。**再現可能にするため**で、
  // 同じ入力からは必ず同じバイト列が出る（テストで比較できる）
  const DOS_TIME = 0;
  const DOS_DATE = 0x0021;

  for (const e of prepared) {
    offsets.push(w.offset);
    w.u32(0x0403_4b50); // ローカルファイルヘッダ signature
    w.u16(20); // version needed to extract (2.0)
    w.u16(FLAG_UTF8);
    w.u16(METHOD_STORE);
    w.u16(DOS_TIME);
    w.u16(DOS_DATE);
    w.u32(e.crc);
    w.u32(e.data.length); // compressed size（store なので同じ）
    w.u32(e.data.length); // uncompressed size
    w.u16(e.name.length);
    w.u16(0); // extra field length
    w.raw(e.name);
    w.raw(e.data);
  }

  const centralStart = w.offset;
  for (const [i, e] of prepared.entries()) {
    w.u32(0x0201_4b50); // セントラルディレクトリ signature
    w.u16(20); // version made by
    w.u16(20); // version needed to extract
    w.u16(FLAG_UTF8);
    w.u16(METHOD_STORE);
    w.u16(DOS_TIME);
    w.u16(DOS_DATE);
    w.u32(e.crc);
    w.u32(e.data.length);
    w.u32(e.data.length);
    w.u16(e.name.length);
    w.u16(0); // extra field length
    w.u16(0); // file comment length
    w.u16(0); // disk number start
    w.u16(0); // internal file attributes
    // 外部属性: 0644 を上位 16bit に置く（Unix の展開ツールがパーミッションとして読む）
    w.u32(0o100644 << 16);
    // biome-ignore lint/style/noNonNullAssertion: offsets は同じループで同数積んである
    w.u32(offsets[i]!);
    w.raw(e.name);
  }

  w.u32(0x0605_4b50); // EOCD signature
  w.u16(0); // このディスクの番号
  w.u16(0); // セントラルディレクトリが始まるディスク
  w.u16(prepared.length);
  w.u16(prepared.length);
  w.u32(centralSize); // セントラルディレクトリのサイズ
  w.u32(centralStart);
  w.u16(0); // コメント長

  return w.bytes;
}
