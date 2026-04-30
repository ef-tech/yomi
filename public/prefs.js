/**
 * localStorage への永続化アクセスを 1 箇所に集約する。
 * - 各 pref は load() / save(value) を提供
 * - localStorage が使えない (Safari Private 等) ケースは null を返す
 * - 値の妥当性チェック (例: enum 範囲) は呼び出し側で行う
 */

function makePref(key, opts = {}) {
  const parse = opts.parse ?? ((s) => s);
  const stringify = opts.stringify ?? ((v) => v);
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
  currentPath: makePref("yomi:currentPath:v1"),
  viewMode: makePref("yomi:viewMode:v1"),
  themeMode: makePref("yomi:themeMode:v1"),
};
