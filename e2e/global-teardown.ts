// e2e/global-teardown.ts — Spec 078 fix-pass: clean up the OQ-4 fixture.
//
// WHY THIS EXISTS. `global-setup.ts` COMMITS order_schedule rows (2 vendors
// × 7 weekdays) on the Towson store so the EOD specs always have vendor
// chips. In CI that's harmless — `e2e.yml` runs against a fresh `db reset`
// stack that nothing else shares. But LOCALLY, those committed rows persist
// after the run and collide with another track's test:
// `supabase/tests/missed_order_audit_rpc.test.sql` arm C uses Towson as its
// positive-case store and asserts the missed-order RPC returns exactly 1 —
// which fails if Towson already carries the 14 fixture rows (the RPC then
// counts them too). So a dev running `npm run e2e` and then
// `scripts/test-db.sh` would get a false pgTAP failure.
//
// This teardown deletes EXACTLY the rows global-setup inserted (Towson +
// the two fixture vendors, all weekdays), leaving order_schedule as the seed
// had it (the committed seed.sql has ZERO Towson order_schedule rows). It is
// scoped to the two fixture vendor_ids so it can never touch a row a dev
// added by hand. Idempotent — a no-op if the rows are already gone.
//
// Scope note: the e2e suite also creates an invited user (invite spec) and
// EOD submissions (eod spec); those live in other tables and don't collide
// with any other track, so full local hygiene still benefits from a
// `supabase db reset` — but the order_schedule fixture was the one concrete
// cross-track collision, and it's cleaned here.
//
// Spec 080 adds a SECOND cleanup: dashboard-window.spec.ts creates a dedicated
// throwaway store (SEED.e2eWindowStoreId) with order_schedule rows on the
// computed in/out-of-window weekdays. A stale dedicated-store order_schedule
// row would likewise be counted by a later local `record_missed_orders_for_day`
// pgTAP run, so it is dropped store-scoped + FK-ordered below. It is keyed on
// the dedicated store id (NOT one of the four pgTAP anchor stores), so it can
// never touch Towson / Frederick / Charles / Reisters.

// Spec 079: the service-role client + the assertLocalStack guard live in
// e2e/fixtures/db.ts now (extracted from global-setup.ts). Import from there
// instead of cross-importing the setup file. serviceRoleClient() runs the
// same prod-URL guard on construction, so this teardown can never delete
// against a non-local stack — behavior identical to the spec-078 version.
import { SEED } from './fixtures/constants';
import { serviceRoleClient } from './fixtures/db';

const FIXTURE_VENDOR_IDS = [SEED.vendorUsFoodId, SEED.vendorRestaurantDepotId];

async function globalTeardown(): Promise<void> {
  // serviceRoleClient() runs the assertLocalStack prod-URL guard — never
  // delete against a non-local stack.
  const admin = serviceRoleClient();

  const { error } = await admin
    .from('order_schedule')
    .delete()
    .eq('store_id', SEED.towsonStoreId)
    .in('vendor_id', FIXTURE_VENDOR_IDS);

  if (error) {
    // Non-fatal: a failed teardown shouldn't fail the whole run (the suite
    // already passed by the time teardown runs). Surface it so a dev knows
    // to `db reset` before running pgTAP. The key is never logged.
    // eslint-disable-next-line no-console
    console.warn(
      `[e2e global-teardown] order_schedule fixture cleanup failed: ${error.message}. ` +
        `Run \`supabase db reset\` before \`scripts/test-db.sh\` to avoid a stale-fixture pgTAP collision.`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `[e2e global-teardown] order_schedule fixture removed from Towson ${SEED.towsonStoreId}.`,
    );
  }

  // ─── Spec 080: drop the dedicated dashboard-window store + its rows ───────
  // dashboard-window.spec.ts (test.beforeAll) created a throwaway store
  // (SEED.e2eWindowStoreId) with order_schedule rows on the in/out-of-window
  // weekdays. Delete store-scoped + FK-ordered (children before the parent) so
  // a local `npm run e2e` followed by `scripts/test-db.sh` cannot see a stale
  // dedicated-store order_schedule row counted by `record_missed_orders_for_day`
  // — the same cross-track collision class the Towson cleanup above prevents.
  //
  // Each delete is keyed on the dedicated store id, so it is idempotent (no-op
  // when already clean) and CANNOT touch Towson or any of the four pgTAP
  // missed_order_audit_rpc anchor stores (different id). purchase_orders is
  // deleted defensively (the fixture creates none — its absence is the "miss" —
  // but a stray prior write must not survive). order_schedule + purchase_orders
  // are both ON DELETE CASCADE off stores per init_schema, so the explicit
  // child deletes are belt-and-suspenders, not strictly required; they make the
  // FK order self-documenting and don't rely on cascade. The store row is
  // deleted LAST. No user_stores / inventory_items deletes — the fixture
  // creates neither (the unconfirmed_po rule reads neither; admin sees the
  // store via auth_is_admin() without a grant).
  const childTables = ['purchase_orders', 'order_schedule'] as const;
  for (const table of childTables) {
    const { error: childErr } = await admin
      .from(table)
      .delete()
      .eq('store_id', SEED.e2eWindowStoreId);
    if (childErr) {
      // Non-fatal, same posture as above — surface and continue so the store
      // delete still runs. The key is never logged.
      // eslint-disable-next-line no-console
      console.warn(
        `[e2e global-teardown] dedicated-store ${table} cleanup failed: ${childErr.message}. ` +
          `Run \`supabase db reset\` before \`scripts/test-db.sh\` to avoid a stale-fixture pgTAP collision.`,
      );
    }
  }

  const { error: storeErr } = await admin
    .from('stores')
    .delete()
    .eq('id', SEED.e2eWindowStoreId);
  if (storeErr) {
    // eslint-disable-next-line no-console
    console.warn(
      `[e2e global-teardown] dedicated store cleanup failed: ${storeErr.message}. ` +
        `Run \`supabase db reset\` to remove the leftover e2e window store ${SEED.e2eWindowStoreId}.`,
    );
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[e2e global-teardown] dedicated dashboard-window store ${SEED.e2eWindowStoreId} removed.`,
  );
}

export default globalTeardown;
