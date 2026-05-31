// e2e/auth.setup.ts — Spec 078 auth-setup project (AC-A1).
//
// Logs in once per role via the REAL UI (fill email + password, click
// signin-submit, wait for the post-login landing surface), then saves
// storageState to a per-role file. Flow specs declare
// `test.use({ storageState })` + `dependencies: ['setup']` so they start
// already-signed-in (AC-A2); UI login is not repeated per test (except the
// dedicated sign-in spec, which exercises real login for AC-S1/S2/S3).
//
// OQ-3c POISON-QUEUE GUARD (critical): this setup performs NO EOD submit.
// The staff offline queue lives in localStorage under
// imr-staff:eod-queue:v1, and Playwright storageState serializes
// localStorage — so a setup that queued an item would carry it into every
// later run. By stopping at the landing surface, the saved staff.json
// holds auth tokens but no queue key. (The EOD specs additionally clear the
// key in beforeEach as defense in depth.)
//
// Selector contract (frozen §7): signin-email, signin-password,
// signin-submit (login screen); cmd-shell-root (admin landing);
// store-picker-root (staff landing — manager has two stores → StorePicker,
// not EODCount, per the verified seed fact in design §3).

import { test as setup, expect } from '@playwright/test';
import { DEMO, STORAGE_STATE } from './fixtures/constants';

setup('authenticate as admin', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('signin-email').fill(DEMO.adminEmail);
  await page.getByTestId('signin-password').fill(DEMO.password);
  await page.getByTestId('signin-submit').click();
  // Admin lands on the Cmd shell. cmd-shell-root is the breakpoint-agnostic
  // shell anchor (§7 #4).
  await expect(page.getByTestId('cmd-shell-root')).toBeVisible();
  await page.context().storageState({ path: STORAGE_STATE.admin });
});

setup('authenticate as master', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('signin-email').fill(DEMO.masterEmail);
  await page.getByTestId('signin-password').fill(DEMO.password);
  await page.getByTestId('signin-submit').click();
  // master@local.test lands on the Cmd shell like admin, but ALSO sees the
  // Users & access section (master-gated, Spec 030) + the invite-role chips.
  // The invite spec runs under this storageState. No EOD submit here (OQ-3c).
  await expect(page.getByTestId('cmd-shell-root')).toBeVisible();
  await page.context().storageState({ path: STORAGE_STATE.master });
});

setup('authenticate as staff', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('signin-email').fill(DEMO.staffEmail);
  await page.getByTestId('signin-password').fill(DEMO.password);
  await page.getByTestId('signin-submit').click();
  // manager@local.test (role='user') is granted TWO stores (Towson +
  // Frederick) with no persisted active store → StorePicker renders, NOT
  // EODCount. The EOD specs navigate picker → EOD by tapping a store row.
  // No EOD submit happens here (OQ-3c), so the saved staff.json carries no
  // queue key.
  await expect(page.getByTestId('store-picker-root')).toBeVisible();
  await page.context().storageState({ path: STORAGE_STATE.staff });
});
