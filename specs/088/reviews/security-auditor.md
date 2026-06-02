# Security audit for spec 088

Reorder "Suggested" shown in cases for case-based items — additive `create or replace` of the
`report_reorder_list(uuid, jsonb)` RPC (cost-rounding math + 3 new derived numeric keys) plus
display-only FE formatting. Changes reviewed UNSTAGED against the prior RPC definition
([supabase/migrations/20260514130000_report_reorder_list.sql](../../../supabase/migrations/20260514130000_report_reorder_list.sql)).

Verdict: **clean PASS.** No new authz, secrets, injection, or data-exposure surface. Every claim
in the architect's design was verified against the actual diff and the original migration rather
than trusted.

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

None.

## What was verified (evidence)

**Auth gate byte-identical — RLS posture unchanged.**
The new function body's first statement is the same `auth_can_see_store(p_store_id)` gate raising
`42501`:
[20260602000000_reorder_suggested_cases.sql:81-84](../../../supabase/migrations/20260602000000_reorder_suggested_cases.sql)
matches the original at
[20260514130000_report_reorder_list.sql:119-122](../../../supabase/migrations/20260514130000_report_reorder_list.sql)
verbatim. `security invoker` + `set search_path = public` are preserved
([20260602000000:67-69](../../../supabase/migrations/20260602000000_reorder_suggested_cases.sql) vs
[20260514130000:105-107](../../../supabase/migrations/20260514130000_report_reorder_list.sql)).
Because the function is `security invoker`, every SELECT inside still runs under the caller's RLS;
the new `coalesce(ci.case_qty, 1)` read at line 389 comes off the SAME `catalog_ingredients` row
already SELECTed through the pre-existing `ci` join (line 412) — no new read surface, no new table,
no `pg_policies` change.

**No GRANT/REVOKE drift.**
Signatures are identical — both declare `report_reorder_list(p_store_id uuid, p_params jsonb default
'{}'::jsonb)`. The new migration intentionally carries NO grant/revoke statements
([20260602000000:597-600](../../../supabase/migrations/20260602000000_reorder_suggested_cases.sql)),
which is correct: `create or replace` with a byte-identical signature preserves the existing ACL
established at
[20260514130000:606-609](../../../supabase/migrations/20260514130000_report_reorder_list.sql)
(`revoke execute ... from public, anon; grant execute ... to authenticated`). I confirmed there is
no `drop function` anywhere in the new file — a drop+recreate would have reset the ACL to default
(public-executable); it is a plain `create or replace`, so anon remains revoked. Verified by grep:
the new migration contains zero `grant`/`revoke` DDL (only those tokens appear in explanatory
comments).

**No injection / no new dynamic SQL.**
The three additive hunks are pure scalar arithmetic on already-materialized rows:
`coalesce(ci.case_qty,1)::numeric` (line 389); `ceil(suggested_qty/case_qty)` guarded by a static
`case when case_qty > 1` (lines 435-440); and three constant-keyed `jsonb_build_object` entries
(lines 494-498). No `EXECUTE`, no `format()`, no string concatenation building SQL — grep for
`execute`/`format(` in the function body returns only the unrelated `usage_forecasted` /
`par_replacement` math already present in the original. All user input (`p_store_id`, `p_params`)
remains parameter-bound; `p_params->>'as_of_date'` is cast via `nullif(...)::date` exactly as before
(line 91), which rejects malformed input by type-cast error, not string interpolation.

**No new data exposure (no cross-store / cross-brand leak).**
The three new keys — `case_qty`, `suggested_cases`, `suggested_units` (lines 494-498) — are per-item
derived numerics computed entirely from values already inside the authorized payload:
`catalog_ingredients.case_qty` (already joined) and `suggested_qty` (already exposed at line 487).
They carry no identifiers, no other-store rows, and no new columns. The whole RPC is still scoped by
the single `p_store_id` gate, so these derivations cannot widen the blast radius. `case_qty` lives on
`catalog_ingredients` (brand-scoped) and was already reachable to the function — no store-scoping
concern is introduced. Confirmed the cost-value change (`estimated_cost`/`vendor_total_cost`/
`kpis.total_estimated_cost` becoming case-rounded) is an arithmetic transform of existing in-scope
numbers, not the surfacing of any previously-hidden data.

**FE is display-only — no new auth surface, no secrets, no cost math.**
[src/lib/db.ts:2764-2770](../../../src/lib/db.ts) maps the three new fields through the existing
private `mapReorderVendor` with defensive `Number(... ?? default)` coercion; `estimatedCost` /
`vendorTotalCost` are left server-authoritative (no FE override). The new exported helpers
`formatSuggested` / `formatSuggestedPdf`
([ReorderSection.tsx:62-82](../../../src/screens/cmd/sections/ReorderSection.tsx)) are pure string
formatters over typed numerics — no `dangerouslySetInnerHTML`, no eval, no template injection
(values flow into React Text nodes / PapaParse cells / jsPDF `autoTable` body, all of which
escape/encode by construction). CSV additions
([ReorderSection.tsx:438-468](../../../src/screens/cmd/sections/ReorderSection.tsx)) emit numeric
cells via the fixed-`columns` allowlist, so no row-field injection reshapes the header. No
`useRole()` value is used as a security boundary anywhere in the diff. No secrets, no
`EXPO_PUBLIC_*` additions, no `console.log` of sensitive data.

**pgTAP does NOT use `set role anon`.**
[report_reorder_list_cases.test.sql](../../../supabase/tests/report_reorder_list_cases.test.sql)
uses the `set local role authenticated` + `request.jwt.claims` master pattern (lines 86-95) and
contains zero `set role anon` (the only `anon` token is in the comment at line 42 explaining its
deliberate absence). Confirms the spec-067 CI-segfault guard holds. Correctly omits any
`has_function_privilege` assertion since the grant is untouched.

## Dependencies

`package.json` and `package-lock.json` are UNCHANGED (empty `git diff`, exit 0) — no new
dependencies introduced. Ran `npm audit --audit-level=high` as a sanity check anyway: the reported
advisories (`@xmldom/xmldom` high; `dompurify`/`postcss`/`brace-expansion` moderate, all transitive
under `@expo/*` and the jsPDF/SVG toolchain) are pre-existing baseline findings, none introduced or
touched by this spec. Out of scope for spec 088; standing dependency-hygiene item unrelated to these
changes.

## Summary

Spec 088 is an additive, arithmetic-only change to an already-gated `security invoker` RPC plus
display-only frontend formatting, and it introduces no security regression. I verified directly
(not by trusting the design notes) that the `auth_can_see_store()` gate, `security invoker` status,
`search_path`, function signature, and the `revoke ... from public, anon` / `grant ... to
authenticated` ACL are all byte-preserved across the `create or replace`; that the three new JSON
keys are pure scalar derivations of data already inside the store-scoped payload (no cross-store /
cross-brand exposure); that no dynamic SQL, `EXECUTE`, or `format()` was added; that the FE is
display-only with no new auth surface, secrets, or `EXPO_PUBLIC_*` leakage and never treats the
placeholder `useRole()` as a boundary; that `package.json` is unchanged (no new deps); and that the
new pgTAP test avoids the `set role anon` CI-segfault and correctly omits a grant assertion. No
Critical, High, Medium, or Low findings — nothing blocks merge.
