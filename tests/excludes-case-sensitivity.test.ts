/**
 * 大小を区別しないファイルシステムで除外がすり抜けないかを見る (Issue #98)。
 *
 * ## 何を確かめたいか
 *
 * Issue #65 で除外は「ツリーに出すかどうか」から**読み書きの可否を決める境界**になった。
 * 判定は `isExcludedPath` のセグメント完全一致で、**大小を区別する**。
 *
 * - **ツリー側 (`scanner.ts`)** は `readdir` が返す**ディスク上の実名**で照合するので、
 *   要求の綴りに関係なく必ず除外される
 * - **読み書き側 (`server.ts`)** は要求パスの字句と `resolveSafe` の戻り (`realpath` 由来) で照合する
 *
 * したがって **大小を区別しないファイルシステムで `realpath()` が綴りを正規化しなければ**、
 * `.yomiignore` に `private` と書いても `GET /api/asset?path=Private/creds.csv` が通り、
 * **ツリーには出ないのに読める**という食い違いが残る。
 *
 * ## 大小を区別する環境では成立しない
 *
 * Linux では `Private/` 自体が存在しないので、除外判定をすり抜けても後段の open が ENOENT で
 * 落ちる。**実害が出るのは「綴り違いでも実ファイルに到達できる」環境だけ**なので、
 * プラットフォーム名で決め打ちせず**実際に作って確かめる** (macOS でも大小を区別する
 * ボリュームは作れるし、Linux でもそういうマウントはありうる)。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSafe } from "../src/safepath.ts";
import { isExcludedPath } from "../src/util/excludes.ts";

/** 実際にファイルを作って、綴り違いで開けるか試す（プラットフォーム名で決め打ちしない） */
async function detectCaseInsensitive(dir: string): Promise<boolean> {
  await mkdir(join(dir, "probe-dir"), { recursive: true });
  await writeFile(join(dir, "probe-dir", "f.txt"), "x");
  try {
    await Bun.file(join(dir, "Probe-Dir", "f.txt")).text();
    return true;
  } catch {
    return false;
  }
}

let root: string;
let caseInsensitive = false;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "yomi-case-"));
  caseInsensitive = await detectCaseInsensitive(root);
  await mkdir(join(root, "private"), { recursive: true });
  await writeFile(join(root, "private", "creds.csv"), "user,password\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("除外判定と大小の区別 (Issue #98)", () => {
  const excludes = new Set(["private"]);

  test("正しい綴りなら除外される（対照）", async () => {
    const safe = await resolveSafe(root, "private/creds.csv");
    expect(safe.rel).toBe("private/creds.csv");
    expect(isExcludedPath(safe.rel, excludes)).toBe(true);
  });

  /**
   * **観測。** この環境が大小を区別するか、`resolveSafe` が綴りを正規化するか、
   * 綴り違いで実ファイルに到達できるかを記録する。
   *
   * assertion を置かずログに出すのは、**まず事実を得るため** (Issue #98 の DoD は
   * 「どちらの結論になっても根拠を残す」)。CI の macOS ジョブでこの出力を読む。
   */
  test("この環境での挙動を記録する", async () => {
    const rel = await resolveSafe(root, "Private/creds.csv")
      .then((s) => s.rel)
      .catch((e) => `throw:${(e as Error).constructor.name}`);
    const reachable = await Bun.file(join(root, "Private", "creds.csv"))
      .text()
      .then(() => true)
      .catch(() => false);

    console.log(
      [
        "[Issue #98]",
        `platform=${process.platform}`,
        `caseInsensitive=${caseInsensitive}`,
        `resolveSafe.rel=${rel}`,
        `excludedByRel=${typeof rel === "string" && !rel.startsWith("throw:") ? isExcludedPath(rel, excludes) : "n/a"}`,
        `excludedByRequested=${isExcludedPath("Private/creds.csv", excludes)}`,
        `fileReachable=${reachable}`,
      ].join(" "),
    );

    // 観測が成立していること自体は固定する（この行が落ちたら計測が壊れている）
    expect(typeof caseInsensitive).toBe("boolean");
  });

  /**
   * **すり抜けの定義**: 「除外判定を通り抜け」かつ「実ファイルに到達できる」。
   *
   * 大小を区別する環境では後者が成立しない (ENOENT) ので、判定を通り抜けても実害は無い。
   * 区別しない環境では両方が成立し、**ツリーに出ないのに読める**状態になる。
   */
  test("綴り違いで実ファイルへ到達できないこと", async () => {
    const excludedByRequested = isExcludedPath("Private/creds.csv", excludes);
    const rel = await resolveSafe(root, "Private/creds.csv")
      .then((s) => s.rel)
      .catch(() => null);
    const excludedByRel = rel === null ? true : isExcludedPath(rel, excludes);
    const blocked = excludedByRequested || excludedByRel;

    if (blocked) return; // 除外が効いている = すり抜けていない

    // 除外は通り抜けた。実ファイルに届くなら、それがすり抜け
    const reachable = await Bun.file(join(root, "Private", "creds.csv"))
      .text()
      .then(() => true)
      .catch(() => false);
    expect(reachable).toBe(false);
  });
});
