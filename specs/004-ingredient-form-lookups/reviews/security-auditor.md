# Security audit for spec 004 — re-audit after fix-pass

Round 2. Prior audit's findings (1 High, 4 Medium, 5 Low) re-evaluated against
the working tree + the live `supabase_db_imr-inventory` Postgres container.
New attack surface introduced by the fix-pass also reviewed.

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

- `src/lib/db.ts:1184-1185` — **STILL-OPEN (per release-coordinator decision).**
  `deleteIngredientConversion(id)` performs a raw `delete().eq('id', id)`
  without verifying that the caller's `currentStore.brandId` matches the
  row's `catalog_id → catalog_ingredients.brand_id`. RLS only checks
  `auth_is_admin()`; an admin can delete any brand's conversion by id.
  Acknowledged out of scope for the single-brand 2026 deployment per the
  release proposal; surfacing again so it isn't lost on the inevitable
  multi-brand transition. No fix expected this cycle.

- `src/screens/cmd/sections/InventoryCatalogMode.tsx` realtime cross-brand
  chatter — **STILL-OPEN (informational).** `ingredient_conversions` is
  brand-keyed only via `catalog_id`; the realtime channel can't filter on
  brand without joining. Per the architect's §4 reasoning, the consumer
  is a refetch trigger and not a row-payload trust point, so the leak is
  authed-only metadata churn rather than data exposure. Acceptable;
  unchanged by fix-pass.

## Low

- `src/components/cmd/IngredientForm.tsx:332` (vendor dropdown filter) —
  **STILL-OPEN (per threat model).** Cross-brand vendor binding gated only
  by RLS on `inventory_items` for non-admins; admins are intentionally
  cross-brand. Consistent with the project's admin threat model. No fix.

- `src/store/useStore.ts:24-32` (`notifyBackendError` raw Postgres errors)
  — **STILL-OPEN (existing pattern).** Admin-only tool; matches the
  prevailing pattern across the store. Not a spec 004 regression. No fix.

- `src/hooks/useRole.ts` placeholder — **RESOLVED (verified clean).**
  Re-greppped across `IngredientForm.tsx`, `IngredientFormDrawer.tsx`,
  `CategoriesSection.tsx`, `InventoryCatalogMode.tsx`, `db.ts`,
  `useStore.ts`, `useRealtimeSync.ts`, and the new `validators.ts`. Zero
  references to `useRole`. Auth boundary stays at the DB-layer RLS.

- Backfill migration
  `supabase/migrations/20260507010946_spec004_ingredient_categories_backfill.sql`
  — **RESOLVED (re-verified).** Parameterized reads, `insert ... select`,
  no `EXECUTE`, no string interpolation. SQL injection impossible.

- No new secrets — **RESOLVED.** Greppd `EXPO_PUBLIC_`, `process.env`,
  `Deno.env`, `API_KEY`, `SECRET`, `TOKEN` across the three new
  migrations and the four touched source files (`InventoryCatalogMode
  .tsx`, `IngredientForm.tsx`, `CategoriesSection.tsx`, `validators.ts`).
  None added.

## Resolution status of prior findings

| Prior finding | Severity | Status         | Notes |
|---------------|----------|----------------|-------|
| `ingredient_categories` permissive RLS | High     | **RESOLVED**   | New migration `20260507015244_spec004_ingredient_categories_rls_p6.sql` applied; live `pg_policy` shows 4 policies matching P5's shape on `ingredient_conversions`. Live probes confirm: non-admin INSERT is rejected with `new row violates row-level security policy`; non-admin UPDATE/DELETE return 0 rows; admin INSERT succeeds. |
| `net_yield_pct` accepts >100% / silently coerces negatives | Medium   | **RESOLVED**   | `InventoryCatalogMode.tsx:641-654` (handleAdd) and `:692-702` (saveEdit) both clamp to (0, 100] and surface "Yield % must be between 0 and 100" toast on out-of-range. Empty input still defaults to 100 (the column default), matching the spec contract. |
| `NUMERIC_RE` accepts lone `.` | Medium   | **RESOLVED**   | New `src/utils/validators.ts:22` exports `NUMERIC_RE = /^(\d+\.?\d*|\d*\.\d+|)$/` — verified rejects `.`, `..`, `1.2.`, `..1`, `1..2`, `+1`, `-1`, `1e2`, ` 1`, `NaN`, `Infinity` while accepting `''`, `0.`, `.0`, `1.5`, `12.`, `0.0`. Used by both `IngredientForm.tsx` and `InventoryCatalogMode.tsx:21`. |
| `deleteIngredientConversion` no brand check | Medium   | **STILL-OPEN** | Out of scope per release proposal item 8 carve-out (single-brand deployment). Re-listed above for traceability. |
| Realtime cross-brand chatter on `ingredient_conversions` | Medium (informational) | **STILL-OPEN** | Architecturally bounded to refetch-trigger usage. Re-listed above. |
| Vendor cross-brand FK | Low      | **STILL-OPEN** | Admin threat model. Re-listed above. |
| `notifyBackendError` raw PG errors | Low      | **STILL-OPEN** | Pre-existing pattern. Re-listed above. |
| `useRole.ts` regression | Low      | **RESOLVED**   | No new code branches on `useRole`. |
| Backfill SQL injection-safe | Low      | **RESOLVED**   | Re-verified. |
| No new secrets | Low      | **RESOLVED**   | Re-verified across all changed files. |

## Re-audit of the new RLS migration

File: `supabase/migrations/20260507015244_spec004_ingredient_categories_rls_p6.sql`.

- **References `auth_is_admin()` correctly** — `:39, :43, :44, :48`. The
  helper is defined at
  `supabase/migrations/20260504173035_per_store_rls_hardening.sql` and
  resolves live to `coalesce((auth.jwt() -> 'app_metadata' ->> 'role'),
  '') = any (array['admin', 'master'])` (verified via `pg_proc`). No
  inline JWT extraction. Good.
- **All four DML operations covered** — SELECT (`:33-35`), INSERT
  (`:37-39`), UPDATE (`:41-44`), DELETE (`:46-48`). UPDATE has both
  `using` and `with check` clauses, so an admin cannot UPDATE a row to
  values that would no longer be visible (defensive even though there's
  no row-level filter besides admin-vs-not).
- **TRUNCATE** is not policy-able in PostgreSQL — it's gated by table
  ownership (`postgres` superuser only). Not a gap; just noting.
- **REFERENCES** — there are no FK references *into* `ingredient_categories`
  (no `inventory_items.category_id`, just text-FK on `name`), so a
  REFERENCES-grant policy is not applicable. The text-FK shape is a
  separate data-integrity question, out of scope here.
- **Idempotency** — every `create policy` is preceded by `drop policy if
  exists`. Re-running the migration is safe. Five legacy policy names
  also dropped (`auth_manage_ingredient_categories`, `Authenticated can
  read…`, `Admins can write/update/delete…`) so the final state is
  deterministic regardless of pre-state.
- **Static SQL only** — no `EXECUTE`, no `format()`, no string
  interpolation. Injection-impossible.
- **No new secrets** — no env vars, no service keys, no tokens.
- **RLS still enabled** — `pg_class.relrowsecurity = true` on
  `ingredient_categories` (verified).

Verdict on the migration: well-formed, complete, mirrors P5's shape on
`ingredient_conversions` exactly, no new attack surface introduced.

## New attack surface introduced by the fix-pass

Reviewed every change for new vectors:

- **Yield clamp at `(0, 100]`.** Tightening; no new vector. The clamp is
  client-side only (the DB column is still unbounded `numeric` — same as
  before), so a hostile admin who bypasses the client could still write
  e.g. yield = 9999. Same threat model as before — admins own the schema
  on this product. A defense-in-depth `check (net_yield_pct > 0 and
  net_yield_pct <= 100)` constraint would tighten further; release
  proposal flagged it as out-of-scope follow-up. Not a finding.

- **Tightened regex `/^(\d+\.?\d*|\d*\.\d+|)$/`.** No catastrophic
  backtracking — the alternation has no nested quantifiers and each
  branch consumes input deterministically. Stress-tested with 1,000-char
  inputs (3 ms total wall time across all probe inputs). The empty
  branch is intentional (allows clearing the field). No ReDoS surface.
  Not a finding.

- **CategoriesSection delete: `disabled={count > 0}` removed; check
  moved into `handleDelete` body.** Audited the race window: between
  the client-side `inventory.filter((i) => i.category === name).length`
  computation and the server `delete().eq('name', name)` round-trip,
  another admin could repoint an `inventory_items.category` to this
  name. The window is ~ms and only between admins. The DB has no FK
  enforcement on `inventory_items.category → ingredient_categories.name`
  (it's a text-FK, observed at the data layer), so the *server* can't
  reject the delete based on referential integrity — there is nothing
  to race against on the DB side. Worst case: admin A deletes "Produce"
  while admin B simultaneously assigns an item to "Produce"; the result
  is an `inventory_items.category = 'Produce'` row whose dropdown
  source is now empty (orphan label). This is the same orphan-text
  failure mode that exists for renames today and is not introduced by
  the fix-pass — the original `disabled={count > 0}` had the identical
  TOCTOU window because the disabled-state was driven by the same
  client-side `inventory` snapshot. The toast / inline warning still
  surface the in-use case; the affordance change is UX-only. Not a
  finding.

- **New `src/utils/validators.ts`.** 28 lines, single regex export +
  one wrapper function. No I/O, no eval, no dynamic dispatch. Module
  surface is two named exports. No injection vector, no privilege
  boundary crossed. Not a finding.

## Live RLS state — verified via docker exec on supabase_db_imr-inventory

```
                   polname                    | polcmd |        using_expr        |   check_expr
----------------------------------------------+--------+--------------------------+-----------------
 Admins can delete ingredient categories      | d      | auth_is_admin()          |
 Admins can update ingredient categories      | w      | auth_is_admin()          | auth_is_admin()
 Admins can write ingredient categories       | a      |                          | auth_is_admin()
 Authenticated can read ingredient categories | r      | (auth.uid() IS NOT NULL) |
(4 rows)
```

`pg_class.relrowsecurity = t` (RLS enabled).

Behavior probes (each in a `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims = ...; <op>; ROLLBACK;` envelope so no real data was mutated):

- Non-admin INSERT — `ERROR: new row violates row-level security policy for table "ingredient_categories"`.
- Non-admin UPDATE — `UPDATE 0` (RLS silently filters all rows out of `using` set).
- Non-admin DELETE — `DELETE 0` (same).
- Admin INSERT — `INSERT 0 1`, returning `admin_probe_ok`.

Realtime publication membership unchanged (verified): `ingredient_categories`, `ingredient_conversions`, `vendors` all in `supabase_realtime`. No publication changes in the fix-pass.

## Dependencies

`package.json` not modified by the fix-pass (verified via `git diff --stat`). `npm audit` skipped — no dependency changes.

## Summary

Spec 004's prior High and two of three actionable Mediums are RESOLVED. The remaining Mediums (`deleteIngredientConversion` no brand check; realtime cross-brand chatter) are scoped out per the release proposal and remain known multi-brand-future surfaces. The new RLS migration is well-formed, mirrors P5's `ingredient_conversions` shape, references the canonical `auth_is_admin()` helper, covers all four DML operations, is idempotent, and is verified to behave correctly against live probes. The fix-pass introduces no new attack surface — the regex has no ReDoS, the validators module has no I/O, the yield clamp is purely tightening, and the categories-delete TOCTOU window is identical to the pre-fix one (and is bounded by admin-only access anyway).

No Critical, no High, two Mediums STILL-OPEN by release-coordinator policy, two Lows STILL-OPEN by threat model.

The spec is clear from a security standpoint to advance.

## Handoff
next_agent: NONE
prompt: Security re-audit complete. 0 Critical, 0 High, 2 Medium (both STILL-OPEN by release-coordinator scope decision — `deleteIngredientConversion` brand check and realtime cross-brand chatter, both bounded to multi-brand-future), 2 Low STILL-OPEN by threat model. All prior actionable findings RESOLVED. New RLS migration `20260507015244_spec004_ingredient_categories_rls_p6.sql` is well-formed, complete (SELECT/INSERT/UPDATE/DELETE all gated), references `auth_is_admin()` helper, idempotent, injection-safe, no new secrets. Live probe against `supabase_db_imr-inventory`: non-admin INSERT rejected, non-admin UPDATE/DELETE return 0 rows, admin INSERT succeeds. Fix-pass introduces no new attack surface (regex has no ReDoS, validators module has no I/O, categories-delete TOCTOU is identical to pre-fix and bounded by admin-only access).
payload_paths:
  - specs/004-ingredient-form-lookups/reviews/security-auditor.md
