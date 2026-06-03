# Security audit for spec 093

**Verdict: PASS — no Critical, no Should-fix, no Nits with security impact.**

Spec 093 is a data-correctness fix (case-size column swap). The new artifact is a
back-office audit/backout table plus a static, RLS-bypassing data backfill, a
cost-calc divisor change, and a form re-bind/relabel. Every item in the focus
list checks out. Nothing here BLOCKS.

Scope reviewed:
- `supabase/migrations/20260602120000_spec093_case_qty_backfill.sql`
- `supabase/tests/spec093_case_qty_backfill.test.sql`
- `scripts/smoke-migrate-spec093.sh`
- `src/utils/unitConversion.ts` (`calcUnitCost` / `calcCasePrice`)
- `src/lib/db.ts` (mapItem fallback cost ~3710; catalog write path 264-303)
- `src/components/cmd/IngredientForm.tsx` (re-bind/relabel/readback)
- `src/components/cmd/IngredientForm.spec093.test.tsx`
- cross-checked: `supabase/migrations/20260514140000_realtime_publication_tighten.sql`,
  `supabase/tests/permissive_policy_lint.test.sql`

---

## Critical (BLOCKS merge)

None.

## Should-fix (before deploy)

None.

## Nits

None with security impact.

---

## Focus-item findings (all clear)

### 1. New audit table `public.spec093_case_qty_backfill_audit` — CLEAR

- **RLS enabled, deny-all to app roles.** `enable row level security` at
  `supabase/migrations/20260602120000_spec093_case_qty_backfill.sql:67` and
  `revoke all on public.spec093_case_qty_backfill_audit from anon, authenticated`
  at `:68`. The revoke is correctly ordered AFTER `create table` (`:54`), so it
  strips any grant that Supabase's platform `ALTER DEFAULT PRIVILEGES ... GRANT
  ... TO anon, authenticated` bootstrap would have attached at table-creation
  time. RLS-enabled + zero policy + revoked grants = deny-all to `anon`/
  `authenticated`. A back-office artifact that is unreachable over PostgREST.
  Matches the spec 075 `audit_log` precedent and the §2 design intent.
- **NOT in any realtime publication.** The migration contains no `ALTER
  PUBLICATION` (confirmed by grep). More importantly, the live publication is an
  explicit 10-table list as of
  `supabase/migrations/20260514140000_realtime_publication_tighten.sql:43-53`
  (which superseded the original `create publication ... for all tables` in
  `20260502190000_realtime_publication.sql:14`). The audit table is not in that
  list, and post-tighten membership is opt-in. So even though an earlier
  `FOR ALL TABLES` existed in repo history, the current state does NOT auto-capture
  this table. No realtime exposure; no `docker restart supabase_realtime`
  ritual needed (no publication change). The spec's "not in any publication"
  claim holds.
- **No cross-tenant data exposure.** The table stores `brand_id` (plus
  catalog_id/name/old+new qty), which would be brand-scoped PII-adjacent data —
  but because it is deny-all to `anon`/`authenticated` and not on realtime,
  there is no PostgREST or WebSocket path by which a customer-PWA or staff-app
  caller could read another tenant's rows. Only the migration role / direct psql
  reaches it, which is the intended back-office posture.
- **No spec 053 permissive-policy-lint regression.** The lint
  (`supabase/tests/permissive_policy_lint.test.sql`) only flags *permissive
  policies* with trivially-wide USING/WITH CHECK. This table has **no policy at
  all**, so it cannot trip the lint. The developer correctly did NOT add a wide
  "to be safe" policy (the exact reflex §2 warned against). pgTAP reports the
  lint stays 4/4.
- **No spec 065 anon-grant regression.** The explicit `revoke all ... from anon,
  authenticated` is the spec 065 posture made explicit. Verified by both the
  Track-3 smoke (`scripts/smoke-migrate-spec093.sh:104-109`, asserts 0
  anon/authenticated grants) and the pgTAP harness
  (`supabase/tests/spec093_case_qty_backfill.test.sql:90-91`).

### 2. The backfill UPDATE — CLEAR

- **RLS-bypassing migration role.** Runs inside `begin; ... commit;`
  (`:45`/`:126`) as the `db push` migration role, which is RLS-exempt. Policies
  are irrelevant to the UPDATE — correct and intended (§2).
- **Only mutates Population B.** The UPDATE at `:119-124` is gated by the
  numeric-safe predicate `coalesce(case_qty,1) <= 1 AND coalesce(sub_unit_size,1)
  > 1`. Population C (`:98-99`) is snapshotted only, never mutated — verified by
  pgTAP assertion (2) at `spec093_case_qty_backfill.test.sql:212-218`.
  Self-extinguishing / idempotent (post-UPDATE rows no longer match), with
  `on conflict (catalog_id) do nothing` on the audit inserts.
- **No injection surface.** The migration is 100% static SQL. No `EXECUTE`, no
  `format()`, no string concatenation of any value — let alone user input. The
  predicates and column lists are literal. There is no dynamic-SQL SQLi vector.

### 3. Form + cost-calc changes — CLEAR

- **No new input-validation gap.** The case-size and sub-unit inputs at
  `IngredientForm.tsx:718` / `:724` carry `numericOnly`, which is a real filter:
  `InputLine` rejects non-numeric input at the `onChangeText` boundary
  (`IngredientForm.tsx:192`, `if (numericOnly && next !== '' &&
  !isNumericInput(next)) return;`) via `isNumericInput` (`src/utils/validators.ts:25`).
  The destination columns `case_qty` / `sub_unit_size` are `numeric`-typed, so
  PostgREST coerces server-side as well. The readback (`:790-810`) only renders a
  template string from already-numeric `Number(values.caseQty)` and never
  interpolates into HTML/SQL — it is a React `<Text>` node, auto-escaped. No XSS,
  no injection.
- **Catalog write path unchanged.** `src/lib/db.ts:278-280` (the `caseQty →
  case_qty`, `subUnitSize → sub_unit_size` mapping) and the surrounding
  `updateInventoryItem` catalog UPDATE (`:286-302`) are byte-for-byte unchanged.
  No auth/RLS change to who may write the catalog — the existing catalog-write
  RLS still governs. Confirms the spec §0/§5 claim.
- **Cost-calc change is arithmetic-only, no security surface.** `calcUnitCost`
  (`unitConversion.ts:290-298`) now divides by `caseQty` alone; the `mapItem`
  fallback (`db.ts:3710-3720`) matches. Both operate on already-parsed floats,
  return numbers, touch no auth/secret/IO. `void subUnitSize` retains the 3-arg
  signature. (R2 default_cost-not-recomputed and R4 calcCasePrice-asymmetric are
  owner-confirmed out of scope and not flagged, per instruction.)
- **No secret exposure.** No `Deno.env`, no `process.env`, no service-role key,
  no token, no API key touched anywhere in the diff. The `RAISE NOTICE`
  (`migration:111`) emits only an integer count of flagged rows — no row data, no
  PII — into the operator's `db push` output. No PII/secret in any log or error
  path.

### 4. Dependencies

No change to `package.json` or any lockfile (working tree confirmed clean for
`package.json` / `package-lock.json` / `yarn.lock`). Per the spec's
"NEW high/critical only; pre-existing advisories out of scope" instruction,
there are **zero dependency findings attributable to spec 093**.

For completeness, `npm audit --audit-level=high` reports 18 pre-existing
transitive advisories (17 moderate, 1 high) in the Expo/jest toolchain
(`expo-notifications` → `expo-constants`, `@expo/config`, `ws` GHSA-58qx-3vcg-4xpx).
None are introduced or touched by this spec — out of scope.

---

## Note for the release-coordinator

Clean audit. No Critical, no Should-fix. The one thing that *looked* like a
finding on first pass — a back-office table created under a historically
`FOR ALL TABLES` realtime publication — is fully neutralized by the spec
20260514140000 publication-tightening migration (explicit 10-table allowlist,
opt-in thereafter) plus the table's deny-all RLS posture. Both the pgTAP test
and the Track-3 smoke independently assert the back-office posture (RLS on, 0
anon/authenticated grants, 0 mis-encoded rows). The migration is prod-touching
and owner-run via explicit `supabase db push`; the `db-migrations-applied.yml`
drift gate (CLAUDE.md §CI workflow) will require that push so prod's
`schema_migrations` gains the entry — a process item, not a security defect.
