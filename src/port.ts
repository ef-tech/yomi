import { createServer } from "node:net";

export const DEFAULT_START_PORT = 3939;
export const PORT_SCAN_LIMIT = 50;

export async function findAvailablePort(
  host: string,
  startPort: number = DEFAULT_START_PORT,
  limit: number = PORT_SCAN_LIMIT,
): Promise<number> {
  for (let port = startPort; port < startPort + limit; port++) {
    if (await isPortAvailable(host, port)) return port;
  }
  throw new Error(
    `空きポートが見つかりません (${startPort}〜${startPort + limit - 1} を試行)`,
  );
}

function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}
