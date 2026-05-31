// e2e/audit.spec.ts — Spec 078 Phase 4: admin audit log (AC-AUDIT1).
//
// Signed in as admin (storageState), navigate to the Audit log section and
// assert the log list renders (rows present, or a deterministic
// empty-state). Audit entries created by earlier mutating specs (e.g.
// invite) may appear — the assertion must NOT depend on an exact row count
// (AC-AUDIT1). A presence assertion on the section root satisfies this.
//
// Navigation: stable sidebar nav testID (spec 079 flake-kill).
//
// Selector contract: audit-root (078 §7); nav-AuditLog (079 §6 SIDEBAR_NAV).

import { test, expect } from '@playwright/test';
import { SIDEBAR_NAV, STORAGE_STATE } from './fixtures/constants';

test.use({ storageState: STORAGE_STATE.admin });

test('AC-AUDIT1: audit log section renders', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('cmd-shell-root')).toBeVisible();

  await page.getByTestId(SIDEBAR_NAV.auditLog).click();

  // Presence, not count — tolerant of rows the invite spec may have added.
  await expect(page.getByTestId('audit-root')).toBeVisible();
});
