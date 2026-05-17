# Code review for Spec 043 (profiles RLS sweep) — re-review after fix pass

## Critical

None.

## Should-fix

None. All three Should-fix items from the prior review landed cleanly:

- **S1** (`delete-user/index.ts:134-136`): explicit `if (!callerProfile.brand_id)` guard added immediately before the `!==` comparison, returning `{ error: "forbidden: caller has no brand scope", status: 403 }`. Correctly closes the `null !== null` mispass window.

- **S2** (`delete-user/index.ts:96-100, 217-232`): `requireSameBrandOrSuperAdmin` consolidates to a single `select("brand_id, role")` round-trip. The `BrandGate` discriminated union carries `{ brand_id, role }` forward as `target`; the outer handler reads `brandGate.target?.role` for admin/master callers and only issues a second service-role read for `super_admin` callers (who were not subject to the original TOCTOU because the gate short-circuited for them). TOCTOU window eliminated for the paths that mattered.

- **S3** (`profiles_rls_sweep.test.sql:408-419`): arm 11 comment now accurately explains that `auth_can_see_brand(brand_id)` uses `EXISTS (… profiles.brand_id = p_brand_id)`, SQL `NULL = NULL` yields NULL (treated as false), so a `super_admin` row with `brand_id IS NULL` never satisfies the EXISTS from a brand-admin caller's perspective — SECURITY DEFINER bypasses RLS and counts correctly. Comment no longer contains the misleading "0 same-brand super_admins" framing.

## Nits

- `delete-user/index.ts` — opportunistic `!` elimination is clean. `gate.userId` and `gate.appRole` at lines 168 and 192 are accessed after the `gate.status !== 200` guard without non-null assertions. TS narrows correctly. No regressions introduced.

- `rls_hardening_followups.test.sql` — `(2026-05-17)` date was removed from the arm-9 patch comment. File is now internally consistent with the date-free style used elsewhere. Clean.

- `migrations/20260517060000_profiles_rls_sweep.sql:1` — no explicit `begin/commit` wrapper (carried forward from prior review). Supabase CLI wraps each migration in a transaction by default; sibling migrations are consistent in lacking explicit wrappers. Still a nit, still not elevated — pattern is uniform.

- `tests/profiles_rls_sweep.test.sql:197-198` — arm 4 fixture comment cross-references `auth_can_see_store_brand_scope.test.sql arm (3)` (carried forward from prior review). The referenced arm number is correct on current HEAD. Deferred to test-engineer for tracking.
