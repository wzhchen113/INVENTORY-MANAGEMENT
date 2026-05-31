// e2e/global-setup.ts — Spec 078 OQ-4 runtime fixture.
//
// THE WEEKDAY-DETERMINISM FIX. The committed supabase/seed.sql contains
// ZERO order_schedule rows (confirmed by the architect). EODCount reads
// order_schedule at (store_id, today's weekday) via fetchVendorsForToday;
// with no rows it renders no vendor chips and no item inputs, so the
// Phase-2 EOD specs (AC-EOD1/2) would be vacuous against the raw seed.
//
// This setup inserts, idempotently, an order_schedule row for BOTH target
// vendors on ALL SEVEN weekdays on the existing Towson store. Result: the
// EOD "today" screen always has two vendor chips (US FOOD + RESTAURANT
// DEPOT — both have Towson inventory_items) plus a non-empty item list,
// regardless of which weekday CI runs on. Two vendors (not one) so
// EODCount renders the vendor-chip switcher (it gates on vendors.length > 1).
//
// WHY A RUNTIME FIXTURE, NOT A SEED EDIT (OQ-4): supabase/seed.sql feeds
// all four test tracks + local dev. Mutating the shared seed to satisfy an
// E2E-only need is the wrong blast radius. This runs once per Playwright
// run, in the Node process, before any browser/project.
//
// SECURITY POSTURE: this uses the LOCAL stack's service-role key (the
// well-known demo key baked into `supabase start`, env-overridable). It is
// NOT a prod secret. It runs ONLY against the local/CI stack URL. The key
// is never logged and never written to a Playwright artifact — only the
// row count is logged. The runtime DB touch lives in test code (the e2e/
// tree), so it does not widen the src/lib/db.ts centralization rule.
//
// Spec 079: the service-role client + the `assertLocalStack` guard were
// EXTRACTED to e2e/fixtures/db.ts (a third consumer — the EOD persistence
// read — landed). This file now imports them; behavior is identical.

import { SEED, WEEKDAYS } from './fixtures/constants';
import { serviceRoleClient } from './fixtures/db';

const VENDORS: Array<{ id: string; name: string }> = [
  { id: SEED.vendorUsFoodId, name: 'US FOOD' },
  { id: SEED.vendorRestaurantDepotId, name: 'RESTAURANT DEPOT' },
];

async function globalSetup(): Promise<void> {
  // serviceRoleClient() runs the assertLocalStack prod-URL guard on
  // construction, so the fixture can never target a non-local stack.
  const admin = serviceRoleClient();

  // One row per (Towson, weekday, vendor). The unique constraint
  // order_schedule_store_day_vendor_unique is (store_id, day_of_week,
  // vendor_id), so `upsert(..., { onConflict, ignoreDuplicates })` is an
  // idempotent ON CONFLICT DO NOTHING — re-runs and a `db reset` both
  // converge.
  //
  // vendor_name AND delivery_day are both NOT NULL on the prod-pulled
  // schema (20260502071736_remote_schema.sql). We mirror the real app
  // write (db.ts addOrderScheduleEntry): vendor_name is the denormalized
  // snapshot; delivery_day falls back to the order weekday when the caller
  // has no distinct delivery day. The EOD screen only reads (store_id,
  // day_of_week) + the vendor join, so the delivery_day value is
  // immaterial to the test — it just has to satisfy NOT NULL.
  const rows = WEEKDAYS.flatMap((day) =>
    VENDORS.map((v) => ({
      store_id: SEED.towsonStoreId,
      day_of_week: day,
      vendor_id: v.id,
      vendor_name: v.name,
      delivery_day: day,
    })),
  );

  const { error } = await admin.from('order_schedule').upsert(rows, {
    onConflict: 'store_id,day_of_week,vendor_id',
    ignoreDuplicates: true,
  });

  if (error) {
    // Fail loudly — a missing FK / dropped Towson or vendor means the EOD
    // specs would silently degrade to vacuous tests. The message is
    // self-explaining; the service-role key is never included in it.
    throw new Error(
      `[e2e global-setup] order_schedule fixture insert failed: ${error.message}. ` +
        `Is the LOCAL Supabase stack running (npm run dev:db) with the committed seed? ` +
        `Expected Towson store ${SEED.towsonStoreId} and vendors ${VENDORS.map((v) => v.id).join(', ')}.`,
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `[e2e global-setup] order_schedule fixture ready: ${rows.length} rows ` +
      `(${VENDORS.length} vendors × ${WEEKDAYS.length} weekdays) on Towson ${SEED.towsonStoreId}.`,
  );
}

export default globalSetup;
