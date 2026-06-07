# Security audit for spec 083 (store-deactivation-toggle)

Scope: `src/lib/db.ts` (new `updateStore`, `fetchStoresIncludingInactive`),
`src/store/useStore.ts` (`updateStore` slice), `src/screens/cmd/sections/BrandsSection.tsx`
(inline toggle UI), plus the new pgTAP pin
`supabase/tests/stores_privileged_update_status.test.sql`.

**Verdict: PASS — no Critical, no High. The "no new migration/RPC/RLS" claim
holds and the existing gate genuinely enforces authorization.** Two Low notes
(documentation/defense-in-depth, not blocking).

## Verification of the four key claims

1. **Non-privileged / cross-brand callers cannot flip status — RLS holds, not just the client gate.**
   VERIFIED. The write is a plain PostgREST UPDATE on `public.stores`
   (`src/lib/db.ts:101-105`). The governing policy `privileged_update_stores`
   (`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:627-636`) has
   BOTH `USING` and `WITH CHECK` = `auth_is_privileged() AND auth_can_see_brand(brand_id)`.
   - `auth_is_privileged()` = `auth_is_admin() OR auth_is_super_admin()`
     (`...:235-239`); `auth_is_admin()` matches JWT role in `('admin','master')`
     (`20260504073942_brand_catalog_p5_rls.sql:23-27`); `auth_is_super_admin()`
     reads `profiles.role = 'super_admin'` (`...:187-195`). This is exactly the
     `admin + master + super_admin` band the spec requires (Q3).
   - A `role='user'` caller fails `USING` → UPDATE filters to 0 rows. A
     cross-brand admin fails `auth_can_see_brand(brand_id)` → 0 rows. The client
     `useRole`/`useIsSuperAdmin` value is NOT the security boundary here; the DB
     policy is. The pgTAP file pins all six permutations
     (`stores_privileged_update_status.test.sql`, arms 1-6 including
     non-privileged=0-rows and cross-brand=0-rows).

2. **`updateStore` cannot write `brand_id` (no cross-brand move / WITH CHECK bypass).**
   VERIFIED at two layers. `db.updateStore` only maps `name/address/eodDeadlineTime/status`
   into `dbUpdates` (`src/lib/db.ts:96-100`) — there is no `brand_id` branch, and
   the type signature is `Partial<Pick<Store,'name'|'address'|'eodDeadlineTime'|'status'>>`
   so `brandId` is not even accepted. `useStore.updateStore` additionally forwards
   only those four explicit keys (`src/store/useStore.ts:1967-1972`), so a caller
   passing `{ brandId }` would be silently dropped before reaching db.ts. A
   status-only PATCH leaves `brand_id` unchanged, so `WITH CHECK` evaluates
   against the original brand and `auth_can_see_brand` still holds — no escalation
   path.

3. **`fetchStoresIncludingInactive` does not leak cross-brand/tenant rows.**
   VERIFIED. The function drops only the `.eq('status','active')` filter; it adds
   no `.eq('brand_id', ...)` bypass and issues a normal RLS-subject SELECT
   (`src/lib/db.ts:68-82`). SELECT on `stores` is governed by
   `store_member_read_stores = auth_can_see_store(id)`
   (`20260509000000_multi_brand_schema_rls.sql:616-618`), which still scopes rows
   to the caller's brand (super-admin short-circuit aside, which is intended).
   `status` is not part of the SELECT policy, so removing the client-side status
   filter exposes only inactive stores the caller was already entitled to see —
   no new tenant exposure. The UI further narrows to the selected brand
   client-side (`BrandsSection.tsx:1064`), which is cosmetic, not the security
   boundary.

4. **No new permissive policy added (CLAUDE.md OR-widening footgun).**
   VERIFIED. `git status` shows zero files under `supabase/migrations/`; the only
   `.sql` added is a `supabase/tests/` pgTAP file (read-only, runs in a
   begin/rollback txn). The diff contains no `CREATE POLICY` / `ALTER TABLE ...
   ENABLE ROW LEVEL SECURITY`. The legacy wide `auth_manage_stores` policy was
   already dropped in spec 051, so the scoped UPDATE policy is not OR-neutralized.
   The permissive-policy lint stays green because nothing was added.

## Other checks

- **XSS via store name in confirm dialog.** Not a finding. `BrandsSection.tsx:1100-1108`
  interpolates `s.name` into `confirmAction`, which renders through `window.confirm`
  (plain text) on web and `Alert.alert` (plain text) on native
  (`src/utils/confirmAction.ts`) — no HTML sink. No Resend/HTML-email path touched.
- **Secrets / PII.** No service-role key, service token, or `EXPO_PUBLIC_*` added
  or logged. Error paths use `notifyBackendError('Update store', e)` and
  `Toast.show` with `e?.message` — no raw rows, SQL fragments, or tokens.
- **Destructive-op guards (self-guard / last-of-role).** Not applicable.
  Deactivation is reversible and non-destructive (only `stores.status` flips); no
  `deleteUser`, role demotion, or profile delete. The CLAUDE.md destructive-op
  discipline does not extend here.
- **Edge functions / verify_jwt.** None added or changed; `supabase/config.toml`
  untouched. `eod-reminder-cron` confirmed unchanged (existing `.eq('status','active')`
  gate is the suppression mechanism).

## Low

- `src/lib/db.ts:101-106` / Backend design "Risks" — an RLS-denied UPDATE returns
  2xx with 0 rows (PostgREST UPDATE semantics), so a non-privileged caller who
  reached the write gets NO error and the optimistic local flip persists until the
  next re-fetch. This is correctly documented as accepted-for-v1 and the tab is
  admin-only + re-fetches on mount/brand-change. Not a vulnerability (RLS still
  prevents the actual write); noted only so a future reviewer doesn't read the
  silent success as a persisted change. Defense-in-depth option if ever desired:
  `.select()` on the update and treat 0 rows as a denial toast.
- `src/screens/cmd/sections/BrandsSection.tsx:1091-1092` — the toggle optimistically
  updates tab-local state and does not read-after-write, so on an RLS 0-row no-op
  the row shows the wrong status until the next reconciliation re-fetch. Cosmetic
  consistency only; the server state is correct. Acceptable for v1 as designed.

## Dependencies

No `package.json` / `package-lock.json` changes — `npm audit` skipped.
