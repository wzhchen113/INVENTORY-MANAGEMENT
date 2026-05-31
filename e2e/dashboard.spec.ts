// e2e/dashboard.spec.ts — Spec 078 Phase 4: admin dashboard (AC-DASH1).
//
// Signed in as admin (storageState), navigate to the Dashboard section and
// assert its primary KPI/summary surface renders against seed data using a
// STABLE selector — not a seed-dependent dollar value (assert structure/
// presence, per AC-DASH1).
//
// Navigation: stable sidebar nav testID (spec 079 flake-kill — no section
// URL, no i18n-fragile label text). Assertion targets are the §7 section-root
// + KPI-container testIDs.
//
// Selector contract: dashboard-root, dashboard-kpis (078 §7);
// nav-Dashboard (079 §6 SIDEBAR_NAV).

import { test, expect } from '@playwright/test';
import { SIDEBAR_NAV, STORAGE_STATE } from './fixtures/constants';

test.use({ storageState: STORAGE_STATE.admin });

test('AC-DASH1: dashboard KPI surface renders', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('cmd-shell-root')).toBeVisible();

  await page.getByTestId(SIDEBAR_NAV.dashboard).click();

  await expect(page.getByTestId('dashboard-root')).toBeVisible();
  // Assert the KPI cards container is present (structure, not values).
  await expect(page.getByTestId('dashboard-kpis')).toBeVisible();
});
