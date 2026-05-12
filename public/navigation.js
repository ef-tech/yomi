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

export function buildUrl(path) {
  const params = new URLSearchParams();
  if (path) params.set(PARAM, path);
  const search = params.toString();
  if (search) return `?${search}`;
  return typeof window !== "undefined" ? window.location.pathname : "/";
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
