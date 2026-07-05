import { describe, expect, test } from "bun:test";
import { buildCsp } from "../src/server.ts";

/** Host ヘッダ付きの Request を組み立てる (buildCsp は Host から ws:// を導出する)。 */
function reqWithHost(host: string | null): Request {
  const headers = new Headers();
  if (host !== null) headers.set("host", host);
  return new Request("http://placeholder/", { headers });
}

describe("buildCsp (Issue #52)", () => {
  test("外部 script を禁止する (script-src 'self')", () => {
    const csp = buildCsp(reqWithHost("127.0.0.1:3939"));
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("default-src 'self'");
    // jsDelivr 等の外部ホストは許可しない
    expect(csp).not.toContain("jsdelivr");
    expect(csp).not.toContain("https://cdn");
  });

  test("Mermaid の inline style のため style-src に 'unsafe-inline' を含む", () => {
    expect(buildCsp(reqWithHost("127.0.0.1:3939"))).toContain("style-src 'self' 'unsafe-inline'");
  });

  test("user markdown のリモート画像/メディアを壊さない (img-src / media-src に http/https)", () => {
    const csp = buildCsp(reqWithHost("127.0.0.1:3939"));
    expect(csp).toContain("img-src 'self' data: http: https:");
    expect(csp).toContain("media-src 'self' http: https:");
  });

  test("connect-src に Host 由来の ws:// と wss:// を明示する (ライブリロード /ws, TLS プロキシ対応)", () => {
    const csp = buildCsp(reqWithHost("127.0.0.1:3939"));
    expect(csp).toContain("connect-src 'self' ws://127.0.0.1:3939 wss://127.0.0.1:3939");
    const lan = buildCsp(reqWithHost("192.168.0.100:3939"));
    expect(lan).toContain("ws://192.168.0.100:3939");
    expect(lan).toContain("wss://192.168.0.100:3939");
  });

  test("clickjacking / object 埋め込みを禁止する", () => {
    const csp = buildCsp(reqWithHost("127.0.0.1:3939"));
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  test("不正な Host はヘッダ注入を防ぐため ws:// を付けない", () => {
    // 空白や ; を含む細工された Host は connect-src へ差し込まない (CSP 注入対策)。
    const csp = buildCsp(reqWithHost("evil; script-src *"));
    expect(csp).not.toContain("script-src *");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("ws://evil");
  });

  test("Host が無ければ connect-src は 'self' のみ", () => {
    const csp = buildCsp(reqWithHost(null));
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("ws://");
  });
});
