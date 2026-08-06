import { networkInterfaces } from "node:os";

export interface ResolvedAddress {
  /** ブラウザでアクセスする URL */
  url: string;
  /** 表示時のラベル (例: "ローカル", "LAN") */
  label: string;
}

/**
 * `node:os` の networkInterfaces() が返すエントリのうち、ここで使う項目だけ (Issue #81)。
 * 実物より狭く定義してあるので、テストからは 3 項目だけのオブジェクトを渡せばよい。
 */
export interface NetworkInterfaceEntry {
  family: string;
  internal: boolean;
  address: string;
}

/** networkInterfaces() 相当。テストから固定値を返す関数に差し替える (Issue #81) */
export type ReadNetworkInterfaces = () => Record<string, NetworkInterfaceEntry[] | undefined>;

/** listLanAddresses() 相当。テストから固定のアドレス一覧に差し替える (Issue #81) */
export type ListLanAddresses = () => string[];

const LOOPBACK_HOSTS = new Set<string>(["127.0.0.1", "localhost", "::1"]);
const ANY_HOSTS = new Set<string>(["0.0.0.0", "::"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export function isWildcard(host: string): boolean {
  return ANY_HOSTS.has(host);
}

/**
 * LAN から到達できる IPv4 アドレスを列挙する。
 *
 * `readInterfaces` は既定で OS の `networkInterfaces()`。テストからは固定値を返す関数を
 * 渡して、IPv4 以外・internal の除外という**選別ロジック自体**を環境非依存に検証する
 * (Issue #81)。省略時の挙動は従来と同じ。
 */
export function listLanAddresses(
  readInterfaces: ReadNetworkInterfaces = networkInterfaces,
): string[] {
  const result: string[] = [];
  const ifaces = readInterfaces();
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
 *
 * `listLan` は既定で `listLanAddresses`。テストからは固定のアドレス一覧を渡して、
 * **URL とラベルの組み立て**を環境非依存に検証する (Issue #81)。省略時の挙動は従来と同じ。
 */
export function buildAccessibleUrls(
  host: string,
  port: number,
  listLan: ListLanAddresses = listLanAddresses,
): ResolvedAddress[] {
  if (isWildcard(host)) {
    const list: ResolvedAddress[] = [{ url: `http://127.0.0.1:${port}`, label: "ローカル" }];
    for (const ip of listLan()) {
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
