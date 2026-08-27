// e2e/auth.spec.ts — Spec 078 Phase 1 sign-in smoke (AC-S1/S2/S3).
//
// The dedicated sign-in spec exercises REAL UI login (the setup project
// reuses storageState for every other spec; this one proves the login
// flow itself). It runs with NO stored session so each case starts at the
// login screen.
//
// Selector contract (frozen §7): signin-email, signin-password,
// signin-submit, signin-error (login); cmd-shell-root (admin landing);
// store-picker-root (staff landing).

import { test, expect } from '@playwright/test';
import { DEMO } from './fixtures/constants';

// Start signed-out: do NOT load a storageState file for this spec.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('sign-in', () => {
  test('AC-S1: admin credentials land on the Cmd shell', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('signin-email').fill(DEMO.adminEmail);
    await page.getByTestId('signin-password').fill(DEMO.password);
    await page.getByTestId('signin-submit').click();
    // Spec 161 — admin is privileged, so all four seeded stores are visible
    // and the gate comes first. This spec starts signed-OUT (no storageState),
    // so there is no remembered pick to skip it.
    await expect(page.getByTestId('store-gate-root')).toBeVisible();
    await page.getByText('Towson', { exact: true }).click();
    await expect(page.getByTestId('cmd-shell-root')).toBeVisible();
  });

  test('AC-S1b: the store gate only appears for a multi-store user', async ({ page }) => {
    // The staff counterpart (AC-S2 below) proves the same rule on the other
    // surface; this pins that the admin gate is a real screen, not a flash —
    // the shell must NOT be mounted underneath it while it is up.
    await page.goto('/');
    await page.getByTestId('signin-email').fill(DEMO.adminEmail);
    await page.getByTestId('signin-password').fill(DEMO.password);
    await page.getByTestId('signin-submit').click();

    await expect(page.getByTestId('store-gate-root')).toBeVisible();
    await expect(page.getByTestId('cmd-shell-root')).toHaveCount(0);
  });

  test('AC-S2: staff credentials land on the StorePicker', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('signin-email').fill(DEMO.staffEmail);
    await page.getByTestId('signin-password').fill(DEMO.password);
    await page.getByTestId('signin-submit').click();
    // manager has two stores → StorePicker (verified seed fact, design §3).
    await expect(page.getByTestId('store-picker-root')).toBeVisible();
  });

  test('AC-S3: bad credentials show the inline error and stay on login', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('signin-email').fill(DEMO.adminEmail);
    await page.getByTestId('signin-password').fill('wrong-password');
    await page.getByTestId('signin-submit').click();
    // The inline error box renders...
    await expect(page.getByTestId('signin-error')).toBeVisible();
    // ...and we did NOT navigate away — the login fields are still present.
    await expect(page.getByTestId('signin-email')).toBeVisible();
    await expect(page.getByTestId('cmd-shell-root')).toHaveCount(0);
  });
});
