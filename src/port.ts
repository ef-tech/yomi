import { createServer } from "node:net";

export const DEFAULT_START_PORT = 3939;
export const PORT_SCAN_LIMIT = 50;

/** isPortAvailable() 相当。テストから固定の判定を返す関数に差し替える (Issue #81) */
export type PortProbe = (host: string, port: number) => Promise<boolean>;

/**
 * startPort から limit 個ぶん順に走査して、最初に空いているポートを返す。
 *
 * `probe` は既定で `isPortAvailable`。テストからは固定の判定を返す関数を渡して、
 * **走査の順序・上限・打ち切り時のエラー**を、実際にソケットを bind せずに検証する
 * (Issue #81)。実 bind に頼ると、他プロセスが同じポートを掴んでいるかで結果が変わる。
 * 省略時の挙動は従来と同じ。
 */
export async function findAvailablePort(
  host: string,
  startPort: number = DEFAULT_START_PORT,
  limit: number = PORT_SCAN_LIMIT,
  probe: PortProbe = isPortAvailable,
): Promise<number> {
  for (let port = startPort; port < startPort + limit; port++) {
    if (await probe(host, port)) return port;
  }
  throw new Error(`空きポートが見つかりません (${startPort}〜${startPort + limit - 1} を試行)`);
}

export function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}
