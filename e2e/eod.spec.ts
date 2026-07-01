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
// (imr-staff:eod-queue:v2 — bumped from v1 in spec 086 when the queued
// `entries` shape changed) via addInitScript BEFORE the app boots, so every
// EOD test starts from an empty queue regardless of what any prior step
// wrote. Belt-and-suspenders with guard #1 (auth-setup never submits EOD).
//
// Navigation: manager has two stores → the staff session lands on
// StorePicker. Each test taps the Towson store-row-{id} to reach EODCount.
//
// SPEC 079 DEEPENINGS:
//   • AC-EOD-PERSIST (in the online case): after the queue drains, reload the
//     SAME (store, vendor, today) and assert the eod-prefill-banner renders
//     (UI-only persistence proof), THEN one belt-and-suspenders service-role
//     read of eod_submissions for (Towson, today, US FOOD) confirming the row
//     + the filled item's value (7). The ONE service-role assertion in the
//     suite — everything else stays UI-only.
//   • AC-072 (scroll guard, separate describe at 375×812): on the populated
//     US FOOD list (31 Towson items) assert Submit stays in-viewport, the
//     eod-item-list is the internal scroll container, and the body does NOT
//     body-scroll. Web-only react-native-web layout regression class; jest
//     cannot reproduce a viewport-sized DOM.
//
// Selector contract: store-picker-root, store-row-{id} (StorePicker);
// eod-store-name, vendor-chip-{id}, eod-item-cases-{id}, eod-item-units-{id}
// (spec 086 — the single eod-item-input-{id} split into Cases + Units; this
// suite fills Units only, Cases blank, so total === the entered number, same
// as the pre-086 single-input semantics), eod-item-row-{id}, eod-submit,
// eod-queue-indicator, eod-prefill-banner (EODCount — all 078 §7, banner
// pre-079); eod-item-list (079 §6 #1 — FROZEN, the scroll container).

import { test, expect, type Page } from '@playwright/test';
import { SEED, STAFF_QUEUE_KEY, STORAGE_STATE } from './fixtures/constants';
import { serviceRoleClient, todayIso } from './fixtures/db';

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

  // Walk to EODCount on Towson, then assert the fixture actually produced a
  // populated screen (vendor chips + at least one item input). Returns the
  // first rendered item's UUID so callers can type into a real, rendered row
  // (not a guessed id) and read it back from the DB. Spec 086: the row now has
  // two inputs (Cases + Units); this suite fills Units only.
  //
  // Lands on one of TWO states (handle both — this is also what makes the
  // AC-EOD-PERSIST reload work): a FRESH context has no persisted active
  // store (the setup project saved storageState while on StorePicker, never
  // selecting a store), so the StorePicker renders and we tap the Towson row.
  // But once a store is selected, setActiveStore persists it to localStorage
  // (imr-staff:active-store:v1), so a RELOAD in the same context restores it
  // and lands DIRECTLY on EODCount, skipping the picker. Branch on whichever
  // appears first so a re-navigation (the persistence reload) is robust.
  async function gotoTowsonEod(page: Page): Promise<{ itemId: string; unitsTestId: string }> {
    await page.goto('/');

    // Whichever of {StorePicker, EODCount-header} renders first wins. On a
    // fresh context it's the picker; on a reload-with-persisted-store it's
    // the EOD header. Auto-retrying expect on the OR-locator avoids a fixed
    // wait (flake checklist #2).
    const picker = page.getByTestId('store-picker-root');
    const eodHeader = page.getByTestId('eod-store-name');
    await expect(picker.or(eodHeader).first()).toBeVisible();

    if (await picker.isVisible()) {
      await page.getByTestId(`store-row-${SEED.towsonStoreId}`).click();
    }

    // EODCount header confirms we're on the count screen (either we tapped
    // the row, or the reload restored the active store directly).
    await expect(eodHeader).toBeVisible();

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

    // Let the item list SETTLE before snapshotting the first row's id.
    // Selecting a vendor swaps the list, and when a submission ALREADY exists
    // for (store, today, vendor) the screen runs a prefill fetch
    // (fetchExistingSubmission, EODCount.tsx:255-270 — a useEffect keyed on
    // store/vendor/date) that re-renders the list a SECOND time with the
    // submitted values + badges. Snapshotting .first()'s id mid-swap captures an
    // id from the PRE-prefill render that then detaches on the re-render — the
    // cause of an intermittent 60s `fill` timeout when this helper is reused
    // after an earlier test has already submitted for today (e.g. the offline
    // test running after AC-EOD1, whose submission persists — global-teardown
    // does not delete eod_submissions). networkidle waits for the prefill fetch
    // to land; the staff surface uses no realtime/polling (spec 062), so it
    // settles cleanly rather than hanging on a long-lived connection.
    await page.waitForLoadState('networkidle');

    // Now derive the item UUID from the first Units input's testid
    // (eod-item-units-<uuid> → <uuid>). The Units box is what this suite fills;
    // Cases stays blank so the converted total equals the entered number.
    const firstUnits = page.getByTestId(/^eod-item-units-/).first();
    await expect(firstUnits).toBeVisible();
    const unitsTestId = await firstUnits.getAttribute('data-testid');
    if (!unitsTestId) throw new Error('[e2e eod] no eod-item-units-* rendered');
    const itemId = unitsTestId.replace('eod-item-units-', '');
    return { itemId, unitsTestId };
  }

  test('AC-EOD1 + AC-EOD-PERSIST: online submit persists (banner on reload + service read)', async ({
    page,
  }) => {
    const { itemId, unitsTestId } = await gotoTowsonEod(page);

    // Count-everything gate (EODCount.tsx): every row needs a value (even 0)
    // before submit, or the submit is BLOCKED and jumps to the first uncounted
    // row (so eod-prefill-banner never appears). Fill every Units box with 0 —
    // the list is un-windowed so all rows are mounted — then the target row is
    // overridden with the real value below.
    const allUnits = page.getByTestId(/^eod-item-units-/);
    for (let i = 0, n = await allUnits.count(); i < n; i++) {
      await allUnits.nth(i).fill('0');
    }

    // Enter a count into the first rendered item's Units box (Cases blank →
    // total === units). The online case fills '7' (the offline case fills '5')
    // so a stale-row read can never match the wrong case (design ordering
    // call-out).
    await page.getByTestId(unitsTestId).fill('7');

    // Submit button is disabled when items.length === 0; we have items.
    await expect(page.getByTestId('eod-submit')).toBeEnabled();
    await page.getByTestId('eod-submit').click();

    // ── Synchronize on the ONLINE submit completing. For an ONLINE submit the
    // item goes straight to the RPC (it is NOT queued), so the queue indicator
    // is vacuously absent from the start — asserting toHaveCount(0) on it does
    // NOT wait for the RPC and would let a reload race the in-flight submit.
    // The deterministic success signal is the eod-prefill-banner appearing
    // IN-PLACE: onSubmit re-runs fetchExistingSubmission + setExisting on
    // success (EODCount.tsx:333-340), which renders the banner without a
    // reload. Waiting on it here means the RPC has landed AND the row is
    // server-readable before we navigate.
    await expect(page.getByTestId('eod-prefill-banner')).toBeVisible();
    // And it submitted online, not queued (the indicator never populated).
    await expect(page.getByTestId('eod-queue-indicator')).toHaveCount(0);

    // ── AC-EOD-PERSIST-1 (UI-only PRIMARY): reload the SAME (store, vendor,
    // today) and assert the eod-prefill-banner ("Last submitted at HH:MM")
    // STILL renders — proving the submission persisted SERVER-SIDE (durable
    // across a fresh boot), not just in the prior page's in-memory state. On
    // reload the persisted active-store key lands us directly on EODCount;
    // gotoTowsonEod handles both that and the picker path, re-selecting US
    // FOOD so we hit the same (store, today, vendor) tuple the submit wrote.
    await gotoTowsonEod(page);
    await expect(page.getByTestId('eod-prefill-banner')).toBeVisible();
    // Spec 086: the Units box pre-fills from the stored total (legacy/units-
    // only fallback) — 7, the value this run submitted with Cases blank.
    await expect(page.getByTestId(unitsTestId)).toHaveValue('7');

    // ── AC-EOD-PERSIST-2/3 (the ONE service-role read — belt-and-suspenders):
    // read eod_submissions for (Towson, today, US FOOD) and assert the row +
    // the entry for the item we filled + its value (7). Keyed off THIS run's
    // submitted value and the (store, date, vendor) tuple — NOT a count of
    // submissions — so it converges on a non-reset local DB (staff_submit_eod
    // upserts on that tuple; a re-run overwrites rather than duplicates).
    // todayIso() mirrors EODCount.todayIso() byte-for-byte so the date key
    // matches what the app wrote across a midnight boundary.
    const db = serviceRoleClient();
    const { data, error } = await db
      .from('eod_submissions')
      .select('id, eod_entries(item_id, actual_remaining)')
      .eq('store_id', SEED.towsonStoreId)
      .eq('date', todayIso())
      .eq('vendor_id', SEED.vendorUsFoodId)
      .maybeSingle();
    expect(error).toBeNull();
    expect(
      data,
      'expected an eod_submissions row for (Towson, today, US FOOD)',
    ).not.toBeNull();

    // The entry for the item we filled (itemId derived in gotoTowsonEod from
    // the units testid). Presence + value, not a row count.
    type Entry = { item_id: string; actual_remaining: number | string | null };
    const entries = (data!.eod_entries ?? []) as Entry[];
    const entry = entries.find((e) => e.item_id === itemId);
    expect(entry, `expected an eod_entries row for item ${itemId}`).toBeDefined();
    expect(Number(entry!.actual_remaining)).toBe(7); // the value THIS run submitted
  });

  test('AC-EOD2/3: offline submit queues, reconnect drains', async ({
    page,
    context,
  }) => {
    const { unitsTestId } = await gotoTowsonEod(page);
    // Count-everything gate — see AC-EOD1. Fill every Units box 0 (un-windowed
    // list → all rows mounted), then override the target row with the real value.
    const allUnits = page.getByTestId(/^eod-item-units-/);
    for (let i = 0, n = await allUnits.count(); i < n; i++) {
      await allUnits.nth(i).fill('0');
    }
    await page.getByTestId(unitsTestId).fill('5');

    // ── Go offline + force the queue path deterministically ─────────────
    // THE FLAKE THIS GUARDS: submit() reads isOnline from a captured closure
    // (useEodSubmit.ts — submit is memoized on [isOnline, userId], onPress wires
    // straight to it via onSubmit). Going offline only re-points the button at
    // the offline/enqueue branch AFTER React processes the DOM `offline` event →
    // re-renders → re-memoizes submit(). That re-render is async relative to the
    // navigator.onLine flag, which setOffline flips synchronously — so polling
    // navigator.onLine can pass BEFORE the re-render lands, letting the click
    // race onto the stale online-branch submit().
    //
    // Route-interception removes the timing dependency entirely (the fix the
    // old comment pre-documented as the fallback). Abort the RPC so EVERY path
    // ends in the queue, regardless of which submit() closure the click hits:
    //   • re-render landed → offline branch enqueues directly (RPC never called)
    //   • re-render raced   → online branch calls the RPC → abort → the hook's
    //     isNetworkError() branch enqueues (useEodSubmit.ts:291-293)
    // setOffline is still flipped: the connectivity transition (false→true on
    // reconnect) is what drives the drain below, so it has to actually occur.
    const RPC_GLOB = '**/rest/v1/rpc/staff_submit_eod';
    await context.route(RPC_GLOB, (route) => route.abort());
    await context.setOffline(true);

    // Secondary sync point only — NOT the determinism guard (the route is).
    // Confirms the browser offline flag flipped before the click; documents
    // the offline-phase boundary.
    await expect
      .poll(() => page.evaluate(() => navigator.onLine), { timeout: 10_000 })
      .toBe(false);

    await page.getByTestId('eod-submit').click();

    // The submission is queued: the indicator becomes visible (it renders
    // only when pending > 0 || draining). This is presence-of-testid, not
    // text-fragile (AC-EOD3).
    await expect(page.getByTestId('eod-queue-indicator')).toBeVisible();

    // ── Reconnect → drain ───────────────────────────────────────────────
    // Drop the RPC block FIRST so the drain's POST can actually land, THEN flip
    // online. Order matters: the drain fires on the online transition; if the
    // route were still aborting, the drained item would network-error and
    // re-queue (useEodSubmit.ts:182-189), hanging the toHaveCount(0) below.
    await context.unroute(RPC_GLOB);
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

  // ── AC-072: spec-072 scroll guard (web-only layout regression) ──────────
  // Scoped to a MOBILE viewport (375×812 — exactly what main Claude
  // hand-verified). REQUIRED: the suite default is Desktop Chrome (1280×720),
  // where 31 items do NOT overshoot and the body never scrolls, so the test
  // would pass VACUOUSLY and guard nothing. test.use here applies the phone
  // viewport ONLY to this nested describe (the online/offline cases above
  // stay desktop). Risk #1 in the design: forget the viewport override and
  // the guard is silently meaningless — the scrollHeight > clientHeight
  // tripwire below fails loudly if the override is ever dropped.
  test.describe('spec-072 scroll guard (mobile viewport)', () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test('AC-072: Submit stays in-viewport; list scrolls internally, body does not', async ({
      page,
    }) => {
      // Populated US FOOD list (31 Towson items) → guaranteed overshoot at
      // 812px height. gotoTowsonEod already asserts an eod-item-units-* is
      // visible, so items definitely rendered before we probe.
      await gotoTowsonEod(page);

      // Tripwire FIRST (design §1 pre-assertion guard): the list must actually
      // overshoot, else every assertion below is vacuous. If the OQ-4 fixture
      // stops running OR the viewport override is dropped, this fails loudly.
      const list = page.getByTestId('eod-item-list');
      await expect(list).toBeVisible();
      const scroll = await list.evaluate((el) => ({
        overflowY: getComputedStyle(el).overflowY,
        scrollH: el.scrollHeight,
        clientH: el.clientHeight,
      }));

      // AC-072-2a: the items list IS the internal scroll container — it can
      // scroll (overflow-y auto/scroll) AND it has overflow (scrollHeight >
      // clientHeight, the overshoot proof).
      expect(['auto', 'scroll']).toContain(scroll.overflowY);
      expect(scroll.scrollH).toBeGreaterThan(scroll.clientH);

      // AC-072-1: the Submit footer stays IN-VIEWPORT (the literal property
      // spec 072 fixed — footer not pushed below the fold). Its bottom edge
      // is at or above the fold (1px sub-pixel tolerance).
      const box = await page.getByTestId('eod-submit').boundingBox();
      expect(box).not.toBeNull();
      const viewport = page.viewportSize()!; // { width: 375, height: 812 }
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);

      // AC-072-2b: the document body does NOT body-scroll — the complementary
      // negative that distinguishes "list scrolls internally" from "page
      // scrolls." Together 2a + 2b pin "list scrolls, page does not."
      const bodyScrolls = await page.evaluate(
        () => document.body.scrollHeight > window.innerHeight + 1, // 1px tolerance
      );
      expect(bodyScrolls).toBe(false);
    });
  });
});
