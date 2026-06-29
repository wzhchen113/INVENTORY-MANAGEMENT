# Security audit for spec 102 (multi-vendor ingredients)

Auditor: security-auditor. Date: 2026-06-29. Scope: the fully-staged spec-102
implementation (`git diff --cached`). Read against the spec's `## Backend
design` + `## Backend implementation` + `## Frontend implementation` sections.

**Verdict: no Critical, no Should-fix-blocking. The new `item_vendors` RLS is
correct and complete; the on-hand reconciliation cannot cross-write stores; the
two new RPCs are on the JWT-protected path with no injection surface. Two Nits
(non-blocking) below.**

Threat-model focus areas from the dispatch, each cleared:
- `item_vendors` RLS — 4 commands, all USING + WITH CHECK present and correct.
- spec-053 permissive-policy lint — stays green, no allowlist entry needed.
- On-hand reconciliation (admin db.ts + staff RPC) — store boundary holds.
- The three RPCs — SECURITY DEFINER/INVOKER correct, search_path pinned, no
  dynamic SQL, grants scoped.
- No new edge function; JWT path preserved.
- `npm audit` — package.json not staged; pre-existing advisories only.

---

## Critical (BLOCKS merge)

None.

## Should-fix (before deploy)

None.

## Nit (non-blocking)

- `supabase/migrations/20260630000000_item_vendors.sql:73-75` — the `item_vendors`
  table-level grant lists `references, trigger` for `anon, authenticated`
  (`grant select, insert, update, delete, references, trigger ... to anon,
  authenticated`). This is harmless (matches the `public_grants_explicit`
  baseline shape and is RLS-gated regardless), and `references`/`trigger` are
  not exploitable on a table the role can't already see, but they are broader
  than the four DML verbs the app actually needs through PostgREST. Not a
  finding against the threat model (RLS is the boundary, not the grant); noted
  only because the migration's own comment claims it mirrors the "no-TRUNCATE
  list" net-effective posture and a reviewer might expect exactly
  `select/insert/update/delete`. No change required.

- `src/lib/db.ts:~437-487` (`updateInventoryItem` link reconciliation) — when
  the editor sends `vendors[]` WITHOUT also sending `vendorId`, the local
  `vendorId` resolves to `null` (db.ts:429) and every upserted link gets
  `is_primary: false`, so a `vendors`-only edit can leave an item with zero
  primary links. This is a **data-integrity / correctness** concern (SD-1 says
  the scalar is the source of truth and `is_primary` is its mirror), NOT a
  security boundary — the partial unique index `item_vendors_one_primary_per_item`
  still prevents the dangerous case (two primaries), and a dropped-primary
  flag leaks nothing and grants no access. Flagging for **code-reviewer /
  test-engineer** ownership, not security. The RLS posture is identical
  regardless of `is_primary`.

---

## Detailed findings (why each focus area is clear)

### 1. `item_vendors` RLS — complete and correct (AC-B)

`supabase/migrations/20260630000000_item_vendors.sql:101-125`. All four
commands present, each gating on `auth_can_see_store(ii.store_id)` via an
`EXISTS` join to the parent `inventory_items` row — the established
child-table pattern (`eod_entries` / `po_items` in
`20260504173035_per_store_rls_hardening.sql`):

- SELECT (`store_member_read_item_vendors`, line ~103) — `USING (exists ... auth_can_see_store(ii.store_id))`. A user who can't see the store gets zero rows. Verified the read path the staff fetch + admin embed depend on.
- INSERT (`store_member_insert_item_vendors`, line ~107) — `WITH CHECK (exists ... auth_can_see_store(ii.store_id))`. **This is the load-bearing one the dispatch called out.** The WITH CHECK re-resolves `item_vendors.item_id → inventory_items.store_id` and re-validates the joined store. A caller cannot INSERT a link pointing at an item in a store they can't see: the `exists` subquery only finds the parent row if `auth_can_see_store(ii.store_id)` is true. No way to smuggle a cross-store link. **Not Critical — the WITH CHECK is present and re-validates the joined store.**
- UPDATE (`store_member_update_item_vendors`, line ~111) — has BOTH `USING` and `WITH CHECK`, each the same `exists ... auth_can_see_store` join. USING gates which existing rows are visible-to-update; WITH CHECK gates the post-image. Because the WITH CHECK re-resolves the (possibly changed) `item_id`'s store, a caller cannot re-point a link's `item_id` to an item in a store they can't see, nor edit a link on an item they can't see. Symmetric and complete.
- DELETE (`store_member_delete_item_vendors`, line ~121) — `USING (exists ... auth_can_see_store)`. A non-member cannot delete another store's links.

`item_vendors` carries the **sensitive per-vendor `cost_per_unit` /
`case_price`** (the business-sensitive data the dispatch flagged). Because
SELECT is gated by `auth_can_see_store`, a customer-PWA / staff / cross-store
caller hitting the same Supabase project cannot read another store's per-vendor
cost. The seed (`supabase/seed.sql`, prod-shaped) is protected by these
policies on this table. No under-policied exfil path.

`alter table public.item_vendors enable row level security;` is present
(line ~100) BEFORE the policies — RLS is actually on, not just declared.

### 2. spec-053 permissive-policy lint stays green (AC-B)

`supabase/tests/permissive_policy_lint.test.sql` is **not** in the staged diff
(unchanged — confirmed via `git diff --cached --name-only`). The architect's
claim that no allowlist entry is needed holds: the lint's arm-(1)/(2) detection
regex (lines 118-122) flags a predicate only when its head token (or an
unguarded OR-tail token) is `auth.uid() is not null` / `true` /
`auth.role() = 'authenticated'`. Each of the four `item_vendors` policies has
the form `exists (select 1 from ... where ... and public.auth_can_see_store(...))`
— the **head token is the `exists(...)` / helper-call expression**, not any of
the three trivially-wide literals, and there is no OR-tail. The normalized
predicate (`lower(regexp_replace(qual, '\s+', ' '))` → `exists (select 1 from
public.inventory_items ii where ...)`) does not match the head regex (which is
anchored `^\s*\(*\s*(<wide tokens>)...`) nor the OR-tail regex (no `or`). The
lint stays green with zero new allowlist rows. (Backend impl reports the full
51/51 pgTAP suite — including this lint — green under both backfilled and
CI-fresh `truncate item_vendors` states.)

### 3. On-hand reconciliation cannot cross-write stores (AC-D/E/F)

**Admin path — `src/lib/db.ts` `submitEODCount` (~line 731+, diff hunk).**
The change drops `.eq('vendor_id', submission.vendorId)` from the
`inventory_items` UPDATE and gates per-entry writes on membership in a
prefetched `linkedItemIdsForVendor` set. Two store-boundary backstops, both
intact:

  (a) The prefetch `supabase.from('item_vendors').select('item_id').eq('vendor_id', submission.vendorId)` runs **under the caller's JWT through PostgREST**, so the new SELECT policy (§1) restricts the returned `item_id`s to stores the caller can see. A cross-store vendor link is invisible here. (Note: the prefetch is filtered by `vendor_id` only, not `store_id` — but RLS, not the explicit filter, is the boundary, and RLS holds.)

  (b) The `inventory_items` UPDATE — now `.eq('id', entry.itemId)` with **no** `store_id` or `vendor_id` predicate — is still gated by `inventory_items`' UPDATE policy `USING/WITH CHECK (auth_can_see_store(store_id))` (`20260504173035_per_store_rls_hardening.sql:54-57`). Even if `entry.itemId` named an item in another store, the UPDATE matches zero rows under RLS. **No cross-store on-hand write is possible.** The membership prefetch is a *correctness* gate (preserve the escape-hatch skip), not the security gate — the security gate is `inventory_items` RLS, which the dispatch asked me to confirm "still holds." It does.

**Staff path — `staff_submit_eod` RPC
(`20260630000200_staff_submit_eod_multi_vendor.sql:~210`).** This RPC is
`security definer`, so RLS does NOT auto-enforce on its writes — but the body
keeps the spec-061 store-membership gate as its **first** effective check:
`if not public.auth_can_see_store(p_store_id) then raise ... errcode='42501'`
(lines ~95-99), firing before any INSERT/UPDATE. The on-hand UPDATE predicate
changed from `and ii.vendor_id = p_vendor_id` to `and exists (select 1 from
public.item_vendors iv where iv.item_id = ii.id and iv.vendor_id = p_vendor_id)`
(membership). The write targets `ii.id = v_entry.ingredient_id` — an attacker
who passes a foreign `ingredient_id` cannot escape the store: the caller is
already proven a member of `p_store_id` by the gate, and a shared item's
on-hand is one row keyed by item id. The membership `exists` only widens *which
vendor* can write the item's shared on-hand within the authorized store; it
does not widen *which store*. `set search_path = public` is pinned (line ~88).
GRANT is unchanged (authenticated only; service_role REVOKE'd) — preserved by
`create or replace` of the byte-identical signature. **No cross-store write.**

**Third copy — admin store optimistic mirror (`useStore.ts`,
`itemMatchesSubmittedVendor` → `vendorIds.includes(subVendorId)`).** Client-only
optimistic UI, no security surface; it must match the server (it now does), but
even a divergence would be a UI artifact, not an access-control issue.

### 4. The three RPCs — security shape

- **`report_reorder_list` rewrite (`20260630000100`)** — `security invoker`,
  `set search_path = public` (lines ~74-76), auth gate
  `if not auth_can_see_store(p_store_id) then raise ... '42501'` as the FIRST
  statement (lines ~84-87). Because it's `security invoker`, every table read
  in the CTE chain (including the new `join public.item_vendors iv` in (4f) and
  the `item_vendor_set` sub-CTE) executes under the caller's JWT and is
  RLS-filtered — a shared item links only to vendors/items the caller can see;
  no cross-store rows leak into the per-vendor explosion or the `also_from_vendors`
  hint. The new `item_vendor_set` hint computes OTHER vendors for an item but is
  filtered `where ii.store_id = p_store_id` AND RLS-gated. No dynamic SQL (all
  CTEs are static; the only string-building is `to_char`/`jsonb_build_object`,
  no `EXECUTE`/`format()` of user input). GRANT preserved by `create or replace`.
  Envelope shape unchanged (additive keys only). **Clear.**

- **`report_weekly_lowstock` (new, `20260630000300`)** — `security invoker`,
  `set search_path = public` (lines ~58-60), auth gate as first statement
  (lines ~64-67). Read-only (no INSERT/UPDATE/DELETE — confirmed; it only
  `select ... into v_items` and `return jsonb_build_object`). All CTE reads run
  RLS-filtered under the caller's JWT. `as_of_date` is parsed via
  `nullif(p_params->>'as_of_date','')::date` — a bad value raises a date-cast
  error, no injection (it's a bound cast, not string-concatenated SQL). No
  dynamic SQL. EXECUTE grant is correctly scoped at birth:
  `revoke execute ... from public, anon; grant execute ... to authenticated;`
  (lines ~334-335) — anon/PWA cannot call it. **Clear.**

- **`staff_submit_eod` (`20260630000200`)** — covered in §3. `security definer`
  is appropriate (it must INSERT submissions/entries/audit rows the caller
  might not directly own), and it compensates with the explicit
  `auth_can_see_store` gate + the unchanged spec-061 actor re-derivation from
  `auth.uid()` (spoof-proof). search_path pinned. GRANT authenticated-only,
  service_role REVOKE'd. **Clear.**

### 5. No new edge function; JWT path preserved

`git diff --cached -- supabase/functions/ supabase/config.toml` is empty. The
13 existing functions are untouched, `config.toml`'s `verify_jwt` split is
unchanged. All spec-102 server logic stays on the PostgREST + Postgres-RPC
JWT-protected path, exactly as the design promised ("No new edge function").
No service-token validation surface added or weakened. No secrets in code (no
`Deno.env`/`process.env` changes in the diff). No `EXPO_PUBLIC_*` additions.

### 6. Realtime subscription (`useRealtimeSync.ts:44`)

New `.on('postgres_changes', { event:'*', schema:'public', table:'item_vendors' }, onSync)`
on the `store-{id}` channel with **no `store_id` filter** (the table has no
`store_id` column). This is not a leak: `onSync` is a debounced full reload that
**ignores the change payload entirely** and re-fetches under the caller's JWT
(RLS-scoped). A cross-store `item_vendors` write fires the notification but
delivers no row data the caller isn't entitled to, and the triggered reload
reads only the caller's own stores. Same documented posture as
`ingredient_conversions`. A client subscribed to a store they can't
`auth_can_see_store()` still receives nothing readable. **Clear.**

### 7. Secrets / PII / logs

No tokens, keys, passwords, or JWTs in any added `console.warn`/`console.log`
(grep clean). The two new `console.warn` lines in `submitEODCount` log only an
error `.message` and an `itemId` (a UUID, not PII). No SQL fragments or stack
traces returned to clients. No PII added to RPC payloads (`report_weekly_lowstock`
returns item names/quantities/dates, not user data).

---

## Dependencies

`package.json` / `package-lock.json` are **not** in the staged diff
(`git diff --cached --name-only` confirms). Per process, `npm audit` is only
required when `package.json` changed — skipped as not-in-scope. For
completeness I ran `npm audit --audit-level=high` anyway: the high-severity
advisories present (`@babel/core`, `@xmldom/xmldom`, `form-data`) are all
**pre-existing** transitive dependencies unrelated to and untouched by spec 102.
Not a spec-102 finding; no action required for this spec.
