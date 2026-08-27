// e2e/fixtures/storeGate.ts — Spec 161.
//
// Every admin-side spec that reaches the Cmd shell has to clear the store gate
// first, and none of them can inherit a pick from `storageState`.
//
// Why not: admin and master are privileged roles, so `visibleStoresFor` hands
// them all four seeded stores and sign-in lands on the gate instead of the
// shell. The gate remembers the choice in sessionStorage (deliberately — see
// the SESSION_STORE_KEY note in src/store/useStore.ts), and Playwright's
// `storageState` serializes cookies + localStorage ONLY. So the pick made in
// `auth.setup.ts` is genuinely gone by the time a spec opens its own context.
// That is the app behaving correctly, not a test defect: a fresh browser
// context IS a new tab, and a new tab is supposed to ask.
//
// `gotoShell` therefore replaces the `page.goto('/') + expect(cmd-shell-root)`
// pair in the admin specs. It tolerates BOTH outcomes so it keeps working if
// the seed ever narrows to a single store (in which case login auto-lands and
// no gate appears).

import { expect, type Page } from '@playwright/test';

/** The store every admin-side spec works in. Towson is the seeded default that
 *  the order_schedule / dashboard fixtures attach to. */
export const E2E_STORE = 'Towson';

/**
 * Clear the spec-161 store gate if it is up, for a page that has ALREADY
 * navigated and authenticated. Ends on the Cmd shell either way.
 *
 * Tolerates both landing surfaces rather than asserting the gate
 * unconditionally: the gate renders only for a multi-store user, so a hard
 * assertion would fail the suite for CORRECT app behavior if the seed ever
 * narrows to one store.
 */
export async function clearStoreGate(page: Page, storeName: string = E2E_STORE) {
  const gate = page.getByTestId('store-gate-root');
  const shell = page.getByTestId('cmd-shell-root');

  await expect(gate.or(shell).first()).toBeVisible();

  if (await gate.isVisible()) {
    // The brand pane auto-selects the sole seeded brand, so the store rows are
    // already listed; filtering keeps the click unambiguous as the seed grows.
    await page.getByTestId('store-gate-store-filter').fill(storeName);
    await page.getByText(storeName, { exact: true }).click();
  }

  await expect(shell).toBeVisible();
}

/**
 * Open the app as an already-authenticated admin and land on the Cmd shell,
 * clearing the store gate on the way. Replaces the
 * `page.goto('/') + expect(cmd-shell-root)` pair in the admin specs.
 */
export async function gotoShell(page: Page, storeName: string = E2E_STORE) {
  await page.goto('/');
  await clearStoreGate(page, storeName);
}
