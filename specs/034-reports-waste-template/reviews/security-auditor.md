# Security audit for spec 034 — Reports: Waste cost template

Scope: 1 new migration + 1 new pgTAP test + 1 modified pgTAP test + 4 frontend
edits (templates.ts, NewReportModal, ReportsSection, ReportDetailFrame, and the
type annotation in `src/types/index.ts`). RPC-only backend; no edge functions,
no new tables, no new RLS surface, no dependency changes.

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

- `supabase/migrations/20260514170000_report_run_waste.sql:108-111` — the
  `by` coercion fall-through silently rewrites unknown values to `'reason'`.
  This is intentional per the spec (forward-compat / COGS precedent at
  20260511120000) and not a security issue, but it does mean a malicious
  caller could pass `by: 'item; DROP TABLE ...'` and it would be silently
  coerced; no log trace is left of the original input. No action required —
  flagging only because future reviewers may wonder. The frontend's
  `OverrideState['by']` union is the upstream type gate; the DB coercion
  is defense-in-depth.

- `supabase/migrations/20260514170000_report_run_waste.sql:117` — the
  `from > to` error message interpolates the parsed dates
  (`'Waste report: from > to (% > %)'`). Same shape as variance at line 195
  / COGS line 124. Dates are already coerced to the `date` type at line
  100/104 so the values that reach `format` are never raw strings — no
  injection surface. Flagged only because the message DOES echo back caller-
  supplied input; if any future change tweaks the message format, keep the
  values typed (not raw `p_params->>'from'`).

## Notes / Confirmed clean

### 1. RPC security posture

- `SECURITY INVOKER` ✅ (line 68) — RLS on `waste_log`, `inventory_items`,
  `catalog_ingredients` applies to the caller's UID, not the function owner.
  Identical to variance line 79.
- `SET search_path = public` ✅ (line 69) — locked; same shape as variance
  line 80. Prevents the `SET search_path` injection / `pg_temp` shadowing
  class of issue.
- First-statement auth gate ✅ (lines 88-92) — `auth_can_see_store(p_store_id)`
  check raises `42501` before any data access. Byte-for-byte equivalent to
  variance lines 142-146.
- `revoke execute ... from public, anon; grant ... to authenticated;` ✅
  (lines 411-412) — closes the PUBLIC-inheritance foot-gun that
  `reports_anon_revoke.test.sql` covers. Identical shape to variance lines
  608-609 and COGS lines 684-685.
- Dispatcher re-create ✅ (lines 425-460) — preserves stub/cogs/variance
  arms and the `not_implemented` fallback exactly. Adds `waste` as a fifth
  arm. The `p_template_id` is matched via SQL `CASE`, not interpolated into
  any dynamic SQL — no injection surface. The dispatcher's first-statement
  auth gate (lines 435-438) is also unchanged.

### 2. RLS regression — store isolation defense-in-depth

The function is `SECURITY INVOKER`, so even if the explicit auth gate at
line 88 were bypassed somehow, the underlying RLS policies would still
filter the result set:

- `waste_log` has per-store RLS: `auth_can_see_store(store_id)` on SELECT,
  INSERT, UPDATE, DELETE (per_store_rls_hardening.sql:137-152).
- `inventory_items` (joined for `by='category'` / `by='item'`) has
  per-store RLS (per_store_rls_hardening.sql:46-61).
- `catalog_ingredients` (joined for `by='category'` / `by='item'`) has
  brand-scoped RLS (multi_brand_schema_rls.sql:446-448).

A manager in brand A who calls this RPC against a brand A store will see
only their brand's catalog rows; cross-tenant data is filtered at the
joined-tables layer too. The pgTAP test (3) exercises the auth-gate
branch; the RLS layer is an independent second line.

### 3. p_params input handling

- `p_params jsonb` is parsed by Postgres, never interpolated. The
  `p_params->>'from'`, `p_params->>'to'`, `p_params->>'by'` extractions
  return text that is then either `::date`-cast (raises 22007/22008 on
  bad input — surfaced sanitized through the frontend's existing
  `runReport` toast path) or `IN (...)`-checked against a fixed allow-
  list. No SQL string is built from caller input.
- Unknown keys in `p_params` are ignored (forward-compat).
- A maliciously huge `p_params` JSONB does not enter any unbounded loop
  or recursive walk; only three specific keys are read.

### 4. Information disclosure

- Error messages cite the parsed `date` values (not raw input strings),
  the calling `p_store_id` (which the caller already has), and the
  generic `'Not authorized for store %'` text. No SQL fragments,
  internal table layout, or cross-tenant data leak through error paths.
- The empty-result envelope (lines 192-197) returns the column header but
  no rows — same shape as a populated result with zero rows, so the
  caller cannot distinguish "no rows for this window" from "this store
  has no waste log at all". No oracle for store membership beyond what
  the auth-gate already discloses.

### 5. DoS / abuse surface

- `idx_waste_log_store_logged_at` (added by variance migration line 619)
  covers the `(store_id = ?, logged_at::date >= ?, ::date <= ?)` filter
  shape — the runner is store-scoped and SARGable on `logged_at`. A
  malicious caller requesting `from='1900-01-01', to='9999-12-31'` would
  scan the full per-store waste log; at prod scale (thousands of rows
  per store-month) that's a few-thousand-row aggregation. No
  authentication bypass and no excess data leak — the RLS layer still
  filters to the caller's stores. Recommend the frontend keep its
  existing date-range chip-strip gating, but no DB-side cap is required
  for this spec.
- The three `with base as ...` re-walks (sections 5, 8, 9) are an
  intentional plpgsql / CTE-scoping pattern (COGS precedent). At the
  scale described above this is fine; at million-row scale it could
  matter — but that's a performance concern, not a security one.

### 6. Test coverage

- `report_run_waste.test.sql` plan(11) ✅ — auth gate, empty range,
  per-row formula, missing-cost zero-out, multi-row ordering, envelope
  shape, by-mode smoke. The auth-gate test (3) impersonates a
  non-member of Charles and asserts 42501.
- `reports_anon_revoke.test.sql` plan(8 → 9) ✅ — new arm at index (5)
  for `report_run_waste` is correctly placed between variance arm (4)
  and reorder arm (6). The arm calls the RPC as anon and asserts 42501
  fires at GRANT time before any param parsing.

### 7. Frontend edits — no auth surface

The 4 frontend edits (templates.ts flag flip, NewReportModal
BY_OPTIONS registry, ReportsSection OverrideState union extension,
ReportDetailFrame ByPopover prop widening) are pure UI wiring. None
introduce a new auth check, fetch a new endpoint, expose a new env
variable, or use the placeholder `useRole()` as a security boundary.
The widened `OverrideState['by']` union (`'reason' | 'category' |
'item'`) is a forward-compat type expansion the DB already coerces on
the server side.

The type doc addition in `src/types/index.ts` (lines 528-530) is a JSDoc
comment update only — no new code.

### Dependencies

`package.json` has no diff vs `main`. No new npm packages introduced.
`npm audit` not re-run for this spec (no dependency surface change since
the last spec).

## Conclusion

This spec adds one tightly-scoped read-only RPC with the spec 016 /
variance security shape applied byte-for-byte: `SECURITY INVOKER`, locked
`search_path`, first-statement auth gate, `revoke from public, anon` +
`grant to authenticated`. The dispatcher arm is a `CASE` match with no
interpolation surface. The new pgTAP test exercises the auth gate;
`reports_anon_revoke.test.sql` extends to cover the GRANT-time anon
denial.

No Critical, High, or Medium findings. Two Low informational notes only.
Recommend ship.
