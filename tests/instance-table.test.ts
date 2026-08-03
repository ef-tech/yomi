import { describe, expect, test } from "bun:test";
import { buildListOutput, NO_INSTANCES_MESSAGE, visibilityLabel } from "../src/instance-table.ts";
import type { InstanceRecord } from "../src/instances.ts";

function record(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    pid: 12345,
    port: 3939,
    host: "127.0.0.1",
    rootDir: "/home/user/docs",
    startedAt: "2026-08-04T00:00:00.000Z",
    logPath: "/state/yomi/logs/3939.log",
    version: "0.0.0-test",
    ...overrides,
  };
}

describe("visibilityLabel (Issue #69)", () => {
  test("ループバックは local", () => {
    expect(visibilityLabel("127.0.0.1")).toBe("local");
    expect(visibilityLabel("localhost")).toBe("local");
    expect(visibilityLabel("::1")).toBe("local");
  });

  test("--share の 0.0.0.0 は share", () => {
    expect(visibilityLabel("0.0.0.0")).toBe("share");
    expect(visibilityLabel("::")).toBe("share");
  });

  test("--host で LAN アドレスを直接指定した場合も share (外から見えることに変わりない)", () => {
    expect(visibilityLabel("192.168.1.10")).toBe("share");
  });
});

describe("buildListOutput (Issue #69)", () => {
  test("0 件なら案内文だけを返す", () => {
    expect(buildListOutput([])).toBe(NO_INSTANCES_MESSAGE);
    expect(NO_INSTANCES_MESSAGE).toBe("起動中の yomi はありません");
  });

  test("見出しは PID / PORT / PUBLIC / DIR", () => {
    const lines = buildListOutput([record()]).split("\n");
    expect(lines[0]).toMatch(/^PID\s+PORT\s+PUBLIC\s+DIR$/);
  });

  test("1 件の内容がすべて並ぶ", () => {
    const output = buildListOutput([
      record({ pid: 4242, port: 8080, host: "0.0.0.0", rootDir: "/srv/docs" }),
    ]);
    const row = output.split("\n")[1] as string;
    expect(row).toContain("4242");
    expect(row).toContain("8080");
    expect(row).toContain("share");
    expect(row).toContain("/srv/docs");
  });

  test("複数件はレジストリの並び順のまま出す", () => {
    const output = buildListOutput([
      record({ pid: 1, port: 3939, rootDir: "/a" }),
      record({ pid: 2, port: 3940, host: "0.0.0.0", rootDir: "/b" }),
    ]);
    const lines = output.split("\n");
    expect(lines).toHaveLength(3); // 見出し + 2 行
    expect(lines[1]).toContain("/a");
    expect(lines[2]).toContain("/b");
  });

  describe("列の整形", () => {
    test("桁数の違う値でも DIR の開始位置が揃う", () => {
      const output = buildListOutput([
        record({ pid: 7, port: 80, rootDir: "/short" }),
        record({ pid: 1234567, port: 65535, host: "0.0.0.0", rootDir: "/long/path" }),
      ]);
      const lines = output.split("\n");
      expect(lines[1]?.indexOf("/short")).toBe(lines[2]?.indexOf("/long/path") as number);
      // 見出しの DIR も同じ位置から始まる
      expect(lines[0]?.indexOf("DIR")).toBe(lines[1]?.indexOf("/short") as number);
    });

    test("値が見出しより短くても見出し幅を割らない", () => {
      // PUBLIC(6) > local(5) なので、PUBLIC の幅は見出しに合わせる
      const lines = buildListOutput([record({ pid: 1, port: 80 })]).split("\n");
      expect(lines[0]?.indexOf("DIR")).toBe(lines[1]?.indexOf("/home/user/docs") as number);
    });

    test("長いパスは切り詰めず、80 桁を超えても見出しとの対応が崩れない", () => {
      const longDir = `/very/long/path/${"segment/".repeat(12)}docs`;
      expect(longDir.length).toBeGreaterThan(80);

      const lines = buildListOutput([record({ rootDir: longDir })]).split("\n");
      // 切り詰め (…) をしない
      expect(lines[1]).toContain(longDir);
      // DIR は最終列なので、溢れても前の 3 列の位置は変わらない
      expect(lines[0]?.indexOf("DIR")).toBe(lines[1]?.indexOf(longDir) as number);
    });

    test("列の区切りは 2 スペース以上あり、値同士がくっつかない", () => {
      const row = buildListOutput([record({ pid: 1234567, port: 65535 })]).split("\n")[1] as string;
      expect(row).toMatch(/^1234567\s{2,}65535\s{2,}local\s{2,}\/home\/user\/docs$/);
    });
  });
});
