# Spec 195: Remove `user_stores` own-row writes (closes 164-H1, the cross-brand step of 187-H2)

> Renumbered from 190 to 195 on 2026-11-09: another session took 190 for `po-number-sequence`. Anything still saying "spec 190" about `user_stores` means this spec.

Status: READY_FOR_REVIEW

> The owner answered the one open question on 2026-11-09: staff never assign themselves stores. Drop the own-row write policy and keep the own-row read policy. See "Decision". Read-only prod pre-checks from the same day are in [specs/195-user-stores-own-row-writes/reviews/prod-prechecks.md](195-user-stores-own-row-writes/reviews/prod-prechecks.md).

## User story
As the owner of a multi-brand restaurant group, I want only admins (through the existing brand-scoped admin policy, the registration RPC, or the service-role edge functions) to be able to create, change or remove a user's store links. Then a staff account, or an admin who has just been demoted, can't link itself to another brand's store and read or write that brand's data.

## Background: the problem
- `public.user_stores` has a permissive `FOR ALL` policy, `"Users can manage own store links"`, with `using (user_id = auth.uid()) with check (user_id = auth.uid())` ([20260520010000_legacy_permissive_policy_dropout.sql:104-110](../supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql)). Any profile can INSERT, UPDATE or DELETE its own link rows.
- The `user_stores_brand_match_trg` trigger doesn't stop a NULL-brand profile (details below). A NULL-brand profile can therefore link itself to any store in any brand. Once linked, the `user_stores` arm of `auth_can_see_store()` gives it read and write access to that store's data.
- NULL-brand, non-privileged profiles come from two places:
  1. **Store-less staff invites.** `register_invited_profile()` writes `brand_id = NULL` when the invitation has no brand and no stores.
  2. **`demote_profile_to_user`.** It sets `role='user', brand_id=NULL` ([20260520000000_demote_profile_to_user_rpc.sql:114-115](../supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql)).
- **164-H1** ([specs/164-profiles-insert-hardening/reviews/security-auditor.md](164-profiles-insert-hardening/reviews/security-auditor.md)) confirmed this live for a store-less staff invitee.
- **187-H2** ([specs/187-order-approval-approver-snapshot/reviews/security-auditor.md](187-order-approval-approver-snapshot/reviews/security-auditor.md)) used it as the cross-brand step:
  1. Demote a target.
  2. Keep using the target's still-live admin JWT.
  3. Self-link to another brand's store, unlinking first if needed.
  4. Read approver emails and `User deleted` rows there, and write approvals there.
- The spec 187 release proposal calls this "separate spec A" ([release-proposal.md](187-order-approval-approver-snapshot/reviews/release-proposal.md), "Out of scope for this review").
- **Prod, 2026-11-09** ([prod-prechecks.md](195-user-stores-own-row-writes/reviews/prod-prechecks.md)):
  - Two live brands (`2AM PROJECT`, `Baltimore Seafood`), so the hole is cross-tenant, not just store-to-store.
  - No NULL-brand non-super_admin profile holds a store, no branded user is linked across brands, and no evidence of a past self-link was found.

## What the code shows

### Current `user_stores` policies (all commands)
Repo and local state. Prod matched this on 2026-11-09 (P-1 in [prod-prechecks.md](195-user-stores-own-row-writes/reviews/prod-prechecks.md)).

| Policy | Cmd | Roles | Predicate | Defined in |
|---|---|---|---|---|
| `Users can read own store links` | SELECT | public | `using (user_id = auth.uid())` | [20260502071736_remote_schema.sql:489-494](../supabase/migrations/20260502071736_remote_schema.sql). Never redefined. |
| `Users can manage own store links` | ALL | public | `using (user_id = auth.uid()) with check (user_id = auth.uid())` | [20260520010000_legacy_permissive_policy_dropout.sql:104-110](../supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql). It replaced the remote_schema version, which had the wide `OR auth.uid() IS NOT NULL` tail. |
| `Admins can manage all store links` | ALL | public | `auth_is_privileged() and exists (store s where s.id = user_stores.store_id and auth_can_see_brand(s.brand_id))`, in both USING and WITH CHECK | same migration, :115-137 |

- All three are permissive. There are no RESTRICTIVE policies.
- The own-row SELECT predicate is the same in the read policy and the ALL policy. Dropping the ALL policy therefore changes **no read**.

### Triggers on `user_stores`
There is exactly one non-internal trigger: `user_stores_brand_match_trg`, `BEFORE INSERT OR UPDATE ... FOR EACH ROW`. It runs `public.user_stores_brand_match()`, which is SECURITY DEFINER, from [20260528010000_user_stores_brand_match_null_brand_guard.sql:69-128](../supabase/migrations/20260528010000_user_stores_brand_match_null_brand_guard.sql). It has no DELETE trigger. Separately, the FKs cascade from `profiles` and from `stores`. Prod matched on 2026-11-09 (P-2).

### Why the brand-match trigger does not stop a NULL-brand profile
- **Non-NULL-brand profile:** the store's brand must equal the profile's brand (:113-116). A branded staff user can only self-link within their own brand, so for them the spec 164 L159 note is correct.
- **NULL-brand profile:** the trigger refuses a row only if the user **already** holds a link in a different brand (:83-110). Three consequences:
  - **First link passes.** A NULL-brand profile with no links can link itself to any store in any brand. The comment at :89 says "The first grant has nothing to conflict with and so passes". That is the 164-H1 probe.
  - **Unlink-then-relink passes.** The own-row ALL policy also allows DELETE. A NULL-brand profile that already has links (for example a demoted admin who keeps their old brand-A links) can delete them all, which has no DELETE trigger, then make a "first" link in brand B. That is the 187-H2 probe ("unlinking and relinking moved them to another brand's store").
  - **UPDATE is blocked in practice.** A single-row `UPDATE ... SET store_id = <foreign>` conflicts with its own pre-update row, because the lookup excludes by the *new* store_id. The trigger is not what closes the hole, though; the DELETE+INSERT route stays open.
- **Conclusion:** the trigger only limits a NULL-brand profile to one brand at a time. It doesn't pin which brand. The policy is the gap.

### Why the admin arm doesn't re-open the hole once the own-row arm is gone
- `auth_can_see_brand(b)` is `auth_is_super_admin() or exists(profiles where id = auth.uid() and brand_id = b)` ([20260509000000_multi_brand_schema_rls.sql:200-209](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql)). Both halves read `profiles`, not the JWT.
- A NULL-brand `role='user'` profile fails both halves for every brand, even with a stale `admin` claim that makes `auth_is_privileged()` true.
- So after this spec, the 187-H2 caller has no write path into `user_stores`. 187-H2's own table confirms the same reasoning applies to `get_profile_emails` ("a NULL brand fails `auth_can_see_brand`").

### Every writer of `user_stores`

| Writer | Where | Runs as | Uses the own-row arm? |
|---|---|---|---|
| `register_invited_profile()` | [20261007000000_profiles_insert_hardening.sql:233](../supabase/migrations/20261007000000_profiles_insert_hardening.sql) | SECURITY DEFINER, owner `postgres` (bypasses RLS; the trigger still fires) | No |
| `consume_invitation()` | [20260531000000_consume_invitation_sets_profile_id.sql:76-98](../supabase/migrations/20260531000000_consume_invitation_sets_profile_id.sql) | — | Doesn't write `user_stores` (only `invitations`) |
| `stock_store_from_store()` | [20261105000000_stock_store_from_store.sql](../supabase/migrations/20261105000000_stock_store_from_store.sql) | — | Doesn't write `user_stores` (comment mention only) |
| Any other function in `supabase/migrations/` | — | — | None. A repo-wide search for `insert into / update / delete from [public.]user_stores` finds only `register_invited_profile` |
| `manage-store-user` edge fn (create + compensation) | [supabase/functions/manage-store-user/index.ts:359, 449-450, 206](../supabase/functions/manage-store-user/index.ts) | service-role client (bypasses RLS) | No |
| `delete-user` edge fn | [supabase/functions/delete-user/index.ts:430, 507](../supabase/functions/delete-user/index.ts) | service-role client | No |
| `eod-reminder-cron`, `weekly-reminder-cron` | read only | service role | No |
| `src/lib/db.ts:191` `deleteStore` (DELETE by `store_id`) | [src/lib/db.ts:182-194](../src/lib/db.ts) | the caller's JWT | Not for an admin, who is covered by the admin arm. **It has no caller in `src/`.** |
| `src/lib/auth.ts:210, 600`; `src/lib/db.ts:5707`; `src/lib/authGate.ts:73` | — | caller JWT | SELECT only |
| `src/screens/staff/**` (staff subtree) | — | caller JWT | No `user_stores` access except types and comments. `StorePicker` chooses among existing links and writes nothing |
| `e2e/staff-reorder.spec.ts:162` (upsert), `e2e/global-teardown.ts:183` (delete) | — | `serviceRoleClient()` | No |
| `scripts/smoke-*.sh` (`smoke-delete-user`, `smoke-store-user`, `smoke-multi-brand`, `smoke-edge-roles`) | — | `psql -U postgres` | No |
| `supabase/seed.sql` | — | postgres | No |

**Result: nothing in this repo writes `user_stores` as the owning user under RLS.**

### pgTAP files that depend on the own-row write arm
- 23 files in `supabase/tests/` mention `user_stores`. Five of them write the table:

| File | Write | Role at the write | Depends on own-row arm? |
|---|---|---|---|
| `legacy_permissive_policy_dropout.test.sql` | arm (9), L472-499: seed manager self-INSERT, expects success | `authenticated`, JWT `user` | **Yes. This is the only dependency.** It flips to 42501 |
| `legacy_permissive_policy_dropout.test.sql` | arms (8), (10), (11) | `authenticated` | No. Same outcome; only the comments that name the own-row arm need rewording |
| `user_stores_brand_match_null_brand.test.sql` | arms (1)-(6) | postgres (by design: it isolates the trigger) | No |
| `order_approvals_approver_snapshot.test.sql:114` (spec 187, uncommitted) | fixture | postgres | No |
| `stock_store_from_store.test.sql:272-275` | fixture | postgres | No |
| `retention_prune_job.test.sql:140` (spec 186, uncommitted) | fixture | postgres | No |
| `retention_prune_job.test.sql:592` (A19-5, expects `ok:0`) | DELETE by store_id | `authenticated`, JWT admin `1111…` | No. Admin arm, and 0 rows either way |

- No test asserts on the `"Users can manage own store links"` policy by name.
- `permissive_policy_lint.test.sql:56-57` mentions it only in a comment about the old OR-tail shape.

### Spec 164's note at L159
[specs/164-profiles-insert-hardening.md:159](164-profiles-insert-hardening.md) says: "An existing staff user can still self-grant other stores within their own brand. This is pre-existing horizontal access, not a role escalation." Two parts of this are wrong:
- **"Within their own brand"** holds only for branded staff. A NULL-brand profile can self-grant across brands, through the first-link and unlink-then-relink routes above.
- **"Horizontal access"** understates it. Prod has two live brands (P-3), so the access is cross-tenant.

## Acceptance criteria

### Policy shape
- [ ] **AC-1:** After the migration, `pg_policies where schemaname='public' and tablename='user_stores'` returns exactly two rows:
  - `Users can read own store links`: PERMISSIVE, `SELECT`, `qual = (user_id = auth.uid())`. Unchanged.
  - `Admins can manage all store links`: PERMISSIVE, `ALL`. `qual` and `with_check` are byte-identical to the pre-migration text.
  - No row named `Users can manage own store links` remains.
- [ ] **AC-2, fail-closed migration:** after the drop, the migration contains a DO block that raises with a `195:`-prefixed message, so the whole apply aborts with nothing changed, unless both of these hold:
  - exactly one permissive policy on `public.user_stores` has `cmd in ('INSERT','UPDATE','DELETE','ALL')`, and it is `Admins can manage all store links`
  - exactly one permissive policy has `cmd = 'SELECT'`, and it is `Users can read own store links`

  A pgTAP arm checks the same post-state.

  As built (post-review, 2026-11-09): the read-policy comment runs after the DO block, so a missing read policy also raises the `195:` R message (`found 0 () qual <null>`). The DO block itself can't run in pgTAP or CI; the evidence is the developer's FC0-FC4 transcripts (see "Post-review fixes") plus the security auditor's own fail-closed probe. T4 pins the post-state.
- [ ] **AC-3:** The migration is re-runnable (`drop policy if exists`). It doesn't change `user_stores_brand_match()`, `user_stores_brand_match_trg`, any function, any grant, or the `supabase_realtime` publication.

  Evidence: file review (the body is only the drop, the DO block and the comment) plus the developer's double `psql -f` run. T25-T27 pin the grant, trigger and publication post-state; they guard against later migrations rather than this one.

### Refusals (the hole is closed)
For every arm, the caller is simulated as PostgREST presents it (`set local role authenticated` plus `request.jwt.claims`), and verification reads run as postgres.
- [ ] **AC-4, store-less staff invitee:** a profile with `role='user'`, `brand_id=NULL`, no links, and JWT `app_metadata.role='user'` runs `insert into user_stores (user_id, store_id) values (auth.uid(), <brand-B store>)`. It raises `42501` with `new row violates row-level security policy for table "user_stores"`, and 0 rows exist afterwards.
- [ ] **AC-5, demoted admin with a stale claim (187-H2):** a profile with `role='user'` and `brand_id=NULL`, holding brand-A links from before demotion, with JWT `app_metadata.role='admin'`:
  - (a) INSERT of an own link on a brand-B store raises `42501`.
  - (b) INSERT of an own link on an unlinked brand-A store raises `42501`.
  - (c) `delete from user_stores where user_id = auth.uid()` affects 0 rows, and the brand-A links are all still present.
  - (d) `update user_stores set store_id = <brand-B store> where user_id = auth.uid()` affects 0 rows.
  - (e) After (a)-(d), `auth_can_see_store(<brand-B store>)` is false for this caller.
- [ ] **AC-6, branded staff (the reversed arm 9):** the seed manager (`2222…`, `role='user'`, brand A, JWT `user`) INSERTs an own link on Charles, a brand-A store they have no link for. It raises `42501`. In `legacy_permissive_policy_dropout.test.sql`, arm (9) is rewritten to assert this with `throws_ok(..., '42501', 'new row violates row-level security policy for table "user_stores"', ...)`. `plan(13)` is unchanged, and the file header and the arm (8), (9) and (11) comments no longer describe an own-row write arm.
- [ ] **AC-7:** The seed manager's own-row DELETE affects 0 rows, and their existing links are unchanged.
- [ ] **AC-8:** An upsert by the owning user (`insert ... on conflict (user_id, store_id) do update/nothing`) on a new store raises `42501`.

### No regression
- [ ] **AC-9, own-row read:** the seed manager's `select count(*) from user_stores` under their JWT equals the number of their links as counted by postgres. They see 0 rows belonging to other users.
- [ ] **AC-10, admin arm:**
  - A brand-A admin INSERTs a link for a brand-A user on a brand-A store, which is admitted. DELETEs that link, and 1 row is removed.
  - The existing arms (10) and (11) of `legacy_permissive_policy_dropout.test.sql` still pass unchanged: same-brand admit, and cross-brand `P0001` from the trigger.
- [ ] **AC-11, super_admin:** a super_admin (profile `role='super_admin'`, brand NULL) INSERTs and then DELETEs a link for a branded user on a store in that user's brand. Both are admitted.
- [ ] **AC-12, registration:** `profiles_insert_hardening.test.sql` passes unchanged. Its C-3 arm shows `register_invited_profile()` still writes the registrant's links.
- [ ] **AC-13, staff sign-in gate:** `src/lib/authGate.ts` and `src/lib/sessionRestore.ts` need no change, and their jest suites pass unchanged. They read only.
- [ ] **AC-14, full suites green:**
  - pgTAP: `scripts/test-db.sh`, all files
  - `npx jest` (full, not a subset)
  - `npm run typecheck`
  - `npm run typecheck:test`
- [ ] **AC-15, no app or edge change:** the diff touches no file under `src/`, `supabase/functions/`, `e2e/`, or `app.json`. The only changes are the new migration, the pgTAP files named under "In scope", and spec text.

### Spec text
- [ ] **AC-16:** [specs/164-profiles-insert-hardening.md](164-profiles-insert-hardening.md) L159 gets a dated correction appended directly below it. The original line is not rewritten. The correction says:
  - The "within their own brand" claim was wrong for NULL-brand profiles (store-less staff invitees, demoted admins), who could self-link across brands.
  - Spec 195 removed the own-row write arm.

### Rollout (cannot be tested in review)
- [ ] **AC-R1, prod pre-checks:** P-1 to P-6 below are re-run read-only against prod right before the apply, and the results are compared with [prod-prechecks.md](195-user-stores-own-row-writes/reviews/prod-prechecks.md) (the 2026-11-09 baseline). The apply stops and goes back to the owner if any of these is true:
  - P-1 shows a `user_stores` policy set different from the three in the table above
  - P-4 or P-5 returns any row
  - P-6 shows a staff link that is neither in the user's own brand nor explained by an invitation or a `Store user created` audit row, beyond the 3 store-user links already noted in the baseline
  - **P-1's admin policy `md5(qual)` or `md5(with_check)` is not `b05a4d4429e322a9cf194d6072b5f6d3`.** Check this in the pre-check run immediately before the paste: `select md5(qual), md5(with_check) from pg_policies where schemaname='public' and tablename='user_stores' and policyname='Admins can manage all store links';`. This is the owner-accepted substitute for security L1 (no md5 inside the migration's DO block; see "Open questions resolved").
- [ ] **AC-R2, prod apply:** done only with the owner's explicit go-ahead, via MCP `execute_sql` per project memory:
  1. Apply the exact migration body.
  2. Insert its exact version (`20261109195000`) into `supabase_migrations.schema_migrations`.
  3. Re-run P-1 and confirm it matches the AC-1 post-state byte-for-byte against the local reference.
  4. Run `notify pgrst, 'reload schema'` only if a client call misbehaves.
- [ ] **AC-R3, CI gates:** after the owner pushes to `main`, the latest runs on `main` of `test.yml` and `db-migrations-applied.yml` are green, and `e2e.yml` is checked manually per project memory. The migration must be on prod before the push that carries it.

## In scope
- One new migration. It drops `"Users can manage own store links"` on `public.user_stores`, comments the remaining two policies (optional), and adds the AC-2 fail-closed DO block.
- **pgTAP (the "pgTAP DB tests" track, run by `scripts/test-db.sh` and in CI by `test.yml`):**
  - A new file, suggested name `supabase/tests/user_stores_own_row_writes.test.sql`, covering AC-1, AC-2 and AC-4 to AC-11.
  - In `supabase/tests/legacy_permissive_policy_dropout.test.sql`, arm (9) is reversed and the arm (8)/(9)/(11) and header comments are updated (AC-6).
- Re-running the existing files that touch `user_stores` without editing them: `user_stores_brand_match_null_brand`, `profiles_insert_hardening`, `auth_can_see_store_brand_scope`, `staff_brand_id_backfill`, `stock_store_from_store`, `retention_prune_job` (spec 186, uncommitted), `order_approvals_approver_snapshot` (spec 187, uncommitted), plus the rest of the suite.
- The dated correction to spec 164 L159 (AC-16).
- Prod pre-checks, prod apply and the CI-gate check (AC-R1 to AC-R3).

## Out of scope (explicitly)
- **Changing `user_stores_brand_match()`.** This is auditor fix (b) from 164-H1, refusing NULL-brand self-inserts in the trigger. Once the arm is gone, no RLS path lets a non-privileged caller write the table, and the change would also refuse legitimate super_admin self-links (super_admins are NULL-brand). The owner can pull it in as defense in depth.
- **`demote_profile_to_user` brand scope and last-of-role guard (164-H2).** That is "separate spec B" in the spec 187 proposal. It is a different object.
- **Profiles-backed role checks instead of the JWT claim (164-M2).** This includes the admin arm of this table, which still trusts `auth_is_privileged()`. A same-brand demoted admin who *keeps* a brand can still use a stale claim to write links within that brand until the token expires. Paired with spec B.
- **What a demoted admin keeps.** Their existing same-brand links survive demotion. Whether demotion should also remove links belongs to spec B.
- **Stopping store-less staff invites from producing NULL-brand profiles.** After this spec, such a profile can't gain any store except through an admin, so it is harmless. The staff gate signs it out ("no-stores").
- **An in-app way for admins to edit an existing user's store links.** None exists today; links come from invitations, `manage-store-user`, or psql. This spec doesn't add one.
- **Invitation squatting / the anon `get_pending_invitation` oracle (164-M1)** and the `consume_invitation` cleanup.
- **The all-zero placeholder `invitations.profile_id`** written by `src/lib/auth.ts:441`, which is why the original P-6 missed. It is a pre-existing data-quality issue and is only worked around in P-6 here.
- **The 3 prod store-user accounts with no `Store user created` audit row** (likely created before spec 167's audit). That is an owner check, not a code change.
- **187-L3** (an admin removing a target's links before `delete-user` to skip its audit row). This spec closes only the target-removes-own-links half, as a side effect.
- **The lint blind spots (164-M3).**
- **`app.json` slug.** Not touched.

## Open questions resolved
- Q (owner, answered 2026-11-09): Do staff ever assign themselves stores, or remove themselves from one? → A: **No. Drop the own-row write policy and keep the own-row read policy** (the recommended option). See "Decision".
- Q: Is this the admin app or a sibling? → A: This repo. It is a DB policy change and has no surface.
- Q: Cmd UI change? → A: None. No client code writes `user_stores` as the owning user (see "Every writer"), and the staff `StorePicker` only chooses among existing links.
- Q: Per-store or admin-global? → A: Per-store data access is the point. The fix narrows who can write the per-store visibility grants. `auth_can_see_store()` is unchanged.
- Q: Edge function or PostgREST? → A: Neither. It is a migration only. Both edge-function writers use the service role and are unaffected.
- Q: Realtime? → A: None. `user_stores` is not in the `supabase_realtime` publication, and the migration doesn't touch the publication, so the realtime restart ritual doesn't apply.
- Q: Web, native, or both? → A: Both are unaffected and need no rebuild. No client code changes, and no shipped client (web, EAS native, or the folded-in staff app) writes `user_stores` as the owner.
- Q: Which test track? → A: pgTAP DB tests. jest and typechecks are run only as no-regression checks. No shell smoke changes. `smoke-store-user.sh` uses the service role and psql, so it is unaffected; running it is optional.
- Q (owner, answered 2026-11-09): Apply the fix plan in [release-proposal.md](195-user-stores-own-row-writes/reviews/release-proposal.md)? → A: **"Apply all three (Recommended)."** That means:
  1. Correct every stale `20261109160000` to `20261109195000` (D-1, D-7, D-8, D-10, AC-R2).
  2. Make the one pre-prod edit to the migration body: shorter read-policy comment, moved after the DO block; header cleanup; rollback additions. Update D-8 to match.
  3. **Security L1 (md5 check inside the DO block): declined.** It would replay on every fresh build and break the migration chain on a Postgres deparse change, and the body is frozen once prod has it. Instead, AC-R1 now has a text-only stop: P-1's admin md5 must equal `b05a4d4429e322a9cf194d6072b5f6d3` right before the paste.

  The test-engineer's AC-3 and DO-block coverage gaps were accepted with a text note (AC-2, AC-3), and the optional cheap arms were added (T24-T27).

## Decision
**Owner, 2026-11-09: staff never assign themselves stores or remove themselves from one.** The migration drops `"Users can manage own store links"` and keeps `"Users can read own store links"`.

What supported it:
- **In repo:**
  - Nothing in `src/`, the staff subtree included, writes `user_stores` as the owning user.
  - The staff sign-in gate signs out a user with zero links ([src/lib/authGate.ts:86-88](../src/lib/authGate.ts)), and there is no self-onboarding screen.
  - Registration (spec 164) and store-user creation (spec 165) write links server-side.
  - Only pgTAP arm (9) exercised the arm. Spec 051 called it "the legitimate self-onboarding path" but named no caller.
- **On prod:** the 2026-11-09 pre-checks found every staff link inside the user's own brand and no evidence of a past self-link.
- **Not checked:** sibling apps outside this repo (the customer PWA, and any pre-spec-063 `imr-staff` build still installed). If one writes `user_stores` with a user JWT, it will start getting 42501.

Alternatives the owner did not choose, kept for the record:
- **(B)** Allow self-assign only within the user's own non-NULL brand. Closes the cross-brand hole but keeps same-brand self-grants, and needs a UI that doesn't exist.
- **(C)** Allow self-remove only. No UI, and it keeps the target-side half of 187-L3.
- **(D)** Keep the policy and harden only the trigger. Same-brand self-grants remain, and it needs a super_admin carve-out.

## Prod read-only queries (project `ebwnovzzkwhsdxkpyjka`)
- **Baseline:** the main session ran P-1 to P-6 read-only on 2026-11-09, with P-6 classified the email-based way below. Results are in [specs/195-user-stores-own-row-writes/reviews/prod-prechecks.md](195-user-stores-own-row-writes/reviews/prod-prechecks.md).
- **Re-run before the apply:** all of them, per AC-R1.
- Nothing here writes.

- **P-1, policy set:** `select policyname, permissive, cmd, roles, qual, with_check from pg_policies where schemaname='public' and tablename='user_stores' order by policyname;`. Expect the three policies in the table above, with text matching the repo. The 2026-11-09 result matched.
- **P-2, trigger set:** `select tgname, tgenabled, pg_get_triggerdef(oid) from pg_trigger where tgrelid='public.user_stores'::regclass and not tgisinternal;`. Expect only `user_stores_brand_match_trg`, enabled `O`. Optionally also `md5(prosrc)` of `public.user_stores_brand_match` against local. The 2026-11-09 result matched.
- **P-3, live brands:** `select id, name, deleted_at from public.brands order by name;`. 2026-11-09: two live brands.
- **P-4, NULL-brand exposure (from the 164 proposal):** `select p.id, p.name, p.role, (select array_agg(distinct s.brand_id) from public.user_stores us join public.stores s on s.id = us.store_id where us.user_id = p.id) as store_brands from public.profiles p where p.brand_id is null and p.role not in ('super_admin');`. Any row holding stores goes to the owner. 2026-11-09: none.
- **P-5, cross-brand links for branded users (expect 0):** `select us.user_id, us.store_id from public.user_stores us join public.profiles p on p.id = us.user_id join public.stores s on s.id = us.store_id where p.brand_id is not null and s.brand_id <> p.brand_id;`. 2026-11-09: none.
- **P-6, classify every staff link (corrected 2026-11-09).**
  - **Why the original was wrong:** it matched `invitations.profile_id`. The app inserts invitations with the all-zero placeholder `profile_id` (`src/lib/auth.ts:441`), so that match misses almost every link.
  - **The fix:** match invitations by email through `auth.users`, and match `manage-store-user` creations by their `Store user created` audit row. That function writes one row per store, with `detail` holding `target_id` ([supabase/functions/manage-store-user/index.ts:239-253](../supabase/functions/manage-store-user/index.ts)).

  ```sql
  select us.user_id, p.name, p.username, us.store_id,
         s.brand_id = p.brand_id as same_brand,
         exists (
           select 1
             from public.invitations i
             join auth.users u on lower(u.email) = lower(i.email)
            where u.id = us.user_id
              and us.store_id::text = any(i.store_ids)
         ) as by_invitation,
         exists (
           select 1
             from public.audit_log a
            where a.action = 'Store user created'
              and a.store_id = us.store_id
              and (a.detail::jsonb ->> 'target_id') = us.user_id::text
         ) as by_store_user_audit
    from public.user_stores us
    join public.profiles p on p.id = us.user_id
    join public.stores   s on s.id = us.store_id
   where p.role = 'user'
   order by by_invitation, by_store_user_audit, p.name;
  ```

  - **How to read it:** a link with `same_brand = false` is a stop. A link with both flags false and no `username` on the profile is unexplained and goes to the owner. A link with both flags false on a store-user account (has a `username`, no invitation) fits a `manage-store-user` creation from before spec 167's audit. Report it, but it is not by itself a stop.
  - **2026-11-09:**
    - 8 staff links, all same-brand.
    - 1 is explained by an invitation.
    - 4 are explained by `Store user created` audit rows.
    - 3 are store-user accounts with no audit row (ids are in the main session's transcript).
  - `user_stores` has no timestamp or author column, so a past self-link can only be found consistent with absence, never proven absent.

## Dependencies
- Specs 051 (policy shape), 068 (NULL-brand trigger), 164 (server-side registration, which removed the last client self-insert), 165 (service-role store-user creation), and 167 (`Store user created` audit rows, used by P-6).
- Interacts with uncommitted specs 186 and 187. Their pgTAP files touch `user_stores` only through postgres fixtures or the admin arm, so neither needs editing. The new migration's version must sort after `20261108130000` (spec 187), the latest on disk at authoring time.
- Spec B (`demote_profile_to_user` scope plus 164-M2) is a sibling follow-up, not a prerequisite.

## Project-specific notes
- Cmd UI section / legacy: none. DB-only.
- Per-store or admin-global: per-store visibility grants. The admin arm (brand-scoped via `auth_can_see_brand`) becomes the only RLS write path.
- Realtime channels touched: none.
- Migrations needed: yes, one (policy drop plus fail-closed assertion).
- Edge functions touched: none. `manage-store-user` and `delete-user` keep writing with the service role.
- Web/native scope: neither. No client change, no new EAS build.
- Tests: pgTAP DB tests (one new file, plus arm (9) of `legacy_permissive_policy_dropout.test.sql`). No new jest or shell smokes.
- `app.json` slug: not touched.

## Backend design

Architect, 2026-11-09. Built from the repo on disk plus the main session's read-only prod checks. I had no database access, so everything marked **[confirm]** must be checked by the developer before or during the build.

### D-0. Verdict and one AC amendment

The PM's analysis holds, with one exception: **AC-5(a) can't raise 42501 as written.**

- On INSERT, the BEFORE ROW trigger `user_stores_brand_match_trg` runs **before** the RLS WITH CHECK. Arm (11) of `legacy_permissive_policy_dropout.test.sql` already relies on this: an admin's cross-brand INSERT that RLS would also refuse comes back `P0001` from the trigger.
- In AC-5(a), the demoted NULL-brand caller still holds a brand-A link and inserts a brand-B link. The trigger's NULL-brand branch (`20260528010000…:94-107`) finds the brand-A link and raises `P0001` first. RLS is never reached, so the test would see P0001 whether or not this spec ships. As written, the arm proves nothing about the policy.
- **Amended AC-5(a), which the test-engineer should read in place of the original:**
  - **(a1)** While the caller holds a brand-A link, inserting a brand-B link raises `P0001` with the trigger's NULL-brand message. This pins the trigger layer and is unchanged by this spec.
  - **(a2)** After the caller's links are removed (by postgres, which stands in for "the unlink step"), the same caller with the same stale `admin` claim inserts a brand-B link and gets `42501` with the RLS message. This is the actual 187-H2 step that the policy drop closes. It also covers the common case: demoted admins usually hold **no** `user_stores` rows, because admin visibility comes from their brand, so the trigger's first-link pass leaves RLS as the only gate.
- AC-5(b) to (e) stand as written, and so do AC-4 and AC-6 to AC-11. In each of AC-4, AC-5(b), AC-6 and AC-8, the trigger admits the row: a first link, or same brand. RLS is therefore what refuses, and the arm is sensitive to the policy.

### D-1. Data model: migration `supabase/migrations/20261109195000_user_stores_drop_own_row_writes.sql`

- **Version:** built as `20261109195000`. At build time `20261109170000` (spec 194) sorted after the originally proposed `…160000`, spec 193 reserved `…190000` and spec 191 `…191000`. See Implementation notes. The `…160000` slot was never used: no file, local `schema_migrations` row or prod row carries it, so don't treat it as reserved. (Corrected 2026-11-09 per release proposal step 1.)
- **Shape:** policy DDL only. Destructive only in the sense that it removes a grant path. It is additive-safe to roll out: no table, column, function, trigger, grant or publication change. Re-runnable.
- **Body, in order, inside `begin; … commit;` (the house style from spec 164/170/187):**
  1. `set local lock_timeout = '5s';`. `DROP POLICY` takes an AccessExclusiveLock on `user_stores`, and every store-scoped RLS check reads `user_stores` through `auth_can_see_store()`. If a long transaction holds the table, the apply should fail fast instead of queueing every store read behind it. A timeout is a clean abort with nothing changed; retry it.
  2. `drop policy if exists "Users can manage own store links" on public.user_stores;`
  3. `comment on policy "Users can read own store links" on public.user_stores is 'spec 195: own-row READ only; no own-row write policy by design.'` This is the optional comment from In scope, decided **yes**: the policy has no comment today, and this is where a future reader of `pg_description` looks. Leave the admin policy's spec 051 comment alone; it is still accurate.
     - **As built (post-review, 2026-11-09):** this statement runs **after** step 4's `end $$;`, so a missing read policy raises the `195:` R message instead of failing at the COMMENT. The text was shortened to the durable fact; the writer inventory stays in the dated migration header, where it can't go stale in `pg_description`.
  4. **Fail-closed DO block** (AC-2). It reads `pg_policies` for `schemaname='public' and tablename='user_stores'` and raises with a `195:` prefix on any mismatch:
     - **W:** count and `string_agg(policyname)` of rows with `permissive='PERMISSIVE' and cmd in ('INSERT','UPDATE','DELETE','ALL')`. Must be exactly 1, named `Admins can manage all store links`. Message: `'195: expected exactly one permissive write policy on public.user_stores (Admins can manage all store links), found % (%)'`.
     - **R:** the same for `cmd='SELECT'`. Must be exactly 1, named `Users can read own store links`, with `qual = '(user_id = auth.uid())'`. That is the PG17 deparse of the `remote_schema.sql:494` text, and prod P-1 matched it.
     - **A:** the admin policy's `qual` and `with_check` are both non-NULL and both contain `auth_can_see_brand`. This stops the apply if dashboard drift ever replaced the brand-scoped admin arm with a wider one. The drop doesn't cause that, but this migration makes the admin arm the only write path, so the migration should refuse to land on top of a weakened one.
     - Don't check RESTRICTIVE policies. They can only narrow access, and none exist.
     - Because the block runs inside the same transaction after the drop, `raise exception` rolls the drop back too. "The whole apply aborts with nothing changed" therefore holds literally.
- **Header must record:** the policy diff; the D-0 trigger-before-RLS note; "no realtime publication change, no `docker restart supabase_realtime_imr-inventory`"; "no grant change, so authenticated keeps INSERT/UPDATE/DELETE on `user_stores`, which the admin arm needs"; the prod-apply and rollback steps from D-8; and "no PostgREST schema reload needed, because RLS is evaluated per query".

**Exact policy diff (post-state):**

| Policy | Before | After |
|---|---|---|
| `Users can read own store links` (PERMISSIVE, SELECT, `{public}`, `(user_id = auth.uid())`) | present | present, unchanged predicate, new comment |
| `Users can manage own store links` (PERMISSIVE, ALL, `{public}`, using/check `(user_id = auth.uid())`) | present | **dropped** |
| `Admins can manage all store links` (PERMISSIVE, ALL, `{public}`, `auth_is_privileged() AND EXISTS(stores … auth_can_see_brand(s.brand_id))` in both) | present | present, untouched |

### D-2. RLS impact, confirmed from the function bodies

- **Reads don't change.** For SELECT, Postgres ORs every permissive policy whose cmd is SELECT or ALL. Before the drop that was `read OR own-row-ALL OR admin`, where `read` and `own-row-ALL` have the identical USING `(user_id = auth.uid())`. After the drop it is `read OR admin`. `X OR X OR Y = X OR Y`, so no row's visibility changes for any caller. The same holds for the implicit SELECT check that UPDATE/DELETE apply to rows named in WHERE or RETURNING. **Pinned by** new-file arms T18 and T19 (D-5).
- **Writes:** the only RLS write path left is `Admins can manage all store links`. The SECURITY DEFINER `register_invited_profile()` and the service-role edge functions don't go through RLS at all (see the P-7 caveat in D-8).
- **Demoted NULL-brand admin with a stale `admin` claim.** Confirmed from the bodies:
  - `auth_is_admin()` reads the JWT only: `app_metadata.role ∈ {admin, master}` (`20260504073942…:23-27`, never redefined). So `auth_is_privileged()` = `auth_is_admin() OR auth_is_super_admin()` is **true** for this caller (`20260509000000…:235-239`).
  - `auth_can_see_brand(b)` is `auth_is_super_admin() OR exists(profiles where id = auth.uid() and brand_id = b)` (`20260509000000…:200-210`). `auth_is_super_admin()` reads `profiles.role = 'super_admin'` (`:187-195`). With `role='user'` and `brand_id IS NULL`, both halves are false for every `b`, because `NULL = b` is never true.
  - So the admin arm's `EXISTS (… auth_can_see_brand(s.brand_id))` is false for every store, in both USING and WITH CHECK, and the caller has **no** RLS write path.
  - `auth_can_see_store()` (latest at `20260517040000…:88-108`) is false for a brand-B store: not super_admin, the admin arm needs `auth_can_see_brand`, and there is no `user_stores` row. It stays **true** for the brand-A stores they still hold. That is out of scope here (spec B / 191).
- **Stale clients (none in `src/`, verified: every `from('user_stores')` in `src/` is a SELECT, except `db.ts:195` `deleteStore`, which has no caller and is admin-only in practice):**

  | Owning-user write | SQL outcome | PostgREST outcome |
  |---|---|---|
  | INSERT (POST) | `42501`, `new row violates row-level security policy for table "user_stores"` | HTTP 403 with that code and message |
  | Upsert on a **new** row (POST + `Prefer: resolution=…`) | same `42501` | 403 |
  | Upsert where the row **already exists** | Expected `42501` too, because the INSERT WITH CHECK runs before the arbiter check. Not pinned by an AC; optional arm | 403 |
  | UPDATE (PATCH) | silent, 0 rows (no UPDATE/ALL policy admits the row in USING) | 200/204 with an empty body |
  | DELETE | silent, 0 rows | 200/204 with an empty body |

  The INSERT refusal comes from RLS, not from grants. Authenticated still holds INSERT/UPDATE/DELETE on `user_stores` (spec 097, `20260618000000…:147-148`). A grant failure would carry the same SQLSTATE `42501` but the message `permission denied for table user_stores`. **The tests pin the RLS message text** so that a future "fix by REVOKE" (which would also break the admin arm) shows up as a failure.
- **Spec 053 lint (`permissive_policy_lint.test.sql`):** unaffected. Dropping a policy can't add a trivially-wide qual. Neither remaining policy matches the head or OR-tail regex, and the allowlist needs no change. Its comment at :55-57 describes the pre-051 shape historically. Leave it unedited (AC-15).
- **Spec 097 grants:** unaffected. No GRANT or REVOKE, and no new object (default privileges are irrelevant).
- **CLAUDE.md permissive-OR rule:** this removes a permissive policy rather than adding one. The fail-closed block W is the "check `pg_policies` for other permissive policies on the same (table, cmd)" step, made executable.

### D-3. API contract
None. There's no RPC, view or PostgREST surface change. The only observable change is the refusal table in D-2.

### D-4. Edge functions, `src/lib/db.ts`, realtime, frontend store
- **Edge functions:** none changed. `manage-store-user` and `delete-user` write through a service-role client, which bypasses RLS. `verify_jwt` settings are untouched.
- **`src/lib/db.ts`:** no new helper or mapping. Don't touch `deleteStore` (`db.ts:182-194`). It has no caller, and for an admin its `user_stores` DELETE goes through the admin arm.
- **Realtime:** none. `user_stores` is not in `supabase_realtime`, and the publication isn't touched, so the `docker restart supabase_realtime_imr-inventory` step does **not** apply.
- **Frontend store (`src/store/useStore.ts`):** no slice changes, and the optimistic-then-revert path is not involved. No Vercel or EAS rebuild.

### D-5. pgTAP: new file `supabase/tests/user_stores_own_row_writes.test.sql`

**Pattern:** hermetic `begin; … rollback;`. Callers are impersonated with `set local role authenticated` plus `set_config('request.jwt.claims', …, true)`. Verification and fixtures run after `reset role; select set_config('request.jwt.claims','',true);`. This is the same pattern as `legacy_permissive_policy_dropout.test.sql`.

**Counting affected rows:** a data-modifying CTE can't sit inside `is(...)`. Run the write in a `DO` block, `get diagnostics v_n = row_count`, stash the count with `set_config('test.x', v_n::text, true)`, then `is(current_setting('test.x', true), '0', …)`. For any write that a mutation could turn into an exception (T11), wrap it in an inner `begin … exception when others then v_n := -1; end;` so the mutation produces a clean failure instead of aborting the file. That matters because `scripts/test-db.sh` flags "planned N but ran M".

**Fixtures** (ids are suggestions; `195` marks them):

| Name | Id | Profile | Links (inserted as postgres) | JWT `app_metadata.role` |
|---|---|---|---|---|
| seed admin | `1111…` | admin, brand A | seed | `admin` |
| seed manager | `2222…` | user, brand A | seed (Towson and Frederick per seed; **count them as postgres, don't hardcode**) | `user` |
| foreign brand B / store B | `b1000000-…-000000000190` / `b1000001-…-000000000190` | — | — | — |
| invitee | `19000000-0000-0000-0000-000000000001` | user, **NULL** brand | none | `user` |
| demoted | `19000000-0000-0000-0000-000000000002` | user, **NULL** brand | Towson (trigger admits it as a first link) | `admin` (stale) |
| target | `19000000-0000-0000-0000-000000000003` | user, brand A | none | — |
| super | `19000000-0000-0000-0000-000000000004` | **super_admin**, NULL brand | none | `super_admin` |

- Seed Charles (`1ea549bb-…`) is brand A and unlinked for everyone above.
- Insert the synthetic `auth.users` rows with every token column `''` (project memory: NULL tokens break GoTrue). Copy the column list from `legacy_permissive_policy_dropout.test.sql:155-182`.
- Use a **synthetic** super_admin rather than promoting seed master `3333…`. Spec 191 may add guards on `profiles` UPDATE, and an INSERT as postgres keeps this file independent of that.

**Arms, plan(23)** (as built: `plan(27)`; T24-T27 were added after review, see "Post-review fixes"). Each "mutation" is a change that must turn the arm red. The developer should run at least M1, M5 and M6 locally once, by hand-editing a scratch copy of the policy in a rolled-back session, and record the results under `## Files changed`.

| # | AC | Caller | Assertion | Flipped by |
|---|---|---|---|---|
| T1 | AC-1 | postgres | `policies_are('public','user_stores', ARRAY['Admins can manage all store links','Users can read own store links'])` | M1-M6 |
| T2 | AC-1 | postgres | `is(permissive‖'\|'‖cmd‖'\|'‖qual, 'PERMISSIVE\|SELECT\|(user_id = auth.uid())')` for the read policy | M5 |
| T3 | AC-1 | postgres | The admin policy's `permissive`, `cmd`, `qual` and `with_check` equal literals pinned from local `pg_policies`. **[confirm]** Capture them from the local DB **before** applying the migration, paste them verbatim, and reuse the same literal for the D-8 prod comparison. This is how "byte-identical to pre-migration" gets tested. | M6, or any edit to the admin arm |
| T4 | AC-2 | postgres | The same predicate as DO-block checks W and R, as one `is()` over `string_agg(cmd‖':'‖policyname, ',' order by cmd, policyname)` filtered to PERMISSIVE → `'ALL:Admins can manage all store links,SELECT:Users can read own store links'` | M1-M6 |
| T5 | AC-4 | invitee | `throws_ok(insert (auth.uid(), store B), '42501', 'new row violates row-level security policy for table "user_stores"')` | M1, M2 |
| T6 | AC-4 | postgres | invitee link count = 0 | M1, M2 |
| T7 | AC-5(b) | demoted | `throws_ok(insert (auth.uid(), Charles), '42501', <RLS msg>)`. The trigger admits it (same brand as the held Towson link). | M1, M2, M8 |
| T8 | AC-5(a1) | demoted | `throws_ok(insert (auth.uid(), store B), 'P0001', format('cross-brand user_stores assignment rejected: user has no brand and store brands differ (existing brand=%s, new store brand=%s)', brand A, brand B))`. This pins the trigger layer; see D-0. | M7 |
| T9 | AC-5(c) | demoted | DO block `delete … where user_id = auth.uid()`, row_count stash = `'0'` | M1, M3 |
| T10 | AC-5(c) | postgres | demoted still holds exactly the Towson link (count = 1) | M1, M3 |
| T11 | AC-5(d) | demoted | DO block: (d1) `update set store_id = store B where user_id = auth.uid()`, using the exception wrapper; (d2) the no-op `update set store_id = store_id where user_id = auth.uid()`. Stash `n1‖','‖n2` = `'0,0'`. Under M1/M4, d1 hits the trigger's P0001 (→ -1) and d2 updates 1 row. | M1, M4 |
| — | fixture | postgres | `delete from user_stores where user_id = <demoted>` (the "unlink" step, done by postgres) | — |
| T12 | AC-5(a2) | demoted (stale `admin`) | `throws_ok(insert (auth.uid(), store B), '42501', <RLS msg>)`. The trigger admits it as a first link. The admin arm is evaluated with `auth_is_privileged()` true and `auth_can_see_brand(B)` false. | M1, M2, M8 |
| T13 | AC-5(e) | demoted | `is(public.auth_can_see_store(<store B>), false)` | M1, M2 (T12's row would exist) |
| T14 | AC-7 | manager | DO block `delete … where user_id = auth.uid()`, row_count stash = `'0'` | M1, M3 |
| T15 | AC-7 | postgres | manager link count = the count captured before T14 | M1, M3 |
| T16 | AC-8 | manager | `throws_ok(insert (auth.uid(), Charles) on conflict (user_id, store_id) do nothing, '42501', <RLS msg>)` | M1, M2 |
| T17 | AC-8 | manager | `throws_ok(insert (auth.uid(), Charles) on conflict (user_id, store_id) do update set store_id = excluded.store_id, '42501', <RLS msg>)` | M1, M2 |
| T18 | AC-9 | manager | `select count(*) from user_stores` = the pre-captured postgres count of the manager's links | M5 |
| T19 | AC-9 | manager | `count(*) where user_id <> auth.uid()` = 0. The admin arm doesn't leak, because `role='user'` makes it not privileged. | widening the read policy, or an `admin` claim leaking |
| T20 | AC-10 | seed admin | `lives_ok(insert (target, Charles))` | M6 |
| T21 | AC-10 | seed admin | DO block `delete where user_id = target and store_id = Charles`, row_count stash = `'1'` | M6 |
| T22 | AC-11 | super | `lives_ok(insert (target, Charles))` | M6, or `auth_is_super_admin()` regressing |
| T23 | AC-11 | super | DO block delete of the same row, row_count stash = `'1'` | M6 |

**Mutation key:**
- **M1:** re-create `Users can manage own store links` (ALL, own-row).
- **M2:** an own-row INSERT-only policy.
- **M3:** an own-row DELETE-only policy.
- **M4:** an own-row UPDATE-only policy.
- **M5:** the migration drops the read policy instead of, or as well as, the write policy.
- **M6:** the admin policy is dropped or altered.
- **M7:** the trigger is dropped, or reverted to its pre-068 body.
- **M8:** `auth_can_see_brand` or `auth_is_privileged` made to admit a NULL-brand caller with a stale claim (for example, a JWT-brand fallback).

**Fail-closed DO block (AC-2):** pgTAP can't run a migration body, so T4 pins the post-state. Also do this once by hand on the local stack and record it under `## Files changed`:
1. `create policy "x195" on public.user_stores for insert to public with check (true);`
2. Re-run the migration file with `psql -f`. Expect `ERROR: 195: expected exactly one permissive write policy …`, with the transaction rolled back and `x195` still present.
3. Drop `x195`.

Don't `supabase db reset` the shared stack: other sessions have unapplied migrations mid-review. Apply with `psql -f`, or `npx supabase migration up`.

### D-6. pgTAP: edits to `supabase/tests/legacy_permissive_policy_dropout.test.sql`

`plan(13)` stays the same: arm (9) goes from one `is()` to one `throws_ok()`.

- **Arm (9) body, L472-499:** replace the INSERT, the `reset role`, the claim clear and the `is()` with a single:
  `select throws_ok(format($q$insert into public.user_stores (user_id, store_id) values (%L::uuid, %L::uuid)$q$, manager_id, store_charles), '42501', 'new row violates row-level security policy for table "user_stores"', 'arm (9): seed manager INSERT into user_stores for SELF is rejected (spec 195: no own-row write arm)');`
  - The JWT is still the seed manager's from arm (7). Arm (8)'s `throws_ok` doesn't change it.
  - With no reset after it, arm (10)'s existing `set local role authenticated` + admin claims still set the caller correctly.
  - Arms (10) and (11) never depended on the manager→Charles row that the old arm (9) created.
- **Arm (9) comment block:** rewrite it to say that the trigger admits the row (same brand), then RLS WITH CHECK refuses it, because spec 195 dropped `Users can manage own store links` and the manager isn't privileged. Reversed from spec 051's "self-onboarding" admit; no such path exists.
- **Header L35-45:**
  - (8): "own-row policy: user_id != auth.uid()" becomes "no own-row write policy exists (spec 195)".
  - (9): "→ admit … No-regression for the legitimate self-onboarding path" becomes "→ 42501 (spec 195 removed the own-row write arm)".
- **Arm (8) comment, L450-458:** change "Post-051: own-row policy fails (user_id != auth.uid())" to "Post-195: there is no own-row write policy; admin arm fails (not privileged)".
- **Arm (11) comment (i), L549-550:** change "the own-row arm fails (target_a != auth.uid())" to "there is no own-row write arm (spec 195)".
- **Housekeeping, needed for accuracy:**
  - L110-112 (the `v_target_a` comment, "so arm (10) doesn't bump into arm (9)'s INSERT"): arm (9) no longer inserts, so reword it.
  - L503 "(claims cleared)": no longer true after the new arm (9). Drop the parenthetical.
- **Mutation:** M1 or M2 turns arm (9) red.

### D-7. Dependencies and coordination
- **Spec 195 depends on none of 186, 187, 189, 191, or 190 (po-number-sequence).** It touches no object they create or change:
  - 187: `order_approvals`, `profiles`, `audit_log`
  - 186: retention job
  - 191: `profiles`, `invitations`, the demote RPC, one trigger function
  - Its version just has to sort after the files on disk.
- 186's `retention_prune_job.test.sql` (A19-5: admin DELETE, `ok:0`) and 187's `order_approvals_approver_snapshot.test.sql` (postgres fixture) pass unedited. The full-suite run in AC-14 confirms it.
- **Spec 191 interaction:**
  - If 191 makes `auth_is_privileged()` or the admin arms read `profiles` instead of the JWT (164-M2), T7 and T12 still expect `42501`, and still get it for an even stricter reason. Either can ship first.
  - **For 191's architect:** don't build 191 fixtures on owning-user `user_stores` writes. They stop working once 195 is applied locally.
  - If 191 also edits `legacy_permissive_policy_dropout.test.sql`, coordinate `plan()`. As specced, it doesn't.
- **Git and the gate:**
  - The working tree holds other specs' unapplied migrations (186, 187, 189, 190-po-number-sequence). Stage **only** this spec's files: the migration, the two test files, this spec, and the spec 164 correction.
  - `db-migrations-applied.yml` hard-fails on any committed migration that's missing from prod, so the commit carrying `20261109195000` must not also carry an unapplied sibling migration.
  - The gate checks presence, not order, so applying 195 to prod before 186/187/189 is fine.

### D-8. Prod pre-checks, apply, verification, rollback (project `ebwnovzzkwhsdxkpyjka`, MCP `execute_sql`, owner go-ahead required)

**Pre-checks (AC-R1).** Re-run P-1 to P-6 with two changes:

- **P-6, harden the cast.** `audit_log.detail` is `text` (`init_schema.sql:201`). Today's rows are JSON (`manage-store-user/index.ts:245`), but one non-JSON `Store user created` row would make `detail::jsonb` abort the whole query. Replace the audit predicate with:
  `(case when pg_input_is_valid(a.detail, 'jsonb') then a.detail::jsonb ->> 'target_id' end) = us.user_id::text`
  - `pg_input_is_valid` is PG16+, so it's available on prod's PG17.
  - `CASE` guarantees the cast is evaluated only for valid input.
  - Add the companion count `select count(*) from public.audit_log where action = 'Store user created' and not pg_input_is_valid(detail, 'jsonb');` and expect 0. If it's nonzero, report it to the owner. It isn't a stop by itself, but those rows can't classify a link.
- **P-7 (new): confirm that registration doesn't depend on the dropped arm.** `register_invited_profile()` inserts the registrant's own links as SECURITY DEFINER. That works without the own-row policy only if the function's owner bypasses RLS on `user_stores`, either as the table owner without FORCE RLS or through `rolbypassrls`. Run:
  `select c.relowner::regrole, c.relrowsecurity, c.relforcerowsecurity, p.proowner::regrole, p.prosecdef, (select rolbypassrls from pg_roles where rolname = 'postgres') from pg_class c, pg_proc p where c.oid = 'public.user_stores'::regclass and p.oid = 'public.register_invited_profile()'::regprocedure;`
  - Expect `postgres, true, false, postgres, true, <any>`.
  - **Stop** if the function owner ≠ the table owner **and** that owner lacks `rolbypassrls`, or if `relforcerowsecurity` is true. Applying anyway would break staff registration on prod.
  - Run the same query locally too, where AC-12 / C-3 is the functional proof.

**Apply (AC-R2):**
1. Paste the exact migration file body (it includes `begin; … commit;`) into `execute_sql`. A `195:` exception or a lock timeout means nothing changed. Stop and report.
2. `insert into supabase_migrations.schema_migrations (version, name) values ('20261109195000', 'user_stores_drop_own_row_writes');` The version must byte-match the final filename. Don't use `apply_migration`, which mints its own timestamp.
3. Verify:
   - Re-run P-1. Expect exactly two rows, and the admin policy's `qual` and `with_check` byte-equal to the T3 literal.
   - Check the read-policy comment with `select obj_description(p.oid, 'pg_policy') from pg_policy p where p.polrelid = 'public.user_stores'::regclass and p.polname = 'Users can read own store links';`, and expect exactly `spec 195: own-row READ only; no own-row write policy by design.`
   - `select version from supabase_migrations.schema_migrations where version = '20261109195000';` should return 1 row.
4. No `notify pgrst, 'reload schema'` is needed for a policy change. Run it only if a client call misbehaves.
5. Then push (AC-R3) and check `test.yml`, `db-migrations-applied.yml` and, manually, `e2e.yml`.

**Rollback** (emergency only, for example a sibling app outside this repo that turns out to self-write links). It re-opens 164-H1 and the 187-H2 cross-brand step:
1. Via `execute_sql`, re-create the 051 policy verbatim:
   `create policy "Users can manage own store links" on public.user_stores as permissive for all to public using (user_id = auth.uid()) with check (user_id = auth.uid());`
   and restore its 051 comment (`20260520010000…:112-113`). Also clear the spec 195 read-policy comment, which would otherwise still say there is no own-row write policy:
   `comment on policy "Users can read own store links" on public.user_stores is null;`
2. **Leave the `schema_migrations` row in place.** The file stays in the repo, and deleting the row would turn the drift gate red.
3. Follow up with a forward migration in the repo that re-creates the policy and nulls the read-policy comment (so local, CI and prod agree). In the same PR, revert legacy arm (9) **and** retire or invert `supabase/tests/user_stores_own_row_writes.test.sql`: once the own-row policy exists, M1 turns 15 of its 27 arms red. Re-applying 195's file would drop the policy again, which is intended.
4. No down-migration ships (repo convention). Record the rollback SQL in the migration header.

### D-9. Risks and tradeoffs
- **Sibling apps not in this repo** (the customer PWA, or a stale pre-063 `imr-staff` install) writing `user_stores` with a user JWT would start getting 403s. The owner accepted this risk. Nothing in this repo does it.
- **Same-brand stale admin (164-M2).** It still passes the admin arm within its brand until the token expires. That is out of scope here (spec 191).
- **Lock:** the drop is brief, but `lock_timeout` keeps it from stalling store-scoped reads.
- **Performance:** one fewer permissive policy to evaluate on `user_stores` reads and writes. That's negligible: there are 10 rows on prod and the seed is small. No edge-function cold-start impact.
- **Migration ordering:** independent of every pending migration (D-7). The only ordering rule is prod before push.
- **Unprovable past self-links:** prod checks are consistent with none having happened (no timestamp or author column). This spec prevents future ones and doesn't audit the past.

### D-10. Expected `## Files changed`
- `supabase/migrations/20261109195000_user_stores_drop_own_row_writes.sql` (new)
- `supabase/tests/user_stores_own_row_writes.test.sql` (new, plan(23); plan(27) after the post-review T24-T27)
- `supabase/tests/legacy_permissive_policy_dropout.test.sql` (arm (9) and comments, plan(13) unchanged)
- `specs/164-profiles-insert-hardening.md` (AC-16 dated correction appended below L159)
- this spec (`## Files changed`, plus the recorded M1/M5/M6 and fail-closed manual results)
- Nothing under `src/`, `supabase/functions/`, `e2e/`, or `app.json` (AC-15).

## Handoff
next_agent: backend-developer
prompt: Implement against the "## Backend design" section of specs/195-user-stores-own-row-writes.md (D-1 migration, D-5 new pgTAP file, D-6 legacy test edits, AC-16 spec 164 correction). Re-check the migration slot (D-1) and capture the T3 admin-policy literal from local pg_policies before applying. Note the AC-5(a) amendment in D-0. Apply locally with psql -f or migration up, not db reset. Run the full pgTAP suite, npx jest, npm run typecheck and npm run typecheck:test. Do not apply to prod. After implementation, set Status: READY_FOR_REVIEW and list the files changed under ## Files changed, including the manual fail-closed and mutation results.
payload_paths:
  - specs/195-user-stores-own-row-writes.md

## Implementation notes

Backend developer, 2026-11-09. Local only: nothing ran against prod, nothing is committed or staged.

**Migration slot: `20261109195000`** (D-1 originally proposed `20261109160000`). At build time the newest file on disk was `20261109170000_kept_records_delete_hardening.sql` (spec 194), which sorts after `…160000`. Spec 193 provisionally reserves `20261109190000` and spec 191 takes `20261109191000`, so `…190000` (the slot 191's design suggested) was also taken. `20261109195000` sorts after every file on disk and both reservations. The prod `schema_migrations` insert is `values ('20261109195000', 'user_stores_drop_own_row_writes')`. The migration header carries the right version, and D-1, D-7, D-8 and D-10 were corrected to it on 2026-11-09 (release proposal step 1). The `…160000` slot was never used.

**Pre-apply confirmations (local):**
- T3 literal, captured from local `pg_policies` before the apply. `qual` and `with_check` are identical, 139 bytes, md5 `b05a4d4429e322a9cf194d6072b5f6d3` both before and after the apply:
  `(auth_is_privileged() AND (EXISTS ( SELECT 1\n   FROM stores s\n  WHERE ((s.id = user_stores.store_id) AND auth_can_see_brand(s.brand_id)))))` (`\n` is LF; three spaces before `FROM`, two before `WHERE`). The test pins it as an `E''` literal so editor whitespace trimming can't change it. Use the same text and md5 for the D-8 P-1 comparison.
- P-7 locally: `postgres | t | f | postgres | t | t` (table owner, relrowsecurity, relforcerowsecurity, function owner, prosecdef, postgres rolbypassrls). Same as prod.
- Local pre-state matched the spec's three-policy table; only trigger `user_stores_brand_match_trg`, enabled `O`.

**Local apply.** `psql -v ON_ERROR_STOP=1 -f` of the migration, then `insert into supabase_migrations.schema_migrations (version, name) values ('20261109195000', 'user_stores_drop_own_row_writes')`. No reset, no stop, no restart. No publication change, so no realtime restart. A second `psql -f` run is a clean no-op (NOTICE "does not exist, skipping", DO passes, COMMIT): AC-3 re-runnability. Post-state: exactly two policies; the read policy carries the spec 195 comment; the admin policy keeps its spec 051 comment and its md5.

**Design followed as written** (D-1 body order, D-5 arms T1-T23, D-6 edits). Choices the design left open:
- Fixture ids use `195` (`19500000-…-00000000000N`, brand/store `b1000000/b1000001-…-000000000195`), per the renumber.
- T11 is preceded by an idempotent postgres re-seed of the demoted user's Towson link, so T11 doesn't depend on T9's outcome. Without it, M1 deletes the row at T9 and T11 would pass vacuously under M1.
- The migration is pure ASCII.

**One observation, not a change:** because D-1 puts the `comment on policy "Users can read own store links"` before the DO block, a missing read policy aborts the apply at the COMMENT (`policy ... does not exist`) rather than with a `195:` message. It is still fail-closed with nothing changed (FC3 below); only the message prefix differs from AC-2's wording. The DO block's R branch is reached when the read policy exists but is altered or joined by another SELECT policy (FC3b, FC3c). **Resolved post-review:** the comment now runs after the DO block, and FC3 raises the `195:` R message (see "Post-review fixes").

### Fail-closed check (AC-2, D-5), run on the local stack after the apply

Every variant ran inside a single transaction that was rolled back, so no extra or altered policy was ever committed or visible to other sessions. After all runs, `pg_policies` still showed exactly the two expected policies with unchanged md5s.

- **FC1, the D-5 procedure.** `begin; create policy "x195" on public.user_stores for insert to public with check (true);` then the migration file text verbatim, except the final `commit;` replaced by `rollback;` as a safety net in case the check didn't fire, under `ON_ERROR_STOP=1`. Output: `ERROR:  195: expected exactly one permissive write policy on public.user_stores (Admins can manage all store links), found 2 (Admins can manage all store links, x195)`, psql exit 3. The file's `begin;` printed "there is already a transaction in progress" because it was nested.
- **FC2, the drop rolls back.** In one transaction: re-create `Users can manage own store links` (the pre-state), create `x195`, `savepoint pre`, run the migration body, which raised the same `195:` W error; `rollback to savepoint pre`. The policy list afterwards was `Admins can manage all store links | Users can manage own store links | Users can read own store links | x195`. The drop was undone by the raise, and `x195` was still present. Then a full rollback.
- **FC3, read policy dropped:** aborts at the COMMENT, `ERROR: policy "Users can read own store links" for table "user_stores" does not exist`. See the observation above.
- **FC3b, read policy widened to `using (true)`:** `ERROR: 195: expected exactly one permissive SELECT policy on public.user_stores (Users can read own store links, qual (user_id = auth.uid())), found 1 (Users can read own store links) qual true`.
- **FC3c, an extra permissive SELECT policy `x195r`:** the same R error, `found 2 (Users can read own store links, x195r)`.
- **FC4, admin arm widened to `auth_is_privileged()` only:** `ERROR: 195: "Admins can manage all store links" on public.user_stores is not brand-scoped (qual auth_is_privileged(), with_check auth_is_privileged())`.

### Mutation results (D-5)

Each mutation ran as `begin; set local lock_timeout='5s'; <mutation DDL>;` followed by the unedited test file, whose own `begin;` nests as a no-op and whose final `rollback;` rolls the mutation back too. Nothing was committed. Policies and the trigger were confirmed intact afterwards.

| Mutation | DDL | `user_stores_own_row_writes.test.sql` red arms | `legacy_permissive_policy_dropout.test.sql` |
|---|---|---|---|
| **M1** | re-create `Users can manage own store links` (ALL, own-row) | 15 of 23: T1, T4, T5, T6, T7, T9, T10, T11, T12, T13, T14, T15, T16, T17, T18 | arm (9) red, 1 of 13 |
| M2 | own-row INSERT-only policy | 10 of 23: T1, T4, T5, T6, T7, T12, T13, T16, T17, T18 | arm (9) red, 1 of 13 |
| M3 | own-row DELETE-only policy | 7 of 23: T1, T4, T9, T10, T14, T15, T18 | not run |
| M4 | own-row UPDATE-only policy | 3 of 23: T1, T4, T11 | not run |
| **M5** | drop `Users can read own store links` | 4 of 23: T1, T2, T4, T18 | not run |
| **M6** | drop `Admins can manage all store links` | 7 of 23: T1, T3, T4, T20, T21, T22, T23 | not run |
| M6b | alter the admin arm to `auth_is_privileged()` only (brand check removed) | 7 of 23: T3, T7, T9, T10, T11, T12, T13 | not run |
| M7 | drop `user_stores_brand_match_trg` | 1 of 23: T8 | not run |

M8 (`auth_can_see_brand` / `auth_is_privileged` widened) was not run. T18 also goes red under M1/M2/M3 because those mutations let an earlier arm change the manager's link count. That cascade is expected.

### Verification (actual output)

- `bash scripts/test-db.sh supabase/tests/user_stores_own_row_writes.test.sql`: PASS, 23 assertions (`ok 1` … `ok 23`).
- `bash scripts/test-db.sh supabase/tests/legacy_permissive_policy_dropout.test.sql`: PASS, 13 assertions; arm (9) is now `ok 9 - arm (9): seed manager INSERT into user_stores for SELF is rejected (spec 195: no own-row write arm)`.
- `npm run test:db`: `✓ 101/101 DB test file(s) passed`. That includes, unedited: `user_stores_brand_match_null_brand` (7), `profiles_insert_hardening` (73, AC-12 / C-3), `auth_can_see_store_brand_scope` (14), `staff_brand_id_backfill` (14), `stock_store_from_store` (196), `retention_prune_job` (70), `order_approvals_approver_snapshot` (68) and `permissive_policy_lint` (5).
- `npx jest`: `Test Suites: 301 passed, 301 total`, `Tests: 3835 passed, 3835 total`, `Snapshots: 17 passed`. That includes `src/lib/sessionRestore.test.ts` (AC-13). `src/lib/authGate.ts` has no dedicated jest suite on disk.
- `npm run typecheck:test`: exit 0.
- `npx tsc --noEmit --types node,jest`: exit 0.
- `npm run typecheck`: red, as already known. All 24 errors are `TS2688 Cannot find type definition file for '<pkg> 2'` from the empty `node_modules/@types/* 2` folders, and there are no other errors. It is not caused by this spec (AC-14 is met by the `--types node,jest` run).

**e2e and registration (read check).** Nothing in `e2e/` writes `user_stores` as an owning user. The only writes are `e2e/staff-reorder.spec.ts:162` (upsert) and `e2e/global-teardown.ts:183` (delete by `store_id`). Both use `admin = serviceRoleClient()` (`staff-reorder.spec.ts:86`, `global-teardown.ts:55`), which bypasses RLS. Every other `e2e/` mention is a comment or constant. Invite and add-user flows reach `user_stores` only through `register_invited_profile()` (SECURITY DEFINER, P-7 confirmed) or the service-role `manage-store-user` function. e2e was not run.

## Post-review fixes (2026-11-09)

Backend developer, applying [release-proposal.md](195-user-stores-own-row-writes/reviews/release-proposal.md) steps 1-5 after the owner's "Apply all three (Recommended)". Local only: nothing ran against prod, nothing is committed or staged. The migration body was edited because prod doesn't have it yet. Once prod has it, the body is frozen.

**Step 1, version text.** D-1 (heading and version bullet), D-7, D-8 apply step 2, D-8 verify, D-10 and AC-R2 now say `20261109195000`. The `…160000` slot was never used: 0 rows in local `schema_migrations`, no file on disk, and prod never had it.

**Step 2, migration body** (`20261109195000_user_stores_drop_own_row_writes.sql`):
- The read-policy comment is now `'spec 195: own-row READ only; no own-row write policy by design.'`, and it runs after the DO block's `end $$;`.
- Header: dropped "Renumbered from spec 190". The PROD-APPLY line now names `execute_sql`, the exact `schema_migrations` insert and the `db-migrations-applied.yml` gate, with no project-memory reference. It also carries the AC-R1 md5 stop.
- Header rollback block: added `comment on policy "Users can read own store links" on public.user_stores is null;`, and the forward re-create migration must also retire or invert `user_stores_own_row_writes.test.sql`.
- D-1 step 3, D-8 verify (the exact `obj_description` string), and D-8 rollback steps 1 and 3 match.
- Still pure ASCII.

**Step 3, security L1:** declined. Added the text-only AC-R1 stop instead (P-1 admin md5 must be `b05a4d4429e322a9cf194d6072b5f6d3` right before the paste).

**Step 4, coverage:** added a note under AC-2 and AC-3. Also added the optional arms at the end of the new file, as postgres, so pgTAP's `ok N` still equals the T label: T24 (`mgr_n > 0` guard), T25 (authenticated keeps SELECT/INSERT/UPDATE/DELETE), T26 (exactly one non-internal trigger, `user_stores_brand_match_trg:O:user_stores_brand_match`), T27 (`user_stores` not in `supabase_realtime`). `plan(23)` became `plan(27)`. T25 uses `has_table_privilege` on the four privileges, not `table_privs_are`, so it won't break if another spec revokes TRUNCATE (security L2).

**Step 5, nits:**
- T14: `set local role authenticated` is now explicit. I did the same in the AC-10 and AC-11 blocks, which relied on the same carry-over.
- T11: `exception when others` is narrowed to `when sqlstate 'P0001' or sqlstate '42501'`.
- T3: the comment now says one md5 covers both identical strings, and that a failure after a Postgres major bump with no policy edit means re-capture.
- Legacy file: reworded the `v_target_a` comment (L110-111), the arm (9) citation is now `(spec 195)`, and the arm (11)(i) run-on is split.

**Local re-apply (shared stack).** Only the changed statement was re-applied. The drop was already done, and the DO block is read-only. The `comment on policy` text was extracted verbatim from the file and run as `begin; set local lock_timeout = '5s'; <comment>; commit;` with `ON_ERROR_STOP=1`. Output: `BEGIN / SET / COMMENT / COMMIT`, exit 0. There was no `db reset`, `stop` or restart.

**Post-apply match.** The live `obj_description`, the migration file string and the D-8 verify string are byte-identical: `spec 195: own-row READ only; no own-row write policy by design.`, md5 `3461e1fd6f43693d023de70b311e8b02` for all three. P-1 on the local stack shows exactly `Admins can manage all store links | Users can read own store links`, with admin `md5(qual)` / `md5(with_check)` = `b05a4d4429e322a9cf194d6072b5f6d3` / `b05a4d4429e322a9cf194d6072b5f6d3`, which matches the T3 literal and the AC-R1 stop value.

### Fail-closed re-run against the edited file

Each case ran as `begin; set local lock_timeout='5s'; <pre-state: re-create "Users can manage own store links">; <mutation>;` followed by the file with its `commit;` turned into `rollback;`, using `ON_ERROR_STOP=1`. Nothing was committed.
- **FC1**, extra INSERT policy `x195`: `ERROR:  195: expected exactly one permissive write policy on public.user_stores (Admins can manage all store links), found 2 (Admins can manage all store links, x195)`, psql exit 3.
- **FC3**, read policy dropped. **Now raises the `195:` message:** `ERROR:  195: expected exactly one permissive SELECT policy on public.user_stores (Users can read own store links, qual (user_id = auth.uid())), found 0 () qual <null>`, psql exit 3. AC-2 now holds literally.
- **FC3b**, read policy widened to `using (true)`: `… found 1 (Users can read own store links) qual true`, exit 3.
- **FC3c**, extra SELECT policy `x195r`: `… found 2 (Users can read own store links, x195r) qual true`, exit 3.
- **FC4**, admin arm widened to `auth_is_privileged()`: `ERROR:  195: "Admins can manage all store links" on public.user_stores is not brand-scoped (qual auth_is_privileged(), with_check auth_is_privileged())`, exit 3.
- **FC2**, the raise undoes the drop and the comment is never set. Setup: the pre-state plus `x195`, the read comment set to `fc2-marker`, then `savepoint pre`, then the body. Result: the same FC1 `195:` W error. After `rollback to savepoint pre`, the policies were `Admins can manage all store links | Users can manage own store links | Users can read own store links | x195` and the read comment was still `fc2-marker`. Then a full rollback.
- **FC0**, a clean pass from the true pre-state (own-row policy re-created, read comment nulled), rolled back: exit 0. Inside the transaction the policies were `Admins can manage all store links | Users can read own store links` and the read comment was the new string.
- **After all runs** (committed state): the two expected policies, the new comment, and admin md5 `b05a4d44…` / `b05a4d44…`.

### Mutation spot-check of the edited test file

Each mutation ran as `begin; <mutation>;` followed by the test file, whose `rollback;` undoes everything. All 27 arms ran each time (no abort).
- **M1** (own-row ALL re-created): red T1 T4 T5 T6 T7 T9 T10 T11 T12 T13 T14 T15 T16 T17 T18. That is the same 15 as before the T11 filter change.
- **M4** (own-row UPDATE-only): red T1 T4 T11. Same as before, so the narrowed filter still catches the trigger's P0001.
- **M7** (trigger dropped): red T8 T26.
- `revoke insert on public.user_stores from authenticated`: red T5 T7 T8 T12 T16 T17 T20 T21 T22 T23 T25.

Afterwards the committed state was intact: two policies, 1 trigger, and authenticated INSERT = `t`.

### Verification (actual output)
- `bash scripts/test-db.sh supabase/tests/user_stores_own_row_writes.test.sql`: `PASS … (27 assertion(s) passed)`.
- `bash scripts/test-db.sh supabase/tests/legacy_permissive_policy_dropout.test.sql`: `PASS … (13 assertion(s) passed)`.
- `npm run test:db`: `✓ 104/104 DB test file(s) passed`, exit 0. The file count grew from 101 because other sessions added files.
- `npx jest`: `Test Suites: 301 passed, 301 total`, `Tests: 3836 passed, 3836 total`, `Snapshots: 17 passed, 17 total`, exit 0.
- `npm run typecheck:test` (`tsc -p tsconfig.test.json --noEmit`): exit 0.

## Files changed

**Migrations**
- `supabase/migrations/20261109195000_user_stores_drop_own_row_writes.sql` (new).
  - Drops `"Users can manage own store links"`, adds the `195:` fail-closed DO block, then comments the read policy.
  - Post-review: the comment was shortened and moved after the DO block, the header was cleaned up, and the rollback additions are in.
  - Applied locally and recorded in local `schema_migrations`. Only the changed comment was re-applied after the edit. **Not applied to prod.**

**pgTAP DB tests**
- `supabase/tests/user_stores_own_row_writes.test.sql` (new, `plan(27)`).
  - T1-T23 per D-5.
  - Post-review: T24-T27 (vacuity guard, grant, trigger and publication pins), an explicit `authenticated` role at T14/AC-10/AC-11, T11's exception filter narrowed to P0001/42501, and the T3 md5 and re-capture note.
- `supabase/tests/legacy_permissive_policy_dropout.test.sql`.
  - Arm (9) is reversed to `throws_ok(..., '42501', 'new row violates row-level security policy for table "user_stores"', ...)`.
  - The header (8)/(9), the `v_target_a` comment, and the arm (8), (10) and (11)(i) comments are reworded per D-6, with post-review wording nits at the `v_target_a` comment, the arm (9) citation and arm (11)(i).
  - `plan(13)` is unchanged.

**Specs**
- `specs/164-profiles-insert-hardening.md`: dated AC-16 correction appended directly below the `user_stores` own-row bullet (the original L159 text is untouched). Not changed in the post-review round.
- `specs/195-user-stores-own-row-writes.md` (this file):
  - `Status: READY_FOR_REVIEW`
  - post-review: the version corrections (D-1, D-7, D-8, D-10, AC-R2), AC-R1's md5 stop, the AC-2 and AC-3 notes, the owner decision under "Open questions resolved", the D-1 step 3, D-5 plan and D-8 verify/rollback updates, and the "Post-review fixes" section
  - Implementation notes and Files changed

**Not touched (AC-15):** nothing under `src/`, `supabase/functions/`, `e2e/`, or `app.json`. No CLAUDE.md edit. Nothing committed, staged or pushed, and no prod change.
