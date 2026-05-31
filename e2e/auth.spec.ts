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
    await expect(page.getByTestId('cmd-shell-root')).toBeVisible();
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
