# Spec 066: Actor FK cascade audit sweep

Status: READY_FOR_REVIEW

Owner: backend

## Problem statement

During spec 065's design pass ([specs/065/reviews/backend-architect.md §"Schema sweep"](065/reviews/backend-architect.md)), the architect surveyed every FK column referencing `public.profiles(id)` in the schema. The survey found 16 such columns. Disposition:

- **1 correct** — `inventory_counts.submitted_by` already has `on delete set null` ([supabase/migrations/20260513000000_inventory_counts.sql:76](../supabase/migrations/20260513000000_inventory_counts.sql)).
- **1 just fixed** — `eod_submissions.submitted_by` was swapped to `on delete set null` by spec 065 ([supabase/migrations/20260527000000_eod_submissions_submitted_by_on_delete_set_null.sql](../supabase/migrations/20260527000000_eod_submissions_submitted_by_on_delete_set_null.sql)).
- **1 cascade (intentional)** — `user_stores.user_id` is `on delete cascade` ([supabase/migrations/20260405000759_init_schema.sql:32](../supabase/migrations/20260405000759_init_schema.sql)). Join-table semantics — correct as-is.
- **1 orphan (anomaly)** — `prep_recipes.created_by` has NO FK at all in prod. The init schema declared it; [supabase/migrations/20260502071736_remote_schema.sql:43](../supabase/migrations/20260502071736_remote_schema.sql) dropped the FK and never re-added it. The column still exists but is unconstrained.
- **11 latent bugs** — every remaining actor FK column carries the default `no action` posture, blocking profile deletion whenever any dependent audit-trail row exists. Each is a re-instance of the exact problem spec 065 fixed for `eod_submissions`.

The 11 latent bugs:

| # | Table | Column | Source |
|---|---|---|---|
| 1 | `inventory_items` | `last_updated_by` | [init_schema.sql:64](../supabase/migrations/20260405000759_init_schema.sql) |
| 2 | `waste_log` | `logged_by` | [init_schema.sql:146](../supabase/migrations/20260405000759_init_schema.sql) |
| 3 | `purchase_orders` | `created_by` | [init_schema.sql:157](../supabase/migrations/20260405000759_init_schema.sql) |
| 4 | `purchase_orders` | `received_by` | [init_schema.sql:162](../supabase/migrations/20260405000759_init_schema.sql) |
| 5 | `pos_imports` | `imported_by` | [init_schema.sql:180](../supabase/migrations/20260405000759_init_schema.sql) |
| 6 | `audit_log` | `user_id` | [init_schema.sql:199](../supabase/migrations/20260405000759_init_schema.sql) |
| 7 | `flags` | `user_id` | [20260502190001_flags_table.sql:15](../supabase/migrations/20260502190001_flags_table.sql) |
| 8 | `flags` | `resolved_by` | [20260502190001_flags_table.sql:20](../supabase/migrations/20260502190001_flags_table.sql) |
| 9 | `report_definitions` | `created_by` | [20260503000001_report_definitions.sql:13](../supabase/migrations/20260503000001_report_definitions.sql) |
| 10 | `report_runs` | `ran_by` | [20260510120000_report_runs.sql:89](../supabase/migrations/20260510120000_report_runs.sql) |
| 11 | `prep_recipes` | `created_by` | orphan — no FK in prod; see anomaly above |

For columns 1–10 each is the same latent bug as `eod_submissions.submitted_by` was prior to spec 065: any `delete from profiles where id = X` raises a foreign-key violation whenever X has even one audit-trail row in any of these tables. Column 11 is the inverse anomaly — the FK was lost, leaving orphan-data risk.

This is the follow-up audit-sweep spec the spec 065 architect review explicitly flagged ([specs/065/reviews/backend-architect.md §6, "Follow-up surfacing"](065-eod-submissions-submitted-by-on-delete-set-null.md)).

## User story

As a brand admin, I want to delete an inactive staff or admin profile without first manually clearing every table that recorded that user as an actor, so that historical audit-trail data is preserved (with NULL actor references where the original user has been deleted) and profile deletion is not silently blocked at the FK layer.

## Acceptance criteria

- [ ] AC1: A single new migration file lands at `supabase/migrations/<next-timestamp>_actor_fk_cascade_audit.sql` that swaps all 11 actor FKs (columns 1–10 in the table above) to `ON DELETE SET NULL`. Architect decides the exact stamp; convention is midnight-anchored.
- [ ] AC2: Within the same migration, `prep_recipes.created_by` has its FK restored as `references public.profiles(id) on delete set null`, matching the rest of the sweep. If the architect's `db diff --linked` check surfaces orphan data in this column that would block the `add constraint` (per Q4 of the open questions block), the architect may split this into a separate migration that does the data clean-up first — design call.
- [ ] AC3: `bash scripts/test-db.sh` runs the suite green — all 34 pgTAP suites that pass at HEAD continue to pass post-migration. No regression.
- [ ] AC4: A new pgTAP test file `supabase/tests/actor_fk_cascade_audit.test.sql` lands that bulk-verifies every FK in scope (the 11 swapped FKs plus the restored `prep_recipes.created_by` FK) has `pg_constraint.confdeltype = 'n'` (SET NULL). Test must exercise all 12 constraints by name in a single iteration to catch a future regression where any one of them is silently reverted.
- [ ] AC5: No application code changes. The change is SQL-only — `src/lib/db.ts`, `src/store/useStore.ts`, every screen under `src/screens/`, and every edge function under `supabase/functions/` remain untouched.
- [ ] AC6: Production push is deferred to main Claude post-merge, same flow as specs 060, 061, 065. If the spec 064 `db-migrations-applied.yml` CI gate is fully wired (i.e. `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_ID` secrets configured), it must catch the schema-drift state between merge and prod push. The spec does NOT authorize an automated production push.
- [ ] AC7: Migration applies cleanly via `npx supabase db reset` (clean local apply, no errors beyond the expected "policy does not exist, skipping" notices from re-applied migrations). Mutation test: reverting any one of the 12 FKs in the new migration to `on delete no action` causes `actor_fk_cascade_audit.test.sql` to fail at the corresponding assertion — verified locally by the developer before READY_FOR_REVIEW.
- [ ] AC8: For each of the 11 FK swaps + the 1 FK restoration, header comments in the migration file capture the trigger-orthogonality, RLS non-impact, and realtime non-impact rationale ONCE at the top of the file (not per-statement). The 12 individual statements get only a one-line `-- <table>.<column>: <reason>` comment each, by analogy to the spec 065 migration's header block.

## In scope

- Single migration that swaps the 11 actor FKs to `ON DELETE SET NULL`, in the order shown in the table above (alphabetical-by-table is fine; no ordering dependency between them).
- Restoration of the missing `prep_recipes_created_by_fkey` FK as `on delete set null` in the same migration.
- New pgTAP test file `supabase/tests/actor_fk_cascade_audit.test.sql` that asserts `confdeltype = 'n'` for all 12 constraints.
- Header comment in the migration matching the spec 065 migration's tone — captures trigger orthogonality, RLS non-impact, and the no-realtime-restart rationale at the file level.
- Confirmation that `inventory_counts.submitted_by` (already correct) is NOT touched. Architect may include it in the pgTAP test's iteration set as a defensive guard against a future regression flip — design call.

## Out of scope (explicitly)

- `user_stores.user_id` — `on delete cascade` is the correct join-table semantic and stays unchanged. Rationale: deleting a user should remove their `user_stores` rows, otherwise we'd have store-membership rows pointing at a NULL user, which is semantically meaningless for an access-control table.
- `eod_submissions.submitted_by` — already fixed by spec 065; touching it again would be churn.
- `inventory_counts.submitted_by` — already correct from its init-migration. May be included in the pgTAP iteration set as a defensive read-only check, but no DDL touches it.
- Any other type of FK semantics change (e.g. swapping a `cascade` to `set null` elsewhere). The 11 columns above are the exhaustive scope.
- Bulk profile-delete UI / admin flow. Out of scope; the existing `delete-user` edge function ([supabase/functions/delete-user/index.ts](../supabase/functions/delete-user/index.ts)) is unchanged. This spec only removes the FK layer's veto on profile delete; admin gating, last-of-role guards, and self-guards remain enforced upstream.
- Application code changes. Every actor-column read path in `src/lib/db.ts` already tolerates NULL (the columns were nullable from the start; the FK swap only changes future delete behavior, not query shape).
- RLS policy changes. None of the swapped columns are referenced in a USING or WITH CHECK clause that breaks under NULL.
- Edge function changes. No edge function relies on the actor column being non-null.
- Realtime publication membership changes. The realtime gotcha applies to publication membership flips, not constraint shape changes — no `docker restart supabase_realtime_imr-inventory` ritual required.

## Open questions resolved

- **Q1: Scope of the survey — trust spec 065's survey or redo?** → A: Trust spec 065's survey as the starting point. Architect re-verifies the 16-column list during their design pass via a single SQL query against `pg_constraint` (cheap), and surfaces any miss as a deviation in the design doc before READY_FOR_BUILD.

- **Q2: One migration vs. per-table migrations?** → A: ONE migration file. Each FK swap is independent (no ordering dependency), the diff is ~50 lines and fully reviewable, and one timestamp = one logical change for the spec 064 CI gate. Architect retains discretion to split if `prep_recipes.created_by` requires a data clean-up step first (per Q4).

- **Q3: Cascade action per column?** → A: ALL `on delete set null`. Default applies to every audit-trail-shaped column (the 10 swaps) and to the restored `prep_recipes.created_by` FK. The audit semantic is "the historical record is independently meaningful; the actor pointer can null out when the actor is deleted." If the architect surfaces a column that needs a different semantic during design, they may deviate with explicit rationale in the design doc.

- **Q4: Orphan column `prep_recipes.created_by` — restore FK, drop column, or leave bare?** → A: **(a) restore the FK** as `on delete set null` matching the rest of the sweep. Architect runs `db diff --linked` or a direct `select count(*) from prep_recipes where created_by is not null and created_by not in (select id from profiles)` against prod during design, and if the FK validation would fail at `add constraint` time due to orphan rows, escalates to the user before READY_FOR_BUILD. Acceptable resolutions: data clean-up migration first (sets stale orphans to NULL), then FK add; or, if the column has never been populated by code, downgrade to (b) drop column (architect surveys `src/lib/db.ts` and the cmd UI for any read/write).

- **Q5: Test plan?** → A: Single new pgTAP file `actor_fk_cascade_audit.test.sql` that iterates `pg_constraint` over the 12 constraints by name (or, if the architect prefers, by `(conrelid, conkey)` pair) and asserts `confdeltype = 'n'` for each. The new test plus the existing brand-scope test (spec 042 / spec 065) constitute the canary. Mutation guard: developer flips one swap back to `no action` locally pre-PR to confirm the test fails at exactly that assertion. No new jest tests, no new shell smokes.

- **Q6: Prod safety — does the FK validation block on orphan data?** → A: Architect checks via `db diff --linked` (or `pg_constraint` + `not in` queries) against the linked prod project during design. If any of the 11 swapped FKs would fail validation because dependent rows reference an already-deleted profile id, that's a deviation flagged in the design doc with a proposed clean-up path before READY_FOR_BUILD. For the swap (drop + re-add) of an existing FK, this scenario is structurally unlikely — the existing `no action` constraint would have prevented the orphan from accumulating. The risk is concentrated in the `prep_recipes.created_by` restoration (Q4) where the FK has been absent since 2026-05-02.

- **Q7: Sequencing with spec 064's CI gate?** → A: Same flow as spec 065. Local CI passes (jest + typechecks + pgTAP), PR merges to main, main Claude applies the migration to prod via `npx supabase db push`. If `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_ID` are set in repo secrets, the `db-migrations-applied.yml` workflow will surface the intermediate "migration on disk, not on prod" state automatically; if not set, main Claude pushes manually post-merge. Either path is acceptable; the spec does not gate on the secrets being configured.

## Dependencies

- A single new migration file in `supabase/migrations/` (or, per Q4, a small clean-up migration plus the main FK-swap migration — architect's call).
- A new pgTAP test file `supabase/tests/actor_fk_cascade_audit.test.sql`.
- No edge function changes.
- No application code changes.
- No RLS policy changes.
- No frontend changes.
- Spec 065 must be merged (already SHIP_READY per the architect review) so the `eod_submissions.submitted_by` FK is in its post-swap state and the 12-constraint iteration in the new pgTAP test reflects reality. (If spec 065 has not landed, this spec must wait — but spec 065's PR is already merged per the architect drift review.)

## Project-specific notes

- **Cmd UI section / legacy:** None — backend-only schema fix.
- **Per-store or admin-global:** N/A — schema migration affects every brand and store equally.
- **Realtime channels touched:** None. Constraint changes do not touch publication membership.
- **Migrations needed:** Yes — one new migration (or two, if Q4 forces a clean-up split).
- **Edge functions touched:** None.
- **Web/native scope:** N/A — DB-only.
- **Tests:** pgTAP track. The change is validated by a new bulk-verify suite asserting `confdeltype = 'n'` for the 12 constraints in scope. The existing brand-scope test (spec 042 / spec 065) continues to pass as a secondary canary.

## Open questions for architect

1. **Constraint name verification.** All 11 FKs in the sweep are auto-named by Postgres as `<table>_<column>_fkey`. The architect should grep the migration history for any explicit `constraint <name>` clauses or renames before writing the drop+add pairs. Reference shape: spec 065's design did this same check ([specs/065-eod-submissions-submitted-by-on-delete-set-null.md §"Constraint name verification"](065-eod-submissions-submitted-by-on-delete-set-null.md)).

2. **prep_recipes.created_by orphan check.** Run `select count(*) from public.prep_recipes where created_by is not null and created_by not in (select id from public.profiles)` against linked prod. If non-zero, propose a clean-up step (set orphans to NULL) BEFORE the FK add. If the column has never been written by application code (architect should grep `src/lib/db.ts` and the screens for `created_by` writes against `prep_recipes`), Q4's option (b) — drop the column — becomes viable; surface that as a counter-proposal in the design doc.

3. **Migration timestamp.** Convention is midnight-anchored. Today is 2026-05-27. Spec 065's migration stamped `20260527000000_`. Architect picks the next available stamp; likely `20260528000000_` (tomorrow) or `20260527010000_` if same-day.

4. **One migration vs. data-clean-up + FK migration split.** Default is one file. If the architect's Q2 orphan check surfaces data that would block validation, they may split. The CI gate from spec 064 detects the unified "applied / not applied" state — multiple files merged in the same PR are fine.

5. **Trigger interactions.** None of the 11 tables in scope have a per-row trigger that rewrites the actor column the way spec 020's `eod_submissions_set_submitted_by_trg` does for `eod_submissions`. Architect should sanity-check by grepping `supabase/migrations/` for `before insert or update` triggers on each of the 11 tables — none are expected, but document the absence in the design doc.

6. **Defensive iteration in the pgTAP test.** The test asserts `confdeltype = 'n'` for the 12 constraints. Should it ALSO assert `confdeltype = 'n'` for `inventory_counts.submitted_by` (already correct) as a regression guard? Architect's call — including it would convert any future "someone reverts inventory_counts back to no action" change into an immediate red CI signal, but it's outside the spec's swap set. Sensible default: include it (one extra row in the VALUES list is free).

7. **Test isolation.** The new pgTAP file reads `pg_constraint` and asserts on rows by name. It is schema-introspection only, with no setup/teardown that touches data. Architect confirms the test runs in any order vs. the existing 34 suites with no isolation requirement.

## Backend design

DB-only change. One migration file + one new pgTAP test file. No edge function changes, no `src/lib/db.ts` changes, no RLS changes, no realtime impact.

### 0. Re-verification of the spec 065 survey

The architect re-verified the 16-column survey by exhaustive grep over `supabase/migrations/` for `references .* profiles(id)` and confirmed:

- Init schema [supabase/migrations/20260405000759_init_schema.sql](../supabase/migrations/20260405000759_init_schema.sql) declares 9 FKs to `profiles(id)` at lines 21, 32, 64, 97, 123, 146, 157, 162, 180, 199 (line 21 is `profiles.id → auth.users(id)` — outbound, not in scope).
- Later migrations add 5 more FKs: `flags_table.sql:15+20`, `report_definitions.sql:13`, `report_runs.sql:89`, `inventory_counts.sql:76`, and the spec 065 fix at `20260527000000_eod_submissions_submitted_by_on_delete_set_null.sql:40`.
- `remote_schema.sql:43` drops `prep_recipes_created_by_fkey`. No later migration re-adds it.
- `invitations.profile_id` is a bare `uuid` column with **no FK** ([recover_undeclared_tables.sql:106](../supabase/migrations/20260424211732_recover_undeclared_tables.sql)) — not in scope.

**Net actor FKs referencing `public.profiles(id)`:**

| Status | Count |
|---|---|
| Outbound from profiles to auth.users (`on delete cascade`) | 1 |
| Inbound `on delete cascade` (intentional — `user_stores`) | 1 |
| Inbound `on delete set null` already correct (`inventory_counts`) | 1 |
| Inbound `on delete set null` after spec 065 (`eod_submissions`) | 1 |
| **Inbound `no action` to swap to `set null` (this spec)** | **10** |
| **Inbound dropped FK to restore as `on delete set null` (this spec)** | **1** |

This matches the PM's 11-bug count exactly. The PM's spec 065 "16 columns" total includes the outbound profiles→auth.users edge (which is `profiles_id_fkey`, line 21 of init_schema, decoded by introspection as the `confrelid` outbound rather than inbound) and is correct.

**The architect WILL NOT re-run the live `pg_constraint` query against the running DB in this design pass** — the migration history is the authoritative source of truth for the local apply path, and the seed inserts (`supabase/seed.sql:1029-1040`) deliberately omit `created_by` from the INSERT column list, so a fresh `npx supabase db reset` produces a state where every `prep_recipes.created_by` is NULL. The dev will run the live verification under "Verification plan" below before READY_FOR_REVIEW. Prod parity is the spec 064 CI gate's job; the local apply is what unblocks this design.

### 1. Full survey table

Each FK in the 12-row sweep below uses Postgres' auto-naming convention `<table>_<column>_fkey`. Verified by inspecting `remote_schema.sql:43` (`drop constraint "prep_recipes_created_by_fkey"`) which proves prod auto-named the same way. The migration uses `drop constraint if exists` so a renamed constraint just no-ops the drop (the subsequent `add constraint` would still create the canonical name).

| # | Table | Column | Constraint name | Current `confdeltype` | Target `confdeltype` | Source line | Rationale |
|---|---|---|---|---|---|---|---|
| 1 | `inventory_items` | `last_updated_by` | `inventory_items_last_updated_by_fkey` | `a` (NO ACTION) | `n` (SET NULL) | [init_schema.sql:64](../supabase/migrations/20260405000759_init_schema.sql) | Audit attribution; deleting the user shouldn't block stock updates from being archived. |
| 2 | `waste_log` | `logged_by` | `waste_log_logged_by_fkey` | `a` | `n` | [init_schema.sql:146](../supabase/migrations/20260405000759_init_schema.sql) | Waste records are historical; logger pointer can null out. |
| 3 | `purchase_orders` | `created_by` | `purchase_orders_created_by_fkey` | `a` | `n` | [init_schema.sql:157](../supabase/migrations/20260405000759_init_schema.sql) | PO history is audit-shaped. |
| 4 | `purchase_orders` | `received_by` | `purchase_orders_received_by_fkey` | `a` | `n` | [init_schema.sql:162](../supabase/migrations/20260405000759_init_schema.sql) | Receiver pointer is audit-shaped. |
| 5 | `pos_imports` | `imported_by` | `pos_imports_imported_by_fkey` | `a` | `n` | [init_schema.sql:180](../supabase/migrations/20260405000759_init_schema.sql) | Import history is audit-shaped. |
| 6 | `audit_log` | `user_id` | `audit_log_user_id_fkey` | `a` | `n` | [init_schema.sql:199](../supabase/migrations/20260405000759_init_schema.sql) | Audit log is the canonical case — actor null-out is the textbook posture. |
| 7 | `flags` | `user_id` | `flags_user_id_fkey` | `a` | `n` | [flags_table.sql:15](../supabase/migrations/20260502190001_flags_table.sql) | Submitter pointer; flag content survives deletion. |
| 8 | `flags` | `resolved_by` | `flags_resolved_by_fkey` | `a` | `n` | [flags_table.sql:20](../supabase/migrations/20260502190001_flags_table.sql) | Resolver pointer is audit-shaped. |
| 9 | `report_definitions` | `created_by` | `report_definitions_created_by_fkey` | `a` | `n` | [report_definitions.sql:13](../supabase/migrations/20260503000001_report_definitions.sql) | Saved-report metadata; creator pointer is audit-shaped. |
| 10 | `report_runs` | `ran_by` | `report_runs_ran_by_fkey` | `a` | `n` | [report_runs.sql:89](../supabase/migrations/20260510120000_report_runs.sql) | Runner pointer; run output is the historical record. |
| 11 | `prep_recipes` | `created_by` | `prep_recipes_created_by_fkey` | **(no FK)** | `n` | dropped by [remote_schema.sql:43](../supabase/migrations/20260502071736_remote_schema.sql) | Restore as `set null`. See §3 below. |

**Defensive read-only iteration in the test (per Q6):**

| # | Table | Column | Constraint name | Expected `confdeltype` | Source |
|---|---|---|---|---|---|
| 12 | `inventory_counts` | `submitted_by` | `inventory_counts_submitted_by_fkey` | `n` | [inventory_counts.sql:76](../supabase/migrations/20260513000000_inventory_counts.sql) — already SET NULL. |
| 13 | `eod_submissions` | `submitted_by` | `eod_submissions_submitted_by_fkey` | `n` | [eod_submissions_submitted_by_on_delete_set_null.sql:40](../supabase/migrations/20260527000000_eod_submissions_submitted_by_on_delete_set_null.sql) — fixed by spec 065. |

These two positive controls are read-only in the new pgTAP test. The migration does NOT touch them. They serve as regression guards: if a future drive-by migration reverses either, this test fails immediately.

### 2. Migration

**Filename.** `supabase/migrations/20260528000000_actor_fk_cascade_audit.sql` (midnight-anchored, next available after spec 065's `20260527000000_`). Per Q3, this is one stamp after today.

**Single file, no split.** Rationale per Q4: the `prep_recipes.created_by` restoration does not require a data clean-up step because (a) the column has been NULL-by-default since 2026-05-02 when `remote_schema.sql:43` dropped the FK and `src/lib/db.ts` has zero writes to it (verified via grep), and (b) the seed at `supabase/seed.sql:1029-1040` omits the column from its INSERT list, so a local `npx supabase db reset` produces an all-NULL column state. If prod has any orphan rows (extremely unlikely — would have to come from a pre-2026-05-02 INSERT plus a profile delete that broke the FK guard), the dev's live orphan check (see Verification plan) catches it and the spec splits at that point.

**Migration body sketch (developer-authored SQL).** The shape mirrors spec 065's migration but with 11 sequential statement pairs. Header comment captures trigger orthogonality + RLS non-impact + realtime non-impact rationale once at the top per AC8.

```sql
-- ============================================================
-- Spec 066 — Allow profile deletion when audit-trail rows reference it.
--
-- Generalizes the spec 065 fix across every actor FK referencing
-- public.profiles(id). The init schema and several follow-on
-- migrations declared `<actor>_by uuid references profiles(id)`
-- without an ON DELETE clause; the default NO ACTION blocks
-- profile deletion whenever ANY dependent audit-trail row
-- exists in any of the 11 tables in scope. This is the same
-- shape spec 065 closed for eod_submissions; spec 066 closes
-- the remaining 10 instances and restores the prep_recipes
-- FK that remote_schema.sql:43 dropped in 2026-05-02 (never
-- re-added).
--
-- Out of scope (intentional): user_stores.user_id stays ON DELETE
-- CASCADE — join-table semantic. eod_submissions.submitted_by
-- and inventory_counts.submitted_by are already SET NULL.
--
-- Trigger orthogonality. None of the 11 tables in scope have a
-- BEFORE INSERT/UPDATE trigger that rewrites the actor column
-- the way eod_submissions_set_submitted_by_trg
-- (20260514120030_eod_submissions_consistency.sql:78-94) does
-- for eod_submissions. (inventory_counts has one but is not in
-- scope — already SET NULL.) FK cascade on profile DELETE is a
-- system-level UPDATE issued by the referential-action machinery
-- that does NOT invoke user-visible BEFORE UPDATE row triggers
-- on the affected column. Even if it did, auth.uid() under the
-- postgres cascade role is NULL, so the effective result would
-- still be <actor> = NULL. No trigger changes required.
--
-- No RLS policy references any of the 11 actor columns in its
-- USING or WITH CHECK clause; nulling does not affect policy
-- evaluation. No realtime publication membership change; the
-- "docker restart supabase_realtime_*" ritual does NOT apply.
-- ============================================================

begin;

-- inventory_items.last_updated_by: audit attribution; null out on delete.
alter table public.inventory_items
  drop constraint if exists inventory_items_last_updated_by_fkey;
alter table public.inventory_items
  add constraint inventory_items_last_updated_by_fkey
    foreign key (last_updated_by) references public.profiles(id) on delete set null;

-- waste_log.logged_by: audit attribution; null out on delete.
alter table public.waste_log
  drop constraint if exists waste_log_logged_by_fkey;
alter table public.waste_log
  add constraint waste_log_logged_by_fkey
    foreign key (logged_by) references public.profiles(id) on delete set null;

-- purchase_orders.created_by: audit attribution; null out on delete.
alter table public.purchase_orders
  drop constraint if exists purchase_orders_created_by_fkey;
alter table public.purchase_orders
  add constraint purchase_orders_created_by_fkey
    foreign key (created_by) references public.profiles(id) on delete set null;

-- purchase_orders.received_by: audit attribution; null out on delete.
alter table public.purchase_orders
  drop constraint if exists purchase_orders_received_by_fkey;
alter table public.purchase_orders
  add constraint purchase_orders_received_by_fkey
    foreign key (received_by) references public.profiles(id) on delete set null;

-- pos_imports.imported_by: audit attribution; null out on delete.
alter table public.pos_imports
  drop constraint if exists pos_imports_imported_by_fkey;
alter table public.pos_imports
  add constraint pos_imports_imported_by_fkey
    foreign key (imported_by) references public.profiles(id) on delete set null;

-- audit_log.user_id: textbook audit-actor null-out.
alter table public.audit_log
  drop constraint if exists audit_log_user_id_fkey;
alter table public.audit_log
  add constraint audit_log_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete set null;

-- flags.user_id: submitter pointer; flag content survives deletion.
alter table public.flags
  drop constraint if exists flags_user_id_fkey;
alter table public.flags
  add constraint flags_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete set null;

-- flags.resolved_by: resolver pointer; null out on delete.
alter table public.flags
  drop constraint if exists flags_resolved_by_fkey;
alter table public.flags
  add constraint flags_resolved_by_fkey
    foreign key (resolved_by) references public.profiles(id) on delete set null;

-- report_definitions.created_by: creator pointer; null out on delete.
alter table public.report_definitions
  drop constraint if exists report_definitions_created_by_fkey;
alter table public.report_definitions
  add constraint report_definitions_created_by_fkey
    foreign key (created_by) references public.profiles(id) on delete set null;

-- report_runs.ran_by: runner pointer; null out on delete.
alter table public.report_runs
  drop constraint if exists report_runs_ran_by_fkey;
alter table public.report_runs
  add constraint report_runs_ran_by_fkey
    foreign key (ran_by) references public.profiles(id) on delete set null;

-- prep_recipes.created_by: RESTORE missing FK (dropped 2026-05-02
-- by remote_schema.sql:43, never re-added). Column has been NULL-
-- by-default since the drop; src/lib/db.ts has zero writes to it.
-- See spec 066 design §0 for orphan-risk analysis.
alter table public.prep_recipes
  drop constraint if exists prep_recipes_created_by_fkey;
alter table public.prep_recipes
  add constraint prep_recipes_created_by_fkey
    foreign key (created_by) references public.profiles(id) on delete set null;

commit;
```

**Idempotency.** Every `drop constraint if exists` makes the migration re-apply-safe. A second `npx supabase db reset` is a no-op for the drops and re-adds the constraints to the same `pg_constraint` shape (`confdeltype = 'n'`).

**Ordering.** Statements appear alphabetically by table per AC §"In scope" guidance. No ordering dependency exists between them; each statement pair operates on a distinct constraint.

### 3. `prep_recipes.created_by` orphan check (Q2 detailed analysis)

**Local apply: zero risk.** The seed at `supabase/seed.sql:1029-1040` does NOT include `created_by` in its INSERT column list. After `npx supabase db reset`, every `prep_recipes.created_by` is NULL. Adding the FK with `on delete set null` is unconstrained by data — Postgres validates non-null values against `profiles.id` and skips NULLs entirely.

**Prod apply: low risk; dev verifies pre-PR.** The FK was dropped on 2026-05-02 ([remote_schema.sql:43](../supabase/migrations/20260502071736_remote_schema.sql)). For an orphan to accumulate, a `prep_recipes` row would have to have a `created_by` populated by application code between then and today. Verification:

- `Grep "prep_recipes" supabase/migrations/` — no migration writes `created_by`.
- `Grep "created_by" src/lib/db.ts` — three call sites total: `purchase_orders.created_by` (params.submittedByUserId), `purchase_orders.creator:profiles!created_by` (read), and `report_definitions.created_by` (rep.createdBy). **No write or read references `prep_recipes.created_by`.**
- `Grep "prep_recipes" src/screens/` — no read or write references `created_by` on `prep_recipes`.

The column is dead — it has been since the FK was dropped. Restoring the FK is safe.

**Dev's pre-READY_FOR_REVIEW check.** Before flipping status, the dev runs against the linked prod DB:

```sql
select count(*) as orphan_count
  from public.prep_recipes pr
 where pr.created_by is not null
   and not exists (select 1 from public.profiles p where p.id = pr.created_by);
```

Expected result: `orphan_count = 0`. If non-zero, the dev escalates to the user with the count and rows. Acceptable resolutions per Q4: (a) prepend a data clean-up step (`update prep_recipes set created_by = null where created_by is not null and not in (select id from profiles)`) to the migration; (b) split into two migrations with clean-up first. Spec 066 explicitly authorizes either; neither is expected to be needed.

### 4. Trigger interactions (Q5 sanity check)

Grep over `supabase/migrations/` for `before insert or update on` matches exactly six triggers:
- `inventory_counts_set_submitted_by_trg` on `inventory_counts` — out of scope (already SET NULL).
- `inventory_count_entries_check_store_trg` on `inventory_count_entries` — does not touch a profile FK column.
- `report_runs_check_definition_consistency_trg` on `report_runs` — overrides `ran_by`. **Same shape as the eod_submissions trigger**: rewrites `new.ran_by := auth.uid()` regardless of caller input. Cascade-from-profile-delete is a system-level UPDATE on the column itself, not a row INSERT/UPDATE that this trigger gates. Even if the trigger did fire under the cascade, `auth.uid()` returns NULL under the postgres cascade role, so the trigger would write NULL which is the same value the cascade is writing. **No trigger change required.**
- `user_stores_brand_match_trg` on `user_stores` — out of scope (cascade).
- `eod_submissions_set_submitted_by_trg` on `eod_submissions` — out of scope (already SET NULL after spec 065).
- `eod_entries_check_store_trg` on `eod_entries` — does not touch a profile FK column.

For the remaining 9 tables in scope (`inventory_items`, `waste_log`, `purchase_orders`, `pos_imports`, `audit_log`, `flags`, `report_definitions`, `prep_recipes`): no `before insert or update` trigger exists. Verified via grep; documented as the absence-of-trigger in the migration header.

### 5. pgTAP test

**Filename.** `supabase/tests/actor_fk_cascade_audit.test.sql`.

**Plan: 12 arms** — one assertion per constraint. Each arm reads `pg_constraint` and asserts `confdeltype = 'n'`. Test is schema-introspection only (no data setup/teardown, no fixture). Per Q7, this requires no isolation against the other 34 suites — it does not impersonate a JWT, does not insert any rows, and reads only catalog tables that are stable across the test suite.

Why 12 arms (not 11): per Q6 default, the test includes `inventory_counts.submitted_by` and `eod_submissions.submitted_by` as positive controls (Q6 says "include it (one extra row in the VALUES list is free)"). Net: 10 sweep arms + 1 restoration arm + 2 positive controls = 13. Architect adjusts the AC4 spec count from 12 → 13 in the design (one extra positive control on `eod_submissions.submitted_by` that the spec author didn't enumerate, but the Q6 default explicitly authorizes). The dev confirms 13 arms in the actual test.

**Test body sketch.**

```sql
-- supabase/tests/actor_fk_cascade_audit.test.sql
--
-- Spec 066 — pgTAP probe that asserts every actor FK referencing
-- public.profiles(id) has confdeltype = 'n' (ON DELETE SET NULL),
-- except the intentional cascade on user_stores.user_id. Catches
-- a future regression where any one of the 11 swapped FKs (or
-- the 2 already-correct positive-control FKs) is silently
-- reverted to NO ACTION / RESTRICT / CASCADE / SET DEFAULT.
--
-- Hermetic isolation: begin; ... rollback;. The probe touches
-- only pg_constraint (catalog read).
--
-- See specs/066-actor-fk-cascade-audit-sweep.md §"Backend design"
-- for the full survey and migration rationale.

begin;
create extension if not exists pgtap;

select plan(13);

-- Reusable single-arm helper inline (pgTAP has no shared helper
-- across tests). The pattern: for a given (table, column) pair,
-- assert that exactly one FK exists referencing profiles(id) and
-- its confdeltype = 'n'. Returns false / errors out if zero FKs
-- found, which catches both the "FK was dropped" regression (the
-- prep_recipes anomaly that motivated spec 066's restoration arm)
-- and the "FK was renamed" deviation. Lookup is by (conrelid,
-- conkey) — robust against constraint rename.

-- Iterate the 13 (table, column, message) triples. Each is(...)
-- expands inline so the TAP output names the offending FK on a
-- failing arm.

-- Arm (1): inventory_items.last_updated_by → set null
select is(
  (select c.confdeltype
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     join pg_attribute a on a.attrelid = t.oid and a.attnum = ANY(c.conkey)
    where n.nspname = 'public'
      and t.relname = 'inventory_items'
      and a.attname = 'last_updated_by'
      and c.contype = 'f'
    limit 1),
  'n'::"char",
  'arm (1): inventory_items.last_updated_by FK has on delete set null. ' ||
  'See specs/066-actor-fk-cascade-audit-sweep.md for the migration that landed this.'
);

-- ... repeat for arms (2) through (13), each on its own (table, column) pair ...

select * from finish();
rollback;
```

The dev decides between (a) 13 hand-written arms (one `is(...)` per triple, matching the canonical pgTAP shape used by `eod_submissions_consistency.test.sql`) or (b) a single-CTE iteration that pulls the 13 (table, column) pairs from a VALUES literal and asserts each in one `is(count_mismatching, 0)` aggregate. Both are valid per Q5 ("by name or by `(conrelid, conkey)` pair"). The hand-written form is more verbose but each assertion names the failing FK in the TAP output, which is the spec author's preferred posture (per AC4: "Test must exercise all 12 constraints by name in a single iteration to catch a future regression where any one of them is silently reverted"). Spec 053's `permissive_policy_lint.test.sql` already demonstrates the single-CTE aggregation pattern — the dev may consult that file if they prefer the aggregated form. **Recommended: hand-written form, 13 arms.** TAP output on failure points directly at the broken constraint, which is the canonical Q5 ask.

### 6. Verification plan (developer pre-PR)

1. **Migration apply.** `npx supabase db reset` — apply clean from scratch. Expect "policy does not exist, skipping" notices for re-applied migrations (cosmetic only). No FK-validation errors.

2. **pgTAP suite.** `bash scripts/test-db.sh` — expect 34 of 34 existing files PASS + the new file PASS at 13/13 assertions. Total: 35 of 35.

3. **Mutation guard.** Manually edit `supabase/migrations/20260528000000_actor_fk_cascade_audit.sql`, change ONE swap's `on delete set null` back to `on delete no action`, re-run `npx supabase db reset && bash scripts/test-db.sh`. Expect: the corresponding arm in `actor_fk_cascade_audit.test.sql` fails with `# Failed test ... arm (N): <table>.<column> FK has on delete set null. ... got: 'a', want: 'n'.` Revert the edit before pushing.

4. **Prod orphan check (linked DB).** Before READY_FOR_REVIEW, run against the linked prod project:

   ```sql
   select count(*) as orphan_count
     from public.prep_recipes pr
    where pr.created_by is not null
      and not exists (select 1 from public.profiles p where p.id = pr.created_by);
   ```

   Expected: 0. If non-zero, do not flip status — escalate per Q4 with the orphan rows attached.

5. **Profile-delete smoke (optional).** As super-admin in the local DB:

   ```sql
   -- Pick a test user that has at least one row in inventory_items.last_updated_by
   -- (or waste_log.logged_by, etc.), then attempt delete.
   delete from public.profiles where id = '<test-user-id>';
   ```

   Expected: succeeds. The dependent rows now have NULL in the actor column. This is the user-facing acceptance criterion — the spec was authored because this delete previously failed.

### 7. Risk and tradeoff analysis

**Migration risk (each row independently).**

| Risk | Likelihood | Mitigation |
|---|---|---|
| Orphan rows in any of the 10 swap tables block `add constraint` validation. | Very low — the existing NO ACTION FK has been blocking orphan accumulation since init. The only way to accumulate orphans is to first DROP the FK, INSERT orphans, then re-add. No migration history shows this pattern. | The dev's verification plan step 1 (`db reset`) catches local failures. Spec 064's CI gate flags prod-side validation failure post-merge. If validation fails, the dev splits with a clean-up migration first per Q4. |
| Orphan rows in `prep_recipes.created_by` block validation on restoration. | Very low — column has been all-NULL by default since 2026-05-02 and `db.ts` has zero writes. | Verification plan step 4 explicitly checks prod before READY_FOR_REVIEW. |
| Constraint name mismatch (custom-named FK not matching `<table>_<column>_fkey` pattern). | Very low — `remote_schema.sql:43` proves prod's auto-naming held. | `drop constraint if exists` no-ops the drop on rename; the subsequent add creates the canonical name. The pgTAP test reads by `(conrelid, conkey)`, not by name, so the assertion still fires correctly. |
| Lock acquisition under `alter table` blocks other queries. | Low — each `alter table` is fast (catalog-only update for FK swap). Migration runs under `npx supabase db push` outside business hours per project convention. | Single-tx `begin/commit` is intentional; if any swap fails, the whole block rolls back and the dev sees the error before half the table set is mutated. |

**Performance on the 286 KB seed dataset.** None — each `alter table` is catalog-only when there is no data to validate (NULL columns and empty tables in seed) or validates against `profiles.id` in milliseconds (the 11 tables in scope are small; `audit_log` is the largest at ~hundreds of seed rows). Total migration runtime is sub-second locally.

**Realtime impact.** None. No table is added/removed from `supabase_realtime`. The `docker restart supabase_realtime_imr-inventory` ritual does NOT apply.

**Edge function impact.** None. No edge function reads or writes the actor columns in a way that depends on FK shape. The `delete-user` function will start succeeding in cases where it previously failed at the FK layer — a semantic improvement, not a contract change. The last-of-role and self-guards still fire upstream.

**`src/lib/db.ts` impact.** None. The actor columns are nullable today (they were declared without `not null`) so every read path in `db.ts` already tolerates NULL. The change only affects future DELETE behavior on `profiles`.

**Frontend store impact.** None. No screen optimistically inserts into any of the swapped FK columns in a way that breaks under the new posture.

### 8. Open questions resolved during design

- **Q1 (constraint name verification).** Resolved: auto-named per Postgres convention. `remote_schema.sql:43`'s `drop constraint "prep_recipes_created_by_fkey"` proves the convention held in prod. The migration uses `drop constraint if exists` to no-op on any rename; pgTAP iterates by `(conrelid, conkey)` so name drift doesn't break the test.

- **Q2 (prep_recipes orphan check).** Resolved: zero orphan risk locally (seed has all-NULL `created_by`). Prod verification deferred to dev pre-PR check; expected 0 orphans. If non-zero, dev escalates per Q4 acceptable resolutions.

- **Q3 (migration timestamp).** Resolved: `20260528000000_actor_fk_cascade_audit.sql`. Midnight-anchored, next available after spec 065's `20260527000000_`.

- **Q4 (single vs. split).** Resolved: SINGLE file. The prep_recipes restoration carries zero orphan risk in the local apply and very low risk in prod. If the dev's prod orphan check (Verification plan step 4) finds non-zero rows, they split per AC2's authorization.

- **Q5 (trigger interactions).** Resolved: only `report_runs_check_definition_consistency_trg` rewrites an actor column in scope (`ran_by`). Same shape as the eod_submissions trigger — orthogonal to FK cascade behavior. No trigger changes required.

- **Q6 (defensive iteration).** Resolved: INCLUDE both `inventory_counts.submitted_by` and `eod_submissions.submitted_by` as positive controls in the pgTAP test. Net 13 arms (10 sweep + 1 restoration + 2 positive controls). AC4's "12 constraints" count is updated to "13 constraints" implicitly by the design.

- **Q7 (test isolation).** Resolved: schema-introspection only. Reads `pg_constraint`. No JWT impersonation, no INSERT, no setup/teardown. Runs cleanly in any order vs. the existing 34 suites.

### 9. Files changed (developer hand-off)

- **NEW** `supabase/migrations/20260528000000_actor_fk_cascade_audit.sql` — the migration body sketched in §2.
- **NEW** `supabase/tests/actor_fk_cascade_audit.test.sql` — the pgTAP probe sketched in §5, with 13 arms.

No other files in the repo change. Specifically: `src/lib/db.ts`, `src/store/useStore.ts`, every screen under `src/screens/`, every edge function under `supabase/functions/`, and every other migration / test file remain untouched (AC5).

## Files changed

### Migrations

- **NEW** `supabase/migrations/20260528000000_actor_fk_cascade_audit.sql` — single migration wrapping all 11 FK swaps in one `begin/commit`. 10 sweep entries (alphabetical by table, idempotent via `drop constraint if exists`) plus the `prep_recipes.created_by` restoration. File header comment captures trigger-orthogonality, RLS non-impact, and realtime non-impact rationale once at the file level per AC8.

### Tests

- **NEW** `supabase/tests/actor_fk_cascade_audit.test.sql` — pgTAP probe with 13 arms (10 sweep + 1 restoration + 2 positive controls for `inventory_counts.submitted_by` and `eod_submissions.submitted_by`). Each arm reads `pg_constraint` by `(conrelid, conkey, contype = 'f', confrelid = profiles)` and asserts `confdeltype = 'n'`. Hermetic `begin; ... rollback;` framing, schema-introspection only (no JWT impersonation, no INSERT, no fixture).

### Verification record (architect §6 four-step plan)

1. **Prod orphan check (architect §Q2).** `npx supabase db query --linked` against `prep_recipes` for created_by orphans → `orphan_count = 0`. Green-light to proceed with single-file migration as designed.
2. **Migration apply.** `npx supabase db reset` — clean apply, all 31 migrations through 066 succeed. Only expected notice: `constraint "prep_recipes_created_by_fkey" of relation "prep_recipes" does not exist, skipping` (the `if exists` no-op on the long-dropped FK before re-adding it fresh).
3. **Full pgTAP suite.** `bash scripts/test-db.sh` — 35/35 test files pass (was 34/34 at HEAD; +1 for the new file). New test passes at 13/13 assertions.
4. **Mutation guard.** Reverted `audit_log.user_id` to `on delete no action` in the migration, re-ran `npx supabase db reset && bash scripts/test-db.sh` against just the new test file. Result: arm (6) failed with `# Failed test 6 ... have: a / want: n`. Reverted to `set null` and re-ran the full suite — back to 35/35 green.
5. **JS toolchain.** `npm test` → 33 jest suites / 316 tests pass. `npx tsc --noEmit` → clean (no output). Confirms AC5 (SQL-only change, no app-code drift).

### Files NOT changed (AC5 confirmation)

`src/lib/db.ts`, `src/store/useStore.ts`, every screen under `src/screens/`, every edge function under `supabase/functions/`, every other migration file, and every other test file remain untouched.
