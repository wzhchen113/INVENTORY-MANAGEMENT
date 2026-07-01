// src/utils/perEachCost.test.ts — Spec 096 (Issue 2).
//
// Pure-logic jest for the per-each cost helpers. Lives in src/utils/ (fast
// node-env project) because it imports a `.ts` module with no `.tsx`/RN
// dependency — mirrors spec 046's `validateCustomUnit` test PLACEMENT but in
// the unit project, not the component project.
//
// piecesPerCase: the formula spec 096 §Q-A proves is a total function over the
// two axes — Cup (legacy packaging) → 2000, bulk (spec-093 "1 case = 20 lbs")
// → 20, case-of-bags (both axes) → 40, both-unset → 1.
//
// perEachCost: Cup → $0.18 from the real seed; AC8 null when piecesPerCase<=1;
// casePrice primary path vs costPerUnit fallback. Seed-pinned self-checks for
// the three catalog rows spec 096's build step calls out (8oz Cup, 3.25oz Cup,
// Aluminum Foil).

import { piecesPerCase, perEachCost } from './perEachCost';

describe('piecesPerCase (spec 096 §Q-A — caseQty × subUnitSize, each defaulting to 1)', () => {
  it('Cup w/ Lid (legacy packaging shape): 1 × 2000 = 2000', () => {
    expect(piecesPerCase(1, 2000)).toBe(2000);
  });

  it('bulk item (spec-093 "1 case = 20 lbs"): 20 × 1 = 20', () => {
    expect(piecesPerCase(20, 1)).toBe(20);
  });

  it('case of 4 bags × 10 each (both axes populated): 4 × 10 = 40', () => {
    expect(piecesPerCase(4, 10)).toBe(40);
  });

  it('both axes unset/zero default to 1 → 1', () => {
    expect(piecesPerCase(0, 0)).toBe(1);
    expect(piecesPerCase(1, 1)).toBe(1);
  });

  it('a single absent/zero factor defaults to 1 (mirrors mapItem parseFloat || 1)', () => {
    expect(piecesPerCase(0, 2000)).toBe(2000); // caseQty 0 → 1
    expect(piecesPerCase(250, 0)).toBe(250); // subUnitSize 0 → 1
  });

  it('negative / NaN factors default to 1 (defensive)', () => {
    expect(piecesPerCase(-5, 2000)).toBe(2000);
    expect(piecesPerCase(NaN, 2000)).toBe(2000);
    expect(piecesPerCase(250, NaN)).toBe(250);
  });
});

describe('perEachCost (spec 096 §Q-A — additive, never touches db.ts:3769-3779)', () => {
  it('AC8 — returns null when piecesPerCase <= 1 (tracking unit == smallest unit)', () => {
    // Floor Cleaner Fabuloso shape: caseQty=1, subUnitSize=1 → single price.
    expect(perEachCost({ casePrice: 4.49, costPerUnit: 4.49, caseQty: 1, subUnitSize: 1 })).toBeNull();
  });

  it('AC6 / 8oz Cup w/ Lid (seed): casePrice 44.50, caseQty 250, subUnitSize 1 → $0.178/each', () => {
    const r = perEachCost({ casePrice: 44.5, costPerUnit: 0.18, caseQty: 250, subUnitSize: 1 });
    expect(r).not.toBeNull();
    expect(r as number).toBeCloseTo(0.178, 3);
    // Rounds to the "$0.18/each" the build step pins.
    expect((r as number).toFixed(2)).toBe('0.18');
  });

  it('3.25oz Cup w/ Lid (seed): casePrice 49.00, caseQty 1, subUnitSize 2000 → $0.0245/each', () => {
    const r = perEachCost({ casePrice: 49, costPerUnit: 49, caseQty: 1, subUnitSize: 2000 });
    expect(r).not.toBeNull();
    expect(r as number).toBeCloseTo(0.0245, 4);
    expect((r as number).toFixed(2)).toBe('0.02');
  });

  it('Aluminum Foil 12" (seed): casePrice 86.99, caseQty 2400, subUnitSize 1 → ~$0.036/each', () => {
    const r = perEachCost({ casePrice: 86.99, costPerUnit: 0.04, caseQty: 2400, subUnitSize: 1 });
    expect(r).not.toBeNull();
    expect(r as number).toBeCloseTo(0.03624, 4);
    expect((r as number).toFixed(2)).toBe('0.04');
  });

  it('primary path divides casePrice by the REAL piece count (caseQty × subUnitSize), not caseQty alone (AC7)', () => {
    // caseQty=1, subUnitSize=2000 → if it wrongly divided by caseQty alone it
    // would be 49/1 = 49.00; the correct per-each is 49/2000 = 0.0245.
    const r = perEachCost({ casePrice: 49, costPerUnit: 49, caseQty: 1, subUnitSize: 2000 });
    expect(r as number).not.toBeCloseTo(49, 1);
    expect(r as number).toBeCloseTo(0.0245, 4);
  });

  it('falls back to costPerUnit AS-IS (identity) when casePrice is 0/unset — spec 104', () => {
    // Spec 104 REVERSES the old `costPerUnit / subUnitSize` fallback: `costPerUnit`
    // is now per-EACH end-to-end (the db.ts no-stored-cost fallback is per-each
    // too), so the per-each cost IS costPerUnit itself. Dividing by subUnitSize
    // again would double-divide. costPerUnit=10 (already per-each) → $10/each.
    // caseQty=2 keeps piecesPerCase (=10) > 1 so the row is eligible.
    expect(perEachCost({ casePrice: 0, costPerUnit: 10, caseQty: 2, subUnitSize: 5 })).toBeCloseTo(10, 10);
  });

  it('fallback prefers casePrice when BOTH bases are positive (primary path wins)', () => {
    // casePrice=20 over piecesPerCase=10 → 2.00 (primary), NOT costPerUnit path.
    expect(perEachCost({ casePrice: 20, costPerUnit: 99, caseQty: 2, subUnitSize: 5 })).toBeCloseTo(2, 10);
  });

  it('returns null when piecesPerCase > 1 but neither price basis is positive', () => {
    expect(perEachCost({ casePrice: 0, costPerUnit: 0, caseQty: 2, subUnitSize: 5 })).toBeNull();
  });

  it('fallback is subUnitSize-independent now (identity) — spec 104', () => {
    // Pre-104 this test pinned the zero-subUnitSize divisor guard. Post-104 the
    // fallback is identity and does not read subUnitSize at all, so a zero
    // subUnitSize is irrelevant: costPerUnit=7 (per-each) → 7. piecesPerCase=10
    // (caseQty=10, subUnitSize floored to 1) keeps the row eligible (>1).
    expect(perEachCost({ casePrice: 0, costPerUnit: 7, caseQty: 10, subUnitSize: 0 })).toBeCloseTo(7, 10);
  });
});
