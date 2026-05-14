# Spec 026: Post-spec-025 cleanup batch

Status: READY_FOR_REVIEW

## Background

Spec 025 (`d1fd3aa`) shipped the legacy-app deletion and surfaced 12
fast-follow tickets in
`specs/025-delete-legacy-app/reviews/release-proposal.md`. The user has
scoped items **#1 (invitations RLS gap)**, **#6 (CLAUDE.md doc rot)**,
and **#7 (orphan `json-server` devDep)** for this cleanup batch. The
three items are bundled because each is small, low-risk, and each is a
direct surface area opened by spec 025's deletions or design choices:

1. **`invitations` RLS does not include `super_admin`** — pre-existing
   weakness in `supabase/migrations/20260424211733_security_fixes.sql:38-57`.
   Spec 025 §2.G.1 broadened the UI `isMaster` predicate to include
   `super_admin`, so the new "Invite User" button in `UsersSection` is
   the trigger for a product-correctness regression: a super-admin's
   first click yields RLS rejection because the four `invitations`
   policies hard-code `array['admin','master']` and never call any
   helper that recognizes `super_admin`. The fix has direct prior art
   from spec 013 (`supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql`)
   and the order_schedule sibling fix
   (`supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql`):
   replace the raw JWT IN-list with `public.auth_is_privileged()`.

2. **CLAUDE.md (and the subagent prompt files) still reference deleted
   modules.** After spec 025 deleted `AppNavigator.tsx`,
   `featureFlags.ts`, `useSupabaseStore.ts`, `useJsonServerSync.ts`,
   `db.json`, `src/lib/api.ts`, the `npm run db` script, and the
   `EXPO_PUBLIC_NEW_UI` env flag, six sections of `CLAUDE.md` describe
   reality that no longer exists. The same stale references appear in
   eight subagent prompt files under `.claude/agents/`. Agents read
   these as the project contract on first invocation — stale text will
   actively mislead future agents into trying to modify deleted files
   or assuming the flag-gated fork still exists.

3. **`json-server` devDependency is orphaned.** Every consumer
   (`db.json`, `useJsonServerSync.ts`, `src/lib/api.ts`, `npm run db`)
   was deleted in spec 025. `package.json:72` still pins
   `json-server: ^1.0.0-beta.15`. Dead weight in
   `npm install` and the audit surface.

## User story

As a future agent (PM, architect, dev, reviewer) booting into this
repo, I want CLAUDE.md and my own subagent prompt to describe the
post-spec-025 reality accurately, so that I do not waste cycles
investigating files that no longer exist or producing designs that
re-introduce flag-gated forks.

As a super-admin who clicks the "Invite User" button in Cmd UI's Users
section, I want the INSERT to succeed (instead of being rejected by
RLS), so that the new invitation flow my role unlocked actually works
end-to-end.

As a developer running `npm install` in CI, I want zero orphan
dev-dependencies in `package.json`, so that install time and `npm
audit` noise are not inflated by code that has been deleted.

## Acceptance criteria

### Track A — Invitations RLS broadened to super_admin

- [ ] **A1.** A new migration at
      `supabase/migrations/20260513120000_invitations_super_admin_rls.sql`
      (or the next available timestamp after the most recent migration
      `20260514140000_realtime_publication_tighten.sql` if the
      architect prefers strict monotonic — architect's call; see Q1
      under Open questions resolved) drops and recreates the four
      `invitations` policies originally declared at
      `supabase/migrations/20260424211733_security_fixes.sql:42-57`.
      Each replacement policy uses `public.auth_is_privileged()` for
      both `using` and (where applicable) `with check`, matching the
      shape established by
      `supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql`
      and
      `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql`.

- [ ] **A2.** All four policies are rewritten — SELECT, INSERT, UPDATE,
      DELETE. The names match the originals exactly (`"Admins can read
      invitations"`, `"Admins can insert invitations"`, `"Admins can
      update invitations"`, `"Admins can delete invitations"`) so the
      end-state diff is a clean replacement, not an addition of
      parallel policies.

- [ ] **A3.** Migration is idempotent and re-runnable: each policy is
      dropped with `drop policy if exists` before being recreated. No
      data changes (DDL only).

- [ ] **A4.** A pgTAP test lands at
      `supabase/tests/invitations_super_admin_rls.test.sql` that
      verifies the three role bands against an INSERT against
      `public.invitations`, mirroring the structure of
      `supabase/tests/eod_submissions_consistency.test.sql`:
    - (i) `app_metadata.role = 'admin'` JWT: INSERT succeeds
          (regression check — pre-existing behavior preserved).
    - (ii) `app_metadata.role = 'super_admin'` JWT + a `profiles` row
           with `role = 'super_admin'` for the impersonated `auth.uid()`
           (because `auth_is_super_admin()` reads `profiles.role`, not
           the JWT — see
           `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:187-195`):
           INSERT succeeds.
    - (iii) `app_metadata.role = 'user'` JWT (no privileged profile
            row): INSERT is rejected with SQLSTATE `42501` via
            `throws_ok()`.
      The test uses the spec-022 framing (`begin; create extension if
      not exists pgtap; select plan(N); ...; select * from finish();
      rollback;`) and runs cleanly under `npm run test:db`.

- [ ] **A5.** The seed file `supabase/seed.sql` is **not** modified —
      the test creates its own super_admin `profiles` row inside the
      hermetic transaction (the seed has no super_admin user today and
      this spec does not change that).

- [ ] **A6.** No other file is touched by the migration or the test.
      Specifically: `src/components/cmd/InviteUserDrawer.tsx` and
      `src/screens/cmd/sections/UsersSection.tsx` are not modified.
      The UI already calls `inviteUser()` correctly; only the policy
      was wrong.

### Track B — CLAUDE.md and subagent-prompt doc rot

- [ ] **B1.** `CLAUDE.md` is edited to remove stale references to the
      following deleted-by-spec-025 modules. The post-state must not
      contain (case-insensitive search) any of: `AppNavigator`,
      `featureFlags`, `EXPO_PUBLIC_NEW_UI`, `useJsonServerSync`, or
      `useSupabaseStore`. References to `db.json`, the `npm run db`
      script, and `src/lib/api.ts` are also removed — these may persist
      only in historical commentary that explicitly notes they were
      deleted in spec 025 (e.g., a one-line "Spec 025 deleted X, Y, Z"
      note in the "Resolved questions" section is acceptable; living
      references in the "Conventions" or "Gaps" blocks are not).

- [ ] **B2.** Specifically:
    - **Stack > Routing line (line 14):** drop the `+ AppNavigator`
      half. New line reads roughly "Routing: React Navigation 6 +
      custom desktop 'Cmd' shell — `src/navigation/CmdNavigator.tsx`."
    - **Project structure block (lines 33-51):** drop the
      `AdminScreens.tsx` and `AppNavigator` lines; drop the
      "InventoryListScreen / ItemDetailScreen" line if the mobile
      fallback was also part of the legacy delete (architect to
      verify); ensure `featureFlags.ts` is not mentioned in the
      `lib/` line.
    - **Conventions > UI fork via env flag (line 55):** rewrite to
      "Cmd UI is the only client" (no fork, no flag). Drop the
      `App.tsx:117` reference (line 117 is no longer the flip; App.tsx
      mounts `CmdNavigator` unconditionally per spec 025 AC20).
    - **Current state > Gaps and unknowns:**
        - Drop the "Possibly-stale legacy data layer" bullet (line 80)
          entirely — those files no longer exist.
        - Drop the "Two coexisting stores" bullet (line 81) — there is
          only one store.
        - Drop the "Large legacy file" bullet (line 82) about
          `AdminScreens.tsx` — that file is gone.
    - **Resolved questions > Data layer:** rewrite the "Legacy — do
      not modify" subsection (lines 201-210) to state that the
      `useSupabaseStore.ts` / `useJsonServerSync.ts` / `db.json` /
      `npm run db` set was deleted in spec 025 and is preserved here
      as a historical note only.
    - **Resolved questions > Legacy admin screens (lines 219-222):**
      either remove the section entirely or replace it with a one-line
      historical note that `AdminScreens.tsx` was deleted in spec 025.
      Architect's preference; either is acceptable as long as no
      living rule about "do not modify AdminScreens.tsx" remains.

- [ ] **B3.** The eight subagent prompt files under `.claude/agents/`
      with the same stale references are updated to match. Files:
    - `code-reviewer.md` — lines 36, 37, 40 (the "frozen file" list
      and the "json-server / db.json patterns" line).
    - `frontend-developer.md` — lines 15, 34, 73-77, 80 (Stack /
      Routing line referencing AppNavigator; the
      `EXPO_PUBLIC_NEW_UI` description; the "Hard rules — do not
      modify these files" list).
    - `backend-developer.md` — lines 34-41 (same do-not-modify list).
    - `backend-architect.md` — lines 45-46 (the "do NOT design
      changes to legacy code" instruction).
    - `test-engineer.md` — lines 47, 51-54 (the
      "AdminScreens.tsx is frozen" line and the legacy-files list).
      Also fix the "there is no test framework" prose if present —
      spec 022 landed jest + pgTAP + shell smoke; the agent prompts
      may still reference its absence.
    - `product-manager.md` — lines 25, 61, 76 (Cmd-vs-legacy probing
      question and the frozen-files rule). My own prompt; I will be
      its first downstream consumer.
    - `workflow-orchestrator.md` — line 72 (frozen-file list).
    - `workflow-auditor.md` — line 30 (frozen-file rule #4).
      For each: remove references to deleted files; collapse the
      do-not-modify list to whatever frozen files remain (the
      `app.json` slug at minimum; possibly `useStore.ts` is
      *not* frozen so it should not be on any do-not-modify list).
      Architect to confirm the exact remaining frozen-file list at
      design time.

- [ ] **B4.** No prose is invented beyond removing stale references
      and replacing them with the minimal accurate description.
      "While I was here" rewrites of unrelated sections are out of
      scope (see Out of scope §3 below).

- [ ] **B5.** After edits, a `grep -rEni
      'AppNavigator|featureFlags|EXPO_PUBLIC_NEW_UI|useJsonServerSync|useSupabaseStore'
      CLAUDE.md .claude/agents/` returns either zero matches or only
      historical-context lines explicitly tagged as such (e.g., "...
      was deleted in spec 025"). This is verifiable at code-review
      time without running anything.

### Track C — Remove orphan `json-server` devDependency

- [ ] **C1.** `package.json:72` (the
      `"json-server": "^1.0.0-beta.15"` line) is removed from
      `devDependencies`. The deletion is performed by running
      `npm uninstall --save-dev json-server` so that
      `package-lock.json` is updated in lockstep.

- [ ] **C2.** After the uninstall, `npm ci` runs cleanly with no
      `json-server`-related warnings. Confirmed by a clean
      `node_modules/json-server` absence (verifiable via
      `ls node_modules/json-server 2>/dev/null` returning nothing).

- [ ] **C3.** Final verification: `grep -rE 'json-server' .` excluding
      `node_modules/` and `package-lock.json` returns only historical
      references (specs, agent-prompt files, and CLAUDE.md if any
      historical note remains). No runtime reference, no script
      reference.

- [ ] **C4.** No new dependency is added.

### Cross-track

- [ ] **CT1.** `npm run typecheck` exits 0.
- [ ] **CT2.** `npm run typecheck:test` exits 0.
- [ ] **CT3.** `npm test -- --ci` passes (existing jest suites green).
- [ ] **CT4.** `npm run test:db` passes — including the new
      `invitations_super_admin_rls.test.sql` file.
- [ ] **CT5.** `npm run test:smoke` passes.
- [ ] **CT6.** The `Files changed` block at the bottom of this spec
      enumerates every file touched.

## In scope

- Single new migration `supabase/migrations/<timestamp>_invitations_super_admin_rls.sql`.
- Single new pgTAP test `supabase/tests/invitations_super_admin_rls.test.sql`.
- Prose edits to `CLAUDE.md`.
- Prose edits to the eight `.claude/agents/*.md` files enumerated in
  B3 above.
- `package.json` and `package-lock.json` mutations from
  `npm uninstall --save-dev json-server`.

## Out of scope (explicitly)

1. **Other items on the spec-025 fast-follow list.** The release
   proposal enumerates 12. This spec covers exactly items #1, #6, #7.
   Items #2 (last-super-admin guard), #3 (cross-brand invitation
   policy), #4 (HTML escape in invite email), #5 (sidebar visibility
   gate), #8 (dead `isMaster ? 'user' : 'user'` ternary), #9 (double
   toast), #10 (`useIsMaster` hoist), #11 (`canDelete` helper +
   tests), #12 (`sendPasswordReset` test) are deferred to follow-up
   specs. Rationale: each is its own contract surface and benefits
   from individual review; bundling would slow code review.
2. **Native EAS build validation.** Item from the spec-025 pre-commit
   gate. This spec changes only a DB policy, prose docs, and a
   devDependency — no native bundle change.
3. **"While I was here" rewrites of CLAUDE.md or agent-prompt prose.**
   The doc-rot fix is strictly removal-of-stale-references. If during
   the edit the architect notices that other prose is unclear or
   outdated, that is a follow-up spec, not this one. Rationale: the
   user said "ask before expanding scope" — broader doc rewrites need
   their own approval.
4. **Migration timestamp policy.** Several recent migrations
   (`20260510130000`, `20260513000000`, etc.) have non-monotonic dates.
   This spec does not normalize that; the architect picks a sensible
   timestamp slot (see Q1).
5. **`app.json` slug change.** Project policy forbids without explicit
   user approval (CLAUDE.md "app.json slug mismatch (DO NOT
   AUTO-FIX)"). Untouched.
6. **`useStore.ts` mutations.** This spec is policy + docs + devDep
   only; no store changes.
7. **Edge function changes.** `send-invite-email`, `delete-user`, and
   the staff-* set are unchanged.
8. **Realtime publication changes.** Unchanged.
9. **Coverage backfill for the other deleted modules.** Spec 023
   already covered specs 016/018/019/020/021's Criticals. The
   `invitations` policy gap was not in that batch (it predates spec
   023 by 8 months); this spec adds the one test that matters for
   this gap.
10. **Removal of `json-server` references in historical files**
    (e.g., spec-025 review files, the spec.md itself). Those are
    historical records and should be preserved verbatim.

## Open questions resolved

- **Q1.** Should `super_admin` be added to all four `invitations`
  policies (SELECT / INSERT / UPDATE / DELETE), or only INSERT (the
  policy the regression triggers)?
  → **A.** All four. The pattern from spec 013 and the order_schedule
  fix replaces the entire raw-JWT IN-list with `auth_is_privileged()`
  uniformly; doing only INSERT would leave super-admins able to
  *create* an invitation but not subsequently *list*, *update*, or
  *delete* it from the Users section — a partial fix that re-creates a
  different regression. Same shape, all four policies.

- **Q2.** Migration filename and timestamp?
  → **A.** Architect picks. Two reasonable shapes: (i)
  `20260513120000_invitations_super_admin_rls.sql` (matches the date
  of writing — today is 2026-05-13) and (ii) explicit "next slot after
  the most recent migration" naming for strict monotonic ordering.
  Architect's call at design time; I have no preference and no
  downstream automation depends on the choice.

- **Q3.** Should the pgTAP test be included in this spec or deferred?
  → **A.** Included. Spec 023 set the precedent that any DB security
  fix lands with a regression test. The shape is well-established
  (`eod_submissions_consistency.test.sql` and
  `inventory_count_entries_check_store.test.sql` are direct
  templates). One test file, three assertions.

- **Q4.** Should the doc-rot fix touch only `CLAUDE.md` or also the
  subagent prompt files?
  → **A.** Both. The eight `.claude/agents/*.md` files have the same
  stale references (verified by grep; see B3 for line-level
  enumeration). They are part of the same project contract — every
  agent reads its own prompt + CLAUDE.md on first invocation. Fixing
  one without the other leaves the contract internally inconsistent.
  This is an expansion of scope beyond the user's explicit prompt
  (which listed only CLAUDE.md); flagged explicitly in B3.

- **Q5.** What is the *exact* current frozen-file list after spec 025?
  → **A.** Only the `app.json` `slug` field remains universally
  frozen (CLAUDE.md "app.json slug mismatch (DO NOT AUTO-FIX)").
  Everything else on the legacy do-not-modify list was either deleted
  by spec 025 or is now editable (`useStore.ts` was never frozen).
  Architect to confirm at design time and align the agent-prompt
  do-not-modify lists accordingly.

- **Q6.** Does the new pgTAP test need a super_admin user in
  `supabase/seed.sql`?
  → **A.** No. The test creates its own super_admin `profiles` row
  inside the hermetic `begin; ... rollback;` transaction. The seed
  stays unchanged.

- **Q7.** Realtime channel impact?
  → **A.** None. Policy rewrite is invisible to
  `pg_publication_tables`. The realtime publication membership for
  `invitations` is unchanged.

## Dependencies

- `public.auth_is_privileged()` helper from
  `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:235-239`
  — already shipped.
- Prior-art pattern from
  `supabase/migrations/20260510020000_order_schedule_super_admin_rls.sql`
  and
  `supabase/migrations/20260510030000_recipe_categories_super_admin_rls.sql`
  — both shipped pre-spec-025.
- Test framework from spec 022 (pgTAP runner at `scripts/test-db.sh`)
  — shipped.
- Spec 023 retroactive-test patterns (file framing, JWT impersonation
  via `set_config('request.jwt.claims', ...)`, hermetic
  `begin; ... rollback;` isolation) — shipped.

## Project-specific notes

- **Cmd UI section / legacy:** N/A. Track A is server-side RLS only.
  Tracks B and C touch docs and `package.json` respectively. No
  `src/screens/cmd/sections/` changes; no `AdminScreens.tsx`
  involvement (the file is gone).
- **Per-store or admin-global:** Admin-global. `invitations` is not
  store-scoped; the policy gates on caller role only.
- **Realtime channels touched:** None. Policy DDL does not affect
  `supabase_realtime` publication membership; the `invitations` table
  is admin-only and not currently in any per-store or per-brand
  channel.
- **Migrations needed:** Yes — one. Filename per Q2.
- **Edge functions touched:** None. `send-invite-email`, `delete-user`,
  and the staff-* functions are unchanged.
- **Web/native scope:** N/A — server + docs + devDep only. No UI code
  ships in this spec.

## File-by-file plan

| File | Change |
|------|--------|
| `supabase/migrations/<new-timestamp>_invitations_super_admin_rls.sql` | NEW. Drops and recreates the four `invitations` policies to use `auth_is_privileged()`. Mirrors spec 013's `recipe_categories` fix shape. |
| `supabase/tests/invitations_super_admin_rls.test.sql` | NEW. pgTAP test with three assertions (admin, super_admin, user). Mirrors `eod_submissions_consistency.test.sql` structure. |
| `CLAUDE.md` | EDIT. Track B1/B2 line-level edits. |
| `.claude/agents/code-reviewer.md` | EDIT. Track B3. |
| `.claude/agents/frontend-developer.md` | EDIT. Track B3. |
| `.claude/agents/backend-developer.md` | EDIT. Track B3. |
| `.claude/agents/backend-architect.md` | EDIT. Track B3. |
| `.claude/agents/test-engineer.md` | EDIT. Track B3 (incl. "no test framework" fix). |
| `.claude/agents/product-manager.md` | EDIT. Track B3. |
| `.claude/agents/workflow-orchestrator.md` | EDIT. Track B3. |
| `.claude/agents/workflow-auditor.md` | EDIT. Track B3. |
| `package.json` | EDIT. Drop `json-server` from `devDependencies` (track C1). |
| `package-lock.json` | EDIT. Auto-updated by `npm uninstall`. |

## Architect design

This is a three-track cleanup. No new product surface, no new RLS table, no
new RPC, no edge function, no `src/lib/db.ts` change, no `useStore.ts`
change, no realtime publication change. The risk surface is therefore:

1. correctly broaden one existing admin-only RLS gate (Track A),
2. delete dead prose from `CLAUDE.md` and eight agent prompts (Track B),
3. remove one orphan devDependency (Track C).

### Resolved open questions

- **Q1 — migration timestamp.** The newest existing migration on disk is
  `supabase/migrations/20260514140000_realtime_publication_tighten.sql`
  (future-dated relative to today's 2026-05-13, but already shipped by
  specs 022/024/025). To preserve strict-monotonic ordering and avoid
  back-dating a migration that lands *after* `20260514140000`, the new
  migration uses **`20260514150000`**. Filename:
  `supabase/migrations/20260514150000_invitations_super_admin_rls.sql`.
  Mirrors spec 013's `20260510020000_order_schedule_super_admin_rls.sql`
  / `20260510030000_recipe_categories_super_admin_rls.sql` naming shape.

- **Q5 — post-spec-025 frozen-file list.** After spec 025 deleted
  `useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`,
  `AdminScreens.tsx`, `AppNavigator.tsx`, `featureFlags.ts`, the
  `EXPO_PUBLIC_NEW_UI` flag, and `src/lib/api.ts`, the only file that
  remains universally frozen is **the `slug` field in `app.json`**
  (CLAUDE.md "app.json slug mismatch (DO NOT AUTO-FIX)"). `useStore.ts`
  has never been frozen (it is the active store). The do-not-modify
  lists in the agent prompts collapse to a one-line `app.json` slug
  rule, **kept**, not removed entirely — every agent should continue to
  see that policy on first invocation. The two-question form of this Q5
  ("preserve the list with one item, or delete the section?") resolves
  to **preserve the list with one item**.

---

### Track A — `invitations` RLS broadened to `super_admin`

#### Data model changes

DDL-only. No tables, columns, or indexes added. Four existing policies on
`public.invitations` are dropped and recreated against the
`public.auth_is_privileged()` helper from
`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:235-239`.
The helper is `auth_is_admin() OR auth_is_super_admin()` — a strict
superset of the current `array['admin','master']` JWT check (admin/master
JWTs continue to pass; super-admin newly passes). No data is altered.

**Migration filename:** `supabase/migrations/20260514150000_invitations_super_admin_rls.sql`.

**Migration shape (pseudocode):**

    -- Header comment block, ~10 lines, citing:
    --   • Original gate added at 20260424211733_security_fixes.sql:42-57.
    --   • Helper introduced at 20260509000000_multi_brand_schema_rls.sql:235-239.
    --   • Prior art: 20260510020000 (order_schedule) and 20260510030000
    --     (recipe_categories) — same shape.
    --   • Strict superset; admin/master JWT still pass.
    --   • Idempotent + re-runnable; no data changes.

    drop policy if exists "Admins can read invitations"   on public.invitations;
    drop policy if exists "Admins can insert invitations" on public.invitations;
    drop policy if exists "Admins can update invitations" on public.invitations;
    drop policy if exists "Admins can delete invitations" on public.invitations;

    create policy "Admins can read invitations"
      on public.invitations for select
      using (public.auth_is_privileged());

    create policy "Admins can insert invitations"
      on public.invitations for insert
      with check (public.auth_is_privileged());

    create policy "Admins can update invitations"
      on public.invitations for update
      using      (public.auth_is_privileged())
      with check (public.auth_is_privileged());

    create policy "Admins can delete invitations"
      on public.invitations for delete
      using (public.auth_is_privileged());

Four policies, four `drop if exists`, four `create policy`. Names match
the originals byte-for-byte so the end-state diff is a clean swap, not a
parallel set. `to authenticated` is intentionally not set; the existing
policies do not specify a role and `auth_is_privileged()` returns false
for `auth.uid() is null`, so anon callers still fail every clause — no
anon path opens.

#### RLS impact summary

- **`select`:** the original `((auth.jwt() -> 'app_metadata' ->> 'role')
  = any (array['admin','master']))` is replaced by
  `public.auth_is_privileged()`. Strict superset — admin and master JWTs
  pass via `auth_is_admin()`; super-admin profiles row passes via
  `auth_is_super_admin()`; everyone else denied.
- **`insert` / `update` / `delete`:** same swap on the equivalent
  `with check` / `using` clauses. Same strict-superset reasoning.
- **No regression:** admin/master JWTs continue to satisfy
  `auth_is_admin()` (which reads `app_metadata.role`). The set
  `{admin, master, super_admin}` is exactly what
  `auth_is_privileged()` returns true for.
- **No anon opens:** `auth_is_admin()` returns false for null
  `app_metadata.role`; `auth_is_super_admin()` returns false for null
  `auth.uid()`. Their OR is false for anon.
- **No effect on `public.get_pending_invitation()` /
  `public.consume_invitation()`:** both are `security definer` with a
  pinned `search_path` and remain anon-callable per their `grant
  execute` lines at `20260424211733_security_fixes.sql:82,110`. The
  policy change does not touch them.

#### pgTAP test

**Test filename:**
`supabase/tests/invitations_super_admin_rls.test.sql`.

**Pattern reference:** structurally mirrors
`supabase/tests/eod_submissions_consistency.test.sql` (fixture +
hermetic begin/rollback + multiple impersonations via
`set_config('request.jwt.claims', ...)`). Specifically it borrows the
`set_config('test.<key>', <val>::text, true)` stash idiom used to thread
the master/manager UUIDs through the test, plus the
`set local role authenticated;` switch before each JWT impersonation.

**Plan:** `select plan(N)` — minimum `N = 4` (one fixture assertion + one
per role band). Architect specifies the four assertions:

| # | Role band | Vector | Expected | Asserter |
|---|-----------|--------|----------|----------|
| 1 | fixture | resolve a real `auth.users.id` value (or synthetic UUID; see Hermetic super_admin fixture below) | non-empty | `isnt()` |
| 2 | `admin` JWT | INSERT into `public.invitations` with `app_metadata.role = 'admin'`; no profiles row needed (helper reads the JWT) | succeeds — row count = 1 | `is(...count..., 1::bigint, ...)` |
| 3 | `super_admin` (profiles row) | INSERT same shape with `app_metadata.role = 'user'` JWT (i.e., NOT admin via JWT) AND an inserted `profiles` row with `role = 'super_admin'` for that `auth.uid()` | succeeds — row count = 1 | `is(...count..., 1::bigint, ...)` |
| 4 | non-privileged `user` JWT | INSERT same shape with `app_metadata.role = 'user'` and NO super_admin profiles row | rejected with SQLSTATE `42501` (`new row violates row-level security policy`) | `throws_ok(...query..., '42501', null, ...)` |

**Hermetic super_admin fixture (the load-bearing detail):**
`auth_is_super_admin()` reads `public.profiles.role`, not the JWT
(documented at
`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:183-195`).
To exercise the super_admin code path the test must INSERT a `profiles`
row inside the `begin; ... rollback;` transaction tying the super_admin
profile to whichever `auth.uid()` the impersonation sets. Two viable
approaches:

1. **Reuse an existing `auth.users.id`** from the seed (e.g., the
   `wzhchen113@gmail.com` super-admin promoted in migration
   `20260509000000` — see lines 246-340 of that migration) — but the
   seed does not currently contain that profile row in dev (per AC A5
   the seed is not modified), so the row INSERT inside the transaction
   is what makes the test viable. Same `auth_users` UUID, hermetic
   `profiles` row override via `on conflict do update`.

2. **Mint a synthetic UUID** and INSERT both an `auth.users` row and a
   `profiles` row inside the transaction. Cleaner isolation but
   requires touching `auth.users`, which is generally not done in
   pgTAP tests on this codebase (the existing tests reference real
   seed UUIDs).

**Architect's call:** approach (2) — mint synthetic UUIDs. Rationale:
the existing `eod_submissions_consistency.test.sql` references
`'22222222-2222-2222-2222-222222222222'` / `'33333333-...'` as synthetic
manager/master UUIDs without inserting into `auth.users` (because those
tests rely on RLS that reads `auth.uid()` from the JWT claims, not from
an actual users row). Same pattern works here: the test impersonates a
JWT claim of `sub = '<synthetic-uuid>'`, then INSERTs a `profiles` row
with `id = '<synthetic-uuid>'` and `role = 'super_admin'`. No
`auth.users` row needed — `auth_is_super_admin()` only joins on
`profiles.id = auth.uid()`. Profiles has no FK to auth.users that
would reject this in the hermetic transaction (verified by reading
`profiles` definition history — the `id uuid primary key` does not
declare `references auth.users(id)` in any of the migrations).

**Two caveats the developer must verify before committing the test:**

- (a) **`profiles.brand_id` NOT NULL or check constraint.** The
  multi-brand migration (`20260509000000_multi_brand_schema_rls.sql`)
  introduced a `profiles_role_brand_consistent` CHECK that requires
  `super_admin` rows to have `brand_id IS NULL`. The INSERT into
  `profiles` inside the test must therefore set `brand_id = null`
  (default is null, but the developer should be explicit). Also set
  `dark_mode = false`, `notifications_enabled = true`,
  `sidebar_layout = null` — whatever NOT NULL columns exist post-spec
  025. Read the current `profiles` CREATE TABLE shape before authoring
  the INSERT.
- (b) **`profiles.id` FK to `auth.users.id`.** If a CHECK or FK was
  added in a later migration that the architect missed, fall back to
  approach (1) — pick the seed admin's UUID and `INSERT ... ON
  CONFLICT (id) DO UPDATE SET role = 'super_admin'`. Both approaches
  produce the same coverage; the synthetic-UUID path is just cleaner.
  The developer chooses at write time.

**Default-case framing:**

    -- supabase/tests/invitations_super_admin_rls.test.sql
    --
    -- Spec 026 / Track A — pgTAP regression for the invitations RLS
    -- super_admin broadening. Three role bands × one INSERT vector.
    -- Hermetic begin; ... rollback; isolation.

    begin;
    create extension if not exists pgtap;
    select plan(4);

    -- ── fixtures (set_config stashes for JWT-impersonation UUIDs) ──
    do $$
    declare
      v_admin_uid       uuid := '11111111-1111-1111-1111-111111111111';
      v_super_admin_uid uuid := '22222222-2222-2222-2222-222222222222';
      v_user_uid        uuid := '33333333-3333-3333-3333-333333333333';
    begin
      perform set_config('test.admin_uid',       v_admin_uid::text,       true);
      perform set_config('test.super_admin_uid', v_super_admin_uid::text, true);
      perform set_config('test.user_uid',        v_user_uid::text,        true);
    end $$;

    select isnt(current_setting('test.admin_uid', true), '',
      'fixture: admin synthetic UUID resolves');

    -- ── Arm (i): admin JWT — INSERT succeeds ──
    set local role authenticated;
    select set_config(
      'request.jwt.claims',
      jsonb_build_object(
        'sub',          current_setting('test.admin_uid', true),
        'role',         'authenticated',
        'app_metadata', jsonb_build_object('role', 'admin')
      )::text,
      true
    );
    insert into public.invitations (email, name, role, store_ids)
      values ('test-admin@example.invalid', 'Admin Test', 'manager', array[]::text[]);

    select is(
      (select count(*)::bigint from public.invitations
        where email = 'test-admin@example.invalid'),
      1::bigint,
      'arm (i): admin JWT INSERT succeeds (regression check)'
    );

    -- ── Arm (ii): super_admin via profiles row — INSERT succeeds ──
    -- Profiles row INSERT first; helper reads profiles.role.
    insert into public.profiles (id, role, brand_id /* + any other NOT NULL cols */)
      values (current_setting('test.super_admin_uid', true)::uuid,
              'super_admin', null);

    select set_config(
      'request.jwt.claims',
      jsonb_build_object(
        'sub',          current_setting('test.super_admin_uid', true),
        'role',         'authenticated',
        'app_metadata', jsonb_build_object('role', 'user')   -- intentionally NOT admin
      )::text,
      true
    );
    insert into public.invitations (email, name, role, store_ids)
      values ('test-superadmin@example.invalid', 'Super Test', 'manager', array[]::text[]);

    select is(
      (select count(*)::bigint from public.invitations
        where email = 'test-superadmin@example.invalid'),
      1::bigint,
      'arm (ii): super_admin via profiles row INSERT succeeds (new behavior)'
    );

    -- ── Arm (iii): plain user JWT — INSERT rejected (42501) ──
    select set_config(
      'request.jwt.claims',
      jsonb_build_object(
        'sub',          current_setting('test.user_uid', true),
        'role',         'authenticated',
        'app_metadata', jsonb_build_object('role', 'user')
      )::text,
      true
    );

    select throws_ok(
      $q$insert into public.invitations (email, name, role, store_ids)
         values ('test-user@example.invalid', 'User Test', 'manager', array[]::text[])$q$,
      '42501',
      null,
      'arm (iii): non-privileged user JWT INSERT rejected by RLS'
    );

    select * from finish();
    rollback;

(The `[email/name/role/store_ids]` column list above is illustrative —
the developer must align it with `invitations`' actual columns at write
time; the table predates spec 026 and the current schema is the source
of truth.)

**Test count gate:** `plan(4)`. Anything less and the test
under-asserts; anything more is fine.

#### API contract

No change. The frontend already calls
`db.inviteUser()` → `auth.admin.inviteUserByEmail()` (an internal admin
RPC on Supabase Auth) which then writes a row into `public.invitations`
via the existing flow. The bug is server-side only: super-admin's row
INSERT was rejected by the four `array['admin','master']` policies.
After this migration, the same call succeeds for super_admin.

#### Edge function changes

None. `send-invite-email` and `delete-user` are unchanged. Both already
treat super_admin as privileged (per AC §6 in the prompt — confirmed in
the spec preamble).

#### `src/lib/db.ts` surface

No change. `inviteUser()` already exists and is unmodified.

#### Realtime impact

None. `public.invitations` is not a member of `supabase_realtime`
(verified — the post-spec-025 publication is the explicit list from
`20260514140000_realtime_publication_tighten.sql`; `invitations` is not
in it). No `docker restart supabase_realtime_imr-inventory` step is
required for this migration. The realtime-publication gotcha is
**not** triggered.

#### Frontend store impact

None. `useStore.ts` is untouched. The optimistic-then-revert pattern is
not invoked — this is a pure server-side policy fix.

#### Risks and tradeoffs

- **Risk: profile FK constraint.** If a later migration added a hard
  FK from `profiles.id → auth.users.id`, the synthetic-UUID approach
  in the test fails on the `profiles` INSERT. Mitigation: developer
  reads the current `profiles` CREATE TABLE shape before authoring
  the test (caveat (b) above). If FK exists, switch to seed-UID
  approach with `ON CONFLICT DO UPDATE`. Cost: one extra line in the
  test; no functional impact.
- **Risk: profiles_role_brand_consistent CHECK rejects the synthetic
  super_admin row.** Mitigation: explicit `brand_id = null` in the
  profiles INSERT (caveat (a) above).
- **Risk: migration ordering.** `20260514150000` is greater than every
  existing migration, so it sorts last. New supabase deployments
  apply in lexical-sort order — safe.
- **Risk: re-running locally during dev.** All four
  `drop policy if exists` calls precede `create policy`. Idempotent.
- **Risk: prod replay safety.** Both `drop policy if exists` and
  `create policy` are DDL — atomic per-statement. If the migration
  fails mid-run (e.g., between drop #3 and create #1), Postgres
  rolls back the migration transaction and the policy set is
  unchanged. Documented at the migration's header.
- **Performance:** policy evaluation cost is identical to the current
  shape — `auth_is_privileged()` is a single short-circuit OR over
  two stable security-definer helpers. No measurable change on the
  286 KB seed.

---

### Track B — Doc rot

This is a delete-stale-prose pass. **Each file's edit list below names
the lines/blocks to remove or rewrite, not the verbatim replacement
prose** — per the spec's own AC B4, "no prose is invented beyond
removing stale references and replacing them with the minimal accurate
description." The developer writes the minimal accurate replacement at
edit time.

#### B-CLAUDE.md (`CLAUDE.md`)

| Line(s) | Change |
|---------|--------|
| 14 | Drop `+ AppNavigator` half and the `, [src/navigation/AppNavigator.tsx](...)` link. Result: routing line names only `CmdNavigator.tsx`. |
| 34 (root code-fence) | Replace `App.tsx # Root; flips between legacy and Cmd UI based on flag` with `App.tsx # Root; mounts CmdNavigator.` |
| 36 | Replace `navigation/ # AppNavigator (legacy) + CmdNavigator (new desktop shell)` with `navigation/ # CmdNavigator (desktop shell)`. |
| 39 | Delete the `AdminScreens.tsx # 104 KB legacy mega-screen` line. |
| 40 | Delete the `InventoryListScreen / ItemDetailScreen` line. **Verified:** spec 025 also deleted these (no `src/screens/InventoryListScreen.tsx` or `src/screens/ItemDetailScreen.tsx` on disk — confirmed by glob during design). |
| 41 | Replace `store/ # Zustand stores (see Open questions re: duplicates)` with `store/ # Zustand store (useStore.ts)`. |
| 42 | Replace `lib/ # db.ts (PostgREST/RPC), featureFlags.ts, webPush.ts, ...` with `lib/ # db.ts (PostgREST/RPC), webPush.ts, ...`. |
| 55 | Rewrite "UI fork via env flag" bullet to a Cmd-UI-only bullet. Suggested shape: "**Cmd UI is the only client.** [App.tsx](App.tsx) mounts `CmdNavigator` unconditionally." No `App.tsx:117` line ref, no `EXPO_PUBLIC_NEW_UI` ref, no `featureFlags.ts` ref. |
| 80 | Delete the "Possibly-stale legacy data layer" bullet entirely. |
| 81 | Delete the "Two coexisting stores" bullet entirely. |
| 82 | Delete the "Large legacy file" bullet entirely. |
| 201-210 ("Data layer (active vs. legacy)") | Rewrite as: keep the **Active** line (`useStore.ts` is the current store). Replace the **Legacy — do not modify** subsection with a one-line historical note: "Spec 025 deleted the legacy data layer (`useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`, the `npm run db` script). They no longer exist in the repo." |
| 219-222 ("Legacy admin screens") | Replace section body with one line: "`AdminScreens.tsx` was deleted in spec 025." Keep the heading or drop it — developer's preference; the spec's AC B2 says either is acceptable. Recommendation: drop the heading entirely and let the section sort itself out; the "do not modify" rule is no longer load-bearing. |

**Frozen-file list after the edits:** only the `app.json` `slug` rule
(CLAUDE.md "app.json slug mismatch (DO NOT AUTO-FIX)") remains. Keep
that section intact (lines 227-230 in the current file).

**Grep gate (AC B5):** after these edits,

    grep -rEni 'AppNavigator|featureFlags|EXPO_PUBLIC_NEW_UI|useJsonServerSync|useSupabaseStore' CLAUDE.md

must return either zero matches or only matches inside the "Spec 025
deleted ..." one-liner under Resolved questions > Data layer (which is
historical context, AC-compliant).

#### B-agent prompts (8 files)

For each file below: remove stale references, collapse the
do-not-modify list (where it appears) to the single `app.json` slug
rule, and update Stack-line phrasing per the same shape used in
CLAUDE.md. The developer reads the surrounding paragraph to write the
minimal accurate replacement — no invented prose.

| File | Surface area to edit |
|------|----------------------|
| `.claude/agents/code-reviewer.md` | Line 36 (`AdminScreens.tsx` frozen rule) — collapse to a one-liner: "Direct edits to files explicitly deleted in spec 025 should not appear; if they do, treat as Critical (the files are gone, the edit is a re-creation)." Line 37 (legacy data-layer files list) — delete the bullet entirely (the files no longer exist; the rule is moot). Line 40 ("Reintroduction of json-server / `db.json` patterns") — keep the rule but rephrase: "Reintroduction of json-server or `db.json` patterns in new code (both deleted in spec 025; re-introduction is Critical)." Line 42 ("There is no test framework yet") — replace with the post-spec-022 reality: "Spec 022 landed jest + pgTAP + shell-smoke infra. New test files must follow one of those three tracks; ad-hoc `*.test.*` files outside that pattern are a finding." |
| `.claude/agents/frontend-developer.md` | Line 15 (Stack/Routing line referencing AppNavigator) — drop `Legacy navigator at [...AppNavigator.tsx]`. Line 34 (`EXPO_PUBLIC_NEW_UI` / `featureFlags.ts` / `App.tsx:117`) — rewrite as "New admin features go in `src/screens/cmd/sections/`. Cmd UI is the only client." Lines 35 (mobile fallback to `InventoryListScreen`/`ItemDetailScreen`) — delete entirely (those files were deleted in spec 025). Line 36 (`AdminScreens.tsx` "NEVER add" rule) — delete entirely. Lines 71-80 (Hard rules — do not modify these files) — collapse to a single bullet: `- The slug field in app.json (towson-inventory — possibly load-bearing for EAS/push).` Drop the CLAUDE.md cross-reference parenthetical or update it to "(See CLAUDE.md 'app.json slug mismatch (DO NOT AUTO-FIX)'.)". |
| `.claude/agents/backend-developer.md` | Lines 30-41 (Hard rules — do not modify these files) — collapse to the same single `app.json` slug bullet. Adjust the CLAUDE.md cross-reference parenthetical at line 41 accordingly. Line 55 ("There is no test framework wired up yet") — rewrite to reflect spec 022's three tracks (jest, pgTAP, shell-smoke). Line 57 reference to `scripts/smoke-edge.sh` stays. |
| `.claude/agents/backend-architect.md` | Lines 45-46 ("Do NOT design changes to legacy code" — names `useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`, `npm run db`, `AdminScreens.tsx`) — collapse to: "Do NOT propose changes to the `app.json` slug. It says `towson-inventory` for legacy reasons and may be load-bearing for EAS/push certs. Surface as an open question if the spec implies it (see CLAUDE.md 'app.json slug mismatch (DO NOT AUTO-FIX)')." The next-line "Do NOT propose changes to the `app.json` slug" rule (line 46) is already present in the file — verify no duplicate. Result: a single rule line about the slug. |
| `.claude/agents/test-engineer.md` | Lines 11-19 (the "no test framework wired up" prose) — rewrite to spec-022 reality: "Spec 022 landed three test tracks — jest (`npm test`), pgTAP DB tests (`npm run test:db`), and shell smokes (`npm run test:smoke`). New tests land in the matching track; do not introduce a fourth framework without PM approval." Update lines 14-15's `scripts/test-unit-conversion.ts` and `scripts/smoke-edge.sh` lines to reflect the current `scripts/test-db.sh` etc. helpers; the architect leaves the exact pruning to the developer. Lines 47 (`AdminScreens.tsx` frozen rule) — delete entirely. Lines 49-55 (Hard rules — do not modify these files) — collapse to the single `app.json` slug rule. |
| `.claude/agents/product-manager.md` | Line 25 ("Cmd UI vs legacy?") — rewrite to: "All admin features land in `src/screens/cmd/sections/`. There is no legacy admin surface to route around — spec 025 deleted it." Line 32 ("There is no test framework wired up yet") — rewrite to spec-022 reality. Lines 61, 76 (frozen-files rule referencing `useSupabaseStore.ts`, etc.) — collapse to the single `app.json` slug rule. |
| `.claude/agents/workflow-orchestrator.md` | Line 72 (frozen-file list — names `useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`, `AdminScreens.tsx`) — collapse to: "Never assign work to the `app.json` slug field without explicit user approval." |
| `.claude/agents/workflow-auditor.md` | Line 30 (frozen-file rule #4 — names the same set) — same collapse: single `app.json` slug rule. |

**Notes for the developer (Track B):**

- (i) Per AC B4, no expansion of scope. If a paragraph references a
  now-deleted thing, replace it with the minimum that keeps the
  surrounding logic readable. Don't rewrite unrelated prose.
- (ii) The "no test framework" prose is not strictly in the spec's
  enumerated list under AC B3 for every agent, but for
  `test-engineer.md` and `frontend-developer.md` (and arguably
  `backend-developer.md` line 55, `product-manager.md` line 32),
  the prose is internally inconsistent with the post-spec-022
  reality. AC B3 lists `test-engineer.md` explicitly; the rest are
  AC-adjacent. **Architect's call:** fix the "no test framework"
  prose wherever it appears across the eight files. That is
  strictly stale-reference removal, not scope expansion — same
  rule shape, different stale fact.
- (iii) The grep gate at AC B5 only enforces the
  AppNavigator/featureFlags/EXPO_PUBLIC_NEW_UI/useJsonServerSync/
  useSupabaseStore pattern across `CLAUDE.md` and
  `.claude/agents/`. After the developer's edits, a second
  manual sanity grep for `AdminScreens|db\.json|npm run db|src/lib/api`
  across the same two paths should return only historical-context
  matches.

---

### Track C — Remove orphan `json-server` devDependency

#### Commands

The developer runs, in order, from the repo root:

1.  `npm uninstall --save-dev json-server`
    - This removes the dependency entry from `package.json:devDependencies` and updates `package-lock.json` in lockstep.
    - Verification immediately after: `grep -n '"json-server"' package.json` returns zero matches.
2.  `npm ci`
    - Confirms `package-lock.json` is internally consistent. Should complete with no warnings about `json-server`.
    - Verification immediately after: `ls node_modules/json-server 2>/dev/null` returns nothing (the directory must not exist).
3.  `grep -rn 'json-server' package-lock.json`
    - Must return zero matches. If a transitive entry survives, that is a Critical finding — `npm ci` should have removed the entire entry.
4.  Optional sanity: `grep -rEn 'json-server' . --exclude-dir=node_modules --exclude-dir=.git --exclude=package-lock.json`
    - Should return only historical references (specs under `specs/`, the historical CLAUDE.md "Spec 025 deleted ..." one-liner if the developer chose that phrasing, and AC B3-edited agent prompt files if any historical phrasing survives). **No runtime reference; no npm script reference.** That matches AC C3.

#### Risks

- **Risk: npm postinstall hooks.** None known on this repo —
  `package.json` declares no `postinstall`. Safe.
- **Risk: `package-lock.json` divergence on CI.** Two CI jobs in
  `.github/workflows/test.yml` run `npm ci`. If `package-lock.json`
  fails to round-trip cleanly, `npm ci` errors with `npm ERR! Missing:
  json-server@...`. Mitigation: commit `package-lock.json` after the
  uninstall, in the same commit as `package.json`.
- **Risk: someone has a stale local checkout that still has the script
  reference.** The `npm run db` script and its consumer files were
  deleted in spec 025 (verified by glob at design time — no
  `src/lib/api.ts`, no `src/store/useJsonServerSync.ts`, no `db.json`
  at repo root). No surviving consumer of `json-server` exists. Safe.

---

### Cross-cutting concerns

#### Test coverage gate

Track A's pgTAP test is picked up automatically by the existing
`db` job in `.github/workflows/test.yml` lines 105-133. The job runs
`npm run test:db`, which invokes `scripts/test-db.sh` — that script
discovers every `*.test.sql` file under `supabase/tests/` and runs each
through `psql -f`. The new
`supabase/tests/invitations_super_admin_rls.test.sql` requires no CI
yaml change. The job's existing `supabase start` + `supabase stop`
bracket already handles the local stack lifecycle.

Tracks B and C have no test surface (prose + devDep removal). AC
CT1-CT5 cover them via the existing CI jobs (`typecheck`,
`typecheck:test`, `jest`, `test:db`, `test:smoke`). No new jobs, no new
scripts, no new CI yaml.

#### Realtime publication

Unchanged. `public.invitations` is not in `supabase_realtime` (verified
against `20260514140000_realtime_publication_tighten.sql`). No
`docker restart supabase_realtime_imr-inventory` step required for this
spec.

#### Edge functions

Unchanged. None of the ten edge functions read the `invitations`
policies directly; they use service-role keys that bypass RLS.

#### Frontend / `src/lib/db.ts` / `useStore.ts`

Unchanged.

#### Migration ordering

`20260514150000` > all existing migrations. Lexical-sort safe.

#### Test framework dependency

The new pgTAP test requires the pgtap extension. `scripts/test-db.sh`
creates it inside each test's transaction (`create extension if not
exists pgtap`). No CI install step needed. Same as every other test in
`supabase/tests/`.

#### Performance

Track A is policy DDL on a low-row-count admin-only table
(`invitations` has at most a handful of rows per day-to-day usage).
Policy evaluation cost is identical to the current shape. No
measurable impact.

---

### File-by-file summary (developer reference)

| File | Track | Operation |
|------|-------|-----------|
| `supabase/migrations/20260514150000_invitations_super_admin_rls.sql` | A | NEW (one-shot DDL — see migration shape above) |
| `supabase/tests/invitations_super_admin_rls.test.sql` | A | NEW (pgTAP, plan(4) — see test shape above) |
| `CLAUDE.md` | B | EDIT (line ranges enumerated under B-CLAUDE.md) |
| `.claude/agents/code-reviewer.md` | B | EDIT |
| `.claude/agents/frontend-developer.md` | B | EDIT |
| `.claude/agents/backend-developer.md` | B | EDIT |
| `.claude/agents/backend-architect.md` | B | EDIT |
| `.claude/agents/test-engineer.md` | B | EDIT |
| `.claude/agents/product-manager.md` | B | EDIT |
| `.claude/agents/workflow-orchestrator.md` | B | EDIT |
| `.claude/agents/workflow-auditor.md` | B | EDIT |
| `package.json` | C | EDIT (auto via `npm uninstall`) |
| `package-lock.json` | C | EDIT (auto via `npm uninstall`) |

13 files total. Tracks are independent — the developer can land them in
any order, in any number of commits, as long as the final state
matches the AC.

## Files changed

### Track A — `invitations` RLS broadening (DB)
- `supabase/migrations/20260514150000_invitations_super_admin_rls.sql` — NEW. Drops + recreates the four `invitations` policies (SELECT / INSERT / UPDATE / DELETE) to use `public.auth_is_privileged()` instead of the raw JWT IN-list. Policy names preserved byte-for-byte. Mirrors the shape of the prior order_schedule + recipe_categories super_admin RLS fixes. DDL only, idempotent.
- `supabase/tests/invitations_super_admin_rls.test.sql` — NEW. pgTAP `plan(4)`: fixture + admin JWT insert + super_admin (profiles.role path) insert + non-privileged user JWT rejection (42501). Uses the seeded master UID (`33333333-...`) flipped to `super_admin` inside the hermetic txn via `UPDATE` (necessary because `profiles.id` has FK to `auth.users(id)` — synthetic UUIDs are not viable). 4/4 PASS locally.

### Track B — Doc rot (CLAUDE.md + 8 agent prompts)
- `CLAUDE.md` — EDIT. Stack/Routing line drops `AppNavigator`. Project-structure block drops `AppNavigator`, `AdminScreens.tsx`, mobile-fallback screens, the duplicate-stores comment, and `featureFlags.ts`. "UI fork via env flag" bullet rewritten to "Cmd UI is the only client." Three "Gaps and unknowns" bullets (legacy data layer, two stores, large legacy file) removed. "Data layer (active vs. legacy)" and "Legacy admin screens" sections collapsed to one-line historical notes referencing spec 025.
- `.claude/agents/code-reviewer.md` — EDIT. Frozen-files rule collapsed: `AdminScreens.tsx` / `useSupabaseStore.ts` / `useJsonServerSync.ts` / `db.json` / `npm run db` references rewritten as "deleted in spec 025, re-creation is Critical". "No test framework" bullet rewritten to spec-022 three-tracks reality.
- `.claude/agents/frontend-developer.md` — EDIT. Routing line drops `AppNavigator`. "Where new screens go" rewritten to Cmd-UI-only. Hard-rules list collapsed to one item (`app.json` slug). Tests section rewritten to spec-022 reality.
- `.claude/agents/backend-developer.md` — EDIT. Hard-rules list collapsed to the single `app.json` slug rule. Tests section rewritten to spec-022 three-tracks reality.
- `.claude/agents/backend-architect.md` — EDIT. "Do NOT design changes to legacy code" rule collapsed (legacy code no longer exists); only the `app.json` slug rule remains.
- `.claude/agents/test-engineer.md` — EDIT. Description frontmatter rewritten ("NO test framework yet" → spec-022 three tracks). "Testing reality on this project" section rewritten. UI-flows bullet drops `AdminScreens.tsx` ban; hard-rules list collapsed to `app.json` slug only.
- `.claude/agents/product-manager.md` — EDIT. "Cmd UI vs legacy?" probe rewritten — no legacy admin surface exists. Tests probe rewritten to spec-022 three-tracks reality. Rule referencing legacy files rewritten to the `app.json` slug rule.
- `.claude/agents/workflow-orchestrator.md` — EDIT. Frozen-files rule (hard rule #3) collapsed to the `app.json` slug rule.
- `.claude/agents/workflow-auditor.md` — EDIT. Frozen-file rule #4 collapsed to the `app.json` slug rule.

### Track C — Remove orphan `json-server` devDependency
- `package.json` — EDIT. Removed `json-server: ^1.0.0-beta.15` from `devDependencies` via `npm uninstall --save-dev json-server`.
- `package-lock.json` — EDIT. Auto-updated by the same uninstall; 45 transitive packages removed. `grep -E 'json-server' package.json package-lock.json` returns zero matches.

### Spec status
- `specs/026-post-025-cleanup/spec.md` — `Status: READY_FOR_BUILD` → `Status: READY_FOR_REVIEW`; this `## Files changed` block appended.
