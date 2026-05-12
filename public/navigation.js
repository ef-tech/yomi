/**
 * URL / 履歴ナビゲーションの純関数ユーティリティ。
 *
 * - URL クエリ `?path=foo.md` を "現在開いているファイル" の single source of truth とする
 * - history.state には { path, hash, navIndex } を保存し、popstate での復元・編集モード
 *   キャンセル時の history.go(delta) 計算に使う
 * - navIndex はモジュールスコープの単調増加カウンタ。リロード時に history.state.navIndex
 *   が残っていれば、それ以上の値で再開（前進履歴に残る古い entry と衝突しないため）
 */

const PARAM = "path";

export function getPathFromUrl(location) {
  const loc = location ?? (typeof window !== "undefined" ? window.location : null);
  if (!loc) return null;
  return new URLSearchParams(loc.search).get(PARAM);
}

/**
 * URL の hash (location.hash) から見出し ID を取得する。
 * 戻り値は先頭の "#" を除き decodeURIComponent 済みの文字列、空なら null。
 *
 * 例: location.hash = "#%E5%89%8A%E9%99%A4%E6%88%A6%E7%95%A5"
 *     -> "削除戦略"
 */
export function getHashFromUrl(location) {
  const loc = location ?? (typeof window !== "undefined" ? window.location : null);
  if (!loc || typeof loc.hash !== "string" || loc.hash.length <= 1) return null;
  const raw = loc.hash.slice(1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function buildUrl(path, hash) {
  const params = new URLSearchParams();
  if (path) params.set(PARAM, path);
  const search = params.toString();
  const base = search
    ? `?${search}`
    : typeof window !== "undefined"
      ? window.location.pathname
      : "/";
  if (!hash) return base;
  return `${base}#${encodeURIComponent(hash)}`;
}

let navCounter = 0;

export function nextNavIndex() {
  return ++navCounter;
}

export function currentNavIndex() {
  return navCounter;
}

/**
 * リロード時に history.state.navIndex から再開する。
 * 既存 navCounter より小さい値は無視（後退させない）。
 */
export function seedNavCounter(from) {
  if (typeof from === "number" && from > navCounter) {
    navCounter = from;
  }
}

// テスト用: navCounter をリセット（プロダクションでは呼ばない）
export function __resetNavCounterForTest() {
  navCounter = 0;
}
