// src/screens/staff/i18n/i18n.test.ts — catalog parity + locale-aware
// t()/translate() + fallback tests.
//
// Mirrors the admin i18n test idiom (src/i18n/i18n.test.ts, spec 038):
//   (a) en / es / zh-CN have identical key sets and string-only leaves.
//   (b) translate(locale, key) returns the locale-specific string.
//   (c) translate(locale, missing) returns the key + warns once (deduped).
//   (d) active-locale missing keys fall back to English value + warn once.
//   (e) bare t() resolves against the active locale (via the registered
//       getter) and keeps the spec-062 call-site shape working.

import en from './en.json';
import es from './es.json';
import zhCN from './zh-CN.json';
import {
  t,
  translate,
  _resetWarnCache,
  _setActiveLocaleGetter,
  type Locale,
} from './index';

// ── Flatten helper ──────────────────────────────────────────────────
function flattenKeys(obj: Record<string, unknown>, prefix = ''): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const child of flattenKeys(v as Record<string, unknown>, next)) {
        out.add(child);
      }
    } else {
      out.add(next);
    }
  }
  return out;
}

describe('staff i18n catalog parity', () => {
  it('en, es, zh-CN have identical key sets', () => {
    const enKeys = flattenKeys(en);
    const esKeys = flattenKeys(es);
    const zhKeys = flattenKeys(zhCN);

    const missingInEs = [...enKeys].filter((k) => !esKeys.has(k));
    const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));
    const extraInEs = [...esKeys].filter((k) => !enKeys.has(k));
    const extraInZh = [...zhKeys].filter((k) => !enKeys.has(k));

    expect(missingInEs).toEqual([]);
    expect(missingInZh).toEqual([]);
    expect(extraInEs).toEqual([]);
    expect(extraInZh).toEqual([]);
  });

  it('every leaf in each catalog is a string', () => {
    function assertStringLeaves(obj: Record<string, unknown>, path = '') {
      for (const [k, v] of Object.entries(obj)) {
        const here = path ? `${path}.${k}` : k;
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          assertStringLeaves(v as Record<string, unknown>, here);
        } else {
          expect(typeof v).toBe('string');
        }
      }
    }
    assertStringLeaves(en);
    assertStringLeaves(es);
    assertStringLeaves(zhCN);
  });

  it('keeps {var} placeholders identical across locales', () => {
    // Every interpolation token in en.json must appear in the same key's
    // es / zh-CN value, else a runtime substitution silently no-ops.
    const enKeys = flattenKeys(en);
    function read(obj: Record<string, unknown>, key: string): string {
      let cur: unknown = obj;
      for (const seg of key.split('.')) cur = (cur as Record<string, unknown>)[seg];
      return cur as string;
    }
    const tokens = (s: string) =>
      new Set((s.match(/\{(\w+)\}/g) ?? []).sort());
    for (const key of enKeys) {
      const enTokens = tokens(read(en, key));
      expect({ key, tokens: tokens(read(es, key)) }).toEqual({ key, tokens: enTokens });
      expect({ key, tokens: tokens(read(zhCN, key)) }).toEqual({ key, tokens: enTokens });
    }
  });
});

describe('staff translate()', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    _resetWarnCache();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns the English string when locale is 'en'", () => {
    expect(translate('en', 'eod.submit')).toBe('Submit');
    expect(translate('en', 'chrome.signOut.label')).toBe('Sign out');
  });

  it("returns the Spanish string when locale is 'es'", () => {
    expect(translate('es', 'eod.submit')).toBe('Enviar');
    expect(translate('es', 'chrome.signOut.label')).toBe('Cerrar sesión');
  });

  it("returns the Chinese string when locale is 'zh-CN'", () => {
    expect(translate('zh-CN', 'eod.submit')).toBe('提交');
    expect(translate('zh-CN', 'chrome.signOut.label')).toBe('退出登录');
  });

  it('substitutes {var} placeholders per locale', () => {
    expect(translate('en', 'store.picker.subtitle', { count: 3 })).toBe(
      'You have access to 3 stores',
    );
    expect(translate('es', 'store.picker.subtitle', { count: 2 })).toBe(
      'Tienes acceso a 2 tiendas',
    );
  });

  it('leaves the literal {var} when no matching var is provided', () => {
    expect(translate('en', 'store.picker.subtitle')).toBe(
      'You have access to {count} stores',
    );
  });

  it('falls back to the English value when the active locale misses the key (warns once)', () => {
    const KEY = 'chrome.signOut.label';
    const segs = KEY.split('.');
    const last = segs.pop()!;
    let cur: any = es;
    for (const seg of segs) cur = cur[seg];
    const saved = cur[last];
    try {
      delete cur[last];
      expect(translate('es', KEY)).toBe('Sign out'); // English value
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[i18n] missing key in es, falling back to en: chrome.signOut.label',
      );
    } finally {
      cur[last] = saved;
    }
  });

  it('returns the key path and warns once for a missing key (deduped)', () => {
    expect(translate('en', 'definitely.missing.key')).toBe('definitely.missing.key');
    expect(translate('en', 'definitely.missing.key')).toBe('definitely.missing.key');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('[i18n] missing key: definitely.missing.key');
  });
});

describe('staff t() (active-locale bound)', () => {
  let active: Locale = 'en';

  beforeEach(() => {
    _resetWarnCache();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    _setActiveLocaleGetter(() => active);
  });
  afterEach(() => {
    active = 'en';
    jest.restoreAllMocks();
  });

  it('resolves against the active locale getter', () => {
    active = 'en';
    expect(t('eod.submit')).toBe('Submit');
    active = 'es';
    expect(t('eod.submit')).toBe('Enviar');
    active = 'zh-CN';
    expect(t('eod.submit')).toBe('提交');
  });

  it('keeps the bare t(key, vars) call-site shape working', () => {
    active = 'es';
    expect(t('store.picker.subtitle', { count: 4 })).toBe('Tienes acceso a 4 tiendas');
  });
});

// The REACTIVE `useI18n()` hook is exercised in the .tsx render test
// (useI18n.reactivity.test.tsx, component/jsdom project) — it calls
// `useMemo`/`useStaffStore`, so it must run inside a React render, which
// this node-env unit suite can't do.
