// src/screens/cmd/lib/priceGuard.ts — Spec 109 (cost-on-receipt), FE slice.
//
// Pure helpers for the ReceivingSection PO-mode "case price this delivery"
// input: the ghosted-expected baseline and the 30% fat-finger guard (OQ-4).
//
// ── Basis bridge (load-bearing, pinned by the design §6/§12) ─────────────────
// The expected baseline derives from `po_items.cost_per_unit`, which is
// PER-COUNTED-UNIT (spec 107 OQ-6). The operator enters a CASE price (OQ-3).
// The two are NOT comparable directly — the guard MUST bring both to the SAME
// basis before computing the delta, or it fires on the wrong number.
//
// Per the ★ spec-104 formula, per-each = case_price / (case_qty × sub_unit_size),
// and the draft stored costPerUnitCounted = per-each × sub_unit_size = case_price
// / case_qty. Therefore:
//
//   expected_case_price = costPerUnit(per-counted) × caseQty
//
// which reconstructs the exact case price the PO draft was built from. The guard
// then compares CASE-to-CASE: |entered − expected| / expected.
//
// These functions are exported for jest (see priceGuard.test.ts) and consumed by
// ReceivingSection.tsx. They hold NO React / RN dependency on purpose so the unit
// test can exercise the bridge math without rendering.

/** Fraction of the expected baseline beyond which the receive requires an extra
 *  human confirm (OQ-4). A 30% swing either direction trips the guard. */
export const PRICE_GUARD_FRACTION = 0.3;

/**
 * The ghosted "expected" CASE price for a PO line — the price the PO was created
 * at, reconstructed from the per-COUNTED-unit snapshot via the ★ bridge
 * (`costPerUnit × caseQty`). Non-finite / negative inputs collapse to 0 (no
 * meaningful baseline). This is BOTH the ghost prefill and the 30% guard
 * baseline, so the two never diverge.
 */
export function expectedCasePrice(costPerUnit: number, caseQty: number): number {
  const cpu = Number.isFinite(costPerUnit) ? costPerUnit : 0;
  const cq = Number.isFinite(caseQty) ? caseQty : 0;
  const expected = cpu * cq;
  return expected > 0 ? expected : 0;
}

/**
 * True iff `enteredCasePrice` differs from the ghosted expected CASE price by
 * more than PRICE_GUARD_FRACTION (30%), on a consistent case-to-case basis.
 *
 * Returns false when there is no meaningful baseline (`expected <= 0`) — such a
 * line still SENDS its price and is still audited server-side, it simply skips
 * the 30% confirm (there is nothing to compare against). Also false for a
 * non-finite entered value.
 *
 * The bridge is applied INSIDE this function (`expectedCasePrice` does the
 * per-counted → case reconstruction), so a caller that passes the raw
 * per-counted `costPerUnit` + `caseQty` + entered CASE price gets a correct
 * like-for-like delta — a naive per-counted-vs-case comparison would be wrong
 * whenever caseQty ≠ 1.
 */
export function isPriceGuardTripped(args: {
  costPerUnit: number;
  caseQty: number;
  enteredCasePrice: number;
}): boolean {
  const { costPerUnit, caseQty, enteredCasePrice } = args;
  const expected = expectedCasePrice(costPerUnit, caseQty);
  if (expected <= 0) return false;
  if (!Number.isFinite(enteredCasePrice)) return false;
  const deltaFraction = Math.abs(enteredCasePrice - expected) / expected;
  return deltaFraction > PRICE_GUARD_FRACTION;
}
