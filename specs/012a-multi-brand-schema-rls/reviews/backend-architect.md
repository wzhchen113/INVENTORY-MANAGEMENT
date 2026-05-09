# Backend architect post-impl review — Spec 012a

Scope of review: confirm the multi-brand schema + RLS implementation matches the design intent in `specs/012a-multi-brand-schema-rls.md` §1–§7, and judge the developer-flagged `'master'` role deviation. Files reviewed: the migration, `supabase/seed.sql`, the spec build notes, and the pre-existing `auth_is_admin()` / `auth_can_see_store()` helpers it builds on.

## Critical drift

None. The implementation matches the design's security boundary intent. The `'master'` deviation does NOT downgrade existing master users (see "Acceptable deviations" §1 below for the helper-chain trace).

## Acceptable deviations

1. **`'master'` added to the role CHECK and to `profiles_role_brand_consistent` (treated as admin-equivalent).** Spec §1 acceptance criterion called for `'super_admin' | 'admin' | 'user'` only. The dev added `'master'` because real master profile rows exist (`supabase/seed.sql:170`, plus the JWT-side `('admin','master')` pattern across multiple existing migrations).

   I confirmed the deviation does not regress permissions:
   - `auth_is_admin()` (unchanged from pre-existing migration `20260424211733_security_fixes.sql`) reads JWT `app_metadata.role IN ('admin','master')`. A `'master'` user logging in carries `app_metadata.role = 'master'` (seed.sql:150) → `auth_is_admin()` returns true.
   - `auth_is_privileged()` (new in this migration, line 235-239) is `auth_is_admin() OR auth_is_super_admin()`. So a `'master'` user passes `auth_is_privileged()`.
   - Every brand-scoped write policy uses `auth_is_privileged() AND auth_can_see_brand(brand_id)`. With master's `profiles.brand_id` set to the 2AM brand by the seed (line 171) AND backfilled in prod by the §4 DO block (line 283-286 of migration: `where brand_id is null and role <> 'super_admin'`), `auth_can_see_brand` returns true. Master keeps full write access to its brand.
   - For READ: `auth_can_see_brand(brand_id)` returns true for any profile whose `brand_id` matches the row's brand_id. Master's brand_id is set, so reads work.

   Net: master is a brand-admin equivalent post-migration. No user is downgraded. The deviation is a correct "design met reality" fix and the migration's inline comment (line 151-161) documents the rationale clearly. The follow-up question of whether `'master'` should be unified with `'admin'` is correctly punted to a future cleanup spec.

2. **`recipes` and `prep_recipes` policy drops include both legacy `"Store access"` and several brand-era policy names.** Design §3 only listed the P5-era write policies. The dev defensively `drop policy if exists` on a wider set including init-schema names. This is harmless and correct given the migration history — strictly safer than the design's narrower drop list.

3. **`vendors` legacy policy `"Vendors admin only"` from init-schema (init line 284) is dropped.** Design didn't enumerate this drop explicitly, but the policy reads `(select role from profiles where id = auth.uid()) = 'admin'` — which would have rejected master writes after this migration regardless. Dropping it as part of the rewrite is correct and necessary.

4. **`pos_recipe_aliases` rewrite gates on parent recipe's brand_id rather than its own `store_id`.** Design §3 said "gate via store (existing per-store RLS)" but the dev chose to gate on the parent recipe's brand instead. I judge this acceptable and arguably tighter: an alias is meaningful only if the recipe is visible to the caller; brand-scoping the alias keeps it consistent with the recipe-write story and removes a per-store-membership exception. Combined with the cross-brand `user_stores` trigger, the brand-gate is a strict super-set of the store-gate. No regression.

5. **`comment on column public.profiles.brand_id` runs before the role/brand-consistency CHECK is added.** Cosmetic ordering — comments are metadata-only, no validation. Fine.

6. **`user_stores_brand_match` trigger function declared `SECURITY DEFINER` with `set search_path = public`.** Design §1 didn't explicitly require SECURITY DEFINER on this trigger. The dev added it. Acceptable: the trigger reads `profiles` and `stores` via direct SELECT and runs as the row-inserter; SECURITY DEFINER ensures the trigger can read regardless of the inserter's RLS visibility on `profiles`. Without it, an admin RLS-restricted from reading another profile (post-012b) could silently bypass the trigger via NULL lookups. The `search_path` lockdown matches the codebase pattern.

## Should-fix

1. **Defensive insert into `profiles` after super-admin promotion (migration lines 314-318) lacks the `name` column required by the init schema.** It supplies `'Super Admin'` for `name` — fine, that satisfies the NOT NULL — but the row also omits `initials` and `color` which are nullable with defaults so this is OK. Marking as "verify" rather than fix: confirm by reading init schema lines 20-28. Defaults exist for `color` (`'#378ADD'`) and `status` (`'active'`); `initials` is nullable with no default. The insert is valid. Withdrawn — no action needed; flagging here only because I traced through it.

2. **Probe 6 expectation in build notes table differs from probe 6 spec.** Build notes line 733 says "used master@local.test, brand-A admin-equivalent" for the recipe_ingredients probe. Spec §6 Probe 6 was written for a brand-A admin (`TOKEN_A`). The substitution is fine — master is admin-equivalent for the 2AM brand — but it means we don't have a probe result captured against `TOKEN_A` specifically. Low-risk because §6 Probe 1 (catalog) used `TOKEN_A` and passed; the helper logic is identical. Not blocking.

3. **The migration's verification probe block (lines 47-132) is verbatim from spec §6.** No drift. Suggest the user keep these comments in the migration even after merge — they're the reproducible verification recipe and tying them to the migration file is good. (The dev's handoff offered to externalize them to a sibling `docs/specs/012a-verification.md`; either is fine.)

## Notes

- **§1 schema additions: all present and correct.** `profiles.brand_id` (line 140-141, ON DELETE SET NULL ✓), `brands.deleted_at` (line 168-169), `profiles_role_check` accepting the four roles (line 162-164, with `'master'` added — see Acceptable deviations §1), `profiles_role_brand_consistent` (line 338-345) added AFTER the backfill per spec §7 risk #6. The two new indexes (line 175-176) match design.

- **§2 helpers: all four functions present and correct.** `auth_is_super_admin()` (line 187-195), `auth_can_see_brand()` (line 200-210), `auth_can_see_store()` rewritten with super-admin short-circuit (line 216-227), `auth_is_privileged()` (line 235-239). All `SECURITY DEFINER`, all `set search_path = public, auth`, all granted to `authenticated, anon` (line 241-243). Signatures match design exactly.

- **§3 RLS rewrites: all 11 tables covered.** Cross-checked against design §3:
  - Direct-brand_id tables: `brands` (6a), `catalog_ingredients` (6b), `recipes` (6c), `prep_recipes` (6d), `vendors` (6e), `stores` (6f). All 6 covered.
  - Parent-EXISTS tables: `recipe_ingredients` (6g), `prep_recipe_ingredients` (6h), `recipe_prep_items` (6i), `ingredient_conversions` (6j), `pos_recipe_aliases` (6k). All 5 covered.
  - `profiles` (6l): super-admin read-all + super-admin update-all added; init-schema "Own profile" left alone. Matches design.
  - **No table missed; no extra brand-scoped table mistakenly added.**

- **§3 audit-list (per-store tables NOT modified): correctly enumerated** in the migration's tail comment (line 988-1011), exactly matching the design's list. The reasoning that `auth_can_see_store()`'s super-admin short-circuit + the cross-brand `user_stores` trigger make these tables transitively brand-scoped is sound.

- **§4 backfill: matches design.** Pre-flight cross-brand check (line 261-271, RAISE EXCEPTION on >0 violations), backfill of all non-super-admin profiles to the 2AM sentinel (line 283-288), super-admin promotion guarded by a `RAISE NOTICE` if email not found (line 299-301), defensive profile-row-creation if auth.users exists but profile doesn't (line 314-318), final invariant check that no `'admin'` row has NULL brand_id (line 324-328). Idempotent UPDATEs are predicated on NULL/wrong values. Identical shape to the design.

  Gap acknowledged: the invariant check at line 324 looks for `role = 'admin'` only, not `role IN ('admin', 'master')`. After the §4 backfill this is still correct because the backfill UPDATE (line 283-286) caught all non-super-admin profiles regardless of role — `'master'` rows were also moved off NULL. The invariant could be tightened to also assert `'master'` has non-NULL brand_id, but the `profiles_role_brand_consistent` CHECK constraint (line 343) catches it from that point forward. Not a defect.

- **§7 risk #6 ordering respected.** File order: ADD COLUMN (line 140) → helper functions (line 187-243) → DO block backfill (line 247-329) → ADD CHECK CONSTRAINT (line 338-345) → trigger + policy rewrites (line 354+). Exactly the design's mandated order. The CHECK runs against post-backfill data so cannot reject pre-existing 'admin' NULL rows.

- **Cross-brand `user_stores` trigger present and correct.** BEFORE INSERT OR UPDATE (line 381-383), super-admin (NULL `v_user_brand`) bypass via early return (line 369-371), RAISES EXCEPTION on cross-brand mismatch (line 372-375). Design intent met.

- **Realtime publication untouched.** Confirmed by reading the migration end-to-end — no `alter publication supabase_realtime add/drop`. The `docker restart supabase_realtime_imr-inventory` ritual does NOT apply to this migration.

- **seed.sql changes (lines 66-68, 118-121, 169-172) add `brand_id` to all three local-dev profile inserts.** Required by the new `profiles_role_brand_consistent` CHECK. Local-dev only (the seed file is never applied to prod). Inline comments document the rationale. Acceptable.

- **Bonus extras worth flagging (not in design, dev added defensively):**
  - The migration's inline verification-probe comment block (lines 47-132) is a verbatim copy of spec §6. Useful to colocate; redundant with spec but not wrong.
  - The `drop policy if exists` lists for each table include legacy names beyond what the design enumerated (e.g., `"Store access"` on tables that may or may not have ever had it). This is defense-in-depth and harmless.
  - The migration's inline comment at line 151-161 documenting the `'master'` role decision is excellent — exactly the kind of in-file rationale that prevents future architects from second-guessing the deviation.

- **Nothing in the design was silently dropped by the implementation.** Every §1-§5 element is present.

## Verdict

**Implementation matches design — acceptable drift only.** The `'master'` role addition is a correct "design met reality" fix; my pre-design probe missed that real `'master'` profile rows exist (only the JWT-side check was noted), and the dev's catch is sound. The helper chain (`auth_is_admin` → JWT `'master'` accepted → `auth_is_privileged` → write policies pass) preserves master's existing privileges. No user is downgraded.

The migration is ready for review by the other reviewers and, after release-coordinator approval, ready for the user to push to prod via `supabase db push --linked`.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 critical, 6 acceptable deviations, 0 should-fix actionable. The `'master'` role deviation is endorsed.
payload_paths:
  - specs/012a-multi-brand-schema-rls/reviews/backend-architect.md
