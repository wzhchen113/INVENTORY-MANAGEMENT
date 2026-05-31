// e2e/dashboard-window.spec.ts — Spec 080: dashboard attention-queue
// weekly-window guard (spec 074 Monday-reset), browser E2E (FULL).
//
// WHAT THIS PROVES (the integration-render delta over the jest layer).
// Spec 074 windows the per-store Attention Queue `unconfirmed_po`
// ("VENDOR order missed (DATE)") rows to a Monday-reset window: only THIS
// work-week's missed orders show; anything before this week's Monday 00:00
// (store timezone) drops off. The logic is already pinned by ~8 deterministic
// jest tests with an injected `now` (cmdSelectors.unconfirmedPoWindow.test.ts
// + weekWindow.test.ts). This spec adds the layer those cannot reach: the
// REAL DashboardSection rendering the spec-074-windowed result in a browser
// against real DB-loaded slices — an integration-wiring proof.
//
// WHY THIS IS NOW DETERMINISTIC (spec 081 un-blocked it). The prior design
// pass RE-DEFERRED this spec because `unconfirmed_po` rendered the FOCAL
// store's schedule on EVERY card (no per-store loader; focal store itself was
// non-deterministic). Spec 081 (shipped, CI green) made the rule genuinely
// per-store: DashboardSection fetches `db.fetchOrderScheduleForStores` /
// `fetchOrderSubmissionsForStores` cross-store and passes
// `scheduleByStore[s.id]` into computeAttentionQueue(s.id, …). So a dedicated
// store's card now renders ITS OWN schedule independent of which store is
// focal — the dedicated-store fixture below drives its OWN card.
//
// FIXTURE (test.beforeAll, service-role — the date math is `now`-relative so
// it lives WITH the assertions, not in global-setup.ts):
//   • A dedicated, e2e-only store (SEED.e2eWindowStoreId, brand 2a…01,
//     status='active' so fetchStores returns it). NOT Towson/Frederick/
//     Charles/Reisters (all four are pgTAP missed_order_audit_rpc anchors).
//   • order_schedule rows on the target weekday(s) for a SEED vendor
//     (US FOOD). NO purchase_orders (the missing PO is the "miss"); NO
//     inventory_items (the rule never reads inventory — spec-text correction
//     in the design); NO user_stores grant (admin sees the store via
//     auth_is_admin(); spec 081 made focal-ness irrelevant to card content).
//   Teardown is store-scoped + FK-ordered in global-teardown.ts.
//
// DATE MATH (Re-confirmation 3): reuse the PRODUCTION weekWindow.ts helpers
// (dependency-free, Intl-only, importable from e2e/) so the test and the app
// agree on the window boundary by construction. In-window date = the LAST
// filtered week ISO (closest to today → max distance from the Monday edge);
// out-of-window date = mondayStart − 1 day (last week's Sunday, always
// filtered). On Monday the in-window set is empty → assert the windowed-empty
// state (positive Monday-reset proof, NOT test.skip — a skip would prove
// nothing 1/7 of CI days).
//
// TIMEZONE (Risk 1, verified live at build time): the fixture date math and
// the app's window boundary MUST use the same tz string. The seeded admin
// session resolves useStore.timezone to the 'America/New_York' DEFAULT
// (useStore.ts:518) — setTimezone is only ever called from the TimezoneBar
// user picker (src/components/TimezoneBar.tsx), never auto-loaded from the DB
// on login, so a fresh session never overrides the default. DashboardSection
// reads that same value (DashboardSection.tsx:133). BRAND_TZ is pinned to it.
//
// Selector contract (FROZEN by the architect — the frontend-developer's
// disjoint lane): dashboard-store-card-{storeId} (the per-store card wrapper)
// + attention-row-{item.id} (each queue row; the unconfirmed_po item.id is
// `${storeId}:po:${vendorKey}:${pastISO}` per cmdSelectors.ts:899, and
// vendorKey === SEED.vendorUsFoodId here because the fixture sets vendor_id).
// Plus dashboard-root (078 §7) + nav-Dashboard (079 §6 SIDEBAR_NAV).

import { test, expect } from '@playwright/test';
import { SEED, SIDEBAR_NAV, STORAGE_STATE, WEEKDAYS } from './fixtures/constants';
import { serviceRoleClient } from './fixtures/db';
import {
  getLocalDateISO,
  getWeekWindow,
  isoDateRange,
} from '../src/utils/weekWindow';

test.use({ storageState: STORAGE_STATE.admin });

// ─── Timezone source (Risk 1) ──────────────────────────────────────────────
// The brand has ONE timezone (spec 074 follow-up #2). The running admin
// session resolves useStore.timezone to the 'America/New_York' default and
// never overrides it (verified above). Pin the SAME constant so the fixture
// and the browser-side computeAttentionQueue derive the window boundary
// identically. Do NOT read this from process.env / the CI runner locale — it
// must match what the app computes (the store value), not the runner's tz.
const BRAND_TZ = 'America/New_York';

// ─── `now`-relative target dates (computed once, store-tz) ──────────────────
// inWindowISO  = the LAST in-window day (this week, strictly before today).
//                [] on Monday → null (the window is empty Monday morning).
// outWindowISO = the day BEFORE this week's Monday (last week's Sunday),
//                guaranteed < mondayStart so the spec-074 filter MUST drop it.
const now = new Date();
const { mondayStart, nextMondayStart } = getWeekWindow(BRAND_TZ, now);
const todayISO = getLocalDateISO(BRAND_TZ, now);
const weekISOs = isoDateRange(mondayStart, nextMondayStart);
const inWindowISOs = weekISOs.filter((iso) => iso < todayISO); // [] on Monday
const isMonday = inWindowISOs.length === 0;
const inWindowISO = isMonday ? null : inWindowISOs[inWindowISOs.length - 1];

const beforeMonday = new Date(mondayStart.getTime());
beforeMonday.setUTCDate(beforeMonday.getUTCDate() - 1);
// Guard the [0] access: the arithmetic guarantees exactly one ISO
// (beforeMonday is one UTC day before mondayStart, so start < end), but
// isoDateRange returns string[] — a future date-math refactor that produced
// start >= end would silently set outWindowISO = undefined, and the
// `${undefined}` testID interpolations below would NEVER match → the
// absence assertion (toHaveCount(0)) would pass VACUOUSLY. Fail loud instead.
const outWindowISOs = isoDateRange(beforeMonday, mondayStart);
if (outWindowISOs.length !== 1) {
  throw new Error(
    `[e2e dashboard-window] expected exactly 1 out-of-window ISO, got ${outWindowISOs.length}`,
  );
}
const outWindowISO = outWindowISOs[0];

// TitleCase weekday of an ISO date, parsed as LOCAL Y/M/D — byte-for-byte the
// shape cmdSelectors.ts:884-887 uses to derive `pastDayName` from the ISO
// (`new Date(+y, +m-1, +d).getDay()`). NOT `new Date(iso)` (UTC midnight,
// which can shift the weekday one day on a negative UTC offset). WEEKDAYS is
// the TitleCase array matching order_schedule.day_of_week.
function weekdayOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}

// ─── Fixture: the dedicated store + its order_schedule rows ─────────────────
test.beforeAll(async () => {
  // serviceRoleClient() runs the assertLocalStack prod-URL guard on
  // construction → the fixture can never target a non-local stack.
  const admin = serviceRoleClient();

  // Defensive distinctness assert (design Re-confirmation 4 "Caveat on FULL
  // across weekdays"): the in-window weekday and last-week-Sunday weekday are
  // distinct by construction (the in-window day is Mon–Sat of THIS week and
  // can never be a Sunday — Sunday is the last day of the window and is only
  // `< today` when today is past Sunday, i.e. never within this week's
  // window). So the two order_schedule rows never collide on the
  // (store, day_of_week, vendor) unique key. Assert it anyway — if a future
  // refactor of the date math breaks the invariant, fail loudly here rather
  // than silently upsert-collapse two rows into one.
  if (inWindowISO !== null) {
    const inWd = weekdayOf(inWindowISO);
    const outWd = weekdayOf(outWindowISO);
    if (inWd === outWd) {
      throw new Error(
        `[e2e dashboard-window] fixture invariant broken: in-window weekday ` +
          `(${inWd}, ${inWindowISO}) === out-of-window weekday (${outWd}, ` +
          `${outWindowISO}). The two order_schedule rows would collide on the ` +
          `(store, day_of_week, vendor) unique key.`,
      );
    }
  }

  // The dedicated store. brand_id = the seed brand (mandatory FK — what makes
  // admin's RLS see the store via auth_is_admin()); status='active' so
  // fetchStores returns it (db.ts filters status). Upsert on the fixed id →
  // idempotent across re-runs and a `db reset`.
  const { error: storeErr } = await admin.from('stores').upsert(
    {
      id: SEED.e2eWindowStoreId,
      brand_id: '2a000000-0000-0000-0000-000000000001',
      name: 'E2E Window Store',
      address: '080 Window Test Way',
      status: 'active',
      eod_deadline_time: '22:00',
    },
    { onConflict: 'id' },
  );
  if (storeErr) {
    throw new Error(
      `[e2e dashboard-window] dedicated store upsert failed: ${storeErr.message}. ` +
        `Is the LOCAL Supabase stack running (npm run dev:db) with the committed seed ` +
        `(seed brand 2a000000-…0001 must exist)?`,
    );
  }

  // One order_schedule row per target date keyed to that date's weekday, for
  // the SEED US FOOD vendor (vendor_id set → the rule's vendorKey ===
  // SEED.vendorUsFoodId, so the test can compute the exact attention-row id).
  // vendor_name AND delivery_day are NOT NULL on the prod-pulled schema; mirror
  // the global-setup fixture's shape (vendor_name = denormalized snapshot,
  // delivery_day = the order weekday). NO purchase_orders row for these dates —
  // its ABSENCE is what makes the scheduled vendor a "miss."
  //
  // On Monday the in-window set is empty (inWindowISO === null), so seed ONLY
  // the out-of-window row — the windowed-empty assertion still needs the
  // out-of-window schedule present so `toHaveCount(0)` proves the WINDOW
  // filtered it (not that no schedule existed at all). On Tue–Sun seed both.
  const targetISOs = isMonday
    ? [outWindowISO]
    : [outWindowISO, inWindowISO as string];

  const rows = targetISOs.map((iso) => ({
    store_id: SEED.e2eWindowStoreId,
    day_of_week: weekdayOf(iso),
    vendor_id: SEED.vendorUsFoodId,
    vendor_name: 'US FOOD',
    delivery_day: weekdayOf(iso),
  }));

  // Idempotent ON CONFLICT DO NOTHING on the (store, day_of_week, vendor)
  // unique key — same shape as global-setup.ts. (A stray prior PO for these
  // dates would defeat the "miss"; the teardown defensively deletes any
  // purchase_orders for this store id, and a brand-new store has none.)
  const { error: schedErr } = await admin.from('order_schedule').upsert(rows, {
    onConflict: 'store_id,day_of_week,vendor_id',
    ignoreDuplicates: true,
  });
  if (schedErr) {
    throw new Error(
      `[e2e dashboard-window] order_schedule fixture insert failed: ${schedErr.message}. ` +
        `Expected the dedicated store ${SEED.e2eWindowStoreId} and seed vendor ${SEED.vendorUsFoodId}.`,
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `[e2e dashboard-window] fixture ready on dedicated store ${SEED.e2eWindowStoreId} ` +
      `(tz=${BRAND_TZ}, today=${todayISO}, isMonday=${isMonday}): ` +
      `out-of-window=${outWindowISO}` +
      (inWindowISO ? `, in-window=${inWindowISO}` : ' (Monday → no in-window date)') +
      `. ${rows.length} order_schedule row(s), no purchase_orders.`,
  );
});

test('AC-080-IN/OUT: spec-074 window renders per-store on the dedicated card', async ({
  page,
}) => {
  // Navigate to the Dashboard by the stable nav testID (flake checklist #1 —
  // never getByText). Assert the shell + section root before interacting
  // (flake checklist #3).
  await page.goto('/');
  await expect(page.getByTestId('cmd-shell-root')).toBeVisible();
  await page.getByTestId(SIDEBAR_NAV.dashboard).click();
  await expect(page.getByTestId('dashboard-root')).toBeVisible();

  // Scope EVERY row assertion to the dedicated store's card so another store's
  // unconfirmed_po rows can't satisfy or break the assertion.
  const card = page.getByTestId(`dashboard-store-card-${SEED.e2eWindowStoreId}`);
  await expect(card).toBeVisible(); // the dedicated card rendered (admin sees it)

  // ── AC-080-OUT (FULL — holds on ALL seven weekdays): the before-this-Monday
  // miss must be FILTERED by the spec-074 window. The dedicated store's card
  // would carry an attention-row-{dedId}:po:{vendor}:{outWindowISO} testID iff
  // the window FAILED to drop it; toHaveCount(0) proves the filter works in the
  // real render. This is the day-invariant floor of the guard.
  const outId = `${SEED.e2eWindowStoreId}:po:${SEED.vendorUsFoodId}:${outWindowISO}`;
  await expect(card.getByTestId(`attention-row-${outId}`)).toHaveCount(0);

  if (!isMonday) {
    // ── AC-080-IN (Tue–Sun add-on): the in-window miss IS rendered. The
    // fixture seeded an order_schedule row on inWindowISO's weekday with no
    // matching purchase_orders row, so computeAttentionQueue emits exactly this
    // row on the dedicated store's card.
    const inId = `${SEED.e2eWindowStoreId}:po:${SEED.vendorUsFoodId}:${inWindowISO}`;
    await expect(card.getByTestId(`attention-row-${inId}`)).toBeVisible();
  } else {
    // ── AC-080-IN-MONDAY (positive Monday-reset proof): the window
    // [thisMonday, today) is empty on Monday morning, so the dedicated store's
    // card shows NO unconfirmed_po rows AT ALL — even though it has a scheduled
    // (and unsubmitted) vendor on the out-of-window date. Asserting zero
    // `attention-row-{dedId}:po:*` rows turns Monday into a genuine reset proof
    // (rule-scoped so it still holds if a future unrelated rule fires on this
    // store). This is a strict superset of the AC-080-OUT assertion above.
    await expect(
      card.locator(
        `[data-testid^="attention-row-${SEED.e2eWindowStoreId}:po:"]`,
      ),
    ).toHaveCount(0);
  }
});
