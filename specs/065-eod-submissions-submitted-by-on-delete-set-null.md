# Spec 065: eod_submissions.submitted_by ON DELETE SET NULL

Status: READY_FOR_REVIEW

Owner: backend

## Problem statement

`public.eod_submissions.submitted_by` is declared as `uuid references profiles(id)` in [supabase/migrations/20260405000759_init_schema.sql:123](../supabase/migrations/20260405000759_init_schema.sql) with no `ON DELETE` clause, so Postgres defaults to `NO ACTION`. Any attempt to delete a `profiles` row that has dependent `eod_submissions` rows raises a foreign-key violation.

This is asymmetric with the later, sibling audit-trail table `public.inventory_counts.submitted_by` ([supabase/migrations/20260513000000_inventory_counts.sql:76](../supabase/migrations/20260513000000_inventory_counts.sql)) which declares the same column as `uuid null references public.profiles(id) on delete set null` — that table correctly preserves the historical row while nulling out the deleted profile reference.

The asymmetry surfaced in pgTAP:

- `supabase/tests/auth_can_see_store_brand_scope.test.sql` (introduced for the brand-scope visibility check in spec 042) fails on baseline with an FK violation when its teardown does `delete from profiles where id = manager_id`.
- The same fail was flagged as a Should-fix in the spec 061 test-engineer review and as a Nit in the spec 064 test-engineer review (pre-existing across both reviews).

The test itself is correct — it is exercising real brand-scope RLS behavior, and the only thing blocking it from passing is the schema's restrictive FK. `inventory_counts` already handles the same scenario correctly; `eod_submissions` should match.

## User story

As a brand admin, I want to delete an inactive staff profile without first manually clearing that staff member's EOD submission history, so that historical EOD records are preserved (with a null `submitted_by` indicating the original submitter has been removed) and profile deletion is not blocked on audit-trail cleanup.

## Acceptance criteria

- [ ] AC1: A new migration file lands in `supabase/migrations/` that drops the existing `eod_submissions_submitted_by_fkey` constraint and re-creates it with `ON DELETE SET NULL` semantics. The migration applies cleanly with no errors.
- [ ] AC2: `bash scripts/test-db.sh` runs the suite green AND `auth_can_see_store_brand_scope.test.sql` passes for the first time (no FK violation during teardown).
- [ ] AC3: No other pgTAP test regresses — every previously-passing suite in the 33-suite track still passes.
- [ ] AC4: Migration applies cleanly to LOCAL Supabase via `npx supabase db reset` (no out-of-order migration warnings, no error from the constraint rename / FK rebind).
- [ ] AC5: Migration applies cleanly to PROD Supabase via `npx supabase db push`. Main Claude runs this AFTER local CI + reviews pass; the spec does not authorize an automated production push.
- [ ] AC6: The new `db-migrations-applied.yml` CI gate from spec 064 catches any future similar drift between migration files on disk and the applied schema.
- [ ] AC7: Deleting a `profiles` row that has dependent `eod_submissions` rows succeeds, and the corresponding `eod_submissions.submitted_by` values are set to NULL (verified by a dedicated assertion in the pgTAP suite OR by manual psql check during review).

## In scope

- Drop the existing FK constraint `eod_submissions_submitted_by_fkey`.
- Re-add the FK with `ON DELETE SET NULL`.
- Confirm column nullability matches (existing column is already nullable since the init-schema declaration has no `not null`).
- Verify the `eod_submissions_set_submitted_by` trigger from spec 020 still functions correctly after the FK swap (the trigger sets `submitted_by := auth.uid()` on insert/update — orthogonal to FK cascade semantics).

## Out of scope (explicitly)

- Similar audit-trail FK cleanups on other tables (`audit_log.user_id`, `staff_waste_log`, etc.). Rationale: out-of-scope scope creep. A future audit-sweep spec can survey the schema for restrictive `submitted_by` / `user_id` FKs and address them as a batch.
- Changes to the test file `auth_can_see_store_brand_scope.test.sql`. The test is correct; the schema needs to match it, not the other way around.
- Application-code changes. The `staff_submit_eod` RPC body already handles a null `submitted_by` per spec 061's `auth.uid()`-derived audit attribution.
- Changes to RLS policies on `eod_submissions`. None of the policies reference `submitted_by` directly in a way that breaks under nulling.
- `ON UPDATE` cascade behavior. Profile UUIDs do not change; pinning `ON UPDATE` to default `NO ACTION` is correct.

## Open questions for architect

1. **Migration timestamp.** Confirm the next timestamp follows the project's convention (`YYYYMMDDHHMMSS_`). Today's date is 2026-05-27; the next available timestamp is likely `20260527<HHMMSS>_eod_submissions_submitted_by_on_delete_set_null.sql`.
2. **`ON DELETE SET NULL` vs. alternatives.** Confirm that `SET NULL` is the right semantic (rather than `SET DEFAULT`, `CASCADE`, or keeping `NO ACTION` and changing the test instead). The architect should explicitly weigh whether nulling the audit reference is preferable to cascading the EOD rows themselves — design rationale: historical EOD records are independently meaningful even after the submitter profile is gone; cascading would erase legitimate sales/inventory history.
3. **Schema sweep.** Survey the rest of the schema for other `*_by` / `user_id` columns referencing `profiles(id)` with restrictive FK semantics that would block profile deletion. If any exist beyond `inventory_counts.submitted_by` (which is already correct) and `eod_submissions.submitted_by` (this spec), name them in the design doc and decide whether they belong in this spec's migration or in a follow-up spec. Default is follow-up unless a strong reason to batch.
4. **Trigger interaction.** Confirm the `eod_submissions_set_submitted_by` trigger from spec 020 (sets `submitted_by := auth.uid()` on insert/update) does not interact poorly with the new FK behavior. Expected answer: trigger fires on insert/update, FK cascade fires on referenced-row delete — orthogonal lifecycle events, no interaction.

## Dependencies

- A single new migration file in `supabase/migrations/`.
- No edge function changes.
- No application code changes.
- No RLS policy changes.
- No frontend changes.

## Project-specific notes

- **Cmd UI section / legacy:** None — backend-only schema fix.
- **Per-store or admin-global:** N/A — schema migration affects the table globally.
- **Realtime channels touched:** None.
- **Migrations needed:** Yes — one new migration.
- **Edge functions touched:** None.
- **Web/native scope:** N/A — DB-only.
- **Tests:** pgTAP track. The change is validated by the `auth_can_see_store_brand_scope.test.sql` suite finally passing; consider adding a dedicated assertion that confirms the new FK behavior (delete a profile, verify the dependent eod_submissions row's `submitted_by` is NULL).

## Backend design

### Summary

Single-table FK swap. Drop the implicit `eod_submissions_submitted_by_fkey` constraint and re-add it with `ON DELETE SET NULL`. No application code, no RLS, no edge functions, no realtime publication membership change.

### Data model changes

**Migration file:** `supabase/migrations/20260527000000_eod_submissions_submitted_by_on_delete_set_null.sql`

Timestamp `20260527000000_` is correct:
- Strictly greater than the current head (`20260525000000_staff_submit_eod_per_user_jwt.sql`, spec 061).
- Matches the convention of midnight-anchored stamps for single-concern migrations (`20260513000000`, `20260514130000`, `20260517020000`, `20260520000000`, `20260524000000`, `20260525000000`).
- Today is 2026-05-27. No reason to pick a non-midnight stamp.

**Constraint name verification.** The constraint name is `eod_submissions_submitted_by_fkey`:
- Init schema ([supabase/migrations/20260405000759_init_schema.sql:123](../supabase/migrations/20260405000759_init_schema.sql)) declares the column as `submitted_by uuid references profiles(id)` — no explicit `constraint <name>` clause.
- Postgres auto-names FKs as `<table>_<column>_fkey` ([Postgres docs](https://www.postgresql.org/docs/current/sql-createtable.html) — implicit constraint naming).
- I grepped the full migration history for `prep_recipes_created_by_fkey` and `eod_submissions_submitted_by` to confirm no rename ever happened. The remote_schema snapshot ([supabase/migrations/20260502071736_remote_schema.sql:43](../supabase/migrations/20260502071736_remote_schema.sql)) drops `prep_recipes_created_by_fkey` (and never re-adds it), but contains no rename or re-shape of `eod_submissions_submitted_by_fkey`. Spec 020's vendor_id work ([supabase/migrations/20260514120000_eod_submissions_vendor_id.sql](../supabase/migrations/20260514120000_eod_submissions_vendor_id.sql)) touches the same table but only adds `vendor_id` — does not touch `submitted_by`.

**Migration body** (pseudo-SQL — developer writes the final file):

```sql
-- Spec 065 — Allow profile deletion when eod_submissions rows reference it.
--
-- The init schema declared `submitted_by uuid references profiles(id)` with
-- no ON DELETE clause, defaulting to NO ACTION. That blocks profile deletion
-- whenever a dependent eod_submissions row exists, surfacing in
-- supabase/tests/auth_can_see_store_brand_scope.test.sql arm (12).
--
-- The sibling audit-trail table `inventory_counts.submitted_by`
-- (20260513000000_inventory_counts.sql:76) already has ON DELETE SET NULL.
-- This migration brings eod_submissions in line.
--
-- The eod_submissions_set_submitted_by trigger (spec 020,
-- 20260514120030_eod_submissions_consistency.sql:78-94) fires BEFORE
-- INSERT/UPDATE only. FK cascade on profile DELETE is orthogonal — the
-- trigger is not invoked. No trigger changes required.

begin;

alter table public.eod_submissions
  drop constraint if exists eod_submissions_submitted_by_fkey;

alter table public.eod_submissions
  add constraint eod_submissions_submitted_by_fkey
  foreign key (submitted_by)
  references public.profiles(id)
  on delete set null;

commit;
```

**Defensive considerations decided:**
- `if exists` on the drop. The implicit auto-named constraint should always exist on a freshly-reset DB, but `if exists` makes the migration idempotent for hand-applied workflows. Costs nothing.
- `begin/commit`. Two statements in one logical unit — wrapping in an explicit transaction means a failure at the second statement rolls back the drop, leaving the FK in its old state. Without the explicit txn, Postgres still runs each statement in its own implicit txn (single-statement autocommit), so a failure at the `add` would leave the table without any FK on `submitted_by`. Belt-and-braces. Spec 020's [20260514120000_eod_submissions_vendor_id.sql:18,130](../supabase/migrations/20260514120000_eod_submissions_vendor_id.sql) uses the same shape.
- No data migration. Existing rows already comply; the FK swap only changes future delete behavior. No `update`/`delete` needed.

**Migration is additive, not destructive** in the conventional sense — it changes a constraint shape but the column data is untouched. Rollback would be to swap back to `no action`, which would resurrect the test fail; no production data risk in either direction.

### Schema sweep — other `*_by` / `user_id` columns referencing `profiles(id)`

I audited every FK-shaped reference to `profiles(id)` in the migration history. The full table:

| Table | Column | ON DELETE | Source |
|---|---|---|---|
| `user_stores` | `user_id` | `cascade` | [init_schema.sql:32](../supabase/migrations/20260405000759_init_schema.sql) |
| `inventory_items` | `last_updated_by` | `no action` (default) | [init_schema.sql:64](../supabase/migrations/20260405000759_init_schema.sql) |
| `prep_recipes` | `created_by` | **NO FK in prod** — dropped by [remote_schema.sql:43](../supabase/migrations/20260502071736_remote_schema.sql) and never re-added | init_schema declared it; remote_schema dropped it |
| `eod_submissions` | `submitted_by` | `no action` (default) — **this spec** | [init_schema.sql:123](../supabase/migrations/20260405000759_init_schema.sql) |
| `waste_log` | `logged_by` | `no action` (default) | [init_schema.sql:146](../supabase/migrations/20260405000759_init_schema.sql) |
| `purchase_orders` | `created_by` | `no action` (default) | [init_schema.sql:157](../supabase/migrations/20260405000759_init_schema.sql) |
| `purchase_orders` | `received_by` | `no action` (default) | [init_schema.sql:162](../supabase/migrations/20260405000759_init_schema.sql) |
| `pos_imports` | `imported_by` | `no action` (default) | [init_schema.sql:180](../supabase/migrations/20260405000759_init_schema.sql) |
| `audit_log` | `user_id` | `no action` (default) | [init_schema.sql:199](../supabase/migrations/20260405000759_init_schema.sql) |
| `flags` | `user_id` | `no action` (default) | [20260502190001_flags_table.sql:15](../supabase/migrations/20260502190001_flags_table.sql) |
| `flags` | `resolved_by` | `no action` (default) | [20260502190001_flags_table.sql:20](../supabase/migrations/20260502190001_flags_table.sql) |
| `report_definitions` | `created_by` | `no action` (default) | [20260503000001_report_definitions.sql:13](../supabase/migrations/20260503000001_report_definitions.sql) |
| `inventory_counts` | `submitted_by` | **`set null`** (correct) | [20260513000000_inventory_counts.sql:76](../supabase/migrations/20260513000000_inventory_counts.sql) |
| `report_runs` | `ran_by` | `no action` (default) | [20260510120000_report_runs.sql:89](../supabase/migrations/20260510120000_report_runs.sql) |
| `eod_entries` | (no FK to profiles) | — | scopes through `submission_id`; no actor column |
| `audit_log.user_id` is `uuid references profiles(id)` ([init_schema.sql:199](../supabase/migrations/20260405000759_init_schema.sql)) with no ON DELETE | | | — |
| `in_app_notifications.user_id` | (no FK, soft reference only) | — | [20260423232117_in_app_notifications.sql:9](../supabase/migrations/20260423232117_in_app_notifications.sql) declares `user_id uuid NOT NULL` with no `references` clause |

**Recommendation: scope strictly to `eod_submissions.submitted_by` in this spec.** Confirming the user's read. Reasons:

1. The spec's stated user intent is "fix the broken test" — `auth_can_see_store_brand_scope.test.sql` arm (12) tears down only by deleting `manager_id`. The only seeded data that would cascade-block that delete is `eod_submissions`. Fixing `eod_submissions.submitted_by` is the minimum sufficient change to unblock the test.
2. The other 11 audit-trail-shaped columns ARE missing `set null` and probably should match the `inventory_counts.submitted_by` posture eventually — but each one is its own design call (e.g. `purchase_orders.created_by` arguably deserves a different posture than `audit_log.user_id`). Bundling them here would balloon the spec and require a per-column posture decision the spec didn't authorize.
3. The spec §"Out of scope" already disclaims similar cleanups and explicitly defers to a future audit-sweep spec. The architect's role here is to confirm the user's narrow framing, not invent scope.

**Follow-up surfacing.** I am flagging the 11-column audit-trail FK drift as a candidate for a future spec ("schema sweep: actor FK cascade posture audit"). Not blocking. The drift surfaces in any prod profile-delete flow that touches an actor with EOD/waste/PO/audit history, but the existing prod `delete-user` edge function ([supabase/functions/delete-user/index.ts](../supabase/functions/delete-user/index.ts)) gates on `auth_is_admin()` + last-of-role + self-guard — it does not currently bulk-delete profiles, so the production blast radius is small. A pgTAP probe that walks `pg_constraint` and asserts `confdeltype = 'n'` on every `profiles(id)`-referencing FK matching `submitted_by|logged_by|created_by|received_by|imported_by|user_id|ran_by|resolved_by` would catch future regressions; that's the right shape for the follow-up spec, but out of scope here.

### Trigger interaction

The `eod_submissions_set_submitted_by_trg` trigger ([20260514120030_eod_submissions_consistency.sql:78-94](../supabase/migrations/20260514120030_eod_submissions_consistency.sql)) is BEFORE INSERT OR UPDATE on `eod_submissions`. It rewrites `new.submitted_by := auth.uid()` unconditionally.

**Orthogonality confirmed.** The FK cascade fires when a row in `public.profiles` is DELETEd — the cascade engine then runs an UPDATE on `eod_submissions` setting `submitted_by` to NULL on every dependent row. But this UPDATE is issued by the FK machinery, not by an application caller, and Postgres's referential-action UPDATE does NOT fire BEFORE UPDATE row triggers for the affected column (it's a system-level cascade, not a user-visible UPDATE statement). Even if it did, the trigger would just re-write the new value of `submitted_by` from `auth.uid()` — which is NULL under any non-impersonated session AND under the postgres role doing the cascade — so the effective result would still be `submitted_by = NULL`.

**Developer note:** do NOT touch the trigger. It's load-bearing for spec 020's submitted_by-forgery defense. The FK swap is fully orthogonal.

### RLS impact

**None.** No RLS policies reference `submitted_by` in their USING or WITH CHECK clauses. Policies on `eod_submissions` ([20260504173035_per_store_rls_hardening.sql](../supabase/migrations/20260504173035_per_store_rls_hardening.sql) and [20260514120030_eod_submissions_consistency.sql](../supabase/migrations/20260514120030_eod_submissions_consistency.sql)) gate on `store_id` via `auth_can_see_store()` and on `auth_is_privileged()` for UPDATE. A NULL `submitted_by` does not affect any policy evaluation.

### API contract

**None.** No new RPC, no PostgREST contract change. The `staff_submit_eod` RPC ([supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql](../supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql)) writes `submitted_by` via the trigger; its behavior is unchanged.

### Edge function changes

**None.** Verified by reading the diff surface in [supabase/functions/](../supabase/functions/). No edge function references `eod_submissions.submitted_by` in a way that breaks under nulling.

### `src/lib/db.ts` surface

**None.** The frontend reads `eod_submissions` rows via existing helpers that already tolerate NULL `submitted_by` (the staff-app path explicitly sets it to NULL via the v2 RPC, so the read paths have always handled it).

### Realtime impact

**None.**
- The `eod_submissions` table is already in `supabase_realtime` ([20260502190000_realtime_publication.sql](../supabase/migrations/20260502190000_realtime_publication.sql) — FOR ALL TABLES; later tightened by [20260514140000_realtime_publication_tighten.sql](../supabase/migrations/20260514140000_realtime_publication_tighten.sql)). A constraint change does not affect publication membership.
- No `docker restart supabase_realtime_imr-inventory` step required. The realtime gotcha applies only to publication membership changes, not constraint changes.

### Frontend store impact

**None.** No changes to [src/store/useStore.ts](../src/store/useStore.ts), no optimistic-then-revert paths affected. The "delete profile" admin flow uses the existing `delete-user` edge function, which calls `auth.admin.deleteUser` (auth-side cascade via `profiles.id references auth.users(id) on delete cascade` in [init_schema.sql:21](../supabase/migrations/20260405000759_init_schema.sql)). After this migration, that flow will succeed when the target profile has dependent `eod_submissions` rows — those rows will have their `submitted_by` nulled and be retained as historical data.

### Test plan

**Existing tests:**
- `supabase/tests/auth_can_see_store_brand_scope.test.sql` arm (12) — this is the success criterion. Currently fails with FK violation at `delete from public.profiles where id = manager_id`. Post-migration: passes.
- All other pgTAP suites — must continue to pass. The FK swap is benign for any test that doesn't delete a profile with dependent rows.

**New test FILE: NOT REQUIRED.** The existing test exercises the fix indirectly (the FK violation on arm 12 is the negative signal; its absence is the positive signal). A dedicated test for the constraint's `confdeltype` value would be belt-and-braces:

```
select is(
  (select confdeltype::text from pg_constraint
    where conname = 'eod_submissions_submitted_by_fkey'),
  'n',
  'eod_submissions_submitted_by_fkey is ON DELETE SET NULL'
);
```

But this is overkill for a single-FK swap that the brand-scope test already verifies end-to-end. **Recommendation: skip the new test file.** The brand-scope test's arm (12) is the canary — if a future migration silently reverts this FK to `no action`, arm (12) would fail again, in the exact place this spec exists to fix. AC2 of the spec already encodes this as the success criterion.

### Risks and tradeoffs

**Pre-existing dangling `submitted_by` values.** If `eod_submissions` rows EXIST in prod with `submitted_by` pointing at a profile that has SOMEHOW already been deleted (e.g. an old `auth.users` cascade from before profile-delete was gated, or a manual psql DELETE that ignored the FK by running as postgres), those rows would currently fail the FK constraint's integrity check. The migration's `add constraint` would surface this as `ERROR: insert or update on table "eod_submissions" violates foreign key constraint`.

**Mitigation:** Negligible. The reverse direction here — adding the FK — would only fail if there are CURRENTLY rows whose `submitted_by` references a NON-EXISTENT profile. Postgres validates the constraint against existing data at the time of `add constraint`. Looking at the existing init-schema FK (`uuid references profiles(id)` with default NO ACTION), no insert path bypasses it; the only way to get into the bad state is via the postgres role bypassing RLS, which would be a manual operator action. Probability is very low.

**Defensive option (not recommended for inclusion):** add `not valid` to the `add constraint` to skip the initial scan, then `validate constraint` separately. This would NOT change the migration's semantics for new rows; it would only defer the existing-row check. For a 30-migration repo with a 286 KB seed and prod data that came from this same FK-protected path, the existing-row check is fast and trustworthy. Land the simple `add constraint`.

**Performance.** None. A FK swap on a table with O(thousands) of rows is sub-second. Postgres validates the constraint via a single seq-scan + index probe to `profiles(id)`; the latter is the PK index so it's O(rows-in-eod_submissions * log(rows-in-profiles)) and trivial. No index creation, no data movement.

**Edge function cold-start.** N/A.

**Migration ordering.** Stamped `20260527000000_` — strictly after `20260525000000_` (current head). No other in-flight spec touches `eod_submissions`. Clean.

**Production push.** Per AC5, the spec defers production application to main Claude post-review. The `db-migrations-applied.yml` CI gate (spec 064, [.github/workflows/db-migrations-applied.yml](../.github/workflows/db-migrations-applied.yml)) will catch any drift between this migration file landing in repo and being applied to prod.

### Implementation summary for the developer

One file to write:

- `supabase/migrations/20260527000000_eod_submissions_submitted_by_on_delete_set_null.sql` — drop + re-add the FK with `ON DELETE SET NULL`. Use the migration body shown above. Include the inline comment block — it documents the trigger orthogonality for future readers.

Then `npx supabase db reset` to verify clean local apply, then `bash scripts/test-db.sh` to verify all pgTAP suites pass (with `auth_can_see_store_brand_scope.test.sql` now passing for the first time).

Do NOT touch:
- `src/lib/db.ts` — no surface change.
- `src/store/useStore.ts` — no slice change.
- Any edge function — no behavior change.
- The `eod_submissions_set_submitted_by` trigger — load-bearing for spec 020 defense; orthogonal to this change.
- Any RLS policy.
- The pgTAP test file `auth_can_see_store_brand_scope.test.sql` — it is correct; the schema needs to match it.

## Handoff

next_agent: backend-developer
prompt: Implement against the design in this spec. The implementation is a single migration file at `supabase/migrations/20260527000000_eod_submissions_submitted_by_on_delete_set_null.sql` per the design's "Migration body" section. After implementation, run `npx supabase db reset` and `bash scripts/test-db.sh` to verify (a) clean migration apply and (b) `auth_can_see_store_brand_scope.test.sql` passes for the first time (no FK violation on arm 12) and (c) no other pgTAP suite regresses. Then set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/065-eod-submissions-submitted-by-on-delete-set-null.md

## Files changed

### migrations
- `supabase/migrations/20260527000000_eod_submissions_submitted_by_on_delete_set_null.sql` (new) — drops the implicit `eod_submissions_submitted_by_fkey` constraint and re-adds it with `ON DELETE SET NULL`. Header comment captures the trigger-orthogonality reasoning per the architect's design.

### verification (no source changes)
- `npx supabase db reset` — clean apply, no errors, no warnings beyond the expected "policy does not exist, skipping" notices from re-applied migrations.
- `bash scripts/test-db.sh` — **34/34 pgTAP suites pass** (up from 33/34). `supabase/tests/auth_can_see_store_brand_scope.test.sql` now passes all 14 assertions for the first time; AC2 satisfied.
- `npm test` — 316/316 jest tests pass across 33 suites (unchanged from baseline; SQL-only change).
- `npm run typecheck` + `npm run typecheck:test` — both clean.
- `pg_constraint.confdeltype` verified as `'n'` (ON DELETE SET NULL) for `eod_submissions_submitted_by_fkey` post-migration via direct psql query.
