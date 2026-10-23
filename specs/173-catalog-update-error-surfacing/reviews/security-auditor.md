## Security audit for spec 173

Scope reviewed (staged, `git diff --cached`):
- `src/lib/db.ts` — `updateInventoryItem` catalog block (L484-517)
- `src/lib/db.eodCountMode.test.ts` — one-line mock addition
- `src/lib/db.updateInventoryItem.catalogErrors.spec173.test.ts` (new)
- `src/store/useStore.updateItem.catalogRevert.spec173.test.ts` (new)
- `specs/173-catalog-update-error-surfacing.md`

No migrations, RLS policies, edge functions, `config.toml`, realtime publication, or `package.json` changes. The change is client-side error detection only. It cannot widen server-side access, because what a caller can do is still decided entirely by RLS.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low
- `src/lib/db.ts:499` and `src/lib/db.ts:513`: raw PostgREST error messages reach the toast. `notifyBackendError` (`src/store/useStore.ts:54-63`) renders `e.message` as `text2` and passes the same string to `console.warn`. For AC-1 that is PGRST116 text ("JSON object requested, multiple (or no) rows returned"). For AC-3 it is Postgres constraint text, e.g. `new row for relation "catalog_ingredients" violates check constraint "..."`, or for a 23505 duplicate name, `duplicate key value violates unique constraint "..."`. This exposes table and constraint names to an authenticated Cmd-UI user, and nothing more. Only `message` is rendered, not `details`/`hint`, so the 23505 `Key (brand_id, lower(name))=(...)` detail does not reach the toast or the console line. The per-store and `item_vendors` writes already throw the same way, and the spec chose this explicitly (D1/D3, "no new copy"). No cross-tenant data, SQL fragments, stack traces, or tokens are exposed. Informational, no action needed. A future spec could map known codes (23505, 23514) to friendly copy if the owner wants.
- `src/store/useStore.ts:2317-2328` (pre-existing, out of scope, already noted in spec D7): `updateItem` writes the `'Item edit'` audit event whether or not the save worked. Now that RLS-denied catalog edits reject, the audit trail can still record an "Item updated" row, with the attempted `value: JSON.stringify(updates)`, for an edit the database refused. This is an audit-integrity gap, not an access-control gap, because the refused write never landed. Consider a follow-up that moves the audit call into the success path or records the failure. Not blocking for spec 173.

### Verification notes (the three questions asked)

**1. Is the RLS-denial detection correct against the `catalog_ingredients` UPDATE policy?** Yes.
- The only UPDATE policy is `privileged_update_catalog_ingredients` (`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:457-466`). Its USING and WITH CHECK are both `auth_is_privileged() AND auth_can_see_brand(brand_id)`. No later migration changes `catalog_ingredients` policies. `20261023000000_catalog_eod_count_mode.sql:30-37` states "NO policy change", and a grep of every later migration found no `create/alter/drop policy ... on public.catalog_ingredients`. The live local DB (`pg_policies`) has exactly four permissive policies (SELECT, INSERT, UPDATE, DELETE) and no RESTRICTIVE policies, matching the migration.
- An UPDATE whose target row fails USING is filtered silently. PostgREST returns `error: null` with `[]`, which `src/lib/db.ts:514-516` turns into a rejection.
- Checked live against the local stack, inside `BEGIN … ROLLBACK` (nothing persisted), with `request.jwt.claims` set and `role authenticated`, running the same `UPDATE … WHERE id = $1 RETURNING id` that PostgREST issues for `.update().eq().select('id')`:
  - `admin@local.test` (privileged, same brand): 1 row returned, so it resolves.
  - `master@local.test` (privileged, same brand): 1 row returned, so it resolves.
  - `manager@local.test` (role `user`, not privileged): 0 rows, `error: null`, so it now rejects with the AC-4 message. This is the case that used to fail silently.
- The only UPDATE trigger, `trg_catalog_image_changed_at` (`20260722000000_ingredient_changed_badge.sql:47-62`), always does `return new`. No BEFORE trigger can null out the row and cause a false 0-row result.
- Order of operations is correct. All four throws (L499, L502, L513, L515) come before the per-store `inventory_items` UPDATE and every `item_vendors` op, so a refused catalog write cannot leave a half-write.
- The AC-4 message ("no permission … or it no longer exists") is deliberately ambiguous, so it does not reveal whether a hidden catalog row exists. The caller also only reaches the catalog id through an `inventory_items` row it can already see.

**2. Could `.select('id')` make a permitted updater fail falsely because it needs SELECT visibility?** No.
- With `RETURNING`, Postgres also applies the SELECT policy to the rows it returns. The SELECT policy `brand_member_read_catalog_ingredients` is `auth_can_see_brand(brand_id)`, which is strictly weaker than the UPDATE USING clause. Any row that passes UPDATE USING also passes SELECT. Super-admins pass through the `auth_is_super_admin()` short-circuit in `auth_can_see_brand` (`20260509000000_multi_brand_schema_rls.sql:200-209`).
- The `.eq('id', catalogId)` WHERE clause already reads the row, so SELECT USING applied to the existing row even before this change. `.select('id')` only adds the returned-row check, and that passes too.
- A new-row SELECT failure would raise 42501 rather than return 0 rows, and it can't happen here anyway. `catalogUpdates` is built from a fixed allowlist (`name`, `unit`, `category`, `case_qty`, `sub_unit_size`, `sub_unit_unit`, `i18n_names`, `eod_count_mode`, `updated_at`, at L473-486). `brand_id` is never written, so the new row keeps its original brand. The allowlist also means the caller cannot mass-assign `brand_id` into another tenant.
- Table grants: `authenticated` holds SELECT and UPDATE on `catalog_ingredients` (live `information_schema.role_table_grants`, from the spec 097 explicit grants), with no column-level revokes, so `RETURNING id` is allowed.
- Confirmed by the live probe above: privileged same-brand callers get exactly 1 row back.

**3. Do the toast messages leak anything sensitive?** No (see the first Low). The synthesized `Error` strings (L502, L515) are fixed literals with no ids or row data. The raw PostgREST messages carry schema and constraint names only. No tokens, keys, or PII appear anywhere in the new code or in the new test files (grepped for key, token, secret, password, and JWT prefixes).

**Other checks**
- Server-side authorization is not affected. The change does not use `useRole()` or any client value as a security boundary. It only reports the result RLS already produced.
- Realtime: no publication or channel changes.
- The intended behavior change (spec D7) is confirmed live: non-privileged Cmd-UI callers (e.g. role `user`) who edit catalog fields will now see a revert and a toast where the edit used to look saved. This is correct and arguably a security improvement, since it stops a "saved" brand-wide catalog change from silently diverging from server state.

### Dependencies
No `package.json` changes, so `npm audit` was skipped.
