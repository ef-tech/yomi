/**
 * 表示中ドキュメントの読み込みと遷移 (Issue #78 で app.js から分離)。
 *
 * 担当:
 *
 * - `/api/file` の取得と `state` / DOM への反映 (`applyFile`)
 * - **全てのファイル遷移の起点** (`navigateTo`)。未保存確認・履歴・URL・
 *   ハッシュへのスクロールをここで一括して扱う
 * - 戻る / 進む (popstate) の復元
 * - プレビュー内リンクの遷移と外部 URL の警告バナー
 * - 表示中パスのコピー (Issue #24 / #30)
 *
 * 「どのファイルを、どう見せるか」までが responsibility。**描画そのものは
 * `ctx.preview`、ツリーの選択表示は `ctx.tree`** に委ねる。
 */

import { errorText, fetchJson, sanitize } from "./app-context.js";
import { t } from "./i18n.js";
import {
  isAnchor,
  isExternalUrl,
  isUnsafeScheme,
  resolveRelativePath,
  splitHrefHash,
} from "./link-resolver.js";
import {
  buildUrl,
  currentNavIndex,
  getHashFromUrl,
  getPathFromUrl,
  nextNavIndex,
  seedNavCounter,
} from "./navigation.js";

const COPY_FEEDBACK_MS = 1500;

/** @param {import("./app-context.js").Ctx} ctx */
export function createDocument(ctx) {
  const { els, state } = ctx;

  /**
   * popstate のキャンセル復元中フラグ。
   * `history.go` が発火させる popstate を 1 回だけ無視して二重 confirm を防ぐ。
   */
  let pendingCancelRestore = false;
  /** @type {string | null} */
  let pendingExternalUrl = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let copyResetTimer = null;

  /* ===== 読み込みと反映 ===== */

  /**
   * @typedef {{ type: "file" | "dir", name?: string, path: string, children?: TreeNode[] }} TreeNode
   * @param {TreeNode} node
   * @returns {string | null}
   */
  function findFirstFile(node) {
    if (node.type === "file") return node.path;
    for (const child of node.children ?? []) {
      /** @type {string | null} */
      const found = findFirstFile(child);
      if (found) return found;
    }
    return null;
  }

  /**
   * URL の `?path=` が実在すればそれを、無ければツリー最初のファイルを開く。
   * @param {TreeNode} tree
   * @returns {string | null}
   */
  function chooseInitialFile(tree) {
    const fromUrl = getPathFromUrl();
    if (fromUrl && state.fileButtons.has(fromUrl)) {
      return fromUrl;
    }
    return findFirstFile(tree);
  }

  /**
   * @param {string} path
   * @returns {Promise<any>}
   */
  async function loadFile(path) {
    return await fetchJson(`/api/file?path=${encodeURIComponent(path)}`);
  }

  /**
   * @param {{ path: string, raw: string, html: string, sha?: string | null }} data
   * @returns {void}
   */
  function applyFile(data) {
    state.currentPath = data.path;
    state.currentRaw = data.raw;
    state.currentHtml = sanitize(data.html);
    state.currentSha = data.sha ?? null;
    els.currentPath.textContent = data.path;
    ctx.editor.hideConflict();
    if (state.editing) {
      // applyFile で別ファイルに切替 = 編集解除
      ctx.editor.exitEditMode();
    }
    ctx.preview.renderCurrentFile();
    ctx.tree.highlightSelected(data.path);
    ctx.tree.expandAncestors(data.path);
    ctx.editor.enableEditActions(true);
    ctx.preview.refreshToc();
    ctx.preview.wireTaskCheckboxes();
  }

  /**
   * hash が指定されていれば、次フレームで該当 ID 要素までスクロールする。
   *
   * - hash が null / 空文字なら何もしない
   * - 編集モード中は preview が隠れているケースがあるため skip（URL/state は維持）
   * - Mermaid 図ありの md では描画完了前なので位置がズレる可能性あり（将来 Issue）
   * - behavior: "auto" (instant) を使う：ファイル切替直後は `renderCurrentFile` で
   *   scrollTop が一旦 0 にリセットされており、そこから "smooth" でスクロールすると
   *   「一瞬先頭が見えてから見出しまで滑る」という 2 段階の挙動になり違和感が出る。
   *   即時ジャンプなら初期位置の見え時間が最小化される。
   */
  /**
   * @param {string | null} hash
   * @returns {void}
   */
  function scrollIntoHash(hash) {
    if (!hash || state.editing) return;
    requestAnimationFrame(() => {
      const target = document.getElementById(hash);
      if (target) {
        target.scrollIntoView({ behavior: "auto", block: "start" });
      }
    });
  }

  /**
   * 全てのファイル遷移の起点。
   *
   * mode:
   *   "push"    ユーザー操作によるファイル切替（tree クリック / リンククリック）。
   *             history.pushState で履歴を積む
   *   "replace" 初期化・URL からの復元。history.replaceState で履歴は増やさない
   *   "none"    ライブリロード等、履歴も URL も触らない
   *
   * loadFile が失敗した場合は URL も history も触らず status 表示のみ。
   *
   * 戻り値: 実際にファイルへ遷移/表示できたら true、編集中の破棄キャンセルや
   * 読み込み失敗で遷移しなかったら false (呼び出し側はこれを見て後続処理を分岐できる)。
   */
  /**
   * @param {string} path
   * @param {{ history?: "push" | "replace" | "none", hash?: string | null }} [options]
   * @returns {Promise<boolean>}
   */
  async function navigateTo(path, { history: mode = "push", hash = null } = {}) {
    if (mode === "push" && !ctx.editor.confirmLeaveEdit()) return false;

    let data;
    try {
      data = await loadFile(path);
    } catch (err) {
      ctx.setStatus("error", t("status.openFailed", { path, msg: errorText(err) }));
      return false;
    }

    applyFile(data);
    scrollIntoHash(hash);
    // スマホ表示ではファイル選択後に sidebar overlay を自動で閉じる
    if (mode === "push") ctx.mobile.closeSidebarIfMobile();

    if (mode === "none") {
      ctx.setStatus("ok", t("status.showing", { path: data.path }));
      return true;
    }

    const url = buildUrl(data.path, hash);
    const navIndex = mode === "push" ? nextNavIndex() : currentNavIndex();
    const entry = { path: data.path, hash, navIndex };

    if (mode === "push") {
      window.history.pushState(entry, "", url);
    } else {
      window.history.replaceState(entry, "", url);
    }

    ctx.setStatus("ok", t("status.showing", { path: data.path }));
    return true;
  }

  /**
   * popstate（戻る/進む）に対応する。
   *
   * 編集モード中に popstate が発火し、未保存変更があれば確認ダイアログを出す。
   * Cancel された場合は history.go(delta) で元のエントリにジャンプし戻す。
   * その re-navigation も popstate を発火させるが、`pendingCancelRestore` フラグで
   * 1 回だけ無視して二重 confirm ループを防ぐ。
   */
  function wireHistoryNavigation() {
    window.addEventListener("popstate", async (ev) => {
      if (pendingCancelRestore) {
        pendingCancelRestore = false;
        return;
      }

      const target = ev.state ?? {
        path: getPathFromUrl(),
        hash: getHashFromUrl(),
        navIndex: currentNavIndex(),
      };

      if (state.editing) {
        if (!ctx.editor.confirmLeaveEdit()) {
          // キャンセル: history.go(delta) で編集中のエントリへ戻す
          // re-push しない（forward 履歴と scroll restoration を壊さないため）
          const delta = currentNavIndex() - target.navIndex;
          if (delta !== 0) {
            pendingCancelRestore = true;
            // history.go が popstate を発火させなかった場合のフォールバック:
            // 次の tick でフラグを必ず解除し、後続の戻る/進むを 1 回飲んでしまうのを防ぐ
            setTimeout(() => {
              pendingCancelRestore = false;
            }, 0);
            window.history.go(delta);
          }
          return;
        }
        ctx.editor.exitEditMode();
      }

      // 到達先 navIndex まで進めておく。次の push は target.navIndex+1 から
      seedNavCounter(target.navIndex);

      if (!target.path) return;
      try {
        const data = await loadFile(target.path);
        applyFile(data);
        scrollIntoHash(target.hash);
        ctx.setStatus("ok", t("status.showing", { path: data.path }));
      } catch (err) {
        ctx.setStatus("error", t("status.openFailed", { path: target.path, msg: errorText(err) }));
      }
    });
  }

  /* ===== リンクナビゲーション ===== */

  /**
   * @param {string} url
   * @returns {void}
   */
  function showExternalLinkBanner(url) {
    pendingExternalUrl = url;
    els.externalLinkUrl.textContent = url;
    els.externalLinkUrl.title = url;
    els.externalLinkBanner.hidden = false;
    // 誤クリックで Enter 連打で開いてしまわないように、デフォルトは「閉じる」にフォーカス
    setTimeout(() => els.externalLinkCancel.focus(), 0);
  }

  function hideExternalLinkBanner() {
    pendingExternalUrl = null;
    els.externalLinkBanner.hidden = true;
    els.externalLinkUrl.textContent = "";
  }

  /**
   * @param {string} href
   * @returns {void}
   */
  function navigateInternal(href) {
    if (!state.currentPath) return;

    // `[X](other.md#見出し)` の hash 部分を分離して navigateTo に渡す
    const { path: hrefPath, hash } = splitHrefHash(href);
    const resolved = resolveRelativePath(state.currentPath, hrefPath);
    if (!resolved) {
      ctx.setStatus("error", t("status.fileNotFound", { href }));
      return;
    }

    // 拡張子なし fallback: foo → foo.md → foo.markdown → foo.mdx
    const candidates = state.fileButtons.has(resolved)
      ? [resolved]
      : [`${resolved}.md`, `${resolved}.markdown`, `${resolved}.mdx`];

    const hit = candidates.find((c) => state.fileButtons.has(c));
    if (!hit) {
      ctx.setStatus("error", t("status.fileNotFound", { href }));
      return;
    }

    navigateTo(hit, { history: "push", hash }).catch((err) =>
      ctx.setStatus("error", errorText(err)),
    );
  }

  function wireLinkNavigation() {
    els.preview.addEventListener("click", (ev) => {
      // `EventTarget` は `Element` とは限らないが、preview 内の click は常に要素。
      // **`instanceof` で絞らない** (実行時チェックを足すと挙動が変わる。i18n.js 参照)
      const a = /** @type {Element} */ (ev.target).closest("a");
      if (!a || !els.preview.contains(a)) return;
      const href = a.getAttribute("href");
      if (!href) return;

      // ページ内アンカーは既存挙動 (見出しジャンプ) に任せる
      if (isAnchor(href)) return;

      // Issue #32 / #37: renderer 側で `target="_blank"` を付与した <a>
      // (画像 wrap, PDF rewrite) はブラウザネイティブの新タブ動作に任せる。
      // 左クリックだけでなく中クリック / Ctrl-Cmd-クリック / 右クリックの
      // 「リンクを新しいタブで開く」「リンクアドレスをコピー」もそのまま動く。
      if (a.target === "_blank") return;

      ev.preventDefault();

      // Issue #22: javascript: 以外の危険スキーム (vbscript / file / chrome-extension / data 等) も同じ扱い
      if (isUnsafeScheme(href)) {
        ctx.setStatus("error", t("status.blockedLink"));
        return;
      }

      if (isExternalUrl(href)) {
        showExternalLinkBanner(href);
        return;
      }

      navigateInternal(href);
    });

    els.externalLinkCancel.addEventListener("click", () => hideExternalLinkBanner());
    els.externalLinkOpen.addEventListener("click", () => {
      const url = pendingExternalUrl;
      hideExternalLinkBanner();
      if (url) {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    });
  }

  /* ===== パスコピー (Issue #24, パス自体タップ — Issue #30) ===== */

  /**
   * クリップボードにテキストをコピーする。
   *
   * モダンブラウザでは `navigator.clipboard.writeText` を使うが、これは
   * Secure Context (HTTPS / localhost) でのみ公開される。yomi は LAN 越しに
   * HTTP で公開されるため (例: http://192.168.0.100:3944)、その経路では
   * `navigator.clipboard` が undefined になる。
   *
   * フォールバックとして、非表示 textarea を作って select → execCommand("copy")
   * を使う古典的手法を採用。`execCommand` は deprecated だが、現状すべての
   * 主要ブラウザで動作する (HTTP context でも OK)。将来 execCommand が消えた
   * 場合は、別途 modal でテキスト選択 UI を提供する形に切り替える。
   */
  /**
   * @param {string} text
   * @returns {Promise<void>}
   */
  async function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } finally {
      document.body.removeChild(ta);
    }
    if (!ok) throw new Error(t("error.copyExec"));
  }

  function flashCopied() {
    els.currentPath.classList.add("is-copied");
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      els.currentPath.classList.remove("is-copied");
      copyResetTimer = null;
    }, COPY_FEEDBACK_MS);
  }

  function wireCopyPath() {
    els.currentPath.addEventListener("click", async () => {
      if (!state.currentPath) return;
      try {
        await copyTextToClipboard(state.currentPath);
        flashCopied();
        ctx.setStatus("ok", t("status.pathCopied", { path: state.currentPath }));
      } catch (err) {
        ctx.setStatus("error", t("status.copyFailed", { msg: errorText(err) }));
      }
    });
  }

  return {
    chooseInitialFile,
    loadFile,
    applyFile,
    navigateTo,
    scrollIntoHash,
    wireHistoryNavigation,
    wireLinkNavigation,
    hideExternalLinkBanner,
    wireCopyPath,
    copyTextToClipboard,
  };
}
