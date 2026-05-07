# Security audit for spec 005

Scope: `supabase/migrations/20260506000000_rename_prep_canonicals.sql`. Spec 005 is a pure-data curation: 16 `UPDATE prep_recipes SET name = m.new_name` rows across 4 source names, all `is_current = false`, in a single brand. No edge functions, no RPCs, no schema, no policies, no roles, no grants, no secrets touched. Local apply complete; remote push pending explicit user authorization.

## Verdict

No Critical, no High, no Medium findings. One Low and one Informational.

The migration is a tightly-scoped data fix on a brand-shared table whose RLS posture (anyone-authed read, admin-only write) is unaffected by row name updates, applied as superuser inside `BEGIN/COMMIT` with strict per-name and grand-total assertions and a count-driven branch that no-ops on an empty DB. There is no reachable user-input surface. The migration body is hardcoded literals and parameterized only by the `_spec005_renames` temp table that the migration itself populates.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `supabase/migrations/20260506000000_rename_prep_canonicals.sql:163-167` — The `UPDATE` is destructive on the `name` column: pre-rename strings (`Tumeric Mix`, `2AM Sauce`, `2AM SAUCE 10`, `House Special Seasoning Mix`) are gone from `prep_recipes` post-apply, with no in-band audit-trail row written. The 16 affected rows are all `is_current = false` (so historically not user-visible via `pwa-catalog`), and `audit_log` is not wired up for migration-driven mutations anywhere else in this repo, so this is consistent with project precedent (Spec 001 did the same shape of mutation against `prep_recipe_ingredients` without an audit row). Impact: if a forensic reconstruction of which rows held the old names is later required (e.g. to investigate a customer-data dispute or a regulatory request), the only surviving evidence is the 16 row UUIDs the architect / dev captured in `specs/005-prep-canonical-curation.md` (gate 1 `row_ids` arrays). Fix (optional, non-blocking): pre-mutation, capture `(id, old_name, new_name, brand_id, applied_at)` into a forensic table or into `audit_log` with `action = 'spec005-rename'` so the trail survives independently of the spec markdown. Not flagged as Medium because (a) no PII is in `prep_recipes.name`, (b) no compliance regime cited in repo touches recipe-name history, (c) project precedent (Spec 001) already accepted destructive UPDATE without an audit row.

### Informational

- `supabase/migrations/20260506000000_rename_prep_canonicals.sql:46-193` — Threat-model surface check, all clear:
  - **RLS post-state.** `prep_recipes` policies established by `supabase/migrations/20260504073942_brand_catalog_p5_rls.sql` are SELECT `auth.uid() is not null` and INSERT/UPDATE/DELETE `auth_is_admin()`. Visibility is invariant under a `name`-only update: every authed user sees every row before and after, and only admins can mutate. The per-store hardening migration (`supabase/migrations/20260504173035_per_store_rls_hardening.sql`) intentionally does NOT touch `prep_recipes` because prep recipes are brand-shared, not store-scoped. No policy uses `name` in `USING` or `WITH CHECK`, so renaming cannot move a row across a visibility boundary.
  - **Brand-scoping.** The migration's `WHERE pr.brand_id = v_brand_id` predicate (line 86, line 167) pins every read and write to brand `2a000000-0000-0000-0000-000000000001`. Cross-brand contamination is not possible — rows under matching `name` strings in any other brand are filtered out by the `brand_id` predicate.
  - **Edge-function impact.** `supabase/functions/pwa-catalog/index.ts:138-145` filters `prep_recipes` to `is_current = true`. All 16 renamed rows are `is_current = false` (architect-certified per spec section 7 risk surface and confirmed by the migration's mechanic — no `is_current` flips). The catalog payload is byte-identical pre/post for every store under this brand. The 3 target canonicals (`38678f33-...` House Special Seasoning, `c7d9a94b-...` Tumeric Seasoning, `66d823bb-...` 2AM SAUCE) were `is_current = true` before the migration and remain `is_current = true` after, with no field changes — they are not visited by the UPDATE because the join key is `m.old_name = pr.name` and the canonicals already sit at the new name. No service-token-bearer path (`pwa-catalog`, `staff-catalog`) sees a payload diff.
  - **Auth-helper bypass.** No app-code path can replay the migration's UPDATE via a non-superuser route: PostgREST `UPDATE prep_recipes` would route through the `admin_update_prep_recipes` policy (`auth_is_admin()` only), and there is no exposed RPC that wraps a name-only update of `prep_recipes`. The two admin RPCs that touch `prep_recipes` (`admin_dedupe_prep_recipes` and `admin_db_inspector_probe`) both gate on `auth_is_admin()` (`supabase/migrations/20260505054049_admin_db_inspector_and_dedup_rpcs.sql:228`, `supabase/migrations/20260505065303_admin_rpcs_lock_anon.sql:37`) and were locked from `anon` and `public` in `20260505065303_admin_rpcs_lock_anon.sql:24-26`. The migration's privileged operation is unreachable from the app surface.
  - **Apply-time secrets / config.** No `Deno.env.get`, no `process.env`, no `current_setting('app.something')`, no `vault.secrets`, no service-token reads. Pure SQL with hardcoded UUID and string literals.
  - **Input validation / injection.** No user input. Every UPDATE candidate string is hardcoded into the migration (`supabase/migrations/20260506000000_rename_prep_canonicals.sql:74-78`); the `_spec005_renames` table is populated only by the migration itself and exists `ON COMMIT DROP`. The UPDATE is a JOIN-driven set update — no `EXECUTE` of dynamic SQL, no `format()`, no string concatenation into SQL.
  - **Realtime publication.** `supabase/migrations/20260502190000_realtime_publication.sql:13-14` publishes `for all tables`, so `prep_recipes` was already in the publication. The migration does NOT `ALTER PUBLICATION`, so the realtime restart gotcha (`memory/project_realtime_publication_gotcha.md`) does not apply. Realtime subscribers on `brand-{brandId}` (`src/hooks/useRealtimeSync.ts:43`) will receive 16 `UPDATE` events; admin clients are the only authed surface for this brand and are intended recipients.
  - **Idempotent re-run path.** Counts `0` → no-op success branch (line 93-94); counts `16` → mutation branch; anything else → `RAISE EXCEPTION` rollback (line 185-188). The `BEGIN/COMMIT` transaction wrapper (line 46, line 193) ensures partial states cannot persist.
  - **Migration ordering.** Filename `20260506000000` sorts after `20260505065303_admin_rpcs_lock_anon.sql` (the latest pre-Spec-004 migration) and before the `20260507*` Spec-004 cluster, consistent with the migration's header comment.
- **Spec-005 sibling drift.** Spec 006 (`House Special Blend (Sauce)` cleanup, untracked at `specs/006-house-special-blend-sauce-drift.md`) is explicitly out of scope here per amendment #3. This audit does NOT cover that cleanup.

## Dependencies

No `package.json` changes — `npm audit` skipped.

## Sign-off

Migration is safe to push to remote on the user's authorization. No security finding gates the spec; the Low finding is an optional defensive improvement, not a blocker.

## Handoff

next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 1 Low, 1 Informational.
payload_paths:
  - specs/005-prep-canonical-curation/reviews/security-auditor.md
