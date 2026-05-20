/**
 * 内容ベースの強 ETag を計算する純関数。
 *
 * Issue #22 で `/api/asset` の ETag を sha256 prefix に変更した経緯を踏まえ、
 * テストしやすいよう Bun.CryptoHasher の呼び出しを 1 箇所に集約する。
 *
 * - 戻り値: `"<16 byte = 32 hex 文字>"` 形式 (RFC 9110 の strong ETag)
 * - Bun ランタイム前提 (Bun.CryptoHasher を使用)
 */
export function computeStrongEtag(buffer: Uint8Array | ArrayBuffer | Buffer): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(buffer);
  return `"${hasher.digest("hex").slice(0, 32)}"`;
}
