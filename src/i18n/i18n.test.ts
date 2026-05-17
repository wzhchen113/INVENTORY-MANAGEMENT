// src/i18n/i18n.test.ts
//
// Spec 038 — catalog parity + fallback test.
//
// Asserts:
//   (a) en.json / es.json / zh-CN.json have identical key sets.
//   (b) t(locale, key) returns the locale-specific string when present.
//   (c) t(locale, missing) returns the key path and console.warns once,
//       deduped across calls.
//   (d) Active-locale missing keys fall back to English value + warn.
//
// Pattern mirrors `src/store/useStore.test.ts` (spec 033) and
// `src/lib/auth.test.ts` — Track 1 jest unit test. No store mocks
// needed because i18n is pure data + pure functions.

import en from './en.json';
import es from './es.json';
import zhCN from './zh-CN.json';
import { t, _resetWarnCache } from './index';

// ── Flatten helper ──────────────────────────────────────────────────
// Walks a nested object and returns the set of dot-path leaf keys.
// A "leaf" is anything that's not a plain object — strings, numbers,
// null, etc. In practice the catalogs only contain string leaves.
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

describe('i18n catalog parity', () => {
  it('en, es, zh-CN have identical key sets', () => {
    const enKeys = flattenKeys(en);
    const esKeys = flattenKeys(es);
    const zhKeys = flattenKeys(zhCN);

    const missingInEs = [...enKeys].filter((k) => !esKeys.has(k));
    const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));
    const extraInEs = [...esKeys].filter((k) => !enKeys.has(k));
    const extraInZh = [...zhKeys].filter((k) => !enKeys.has(k));

    // The four expect lines collectively assert set equality; each one
    // surfaces a useful failure message (jest prints the array diff).
    expect(missingInEs).toEqual([]);
    expect(missingInZh).toEqual([]);
    expect(extraInEs).toEqual([]);
    expect(extraInZh).toEqual([]);
  });

  it('every leaf in en.json is a string', () => {
    // The runtime t() assumes string leaves; a stray null/number/array
    // would silently fall through to the "missing key" branch and
    // emit a warning. Catch it here instead.
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
});

describe('t()', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    // Reset the module-level warned-set so each test's missing-key
    // assertion sees a fresh warn budget.
    _resetWarnCache();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns the English string when locale is 'en'", () => {
    expect(t('en', 'sidebar.groups.operations')).toBe('Operations');
    expect(t('en', 'chrome.signOut')).toBe('sign out');
  });

  it("returns the Spanish string when locale is 'es'", () => {
    expect(t('es', 'sidebar.groups.operations')).toBe('Operaciones');
    expect(t('es', 'chrome.signOut')).toBe('cerrar sesión');
  });

  it("returns the Chinese string when locale is 'zh-CN'", () => {
    expect(t('zh-CN', 'sidebar.groups.operations')).toBe('运营');
    expect(t('zh-CN', 'chrome.signOut')).toBe('退出登录');
  });

  it('section.inventory.tabs.categories exists in en / es / zh-CN', () => {
    // Spec 039 — the `categories` tab label in InventoryDesktopLayout
    // is NOT filename-style and DOES route through `t()`. The other two
    // tabs (`items.tsv`, `catalog.tsv`) stay verbatim. Guarding the
    // catalog presence here means a future rename of the key surfaces
    // as a test failure rather than a UI fall-through to the dot-path.
    expect(t('en', 'section.inventory.tabs.categories')).toBe('categories');
    expect(t('es', 'section.inventory.tabs.categories')).toBe('categorías');
    expect(t('zh-CN', 'section.inventory.tabs.categories')).toBe('分类');
  });

  it('substitutes {var} placeholders from the vars object', () => {
    expect(
      t('en', 'chrome.eodFooter', { submittedCount: 3, totalCount: 5 }),
    ).toBe('EOD 3/5');
    expect(
      t('es', 'chrome.eodFooter', { submittedCount: 2, totalCount: 4 }),
    ).toBe('EOD 2/4');
  });

  it('leaves unsubstituted {var} literals in place when vars is missing the key', () => {
    expect(t('en', 'chrome.eodFooter', { submittedCount: 1 })).toBe(
      'EOD 1/{totalCount}',
    );
  });

  it('falls back to the English value when the active locale is missing the key (and warns once)', () => {
    // Manufacture a missing-in-target scenario by transiently deleting a
    // key from the imported `es` JSON object. The i18n module holds the
    // SAME object reference (Jest's module cache shares the parsed
    // import), so mutating it here mutates the catalog used by `t()`.
    // Save+restore via try/finally so the parity test is unaffected by
    // ordering. Asserts:
    //  - t('es', key) returns the English value (fallback path).
    //  - console.warn is emitted once for the missing-in-locale warn
    //    (`[i18n] missing key in es, falling back to en: <key>`).
    const KEY = 'chrome.signOut';
    const segs = KEY.split('.');
    const last = segs.pop()!;
    let cur: any = es;
    for (const seg of segs) cur = cur[seg];
    const saved = cur[last];
    try {
      delete cur[last];
      expect(t('es', KEY)).toBe('sign out'); // English value
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[i18n] missing key in es, falling back to en: chrome.signOut',
      );
    } finally {
      cur[last] = saved;
    }
  });

  it('returns the key path and warns once for a missing key', () => {
    const result = t('en', 'definitely.missing.key');
    expect(result).toBe('definitely.missing.key');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[i18n] missing key: definitely.missing.key',
    );
  });

  it('dedupes warnings for the same missing key across multiple calls', () => {
    t('en', 'another.missing.key');
    t('en', 'another.missing.key');
    t('es', 'another.missing.key');
    // English path: 1 warn (missing in en, deduped on second call).
    // Spanish path: falls back to en (also missing), so it hits the
    // same missing-key branch — still deduped via the shared warned set.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
