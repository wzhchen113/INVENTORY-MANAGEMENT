# Code reviewer findings — Spec 012a

> Note: code-reviewer agent emitted findings as inline output (its system
> prompt restricts file writes); main Claude transcribed verbatim into
> this file so release-coordinator can read it.

## Critical

None.

## Should-fix

- **`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:229–234`** — The
  `auth_is_privileged()` comment references a `sync_role_to_app_metadata` trigger that
  writes `'super_admin'` into `raw_app_meta_data`, explaining why `auth_is_admin()`
  returns false for super-admins. **No such trigger exists in any migration in this
  repo; the trigger is fictional.** The underlying code logic is correct (the comment
  just explains *why* the OR is needed), but it establishes a false fact about how JWT
  `app_metadata` is populated. A future developer or security auditor reading this
  comment will look for that trigger, won't find it, and will doubt the entire design
  paragraph. Remove the trigger claim; keep only the factual statement: "super-admin
  promotion via `profiles.role` does NOT also set `app_metadata.role` to `'admin'`, so
  `auth_is_admin()` returns false for super-admins."

- **`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:836–841`** — The
  section (6j) comment claims the policy "falls back to the inventory_items.store_id
  chain for legacy rows whose catalog_id is not yet backfilled." The actual SQL at
  lines 854–903 does no such fallback — every policy condition is `EXISTS (SELECT 1
  FROM catalog_ingredients ci WHERE ci.id = ingredient_conversions.catalog_id AND ...)`.
  If any `ingredient_conversions` row has `catalog_id IS NULL`, the EXISTS evaluates
  to false and the row is invisible to everyone including admins. The comment
  describes non-existent behaviour, making this a misleading promise. Fix: either
  implement the fallback (`OR (catalog_id IS NULL AND public.auth_is_privileged())`)
  if legacy NULL rows remain, or rewrite the comment to say "P3 forced catalog_id
  NOT NULL on ingredient_conversions; there are no legacy NULL rows" and cite the P3
  migration filename.

- **`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:321–328`** — The
  post-migration invariant check (step ── 3 inside the DO block) only checks
  `role = 'admin' AND brand_id IS NULL`. It does not check `role = 'master' AND brand_id
  IS NULL`, even though `master` is treated as admin-equivalent by the
  `profiles_role_brand_consistent` CHECK at lines 339–345. Backfill at lines 283–286
  correctly covers all roles except `'super_admin'`, so in practice this invariant
  would have caught a `master` profile with NULL brand_id during the migration run.
  But the invariant as written will silently pass if a `master` profile slips through.
  Fix: change to `WHERE role IN ('admin', 'master') AND brand_id IS NULL`.

## Nits

- **`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:1–47`** — Top-of-file
  header explains "WHAT THIS MIGRATION DOES" with a numbered list. Per CLAUDE.md,
  comments should explain *why*, not *what*. The reference per-store hardening
  migration uses a short "why this was needed" header. Consider collapsing the
  WHAT-list into a "why 012a exists" paragraph. Low priority.

- **`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:354–383`** — The
  `user_stores_brand_match` trigger function uses `set search_path = public` (no
  `auth`). All other new helpers use `set search_path = public, auth`. Technically
  correct (trigger doesn't call `auth.uid()`), but the inconsistency could confuse a
  future reader. A one-line `-- no auth schema needed; trigger does not call auth.uid()`
  would explain it.

- **`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:411–417`** — DROP
  list for `brands` includes `brand_member_read_brands` and `super_admin_manage_brands`
  which P5 never created — these are pure forward-guard drops. Brief inline comment
  to distinguish from legacy-policy drops.

- **`supabase/seed.sql:115–117`** — Comment on the manager profile explains why
  `brand_id` is set ("so cross-brand store assignment via user_stores doesn't trip
  the user_stores_brand_match trigger"). This is exactly correct — flagging
  positively as the comment style that should be applied consistently.

- **`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:263–267`** — The
  pre-flight cross-brand check joins `profiles` on `p.brand_id IS NOT NULL AND
  s.brand_id IS NOT NULL`. At the point the DO block runs, `profiles.brand_id` is
  brand new with all NULLs. The pre-flight always counts 0 and passes trivially. Not
  a bug (correct result for current state) but worth acknowledging in the comment
  for honesty.

## Positive attestations (everything that was checked and passes)

- Seed.sql minimality: confirmed (3 profile inserts, each with `brand_id` + inline
  comment, no over-modification).
- Migration physical ordering (§7 risk #6): correct. Column add → helpers →
  pre-flight + backfill DO → CHECK → trigger → policy rewrites. The CHECK is added
  *after* the backfill as required.
- `master` role in helpers:
  - `auth_is_super_admin()` checks `role = 'super_admin'` only → correct.
  - `auth_can_see_brand()` delegates to `auth_is_super_admin()` then checks
    `profiles.brand_id` — `master` profiles have non-null brand_id per the CHECK,
    so they get brand-scoped access correctly.
  - `auth_is_privileged()` ORs `auth_is_admin()` (JWT `app_metadata.role IN
    ('admin','master')`) with `auth_is_super_admin()` — `master` profile gets
    `auth_is_admin() = true`, so `auth_is_privileged() = true`. Consistent.
- `auth_can_see_store()` update: super-admin short-circuit added as first branch,
  before `auth_is_admin()` and `user_stores` membership. Correct order
  (cheapest-to-evaluate first).
- Idempotency: every `ALTER TABLE ADD COLUMN` uses `IF NOT EXISTS`. Every function
  uses `CREATE OR REPLACE`. Every policy uses `DROP POLICY IF EXISTS` then `CREATE
  POLICY`. Backfill predicated on NULL. CHECK uses `DROP CONSTRAINT IF EXISTS`
  before re-adding. Trigger uses `DROP TRIGGER IF EXISTS`. Full idempotency confirmed
  by reading.
- Missed-table cross-check (spec §3 vs migration): all 12 tables in §3 covered
  (6a brands → 6l profiles). The §3 audit tables (`inventory_items`, `eod_*`, etc.)
  are correctly enumerated in the audit comment block at lines 988–1011 with
  rationale for why they're not modified.
