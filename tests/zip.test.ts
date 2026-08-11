/**
 * 無圧縮 ZIP の書き出し (Issue #140)。
 *
 * **自前で書いた形式なので、実物の `unzip` で開けることまで見る。** 自分の実装で
 * 読み書きして通るだけでは「同じ勘違いで書いて読んでいる」ことを排除できない
 * （CRC やヘッダのオフセットを一貫して間違えても気づけない）。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, createZip } from "../src/util/zip.ts";

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);

let work: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "yomi-zip-"));
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("crc32", () => {
  // 既知のベクタ。**自分の実装で計算した値を書かない**（それだと何も検証していない）
  test.each([
    ["", 0x0000_0000],
    ["a", 0xe8b7_be43],
    ["abc", 0x3524_41c2],
    ["123456789", 0xcbf4_3926],
  ])("`%s` の CRC-32", (input, expected) => {
    expect(crc32(bytes(input))).toBe(expected);
  });
});

describe("createZip", () => {
  test("PK シグネチャで始まり、EOCD で終わる", () => {
    const zip = createZip([{ name: "a.txt", data: bytes("hello") }]);
    expect(Array.from(zip.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const eocd = zip.slice(zip.length - 22, zip.length - 18);
    expect(Array.from(eocd)).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });

  test("同じ入力からは同じバイト列が出る（日時を固定してある）", () => {
    const make = () => createZip([{ name: "a.txt", data: bytes("x") }]);
    expect(Array.from(make())).toEqual(Array.from(make()));
  });

  test("エントリが 0 件でも壊れない", () => {
    const zip = createZip([]);
    expect(zip.length).toBe(22); // EOCD だけ
    expect(Array.from(zip.slice(0, 4))).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });

  /**
   * **zip slip を作らない。** 展開先の外へ書き出せる名前は受け取らない。
   *
   * **バックスラッシュとドライブレターも落とす** —— `split("/")` だけを見ていると
   * `..\..\evil.exe` は 1 セグメント扱いで通り、**Windows で展開したときに外へ
   * 書き出せる**。APPNOTE 4.4.17.1 も「ドライブ / デバイス名を含まず、区切りは
   * forward slash」と定めている。yomi は POSIX でしか動かないが、
   * **エントリ名は利用者の Markdown 由来**で `C:\evil.png` は POSIX では合法な名前。
   */
  test.each([
    ["../escape.png"],
    ["docs/../../escape.png"],
    ["/abs.png"],
    [""],
    ["..\\..\\evil.exe"],
    ["a\\..\\..\\b.png"],
    ["C:\\evil.exe"],
    ["c:evil.png"],
  ])("`%s` のようなエントリ名は拒否する", (name) => {
    expect(() => createZip([{ name, data: bytes("x") }])).toThrow(RangeError);
  });

  test("同名のエントリは拒否する（展開時にどちらが残るか決まらない）", () => {
    expect(() =>
      createZip([
        { name: "a.png", data: bytes("1") },
        { name: "a.png", data: bytes("2") },
      ]),
    ).toThrow(/重複/);
  });

  /**
   * **実物の `unzip` で開く。** ここが自前実装の唯一の外部検証。
   *
   * `unzip` が無い環境では skip せず**失敗させる** —— 黙って飛ばすと、
   * 形式が壊れていても CI が緑のままになる（このテストの存在意義が消える）。
   */
  test("実物の unzip で展開でき、中身とパスが一致する", async () => {
    const files = [
      { name: "docs/img/a.png", body: "PNG-A" },
      { name: "shared/b.jpg", body: "JPEG-B" },
      // **日本語のファイル名。** UTF-8 フラグを立て忘れると文字化けする
      { name: "docs/img/日本語 画像.png", body: "PNG-JA" },
      { name: "SKIPPED.txt", body: "https://example.com/x.png\n" },
    ];
    const zip = createZip(files.map((f) => ({ name: f.name, data: bytes(f.body) })));
    const zipPath = join(work, "t.zip");
    await writeFile(zipPath, zip);

    const out = join(work, "out");
    const proc = Bun.spawn(["unzip", "-q", "-o", zipPath, "-d", out], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect({ code: await proc.exited, stderr }).toEqual({ code: 0, stderr: "" });

    for (const f of files) {
      expect(await readFile(join(out, f.name), "utf-8")).toBe(f.body);
    }
  });

  test("unzip が CRC を検証して通る", async () => {
    const zip = createZip([{ name: "a.bin", data: new Uint8Array([0, 1, 2, 255, 128]) }]);
    const zipPath = join(work, "crc.zip");
    await writeFile(zipPath, zip);

    // `-t` は全エントリの CRC を突き合わせる。**ヘッダに書いた CRC が間違っていれば落ちる**
    const proc = Bun.spawn(["unzip", "-t", zipPath], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("No errors detected");
  });
});
