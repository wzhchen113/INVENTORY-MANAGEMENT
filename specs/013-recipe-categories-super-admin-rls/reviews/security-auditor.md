# Security audit for spec 013

Re-review of the amended spec. Migration code is unchanged from the first
pass; the spec text was edited to retire the prior Low documentation finding.

Scope: single-file RLS policy migration that swaps the `recipe_categories`
WRITE policy from a raw JWT role check (`['admin','master']`) to
`public.auth_is_privileged()`. SELECT policy left unchanged. Mirrors the
prior-art shape from `20260510020000_order_schedule_super_admin_rls.sql`.

## Files reviewed

- `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql` (unchanged from prior pass)
- `specs/013-recipe-categories-super-admin-rls.md` (amended)
- Prior art: `supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql`
- Helpers: `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:187-243`,
  `supabase/migrations/20260504073942_brand_catalog_p5_rls.sql:23-27`
- Pre-state policy: `supabase/migrations/20260424211733_security_fixes.sql:112-122`
- Table definition: `supabase/migrations/20260424211732_recover_undeclared_tables.sql:23-28`
- `profiles` RLS for super-admin promotion: `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:978-988`
- `package.json` — not changed; `npm audit` skipped.

## Re-review notes — amended-spec verification

### Prior Low (documentation drift) — resolved

The previous pass flagged a doc-only drift on the spec at lines 31 and 67:
spec text described a `brand_id` column that does not exist on
`recipe_categories`. Confirmed resolved:

- Spec line 31 now reads:
  `Positive psql probe: with a JWT carrying app_metadata.role = 'super_admin', INSERT INTO recipe_categories (name) VALUES (...) succeeds.`
  No `brand_id` reference. Matches the real `(id, name, created_at)` schema.
- Spec line 67 now reads:
  `Per-store or admin-global: recipe_categories is **global** (no brand_id column — schema is id, name, created_at). The helper auth_is_privileged() covers admin / master / super_admin uniformly, which is the desired behavior.`
  Explicit, accurate description.

No other occurrences of `brand_id` in the spec body. Drift closed.

### Strict-superset claim — re-confirmed against committed migration

Migration content at `20260510030000_recipe_categories_super_admin_rls.sql:22-27`
is identical to the prior pass:

```
drop policy if exists "Admins can write categories" on public.recipe_categories;

create policy "Admins can write categories"
  on public.recipe_categories for all
  using      (public.auth_is_privileged())
  with check (public.auth_is_privileged());
```

Pre-state predicate (from `20260424211733_security_fixes.sql:121-122`):

```
(auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])
```

Post-state predicate resolves to:

```
public.auth_is_privileged()
  := public.auth_is_admin() OR public.auth_is_super_admin()
  := coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = any (array['admin','master'])
     OR exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin')
```

Truth table holds unchanged:

- `app_metadata.role = 'admin'`: pre PASS / post PASS (via `auth_is_admin()`).
- `app_metadata.role = 'master'`: pre PASS / post PASS (via `auth_is_admin()`).
- `app_metadata.role = 'super_admin'` AND profile row exists: pre FAIL / post PASS (the intended fix).
- `app_metadata.role = 'user'` / unauth / anon: pre FAIL / post FAIL.
- NULL JWT role: pre FAIL (any() with NULL coerces away) / post FAIL (post `coalesce` folds to '' and fails the IN; profile-row branch only passes for `role='super_admin'`).

No principal loses access. No new principal is admitted other than the
intentional super-admin. Strict superset is correct.

### SELECT policy unchanged — confirmed

The migration only targets `"Admins can write categories"`. The read-side
policy `"Authenticated can read categories"` from `security_fixes.sql:115-117`
(`using (auth.uid() is not null)`) is untouched. No data-exposure regression
on read.

### Helper-function safety — confirmed

All helpers in the call graph are SECURITY DEFINER with locked search_path:

- `auth_is_admin()` — `set search_path = public, auth` (`brand_catalog_p5_rls.sql:23-27`).
- `auth_is_super_admin()` — `set search_path = public, auth` (`multi_brand_schema_rls.sql:187-195`).
- `auth_is_privileged()` — `set search_path = public, auth` (`multi_brand_schema_rls.sql:235-239`).

Execute grants are `authenticated, anon` (line 241-243), which is correct
because the policy must be evaluable in any auth context; the predicates
themselves filter callers. Search_path injection cannot reach into these
functions.

### `auth_is_super_admin()` profile probe — not a privilege escalation

Re-verified. The function reads `profiles.role` for the calling `auth.uid()`.
Write paths to `profiles.role`:

1. Self-update is rejected at the policy level — the `super_admin_manage_profiles`
   policy at `multi_brand_schema_rls.sql:985-988` gates role-changing UPDATEs
   behind `auth_is_super_admin()` itself.
2. Promotion requires an existing super-admin (or out-of-band bootstrap via
   service-role / direct SQL on the local DB).

Not a client-exploitable escalation vector.

### Idempotency / safety of DDL

`drop policy if exists` then `create policy`. Re-runnable. RLS-enabled state
on `recipe_categories` is set elsewhere and is not toggled here. The DROP
only targets the one named WRITE policy; the SELECT policy stays in place,
so even mid-migration the table remains gated.

### CI gating

Per CLAUDE.md, `db-migrations-applied.yml` is not currently active. This
migration is policy-only DDL, non-destructive (no row-level changes, no
column changes, no permission narrowing). Manual verification via the four
psql probes in the spec acceptance criteria is appropriate.

### `npm audit`

`package.json` not changed. Skipped.

## Findings

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

None. The prior pass's Low (doc drift on `brand_id`) is resolved by the spec
amendments at lines 31 and 67.

### Dependencies

No `package.json` changes — `npm audit` skipped.

## Verdict

The migration achieves exactly what the spec describes: a strict-superset
WRITE policy update that admits super-admins to `recipe_categories`
INSERT/UPDATE/DELETE while preserving admin/master access and not touching
the SELECT policy. Helper functions are correctly hardened (SECURITY DEFINER,
locked search_path). The `auth_is_super_admin()` profile probe is not a
privilege-escalation surface — promotion to `super_admin` requires an
existing super-admin or the documented bootstrap path. No RLS gap, no data
exposure regression. The prior Low documentation drift is closed.

Clean re-review: zero Critical, zero High, zero Medium, zero Low.
