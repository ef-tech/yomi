import { spawn } from "node:child_process";

type Command = readonly [string, ...string[]];

export function openBrowser(url: string): void {
  const candidates = pickCommands();
  for (const candidate of candidates) {
    const [cmd, ...args] = candidate;
    try {
      const child = spawn(cmd, [...args, url], {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => {
        /* 失敗しても致命ではない */
      });
      child.unref();
      return;
    } catch {
      /* 次の候補を試す */
    }
  }
  console.warn(`ブラウザを自動で開けませんでした。手動で開いてください: ${url}`);
}

function pickCommands(): readonly Command[] {
  switch (process.platform) {
    case "darwin":
      return [["open"]];
    case "win32":
      return [["cmd", "/c", "start", '""']];
    default:
      return [["xdg-open"], ["gnome-open"], ["wslview"]];
  }
}
