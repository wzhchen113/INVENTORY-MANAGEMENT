// e2e/eod.spec.ts — Spec 078 Phase 2: staff EOD submit + offline queue.
//
// Highest-value, highest-difficulty flow. Signed in as staff
// (storageState), this proves the online submit (AC-EOD1) and the
// offline → queue → drain cycle (AC-EOD2/3).
//
// PRECONDITION: e2e/global-setup.ts has inserted order_schedule rows for
// every weekday × two vendors on Towson, so the EOD "today" screen always
// renders two vendor chips + a non-empty item list. Without that fixture
// this entire spec would be vacuous (empty screen) — see design §OQ-4.
//
// OQ-3c GUARD #2: each test clears the staff offline-queue localStorage key
// (imr-staff:eod-queue:v1) via addInitScript BEFORE the app boots, so every
// EOD test starts from an empty queue regardless of what any prior step
// wrote. Belt-and-suspenders with guard #1 (auth-setup never submits EOD).
//
// Navigation: manager has two stores → the staff session lands on
// StorePicker. Each test taps the Towson store-row-{id} to reach EODCount.
//
// Selector contract (frozen §7): store-picker-root, store-row-{id}
// (StorePicker); eod-store-name, vendor-chip-{id}, eod-item-input-{id},
// eod-item-row-{id}, eod-submit, eod-queue-indicator (EODCount). All EOD
// selectors already exist today (audited in design §7) — no net-new EOD
// testID is required for AC-EOD1.

import { test, expect, type Page } from '@playwright/test';
import { SEED, STAFF_QUEUE_KEY, STORAGE_STATE } from './fixtures/constants';

test.use({ storageState: STORAGE_STATE.staff });

test.describe('staff EOD', () => {
  test.beforeEach(async ({ context }) => {
    // Clear the offline-queue key before the app boots (OQ-3c guard #2).
    await context.addInitScript((key) => {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* localStorage may be unavailable pre-navigation; ignore */
      }
    }, STAFF_QUEUE_KEY);
  });

  // Walk StorePicker → EODCount by tapping the Towson row, then assert the
  // fixture actually produced a populated screen (vendor chips + at least
  // one item input). Returns the first item-input testid so callers can
  // type a count into a real, rendered row (not a guessed id).
  async function gotoTowsonEod(page: Page): Promise<string> {
    await page.goto('/');
    await expect(page.getByTestId('store-picker-root')).toBeVisible();
    await page.getByTestId(`store-row-${SEED.towsonStoreId}`).click();

    // EODCount header confirms we left the picker.
    await expect(page.getByTestId('eod-store-name')).toBeVisible();

    // Fixture sanity: two vendors scheduled → the chip switcher renders.
    // Asserting the chips exist guards against a silently-vacuous test if
    // the OQ-4 fixture ever stops running.
    await expect(
      page.getByTestId(`vendor-chip-${SEED.vendorUsFoodId}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`vendor-chip-${SEED.vendorRestaurantDepotId}`),
    ).toBeVisible();

    // Select US FOOD (31 Towson items) so the list is definitely non-empty.
    await page.getByTestId(`vendor-chip-${SEED.vendorUsFoodId}`).click();

    // Wait for at least one item input to render, then return its testid.
    const firstInput = page.getByTestId(/^eod-item-input-/).first();
    await expect(firstInput).toBeVisible();
    const testid = await firstInput.getAttribute('data-testid');
    if (!testid) throw new Error('[e2e eod] no eod-item-input-* rendered');
    return testid;
  }

  test('AC-EOD1: online submit clears the queue indicator', async ({ page }) => {
    const inputTestId = await gotoTowsonEod(page);

    // Enter a count into the first rendered item.
    await page.getByTestId(inputTestId).fill('7');

    // Submit button is disabled when items.length === 0; we have items.
    await expect(page.getByTestId('eod-submit')).toBeEnabled();
    await page.getByTestId('eod-submit').click();

    // Online success: the queue indicator never holds a pending item (it
    // renders null when pending===0 && !draining). Assert it settles absent
    // — i.e. nothing got stuck in the queue.
    await expect(page.getByTestId('eod-queue-indicator')).toHaveCount(0);
  });

  test('AC-EOD2/3: offline submit queues, reconnect drains', async ({
    page,
    context,
  }) => {
    const inputTestId = await gotoTowsonEod(page);
    await page.getByTestId(inputTestId).fill('5');

    // ── Go offline ──────────────────────────────────────────────────────
    // context.setOffline(true) flips navigator.onLine AND dispatches the
    // DOM `offline` event, which useConnectionStatus (web branch) listens
    // for → useEodSubmit re-memoizes submit() with isOnline=false.
    await context.setOffline(true);

    // OQ-5 subtlety #1: submit() reads isOnline from a captured closure, so
    // wait for the offline state to propagate (React re-render) BEFORE
    // clicking submit, else the click could race the emulation flip and take
    // the online branch. Polling navigator.onLine is the documented timing
    // guard. (Route-interception of **/rest/v1/rpc/staff_submit_eod is the
    // documented fallback if this ever proves flaky — not needed in v1.)
    await expect
      .poll(() => page.evaluate(() => navigator.onLine), { timeout: 10_000 })
      .toBe(false);

    await page.getByTestId('eod-submit').click();

    // The submission is queued: the indicator becomes visible (it renders
    // only when pending > 0 || draining). This is presence-of-testid, not
    // text-fragile (AC-EOD3).
    await expect(page.getByTestId('eod-queue-indicator')).toBeVisible();

    // ── Reconnect → drain ───────────────────────────────────────────────
    await context.setOffline(false);
    await expect
      .poll(() => page.evaluate(() => navigator.onLine), { timeout: 10_000 })
      .toBe(true);

    // The `online` DOM event → useConnectionStatus setConnected(true) →
    // useEodSubmit Effect-1 detects false→true and calls drain() → the
    // queued item POSTs via staff_submit_eod and dequeues → QueueIndicator
    // returns null when pending===0 && !draining. Assert the indicator
    // actually disappears — proving the drain happened, not merely that no
    // error fired (AC-EOD2's explicit requirement).
    await expect(page.getByTestId('eod-queue-indicator')).toHaveCount(0, {
      timeout: 30_000,
    });
  });
});
