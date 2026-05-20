import { describe, expect, test } from "bun:test";
import { computeStrongEtag } from "../../src/util/etag.ts";

describe("computeStrongEtag (Issue #23)", () => {
  test('`"<32 hex 文字>"` 形式の strong ETag を返す', () => {
    const etag = computeStrongEtag(new Uint8Array([1, 2, 3]));
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
  });

  test("同じ内容 → 同じ ETag (決定的)", () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5]);
    expect(computeStrongEtag(buf)).toBe(computeStrongEtag(buf));
  });

  test("内容が違えば ETag も違う (1 byte 差)", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 4]);
    expect(computeStrongEtag(a)).not.toBe(computeStrongEtag(b));
  });

  test("空の入力でも形式は壊れない", () => {
    const etag = computeStrongEtag(new Uint8Array([]));
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
  });

  test("Buffer / Uint8Array / ArrayBuffer すべて受け付ける", () => {
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const fromUint8 = computeStrongEtag(data);
    const fromBuffer = computeStrongEtag(Buffer.from(data));
    const fromArrayBuf = computeStrongEtag(data.buffer);
    expect(fromUint8).toBe(fromBuffer);
    expect(fromUint8).toBe(fromArrayBuf);
  });
});
