/**
 * リンクの種類判定と相対パス解決の純関数群。
 * ブラウザから直接 import される (yomi はビルドステップなしの哲学)。
 * bun test からも import 可能 (.js モジュール)。
 *
 * サーバ側 (src/renderer.ts) からも import される共有モジュール。
 * 純関数のみで、DOM や window / location には依存しないこと。
 */

/** `#fragment` だけのリンク (ページ内アンカー)。`foo.md#bar` 等は false */
export function isAnchor(href) {
  return typeof href === "string" && href.startsWith("#");
}

/**
 * 安全な外部リンクのスキーム allowlist。
 * top-level navigation で安全に扱える https/mailto/tel に限定する
 * (data: は top-level data URI XSS の歴史があるため除外)。
 */
const SAFE_LINK_SCHEME = /^(https?|mailto|tel):/i;

/**
 * 危険スキームの blocklist。先頭空白や大文字の難読化に対応。
 * - javascript / vbscript: legacy scripting
 * - file: ローカル file system 参照
 * - chrome-extension / chrome / chrome-search / view-source / wyciwyg / jar: ブラウザ内部スキーム
 * - intent: Android intent URL (file リーク等の事例あり)
 * - data: top-level navigation での data URI XSS を防ぐ
 */
const DANGEROUS_SCHEME =
  /^\s*(javascript|vbscript|file|chrome-extension|chrome|chrome-search|intent|wyciwyg|view-source|jar|data)\s*:/i;

/**
 * 安全な data:image URL かどうか (renderer の image src 用)。
 * 一般的な画像 MIME + base64 のみ許可、`data:text/html;base64,...` 等は拒否。
 */
const SAFE_IMAGE_DATA_URL =
  /^data:image\/(png|jpeg|jpg|gif|webp|avif|bmp|svg\+xml|x-icon);base64,[a-zA-Z0-9+/=]+$/i;

// `^\s*` で `\tvbscript:` 等の leading whitespace 難読化も scheme として認識する
// (image src 用の安全判定で必ず allowlist を通る、未許可なら空文字にされる)
const HAS_SCHEME = /^\s*[a-z][a-z0-9+.-]*:/i;

/**
 * 外部リンクとして開いてよい URL か (https/mailto/tel)。
 *
 * Issue #22 で allowlist 化。それ以前は RFC 3986 スキーム全部 (`ftp:`, `sms:`,
 * `vbscript:` 含む) を true にしていた。現在は app.js の外部リンクバナーで
 * 安全に新タブを開ける https/mailto/tel に限定する。
 */
export function isExternalUrl(href) {
  if (typeof href !== "string") return false;
  return SAFE_LINK_SCHEME.test(href);
}

/**
 * `javascript:` スキームかどうか。空白や大文字の難読化に対応。
 * 例: " JavaScript : alert(1)" でも true
 *
 * Issue #22 以降、より広く危険スキームを判定する [[isUnsafeScheme]] も追加した。
 * 既存呼び出しの後方互換のためこの関数は javascript: のみマッチに維持する。
 */
export function isJavascriptUrl(href) {
  if (typeof href !== "string") return false;
  return /^\s*javascript\s*:/i.test(href);
}

/**
 * Issue #22: 危険スキームの拡張判定。
 * javascript / vbscript / file / chrome-extension / intent / view-source / wyciwyg / jar / data
 * のいずれかをマッチする。link click / image src 両方で実行・表示・遷移を阻止する。
 */
export function isUnsafeScheme(href) {
  if (typeof href !== "string") return false;
  return DANGEROUS_SCHEME.test(href);
}

/**
 * Issue #22: image src として安全な href か。
 * - `http(s)://` で始まる絶対 URL: true
 * - `data:image/(png|jpeg|gif|webp|avif|bmp|svg+xml|x-icon);base64,` 形式の data URI: true
 * - それ以外 (mailto:, tel:, ftp:, file:, javascript:, スキームなしの相対パス) は false
 *
 * スキームなし (相対パス) は呼び出し側 ([[rewriteImageHref]]) で別途解決する。
 */
export function isSafeImageHref(href) {
  if (typeof href !== "string") return false;
  if (/^https?:/i.test(href)) return true;
  if (SAFE_IMAGE_DATA_URL.test(href)) return true;
  return false;
}

/**
 * RFC 3986 風のスキーム接頭辞 (`http:`, `mailto:`, `foo+bar.baz:`, ...) を持つかの判定。
 * 安全性とは無関係の純粋な構文判定。`isSafeImageHref` / `isExternalUrl` / `isUnsafeScheme` の
 * 前段フィルタとして使う。
 */
export function hasScheme(href) {
  if (typeof href !== "string") return false;
  return HAS_SCHEME.test(href);
}

/**
 * href から `#hash` 部分を分離する純関数。
 *
 * - "other.md#sec1"  -> { path: "other.md", hash: "sec1" }
 * - "../api.md"      -> { path: "../api.md", hash: null }
 * - "#sec1"          -> { path: "", hash: "sec1" }  (アンカー単独)
 * - "foo%20bar.md#%E8%A6%8B%E5%87%BA%E3%81%97"
 *                    -> { path: "foo bar.md", hash: "見出し" }
 *
 * クエリ (`?...`) は path 側に残す。yomi の resolveRelativePath はクエリも
 * 切り落とすため、現状クエリ付き内部リンクは想定外。
 */
export function splitHrefHash(href) {
  if (typeof href !== "string") return { path: "", hash: null };

  const idx = href.indexOf("#");
  if (idx === -1) return { path: href, hash: null };

  const rawPath = href.slice(0, idx);
  const rawHash = href.slice(idx + 1);

  let hash = rawHash;
  if (rawHash) {
    try {
      hash = decodeURIComponent(rawHash);
    } catch {
      // 不正なエンコードはそのまま使う
    }
    // NFC 正規化: marked の slugger は NFC 出力なので URL 側を揃える
    // (macOS Finder 由来の NFD 入力等で getElementById がミスマッチするのを防ぐ)
    try {
      hash = hash.normalize("NFC");
    } catch {
      // normalize 不可な環境ではそのまま使う
    }
  }

  return { path: rawPath, hash: hash || null };
}

/**
 * 現在のファイル path と相対 href から、リンク先の path を解決する。
 * POSIX 風の path 正規化 (`.`, `..` を解決)。
 *
 * - currentPath: yomi のツリーの relative path (例: "docs/guide.md")
 * - href: リンクの値 (例: "../api.md", "./sub/foo.md", "bar.md")
 * - 戻り値: 解決された相対 path (例: "api.md")
 *
 * root を超える `..` は root 止まり (= 配列が空になるまで pop)。
 */
export function resolveRelativePath(currentPath, href) {
  if (typeof currentPath !== "string" || typeof href !== "string") return "";

  // currentPath のディレクトリ部分 (ファイル名は除外)
  const dirSegments = currentPath.split("/").slice(0, -1).filter(Boolean);

  // href を URL デコードしてからセグメント分解 ([X](./hello%20world.md) 対応)
  let decoded = href;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    // 不正なエンコードはそのまま使う
  }
  const hrefSegments = decoded.split("/");

  // 末尾のクエリ/フラグメントは無視 (yomi の API には fragment 部は不要、内部遷移のみ扱う)
  const lastIdx = hrefSegments.length - 1;
  if (lastIdx >= 0) {
    const last = hrefSegments[lastIdx];
    const hashIdx = last.indexOf("#");
    const queryIdx = last.indexOf("?");
    const cutAt = Math.min(
      hashIdx === -1 ? Number.POSITIVE_INFINITY : hashIdx,
      queryIdx === -1 ? Number.POSITIVE_INFINITY : queryIdx,
    );
    if (cutAt !== Number.POSITIVE_INFINITY) {
      hrefSegments[lastIdx] = last.slice(0, cutAt);
    }
  }

  // 絶対パス (`/foo`) の場合は root から
  const isAbsolute = decoded.startsWith("/");
  const stack = isAbsolute ? [] : [...dirSegments];

  for (const seg of hrefSegments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      stack.pop();
      continue;
    }
    stack.push(seg);
  }

  return stack.join("/");
}
