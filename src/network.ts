import { networkInterfaces } from "node:os";

export interface ResolvedAddress {
  /** ブラウザでアクセスする URL */
  url: string;
  /** 表示時のラベル (例: "ローカル", "LAN") */
  label: string;
}

const LOOPBACK_HOSTS = new Set<string>(["127.0.0.1", "localhost", "::1"]);
const ANY_HOSTS = new Set<string>(["0.0.0.0", "::"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export function isWildcard(host: string): boolean {
  return ANY_HOSTS.has(host);
}

export function listLanAddresses(): string[] {
  const result: string[] = [];
  const ifaces = networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== "IPv4") continue;
      if (addr.internal) continue;
      result.push(addr.address);
    }
  }
  return result;
}

/**
 * 起動時に表示するアクセス可能な URL のリストを組み立てる。
 * - host が 0.0.0.0 の場合: localhost と LAN IP を並べる
 * - host がループバックの場合: そのアドレスのみ
 * - それ以外: そのアドレスのみ
 */
export function buildAccessibleUrls(host: string, port: number): ResolvedAddress[] {
  if (isWildcard(host)) {
    const list: ResolvedAddress[] = [{ url: `http://127.0.0.1:${port}`, label: "ローカル" }];
    for (const ip of listLanAddresses()) {
      list.push({ url: `http://${ip}:${port}`, label: "LAN" });
    }
    return list;
  }
  return [
    {
      url: `http://${host}:${port}`,
      label: isLoopback(host) ? "ローカル" : "ホスト",
    },
  ];
}

/** ブラウザ自動オープン用の URL (0.0.0.0 のような無効値を避ける) */
export function pickBrowserUrl(host: string, port: number): string {
  if (isWildcard(host)) return `http://127.0.0.1:${port}`;
  return `http://${host}:${port}`;
}
