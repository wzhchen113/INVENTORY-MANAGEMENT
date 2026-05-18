# Backend-architect — post-implementation drift review (RE-REVIEW after SF1-SF5)

Spec: 049 (Cross-brand catalog copy/paste)
Status on entry: READY_FOR_REVIEW (post-fixes)
Reviewer mode: post-impl drift, second pass (read-only; do not mutate `Status:`)

## Context for the re-review

The prior post-impl review (preserved below in spirit) found 0 Critical,
0 Should-fix, 3 Minor — all editorial / positive direction. The
`release-coordinator` proposal then merged five Should-fix items from
other reviewers into a FIXES_NEEDED list:

- **SF1** — Add an admin-profile rejection arm to
  `cross_brand_copy.test.sql` (plan 13 → 14). The original arm (1)
  labeled "admin rejected" used a fixture with `profiles.role='master'`,
  so the AC "admin AND master callers MUST be rejected" only had
  master-side evidence.
- **SF2** — Add negative-gate jest tests on `InventoryCatalogMode` and
  `VendorsSection` so AC-N1 / AC-F3 has automated coverage instead of a
  browser-only reviewer checklist.
- **SF3** — Remove dead `v_source_count` variable + the two unused
  `SELECT count(*) INTO v_source_count` scans from the migration.
- **SF4** — Tighten the audit-row count assertion from `>= 3` to `= 4`
  (so a vendors-audit-row regression or stray INSERT would fail the
  arm).
- **SF5** — Remove the dead i18n key `dialog.copyToBrand.selectAllAria`
  from `en/es/zh-CN`.

This re-review confirms each of the five fixes landed without
introducing drift on any of the architect's design contracts (§A–§N).

## Verdict (post-fixes)

**Zero Critical. Zero Should-fix. Zero new Minor. No drift introduced
by the five fixes.** The original three Minor findings remain
non-blocking and are unchanged by these fixes (audit `names` captures
copied rather than attempted, TS interface shortened to
`CopyCatalogResult`, pgTAP plan grew positive direction). Recommend
ship.

## Per-fix verification

### SF1 — admin-profile rejection arm (plan 13 → 14)

PASS. `supabase/tests/cross_brand_copy.test.sql:29` declares
`select plan(14);`. The file structure now lays out:

- **(1a) profiles.role='master'**, JWT `app_metadata.role='admin'`
  (id=33...). Lines 100-130. Rejected with `'super_admin only'`.
- **(1b) profiles.role='admin'**, JWT `app_metadata.role='admin'`
  (id=22..., promoted in fixtures). Lines 132-162. Rejected with
  `'super_admin only'`.
- **(2) profiles.role='master'**, JWT `app_metadata.role='master'`
  (id=33...). Lines 164-193. Rejected with `'super_admin only'`.

The new arm (1b) closes the AC-B4/AC-N2 gap directly. The fixtures
block at lines 52-54 mutates id=22 from seed `role='user'` to
`role='admin'` via plain `UPDATE`. Critically:

- The seed at `supabase/seed.sql:118-120` already sets id=22's
  `brand_id` to the 2AM PROJECT brand (`2a000000-...-001`), so the
  `profiles_role_brand_consistent` CHECK (added in 012a) — which
  requires `role='admin'` rows to have `brand_id NOT NULL` — is
  satisfied without further mutation. The architect verified this
  CHECK at `20260509000000_multi_brand_schema_rls.sql:138-144`.
- The mutation is inside the transaction-scoped pgTAP harness and
  rolls back at line 459 (`rollback;`).
- `auth_is_super_admin()` reads `public.profiles.role` (verified at
  `20260509000000_multi_brand_schema_rls.sql:187-195`) — NOT
  `app_metadata.role` from the JWT — so the gate fires off the table
  state, exactly as the design at §A item 3 intended.

The relabeling of all three rejection arms (1a, 1b, 2) now names the
**exact `profiles.role` being tested** rather than relying on the
JWT-claim wording. Pair-test (1a) and (2) jointly demonstrate that the
gate ignores the JWT `app_metadata.role` claim — which is itself a
useful piece of evidence that the gate is defense-in-depth-correct.

No drift from §A item 3 gate ordering or §M test plan intent. The
expansion from "designed 9 arms" to "implemented 14 arms" remains the
positive-direction Minor 3 from the prior review.

### SF2 — UI negative-gate jest coverage

PASS. Two new files:

- `src/screens/cmd/sections/__tests__/InventoryCatalogMode.test.tsx`
  (329 lines).
- `src/screens/cmd/sections/__tests__/VendorsSection.test.tsx`
  (228 lines).

Both files mock `useIsSuperAdmin` directly via
`jest.mock('../../../../hooks/useRole', ...)` so the gate can be
flipped per-test. Each file has 4 arms:

1. `useIsSuperAdmin=false` → per-row checkbox + per-row "COPY" pill
   absent (assertion against accessibility labels +
   `screen.queryByText('COPY') === null`).
2. `useIsSuperAdmin=false` → top-bar bulk pill absent.
3. `useIsSuperAdmin=true` → per-row checkbox + per-row "COPY" pill
   render (positive control — distinguishes "gate works" from "tests
   pass for the wrong reason").
4. `useIsSuperAdmin=true` + checkbox press → top-bar bulk pill
   renders.

**No drift on the gate contract from §J — Frontend — Cmd UI
affordances.** The architect's design specified
`if (!isSuperAdmin) return null;` for the affordance subtree. The
tests prove that contract by direct assertion. The heavy-child stub
strategy (IngredientFormDrawer, ExportCsvDrawer, CopyToBrandDialog,
TabStrip, StatCard, IngredientForm, etc., all stubbed to `() => null`)
is the same boundary-mocking pattern used in
`RecipeCategoriesSection.test.tsx` and `CopyToBrandDialog.test.tsx`
already in the repo. No new architectural pattern introduced.

**One observation — not a drift.** The tests target accessibility
labels that match the i18n key paths (e.g.,
`'dialog.copyToBrand.selectRowAria'`) under the mocked `useT` that
returns the key unchanged. This is a key-echoing convention, not a
literal string assertion, so a future i18n catalog rename would not
break these tests as long as the key path stays stable. Same shape as
the existing `useT` mocks elsewhere in `__tests__/`. The convention is
durable.

### SF3 — Removed dead `v_source_count`

PASS. Confirmed via `Grep v_source_count` against
`supabase/migrations/20260518000000_spec049_cross_brand_copy.sql` →
zero matches. The declaration is gone and both former `SELECT count(*)
... INTO v_source_count` scans (one in the catalog_ingredients branch,
one in the vendors branch) are gone.

Net effect: two extra full-set table scans per RPC call eliminated for
zero behavior change. The `copied` / `skipped` accounting in the
implementation still uses `v_copied`, `v_skipped`, `v_copied_names`,
`v_skipped_names` (lines 127-130) — none of those were `v_source_count`.

The remaining variable declarations at lines 126-130 are the minimal
working set. The function body still proceeds: gate → empty-selection
short-circuit → dispatch → audit → return. Migration line count
dropped accordingly; no semantic change.

No drift on §B item 2 (Body sketch) or §C (Audit shape).

### SF4 — Audit-row count assertion tightened `>= 3` → `= 4`

PASS. `supabase/tests/cross_brand_copy.test.sql:404-414`:

```sql
select cmp_ok(
  (select count(*)::int from public.audit_log
    where action = 'catalog_copy'
      and detail = 'cafe1049-0000-0000-0000-000000000001'),
  '=',
  4,
  '(9a) exactly 4 audit_log rows in target with action=catalog_copy
   (arms 4/5/6a/6b each wrote one)'
);
```

The architect verified the arithmetic against the function's audit
gate at migration line 279 (`if v_copied > 0 or v_skipped > 0 then
insert into audit_log ...`):

| Arm | Inputs                            | v_copied | v_skipped | Audit row? |
|-----|-----------------------------------|----------|-----------|------------|
| 4   | super_admin, 2 ingredients        | 2        | 0         | yes        |
| 5   | super_admin, 2 vendors            | 2        | 0         | yes        |
| 6a  | super_admin, ing_id_1 + ing_id_new| 1        | 1         | yes        |
| 6b  | super_admin, ing_id_1 + ing_id_new (re-run) | 0  | 2 | yes        |

Total: 4 audit rows in target brand. The earlier rejected arms (1a,
1b, 2, 7, 8) raise before the audit insert. The empty-selection
short-circuit (line 151-153) is not exercised in this test (no arm
passes an empty array). The COUNT predicate filters on `action AND
detail`, NOT `item_ref`, so it picks up the vendors row from arm 5 too
— `= 4` is the exact correct count.

The `(9b)` arm immediately below still uses `item_ref =
'catalog_ingredients'` to pick exactly one of the four for shape
assertion. No drift on §C (audit_log shape) or §M item 8.

The header comment at line 393 (`-- ─── (9a) exactly FOUR audit rows
...`) now matches the assertion, closing the code-reviewer SF3 about
"exactly ONE audit row" prose / `>=` numeric mismatch from the prior
release-proposal item 4.

### SF5 — Removed dead i18n key `selectAllAria`

PASS. `Grep selectAllAria` against the entire repo returns matches
only inside the `specs/049-*/` review/proposal files (discussing the
removal) — zero matches in `src/i18n/{en,es,zh-CN}.json`, zero matches
in any component or screen file. The key is gone from all three
catalogs.

The i18n catalog-parity arm in `src/i18n/i18n.test.ts` continues to
pass because the removal was uniform across the three catalogs.
Reviewer-noted dev-only artifact, no functional UI change.

No drift on §J — affordance gating (the multi-select checkbox in
`CopyToBrandDialog` uses the column-header-less leftmost-checkbox-per-row
shape; there is no column-header select-all checkbox in the design).

## Cross-cutting checks (still PASS after fixes)

1. **RPC signature** unchanged — `(uuid, uuid, text, uuid[]) returns
   public.copy_catalog_result`. Migration line 116-121.
2. **Composite type** unchanged — `(copied int, skipped int,
   skipped_names text[])`. Migration line 82-87.
3. **`SECURITY DEFINER` + `search_path = public, auth`** unchanged.
   Migration line 122-124.
4. **Gate ordering**: super_admin → see source → see target → source
   != target → table whitelist. Migration line 133-147. First
   executable statement is `auth_is_super_admin()`. No change.
5. **`ON CONFLICT (brand_id, lower(name)) DO NOTHING`** on both
   branches: migration line 178 (catalog_ingredients) and 237
   (vendors). Unchanged.
6. **`skipped_names` bounded to 20** via `LIMIT 20` inside the
   `skipped_q` subquery: lines 200 + 258. Unchanged.
7. **Audit row mapping** (store_id NULL / user_id auth.uid() / action
   'catalog_copy' / item_ref p_table / detail target_brand_id::text /
   value json_build_object(...)::text): lines 280-296. Unchanged.
8. **GRANT/REVOKE shape**: `revoke from public, anon; grant to
   authenticated;` at migration lines 308-309. Unchanged.
9. **TS wrapper `copyCatalogRows`** at `src/lib/db.ts:2553-2598`.
   Signature, return shape, snake→camel mapping unchanged.
10. **No new `supabase.rpc()` call sites** outside `src/lib/db.ts`.
    Verified across the new test files and the unchanged
    `CopyToBrandDialog.tsx` import surface.
11. **Realtime publication unchanged**. Migration header lines 28-34
    explicitly declare "REALTIME: this migration does NOT touch the
    supabase_realtime publication." No `docker restart
    supabase_realtime_imr-inventory` needed.

## Minor findings carried forward (unchanged from prior review)

These were not introduced or modified by SF1-SF5; included for
completeness so the release-coordinator has a single source of truth.

### Minor 1 — `audit_log.value` JSON `names` field captures the COPIED set, not the SOURCE-IDS set

Implementation writes `v_copied_names` (the names returned by `INSERT
… RETURNING`) into the audit payload, not `v_source_names`. Arguably
more useful — audit readers care what landed, not what was attempted.
Severity: Minor. Recommendation: leave as-is.

### Minor 2 — TS interface renamed from `CopyCatalogRowsResult` to `CopyCatalogResult`

Implementation chose the shorter name. No external caller depends on
either. Severity: cosmetic. Recommendation: leave as-is.

### Minor 3 — pgTAP plan size grew from designed 9 → implemented 14

Original review noted 13; SF1 took it to 14. The expansion is positive
coverage growth (anon-EXECUTE arm, skip-on-conflict split into 6a/6b,
audit shape split into 9a/9b/9c/9d, role-rejection split into 1a/1b/2).
The harness contract doesn't care about plan number as long as it
matches `finish()`. Severity: positive direction. Recommendation:
leave as-is.

## Open question carried forward from design §L (unchanged)

`P0001` vs `42501` SQLSTATE convention for role-rejection. Implementer
chose explicit `using errcode = 'P0001'` matching the existing
`copy_brand_catalog` precedent. Architect-recommended: stay with
`P0001` until a generic errcode-mapping layer lands. Not a Spec 049
ship blocker.

## Closing

All five fixes are mechanically clean. None introduce architectural
drift, none broaden the function surface, none reach outside the
contract the original design defined. The audit-count tightening (SF4)
is actually a stronger safety net than the original `>= 3` shape — a
future stray INSERT or a vendors-branch regression that silently fails
to write the audit row would now fail the test.

The two new section test files (SF2) follow the same boundary-mocking
pattern as `RecipeCategoriesSection.test.tsx` and don't introduce a
new test idiom. The dead-variable removal (SF3) is a strict
performance improvement. The plan/header alignment (SF4) and i18n key
cleanup (SF5) are dead-code removals. SF1 is the one that closes a
real AC gap (admin-profile rejection arm), and the fixture mutation
strategy honors `profiles_role_brand_consistent`.

No architectural drift detected — second pass confirms the original
"ready for release-coordinator" verdict.

## Handoff

next_agent: NONE
prompt: Architectural drift re-review complete after SF1-SF5. 0 Critical,
  0 Should-fix, 0 new Minor (three carry-forward Minor items unchanged
  from the prior pass, all positive direction). All five fixes landed
  cleanly. Recommend ship.
payload_paths:
  - specs/049-cross-brand-catalog-copy/reviews/backend-architect.md
