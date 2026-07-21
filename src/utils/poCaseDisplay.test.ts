// src/utils/poCaseDisplay.test.ts — Spec 134 (AC-8).
//
// Pins the PURE units⇄cases conversion for the PO order-lines table: case rows
// read/edit in cases, unit rows verbatim, fractional cases DISPLAY exact (never
// rounded — AC-5), the edit write-back is `round(cases) × caseQty` base units,
// and the load-bearing `poResolveEdit` no-op guard that prevents the 85→84
// focus-blur corruption. Mirrors the purity discipline of the sibling
// `poQuickOrderText.test.ts` — no component mount, pure functions only.

import {
  isCaseRow,
  poOrderedToCases,
  poCasesToBase,
  poCasePrice,
  poOrderedDisplay,
  poResolveEdit,
} from './poCaseDisplay';

describe('isCaseRow', () => {
  it('is true only for caseQty > 1', () => {
    expect(isCaseRow(6)).toBe(true);
    expect(isCaseRow(2)).toBe(true);
    expect(isCaseRow(1)).toBe(false);
    expect(isCaseRow(0)).toBe(false);
    expect(isCaseRow(0.5)).toBe(false);
    expect(isCaseRow(-3)).toBe(false);
    expect(isCaseRow(NaN)).toBe(false);
    // null/undefined coerce through the numeric call sites as NaN/0.
    expect(isCaseRow(Number(null))).toBe(false);
    expect(isCaseRow(Number(undefined))).toBe(false);
  });
});

describe('whole-case line (caseQty=6, orderedQty=84 → 14 cases)', () => {
  it('displays 14 cases exact', () => {
    expect(poOrderedToCases(84, 6)).toBe(14);
    expect(poOrderedDisplay(84, 6)).toBe('14');
  });

  it('an edit to 13 cases writes 78 base units', () => {
    expect(poCasesToBase(13, 6)).toBe(78);
    expect(poResolveEdit('13', 84, 6)).toEqual({ write: true, base: 78 });
  });

  it('an untouched line (retyping the seed) issues NO write', () => {
    expect(poResolveEdit('14', 84, 6)).toEqual({ write: false, base: 84 });
  });

  it('"14.0" retyped resolves to the same 84 base → no write', () => {
    expect(poResolveEdit('14.0', 84, 6)).toEqual({ write: false, base: 84 });
  });
});

describe('fractional-case line (caseQty=6, orderedQty=85 → 14.17 cases)', () => {
  it('displays the exact decimal, NOT rounded', () => {
    expect(poOrderedToCases(85, 6)).toBeCloseTo(14.1666, 3);
    expect(poOrderedDisplay(85, 6)).toBe('14.17');
  });

  it('an UNTOUCHED fractional line (seed focus+blur) issues NO write — no 85→84 corruption', () => {
    expect(poResolveEdit('14.17', 85, 6)).toEqual({ write: false, base: 85 });
  });

  it('a fractional line the operator DOES retype writes the whole-case product', () => {
    expect(poResolveEdit('14', 85, 6)).toEqual({ write: true, base: 84 });
  });
});

describe('unit rows (caseQty=1 / 0 / null → no case treatment)', () => {
  it('display, conversion, and edit are verbatim base units for caseQty=1', () => {
    expect(isCaseRow(1)).toBe(false);
    expect(poOrderedToCases(84, 1)).toBe(84);
    expect(poOrderedDisplay(84, 1)).toBe('84');
    expect(poCasesToBase(84, 1)).toBe(84);
  });

  it('caseQty=0 behaves as a unit row', () => {
    expect(poOrderedDisplay(84, 0)).toBe('84');
    expect(poCasesToBase(84, 0)).toBe(84);
  });

  it('unit rows preserve fractional edits verbatim', () => {
    expect(poCasesToBase(12.5, 1)).toBe(12.5);
    expect(poResolveEdit('12.5', 10, 1)).toEqual({ write: true, base: 12.5 });
  });

  it('an untouched unit row issues NO write', () => {
    expect(poResolveEdit('84', 84, 1)).toEqual({ write: false, base: 84 });
  });
});

describe('poResolveEdit input validation (per §3 guard)', () => {
  it('non-numeric text (NaN) never writes', () => {
    expect(poResolveEdit('abc', 84, 6)).toEqual({ write: false, base: 84 });
  });

  it('negative text never writes', () => {
    expect(poResolveEdit('-1', 84, 6)).toEqual({ write: false, base: 84 });
  });
});

describe('case price + LINE $ identity (AC-3 / AC-4)', () => {
  it('case price is costPerUnit × caseQty', () => {
    expect(poCasePrice(2.5, 6)).toBe(15);
    expect(poCasePrice(2.5, 1)).toBe(2.5);
    expect(poCasePrice(2.5, 0)).toBe(2.5);
  });

  it('cases × casePrice === orderedQty × costPerUnit for whole-case lines', () => {
    const orderedQty = 84;
    const caseQty = 6;
    const costPerUnit = 2.5;
    const cases = poOrderedToCases(orderedQty, caseQty);
    const casePrice = poCasePrice(costPerUnit, caseQty);
    expect(cases * casePrice).toBeCloseTo(orderedQty * costPerUnit, 6);
  });

  it('cases × casePrice === orderedQty × costPerUnit even for fractional display', () => {
    const orderedQty = 85;
    const caseQty = 6;
    const costPerUnit = 2.5;
    const cases = poOrderedToCases(orderedQty, caseQty);
    const casePrice = poCasePrice(costPerUnit, caseQty);
    expect(cases * casePrice).toBeCloseTo(orderedQty * costPerUnit, 6);
  });
});
