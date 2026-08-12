/**
 * app.js の責務分割で全モジュールが共有する土台 (Issue #78)。
 *
 * ## なぜ「ファクトリ」なのか — モジュールレベルに状態を置けない
 *
 * 特性テストのハーネス (`tests/helpers/app-harness.ts`) は、テストごとに jsdom を作り直し
 * `import("../../public/app.js?boot=N")` でクエリを変えて **app.js だけ** を読み直す。
 * **app.js が import するモジュールはクエリが付かないのでキャッシュされ、2 回目以降も
 * 1 回目のインスタンスが使い回される。**
 *
 * したがって切り出したモジュールが `const els = { ... document.getElementById() }` のような
 * **DOM 束縛の状態をモジュールレベルに持つと、2 回目の boot で前の jsdom の要素を掴んだまま**
 * になり、テストが壊れる (本番でも 1 プロセス 1 文書なので露見しないぶん厄介)。
 *
 * そのため els / state は**必ず関数で作り**、app.js が boot ごとに 1 度だけ呼ぶ。
 * 各モジュールも `createXxx(ctx)` の形にして、状態はクロージャに閉じる。
 *
 * ## ctx による遅延束縛
 *
 * 分割前の app.js は関数どうしが自由に呼び合っていた (例: websocket → document の再読込 →
 * tree の再描画)。モジュール間で相互参照が循環するため、**import ではなく `ctx` 経由**で
 * 参照する。app.js が全モジュールを生成してから `ctx` に差し込むので、生成順に依存しない。
 */

import { ERROR_CODE_KEYS, t } from "./i18n.js";
import { prefs } from "./prefs.js";
import { SANITIZE_CONFIG } from "./sanitize-config.js";
import DOMPurify from "./vendor/dompurify.js";

export const VIEW_MODES = ["preview", "split", "md"];
export const DEFAULT_VIEW_MODE = "preview";

export const THEME_MODES = ["auto", "light", "dark"];
export const DEFAULT_THEME_MODE = "auto";

// UI 言語モード (Issue #48): auto はブラウザ言語に追従、ja / en は固定
export const LANG_MODES = ["auto", "ja", "en"];
export const DEFAULT_LANG_MODE = "auto";

export const TOC_EXPAND_LEVELS = ["h3", "h6"];
export const DEFAULT_TOC_EXPAND_LEVEL = "h3";

/** スマホ判定 (Issue #25)。767px 以下を sidebar overlay モードとする。 */
export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

/**
 * @param {string | null | undefined} html
 * @returns {string}
 */
export function sanitize(html) {
  // サニタイズ設定は public/sanitize-config.js に切り出し (Issue #59)。
  // `<style>` タグ / style 属性を禁止し CSS インジェクション (exfiltration) を防ぐ。
  // Mermaid 図は sanitize 後に mermaid.run() が SVG を生成する (再 sanitize しない)。
  return DOMPurify.sanitize(html ?? "", SANITIZE_CONFIG);
}

/**
 * サーバの応答を載せた fetch エラー。`errorText` が `code` を翻訳キーに対応づける。
 *
 * @typedef {Error & { status?: number, code?: string, payload?: any }} ApiError
 */

/**
 * fetch して JSON を返す。非 2xx はサーバの error / code を載せた Error を投げる。
 *
 * **戻り値の形は呼び出し側が指定する。** サーバの応答は URL ごとに違うので、ここで
 * 1 つに決められない。型は `public/api-types.js` に集めてあるので
 * `fetchJson(/** @type {...} *\/ ...)` ではなく `await fetchJson<FileResponse>(...)`
 * 相当を JSDoc の型引数で書く（呼び出し側の `@type` で受ける）。
 *
 * @template [T=unknown]
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<T>}
 */
export async function fetchJson(url, options) {
  const res = await fetch(url, options);
  /** @type {any} */
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = /** @type {ApiError} */ (new Error(data.error ?? `HTTP ${res.status}`));
    err.status = res.status;
    err.code = data.code;
    err.payload = data;
    throw err;
  }
  return data;
}

/** `/api/tree` の版を伝えるヘッダ名。**`src/server.ts` の `TREE_GEN_HEADER` と揃える。** */
const TREE_GEN_HEADER = "X-Yomi-Tree-Gen";

/**
 * ツリーを版つきで取得する (Issue #126)。
 *
 * **取得を 1 か所にまとめる。** `/api/tree` は初回起動・再接続・新規作成の 3 経路から
 * 引かれる。どこか 1 つでも版を控え忘れると、**そこから先の差分がすべて捨てられる**
 * （版が合わないので毎回全量へ逃げる）ことになり、しかも動きは正しいので気づけない。
 *
 * @returns {Promise<{ root: import("./api-types.js").TreeNode, gen: number | null }>}
 */
export async function fetchTree() {
  const res = await fetch("/api/tree");
  /** @type {any} */
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = /** @type {ApiError} */ (new Error(data.error ?? `HTTP ${res.status}`));
    err.status = res.status;
    err.code = data.code;
    err.payload = data;
    throw err;
  }
  const raw = res.headers.get(TREE_GEN_HEADER);
  // **数値として読めないものは「版を知らない」に倒す。** ヘッダを返さない古いサーバや
  // 途中の proxy が壊した場合で、`Number("")` の 0 を版と信じると差分を誤って適用する
  const gen =
    raw !== null && raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
  return { root: data, gen };
}

/**
 * 例外から表示用の文字列を取り出す。
 *
 * **`errorText` と使い分ける。** あちらは**サーバ API の `code` を翻訳キーへ引き当てる**
 * もので、クリップボードの `DOMException` や Mermaid のパースエラーには対応表が無い。
 * 非 fetch 経路をあちらへ流すと「fetch のエラー整形器」の守備範囲がぼやける。
 *
 * @param {unknown} err
 * @returns {string}
 */
export function messageOf(err) {
  const message = /** @type {{ message?: unknown } | null | undefined} */ (err)?.message;
  return typeof message === "string" ? message : String(err);
}

/**
 * fetch エラーを表示用文字列に変換する (Issue #48)。
 * サーバが返した code を翻訳キーに対応づけ、未知 code / code 無しは
 * サーバの error 文字列 (err.message) にフォールバックする。
 *
 * **`unknown` で受ける。** 呼び出し元の多くは `catch (err)` からそのまま渡してくるので、
 * `ApiError` に絞ると呼ぶ側で毎回キャストが要る。
 *
 * @param {unknown} err
 * @returns {string}
 */
export function errorText(err) {
  const e = /** @type {ApiError | null | undefined} */ (err);
  /** @type {Record<string, string | undefined>} */
  const codeKeys = ERROR_CODE_KEYS;
  const key = e?.code ? codeKeys[e.code] : undefined;
  return key ? t(key) : (e?.message ?? String(err));
}

/**
 * `getElementById` の結果を型付きで返す。
 *
 * **実行時の振る舞いは `document.getElementById` そのままで、null チェックを足していない。**
 * 分割前から全モジュールが「index.html にあるはずの要素」として無条件に参照しており、
 * ここで存在チェックを入れると**挙動が変わる**（Issue #79 は外部挙動を変えない）。
 * 型アサーションは、そのコードが元から置いている前提を型として明示するもの。
 *
 * 要素が実際に無ければ従来どおり最初の参照で TypeError になる。
 *
 * @param {string} id
 * @returns {HTMLElement}
 */
const byId = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * `querySelectorAll` の結果を配列で返す。
 * @param {string} selector
 * @returns {HTMLElement[]}
 */
const allOf = (selector) =>
  /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll(selector)));

/** DOM 要素の参照をまとめて引く。**boot ごとに 1 度だけ呼ぶこと** (上記のとおり)。 */
export function createElements() {
  return {
    sidebar: byId("sidebar"),
    sidebarBackdrop: byId("sidebar-backdrop"),
    menuBtn: byId("menu-btn"),
    tree: byId("tree"),
    // ツリーツールバー (Issue #41)
    treeExpandAll: /** @type {HTMLButtonElement} */ (byId("tree-expand-all")),
    treeCollapseAll: /** @type {HTMLButtonElement} */ (byId("tree-collapse-all")),
    // 新規 md 作成 (Issue #6)
    treeNewFile: /** @type {HTMLButtonElement} */ (byId("tree-new-file")),
    preview: byId("preview"),
    source: byId("source"),
    editor: /** @type {HTMLTextAreaElement} */ (byId("editor")),
    contentBody: byId("content-body"),
    status: byId("status"),
    currentPath: /** @type {HTMLButtonElement} */ (byId("current-path")),
    dirtyIndicator: byId("dirty-indicator"),
    // ⋮ overflow menu (Issue #30, スマホ専用)
    overflowBtn: byId("overflow-btn"),
    overflowMenu: byId("overflow-menu"),
    // **非 null。** `index.html` に常にあり、`app-mobile.js` は無条件に
    // `addEventListener` している。`app-editor.js` に残る `if (els.overflowEdit)` は
    // その事実より古い防御で、いまは常真（消すのは挙動変更なのでこの Issue では触らない）
    overflowEdit: /** @type {HTMLButtonElement} */ (byId("overflow-edit")),
    overflowQuickOpen: byId("overflow-quick-open"),
    // クイックオープン (Issue #54)
    quickOpen: byId("quick-open"),
    quickOpenInput: /** @type {HTMLInputElement} */ (byId("quick-open-input")),
    quickOpenList: byId("quick-open-list"),
    quickOpenEmpty: byId("quick-open-empty"),
    overflowThemeBtns: allOf(".overflow-theme-btn"),
    overflowViewBtns: allOf(".overflow-view-btn"),
    // FAB 目次 (Issue #30, スマホ専用)
    tocFab: /** @type {HTMLButtonElement} */ (byId("toc-fab")),
    editBtn: /** @type {HTMLButtonElement} */ (byId("edit-btn")),
    discardBtn: byId("discard-btn"),
    conflictBanner: byId("conflict-banner"),
    conflictTakeServer: byId("conflict-take-server"),
    conflictOverwrite: byId("conflict-overwrite"),
    conflictDismiss: byId("conflict-dismiss"),
    conflictShowDiff: byId("conflict-show-diff"),
    // 競合の差分ダイアログ (Issue #57)
    // 画像 zip のダウンロード (Issue #140)。PC は編集ボタンの隣、スマホは ⋮ メニュー
    downloadImagesBtn: /** @type {HTMLButtonElement} */ (byId("download-images-btn")),
    overflowDownloadImages: /** @type {HTMLButtonElement} */ (byId("overflow-download-images")),
    conflictDiff: byId("conflict-diff"),
    conflictDiffSummary: byId("conflict-diff-summary"),
    conflictDiffBody: byId("conflict-diff-body"),
    conflictDiffLegend: byId("conflict-diff-legend"),
    conflictDiffTruncated: byId("conflict-diff-truncated"),
    conflictDiffNotice: byId("conflict-diff-notice"),
    conflictDiffCopyLocal: byId("conflict-diff-copy-local"),
    conflictDiffCopyServer: /** @type {HTMLButtonElement} */ (byId("conflict-diff-copy-server")),
    conflictDiffTakeServer: byId("conflict-diff-take-server"),
    conflictDiffOverwrite: byId("conflict-diff-overwrite"),
    conflictDiffClose: byId("conflict-diff-close"),
    toggleButtons: allOf(".view-toggle-btn"),
    // **`[data-theme-mode]` で絞る (Issue #85)。** 言語トグルは見た目を揃えるために
    // `class="theme-toggle-btn lang-toggle-btn"` を持っており、素の class セレクタだと
    // ここに混入する。`applyThemeMode` は集めた全ボタンに `aria-pressed` を書くので、
    // `data-theme-mode` を持たない言語ボタンは必ず `false` にされ、スクリーンリーダー
    // 利用者には「どの言語が選ばれているか」が分からなくなっていた。
    //
    // `:not(.lang-toggle-btn)` でも直せるが、**属性で絞るほうが意図がそのまま出る** ——
    // このリストは「テーマモードを持つボタン」であって「言語ボタン以外」ではない。
    // 将来また別の用途で `.theme-toggle-btn` のスタイルを再利用しても壊れない。
    themeButtons: allOf(".theme-toggle-btn[data-theme-mode]"),
    // UI 言語トグル (Issue #48)
    langButtons: allOf(".lang-toggle-btn"),
    overflowLangBtns: allOf(".overflow-lang-btn"),
    // TOC
    tocBtn: /** @type {HTMLButtonElement} */ (byId("toc-btn")),
    tocPanel: byId("toc-panel"),
    tocList: byId("toc-list"),
    tocClose: byId("toc-close"),
    tocExpandToggle: byId("toc-expand-toggle"),
    // 外部 URL 警告バナー
    externalLinkBanner: byId("external-link-banner"),
    externalLinkUrl: byId("external-link-url"),
    externalLinkCancel: byId("external-link-cancel"),
    externalLinkOpen: byId("external-link-open"),
  };
}

/** 画面の可変状態。**boot ごとに 1 度だけ呼ぶこと**。 */
export function createState() {
  return {
    /** @type {Map<string, HTMLButtonElement>} path -> tree-item ボタン要素 */
    fileButtons: new Map(),
    /** @type {Map<string, { button: HTMLButtonElement, ul: HTMLUListElement }>} path -> ディレクトリの開閉に使う要素 */
    dirNodes: new Map(),
    /** 開いているディレクトリ path のセット */
    openDirs: new Set([""]),
    /**
     * @type {import("./api-types.js").TreeNode | null}
     * 直近に描いたツリーのデータ (Issue #126)。**差分更新の土台**で、`tree` 通知を
     * 受けたらここへ 1 件だけ足し引きして、変わったディレクトリだけ描き直す。
     */
    treeData: null,
    /**
     * @type {number | null}
     * `treeData` の版 (Issue #126)。`/api/tree` の `X-Yomi-Tree-Gen` ヘッダで受け取る。
     * 差分通知の版が「これ + 1」でなければ**取りこぼしている**ので全量へ逃げる。
     * `null` は版を知らない状態（ヘッダを返さない古いサーバ・取得前）。
     */
    treeGen: null,
    /** @type {string | null} 現在表示中のファイル path */
    currentPath: null,
    /** 現在のファイル内容 */
    currentRaw: "",
    currentHtml: "",
    /** @type {string | null} 直近 GET / POST 時のサーバ側 sha (Lost Update 検知のベース) */
    currentSha: null,
    /** @type {string} 表示モード: preview | split | md */
    viewMode: DEFAULT_VIEW_MODE,
    /** @type {string} テーマモード: auto | light | dark */
    themeMode: DEFAULT_THEME_MODE,
    /** @type {string} UI 言語モード: auto | ja | en (localStorage 永続、Issue #48) */
    langMode: DEFAULT_LANG_MODE,
    /** 編集モード中かどうか */
    editing: false,
    /** 編集中で未保存の差分があるかどうか */
    dirty: false,
    /** TOC パネルが表示中か (localStorage 永続化) */
    tocVisible: false,
    /** @type {string} TOC の展開レベル: "h3" (H1-H3) / "h6" (H1-H6) */
    tocExpandLevel: DEFAULT_TOC_EXPAND_LEVEL,
    /** 編集モード進入時に TOC が開いていたら、終了時に復元するためのフラグ */
    tocSuspended: false,
    /** md モード時に TOC ボタン押下で一時的に preview 切替したかのフラグ (戻すため) */
    tocPreviewOverride: false,
    /** @type {Map<string, HTMLElement>} path -> button 要素 (現在地ハイライト用) */
    tocEntries: new Map(),
    /** @type {IntersectionObserver | null} 再構築のたびに破棄して作り直す */
    tocObserver: null,
    /** Issue #9: split mode のスクロール同期 ON/OFF (デフォルト ON) */
    scrollSyncEnabled: true,
    /**
     * @type {{ li: HTMLLIElement, input: HTMLInputElement, trigger: HTMLElement | null } | null}
     *   Issue #6: 表示中の新規ファイル名インライン入力 (非表示時は null)
     */
    newFileInput: null,

    /** @type {string[]} Issue #54: クイックオープンの母集団 (ツリー再描画のたびに張り直す) */
    quickOpenPaths: [],
    /** @type {import("./quick-open.js").QuickOpenHit[]} Issue #54: いま表示している候補 */
    quickOpenHits: [],
    /** Issue #54: 候補内の選択位置 (候補が無ければ -1) */
    quickOpenIndex: -1,
    /** @type {HTMLElement | null} Issue #54: 開く直前のフォーカス (閉じたら戻す) */
    quickOpenReturnFocus: null,
  };
}

/**
 * localStorage から設定を復元する (state を直接書き換える)。
 *
 * @param {State} state
 * @returns {void}
 */
export function restorePreferences(state) {
  const open = prefs.openDirs.load();
  if (open) state.openDirs = new Set([...open, ""]);

  const view = prefs.viewMode.load();
  if (view && VIEW_MODES.includes(view)) state.viewMode = view;

  const theme = prefs.themeMode.load();
  if (theme && THEME_MODES.includes(theme)) state.themeMode = theme;

  // Issue #48: UI 言語モード (auto|ja|en)。未保存/不正値はデフォルト auto を維持
  const lang = prefs.lang.load();
  if (lang && LANG_MODES.includes(lang)) state.langMode = lang;

  const tocVis = prefs.tocVisible.load();
  if (tocVis === true) state.tocVisible = true;

  const tocLv = prefs.tocExpandLevel.load();
  if (tocLv && TOC_EXPAND_LEVELS.includes(tocLv)) state.tocExpandLevel = tocLv;

  // Issue #9: scrollSync は load 値が null (未保存) ならデフォルト true を維持
  const ss = prefs.scrollSync.load();
  if (ss === false) state.scrollSyncEnabled = false;
}

/**
 * ステータス表示 (PC はヘッダ、スマホは toast)。
 *
 * toast のタイマーを閉じ込めたいのでファクトリにする。モジュールレベルに置くと
 * boot をまたいで前の jsdom のタイマーが残る (このファイル冒頭の理由)。
 *
 * **`mobileQuery` は ctx 直下に置く** (`els` / `state` と同格)。status の内部詳細ではなく
 * 横断的な関心事で、ここに載せると「スマホ UI がステータス表示に依存する」という
 * 説明のつかない依存ができるため。
 *
 * @param {Ctx} ctx
 */
export function createStatus(ctx) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let toastTimer = null;

  return {
    /**
     * @param {"ok" | "error" | null} kind
     * @param {string} text
     * @returns {void}
     */
    setStatus(kind, text) {
      const { status } = ctx.els;
      status.textContent = text;
      status.classList.remove("is-ok", "is-error", "is-toast");
      if (kind === "ok") status.classList.add("is-ok");
      else if (kind === "error") status.classList.add("is-error");
      // スマホでは toast 表示 (Issue #30): CSS animation 完了後に class を除去
      if (ctx.mobileQuery.matches && text) {
        status.classList.add("is-toast");
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
          status.classList.remove("is-toast");
          toastTimer = null;
        }, 3000);
      }
    },

    /** ステータス表示を空にする (テキスト + 装飾クラス + toast タイマーを解除)。 */
    clearStatus() {
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      ctx.els.status.textContent = "";
      ctx.els.status.classList.remove("is-ok", "is-error", "is-toast");
    },
  };
}

/**
 * 全モジュールが共有する土台。**遅延束縛**なので、`app.js` が各ファクトリを呼んで
 * ここへ差し込むまで `document` 以降のメンバーは存在しない（このファイル冒頭の説明）。
 * 型の上では循環参照になるが、型は実行時に消えるので問題にならない。
 *
 * @typedef {ReturnType<typeof createElements>} Elements
 * @typedef {ReturnType<typeof createState>} State
 * @typedef {{
 *   els: Elements,
 *   state: State,
 *   mobileQuery: MediaQueryList,
 *   setStatus: (kind: "ok" | "error" | null, text: string) => void,
 *   clearStatus: () => void,
 *   document: ReturnType<typeof import("./app-document.js").createDocument>,
 *   preview: ReturnType<typeof import("./app-preview.js").createPreview>,
 *   tree: ReturnType<typeof import("./app-tree.js").createTree>,
 *   editor: ReturnType<typeof import("./app-editor.js").createEditor>,
 *   mobile: ReturnType<typeof import("./app-mobile.js").createMobileUi>,
 *   ws: ReturnType<typeof import("./app-websocket.js").createWebSocketClient>,
 *   quickOpen: ReturnType<typeof import("./app-quick-open.js").createQuickOpen>,
 *   images: ReturnType<typeof import("./app-images.js").createImageDownload>,
 * }} Ctx
 */
