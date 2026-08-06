import { describe, expect, test } from "bun:test";
import {
  buildAccessibleUrls,
  isLoopback,
  isWildcard,
  listLanAddresses,
  type NetworkInterfaceEntry,
  pickBrowserUrl,
} from "../src/network.ts";

/** networkInterfaces() の戻り値を模す (Issue #81 の注入点) */
function fakeInterfaces(
  map: Record<string, NetworkInterfaceEntry[] | undefined>,
): () => Record<string, NetworkInterfaceEntry[] | undefined> {
  return () => map;
}

const ipv4 = (address: string, internal = false): NetworkInterfaceEntry => ({
  family: "IPv4",
  internal,
  address,
});
const ipv6 = (address: string, internal = false): NetworkInterfaceEntry => ({
  family: "IPv6",
  internal,
  address,
});

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

describe("listLanAddresses (固定の interface を注入)", () => {
  test("外向き IPv4 だけを拾う", () => {
    const list = listLanAddresses(
      fakeInterfaces({
        eth0: [ipv4("192.168.1.10")],
        wlan0: [ipv4("10.0.0.5")],
      }),
    );
    expect(list).toEqual(["192.168.1.10", "10.0.0.5"]);
  });

  test("internal (ループバック) は除外する", () => {
    const list = listLanAddresses(
      fakeInterfaces({
        lo: [ipv4("127.0.0.1", true)],
        eth0: [ipv4("192.168.1.10")],
      }),
    );
    expect(list).toEqual(["192.168.1.10"]);
  });

  test("IPv6 は除外する", () => {
    const list = listLanAddresses(
      fakeInterfaces({
        eth0: [ipv6("fe80::1"), ipv4("192.168.1.10"), ipv6("::1", true)],
      }),
    );
    expect(list).toEqual(["192.168.1.10"]);
  });

  test("1 つの interface が複数アドレスを持っても全部拾う", () => {
    const list = listLanAddresses(
      fakeInterfaces({ eth0: [ipv4("192.168.1.10"), ipv4("192.168.1.11")] }),
    );
    expect(list).toEqual(["192.168.1.10", "192.168.1.11"]);
  });

  test("undefined のエントリを飛ばす (node の Dict は undefined を取りうる)", () => {
    const list = listLanAddresses(fakeInterfaces({ down0: undefined, eth0: [ipv4("10.1.2.3")] }));
    expect(list).toEqual(["10.1.2.3"]);
  });

  test("外向き IPv4 が 1 つも無ければ空配列", () => {
    expect(listLanAddresses(fakeInterfaces({ lo: [ipv4("127.0.0.1", true)] }))).toEqual([]);
    expect(listLanAddresses(fakeInterfaces({}))).toEqual([]);
  });

  test("既定の呼び出し (引数なし) は OS の networkInterfaces を使い IPv4 文字列を返す", () => {
    const list = listLanAddresses();
    expect(Array.isArray(list)).toBe(true);
    for (const addr of list) {
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
    expect(pickBrowserUrl("127.0.0.1", 3939)).toBe("http://127.0.0.1:3939");
    expect(pickBrowserUrl("localhost", 3939)).toBe("http://localhost:3939");
  });

  test("任意の IP もそのまま", () => {
    expect(pickBrowserUrl("192.168.1.10", 8080)).toBe("http://192.168.1.10:8080");
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

  test("0.0.0.0 なら先頭が ローカル、続いて LAN の全アドレス (固定値を注入)", () => {
    const list = buildAccessibleUrls("0.0.0.0", 3939, () => ["192.168.1.10", "10.0.0.5"]);
    expect(list).toEqual([
      { url: "http://127.0.0.1:3939", label: "ローカル" },
      { url: "http://192.168.1.10:3939", label: "LAN" },
      { url: "http://10.0.0.5:3939", label: "LAN" },
    ]);
  });

  test(":: も wildcard として同じ扱い", () => {
    const list = buildAccessibleUrls("::", 3939, () => ["192.168.1.10"]);
    expect(list).toEqual([
      { url: "http://127.0.0.1:3939", label: "ローカル" },
      { url: "http://192.168.1.10:3939", label: "LAN" },
    ]);
  });

  test("LAN アドレスが 1 つも無ければ ローカル だけ", () => {
    expect(buildAccessibleUrls("0.0.0.0", 3939, () => [])).toEqual([
      { url: "http://127.0.0.1:3939", label: "ローカル" },
    ]);
  });

  test("wildcard でなければ LAN の列挙を行わない", () => {
    let called = 0;
    const list = buildAccessibleUrls("127.0.0.1", 3939, () => {
      called += 1;
      return ["192.168.1.10"];
    });
    expect(called).toBe(0);
    expect(list).toHaveLength(1);
  });

  test("既定の呼び出し (第 3 引数なし) でも先頭は ローカル で LAN が続く", () => {
    const list = buildAccessibleUrls("0.0.0.0", 3939);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]).toEqual({ url: "http://127.0.0.1:3939", label: "ローカル" });
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
