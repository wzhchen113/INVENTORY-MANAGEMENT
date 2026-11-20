# Spec 198 - backend-architect post-implementation drift review

Reviewer: backend-architect, 2026-11-10. Mode: post-implementation review. `Status:` unchanged.

Read: the spec's `## Backend design` and `## Files changed`;
`supabase/migrations/20261110120000_invitations_hardening.sql`; `specs/198-invitations-hardening/rollback.sql`;
`supabase/functions/send-invite-email/index.ts`; `supabase/tests/invitations_hardening.test.sql` (catalog and C3
slices) and `profiles_insert_hardening.test.sql` (K-13, Section C, E-1); `scripts/smoke-edge-roles.sh` (Arms 3, 3b, 5);
`src/lib/auth.ts` (`inviteUser`, `registerInvitedUser`), `src/lib/inviteLink.ts`, `src/components/cmd/InviteLinkPanel.tsx`,
both invite drawers, `RegisterScreen.tsx`, `LoginScreen.tsx`; `e2e/invite.spec.ts`, `e2e/invite-claim.spec.ts`,
`e2e/fixtures/constants.ts`, `playwright.config.ts`, `.github/workflows/e2e.yml`; the caller sites in `UsersSection.tsx`
and `BrandsSection.tsx`; 191's INVITE policies (`20261109191000:505-560`) for the SCOPE copy.

## Verdict

The build matches the contract. Every RPC name, argument name, jsonb key, grant, policy shape, trigger rule, URL
parameter and testID in the design's section 13 "shared contract" is as specified. SCOPE in all four policies is
byte-for-byte 191's P_INV body. `check_invitation_code` (CP) and `register_invited_profile(text)` (R3-R7) agree.
No `supabase.*` call was added outside the documented `src/lib/auth.ts` carve-out. `src/lib/db.ts` keeps explicit column
lists that leave out `code_hash` (`db.ts:240`, `db.ts:5610`).

**Critical: 0. Should-fix: 5. Nits: 8.** No finding blocks the design. The Should-fix items are verification and commit
hygiene to finish before the prod apply.

## Critical

None.

## Should-fix

**S1. Put E-1's `code_hash` into the 198 commit now. Don't defer it.**
(`supabase/tests/profiles_insert_hardening.test.sql:1036`, recorded deviation 6)
- The reason for deferring was that E-1 sits inside spec 191's Section E hunk, and the column doesn't exist at 191's commit.
- The commit plan is now 187, then 191, then 195, then 198, all in one sequence. Once 191 is committed, the one-liner
  (`, code_hash` / `encode(sha256(convert_to('e1','UTF8')),'hex')`) is an ordinary diff against 191's commit. It can be
  staged with 198.
- **Why it matters:** E-1 is currently refused for two reasons: the privilege leaf and the missing `code_hash`. If
  someone mutates the privilege leaf, E-1 can't turn red, so it no longer pins what its description says.
- CI-2, A3, C2 and E-2 cover the leaf, so this isn't Critical. It is still a "follow-up" that costs nothing today and is
  easy to lose later.

**S2. `e2e/invite-claim.spec.ts` doesn't survive a Playwright retry.**
(`invite-claim.spec.ts:59-60, 150-153, 186`; `constants.ts:97`)
- `RUN_ID` is `GITHUB_RUN_ID`, which stays the same across CI retries (`retries: 2`).
- Suppose attempt 1 of the happy path gets past `signUp` and then fails, for example at staff landing. On the retry:
  - If `afterAll` didn't remove the auth user, the guard at :150 fails with the misleading "stub did not take effect"
    message.
  - If `afterAll` did remove it (worker teardown), the durable check `expect(inv).toHaveLength(1)` at :186 sees two
    rows: attempt 1's used row and the new pending row. B8 deletes only `used = false` rows.
- So a one-off flake late in F2 becomes a hard red. This is the spec's most valuable track: it's the only one that uses
  real GoTrue sign-up.
- **Fix (either one):**
  - make the email unique per attempt, e.g. append `test.info().retry` or a short random suffix
  - key the durable check on `profile_id = userId` instead of the row count

**S3. Neither e2e spec has run. The test-branch `e2e.yml` run is the first real execution, and it needs to be green
before the prod apply.**
- `e2e.yml` is advisory and not in the CLAUDE.md gate list (memory: "e2e gate promotion pending"), so nothing forces
  anyone to look at it. Treat it as required for this spec.
- Specific risk points to watch on that run:
  - **F1 step 1 (`invite.spec.ts:101-103`)** is the first e2e assertion in the repo that depends on the CI edge runtime
    actually serving a function. No other spec waits on `functions/v1`. At cold boot the function fetches
    `jsr:`/`esm.sh` modules.
    - If F1 goes red at this step and nowhere else, check edge-runtime health before blaming 198.
    - The F2 specs stub the function, so they don't depend on it.
  - **V-5 (`invite-claim.spec.ts:34-38`).** `signUp` leaves a live session, then `register_invited_profile` runs. The
    spec 164 flow had the same order, so this isn't new. But no spec has exercised it end to end since spec 152's
    session watch landed. If `register-success` never appears, look there first.
  - **AD-6 hand-off.** `register-code` should be prefilled after `LoginScreen` strips the URL. Only jest covers this
    today.

**S4. The shell smokes were not executed.**
- `smoke-edge-roles.sh` was checked with `bash -n` only. `smoke-delete-user.sh` (D-5 / E1) was not run, and the
  developer recorded both.
- Run both against the local stack before the prod apply:
  - Arm 3b is the same request as the section 10 step 7 post-deploy check.
  - `smoke-delete-user.sh` is the only end-to-end proof that `delete-user` can still call `assert_not_last_of_role` as
    service_role after the revoke.
- Q-9 (what GoTrue does on `signUp` after `inviteUserByEmail`) is also unrun. That's acceptable, because F2 stubs the
  fallback. Still, record the prod `RESEND_API_KEY` dashboard answer at apply time: it decides which path real invitees
  take.

**S5. The from-scratch apply is unproven, and the index holds other specs' staged files.**
- **Fresh apply.** The developer applied 198 locally with psql, on top of a database migrated step by step, and never
  ran `supabase db reset`. The first from-scratch proof will be the test branch's `test.yml` pgTAP job, which resets
  from scratch. The A8/K-f2 pins and the prerequisite DO block (`extensions.gen_random_bytes` privileges) are the parts
  that could differ on a fresh image. That run must be green before the prod apply.
- **Commit hygiene.**
  - The git index already holds staged additions for other specs: `specs/188-*.md`, `specs/196-*` and
    `supabase/migrations/20261109200000_po_number_server_assigned.sql`. A plain `git commit` for 187's hunks would
    carry them along. Unstage them, or commit them deliberately, before building the 187 → 191 → 195 → 198 sequence.
  - The frontend half has no shared-file hunk map, unlike the backend's. Confirm that none of `src/lib/auth.ts`, the two
    drawers, `RegisterScreen.tsx`, `LoginScreen.tsx`, `e2e/invite.spec.ts` or their tests carries another session's
    hunks.
  - Keep `src/lib/db.ts` out of 198's commit entirely: 198 doesn't change it, and it carries 187's and others' hunks.

## Nits

- **N1.** `src/components/cmd/InviteUserDrawer.tsx:165-166`: the `derivedBrandId` comment still cites
  `get_pending_invitation.resolved_brand_id`, which this spec drops. Point it at `create_invitation` step 5.
- **N2.** `scripts/smoke-edge-roles.sh:337-372`, Arm 5 (recorded deviation 7). The arm still holds, but it is now
  vacuous: the 400 fires before the function reads `name`.
  - Fix: send a valid-format `inviteCode` (32 hex). The arm then reaches the post-validation path again, and its
    existing `delete from auth.users` cleanup already covers the fallback's side effect.
  - Also, Arm 3's comment at :214 ("line 49") is stale.
- **N3.** `src/components/cmd/InviteLinkPanel.tsx:58,60`: in code-only mode the panel says "code", but the toasts still
  say "Link copied" / "Select the link". This can't happen in practice: the copy button is web-only, and on web `link`
  is null only if `window.location.origin` is empty. Cosmetic.
- **N4.** Both drawers keep the plaintext code in `issued` after close, until the drawer reopens. On reopen the old
  panel paints for one frame before the `[visible]` effect clears it. The same admin already saw the code, so there's
  no exposure. Clearing on close (`if (!visible) setIssued(null)`) would be tidier.
- **N5.** `e2e/invite-claim.spec.ts:79-83`: the stub's `route.fulfill` has no `Access-Control-Allow-Origin`. The app
  (`localhost:8081`) calls `127.0.0.1:54321` cross-origin, so the page's fetch probably fails CORS. The call is
  fire-and-forget and the handler has already captured the body, so the result is only console noise. Add the header.
- **N6.** `e2e/invite.spec.ts:101`: match the response with a predicate that also checks `request().method() ===
  'POST'`, so a preflight can never satisfy it.
- **N7.** `src/lib/auth.ts:546-561`: `resendInvite` (no callers, out of scope) still does `select('*')` on
  `invitations`, which now includes `code_hash` and `invited_by` for in-scope admins. The hash isn't usable without its
  preimage. Note it for whichever spec deletes `resendInvite`.
- **N8 (pre-existing, not 198 drift; for the owner).** Neither RLS nor `create_invitation` enforces spec 029's "only
  master/super_admin invite role=admin" rule.
  - P_INV (164 and 191) admits `role = 'admin'` for any privileged in-brand caller, and D3 then honours the claim. Only
    the drawer's role picker gates this.
  - 198 doesn't widen it, because the RPC is INVOKER under the same policy. It does make it a one-RPC-call action.
  - It's a candidate follow-up. Enforcing it needs INSERT/UPDATE policy parity, not only a check in the RPC.

## Recorded deviations: judgement

| Deviation | Judgement |
|---|---|
| **C3 fixture** (added `now()+7d12h`) | **Accept.** It's an improvement: the design's own "7 to 8 days" mutation couldn't turn C3 red with only NULL, 2099 and in-bound rows. The inline clamp copy (`invitations_hardening.test.sql:353`) is byte-identical to `migration:214`. The mirror-drift risk is accepted per the `consume_invitation` arm C pattern. |
| **C-15 rewritten as positive** | **Accept.** It keeps `plan(80)` out of 191's hunk. A positive "second invitation's own code claims it" pin at the 164 level is useful B5 coverage. C-18's lists are updated to match (`:835`). |
| **E-1 without `code_hash`** | **Accept the reasoning as of build time. Don't keep the deferral.** See S1: fold it into the 198 commit. |
| **AD-4 stamp limited to admin/master** (`migration:615-620`) | **Accept.** Under `profiles_role_brand_consistent` it behaves the same as the unfiltered read, and it matches the AD-4 text more literally. A `user` caller never reaches step 5 (step 1 refuses). |
| **Smoke Arm 5 now returns 400** | **Accept.** The assertion is still true. See N2 to restore its reach. |
| R7 `is distinct from` vs CP `=` | **Accept.** They differ only for a NULL-brand admin/master, which the CHECK forbids. B6-agree pins the reachable cases. |
| Mutation stand-ins (A4, D3-b, K-g) | **Accept.** The design's listed mutations for A4 and D3-b couldn't be built as written. The stand-ins exercise the same predicates. |
| **DONE inside `InviteLinkPanel`**, footer hidden | **Accept.** It avoids a duplicate `invite-done` testID. Esc and the header close (X) still work, so a phone user whose DONE is below the fold still has a way out. |
| **Admin drawer: `issued` reset in its own `[visible]` effect** (`InviteAdminDrawer.tsx:64-66`) | **Accept. Better than the design.** The existing form-reset effect is keyed on `[visible, brandStores]`, so following the design literally would have wiped an uncopied link on any `stores` refresh. `BrandsSection.refreshAfterInvite` (`:175`) only reloads admins today, but the separate effect removes the hazard. |
| **`buildIssuedInviteLink` in `InviteLinkPanel.tsx`** | **Accept.** It needs `Platform`, `window` and `process.env`, which `inviteLink.ts` deliberately avoids so it can stay pure and mock-free. Both drawers share the one definition. |
| **`result.error !== null`** | **Accept.** This is the correct discriminant for `InviteUserResult`. Unlike a truthiness check, it treats an empty-string error as a failure. |
| **Code-only copy** | **Accept.** The `link`/`code` noun switch matches the design's intent. Toast wording is N3. |
| **`inviteLinkBase` on web** (`webOrigin ? webOrigin : null`) | **Accept.** It matches the design: on web it uses `window.location.origin` and ignores the configured URL. An empty origin falls back to code-only. On a Vercel preview or localhost, the drawer link points at that origin while the email points at `APP_URL`. That's expected, and both open the same app on the same project. |

## Prod apply, rollback and edge deploy

- **Migration header** (`migration:91-111`): matches design section 10.
  - It uses `execute_sql`, not `apply_migration`.
  - The exact `schema_migrations` insert goes before `commit;`, then `notify pgrst`.
  - It runs the normalized-md5 checks over the four new or replaced functions, plus the unchanged-body checks on
    `consume_invitation` and `assert_not_last_of_role`.
  - It compares policy md5s and runs the step-5 privilege matrix.
  - Reference md5s for functions and policies are recorded in `## Files changed`. The migration is pure ASCII.
  - A `'198:'` raise rolls back everything, including the version row.
- **Prerequisite guard** (`migration:131-140`): an out-of-order apply ahead of 191 aborts cleanly. Q-1 must be re-run
  on prod: `authenticated` needs `extensions` USAGE plus `gen_random_bytes` EXECUTE, because `create_invitation` is
  INVOKER.
- **Edge deploy:** `send-invite-email` keeps `verify_jwt = true` and makes no `config.toml` change, as designed.
  - The step 7 check (admin bearer, `{"email","name"}` → 400 `inviteCode required`; no bearer → 401) matches Arm 3b.
  - Order matters: migration, then edge, then Vercel.
  - If the new function is live while an old client is still running, every old-client email gets a 400. That's silent,
    because the call is fire-and-forget. It's harmless, because after the migration the old client can't create
    invitations anyway.
  - If the new client is live before the new function, the emails carry the legacy code-less link. The drawer link
    still works.
- **Rollback** (`rollback.sql`):
  - The INSERT/UPDATE bodies match `20261109191000:505-560` verbatim.
  - The `register_invited_profile()` body and the `get_pending_invitation` body match their cited sources.
  - It recreates SELECT/DELETE without `to`, which gives roles `public`, prod's pre-198 shape.
  - It keeps the columns, index and constraint, and the anon revoke on `assert_not_last_of_role`.
  - The developer dry-ran it, and its 1/1/1/1 DO block passed.
  - One operational dependency is already in the header: the old `send-invite-email` must be redeployed in the same
    window. Otherwise the restored old client's emails all get 400.

## Ordering (187, 191, 195, then 198 on a test branch; prod in version order)

- **Code dependencies:**
  - 198 depends only on 191 (`auth_profile_is_privileged()` and the P_INV text), and the prerequisite DO block enforces
    that.
  - 198 doesn't depend on 195. The claim writes `user_stores` as postgres.
  - It shares only `public` grants with 197.
- **Shared-file hunks** (backend map in `## Files changed`):
  - In `profiles_insert_hardening.test.sql`, 191's K-13 stays the old pin at 191's commit, and 198's hunk rewrites it.
    Each intermediate tree is self-consistent.
  - Only the tip will run in CI, though. That makes S5's fresh-reset run the real check.
- **`db-migrations-applied` on the test branch** will be red: 187 (`20261108130000`), 191, 195 and 198 are not on prod.
  That's expected on a pre-apply branch and doesn't indict 198.
  - Before anything reaches `main`, prod must hold every lower version present in the pushed tree, applied in version
    order with 198 last.
  - That includes any of 190 (`20261109140000`), 193 (`20261109190000`), 196 (`20261109200000`) and 197
    (`20261109230000`) that the branch carries.

## e2e in CI against a fresh stack

- **Structure is sound:**
  - `supabase db reset` applies 191 before 198.
  - `seed.sql` holds no invitations and none of the dropped function names.
  - The master (`3333`, brand A) can see Towson (`SEED.towsonStoreId`).
  - F1's zero-store invite gets the master's brand through AD-4 and passes the INSERT policy.
  - F1 is retry-safe: on a retry, B8 replaces the row, and the fallback's `inviteUserByEmail` error is ignored, so the
    step-4 `toHaveLength(1)` still holds.
  - The F2 negative arm is retry-safe as well.
  - The `serviceRoleClient` `.eq('email', ...)` reads are safe for `+` addresses: postgrest-js builds the URL with
    `URLSearchParams`.
- **Open items:** S2 (F2 happy-path retry), S3 (first-ever run; F1's edge-runtime dependency; V-5), N5 and N6.

## AD-4 (owner may flip)

- The build is the recommended default, and it's correct.
- **If the owner flips it, decide before the prod apply.** Afterwards, the flip becomes a new migration that:
  - replaces two SECURITY DEFINER bodies (`register_invited_profile(text)` R7 and `check_invitation_code` CP)
  - replaces `create_invitation`, removing the stamp
  - re-verifies all their md5s on prod
  - re-pins B2-zero(b)
- Before the apply, it's an edit to an unapplied migration plus one pgTAP arm.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 5 Should-fix (S1 E-1 code_hash into the 198 commit; S2 F2 retry-safety; S3 first e2e run must be green, watch F1 edge-runtime and V-5; S4 run both shell smokes; S5 fresh-reset pgTAP proof plus staged 188/196 files in the index), 8 Nits. All recorded deviations accepted; the admin-drawer reset deviation is better than the design.
payload_paths:
  - specs/198-invitations-hardening/reviews/backend-architect.md

---

## Re-review (2026-11-10)

Scope: the backend-developer's "Review fix pass" (spec `## Files changed`, lines ~1518-1727) checked against
`release-proposal.md` items 1-8 and the owner decisions of 2026-11-10 (H1 super_admin-only UPDATE, AD-4 keep, L1 keep
the query string, L3 deferred, L4 no change). `Status:` unchanged.

Read: the migration (whole file); `rollback.sql`; `20261109191000:504-560` (to check the rollback's 5b and SCOPE);
`invitations_hardening.test.sql` (K-b, K-d, K-g, C3, C2, D1/D2, D3, H1-a..d); `profiles_insert_hardening.test.sql`
(header, fixtures, Section D, Section E); `src/lib/invitationsClamp.source.test.ts`; `src/lib/inviteLink.ts`
(`formatInviteExpiry`); `InviteLinkPanel.tsx`; `InviteUserDrawer.tsx:161-224`; the `expiresAt` path in `auth.ts`;
`e2e/invite-claim.spec.ts`; `e2e/fixtures/constants.ts:97`; `scripts/smoke-rpc.sh` section 2; the local-only guard and
Arm 5 in `smoke-edge-roles.sh`; and every migration on disk dated 2026-11-09 or later.

I have no shell in this review, so I did **not** recompute any md5 or read git state. md5 consistency below is
structural: it checks which bodies and expressions changed against which table entries changed.

### Verdict

The fix pass matches the proposal and the owner decisions. H1 is closed in the policy text, the fail-closed DO block,
and behaviourally (IH H1-a..d, C2's `1111` arm, PIH D-11). **Critical: 0. Should-fix: 3. Nits: 7.** None of them
touches SQL or function bodies, so no md5 changes.

### Item-by-item check

| Item | Result |
|---|---|
| **H1 policy** (`migration:331-387`) | **Correct.** `public.auth_is_super_admin()` and `invitations.used = false` are in both USING (:337-338) and WITH CHECK (:357-358). SCOPE, D7 and EXPIRY are unchanged, and SCOPE is still byte-identical to `20261109191000:510-519`. The comment keeps `spec 191` (K-17), and the shape is still 1/1/1/1. Nothing in `src/` updates `invitations` (checked again), so the app loses nothing. I also checked one alternative revival route: an in-scope admin can read `code_hash` (L3) and can DELETE a used row, since the DELETE policy has no `used` filter. They could then re-INSERT a row carrying the old hash. That gains nothing. The trigger stamps `invited_by = auth.uid()` on that row, so D3 ties it to the re-inserting admin's own current privilege. That is the AD-2 "picks its own code_hash" case the design already accepted. Not a finding. |
| **Extended DO block** (`:791-808`, `:842-845`) | **Correct.** It requires `used = false` in both expressions and at least two `auth_is_super_admin()` occurrences (D7's arm plus the H1 leaf), and it refuses client EXECUTE on the trigger function. The ">= 2" check is textual only, so a leaf moved into an OR arm would still pass it. IH C2-`1111` and H1-b are the behavioural pins that catch that, so this is acceptable. |
| **D-9..D-11 rewrite** (`profiles_insert_hardening.test.sql:917-952`) | **Correct, and it was needed.** Under the H1 policy a brand admin's UPDATE matches 0 rows, so the old `throws_ok(42501)` arms would have gone red. D-9 now runs as the SA and isolates WITH CHECK's `role in ('user','admin')` arm. d1 is unused, in bound and brand A, so USING passes and only the role arm refuses. D-10 isolates the `s.id is null` store arm. D-11 pins the brand admin's 0-row result. `plan(80)` holds. One piece of coverage is gone: the UPDATE WITH CHECK brand arm is now unreachable by every client, because the SA can see every brand. That's inherent to H1 and already noted in AD-12. The INSERT side still pins it (D-5/D-6). E-1 now carries `code_hash`, so it isolates the privilege leaf again (my S1 is resolved). CR-3 lines 8, 17 and 597 are fixed. |
| **Blank-code guard** (`migration:546`) | **Correct.** `nullif(btrim(p_code), '') is not null` has the same meaning as R3b's `coalesce(lower(btrim(p_code)), '') = ''`, because both use the same `btrim`. B6-agree adds `''`, `'   '` and NULL against the `sha256('')` row, and B3-2b pins the claim side. The design text in section 3.2 is updated to match. |
| **L2 revoke** (`migration:214`) | **Correct.** Postgres checks EXECUTE on a trigger function at CREATE TRIGGER time, not when the trigger fires. The trigger is created at :206 before the revoke, and IH B1/C1/D1/A6 stay green. Expected proacl is `postgres, service_role`. Prod's default privileges have the same shape (prod P-9 shows service_role on every function), so prod should match. |
| **Clamp source probe** (`invitationsClamp.source.test.ts`) | **Sound.** It strips line comments, normalises whitespace, and requires exactly one occurrence in each file plus placement in section 4. The DO-block invariant at :848-851 is a `select`, so it doesn't double-count. Together with C3's behavioural copy, this closes test-engineer Should-fix 2. |
| **CR-2 `expiresAt`** | **Correct.** The value flows `auth.ts:457` (jsonb `expires_at`, defaulting to `''` when missing) → `IssuedInvite` in both drawers (`InviteUserDrawer.tsx:223`, `InviteAdminDrawer.tsx:134`) → the `InviteLinkPanel` prop → `formatInviteExpiry`. The parse is done by hand (Hermes-safe; it handles 6-digit fractions and `+00:00`/`Z`), and anything unparseable falls back to "It works once." No 48-hour constant is left in the client. The email copy is unchanged, per D-3. |
| **F2 retry** (`invite-claim.spec.ts:59-69`) | **Correct.** Each attempt gets its own email via `test.info().retry`. A retry runs in a new worker, so the failed worker's `afterAll` removes attempt N's auth user, and attempt N+1's `toHaveLength(1)` (:196) only sees its own row. Locally, `RUN_ID` is `Date.now()` per worker, so local re-runs don't collide either. My S2 is resolved. |
| **`rollback.sql`** | **Matches.** 5b is byte-identical to the committed `20261109191000:505-560`. 5a matches `20260514150000`. The header names H1. The only non-ASCII bytes are inside the verbatim `get_pending_invitation` COMMENT (:219-222), which is not part of `prosrc`, so it doesn't affect any md5. |
| **md5 references** (fix-pass table) | **Consistent with the diff.** The only edits to function bodies are CP's (new raw and normalised md5), and the only edits to policy expressions are UPDATE `qual` and `with_check` (new md5s). SELECT/DELETE `qual` and INSERT `with_check` keep their md5s, and so do `register_invited_profile(text)`, `create_invitation` and the trigger function. The trigger function's proacl changed (L2), and the table records that. The developer's simulated pre-198 dry run reproduced the table from the full file body. I did not recompute the values myself. |
| **Prod-apply text** (header :95-112, spec section 10) | **Matches the built file,** with the text gaps listed in SF-2 and N-1. |

### Critical

None.

### Should-fix

**SF-1. Build 198's single commit without the shared index, and prove that tree on its own before pushing.**
- At session start the shared index already held other specs' staged work: `specs/188-*`, all of spec 192
  (`src/lib/eodDraftSlot.ts`, `EODCountSection.tsx` and its tests) and `specs/196-*`.
- Disk also holds migrations that are not on prod and must not ride: `20261109190000` (193), `20261109200000` (196)
  and `20261110130000` (199).
- A `git switch -c` from `980a79c` in this checkout carries that index along, so a plain `git commit` sweeps it in.
  Unstaging it would disturb other sessions.
- **Recommended:** create a separate worktree from `980a79c`, outside `.claude/worktrees/` and never `supabase start`ed
  from (CLAUDE.md bind-mount gotcha). Bring over the 198-only new files whole, and apply only 198's hunks of the
  shared files.
- **Shared files that also carry other sessions' hunks:**
  - `src/lib/auth.ts`. Note that 198's `import ... from './inviteLink'` (:8) sits next to the `placeholderEmail` import
    (:7). If :7 is another session's line, that hunk needs a manual edit.
  - both drawers and their tests
  - `RegisterScreen.tsx` and `LoginScreen.tsx` and their tests
  - `inviteUser.test.ts` and `registerInvitedUser.test.ts`
  - `auth.fetchAllUsers.test.ts` and `db.fetchBrandAdmins.test.ts`
  - `e2e/invite.spec.ts`
  - `scripts/smoke-edge-roles.sh` and `scripts/smoke-rpc.sh`
- **Exclude:**
  - `src/lib/db.ts`
  - `package.json`
  - `placeholderEmail*`
  - `scripts/smoke-staff-eod.sh`
  - `specs/043-*`, `specs/164-*` and `specs/178-*`
  - `supabase/tests/staff_role_eod_rls.test.sql`
  - `supabase/functions/delete-user/`
- The fix pass's "Against HEAD in this checkout (191 still uncommitted)" hunk notes are stale now that 191 is on
  `main`. Re-derive the hunks with `git diff 980a79c -- <file>`.
- **Proof before pushing, in the isolated tree:**
  - `git diff --cached --name-only 980a79c` lists only 198's paths
  - under `supabase/migrations/` there is exactly one new file, `20261110120000_invitations_hardening.sql`
  - `npx jest`, `npm run typecheck:test` and `npx tsc -p e2e/tsconfig.json --noEmit` all pass
- **Why:** every green result in the fix pass ran on a working tree, and a local DB, that also held 192/193/196/199
  work.

**SF-2. Mark the superseded md5 references, and add the trigger function to the section 10 step-5 query.** This is
text only.
- The first backend table in the spec (around lines 1419-1435) still says "SELECT, DELETE **and UPDATE** `qual`:
  `864eb7d8...`". It also still carries the old CP md5s and the old trigger-function proacl. The fix-pass table
  supersedes all of these, but only in prose.
- Strike the stale values through, the same way deviations 6 and 7 were, so whoever runs prod step 3/4 can't pick
  them up.
- The fix pass says the step-5 privilege matrix "gains `assert_invitation_provenance()`", but the step-5 SQL in
  section 10 (around lines 1193-1199) doesn't list it. Step 3's proacl comparison does cover it, so this is a doc fix,
  not a gap.

**SF-3 (carried over from S4 and proposal item 8; still open). Run `smoke-edge-roles.sh` and `smoke-delete-user.sh`
locally before the prod apply.**
- The fix pass records both as not run.
- **`smoke-delete-user.sh`** is the only end-to-end proof that `delete-user` can still call `assert_not_last_of_role`
  as service_role after D-5.
- **`smoke-edge-roles.sh`:** Arm 3b is the same request as prod step 7. Arm 5 now reaches the fallback path, and its
  cleanup exists. The script refuses non-local URLs (:67-70).
- **Also re-run `smoke-rpc.sh` section 2 with at least one pending invitation present.** Its GET and DELETE arms were
  vacuous on the fix-pass run because the table held 0 rows.
- Both scripts write to the shared stack, so coordinate with the other sessions first.

### Nits

- **N-1.** The ROLLBACK line in the migration header (`:114-115`) still lists "195-H1, 164-M1 and 191-M1" without the
  review H1, while `rollback.sql:20-25` does name it. It sits outside any `$$` body, so editing it changes no md5.
- **N-2.** Policy md5s depend on the session `search_path`. `pg_get_expr` leaves `public.` off functions and relations
  that are visible on the path. Run the step-4 query with the same `search_path` locally and on prod (e.g.
  `set search_path = "$user", public, extensions;` in both). If an md5 differs, diff the text before calling it drift.
  Function `prosrc` md5s aren't affected by this.
- **N-3.** `profiles_insert_hardening.test.sql:847` still heads Section D as "D-1..D-12: admin A", but D-9 and D-10
  now run as the SA. The inline comment at :917-921 explains it; fixing the header is optional.
- **N-4.** `invite-claim.spec.ts:105-115`: `await emailRequest` resolves on the request event, not when the route
  handler has assigned `emailBody`. This race is pre-existing and was already on the proposal's remaining-nits list.
  A promise resolved inside the handler would remove it.
- **N-5.** `formatInviteExpiry` shows the admin's local time with no timezone label. That's fine for the admin; it's
  only worth noting if the link is forwarded to someone in another timezone. Cosmetic.
- **N-6.** `20261110130000` (spec 199) now sorts after 198. The design 1 "bump if anything sorts at or after" rule was
  satisfied at build time, and no bump is needed: 199 and 193 change only `staff_submit_eod`, with no shared objects.
  For 193's owner: applying `20261109190000` to prod after 198 is out of version order. That's harmless through MCP,
  but `supabase db push` would need `--include-all`.
- **N-7.** E-2 (spec 191) and H1-a now each have two causes. Both are recorded and inherent to H1. K-16, C2-`1111` and
  H1-b keep each leaf pinned on its own. No action.

### Prod-apply order (landing facts: 187, 191 and 195 on prod and on `main` at `980a79c`)

**0. Commit and CI** (owner go-ahead)
1. Build the single 198 commit on a fresh test branch from `980a79c`, following SF-1.
2. Push the test branch. Then:
   - **`test.yml`** must be green. Its pgTAP job is the first from-scratch apply of the fix-pass body, covering the DO
     block 8.3/8.5 additions and K-b/K-d.
   - **`e2e.yml`** must be green. It is the first run of F1 and F2. If F1 is red only at its edge-function wait, check
     CI edge-runtime health before blaming 198.
   - **`db-migrations-applied.yml`** must be red with **exactly one** missing version, `20261110120000`. Any other
     missing version means a stray migration got into the commit. Stop.

**1. Read-only pre-checks** (MCP `execute_sql`, project `ebwnovzzkwhsdxkpyjka`, done once, right before the apply)
- Confirm the latest `test.yml` and `db-migrations-applied.yml` runs on `main` (`980a79c`) are green. That proves prod
  holds every migration on `main`.
- **P-1, P-2, P-3:** pending rows. Any person listed in P-1 gets re-invited after the apply.
- **P-8:** must now show:
  - INSERT and UPDATE in 191's shape: `auth_profile_is_privileged()`, `{authenticated}`
  - SELECT and DELETE as `auth_is_privileged()`, `{public}`

  That is exactly the state `rollback.sql` restores. If P-8 differs, stop and reconcile `rollback.sql` first.
- **P-9:** save the `proacl` values.
- **P-12:** must include `20261108130000`, `20261109191000` and `20261109195000`, and must **not** include
  `20261110120000`.
- **Q-1:** `authenticated` has USAGE on `extensions` and EXECUTE on `gen_random_bytes`. Without this the prerequisite
  DO block aborts.
- **Q-2.**
- **Q-4:** the prod list of `profiles` writers must equal local's pre-198 list, `demote_profile_to_user(uuid)` and
  `register_invited_profile()`. K-f2's post-apply pin depends on it.
- **Q-6:** no FK references `invitations`.
- **Q-7:** table grants.
- **Save the rollback inputs:** `pg_get_functiondef` of `get_pending_invitation(text)` and `register_invited_profile()`,
  plus the P-8 text.
- **Owner dashboard checks.** Record whether `RESEND_API_KEY` is present.
- **Hold invites.**
- **SF-3's smokes** have been run locally.

**2. Apply, verify, deploy, push** (back to back, invites on hold)
1. **Migration.** MCP `execute_sql` with the exact `20261110120000_invitations_hardening.sql` body **from the
   committed tree**. Immediately before the final `commit;`, add
   `insert into supabase_migrations.schema_migrations (version, name) values ('20261110120000', 'invitations_hardening');`.
   - Do not use `apply_migration`.
   - Expect `NOTICE 198: clamped N pending invitation(s)`, with N matching P-2's out-of-bound count.
   - Any `'198:'` raise rolls back everything, including the version row.
2. **Schema reload:** `notify pgrst, 'reload schema';`
3. **Verify functions** (section 10 step 3): normalised md5, `prosecdef` (f/t/t/f), `proconfig`, owner and proacl
   against the **fix-pass** table. `assert_invitation_provenance()` should be `postgres, service_role`. There should
   be no `get_pending_invitation` row and no zero-argument `register_invited_profile` row. `consume_invitation` and
   `assert_not_last_of_role` bodies should be unchanged from the pre-apply output.
4. **Verify policies** (step 4): pin `search_path` (N-2), then expect 4 rows, all `{authenticated}`, with the fix-pass
   md5s: SELECT/DELETE `864eb7d8...`, INSERT `648ee063...`, UPDATE `qual` `bfe1da65...`, UPDATE `with_check`
   `8dc14413...`.
5. **Verify privileges** (step 5): the matrix plus the trigger function (anon f, authenticated f, service_role t). No
   PUBLIC entry. `assert_not_last_of_role`'s ACL is unchanged from P-9.
6. **Verify schema objects** (step 6): columns, index, constraint, trigger enabled. P-2 and P-3 show 0 pending rows
   outside the bound.
7. **Deploy `send-invite-email`** from the committed tree, with `npx supabase@2.108.0 functions deploy
   send-invite-email --project-ref ebwnovzzkwhsdxkpyjka` or MCP `deploy_edge_function` (`verify_jwt: true`).
   - With an admin bearer, `{"email","name"}` should return 400 `inviteCode required`.
   - With no bearer it should return 401.
8. **Push the commit to `main`** (fast-forward). If `main` has moved past `980a79c`:
   - rebase and re-run CI on the rebased commit
   - confirm any migration the new `main` commits carry is already on prod

   The push triggers the Vercel deploy.
9. **Confirm the latest `test.yml`, `db-migrations-applied.yml` and `e2e.yml` runs on `main` are green.**
10. **Release the invite hold.** Re-invite anyone P-1 listed.

The rollback path is unchanged: `rollback.sql` via `execute_sql`, then `notify pgrst`. Redeploy the previous
`send-invite-email` and revert the Vercel deploy in the same window.

### Handoff
next_agent: NONE
prompt: Architectural re-review of the 2026-11-10 fix pass complete. 0 Critical, 3 Should-fix (SF-1 build the single 198 commit in an isolated worktree from 980a79c, excluding 193/196/199 migrations, 188/192/196 staged files, db.ts and other sessions' shared-file hunks, and prove that tree with jest/typecheck before pushing; SF-2 strike the superseded md5 table and add the trigger function to the step-5 query; SF-3 run smoke-edge-roles.sh and smoke-delete-user.sh, and re-run smoke-rpc section 2 with a pending row), 7 Nits. H1, the DO block, D-9..D-11, the blank-code guard, the L2 revoke, the clamp probe, CR-2, the F2 retry change, rollback.sql and the md5 deltas all check out.
payload_paths:
  - specs/198-invitations-hardening/reviews/backend-architect.md
