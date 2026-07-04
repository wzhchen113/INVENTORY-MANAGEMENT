// src/screens/cmd/lib/priceGuard.test.ts — Spec 109 (cost-on-receipt), FE slice.
//
// Pins the pure 30%-fat-finger-guard predicate + the ★-bridge expected-case
// price. The load-bearing case is the BASIS BRIDGE: the baseline is a
// PER-COUNTED-UNIT snapshot, the entered value is a CASE price, and the guard
// must bridge to case-to-case (via `costPerUnit × caseQty`) before comparing —
// a naive per-counted-vs-case comparison gives the WRONG delta whenever
// caseQty ≠ 1. Every case below fixes a §15 jest bullet.

import { expectedCasePrice, isPriceGuardTripped, PRICE_GUARD_FRACTION } from './priceGuard';
import { t } from '../../../i18n';

describe('expectedCasePrice — ★ bridge (per-counted × caseQty)', () => {
  it('reconstructs the case price from the per-counted snapshot', () => {
    // costPerUnit is per-COUNTED-unit; × caseQty = the case price the PO was
    // built from. 4/counted × 10 cases-worth = $40 case.
    expect(expectedCasePrice(4, 10)).toBe(40);
    expect(expectedCasePrice(1.6, 25)).toBe(40);
  });

  it('returns 0 for a non-positive / non-finite baseline (no meaningful expected)', () => {
    expect(expectedCasePrice(0, 10)).toBe(0);
    expect(expectedCasePrice(4, 0)).toBe(0);
    expect(expectedCasePrice(Number.NaN, 10)).toBe(0);
    expect(expectedCasePrice(-4, 10)).toBe(0);
  });
});

describe('isPriceGuardTripped — >30% delta, bridged case-to-case', () => {
  it('exact bridge math: expected = per-counted × caseQty', () => {
    // expected = 4 × 10 = 40. Entered exactly 40 → 0% delta → not tripped.
    expect(isPriceGuardTripped({ costPerUnit: 4, caseQty: 10, enteredCasePrice: 40 })).toBe(false);
  });

  it('flags a >30% increase', () => {
    // expected 40; entered 55 → 37.5% up → tripped.
    expect(isPriceGuardTripped({ costPerUnit: 4, caseQty: 10, enteredCasePrice: 55 })).toBe(true);
  });

  it('flags a >30% decrease (either direction)', () => {
    // expected 40; entered 25 → 37.5% down → tripped.
    expect(isPriceGuardTripped({ costPerUnit: 4, caseQty: 10, enteredCasePrice: 25 })).toBe(true);
  });

  it('does NOT flag a delta at or below 30%', () => {
    // expected 40; entered 52 → exactly 30% → NOT tripped (strictly > 0.30).
    expect(isPriceGuardTripped({ costPerUnit: 4, caseQty: 10, enteredCasePrice: 52 })).toBe(false);
    // 28 → 30% down → NOT tripped.
    expect(isPriceGuardTripped({ costPerUnit: 4, caseQty: 10, enteredCasePrice: 28 })).toBe(false);
    // 45 → 12.5% up → NOT tripped.
    expect(isPriceGuardTripped({ costPerUnit: 4, caseQty: 10, enteredCasePrice: 45 })).toBe(false);
  });

  it('does NOT flag when there is no meaningful baseline (expected <= 0)', () => {
    // A 0 snapshot has no baseline — skip the check (still sent + audited
    // server-side), never trip. This is the guard-the-expected>0 branch.
    expect(isPriceGuardTripped({ costPerUnit: 0, caseQty: 10, enteredCasePrice: 999 })).toBe(false);
    expect(isPriceGuardTripped({ costPerUnit: 4, caseQty: 0, enteredCasePrice: 999 })).toBe(false);
  });

  it('does NOT flag a non-finite entered value', () => {
    expect(isPriceGuardTripped({ costPerUnit: 4, caseQty: 10, enteredCasePrice: Number.NaN })).toBe(false);
  });

  it('BRIDGE PIN: caseQty > 1 — a naive per-counted-vs-case comparison would flag the wrong number', () => {
    // Per-counted snapshot 4, caseQty 12 → expected CASE price = 48.
    // Operator enters the true case price 50 (a 4.2% change → must NOT trip).
    // A NAIVE (unbridged) guard would compare entered 50 against the per-counted
    // 4, computing an absurd |50 − 4| / 4 = 1150% delta and WRONGLY trip. The
    // bridge is what makes this correct.
    expect(isPriceGuardTripped({ costPerUnit: 4, caseQty: 12, enteredCasePrice: 50 })).toBe(false);
    // And a genuine >30% swing on the bridged basis still trips: 48 → 70 (45.8%).
    expect(isPriceGuardTripped({ costPerUnit: 4, caseQty: 12, enteredCasePrice: 70 })).toBe(true);
  });

  it('exposes the 30% threshold constant', () => {
    expect(PRICE_GUARD_FRACTION).toBe(0.3);
  });
});

describe('spec 109 i18n — the 30%-guard copy interpolates old→new', () => {
  // Pins the real t() rendering of the price-guard strings the section builds,
  // across all three locales (the section test's useT mock returns raw keys).
  for (const locale of ['en', 'es', 'zh-CN'] as const) {
    it(`priceGuardLine renders item + old → new (${locale})`, () => {
      const rendered = t(locale, 'section.receiving.priceGuardLine', { item: 'Flour', old: '40.00', new: '55.00' });
      expect(rendered).toContain('Flour');
      expect(rendered).toContain('40.00');
      expect(rendered).toContain('55.00');
      // No unresolved placeholders leaked through.
      expect(rendered).not.toMatch(/\{(item|old|new)\}/);
    });

    it(`priceGuardBody embeds the flagged-line list (${locale})`, () => {
      const list = t(locale, 'section.receiving.priceGuardLine', { item: 'Flour', old: '40.00', new: '55.00' });
      const body = t(locale, 'section.receiving.priceGuardBody', { lines: list });
      expect(body).toContain('Flour');
      expect(body).not.toMatch(/\{lines\}/);
    });

    it(`pricesUpdatedToast renders the count (${locale})`, () => {
      const toast = t(locale, 'section.receiving.pricesUpdatedToast', { count: 3 });
      expect(toast).toContain('3');
      expect(toast).not.toMatch(/\{count\}/);
    });
  }
});
