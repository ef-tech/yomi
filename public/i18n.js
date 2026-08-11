/**
 * 多言語化 (Issue #48)。ビルドステップなしの純粋 JS メッセージ辞書。
 *
 * - MESSAGES に ja / en の 2 言語を持つ。両言語は同じキー集合を持つ (テストで保証)。
 * - t(key, params) で辞書を引き、{name} 形式のプレースホルダを置換する。
 *   未翻訳キーは ja にフォールバックし、それも無ければキー文字列を返す (壊れない)。
 * - 現在言語は localStorage (prefs.lang, 値 "auto" | "ja" | "en") に永続。
 *   "auto" は navigator.language を見て en* → en、それ以外 → ja。
 * - DOM の静的文字列は data-i18n / data-i18n-title / data-i18n-aria-label /
 *   data-i18n-placeholder 属性で宣言し、applyI18n() が一括で流し込む。
 */

/** サーバの API エラー code → メッセージキーの対応 (未知 code はサーバの error 文字列にフォールバック)。 */
export const ERROR_CODE_KEYS = {
  invalid_json: "error.invalid_json",
  path_required: "error.path_required",
  not_found: "error.not_found",
  not_markdown: "error.not_markdown",
  unsafe_path: "error.unsafe_path",
  excluded_dir: "error.excluded_dir",
  excluded_path: "error.excluded_path",
  already_exists: "error.already_exists",
  parent_missing: "error.parent_missing",
  create_failed: "error.create_failed",
  // **`write_failed` は Issue #101 で code を足したのに、この対応表へ入れ忘れていた** ——
  // 対応が無いと `errorText` がサーバの文言へフォールバックし、翻訳が効かない
  write_failed: "error.write_failed",
  read_failed: "error.read_failed",
  asset_failed: "error.asset_failed",
  zip_failed: "error.zip_failed",
  tree_failed: "error.tree_failed",
  internal_error: "error.internal_error",
  body_too_large: "error.body_too_large",
  origin_forbidden: "error.origin_forbidden",
};

const MESSAGES = {
  ja: {
    // topbar / メニュー
    "menu.openTree.aria": "ファイルツリーを開く",
    "menu.tree.title": "ファイルツリー",
    "menu.more": "メニュー",
    "theme.group": "テーマ",
    "theme.auto": "自動",
    "theme.auto.title": "システム設定に追従",
    "theme.light": "ライト",
    "theme.light.title": "ライトテーマ",
    "theme.dark": "ダーク",
    "theme.dark.title": "ダークテーマ",
    "lang.group": "言語",
    "lang.auto": "自動",
    "lang.auto.title": "ブラウザの言語に追従",
    "lang.ja": "日本語",
    "lang.ja.title": "日本語で表示",
    "lang.en": "EN",
    "lang.en.title": "Show in English",
    "toc.button": "📖 目次",
    "toc.button.title": "目次 (Ctrl/Cmd+Shift+O)",
    "viewMode.label": "表示モード",
    "view.preview": "プレビュー",
    "view.preview.title": "プレビューのみ",
    "view.split": "並列",
    "view.split.title": "Markdown とプレビューを並列表示",
    "view.md": "MD",
    "view.md.title": "Markdown ソースのみ",
    "overflow.editMode": "✏️ 編集モード",
    "overflow.downloadImages": "🗜️ 画像を zip で保存",
    "images.download": "画像 zip",
    "images.download.title": "この記事が参照している画像を zip でまとめてダウンロードする",
    "images.download.none": "この記事は画像を参照していません",
    "images.download.done": "画像 {count} 枚を zip にしました",
    "images.download.partial": "画像 {count} 枚を zip にしました（{skipped} 件は入りませんでした）",
    "images.download.failed": "画像の zip 作成に失敗しました: {msg}",
    // sidebar / tree
    "sidebar.label": "ファイルツリー",
    "tree.newFile.aria": "新規 Markdown ファイルを作成",
    "tree.newFile.title": "新規 md ファイル",
    "tree.newFileInDir.title": "{path} に新規 md ファイル",
    "tree.newFileInDir.aria": "{name} に新規 Markdown ファイルを作成",
    "tree.expandAll": "全て開く",
    "tree.collapseAll": "全て閉じる",
    "tree.loading": "読み込み中…",
    "tree.newFileInput.placeholder": "新規ファイル名 (.md)",
    "tree.newFileInput.aria": "新規 Markdown ファイル名 (Enter で作成、Esc でキャンセル)",
    // content header
    "path.copy.aria": "表示中のファイルパス。タップでコピー",
    "path.copy.title": "タップでパスをコピー",
    "dirty.indicator": "● 未保存",
    "edit.button": "編集",
    "edit.button.title": "ブラウザ内で編集する",
    "edit.saveClose": "保存して閉じる",
    "edit.saveClose.emoji": "💾 保存して閉じる",
    "edit.saveClose.title": "保存して編集モードを終了 (Ctrl/Cmd+S でも保存可)",
    "edit.discard": "破棄",
    "edit.discard.title": "編集を破棄して閉じる",
    // conflict / external link banner
    "conflict.message": "他の場所でファイルが更新されています。",
    "conflict.takeServer": "サーバ内容を取り込む",
    "conflict.overwrite": "強制上書き",
    "conflict.showDiff": "差分を見る",
    "conflict.diff.title": "保存の競合",
    "conflict.diff.summary":
      "ローカル版にしかない行 {local} 行 / サーバ版にしかない行 {server} 行。",
    "conflict.diff.identical": "内容は同じです（保存のタイミングだけがずれています）。",
    "conflict.diff.legendLocal": "ローカル（編集中）",
    "conflict.diff.legendServer": "サーバ（最新）",
    "conflict.diff.bodyAria": "ローカル版とサーバ版の行差分",
    "conflict.diff.truncated":
      "文書が大きいため差分の表示を省略しました。内容を確認してから選んでください。",
    "conflict.diff.copyLocal": "ローカル版をコピー",
    "conflict.diff.copyServer": "サーバ版をコピー",
    "conflict.diff.copiedLocal": "ローカル版をコピーしました",
    "conflict.diff.copiedServer": "サーバ版をコピーしました",
    "conflict.diff.skipped": "{count} 行省略",
    "conflict.diff.copyFailed": "コピーに失敗しました",
    "conflict.diff.serverGone": "サーバ側にファイルがありません",
    "common.close": "閉じる",
    "common.open": "開く",
    "extlink.message": "外部 URL を開きますか?",
    // editor / preview
    "editor.aria": "Markdown エディタ",
    "preview.placeholder": "左のツリーから Markdown ファイルを選択してください。",
    "preview.noFiles": "このディレクトリには Markdown ファイルが見つかりませんでした。",
    // TOC
    "toc.panel.aria": "目次",
    "toc.title": "目次",
    "toc.close.aria": "目次を閉じる",
    "toc.list.aria": "見出し一覧",
    "toc.fab": "目次",
    "toc.expandH4": "▾ H4- 展開",
    "toc.expandH4.title": "H4 以下も表示",
    "toc.collapseH4": "▴ H4- 折りたたみ",
    "toc.collapseH4.title": "H4 以下を隠す",
    "toc.empty": "目次がありません",
    // クイックオープン (Issue #54)
    "quickOpen.label": "ファイルを検索して開く",
    "quickOpen.placeholder": "ファイル名で絞り込み",
    "quickOpen.input.aria": "ファイル名で絞り込み (↑↓ で選択、Enter で開く、Esc で閉じる)",
    "quickOpen.empty": "一致するファイルがありません",
    "quickOpen.open": "🔍 ファイルを検索",
    // ステータス (動的)
    "status.fileCount": "ファイル {count} 件",
    "status.initFailed": "初期化失敗: {msg}",
    "status.loadError": "読み込みエラー: {msg}",
    "status.invalidName": "ファイル名が不正です (空・パス区切りは使えません)",
    "status.created": "{path} を作成しました",
    "status.createdNotOpened": "{path} を作成しました (編集中のため未オープン)",
    "status.createFailed": "{path} の作成に失敗しました: {msg}",
    "status.openFailed": "{path} を開けませんでした: {msg}",
    "status.showing": "{path} を表示",
    "status.mermaidError": "Mermaid 描画エラー: {msg}",
    "status.pathCopied": "パスをコピー: {path}",
    "status.copyFailed": "コピー失敗: {msg}",
    "status.saveNoFile": "保存失敗: 表示中のファイルがありません",
    "status.saved": "{path} を保存",
    "status.conflict": "競合: ファイルが他で更新されています",
    "status.saveFailed": "保存失敗: {msg}",
    "status.taskLocateFailed": "タスクの位置を特定できませんでした",
    "status.taskUpdated": "{path} を更新 (タスク{state})",
    "status.serverTaken": "サーバ側の内容を取り込みました",
    "status.blockedLink": "不正なリンクをブロックしました",
    "status.fileNotFound": "ファイルが見つかりません: {href}",
    "status.fileUpdatedElsewhere": "ファイルが他で更新されています",
    "status.reloaded": "{path} を再読込",
    "status.fileDeleted": "ファイルが削除されました: {path}",
    "status.treeFetchFailed": "ツリー再取得失敗: {msg}",
    "task.on": "ON",
    "task.off": "OFF",
    // 確認ダイアログ
    "confirm.discardEditEnd": "未保存の変更を破棄して編集を終了しますか?",
    "confirm.unsavedContinue": "未保存の変更があります。破棄して続行しますか?",
    // API エラー (サーバ code → 翻訳)
    "error.invalid_json": "JSON の解析に失敗しました",
    "error.path_required": "path が必要です",
    "error.not_found": "ファイルが見つかりません",
    "error.not_markdown": "Markdown ファイル以外は作成できません",
    "error.unsafe_path": "パスが不正です",
    "error.excluded_dir": "除外設定により作成できません",
    "error.excluded_path": "除外設定により読み書きできません",
    "error.already_exists": "既に存在します",
    "error.parent_missing": "親ディレクトリが存在しません",
    "error.create_failed": "ファイルの作成に失敗しました",
    "error.write_failed": "ファイルの保存に失敗しました",
    "error.read_failed": "ファイルの読み取りに失敗しました",
    "error.asset_failed": "ファイルの読み取りに失敗しました",
    "error.zip_failed": "zip の作成に失敗しました",
    "error.tree_failed": "ツリーの取得に失敗しました",
    "error.internal_error": "サーバ内部エラーが発生しました",
    "error.body_too_large": "body が大きすぎます",
    "error.origin_forbidden": "Origin が許可されていません",
    "error.copyExec": "execCommand copy が失敗しました",
  },
  en: {
    // topbar / menu
    "menu.openTree.aria": "Open file tree",
    "menu.tree.title": "File tree",
    "menu.more": "Menu",
    "theme.group": "Theme",
    "theme.auto": "Auto",
    "theme.auto.title": "Follow system setting",
    "theme.light": "Light",
    "theme.light.title": "Light theme",
    "theme.dark": "Dark",
    "theme.dark.title": "Dark theme",
    "lang.group": "Language",
    "lang.auto": "Auto",
    "lang.auto.title": "Follow browser language",
    "lang.ja": "日本語",
    "lang.ja.title": "日本語で表示",
    "lang.en": "EN",
    "lang.en.title": "Show in English",
    "toc.button": "📖 TOC",
    "toc.button.title": "Table of contents (Ctrl/Cmd+Shift+O)",
    "viewMode.label": "View mode",
    "view.preview": "Preview",
    "view.preview.title": "Preview only",
    "view.split": "Split",
    "view.split.title": "Show Markdown and preview side by side",
    "view.md": "MD",
    "view.md.title": "Markdown source only",
    "overflow.editMode": "✏️ Edit mode",
    "overflow.downloadImages": "🗜️ Save images as zip",
    "images.download": "Images zip",
    "images.download.title": "Download the images referenced by this article as a zip",
    "images.download.none": "This article references no images",
    "images.download.done": "Zipped {count} image(s)",
    "images.download.partial": "Zipped {count} image(s) ({skipped} skipped)",
    "images.download.failed": "Failed to create the image zip: {msg}",
    // sidebar / tree
    "sidebar.label": "File tree",
    "tree.newFile.aria": "Create a new Markdown file",
    "tree.newFile.title": "New md file",
    "tree.newFileInDir.title": "New md file in {path}",
    "tree.newFileInDir.aria": "Create a new Markdown file in {name}",
    "tree.expandAll": "Expand all",
    "tree.collapseAll": "Collapse all",
    "tree.loading": "Loading…",
    "tree.newFileInput.placeholder": "New file name (.md)",
    "tree.newFileInput.aria": "New Markdown file name (Enter to create, Esc to cancel)",
    // content header
    "path.copy.aria": "Current file path. Tap to copy.",
    "path.copy.title": "Tap to copy path",
    "dirty.indicator": "● Unsaved",
    "edit.button": "Edit",
    "edit.button.title": "Edit in the browser",
    "edit.saveClose": "Save and close",
    "edit.saveClose.emoji": "💾 Save and close",
    "edit.saveClose.title": "Save and exit edit mode (Ctrl/Cmd+S also saves)",
    "edit.discard": "Discard",
    "edit.discard.title": "Discard edits and close",
    // conflict / external link banner
    "conflict.message": "The file was updated elsewhere.",
    "conflict.takeServer": "Load server version",
    "conflict.overwrite": "Force overwrite",
    "conflict.showDiff": "Show diff",
    "conflict.diff.title": "Save conflict",
    "conflict.diff.summary":
      "{local} line(s) only in your version / {server} line(s) only on the server.",
    "conflict.diff.identical": "The contents are identical (only the save timing differed).",
    "conflict.diff.legendLocal": "Local (being edited)",
    "conflict.diff.legendServer": "Server (latest)",
    "conflict.diff.bodyAria": "Line diff between your version and the server version",
    "conflict.diff.truncated":
      "The document is too large to diff. Review the contents before choosing.",
    "conflict.diff.copyLocal": "Copy local version",
    "conflict.diff.copyServer": "Copy server version",
    "conflict.diff.copiedLocal": "Copied the local version",
    "conflict.diff.copiedServer": "Copied the server version",
    "conflict.diff.skipped": "{count} line(s) hidden",
    "conflict.diff.copyFailed": "Failed to copy",
    "conflict.diff.serverGone": "The file no longer exists on the server",
    "common.close": "Close",
    "common.open": "Open",
    "extlink.message": "Open external URL?",
    // editor / preview
    "editor.aria": "Markdown editor",
    "preview.placeholder": "Select a Markdown file from the tree on the left.",
    "preview.noFiles": "No Markdown files were found in this directory.",
    // TOC
    "toc.panel.aria": "Table of contents",
    "toc.title": "TOC",
    "toc.close.aria": "Close table of contents",
    "toc.list.aria": "Heading list",
    "toc.fab": "Table of contents",
    "toc.expandH4": "▾ Show H4-",
    "toc.expandH4.title": "Show H4 and deeper",
    "toc.collapseH4": "▴ Hide H4-",
    "toc.collapseH4.title": "Hide H4 and deeper",
    "toc.empty": "No headings",
    // Quick open (Issue #54)
    "quickOpen.label": "Search and open a file",
    "quickOpen.placeholder": "Filter by file name",
    "quickOpen.input.aria": "Filter by file name (↑↓ to select, Enter to open, Esc to close)",
    "quickOpen.empty": "No matching files",
    "quickOpen.open": "🔍 Search files",
    // status (dynamic)
    "status.fileCount": "{count} files",
    "status.initFailed": "Initialization failed: {msg}",
    "status.loadError": "Load error: {msg}",
    "status.invalidName": "Invalid file name (empty or path separators are not allowed)",
    "status.created": "Created {path}",
    "status.createdNotOpened": "Created {path} (not opened while editing)",
    "status.createFailed": "Failed to create {path}: {msg}",
    "status.openFailed": "Could not open {path}: {msg}",
    "status.showing": "Showing {path}",
    "status.mermaidError": "Mermaid render error: {msg}",
    "status.pathCopied": "Path copied: {path}",
    "status.copyFailed": "Copy failed: {msg}",
    "status.saveNoFile": "Save failed: no file is open",
    "status.saved": "Saved {path}",
    "status.conflict": "Conflict: the file was updated elsewhere",
    "status.saveFailed": "Save failed: {msg}",
    "status.taskLocateFailed": "Could not locate the task",
    "status.taskUpdated": "Updated {path} (task {state})",
    "status.serverTaken": "Loaded the server version",
    "status.blockedLink": "Blocked an unsafe link",
    "status.fileNotFound": "File not found: {href}",
    "status.fileUpdatedElsewhere": "The file was updated elsewhere",
    "status.reloaded": "Reloaded {path}",
    "status.fileDeleted": "File was deleted: {path}",
    "status.treeFetchFailed": "Failed to refetch tree: {msg}",
    "task.on": "ON",
    "task.off": "OFF",
    // confirm dialogs
    "confirm.discardEditEnd": "Discard unsaved changes and end editing?",
    "confirm.unsavedContinue": "You have unsaved changes. Discard and continue?",
    // API errors (server code -> translation)
    "error.invalid_json": "Failed to parse JSON",
    "error.path_required": "path is required",
    "error.not_found": "File not found",
    "error.not_markdown": "Only Markdown files can be created",
    "error.unsafe_path": "Invalid path",
    "error.excluded_dir": "Cannot create: excluded by .yomiignore or the default excludes",
    "error.excluded_path": "Cannot read or write: excluded by .yomiignore or the default excludes",
    "error.already_exists": "Already exists",
    "error.parent_missing": "Parent directory does not exist",
    "error.create_failed": "Failed to create the file",
    "error.write_failed": "Failed to save the file",
    "error.read_failed": "Failed to read the file",
    "error.asset_failed": "Failed to read the file",
    "error.zip_failed": "Failed to create the zip",
    "error.tree_failed": "Failed to load the tree",
    "error.internal_error": "Internal server error",
    "error.body_too_large": "Request body is too large",
    "error.origin_forbidden": "Origin is not allowed",
    "error.copyExec": "execCommand copy failed",
  },
};

/**
 * @typedef {"ja" | "en"} Lang 実効言語
 * @typedef {"auto" | Lang} LangMode 利用者が選べる設定値
 * @typedef {keyof typeof MESSAGES.ja} MessageKey
 */

/**
 * 内部で利用するため公開 (テストの ja/en キー一致検証に使う)。
 *
 * @param {Lang} lang
 * @returns {Record<string, string>}
 */
export function messagesFor(lang) {
  return MESSAGES[lang] ?? MESSAGES.ja;
}

/**
 * "auto" | "ja" | "en" と navigator の言語から実効言語 ("ja" | "en") を決める。
 *
 * @param {LangMode | string | null | undefined} mode
 * @param {string | null | undefined} navLang
 * @returns {Lang}
 */
export function resolveLang(mode, navLang) {
  if (mode === "ja" || mode === "en") return mode;
  return String(navLang ?? "")
    .toLowerCase()
    .startsWith("en")
    ? "en"
    : "ja";
}

/** @type {Lang} */
let currentLang = "ja";
/** @type {Set<(lang: Lang) => void>} */
const listeners = new Set();

/** @returns {Lang} */
export function getLang() {
  return currentLang;
}

/**
 * 実効言語をセットし、リスナーに通知する。
 *
 * @param {string | null | undefined} lang
 * @returns {void}
 */
export function setLang(lang) {
  currentLang = lang === "en" ? "en" : "ja";
  for (const fn of listeners) fn(currentLang);
}

/**
 * 言語変更の購読 (UI 再適用に使う)。
 *
 * @param {(lang: Lang) => void} fn
 * @returns {() => boolean} 解除する関数
 */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * テスト用: 購読者を全解除する (プロダクションでは呼ばない)。
 *
 * app.js はモジュール読み込み時に onLangChange(reapplyDynamicI18n) を登録するが、
 * 解除する手段を持たない (ページ生存中は解除しないため)。特性テストは 1 テストごとに
 * app.js を読み直すので、これが無いと過去のインスタンスの購読が積み残り、
 * setLang のたびに破棄済み DOM を触るリスナーが増えていく。
 * navigation.js の __resetNavCounterForTest と同じ用途。
 */
export function __resetLangListenersForTest() {
  listeners.clear();
}

/**
 * キーを引いてプレースホルダ {name} を params で置換する。未翻訳は ja→キーにフォールバック。
 *
 * @param {MessageKey | string | null | undefined} key
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function t(key, params) {
  /** @type {Record<string, string | undefined>} */
  const table = MESSAGES[currentLang] ?? MESSAGES.ja;
  if (typeof key !== "string") return "";
  let msg = table[key];
  if (msg === undefined) msg = /** @type {Record<string, string | undefined>} */ (MESSAGES.ja)[key];
  if (msg === undefined) return key;
  if (params) {
    // テンプレートを 1 パスで走査し、各 {name} をその場で params から置換する。
    // 逐次 replaceAll だと、置換後の値に別の {name} が含まれる場合 (例: パスに
    // "{state}" を含むファイル名) に二重置換される。単一パスならその事故を防げる。
    msg = msg.replace(/\{(\w+)\}/g, (/** @type {string} */ match, /** @type {string} */ name) =>
      name in params ? String(params[name]) : match,
    );
  }
  return msg;
}

/**
 * data-i18n* 属性を持つ要素に現在言語のテキスト/属性を流し込む。
 *
 * **型アサーションで絞る。`instanceof` は使わない。** `querySelectorAll` は `Element` を返すが
 * `dataset` / `title` は `HTMLElement`、`placeholder` は input / textarea にしかない。
 * ただし `instanceof` は**実行時チェックを足すことになり、この Issue の前提（外部挙動を
 * 変えない）を破る**。元のコードは無条件に参照しており、絞り込みに漏れた要素は
 * 従来「例外になる」ではなく「そのまま処理される」。
 *
 * 加えて**特性テストのハーネスに無いコンストラクタがある**。`tests/helpers/app-harness.ts` は
 * `Node` と `HTMLElement` はグローバルに置くが、**`HTMLInputElement` /
 * `HTMLTextAreaElement` は置いていない** —— ここを `instanceof HTMLInputElement` で
 * 書いて `ReferenceError` になり、179 テストが落ちた。
 *
 * @param {Document | HTMLElement} [root]
 * @returns {void}
 */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    const target = /** @type {HTMLElement} */ (el);
    target.textContent = t(target.dataset.i18n);
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    const target = /** @type {HTMLElement} */ (el);
    target.title = t(target.dataset.i18nTitle);
  }
  for (const el of root.querySelectorAll("[data-i18n-aria-label]")) {
    const target = /** @type {HTMLElement} */ (el);
    target.setAttribute("aria-label", t(target.dataset.i18nAriaLabel));
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    const target = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (el);
    target.placeholder = t(target.dataset.i18nPlaceholder);
  }
}
