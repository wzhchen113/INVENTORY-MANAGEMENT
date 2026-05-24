// src/i18n/index.ts — hand-rolled t() over a typed message catalog.
//
// Single locale (English) in v1. The hook surface is `useI18n()` which
// returns `{ t }`; cycle-2 can swap in a Zustand-backed locale selector
// without touching call sites.
//
// Mirrors imr-inventory's i18n shape (spec 038) stripped to one
// catalog. Missing keys console.warn once and return the raw key.
// `{var}` placeholder substitution only — no ICU plural rules in v1.

import en from './en.json';

const catalog: Record<string, unknown> = en;

// Module-level Set so the same missing key doesn't spam logs on every
// render. Test resets via _resetWarnCache().
const _warned = new Set<string>();

/** Reset the missing-key warn cache. Test-only — production code should
 *  never call this. */
export function _resetWarnCache(): void {
  _warned.clear();
}

/** Look up a nested dot-path. Returns undefined when any segment is
 *  missing or a non-string leaf is hit. */
function lookup(key: string): string | undefined {
  let cur: unknown = catalog;
  for (const seg of key.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/**
 * Translate a dot-path key into the active locale's string.
 * Resolution order:
 *   1. English catalog → return value (with {var} interpolation).
 *   2. Missing — return the raw key string and console.warn once.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const value = lookup(key);
  if (value === undefined) {
    if (!_warned.has(key)) {
      // eslint-disable-next-line no-console
      console.warn(`[i18n] missing key: ${key}`);
      _warned.add(key);
    }
    return key;
  }
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (_m, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`,
  );
}

/** Hook surface — returns `{ t }`. Cycle-2 lifts active locale into
 *  the store; for v1 the call is a no-op wrapper. */
export function useI18n(): { t: typeof t } {
  return { t };
}
