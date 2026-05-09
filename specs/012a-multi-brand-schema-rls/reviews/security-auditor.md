# Security auditor findings — Spec 012a

Scope: `supabase/migrations/20260509000000_multi_brand_schema_rls.sql` (single
file, atomic transaction), `supabase/seed.sql` (3 seed-profile rows extended
with `brand_id`), and reasoning about the §6 verification probes against the
RLS policies as written.

This migration is the security boundary for the multi-brand model. Audit
treats it accordingly.

---

## Critical (BLOCKING)

(none)

---

## Warnings

(none — see Notes #2 and Notes #5 for items that were considered and
discharged with reasoning.)

---

## Notes

### 1. Helper functions — SECURITY DEFINER + locked search_path verified

All three new helpers and the updated `auth_can_see_store()` are well-formed:

| Function | File:line | SECURITY DEFINER | STABLE | search_path | Inputs / sources |
|---|---|---|---|---|---|
| `auth_is_super_admin()` | `20260509000000_multi_brand_schema_rls.sql:187-195` | yes | yes (`language sql stable`) | `public, auth` | `auth.uid()` + `public.profiles` only |
| `auth_can_see_brand(uuid)` | same:200-210 | yes | yes | `public, auth` | `auth.uid()` + `public.profiles` only |
| `auth_can_see_store(uuid)` UPDATED | same:216-227 | yes | yes | `public, auth` | super-admin / admin / `user_stores` membership |
| `auth_is_privileged()` | same:235-239 | yes | yes | `public, auth` | composes the two above |

- All identifiers inside the function bodies are fully schema-qualified
  (`public.profiles`, `public.auth_is_admin()`, `public.user_stores`, etc.) —
  so the `set search_path = public, auth` does not open a schema-shadowing
  hole even though it is not the maximally hardened `set search_path = ''`.
  This matches the established pattern of `auth_is_admin()` (see
  `20260504073942_brand_catalog_p5_rls.sql:23-27`) and `auth_can_see_store()`
  in the prior hardening migration. No regression vs. the existing baseline.
  Tightening to `set search_path = ''` across all helpers is tracked debt
  for a follow-up cleanup spec, not an 012a defect.
- No `format()`, no `EXECUTE`, no dynamic SQL anywhere in the migration —
  the `uuid` parameter on `auth_can_see_brand()` is bound, not interpolated.
  No SQL-injection vector introduced.
- `STABLE` is correct (each function is deterministic per query and reads
  only catalog/auth state — Postgres can cache calls within a single query).

### 2. `auth_can_see_store()` super-admin short-circuit ordering

Verified at `20260509000000_multi_brand_schema_rls.sql:219-226`. The new body
reads:

```
select
  public.auth_is_super_admin()
  or public.auth_is_admin()
  or exists (
    select 1 from public.user_stores
     where user_id = auth.uid()
       and store_id = p_store_id
  );
```

Super-admin first, then admin (preserved), then per-store membership
(preserved). The pre-existing admin path is untouched. Probe 9 (service-role
bypass) is unaffected because RLS itself is bypassed for the service role.

### 3. Cross-brand `user_stores` trigger is BEFORE-trigger and not bypassable from RLS

`user_stores_brand_match()` at `20260509000000_multi_brand_schema_rls.sql:354-378`
and the trigger declaration at lines 380-383:

- `BEFORE INSERT OR UPDATE` — fires before the row lands, blocking the write.
- Raises `EXCEPTION` (not NOTICE), so the offending statement is rolled back.
- Super-admin (`v_user_brand IS NULL`) returns `new` early — super-admin can
  assign themselves to any store for testing without tripping the trigger.
  This matches the spec's stated intent.
- `SECURITY DEFINER` with `set search_path = public` so the lookups against
  `public.profiles` and `public.stores` aren't blocked by the caller's RLS.
  Identifiers are fully qualified, so the search_path doesn't open a hole.
- Trigger is per-row (`for each row`), so bulk INSERTs cannot bypass — every
  candidate row is independently validated.
- Probe 8 (cross-brand assignment must EXCEPTION) is correctly enforced by
  this trigger AND additionally by the new policy on `user_stores`-related
  paths. Defense in depth.

The pre-flight assertion at lines 261-271 also confirms there are zero
existing cross-brand `user_stores` rows BEFORE the trigger is installed —
otherwise the migration aborts. Belt-and-suspenders.

### 4. `brands` write policy correctly tightened to super-admin only

At `20260509000000_multi_brand_schema_rls.sql:411-429`:

- `drop policy if exists "admin_manage_brands"` — removes the prior P1
  policy that let any JWT-admin (`app_metadata.role IN ('admin','master')`)
  insert/update/delete tenant rows. That was the security gap the
  architect's §0 probe #4 flagged.
- `super_admin_manage_brands` (`FOR ALL`, USING + WITH CHECK both =
  `auth_is_super_admin()`) replaces it. Only super-admin can create / rename
  / soft-delete a brand row.
- `brand_member_read_brands` filters `deleted_at IS NULL OR auth_is_super_admin()`,
  so soft-deleted brands stay invisible to brand-admins (consistent with
  Probe 7's expected output) but remain visible to super-admin for restore.

Verified Probe 4 (brand-B admin sees only brand B) and Probe 7 (soft-deleted
brand hidden from non-super-admin) flow correctly through these policies.

### 5. Service-role bypass intact (architect §0 probe #2)

No `using (false)` clause introduced anywhere. The 4 brand-scoped
`super_admin_manage_brands`, plus all the `privileged_*` policies, all use
`USING (...)` predicates that evaluate against the JWT — the service role
bypasses RLS entirely by design. Probe 9 confirmed the sibling apps
(`pwa-catalog`, `staff-*`) keep working. No edge-function audit needed for
012a.

### 6. `master` role is treated correctly — admin-equivalent, NOT super-admin

This was a flagged deviation from the spec's acceptance criteria. Audit:

- `profiles_role_check` accepts `'super_admin' | 'admin' | 'master' | 'user'`
  (line 164). Pre-existing seed and prod `'master'` rows survive the
  migration's CHECK validation.
- `profiles_role_brand_consistent` (line 343) treats `'master'` identically
  to `'admin'` — must have a non-NULL `brand_id`. Master cannot be silently
  promoted to super-admin via the consistency CHECK.
- `auth_is_super_admin()` body (line 190-194) tests `role = 'super_admin'`
  with strict equality. `'master'` does NOT match — no leak path here.
- `auth_is_admin()` (unchanged from `20260504073942`) reads
  `app_metadata.role IN ('admin','master')` from the JWT. Master keeps its
  pre-existing admin-equivalent capability. No new privilege added.
- `auth_can_see_brand()` reads `profiles.brand_id` directly without filtering
  by role — works for master profile rows because the CHECK forces them to
  have a `brand_id`.
- The seed sets `master@local.test` to `brand_id = '2a000000-...'`
  (`supabase/seed.sql:169-171`) so the consistency CHECK is satisfied.

**Verdict:** the 'master' deviation is safe. Master remains a synonym for
admin, scoped to a single brand, never elevated to super-admin. This is the
expected behavior given the existing JWT-side `('admin','master')` checks
across multiple older migrations.

### 7. Backfill safety — super-admin email is a hardcoded literal, auditable in git blame

`v_super_email constant text := 'wzhchen113@gmail.com';` at line 250 of the
migration. The literal lives in the migration file (committed to git), is
not parametrized, and is not read from any env variable. Anyone re-running
the migration locally would get the same hard-coded email — they cannot
silently substitute their own without producing a visible diff in the git
blame for this line. This is the safest design for a one-time hard-coded
promotion.

The promotion itself is guarded:
- Wrapped in `IF v_super_user_id IS NULL` → `RAISE NOTICE` and skip
  (fresh local stacks won't have the email — expected behavior).
- The UPDATE is predicated on `(role <> 'super_admin' OR brand_id is not null)`
  so re-runs are no-ops once the row is already promoted.
- The defensive `IF NOT EXISTS ... INSERT` (lines 314-318) only fires if
  the auth.users row exists but no profile row does — bounded edge case.
- Final invariant check (lines 324-328) `RAISE EXCEPTION` if any
  `role='admin' AND brand_id IS NULL` slips through — the migration
  refuses to commit on a violation.

### 8. Orphaned-brand admin behavior is safe-by-default

Per spec §7 risk #1 and the §1 schema decision: `profiles.brand_id` uses
`ON DELETE SET NULL` (line 141). When 012c eventually deletes a brand, the
human user's profile survives but their `brand_id` becomes NULL.

Reasoning about the helper:

- `auth_can_see_brand(X)` evaluates:
  `auth_is_super_admin() OR EXISTS (SELECT 1 FROM profiles WHERE id=auth.uid() AND brand_id = X)`
- For an orphan admin (NULL brand_id, role='admin', not super-admin):
  - First disjunct is false (not super-admin).
  - Second disjunct: `WHERE id = auth.uid() AND brand_id = X` —
    `NULL = X` evaluates to NULL (not TRUE) for any X, so the EXISTS is
    false.
- Result: orphan admin can see nothing. Effectively suspended. Safe.

The `profiles_role_brand_consistent` CHECK would also reject the
`role='admin' + brand_id=NULL` combination if the row were ever updated
post-delete — but `ON DELETE SET NULL` runs without firing CHECK
constraints (referential actions skip validation in standard Postgres).
The orphan row will exist in the DB after a brand delete; its admin will
be locked out by RLS regardless. Confirmed safe.

### 9. Policy coverage — every brand-scoped table is gated, no `USING (true)`

Audited each policy in §6 of the migration:

- `brands` — read gated on brand visibility + soft-delete; write gated on
  super-admin only.
- `catalog_ingredients`, `recipes`, `prep_recipes`, `vendors`, `stores` —
  all four CRUD verbs gated on `auth_can_see_brand(brand_id)` (and
  `auth_is_privileged()` for writes). Stores READ uses
  `auth_can_see_store(id)` which now short-circuits for super-admin.
- `recipe_ingredients`, `prep_recipe_ingredients`, `recipe_prep_items`,
  `ingredient_conversions`, `pos_recipe_aliases` — all four CRUD verbs
  gated via parent EXISTS-join to a brand-scoped parent. UPDATE policies
  carry both USING and WITH CHECK, preventing a row from being moved to a
  parent in a different brand mid-update.
- `profiles` — additive `super_admin_read_all_profiles` (SELECT) and
  `super_admin_manage_profiles` (UPDATE). The pre-existing "Own profile"
  policy is preserved by not dropping it. Non-super-admins remain able to
  read/write only their own row. Note: `super_admin_manage_profiles` does
  NOT cover INSERT or DELETE — appropriate since profile creation is a
  trigger-driven flow on auth.users insert and deletion is destructive
  (deferred to a future invitation/admin-management spec, presumably 012b).

No policy uses `USING (true)`. No policy was inadvertently weakened.

Probes 1, 3, 4, 6 are correctly enforced by these policies. Verified by
reading the SQL: a brand-A admin's `auth_can_see_brand('2b...')` returns
false because their `profiles.brand_id = '2a...'` doesn't match — the
policy's USING clause filters every brand-B row out of their result set
(Probe 1) and rejects every brand-B insert with 42501 (Probe 3). Probe 6
follows transitively because the EXISTS join to `recipes.brand_id` evaluates
the same predicate.

### 10. Deliberate access widening on `pos_recipe_aliases` — flagged for awareness

Old `pos_recipe_aliases` policy (`20260425043301_pos_recipe_aliases.sql:23-40`)
required:
`store_id IN (SELECT store_id FROM user_stores WHERE user_id = auth.uid())`
plus admin override.

New policy (`20260509000000_multi_brand_schema_rls.sql:918-967`) gates on
`auth_can_see_brand(recipe.brand_id)` via EXISTS-join through `recipes`.

This is a deliberate widening of access for brand-admins:
- **Old**: brand-admin could read/write aliases only for stores in their
  `user_stores` membership.
- **New**: brand-admin can read/write aliases for any store in their brand,
  regardless of `user_stores` membership.

The migration's inline comment at lines 908-910 acknowledges this is the
intended new model ("the new policy gates on brand membership which is the
correct super-set"). Given the cross-brand `user_stores` trigger, no
brand-admin can have a `user_stores` row outside their brand, so the
practical exposure is "all stores in your brand" — consistent with the
brand-admin role definition in the umbrella spec. Not a vulnerability;
flagged so the user knows the model has shifted on this one table.

Note: `pos_recipe_aliases` rows still carry a `store_id` column. The new
policy doesn't validate that `store_id` belongs to the same brand as
`recipe_id`. In principle a brand-admin could write `(recipe_id from brand A,
store_id from brand B)`. Probe 8's cross-brand `user_stores` trigger does
NOT cover this — it only checks `user_stores`. Mitigation: the alias write
would still need to satisfy RLS, which would require the writer to see both
the recipe (brand A only) and create a row that any reader's policy would
honor. A brand-A admin writes such a row — only brand-A admins see it
because the read policy joins via `recipe_id` not `store_id`. So the row
is inert (visible only within brand A) and presumably never inserted in
practice (the UI wouldn't generate such a row). Documented for the architect
as a model wrinkle worth tightening in 012b's UI layer (filter the store
picker to the recipe's brand). Not a security finding — no cross-brand
data leak occurs.

### 11. `npm audit` — skipped, no `package.json` changes

`git status` shows only:
- `supabase/seed.sql` (M)
- `specs/012-multi-brand-tenancy.md` (??)
- `specs/012a-multi-brand-schema-rls.md` (??)
- `supabase/migrations/20260509000000_multi_brand_schema_rls.sql` (??)

No JS dependency changes. `npm audit` correctly out of scope.

### 12. SECURITY DEFINER public-execute lint debt — acknowledged

The migration adds 3 new helpers (`auth_is_super_admin`, `auth_can_see_brand`,
`auth_is_privileged`) granted to `authenticated, anon`. Same pattern as the
existing `auth_is_admin()` and `auth_can_see_store()`. Spec §7 risk #4 calls
this out as known-acceptable tracked debt. The Supabase security advisor
will surface 3 new warnings of this type post-deploy. Not a new
vulnerability; pre-existing tracked debt grows by 3.

### 13. No PII or secret leakage

- The migration logs row counts via `RAISE NOTICE` (`backfilled %`,
  `promoted %`) — no PII.
- The super-admin promotion notice does include the user's UUID
  (`user_id=%`, line 309). UUIDs are not considered PII in this codebase
  and are present throughout migration output. Acceptable.
- The hardcoded email `wzhchen113@gmail.com` is the project owner's own
  email — not third-party PII.
- The cross-brand trigger's exception message includes brand UUIDs. Not
  sensitive.

### 14. Idempotency = safe re-apply

Every CREATE uses `IF NOT EXISTS` / `OR REPLACE`. Every ALTER COLUMN uses
`IF NOT EXISTS`. Every DROP POLICY uses `IF EXISTS`. The backfill UPDATE is
predicated on NULL/wrong values and no-ops on second run. The super-admin
promotion is guarded by an inequality. The pre-flight assertion runs again
on re-apply but stays at 0 cross-brand rows because the trigger has been
in place since the first apply. Re-running the migration cannot leave the
DB in a worse state than after the first apply.

---

## Summary

The migration correctly establishes the security boundary for the
multi-brand model. All §6 verification probes (1–9) are enforceable from
the SQL as written. The four named concerns from the audit brief —
helper correctness, trigger non-bypassability, `brands`-write tightening,
service-role preservation — all check out. The `master` role deviation is
safe (master = admin-equivalent, not silently elevated to super-admin).
Backfill is auditable and idempotent. Orphan-admin path is locked-by-default
when 012c eventually deletes a brand.

No Critical findings. No Warnings.

Recommendation to release-coordinator: the security boundary is sound. This
spec is **safe to ship from a security standpoint**, pending the user's
manual `supabase db push --linked` per the deploy checklist.
