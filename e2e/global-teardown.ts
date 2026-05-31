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

import { createClient } from '@supabase/supabase-js';
import { SEED } from './fixtures/constants';
import { assertLocalStack } from './global-setup';

const SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const FIXTURE_VENDOR_IDS = [SEED.vendorUsFoodId, SEED.vendorRestaurantDepotId];

async function globalTeardown(): Promise<void> {
  // Same guard as global-setup — never delete against a non-local stack.
  assertLocalStack(SUPABASE_URL);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

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
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[e2e global-teardown] order_schedule fixture removed from Towson ${SEED.towsonStoreId}.`,
  );
}

export default globalTeardown;
