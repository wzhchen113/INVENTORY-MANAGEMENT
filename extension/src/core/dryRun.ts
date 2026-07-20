// Spec 132 (D-5) — the dry-run gate. A SINGLE boundary that gates BOTH side
// effects (AC-10): the cart-fill add-to-cart AND the spec-131 mark-ordered
// write. Dry-run is the DEFAULT posture; a live run is an explicit opt-in.
// Matching + report assembly run identically in both modes, so matching is
// validated before anything touches a real cart. Pure + total (AC-12).

import type { PlannedAction } from '../lib/types';

/**
 * The actions the extension will actually EXECUTE against the live cart.
 *   • dry-run  → `[]` (no add-to-cart side effect — AC-10).
 *   • live     → only the RESOLVABLE actions ('url' | 'search'); 'unmapped'
 *                lines are never executed (they are reported unmatched — AC-5).
 * This is the one place the cart-fill side effect is gated; the caller executes
 * exactly what this returns.
 */
export function actionsToExecute(plan: PlannedAction[], dryRun: boolean): PlannedAction[] {
  if (dryRun) return [];
  return plan.filter((a) => a.resolution !== 'unmapped');
}

/**
 * Whether the spec-131 mark-ordered write-back may fire. Dry-run NEVER writes
 * back (AC-10). The same gate covers the second side effect so a single boolean
 * governs both — testable in isolation.
 */
export function canMarkOrdered(dryRun: boolean): boolean {
  return !dryRun;
}
