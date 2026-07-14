/**
 * Type declarations for public/sanitize-config.js (browser ES module).
 *
 * これにより tests/sanitize-config.test.ts から型安全に import できる。
 * 実装は public/sanitize-config.js 側にある (yomi はビルドステップなしで
 * ブラウザに直接配る哲学なので、ソースは .js のまま)。
 */

export interface SanitizeConfig {
  USE_PROFILES: { html: boolean };
  ADD_ATTR: string[];
  FORBID_ATTR: string[];
  FORBID_TAGS: string[];
}

export declare const SANITIZE_CONFIG: SanitizeConfig;
