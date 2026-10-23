// src/lib/eodNoNeed.spec174.test.ts — Spec 174 (AC-1, AC-20).
//
// `isReorderNoNeed` is the ONE predicate every spec 174 surface (five export
// builders + the phone Ordering card) uses to decide "this reorder row was
// counted NO NEED". Only the `no_need` flag token makes a row NO NEED — a zero
// on-hand / zero suggestion / `needsOrder: false` alone does not (AC-20).

import * as shared from './eodNoNeed';
import * as barrel from '../screens/staff/lib/eodNoNeed';
import { isReorderNoNeed, REORDER_FLAG_NO_NEED } from './eodNoNeed';

describe('Spec 174 — isReorderNoNeed', () => {
  it('is true when the flags carry the no_need token', () => {
    expect(isReorderNoNeed({ flags: [REORDER_FLAG_NO_NEED] })).toBe(true);
    expect(isReorderNoNeed({ flags: ['no_need'] })).toBe(true);
    expect(isReorderNoNeed({ flags: ['no_par', 'no_need'] })).toBe(true);
  });

  it('is false for empty / null / absent flags (null-safe)', () => {
    expect(isReorderNoNeed({ flags: [] })).toBe(false);
    expect(isReorderNoNeed({ flags: null })).toBe(false);
    expect(isReorderNoNeed({ flags: undefined })).toBe(false);
    expect(isReorderNoNeed({})).toBe(false);
  });

  it('is false for other tokens', () => {
    expect(isReorderNoNeed({ flags: ['no_par'] })).toBe(false);
    expect(isReorderNoNeed({ flags: ['no_usage_rate', 'eod_missing_for_item'] })).toBe(false);
  });

  it('AC-20 — a zero-but-not-flagged row is NOT NO NEED', () => {
    const zeroRow = {
      onHand: 0,
      suggestedQty: 0,
      suggestedUnits: 0,
      needsOrder: false,
      flags: ['no_par'],
    };
    expect(isReorderNoNeed(zeroRow)).toBe(false);
  });

  it('AC-1 — the staff barrel re-exports the shared predicate by identity', () => {
    expect(barrel.isReorderNoNeed).toBe(shared.isReorderNoNeed);
  });
});
