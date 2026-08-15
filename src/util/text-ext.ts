/**
 * ツリーに載せて閲覧できるテキストファイルの判定と、ハイライト言語の対応表 (Issue #155)。
 *
 * yomi は Markdown ビューアだが、実際のリポジトリでは md の隣に `.json` / `.csv` /
 * 設定ファイル / コードが並ぶ。**読むだけ**ならここで完結させたい、というのがこの
 * モジュールの目的。
 *
 * ## 許可リスト方式を維持する
 *
 * `asset-ext.ts` と同じく **allowlist**（列挙したものだけ通す）にする。「除外に掛からない
 * ものは全部テキストとして出す」にすると、バイナリを誤ってテキスト表示する経路が生まれ、
 * #21 / #22 / #64 で貫いてきた方針からの転換になる。
 *
 * ## `asset-ext.ts` と役割が違う
 *
 * | | 対象 | 経路 | 出力 |
 * |---|---|---|---|
 * | `asset-ext.ts` | md から**リンクされた**添付 | `/api/asset` | ブラウザへ配信（inline / attachment） |
 * | `text-ext.ts`  | **ツリーに載せる**読み物 | `/api/file` | 本文を JSON で返し、右ペインに表示 |
 *
 * 拡張子が両方に出てくる（`.csv` / `.json` / `.txt` 等）のは意図どおりで、
 * **「リンクを踏んで保存する」と「ツリーから開いて読む」は別の要求**。
 *
 * ## `.html` / `.js` を載せてよい理由
 *
 * `asset-ext.ts` はこれらを**意図して除外**している（`/api/asset` は Content-Type 付きで
 * 配信するので、top-level navigation でスクリプトが動く経路になる）。こちらは
 * **本文を JSON の文字列として返し、クライアントが `textContent` で入れる**だけなので、
 * ブラウザが HTML として解釈することも script として実行することもない。
 * **描画せずテキストとして見せる**という一点が違いを生んでいる。
 *
 * ## 言語 ID は highlight.js の名前に合わせる
 *
 * ハイライトはクライアントが当てるので、サーバは「どの言語として扱うか」だけを返す。
 * 値は `public/vendor/highlight.js` に登録した言語名と一致させること
 * (`scripts/vendor/highlight.js` が登録の正本)。**ハイライトしないものは
 * `plaintext`** で、これは highlight.js に組み込みで存在する。
 */

/** ハイライトを当てない言語 ID。highlight.js の組み込み。 */
export const PLAIN_LANGUAGE = "plaintext";

/**
 * 拡張子 (先頭ドット込み・小文字) → ハイライト言語 ID。
 *
 * **`.md` / `.markdown` / `.mdx` は入れない。** Markdown は `markdown-ext.ts` が持つ別経路で、
 * レンダリングして見せる（ここへ入れると raw 表示に倒れる）。
 *
 * **`.env` は入れない。** 秘密情報を含むのが常なので、既定でツリーに出さない
 * (`.yomiignore` の否定パターンで各自が解除できる。Issue #97)。
 *
 * **画像・PDF は入れない。** ブラウザで表示するものは `asset-ext.ts` の担当。
 */
export const TEXT_LANGUAGES: Readonly<Record<string, string>> = {
  // 素のテキスト・データ
  ".txt": PLAIN_LANGUAGE,
  ".text": PLAIN_LANGUAGE,
  ".log": PLAIN_LANGUAGE,
  ".csv": PLAIN_LANGUAGE,
  ".tsv": PLAIN_LANGUAGE,
  // 設定・データ記述
  ".json": "json",
  ".jsonc": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "ini",
  ".ini": "ini",
  ".cfg": "ini",
  ".conf": "ini",
  ".properties": "ini",
  ".xml": "xml",
  ".html": "xml",
  ".htm": "xml",
  // スタイル
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  // スクリプト・コード
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".php": "php",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".lua": "lua",
  ".pl": "perl",
  ".pm": "perl",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "protobuf",
  ".diff": "diff",
  ".patch": "diff",
};

/**
 * 拡張子を持たない慣習ファイル名 (小文字で比較) → ハイライト言語 ID。
 *
 * **拡張子判定とは別経路にする。** `Dockerfile` / `Makefile` / `.gitignore` は
 * 「拡張子が無い」または「名前全体がドット始まり」なので、`lastIndexOf(".")` を使う
 * 拡張子判定では拾えない（`.gitignore` は拡張子 `.gitignore` に見えてしまう）。
 *
 * リポジトリのルートで必ず目に入る割に、今まではツリーから開けなかったものを選んだ。
 */
export const TEXT_FILENAMES: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  license: PLAIN_LANGUAGE,
  ".gitignore": PLAIN_LANGUAGE,
  ".gitattributes": PLAIN_LANGUAGE,
  ".dockerignore": PLAIN_LANGUAGE,
  ".npmignore": PLAIN_LANGUAGE,
  ".yomiignore": PLAIN_LANGUAGE,
  ".editorconfig": "ini",
};

/**
 * パスから basename を小文字で取り出す。
 *
 * 区切りは `/` と `\` の両方を見る。呼び出し側は `toPosix` 済みのパスを渡すことが
 * 多いが、`entry.name` がそのまま来る経路もあるので、ここで吸収しておく。
 */
function basenameLower(nameOrPath: string): string {
  const normalized = nameOrPath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return (slash < 0 ? normalized : normalized.slice(slash + 1)).toLowerCase();
}

/**
 * 小文字化した拡張子 (先頭ドット込み) を返す。拡張子なし・末尾ドット・
 * ドット始まりの名前 (`.gitignore`) は null。
 *
 * **ドット始まりを拡張子と見なさない。** `.gitignore` の `lastIndexOf(".")` は 0 なので、
 * `slice(0)` すると名前全体が「拡張子」になる。ドットファイルは `TEXT_FILENAMES` の
 * 担当なので、ここでは拾わない（`asset-ext.ts` の `extensionOf` は `dot < 0` しか見て
 * いないが、あちらは `.gitignore` を配信対象に持たないので問題が出ていない）。
 */
function extensionOf(basename: string): string | null {
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = basename.slice(dot);
  return ext === "." ? null : ext;
}

/**
 * ツリーに載せて本文を表示できるテキストファイルか。
 *
 * Markdown は含まない（`isMarkdownExtension` の担当）。両方をまとめた判定は
 * `viewable.ts` の `isViewableFile`。
 */
export function isTextExtension(nameOrPath: string): boolean {
  return textLanguageOf(nameOrPath) !== null;
}

/**
 * 表示に使うハイライト言語 ID を返す。テキストとして扱えないものは null。
 *
 * 判定順は **ファイル名 → 拡張子**。`Dockerfile.dev` のような名前は拡張子側 (`.dev`) に
 * 無いので落ちるが、`Dockerfile` そのものは拾える。
 *
 * `Object.hasOwn` で引くのは `asset-ext.ts` と同じ理由 —— `.toString` や `.__proto__` が
 * `Object.prototype` 経由で「登録済み」に見える経路を塞ぐ (defense-in-depth)。
 */
export function textLanguageOf(nameOrPath: string): string | null {
  const base = basenameLower(nameOrPath);
  if (!base) return null;
  if (Object.hasOwn(TEXT_FILENAMES, base)) return TEXT_FILENAMES[base] ?? null;
  const ext = extensionOf(base);
  if (ext === null || !Object.hasOwn(TEXT_LANGUAGES, ext)) return null;
  return TEXT_LANGUAGES[ext] ?? null;
}
