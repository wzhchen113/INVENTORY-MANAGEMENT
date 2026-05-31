// e2e/reorder.spec.ts — Spec 078 Phase 4: admin reorder (AC-REORD1).
//
// Signed in as admin (storageState), navigate to the Reorder section and
// assert the reorder list/table renders from seed. A render assertion on a
// stable structural element (the section root) is acceptable for v1
// (AC-REORD1) — no mutating action is exercised.
//
// Selector contract (frozen §7): reorder-root.

import { test, expect } from '@playwright/test';
import { SIDEBAR_LABEL, STORAGE_STATE } from './fixtures/constants';

test.use({ storageState: STORAGE_STATE.admin });

test('AC-REORD1: reorder section renders from seed', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('cmd-shell-root')).toBeVisible();

  await page.getByText(SIDEBAR_LABEL.reorder, { exact: true }).first().click();

  // Structural assertion — the section mounted. Whether the list has rows
  // or an empty-state is seed-dependent; presence of the root is not.
  await expect(page.getByTestId('reorder-root')).toBeVisible();
});
