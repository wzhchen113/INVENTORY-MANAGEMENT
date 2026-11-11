# Spec 191: Demote-profile brand scope, last-of-role guard, and profiles-backed role checks

Status: READY_FOR_REVIEW

Closes **164-H2** (`demote_profile_to_user` has no brand scope and no last-of-role guard) and the role-changing part of **164-M2** (writes that create or remove roles trust the JWT `app_metadata.role` over `profiles.role`). It is "separate spec B" in `specs/187-order-approval-approver-snapshot/reviews/release-proposal.md`. "Separate spec A" (removing `user_stores` own-row writes, 164-H1) is spec 195, which is being written in parallel.

Naming: "164-H2" and "164-M2" are in `specs/164-profiles-insert-hardening/reviews/security-auditor.md`. "187-H2" is in `specs/187-order-approval-approver-snapshot/reviews/security-auditor.md`.

## User story

As a brand admin or master, I want to be able to demote people in my own brand and nobody else, so that brand membership stays manageable without giving me reach into other tenants.

As the brand owner (the only super_admin), I want these guarantees, so that nobody can lock me out of the Tenancy/Brands surface in a way only psql can fix:
- only a super_admin can demote a super_admin
- no demotion, through any path, can leave zero super_admins or zero masters
- a demoted admin's still-valid token can't demote anyone or mint a new admin

## What the code does today (established for this spec)

Each item is tagged **[read]** (from reading the code) or **[ran-by-auditor]** (an auditor confirmed it live). The PM ran nothing.

### The RPC
`supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql` runs these checks in order:
1. null caller: `'cannot demote self'`
2. `auth_is_privileged()`: 42501 `'forbidden'`
3. self check: `'cannot demote self'`
4. `update profiles set role='user', brand_id=null`
5. P0002 `'target profile not found'`

There is no brand check, no target-role check, no `assert_not_last_of_role` call, and no lock.
- **[ran-by-auditor]** A brand-A admin demoted the only super_admin (164-H2).
- **[ran-by-auditor]** A brand-B admin demoted a brand-A admin (187-H2).
- `README.md:229` says the RPC has "self- and last-of-role guards". That is false today and becomes true when this spec ships.

### How the role helpers decide [read]

| Helper | Source of truth | Definition |
|---|---|---|
| `auth_is_admin()` | **JWT only.** True if `app_metadata.role` is `admin` or `master` | `20260504073942_brand_catalog_p5_rls.sql:23`. Body unchanged since; spec 157 added only a `comment on function` |
| `auth_is_super_admin()` | **`profiles.role = 'super_admin'`** | `20260509000000_multi_brand_schema_rls.sql:187` |
| `auth_is_privileged()` | `auth_is_admin() OR auth_is_super_admin()`, so **JWT for admin/master, profiles for super_admin** | same file `:235` |
| `auth_can_see_brand(b)` | `auth_is_super_admin()` OR `profiles.brand_id = b`, so **profiles** | same file `:200` |
| `auth_can_see_store(s)` | super_admin (profiles), OR **`auth_is_admin()` (JWT)** plus `auth_can_see_brand(store.brand_id)` (profiles), OR a `user_stores` row | `20260517040000_auth_can_see_store_brand_scope.sql:88` |

So the JWT decides only admin/master status. Super_admin status and brand membership always come from `profiles`.

### What `profiles_sync_role_to_jwt` does on demotion [read]
- It is an `AFTER INSERT OR UPDATE OF role` trigger on `profiles` that runs `sync_role_to_app_metadata()` (`20260502071736_remote_schema.sql:245,515`).
- It copies `NEW.role` into `auth.users.raw_app_meta_data.role` straight away.
- It does not touch sessions or tokens. The demoted user's **current access token** keeps its old `app_metadata.role` until it expires.
- The next refresh issues a token built from the updated `auth.users` row, so the claim becomes `user`.

**The stale window is therefore at most one access-token lifetime.** `supabase/config.toml:171` sets `jwt_expiry = 3600`. The prod value has not been checked. It is a dashboard setting.

Who the stale claim affects:
- **Demoted admin/master:** affected. `auth_is_admin()` stays true until the token expires.
- **Demoted super_admin:** loses powers immediately, because `auth_is_super_admin()` reads `profiles`.
- **Edge functions** (`delete-user`, `manage-store-user`): not affected. They call `auth.getUser()`, which returns the current `auth.users` row, not the token's claims.

### Ending the target's sessions would not shorten the window [read; GoTrue behaviour from memory, not probed]
- Deleting the target's `auth.sessions` rows (and with them, as I understand GoTrue's schema, their refresh tokens) stops refresh, and GoTrue endpoints start refusing the token.
- **PostgREST does not check sessions.** It only checks the JWT signature and `exp`, so the issued access token keeps working against every RLS policy and RPC until it expires.
- A refresh would already have dropped the claim. Ending sessions only adds a forced re-login.
- It would also be the first public-schema code in this repo to DELETE from an `auth.*` table. Not adopted (see Decisions, OQ-3).

### The direct-PATCH route that sits beside the RPC [read]
- `super_admin_manage_profiles` (012a) lets a super_admin UPDATE any `profiles` row, including their own.
- `assert_brand_id_immutable_for_self()` (`20260517050000_rls_hardening_followups.sql:196`) refuses role changes only for **non**-super_admin callers. They get `'role is read-only for self-edits (super_admin only)'` or `'role changes require super_admin'`.
- So a super_admin can still `PATCH /rest/v1/profiles?id=eq.<self>` with `{"role":"user"}`, or demote the last master, without the RPC's self guard or any last-of-role guard.
- Spec 050 says its RPC closed this "uniformly". It added a guarded path but did not close the unguarded one.
- Nothing in `src/` or `supabase/functions/` writes `profiles.role` through a direct UPDATE.

### UI caller and wrappers [read]
- The only caller is `MembersTab` in `src/screens/cmd/sections/BrandsSection.tsx:885-894`, which calls `useStore.demoteProfileToUser` (`src/store/useStore.ts:2053`), which calls `db.demoteProfileToUser` (`src/lib/db.ts:5627`).
- No other file in `src/` calls the store action or the db wrapper.
- `BrandsSection` renders only for super_admins (`:80`, `:162`). **No brand admin or master can reach the Demote button**; they can reach the RPC only by calling PostgREST directly.
- `MembersTab` lists profiles with the selected `brand_id`. Super_admins (`brand_id IS NULL`) never appear there, and Demote is offered only on `admin`/`master`/`user` rows.
- The store action reverts optimistically and calls `notifyBackendError('Demote profile', e)` on any error, so any refusal string reaches the user as a toast with no code change.

### Blast radius of the 164-M2 options
Counts come from migration text, so they overcount policies that were later dropped and recreated. The architect should confirm them with the queries in Dependencies.

| Object | Migration-text count |
|---|---|
| `auth_is_privileged()` | 184 occurrences in 33 migration files; ~71 `create policy` statements in 17 files; ~22 function bodies in 17 files |
| `auth_is_admin()` | 94 occurrences in 17 files. It is the JWT leaf under `auth_is_privileged()` and under `auth_can_see_store()`'s admin arm. Spec 157's migration header estimates "~40 store-scoped policies" ride that arm |
| pgTAP fixtures | 77 test files (232 occurrences) set `app_metadata` in `request.jwt.claims` |

This spec changes **1 RPC, 3 policies and 1 trigger function**, and may add **1 helper**. Changing `auth_is_admin()` would reach effectively all of RLS, so it is a follow-up spec.

## Acceptance criteria

### A. RPC authorization (164-H2, 187-H2 step 1)

**Check order in `public.demote_profile_to_user(uuid)`.** The order is a contract; the architect may change it only with a written reason.

1. Null `auth.uid()`: P0001 `'cannot demote self'` (unchanged).
2. **Caller privilege from `profiles`.** If the caller's `profiles.role` is not one of `admin`, `master` or `super_admin`, raise 42501 `'forbidden'`. The JWT claim is ignored.
3. Self: if `target = auth.uid()`, raise P0001 `'cannot demote self'` (unchanged).
4. Take the lock (see B4). Re-read the caller's `profiles` row, and refuse with `'forbidden'` if the caller is no longer privileged. Then read the target row `for update`.
5. Target not found: P0002 `'target profile not found'` (unchanged).
6. Target is `super_admin` and caller is not: 42501 `'forbidden: only a super_admin can demote a super_admin'`.
7. **Brand scope.** If the caller is admin/master and `target.brand_id` is not the caller's non-NULL `brand_id` (a NULL-safe comparison, so NULL on either side refuses), raise 42501 `'forbidden: target is in a different brand'`. This string matches `delete-user`'s brand-gate message byte for byte. Super_admin callers skip this step.
8. Last-of-role (see B).
9. `update … set role='user', brand_id=null`, then return the id (unchanged).

Criteria:
- [ ] **A1.** Callers refused at step 2 with 42501 `'forbidden'`, target row unchanged:
  - a `user` profile with a stale `app_metadata.role='admin'` claim
  - a profile-less login with an `admin` claim
  - a `user` profile with a `super_admin` claim
- [ ] **A2.** Brand scope, target row unchanged in each case:
  - An admin (and a master) demoting an admin, master or user in **another** brand gets 42501 `'forbidden: target is in a different brand'`.
  - The same applies to a NULL-brand `user` target.
  - An admin whose JWT claims `super_admin` still gets the brand refusal; the claim is ignored.
- [ ] **A3.** An admin or master demoting a `super_admin` gets 42501 `'forbidden: only a super_admin can demote a super_admin'`. Target row unchanged.
- [ ] **A4.** Allowed in-brand demotions. Each returns the target id and leaves `role='user'`, `brand_id IS NULL`:
  - an admin demotes a same-brand `admin`, `master` (when it is not the last) or `user`
  - a master demotes a same-brand `admin`
- [ ] **A5.** A super_admin can demote any non-self `admin`, `master` or `user` in **any** brand, and another super_admin when at least two exist.
- [ ] **A6.** The self guard, null-caller check and P0002 behave as before. The existing `supabase/tests/demote_self_guard.test.sql` passes **unmodified**: its arms (i) and (ii) use a same-brand seed admin as the caller, which steps 2 and 7 still admit.
- [ ] **A7.** Every refusal fires before the UPDATE. pgTAP checks the target row is unchanged after each refusal arm.
- [ ] **A8.** The function stays `SECURITY DEFINER` with `search_path` pinned, owned by `postgres`, EXECUTE granted to `authenticated` only (not `anon`, not PUBLIC). Its comment block records the check order above and why the caller check reads `profiles` rather than `auth_is_privileged()` (the spec 157 rule for deliberate deviations).

### B. Last-of-role guard (the CLAUDE.md spec 031 rule)
- [ ] **B1.** Demoting the only `master` raises P0001 `'cannot demote the last master'` and leaves the row unchanged. This holds for a same-brand admin caller and for a super_admin caller.
- [ ] **B2.** Every demotion of a `super_admin` or `master` target goes through `public.assert_not_last_of_role(target_id, target_role)`. For a `super_admin` target the string is `'cannot demote the last super_admin'`.
  - In a single session this is unreachable through the RPC, because only another super_admin may call it on a super_admin.
  - It is verified by code review and by the B4 probe.
- [ ] **B3.** The "how many are left" count lives only in `assert_not_last_of_role`. The architect chooses how to get the `demote` wording: a verb parameter with a default of `'delete'`, or catching P0001 in the RPC and raising again.
  - `delete-user`'s strings (`'cannot delete the last super_admin'` / `'cannot delete the last master'`) stay byte-for-byte unchanged.
  - `supabase/tests/delete_last_privileged_guard.test.sql` passes. Edit it only if the helper's signature changes.
- [ ] **B4.** Concurrency:
  - The RPC and the direct-PATCH guard (section D) serialize demotions of `super_admin`/`master` rows (advisory lock or row locks; the architect chooses). The RPC re-reads the caller's role after taking the lock.
  - Required outcomes, when two holders of the same role demote each other at the same moment:
    - the last two super_admins: at least one super_admin remains
    - the last two masters: at least one master remains
  - Verification:
    - a manual two-`psql`-session probe on the local stack, recorded in the review notes
    - a serial pgTAP arm: admin A demotes same-brand admin B, then B (now `user`, stale claim) tries to demote A and gets 42501 `'forbidden'`

### C. Role-changing writes read `profiles`, not the JWT (164-M2, scoped)
- [ ] **C1.** The RPC's caller check (A, step 2), the `public.invitations` INSERT policy (`"Admins can insert invitations"`) and the UPDATE policy (`"Admins can update invitations"`, both USING and WITH CHECK) all decide "caller is privileged" from `profiles.role in ('admin','master','super_admin')`, not from `auth_is_privileged()`.
  - Everything else in the P_INV predicate (role whitelist, brand check, store check) stays the same in meaning.
  - The architect may add a shared helper. If it is a function, it must be SECURITY DEFINER with `search_path` pinned, and it must not read the JWT.
- [ ] **C2.** The `public.profiles` INSERT policy (`"Admins can insert profiles in own brand"`) makes the same swap.
- [ ] **C3.** A caller with a stale `app_metadata.role='admin'` claim and a `profiles` row with `role='user'` and `brand_id = A` gets 42501 on all three. This is 164-M2's exact scenario:
  - INSERT of a `role='admin', brand_id=A` invitation
  - UPDATE of an existing brand-A invitation
  - INSERT of a brand-A profile
- [ ] **C4.** Every existing arm in `profiles_insert_hardening.test.sql` and `invitations_super_admin_rls.test.sql` that admits a legitimate admin or super_admin still passes. `e2e/invite.spec.ts` still passes.
- [ ] **C5.** The new migration re-runs spec 164's fail-closed assertions after recreating the policies, and aborts the apply if any count is off:
  - exactly one permissive INSERT/ALL policy on `profiles`
  - exactly one permissive INSERT/ALL policy on `invitations`
  - exactly one permissive UPDATE/ALL policy on `invitations`
- [ ] **C6.** Each changed policy has a `comment on policy` saying it is deliberately backed by `profiles`, with the reason (164-M2 / spec 191).
- [ ] **C7.** `supabase/tests/permissive_policy_lint.test.sql` and `super_admin_policy_parity.test.sql` pass with no new allowlist rows.

### D. Close the super_admin direct-PATCH route (OQ-5)
- [ ] **D1.** When an `authenticated` super_admin changes **their own** `role` through a direct UPDATE on `profiles`, it raises P0001 `'cannot demote self'` and the row is unchanged.
- [ ] **D2.** When an `authenticated` super_admin's direct UPDATE moves another row **off** `super_admin` or `master`, it calls `assert_not_last_of_role(old.id, old.role)`. If that row is the last of its role, it raises `'cannot demote the last super_admin'` or `'cannot demote the last master'` and the row is unchanged.
- [ ] **D3.** Non-super_admin callers keep the existing behaviour: `'role is read-only for self-edits (super_admin only)'` and `'role changes require super_admin'`, along with the brand_id string, are unchanged. `auth_can_see_store_brand_scope.test.sql` (arms 7-8), `rls_hardening_followups.test.sql` and `profiles_rls_sweep.test.sql` pass unmodified.
- [ ] **D4.** Callers whose `current_user` is `postgres` or `service_role` are unaffected: migrations, MCP applies, pgTAP fixtures after `reset role`, and the SECURITY DEFINER RPC's own UPDATE. The RPC does its own checks (A, B), so nothing fires twice.

### E. Client and UI
- [ ] **E1.** No changes to `src/lib/db.ts` `demoteProfileToUser`, the `useStore` action, or `BrandsSection.tsx`. The signature `(profileId: string) => Promise<string>` is unchanged.
  - Why no new handling is needed:
    - The only button is super_admin-only, so a UI user never hits the brand-scope or super_admin-target refusals (A2, A3) or `'forbidden'` (A1).
    - A brand admin who calls the RPC directly gets these strings over HTTP. No screen of theirs calls it.
    - If a future brand-admin screen calls the wrapper, every refusal already surfaces through `notifyBackendError` with an optimistic revert. That future screen should hide Demote on cross-brand and super_admin rows rather than rely on the toast.
- [ ] **E2.** The one new string a UI user can hit is `'cannot demote the last master'`, when a super_admin demotes the only master from Brands → Members.
  - It shows through the existing toast, and the role pill reverts.
  - Manual check on the local stack (`admin@local.test` promoted to super_admin, the seed master as target): the toast shows the string and the row reverts to `master`. Record the result in the review notes.

### F. Tests and gates
- [ ] **F1.** pgTAP track (load-bearing). See "Test plan". `scripts/test-db.sh` passes on all files.
- [ ] **F2.** `npx jest` (full suite), `npm run typecheck` and `npm run typecheck:test` pass. No jest changes are expected.
- [ ] **F3.** Arm 7 of `scripts/smoke-edge-roles.sh` passes **unmodified**. It self-demotes as a plain admin and expects 400 `'cannot demote self'`, which A6 preserves.
  - Add one arm that checks PostgREST's real status mapping, because no pgTAP arm does. As the plain admin, demote a target in another brand. Expect HTTP 403 with message `'forbidden: target is in a different brand'`, and the target row unchanged.
  - The local seed may have only one brand. If so, the arm creates and removes its own second-brand fixture, the same way other arms use `docker exec psql`.
  - Smoke is not in CI, so run it by hand once.
- [ ] **F4.** After the push, the latest runs on `main` of `test.yml`, `db-migrations-applied.yml` and `e2e.yml` are green (CLAUDE.md gate rule, plus the e2e check from project memory).

### G. Docs
- [ ] **G1.** The migration header records the check order, the lock choice and every refusal string.
- [ ] **G2.** `README.md:229` is accurate once this spec ships. It may gain "brand-scoped".
- [ ] **G3.** **CLAUDE.md proposal.** Do not edit CLAUDE.md in this spec; the owner confirms the wording when the spec lands. The proposed sentence, appended to the spec 031 last-of-role bullet:
  > Role demotions through `public.demote_profile_to_user` and super_admin direct role edits on `profiles` call the same helper, with refusal strings `'cannot demote the last super_admin'` / `'cannot demote the last master'` (spec 191).

### H. Prod rollout
- [ ] **H1. Read-only pre-checks** (MCP `execute_sql`, project `ebwnovzzkwhsdxkpyjka`). Record the results in the spec.
  - counts of `super_admin` and `master` profiles
  - the permissive policy counts from C5 on `profiles` and `invitations`
  - the live `prosrc` of `demote_profile_to_user` and `assert_brand_id_immutable_for_self`, compared with the repo (normalized md5)
  - prod's JWT expiry setting, read from the dashboard

  **Stop and report** if prod has 0 super_admins, or an admin/master with `brand_id IS NULL`.
- [ ] **H2. Apply** (with owner approval):
  - Run the migration body, insert its exact version into `supabase_migrations.schema_migrations`, verify the normalized md5 of every function it creates or replaces, and check the `pg_policies` text of the three policies.
  - There is no client deploy, so there is no apply-to-deploy window.
- [ ] **H3. Commit and push**, then F4.

## In scope
- A new migration that:
  - replaces `demote_profile_to_user`: the check order in A, the lock, the last-of-role call, the demote-specific strings
  - recreates the invitations INSERT/UPDATE and profiles INSERT policies with a profiles-backed privileged check, re-asserting spec 164's policy counts
  - extends the `profiles` BEFORE UPDATE trigger function for super_admin direct role edits (D)
  - optionally adds one profiles-backed helper (C1)
- pgTAP: the new file and the edits listed in "Test plan".
- One new smoke arm (F3).
- A manual UI check (E2) and a concurrency probe (B4).

## Out of scope (explicitly)
- **Changing `auth_is_admin()` / `auth_is_privileged()` to consult `profiles`.** This is the only change that closes the stale-claim window across all of RLS.
  - Blast radius: effectively every privileged policy and function, 77 pgTAP files with JWT fixtures, and a per-row `profiles` lookup cost.
  - **Follow-up spec, decided 2026-11-09 (OQ-3).**
- **Ending the demoted user's sessions**, and **shortening prod `jwt_expiry`.** Not adopted (OQ-3). The expiry is the owner's operational setting.
- **`user_stores` own-row writes (164-H1).** Spec 195 owns these.
- **Removing the target's `user_stores` links on demotion.** Today a demoted admin keeps staff-level access to their linked stores. Changing that is a product decision.
- **Role hierarchy between admin and master.** A same-brand admin may demote a master, subject to the last-of-role guard. This matches `delete-user`.
- **Writing an audit row for demotions.** That belongs with 187's follow-up D (auditing privileged renames and email changes).
- **`delete-user`'s own race** between its last-of-role check and `auth.admin.deleteUser`, and how it relates to concurrent demotions. Record as a follow-up.
- **Invitation squatting / the anon `get_pending_invitation` oracle (164-M1)**, and the P_INV `brand_id IS NULL` arm.
- **Any UI change** (for example a brand-admin Demote surface, or hiding Demote on the last master).
- **`app.json` slug.** Not touched.

## Open questions resolved
Decided 2026-11-09. The owner answered OQ-1, OQ-3 and OQ-5. The owner was not asked OQ-2 or OQ-4, so the PM's recommendations stand, as the coordinator directed.

- **Q (OQ-1): Who may demote whom?** → **A: same-brand admins too** (the auditor's shape, not the PM's super_admin-only recommendation).
  - Admins and masters may demote `admin`/`master`/`user` targets in their own brand.
  - Demoting a super_admin needs a super_admin.
  - Super_admins may demote across brands.
  - Self and last-of-role guards apply in every case.
- **Q (OQ-2): Wording for the last-of-role refusal on demote?** → **A (PM recommendation, owner not asked):** `'cannot demote the last super_admin'` / `'cannot demote the last master'`, following the CLAUDE.md `'cannot <verb> …'` convention. The count stays in `assert_not_last_of_role`.
- **Q (OQ-3): How far does 164-M2 go here?** → **A: role-changing writes only.** That means the demote RPC's caller check, invitations INSERT/UPDATE and profiles INSERT. Changing `auth_is_admin()` is a separate, later spec.
- **Q (OQ-4): CLAUDE.md?** → **A (PM recommendation, owner not asked):** one additive sentence, recorded in G3 as a proposal the owner confirms at landing. This spec does not edit CLAUDE.md.
- **Q (OQ-5): Close the super_admin direct-PATCH route?** → **A: yes, the narrow trigger rule** (section D).
- **Q: Apply the post-review fix plan (`specs/191-demote-profile-brand-scope/reviews/release-proposal.md`, items 1-6)?** → **A: yes. The owner approved it on 2026-11-09 ("Apply all three (Recommended)").** The three are the release proposal's owner decisions 3, 4 and the fix-pass items as a whole:
  - **Item 1 (migration edit)** includes the security **L1** privilege check as the wrapper's first statement, and the optional **S3(b)** safeguard: step 7 is written `v_caller_role is distinct from 'super_admin'`.
  - **C4** (`e2e/invite.spec.ts`) will run in CI on a pushed non-`main` test branch later. It is not part of this fix pass.
  - **F3's Arm 7b script run and the E2 manual UI check are waived, with a record.** Evidence for F3: the test-engineer's minted-JWT request to `/rest/v1/rpc/demote_profile_to_user` (a self-minted `authenticated` JWT for a profile-less uid) returned HTTP 403 with `{"code":"42501",...,"message":"forbidden"}`; every 191 refusal of that kind (`forbidden`, `forbidden: target is in a different brand`, `forbidden: only a super_admin can demote a super_admin`) shares errcode 42501. Evidence for E2: pgTAP **B1b** pins the exact string `cannot demote the last master` for a super_admin caller through the same RPC, and the revert-plus-toast path was traced by reading (`src/store/useStore.ts:2064`, `src/lib/db.ts:5564`); no `src/` code changed.
  - **Security L3** (anon/PUBLIC EXECUTE on `assert_not_last_of_role`) is not done here; it moves to **spec 198**. Prod already has no anon/PUBLIC EXECUTE on that function; only the repo and the local stack grant anon.
  - **Security M1** (pre-demotion admin invitations survive, no inviter recorded) goes to **spec 198** and follow-up **X3**.
  - **`README.md`** is left out of this spec (G2): its "self- and last-of-role guards" claim becomes true when 191 ships.

## Decisions (with the alternatives not taken)
- **OQ-1, same-brand demotion.**
  - Not taken: super_admin only. It would have removed the in-brand setup described under Security notes, but brand admins would have lost an API capability.
  - Not taken: an extra "only master or super_admin may demote a master" rule.
- **OQ-2, `demote` wording.**
  - Not taken: reusing `'cannot delete the last …'` verbatim, which would make the toast read "Demote profile failed: cannot delete the last master".
- **OQ-3, profiles-backed checks on 1 RPC and 3 policies only.** Not taken:
  - ending sessions on demotion (doesn't shrink the window, and touches `auth.*`)
  - rewriting `auth_is_admin()` here (all of RLS; becomes the follow-up)
  - shortening `jwt_expiry` (an operational setting; the owner may still change it independently)
- **OQ-4, CLAUDE.md as a proposal only.** Not taken: recording the rule only in the migration header.
- **OQ-5, narrow trigger rule for super_admin callers.** Not taken:
  - refusing all direct role edits by `authenticated` callers (would remove the super_admin's API-only promote path)
  - leaving the route open

## Security notes
- **What this spec closes:**
  - cross-brand demotion (164-H2, and step 1 of 187-H2)
  - a brand admin demoting a super_admin
  - losing the last super_admin or master through the RPC or a direct PATCH
  - a stale admin claim demoting anyone
  - a stale admin claim minting an invitation or profile (164-M2)
- **What remains, in-brand.** A brand admin can still invite a second admin they control and then demote them, leaving a NULL-brand `user` profile whose token still carries `admin` for up to `jwt_expiry` seconds. During that window the token passes `auth_is_privileged()`:
  - on unscoped privileged policies
  - on store-scoped privileged policies for stores the account is still linked to (its own brand's stores)

  After this spec it can no longer demote anyone or create invitations or profiles.
  - **The step that made this dangerous was the cross-brand self-link** (187-H2): with a NULL brand, the account could add its own `user_stores` row to any brand's store. **Spec 195 removes that step.** Until spec 195 ships, the in-brand setup still leads cross-brand.
  - Closing the remaining window entirely is the `auth_is_admin()` follow-up.
- **Existence oracle.** An admin or master can tell P0002 (no such profile) apart from `'forbidden: target is in a different brand'`, which shows that a given uuid is a profile in some other brand. UUIDs are random and there is no enumeration route, so this is accepted as Low. The architect may instead return the brand refusal for a missing target when the caller is admin/master. In that case, update A2 and A6 to match.

## Test plan (tracks)

**pgTAP (load-bearing).** Hermetic `begin … rollback`. Callers use `set local role authenticated` plus `request.jwt.claims` with deliberately mismatched claim/profile pairs. The seed has one brand, no super_admin and one master (`33333333-…`), so fixtures create a second brand and promote a super_admin inside the transaction, the same way `delete_last_privileged_guard.test.sql` and `auth_can_see_store_brand_scope.test.sql` do.

| File | Change |
|---|---|
| **New** `supabase/tests/demote_profile_brand_scope.test.sql` (the architect may rename it) | Arms: A1 (3 callers), A2 (cross-brand admin target, cross-brand user target, NULL-brand target, forged-claim caller, plus a master caller), A3, A4 (each allowed in-brand case), A5 (cross-brand, and super_admin with two present), A7 row-unchanged checks, B1 (admin caller and super_admin caller), B4 serial arm, C3 RPC-side stale caller, D1, D2 |
| `supabase/tests/demote_self_guard.test.sql` | **Unmodified.** Must still pass (A6) |
| `supabase/tests/profiles_insert_hardening.test.sql` | Add the C3 arms (stale claim refused on invitations INSERT/UPDATE and profiles INSERT). Update any arm that pins policy text or relies on a claim-only privileged caller. Re-check the K arms (policy and trigger presence). Bump `plan()` |
| `supabase/tests/invitations_super_admin_rls.test.sql` | Re-run. Edit only if an arm's caller has a claim-only privilege |
| `supabase/tests/delete_last_privileged_guard.test.sql` | Edit only if B3 changes the helper's signature |
| `permissive_policy_lint`, `super_admin_policy_parity`, `auth_can_see_store_brand_scope`, `rls_hardening_followups`, `profiles_rls_sweep`, `legacy_permissive_policy_dropout` | Must pass unmodified |

**Shell smoke.** Arm 7 of `scripts/smoke-edge-roles.sh` stays unmodified. Add the cross-brand 403 arm from F3.

**jest.** No changes expected. The full suite still runs (project memory rule).

**e2e.** `e2e/invite.spec.ts` must stay green (C4).

## Follow-ups to record
- **`auth_is_admin()` agreement with `profiles`.** This closes the stale-claim window across all of RLS. Size it with the live-catalog queries below. Decided as a separate later spec on 2026-11-09.
- **`delete-user` last-of-role race** against concurrent demotions and deletes.
- **Audit rows for demotions** (with 187 follow-up D).

## Dependencies
- **Migrations it builds on:**
  - `20260520000000_demote_profile_to_user_rpc.sql` (spec 050)
  - `20260514160000_assert_not_last_of_role.sql` (spec 031)
  - `20261007000000_profiles_insert_hardening.sql` (spec 164: P_INV, the profiles INSERT policy, and the fail-closed DO blocks to repeat)
  - `20260517050000_rls_hardening_followups.sql` (the trigger function to extend)
- **`delete-user`** brand-gate message `'forbidden: target is in a different brand'` (`supabase/functions/delete-user/index.ts:156`). The RPC mirrors it; the edge function is not changed.
- **Spec 195 (in progress).**
  - It is independent at the object level: spec 195 changes `user_stores` policies, spec 191 changes `profiles`, `invitations`, one RPC and one trigger function.
  - Both are needed to close 187-H2 and the in-brand setup's cross-brand step.
  - Either can ship first. Coordinate migration timestamps (both `20261109…` or later, after spec 187's `20261108130000`) and `plan()` counts if both edit the same test file.
- **Specs 186 and 187 (uncommitted in the working tree).** Not touched by this spec. Stage only spec 191's files.
- **Live-catalog queries** for the follow-up's blast radius:
  - `select count(*) from pg_policies where schemaname='public' and (coalesce(qual,'')||coalesce(with_check,'')) ~ 'auth_is_(admin|privileged)\(|auth_can_see_store\(';`
  - `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosrc ~ 'auth_is_(admin|privileged)\(';`
- **No new packages. No edge function changes. No client code changes.**

## Risks
- **Prod has one super_admin (the owner).** After this spec, only another super_admin could demote them, and the self guard stops them demoting themselves by either path. If the owner account itself is lost, recovery still needs psql, as it does today.
- **Shared local stack.** The migration replaces two functions and recreates three policies. It is transaction-wrapped and safe to re-run (`create or replace`, `drop policy if exists`). Don't `supabase db reset` the shared stack while other specs are mid-review.
- **P_INV drift.** If prod has dashboard-drift policies on `invitations`, the C5 assertions abort the apply with nothing applied. That is the intended fail-closed behaviour; report it to the owner.
- **The B2 refusal is untestable in one session.** It needs concurrency, so it is covered by the lock design, code review and the B4 manual probe.
- **Lock scope.** A lock that is too broad would serialize every demotion. Demotion is rare and operator-driven, so this is acceptable. The architect should still keep the lock to `super_admin`/`master` targets where practical.

## Project-specific notes
- **Cmd UI section / legacy:** Cmd UI only. The single caller is `MembersTab` in `src/screens/cmd/sections/BrandsSection.tsx` (super_admin-only). It needs no code change (E1).
- **Per-store or admin-global:**
  - Demotion is **brand-scoped** for admins and masters and global for super_admins.
  - The invitation and profile INSERT policies keep their brand scoping through `auth_can_see_brand`.
  - No change to `auth_can_see_store()`.
- **Realtime channels touched:** none. `profiles` and `invitations` are not in the `supabase_realtime` publication, and no publication change is made, so the `docker restart supabase_realtime_imr-inventory` gotcha does not apply.
- **Migrations needed:** yes, one. It changes functions, policies and a trigger function, may add a helper, and adds no tables.
- **Edge functions touched:** none. `delete-user` is read only for reference.
- **Web/native scope:** both. There is no client change, so nothing needs a Vercel or EAS deploy. The release is migration-only.
- **Test tracks:** pgTAP (load-bearing), shell smoke (one new arm; Arm 7 unchanged), e2e (`invite.spec.ts` regression), jest (full suite run, no edits).
- **`app.json` slug:** not touched.

## Backend design

Architect, 2026-11-09. Everything below is read from the repo. I had no DB access, so section 9 lists the live-catalog queries the developer runs **before** writing the migration.

### 0. Summary of the calls

| Call | Decision |
|---|---|
| **B4, lock** | Two layers. (1) **Row locks** on `{caller, target}`, taken in `id` order with `for no key update`. This serializes any two demotions that share a caller or target (mutual demotion) and is where the caller re-read happens. (2) A **transaction advisory lock keyed by the target role**, taken only for `super_admin`/`master` targets, immediately before the count. This serializes third-party demotions of the same role. Both paths (RPC and the trigger) share one helper for layer 2. |
| **B3, wording** | A new wrapper `assert_demote_not_last_of_role(uuid, text)` takes the role lock, calls `assert_not_last_of_role` unchanged, catches P0001, and re-raises `'cannot demote the last <role>'` when the message is exactly `'cannot delete the last <role>'`. Any other P0001 is re-raised untouched. The helper's signature, body and grants are **not changed**, so `delete-user` and `delete_last_privileged_guard.test.sql` are unaffected. |
| **C1, helper** | Add `public.auth_profile_is_privileged()`: SECURITY DEFINER, `search_path = public, auth`, reads only `profiles.role` for `auth.uid()`. Used by the RPC's step 2 and by the three policies. The name deliberately does **not** contain the substring `auth_is_privileged`, so K-2 must be updated and can tell the two apart. |
| **Existence oracle** | **Keep P0002 for every caller.** Masking it alone would not close the oracle, because step 6 (contract A3) already tells an admin that a uuid is a super_admin. UUIDs are random and there is no enumeration route, so this stays Low, as the spec accepted. A2 and A6 are unchanged. |
| **OQ-5, trigger** | Extend `assert_brand_id_immutable_for_self()` (trigger `profiles_self_brand_lock`, BEFORE UPDATE, FOR EACH ROW, SECURITY INVOKER) with an `elsif` branch for super_admin callers when `current_user in ('authenticated','anon')` and `role` changes: first the self guard, then the shared wrapper. The existing non-super_admin branch keeps its logic and message strings identical (see deviation 2 for the ASCII-fied comment glyphs). |
| **Migration slot** | `supabase/migrations/20261109191000_demote_profile_brand_scope.sql`. See section 8. |

### 1. Data model

There are no table, column, index or publication changes. One additive migration, `20261109191000_demote_profile_brand_scope.sql`, written as pure ASCII (spec 163 M1 lesson) and wrapped in `begin; … commit;` like `20261007000000`. Safe to re-run: `create or replace` plus `drop policy if exists`.

The migration body runs in this order. The order matters because policies depend on the helper.

1. Create `public.auth_profile_is_privileged()`, then its comment and grants.
2. Create `public.assert_demote_not_last_of_role(uuid, text)`, then its comment and grants.
3. `create or replace public.demote_profile_to_user(uuid)`, then `comment on function` and the grants restated.
4. `create or replace public.assert_brand_id_immutable_for_self()`, then `comment on function`. The trigger binding is unchanged, so there is no `drop trigger`.
5. Drop and recreate the three policies, then `comment on policy` for each.
6. The fail-closed DO block (C5).

The header records the check order, the lock design, every refusal string, the prod-apply recipe and the rollback pointer (G1).

#### 1.1 `public.auth_profile_is_privileged()` (C1)

```
returns boolean  language sql  stable  security definer  set search_path = public, auth
body:  select exists (select 1 from public.profiles
                       where id = auth.uid()
                         and role in ('admin','master','super_admin'))
owner postgres
revoke all on function … from public, anon;  grant execute … to authenticated;
```

- It reads `auth.uid()`, which is the JWT `sub`, the same as every helper. It **never** reads `app_metadata`. That is what C1's "must not read the JWT" means.
- The role set mirrors `ADMIN_ROLES` and the inline check in spec 187's `tg_order_approvals_guard`. **Do not** refactor 187's inline check to use this helper in this spec. 187's comment says to keep it inline, and 187 is mid-build.
- Why `anon` is revoked: the three policies are `to authenticated`, so anon never evaluates them. If a future `to public` policy calls the helper, a hard permission error is safer than a silent `false`.
- Comment text: "spec 191 / 164-M2: profiles-backed privileged check for role-changing writes (demote RPC, invitations INSERT/UPDATE, profiles INSERT). Deliberately does not consult the JWT app_metadata.role claim, which stays stale for up to jwt_expiry after a demotion. auth_is_privileged() is unchanged; converging it is a follow-up spec."

#### 1.2 `public.assert_demote_not_last_of_role(p_target uuid, p_role text)` (B3, B4 layer 2)

```
returns void  language plpgsql  VOLATILE  security INVOKER  set search_path = public, auth
0. if not public.auth_profile_is_privileged() then
     raise exception using errcode = '42501', message = 'forbidden';         -- added 2026-11-09 (security L1)
1. if p_role is null or p_role not in ('super_admin','master') then return;   -- lock scope only
2. perform pg_advisory_xact_lock(hashtext('last_of_role:' || p_role));
3. begin
     perform public.assert_not_last_of_role(p_target, p_role);
   exception when sqlstate 'P0001' then
     if sqlerrm = 'cannot delete the last ' || p_role then
       raise exception using errcode = 'P0001', message = 'cannot demote the last ' || p_role;
     end if;
     raise;
   end;
revoke all on function … from public, anon;  grant execute … to authenticated;
```

- **The count stays in `assert_not_last_of_role`.** Step 1 only scopes the lock. If the role set in step 1 drifted from the helper's, the helper would still be called for the guarded roles; step 1 can only skip the lock and count for roles the helper treats as a no-op anyway.
- **VOLATILE is load-bearing.** Under READ COMMITTED, the PERFORM in step 3 takes a fresh snapshot after the lock is granted, so it sees a demotion that a competing transaction committed while this one waited. Never mark the wrapper STABLE.
- **Why SECURITY INVOKER plus an `authenticated` grant:** the trigger path is INVOKER with `current_user = authenticated`, so `authenticated` needs EXECUTE.
- **Step 0 (amended 2026-11-09, owner-approved fix plan, security L1).** As first built, any authenticated caller could call the wrapper directly over PostgREST, take the role advisory lock and get a last-of-role answer. Step 0 refuses a caller who is not privileged by `profiles.role` before the role filter and the lock. Both legitimate callers pass it: the RPC has already passed steps 2 and 4 for the same `auth.uid()`, and the trigger branch runs only for super_admins. pgTAP K-10 pins the order; W-1 pins the refusal.
- **Fail-closed coupling.** If someone rewords the helper's message, the wrapper re-raises the original P0001. The demotion is still refused, just with "delete" wording. Arms B1a, B1b and D2a pin the coupling: they go red if the helper's wording changes. K-6 checks structure only (corrected 2026-11-09; this line used to say K-6 pins it).
- **Lock key.** This uses the single-bigint form, following `stock_store_from_store` (`hashtext('stock_store:' || …)`). The two keys are `hashtext('last_of_role:super_admin')` and `hashtext('last_of_role:master')`.

#### 1.3 `public.demote_profile_to_user(target_user_id uuid)`, replaced

The signature, return type, SECURITY DEFINER, `search_path = public, auth` and owner `postgres` are unchanged. Restate `revoke execute … from public, anon; grant execute … to authenticated;`. Leave `service_role`'s posture as it is today; a service-role caller has a null `auth.uid()` and gets `'cannot demote self'`.

Check order, written as pseudocode:

```
v_caller := auth.uid()
1. v_caller is null                                   -> P0001 'cannot demote self'
2. not public.auth_profile_is_privileged()            -> 42501 'forbidden'
3. target_user_id = v_caller                          -> P0001 'cannot demote self'
4. LOCK + RE-READ (B4 layer 1):
     for r in select id, role, brand_id from public.profiles
               where id in (v_caller, target_user_id)
               order by id
               for no key update
     loop  -> v_caller_role/v_caller_brand  or  v_target_role/v_target_brand, v_found := true
   v_caller_role is null or not in ('admin','master','super_admin')
                                                      -> 42501 'forbidden'
5. not v_found                                        -> P0002 'target profile not found'
6. v_target_role = 'super_admin' and v_caller_role <> 'super_admin'
                                                      -> 42501 'forbidden: only a super_admin can demote a super_admin'
7. v_caller_role is distinct from 'super_admin'      -- was in ('admin','master'); amended 2026-11-09
   and (v_caller_brand is null or v_target_brand is distinct from v_caller_brand)
                                                      -> 42501 'forbidden: target is in a different brand'
8. perform public.assert_demote_not_last_of_role(target_user_id, v_target_role)
                                                      -> P0001 'cannot demote the last super_admin' | '... master'
9. update public.profiles set role = 'user', brand_id = null
    where id = target_user_id returning id into v_demoted;  return v_demoted;
```

**Deviation from the spec's step 4, with the reason (as the spec requires).** The spec says "take the lock, re-read the caller, then read the target `for update`". Here, step 4 takes **row locks on both rows in id order**, and the role advisory lock moves to step 8. The reasons:

- **(a) Lock order matches the trigger path.** A direct PATCH already holds the target's row lock when its BEFORE trigger runs, and only then takes the advisory lock. If the RPC took the advisory lock before its row locks, an RPC racing a PATCH on the same row would deadlock. With "rows, then advisory" on both paths, the only lock taken after the advisory lock is the UPDATE of a row that is already locked.
- **(b) The role key needs the target's role,** which is only known after the target row is read.
- **(c) Locking the caller's row** means the caller's role cannot change for the rest of the call. A super_admin demoting this caller, or the target demoting this caller back, waits. So "re-read after the lock" holds through step 9, not just at the moment of the read.
- **(d) Unprivileged callers never take locks,** because step 2 runs first. That keeps lock-based DoS off the table. Since the 2026-11-09 fix pass this holds on every path, not only the RPC: the wrapper's step 0 refuses an unprivileged direct caller before its lock.
- **Step 7 is fail-closed (amended 2026-11-09, owner-approved fix plan, architect S3(b)).** While step 4 holds, only admin/master callers reach step 7, so `is distinct from 'super_admin'` behaves exactly like `in ('admin','master')`. If a future refactor dropped the step-4 re-read, a caller demoted mid-call (re-read role `user`) would get the brand refusal instead of reaching every brand. pgTAP K-9 pins the step-4 re-read itself.
- `for no key update` is used, not `for update`, so the locks do not block FK `key share` locks, such as a concurrent `user_stores` insert that references the profile. The step 9 UPDATE needs only this lock level, because it changes non-key columns.

Steps 2 and 4 both check privilege. Step 2 is the cheap, lock-free refusal. Step 4 is the race-proof re-read. Both use the same role set. The RPC's own UPDATE fires `profiles_self_brand_lock` with `current_user = postgres`, so the trigger's new branch skips it and nothing fires twice (D4).

The `comment on function` covers A8: the check order, the profiles-backed caller check, why it is not `auth_is_privileged()` (164-M2, the stale claim; spec 157 deliberate-deviation rule), the lock design, and every refusal string.

#### 1.4 `public.assert_brand_id_immutable_for_self()`, extended (OQ-5, D)

It stays SECURITY INVOKER with `search_path = public, auth`, and stays bound to `profiles_self_brand_lock`. The new shape:

```
if tg_op = 'UPDATE' and not public.auth_is_super_admin() then
   <existing body: logic and message strings identical, all three message strings unchanged>
elsif tg_op = 'UPDATE'
      and current_user in ('authenticated', 'anon')
      and old.role is distinct from new.role then
   -- caller is a super_admin (profiles-backed)
   if old.id = auth.uid() then
     raise exception using errcode = 'P0001', message = 'cannot demote self';
   end if;
   perform public.assert_demote_not_last_of_role(old.id, old.role);
end if;
return new;
```

How it interacts with every other writer:

| Writer | `current_user` in trigger | Effect |
|---|---|---|
| Super_admin direct PATCH via PostgREST | `authenticated` | New branch fires: D1, D2 |
| `demote_profile_to_user` (DEFINER) | `postgres` | Skipped; the RPC does its own checks (D4) |
| `register_invited_profile` (DEFINER) | n/a, INSERT only | Not an UPDATE trigger; unaffected |
| `manage-store-user`, `delete-user` (service role) | `service_role` | Skipped. Neither updates `profiles` today: manage-store-user inserts or deletes, delete-user deletes |
| Migrations, MCP applies, pgTAP fixtures after `reset role` | `postgres` | Skipped, even when stale claims are still set (D4a pins this) |
| FK actions (for example brand-delete cascades) | table owner | Skipped; they change only `brand_id` anyway |
| `profiles_sync_role_to_jwt` | AFTER UPDATE OF role | Runs only if this BEFORE trigger lets the row through; a refusal leaves `auth.users` untouched |
| Spec 187 (`profiles` DELETE policy drop, `tg_order_approvals_guard`) | n/a | No overlap: 187 touches DELETE and `order_approvals`. This spec touches UPDATE triggers and INSERT policies |

**Promotion paths are not affected:**

- `user` to anything, and `admin` to `master`, have an unguarded `old.role`, so the wrapper is a no-op.
- Spec 042's arm 15 (super_admin promotes a user to super_admin) and the profiles fixture promotions in about 20 test files run as `postgres` and are unaffected.
- **One consequence to record (pinned by D2d):** promoting the **last** master to `super_admin` is refused with `'cannot demote the last master'`, because it moves the row off `master`. That is exactly D2's wording ("moves another row off super_admin or master"). The owner should know about it. Workaround: promote someone else to master first.

**Multi-row PATCH:**

- `update profiles set role='user' where role='master'`, run by a super_admin, is refused once only one master would remain. A row-level BEFORE trigger in a VOLATILE function sees the changes already made to earlier rows of the same statement. D2c pins this.
- In a multi-row statement, the advisory lock is held while later rows are row-locked. So a multi-row super_admin PATCH racing an RPC can deadlock. Postgres detects it after `deadlock_timeout` (1s) and aborts one side with 40P01. This fails closed and is rare: it needs a multi-row role PATCH, which no client sends. Accepted.

Update the `comment on function` to describe spec 041, 042 and 191 together. Keep the existing "SECURITY INVOKER is load-bearing" explanation.

#### 1.5 Policies (C1, C2, C5, C6)

Recreate these three with `drop policy if exists` + `create policy`, the same name, `to authenticated`, and permissive. The only change is `public.auth_is_privileged()` → `public.auth_profile_is_privileged()`; every other clause is copied verbatim from `20261007000000` L56-61 and L276-322:

- `public.profiles` `"Admins can insert profiles in own brand"` (INSERT, WITH CHECK)
- `public.invitations` `"Admins can insert invitations"` (INSERT, WITH CHECK, full P_INV)
- `public.invitations` `"Admins can update invitations"` (UPDATE, USING and WITH CHECK, full P_INV in both)

Add `comment on policy` to each: "spec 191 / 164-M2: privileged check deliberately reads profiles.role via auth_profile_is_privileged(), not the JWT claim (stale up to jwt_expiry after demotion). Rest of predicate unchanged from spec 164." The profiles INSERT comment keeps the spec 164 sentence about `profiles_insert_role_guard` and `register_invited_profile()`.

Then the fail-closed DO block (C5). Copy spec 164's three count checks (each must equal 1) with messages prefixed `191:`. Add a fourth check: the three recreated policies' `qual`/`with_check` text must contain `auth_profile_is_privileged()` and must not contain `auth_is_privileged()`. That catches a botched copy at apply time.

Untouched: the invitations SELECT/DELETE policies (K-13 pins `qual = 'auth_is_privileged()'`), `super_admin_manage_profiles`, `"Admins can update any profile"`, and every other `profiles` policy.

### 2. RLS impact

- **No new tables.** These policies change: the three in 1.5. Nothing else.
- Permissive-policy lint (spec 053): the new predicates are not trivially wide, so no allowlist row is added (C7). Spec 157's LINT-1 (no policy names `auth_is_admin`) still holds.
- Grant lint (spec 097) covers tables only. Function EXECUTE is handled by explicit revokes, because spec 097's `ALTER DEFAULT PRIVILEGES` gives `anon` an explicit EXECUTE on new functions. The revoke from `anon` must be explicit, not only from `public`.
- What the RLS change does for real callers:
  - A legitimate admin, master or super_admin has a matching `profiles.role`, so the result is unchanged.
  - A stale-claim `user` loses invitation and profile writes. That is the C3 fix.
  - A profile-less login with an admin claim loses them too, but it could not pass `auth_can_see_brand` before either.

### 3. API contract

The PostgREST RPC is unchanged: `POST /rest/v1/rpc/demote_profile_to_user`, body `{"target_user_id": uuid}`, returns the uuid.

| SQLSTATE | HTTP (PostgREST, authenticated) | Message |
|---|---|---|
| P0001 | 400 | `cannot demote self` |
| 42501 | 403 | `forbidden` |
| P0002 | 404 | `target profile not found` |
| 42501 | 403 | `forbidden: only a super_admin can demote a super_admin` |
| 42501 | 403 | `forbidden: target is in a different brand` (byte-identical to `delete-user/index.ts:156`) |
| P0001 | 400 | `cannot demote the last master` / `cannot demote the last super_admin` |
| 40P01 | 500-class | Deadlock: multi-row PATCH racing an RPC only, rare (1.4) |

Direct `PATCH /rest/v1/profiles` by a super_admin that changes `role` has two new refusals, both P0001 (HTTP 400): `cannot demote self` (own row) and `cannot demote the last <role>`.

**Correction to C3 (a test-shape fix, not a contract change).** An RLS UPDATE whose **USING** fails filters the row out silently. It does not raise 42501. So the C3 "UPDATE of an existing brand-A invitation" case asserts **0 rows affected and the row unchanged**, the same shape as existing arm D-12. The INSERT cases do raise 42501.

### 4. Edge functions

None changed. `delete-user`'s strings and its RPC call to `assert_not_last_of_role(target_user_id, target_role)` are untouched.

### 5. `src/lib/db.ts`, store, realtime

- **`db.ts`:** no change (E1). `demoteProfileToUser(profileId: string): Promise<string>` keeps its signature, and there is no new mapping.
- **`useStore.ts`:** no change. The existing optimistic revert with `notifyBackendError('Demote profile', e)` surfaces every new string (E2).
- **Realtime:** none. Neither `profiles` nor `invitations` is in `supabase_realtime`, and there is no publication change. The `docker restart supabase_realtime_imr-inventory` step does **not** apply.

### 6. Tests

#### 6.1 New file: `supabase/tests/demote_profile_brand_scope.test.sql`

- **Isolation:** hermetic `begin … rollback`.
- **Fixtures:** created as postgres with claims cleared. Synthetic `auth.users` rows have token columns set to `''` (see the project note on SQL-created auth users). Ids use the prefix `d1910000-…`; brand B is `b1910000-0000-0000-0000-00000000000b`.
- **Seed rows used:** A1 = `11111…` (admin, brand A), U = `22222…` (user, brand A), M1 = `33333…` (master, brand A).
- **Synthetic profiles:**

  | Id | Role | Brand |
  |---|---|---|
  | UA | user | A |
  | A2 | admin | A |
  | A4t | admin | A |
  | M2 | master | A |
  | MB | master | B |
  | AB | admin | B |
  | UB | user | B |
  | UN | user | NULL |
  | UA2 | user | A |
  | M3 | user (promoted later) | A |
  | S1, S2, S3 | super_admin | NULL |

  Plus O, an `auth.users` row with no profile.
- **Callers** use `set local role authenticated` plus `request.jwt.claims`.
- **Lock probe** (`L(role)`), run as postgres after `reset role`:

  `exists (select 1 from pg_locks where locktype='advisory' and pid=pg_backend_pid() and objsubid=1 and granted and ((classid::bigint << 32) | objid::bigint) = hashtext('last_of_role:'||<role>)::bigint)`

  Transaction-level advisory locks persist until the final rollback, so **arm order matters**. Keep the order below.

**The arms, in this order.** Each arm's "Mutation" names a change that must turn that arm red.

| # | Arm | Expect | Mutation it kills |
|---|---|---|---|
| K-1 | RPC `prosecdef`, owner `postgres`, `'search_path=public, auth' = any(proconfig)` | true | RPC made INVOKER, or search_path unpinned |
| K-2 | RPC EXECUTE: authenticated yes, anon no, PUBLIC no | true | Grant regression |
| K-3 | `auth_profile_is_privileged`: DEFINER, owner postgres, search_path pinned, `prosrc ~ 'profiles'` and `prosrc !~* 'jwt\|app_metadata'` | true | Helper reads the claim |
| K-4 | Helper EXECUTE: authenticated yes, anon no, PUBLIC no | true | Grant regression |
| K-5 | Wrapper: `prosecdef = false`, `provolatile = 'v'`, search_path pinned, EXECUTE authenticated yes / anon no / PUBLIC no | true | Wrapper marked STABLE or DEFINER |
| K-6 | `pg_get_functiondef` of the RPC and of the trigger function each contain `assert_demote_not_last_of_role(`, and neither matches `count\s*\(`. The wrapper contains `assert_not_last_of_role(`, `pg_advisory_xact_lock` and `'cannot delete the last '` | true | Count duplicated (B3); lock line removed |
| K-7 | `obj_description(RPC oid,'pg_proc') ~ 'profiles'` (A8) | true | Comment dropped |
| K-8 | `profiles_self_brand_lock` is BEFORE UPDATE ROW, calls `assert_brand_id_immutable_for_self()`, and that function is `prosecdef = false` | true | Trigger function made DEFINER (current_user collapses, spec 042) |
| K-9 (added 2026-11-09) | Comment-stripped RPC `prosrc` has the step-4 re-read (`v_caller_role is null or … not in ('admin', 'master', 'super_admin')` → 42501 `'forbidden'`) after `for no key update` and before the brand step, and matches none of `auth_is_privileged\|auth_is_admin\|jwt\|app_metadata` | true | Step-4 re-read removed; re-read made claim-based |
| K-10 (added 2026-11-09) | Comment-stripped wrapper `prosrc` starts with the `auth_profile_is_privileged()` → 42501 `'forbidden'` check, before the role filter and `pg_advisory_xact_lock` | true | Wrapper privilege check removed or moved after the lock |
| L-0 | `not L('master') and not L('super_admin')` | true | (precondition) |
| W-1 (added 2026-11-09) | U (profile `user`, claim `admin`) calls `assert_demote_not_last_of_role(<random uuid>, 'master')` directly | 42501 `forbidden` | Wrapper privilege check removed |
| A1a | U with claim `admin` demotes UA | 42501 `forbidden` | Step 2 reverted to `auth_is_privileged()` |
| A1b | O (no profile) with claim `admin` demotes UA | 42501 `forbidden` | Same |
| A1c | U with claim `super_admin` demotes UA | 42501 `forbidden` | No-regression (the claim never counted) |
| A1-RU | UA unchanged (role, brand) | true | Refusal after UPDATE |
| A2a-e | A1 → AB; A1 → UB; A1 → UN; A1 with claim `super_admin` → AB; MB (claim master) → UA | 42501 `forbidden: target is in a different brand` (each) | Step 7 removed. **A2c** also kills a non-NULL-safe `<>` |
| A2-RU | AB, UB, UN, UA unchanged | true | |
| A3a-b | A1 → S1; M1 → S1 | 42501 `forbidden: only a super_admin can demote a super_admin` | Step 6 removed (falls through to the brand string) |
| A3-RU | S1 still super_admin | true | |
| A4a | A1 demotes UA: `is(…, UA)` plus post `(user, NULL)` | ok | |
| A4b | A1 demotes A2: `is(…, A2)` plus post `(user, NULL)` | ok | |
| B4 | A2 (claim still `admin`, profile now `user`) demotes A1 | 42501 `forbidden`; A1 unchanged (2 assertions) | Step 2 or step 4 re-read made claim-based |
| L-scope | `not L('master') and not L('super_admin')` after two unguarded demotions | true | Lock taken for every role |
| A4c | M1 (claim master) demotes A4t | returns A4t | |
| A4d | A1 demotes M2 (M1 and MB remain) | returns M2 | Over-broad guard |
| L-1 | `L('master')` | true | **RPC path lock removed** |
| A5a | S1 demotes AB (cross-brand) | returns AB | Brand check applied to super_admin |
| A5b | S1 demotes MB (leaves M1 as the only master) | returns MB | |
| B1a | A1 demotes M1 | P0001 `cannot demote the last master` | Wrapper call removed; translation removed ("delete" wording) |
| B1b | S1 demotes M1 | same | Same |
| B1-RU | M1 still `(master, A)` | true | |
| D-pre | `not L('super_admin')` | true | (precondition) |
| D1 | S1 PATCHes its own row: `update profiles set role='user' where id=S1` | P0001 `cannot demote self` (S1, S2, S3 present, so this is not the last-of-role refusal) | Self branch removed |
| D1-RU | S1 still super_admin | true | |
| D2b | S1 PATCHes S3 to `user` | lives | |
| L-2 | `L('super_admin')` | true | **Trigger path lock removed** |
| D2b-RU (added 2026-11-09) | S3 is `(user, NULL)` | true | D2b's UPDATE matching 0 rows |
| D2a | S1 PATCHes M1 to `role='admin'` | P0001 `cannot demote the last master`; plus RU | Trigger `perform` removed |
| D2c | As postgres, set M3 to `(master, A)`. Then S1 runs `update profiles set role='user', brand_id=null where role='master'` | P0001 `cannot demote the last master`; M1 and M3 both still master (RU) | Trigger `perform` removed (multi-row) |
| D2d | As postgres, set M3 back to `user`. Then S1 PATCHes M1 to `(super_admin, NULL)` | P0001 `cannot demote the last master` | Pins the 1.4 consequence |
| D3a-c | S1 promotes UA2 from user to admin; then from admin to master; then promotes UN from user to `(super_admin, NULL)` | each lives with the expected role | New branch refusing every role change |
| A5c | S1 demotes S2 through the RPC (S1 and the promoted UN remain) | returns S2 | |
| D4a | `reset role` **keeping S1's claims**. As postgres, run `update profiles set role='user', brand_id=null where role='master'`. This demotes M1 and UA2 and leaves **zero** masters | lives (only possible because the branch skips postgres) | `current_user` gate removed |
| D4a-RU (added 2026-11-09) | M1 and UA2 are `(user, NULL)` | true | D4a's UPDATE matching 0 rows |
| D4b | As postgres, restore M1 alone to `(master, A)`. Then `set local role service_role` (S1 claims kept) and update M1 to `(user, NULL)`, leaving zero again | lives | `service_role` not skipped |
| D4b-RU (added 2026-11-09) | M1 is `(user, NULL)` | true | D4b's UPDATE matching 0 rows |

`plan()` equals the assertion count as written, about 53. Set it exactly when building. (Built as `plan(54)`; `plan(60)` after the 2026-11-09 fix pass added K-9, K-10, W-1, D2b-RU, D4a-RU and D4b-RU. K-6, K-9 and K-10 strip `--` comments before matching; K-7 also requires `auth_is_privileged` and `jwt_expiry` in the comment; A5c re-asserts S1's claims.)

`demote_self_guard.test.sql` stays **unmodified** (A6). Check against the new order:

- Arm (i): A1 is privileged by profile; self → `cannot demote self`.
- Arm (ii): the manager is in brand A, same as A1, role user, so no lock.
- Arm (iii): the manager's profile is `user` → `forbidden`.
- Arm (iv): null caller.

#### 6.2 `supabase/tests/profiles_insert_hardening.test.sql`, edited

- **K-2:** change `nc like '%auth_is_privileged%'` to `nc like '%auth_profile_is_privileged()%' and nc not like '%auth_is_privileged()%'`. Update the description.
- **New K-16:** the invitations INSERT `with_check`, and the UPDATE `qual` and `with_check`, each contain `auth_profile_is_privileged()` and none contains `auth_is_privileged()`. Normalize the text the same way K-2 does.
- **New K-17:** each of the three policies has a non-null `obj_description(pol.oid, 'pg_policy')` matching `spec 191`, joining `pg_policy` on `polname` (C6).
- **New K-18:** `auth_profile_is_privileged()`: EXECUTE authenticated true, anon false, PUBLIC false.
- **New section E, after section D.** Caller: the seed manager U (profile `user`, brand A) with `app_metadata.role = 'admin'`. This is 164-M2's exact scenario.
  - **E-1:** INSERT invitation `role='admin', brand_id=A` → 42501. Mutation: INSERT policy reverted → lives.
  - **E-2:** `with u as (update invitations set name='stale-191' where email='d1-164@local.test' returning 1) select is(count(*), 0)`. Mutation: UPDATE USING reverted → 1.
  - **E-3:** INSERT `profiles (id=<new orphan e1910000-…-0001>, role='user', brand_id=A)` → 42501. Mutation: profiles INSERT policy reverted → lives. Add the orphan to the `auth.users` fixture list.
- `plan(73)` becomes `plan(79)`. Update the arm map in the header.
- K-1, K-12, K-13, K-14 and K-15 are unchanged and still pass. Sections A and D callers are all profile-privileged, so they pass (C4).

#### 6.3 Must pass unmodified

- `demote_self_guard`
- `delete_last_privileged_guard` (the helper is unchanged)
- `invitations_super_admin_rls`: arm (i) A1 has profile `admin`; arm (ii) uses the promoted profile.
- `permissive_policy_lint`
- `super_admin_policy_parity`
- `auth_can_see_store_brand_scope`, arms 7-8: the existing branch keeps its logic and message strings identical.
- `rls_hardening_followups`: arm 13 uses the existing branch; arm 15 promotes a user.
- `profiles_rls_sweep`
- `legacy_permissive_policy_dropout`
- `public_grants_explicit`

Run the whole `scripts/test-db.sh`. About 20 files promote `33333…` to super_admin as postgres; that path is skipped by design (D4).

#### 6.4 Smoke: `scripts/smoke-edge-roles.sh`

Arm 7 stays unmodified. After Arm 4, `admin@local.test` is a super_admin by profile; the RPC still answers `cannot demote self` at step 3.

**New Arm 8, cross-brand demote → 403.** Place it after Arm 7.

- **Pre-clean, then fixtures,** via `docker exec … psql`: brand `b1910000-0000-0000-0000-00000000000b`; an `auth.users` row `d1910000-0000-0000-0000-0000000000a8` with `''` tokens; and a profile `(admin, brand B)`.
- **Caller state.** Snapshot the caller's `PRE_ROLE`/`PRE_BRAND`. Arm 4 has usually promoted the caller to super_admin, and a super_admin would legitimately succeed here. So if the role is not `admin`, set the caller to `(admin, brand A)` as postgres for the arm, and restore the snapshot afterwards. The EXIT trap `restore_admin` stays the final safety net.
- **Request:** POST the RPC with `$ADMIN_BEARER`.
- **Assert:** HTTP 403, body matches `"message":"forbidden: target is in a different brand"`, and the target is still `(admin, brand B)`.
- **Cleanup:** delete the profile, then the `auth.users` row, then the brand.
- If Arm 3 gave no token, SKIP.
- The smoke is not in CI; run it once by hand (F3).

#### 6.5 Manual B4 concurrency probe (local; record in review notes)

**Setup.** Two `psql` sessions into `supabase_db_imr-inventory`. Each runs `begin; set local role authenticated; select set_config('request.jwt.claims', '<json>', true);` and then the statement, and holds the transaction open until told to commit. Fixtures are committed as postgres first; the restore SQL is at the end.

| Probe | Fixture | Session 1 (hold, then COMMIT) | Session 2 | Expected |
|---|---|---|---|---|
| P1a, row lock (same caller; layer 1) | Promote `22222…` to `(master, A)`, so there are 2 masters | A1 demotes `33333…` | A1 demotes `22222…`. It **blocks** on A1's row lock (`Lock/transactionid`) until S1 commits | S2: `cannot demote the last master`; exactly 1 master left. **No mutation step** (dropping the advisory lock does not change this probe) |
| P1b, advisory lock (third party; layer 2) | Same 2 masters, plus a second brand-A admin X, so the two `{caller, target}` sets do not overlap | A1 demotes `33333…` | X demotes `22222…`. It **blocks** on `Lock/advisory` (master key) until S1 commits | S2: `cannot demote the last master`; exactly 1 master left |
| P2, row locks (mutual) | Same 2 masters | `33333…` (claim master) demotes `22222…` | `22222…` (claim master) demotes `33333…`. It blocks | S2: `forbidden` (caller re-read); 1 master left |
| P3, trigger path (mutual PATCH; B2 string) | Promote `11111…` and `22222…` to `(super_admin, NULL)`, so there are 2 super_admins | `11111…` runs `update profiles set role='user' where id='22222…'` | `22222…` runs `update … where id='11111…'`. It blocks | S2: `cannot demote the last super_admin`; 1 super_admin left |

- **Mutation for P1b (local only, never committed):** `create or replace` the wrapper without the `pg_advisory_xact_lock` line and rerun **P1b**. S2 must **not** block, and both demotions succeed, leaving 0 masters. Then re-apply the migration's wrapper body. (Amended 2026-11-09, architect S5: the design's original single P1 used A1 as caller in both sessions, so S2 blocked on layer 1 and the mutation could not be seen. The developer's P1′ is P1b.)
- **Restore (as postgres):** `11111…` → `(admin, A)`, `22222…` → `(user, A)`, `33333…` → `(master, A)`. The sync trigger re-syncs `app_metadata`.

#### 6.6 E2 manual UI check

As written in the spec: `admin@local.test` promoted to super_admin, demoting seed master `33333…` from Brands → Members. Expect the toast `cannot demote the last master` and the role pill reverting.

### 7. Blast radius, confirmed from the repo text

| What | Today |
|---|---|
| `auth_is_privileged()` in migrations | 189 occurrences in 34 files. The spec's 184/33 predates spec 189's `20261109120000` |
| pgTAP files mentioning `app_metadata` | 84 (298 occurrences). This is a broader grep than the spec's, and includes comments |
| What this spec moves to `profiles` | 3 live policies + 1 RPC gate |
| What stays on the JWT | `auth_is_admin()`, `auth_is_privileged()` and every other policy (follow-up) |

Live counts come from the section 9 queries.

### 8. Migration slot and coordination

- **On disk, newest first:** `20261109120000` (spec 189), `20261108130000` (187), `20261108120000` (186).
- **Reserved in specs but not yet on disk:** `20261109000000` (188) and `20261109140000` (190-po-number-sequence).
- **This spec takes `20261109191000`,** a mnemonic for spec 191 at 19:10. It sorts after all of the above.
- **Spec 195-user-stores-own-row-writes:** take `20261109190000`, or any free slot that is not `20261109191000`. Spec numbers have clashed between sessions (this spec was drafted as 190 and renamed to 195 on 2026-11-09 because 190 is po-number-sequence), so before creating the file, run `ls supabase/migrations | sort | tail -3` and grep `specs/` for the chosen version.
- **Ordering:** 195 and 191 change disjoint objects (`user_stores` policies vs `profiles`/`invitations` policies, one RPC and one trigger function), so they apply in either order.
  - The drift gate compares sets, so each version must be on prod before the push that commits it.
  - Spec 195 must **not** reference `auth_profile_is_privileged()`, so that neither spec depends on the other landing first. A later spec can adopt the helper.
- **Spec 187:** no object overlap (see 1.4). Neither spec edits the other's test files. Stage only 191's files.

### 9. Developer pre-build queries (local; then the same on prod at H1)

```
-- (a) policies on the two tables
select tablename, policyname, cmd, permissive, roles, qual, with_check
  from pg_policies where schemaname='public' and tablename in ('profiles','invitations') order by 1,3,2;
-- (b) C5 baseline: expect 1 / 1 / 1
select tablename, count(*) filter (where cmd in ('INSERT','ALL')) ins_all,
                  count(*) filter (where cmd in ('UPDATE','ALL')) upd_all
  from pg_policies where schemaname='public' and permissive='PERMISSIVE'
   and tablename in ('profiles','invitations') group by 1;
-- (c) triggers on profiles: expect profiles_self_brand_lock, profiles_self_delete_lock,
--     profiles_sync_role_to_jwt, profiles_insert_role_guard (+ any non-role ones; list them)
select tgname, tgtype, tgfoid::regprocedure, tgenabled from pg_trigger
 where tgrelid='public.profiles'::regclass and not tgisinternal order by 1;
-- (d) names are free: expect 0 rows
select proname from pg_proc where pronamespace='public'::regnamespace
   and proname in ('auth_profile_is_privileged','assert_demote_not_last_of_role');
-- (e) bodies to replace match the repo
select p.oid::regprocedure, md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')), p.prosecdef, p.proconfig,
       p.proowner::regrole, p.proacl
  from pg_proc p where p.oid in ('public.demote_profile_to_user(uuid)'::regprocedure,
       'public.assert_brand_id_immutable_for_self()'::regprocedure,
       'public.assert_not_last_of_role(uuid,text)'::regprocedure);
-- (f) follow-up blast radius (record only)
select count(*) from pg_policies where schemaname='public'
   and (coalesce(qual,'')||coalesce(with_check,'')) ~ 'auth_is_(admin|privileged)\(|auth_can_see_store\(';
select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.prosrc ~ 'auth_is_(admin|privileged)\(';
```

If (c) shows another BEFORE UPDATE trigger on `profiles` that touches `role`, stop and report; the design assumes `profiles_self_brand_lock` is the only one.

### 10. Prod rollout (project `ebwnovzzkwhsdxkpyjka`, MCP `execute_sql`)

**H1, read-only.**

- Run queries 9(a)–(e) on prod, plus:
  - `select role, count(*) from public.profiles where role in ('super_admin','master') group by 1;`
  - `select count(*) from public.profiles where role in ('admin','master') and brand_id is null;`
  - `select version from supabase_migrations.schema_migrations where version >= '20261108000000' order by 1;`
- Read `jwt_expiry` from the dashboard.
- **Stop and report if any of these hold:**
  - 0 super_admins
  - any admin or master with a NULL brand
  - any C5 count ≠ 1
  - (d) returns rows
  - (e) md5s differ from local (drift)
  - extra `profiles` triggers versus local

**H2, apply (with owner approval).**

1. `execute_sql` the migration file body exactly as committed.
2. `insert into supabase_migrations.schema_migrations (version, name) values ('20261109191000', 'demote_profile_brand_scope');`. Use the same column set as the 164 and 187 inserts, and only this version.
3. **Verify functions.** For `demote_profile_to_user(uuid)`, `assert_brand_id_immutable_for_self()`, `auth_profile_is_privileged()` and `assert_demote_not_last_of_role(uuid,text)`, the normalized md5 of `prosrc` must equal local. `prosecdef` (t/f/t/f respectively), `proconfig` (`search_path=public, auth`), owner `postgres` and `proacl` must also equal local. `assert_not_last_of_role(uuid,text)` md5 must be **unchanged** from H1.
4. **Verify policies and grants.**
   - The `pg_policies` `qual`/`with_check` text of the three policies equals local.
   - The C5 counts equal 1.
   - `has_function_privilege` for anon is false on both new functions and on the RPC.
5. **Optional, with owner approval:** a rolled-back refusal probe as the owner's super_admin id. Run `begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"<owner id>","role":"authenticated"}', true); select public.demote_profile_to_user('<owner id>'); rollback;`. Expect `cannot demote self`. Repeat with `update public.profiles set role='user' where id='<owner id>'` and expect the same string (D1 on prod).

**H3.** Commit and push only after H2 step 2. Then check F4 (`test.yml`, `db-migrations-applied.yml`, and `e2e.yml` by hand).

**Rollback.** The rollback SQL is `specs/191-demote-profile-brand-scope/rollback.sql` (written and dry-run 2026-11-10; see Implementation notes), not a migration file, unless the migration is already pushed. It runs in one transaction:

1. Recreate the three policies with their exact `20261007000000` text and the spec 164 comment, and re-run the 164 DO block.
2. `create or replace` `assert_brand_id_immutable_for_self()` from `20260517050000` L196-248, verbatim, including its comment.
3. `create or replace` `demote_profile_to_user` from `20260520000000`, verbatim.
4. `drop function public.assert_demote_not_last_of_role(uuid,text); drop function public.auth_profile_is_privileged();`. These must come **after** steps 1-3, because the policies and functions depend on them.

What to do with the version row:

- **Not yet pushed:** also `delete from supabase_migrations.schema_migrations where version='20261109191000'`, and revert the repo files.
- **Already pushed:** ship the same body as a new forward migration with a later version. Never delete the version row of a pushed migration.

Rolling back reopens 164-H2 and 187-H2 step 1.

### 11. Risks and tradeoffs

- **READ COMMITTED assumption.** The lock design relies on fresh per-statement snapshots, which is PostgREST's and psql's default. Under REPEATABLE READ, a waiter would see a stale count, though its row-lock re-read raises 40001 in the mutual case. Nothing in the app sets a higher isolation level. Recorded in the migration header.
- **Deadlock (40P01)** is possible only for a multi-row super_admin role PATCH racing an RPC. It fails closed (1.4).
- **The last master cannot be promoted to super_admin** directly (D2d). This is intended per D2; the owner should be told.
- **`delete-user` race (follow-up, unchanged).** It calls `assert_not_last_of_role` without the role lock, so a delete racing a demotion of the last two masters could still leave zero. The fix would be for `delete-user` to call a locking variant, but its check and `auth.admin.deleteUser` are not in one transaction anyway. Stays a follow-up, as the spec says.
- **Message coupling (B3).** The wrapper matches the helper's text exactly. A reword of the helper keeps refusing but loses the "demote" wording; B1a, B1b and D2a catch it in CI (K-6 checks structure only).
- **Performance.** One primary-key lookup on `profiles` per evaluation of the three policies, two row locks and at most one advisory lock per demotion. This is negligible on the 286 KB seed and on prod. No edge function, so no cold-start concern.
- **The stale claim still works elsewhere** (`auth_is_privileged()` across the rest of RLS) for up to `jwt_expiry`. This is the out-of-scope follow-up the spec names.

### Files the developer is expected to change

- `supabase/migrations/20261109191000_demote_profile_brand_scope.sql` (new)
- `supabase/tests/demote_profile_brand_scope.test.sql` (new)
- `supabase/tests/profiles_insert_hardening.test.sql` (K-2, K-16 to K-18, section E, `plan(79)`)
- `scripts/smoke-edge-roles.sh` (new Arm 8)
- `README.md:229` (G2)
- This spec: the H1 results, the B4 probe and E2 results in the review notes, and `## Files changed`

## Handoff
next_agent: backend-developer
prompt: Implement against the design in this spec (specs/191-demote-profile-brand-scope.md, "## Backend design"). Run the section 9 pre-build queries on the local stack first and stop if (c) or (e) disagree with the design. Use migration version 20261109191000. Do not touch spec 186/187/189/190 files or CLAUDE.md. After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/191-demote-profile-brand-scope.md

## Implementation notes (backend-developer, 2026-11-09)

### Section 9 pre-build queries (local, before writing the migration)

| Query | Result | Matches the design? |
|---|---|---|
| (a) policies | `profiles`: 1 INSERT (`Admins can insert profiles in own brand`, `to authenticated`), 3 SELECT, 3 UPDATE. `invitations`: SELECT and DELETE `auth_is_privileged()`, plus INSERT and UPDATE P_INV (`to authenticated`) | yes |
| (b) C5 baseline | invitations ins_all=1, upd_all=1; profiles ins_all=1 (profiles upd_all=3 is not a C5 count) | yes |
| (c) triggers on `profiles` | `profiles_insert_role_guard` (7, BEFORE INSERT), `profiles_self_brand_lock` (19, BEFORE UPDATE), `profiles_self_delete_lock` (11, BEFORE DELETE), `profiles_sync_role_to_jwt` (21, AFTER INSERT/UPDATE). No other BEFORE UPDATE trigger | yes |
| (d) new names free | 0 rows | yes |
| (e) bodies vs repo (normalized md5) | `demote_profile_to_user` f77056fb..., `assert_brand_id_immutable_for_self` c7318dd8..., `assert_not_last_of_role` 0638c51b...; each equals the md5 of its repo migration body | yes |
| (f) follow-up blast radius (record only) | 107 policies match `auth_is_(admin\|privileged)\(\|auth_can_see_store\(`; 22 public functions match `auth_is_(admin\|privileged)\(` | n/a |
| extra | local roles: 1 admin, 1 master, 1 user, 0 super_admin; 0 admin/master with NULL brand; `transaction_isolation` = read committed; `deadlock_timeout` = 1s | yes |

Nothing differed, so the build went ahead.

### Apply (local only)

- Version `20261109191000` was free (195 used `…195000`; 193 reserves `…190000`). Applied with `psql -f` (ON_ERROR_STOP), then `insert into supabase_migrations.schema_migrations (version, name) values ('20261109191000', 'demote_profile_brand_scope')`. A dry run inside a rolled-back transaction came first.
- Live vs file (normalized md5 of `prosrc`), checked after apply and again after all mutations: `auth_profile_is_privileged` 7b8fd913..., `assert_demote_not_last_of_role` 2cea0747..., `demote_profile_to_user` ceda99fa..., `assert_brand_id_immutable_for_self` 1ce30998.... All four match the file. `assert_not_last_of_role` is still 0638c51b... (unchanged).
- Nothing on prod. H1/H2/H3 are still open.

### Deviations from the design (each small, recorded here for the post-impl review)

1. **Smoke arm is "Arm 7b", not "Arm 8".** `scripts/smoke-edge-roles.sh` already has an Arm 8 (spec 167), and its header says it must run last. The new arm goes between Arm 7 and Arm 8, and its fixture cleanup is also wired into the EXIT trap (`XB_CREATED`).
2. **ASCII in the "byte-identical" trigger branch.** The original comments in `assert_brand_id_immutable_for_self()` contain three non-ASCII characters (em dash, arrow, section sign). Section 1 asks for a pure-ASCII file, so they became `-`, `->` and `section`. The logic and all three message strings are byte-identical. `auth_can_see_store_brand_scope` arms 7-8, `rls_hardening_followups` and `profiles_rls_sweep` pass.
3. **L-scope probes four keys.** It checks the `admin` and `user` keys as well as `master` and `super_admin`. Without that, the design's "lock taken for every role" mutation survives, because it locks `last_of_role:admin` / `last_of_role:user`, not the two keys the design's L-scope checked.
4. **Corrections to the 6.1 / 6.2 "mutation it kills" column.** All of these mutations are still killed; only the arm that catches them differs:
   - "Step 2 reverted to `auth_is_privileged()`" alone does **not** turn A1a/A1b red, because the step-4 re-read gives the same `forbidden`. **A2d** catches it: under `auth_is_privileged()`, an admin with a `super_admin` claim gets `forbidden` instead of the brand refusal. Reverting steps 2 **and** 4 turns A1a, A1b and A2d red.
   - A step-4-only mutation is not caught by B4, because step 2 refuses first. Only the P2 probe catches it.
   - E-2 with "UPDATE USING reverted": the row now passes USING, but the WITH CHECK (still profiles-backed) raises 42501. So E-2 errors and the file fails under `ON_ERROR_STOP`, rather than returning `count = 1`. K-16 also goes red.
5. **P1 as written does not exercise the advisory lock.** In the design's P1, A1 is the caller in both sessions, so S2 blocks on A1's **row lock** (layer 1, `Lock/transactionid`), not on the advisory lock. With the advisory lock removed, P1 as written still serializes and refuses. I added **P1'** with two different callers (A1 and a second brand-A admin X), which is what the design's "third party" label describes.

### Mutations (all inside a transaction that ended in ROLLBACK; never visible to other sessions)

Each run was `begin; <mutated create or replace / grant / policy>; <test file>; rollback;` against the shared DB. These arms went red:

| Mutation | Red arms |
|---|---|
| RPC made SECURITY INVOKER | K-1, A2a-e, A3a-b (plus an RLS error) |
| RPC EXECUTE granted to anon | K-2 |
| Helper also reads `auth.jwt()->app_metadata->role` | K-3; in profiles_insert_hardening: E-1, E-2, E-3 |
| Wrapper STABLE | K-5 |
| Wrapper SECURITY DEFINER | K-5 |
| Wrapper without `pg_advisory_xact_lock` | K-6, L-1, L-2 |
| RPC calls `assert_not_last_of_role` directly (no wrapper) | K-6, L-1, B1a, B1b |
| RPC comment dropped | K-7 |
| Trigger function SECURITY DEFINER | K-8, D1, D1-RU, L-2, D2a, D2c, D2d, D3 |
| Step 2 to `auth_is_privileged()` | A2d |
| Steps 2 and 4 to `auth_is_privileged()` | A1a, A1b, A1-RU, A2d, A2-RU |
| Step 7 removed | A2a-e, A2-RU |
| Step 7 as non-NULL-safe `<>` | A2c |
| Step 6 removed | A3a, A3b |
| RPC wrapper call removed | K-6, L-1, B1a, B1b, B1-RU, D2a, D2a-RU, D2c-RU, D2d |
| Wrapper translation removed ("delete" wording) | K-6, B1a, B1b, D2a, D2c, D2d |
| Wrapper locks before its role filter (every role) | L-scope |
| Trigger `perform` removed | K-6, L-2, D2a, D2a-RU, D2c, D2c-RU, D2d |
| Trigger self branch removed | D1, D1-RU, D2a, D2c, D2d, D3 |
| Trigger `current_user` gate removed | D4a |
| Trigger also fires for service_role | D4b |
| Trigger refuses every role change | K-6, D2b, L-2, D2a, D2c, D2d, D3a-c, D3 |
| invitations INSERT policy reverted | K-16, K-17, E-1 |
| invitations UPDATE USING reverted | K-16, K-17 (+ E-2 errors, see deviation 4) |
| profiles INSERT policy reverted | K-2, K-17, E-3 |

### B4 lock probes P1-P3

**Where they ran.** Each probe needs committed fixtures (a second master or super_admin), and S1 has to commit for S2's re-read to mean anything. Neither can be rolled back in the shared `postgres` database. So the probes ran in a throwaway database, `probe191`, on the same local Postgres server:
- It was a schema-only clone of `public` + `auth`, made with `pg_dump -s --no-owner`. The md5s of the five functions, the profiles triggers and the profiles policies were checked to be identical to the shared DB.
- Fixtures were 4 profiles (A1 admin, U, M1 master, X admin; all brand A).
- **S2 always rolled back. S1 committed, but only inside `probe191`.**
- `probe191` was dropped afterwards. Nothing was committed to the shared DB, and the seed profiles there are unchanged.

A third session watched `pg_stat_activity` / `pg_locks` while S2 was blocked. Lock keys: `hashtext('last_of_role:master')` = -809560464, `'last_of_role:super_admin'` = 36413747.

| Probe | S1 (hold 4s, COMMIT) | S2 (ROLLBACK) | What S2 waited on | S2 saw | After S1 commit |
|---|---|---|---|---|---|
| P1 as written (2 masters; A1 caller in both) | A1 demotes M1, returns id | A1 demotes U | `Lock/transactionid` (A1's row lock) | `ERROR: cannot demote the last master` after S1 committed | 1 master (U) |
| **P1'** (2 masters; callers A1 and X) | A1 demotes M1, returns id | X demotes U | `Lock/advisory` ExclusiveLock, classid=4294967295 objid=3485406832 (= -809560464, master key) | `ERROR: cannot demote the last master` after S1 committed | 1 master (U) |
| P2 (2 masters, mutual RPC) | M1 (claim master) demotes U, returns id | U (claim master) demotes M1 | `Lock/transactionid` (row lock) | `ERROR: forbidden` (caller re-read) | 1 master (M1) |
| P3 (2 super_admins, mutual direct PATCH) | A1 `update profiles set role='user' where id=U`, UPDATE 1 | U `update ... where id=A1` | `Lock/advisory` objid=36413747 (super_admin key) | `ERROR: cannot demote the last super_admin` (B2 string) | 1 super_admin (A1) |
| **P1' mutant** (wrapper without the advisory lock, in probe191 only) | A1 demotes M1 | X demotes U | did not block | succeeded (returned U's id) while S1's demotion was pending. Had S2 committed, 0 masters would remain | (S2 rolled back) |
| P1-as-written mutant | A1 demotes M1 | A1 demotes U | `Lock/transactionid` | `cannot demote the last master`, so this mutant is not detected (deviation 5) | 1 master |

### E2 (UI) - confirmed by reading, not in a browser

`MembersTab.handleDemote` (`src/screens/cmd/sections/BrandsSection.tsx:885`) awaits `useStore.demoteProfileToUser`. That action (`src/store/useStore.ts:2064`) flips the cached pill optimistically. On a thrown `PostgrestError` it restores `brandAdminsByBrandId` to `prevByBrand` (the pill goes back to `master`) and calls `notifyBackendError('Demote profile', e)`, which shows an error toast: text1 `Demote profile failed`, text2 `e.message` = `cannot demote the last master`. `db.demoteProfileToUser` (`src/lib/db.ts:5564`) rethrows the RPC error unchanged. No UI code changed. The live browser check needs `admin@local.test` promoted to super_admin, which is a shared login, so it was not done.

### Not run / still open (first build; see the fix pass below for the current status)

- `scripts/smoke-edge-roles.sh` was **not run**: its Arm 4 promotes the shared `admin@local.test` login. The Arm 7b fixture SQL (brand, auth.users with `''` tokens, admin profile, cleanup) was checked inside a rolled-back transaction, and `bash -n` passes. The PostgREST 42501 -> HTTP 403 mapping (F3) was later verified by the test-engineer (fix pass, below).
- `e2e/invite.spec.ts` (C4) was not run.
- E2 browser check (see above).
- H1/H2/H3 prod rollout.

### Follow-ups

- **README.md:229 (G2)** still says the RPC has "self- and last-of-role guards". It becomes true with this migration, and could add "brand-scoped". Owner decision 2026-11-09: README.md stays out of this spec.
- **CLAUDE.md G3 sentence** is for the owner to confirm at landing; not edited.
- **Owner note (D2d):** the last master cannot be promoted straight to super_admin (`cannot demote the last master`). Promote someone else to master first.
- **6.5 P1 wording:** done in the fix pass (P1a / P1b).
- **Security L3** (anon/PUBLIC EXECUTE on `assert_not_last_of_role`): spec 198. **Security M1**: spec 198 and follow-up X3.
- Carried over from the spec: the `auth_is_admin()` / `profiles` convergence, the `delete-user` last-of-role race, and audit rows for demotions.

## Fix pass (backend-developer, 2026-11-10)

Applied `specs/191-demote-profile-brand-scope/reviews/release-proposal.md` items 1-6, in its order, as approved by the owner on 2026-11-09 (see "Open questions resolved"). Migration `20261109191000` was edited in place: it is not on prod.

### Item 1: migration edits

- **1a (architect S1):** `set local lock_timeout = '5s';` straight after `begin;`, with the reason. Outside every function body.
- **1b (security L1):** the wrapper `assert_demote_not_last_of_role` now starts with `if not public.auth_profile_is_privileged() then raise exception using errcode = '42501', message = 'forbidden'; end if;`, before its role filter and `pg_advisory_xact_lock`. The role-filter comment now says the list mirrors `assert_not_last_of_role`'s guarded roles and both change together. The wrapper's `comment on function` and the helper's usage list were updated to match.
- **1c (architect S3(b)):** step 7 is `v_caller_role is distinct from 'super_admin'`. The step-4 comment says its role list must equal `auth_profile_is_privileged()`'s set and that K-9 pins it. `v_found` is renamed `v_target_found`. The RPC's `comment on function` says "every non-super_admin caller" for step 7.
- **1d (text only):** K-6 claim corrected to "B1a/B1b/D2a (K-6 checks structure only)"; "byte-identical" for the trigger's first branch corrected (logic and message strings identical, three comment glyphs ASCII-fied) in the header and the section 4 banner (the delete-user brand-message "byte-identical" claims are true and kept); spec-section coordinates replaced by self-describing labels; rollback pointer now names `rollback.sql`; prod-apply list gains `prosecdef` t/f/t/f, `proconfig`, owner and `proacl`; ENCODING line spells out the spec 163 M1 lesson; isolation-level claim reduced to the assumption plus how to check it; profiles INSERT policy comment split into clean sentences; the DO block's fourth check uses `position()` instead of `LIKE`; the trigger banner says why reaching the `elsif` implies super_admin.
- The file is still pure ASCII (0 non-ASCII bytes).

**Local re-apply (shared stack).** Only the changed statements, copied out of the file by line range, in one psql transaction with `ON_ERROR_STOP` and `lock_timeout = '5s'`: the helper's `comment on function`; the wrapper's `create or replace` + comment; the RPC's `create or replace` + comment; the profiles INSERT policy's `comment on policy`. The policies themselves, the trigger function, the helper body, the grants and the version row were not re-applied (unchanged). No `db reset`/`stop`. The **whole edited file** was then run once with its `commit;` swapped for `rollback;` (under `ON_ERROR_STOP`), so the new `lock_timeout` line and the `position()`-based DO block were exercised end to end: every statement through `DO` succeeded, then `ROLLBACK`.

**Live vs file afterwards** (raw and normalized md5 of `prosrc`, all four MATCH):

| Function | Normalized md5 (the H2 reference) | prosecdef | provolatile | proconfig | owner | proacl |
|---|---|---|---|---|---|---|
| `demote_profile_to_user(uuid)` | `bcfcc47094be06d97000053bb396fc51` (was `ceda99fa…`) | t | v | `{"search_path=public, auth"}` | postgres | `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}` |
| `assert_brand_id_immutable_for_self()` | `1ce30998e0d1264f116c0beb8b4cc76c` (unchanged) | f | v | same | postgres | `{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}` (unchanged by 191) |
| `auth_profile_is_privileged()` | `7b8fd9139961526f16dbd177e371e337` (unchanged) | t | s | same | postgres | `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}` |
| `assert_demote_not_last_of_role(uuid,text)` | `19495402c5dacfa14d5b67b048192fd1` (was `2cea0747…`) | f | v | same | postgres | `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}` |
| `assert_not_last_of_role(uuid,text)` | `0638c51b89305a6c109a146f2feb7f9a` (must stay unchanged on prod) | t | s | same | postgres | `{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}` locally (L3: prod has no anon/PUBLIC; spec 198) |

Policy text, md5 of `coalesce(qual,'')||'|'||coalesce(with_check,'')` (unchanged by the fix pass): `Admins can insert invitations` `54fa3c18…`, `Admins can insert profiles in own brand` `5b13ae0e…`, `Admins can update invitations` `5939fcd6…`.

### Item 2: test edits

- `demote_profile_brand_scope.test.sql`, `plan(54)` -> `plan(60)`:
  - **K-9** (S3(a)): comment-stripped RPC body has the step-4 re-read after `for no key update` and before the brand step, and matches none of `auth_is_privileged|auth_is_admin|jwt|app_metadata`.
  - **K-10** (L1): comment-stripped wrapper body starts with the `auth_profile_is_privileged()` check, before the role filter and the advisory lock (lock absence can't be probed after a refused `throws_ok`).
  - **W-1** (L1): seed staff `2222` (profile `user`, stale `admin` claim) calls the wrapper directly for `master` and gets 42501 `forbidden`.
  - **D2b-RU, D4a-RU, D4b-RU**: post-state checks after the bare `lives_ok` arms.
  - A5c re-asserts S1's claims; K-6 strips comments before its `count\s*\(` check; K-7 also requires `auth_is_privileged` and `jwt_expiry`.
- `profiles_insert_hardening.test.sql`, `plan(79)` -> `plan(80)`: **E-2-pre** asserts the section D invitation `d1-164@local.test` exists before E-2.

### Item 3: re-verify (actual output)

- `bash scripts/test-db.sh` on the five named files: `demote_profile_brand_scope` 60/60, `profiles_insert_hardening` 80/80, `demote_self_guard` 6/6 (unmodified), `delete_last_privileged_guard` 4/4, `invitations_super_admin_rls` 4/4. "5/5 DB test file(s) passed".
- `npm run test:db`: "104/104 DB test file(s) passed" (one more file than the review runs; other sessions' work is on disk).
- `npx jest`: Test Suites 301 passed / 301; Tests 3836 passed / 3836; Snapshots 17 passed.
- `npm run typecheck:test`: exit 0. `npx tsc --noEmit --types node,jest`: exit 0. `npm run typecheck` not run (known local red, empty `node_modules/@types/* 2` folders).
- **Mutations**, each `begin; <mutant create or replace built from the file's own text>; <demote_profile_brand_scope.test.sql>` (the test file's final `rollback` discards the mutant; never visible to other sessions). Live md5s re-checked afterwards: all four MATCH the file.

| Mutation | Result |
|---|---|
| Wrapper privilege check removed | **red**: K-10, W-1, L-scope (3 of 60) |
| Wrapper privilege check moved after the advisory lock | **red**: K-10 (1 of 60) |
| **Step-4 re-read removed** | **red: K-9** (1 of 60). Before the fix pass this mutant passed 54/54 |
| Step-4 re-read replaced by `auth_is_privileged()` | **red**: K-9, A2d (2 of 60) |
| Step 7 put back to `in ('admin', 'master')` | **green, 60/60**, as expected: behaviour is identical while step 4 holds. Recorded, not a gap |

### Item 4: rollback SQL

- New file `specs/191-demote-profile-brand-scope/rollback.sql`: one transaction with `set local lock_timeout = '5s'`, in the design order (policies + spec 164 DO blocks; trigger function; RPC + grants, with `comment on function … is null` because it had no comment before 191; then drop the wrapper and the helper). Header: version-row rule, the X2 dependency note with a `pg_depend` check (today it returns only the three step 1 policies), the do-not-retype rule and the source line ranges.
- **The pre-191 bodies were copied with `sed` by line range, not retyped:** `20261007000000` L54-66, L68-83, L276-322, L324-353; `20260517050000` L196-248; `20260520000000` L55-132, L141-142. A byte comparison confirmed each range appears in `rollback.sql` byte-identical. The file keeps 12 non-ASCII lines on purpose (em dash, arrow, section sign).
- **Dry run** (local psql; the file with its single `commit;` line swapped for the checks plus `rollback;`). Every statement ran under `ON_ERROR_STOP`; then, inside the transaction:

| Check | Result | Baseline |
|---|---|---|
| `assert_brand_id_immutable_for_self` normalized md5 | `c7318dd854a9a63bc2a7adb7cab3b4f3` | `c7318dd8…` (H1) |
| `demote_profile_to_user` normalized md5 | `f77056fbf50ff1478a156ecd8b508f6b` | `f77056fb…` |
| `assert_not_last_of_role` normalized md5 | `0638c51b89305a6c109a146f2feb7f9a` | `0638c51b…` |
| trigger body contains em dash, arrow, section sign | true | |
| spec 164 counts (profiles INSERT/ALL, invitations INSERT/ALL, invitations UPDATE/ALL) | 1/1/1 | 1/1/1 |
| both new functions gone | true | |
| the three policies use `auth_is_privileged()` and not the helper | 3 | 3 |
| policy comments: profiles = spec 164's text; both invitations policies none | true/true/true | |
| RPC comment removed; trigger comment = spec 042's | true; true | |
| RPC posture | `t {"search_path=public, auth"} postgres {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}`; anon EXECUTE false | |

  After `ROLLBACK`, the live functions again MATCH the 191 file.
- **MCP channel:** not run. The MCP `execute_sql` connection is prod, and this task allows no prod change, not even a rolled-back one. So, as the proposal allows, the post-rollback md5 check in the header is the proof that the non-ASCII bytes survived that channel.

### Item 5: spec text

§6.5 P1 is now P1a (layer 1, no mutation step) and P1b (the developer's P1′, layer 2, where the mutation step runs). §1.2 and §11 no longer say K-6 pins the coupling. §0, §1.4 and §6.3 say "logic and message strings identical" instead of byte-identical. §1.2 shows the wrapper's step 0. §1.3 shows the fail-closed step 7 and notes that (d) now holds on every path. §6.1 lists the new arms and `plan(60)`. §10 points at `rollback.sql`. B4 evidence: the developer's P1′/P2/P3 (above) plus the security-auditor's independent races **R1-R7** in its own throwaway clone `sec191probe` (RPC against PATCH in both orders, third-party and same-role). All ended with at least 1 super_admin and at least 1 master; S2 waited on `Lock/transactionid` for mutual demotions and `Lock/advisory` for third-party ones. Neither 1b nor 1c changes lock order, so the probes were not repeated.

**F3 and E2: waived with a record** (owner, 2026-11-09). F3: the test-engineer's minted-JWT request got HTTP 403 `{"code":"42501",...,"message":"forbidden"}` from `/rest/v1/rpc/demote_profile_to_user`; the Arm 7b script itself has still not run (it needs the shared `admin@local.test`), and it got `bash -n` plus a rolled-back check of its cleanup SQL. E2: pgTAP B1b plus the traced UI path (`useStore.ts:2064`, `db.ts:5564`). **C4** runs later in CI on a pushed non-`main` test branch.

### Item 6: smoke script

`scripts/smoke-edge-roles.sh` Arm 7b: `XB_CLEANUP_SQL` is defined once next to `XB_BRAND` / `XB_TARGET` and used for the pre-clean, the post-arm cleanup and the EXIT trap; the header recovery note points at it rather than repeating the SQL. If the caller snapshot comes back empty/fails, or the role swap fails, the arm now fails **without sending the request**. The `&& pass || fail` lines are `if` blocks. `bash -n` passes. Not run (instruction).

### Still open after the fix pass

- C4 (`e2e/invite.spec.ts`) on a CI test branch (owner go-ahead for the branch push).
- H1/H2/H3 prod rollout and F4. H2 should use the md5 references in the table above.
- The one-time Arm 7b run in a quiet window, if the owner wants it beyond the waiver.

## Files changed

**Migrations**
- `supabase/migrations/20261109191000_demote_profile_brand_scope.sql` (new; edited in place by the fix pass; applied locally, version row inserted locally only; the fix pass re-applied only the changed statements)

**pgTAP**
- `supabase/tests/demote_profile_brand_scope.test.sql` (new, `plan(60)` after the fix pass)
- `supabase/tests/profiles_insert_hardening.test.sql` (K-2 updated; K-16, K-17, K-18, section E-1..E-3 and E-2-pre added; orphan `e1910000-...-0001` added; `plan(73)` -> `plan(80)`; header arm map)
- `supabase/tests/demote_self_guard.test.sql`: unmodified, passes 6/6

**Shell smoke**
- `scripts/smoke-edge-roles.sh` (new Arm 7b, with header recovery note and EXIT-trap cleanup; fix pass: single `XB_CLEANUP_SQL`, fail-early guard, `if` blocks; not run)

**Spec**
- `specs/191-demote-profile-brand-scope.md` (Status, owner decisions, design amendments, these notes)
- `specs/191-demote-profile-brand-scope/rollback.sql` (new; dry-run locally)
- `specs/191-demote-profile-brand-scope/reviews/` (the five review files, written by the reviewers; not edited by the developer)

**Not changed:** `src/lib/db.ts`, `src/store/useStore.ts`, `BrandsSection.tsx`, edge functions, `supabase/config.toml`, CLAUDE.md, README.md, `app.json`.

### Gate results (local, after the fix pass)

- `demote_profile_brand_scope` 60/60, `profiles_insert_hardening` 80/80, `demote_self_guard` 6/6, `delete_last_privileged_guard` 4/4, `invitations_super_admin_rls` 4/4.
- `npm run test:db`: 104/104 files passed.
- `npx jest`: 301 suites / 3836 tests passed.
- `npm run typecheck:test`: exit 0. `npx tsc --noEmit --types node,jest`: exit 0.
- `npm run typecheck` not run (known red: empty `node_modules/@types/* 2` folders).
