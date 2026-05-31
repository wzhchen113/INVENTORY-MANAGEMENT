// e2e/reorder.spec.ts — Spec 078 Phase 4 + Spec 079 action depth.
//
// Signed in as admin (storageState), navigate to the Reorder section and
// exercise the action surface that actually EXISTS.
//
// AC-REORD-DEPTH-1 (spec 079): the Reorder section has NO durable mutating
// action (no mark-ordered / generate-PO) — its only actions are CSV export,
// PDF export, and Refresh (ReorderSection.tsx). So the deepening is:
//   1. assert the section renders (the spec-078 floor — reorder-root visible),
//   2. exercise Refresh (the GUARANTEED floor — it's OUTSIDE the showExport
//      gate, so it always renders) and assert the loading→loaded transition
//      completes (the REFRESH label returns from 'LOADING…' to 'REFRESH') and
//      the section stays mounted,
//   3. DEFENSIVELY assert the export controls are visible+enabled WHEN the
//      selected store has a non-empty reorder payload (the showExport gate:
//      Platform.OS === 'web' AND reorderPayload.vendors.length > 0 AND no
//      error AND not initial-loading). If the default store yields an empty
//      payload the export buttons won't render — so the export check is
//      conditional on their presence, never a hard precondition.
// NO file-download assertion (page.waitForEvent('download')) — excluded from
// v1 per the design (jsPDF/PapaParse blob downloads on RN-web are a flake
// surface; the enable+refresh+loaded-transition is the meaningful floor).
//
// Navigation: stable sidebar nav testID (spec 079 flake-kill).
//
// Selector contract: reorder-root (078 §7); reorder-export-csv /
// reorder-export-pdf / reorder-refresh (079 §6 — FROZEN); nav-Reorder
// (079 §6 SIDEBAR_NAV).

import { test, expect } from '@playwright/test';
import { SIDEBAR_NAV, STORAGE_STATE } from './fixtures/constants';

test.use({ storageState: STORAGE_STATE.admin });

test('AC-REORD-DEPTH-1: reorder renders, Refresh round-trips, exports gate on payload', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('cmd-shell-root')).toBeVisible();

  await page.getByTestId(SIDEBAR_NAV.reorder).click();

  // Structural floor (spec-078 AC-REORD1): the section mounted.
  await expect(page.getByTestId('reorder-root')).toBeVisible();

  // ── Refresh: the GUARANTEED action (outside the showExport gate) ────────
  // It always renders. Click it and assert the loading→loaded transition
  // completes — the label returns from 'LOADING…' to 'REFRESH' — and the
  // section stays mounted. This exercises the action surface deterministically
  // without depending on payload content.
  const refresh = page.getByTestId('reorder-refresh');
  await expect(refresh).toBeVisible();
  await refresh.click();
  // The button text returns to 'REFRESH' once the reload settles. Generous
  // timeout: a refresh re-fetches the reorder payload from the live stack.
  await expect(refresh).toHaveText('REFRESH', { timeout: 15_000 });
  await expect(page.getByTestId('reorder-root')).toBeVisible(); // still mounted

  // ── Export controls: DEFENSIVE — assert only when the payload is non-empty
  // The showExport gate requires the selected store's reorder payload to have
  // vendors. The seed has Towson inventory across vendors, so the default
  // admin store SHOULD yield a non-empty payload and render the export
  // buttons. But we do NOT make that a hard precondition (architect risk #2):
  // if the default store's payload is empty, the buttons legitimately don't
  // render and the Refresh assertions above remain the meaningful floor.
  const csv = page.getByTestId('reorder-export-csv');
  // DELIBERATE one-shot (non-retrying) snapshot: by here the Refresh reload
  // has already settled (the `toHaveText('REFRESH')` wait at line 56 gates
  // the loaded state), so this read reflects the FINAL payload, not a
  // mid-load transient. We want a snapshot — not an auto-retrying assertion —
  // precisely because "buttons absent" is a legitimate terminal state (empty
  // payload), and a retrying `expect(...).toBeVisible()` would hang 10s then
  // fail on that valid path. `.catch(() => false)` guards the detached case.
  const exportVisible = await csv.isVisible().catch(() => false);
  if (exportVisible) {
    // When the export surface IS present, both buttons must be enabled
    // (showExport gates both together). Symmetric treatment — both are
    // already known visible under the same gate, so assert enabled-ness only.
    await expect(page.getByTestId('reorder-export-csv')).toBeEnabled();
    await expect(page.getByTestId('reorder-export-pdf')).toBeEnabled();
  }
});
