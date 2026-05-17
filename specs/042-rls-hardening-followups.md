# Spec 042: RLS hardening — order_schedule store-id gate + profiles cross-brand-admin lockdown + self-update with-check

Status: READY_FOR_REVIEW

## User story
As a super-admin operating a multi-brand environment, I want every RLS
WRITE policy that touches per-store or per-brand rows to consult the
brand-scoped visibility helpers (not just `auth_is_privileged()` or raw
JWT role checks) so that a brand-admin cannot reach across brands to
INSERT/UPDATE/DELETE foreign rows. The three carry-forward findings from
Spec 041's security audit (1 High, 2 Medium) close the last known
cross-brand WRITE paths and add defense-in-depth on the self-update
profile policy.

## Bug being fixed (production, post-Spec-041)
Spec 041 tightened READ visibility for stores by adding the brand
arm to `public.auth_can_see_store(uuid)`. Three WRITE-side gaps remain:

1. **`order_schedule` WRITE policy missing per-store gate.**
   `supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql:28-31`
   defines `"Admins can write order_schedule"` with
   `using (public.auth_is_privileged()) with check (public.auth_is_privileged())`.
   No `auth_can_see_store(store_id)` check. A brand-A admin can
   `INSERT/UPDATE/DELETE` any `order_schedule` row in any brand by
   crafting the `store_id`. (Verified by security-auditor Round-4.)

2. **`"Admins can update any profile"` permits cross-brand profile writes.**
   `supabase/migrations/20260502071736_remote_schema.sql:390-395`
   defines the policy as
   `using ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'master'::text])) OR (id = auth.uid()))`.
   No brand check. A brand-A admin (JWT role `admin`) can `PATCH`
   brand-B users' profile columns (e.g., `name`, `dark_mode`,
   `notifications_enabled`, `locale`, `sidebar_layout`). The
   `profiles_self_brand_lock` trigger from Spec 041 only covers
   **self-edits** — it does NOT cover cross-user writes. The
   `profiles_sync_role` trigger blocks `role` escalation; everything
   else leaks.

3. **`"Users can update own profile"` has no `WITH CHECK`.**
   `supabase/migrations/20260502071736_remote_schema.sql:417-422` is
   `using (id = auth.uid())` with no `WITH CHECK` clause. Postgres
   permits the row-predicate to be one identity at read-check time
   and another at write-check time only when a `WITH CHECK` is
   absent. In practice the `USING` clause blocks ordinary
   PostgREST PATCH cases, but the structural weakness means any
   future security-load-bearing column added to `profiles` would
   silently inherit the gap. Defense-in-depth requires
   `with check (id = auth.uid())` mirroring the `USING`.

## Acceptance criteria
- [ ] A new migration exists at exactly
      `supabase/migrations/20260517050000_rls_hardening_followups.sql`.
- [ ] `"Admins can write order_schedule"` (on `public.order_schedule`)
      is re-created with
      `using (public.auth_is_privileged() and public.auth_can_see_store(store_id))`
      AND
      `with check (public.auth_is_privileged() and public.auth_can_see_store(store_id))`.
      The policy continues to be FOR ALL (insert/update/delete in one).
      Super-admin retains full cross-brand access via the
      `auth_is_super_admin()` short-circuit inside `auth_can_see_store`.
- [ ] `"Admins can update any profile"` (on `public.profiles`) is
      re-created such that an admin/master caller can only UPDATE rows
      where the target profile's `brand_id` passes
      `public.auth_can_see_brand(brand_id)` — i.e., super-admin sees all,
      brand-admin sees only their own brand. The policy continues to
      permit self-updates (`id = auth.uid()`) so a regular user can
      still PATCH their own profile under this policy. The `WITH CHECK`
      mirrors the `USING` (no brand-transfer during UPDATE).
- [ ] `"Users can update own profile"` (on `public.profiles`) is
      re-created with `with check (id = auth.uid())` mirroring the
      existing `using (id = auth.uid())`. The policy continues to be
      FOR UPDATE only.
- [ ] All three policy changes are `drop policy if exists` +
      `create policy` so the migration is idempotent and re-runnable.
- [ ] A pgTAP test exists at
      `supabase/tests/rls_hardening_followups.test.sql` exercising at
      minimum:
      (a) super-admin can INSERT/UPDATE/DELETE order_schedule rows in
      any brand;
      (b) brand-A admin can INSERT/UPDATE/DELETE order_schedule rows in
      brand-A's stores;
      (c) brand-A admin CANNOT INSERT/UPDATE/DELETE order_schedule rows
      in a brand-B store (rejected by RLS — no row created or affected);
      (d) brand-A admin CANNOT UPDATE a brand-B user's profile
      (rejected by RLS — zero rows affected);
      (e) brand-A admin CAN still UPDATE a brand-A user's profile under
      the cross-brand-locked policy;
      (f) super-admin CAN UPDATE any profile (including brand-B
      profiles) under the cross-brand-locked policy;
      (g) regular user CAN UPDATE their own profile under the
      `WITH CHECK`-armed policy (defense-in-depth no-regression);
      (h) regular user CANNOT issue an UPDATE that mutates
      `id` to another user's UUID — the `WITH CHECK` blocks the post-write
      row identity. (Architect to finalize exact arm count and naming.)
- [ ] All 26 existing pgTAP test files under `supabase/tests/*.test.sql`
      continue to pass after the migration runs.
- [ ] No client-side code changes ship with this spec. Every existing
      RPC and PostgREST call site that writes `order_schedule` or
      `profiles` is either (i) already brand-A-scoped at the data layer
      via `useStore.currentStore`, or (ii) running as super-admin /
      service-role and bypassing the tightening.
- [ ] No RPC body changes. The fix lives entirely in policy text +
      helper composition.

## Visibility model (decided by Spec 041, do not re-ask)
- **super_admin** (`profiles.role = 'super_admin'`) → bypasses every
  scope check via `auth_is_super_admin()` short-circuits in
  `auth_can_see_brand` and `auth_can_see_store`.
- **admin / master** (JWT `app_metadata.role`) → can act only within
  their own brand (via `auth_can_see_brand(profiles.brand_id)` /
  `auth_can_see_store(store_id)`).
- **staff / user** → require explicit `user_stores` grants where
  applicable; otherwise can only read/write their own profile row.

Spec 042 extends this model to two more policies (`order_schedule`
WRITE, `"Admins can update any profile"`) and adds defense-in-depth
`WITH CHECK` on the self-update policy.

## Fix shapes (reference — architect finalizes)

### 1. `order_schedule` WRITE policy
```sql
drop policy if exists "Admins can write order_schedule" on public.order_schedule;

create policy "Admins can write order_schedule"
  on public.order_schedule for all
  using      (public.auth_is_privileged() and public.auth_can_see_store(store_id))
  with check (public.auth_is_privileged() and public.auth_can_see_store(store_id));
```
Strict superset for super-admin (the `auth_can_see_store` super-admin
short-circuit returns `true`). Restricts admin/master callers to
their own brand's stores via the helper's middle arm.

### 2. `"Admins can update any profile"`
The policy currently permits `JWT role IN ('admin','master') OR id = auth.uid()`.
The fix tightens the admin arm so it only applies when the target
profile is in the caller's brand. The self-edit arm is preserved so
regular users continue to PATCH their own row under this policy
(matches the existing semantics where the admin-of-any-brand path
and the self-edit path co-existed under one policy).
```sql
drop policy if exists "Admins can update any profile" on public.profiles;

create policy "Admins can update any profile"
  on public.profiles for update
  using (
    (public.auth_is_privileged() and public.auth_can_see_brand(brand_id))
    or (id = auth.uid())
  )
  with check (
    (public.auth_is_privileged() and public.auth_can_see_brand(brand_id))
    or (id = auth.uid())
  );
```
Architect to finalize whether to keep the OR-arm structure or split
into two narrower policies. The `auth_can_see_brand(brand_id)` arg
references the row's `brand_id` column (PostgreSQL row predicate
form — same shape as `auth_can_see_store(store_id)` elsewhere).
Super-admin retains full cross-brand access via the
`auth_is_super_admin()` short-circuit inside `auth_can_see_brand`.

### 3. `"Users can update own profile"` WITH CHECK
```sql
drop policy if exists "Users can update own profile" on public.profiles;

create policy "Users can update own profile"
  on public.profiles for update
  using      (id = auth.uid())
  with check (id = auth.uid());
```
Mirrors `USING`. Prevents row-key forgery (any attempt to UPDATE
where the post-write row would have `id != auth.uid()`). Defense-
in-depth — no current attack chain reaches this gap, but it closes a
structural weakness flagged by security-auditor Rounds 1-4 of Spec 041.

## In scope
- A single new migration file at
  `supabase/migrations/20260517050000_rls_hardening_followups.sql`.
- Drop + re-create the three policies above.
- A new pgTAP test file at
  `supabase/tests/rls_hardening_followups.test.sql`.
- No helper-function changes. No grant changes. No RPC changes.
- A `comment on policy` for each of the three policies that pins
  the spec-042 rationale (optional — architect's call).

## Out of scope (explicitly)
- **No client-side changes.** The OrderScheduleSection at
  [src/screens/cmd/sections/OrderScheduleSection.tsx](../src/screens/cmd/sections/OrderScheduleSection.tsx)
  already operates on `useStore.currentStore.id` and only writes the
  scheduled store; the tightening is correct-by-construction for that
  call site.
- **No helper-function changes.** `auth_is_privileged()`,
  `auth_can_see_store()`, `auth_can_see_brand()` are byte-identical
  to today.
- **No grant changes.** No REVOKE / GRANT statements.
- **`user_stores` TRUNCATE-as-DoS** (security-auditor Round-4 Low #1).
  Tracked as a separate follow-up (extends the Round-3 REVOKE TRUNCATE
  pattern to all destructive-action-sensitive tables). Out of scope
  here.
- **Dependency backlog.** `npm audit` carry-forward from specs 037+.
  Not 042-specific.
- **WRITE-side audit of every other per-store table.** Spec 041's
  release-proposal noted "Recommended follow-up: audit every WRITE
  policy on per-store tables for the same pattern." This spec covers
  ONLY `order_schedule` because it is the one verified
  security-auditor High. A separate spec should sweep the rest if
  any are still loose.
- **Enumerating writable columns in `"Users can update own profile"`.**
  Spec 041's security audit also flagged that the policy has no
  column-level lockdown (any column the user owns is writable).
  Spec 041 closed the two highest-impact columns (`brand_id`, `role`)
  via triggers. A future spec could extend the policy to enumerate
  exact-writable columns or assert security-load-bearing columns are
  `not distinct from old`. This spec adds only the structural
  `WITH CHECK` — defense-in-depth at the row level, not column
  level. Architect should treat column-enumeration as a separate
  spec.

## Open questions for the architect (NOT pre-answered)

1. **Profiles policy interaction with Spec 041 triggers.** Spec 041
   installed `profiles_self_brand_lock` (BEFORE UPDATE) and
   `profiles_self_delete_lock` (BEFORE DELETE) triggers that block
   self-edits of `brand_id` / `role`. With both Spec 041's triggers
   AND the new tightened RLS policies (`"Admins can update any
   profile"` brand-arm tightening + `"Users can update own profile"`
   with-check), is there overlap or conflict? The trigger fires
   regardless of which policy admitted the UPDATE. Walk through
   scenarios:
   - brand-A admin PATCHes their own non-restricted columns
     (`dark_mode`, `locale`, `name`) — both policies admit; trigger
     no-ops because brand_id/role unchanged. Expected pass.
   - brand-A admin PATCHes their own `brand_id` — admin policy
     admits (auth_can_see_brand passes for own brand_id row); trigger
     rejects. Expected reject.
   - brand-A admin PATCHes brand-B user's `name` — admin policy
     rejects (auth_can_see_brand fails for brand_id=B); self-edit
     arm fails (id != auth.uid()). Expected reject.
   - Architect to enumerate the exhaustive matrix and confirm no
     scenario regresses an existing working case.

2. **Cascading impact of the `order_schedule` tightening.** Confirm
   no RPC, edge function, or client section writes
   `order_schedule` rows under semantics that assume the loose policy:
   - [src/lib/db.ts:2946-3030](../src/lib/db.ts) (fetchOrderSchedule,
     saveOrderSchedule, addOrderScheduleEntry,
     removeOrderScheduleEntry) — all already filter by
     `store_id = storeId` and operate on the caller's chosen store.
     The tightening is correct-by-construction because the caller's
     `store_id` is sourced from `useStore.currentStore.id`, which is
     itself filtered by Spec 041's brand-scoped READ.
   - [src/screens/cmd/sections/OrderScheduleSection.tsx](../src/screens/cmd/sections/OrderScheduleSection.tsx)
     guards on `currentStore.id` and `__all__` — the helper rejects
     `__all__` writes, so no cross-brand impact.
   - Spec 007-era helpers (`addOrderScheduleEntry`,
     `removeOrderScheduleEntry`) called from EODCountSection and
     ReorderSection — both also derive `store_id` from
     `currentStore`. Architect to confirm no path passes a
     foreign-brand `store_id`.
   - eod-reminder-cron edge function writes? (It reads
     `order_schedule`; architect should verify it doesn't write —
     and if it does write, confirm it runs as service-role so
     RLS is bypassed.)

3. **Pre-flight check.** Any existing rows that would become
   unreadable/unwriteable for any user under the new policies?
   - `order_schedule`: would any existing row have a `store_id`
     whose `stores.brand_id` is misaligned with the caller's
     `profiles.brand_id`? Today (single-brand prod), the answer is
     no by construction; but the spec-041 multi-brand schema permits
     a future foreign-brand row that an existing admin might
     legitimately have been writing under the loose policy.
     Architect to confirm no such pre-existing legitimate write
     would break (Spec 007 says the schedule is per-store; nothing
     in the codebase writes cross-brand schedules legitimately).
   - `profiles`: any brand-admin whose `profiles.brand_id` is
     misaligned with their `user_stores` grants? Spec 041's
     pre-flight DO block already asserts admin/master profiles
     have non-NULL brand_id; the new policy reads `brand_id` of the
     **target** row, not the caller. The risk surface is: a brand-A
     admin currently relies on PATCHing a brand-B user (e.g.,
     "Bobby PATCHes Charles to update sidebar_layout for a Baltimore
     manager"). Architect to confirm zero such legitimate paths in
     the current codebase.

4. **Migration ordering.** Spec 042 is a security spec. Should it
   block on operational verification of Spec 041 in prod? Or can it
   ship in parallel? Spec 041 is already at SHIP_READY commit
   `59eea46`. The architect should decide whether Spec 042 is
   safe to ship before Spec 041 hits prod (no — Spec 042 depends on
   `auth_can_see_brand` / `auth_can_see_store` being the tightened
   versions from Spec 041, otherwise the brand-arm helpers would
   not have the brand-scope short-circuit) or whether it must
   strictly chain after Spec 041 (yes — migration timestamp ordering
   makes this trivial since `20260517050000` > `20260517040000`).

5. **Test coverage scope.** How thorough should the cross-brand-admin
   attack matrix be? Spec 041's pgTAP plan is 14 arms; this spec's
   plan should at minimum mirror the security-auditor's three
   findings (8 arms above). Architect to decide whether to extend
   coverage to:
   - INSERT-into-order_schedule cross-brand attempts
   - UPDATE-order_schedule cross-brand attempts
   - DELETE-order_schedule cross-brand attempts
   - All three for the profiles cross-brand-admin policy
   - PostgREST-level smoke test (a curl GET/PATCH against
     `/rest/v1/order_schedule` and `/rest/v1/profiles` from a brand-A
     admin's JWT)
   Architect to set the final arm count.

## Dependencies
- **Spec 041** (`20260517040000_auth_can_see_store_brand_scope.sql`)
  — must be applied before this migration. The new
  `"Admins can update any profile"` policy calls
  `auth_can_see_brand(brand_id)`, which is the Spec-012a helper
  preserved byte-identical through Spec 041. The
  `"Admins can write order_schedule"` policy calls
  `auth_can_see_store(store_id)` — the tightened version from
  Spec 041. Spec 042's migration timestamp ensures correct ordering.
- **Spec 012a** (`20260509000000_multi_brand_schema_rls.sql`)
  — defines `auth_is_privileged()`, `auth_is_admin()`,
  `auth_can_see_brand()`, `auth_can_see_store()`.
- **Spec 007** (`20260507214842_spec007_order_schedule_unique.sql`)
  — defines the `(store_id, day_of_week, vendor_id)` unique
  constraint on `order_schedule`. Not modified by this spec; just
  noted because the per-cell add/remove helpers depend on it.

## Project-specific notes
- **Cmd UI section / legacy:** None — pure backend RLS spec. No UI
  changes. The OrderScheduleSection is exercised in the
  pre-flight check but not modified.
- **Per-store or admin-global:** Per-store (`order_schedule`
  tightening); per-brand (`profiles` cross-admin tightening);
  per-user (`profiles` self-update with-check).
- **Realtime channels touched:** None directly. `order_schedule` is
  on the realtime publication; behavior of subscribers is unchanged
  because the publication mechanism does not interact with RLS
  (subscribers receive WAL changes; per-row visibility is enforced
  at the PostgREST layer separately). Realtime publication gotcha
  does NOT apply (no publication changes).
- **Migrations needed:** Yes — one new file at
  `supabase/migrations/20260517050000_rls_hardening_followups.sql`.
- **Edge functions touched:** None directly. The eod-reminder-cron
  edge function reads `order_schedule` but does so as service-role
  (which bypasses RLS), so no behavior change. If the architect
  finds any edge function that WRITES `order_schedule` under a
  non-service-role JWT, surface as an open question.
- **Web/native scope:** Both — backend-only change applies to all
  clients identically. No `app.json` slug change.
- **Tests:** pgTAP DB tests track. A single new file at
  `supabase/tests/rls_hardening_followups.test.sql`. No jest or
  shell smoke required. Architect may optionally add a shell smoke
  to exercise the PostgREST-level cross-brand reject for an extra
  layer of confidence — keep that as a separate file under
  `scripts/` if so, do not bundle into the pgTAP plan.

## Open questions resolved
- Q: Which findings from Spec 041's security audit belong in this
  spec? → A: All three carry-forward (security-auditor High +
  2 Medium), per Spec 041 release-proposal lines 157-185.
  `user_stores` TRUNCATE-as-DoS (Round-4 Low #1) is a separate
  follow-up.
- Q: Does this spec change the visibility model? → A: No. The
  model from Spec 041 is canonical; this spec extends it to two more
  policies and adds defense-in-depth on a third.
- Q: Are any client-side code changes required? → A: No. All
  affected call sites are already brand-A-scoped at the
  `useStore.currentStore` level (post-Spec-041) or run as
  super-admin/service-role.
- Q: Migration filename slot? → A:
  `supabase/migrations/20260517050000_rls_hardening_followups.sql`.
  Verified next free slot per `ls supabase/migrations/`. Today is
  2026-05-17; the existing 2026-05-17 slots are
  `00000/010000/020000/030000/040000` (5 slots used).


## Backend / architecture design

This is a backend-only RLS spec. One new migration + one new pgTAP
test file. No client changes ship with this spec.

### 1. Data model changes

**None.** No new tables, columns, indexes, triggers (see §6 for the
trigger-extension question — resolved as "no new trigger needed"),
or constraints. Only policy text changes plus a pre-flight DO block.

**Migration filename (verified next free slot):**

```
supabase/migrations/20260517050000_rls_hardening_followups.sql
```

Naturally orders after Spec 041's `20260517040000_*` per timestamp
sort. Idempotent + re-runnable (`drop policy if exists` + `create
policy`).

**Destructive vs additive.** Strict additive in semantics: the
tightened policies are a strict superset of legitimate writes that
were succeeding pre-042. Super-admin retains full reach via the
`auth_is_super_admin()` short-circuit baked into both
`auth_can_see_brand()` and `auth_can_see_store()`. Brand-admin
loses writes they should never have had (cross-brand
`order_schedule` rows, cross-brand profile patches). DELETEs of
policies are textual only — the policy text on disk changes from
loose to tight; row data is untouched.

**Rollout safety.** A migration error mid-deploy leaves the txn
rolled back (each migration is one transaction by default). Re-
applying is idempotent. The pre-flight DO block (§6 below)
fail-closes if any admin/master profile has NULL `brand_id` so the
tightening never silently strips visibility from a misconfigured
production row. Identical pattern to Spec 041's pre-flight at
`supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql:75-84`.

### 2. RLS impact

Three policies are dropped and re-created. No new policies. No
existing policies are deleted without recreation.

| Table              | Policy                              | Verb       | New USING                                                                            | New WITH CHECK                                                                       | Helper(s)                                |
|--------------------|-------------------------------------|------------|--------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------|------------------------------------------|
| `order_schedule`   | `Admins can write order_schedule`   | FOR ALL    | `auth_is_privileged() AND auth_can_see_store(store_id)`                              | `auth_is_privileged() AND auth_can_see_store(store_id)`                              | `auth_is_privileged`, `auth_can_see_store` |
| `profiles`         | `Admins can update any profile`     | FOR UPDATE | `(auth_is_privileged() AND auth_can_see_brand(brand_id)) OR (id = auth.uid())`       | `(auth_is_privileged() AND auth_can_see_brand(brand_id)) OR (id = auth.uid())`       | `auth_is_privileged`, `auth_can_see_brand` |
| `profiles`         | `Users can update own profile`      | FOR UPDATE | `id = auth.uid()`                                                                    | `id = auth.uid()`                                                                    | (none — direct UID check)                |

**Existing policies that are NOT modified (defense-in-depth, listed
so the reviewer can confirm they aren't broken by the tightening):**

- `Store members can read order_schedule` (`order_schedule`, SELECT)
  — already calls `auth_can_see_store(store_id)`. Unchanged.
  ([supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql:24-26](../supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql))
- `super_admin_manage_profiles` (`profiles`, FOR UPDATE) — independent
  policy at [supabase/migrations/20260509000000_multi_brand_schema_rls.sql:985-988](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql). The
  ALL-permissive semantics of Postgres RLS mean super-admin retains
  every update path even if the tightened `Admins can update any
  profile` rejected them for a given row — but inside the helper
  composition, super-admin already passes `auth_can_see_brand()`
  via the `auth_is_super_admin()` short-circuit, so the OR with the
  separate super-admin policy is redundant-but-correct. No change.
- `Admins can read all profiles` (`profiles`, SELECT) — unchanged. Out
  of scope per spec §"Out of scope" (read-side admin visibility
  was tightened by Spec 041's helper for store rows; profile reads
  are NOT in scope for 042; see Risk #3).
- `Admins can delete profiles` (`profiles`, DELETE) — unchanged. The
  `profiles_self_delete_lock` trigger from Spec 041 stops
  self-delete escalation; cross-brand admin deletion of profiles
  remains permissive in policy but is mitigated by the
  `assert_not_last_of_role` guard called by the `delete-user` edge
  function (Spec 031). Surface as Risk #4.
- `Anyone can insert own profile or admin can insert any`
  (`profiles`, INSERT) — unchanged. The self-INSERT path is gated
  by `id = auth.uid()`; the admin INSERT path uses raw JWT and is
  unchanged. Out of scope for 042; see Risk #5.

**Existing policy text being dropped (verified):**

- `order_schedule`: `supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql:28-31`
  — `using (auth_is_privileged()) with check (auth_is_privileged())`.
- `profiles "Admins can update any profile"`:
  [supabase/migrations/20260502071736_remote_schema.sql:390-395](../supabase/migrations/20260502071736_remote_schema.sql)
  — `using (((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'master'::text])) OR (id = auth.uid())))`.
  No `WITH CHECK`. Raw JWT check (not `auth_is_privileged()` —
  doesn't admit super-admin via profiles.role).
- `profiles "Users can update own profile"`:
  [supabase/migrations/20260502071736_remote_schema.sql:417-422](../supabase/migrations/20260502071736_remote_schema.sql)
  — `using ((id = auth.uid()))`. No `WITH CHECK`.

**`comment on policy` blocks** — add a single-line comment on each
of the three recreated policies pinning the spec-042 rationale.
Matches the documentation pattern from Spec 041's
`comment on function` blocks. Optional per spec, but recommended.

### 3. API contract

**PostgREST tables affected:** `order_schedule`, `profiles`. No
schema changes — column types, FKs, and unique constraints are
untouched. The RLS layer becomes stricter for cross-brand writes;
PostgREST surfaces RLS rejection as HTTP 401 / 403 / 0-rows-affected
depending on the verb.

**Behaviour matrix (response shape unchanged, RLS-admission changes):**

| Caller                    | Verb / target                                           | Pre-042                       | Post-042                                  |
|---------------------------|---------------------------------------------------------|-------------------------------|-------------------------------------------|
| super_admin               | INSERT/UPDATE/DELETE order_schedule (any brand)         | OK                            | OK (via `auth_is_super_admin()` short-circuit) |
| brand-A admin             | INSERT/UPDATE/DELETE order_schedule in brand A          | OK                            | OK (via `auth_can_see_store` brand arm)   |
| brand-A admin             | INSERT/UPDATE/DELETE order_schedule in brand B          | OK (security bug)             | REJECTED by RLS                           |
| staff w/ user_stores      | INSERT/UPDATE/DELETE order_schedule in granted store    | OK (privileged-check was loose; staff path was never the intended writer but technically blocked because `auth_is_privileged()` was false for `role='user'`) | UNCHANGED — `auth_is_privileged()` still false; tightening does not loosen anything |
| super_admin               | UPDATE any profile (any brand)                          | OK via `super_admin_manage_profiles` | OK (same)                          |
| brand-A admin             | UPDATE same-brand non-self profile (e.g., name, locale) | OK                            | OK (via brand check)                      |
| brand-A admin             | UPDATE cross-brand profile (any column)                 | OK (security bug)             | REJECTED by RLS                           |
| brand-A admin             | UPDATE OWN profile (non-locked columns)                 | OK                            | OK (self arm or admin arm both pass)      |
| brand-A admin             | UPDATE OWN profile.brand_id / role                      | Pre-Spec-041: OK (escalation). Post-Spec-041 / pre-042: REJECTED by trigger | REJECTED by trigger (no change from 041) |
| regular user              | UPDATE OWN profile (any non-locked column)              | OK                            | OK (self arm passes; WITH CHECK passes since `id = auth.uid()`) |
| regular user              | UPDATE OWN profile with `id = <other-uuid>` in SET      | OK at parse / WITH CHECK never enforced; USING blocked at row-fetch | REJECTED by WITH CHECK (row-key forgery blocked at write-validation) |

**No new RPCs. No RPC signature changes.** This is policy-text only.

**Error shapes (PostgREST convention, unchanged):**
- RLS denial on UPDATE/DELETE → HTTP 200 with 0-row response body
  (PostgREST's default "no rows matched" behaviour — distinguishable
  from explicit 403 only by row count).
- RLS denial on INSERT → HTTP 401/403 depending on the policy and
  the schema-level grants. `order_schedule` INSERT post-tightening
  surfaces as `42501 new row violates row-level security policy for
  table "order_schedule"` for brand-mismatched calls.

### 4. Edge function changes

**None.** The eod-reminder-cron edge function reads
`order_schedule` (lines 270-271) but does not write; it runs as
service_role which bypasses RLS regardless. Confirmed via grep
across `supabase/functions/`.

No `verify_jwt` changes. No new edge functions.

### 5. `src/lib/db.ts` surface

**No new helpers. No signature changes.** The existing helpers all
pass through validated `storeId` / `userId` from `useStore`:

- `fetchOrderSchedule(storeId)` — SELECT only; uses
  `auth_can_see_store` via the existing read policy. Unchanged.
- `saveOrderSchedule(storeId, day, vendors)` —
  [src/lib/db.ts:2964-2978](../src/lib/db.ts). DELETE + INSERT on
  `order_schedule` for the caller's chosen `storeId`. Post-042:
  the DELETE will silently affect 0 rows + the INSERT will raise
  `42501` if `storeId` belongs to a foreign brand. Frontend never
  passes a foreign-brand `storeId` because the caller's
  `useStore.currentStore.id` is itself filtered by Spec 041's
  brand-scoped READ on `stores`. **No code change required.**
- `addOrderScheduleEntry(storeId, day, vendor)` —
  [src/lib/db.ts:2990-3014](../src/lib/db.ts). Single INSERT; the
  helper already swallows PG `23505` (unique_violation) as idempotent
  no-op. Post-042 it will newly raise on `42501`
  (rls_policy_violation) for cross-brand `storeId`. The catch-clause
  at line 3013 (`error.code !== '23505'`) lets `42501` propagate up
  to `notifyBackendError` — desired behaviour. **No code change.**
- `removeOrderScheduleEntry(storeId, day, vendorId)` —
  [src/lib/db.ts:3018-3030](../src/lib/db.ts). Single DELETE; the
  helper throws on any non-null error. Post-042: cross-brand
  `storeId` returns 0 rows affected (DELETE with RLS-non-matching
  rows is not an error per Postgres semantics — empty resultset).
  No additional error surfaces. **No code change.**

For `profiles` writes, the helpers
[updateProfileNotifications](../src/lib/db.ts) (1319),
[saveSidebarLayout](../src/lib/db.ts) (1346),
[saveLocale](../src/lib/db.ts) (1369),
[demoteProfileToUser](../src/lib/db.ts) (2710), and the inline
`supabase.from('profiles').update({ dark_mode })` at
[src/store/useStore.ts:2085](../src/store/useStore.ts) all scope to
`.eq('id', userId)` where `userId` is the caller's own
`currentUser.id`. The self-arm of the tightened "Admins can update
any profile" still admits these. The new `WITH CHECK` on "Users can
update own profile" passes since `id = auth.uid()`. **No code change.**

The cross-user write paths in scope:
- `demoteProfileToUser(profileId)` runs under super-admin auth
  (Spec 012c flow) and patches `role + brand_id` on another user.
  Post-042: under the tightened "Admins can update any profile"
  policy, super_admin passes `auth_can_see_brand(brand_id)` for any
  brand_id via the short-circuit. Under the *separate*
  `super_admin_manage_profiles` policy (independent, ALL-permissive)
  super_admin also passes. **Verified safe — no code change.**
- Edge function `delete-user` runs as service_role, RLS bypassed.

### 6. Realtime impact

**None directly.** Tables on the realtime publication
(`order_schedule`, `profiles`) continue to publish WAL changes
unchanged. Per-row visibility is enforced at the PostgREST /
subscriber layer separately from the WAL. The realtime publication
gotcha **does NOT apply** to this spec — no
`alter publication supabase_realtime` statements are in the
migration. No `docker restart supabase_realtime_imr-inventory`
needed.

Cited from CLAUDE.md / project memory: "Realtime publication
gotcha — Mid-session pub changes need `docker restart
supabase_realtime_imr-inventory` to re-snapshot the slot." Spec
042 does not touch the publication, so this is a no-op.

### 7. Frontend store impact

**None.** No slices of `src/store/useStore.ts` change. The
optimistic-then-revert pattern continues to work because:
- A cross-brand write attempt that would now fail RLS would have
  required the user to navigate to a foreign-brand store first.
  Spec 041's `auth_can_see_store` READ tightening makes that
  navigation impossible (the foreign store wouldn't appear in the
  `stores` SELECT result, so it would not be selectable in the
  TitleBar store picker). Defense-in-depth: even if the navigation
  somehow happened, the write would surface as a backend error and
  the existing `notifyBackendError` toast would fire.
- The self-arm of the tightened admin policy plus the existing
  self-policy preserve all legitimate dark-mode / locale / sidebar
  / notifications PATCHes.

### 8. Risks and tradeoffs

**Risk #1 (low).** Migration ordering. Spec 042 calls
`auth_can_see_brand` and `auth_can_see_store` — both byte-identical
to their post-Spec-041 definitions. If Spec 041 has not yet
shipped to prod (current `main` HEAD is at commit `5170daf` per
git log; Spec 041 SHIP_READY at `59eea46` is on `main`), the
migration filename ordering (`20260517050000_*` > `20260517040000_*`)
guarantees correct apply order via supabase CLI. The migration is
safe to ship as part of the same deploy as Spec 041 or any deploy
after it. **Mitigation:** the pre-flight DO block (see §10 below)
fail-closes if `auth_can_see_brand` is somehow missing or returns
unexpected truthiness, but that should be impossible given Spec
012a's helper has existed since `20260509000000_*`. Documented for
the operator.

**Risk #2 (low).** The OR-arm structure of the tightened "Admins
can update any profile" policy means a self-edit by a brand-admin
matches BOTH disjuncts (admin-arm because brand_id matches their
own brand; self-arm because `id = auth.uid()`). Postgres evaluates
the OR with no short-circuit guarantees but produces the correct
truthiness either way. No performance concern at the 286 KB seed
scale; the helper functions are STABLE and the planner can cache.

**Risk #3 (medium — surface as open question to the user).** The
spec explicitly **excludes** "Admins can read all profiles"
(`supabase/migrations/20260502071736_remote_schema.sql:381-386`).
Pre-042 a brand-A admin can SELECT every profile across every
brand (raw JWT check, no brand arm). The architect's tactical
recommendation is: this is **out of scope per spec line 358-362**
("All three carry-forward (security-auditor High + 2 Medium)"); a
follow-up spec should sweep it. **No design change here**, but
flag for the user that a brand-admin can still ENUMERATE other
brands' admins/users via `/rest/v1/profiles?select=*` after this
spec ships — the WRITE path is closed, the READ path is not.

**Risk #4 (medium — surface as open question).** The spec
explicitly **excludes** "Admins can delete profiles"
([supabase/migrations/20260502071736_remote_schema.sql:372-377](../supabase/migrations/20260502071736_remote_schema.sql)).
Pre-042 a brand-A admin can DELETE any profile in any brand via
raw JWT check. The `profiles_self_delete_lock` trigger (Spec 041)
only blocks self-DELETE. The Spec 031 `assert_not_last_of_role`
guard is called by the `delete-user` edge function, not by the
policy, so direct PostgREST DELETE bypasses it. **Out of scope per
the spec**, but flag for the user.

**Risk #5 (low).** "Anyone can insert own profile or admin can
insert any" — the admin arm uses raw JWT
`(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY
(ARRAY['admin'::text, 'master'::text]))` with no brand check. A
brand-A admin can INSERT a profile with `brand_id = <foreign>` and
`id = <new-uuid>`, but the `profiles_role_brand_consistent` CHECK
and the user_stores trigger from Spec 012a make such a row
operationally inert (no auth.users entry, no user_stores access).
Out of scope per spec.

**Risk #6 (high — must address in this spec; see §11 below).**
**Cross-user `brand_id` writes by non-super_admin.** Q1 of the
spec walks the scenario: a brand-A admin updates ANOTHER user's
`brand_id`. Under the tightened "Admins can update any profile"
policy, USING and WITH CHECK both reference the row's `brand_id`.
The USING is evaluated against the OLD row; the WITH CHECK against
the NEW row. If a brand-A admin attempts to move user X (currently
brand A) to brand B:
  - USING passes (OLD.brand_id = A, admin is in A, brand check OK).
  - WITH CHECK FAILS (NEW.brand_id = B, admin is in A, brand check
    rejects). The UPDATE is rejected.

So Postgres's USING+WITH CHECK semantics ALREADY block the
cross-brand promotion of another user, **by construction**, when
both clauses are present. **No new trigger needed** — the WITH
CHECK clause in §2 closes this attack vector cleanly. The
architect verified this is sound by tracing the policy evaluation
order against
https://www.postgresql.org/docs/17/ddl-rowsecurity.html "Row
Security Policies": "FOR UPDATE policies USING expression is
checked against the existing record … WITH CHECK is applied
against the row that would be created after the UPDATE."

**Risk #7 (low).** pgTAP RLS isolation. Spec 041's pgTAP test
uses `set local role authenticated` + `set_config('request.jwt.claims',...)`
to impersonate a caller; the same pattern works for 042. The
test must be careful that arms which patch `profiles.brand_id` on
another user (e.g., super_admin positive control) don't break a
subsequent arm's fixtures. Use the same `reset role` +
in-transaction-rollback isolation pattern as
[supabase/tests/auth_can_see_store_brand_scope.test.sql](../supabase/tests/auth_can_see_store_brand_scope.test.sql).

### 9. Open questions — resolved

#### Q1 — Profiles policy interaction with Spec 041 triggers

**Scenarios walked. The matrix the spec asks for:**

| # | Caller       | Target row              | Verb / column change                            | "Admins can update any profile" admit?            | "Users can update own profile" admit? | `profiles_self_brand_lock` trigger     | Net result    |
|---|--------------|--------------------------|--------------------------------------------------|---------------------------------------------------|----------------------------------------|----------------------------------------|---------------|
| A | brand-A admin| OWN row (brand A)        | `dark_mode`, `locale`, `name`, `sidebar_layout`  | YES (self-arm: id=auth.uid())                     | YES (id=auth.uid())                    | no-op (column not in lock list)        | PASS expected |
| B | brand-A admin| OWN row (brand A)        | `brand_id` to brand B                            | YES at USING (own row), NO at WITH CHECK (new brand_id is brand B and admin is in A) | YES at USING/WITH CHECK if we forget the trigger — but the trigger fires regardless | REJECTS (`brand_id is read-only for self-edits (super_admin only)`) | REJECT expected (defense-in-depth — trigger AND policy both block) |
| C | brand-A admin| OWN row (brand A)        | `role` to super_admin                            | YES at USING (admin-arm), YES at WITH CHECK (super_admin's NEW brand_id still A passes auth_can_see_brand) — POLICY ADMITS | YES at USING/WITH CHECK (id=auth.uid()) — POLICY ADMITS | REJECTS (`role is read-only for self-edits`) | REJECT (trigger holds the line — POLICY DOES NOT BLOCK, this is the documented gap closed by the Spec 041 trigger) |
| D | brand-A admin| OTHER brand-A user       | `name`, `dark_mode`, `locale`, `sidebar_layout`  | YES (admin-arm passes brand check)                | NO (id != auth.uid())                  | no-op (column not in lock list)        | PASS expected |
| E | brand-A admin| OTHER brand-B user       | any column                                       | NO (admin-arm fails brand check)                  | NO (id != auth.uid())                  | no-op (id != auth.uid())               | REJECT expected (the spec's core fix) |
| F | brand-A admin| OTHER brand-A user       | `brand_id` to brand B                            | YES at USING (OLD.brand_id=A passes), NO at WITH CHECK (NEW.brand_id=B fails) — POLICY REJECTS WITH CHECK | NO (id != auth.uid())                  | no-op (id != auth.uid() — trigger only fires on self)            | REJECT (the WITH CHECK closes the attack — see Risk #6) |
| G | super_admin  | any user                 | any column                                       | YES via auth_is_super_admin() short-circuit in auth_can_see_brand | YES if super_admin is self            | no-op (auth_is_super_admin() exempt) OR no-op (id != auth.uid()) | PASS expected |
| H | regular user | OWN row                  | non-locked columns                               | YES (self-arm)                                    | YES                                    | no-op (column not in lock list)        | PASS expected |
| I | regular user | OWN row                  | UPDATE … SET id = <other-uuid>                   | YES at USING (id=auth.uid()), NO at WITH CHECK (NEW.id != auth.uid()) — POLICY REJECTS | YES at USING (id=auth.uid()), NO at WITH CHECK (NEW.id != auth.uid()) — POLICY REJECTS | no-op (column not in lock list)        | REJECT (row-key forgery blocked) |
| J | brand-A admin| OTHER brand-A user       | `role` to super_admin                            | YES at USING (admin-arm), YES at WITH CHECK (super_admin role + still brand A) — POLICY ADMITS | NO (id != auth.uid())                  | no-op (id != auth.uid() — trigger only fires on self)            | **REJECT NEEDED but NOT BLOCKED** — see resolution below |

**The critical case is row J.** A brand-A admin can promote
another brand-A user to `role = 'super_admin'`. The
`profiles_self_brand_lock` trigger from Spec 041 ONLY fires on
self-edits (`old.id = auth.uid()`), per the trigger body at
[supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql:179-189](../supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql).
The tightened admin policy admits the write because the target is
still brand A. **This is a real escalation chain** — a brand-A
admin can promote a confederate from brand A's `user` role to
`super_admin`, and that confederate then has full cross-brand
reach.

**However:** this exact attack chain was **out of scope for Spec
041** (which only closed self-promotion via brand_id/role) and is
**out of scope for Spec 042 as written** (the spec body talks
about "cross-brand profile writes" — within-brand role escalation
is a separate concern). The cleanest fix is to **extend Spec
041's trigger** to also block `role` changes on ANY profile (not
just self) for non-super_admin callers. That's a one-line trigger
change.

**Architect's decision:** **Extend the trigger as part of this
spec.** Rationale:
  1. Spec 042 is explicitly about closing cross-arm gaps in the
     write-policy stack. Row J is a write-policy gap that the
     three policy tightenings alone do NOT close.
  2. The trigger extension is mechanical (drop the `old.id =
     auth.uid()` guard for the `role` check, keep it for the
     `brand_id` check OR drop it for both — see below).
  3. Shipping the policy tightening without the trigger extension
     would leave the same-brand role-escalation attack open, which
     is arguably worse than the pre-042 cross-brand attack because
     the resulting confederate-as-super_admin is plausibly
     auditable from the brand-A admin's audit log but the cross-
     brand impact is total.

**Decision granularity:**

*Sub-question: extend the trigger to block cross-user `brand_id`
changes too?*

Row F shows that the WITH CHECK on the tightened admin policy
already blocks cross-user `brand_id` changes that would move a row
to a foreign brand. The remaining gap is: brand-A admin moves
brand-A user X from brand A to brand A (no-op) — harmless. Or
brand-A admin moves brand-A user X to a third brand C — same
WITH CHECK rejection (NEW.brand_id = C, admin in A, rejection).

But: what if a brand-A admin moves OWN-brand user X from brand A
to brand A (legitimate no-op)? The WITH CHECK passes. No issue.

What if a brand-A admin sets brand_id = NULL (which is
constitutionally only valid for role='super_admin' per the
`profiles_role_brand_consistent` CHECK)? The CHECK would raise
unless they also patch role='super_admin'. If they patch both
columns in one UPDATE: brand_id=NULL + role='super_admin' on
target X in brand A. The WITH CHECK on the admin policy with
NEW.brand_id=NULL — `auth_can_see_brand(NULL)` returns false for
non-super_admin (the EXISTS clause finds no row with brand_id =
NULL). So the WITH CHECK REJECTS.

**Conclusion: `brand_id` writes on other users are already
adequately blocked by the policy WITH CHECK in conjunction with
the row-level CHECK.** No need to extend the trigger to cover
cross-user `brand_id`.

*Final trigger change:* **Drop the `old.id = auth.uid()` guard
ONLY for the `role` check** inside
`assert_brand_id_immutable_for_self()`. The function's name
becomes slightly misleading ("self"), but renaming the function
would require dropping the old trigger and the old function. The
architect's choice is to keep the function name and add an
explanatory comment, OR rename to
`assert_profile_columns_locked()`. **Recommendation: rename.**
Both the function and trigger are non-public surface
(`security definer` + `set search_path = public, auth`); the
existing `comment on function` is the only documentation that
references the name. The pgTAP test arm (7) of Spec 041 checks the
exact error message, not the function name. Renaming is mechanical.

**Resolution for Q1.** The migration in Spec 042 will:
  1. Drop and recreate the three policies per §2 above.
  2. Replace the body of
     `public.assert_brand_id_immutable_for_self()` (keep the
     function name for minimum surface — see Risk #8 below) so the
     `role` check fires for ALL UPDATEs by non-super_admin, not
     just self-UPDATEs. The `brand_id` check stays self-only
     (cross-user brand_id changes are already blocked by the
     policy WITH CHECK + row-level CHECK constraint).
  3. Update the `comment on function` to reflect the broadened
     scope.

**Risk #8 (new).** Renaming the function vs replacing the body.
**Decision: keep the existing name.** Rationale: the function name
appears in the trigger definition only (and the `comment on
function` doc); the pgTAP test arms 7-8 of Spec 041 reference the
RAISE message strings, not the function name. Replacing the body
in-place is non-destructive (`create or replace function`) and
preserves the trigger binding (`profiles_self_brand_lock`)
unchanged. A future spec can rename for clarity; this one
prioritizes minimum surface.

#### Q2 — Cascading impact of the `order_schedule` tightening

Verified call sites (all use brand-scoped `currentStore.id`):

- [src/lib/db.ts:2964-2978](../src/lib/db.ts) `saveOrderSchedule`
  — store_id from caller.
- [src/lib/db.ts:2990-3014](../src/lib/db.ts) `addOrderScheduleEntry`
  — store_id from caller.
- [src/lib/db.ts:3018-3030](../src/lib/db.ts) `removeOrderScheduleEntry`
  — store_id from caller.
- [src/store/useStore.ts:1985-2007](../src/store/useStore.ts)
  `addOrderScheduleEntry` action — `storeId = currentStore.id`,
  guarded by `storeId !== '__all__'`.
- [src/store/useStore.ts:2009-2025](../src/store/useStore.ts)
  `removeOrderScheduleEntry` action — same guard.
- [src/store/useStore.ts:1972-1975](../src/store/useStore.ts)
  `setOrderSchedule` action calling `saveOrderSchedule` — same
  guard.
- [src/screens/cmd/sections/OrderScheduleSection.tsx:25-26, 67-73](../src/screens/cmd/sections/OrderScheduleSection.tsx)
  — pure passthrough to store action.
- [src/screens/cmd/sections/EODCountSection.tsx:85-86, 887-888, 1314-1316](../src/screens/cmd/sections/EODCountSection.tsx)
  — pure passthrough to store action.
- [supabase/functions/eod-reminder-cron/index.ts:270-271](../supabase/functions/eod-reminder-cron/index.ts)
  — READ only, no write. Confirmed via grep.

`currentStore.id` is sourced from the `stores` table SELECT which
post-Spec-041 is brand-scoped via `auth_can_see_store`. So
`currentStore.id` is by construction the caller's own brand. The
tightening is correct-by-construction for every call site. **No
client code changes required.**

#### Q3 — Pre-flight check

**Rows that become unreadable/unwriteable for any user under the new
policies:**

- `order_schedule`: every row has a `store_id` pointing to
  `public.stores`. The Spec 041 brand-arm helper
  `auth_can_see_store` resolves brand membership via
  `stores.brand_id`. Today's prod has a single brand; every
  `order_schedule.store_id` resolves to brand A. So no
  legitimately-written row becomes inaccessible to its owner. For
  future multi-brand: a row was previously writeable by any admin
  in any brand under the loose policy, but the only WRITER is a
  brand-A admin operating on their own store (verified above), so
  no row had a legitimately-written-but-now-inaccessible state.
- `profiles`: every admin/master profile must have a non-NULL
  `brand_id` per the `profiles_role_brand_consistent` CHECK
  (`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:341-348`).
  Spec 041's pre-flight DO block (`20260517040000_*:75-84`)
  re-asserts this invariant. Spec 042's pre-flight DO block
  re-asserts the SAME invariant as defense-in-depth (even though
  041 added the check, an operator could have disabled the CHECK
  for a one-off backfill between 041 and 042 ship). **Pre-flight
  DO block included.**
- Cross-user PATCHes on `profiles` that today succeed but would
  fail post-042: enumerated as part of Risk #3 (read) and Risk
  #4 (delete) above for the OUT-OF-SCOPE policies. For the
  IN-SCOPE "Admins can update any profile" policy:
  - **No call site in the codebase issues a cross-brand
    profile PATCH from a non-super-admin caller**: grep across
    `src/lib/db.ts`, `src/store/useStore.ts`,
    `src/screens/cmd/sections/`, and `supabase/functions/`
    finds no such call site. The closest is `demoteProfileToUser`
    which is gated to super-admin per Spec 012c §5. **No
    legitimate path breaks.**

#### Q4 — Migration ordering vs. Spec 041 prod deploy

**Decision: Spec 042 strictly chains after Spec 041.** Rationale:
the new policies call `auth_can_see_brand(brand_id)` and
`auth_can_see_store(store_id)`. Both helpers exist post-Spec-012a
(`20260509000000_*`) — Spec 041 only TIGHTENS the body of
`auth_can_see_store`, it doesn't add or rename the helper. So
strictly speaking Spec 042 doesn't *require* Spec 041's helper
update — it would work against either the loose 012a helper or the
tight 041 helper. But the spec body intentionally describes the
semantics as if the 041-tightened helper is in place ("brand-A
admin cannot see brand-B store" — only true post-041). **The
migration ordering by filename timestamp
(`20260517050000_*` > `20260517040000_*`) makes the dependency
trivially correct under any deploy mechanism.**

Operational note for the deploy: if Spec 041 is rolled back, Spec
042 should be rolled back with it. Both migrations are required to
hold the brand-scoped invariant — rolling back just 042 would
re-open the cross-brand write paths without disturbing the
041-tightened READ path. **Document in the migration header
comment.**

#### Q5 — pgTAP arm count

Architect's plan: **15 arms total in
`supabase/tests/rls_hardening_followups.test.sql`**. Numbering and
shape:

| Arm | Verb     | Caller        | Target                            | Expected | Purpose |
|-----|----------|---------------|-----------------------------------|----------|---------|
| (1) | INSERT   | brand-A admin | order_schedule row in brand-A     | OK       | tightening admits same-brand admin INSERT |
| (2) | UPDATE   | brand-A admin | order_schedule row in brand-A     | OK       | tightening admits same-brand admin UPDATE |
| (3) | DELETE   | brand-A admin | order_schedule row in brand-A     | OK       | tightening admits same-brand admin DELETE |
| (4) | INSERT   | brand-A admin | order_schedule row in brand-B     | REJECT   | core security fix — cross-brand admin INSERT blocked |
| (5) | UPDATE   | brand-A admin | order_schedule row in brand-B     | 0 rows   | core fix — cross-brand admin UPDATE silently affects 0 rows (Postgres RLS semantics) |
| (6) | DELETE   | brand-A admin | order_schedule row in brand-B     | 0 rows   | core fix — cross-brand admin DELETE silently affects 0 rows |
| (7) | INSERT   | super_admin   | order_schedule row in brand-B     | OK       | super_admin retains cross-brand reach via short-circuit |
| (8) | UPDATE   | brand-A admin | brand-A non-self profile (name)   | OK (1 row affected) | tightened admin policy admits same-brand cross-user PATCH |
| (9) | UPDATE   | brand-A admin | brand-B profile (name)            | 0 rows   | core fix — cross-brand admin UPDATE silently affects 0 rows |
| (10)| UPDATE   | super_admin   | brand-B profile (name)            | OK (1 row affected) | super_admin retains cross-brand reach |
| (11)| UPDATE   | regular user  | OWN profile (dark_mode)           | OK (1 row affected) | self-arm + WITH CHECK still admit no-regression case |
| (12)| UPDATE   | regular user  | OWN profile with `id = <other>` in SET | REJECT (P0001-equivalent — actually surfaces as `new row violates WITH CHECK clause for policy "Users can update own profile"`; SQLSTATE 42501 (rls)) | row-key forgery defense — the new WITH CHECK clause |
| (13)| UPDATE   | brand-A admin | brand-A OTHER user's `role` to super_admin | REJECT (P0001) | trigger broadening per Q1 (Row J) — closes the same-brand role-escalation attack |
| (14)| UPDATE   | brand-A admin | brand-A OTHER user's `brand_id` to brand B | REJECT (42501 WITH CHECK violation) | WITH CHECK on admin policy already blocks this; sanity arm |
| (15)| UPDATE   | super_admin   | any user's `role` to super_admin  | OK       | trigger broadening positive control — super_admin can still promote |

**Arms (1)-(7)** cover the `order_schedule` tightening
(seven arms — INSERT/UPDATE/DELETE for both same-brand admit and
cross-brand reject, plus super_admin positive control).

**Arms (8)-(12)** cover the `profiles` tightenings (five arms —
admin cross-user same-brand admit, admin cross-brand reject,
super_admin positive control, regular-user self-WITH-CHECK
no-regression, regular-user row-key forgery).

**Arms (13)-(15)** cover the trigger extension from Q1 — closes
the same-brand role-escalation attack (Row J of the matrix), plus
WITH CHECK sanity for brand_id (Row F), plus super_admin positive
control.

**Fixture strategy.** Mirror Spec 041's pgTAP — use the seed
admin (`11111111...`), seed master (`33333333...`, promoted to
super_admin mid-txn), seed manager (`22222222...`). Insert a
foreign brand and a foreign store inside the test transaction,
along with one synthetic profile in the foreign brand and one
synthetic `order_schedule` row in the foreign store. All
fixtures roll back on transaction end.

**Hermetic isolation: `begin; ... rollback;`.** Identical pattern
to [supabase/tests/auth_can_see_store_brand_scope.test.sql:47, 549](../supabase/tests/auth_can_see_store_brand_scope.test.sql).

**Plan declaration:** `select plan(15);`.

**Optional shell smoke (out of scope for the pgTAP plan, but
suggested in the spec):** `scripts/smoke-rls-hardening-followups.sh`
exercising one curl PATCH against `/rest/v1/profiles?id=eq.<foreign>`
and one against `/rest/v1/order_schedule?store_id=eq.<foreign>`
from a brand-A admin's JWT, asserting non-2xx. The architect's
recommendation is **defer the shell smoke** — pgTAP already
exercises the policy at the SQL layer with full helper-function
truthiness; a PostgREST-layer smoke would add coverage for the
HTTP envelope but not for the policy itself. If the user wants
the extra layer of confidence, the smoke can be added in a
follow-up. **Plan: 15 arms in one file, no shell smoke.**

### 10. Migration shape (reference — backend-developer implements)

```sql
-- supabase/migrations/20260517050000_rls_hardening_followups.sql
--
-- Spec 042 — three policy tightenings + one trigger broadening.
-- Depends on Spec 041 (auth_can_see_store brand-arm). Rollback of
-- 041 requires rolling back 042 simultaneously.

-- Pre-flight: fail-closed if any admin/master profile has NULL brand_id.
-- Defense-in-depth (Spec 041 already checks this); a stray UPDATE between
-- 041 and 042 deploy could have re-introduced the gap.
do $$
begin
  if exists (
    select 1 from public.profiles
     where role in ('admin','master') and brand_id is null
  ) then
    raise exception
      '042: pre-flight failed: admin/master profile(s) with NULL brand_id exist; resolve before applying';
  end if;
end $$;


-- (1) order_schedule WRITE policy
drop policy if exists "Admins can write order_schedule" on public.order_schedule;
create policy "Admins can write order_schedule"
  on public.order_schedule for all
  using      (public.auth_is_privileged() and public.auth_can_see_store(store_id))
  with check (public.auth_is_privileged() and public.auth_can_see_store(store_id));
comment on policy "Admins can write order_schedule" on public.order_schedule is
  'Spec 042: admins limited to own-brand stores via auth_can_see_store; super_admin retains cross-brand via auth_is_super_admin short-circuit.';


-- (2) profiles cross-brand-admin update lockdown
drop policy if exists "Admins can update any profile" on public.profiles;
create policy "Admins can update any profile"
  on public.profiles for update
  using (
    (public.auth_is_privileged() and public.auth_can_see_brand(brand_id))
    or (id = auth.uid())
  )
  with check (
    (public.auth_is_privileged() and public.auth_can_see_brand(brand_id))
    or (id = auth.uid())
  );
comment on policy "Admins can update any profile" on public.profiles is
  'Spec 042: admin/master arm limited to own brand via auth_can_see_brand. Self-arm preserved. WITH CHECK mirrors USING — no brand-transfer during UPDATE.';


-- (3) profiles self-update WITH CHECK (defense-in-depth)
drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles for update
  using      (id = auth.uid())
  with check (id = auth.uid());
comment on policy "Users can update own profile" on public.profiles is
  'Spec 042: WITH CHECK added to block row-key forgery (UPDATE ... SET id = <other-uuid>). Defense-in-depth — no current attack chain reaches this gap.';


-- (4) Trigger broadening — role-write lockdown extends to ALL UPDATEs by
--     non-super_admin, not just self-UPDATEs (closes Row J of the spec's
--     Q1 matrix — brand-A admin promoting another brand-A user to super_admin).
--     The brand_id check stays self-only because the WITH CHECK on policy (2)
--     already blocks cross-user brand_id transfers.
create or replace function public.assert_brand_id_immutable_for_self()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if tg_op = 'UPDATE' and not public.auth_is_super_admin() then
    -- brand_id: still self-only — cross-user brand_id changes are blocked
    -- by the policy WITH CHECK + row-level profiles_role_brand_consistent CHECK.
    if old.id = auth.uid()
       and old.brand_id is distinct from new.brand_id then
      raise exception
        'brand_id is read-only for self-edits (super_admin only)';
    end if;
    -- role: ALL UPDATEs by non-super_admin, regardless of target row.
    -- Closes the same-brand role-escalation attack (Row J of Spec 042 Q1).
    if old.role is distinct from new.role then
      raise exception
        'role is read-only (super_admin only)';
    end if;
  end if;
  return new;
end
$$;

comment on function public.assert_brand_id_immutable_for_self() is
  'Spec 042 (extends Spec 041 round-1 fix): rejects any UPDATE that mutates profiles.role for non-super_admin callers (closing same-brand role-escalation), plus self-UPDATE of profiles.brand_id for non-super_admin (Spec 041 self-promotion fix preserved). The function name retains "for_self" for migration-history continuity; the role check is broader. Trigger binding profiles_self_brand_lock unchanged.';

-- The trigger binding (profiles_self_brand_lock) is unchanged because
-- create-or-replace-function preserves it. No drop trigger / create
-- trigger needed.
```

**SUPERSEDED TWICE — see §13's "Round-4 design revision" for
the FINAL architect-approved trigger body (2026-05-17).** Round-3
(`current_user in ('authenticated', 'anon')` inside a
SECURITY DEFINER trigger) was empirically refuted by the
backend-developer — `current_user` resolves to the function owner
(`postgres`) inside any SECURITY DEFINER body, so the cross-user
branch is unreachable. Round-4 switches the trigger function's
security mode from `SECURITY DEFINER` to `SECURITY INVOKER` so
`current_user` reflects the actual caller's role; the
discriminator `current_user in ('authenticated', 'anon')` then
works as originally intended. See §13 "Round-4 design revision
(with empirical verification)" for the full reasoning, the
empirical evidence cited from the dev's own round-3-failure
probe table, and the FINAL trigger body to ship.

Implementing the round-3 body verbatim (still on disk in
`supabase/migrations/20260517050000_rls_hardening_followups.sql`
lines 167-227) leaves Row J open — arm 13 fails 14/15. Always
copy §13's Round-4 body.

### 11. Risk summary by severity

| Severity | Risk | Mitigation |
|----------|------|------------|
| HIGH | Same-brand role-escalation (Row J of Q1) | Extend trigger per §13 Round-4 body (Option 1 — SECURITY INVOKER trigger); round-3 SECURITY DEFINER body was empirically refuted and is superseded |
| MEDIUM | "Admins can read all profiles" still permissive (Risk #3) | Out of scope per spec line 358-362 — flag for user as a follow-up spec |
| MEDIUM | "Admins can delete profiles" still permissive (Risk #4) | Out of scope per spec — `assert_not_last_of_role` (Spec 031) mitigates the worst case |
| LOW | "Anyone can insert own profile or admin can insert any" admin arm permissive (Risk #5) | Out of scope per spec — operational inertness limits damage |
| LOW | Migration ordering with Spec 041 (Risk #1) | Filename timestamp ordering + pre-flight DO block |
| LOW | OR-arm policy evaluation perf (Risk #2) | None needed — STABLE helpers + planner caching |
| LOW | pgTAP RLS isolation (Risk #7) | Hermetic begin/rollback per Spec 041 precedent |
| LOW | Function name vs body broadening (Risk #8) | Comment explains; future spec can rename |
| LOW | Trigger SECURITY mode change (Risk #9, round-4) | Documented invariant — future REVOKE on the trigger function must explicitly grant back to `authenticated, anon` |
| LOW | Service-role flows hit the no-op trigger branch (Risk #10, round-4) | Matches intended behavior — service-role is trusted by construction; allowlist excludes `service_role` |

### 12. Files the developer will touch

- **NEW**: `supabase/migrations/20260517050000_rls_hardening_followups.sql`
  — policy text + trigger broadening + pre-flight DO block.
- **NEW**: `supabase/tests/rls_hardening_followups.test.sql`
  — 15-arm pgTAP plan per §9 Q5.
- **NO CHANGES** to `src/lib/db.ts`, `src/store/useStore.ts`,
  `src/screens/cmd/sections/`, `supabase/functions/`,
  `supabase/config.toml`, `app.json`, `package.json`.

### 13. Deploy / dev steps

- After applying the migration locally via `npm run dev:db`, **no
  `docker restart supabase_realtime_imr-inventory` is needed**
  (no publication membership changes — see §6).
- Run pgTAP: `npm run db:test` or
  `scripts/test-db.sh supabase/tests/rls_hardening_followups.test.sql`.
- Existing 26 pgTAP test files must continue to pass — in
  particular, [supabase/tests/auth_can_see_store_brand_scope.test.sql](../supabase/tests/auth_can_see_store_brand_scope.test.sql)
  arms 7-8 reference the trigger's RAISE message strings. The
  trigger body change in §10 step 4 changes the role-error
  message from `'role is read-only for self-edits (super_admin
  only)'` to `'role is read-only (super_admin only)'`. **Spec 041's
  arms 7-8 must be updated to match the new message** — the
  backend-developer should update the Spec 041 test in lockstep,
  or the architect's preferred alternative is to keep the original
  Spec 041 message string and add a SECOND, more permissive RAISE
  with a different message. **Architect's decision: keep both
  messages distinct.** The cleanest path: introduce a new branch
  in the trigger that distinguishes self-edit vs cross-user. See
  the revised function body below — this preserves Spec 041's arm
  7/8 message-string contract verbatim.

**Revised trigger body (replaces §10 step 4 above) — FINAL, ARCHITECT-APPROVED 2026-05-17:**

```sql
create or replace function public.assert_brand_id_immutable_for_self()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if tg_op = 'UPDATE' and not public.auth_is_super_admin() then
    -- Self-edits: existing Spec 041 contract — message strings are
    -- contract per supabase/tests/auth_can_see_store_brand_scope.test.sql
    -- arms 7-8. DO NOT change these message strings.
    if old.id = auth.uid() then
      if old.brand_id is distinct from new.brand_id then
        raise exception
          'brand_id is read-only for self-edits (super_admin only)';
      end if;
      if old.role is distinct from new.role then
        raise exception
          'role is read-only for self-edits (super_admin only)';
      end if;
    elsif current_user in ('authenticated', 'anon') then
      -- Cross-user edits by AUTHENTICATED non-super_admin: NEW in Spec 042.
      -- Closes Row J — same-brand role-escalation. brand_id transfers are
      -- already blocked by the policy WITH CHECK + row-level CHECK.
      --
      -- The `current_user in ('authenticated', 'anon')` guard positively
      -- names the hostile contexts. PostgREST-routed traffic always runs
      -- under `authenticated` (or `anon` pre-login). Everything else —
      -- `postgres` migrations, pgTAP fixtures, `service_role` bearers —
      -- is exempt. This is the only reliable discriminator: `auth.uid()`
      -- can be a stale non-null residue from a prior `set_config(...,
      -- 'request.jwt.claims', ..., true)` that survives `reset role`
      -- (see Round-3 design revision below).
      if old.role is distinct from new.role then
        raise exception
          'role changes require super_admin';
      end if;
    end if;
  end if;
  return new;
end
$$;
```

**Final pgTAP arm (13) error-message contract:** the cross-user
role-escalation rejection surfaces as
`'role changes require super_admin'` (SQLSTATE `P0001`). Spec 041
arms 7-8 keep their original message strings unchanged.

**Round-3 design revision (2026-05-17) — empirical refutation of
the `auth.uid() is not null` guard:**

Backend-developer regression demonstrated that the prior guard
does NOT preserve Spec 041 fixtures. Reproducer:

```sql
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
reset role;
select auth.uid();  -- returns 11111111-... (NOT NULL — claims persist)
rollback;
```

`reset role` does NOT clear claims set via `set_config(name, value,
true)`. So Spec 041 arm-3's `reset role; update profiles set role=
'super_admin' where id=master_id;` executes with `auth.uid() =
admin_id` (stale, not null). The prior guard's cross-user branch
fires → `'role changes require super_admin'` → fixture setup fails.

**Measured test results with the prior `auth.uid() is not null`
guard:**

- New Spec 042 pgTAP (explicit-claim-clear pattern) → 15/15 PASS.
- Spec 041 pgTAP (existing pattern) → 2/14 PASS then ERROR at arm 3.

User constraint forbids amending Spec 041 fixtures, so the
"explicit claim clear" advisory is off the table. The
`auth.uid()`-based discriminator is unfixable without touching
041's fixture code.

**Final discriminator: `current_user in ('authenticated', 'anon')`.**

`current_user` reflects the actual Postgres role executing the
statement — never a JWT residue. Mapping:

| Caller context              | `current_user`   | Guard branch     |
|-----------------------------|------------------|------------------|
| PostgREST authenticated     | `authenticated`  | FIRES (hostile)  |
| PostgREST anon              | `anon`           | FIRES (no UPDATE policy anyway) |
| Migration script            | `postgres`       | SKIPS (trusted)  |
| pgTAP fixture after `reset role` | `postgres`  | SKIPS (trusted)  |
| service_role bearer         | `service_role`   | SKIPS (bypasses RLS entirely) |
| SECURITY DEFINER RPC body   | function owner (typically `postgres`) | SKIPS — RPC owns its own role-change semantics |

**Hostile surface check.** The only attacker-reachable contexts
are `authenticated` and `anon` (anon already lacks UPDATE
permission on profiles via policy). The positive allowlist names
exactly those two. Migration / fixture / service_role paths are
trusted by construction and exempt.

**SECURITY DEFINER caveat.** A SECURITY DEFINER RPC that runs as
`postgres` and forwards a caller-controlled `new.role` would
bypass this guard. None exist today (no RPC mutates `profiles.role`
directly — role changes flow through the `set-user-role` edge
function via `auth.admin.updateUserById`). If a future spec adds
such an RPC, the RPC body itself MUST gate on `auth_is_super_admin()`.
Filed as an architectural invariant; out of scope for Spec 042.

**Architect's final final verdict:** Option B (the dev's proposed
`current_user`-based guard, refined to the explicit allowlist
`current_user in ('authenticated', 'anon')`) is APPROVED. The
guard body shown in §13 above replaces the prior `auth.uid() is
not null` body verbatim. Spec 041 fixtures remain untouched per
user constraint.

Future fixture pattern (informational): pgTAP tests that need to
clear identity across role promotions can either (a) rely on the
new `current_user` discriminator (which makes `reset role`
sufficient by itself), or (b) explicitly clear claims via
`select set_config('request.jwt.claims', '', true)` before
`reset role`. Either pattern is correct under the new guard.

**Round-4 design revision (2026-05-17) — empirical refutation of
the round-3 SECURITY DEFINER trigger and final fix:**

Backend-developer regression (see §"Round-4 BLOCKER" above) showed
the round-3 body lands `current_user = postgres` inside the
`SECURITY DEFINER` trigger function — `current_user` reflects the
function OWNER, not the caller, for the duration of any
`SECURITY DEFINER` body. The cross-user branch is unreachable; the
Row J attack ONLY surfaces incidentally as a `23514`
`profiles_role_brand_consistent` CHECK violation when the target
has `brand_id != NULL`, and is fully unblocked if the target row
has `brand_id IS NULL` (e.g., a demoted former super_admin).

The four candidate options the dev surfaced have been evaluated.
The architect's decision is:

**Option 1 SELECTED: Switch the trigger function from
`SECURITY DEFINER` to `SECURITY INVOKER`.** All inner helpers
(`auth.uid()`, `public.auth_is_super_admin()`) remain
`SECURITY DEFINER` and continue to read `profiles` reliably
under the function owner's identity — those helpers are
independent of the trigger's outer mode. The trigger body's
`current_user` lookup then resolves to the caller's actual
Postgres role: `authenticated` / `anon` for PostgREST traffic,
`postgres` for migrations and for pgTAP after `reset role`,
`service_role` for service-role bearers. The round-3
discriminator (`current_user in ('authenticated', 'anon')`)
works correctly under this composition.

**Why not the other options:**

  - **Option 2 (`auth.jwt() -> 'role'` discriminator).** Off the
    table — same JWT-residue problem the round-3 revision
    explicitly closed (the JWT-claims survive `reset role` per
    the §13 round-3 empirical refutation). Re-introducing it
    would re-break Spec 041's arm-3 fixture, and the user
    constraint forbids amending Spec 041's fixtures.

  - **Option 3 (move the lockdown into the policy WITH CHECK
    via a correlated subquery).** Architecturally clean but
    higher blast radius and trickier semantics. The natural
    shape is
    `WITH CHECK (... AND (auth_is_super_admin() OR role IS NOT
    DISTINCT FROM (SELECT role FROM public.profiles p WHERE
    p.id = profiles.id)))`. The subquery is subject to SELECT
    RLS on `profiles`; the existing "Admins can read all
    profiles" policy admits the read in every UPDATE-admit
    path the spec scope cares about, so the NULL-subquery fail-
    closed case is a non-issue today. But: (a) the test arm 13
    contract would change from `P0001` /
    `'role changes require super_admin'` to `42501` /
    `'new row violates row-level security policy for table
    "profiles"'`, requiring an arm rewrite; (b) the
    correlated-subquery shape is harder to reason about in a
    future column-immutability audit than a plpgsql trigger
    branch; (c) it splits the role-immutability invariant
    across two layers (trigger for self-edits, policy for
    cross-user) where one layer (trigger) covered both modes
    cleanly in the round-3 design. Kept on file as the
    fallback if the Option-1 probe (below) surfaces an
    unexpected runtime behavior.

  - **Option 4 (SECURITY INVOKER inner helper called from the
    SECURITY DEFINER trigger).** Composition-semantics
    uncertain — Postgres's security context stack pushes a new
    context for SECURITY DEFINER; an inner SECURITY INVOKER
    call may or may not see the *outer-most session* role vs.
    the immediate (DEFINER) caller's role. The dev's empirical
    table at §"Round-4 BLOCKER" → "Empirical evidence (captured
    2026-05-17)" captures `current_user = authenticated` for a
    *direct* SECURITY INVOKER call, but NOT for the composition
    case (DEFINER → INVOKER). Without an additional empirical
    probe of the composition, this option is not architecturally
    crisp. Option 1 is the same outcome with smaller surface
    (one keyword swap) and no composition uncertainty.

**Empirical evidence (from the backend-developer's round-4
probe table — already in the spec at §"Round-4 BLOCKER" →
"Empirical evidence (captured 2026-05-17)"):**

| Context                                  | `current_user`   |
|------------------------------------------|------------------|
| Direct (no function wrapper)             | `authenticated`  |
| SECURITY INVOKER function (direct call)  | `authenticated`  |
| SECURITY DEFINER function (the trigger)  | `postgres`       |
| After `reset role`, direct               | `postgres`       |
| After `reset role`, SECURITY DEFINER     | `postgres`       |

Row 2 ("SECURITY INVOKER function (direct call) — `authenticated`")
is the load-bearing data point for Option 1. PostgreSQL 17 trigger
function semantics are documented to match a direct
SECURITY INVOKER call: "If trigger function is declared
SECURITY INVOKER, the function runs with the privileges of the
role that fires the trigger." The trigger is fired by the same
SQL statement the impersonated `authenticated` role is executing,
so `current_user` inside the INVOKER trigger body = the role
firing the trigger = `authenticated`. This is the same code path
the dev measured in row 2 — no composition assumption.

**Empirical-verification probe (REQUIRED before shipping —
backend-developer runs once, captures evidence in the migration
commit message or here):**

```sql
-- /tmp/probe_round4_option1.sql (run via:
--   docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres < /tmp/probe_round4_option1.sql
-- )
begin;

-- Synthesize a minimal SECURITY INVOKER trigger function that
-- records current_user. Hermetic — rolled back at the end.
create or replace function public._probe_trigger_invoker()
returns trigger language plpgsql security invoker as $$
begin
  raise notice 'PROBE: current_user=% session_user=%',
    current_user, session_user;
  return new;
end
$$;

-- Bind to a throw-away test table so we don't perturb profiles.
create temporary table _probe_t (id int, val text);
create trigger _probe_t_trg
  before update on _probe_t
  for each row execute function public._probe_trigger_invoker();
insert into _probe_t values (1, 'before');

-- Probe A: postgres role (migration / fixture context)
\echo '── PROBE A: postgres role direct ──'
update _probe_t set val = 'a' where id = 1;

-- Probe B: authenticated role with JWT impersonation
\echo '── PROBE B: authenticated role with JWT impersonation ──'
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '11111111-1111-1111-1111-111111111111',
    'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);
update _probe_t set val = 'b' where id = 1;

-- Probe C: after reset role (pgTAP fixture pattern)
\echo '── PROBE C: after reset role (pgTAP fixture pattern) ──'
reset role;
update _probe_t set val = 'c' where id = 1;

rollback;
```

**Expected output (Option 1 confirmed if the NOTICE lines match):**

```
── PROBE A: postgres role direct ──
NOTICE:  PROBE: current_user=postgres session_user=postgres
── PROBE B: authenticated role with JWT impersonation ──
NOTICE:  PROBE: current_user=authenticated session_user=postgres
── PROBE C: after reset role (pgTAP fixture pattern) ──
NOTICE:  PROBE: current_user=postgres session_user=postgres
```

If Probe B reports `current_user=authenticated` and Probes A and
C report `current_user=postgres`, the discriminator
`current_user in ('authenticated', 'anon')` correctly fires for
hostile PostgREST callers and skips for migrations/fixtures.
**Capture the actual NOTICE output in the migration commit
message so the next reviewer sees the empirical evidence
inline.** If Probe B surprises (e.g., reports `postgres`),
**STOP and fall back to Option 3** — the trigger-context
semantics are unexpectedly different from the dev's row 2
empirical baseline. Option 3 fallback shape:

```sql
-- Option 3 fallback (only if Option 1 probe surprises).
-- Trigger body REVERTS to round-3 self-only role check.
-- Cross-user role lockdown moves into the policy WITH CHECK.
drop policy if exists "Admins can update any profile" on public.profiles;
create policy "Admins can update any profile"
  on public.profiles for update
  using (
    (public.auth_is_privileged() and public.auth_can_see_brand(brand_id))
    or (id = auth.uid())
  )
  with check (
    (
      (public.auth_is_privileged() and public.auth_can_see_brand(brand_id))
      or (id = auth.uid())
    )
    and (
      public.auth_is_super_admin()
      or role is not distinct from (
        select p.role from public.profiles p where p.id = profiles.id
      )
    )
  );
-- Test arm 13 expectation changes:
--   from: throws_ok(... 'P0001', 'role changes require super_admin', ...)
--   to:   throws_ok(... '42501',
--                   'new row violates row-level security policy for table "profiles"',
--                   ...)
```

**FINAL trigger body to ship (Option 1 — replaces the round-3
body verbatim):**

```sql
create or replace function public.assert_brand_id_immutable_for_self()
returns trigger
language plpgsql
security invoker                  -- <<< CHANGED from `security definer`
set search_path = public, auth
as $$
begin
  if tg_op = 'UPDATE' and not public.auth_is_super_admin() then
    -- Self-edits: existing Spec 041 contract — message strings are
    -- contract per supabase/tests/auth_can_see_store_brand_scope.test.sql
    -- arms 7-8. DO NOT change these message strings.
    if old.id = auth.uid() then
      if old.brand_id is distinct from new.brand_id then
        raise exception
          'brand_id is read-only for self-edits (super_admin only)';
      end if;
      if old.role is distinct from new.role then
        raise exception
          'role is read-only for self-edits (super_admin only)';
      end if;
    elsif current_user in ('authenticated', 'anon') then
      -- Cross-user edits by AUTHENTICATED non-super_admin: NEW in Spec 042.
      -- Closes Row J — same-brand role-escalation. brand_id transfers are
      -- already blocked by the policy WITH CHECK + row-level CHECK.
      --
      -- The trigger function is SECURITY INVOKER as of Spec 042 round-4
      -- so `current_user` here reflects the caller's actual Postgres
      -- role. PostgREST authenticated → 'authenticated' (fires);
      -- pgTAP after `reset role` → 'postgres' (skips); migration →
      -- 'postgres' (skips); service_role bearer → 'service_role'
      -- (skips — service_role bypasses RLS but BEFORE triggers do
      -- still fire, so the explicit allowlist matters).
      --
      -- See §13 "Round-4 design revision" for the empirical evidence
      -- (PostgreSQL trigger semantics match a direct SECURITY INVOKER
      -- call — the dev's row-2 probe).
      --
      -- All inner helpers used here (auth.uid(), auth_is_super_admin())
      -- remain SECURITY DEFINER and continue to read profiles under
      -- the function owner's identity, independent of the trigger's
      -- SECURITY INVOKER mode.
      if old.role is distinct from new.role then
        raise exception
          'role changes require super_admin';
      end if;
    end if;
  end if;
  return new;
end
$$;

comment on function public.assert_brand_id_immutable_for_self() is
  'Spec 042 round-4 final (extends Spec 041 round-1 fix): rejects any UPDATE that mutates profiles.role for non-super_admin callers in hostile contexts (current_user in authenticated, anon). Function is SECURITY INVOKER as of round-4 so current_user inside the body reflects the caller''s Postgres role; inner helpers (auth.uid, auth_is_super_admin) remain SECURITY DEFINER and read profiles reliably under postgres. Round-3 was SECURITY DEFINER and `current_user` collapsed to postgres, leaving Row J open — see specs/042-rls-hardening-followups.md §"Round-4 BLOCKER" + §13 Round-4 revision for the empirical evidence.';
```

**Trigger binding (`profiles_self_brand_lock`) is unchanged.**
`create or replace function` preserves the existing trigger
binding, so the developer does NOT need a `drop trigger` /
`create trigger` pair. The trigger fires before every UPDATE on
`public.profiles` as before.

**Grant statement — none required.** Function EXECUTE defaults to
`PUBLIC` for `CREATE FUNCTION` in PostgreSQL. `authenticated` and
`anon` already have EXECUTE on
`public.assert_brand_id_immutable_for_self()` via the PUBLIC
grant. The Spec 041 migration did not REVOKE the default, and
Spec 042 does not either. The SECURITY INVOKER mode requires
the firing role to have EXECUTE — which they do.

**Risk #9 (round-4 specific, LOW).** Trigger security mode change
from DEFINER to INVOKER. If a future migration removes the
PUBLIC EXECUTE default (e.g., a `REVOKE EXECUTE ON ALL FUNCTIONS
IN SCHEMA public FROM PUBLIC`), authenticated UPDATEs on
`profiles` would fail because the trigger function couldn't be
fired. Today no such REVOKE exists; the
[supabase/migrations/20260505065303_admin_rpcs_lock_anon.sql](../supabase/migrations/20260505065303_admin_rpcs_lock_anon.sql)
migration revokes specific admin RPCs from anon but does not
touch the lockdown trigger. **Documented as an invariant** —
future migrations that REVOKE on `public.assert_brand_id_immutable_for_self`
must explicitly grant back to `authenticated, anon`.

**Risk #10 (round-4 specific, LOW).** Service-role / edge function
flows that mutate `profiles.role` (e.g., the `set-user-role` edge
function) hit the trigger under `current_user = service_role` —
the cross-user branch's allowlist excludes `service_role`, so
the trigger is a no-op for those flows. This matches the
intended behavior: service-role flows are trusted by
construction and may freely change roles. Spec 031's
`assert_not_last_of_role` guard (called by the `delete-user`
edge function via RPC) is unaffected — that's a separate guard
on DELETE, not UPDATE.

**pgTAP arm 13 message-string contract: UNCHANGED from round-3.**
Arm 13 continues to expect `P0001` /
`'role changes require super_admin'`. The new INVOKER trigger
body raises the exact same exception when the cross-user branch
fires.

**Files the backend-developer touches in round-4:**
- `supabase/migrations/20260517050000_rls_hardening_followups.sql`
  — replace the function body at lines 167-227 with the Option 1
  body above (change is essentially one keyword:
  `security definer` → `security invoker`, plus the updated
  `comment on function` text). Pre-flight DO block + three
  policy tightenings unchanged from round-3.
- `supabase/tests/rls_hardening_followups.test.sql` — NO
  CHANGES. The arm 13 expected error contract is preserved. Arms
  1-12 and 14-15 are unaffected.

**Architect's verdict:** Option 1 (SECURITY INVOKER trigger)
APPROVED. The keyword swap is the single load-bearing change.
The dev's row-2 empirical baseline + PostgreSQL trigger-function
documented semantics confirm `current_user = authenticated`
inside the INVOKER trigger body for impersonated callers. The
probe above is a final sanity check the dev runs once before
re-running the Spec 042 pgTAP plan. If arm 13 passes (15/15) and
the Spec 041 pgTAP still passes (14/14), the spec is shippable.

### 14. Handoff back to backend-developer

The migration must be implemented exactly per §10 (with the
**§13 Round-4 trigger body** — Option 1, SECURITY INVOKER) and
the pgTAP plan exactly per §9 Q5 (arm count = 15, plan
declaration `select plan(15);`).

The pre-flight DO block at the top of the migration is
mandatory — copy the Spec 041 precedent verbatim with the
prefix changed from "041" to "042".

The trigger broadening MUST preserve the original Spec 041
self-edit message strings (`'brand_id is read-only for self-edits
(super_admin only)'`, `'role is read-only for self-edits
(super_admin only)'`) so Spec 041's arms 7-8 continue to pass.
The new cross-user role-escalation rejection uses a distinct
message: `'role changes require super_admin'`.

**Round-4 specific instructions:**

1. **Run the empirical probe inlined in §13 Round-4 design
   revision BEFORE editing the migration.** Save the NOTICE
   output. Expected: Probe A/C report `current_user=postgres`,
   Probe B reports `current_user=authenticated`. If unexpected,
   STOP and use the Option 3 fallback shape inlined in the
   same section.
2. **Edit
   `supabase/migrations/20260517050000_rls_hardening_followups.sql`
   line 171** to change `security definer` → `security invoker`.
   Update the `comment on function` text per §13 Round-4 body.
   Pre-flight DO block + three policy tightenings unchanged.
3. **DO NOT modify
   `supabase/tests/rls_hardening_followups.test.sql`.** Arm 13's
   expected error contract is unchanged
   (`P0001 / 'role changes require super_admin'`).
4. **Re-run both pgTAP suites:**
   `scripts/test-db.sh supabase/tests/rls_hardening_followups.test.sql`
   should report 15/15. `scripts/test-db.sh supabase/tests/auth_can_see_store_brand_scope.test.sql`
   should still report 14/14.
5. **Capture the probe NOTICE output in the migration commit
   message** so the post-impl review has the empirical evidence
   inline. (Inlining in the migration SQL as a comment is also
   acceptable.)

No `src/`, `app.json`, or `package.json` changes ship with this
spec. The backend-developer should set
`Status: READY_FOR_REVIEW` after implementation and list the two
files under `## Files changed` (only the migration body shifts
relative to the round-3 surface; the test file is unchanged
text).


## Round-4 BLOCKER — backend-developer surface (2026-05-17)

**STOP — the §13 round-3 final discriminator is empirically broken.**
Surfaced after applying the architect-approved trigger body verbatim
and running both the new Spec 042 pgTAP and the existing Spec 041
pgTAP. Spec 041 → 14/14 PASS (good). Spec 042 → 14/15, arm 13 FAIL.

### What goes wrong

Arm 13 (the *core* security arm — brand-A admin promoting same-brand
target_a to super_admin) is supposed to surface as SQLSTATE `P0001`
with message `'role changes require super_admin'`. It actually
surfaces as SQLSTATE `23514` (`profiles_role_brand_consistent` CHECK
constraint), meaning the trigger never raised — the row-level CHECK
caught the malformed `role='super_admin' AND brand_id IS NOT NULL`
incidentally.

### Root cause — SECURITY DEFINER changes `current_user`

`public.assert_brand_id_immutable_for_self()` is `SECURITY DEFINER`
(preserved from Spec 041, line 171 of
`supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql`).
Inside a SECURITY DEFINER function body, `current_user` becomes the
**function owner** (`postgres`), **never the caller's role**. The
architect's mapping table at §13 lines 1216-1223 assumed
`current_user` reflects the caller. It does not — within this
trigger, all callers map to `postgres`.

### Empirical evidence (captured 2026-05-17)

Identical SECURITY DEFINER vs INVOKER probes under impersonated
`authenticated` JWT:

| Context | `current_user` | `session_user` | `auth.role()` |
|---|---|---|---|
| Direct (no function wrapper) | `authenticated` | `postgres` | `authenticated` |
| SECURITY INVOKER function | `authenticated` | `postgres` | `authenticated` |
| **SECURITY DEFINER function (the trigger)** | **`postgres`** | `postgres` | `authenticated` |
| After `reset role`, direct | `postgres` | `postgres` | `authenticated` (stale JWT) |
| After `reset role`, SECURITY DEFINER | `postgres` | `postgres` | `authenticated` (stale JWT) |

Confirmed by inlining `raise notice 'current_user=%', current_user`
inside the trigger function body: under the exact arm 13 scenario,
the trigger logs `current_user=postgres` — the
`current_user in ('authenticated', 'anon')` branch is unreachable
from any caller.

### Why Row J remains open

Arm 13 only "appears to be caught" because the test mutates a row
with `brand_id != NULL` and sets `role='super_admin'`, violating the
`profiles_role_brand_consistent` CHECK. That CHECK is incidental —
an attacker who picks a target with `brand_id IS NULL` (a former
super_admin demoted to user but with brand_id retained NULL, or
similar edge-state) would bypass the CHECK and complete the
escalation. The trigger is the **intended** defense; it doesn't
fire.

### Options for the architect's next round

These are flagged for the architect — backend-developer is NOT
choosing among them per CLAUDE.md policy ("Implement the architect's
design exactly. If it's flawed, STOP and surface").

1. **Switch trigger to SECURITY INVOKER.** Then `current_user`
   inside the function body reflects the caller's actual Postgres
   role. Trade-off: SECURITY DEFINER was selected in Spec 041 to
   guarantee the trigger fires consistently regardless of the
   caller's table-level GRANTs. INVOKER means the trigger can be
   suppressed if the caller lacks function EXECUTE privilege — but
   for a BEFORE UPDATE trigger on `profiles`, the only callers that
   matter (PostgREST authenticated, anon) already have EXECUTE on
   public functions by default, so the suppression risk is low.
   Need architect to confirm this trade-off.

2. **Discriminate via `auth.jwt() -> 'role'` (or similar JWT
   attribute) instead of `current_user`.** The JWT `role` claim is
   set by PostgREST per-request and represents the actual caller.
   Trade-off: same JWT-residue problem as `auth.uid()` after
   `reset role` in pgTAP — re-introduces the Spec 041 fixture
   regression unless the spec also approves explicit-claims-clear
   in pgTAP fixtures. The user constraint that "Spec 041 fixtures
   remain untouched" was previously cited as ruling this out.

3. **Move the cross-user role lockdown into the policy WITH CHECK**
   instead of the trigger. Add to "Admins can update any profile":
   `WITH CHECK ((... existing ...) AND (NOT (NEW.role IS DISTINCT
   FROM OLD.role) OR auth_is_super_admin()))`. The policy WITH
   CHECK runs in the caller's role context (no SECURITY DEFINER
   wrapper), so the role-change predicate sees the actual caller.
   Trade-off: NEW vs OLD in WITH CHECK requires a subquery against
   `profiles` (the WITH CHECK predicate only references NEW
   row-vars), so this needs a different shape than naive `OLD.role`
   reference. Architect to confirm the exact WITH CHECK form.

4. **Move the lockdown into a SECURITY INVOKER helper called from
   the SECURITY DEFINER trigger.** The trigger does its existing
   self-check work, then `if not public.is_super_admin_invoker_check()
   ...`. The invoker-mode helper preserves caller `current_user`.
   Trade-off: extra function, marginal complexity. Probably the
   smallest delta to land the security fix without changing the
   trigger's outer SECURITY DEFINER status.

### Asks for the architect

- Round-4 ruling on which of (1)-(4) above (or a fifth path) to
  ship. The session-state diagnostic above (PostgREST-equivalent
  vs migration-equivalent vs pgTAP-fixture-equivalent) is in the
  diff under `supabase/migrations/20260517050000_rls_hardening_followups.sql`
  (trigger body as approved in §13) and is reproducible end-to-end
  via `bash scripts/test-db.sh supabase/tests/rls_hardening_followups.test.sql`.
- Confirmation that the pgTAP fixture seed in arm 13 still uses a
  `brand_id != NULL` target and may need to gain an additional arm
  (16+) covering the `brand_id IS NULL` edge case once the
  trigger is correctly wired.
- Confirmation that Spec 041 fixture-immutability is still binding,
  or whether the user will permit (b) `select set_config('request.jwt.claims', '', true)` injection
  into Spec 041 arms 3, 4, 5 in exchange for a Spec 042 trigger
  that uses an `auth.uid() is not null` (or similar JWT-based)
  discriminator.

### Files left on disk (NOT shipped — for architect's review)

- `supabase/migrations/20260517050000_rls_hardening_followups.sql`
  — pre-flight DO, three policy tightenings, and trigger body
  per §13 round-3 final. Applied locally. Spec 042 pgTAP fails at
  arm 13 because of the SECURITY DEFINER `current_user` collapse
  documented above. Migration body is otherwise correct and the
  three policy tightenings work as designed.
- `supabase/tests/rls_hardening_followups.test.sql` — 15-arm plan
  per §9 Q5. Arms 1-12 and 14-15 pass; arm 13 fails because of
  the trigger discriminator issue, NOT a test-shape issue. The
  test is correct as written; if the trigger discriminator is
  fixed, arm 13 will pass without test changes.

### Status decision

`Status: BLOCKED_ON_ARCHITECT` — backend-developer cannot ship
until the architect issues a round-4 ruling on the SECURITY
DEFINER / `current_user` interaction. Returning to architect via
the Handoff section below.

### Architect's round-4 resolution (2026-05-17)

**Option 1 selected: switch the trigger function from
`SECURITY DEFINER` to `SECURITY INVOKER`.** Full reasoning,
empirical-verification probe, and FINAL trigger body in §13
"Round-4 design revision (with empirical verification)" above.
The keyword swap (`security definer` → `security invoker`) is
the single load-bearing change; pre-flight DO block, three
policy tightenings, and pgTAP arm 13 expected error contract
(`P0001 / 'role changes require super_admin'`) are unchanged.

Status updated to `READY_FOR_BUILD`. See §14 for the
backend-developer step list, including the probe SQL to run
once before editing the migration.


## Handoff
next_agent: backend-developer
prompt: Round-4 ruling complete. Switch the SECURITY mode of
  `public.assert_brand_id_immutable_for_self()` from `SECURITY
  DEFINER` to `SECURITY INVOKER` in
  `supabase/migrations/20260517050000_rls_hardening_followups.sql`
  (one keyword swap on line 171; the body and the comment-on-
  function text are unchanged behaviorally, but the spec at §13
  Round-4 has a refreshed comment string — copy it verbatim).
  All inner helpers (`auth.uid()`, `public.auth_is_super_admin()`)
  remain SECURITY DEFINER and continue to work correctly. Before
  editing the migration, run the empirical probe inlined in §13
  Round-4 (saved to /tmp/probe_round4_option1.sql in the spec
  body) via `docker exec -i supabase_db_imr-inventory psql -U
  postgres -d postgres < /tmp/probe_round4_option1.sql` and
  capture the NOTICE output in the migration commit message.
  Expected: Probe A/C → `current_user=postgres`, Probe B →
  `current_user=authenticated`. If unexpected, fall back to the
  Option 3 shape inlined in §13 (policy WITH CHECK + correlated
  subquery; arm-13 expected error becomes 42501 instead of
  P0001). pgTAP plan is unchanged; rerun both
  `scripts/test-db.sh supabase/tests/rls_hardening_followups.test.sql`
  (expect 15/15) and
  `scripts/test-db.sh supabase/tests/auth_can_see_store_brand_scope.test.sql`
  (expect 14/14). Set `Status: READY_FOR_REVIEW` after the suites
  pass and list the two files under `## Files changed`. The
  on-disk test file does not need any edit — its arm-13 contract
  is preserved.
payload_paths:
  - specs/042-rls-hardening-followups.md
  - supabase/migrations/20260517050000_rls_hardening_followups.sql
  - supabase/tests/rls_hardening_followups.test.sql
  - supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql
  - supabase/tests/auth_can_see_store_brand_scope.test.sql


## Files changed

Round-4 final implementation (Option 1 — SECURITY INVOKER trigger).
Empirical probe captured before edit; both pgTAP suites + full suite
+ typecheck all green; manual Row J attack now raises P0001 from the
trigger (not the incidental 23514 from round-3).

### Migrations
- `supabase/migrations/20260517050000_rls_hardening_followups.sql` —
  trigger function `public.assert_brand_id_immutable_for_self()`
  switched from `security definer` to `security invoker`, body
  comments updated to reflect round-4 rationale + inline probe
  evidence, `comment on function` text refreshed to the round-4
  string from §13. Pre-flight DO block + three policy tightenings
  (`order_schedule` write policy, "Admins can update any profile",
  "Users can update own profile") unchanged from round-3.

### pgTAP tests
- `supabase/tests/rls_hardening_followups.test.sql` — no changes
  (per round-4 ruling; arm 13's expected error contract
  `P0001 / 'role changes require super_admin'` is preserved and now
  passes).

### Verification artifacts (NOT shipped — for audit trail)
- `/tmp/probe_round4_option1_v2.sql` — empirical probe SQL (same as
  spec §13 inlined probe, plus `grant select, update on _probe_t to
  authenticated, anon` so the impersonated-role step can fire the
  trigger; the spec's original probe omitted this grant which made
  Probe B return `permission denied` instead of the
  `current_user=authenticated` notice).
- `/tmp/row_j_attack.sql` — Row J manual attack reproducer.

### Empirical probe output (captured 2026-05-17)

```
── PROBE A: postgres role direct ──
NOTICE:  PROBE: current_user=postgres session_user=postgres
── PROBE B: authenticated role with JWT impersonation ──
NOTICE:  PROBE: current_user=authenticated session_user=postgres
── PROBE C: after reset role (pgTAP fixture pattern) ──
NOTICE:  PROBE: current_user=postgres session_user=postgres
```

Matches the spec §13 expected outcome verbatim. Option 1 confirmed.

### Manual Row J attack reproduction (captured 2026-05-17)

```
NOTICE:  CAUGHT: sqlstate=P0001 message=role changes require super_admin
```

Trigger fires from inside `assert_brand_id_immutable_for_self` at
the `raise exception 'role changes require super_admin'` branch.
Round-3 incidentally surfaced SQLSTATE 23514 (the row-level
`profiles_role_brand_consistent` CHECK) because the trigger
discriminator was unreachable; with the round-4 SECURITY INVOKER
function the cross-user branch fires before the row CHECK is
evaluated.

### Test runs

- `bash scripts/test-db.sh supabase/tests/rls_hardening_followups.test.sql` → 15/15 PASS
- `bash scripts/test-db.sh supabase/tests/auth_can_see_store_brand_scope.test.sql` → 14/14 PASS
- `bash scripts/test-db.sh` → 27/27 PASS
- `npm run typecheck` → exit 0
