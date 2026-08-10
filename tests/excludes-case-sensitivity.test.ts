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
import { createServer, type ServerHandle } from "../src/server.ts";
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

/**
 * **存在オラクル。** Issue #65 は「除外配下のパスは実在しても存在しなくても同じ 400」を
 * 保証していた（実在を漏らさないため）。
 *
 * 大小を区別しない環境では、**字句判定 (`isRequestExcluded`) が綴り違いを弾かない**ので
 * 次の順で処理が進む:
 *
 * 1. 字句判定: `Private/x.md` は `private` と一致せず**通過**
 * 2. `resolveSafe`: **実在すれば** realpath が `private/x.md` に正規化 → 解決後判定で 400
 * 3. **実在しなければ** leaf を解決できず lexical fallback → `Private/x.md` のまま → 通過 → open が ENOENT → 404
 *
 * つまり **400 と 404 が分かれ、綴りを変えるだけで「除外配下にそのファイルがあるか」が分かる**。
 * これが成立するかを実際の応答で確かめる。
 */
describe("存在オラクル（大小を区別しない環境で綴りを変えたとき）", () => {
  let handle: ServerHandle | null = null;
  let url = "";

  beforeAll(async () => {
    handle = createServer({
      rootDir: root,
      hostname: "127.0.0.1",
      port: 0,
      watch: false,
      excludes: new Set(["private"]),
    });
    url = `http://127.0.0.1:${handle.server.port}`;
    await writeFile(join(root, "private", "secret.md"), "# secret\n");
  });

  afterAll(() => {
    handle?.close();
  });

  test("正しい綴りは実在・非実在とも同じ 400（#65 の保証）", async () => {
    const exists = await fetch(`${url}/api/file?path=private/secret.md`);
    const missing = await fetch(`${url}/api/file?path=private/nope.md`);
    expect(exists.status).toBe(400);
    expect(missing.status).toBe(400);
  });

  test("綴りを変えても実在・非実在で応答が分かれないこと", async () => {
    const exists = await fetch(`${url}/api/file?path=Private/secret.md`);
    const missing = await fetch(`${url}/api/file?path=Private/nope.md`);
    const codes = {
      exists: exists.status,
      missing: missing.status,
      existsCode: ((await exists.json()) as { code?: string }).code,
      missingCode: ((await missing.json()) as { code?: string }).code,
    };
    console.log(`[Issue #98 oracle] caseInsensitive=${caseInsensitive} ${JSON.stringify(codes)}`);

    // **実在の有無で応答が変わってはいけない。** 変わると、綴りを変えるだけで
    // 除外配下のファイルの実在を問い合わせられる
    expect(codes.exists).toBe(codes.missing);
  });
});
