# Security audit for spec 035

Scope: new `public.report_run_vendor(uuid, jsonb)` RPC + dispatcher arm, the
companion pgTAP suite, the 1-arm extension of the anon-revoke suite, and 4
frontend wiring edits. The architect framed this as byte-for-byte parallel to
spec 034 (waste) in security shape; I confirm that parity, then re-check the
divergences that matter for security (new joined tables, brand-scoped vendor
name resolution).

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `supabase/migrations/20260514180000_report_run_vendor.sql:152` — Error
  message `'Vendor report: from > to (% > %)'` interpolates the caller-
  supplied `v_from` / `v_to` dates (already coerced to `::date`, so the
  format spec can only render a valid date literal). This is the same
  shape as waste:117 and variance — not a finding by itself. Noted only
  so a future contributor doesn't widen the message to include
  arbitrary `p_params` substrings (which would reflect untrusted input
  back to a JSON error envelope).

### Dependencies

No `package.json` or `package-lock.json` changes in this spec — `npm audit`
skipped. The 8 changed files are 1 migration, 1 new pgTAP, 1 extended
pgTAP, 4 frontend `.tsx`/`.ts` edits, and the spec markdown itself; no
runtime deps were touched.

---

## What I verified (positive findings)

These items would be the locus of a Critical/High if any one were missing;
I confirmed each is in place.

### 1. RPC security posture — byte-for-byte parity with waste

`supabase/migrations/20260514180000_report_run_vendor.sql:99-128`

- `language plpgsql` (line 103)
- `security invoker` (line 104) — the RPC runs as the caller's role, so
  RLS on every joined table (`purchase_orders`, `po_items`, `vendors`,
  `inventory_items`, `catalog_ingredients`) is evaluated against the
  caller's `auth.uid()`. Defense-in-depth even if the explicit auth gate
  at line 125 were removed.
- `set search_path = public` (line 105) — closes the public-schema
  shadowing foot-gun; objects in private schemas can't shadow the
  function's resolution.
- First statement is the `auth_can_see_store(p_store_id)` gate raising
  `42501` (line 125-128). Matches waste:88-92 / variance:142-146 /
  COGS exactly.
- Grants (line 463-464): `revoke execute on function ... from public,
  anon; grant ... to authenticated;`. Closes the implicit `EXECUTE TO
  PUBLIC` foot-gun that `reports_anon_revoke.test.sql` covers
  end-to-end as the anon role.

The dispatcher (line 473-510) re-creates `public.report_run` with the
same security shape (`security invoker`, `search_path`, auth gate first,
revoke from public/anon, grant to authenticated). The case-edit is a full
re-create because Postgres has no in-place CASE-edit — outstanding grants
to other roles are preserved by `create or replace`.

### 2. Joined-table RLS coverage — defense in depth

Even if a future contributor were to weaken the explicit auth gate, every
table the runner touches has store- or brand-scoped RLS that filters under
`security invoker`:

- `purchase_orders` — per-store via `auth_can_see_store(store_id)` at
  `supabase/migrations/20260504173035_per_store_rls_hardening.sql:186-201`.
- `po_items` — chained per-store via parent PO's store_id at
  `supabase/migrations/20260504173035_per_store_rls_hardening.sql:206-251`
  (`EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = po_items.po_id
  AND auth_can_see_store(po.store_id))`). Same shape the runner's join
  uses, so RLS will allow exactly the rows the runner intends to return.
- `vendors` — brand-scoped via `auth_can_see_brand(brand_id)` at
  `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:575-577`.
  The left-join (`left join vendors v on v.id = po.vendor_id`, line 205)
  means a vendor row from another brand would simply be filtered to NULL
  by RLS and surface as `'(deleted vendor)'` — the migration's orphan
  fallback (line 200-202) is correct: it does not leak a vendor name
  from outside the caller's brand. This is the right call given the
  2AM-only single-brand reality today, AND it stays correct when the
  multi-brand expansion lands.
- `inventory_items` — per-store at
  `supabase/migrations/20260504173035_per_store_rls_hardening.sql:46-63`.
- `catalog_ingredients` — brand-scoped at
  `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:446-448`.
  Used for `category` / `unit` / `item.name` resolution in by=category
  and by=item modes. Same brand check applies; cross-brand catalog
  entries are filtered to NULL and surface as `'(uncategorized)'` /
  `'(deleted item)'` / `''`.

The architect's note about "vendor name leaks from other brands" is
specifically prevented because RLS evaluates the LEFT JOIN's predicate
against the caller's UID — `v.id = po.vendor_id` returns NULL when
`auth_can_see_brand(v.brand_id)` is false, which the `coalesce(v.name,
case ...)` correctly maps to the orphan label.

### 3. Information disclosure via `p_params`

`supabase/migrations/20260514180000_report_run_vendor.sql:132-146`

- `from` / `to` extracted via `(p_params->>'from')::date` — the explicit
  `::date` cast turns any malformed input into the native 22007/22008
  PG error, which the frontend's `runReport` toast path already
  sanitizes to "Run failed — check server logs". No interpolation of
  the raw input into any subsequent SQL.
- `by` extracted via `p_params->>'by'` and allow-listed against
  `('vendor', 'category', 'item')` at line 143. Unknown values are
  silently coerced to the default `'vendor'` per the forward-compat
  convention; the value is then read ONLY through the `v_by` plpgsql
  variable in `if v_by = 'vendor' then ... elsif v_by = 'category' ...
  else (item) ...` control flow. No dynamic SQL anywhere — no `EXECUTE
  format()` or similar. SQLi surface = zero.
- Unknown keys in `p_params` are silently ignored (no iteration over
  `jsonb_each(p_params)`). No prototype-pollution-equivalent risk.
- Range-validation error `'Vendor report: from > to (% > %)'` (line
  152) only echoes the already-cast `v_from` / `v_to` date values — no
  raw user input is reflected.
- No SQL fragments, table names, or row data appear in any error
  message back to the client.

### 4. Anon-revoke test extension

`supabase/tests/reports_anon_revoke.test.sql:39, 125-137`

- `plan(9)` → `plan(10)` (line 39) — matches the new arm.
- Arm position is `(6)` — slotted immediately after waste `(5)` and
  before `report_reorder_list` `(7)`, matching the migration's
  in-source ordering (vendor lands after waste). The renumbered arms
  `(7)/(8)/(9)` are correctly renumbered down the file.
- New arm (line 129-137): `set local role anon` is in scope from line
  55; `request.jwt.claims` is set to an `'anon'` role JWT at line 56-62
  (also still in scope). The `format(...)` substitutes the Frederick
  store id correctly. The `throws_ok(... '42501' ...)` assertion will
  fire at GRANT time (the function call is blocked before the
  `auth_can_see_store` check inside the function body) — same shape as
  arms (1) through (5) and (7)/(8)/(9). Matches architect §A6.

### 5. Status filter is load-bearing

`supabase/migrations/20260514180000_report_run_vendor.sql:207`

The `(po.status = 'received' OR po.received_at IS NOT NULL)` predicate
matches the variance multivendor precedent at
`20260514120020_report_run_variance_multivendor.sql:350`. Without this
filter, draft / sent POs (which represent intent but not actual spend)
would inflate the headline. The new pgTAP arm (7) at
`supabase/tests/report_run_vendor.test.sql:240-256` explicitly inserts a
`status='draft', received_at IS NULL` PO and asserts it does NOT
contribute, which protects against a future WHERE-clause regression. The
test is well-placed.

### 6. Frontend wiring — no new auth surface

The 4 frontend edits (`templates.ts`, `NewReportModal.tsx`,
`ReportDetailFrame.tsx`, `ReportsSection.tsx`) are all UI plumbing:

- `templates.ts:32` flips `vendor` from `'preview'` to `'live'`. No
  auth implication — `status` only gates whether the detail frame's
  chip dropdowns are interactive and whether the RUN button calls the
  real dispatcher arm vs. surfacing `not_implemented`.
- `NewReportModal.tsx:75-90` widens the `ByOption` union to admit
  `'vendor'`; adds `vendor: ['vendor', 'category', 'item']` to the
  `BY_OPTIONS` registry. The string is rendered into UI labels via
  `<Text>{opt}</Text>` (React Native `Text` is XSS-safe by
  construction) and passed back to the RPC via `params.by` — which the
  RPC then allow-lists at line 143.
- `ReportDetailFrame.tsx:62, 190-194, 268-271` widens the same union
  and adds the per-template by-mode option list. Same XSS-safe rendering
  pattern.
- `ReportsSection.tsx:40, 177` widens the `OverrideState['by']` union.
  The override value is passed verbatim into the RPC call's merged
  params; server-side allow-listing at line 143 is the authoritative
  gate.

No client-side `useRole()` usage in any of these — the role hook is the
documented placeholder per CLAUDE.md and is NOT used as a security
boundary in this spec. No localStorage reads, no service-role key
reachable from client, no `EXPO_PUBLIC_*` envs added.

### 7. Edge functions — out of scope

This spec touches no `supabase/functions/`. The `verify_jwt` /
service-token / `ADMIN_ROLES` Set / `escapeHtml` audit lanes are all
n/a. No new edge function landed; no existing edge function was
modified.

### 8. CI / migration safety

Per CLAUDE.md "CI workflow", `.github/workflows/db-migrations-applied.yml`
is not currently on disk — agents should not assume CI is gating
migration safety. The vendor migration is NOT destructive:

- `create or replace function public.report_run_vendor(...)` — net-new.
- `create or replace function public.report_run(...)` — re-creates the
  dispatcher with one added `when 'vendor'` arm; preserves every
  existing arm verbatim (verified against
  `20260514170000_report_run_waste.sql:425-460`). Outstanding grants are
  preserved by `create or replace`.
- `revoke ... from public, anon; grant ... to authenticated;` — the
  revoke is idempotent (no-op if already revoked, which it will be for
  the dispatcher whose previous revoke already fired).

No data is migrated, no table is altered, no policy is changed. Rollback
is `drop function public.report_run_vendor(uuid, jsonb)` plus
re-create the prior dispatcher version from the waste migration's tail.

---

Bottom line: the security shape is byte-for-byte the spec 034 waste
precedent the architect intended. All five joined tables have appropriate
RLS that filters under `security invoker`. The auth gate is the first
statement; grants/revokes match the spec 016 convention; no dynamic SQL;
no caller-controlled string reflected into errors; the new anon-revoke
arm fires from inside the `anon` role and asserts `42501`. The four
frontend edits introduce no new auth surface — they widen TS unions and
add UI labels, with the RPC's allow-list at line 143 as the
authoritative gate on the `by:` value.
