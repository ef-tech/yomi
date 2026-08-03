import type { InstanceRecord } from "./instances.ts";
import { isLoopback } from "./network.ts";

/** 起動中インスタンスが 1 件も無いときの案内（異常ではないので終了コードは 0） */
export const NO_INSTANCES_MESSAGE = "起動中の yomi はありません";

/**
 * 公開有無の表示 (Issue #69)。
 * ループバック以外はすべて `share` 扱いにする — `--share` の 0.0.0.0 だけでなく、
 * `--host 192.168.x.x` のような直接指定も外から見えることに変わりはない。
 */
export function visibilityLabel(host: string): string {
  return isLoopback(host) ? "local" : "share";
}

const HEADER = { pid: "PID", port: "PORT", visibility: "PUBLIC", dir: "DIR" } as const;

interface Row {
  pid: string;
  port: string;
  visibility: string;
  dir: string;
}

/**
 * `yomi list` の出力を組み立てる。
 *
 * 起動ディレクトリは長くなりがちなので最終列に置き、幅を揃えない。
 * こうしておくと 80 桁を超えて折り返しても、見出しと値の対応は崩れない
 * （途中の列に長い値が来る並びだと、1 行溢れただけで表全体が読めなくなる）。
 */
export function buildListOutput(records: readonly InstanceRecord[]): string {
  if (records.length === 0) return NO_INSTANCES_MESSAGE;

  const rows: Row[] = records.map((r) => ({
    pid: String(r.pid),
    port: String(r.port),
    visibility: visibilityLabel(r.host),
    dir: r.rootDir,
  }));

  const widths = {
    pid: widthOf(HEADER.pid, rows, (r) => r.pid),
    port: widthOf(HEADER.port, rows, (r) => r.port),
    visibility: widthOf(HEADER.visibility, rows, (r) => r.visibility),
  };

  const format = (row: Row) =>
    [
      row.pid.padEnd(widths.pid),
      row.port.padEnd(widths.port),
      row.visibility.padEnd(widths.visibility),
      row.dir,
    ].join("  ");

  return [format(HEADER), ...rows.map(format)].join("\n");
}

function widthOf(header: string, rows: readonly Row[], pick: (row: Row) => string): number {
  return rows.reduce((max, row) => Math.max(max, pick(row).length), header.length);
}
