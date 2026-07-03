/**
 * public/i18n.js の型宣言 (Issue #48)。
 * bun test / tsc から import するための最小限の型付け。
 */

export type Lang = "ja" | "en";
export type LangMode = "auto" | "ja" | "en";

/** サーバの API エラー code → メッセージキーの対応表。 */
export const ERROR_CODE_KEYS: Record<string, string>;

/** 指定言語のメッセージ辞書を返す (未知言語は ja)。 */
export function messagesFor(lang: string): Record<string, string>;

/** "auto" | "ja" | "en" と navigator の言語から実効言語を決める。 */
export function resolveLang(mode: string, navLang?: string | null): Lang;

/** 現在の実効言語を返す。 */
export function getLang(): Lang;

/** 実効言語をセットし、リスナーへ通知する。 */
export function setLang(lang: string): void;

/** 言語変更を購読する。返り値の関数で解除。 */
export function onLangChange(fn: (lang: Lang) => void): () => void;

/** キーを引いて {name} プレースホルダを params で置換する。 */
export function t(key: string, params?: Record<string, string | number>): string;

/** data-i18n* 属性を持つ要素へ現在言語のテキスト/属性を流し込む。 */
export function applyI18n(root?: Document | Element): void;
