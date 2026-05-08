# Security audit for spec 007

Scope: Spec 007 EOD count vendor row filtered by day-of-week schedule.
Reviewed migration `supabase/migrations/20260507214842_spec007_order_schedule_unique.sql`,
new `src/lib/db.ts` helpers, new `src/store/useStore.ts` actions, and the
new UI surfaces (`OrderScheduleSection.tsx`, `EODCountSection.tsx` deltas,
`AddVendorScheduleModal.tsx`). Probed the local DB for RLS behavior.

## Verdict: no Critical findings. Spec 007 is safe to ship from a security perspective.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `src/lib/db.ts:1565` — `addOrderScheduleEntry` swallows only PG error code
  `23505` (unique_violation) but rethrows all other errors, including
  `42501` (RLS violation). That's the right shape for an admin-only write —
  a non-admin caller will see a `notifyBackendError` toast. **Not a finding,
  noting for completeness.** Confirmed via local probe: when a non-admin
  attempts the insert, RLS WITH CHECK fires before the unique constraint,
  so the user gets a `new row violates row-level security policy` message
  rather than a `23505` — meaning the unique constraint cannot be used as a
  side-channel to enumerate existing rows from outside admin role. Postgres
  RLS-vs-constraint ordering is correct here.

### Dependencies

No `package.json` / `package-lock.json` changes — `npm audit` skipped.

---

## Item-by-item walk-through of the auditor brief

### 1. RLS on `order_schedule`

**Confirmed via probe of local DB.**

Policies present (`pg_policy` query against `public.order_schedule`):

- `Store members can read order_schedule` (SELECT) —
  `store_id IN (SELECT store_id FROM user_stores WHERE user_id = auth.uid()) OR
   ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin','master'))`
- `Admins can write order_schedule` (ALL) — admin/master JWT role only,
  both USING and WITH CHECK.

`relrowsecurity = t`. Source migration:
`supabase/migrations/20260424211733_security_fixes.sql:21-35`. The
`per_store_rls_hardening.sql` migration explicitly leaves `order_schedule`
alone (line 19-23 of that file says so) — so the architect's §4 analysis is
accurate.

**Read probe** (manager user `22222222-...`, role `user`, member of Towson +
Frederick only): with one seed row in Charles store and one in Towson, the
manager's `SELECT` returned only the Towson row. Cross-store leak is
blocked.

**Write probe** (same manager, member of Towson): `INSERT` into
`order_schedule` for Towson failed with
`new row violates row-level security policy for table "order_schedule"`.
Even being a member is not enough — admin/master role required. Matches the
spec's intent (admin-managed config).

**Admin probe** (admin user `11111111-...`, role `admin`): `INSERT ... ON
CONFLICT ON CONSTRAINT order_schedule_store_day_vendor_unique DO NOTHING`
succeeded.

No new RLS work needed. Architect's §4 is accurate.

### 2. Unique-constraint vs. RLS ordering (existence side-channel)

**Verified safe.** Probed: when a non-admin attempts to insert a row that
already exists, Postgres returns the RLS error (42501-class) and never
evaluates the unique constraint, so `23505` cannot be used as a yes/no
oracle to enumerate other tenants' rows. Modern Postgres evaluates RLS
WITH CHECK before triggering the unique-index enforcement on writes the
caller doesn't have permission for. No leak.

### 3. `addOrderScheduleEntry` insert shape

`src/lib/db.ts:1542-1566` uses a plain `.insert(...)` and swallows error
code `23505`. This is functionally equivalent to architect's
`ON CONFLICT DO NOTHING` (the row doesn't get inserted in either case) and
the user does not see an error toast on duplicate clicks. Local smoke
confirms idempotent behavior (re-clicking an already-on cell is a silent
no-op).

UX-as-security note: the helper swallows ONLY 23505. Other error codes
(connectivity, RLS denial, etc.) propagate up to `notifyBackendError`. No
generic-error obscuring.

### 4. Brand-scope leakage on vendors

**Confirmed safe at the application layer.** `useStore.vendors` is loaded
via `db.fetchAllForStore → fetchVendors(brandId)` at
`src/lib/db.ts:1475`, which filters `eq('brand_id', brandId)`. Both the
`AddVendorScheduleModal` picker (`src/components/cmd/AddVendorScheduleModal.tsx:27`)
and the `OrderScheduleSection` grid (`src/screens/cmd/sections/OrderScheduleSection.tsx:21`)
only see vendors for the current store's brand.

**Caveat (pre-existing, NOT a Spec 007 finding):** `vendors` table SELECT
RLS is `auth.uid() is not null`
(`supabase/migrations/20260504073942_brand_catalog_p5_rls.sql:155-158`),
i.e., any authed user can read every brand's vendors via raw PostgREST.
The brand scoping is purely client-side. A determined admin could craft a
direct REST call referencing a vendor_id from a different brand and try to
schedule it for a store in their own brand. With current policies the
write WOULD succeed (admin role passes the `Admins can write
order_schedule` policy; there's no FK-side brand check). The result is
cosmetic noise (a vendor shows up in the schedule that no one normally
sees) — no data exfiltration, no cross-tenant write, since
`order_schedule.store_id` still pins the row to a store in the admin's own
brand.

Not surfacing this as a Spec 007 finding because (a) the surface for it
existed before this spec — the legacy `saveOrderSchedule` had the same
exposure, (b) admins are trusted by design here, and (c) the pre-existing
loose `vendors` SELECT policy is the upstream cause and is already noted
in the architect's hardening backlog. Flag only if the user wants a
brand-cross-check on the new helper (e.g., resolve `vendor.brand_id` and
match against `stores.brand_id`).

### 5. `useRole` placeholder reliance

**None.** Greped the three new/changed UI files (`OrderScheduleSection.tsx`,
`EODCountSection.tsx`, `AddVendorScheduleModal.tsx`) and the new store
actions — no references to `useRole`. Authorization rides entirely on RLS
at the DB layer, which is correct.

### 6. Secrets

No new secrets, no new env-var references, no `process.env` /
`Deno.env.get` introductions. `console.*` is clean in the new files; the
optimistic-revert path uses `notifyBackendError` (which the project-wide
auditor brief flags as the right shape).

### 7. Migration idempotency

`supabase/migrations/20260507214842_spec007_order_schedule_unique.sql`:

- The dedup pre-pass is a `DELETE ... USING ... WHERE a.ctid > b.ctid`
  self-join. Re-running on a deduped table finds zero matching pairs and
  is a no-op. NOTICE prints `0` on the second apply.
- The constraint add is wrapped in a `DO $$ ... IF NOT EXISTS (SELECT 1
  FROM pg_constraint WHERE conname = ...) ...` block (lines 68-83). Probed
  by re-running the IF-NOT-EXISTS check against the currently-applied
  local DB: it correctly returned the `skipped` branch.

Idempotent. Safe to re-apply.

### 8. Coexistence with the pre-existing `vendor_name` unique constraint

`order_schedule` now has TWO unique constraints (verified by
`pg_constraint` probe):

- `order_schedule_store_id_day_of_week_vendor_name_key` —
  `(store_id, day_of_week, vendor_name)` — pre-existing in
  `20260502071736_remote_schema.sql`.
- `order_schedule_store_day_vendor_unique` —
  `(store_id, day_of_week, vendor_id)` — new in this spec.

**Behavior under combined constraints:**

- Insert path through the new helper supplies both `vendor_id` and
  `vendor_name` from the caller's vendor record. If the caller fetches the
  vendor from `useStore.vendors`, both will match the same vendor row, so
  the two constraints converge. No surprises in the happy path.
- Edge case: vendor name update. `updateVendor`
  (`src/lib/db.ts:1048-1059`) updates `vendors.name` but does NOT cascade
  to `order_schedule.vendor_name`. After a rename, the cached
  `useStore.vendors[i].name` is the new name; existing `order_schedule`
  rows still hold the old name. Inserting "rename target" name for a
  vendor_id that already has a row would fail BOTH constraints (vendor_id
  conflict via the new constraint, vendor_name conflict only if the new
  name happens to match). The 23505 swallow handles either path
  gracefully — the user sees a no-op, which is the right outcome.
- Adversarial edge case: two rows with same vendor_id but different
  vendor_name. **Cannot happen via the new helper** (same vendor_id is
  blocked by the new constraint). Could only happen via direct DB writes
  bypassing both helpers, which requires admin role anyway and is
  out-of-scope.

Net assessment: redundant but not harmful. The new constraint at the
vendor_id grain is the canonical one going forward; the legacy
vendor_name constraint is harmless dead weight that could be dropped in a
future cleanup but is NOT a security concern.

### 9. TZ-bug fix — `localDayIso` → `selectedDayName`

`src/screens/cmd/sections/EODCountSection.tsx:38-43,71,165-167`:

- `selectedIso` is initialized to `localDayIso(new Date())` and updated
  only via `setSelectedIso` from the in-component week picker (line 409).
- `selectedDayName` is derived as `DAY_NAMES[new Date(selectedIso +
  'T00:00:00').getDay()]`.
- No URL-param parsing, no `Linking.parse`, no `route.params` consumption
  feeds `selectedIso`. The day-of-week is purely client-state.

Even if `selectedIso` were attacker-controlled, `selectedDayName` is only
used on the read side (filtering vendor pills) and on the write side as
the `day_of_week` field in the new helpers. Writing for a different day
than the user thinks they're writing for is not a security issue — the
target store still has admin RLS gating. Worst case is a self-foot-shoot
bookkeeping error.

No coercion path. The TZ fix is purely a correctness improvement.

### 10. Realtime publication

Spec 007 §5 did NOT add `order_schedule` to the realtime publication. But
the build notes (line 1113) report that `order_schedule` was ALREADY in
the publication. Verified — no change to the publication membership in
this spec.

Realtime row-level filtering: realtime respects RLS. A non-admin
subscriber to `store-{their-store}` channel will only receive
`order_schedule` row events for stores they can `SELECT` against the read
policy. Same security boundary as the REST path. No new exposure.

### 11. Input validation

The new helpers take `storeId: string`, `day: string`, `vendor.vendorId:
string`. PostgREST is parameterized — no `.rpc('exec_sql', ...)`-style
dynamic SQL. The `day` string is not constrained client-side to TitleCase
weekday values, but a malformed `day` value (e.g., `"Foo"` from a tampered
client) just inserts a bookkeeping garbage row that no UI surface reads.
Not a security issue. Could be an integrity/UX concern; surface for the
backend-architect post-impl review if concerned, not security.

`vendor_id` is a UUID column with FK to `vendors(id)` (per
`20260502071736_remote_schema.sql:191`). Invalid UUIDs are rejected by PG
as type errors; missing references fail the FK check. No SQLi surface.

---

## Files reviewed

- `supabase/migrations/20260507214842_spec007_order_schedule_unique.sql`
- `supabase/migrations/20260424211733_security_fixes.sql` (existing
  `order_schedule` policies)
- `supabase/migrations/20260424211732_recover_undeclared_tables.sql`
  (table creation)
- `supabase/migrations/20260504173035_per_store_rls_hardening.sql`
  (confirms `order_schedule` intentionally left out)
- `supabase/migrations/20260504073942_brand_catalog_p5_rls.sql` (vendors
  RLS, brand-scope context)
- `supabase/migrations/20260502071736_remote_schema.sql` (pre-existing
  vendor_name unique + delivery_day NOT NULL)
- `src/lib/db.ts` (lines 572-600 fetchVendors, 1462-1495 fetchAllForStore,
  1497-1582 order_schedule helpers)
- `src/store/useStore.ts` (lines 1036-1098 schedule actions)
- `src/screens/cmd/sections/OrderScheduleSection.tsx`
- `src/screens/cmd/sections/EODCountSection.tsx` (lines 30-43, 60-71,
  160-185, 540-640, 895-920)
- `src/components/cmd/AddVendorScheduleModal.tsx`

## Probes run (local DB, port 54322)

- `pg_policy` enumeration of `order_schedule` policies — confirmed.
- `pg_class.relrowsecurity` on `order_schedule` — confirmed `t`.
- `pg_constraint` enumeration of unique constraints on `order_schedule` —
  confirmed both constraints present.
- Cross-store SELECT as non-admin store member — only own-store row
  returned.
- INSERT as non-admin (member): blocked by RLS WITH CHECK.
- INSERT as admin: succeeded.
- Duplicate INSERT as non-admin: blocked by RLS, NOT by unique constraint
  — no existence-side-channel.
- Re-applying constraint-add `IF NOT EXISTS` block: correctly skipped.

Test rows cleaned up after probes (`DELETE` returned remaining count = 1,
the seed row).
