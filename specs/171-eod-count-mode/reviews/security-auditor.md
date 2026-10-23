## Security audit for spec 171

Scope: staged diff (`git diff --cached`), with most attention on
`supabase/migrations/20261023000000_catalog_eod_count_mode.sql`, the
`create_inventory_item_with_catalog` drop and recreate, the CHECK constraint, RLS and
grants on `catalog_ingredients`, the staff PostgREST embed change, and the
`db.ts` write path. The untracked `specs/172-eod-no-need.md` was not reviewed.

I checked the live state of the local stack (`supabase_db_imr-inventory`, with the migration
already applied) using read-only catalog queries:

- `create_inventory_item_with_catalog(uuid,uuid,text,text,text,numeric,numeric,text,numeric,numeric,jsonb,jsonb,text)`
  is the ONLY overload. `prosecdef = f` (SECURITY INVOKER), `proconfig = {search_path=public}`,
  `proacl = {postgres=X, authenticated=X, service_role=X}`. There is no PUBLIC entry and no anon entry.
- `catalog_ingredients.eod_count_mode` is `text NOT NULL DEFAULT 'cases_and_units'`, and
  `catalog_ingredients_eod_count_mode_check` is
  `CHECK (eod_count_mode = ANY (ARRAY['cases_and_units','cases_only','units_only']))`.
- `pg_policies` on `catalog_ingredients` has not changed. SELECT is gated by `auth_can_see_brand(brand_id)`.
  INSERT, UPDATE and DELETE are gated by `auth_is_privileged() AND auth_can_see_brand(brand_id)`.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low
- `src/lib/db.ts:294` and `src/screens/staff/screens/EODCount.tsx:160`: **deploy ordering (availability, not
  confidentiality).** Both PostgREST embeds now name `eod_count_mode` explicitly. If the Vercel web build ships
  before the migration is applied to prod (the MCP `execute_sql` + `schema_migrations` route), PostgREST will
  reject the whole select with "column does not exist". That breaks the admin `fetchInventory` and the staff
  EOD item fetch. `createInventoryItem` (`src/lib/db.ts:397`) would also fail with PGRST202, because the
  12-arg function cannot accept `p_eod_count_mode`. The reverse order is safe: legacy clients leave the trailing
  parameter out, and the default resolves the call to the single 13-arg overload. **Fix:** apply the migration
  to prod first, then deploy the client. Confirm `db-migrations-applied.yml` is green before the web deploy.
  No code change is needed.
- `supabase/migrations/20261023000000_catalog_eod_count_mode.sql:76-82`: **the count mode is only a UI-input
  restriction.** `staff_submit_eod` and `eod_entries` do not enforce it. Any store member can still send
  `actual_remaining_cases` and `actual_remaining_each` for a `units_only` or `cases_only` item through
  PostgREST or RPC. This is documented and intended (the column comment and spec say so). It gives no new
  capability, because store members could already submit arbitrary count values. Recorded only so nobody
  later treats `eod_count_mode` as a server-side integrity control. No fix required for this spec.

### Verified (no finding)
1. **RPC drop and recreate** (`migration:85-87`, `89-235`). The 12-arg signature drop exactly matches
   `20260517000000_user_data_i18n_names.sql:131-133`, so there is no leftover overload that could cause
   PGRST203. The body stays `security invoker` with `set search_path = public` (lines 106-107), which matches
   the 11-arg and 12-arg predecessors. Every write runs under the caller's RLS. No dynamic SQL is used
   (`EXECUTE`/`format`), and every argument is bound, so there is no SQLi surface.
   `p_eod_count_mode` goes straight into the INSERT, and the CHECK constraint validates it. A bad value
   raises 23514 (pgTAP arm 19).
2. **Grants** (`migration:241-246`). The `revoke all ... from public, anon` followed by
   `grant execute ... to authenticated` is correct and needed. Spec 097's
   `alter default privileges ... on functions` (`20260618000000_public_grants_explicit.sql:198+`) would
   otherwise give anon an explicit EXECUTE, on top of PostgreSQL's implicit PUBLIC EXECUTE. This is a real
   tightening compared with the 12-arg version, where anon could execute through PUBLIC and only RLS stopped
   the writes. It follows the same pattern as `20261008000000_get_profile_emails.sql:71-72`. The live ACL above
   confirms it, and pgTAP arms 21-25 pin it (anon has no EXECUTE, PUBLIC has no EXECUTE, authenticated has
   EXECUTE, there is exactly one overload, and `prosecdef = false`). service_role keeping EXECUTE is harmless,
   because it already bypasses RLS.
3. **Authenticated callers of the RPC, including customer-PWA and staff JWTs.** These users share the Supabase
   project, so they also get EXECUTE. Because the function is SECURITY INVOKER, they cannot write
   `eod_count_mode`:
   - New catalog rows need `privileged_insert_catalog_ingredients` (`auth_is_privileged() AND
     auth_can_see_brand`).
   - The find-existing branch and the `on conflict ... do update set updated_at = now()` branch
     (`migration:126-130`, `155`) never touch `eod_count_mode`. pgTAP arm 20 proves that the find-existing
     path does not overwrite it.
   - A caller who cannot see the brand gets an RLS error on the catalog INSERT.
4. **Write path for `eod_count_mode`** (`src/lib/db.ts:482-483`, `397`). Writes only reach the column through
   (a) the PostgREST UPDATE on `catalog_ingredients`, gated by `privileged_update_catalog_ingredients`, or
   (b) the RPC create branch, gated by the privileged INSERT policy. Staff (`role = 'user'`) UPDATE affects 0
   rows (pgTAP arms 14 and 15). Neither path relies on client-side `useRole()`. On the client, the form
   restricts the value through `isEodCountMode` (`src/components/cmd/IngredientForm.tsx:1108`), and create
   normalizes it (`normalizeEodCountMode`). The DB CHECK is the authoritative guard.
5. **RLS and realtime exposure.** No new table, policy or publication change. The new column inherits the
   existing brand-scoped SELECT policy, so staff and other brand members can read it. That is intended
   (AC-4), and the value is a non-sensitive UI hint with no PII. `catalog_ingredients` is already in
   `supabase_realtime` with no column list, so cross-brand realtime visibility is still filtered by the
   unchanged SELECT policy. `pwa-catalog` (`supabase/functions/pwa-catalog/index.ts:115`) uses an explicit
   column list that does not include the new column, so the customer-facing surface is unchanged.
6. **CHECK constraint** (`migration:70-74`). It admits exactly the three literals. With NOT NULL and a
   constant default, it cannot fail validation on existing prod rows. The drop-then-add makes it idempotent.
   Nothing in the migration is destructive to data.
7. **Staff PostgREST select** (`src/screens/staff/screens/EODCount.tsx:160`). The only change is one extra
   column on an existing embed. Filtering (`.eq('item.store_id', storeId)`, `inventory_items!inner`) and RLS
   (`auth_can_see_store` on `inventory_items`, `auth_can_see_brand` on `catalog_ingredients`) are unchanged.
   The value is normalized before use (`normalizeEodCountMode`), so an unexpected server value cannot reach
   the UI as an arbitrary string.
8. **Secrets and logging.** No new `console.*`, `notifyBackendError` payloads, env vars or `EXPO_PUBLIC_*`
   keys. No edge functions or `supabase/config.toml` changes. No HTML or email interpolation. No destructive
   role or deletion paths, so the last-of-role and self-guard rules do not apply.

### Out of scope / pre-existing (not attributed to spec 171)
- The local catalog shows `anon` and `authenticated` with TRUNCATE on `catalog_ingredients`. This comes from
  the CLI image and is not introduced here. PostgREST does not expose TRUNCATE, and no SECURITY INVOKER
  function issues it, so it cannot be reached from the API. It is only worth a look if a future spec adds
  raw-SQL surfaces.
- `src/lib/db.ts:492-497`: the result of the `catalog_ingredients` `.update(...)` call is not checked. An RLS
  0-row filter or a CHECK violation is therefore swallowed silently for every catalog field, and now
  `eod_count_mode` as well. This is a correctness and UX issue for the code reviewer, not a security issue.
  The form already limits the value to valid literals.

### Dependencies
No `package.json` or lockfile changes. Skipped `npm audit`.
