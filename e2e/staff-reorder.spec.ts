// e2e/staff-reorder.spec.ts — Spec 092, Track 4 (browser E2E, web-only).
//
// The deferred staff-Reorder e2e from spec 089. Signed in as the manager
// (storageState, manager@local.test, role 'user'), this proves the realistic
// happy path the jest layer cannot reach: sign in → reach a store → open the
// Reorder tab → the per-vendor reorder card renders → the by-the-case Suggested
// string ("N cases · M units", spec 088) renders → the three export buttons are
// present + enabled → and the empty/no-data state on a second dedicated store.
//
// DETERMINISTIC-DATA STRATEGY (design §1 — Strategy A1, two dedicated stores).
// The committed seed has ZERO order_schedule rows AND the only stores the
// manager can see in the raw seed are Towson + Frederick (BOTH pgTAP
// missed_order_audit_rpc anchors), so the happy-path assertions cannot be made
// non-vacuous on the raw seed without seeding an anchor store (the forbidden
// cross-track collision). The `test.beforeAll` below seeds TWO e2e-only stores
// GRANTED to the manager:
//   • SEED.e2eReorderStoreId — 1 vendor (US FOOD) × all 7 weekdays in
//     order_schedule + 1 below-par, case_qty>1 inventory_items row (FK → a
//     dedicated catalog_ingredients row, case_qty=12, unit 'EA'). par 24,
//     stock 0 → suggested_qty 24 → suggested_cases ceil(24/12)=2,
//     suggested_units 24 → the rendered "Order: 2 cases · 24 EA". All-7-weekdays
//     so the PRIMARY "order today" filter is non-empty on ANY weekday CI runs.
//   • SEED.e2eReorderEmptyStoreId — granted, NO inventory → payload.vendors ===
//     [] → staff-reorder-empty, on any weekday (now-independent, no calendar).
// The manager is role 'user' → sees a store ONLY via a user_stores grant; both
// stores get one (without it report_reorder_list raises RLS 42501 → the error
// pane, NOT the list — fetchReorder.ts). Both store ids are NON-anchor, so the
// teardown (global-teardown.ts, store-scoped + FK-ordered) cannot collide with
// the missed_order_audit_rpc pgTAP arms. See specs/092/spec.md §1-§5.
//
// NO-VACUOUS-PASS DISCIPLINE (specs 078/080). AC-LIST tripwires the seeded
// vendor card FIRST — a silently-empty screen fails loudly rather than passing.
// The beforeAll also asserts the seeded case_qty is > 1 (a guard so a future
// edit to 12 → 1 fails loudly rather than dropping the cases·units form to a
// units-only string the AC-CASES assertion would no longer match).
//
// NAVIGATION. By testID, never by visible label (spec-079 flake-kill). The
// gotoReorderStore helper (ported from eod.spec.ts's gotoTowsonEod) handles
// BOTH the StorePicker path (tap store-row-{id}) AND the reload-with-persisted-
// active-store path (lands directly on the tabs). Auto-retrying expect on the
// terminal testIDs (-root, -vendor-<id>, -empty), no fixed waits.
//
// NO download/share assertion (no page.waitForEvent('download')) — presence +
// enabled-ness only, matching the admin reorder.spec.ts precedent (jsPDF /
// PapaParse / expo-sharing blob path is a known flake surface; Out of scope).
//
// Selector contract (FROZEN — all already exist in Reorder.tsx / StaffStack.tsx /
// StorePicker.tsx; confirmed by read): staff-tab-reorder (tab); staff-reorder-
// root, staff-reorder-store-name, staff-reorder-vendor-<vendorId>,
// staff-reorder-export-csv / -export-text / -export-pdf, staff-reorder-empty;
// store-picker-root, store-row-<id> (StorePicker). No app-code change — the KPI
// vendors value is read by scoping the localized label/value within the root
// (design §6: prefer the no-app-change route; the vendor-card tripwire is the
// real guard).

import { test, expect, type Page } from '@playwright/test';
import { SEED, STORAGE_STATE, WEEKDAYS } from './fixtures/constants';
import { serviceRoleClient } from './fixtures/db';

test.use({ storageState: STORAGE_STATE.staff });

// The seeded case fixture is fully deterministic: par 24, current_stock 0,
// case_qty 12 → suggested_qty 24, suggested_cases 2, suggested_units 24. These
// constants are the single source of truth the assertions key off so the
// fixture and the AC stay in lockstep.
const REORDER_CASE_QTY = 12;
const EXPECTED_CASES = 2; // ceil(24 / 12)
const EXPECTED_UNITS = 24; // suggested_units = cases × case_qty (server-authoritative)
const REORDER_UNIT = 'EA';
const REORDER_STORE_NAME = 'E2E Reorder Store';
const REORDER_EMPTY_STORE_NAME = 'E2E Reorder Empty Store';

test.describe('staff Reorder', () => {
  // ─── Fixture: two dedicated stores + grants + catalog + below-par case item
  //     + 7-weekday schedule (design §2). now-INDEPENDENT but spec-local, so it
  //     lives in a test.beforeAll co-located with the assertions (the spec-080
  //     precedent). Torn down store-scoped + FK-ordered in global-teardown.ts.
  test.beforeAll(async () => {
    // serviceRoleClient() runs the assertLocalStack prod-URL guard on
    // construction → the fixture can never target a non-local stack.
    const admin = serviceRoleClient();

    // Determinism guard (design §2, no-vacuous-pass): the case_qty MUST be > 1
    // or suggested_cases is null and the rendered string collapses to the
    // units-only form, silently breaking AC-092-CASES. Fail loud here if a
    // future edit drops it to 1.
    if (REORDER_CASE_QTY <= 1) {
      throw new Error(
        `[e2e staff-reorder] fixture invariant broken: REORDER_CASE_QTY ` +
          `(${REORDER_CASE_QTY}) must be > 1 so report_reorder_list sets ` +
          `suggested_cases non-null and the rendered Suggested string uses the ` +
          `"N cases · M units" form (spec 088). With case_qty <= 1 AC-092-CASES ` +
          `would assert a units-only string that no longer renders.`,
      );
    }

    // 1. catalog_ingredients — the case-display source (P3: inventory_items
    //    reads name/unit/case_qty from the joined catalog row, not the item).
    //    Upsert on id → idempotent across re-runs and a `db reset`. brand_id =
    //    the seed brand (mandatory FK + the brand-match trigger requires the
    //    granted store's brand to equal the manager's profile brand).
    const { error: catalogErr } = await admin.from('catalog_ingredients').upsert(
      {
        id: SEED.e2eReorderCatalogId,
        brand_id: '2a000000-0000-0000-0000-000000000001',
        name: 'E2E Reorder Case Item',
        unit: REORDER_UNIT,
        category: 'Dry goods',
        case_qty: REORDER_CASE_QTY,
      },
      { onConflict: 'id' },
    );
    if (catalogErr) {
      throw new Error(
        `[e2e staff-reorder] catalog_ingredients fixture upsert failed: ${catalogErr.message}. ` +
          `Is the LOCAL Supabase stack running (npm run dev:db) with the committed seed ` +
          `(seed brand 2a000000-…0001 must exist)?`,
      );
    }

    // 2. stores × 2 — reorder store + empty store. brand_id = the seed brand
    //    (brand-match trigger + RLS), status='active' so the staff store list
    //    returns them. Upsert on the fixed ids → idempotent.
    const { error: storesErr } = await admin.from('stores').upsert(
      [
        {
          id: SEED.e2eReorderStoreId,
          brand_id: '2a000000-0000-0000-0000-000000000001',
          name: REORDER_STORE_NAME,
          address: '092 Reorder Test Way',
          status: 'active',
          eod_deadline_time: '22:00',
        },
        {
          id: SEED.e2eReorderEmptyStoreId,
          brand_id: '2a000000-0000-0000-0000-000000000001',
          name: REORDER_EMPTY_STORE_NAME,
          address: '093 Reorder Empty Way',
          status: 'active',
          eod_deadline_time: '22:00',
        },
      ],
      { onConflict: 'id' },
    );
    if (storesErr) {
      throw new Error(
        `[e2e staff-reorder] dedicated stores upsert failed: ${storesErr.message}. ` +
          `Expected the seed brand 2a000000-…0001 to exist.`,
      );
    }

    // 3. user_stores × 2 — grant the manager BOTH dedicated stores. Without
    //    these grants the RPC raises RLS 42501 → the error pane, not the list.
    //    Upsert on the (user_id, store_id) PK with ignoreDuplicates → an
    //    idempotent ON CONFLICT DO NOTHING. The brand-match trigger passes
    //    (seed-brand stores + seed-brand profile).
    const { error: grantErr } = await admin.from('user_stores').upsert(
      [
        { user_id: SEED.managerUserId, store_id: SEED.e2eReorderStoreId },
        { user_id: SEED.managerUserId, store_id: SEED.e2eReorderEmptyStoreId },
      ],
      { onConflict: 'user_id,store_id', ignoreDuplicates: true },
    );
    if (grantErr) {
      throw new Error(
        `[e2e staff-reorder] user_stores grant upsert failed: ${grantErr.message}. ` +
          `Expected manager ${SEED.managerUserId} and the two dedicated stores. ` +
          `(A failed brand-match trigger means the store brand != the profile brand.)`,
      );
    }

    // 4. inventory_items — ONE below-par, case-based row on the reorder store
    //    only (the empty store gets none). par 24, stock 0, case_qty (from the
    //    catalog) 12 → par_replacement = max(0, 24-0-0) = 24 ≥ 0.001 (surfaces),
    //    suggested_cases = ceil(24/12) = 2, suggested_units = 24 → the rendered
    //    "Order: 2 cases · 24 EA". usage_per_portion 0 (irrelevant —
    //    par_replacement alone clears the filter; no POS data needed). catalog_id
    //    is NOT NULL post-P3. Upsert on id → idempotent.
    const { error: itemErr } = await admin.from('inventory_items').upsert(
      {
        id: SEED.e2eReorderItemId,
        store_id: SEED.e2eReorderStoreId,
        vendor_id: SEED.vendorUsFoodId,
        catalog_id: SEED.e2eReorderCatalogId,
        par_level: 24,
        current_stock: 0,
        cost_per_unit: 1.0,
        usage_per_portion: 0,
      },
      { onConflict: 'id' },
    );
    if (itemErr) {
      throw new Error(
        `[e2e staff-reorder] inventory_items fixture upsert failed: ${itemErr.message}. ` +
          `Expected the dedicated store ${SEED.e2eReorderStoreId}, vendor ${SEED.vendorUsFoodId}, ` +
          `and catalog ${SEED.e2eReorderCatalogId} (catalog_id is NOT NULL post-P3).`,
      );
    }

    // 5. order_schedule — 7 rows on the reorder store only (one per weekday),
    //    for US FOOD, so partitionReorderVendors places the vendor in PRIMARY on
    //    WHATEVER weekday CI runs (weekday-agnostic). vendor_name + delivery_day
    //    are NOT NULL on the prod-pulled schema. Upsert on the (store_id,
    //    day_of_week, vendor_id) unique key with ignoreDuplicates — the same
    //    idempotent shape as global-setup.ts.
    const scheduleRows = WEEKDAYS.map((day) => ({
      store_id: SEED.e2eReorderStoreId,
      day_of_week: day,
      vendor_id: SEED.vendorUsFoodId,
      vendor_name: 'US FOOD',
      delivery_day: day,
    }));
    const { error: schedErr } = await admin.from('order_schedule').upsert(scheduleRows, {
      onConflict: 'store_id,day_of_week,vendor_id',
      ignoreDuplicates: true,
    });
    if (schedErr) {
      throw new Error(
        `[e2e staff-reorder] order_schedule fixture insert failed: ${schedErr.message}. ` +
          `Expected the dedicated store ${SEED.e2eReorderStoreId} and seed vendor ${SEED.vendorUsFoodId}.`,
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      `[e2e staff-reorder] fixture ready: reorder store ${SEED.e2eReorderStoreId} ` +
        `(US FOOD × ${scheduleRows.length} weekdays + 1 below-par case item: par 24, ` +
        `case_qty ${REORDER_CASE_QTY} → ${EXPECTED_CASES} cases · ${EXPECTED_UNITS} ${REORDER_UNIT}) ` +
        `+ empty store ${SEED.e2eReorderEmptyStoreId} (no inventory). ` +
        `Both granted to manager ${SEED.managerUserId}.`,
    );
  });

  // Walk to the Reorder tab on a SPECIFIC dedicated store. Ported from
  // eod.spec.ts's gotoTowsonEod: lands on one of TWO states (handle both) — a
  // FRESH context has no persisted active store (the setup project saved
  // storageState on StorePicker, never selecting a store), so the StorePicker
  // renders and we tap the store row. Once a store is selected, setActiveStore
  // persists it to localStorage, so a RELOAD in the same context restores it
  // and lands DIRECTLY on the tabs, skipping the picker. Branch on whichever
  // appears first so a same-context re-navigation is robust.
  //
  // NOTE the suite targets TWO different dedicated stores per the design (so we
  // tap store-row-{id} rather than seeding STAFF_ACTIVE_STORE_KEY, which can
  // only point at one). On the reload-with-persisted-store branch the persisted
  // store may differ from the one we want; if the picker is NOT shown but the
  // store name does not match, fall back through sign-out-of-store via the
  // switch-store affordance is out of scope — each test uses its own page
  // (fresh context), so the picker path is the one exercised.
  async function gotoReorderStore(page: Page, storeId: string): Promise<void> {
    await page.goto('/');

    // Whichever of {StorePicker, staff tab bar} renders first wins. On a fresh
    // context it's the picker. Auto-retrying expect on the OR-locator avoids a
    // fixed wait (flake checklist #2).
    const picker = page.getByTestId('store-picker-root');
    const reorderTab = page.getByTestId('staff-tab-reorder');
    await expect(picker.or(reorderTab).first()).toBeVisible();

    if (await picker.isVisible()) {
      await page.getByTestId(`store-row-${storeId}`).click();
    }

    // The bottom tab bar is visible once an active store is set (either we
    // tapped the row, or a reload restored the active store directly).
    await expect(reorderTab).toBeVisible();

    // Open the Reorder tab by its FROZEN testID (never by the i18n label).
    await reorderTab.click();

    // The Reorder screen mounted. -loading is transient (fetch-on-mount); assert
    // the terminal -root, which is always present once the screen renders.
    await expect(page.getByTestId('staff-reorder-root')).toBeVisible();
  }

  test('AC-092-NAV/LIST/CASES/EXPORT: reorder list, by-the-case Suggested, export affordances', async ({
    page,
  }) => {
    // ── AC-092-NAV: reach the Reorder page on the dedicated reorder store ────
    await gotoReorderStore(page, SEED.e2eReorderStoreId);
    await expect(page.getByTestId('staff-reorder-store-name')).toContainText(
      REORDER_STORE_NAME,
    );

    // ── AC-092-LIST: tripwire FIRST (no-vacuous-pass) — the seeded US FOOD
    // vendor card must render. If the fixture ever stops producing a non-empty
    // PRIMARY list, this fails LOUDLY rather than the test passing vacuously.
    const vendorCard = page.getByTestId(`staff-reorder-vendor-${SEED.vendorUsFoodId}`);
    await expect(vendorCard).toBeVisible();

    // KPI strip secondary guard: assert the localized "Vendors" KPI label is
    // present within staff-reorder-root. The KPI cards have no per-card testID
    // (design §6 — the no-app-change route). NOTE (code-review): we deliberately
    // do NOT assert the bare value "1" — a "1" appears in many places on the page
    // and `.first()` would pick an arbitrary node, so that assertion is vacuous.
    // The "Vendors" label is specific to the KPI strip; the real no-vacuous-pass
    // guards are the vendor-card tripwire above + the by-the-case string below.
    const root = page.getByTestId('staff-reorder-root');
    await expect(root.getByText('Vendors', { exact: true })).toBeVisible();

    // ── AC-092-CASES (headline): the by-the-case Suggested string renders in
    // the vendor card. formatSuggested → `${cases} cases · ${units} EA`, wrapped
    // by t('reorder.item.order', {suggested}) = "Order: {suggested}" →
    // "Order: 2 cases · 24 EA". Assert the `·`-joined cases·units shape (NOT a
    // units-only string). The regex tolerates whitespace variance around the
    // middot (U+00B7) but REQUIRES the "cases" word + the middot, so a
    // regression to a units-only render fails. The value (2 / 24) is fully
    // determined by the fixture (par 24, case_qty 12).
    const casesPattern = new RegExp(
      `Order:\\s*${EXPECTED_CASES}\\s*cases\\s*\\u00B7\\s*${EXPECTED_UNITS}\\s*${REORDER_UNIT}`,
    );
    await expect(vendorCard.getByText(casesPattern)).toBeVisible();

    // ── AC-092-EXPORT: the showExport gate is satisfied (non-empty PRIMARY, no
    // error, not initial-loading), so all three export buttons render + are
    // enabled. Presence + enabled-ness ONLY — do NOT click them / do NOT assert
    // a download (matches the admin reorder.spec.ts precedent; Out of scope).
    for (const testId of [
      'staff-reorder-export-csv',
      'staff-reorder-export-text',
      'staff-reorder-export-pdf',
    ] as const) {
      const btn = page.getByTestId(testId);
      await expect(btn).toBeVisible();
      await expect(btn).toBeEnabled();
    }
  });

  test('AC-092-STATE: the empty store shows the no-data state', async ({ page }) => {
    // ── AC-092-STATE: the dedicated empty store (granted, NO inventory) →
    // report_reorder_list returns payload.vendors === [] → the staff-reorder-
    // empty StateCard, on ANY weekday (now-independent). This also exercises the
    // store-switch / picker path for the second dedicated store.
    await gotoReorderStore(page, SEED.e2eReorderEmptyStoreId);
    await expect(page.getByTestId('staff-reorder-store-name')).toContainText(
      REORDER_EMPTY_STORE_NAME,
    );
    await expect(page.getByTestId('staff-reorder-empty')).toBeVisible();

    // Belt-and-suspenders: the empty store has no vendor card and no export
    // surface (the showExport gate is false on an empty PRIMARY set).
    await expect(
      page.getByTestId(`staff-reorder-vendor-${SEED.vendorUsFoodId}`),
    ).toHaveCount(0);
  });
});
