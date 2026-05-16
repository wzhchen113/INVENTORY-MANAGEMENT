// src/i18n/index.ts
//
// Spec 038 — hand-rolled t() over a typed message catalog. See §8 of
// [specs/038-multi-language-support-p1-chrome.md](../../specs/038-multi-language-support-p1-chrome.md).
//
// All three catalogs ship in every bundle (architect §0.2). Keys are
// nested dot-paths; the lookup walks the JSON object. Missing keys fall
// back to the English value (when active locale isn't English) and
// emit a one-time console.warn per key. {var} placeholder substitution
// only — no ICU plural rules in P1.

import en from './en.json';
import es from './es.json';
import zhCN from './zh-CN.json';

export type Locale = 'en' | 'es' | 'zh-CN';

// Module-level catalog registry. Not exported — callers go through
// `t()` so the lookup + warn machinery stays the single entry point.
const catalogs: Record<Locale, Record<string, unknown>> = {
  en,
  es,
  'zh-CN': zhCN,
};

// Module-level Set so the same missing key doesn't spam logs on every
// render. The i18n test clears this between cases via _resetWarnCache().
const _warned = new Set<string>();

/** Reset the missing-key warn cache. Test-only — production code should
 *  never call this. Exported with an underscore prefix to discourage
 *  accidental use. */
export function _resetWarnCache(): void {
  _warned.clear();
}

/** Look up a nested dot-path in a catalog object. Returns `undefined`
 *  when any segment is missing or a non-string leaf is hit. */
function lookup(catalog: Record<string, unknown>, key: string): string | undefined {
  let cur: unknown = catalog;
  for (const seg of key.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/**
 * Translate a dot-path key into the active locale's string.
 *
 * Resolution order:
 *   1. Active locale catalog → return value (with {var} interpolation if vars given).
 *   2. English catalog (when active locale != 'en') → return English fallback;
 *      console.warn once per missing key.
 *   3. Both missing — return the raw key string and console.warn once.
 *
 * Placeholder substitution: `{name}` → `vars.name` when `vars.name` is
 * defined; otherwise the literal `{name}` is left in place (debug aid).
 */
export function t(
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const fromActive = lookup(catalogs[locale], key);
  const value =
    fromActive ?? (locale !== 'en' ? lookup(catalogs.en, key) : undefined);
  if (value === undefined) {
    if (!_warned.has(key)) {
      // eslint-disable-next-line no-console
      console.warn(`[i18n] missing key: ${key}`);
      _warned.add(key);
    }
    return key;
  }
  // Fallback occurred (active locale missing the key, English supplied
  // it) — warn once so catalog drift surfaces during development. The
  // jest catalog-parity test in i18n.test.ts is the primary defense;
  // this is the runtime safety net.
  if (fromActive === undefined && locale !== 'en') {
    const warnKey = `${locale}:${key}`;
    if (!_warned.has(warnKey)) {
      // eslint-disable-next-line no-console
      console.warn(`[i18n] missing key in ${locale}, falling back to en: ${key}`);
      _warned.add(warnKey);
    }
  }
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (_m, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`,
  );
}
