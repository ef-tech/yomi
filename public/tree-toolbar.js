/**
 * ツリーツールバー (Issue #41) の状態遷移ロジック。
 *
 * DOM に触れない純粋関数として app.js から切り出し、bun test から
 * 直接テストする (他の pure module: navigation.js / link-resolver.js と同じ方針)。
 * DOM への反映 (setDirOpen / disabled 切替) は app.js 側が担当する。
 */

/** ルートを表す sentinel。openDirs に常に含める (restorePreferences と同じ規約) */
export const ROOT_DIR = "";

/**
 * 全て開く: ツリーに現存する全ディレクトリ path を開いた状態の開集合を返す。
 *
 * 既存の openDirs を引き継がないことに意味がある: 過去に存在したが
 * リネーム/削除で消えたディレクトリの stale path を捨てるため、
 * 「全て開く」が localStorage に溜まった死んだ path の自然な剪定になる
 * (renderTree は openDirs を剪定しないので、ここが唯一の掃除どころ)。
 *
 * @param {Iterable<string>} dirPaths ツリーに現存する全ディレクトリ path
 * @returns {Set<string>} ROOT_DIR + 全 dirPaths の新しい Set
 */
export function expandAllDirs(dirPaths) {
  const next = new Set([ROOT_DIR]);
  for (const path of dirPaths) {
    next.add(path);
  }
  return next;
}

/**
 * 全て閉じる: 初期状態 (ルート直下のみ表示) の開集合を返す。
 *
 * @returns {Set<string>} ROOT_DIR のみを含む新しい Set
 */
export function collapseAllDirs() {
  return new Set([ROOT_DIR]);
}

/**
 * ツールバーを有効にするか: ディレクトリが 1 つ以上ある時だけ true。
 * 読み込み中 / 読み込み失敗 / フラット構成 (ディレクトリなし) では false。
 *
 * @param {number} dirCount ツリーに存在するディレクトリ数
 * @returns {boolean}
 */
export function isTreeToolbarEnabled(dirCount) {
  return dirCount > 0;
}
