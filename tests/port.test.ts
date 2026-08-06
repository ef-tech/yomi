import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  DEFAULT_START_PORT,
  findAvailablePort,
  isPortAvailable,
  PORT_SCAN_LIMIT,
  type PortProbe,
} from "../src/port.ts";

/**
 * Issue #81: findAvailablePort の走査ロジックを、実際にソケットを bind せずに検証する。
 *
 * 実 bind に頼ると「他プロセスがそのポートを掴んでいるか」で結果が変わり、CI と手元で
 * 挙動が揺れる。空き判定を注入して固定すれば、順序・上限・打ち切りを決定的に検証できる。
 */

/** 指定したポート群だけを「空き」と答える probe。問い合わせ順も記録する */
function probeAllowing(available: number[]): PortProbe & { asked: number[] } {
  const asked: number[] = [];
  const fn = async (_host: string, port: number) => {
    asked.push(port);
    return available.includes(port);
  };
  return Object.assign(fn, { asked });
}

describe("findAvailablePort (空き判定を注入)", () => {
  test("開始ポートが空いていればそれを返し、そこで走査を止める", async () => {
    const probe = probeAllowing([3939]);
    await expect(findAvailablePort("127.0.0.1", 3939, 50, probe)).resolves.toBe(3939);
    expect(probe.asked).toEqual([3939]);
  });

  test("塞がっていれば 1 ずつ上げて最初の空きを返す", async () => {
    const probe = probeAllowing([3942]);
    await expect(findAvailablePort("127.0.0.1", 3939, 50, probe)).resolves.toBe(3942);
    expect(probe.asked).toEqual([3939, 3940, 3941, 3942]);
  });

  test("limit の範囲内で全部塞がっていれば、試した範囲を書いて throw する", async () => {
    const probe = probeAllowing([]);
    await expect(findAvailablePort("127.0.0.1", 4000, 3, probe)).rejects.toThrow(
      "空きポートが見つかりません (4000〜4002 を試行)",
    );
    expect(probe.asked).toEqual([4000, 4001, 4002]);
  });

  test("limit の 1 つ外側は見に行かない", async () => {
    const probe = probeAllowing([4003]);
    await expect(findAvailablePort("127.0.0.1", 4000, 3, probe)).rejects.toThrow();
    expect(probe.asked).not.toContain(4003);
  });

  test("limit ちょうど最後のポートが空いていれば拾える (境界)", async () => {
    const probe = probeAllowing([4002]);
    await expect(findAvailablePort("127.0.0.1", 4000, 3, probe)).resolves.toBe(4002);
  });

  test("host はそのまま probe へ渡る", async () => {
    const hosts: string[] = [];
    const probe: PortProbe = async (host, _port) => {
      hosts.push(host);
      return true;
    };
    await findAvailablePort("0.0.0.0", 5000, 50, probe);
    expect(hosts).toEqual(["0.0.0.0"]);
  });

  test("startPort / limit を省略すると既定値を使う", async () => {
    const probe = probeAllowing([]);
    await expect(findAvailablePort("127.0.0.1", undefined, undefined, probe)).rejects.toThrow();
    expect(probe.asked[0]).toBe(DEFAULT_START_PORT);
    expect(probe.asked).toHaveLength(PORT_SCAN_LIMIT);
    expect(probe.asked.at(-1)).toBe(DEFAULT_START_PORT + PORT_SCAN_LIMIT - 1);
  });
});

describe("isPortAvailable (実ソケット)", () => {
  test("誰も使っていないポートは空きと判定する", async () => {
    // 一度 bind して解放したポートは、直後は空いているとみなせる
    const port = await findAvailablePort("127.0.0.1", 39100);
    await expect(isPortAvailable("127.0.0.1", port)).resolves.toBe(true);
  });

  test("使用中のポートは空きでないと判定する", async () => {
    const port = await findAvailablePort("127.0.0.1", 39200);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      await expect(isPortAvailable("127.0.0.1", port)).resolves.toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("findAvailablePort (既定の probe = 実ソケット)", () => {
  test("使用中のポートを飛ばして次の空きを返す", async () => {
    const start = await findAvailablePort("127.0.0.1", 39300);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(start, "127.0.0.1", resolve));
    try {
      // probe を渡さない = 従来どおりの経路。塞いだポートは飛ばされる
      const next = await findAvailablePort("127.0.0.1", start);
      expect(next).toBeGreaterThan(start);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
