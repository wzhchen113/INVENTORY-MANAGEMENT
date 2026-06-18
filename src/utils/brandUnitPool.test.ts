// src/utils/brandUnitPool.test.ts — Spec 096 (Issue 1).
//
// Pure-logic jest for the derived brand unit pool. Fast node-env project
// (no `.tsx`/RN import). Pins: union across all three sources
// (catalogIngredients.unit, catalogIngredients.subUnitUnit,
// conversions.purchaseUnit); lower(name) de-dupe with first-seen casing
// preserved (AC5, mirrors catalog_ingredients_brand_name_lower_unique); empty
// input → empty pool.

import { deriveBrandUnitPool } from './brandUnitPool';

describe('deriveBrandUnitPool (spec 096 §Q-C — derived, brand-scoped by construction)', () => {
  it('empty input → empty pool', () => {
    expect(deriveBrandUnitPool({ catalogIngredients: [], conversions: [] })).toEqual([]);
  });

  it('unions BOTH ingredient axes — unit AND subUnitUnit (the AC1 gap-closer)', () => {
    const pool = deriveBrandUnitPool({
      catalogIngredients: [{ unit: 'cases', subUnitUnit: 'Pack' }],
      conversions: [],
    });
    // "Pack" lives on subUnitUnit; it MUST surface in the pool so it can be
    // offered in a sibling ingredient's dropdowns.
    expect(pool).toContain('Pack');
    expect(pool).toContain('cases');
  });

  it('unions conversion purchase units alongside the ingredient axes', () => {
    const pool = deriveBrandUnitPool({
      catalogIngredients: [{ unit: 'each', subUnitUnit: 'lbs' }],
      conversions: [{ purchaseUnit: 'box' }],
    });
    expect(pool).toEqual(expect.arrayContaining(['each', 'lbs', 'box']));
  });

  it('de-dupes case-insensitively on lower(name) (AC5)', () => {
    const pool = deriveBrandUnitPool({
      catalogIngredients: [
        { unit: 'Pack', subUnitUnit: '' },
        { unit: 'pack', subUnitUnit: 'PACK' },
      ],
      conversions: [{ purchaseUnit: 'pAcK' }],
    });
    // Exactly one entry for the "pack" key across four differently-cased uses.
    expect(pool.filter((u) => u.toLowerCase() === 'pack')).toHaveLength(1);
  });

  it('preserves FIRST-seen casing for a de-duped key', () => {
    // First-seen order is: all catalogIngredients.unit, then all
    // catalogIngredients.subUnitUnit, then conversions.purchaseUnit.
    // "Pack" (title-case) appears first.
    const pool = deriveBrandUnitPool({
      catalogIngredients: [
        { unit: 'Pack', subUnitUnit: '' },
        { unit: 'pack', subUnitUnit: '' },
      ],
      conversions: [],
    });
    expect(pool).toContain('Pack');
    expect(pool).not.toContain('pack');
  });

  it('catalogIngredients.unit is seen before .subUnitUnit for casing precedence', () => {
    // Same key on two axes: the `unit` axis (iterated first) wins the casing.
    const pool = deriveBrandUnitPool({
      catalogIngredients: [{ unit: 'Tray', subUnitUnit: 'tray' }],
      conversions: [],
    });
    expect(pool).toContain('Tray');
    expect(pool).not.toContain('tray');
  });

  it('skips empty / whitespace-only names on every axis', () => {
    const pool = deriveBrandUnitPool({
      catalogIngredients: [{ unit: '', subUnitUnit: '   ' }],
      conversions: [{ purchaseUnit: '\t' }],
    });
    expect(pool).toEqual([]);
  });

  it('trims surrounding whitespace before de-dupe and storage', () => {
    const pool = deriveBrandUnitPool({
      catalogIngredients: [{ unit: '  case  ', subUnitUnit: '' }],
      conversions: [{ purchaseUnit: 'case' }],
    });
    expect(pool).toEqual(['case']);
  });
});
