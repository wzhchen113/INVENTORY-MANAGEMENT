// src/screens/cmd/lib/__tests__/itemMoney.test.ts — Spec 112.
//
// Pins the ★ single cost-definition helpers (spec 104 per-each basis). These
// are the ONE definition of each money string consumed by BOTH the
// InventoryTable cells and the DetailPane header — this unit test pins the
// numbers independently of the render tree so a basis regression fails here
// too. Pure-TS: runs in the fast node-env unit project (jest.config
// `src/screens/cmd/lib/**/*.test.ts`).

import {
  stockValue,
  formatStockValue,
  costPerEachLabel,
  formatCostPerEach,
} from '../itemMoney';

describe('itemMoney — spec 104 per-each basis (spec 112 ★)', () => {
  describe('stockValue', () => {
    it('is currentStock × costPerUnit × subUnitSize (the :449 bridge)', () => {
      expect(stockValue({ currentStock: 3, costPerUnit: 0.02, subUnitSize: 2000 })).toBeCloseTo(120, 6);
    });

    it('defaults costPerUnit → 0 and subUnitSize → 1 when falsy', () => {
      expect(stockValue({ currentStock: 5, costPerUnit: null, subUnitSize: null })).toBe(0);
      expect(stockValue({ currentStock: 5, costPerUnit: 4, subUnitSize: null })).toBe(20); // ×1
      expect(stockValue({ currentStock: 0, costPerUnit: 4, subUnitSize: 3 })).toBe(0);
    });
  });

  describe('formatStockValue', () => {
    it('is $ + toFixed(0) — the spec-112 case-6 value pin', () => {
      expect(formatStockValue({ currentStock: 3, costPerUnit: 0.02, subUnitSize: 2000 })).toBe('$120');
    });

    it('rounds to whole dollars', () => {
      // 7 × 1.5 × 1 = 10.5 → "$11" (toFixed(0) rounds half up here)
      expect(formatStockValue({ currentStock: 7, costPerUnit: 1.5, subUnitSize: 1 })).toBe('$11');
      expect(formatStockValue({ currentStock: 0, costPerUnit: 0, subUnitSize: 0 })).toBe('$0');
    });
  });

  describe('costPerEachLabel', () => {
    it('is subUnitUnit, else "each"', () => {
      expect(costPerEachLabel({ subUnitUnit: 'g' })).toBe('g');
      expect(costPerEachLabel({ subUnitUnit: '' })).toBe('each');
      expect(costPerEachLabel({ subUnitUnit: null })).toBe('each');
    });
  });

  describe('formatCostPerEach', () => {
    it('is $ + costPerUnit.toFixed(2) when positive — the case-6 value pin', () => {
      expect(formatCostPerEach({ costPerUnit: 0.02 })).toBe('$0.02');
      expect(formatCostPerEach({ costPerUnit: 12.5 })).toBe('$12.50');
    });

    it('is "—" when costPerUnit is falsy (0 / null)', () => {
      expect(formatCostPerEach({ costPerUnit: 0 })).toBe('—');
      expect(formatCostPerEach({ costPerUnit: null })).toBe('—');
    });
  });
});
