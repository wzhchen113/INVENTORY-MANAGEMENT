// src/utils/perEachCost.spec207.test.ts — Spec 207 (AC-4 parity, design D-9).
//
// Spec 207 moved the per-each cost rule into SQL: public.pieces_per_case(q, s)
// and public.per_each_cost(price, q, s) in
// supabase/migrations/20261123130000_recompute_costs_on_pack_size_change.sql.
// This file is the TS side of the AC-4 parity check. It pins the SAME literal
// input matrix as the "AC-4 helper matrix" block in
// supabase/tests/cost_rederive_on_pack_size.test.sql; reviewers check the two
// matrices match row for row.
//
// - piecesPerCase is asserted for EVERY input (SQL pieces_per_case mirrors it).
// - calcUnitCost is asserted only for caseQty > 0. For caseQty <= 0 it returns
//   0 (spec 104's narrow dead-input guard), while per_each_cost treats the
//   factor as 1 (design D-2 interpretation note). The editor never stores
//   case_qty <= 0, so that gap is reachable only by direct SQL.
// - SQL NULL has no `number` form. The matrix uses NaN in its place: the
//   nearest TS shape, which piecesPerCase also floors to 1 (non-finite), the
//   same result SQL gives NULL.
// - per_each_cost rounds to 6 dp (numeric(12,6), the editor's toFixed(6)), so
//   the TS side is compared after toFixed(6).

import { piecesPerCase } from './perEachCost';
import { calcUnitCost } from './unitConversion';

// [caseQty, subUnitSize, pieces, per_each_cost(30, q, s)] — same rows, same
// order as the pgTAP `_m` table. NaN stands for SQL NULL.
const MATRIX: ReadonlyArray<readonly [number, number, number, number]> = [
  [NaN, NaN, 1, 30.0], [NaN, 0, 1, 30.0], [NaN, 35, 35, 0.857143],
  [0, NaN, 1, 30.0],   [0, 0, 1, 30.0],   [0, 35, 35, 0.857143],
  [-1, NaN, 1, 30.0],  [-1, 0, 1, 30.0],  [-1, 35, 35, 0.857143],
  [2, NaN, 2, 15.0],   [2, 0, 2, 15.0],   [2, 35, 70, 0.428571],
];

const round6 = (n: number): number => Number(n.toFixed(6));

describe('spec 207 AC-4 parity: piecesPerCase ↔ public.pieces_per_case', () => {
  it.each(MATRIX)('piecesPerCase(%p, %p) = %p (cost %p)', (q, s, pieces) => {
    expect(piecesPerCase(q, s)).toBe(pieces);
  });

  it('non-finite factors count as 1 (the SQL < Infinity bound)', () => {
    expect(piecesPerCase(Infinity, 2)).toBe(2);
    expect(piecesPerCase(NaN, 2)).toBe(2);
    expect(piecesPerCase(2, -Infinity)).toBe(2);
  });
});

describe('spec 207 AC-4 parity: case_price / piecesPerCase ↔ public.per_each_cost(30, q, s)', () => {
  it.each(MATRIX)('q %p, s %p → pieces %p → round6(30 / pieces) = %p', (q, s, _pieces, cost) => {
    expect(round6(30 / piecesPerCase(q, s))).toBe(cost);
  });
});

describe('spec 207 AC-4 parity: calcUnitCost ↔ public.per_each_cost, caseQty > 0 only', () => {
  const positive = MATRIX.filter(([q]) => q > 0);

  it('the caseQty > 0 slice is non-empty', () => {
    expect(positive.length).toBe(3);
  });

  it.each(positive)('calcUnitCost(30, q %p, s %p) (pieces %p) rounds to %p', (q, s, _pieces, cost) => {
    expect(round6(calcUnitCost(30, q, s))).toBe(cost);
  });
});
