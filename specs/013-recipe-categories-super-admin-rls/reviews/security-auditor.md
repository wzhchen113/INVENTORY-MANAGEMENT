# Security audit for spec 013

Scope: single-file RLS policy migration that swaps the `recipe_categories`
WRITE policy from a raw JWT role check (`['admin','master']`) to
`public.auth_is_privileged()`. SELECT policy left unchanged. Mirrors the
prior-art shape from spec 012-ish follow-up `20260510020000_order_schedule_super_admin_rls.sql`.

## Files reviewed

- `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql` (new)
- `specs/013-recipe-categories-super-admin-rls.md`
- Prior art: `supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql`
- Helpers: `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:187-243`,
  `supabase/migrations/20260504073942_brand_catalog_p5_rls.sql:23-27`
- Pre-state policy: `supabase/migrations/20260424211733_security_fixes.sql:112-122`
- Table definition: `supabase/migrations/20260424211732_recover_undeclared_tables.sql:23-28`,
  `supabase/migrations/20260502071736_remote_schema.sql:151-153`
- `profiles` RLS for super-admin promotion: `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:978-988`
- `package.json` — not changed; `npm audit` skipped.

## Verification results

### Strict-superset claim — confirmed

Pre-state predicate (from `20260424211733_security_fixes.sql:121`):

```
(auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])
```

Post-state predicate (from `20260510030000_recipe_categories_super_admin_rls.sql:26-27`):

```
public.auth_is_privileged()
  := public.auth_is_admin() OR public.auth_is_super_admin()
  := coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = any (array['admin','master'])
     OR exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin')
```

Truth table:
- `app_metadata.role = 'admin'`: pre PASS / post PASS (via `auth_is_admin()`).
- `app_metadata.role = 'master'`: pre PASS / post PASS (via `auth_is_admin()`).
- `app_metadata.role = 'super_admin'` AND profile row exists: pre FAIL / post PASS (the intended fix).
- `app_metadata.role = 'user'` / unauth / anon: pre FAIL / post FAIL.
- NULL JWT role: pre FAIL (any() with NULL coerces away) / post FAIL (the post `coalesce` also folds to '' which fails the IN, and the profile-row branch only passes for `role='super_admin'`).

No principal loses access. No new principal is admitted other than the
intentional super-admin. Strict superset is correct.

### SELECT policy unchanged — confirmed

The migration only touches `"Admins can write categories"`. The read-side
policy `"Authenticated can read categories"` from `security_fixes.sql:115-117`
is not referenced. No data-exposure regression on read.

### Helper-function safety — confirmed

All four helpers in the call graph are SECURITY DEFINER with locked
search_path:

- `auth_is_admin()` — `set search_path = public, auth` (`brand_catalog_p5_rls.sql:23-27`).
- `auth_is_super_admin()` — `set search_path = public, auth` (`multi_brand_schema_rls.sql:187-195`).
- `auth_is_privileged()` — `set search_path = public, auth` (`multi_brand_schema_rls.sql:235-239`).
- `auth_can_see_store()` — `set search_path = public, auth` (`multi_brand_schema_rls.sql:216-227`) — not used by this policy but reviewed because it shares the call graph.

Search_path injection via `set role` / `set search_path` cannot reach into
these functions. Execute grants are `authenticated, anon` (line 241-243),
which is correct because the policy must be evaluable in any auth context;
the predicates themselves filter callers.

### `auth_is_super_admin()` — profile-table probe is NOT a privilege escalation

Implementer asked specifically. The function body is:

```
select exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin');
```

This passes only when `profiles.role = 'super_admin'` for the calling user.
The only paths that can write `profiles.role`:

1. The user's own row — but `profiles` RLS lets a user only manage their own
   row, and the `profiles_role_check` constraint plus the `super_admin_manage_profiles`
   policy at `multi_brand_schema_rls.sql:985-988` gate role-changing UPDATEs
   behind `auth_is_super_admin()`. Self-promotion via PostgREST is rejected
   at the policy level.
2. The `super_admin_manage_profiles` policy (line 985-988) — gated on
   `auth_is_super_admin()` itself, so only an existing super-admin can promote.
3. Bootstrap via `auth.users` direct SQL on the local DB or service-role —
   documented out-of-band path at line 97. Not a vector exploitable from
   client code.

Net: the probe is a server-side row read from a table the user cannot
self-update to `'super_admin'`. Not a privilege-escalation surface.

The implementer's note is correct.

### Idempotency / safety of DDL

`drop policy if exists` then `create policy` — re-runnable, safe for
existing databases. RLS-enabled state on `recipe_categories` is set by
`20260502071736_remote_schema.sql:153` and is not toggled by this migration.
No risk of dropping all policies and leaving the table accessible — there's
a separate SELECT policy and the DROP only targets the one named WRITE policy.

### CI gating

Per CLAUDE.md "Resolved questions / CI workflow", `db-migrations-applied.yml`
is not currently active. This migration is policy-only DDL and is non-destructive
(no row-level changes, no column changes, no permission changes that narrow
access). Manual verification via the four psql probes documented in spec
acceptance criteria is appropriate; nothing here would be caught by CI gating
that isn't covered by the probes.

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

- `specs/013-recipe-categories-super-admin-rls.md:31` — Documentation drift,
  not a security finding. The spec's positive-probe text reads
  `INSERT INTO recipe_categories (name, brand_id) VALUES (...)`, but
  `recipe_categories` does not have a `brand_id` column. The table is defined
  at `supabase/migrations/20260424211732_recover_undeclared_tables.sql:24-28`
  with only `id, name, created_at` and is keyed globally by name (see
  `src/lib/db.ts:1237-1250`). The migration itself does not reference
  `brand_id`, so the security posture is unaffected. The spec at line 67 also
  describes the table as "brand-scoped (has `brand_id`)" — same drift. Worth
  correcting for accuracy of the spec record, but does not block.

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
exposure regression.

No Critical, High, or Medium findings. One Low documentation note on the
spec text (not the migration).
