// src/i18n/localizedName.test.ts
//
// Spec 040 P3 — pure-function test for `getLocalizedName`. Track 1 jest
// per spec §Verification. No store mocks; the helper is pure data + a
// switch. Five required cases (spec §Helper module) plus three defensive
// cases for whitespace / null / undefined inputs.

import { getLocalizedName } from './localizedName';

describe('getLocalizedName()', () => {
  it("returns the Spanish translation when present", () => {
    expect(
      getLocalizedName(
        { name: 'Detergent', i18nNames: { es: 'Detergente' } },
        'es',
      ),
    ).toBe('Detergente');
  });

  it("falls back silently to English when es entry is missing", () => {
    expect(
      getLocalizedName({ name: 'Detergent', i18nNames: {} }, 'es'),
    ).toBe('Detergent');
  });

  it("falls back silently to English when i18nNames is null", () => {
    // The DB JSONB column never returns null in practice (default '{}'),
    // but PostgREST + the local in-memory cache may yield null in
    // intermediate states. The helper tolerates it.
    expect(
      getLocalizedName({ name: 'Detergent', i18nNames: null }, 'es'),
    ).toBe('Detergent');
  });

  it("resolves the recipes table's menuItem canonical column", () => {
    expect(
      getLocalizedName(
        { menuItem: 'Burger', i18nNames: { 'zh-CN': '汉堡' } },
        'zh-CN',
      ),
    ).toBe('汉堡');
  });

  it("returns canonical English when locale is 'en' even with translations present", () => {
    // English mode never reads i18nNames — that column never carries
    // an English entry by spec design (the canonical column IS English).
    expect(
      getLocalizedName(
        { name: 'Detergent', i18nNames: { es: 'Detergente' } },
        'en',
      ),
    ).toBe('Detergent');
  });

  it("treats whitespace-only translations as missing (silent fallback)", () => {
    // Defensive: a `{"es": "   "}` row shouldn't render as a blank in
    // Spanish mode while the English canonical has content. The helper
    // trims before checking length.
    expect(
      getLocalizedName(
        { name: 'Detergent', i18nNames: { es: '   ' } },
        'es',
      ),
    ).toBe('Detergent');
  });

  it("returns empty string for null row", () => {
    expect(getLocalizedName(null, 'es')).toBe('');
  });

  it("returns empty string for undefined row", () => {
    expect(getLocalizedName(undefined, 'es')).toBe('');
  });

  it("returns empty string when both name and menuItem are missing", () => {
    expect(getLocalizedName({ i18nNames: {} }, 'en')).toBe('');
    expect(getLocalizedName({ i18nNames: { es: 'X' } }, 'en')).toBe('');
  });

  it("prefers menuItem over name when both are present (recipe rows post-Phase-3)", () => {
    // The 5 P3 tables never carry BOTH columns on a single row in the
    // production schema. The architect's §5 helper code picks menuItem
    // first as a defensive choice; lock that ordering here.
    expect(
      getLocalizedName({ name: 'X', menuItem: 'Y', i18nNames: {} }, 'en'),
    ).toBe('Y');
  });

  it("zh-CN translation round-trips through the helper", () => {
    expect(
      getLocalizedName(
        { name: 'Yellow Onion', i18nNames: { 'zh-CN': '黄洋葱' } },
        'zh-CN',
      ),
    ).toBe('黄洋葱');
  });
});

// Track 1 fixture round-trips — one row per table to assert the
// canonical column resolution. These mirror the architect's
// "small fixture-based catalog-parity-style assertion" requirement
// in spec §Verification.
describe('getLocalizedName() fixture round-trip', () => {
  const fixtures = [
    {
      table: 'catalog_ingredients',
      row: { name: 'Yellow Onion', i18nNames: { es: 'Cebolla Amarilla', 'zh-CN': '黄洋葱' } },
    },
    {
      table: 'recipes',
      row: { menuItem: 'Cheeseburger', i18nNames: { es: 'Hamburguesa con Queso', 'zh-CN': '芝士汉堡' } },
    },
    {
      table: 'prep_recipes',
      row: { name: 'Marinated Chicken', i18nNames: { es: 'Pollo Marinado', 'zh-CN': '腌鸡肉' } },
    },
    {
      table: 'recipe_categories',
      row: { name: 'Sandwiches', i18nNames: { es: 'Sándwiches', 'zh-CN': '三明治' } },
    },
    {
      table: 'ingredient_categories',
      row: { name: 'Protein', i18nNames: { es: 'Proteína', 'zh-CN': '蛋白质' } },
    },
  ] as const;

  for (const { table, row } of fixtures) {
    it(`${table}: en mode returns canonical column`, () => {
      const canonical = (row as any).menuItem ?? (row as any).name;
      expect(getLocalizedName(row, 'en')).toBe(canonical);
    });
    it(`${table}: es mode returns es override`, () => {
      expect(getLocalizedName(row, 'es')).toBe(row.i18nNames.es);
    });
    it(`${table}: zh-CN mode returns zh-CN override`, () => {
      expect(getLocalizedName(row, 'zh-CN')).toBe(row.i18nNames['zh-CN']);
    });
  }
});
