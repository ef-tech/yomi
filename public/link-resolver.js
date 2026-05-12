/**
 * リンクの種類判定と相対パス解決の純関数群。
 * ブラウザから直接 import される (yomi はビルドステップなしの哲学)。
 * bun test からも import 可能 (.js モジュール)。
 */

/** `#fragment` だけのリンク (ページ内アンカー)。`foo.md#bar` 等は false */
export function isAnchor(href) {
  return typeof href === "string" && href.startsWith("#");
}

/**
 * スキーム付き URL かどうか。
 * 例: http(s)://, mailto:, tel:, ftp:, sms: 等の RFC 3986 風スキーム。
 * 相対パスや anchor は false。
 */
export function isExternalUrl(href) {
  if (typeof href !== "string") return false;
  // RFC 3986: scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/**
 * `javascript:` スキームかどうか。空白や大文字の難読化に対応。
 * 例: " JavaScript : alert(1)" でも true
 */
export function isJavascriptUrl(href) {
  if (typeof href !== "string") return false;
  return /^\s*javascript\s*:/i.test(href);
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
