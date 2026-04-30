import { describe, expect, test } from "bun:test";
import {
  buildAccessibleUrls,
  isLoopback,
  isWildcard,
  listLanAddresses,
  pickBrowserUrl,
} from "../src/network.ts";

describe("isLoopback", () => {
  test("ループバックアドレスを認識", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
  });

  test("非ループバックは false", () => {
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("192.168.1.1")).toBe(false);
    expect(isLoopback("8.8.8.8")).toBe(false);
  });
});

describe("isWildcard", () => {
  test("0.0.0.0 と :: が wildcard", () => {
    expect(isWildcard("0.0.0.0")).toBe(true);
    expect(isWildcard("::")).toBe(true);
  });

  test("それ以外は false", () => {
    expect(isWildcard("127.0.0.1")).toBe(false);
    expect(isWildcard("localhost")).toBe(false);
    expect(isWildcard("192.168.1.1")).toBe(false);
  });
});

describe("listLanAddresses", () => {
  test("配列を返す (内容は OS 依存なので形のみ検証)", () => {
    const list = listLanAddresses();
    expect(Array.isArray(list)).toBe(true);
    // 各要素は IPv4 文字列のはず
    for (const addr of list) {
      expect(typeof addr).toBe("string");
      expect(addr).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    }
  });
});

describe("pickBrowserUrl", () => {
  test("0.0.0.0 は localhost に置換", () => {
    expect(pickBrowserUrl("0.0.0.0", 3939)).toBe("http://127.0.0.1:3939");
    expect(pickBrowserUrl("::", 3939)).toBe("http://127.0.0.1:3939");
  });

  test("ループバックはそのまま", () => {
    expect(pickBrowserUrl("127.0.0.1", 3939)).toBe(
      "http://127.0.0.1:3939",
    );
    expect(pickBrowserUrl("localhost", 3939)).toBe(
      "http://localhost:3939",
    );
  });

  test("任意の IP もそのまま", () => {
    expect(pickBrowserUrl("192.168.1.10", 8080)).toBe(
      "http://192.168.1.10:8080",
    );
  });
});

describe("buildAccessibleUrls", () => {
  test("ループバックなら 1 件、ラベルは ローカル", () => {
    const list = buildAccessibleUrls("127.0.0.1", 3939);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      url: "http://127.0.0.1:3939",
      label: "ローカル",
    });
  });

  test("ローカル以外の固定アドレスならラベルは ホスト", () => {
    const list = buildAccessibleUrls("192.168.1.10", 3939);
    expect(list).toHaveLength(1);
    expect(list[0]?.label).toBe("ホスト");
    expect(list[0]?.url).toBe("http://192.168.1.10:3939");
  });

  test("0.0.0.0 なら先頭が ローカル、続いて LAN (件数は OS 依存)", () => {
    const list = buildAccessibleUrls("0.0.0.0", 3939);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]?.url).toBe("http://127.0.0.1:3939");
    expect(list[0]?.label).toBe("ローカル");
    for (const u of list.slice(1)) {
      expect(u.label).toBe("LAN");
      expect(u.url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:3939$/);
    }
  });

  test("ポート番号が URL に反映される", () => {
    const list = buildAccessibleUrls("127.0.0.1", 8080);
    expect(list[0]?.url).toBe("http://127.0.0.1:8080");
  });
});
