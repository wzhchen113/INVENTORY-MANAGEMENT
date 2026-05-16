# Code review — spec 013

Re-review on the amended spec (AC9 deferred per CLAUDE.md; `brand_id` doc references removed). Migration code is unchanged from the original submission.

Reviewer: code-reviewer
Status at review time: READY_FOR_REVIEW

## Critical

None.

## Should-fix

None.

## Nits

- `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql:22–27` — The `drop policy if exists` / `create policy` pair is not wrapped in an explicit `BEGIN; ... COMMIT;` block. Postgres DDL is transactional, so a session abort between the two statements would leave `recipe_categories` with no WRITE policy at all until the migration is re-run. The prior-art file `20260510020000_order_schedule_super_admin_rls.sql` has the same omission, so this is a consistent project pattern rather than a local deviation. No action required unless the project decides to standardise on explicit transaction wrappers in migrations.

- `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql:1–20` — Comment block is accurate and appropriately detailed for a one-policy patch: root cause, fix rationale, helper provenance, and the SELECT-untouched decision are all explained. Above the quality bar for this class of change. No improvement needed.

No findings from application code, store slices, or legacy file checks — this is a migration-only change, as intended.
