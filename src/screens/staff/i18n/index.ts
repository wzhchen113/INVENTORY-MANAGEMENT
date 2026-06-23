// src/screens/staff/i18n/index.ts — locale-aware t() over typed catalogs.
//
// Three locales (EN, ES, zh-CN) — matching the admin app. Mirrors the
// admin i18n shape at src/i18n/index.ts (spec 038): all catalogs ship in
// every bundle, keys are nested dot-paths, and missing keys fall back to
// the English value (when the active locale isn't English) with a
// one-time console.warn per key.
//
// The active locale lives in `useStaffStore.locale`. The bare `t(key)`
// surface resolves against that live store value so existing call sites
// keep working WITHOUT threading a locale arg through every component —
// but bare `t()` is NOT reactive (it reads the store snapshot at call
// time). Components that must re-render when the locale changes should
// read `locale` from the store (e.g. via `useStaffStore((s) => s.locale)`
// or the `useI18n()` hook below) so React re-runs the render.
//
// `{var}` placeholder substitution only — no ICU plural rules.

import { useMemo } from 'react';
import en from './en.json';
import es from './es.json';
import zhCN from './zh-CN.json';

export type Locale = 'en' | 'es' | 'zh-CN';

// Module-level catalog registry. Not exported — callers go through `t()`.
const catalogs: Record<Locale, Record<string, unknown>> = {
  en,
  es,
  'zh-CN': zhCN,
};

// ── Active-locale source ────────────────────────────────────────────
// The store is the source of truth, but importing useStaffStore here
// would create a circular import (the store imports the i18n
// getter/hook registration, so the cycle would point both ways).
// Instead the store INJECTS its locale access at module-init time via
// two registration calls:
//
//   _setActiveLocaleGetter(fn)  — a plain SNAPSHOT getter for the bare
//     `t()` (imperative call sites: event handlers, Toast.show, etc.).
//
//   _setActiveLocaleHook(hook)  — a REACTIVE hook (a Zustand selector
//     subscription) for `useI18n()`, so render-time consumers re-render
//     when the locale changes.
//
// Both default to 'en' until the store registers them; registration
// runs at the store module's init, before any component renders.
let _getActiveLocale: () => Locale = () => 'en';

// Reactive hook the store registers (a `() => useStaffStore((s) =>
// s.locale)` subscription). Defaults to a STABLE function returning
// 'en' so `useI18n()` is hook-safe (callable unconditionally) before
// registration. The stable identity matters: it's still a valid hook
// call (returns the same constant), and once the store registers its
// real subscription every subsequent render uses that.
let _useActiveLocale: () => Locale = () => 'en';

/** Wire up the active-locale SNAPSHOT getter. Called once by
 *  useStaffStore at module init. Test-only callers may also use it to
 *  pin a locale for the bare `t()`. */
export function _setActiveLocaleGetter(fn: () => Locale): void {
  _getActiveLocale = fn;
}

/** Wire up the REACTIVE active-locale hook (a Zustand selector
 *  subscription). Called once by useStaffStore at module init so
 *  `useI18n()` consumers re-render on a locale change. The injected
 *  function MUST be a React hook (it calls `useStaffStore(...)`); it is
 *  invoked unconditionally from `useI18n()` to honor the rules of
 *  hooks. */
export function _setActiveLocaleHook(hook: () => Locale): void {
  _useActiveLocale = hook;
}

// Module-level Set so the same missing key doesn't spam logs on every
// render. Test resets via _resetWarnCache().
const _warned = new Set<string>();

/** Reset the missing-key warn cache. Test-only — production code should
 *  never call this. */
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
 * Translate a dot-path key against a specific locale.
 *
 * Resolution order:
 *   1. Active locale catalog → return value (with {var} interpolation).
 *   2. English catalog (when locale != 'en') → English fallback; warn once.
 *   3. Both missing — return the raw key string and warn once.
 */
export function translate(
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
  // jest catalog-parity test is the primary defense; this is the
  // runtime safety net.
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

/**
 * Bare translate against the ACTIVE locale (from the store). Keeps the
 * spec-062 call-site shape `t(key, vars)` working unchanged. Not
 * reactive on its own — see the module header.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  return translate(_getActiveLocale(), key, vars);
}

/** Hook surface — returns `{ t }` bound REACTIVELY to the active
 *  locale. It subscribes to the store's `locale` slice (via the
 *  registered `_useActiveLocale` hook), so ANY component that destructures
 *  `const { t } = useI18n()` and renders its strings re-renders when the
 *  locale changes. This is the fix for spec 099's "some parts change,
 *  some don't" — the bare `t()` export reads a snapshot and is NOT
 *  reactive, so render-path strings must come from this hook.
 *
 *  The returned `t` is bound to the SUBSCRIBED locale (not the snapshot
 *  getter), so the strings update in lock-step with the re-render.
 *  Keep using the bare `t()` for IMPERATIVE call sites (event handlers,
 *  Toast.show in onSubmit) where you want the live locale at call time. */
export function useI18n(): { t: typeof t } {
  // Unconditional hook call — `_useActiveLocale` is always a valid hook
  // (the stable 'en' default before the store registers, then the real
  // Zustand subscription). This subscribes the calling component to the
  // locale slice.
  const locale = _useActiveLocale();
  // Memoize on `locale` so the returned `t` has a STABLE identity until the
  // locale actually changes. Consumers put `t` in useCallback/useMemo deps
  // (so handlers + memos re-translate on a switch); without this stability
  // a fresh `t` every render would invalidate those deps each render and,
  // where the dep feeds an effect, spin an infinite render loop.
  return useMemo(
    () => ({
      t: (key: string, vars?: Record<string, string | number>) =>
        translate(locale, key, vars),
    }),
    [locale],
  );
}
