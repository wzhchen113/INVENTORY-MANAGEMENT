# Security audit for spec 069 — staff brand_id catalog-read fix (Option A)

**Verdict: PASS. Zero Critical, zero High, zero Medium. Two Low (advisory/non-blocking).**

Option A restores the spec-012a brand-isolation invariant for the staff rows the
post-012a invite flow left NULL-brand. I worked the threat model on the premise
that this is a security-boundary change (it backfills production `profiles` rows
that gate `auth_can_see_brand`), and I treated callers of the shared Supabase
backend as hostile. Every one of the eight assigned critical checks passed. The
fix does **not** over-grant: giving staff a `brand_id` widens exactly the read
set the spec intends (their own brand's `catalog_ingredients` + `vendors`), and
every write/privileged path keeps its `auth_is_privileged()` conjunct as the
load-bearing denial.

Files reviewed:
- `supabase/migrations/20260528020000_staff_brand_id_backfill.sql` (the fix)
- `src/lib/auth.ts` (`registerInvitedUser` stamp, :378-388)
- `src/lib/registerInvitedUser.test.ts` (jest divergence guard)
- `supabase/tests/staff_brand_id_backfill.test.sql` (pgTAP, plan(13)/13 arms)
- `supabase/migrations/20260509000000_multi_brand_schema_rls.sql` (012a invariant + `auth_can_see_brand`)
- `supabase/migrations/20260528010000_user_stores_brand_match_null_brand_guard.sql` (spec 068 single-brand trigger)
- `supabase/migrations/20260517050000_rls_hardening_followups.sql` (`profiles_self_brand_lock` trigger)
- `supabase/migrations/20260517060000_profiles_rls_sweep.sql` (profiles SELECT/DELETE gates)
- `supabase/migrations/20260510000000_invitations_brand_id.sql` (prior `get_pending_invitation`)
- `supabase/migrations/20260514150000_invitations_super_admin_rls.sql` (invitations write gate)
- `supabase/migrations/20260504072830_brand_catalog_p3_lockdown.sql` (`stores.brand_id` NOT NULL)
- `supabase/migrations/20260424211732_recover_undeclared_tables.sql` (`invitations.store_ids text[]`)
- `src/screens/staff/screens/EODCount.tsx` (the two brand-gated embeds)

---

## Critical (BLOCKS merge)

None.

---

## High (must fix before deploy)

None.

---

## Medium

None.

---

## Low

- `supabase/migrations/20260528020000_staff_brand_id_backfill.sql:177-186` — the
  backfill scalar subquery `set brand_id = (select distinct s.brand_id ...)`
  relies on pre-flight (a) having already proven `count(distinct s.brand_id) <= 1`
  for every targeted row. That reasoning is **correct and the subquery is safe**
  (see Check 1), but it is an *implicit* ordering dependency: pre-flight (a)
  `raise exception`s on multi-brand BEFORE the UPDATE runs, so by the time the
  UPDATE executes the scalar subquery is guaranteed single-row. Since the whole
  DO block is one transaction with no intervening writes, there is no TOCTOU
  window. No action required — flagged only so a future editor who reorders the
  block (moving the UPDATE above the multi-brand guard) understands the guard is
  load-bearing for the scalar subquery, not just for the AC. Cheap hardening if
  ever desired: add `limit 1` to the scalar subquery as belt-and-suspenders, but
  it is not necessary given the guard.

- `supabase/migrations/20260528020000_staff_brand_id_backfill.sql:252-258` /
  `src/lib/auth.ts:385-387` — an admin/master crafting a staff invitation could
  set `store_ids[1]` to a store in a *different* brand than their own, which makes
  `resolved_brand_id` (and thus the stamped `profiles.brand_id`) that other
  brand. This is **not a vulnerability** in this spec's threat model: (a) only
  `auth_is_privileged()` callers can INSERT invitations
  (`20260514150000_…:37-39`), so a `role='user'` staff user cannot craft one;
  (b) the resolved brand always derives from a *real* `stores` row's `brand_id`,
  never an attacker-chosen literal; (c) each invite's resolved brand derives only
  from THAT invite's own `store_ids` (RPC is `where i.email = lower(p_email)
  ... limit 1`), so there is no cross-invite leak; and (d) the resulting staff
  user would still need a matching `user_stores` grant, which the spec-068 trigger
  constrains to a single brand. An admin assigning a staff user to a store and the
  brand following that store is the intended operator action. Noted only to record
  that the "brand follows the assigned store" semantics were considered and are
  acceptable.

---

## Detailed findings on the eight mandatory critical checks

### 1. Backfill brand derivation is unambiguous + correct — PASS

The backfill derives `brand_id` from `(select distinct s.brand_id from
user_stores us join stores s on s.id = us.store_id where us.user_id = p.id)`
(`:178-183`). Three facts make this exact:

- **`stores.brand_id` is `NOT NULL`** since the P3 lockdown
  (`20260504072830_brand_catalog_p3_lockdown.sql:19`,
  `alter column brand_id set not null`). So a staff user's `user_stores` can
  never resolve to a NULL-brand store — there is no NULL-brand-store edge case
  that could evade the multi-brand guard or poison the `distinct`.
- **Pre-flight (a) fails LOUD on multi-brand** (`:128-144`): it counts
  `role='user' AND brand_id is null` users whose `user_stores` span
  `count(distinct s.brand_id) > 1` and `raise exception`s, refusing to apply.
  It does **not** silently pick one. This is the §3a fail-closed posture and it
  does exactly what the prompt required. The WHERE clause of the pre-flight
  (`p.role='user' AND p.brand_id is null`) matches the WHERE clause of the
  UPDATE byte-for-byte in intent, so the same row set is checked and then
  mutated — no row the UPDATE touches escapes the multi-brand assertion.
- **Could a prod NULL-brand staff user have stores spanning >1 brand (pre-068
  rows)?** If yes, pre-flight (a) catches it and blocks the migration — it does
  not stamp a wrong brand. The spec's §8 prod read-only pre-flight recorded
  exactly 1 affected row ("Charles" → 2AM, single-element `derived_brands`),
  zero multi-brand staff, so this is empirically a no-op today, but the assertion
  is the contract regardless of CI (and there is no migrations-applied CI gate —
  CLAUDE.md). Because pre-flight (a) guarantees `count(distinct) <= 1` for every
  targeted row, the `select distinct` scalar subquery in the UPDATE returns
  exactly one row and cannot raise "more than one row returned by a subquery."

### 2. The invite-flow stamp cannot stamp the wrong brand or leak across an invite — PASS

- **Staff invite resolves brand from THAT invite's stores only.**
  `get_pending_invitation` computes `resolved_brand_id = coalesce(i.brand_id,
  (select s.brand_id from stores s where ... s.id = (i.store_ids[1])::uuid))`
  (`:250-259`), scoped by `where i.email = lower(p_email) ... limit 1`
  (`:262-265`). The derived brand is the real brand of the invite's own first
  store — not a global default, not another invite's value.
- **Admin path reads `invitation.brand_id` only.** `auth.ts:385-387`:
  `brand_id: invitation.role === 'user' ? (invitation.resolved_brand_id ??
  invitation.brand_id ?? null) : (invitation.brand_id ?? null)`. The
  `role !== 'user'` branch never reads `resolved_brand_id`. The jest divergence
  guard `registerInvitedUser.test.ts:150-170` constructs a contrived admin row
  where `brand_id` (brand A) and `resolved_brand_id` (brand B) differ and
  asserts the INSERT used brand A — locking the admin path against a future
  regression. An admin invite cannot accidentally pull a staff-derived brand.
- **No path lets a crafted payload set an arbitrary brand_id.** `invitations`
  INSERT requires `auth_is_privileged()` (`20260514150000_…:37-39`), so a
  `role='user'` caller cannot craft an invitation. The resolved brand is always
  a genuine `stores.brand_id`, never an attacker literal. (Operator-chosen store
  → operator-chosen brand is intended; see Low #2.)

### 3. `auth_can_see_brand` semantics NOT broadened — PASS

`auth_can_see_brand(uuid)` is defined exactly **once** in the codebase, at
`20260509000000_multi_brand_schema_rls.sql:200`, and is **never** redefined by
any later migration (confirmed: the only `create ... function auth_can_see_brand`
hit across all migrations is that single line). The spec-069 migration's only
mentions of the helper are in comment text — there is no `create or replace
function public.auth_can_see_brand` in `20260528020000_…`. This is the entire
point of Option A vs Option B, and it holds: only the `profiles.brand_id` DATA
changed; the brand-isolation helper body is untouched.

### 4. Cross-brand isolation preserved (the 012a invariant) — PASS

`auth_can_see_brand` is unchanged (Check 3), so a backfilled staff user
(`brand_id = 2AM`) still gets `auth_can_see_brand(Baltimore/foreign) = false` —
their `profiles.brand_id` does not equal the foreign brand and they are not a
super_admin. pgTAP arm (3) (`staff_brand_id_backfill.test.sql:206-214`) proves the
fixed staff user reading brand-B catalog returns 0 rows AND
`auth_can_see_brand(B) = false`. pgTAP arm (7) (`:293-305`) proves brand-A admin
still sees 0 brand-B catalog AND 0 brand-B vendors (the 012a probes-1–7
regression guard). Isolation intact.

### 5. Staff write-denial preserved — PASS

Every WRITE policy on `catalog_ingredients` / `recipes` / `vendors` / etc. is
`auth_is_privileged() AND auth_can_see_brand(...)`
(`20260509000000_…:450-473, 494-517, 579-602`). A `role='user'` staff user is
NOT privileged (`auth_is_privileged()` = `auth_is_admin() OR auth_is_super_admin()`,
both false for staff). Giving staff a `brand_id` makes the second conjunct true
but leaves the first conjunct false → every write stays denied. pgTAP arm (4)
(`:221-230`) proves a brand-stamped staff user's `INSERT into catalog_ingredients`
is RLS-denied (`42501`). The `brand_id` stamp grants zero write. This is the key
"did we over-grant?" check and it is clean.

### 6. Does the brand_id stamp grant staff MORE than catalog reads? — PASS (scoped to their own brand)

A brand_id-having staff user now passes `auth_can_see_brand(theirBrand)`
everywhere it gates a SELECT. Enumerated reachable reads (from the design's §1a
table, re-verified against the policy text):

- `catalog_ingredients` SELECT — **intended** (THE fix).
- `vendors` SELECT — **intended** (the latent fallback-masked embed; AC #2).
- `brands` SELECT — staff can now read their own brand's row
  (`20260509000000_…:422-427`); benign (lets the app resolve brand name). Still
  gated `auth_can_see_brand(id) AND (deleted_at IS NULL OR super)`, so they see
  ONLY their own brand, never a foreign or soft-deleted brand.
- `recipes`, `prep_recipes`, `recipe_ingredients`, `prep_recipe_ingredients`,
  `recipe_prep_items`, `ingredient_conversions`, `pos_recipe_aliases` SELECT —
  now RLS-reachable for staff **for their own brand only**. Not queried by the
  staff app today (PM survey + design §1a), and acceptable under the threat model
  (staff are trusted within their store's brand). Crucially, every one of these
  is scoped by `auth_can_see_brand(brand_id)` against the staff user's *single*
  brand — **not all brands**. A staff user reading any of these still gets only
  their own brand's rows; cross-brand reads remain denied (Check 4). This is the
  same surface Option B would have opened, but Option A scopes it to the user's
  actual brand rather than every brand they have a store in (they have stores in
  only one brand anyway, post-068, so the two are equivalent in practice).
- **`profiles` SELECT does NOT widen.** This was the sharpest "did the stamp leak
  more" risk. The profiles SELECT policy
  (`20260517060000_profiles_rls_sweep.sql:96-101`) is
  `(auth_is_privileged() AND auth_can_see_brand(brand_id)) OR id = auth.uid()`.
  A brand_id-having staff user is NOT privileged, so the brand arm never admits
  them — they can read ONLY their own profile via `id = auth.uid()`, exactly as
  before. **Giving staff a brand_id does NOT let them enumerate other staff or
  admins in their brand.** Likewise `profiles` UPDATE
  (`20260517050000_…:99-108`) and DELETE (`20260517060000_…:127-131`) keep the
  `auth_is_privileged()` conjunct on the brand arm — no new write/delete on other
  profiles.

Conclusion: the expanded read set is all intended/acceptable and is scoped to
the staff user's own brand. No cross-brand read leaks.

### 7. `get_pending_invitation` DROP+CREATE window — PASS

The migration `drop function if exists public.get_pending_invitation(text)`
(`:226`) then `create function ...` (`:228`) within the **same migration
transaction**. Supabase migrations run transactionally, so no client observes a
missing function mid-migration — the DROP and CREATE commit atomically. This is
the identical, already-shipped pattern from
`20260510000000_invitations_brand_id.sql:40-62` (which the spec cites). The
return-type column-set change (`42P13`) genuinely requires DROP+CREATE rather
than CREATE OR REPLACE; the choice is correct. `grant execute ... to anon,
authenticated` is re-asserted (`:278`), so anon can still call it for the
register flow.

### 8. Backfill idempotency + re-run safety — PASS

- **Backfill UPDATE** is predicated on `p.brand_id is null` (`:185`), so a second
  run matches zero rows → no-op. Re-running cannot corrupt: it never overwrites a
  brand_id that was already set, and the multi-brand pre-flight / post-backfill
  invariant assertions are read-only counts that pass on a clean second run
  (`v_backfilled = 0`, `v_remaining = 0`).
- **`get_pending_invitation`** uses `drop function if exists` + `create function`
  — idempotent on re-run.
- **Trigger interactions confirmed safe:** the backfill is a `profiles` UPDATE,
  so `user_stores_brand_match_trg` (fires on `user_stores` writes only) does not
  fire. The `profiles_self_brand_lock` / `assert_brand_id_immutable_for_self`
  trigger (`20260517050000_…:196-245`) is SECURITY INVOKER and gates on
  `old.id = auth.uid()`; during the migration `current_user = postgres` and
  `auth.uid() = NULL`, so neither the self-edit branch nor the
  `current_user in ('authenticated','anon')` cross-user branch fires — the
  migration's claim at `20260528020000_…:78-82` is verified correct. The
  `profiles_role_brand_consistent` CHECK (`20260509000000_…:343-348`) has an
  unconditional `(role='user')` arm, so setting a brand_id on a staff row is
  constraint-legal.

---

## PII / secrets / dependencies

- **No secrets** in the migration, `auth.ts` change, or tests. No service-role key
  or service token reachable from the client. No `EXPO_PUBLIC_*` change.
- **No PII leakage.** The migration's `raise notice` lines log staff profile `id`
  and `name` for the zero-store skip path (`:167`) — these go to the Postgres
  server log during a migration run by an operator, not to any client API
  response, and `name` is already operator-visible in the admin UI. Acceptable
  for a one-time migration NOTICE; not surfaced to end users.
- **No `npm audit` run — `package.json` did not change** in this spec (working
  tree shows only `src/lib/auth.ts`, the new migration, the two test files, and
  the spec). Dependency surface untouched.

### Dependencies

no package.json changes — skipped

---

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 2 Low (both
advisory/non-blocking — an implicit-but-correct ordering dependency in the
backfill scalar subquery, and the intended "brand follows the assigned store"
invite semantics). Option A is sound: `auth_can_see_brand` is provably untouched
(defined once in 012a, never redefined), the backfill brand derivation is
unambiguous (stores.brand_id is NOT NULL + spec-068 single-brand guarantee +
fail-loud multi-brand pre-flight), staff write-denial is preserved (every write
keeps its auth_is_privileged() conjunct), profiles SELECT does NOT widen so staff
cannot enumerate other profiles, cross-brand isolation (012a) holds, and the
DROP+CREATE is transactional. No findings block; spec may advance to
READY_FOR_DEPLOY on the security axis.
payload_paths:
  - specs/069/reviews/security-auditor.md
