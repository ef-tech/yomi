/**
 * localStorage への永続化アクセスを 1 箇所に集約する。
 * - 各 pref は load() / save(value) を提供
 * - localStorage が使えない (Safari Private 等) ケースは null を返す
 * - 値の妥当性チェック (例: enum 範囲) は呼び出し側で行う
 */

/**
 * 1 つの pref に対する load / save を作る。
 *
 * `T` は保存する値の型。`parse` / `stringify` を渡さなければ文字列のまま扱う。
 *
 * **既定は `string`。** 型引数の既定値が無いと、`opts` を渡さない pref（viewMode 等）は
 * `T` の推論材料が無く `any` に潰れ、`restorePreferences` の検査が丸ごと効かなくなる。
 *
 * @template {unknown} [T=string]
 * @param {string} key localStorage のキー
 * @param {{ parse?: (raw: string) => T | null, stringify?: (value: T) => string }} [opts]
 * @returns {{ key: string, load: () => T | null, save: (value: T | null | undefined) => void }}
 */
function makePref(key, opts = {}) {
  const parse = opts.parse ?? /** @type {(raw: string) => T | null} */ ((s) => s);
  const stringify = opts.stringify ?? ((/** @type {T} */ v) => String(v));
  return {
    key,
    load() {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) return null;
        return parse(raw);
      } catch {
        return null;
      }
    },
    save(value) {
      try {
        if (value === null || value === undefined) {
          localStorage.removeItem(key);
        } else {
          localStorage.setItem(key, stringify(value));
        }
      } catch {
        /* localStorage 不可 */
      }
    },
  };
}

export const prefs = {
  openDirs: makePref("yomi:openDirs:v1", {
    parse: (s) => {
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr : null;
    },
    stringify: (arr) => JSON.stringify(arr),
  }),
  // 旧 "yomi:currentPath:v1" は廃止: 現在ファイルは URL ?path= で表現する
  viewMode: makePref("yomi:viewMode:v1"),
  themeMode: makePref("yomi:themeMode:v1"),
  // Issue #48: UI 言語 ("auto" | "ja" | "en"、デフォルト auto)
  lang: makePref("yomi:lang:v1"),
  tocVisible: makePref("yomi:tocVisible:v1", {
    parse: (s) => s === "true",
    stringify: (v) => (v ? "true" : "false"),
  }),
  tocExpandLevel: makePref("yomi:tocExpandLevel:v1"),
  // Issue #9: split mode のスクロール同期 ON/OFF (デフォルト ON)
  scrollSync: makePref("yomi:scrollSync:v1", {
    parse: (s) => s === "true",
    stringify: (v) => (v ? "true" : "false"),
  }),
};
