import { describe, expect, test } from "bun:test";
import { buildStartupBanner } from "../src/banner.ts";

describe("buildStartupBanner", () => {
  test("ループバックは ローカル URL のみ + 警告なし", () => {
    const banner = buildStartupBanner({
      rootDir: "/tmp/docs",
      host: "127.0.0.1",
      port: 3939,
    });
    expect(banner).toContain("yomi が起動しました");
    expect(banner).toContain("ローカル");
    expect(banner).toContain("http://127.0.0.1:3939");
    expect(banner).toContain("対象ディレクトリ: /tmp/docs");
    expect(banner).toContain("停止するには Ctrl+C");
    // 警告は出ない
    expect(banner).not.toContain("認証なし");
    expect(banner).not.toContain("--host 127.0.0.1");
  });

  test("0.0.0.0 (wildcard) は LAN 警告とローカル限定 hint を含む", () => {
    const banner = buildStartupBanner({
      rootDir: "/tmp/docs",
      host: "0.0.0.0",
      port: 3939,
    });
    expect(banner).toContain("yomi が起動しました");
    expect(banner).toContain("ローカル");
    expect(banner).toContain("http://127.0.0.1:3939");
    expect(banner).toContain("認証なしでネットワークに公開");
    expect(banner).toContain("ローカル限定にするには --host 127.0.0.1");
  });

  test("固定 IP (非ループバック) は警告ありだが --host hint なし", () => {
    const banner = buildStartupBanner({
      rootDir: "/tmp/docs",
      host: "192.168.1.10",
      port: 8080,
    });
    expect(banner).toContain("http://192.168.1.10:8080");
    expect(banner).toContain("認証なしでネットワークに公開");
    expect(banner).not.toContain("ローカル限定にするには");
  });

  test("ポート番号が URL に正しく反映される", () => {
    const banner = buildStartupBanner({
      rootDir: "/x",
      host: "127.0.0.1",
      port: 12345,
    });
    expect(banner).toContain("http://127.0.0.1:12345");
  });
});
