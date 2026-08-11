/**
 * エラー `code` の一覧が、サーバとクライアントで食い違っていないことを検証する (Issue #99)。
 *
 * クライアントは `code` を翻訳キーへ引き当てる（`public/i18n.js` の `ERROR_CODE_KEYS`）。
 * **別々に書いていたので、片方だけ足して気づかない事故が起きた** —— Issue #101 が
 * `write_failed` を返すようにしたのに対応表へ入れ忘れ、英語表示でも日本語が出ていた。
 *
 * `src/util/error-codes.ts` を唯一の出所にして、両方向を型で固定する。
 *
 * **`tests/api-types.test.ts` と同じ作法。** あちらはツリーの形、こちらは code の集合。
 */

import { describe, expect, test } from "bun:test";
import { ERROR_CODE_KEYS, messagesFor } from "../public/i18n.js";
import { internalErrorResponse } from "../src/server.ts";
import { ERROR_CODES, type ErrorCode } from "../src/util/error-codes.ts";

/** 双方向に代入できる = 同じ集合。片方向だけだと、足りない/余分を見逃す。 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// **ここが検証の本体。** 集合が食い違うと `true` に代入できず typecheck が落ちる。
// - サーバが返しうる code に対応表が無い → 翻訳されずサーバの文言が出る（#101 の事故）
// - 対応表に残った死に code → 誰も返さないキーが辞書に残り続ける
const _codeSetsMatch: Exact<keyof typeof ERROR_CODE_KEYS, ErrorCode> = true;

describe("エラー code の突き合わせ (Issue #99)", () => {
  test("サーバの一覧とクライアントの対応表が同じ集合である", () => {
    expect(_codeSetsMatch).toBe(true);
    // 型が消えても件数のずれには気づけるように、実行時にも比べる
    expect(Object.keys(ERROR_CODE_KEYS).sort()).toEqual([...ERROR_CODES].sort());
  });

  test("全 code の翻訳キーが ja / en 双方に存在する", () => {
    const ja = messagesFor("ja");
    const en = messagesFor("en");
    for (const code of ERROR_CODES) {
      const key = ERROR_CODE_KEYS[code];
      expect(Object.hasOwn(ja, key)).toBe(true);
      expect(Object.hasOwn(en, key)).toBe(true);
    }
  });

  /**
   * **サーバのソースに、一覧に無い code が書かれていないか。**
   *
   * 型で防げるのは「一覧と対応表のずれ」までで、**`code: "typo"` のような
   * リテラルの書き間違い**は、`Response.json` の引数が緩いので `tsc` を通ってしまう。
   * そこはソースを見るしかない。
   *
   * **限界: ヘルパ経由で位置引数として渡す形も拾う必要がある**（`forbidden(msg, "code")`）。
   * 下の 2 つの正規表現がそれで、**どちらも取りこぼす書き方は残る**。型で守れない部分の
   * best-effort であって、これだけを頼りにしない。
   */
  test("サーバのソースに一覧外の code が書かれていない", async () => {
    const src = await Bun.file(new URL("../src/server.ts", import.meta.url)).text();
    const found = new Set<string>();
    // `code: "xxx"` の形
    for (const m of src.matchAll(/\bcode:\s*"([a-z_]+)"/g)) found.add(m[1] as string);
    // `forbidden(…, "xxx")` のようにヘルパへ位置引数で渡す形
    for (const m of src.matchAll(/\bforbidden\([^)]*?"([a-z_]+)"\s*\)/g)) found.add(m[1] as string);

    // 拾えていないと恒真になるので、実数に近い下限を置く
    expect(found.size).toBeGreaterThanOrEqual(15);
    const known = new Set<string>(ERROR_CODES);
    expect([...found].filter((c) => !known.has(c))).toEqual([]);
  });
});

/**
 * `fetch` を抜けた例外の受け皿 (Issue #99)。
 *
 * **経路としては到達しない** —— いまは全ハンドラが自分で捕捉するので、
 * リクエストからここへ落とす手段が無い（実際に試した: 深いネストの Markdown も
 * 不正な percent-encoding も、それぞれのハンドラが 500 / 400 / 404 で返す）。
 * **将来 catch を書き忘れたときの保険**なので、応答の形だけを固定しておく。
 */
describe("未捕捉エラーの受け皿 (Issue #99)", () => {
  test("HTML ではなく短い JSON を返し、内部情報を載せない", async () => {
    const res = internalErrorResponse(new Error("EACCES: permission denied, open '/home/u/x.md'"));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    const text = await res.text();
    expect(text).not.toContain("/home/");
    expect(text).not.toContain("EACCES");
    const body = JSON.parse(text) as { code?: string };
    expect(body.code).toBe("internal_error");
  });
});
