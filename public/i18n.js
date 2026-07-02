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
  already_exists: "error.already_exists",
  parent_missing: "error.parent_missing",
  create_failed: "error.create_failed",
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
    "error.excluded_dir": "除外ディレクトリ配下には作成できません",
    "error.already_exists": "既に存在します",
    "error.parent_missing": "親ディレクトリが存在しません",
    "error.create_failed": "ファイルの作成に失敗しました",
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
    "error.excluded_dir": "Cannot create under an excluded directory",
    "error.already_exists": "Already exists",
    "error.parent_missing": "Parent directory does not exist",
    "error.create_failed": "Failed to create the file",
    "error.body_too_large": "Request body is too large",
    "error.origin_forbidden": "Origin is not allowed",
    "error.copyExec": "execCommand copy failed",
  },
};

/** 内部で利用するため公開 (テストの ja/en キー一致検証に使う)。 */
export function messagesFor(lang) {
  return MESSAGES[lang] ?? MESSAGES.ja;
}

/** "auto" | "ja" | "en" と navigator の言語から実効言語 ("ja" | "en") を決める。 */
export function resolveLang(mode, navLang) {
  if (mode === "ja" || mode === "en") return mode;
  return String(navLang ?? "")
    .toLowerCase()
    .startsWith("en")
    ? "en"
    : "ja";
}

let currentLang = "ja";
const listeners = new Set();

export function getLang() {
  return currentLang;
}

/** 実効言語をセットし、リスナーに通知する。 */
export function setLang(lang) {
  currentLang = lang === "en" ? "en" : "ja";
  for (const fn of listeners) fn(currentLang);
}

/** 言語変更の購読 (UI 再適用に使う)。 */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** キーを引いてプレースホルダ {name} を params で置換する。未翻訳は ja→キーにフォールバック。 */
export function t(key, params) {
  const table = MESSAGES[currentLang] ?? MESSAGES.ja;
  let msg = table[key];
  if (msg === undefined) msg = MESSAGES.ja[key];
  if (msg === undefined) return key;
  if (params) {
    // テンプレートを 1 パスで走査し、各 {name} をその場で params から置換する。
    // 逐次 replaceAll だと、置換後の値に別の {name} が含まれる場合 (例: パスに
    // "{state}" を含むファイル名) に二重置換される。単一パスならその事故を防げる。
    msg = msg.replace(/\{(\w+)\}/g, (match, name) =>
      name in params ? String(params[name]) : match,
    );
  }
  return msg;
}

/** data-i18n* 属性を持つ要素に現在言語のテキスト/属性を流し込む。 */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of root.querySelectorAll("[data-i18n-aria-label]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
}
