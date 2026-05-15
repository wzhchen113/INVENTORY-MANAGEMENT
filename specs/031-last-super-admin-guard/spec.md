# Spec 031: Last-super-admin / master deletion guard

Status: READY_FOR_REVIEW

## User story

As a master-role admin operating the Cmd UI, I want the system to refuse
to delete the final remaining `super_admin` profile (or the final
`master` profile) so that the Tenancy sidebar group (Brands), the brand
picker, and the role-management surface stay reachable in-app and we
never silently drop the project into a "recover-by-psql-only" state.

Symmetrically, as the engineer who designed the role model, I want the
guard enforced server-side in the `delete-user` edge function (the
authoritative gate) and mirrored optimistically client-side in
`UsersSection` (so the DELETE button is hidden when it would be
meaningless), with a regression-locking pgTAP test and a regression-
locking smoke arm.

### Foot-gun being closed

1. Spec 025 (backend-architect drift review, S1) surfaced: there is no
   guard against a master deleting the only remaining super-admin.
   With zero super-admin profiles, the TENANCY sidebar group disappears
   (`useIsSuperAdmin()` returns false for everyone, so
   `cmdSelectors` hides the Brands item), the brand picker disappears,
   and there is no in-app path to promote anyone back to super-admin.
2. Spec 029 release-proposal fast-follow item #4 reiterated the same
   foot-gun ("Guard against deleting the last `super_admin` / master
   (admin foot-gun)").
3. Recovery today requires a direct psql `update public.profiles set
   role='super_admin'` — that breaks the no-prod-dashboard-SQL
   convention captured in user memory `project_undeclared_prod_state`
   and forces a database-shell-using human into a path the app's own
   admin should be able to navigate. Closing this is the cheapest way
   to bring the role-management surface up to the standard the rest of
   the privileged-action paths already meet.

## Acceptance criteria

### Server-side refusal (authoritative gate)

- [ ] `supabase/functions/delete-user/index.ts` queries the
      `profiles.role` distribution before invoking
      `supabase.auth.admin.deleteUser(userId)`.
- [ ] If the target profile's role is `super_admin` AND the count of
      `profiles` rows where `role = 'super_admin'` is `<= 1` (i.e.
      the target IS the last one), the function returns HTTP `400`
      with body `{ "error": "cannot delete the last super_admin" }`.
- [ ] If the target profile's role is `master` AND the count of
      `profiles` rows where `role = 'master'` is `<= 1`, the function
      returns HTTP `400` with body
      `{ "error": "cannot delete the last master" }`.
- [ ] Both refusals use the same envelope shape as the existing
      self-delete refusal at
      `supabase/functions/delete-user/index.ts:59-64`
      (HTTP 400, JSON `{ error: <string> }`, `corsHeaders` spread).
      The error string is a stable identifier — reviewers / scripts /
      future jest can match on it.
- [ ] The refusal fires **before** any `supabase.from(...).delete()`
      side-effects (`user_stores`, `profiles`, `invitations`,
      `auth.admin.deleteUser`). The current function deletes
      `user_stores`, then `profiles`, then `invitations`, then auth
      user; the new check sits between the self-delete check (line 59)
      and the first `supabase.from("user_stores").delete()` (line 68)
      so no partial cleanup happens on a refused delete.
- [ ] The lookup uses the service-role client already constructed at
      `supabase/functions/delete-user/index.ts:66` for the deletes,
      not the caller's JWT client, so the count is RLS-bypassing and
      sees every profile regardless of the caller's
      `auth_can_see_store()` scope. (Per-store visibility is irrelevant
      here — "last super_admin" is a global predicate.)
- [ ] If the target user's `userId` does not resolve to a `profiles`
      row at all (e.g. auth-only user, no profile), the guard
      no-ops — the existing delete sequence runs as before. (We are
      not introducing a "must have a profile" requirement; we are only
      adding a refusal for two specific role conditions.)
- [ ] No new environment variable, no new edge-function dependency,
      no new import — the existing `supabase-js` client at line 66
      is sufficient.

### Client-side `canDelete` extension (UX hint, not security)

- [ ] `src/screens/cmd/sections/UsersSection.tsx` derives a
      `lastOfRoleByRole` map (or equivalent) from the already-fetched
      `users` list, of shape `{ super_admin: boolean; master: boolean }`,
      where each boolean is true iff exactly one row in `users` has
      that role.
- [ ] `UserRow`'s `canDelete` predicate is extended to additionally
      return `false` when:
        - `user.role === 'super_admin'` AND `lastOfRole.super_admin === true`, OR
        - `user.role === 'master'`      AND `lastOfRole.master === true`.
- [ ] The existing `canDelete` rules are preserved (master sees DELETE
      on everyone-except-self; non-master admins do not see DELETE on
      admin / master / super_admin rows; self-delete is already
      stripped per spec 029 / 030).
- [ ] No new RPC, no new edge-function call, no new query — the
      client derives the count from the same `users` array
      `fetchAllUsers()` already returns.
- [ ] When `canDelete` is suppressed by this new rule (versus the
      pre-existing rules), the row still renders with no DELETE
      button. **No tooltip / no explanatory text is required for v1**;
      the absence of the affordance is the UX. (Adding a tooltip is
      out of scope — separate UX spec — but the architect may surface
      it as a fast-follow if it is trivial. Keep this spec tight.)
- [ ] If `fetchAllUsers()` returns a brand-filtered subset (non-super
      admin in a brand), the local `lastOfRole` calculation is still
      correct *for the rows the user can see*, but the server-side
      guard is the authoritative check — if the client miscounts
      because of brand filtering and lets the button render, the
      server still refuses with HTTP 400. This is acceptable v1
      behavior (the only role that ever has more than one row is
      `master`, and master rows in `UsersSection` are gated by
      `useIsMaster()` — see the architect's design note).

### pgTAP regression test (DB-side simulation)

- [ ] New file `supabase/tests/delete_last_privileged_guard.test.sql`
      lands alongside the existing 14 pgTAP files in
      `supabase/tests/`. The file count goes from 14 to 15.
- [ ] Hermetic `begin; ... rollback;` shape, mirroring
      `supabase/tests/invitations_super_admin_rls.test.sql` (the spec
      026 sibling).
- [ ] Two arms, both `throws_ok` / `is` style:
        - Arm (i): the seed contains exactly one `super_admin` row
          after the test's setup; an emulated guard check (see
          architect's choice below) refuses to delete that row.
        - Arm (ii): the seed contains exactly one `master` row after
          the test's setup; the same emulated guard check refuses to
          delete that row.
- [ ] Test mechanism: the architect chooses between two
      implementation paths. The spec accepts either:
        - **Path A (preferred if the guard is implemented as a DB-side
          helper):** the guard is exposed as a SQL function such as
          `public.assert_not_last_of_role(target_id uuid)` that
          `raises_exception` (SQLSTATE 42501 or a custom 23xxx) when
          the target is the last of its role. The pgTAP test calls
          this function directly. The edge function then calls the
          same SQL via PostgREST RPC. **This avoids drift** because
          there is one source of truth.
        - **Path B (acceptable if the guard stays inline in the edge
          function):** the pgTAP test re-implements the same
          `count(*) where role = ?` query and asserts the count
          equals 1 for both `super_admin` and `master` after fixtures.
          A note in the SQL header explicitly cross-references the
          edge function line numbers so a future drift between the
          two implementations is loud during code review.
- [ ] If the architect picks Path B, the spec REQUIRES that the
      smoke test arm (next section) actually hit the edge function
      via HTTP so we have *some* end-to-end coverage of the inline
      JS-side logic. (If Path A is picked, the smoke arm is still
      desirable but moves from "load-bearing" to "defense-in-depth.")
- [ ] `npm run test:db` reports 15/15 pass (previously 14/14).

### Smoke test (Arm 6 of `scripts/smoke-edge-roles.sh`)

- [ ] `scripts/smoke-edge-roles.sh` gains an Arm 6 appended after
      Arm 5 (the escape-test arm).
- [ ] Arm 6 reuses the Arm 4 super_admin promotion machinery. Concrete
      sequence inside Arm 6:
        1. Confirm `$PROMOTED == "1"` (Arm 4 ran and the admin
           profile is currently `super_admin` + `brand_id = null`).
           If Arm 4 was skipped, Arm 6 SKIPs with the same reason
           shape.
        2. Confirm there is exactly one `super_admin` row in
           `profiles` (via `docker exec -i supabase_db_imr-inventory
           psql -tA -c "select count(*) from public.profiles where
           role='super_admin'"`). If the count is not 1 (because the
           operator had a pre-existing super-admin in the seed), the
           arm SKIPs cleanly — it can't run a "delete the last"
           experiment when there is more than one.
        3. Mint a fresh `$SUPER_ADMIN_BEARER` (reuse Arm 4's bearer
           if still valid; otherwise re-login admin@local.test).
        4. POST to `${SUPABASE_URL}/functions/v1/delete-user` with
           body `{"userId":"<admin@local.test's own id>"}` and the
           super-admin bearer. **This deliberately tries to delete
           one's own super_admin row.** Two refusals are in play:
             - The self-delete refusal at line 59–64 (HTTP 400
               `"cannot delete self"`).
             - The new last-super-admin refusal (HTTP 400
               `"cannot delete the last super_admin"`).
        5. Assert HTTP 400 AND body matches one of the two refusal
           strings. **Either is a PASS** — the assertion is "the
           function refused with a structured error," not "the
           function refused with *this specific* error." (Both
           refusals are correct; if the dev orders the new check
           before the self-delete check the new string wins, and
           vice versa. The architect should pick an order and the
           assertion follows.)
        6. **Confirm no state mutation occurred.** Re-query
           `select count(*) from public.profiles where
           role='super_admin'` — must still be 1. If it changed,
           the function partial-deleted and that is a FAIL.
- [ ] Arm 6 honors the existing `case "$SUPABASE_URL" in
      http://127.0.0.1:*|http://localhost:*` refuse-non-local guard at
      lines 53–60 of `scripts/smoke-edge-roles.sh` — the script ALREADY
      bails before Arm 1 if `$SUPABASE_URL` is remote. Arm 6 inherits
      this; no new check is needed.
- [ ] Arm 6 uses the same `pass` / `fail` / `skip` accumulator pattern
      (lines 78–80) as Arms 1–5. Failures accumulate into `$FAILED`
      and the final `exit $FAILED` reports non-zero if any arm
      failed.
- [ ] `npm run test:smoke` passes with Arm 6 present.

### Convention doc additions (strictly additive)

- [ ] `CLAUDE.md` gains a new bullet under "Conventions already in use"
      capturing the rule. Suggested text (exact wording is the
      architect / dev's call, but the substance must be):

      > **Edge functions performing destructive role-change or
      > deletion operations must include a last-of-role guard.**
      > Before invoking `auth.admin.deleteUser` (or any equivalent
      > destructive op) on a profile whose role is `super_admin` or
      > `master`, the function MUST count the remaining rows of that
      > role and refuse with HTTP 400 + structured error if the
      > delete would leave zero. Reference shape:
      > [supabase/functions/delete-user/index.ts](supabase/functions/delete-user/index.ts)
      > (spec 031). The DB-side mirror (Path A) or inline-and-cross-
      > referenced (Path B) decision is documented in the spec.

- [ ] `.claude/agents/security-auditor.md` gains a matching reminder
      bullet in whichever checklist section is appropriate (architect /
      dev to pick the section). Substance: "When reviewing destructive
      role-change or deletion edge functions, verify a last-of-role
      guard is present for `super_admin` and `master` targets." Cross-
      reference spec 031.
- [ ] Both additions are STRICTLY ADDITIVE. No existing bullet is
      reworded or reordered.

### Cross-cutting verification gates

- [ ] `npx tsc --noEmit` exits 0.
- [ ] `npm run typecheck:test` exits 0.
- [ ] `npm test -- --ci` PASS. No existing tests broken; if a jest
      suite covers `delete-user`'s client wrapper at
      `src/lib/auth.deleteUser` or the `UsersSection` `canDelete`
      logic, extend it to assert the new branch.
- [ ] `npm run test:db` PASS — file count goes 14 → 15.
- [ ] `npm run test:smoke` PASS — `smoke-edge-roles.sh` gains Arm 6.
- [ ] Manual: log in as the seed master (or promote admin to
      super_admin via the same dance Arm 4 uses), open
      `UsersSection`, verify the DELETE button does NOT render on the
      single super_admin row. Attempt the delete via the edge function
      directly (curl) and confirm HTTP 400 with the structured error.

## In scope

- Add server-side refusal to `supabase/functions/delete-user/index.ts`
  for last `super_admin` and last `master` targets, before any
  side-effects.
- Extend `UsersSection.tsx`'s `canDelete` derivation to hide DELETE on
  last-of-role rows. Derive from the existing `users` list — no new
  RPC.
- Add pgTAP test
  `supabase/tests/delete_last_privileged_guard.test.sql` covering both
  arms.
- Add Arm 6 to `scripts/smoke-edge-roles.sh`.
- Strictly-additive convention bullets in `CLAUDE.md` and
  `.claude/agents/security-auditor.md`.
- Architect picks Path A (DB function reused by both edge function
  and pgTAP) vs. Path B (inline in edge function, mirrored in pgTAP).
  Either is acceptable; Path A is preferred for drift avoidance.

## Out of scope (explicitly)

- **Role-demotion guard (edit role, not delete).** A master demoting
  the only super_admin via a role-edit picker is the same foot-gun
  shape but a different code path (`updateProfile` / role mutation
  flow, not the `delete-user` edge function). Deferred to a follow-up
  spec — the brief explicitly recommends "delete is the immediate
  footgun" for v1.
- **Brand-scope "last master in brand X" semantics.** For v1, "last"
  is a global count. A brand-isolated tenant could in principle want
  its own last-master guarded, but the data model currently has at
  most one master per brand and only a handful of brands. Defer.
- **Cascade on brand deletion if that brand's last master is also
  globally last.** Brand deletion goes through a different surface
  (`BrandsSection` + `delete-brand` flow) and the cascade behavior
  there is its own audit. Out of scope for this spec.
- **"Replace before delete" flow (deactivate master via promoting
  another user first).** UX feature; deferred. The guard refuses
  outright at server; admin must promote a replacement via the
  existing role-edit picker first, then re-attempt the delete. That
  is acceptable v1 UX.
- **Tooltip / disabled-button affordance on hidden DELETE.** The v1
  UX is button-absent. Adding a tooltip ("this user cannot be
  deleted because they are the last super_admin") is a UX polish for
  the next pass on `UsersSection`.
- **`useStore.test.ts` jest harness.** Spec 029's deferred follow-up
  remains its own spec. We do not stand it up here just to test
  this guard — the pgTAP + smoke arm coverage is sufficient.
- **Reports template backlog.** Unrelated.
- **`canDelete` / `canResetPassword` pure-helper extraction.** Spec
  029 explicitly deferred this; still deferred. We extend `canDelete`
  in place.
- **Touching `useRole()` placeholder.** Per CLAUDE.md, intentional.
- **Touching the `app.json` `slug`.** Per CLAUDE.md, do not change.

## Open questions resolved

- Q: Should we refuse outright when count == 1, or warn-and-confirm
  via a second prompt? → **A: refuse outright at the server.** Client
  hides the button so the user never reaches a refusal codepath in
  the common case. This matches the brief's recommendation
  ("Refuse outright at server. Client may show a tooltip/disabled
  state.") and matches how `delete-user` already refuses self-delete.
- Q: Should the role-demotion path (edit role, not delete) be folded
  into this spec? → **A: no, defer.** Delete is the immediate
  footgun; the role-edit surface is a different code path with its
  own UX and its own server-side hook. Filed as a follow-up.
- Q: Should "last" be brand-scoped or global? → **A: global.** Per
  the brief's recommendation. Per-brand-master may matter later but
  v1 covers the global predicate that prevents the
  recovery-by-psql state.
- Q: Path A (DB function shared with edge function) vs. Path B
  (inline in edge function, mirrored in pgTAP)? → **A: architect's
  call. Path A is preferred for drift avoidance** (one source of
  truth); Path B is acceptable if the architect judges the inline-
  in-edge-function pattern matches the existing convention of
  `delete-user` better. Both paths must produce the same observable
  HTTP 400 + structured error. If Path B is chosen, the pgTAP file
  header MUST cross-reference the edge function line numbers so
  drift is loud at code review (spec 027 §4.2 lesson — inline-not-
  shared edge function logic is invisible drift surface).
- Q: What HTTP code? → **A: 400.** Mirrors the existing self-delete
  refusal envelope at `delete-user/index.ts:59-64`. This is a
  caller-error class (the caller asked for something that would
  break the system state), not a permission error (403) or a server
  error (500).
- Q: Error message stability? → **A: stable identifiers.** Both
  `"cannot delete the last super_admin"` and `"cannot delete the
  last master"` are exact-match assertable. The smoke arm and any
  future jest can match on these strings.
- Q: What about a target with no `profiles` row (auth-only)? → **A:
  no-op the guard.** The current function ALREADY tolerates this
  (it best-effort deletes from `user_stores`, `profiles`,
  `invitations` and proceeds to `auth.admin.deleteUser` even if the
  first three find nothing). The guard returns "not last of any
  role" when the target has no profile. The existing flow proceeds.
- Q: What if the target's role is `admin` or `user` (not a privileged
  role)? → **A: guard no-ops, existing flow proceeds.** The guard
  ONLY checks the two privileged roles. Admin and user deletes are
  not foot-guns and stay on the existing fast path.

## Dependencies

- No new packages.
- No new edge-function dependencies. Reuses the existing
  `@supabase/supabase-js@2` import.
- **Path A only:** new migration adding the
  `public.assert_not_last_of_role(target_id uuid)` helper. Single
  SQL function, `security definer` so it can read `profiles` from
  inside an RPC the edge function calls via service role. Architect
  designs.
- **Path B only:** no new migration. SQL count lives inline in the
  edge function via `supabase.from('profiles').select(...,
  { count: 'exact' }).eq('role', target.role)`.
- Existing files touched (both paths):
  - `supabase/functions/delete-user/index.ts`
  - `src/screens/cmd/sections/UsersSection.tsx`
  - `supabase/tests/delete_last_privileged_guard.test.sql` (new)
  - `scripts/smoke-edge-roles.sh`
  - `CLAUDE.md` (additive bullet)
  - `.claude/agents/security-auditor.md` (additive bullet)

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only
  (`src/screens/cmd/sections/UsersSection.tsx`). Spec 025 already
  deleted the legacy admin surface; nothing to route around.
- **Per-store or admin-global:** Admin-global. "Last super_admin /
  master" is a global count, not per-store. The server-side count
  uses the service-role client and bypasses `auth_can_see_store()`.
- **Realtime channels touched:** None. `UsersSection` is fetch-on-
  mount + fetch-on-action by design (see comment at
  `UsersSection.tsx:17-19`). The new `lastOfRole` derivation runs
  against the already-fetched `users` array. No publication change,
  no realtime gotcha.
- **Migrations needed:** Path A — yes (one new SQL function, plus
  optional RPC wrapper if the edge function calls it via RPC rather
  than embedded SQL). Path B — no.
- **Edge functions touched:** `delete-user`. Requires `supabase
  functions deploy delete-user` after merge (release coordinator
  surfaces this).
- **Web/native scope:** Both. The `UsersSection` change is pure
  React Native + react-native-web. No web-only or native-only API.
- **Test track:** pgTAP (DB tests) + shell smoke (Arm 6) + a
  jest extension IF a `useStore.test.ts` or `UsersSection.test.tsx`
  scaffold already exists. Per spec 022's three-track convention
  the test-engineer routes coverage to the matching track. The
  brief's verification gates list all three; the pgTAP + smoke
  arm are load-bearing, jest is optional.
- **`app.json` slug:** Not touched.
- **Post-merge deploy step:** Yes — `supabase functions deploy
  delete-user`. Release coordinator surfaces this in the proposal.
  Path A also requires `supabase db push` (or equivalent) to apply
  the new migration before the edge-function deploy, so the edge
  function does not call a function that does not yet exist in
  prod. Architect specifies the migration filename and ordering.

## Drift / convention risks the architect should review

- **Spec 027 inline-not-shared lesson.** Edge function role gates
  mirror `auth_is_privileged()` and are inline (not under
  `_shared/`) precisely because shared modules are invisible drift
  surface for the supabase CLI's per-function deploy. The
  last-of-role guard is a sibling pattern: same rule, same risk. If
  the architect picks Path A (DB-side helper), drift is constrained
  to the SQL function alone. If Path B (inline in edge function),
  the pgTAP test header MUST cross-reference the edge function line
  numbers so a future change to one without the other is loud at
  code review.
- **Spec 026 / 027 "ADMIN_ROLES parity" lesson.** A future role
  added to the system (e.g. `billing_admin`) might or might not
  warrant the same last-of-role guard. The convention bullet in
  `CLAUDE.md` should make the rule explicit: "for super_admin and
  master." If a new privileged role lands, the spec for that role
  must explicitly decide whether the guard applies.
- **Brand-scope deferral.** "Last master in brand X" is deferred but
  worth a single sentence in the architect's design so a future
  spec author finds the carve-out. The current data model has at
  most one master per brand; the global predicate is a strict
  superset of any per-brand predicate, so v1 cannot regress per-
  brand behavior.

## Backend design

### 0. Path decision — Path A (DB-side helper)

Selected. The drift-avoidance argument the PM raised is decisive in this
case for three reasons:

1. **The guard is a database invariant, not an edge-function concern.**
   The thing we are protecting is the row distribution in `public.profiles`
   — specifically "there must always remain at least one row with
   `role='super_admin'` and at least one with `role='master'`." That
   property lives in SQL the same way `profiles_role_brand_consistent`
   (the existing role/brand CHECK at
   [supabase/migrations/20260509000000_multi_brand_schema_rls.sql:338-348](supabase/migrations/20260509000000_multi_brand_schema_rls.sql))
   does. The natural home is a DB function, not TypeScript.

2. **pgTAP gets stronger coverage.** Path B's pgTAP would re-implement
   the count predicate in SQL and assert against fixtures — it does NOT
   exercise the actual guard. Path A's pgTAP calls the live guard via
   `SELECT public.assert_not_last_of_role(...)`, which is the same
   function path the edge function takes via RPC. One source of truth,
   one regression detector.

3. **Spec 027 §4.2 "inline-not-shared" lesson cuts the OTHER way here.**
   Spec 027's lesson was about TypeScript code shared *across edge
   functions* via `_shared/` — invisible because the supabase CLI
   deploys one function at a time. Path A puts the shared code in
   **SQL**, not TypeScript. The migration is applied once
   (`supabase db push`); every PostgREST RPC caller sees the same
   function atomically. There is no per-deploy drift surface in SQL
   the way there is for `_shared/` TS. The "inline" rule applied to
   role-gate Sets specifically because hardcoding a 3-element Set per
   function was cheap; for a 12-line SQL helper that's also the pgTAP
   target, the symmetry collapses.

Path B remains acceptable for spec-AC compliance and the spec leaves the
choice open. We choose A.

### 1. Data model changes

**New migration:** `supabase/migrations/20260514160000_assert_not_last_of_role.sql`

Timestamp slot: `20260514160000` — strictly greater than
`20260514150000_invitations_super_admin_rls.sql` (the spec 026 sibling)
and on the same calendar day as the cluster of 2026-05-14 migrations.
Strictly additive — no table touches, no policy touches, no data
changes. A single `CREATE OR REPLACE FUNCTION` plus `GRANT EXECUTE`.

**No new tables, columns, or indexes.** The function reads
`public.profiles` (existing) via the
`20260509000000_multi_brand_schema_rls.sql:115-118` index on
`profiles(role)` (created in spec 012a) — count is already cheap.

**Helper signature (Path A specifies):**

```sql
-- supabase/migrations/20260514160000_assert_not_last_of_role.sql
--
-- Spec 031 — last-super-admin / master deletion guard. Single source
-- of truth for the "would this delete leave zero super_admins / masters"
-- invariant. Called by:
--   1. supabase/functions/delete-user/index.ts (via RPC) before
--      auth.admin.deleteUser() and the user_stores / profiles /
--      invitations cleanup.
--   2. supabase/tests/delete_last_privileged_guard.test.sql (direct
--      SELECT) — regression test.
--
-- Strictly additive. No tables/policies touched. No publication change.
-- Idempotent (CREATE OR REPLACE).

create or replace function public.assert_not_last_of_role(
  target_user_id uuid,
  target_role    text
)
returns void
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_count   bigint;
  v_message text;
begin
  -- No-op for roles we don't guard. 'admin' and 'user' deletes are
  -- not foot-guns; only the two privileged singleton roles are.
  if target_role is null or target_role not in ('super_admin', 'master') then
    return;
  end if;

  select count(*)::bigint
    into v_count
    from public.profiles
   where role = target_role;

  -- If the target is the last (or sole) row of its role, refuse.
  -- The count includes the target itself, so <= 1 means deleting the
  -- target would leave zero.
  if v_count <= 1 then
    v_message := case target_role
      when 'super_admin' then 'cannot delete the last super_admin'
      when 'master'      then 'cannot delete the last master'
    end;
    raise exception using
      errcode = 'P0001',
      message = v_message;
  end if;
end;
$$;

grant execute on function public.assert_not_last_of_role(uuid, text) to authenticated, service_role;
```

**Why `security definer` + `set search_path`:**

- The helper must count `public.profiles` rows **globally**, not
  filtered through the caller's RLS view. `auth_can_see_store()` /
  brand RLS would otherwise return a brand-scoped count for a
  brand-admin caller, which is the wrong predicate ("last super_admin
  in my brand" is meaningless — super_admin has `brand_id IS NULL` by
  the `profiles_role_brand_consistent` CHECK).
- `security definer` runs with the function owner's rights (the
  Supabase `postgres` superuser when applied via `supabase db push`)
  which bypasses RLS for the count.
- `set search_path = public, auth` locks the resolution path — same
  shape as `auth_is_super_admin()` /
  [auth_can_see_brand()](supabase/migrations/20260509000000_multi_brand_schema_rls.sql:200-210).
  Prevents search-path injection if a caller has set a misleading
  `search_path` in their session.
- `stable` declares the function as read-only (no side effects, same
  output for same input within a single statement).

**Why `errcode = 'P0001'`:**

`P0001` is the standard PostgreSQL "raise_exception" SQLSTATE for
plpgsql `raise exception` without an explicit code. It is what
`pgtap`'s `throws_ok()` matches by default. `42501` (insufficient
privilege) is wrong here — this is not an authz failure, it is a
caller-error class. We let the message text carry the meaning.

**Why pass `target_role` rather than re-resolve from `profiles`:**

The edge function already needs to read the target's role (to surface
"target has no profile → no-op") and then makes a separate cleanup
sweep. Passing the role keeps the helper a pure predicate (count + raise)
with no profile lookup, which makes the pgTAP path simpler: the test
sets up its own fixture and calls the function with a known role.

**Destructive vs additive:** Strictly additive. `CREATE OR REPLACE` is
idempotent; re-running the migration is a no-op. No existing table or
policy is touched. Rollback is trivial: `drop function public.assert_not_last_of_role(uuid, text);`.

### 2. RLS impact

**None.** This migration adds no table and modifies no existing policy.
The `profiles` table's existing RLS (per
[20260509000000_multi_brand_schema_rls.sql:451-471](supabase/migrations/20260509000000_multi_brand_schema_rls.sql))
is untouched — `auth_is_privileged()` gates writes, per-brand select
is gated by `auth_can_see_brand()`. The new function is `security
definer` and bypasses RLS by design (justified above).

The function `GRANT EXECUTE` is scoped to `authenticated, service_role`.
`anon` is NOT granted — there is no realistic caller path for an
anonymous user to trigger a profile delete, but defense-in-depth says
the function should not be reachable from an unauthenticated context.
Mirrors the grants pattern in
[20260509000000_multi_brand_schema_rls.sql:241-243](supabase/migrations/20260509000000_multi_brand_schema_rls.sql)
EXCEPT the `auth_is_*` family grants `anon` too (because the RLS
policies call them in their `using` clause and `anon` reads must
short-circuit cleanly). This function is only ever called from RPC, so
`anon` is unnecessary.

### 3. API contract

**RPC, not PostgREST table/view.** Single function call from one
caller (the edge function). No filter/sort/pagination requirements.
PostgREST RPC is the natural shape.

**Request shape** (from `supabase/functions/delete-user/index.ts`):

```ts
const { error: guardError } = await supabase.rpc('assert_not_last_of_role', {
  target_user_id: userId,
  target_role: targetRole,  // 'super_admin' | 'master' | 'admin' | 'user' | null
});
```

Argument names use `snake_case` to match PostgREST's parameter binding
convention (which expects argument names to match the SQL signature
exactly). The function is `target_user_id uuid, target_role text`.

**Response shape (success):** `data = null, error = null`. The function
returns `void`.

**Response shape (refusal):** PostgREST surfaces a raised plpgsql
exception as a `PostgrestError` with:

```
{
  code:    'P0001',
  message: 'cannot delete the last super_admin',  // or '...master'
  details: null,
  hint:    null,
}
```

The edge function inspects `error.message` and returns it verbatim in
the HTTP 400 envelope.

**Error cases:**

| Scenario | RPC result | Edge function action |
|----------|-----------|---------------------|
| `target_role` is `null` (target has no profiles row) | `error = null` (helper returns early) | proceed with delete |
| `target_role` is `'admin'` or `'user'` | `error = null` (helper returns early) | proceed with delete |
| `target_role` is `'super_admin'` AND count > 1 | `error = null` | proceed with delete |
| `target_role` is `'super_admin'` AND count `<=` 1 | `error.message = 'cannot delete the last super_admin'` | return HTTP 400 |
| `target_role` is `'master'` AND count `<=` 1 | `error.message = 'cannot delete the last master'` | return HTTP 400 |
| RPC itself errors (network, DB down, etc.) | non-P0001 PostgrestError | return HTTP 500 (existing catch handler) |

**SQLSTATE / code:** `P0001` (default plpgsql raise_exception code).

### 4. Edge function changes

**File:** `supabase/functions/delete-user/index.ts` — modify only.
**`verify_jwt` setting:** unchanged (the function is JWT-gated by the
Supabase gateway plus `requireAdminCaller()` at line 21; no entry in
`[functions.delete-user]` in `supabase/config.toml` means it inherits
the default `verify_jwt = true`). No `config.toml` change.

**No new env vars, no new imports.** Uses the existing service-role
`supabase` client at line 66.

**Exact call-site placement:**

The new logic goes **between** the self-delete refusal (current
lines 59–64) and the construction of the service-role client (current
line 66). Specifically:

1. After line 64 (`}` closing the `if (userId === gate.userId)` block).
2. Construct the service-role client (current line 66) — moved up by
   one logical block so the role lookup uses it.
3. Look up target role: `select role from profiles where id = userId limit 1`.
4. If the target has no profile row (`data` is null OR `error.code === 'PGRST116'`
   "no rows"), the guard no-ops — the existing delete sequence proceeds.
   (Spec AC: auth-only user no-op.)
5. If a profile row exists, RPC `assert_not_last_of_role(userId, role)`.
6. If the RPC returns `error.code === 'P0001'`, return HTTP 400 with
   the verbatim `error.message`. Mirrors the self-delete envelope shape.
7. If the RPC returns any other error, return HTTP 500 with
   `error.message` (matches the existing catch-all at line 84-89).
8. Fall through to the existing `user_stores` / `profiles` /
   `invitations` / `auth.admin.deleteUser` sequence (lines 68-79).

**Pseudocode** (developer authors the real TypeScript):

```ts
// AFTER line 64 (self-delete refusal closing brace), BEFORE existing line 66.

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Look up target's role. If no profile row exists (auth-only user),
// skip the guard entirely — the existing delete sequence handles it.
const { data: targetProfile, error: lookupError } = await supabase
  .from("profiles")
  .select("role")
  .eq("id", userId)
  .maybeSingle();

if (lookupError && lookupError.code !== "PGRST116") {
  // Unexpected lookup failure (not "no rows"). Bail with 500.
  return new Response(JSON.stringify({ error: lookupError.message }), {
    status: 500,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

if (targetProfile?.role) {
  // RPC the SQL helper. P0001 → HTTP 400 with verbatim message;
  // anything else → HTTP 500.
  const { error: guardError } = await supabase.rpc("assert_not_last_of_role", {
    target_user_id: userId,
    target_role: targetProfile.role,
  });
  if (guardError) {
    const status = guardError.code === "P0001" ? 400 : 500;
    return new Response(JSON.stringify({ error: guardError.message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// ──── existing delete sequence continues (current lines 68-79) ────
await supabase.from("user_stores").delete().eq("user_id", userId);
// ...
```

**Why `.maybeSingle()` rather than `.single()`:** `.single()` errors
when zero rows are returned (auth-only user has no profile row). Spec
AC says the guard no-ops in that case. `.maybeSingle()` returns
`data = null` cleanly for the zero-row case.

**Ordering rationale (new guard AFTER self-delete refusal):** The
smoke arm 6 deliberately tries to delete one's own super_admin row.
With the self-delete check at line 59 firing FIRST, the smoke arm
gets `"cannot delete self"`. With the new check first, the smoke arm
would get `"cannot delete the last super_admin"`. Either is correct
per the spec AC, but keeping self-delete first preserves byte-for-byte
backward compatibility with anything (jest, other smokes) that already
asserts the self-delete string for the same call shape. **The new
check goes AFTER self-delete.** The smoke arm asserts either string
matches (per spec AC).

### 5. Error envelope (verbatim)

Mirrors the self-delete envelope at
[delete-user/index.ts:59-64](supabase/functions/delete-user/index.ts):

```
HTTP/1.1 400 Bad Request
Content-Type: application/json
<cors headers spread>

{"error":"cannot delete the last super_admin"}
```

and:

```
HTTP/1.1 400 Bad Request
Content-Type: application/json
<cors headers spread>

{"error":"cannot delete the last master"}
```

**Wording is verbatim** — `cannot delete the last super_admin` and
`cannot delete the last master`. Lower-case "cannot delete the last",
lower-case role name, underscore in `super_admin` (matches the role
literal exactly). These strings are stable identifiers; the smoke arm,
any future jest, and any client code asserting on them must match
byte-for-byte.

### 6. `src/lib/db.ts` surface — none

**No changes to `src/lib/db.ts`.** Per the spec's project notes, the
client-side check uses the already-fetched `users` array from
`fetchAllUsers()` (which lives in `src/lib/auth.ts`, not `db.ts`). The
edge function call already goes through `deleteProfile` →
`auth.deleteUser` → `delete-user` edge function. No new helper is
needed. No snake_case → camelCase mapping changes.

### 7. Client-side `canDelete` extension

**File:** `src/screens/cmd/sections/UsersSection.tsx` — modify only.

**Derivation point:** Inside `UsersSection()` (not `UserRow`), after
the existing `rawUsers = users || []` line at line 69 and before the
existing `visibleUsers = ...` derivation at line 70. The map is
derived from `rawUsers` (the full fetched set), NOT `visibleUsers`
(the role-filtered subset shown to non-master admins), so the count
matches what the server sees for the caller's brand.

**Shape:**

```ts
// Spec 031 — derive last-of-role counts from the same fetched users
// array. The server is the authoritative gate (delete-user edge fn
// calls assert_not_last_of_role); this is a UX hint that hides the
// DELETE button when the server would refuse.
const lastOfRole = {
  super_admin: rawUsers.filter((u) => u.role === 'super_admin').length <= 1,
  master:      rawUsers.filter((u) => u.role === 'master').length <= 1,
};
```

Pass `lastOfRole` down to `<UserRow ... lastOfRole={lastOfRole} />`.
`UserRow` extends `canDelete` (currently at line 267-269):

```ts
const canDelete = (isMaster
  ? !isSelf
  : !isSelf && user.role !== 'admin' && user.role !== 'master' && user.role !== 'super_admin')
  // Spec 031 — also suppress DELETE for the last super_admin / master
  // (would otherwise hit a server HTTP 400). The server is authoritative;
  // this is a UX hint, not security.
  && !(user.role === 'super_admin' && lastOfRole.super_admin)
  && !(user.role === 'master'      && lastOfRole.master);
```

**Brand-filtering edge case (per spec AC line 106-114):** when
`fetchAllUsers({ brandId })` returns a brand-filtered subset for a
non-super admin, the client's `lastOfRole.super_admin` may be true
(zero super_admins visible) when the global count is > 1 (super_admin
has `brand_id IS NULL` per the
[profiles_role_brand_consistent CHECK](supabase/migrations/20260509000000_multi_brand_schema_rls.sql:338-348),
so they're invisible to brand-scoped queries). However:

- Non-super admins in `UsersSection` already cannot see `super_admin`
  rows at all — `visibleUsers` filters them out at line 71.
- A brand-scoped admin's `rawUsers` contains only their brand's
  profiles; `lastOfRole.super_admin` will be `false` (`rawUsers.filter(...)
  .length` is 0, not <= 1)... wait — `0 <= 1` is `true`. The
  predicate as written would suppress DELETE on any visible
  super_admin row when none are visible. But no super_admin row is
  visible in that case (visible filter strips them), so the predicate
  is unreachable. Defense-in-depth: the predicate uses `<= 1` because
  the server-side helper uses `<= 1`, so the client mirrors the server
  exactly. Visible-zero-rows is harmless because there's no row to
  suppress.

If a brand-scoped admin somehow saw exactly 1 master row in
`rawUsers`, `lastOfRole.master = true` and the DELETE on that master
is suppressed — which is correct for that brand-scoped admin's view.
The server-side helper would refuse it too if the global master count
were 1, and would accept it if global > 1; the client may suppress
even when global > 1 (over-conservative, UX hint only).

This is acceptable v1 behavior. The server is the authoritative gate.

**No new prop validation** — `lastOfRole` is plain `{ super_admin:
boolean; master: boolean }`. TypeScript signature on `UserRow`'s
props expands by one field.

**No tooltip / no explanatory text** per spec AC line 102-105.

### 8. Realtime impact

**None.** `UsersSection` does not subscribe to any realtime channel
(see comment at [UsersSection.tsx:17-19](src/screens/cmd/sections/UsersSection.tsx)
— user/invite changes are rare enough that fetch-on-mount + fetch-on-
action is sufficient).

The new migration does NOT touch the `supabase_realtime` publication
(it adds a function, not a table). The `docker restart
supabase_realtime_imr-inventory` ritual from
[20260514140000_realtime_publication_tighten.sql](supabase/migrations/20260514140000_realtime_publication_tighten.sql)
does NOT apply here.

**Publication gotcha (call-out):** No publication change in this
migration. No `docker restart supabase_realtime_imr-inventory` step
needed for dev or deploy.

### 9. Frontend store impact

**Minimal.** The `useStore` slice unchanged. `deleteProfile` already
toasts the backend error via `notifyBackendError` (`useStore.ts:23`),
so the new HTTP 400 from the edge function will surface as a toast
("cannot delete the last super_admin") if a user somehow bypasses
the client gate and POSTs the delete directly — which is the correct
optimistic-then-revert pattern. No code change in `useStore.ts` is
required.

The existing toast surface for delete failures works without
modification: `deleteProfile` (which calls `deleteUser` in
`src/lib/auth.ts`) reads `error.message` from the edge function's
JSON response and passes it to `notifyBackendError`. The verbatim
strings from §5 land in the toast.

> (Update — spec 032 closed the silent-success gap surfaced by the
> spec 031 code-reviewer S1 finding. Prior to spec 032,
> `callEdgeFunction` swallowed non-2xx and the toast never fired.
> Refer to spec 032 §"Caller chain audit" for the verified path.)

### 10. pgTAP test design

**File:** `supabase/tests/delete_last_privileged_guard.test.sql` (new).
File count goes 14 → 15 per spec AC line 120.

**Shape:** mirrors [invitations_super_admin_rls.test.sql](supabase/tests/invitations_super_admin_rls.test.sql)
— hermetic `begin; ... rollback;` with seed-based fixtures.

**Plan: `select plan(4)`.** Four arms:

1. **Arm (i) — last super_admin refused.** Promote seed master (id
   `33333333-...`) to `role='super_admin'`, `brand_id=null` inside the
   txn. Confirm exactly one super_admin row exists in `profiles`.
   `throws_ok` on `select public.assert_not_last_of_role(<master_id>,
   'super_admin')` with SQLSTATE `P0001` and message exactly
   `'cannot delete the last super_admin'`.

2. **Arm (ii) — last master refused.** Seed already has exactly one
   master row (id `33333333-...`, brand A). Confirm count is 1.
   `throws_ok` on `select public.assert_not_last_of_role(<master_id>,
   'master')` with SQLSTATE `P0001` and message exactly
   `'cannot delete the last master'`.
   - **Caveat:** because Arm (i) UPDATE'd the master row to
     super_admin, Arm (ii) needs to either run BEFORE Arm (i), or
     UPDATE the row back to `role='master', brand_id='2a000000-...'`
     before its check. Cleanest order: Arm (ii) first (no setup
     needed, master role already present in seed), THEN Arm (i)
     (promote master → super_admin, then check super_admin count).

3. **Arm (iii) — non-last super_admin allowed.** INSERT a second
   super_admin row inside the txn (reuse an existing auth.users.id
   — likely the seed manager id `22222222-...` — and UPDATE its
   profile to `role='super_admin', brand_id=null`). Confirm count is
   2. `lives_ok` on `select public.assert_not_last_of_role(<first_id>,
   'super_admin')` — the function returns void with no exception.

4. **Arm (iv) — non-last master allowed.** UPDATE the seed admin row
   (id `11111111-...`) to `role='master', brand_id='2a000000-...'`
   so count is 2. `lives_ok` on `select public.assert_not_last_of_role
   (<one_master_id>, 'master')`.

**Why hermetic `rollback`:** the test mutates profiles inside the txn
(promotes seed users between roles). Rollback restores the seed
exactly. Mirrors the pattern at
[invitations_super_admin_rls.test.sql:29-141](supabase/tests/invitations_super_admin_rls.test.sql).

**JWT context:** unlike the invitations test, this helper runs as
`security definer` and does not check `auth.uid()`. **No need to
`set local role authenticated` or stuff `request.jwt.claims`.** The
test runs as the default `supabase db reset` / `pg_prove` superuser
context, which the `security definer` function honors.

**`npm run test:db` reports 15/15 pass** (was 14/14).

### 11. Smoke Arm 6

**File:** `scripts/smoke-edge-roles.sh` — append after Arm 5
(currently lines 269-304, the escape-test arm). Same `pass` / `fail` /
`skip` accumulator (lines 78-80). Same refuse-non-local guard at
lines 53-60 — Arm 6 inherits it (no new check needed).

**Sequence inside Arm 6 (matching spec AC line 160-193 verbatim):**

1. SKIP if `$PROMOTED != "1"` (Arm 4 did not promote). Same skip
   shape as Arm 4 (line 214) and Arm 5 (line 271). Reason string:
   `"Arm 4 super_admin promotion did not run"`.
2. SKIP if pre-existing super_admin count is not 1:
   ```bash
   SA_COUNT=$(docker exec -i supabase_db_imr-inventory psql -tA \
     -U postgres -d postgres \
     -c "select count(*) from public.profiles where role='super_admin';" \
     2>/dev/null | tr -d ' ')
   ```
   If `SA_COUNT != 1`, SKIP with reason `"super_admin count is $SA_COUNT
   (need exactly 1 for this arm)"`. This protects against an operator
   who has a pre-existing super_admin row (e.g.
   `wzhchen113@gmail.com` from spec 012a §7) that would make the
   "last super_admin" arm meaningless.
3. Resolve target user id (the admin user that was promoted in Arm 4):
   ```bash
   ADMIN_UID=$(docker exec -i supabase_db_imr-inventory psql -tA \
     -U postgres -d postgres \
     -c "select id from auth.users where email='${ADMIN_EMAIL}' limit 1;" \
     2>/dev/null | tr -d ' ')
   ```
4. POST to `${SUPABASE_URL}/functions/v1/delete-user` with body
   `{"userId":"${ADMIN_UID}"}` and `Authorization: Bearer
   ${SUPER_ADMIN_BEARER}`.
5. Assert HTTP 400 AND body matches one of:
   - `cannot delete self` (existing self-delete refusal — see line 59-64)
   - `cannot delete the last super_admin` (new last-of-role refusal)
   ```bash
   if [[ "$CODE" == "400" ]]; then
     if printf '%s' "$BODY" | grep -qE '"error":"cannot delete (self|the last super_admin)"'; then
       pass "delete-user refused last-super-admin or self (HTTP 400, $BODY)"
     else
       fail "expected refusal string, got: ${BODY:0:200}"
     fi
   else
     fail "expected 400, got $CODE: ${BODY:0:200}"
   fi
   ```
   Per the design at §4 ordering rationale, the self-delete check
   fires first, so in practice the smoke gets `cannot delete self`.
   The Arm accepts either string per spec AC.
6. **Re-confirm no state mutation:** re-query super_admin count.
   Must still be 1. If changed (function partial-deleted before
   refusing), FAIL.
7. `$FAILED` accumulator (same as Arms 1-5) returns non-zero on any
   arm failure.

**`npm run test:smoke` passes with Arm 6.**

### 12. Convention doc additions

#### 12.1 `CLAUDE.md` — new bullet under "Conventions already in use"

Append AFTER the spec-028 "Edge function HTML email templates escape
interpolated values" bullet and BEFORE the "Imports" bullet. Verbatim
wording:

```
- **Edge functions performing destructive role-change or deletion operations include a last-of-role guard.** Before invoking `auth.admin.deleteUser` (or any equivalent destructive op) on a profile whose role is `super_admin` or `master`, the function MUST call `public.assert_not_last_of_role(target_user_id, target_role)` via RPC. The helper raises SQLSTATE `P0001` with message `'cannot delete the last super_admin'` or `'cannot delete the last master'` when the delete would leave zero rows of that role. The function maps `P0001` to HTTP 400 + structured error and refuses BEFORE any side-effect deletes. Reference shape: [supabase/functions/delete-user/index.ts](supabase/functions/delete-user/index.ts) (spec 031). The SQL helper is the single source of truth — pgTAP exercises the same function the edge function calls via RPC. If a new privileged role lands (e.g. `billing_admin`), the spec for that role must explicitly decide whether the guard applies and update both the SQL function and this bullet.
```

Strictly additive; no existing bullet reworded. The "spec 031"
back-reference matches the spec-026/027/028 anchor style.

#### 12.2 `.claude/agents/security-auditor.md` — new reminder bullet

Append AFTER the existing "Audit HTML body interpolations for
`escapeHtml` wrap" bullet (line 50). Verbatim wording:

```
- Audit destructive role-change or deletion edge functions for last-of-role guard parity. Any edge function that calls `auth.admin.deleteUser` or executes a role demotion / profile delete on a target whose role can be `super_admin` or `master` MUST gate the destructive op behind `supabase.rpc('assert_not_last_of_role', { target_user_id, target_role })` BEFORE any side-effect `from(...).delete()` runs. A function that omits this gate, or runs it AFTER cleanup deletes, is **High** (operator footgun — leaves the project recoverable only by direct psql access; not a privilege escalation). Reference shape: `supabase/functions/delete-user/index.ts` (spec 031). The DB-side helper raises SQLSTATE `P0001`; the function must map to HTTP 400 with a structured error.
```

Strictly additive. Inserted into the existing "Edge functions —
`verify_jwt` and service-token validation" section so a security
auditor sees it alongside the other edge-function-specific gates.

### 13. Migration ordering and deploy step

#### Local dev

1. Author the migration as `supabase/migrations/20260514160000_assert_not_last_of_role.sql`.
2. Apply via `supabase migration up` OR `supabase db reset` (the
   latter re-applies seed.sql + all migrations from scratch).
   `npm run dev:db` reboots the stack and re-applies migrations.
3. `npm run test:db` picks up the new pgTAP file automatically (the
   runner at `scripts/test-db.sh` globs `supabase/tests/*.sql`).
4. `npm run test:smoke` runs Arm 6 against the local stack.

**No `docker restart supabase_realtime_imr-inventory` needed** — no
publication change. (Defensive call-out per the architect prompt.)

#### Post-merge production deploy

**Order matters.** The edge function calls a function that doesn't
yet exist in prod until the migration is applied. Sequence:

1. **First:** `supabase db push` to apply the migration. Verify the
   function exists with:
   ```sql
   select prokind, proname from pg_proc
    where proname = 'assert_not_last_of_role';
   -- expected: 'f' / 'assert_not_last_of_role' (one row)
   ```
2. **Second:** `supabase functions deploy delete-user`.

If 2 lands before 1, the function returns HTTP 500 (`function
public.assert_not_last_of_role(uuid, text) does not exist` from
PostgREST) on every privileged-role delete — fail-closed, but not the
intended UX. The order matters and the release-coordinator should
surface both steps in the deploy proposal.

**CI assumption:** Per CLAUDE.md "CI workflow" — the
`db-migrations-applied.yml` workflow is NOT on disk. Do NOT design
around CI gating the order. Manual verification per the two-step
above.

### 14. Risks and tradeoffs

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Migration applied AFTER edge function deploy (operator runs deploy out of order). | Low | Function returns HTTP 500 fail-closed — no delete succeeds. Operator notices on first attempt. Spec calls out the order explicitly. |
| `security definer` function read by a future caller from outside `delete-user`. | Low | Function is pure read + raise; no writes. `GRANT EXECUTE` is `authenticated, service_role` (no anon). Worst case: an `authenticated` caller can probe role counts globally — but the function does not return the count, only raises or returns void. Information leak is binary: "is target the last?" — which the caller already knows by querying their visible profiles. Not exploitable. |
| Smoke arm 6 ordering: if a future dev moves the new check BEFORE the self-delete check, the smoke assertion still passes (matches either string). Risk: assertion becomes too loose. | Low | Spec AC accepts either string. If we want to tighten, a follow-up can add a second arm that targets a DIFFERENT user's last-of-role row (no self-delete collision). Out of scope for v1. |
| pgTAP fixture shares the seed master id (`33333333-...`) with the spec 026 sibling test. Two concurrent test runs of the same DB → conflicts. | Negligible | `npm run test:db` runs serially via `pg_prove`. Each test is hermetic (rollback). No concurrency issue. |
| Brand-scoped admin sees inflated `lastOfRole` count (UI suppresses DELETE over-conservatively). | Acceptable | Spec AC accepts this. Server is authoritative. Worst case: admin manually toggles role of a non-last master, then deletes — extra click. |
| `target_role` argument is caller-supplied (the edge function reads it from `profiles` but the SQL function doesn't re-validate). If a future caller passes a stale or forged role, the count may target the wrong role. | Low | Helper short-circuits for non-{super_admin, master} roles. Worst case: caller passes `'master'` when target is actually `'admin'` — function raises if master count is 1, blocking an admin delete. UX bug (caller's fault), not security. Inside the edge function the lookup at line 64+ is atomic w.r.t. the RPC; no TOCTOU window. |
| `profiles.role` UPDATE between the role lookup and the RPC (TOCTOU). | Negligible | The window is <100ms inside the same edge function invocation. Concurrent role mutations are extremely rare (admin clicking around in UI). If they do collide, the helper's count + raise is atomic — at worst the call refuses spuriously and the operator retries. No data loss. |
| Cold-start: edge function fn-deploy gains one round-trip RPC. | Negligible | RPC adds ~10ms vs the existing direct table reads. Edge-function cold starts dominate at hundreds of ms. Imperceptible. |
| Performance on 286 KB seed: `count(*) from profiles where role = ?` over ~5 rows. | Negligible | Existing `profiles_role` btree from
[20260509000000_multi_brand_schema_rls.sql](supabase/migrations/20260509000000_multi_brand_schema_rls.sql). Even at prod scale (hundreds of profiles), this is a partial index scan, <1ms. |
| Helper signature evolution (e.g. adding a third privileged role). | Manageable | The helper's role-check list is a `not in ('super_admin', 'master')` early-return at the top. A new role would require: (1) updating the helper's `case` block, (2) updating the `CLAUDE.md` bullet's role list, (3) updating the pgTAP test to add an arm. The convention bullet at §12.1 calls this out. |
| RLS gap: the helper is `security definer` and bypasses RLS. Misuse could leak. | Low | Function returns `void` — no row data. Only raises an exception with a fixed string. Even a malicious authenticated caller learns nothing they can't learn from their own visible profiles count. `anon` is not granted. |

### 15. Cross-cutting notes

- **No `app.json` touch.** Per CLAUDE.md.
- **No `src/lib/db.ts` change.** The edge function uses its own
  Supabase client (service role). The client never directly calls
  the new helper.
- **No new role types.** Helper accepts `text`; the spec's privileged
  set is `{'super_admin', 'master'}` and the helper short-circuits
  for everything else.
- **No new env var.** Edge function reuses the existing service-role
  client at the current line 66 (moved up by one logical block).
- **Spec 027 inline-not-shared lesson does NOT apply.** That lesson
  was about TypeScript shared modules under `_shared/`. Path A's
  shared code is SQL, deployed once via `supabase db push`. The
  symmetry holds: helper is one source of truth, called from one
  edge function and one pgTAP test.
- **Spec 026/027 `ADMIN_ROLES` parity lesson DOES apply.** A future
  role added to the privileged set must update both the SQL helper's
  `case` block and the `CLAUDE.md` convention bullet. The bullet at
  §12.1 captures this carve-out explicitly.
- **Brand-scope deferral is fine.** Per the spec's out-of-scope
  list: the v1 predicate is global count, and the data model
  guarantees super_admin has `brand_id IS NULL`. Per-brand-master
  semantics are deferred.

### 16. Files the developer will touch

**New (2):**
- `supabase/migrations/20260514160000_assert_not_last_of_role.sql`
- `supabase/tests/delete_last_privileged_guard.test.sql`

**Modified (4):**
- `supabase/functions/delete-user/index.ts` (insert ~25 lines between
  current lines 64 and 66)
- `src/screens/cmd/sections/UsersSection.tsx` (derive `lastOfRole`,
  pass to UserRow, extend `canDelete` predicate — ~10 lines)
- `scripts/smoke-edge-roles.sh` (append Arm 6 — ~40 lines)
- `CLAUDE.md` (one new bullet, ~6 lines)
- `.claude/agents/security-auditor.md` (one new bullet, ~6 lines)

**Unchanged:**
- `supabase/config.toml` (no `verify_jwt` change)
- `src/lib/db.ts`
- `src/lib/auth.ts`
- `src/store/useStore.ts`
- `app.json`
- Realtime publication

## Handoff
next_agent: backend-developer
prompt: Implement against the design in this spec. Path A is selected
  — author the migration at supabase/migrations/20260514160000_assert_not_last_of_role.sql,
  the pgTAP test at supabase/tests/delete_last_privileged_guard.test.sql,
  the edge-function changes to supabase/functions/delete-user/index.ts,
  the UsersSection.tsx canDelete extension, smoke Arm 6 in
  scripts/smoke-edge-roles.sh, and the additive bullets in CLAUDE.md
  and .claude/agents/security-auditor.md (verbatim wording in §12).
  After implementation, set Status: READY_FOR_REVIEW and list files
  changed under ## Files changed.
payload_paths:
  - specs/031-last-super-admin-guard/spec.md

## Files changed

### Migrations (new)
- `supabase/migrations/20260514160000_assert_not_last_of_role.sql` — Path A
  helper `public.assert_not_last_of_role(uuid, text)`. `security definer`
  + `set search_path = public, auth`. Counts `profiles` rows of the given
  role excluding the target; raises `P0001` with stable message
  (`'cannot delete the last super_admin'` / `'cannot delete the last master'` /
  generic `'cannot delete the last %s'`) if no other rows remain. No-ops
  for `null` / `admin` / `user` targets. `GRANT EXECUTE` to `authenticated`
  + `service_role`. `CREATE OR REPLACE` (idempotent).

### Tests (new)
- `supabase/tests/delete_last_privileged_guard.test.sql` — pgTAP regression.
  `plan(4)` with hermetic `begin … rollback`. Architect ordering preserved:
  Arm (i) `throws_ok` last-master refusal → Arm (ii) `lives_ok` non-last
  master → Arm (iii) `throws_ok` last-super_admin refusal (after promoting
  seed master to super_admin) → Arm (iv) `lives_ok` non-last super_admin.
  All four arms target the canonical SQL helper via `select
  public.assert_not_last_of_role(...)`. `npm run test:db` now reports
  15/15 (was 14/14).

### Edge functions (modified)
- `supabase/functions/delete-user/index.ts` — inserted the last-of-role
  guard AFTER the self-delete refusal at line 59-64 and BEFORE the
  `user_stores` / `profiles` / `invitations` deletes. Moved the
  service-role `supabase` client construction up by one logical block so
  the role lookup uses it. Uses `.maybeSingle()` on the role lookup
  (auth-only user → no-op). RPC `assert_not_last_of_role` mapped:
  `P0001` → HTTP 400 with verbatim `error.message`; any other error →
  HTTP 500. Existing `corsHeaders` envelope shape preserved (matches the
  self-delete refusal envelope).

### Smoke (modified)
- `scripts/smoke-edge-roles.sh` — appended Arm 6 after Arm 5. SKIPs if
  Arm 4's super_admin promotion did not run, if no `SUPER_ADMIN_BEARER`,
  or if the pre-existing super_admin count is not 1. Resolves the admin
  uid via `docker exec psql`, POSTs `delete-user` with the promoted
  user's own id, asserts HTTP 400 + body matches either
  `'cannot delete self'` or `'cannot delete the last super_admin'`
  (self-delete fires first per the design ordering — both refusals are
  correct). Re-queries super_admin count post-call to confirm no
  state mutation. Inherits the existing `case "$SUPABASE_URL" in
  http://127.0.0.1:*|http://localhost:*` refuse-non-local guard.

### Client (modified)
- `src/screens/cmd/sections/UsersSection.tsx` — derived
  `lastOfRole = { super_admin: bool, master: bool }` from `rawUsers`
  (the full fetched set, NOT `visibleUsers`) inside `UsersSection()`
  before the `visibleUsers` derivation. Threaded the new prop down to
  `<UserRow>` and extended the `canDelete` predicate to additionally
  refuse when the target is the last super_admin or master. UX hint
  only; server is authoritative.

### Convention docs (modified — strictly additive)
- `CLAUDE.md` — new bullet under "Conventions already in use", inserted
  AFTER the spec-028 escapeHtml bullet and BEFORE the "Imports" bullet.
  Verbatim wording from the architect's §12.1.
- `.claude/agents/security-auditor.md` — new audit-rule bullet under the
  "Edge functions — `verify_jwt` and service-token validation" section,
  inserted AFTER the spec-028 escapeHtml audit bullet. Verbatim wording
  from the architect's §12.2.

### Post-merge deploy steps (user runs, in this order)
1. `npx supabase db push --project-ref ebwnovzzkwhsdxkpyjka` — applies
   the migration. The edge function in step 2 RPCs the helper this
   migration creates; deploying the function before the migration
   yields HTTP 500 (`function … does not exist`) on every privileged
   delete attempt.
2. `npx supabase functions deploy delete-user --project-ref ebwnovzzkwhsdxkpyjka` —
   deploys the new edge-function logic.
