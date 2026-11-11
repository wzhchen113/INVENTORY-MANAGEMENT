## Test report for spec 191

### Acceptance criteria status
(file = supabase/tests/demote_profile_brand_scope.test.sql unless noted; PIH = profiles_insert_hardening.test.sql)
- A1 stale/profile-less/forged-super_admin callers refused 42501 'forbidden', target unchanged -> PASS: A1a, A1b, A1c, A1-RU. Caveat: A1a/A1b alone pass even if step 2 is reverted (step 4 re-read gives the same string); A2d is the arm that pins step 2. A1c passes on old code too (no-regression only).
- A2 brand scope (admin->admin/user/NULL-brand in other brand, master caller, forged super_admin claim) -> PASS: A2a-e, A2-RU. Master->other-brand admin/master untested, same code path.
- A3 admin/master cannot demote super_admin -> PASS: A3a, A3b, A3-RU.
- A4 in-brand demotions (admin->admin/user, admin->non-last master, master->admin) -> PASS: A4a, A4b, A4c, A4d with post-state checks.
- A5 super_admin cross-brand and super_admin->super_admin -> PASS: A5a, A5b, A5c.
- A6 self guard / null caller / P0002 unchanged; demote_self_guard unmodified -> PASS: demote_self_guard.test.sql 6/6 unmodified. P0002 is covered only by that file.
- A7 refusals fire before UPDATE -> PASS: A1-RU, A2-RU, A3-RU, B1-RU, D1-RU, D2a-RU, D2c-RU.
- A8 DEFINER, search_path, owner, grants, comment -> PASS: K-1, K-2, K-7.
- B1 last master refused for admin and super_admin callers -> PASS: B1a, B1b, B1-RU.
- B2 super_admin target goes through the helper, 'cannot demote the last super_admin' -> PASS by non-CI evidence only. Unreachable in one session. CI covers it indirectly (K-6 text pin, L-2 lock on trigger path). The string itself was seen only in the developer's P3 probe (throwaway DB probe191). Accepted per the spec's own risk note.
- B3 helper unchanged, delete-user strings unchanged -> PASS: K-6, delete_last_privileged_guard 4/4 unmodified.
- B4 concurrency -> PARTIAL. Serial pgTAP arm PASS (B4). Lock presence PASS in CI (L-0, L-scope x4 keys, L-1, L-2). Two-session probes P1', P2, P3 were run only by the developer in a throwaway DB and are self-reported, not reproduced by me. Judgement below.
- C1 RPC + invitations INSERT/UPDATE use profiles-backed check -> PASS: PIH K-2, K-16, K-3, E-1, E-2.
- C2 profiles INSERT policy -> PASS: PIH K-2, E-3.
- C3 stale-claim user refused on 3 writes -> PASS: PIH E-1 (42501), E-2 (0 rows, per design correction), E-3 (42501); RPC side A1a/B4.
- C4 existing arms still pass; e2e/invite.spec.ts -> pgTAP PASS (PIH 79/79, invitations_super_admin_rls 4/4). e2e NOT RUN.
- C5 fail-closed DO block -> PASS by inspection of the migration (applied locally without abort); no arm re-triggers it. Fine for a one-shot apply guard.
- C6 comment on policy -> PASS: PIH K-17.
- C7 lint / parity unmodified -> PASS: full test:db 103/103.
- D1 super_admin self role change refused -> PASS: D1, D1-RU.
- D2 last-of-role via direct UPDATE -> PASS for master (D2a, D2c, D2d, RUs). The super_admin variant is unreachable in one session (P3 only, developer-run).
- D3 non-super_admin behaviour unchanged -> PASS: auth_can_see_store_brand_scope, rls_hardening_followups, profiles_rls_sweep (all in the 103/103 run), and D3a-c for promotions.
- D4 postgres/service_role skip -> PASS: D4a, D4b. Both are lives_ok with no row-state check (see Nits).
- E1 no client change -> PASS (git status shows no db.ts/useStore/BrandsSection change from this spec).
- E2 manual UI toast check -> NOT TESTED. Developer verified by reading code only; spec requires a live check.
- F1 pgTAP -> PASS (103/103).
- F2 jest + typecheck:test -> PASS. `npm run typecheck` not run (known red).
- F3 smoke Arm 7 unmodified + new 403 arm -> NOT TESTED as a script (Arm 7b is "7b", not "8"; not run, per instruction). Mapping itself verified by me, see Notes.
- F4 post-push CI green -> NOT TESTED (nothing pushed).
- G1 migration header -> PASS (read). G2 README.md:229 -> NOT DONE (developer left it; README has other sessions' edits). G3 -> proposal only, nothing to test.
- H1-H3 prod rollout -> NOT TESTED / not started (expected at this stage).

Totals: 24 PASS (counting B2/B3/C5 as passes with caveats), 2 PARTIAL (B4, C4), 0 FAIL, NOT TESTED: E2, F3 (script), F4, H1-H3.

### Test run
- `bash scripts/test-db.sh <file>` per file: demote_profile_brand_scope 54/54 PASS; profiles_insert_hardening 79/79 PASS; demote_self_guard 6/6 PASS; delete_last_privileged_guard 4/4 PASS; invitations_super_admin_rls 4/4 PASS.
- `npm run test:db`: 103/103 DB test files passed (developer reported 102; one more file has appeared since, user_stores_own_row_writes from spec 195, and it passes).
- `npx jest`: 301 suites passed, 3836 tests passed, 17 snapshots.
- `npm run typecheck:test`: exit 0.
- Not run, as instructed: smoke-edge-roles.sh, e2e, `npm run typecheck`.

### Judgement on the requested items

1. Developer's corrections to the design's mutation table (deviation 4): all three are sound.
   - "Step 2 reverted alone is not caught by A1a/A1b" is correct (step 4 re-read yields the same 42501 'forbidden'). A2d does catch it, since an admin with a forged super_admin claim would get 'forbidden' instead of the brand string. Real consequence: A1a/A1b/B4 do not independently pin step 2, and nothing in CI pins step 4 on its own.
   - "Step-4-only mutation not caught by B4": correct, step 2 refuses first. The re-read after the row lock is only observable under concurrency (P2). NOT a Critical, since step 2 is the live gate in every serial case, but it is a Should-fix: a future refactor deleting the step-4 re-read would pass CI. I would accept it as a documented gap or ask for an isolated test using a two-connection harness (not in-tree today).
   - E-2 "UPDATE USING reverted": the WITH CHECK still blocks, so the arm errors instead of returning count=1. It still goes red (and K-16 fails), so the mutation is killed. Fine.
2. P1 as written never exercises the advisory lock: confirmed by reading the design. Both sessions use A1 as caller, so S2 waits on A1's row lock (layer 1) and an advisory-lock-less wrapper still passes. P1' (A1 and X) is the correct probe and the developer showed S2 blocked on Lock/advisory and the mutant letting both demotions succeed. Spec 6.5 still says P1 as written; the row should be changed to P1'. In CI, the advisory lock is pinned only by static/presence arms (K-6 text match, L-1, L-2, L-scope), not behaviourally. Presence of the lock call in the function body is covered; blocking behaviour is not. Should-fix (doc), not a ship blocker.
3. Items that did not run:
   - Arm 7b / HTTP 403 mapping: the mapping is not a real gap. I verified it read-only against the live stack with a self-minted authenticated JWT for a profile-less uid calling `/rest/v1/rpc/demote_profile_to_user`: response `{"code":"42501",...,"message":"forbidden"}` HTTP 403. 42501 maps to 403 and the other cross-brand/super_admin strings use the same errcode. What stays unverified is the script itself (fixture SQL, trap cleanup, caller swap logic): it was dry-run in a rolled-back transaction and `bash -n` only. Since smoke is not in CI, not a ship blocker; run it once when the shared admin login can be disturbed (F3 says "run by hand once").
   - e2e/invite.spec.ts: a real but modest gap. C4 names it explicitly and the invite flow is exactly what the policy swap touches (the inviter is a real admin whose profile role is admin, so I expect it to pass, and PIH sections A and D cover the same shape in SQL). It needs: the local stack up with seed, Expo web server on :8081 started by Playwright's `webServer`, `E2E_BASE_URL` default, admin@local.test login/password, and serial execution because it mutates the shared stack (invitations rows + the user created). It also needs global-setup to not clash with other sessions' runs. Recommend running it once before commit, not run here because the stack is shared.
   - E2 manual UI check: a real, spec-mandated AC with no evidence beyond code reading. The code path is simple (store reverts and calls notifyBackendError with e.message), so risk is low, but it needs admin@local.test promoted to super_admin (shared login) and a browser. Run it once and record it, or have the owner waive it.

### Gaps ranked

Critical
- None. No AC is FAIL. All behavioural ACs the pgTAP track can reach are PASS and the full DB/jest/typecheck:test gates are green.
  - Release-coordinator note: strictly, E2 and F3-as-script are NOT TESTED, which the process counts as Critical. I rate them as accepted-with-record rather than defects: the code path for E2 is verified by reading, and the F3 mapping was verified by my probe. If the coordinator applies the rule literally, the fix is cheap (run Arm 7b and the E2 click-through once on a quiet stack).

Should-fix
1. e2e/invite.spec.ts not run (C4 names it). Run once on a stack nobody else is using.
2. E2 manual UI check not performed (spec E2 requires it recorded).
3. Spec 6.5 still lists P1 with a single caller, which cannot kill the advisory-lock mutant. Replace with P1' in the spec so reruns are meaningful.
4. Step-4 caller re-read and the advisory lock's blocking behaviour have no CI coverage; only developer-run probes in a throwaway DB (self-reported, not reproduced by me). If the lock line were deleted, K-6/L-1/L-2 would catch it; if only the re-read were deleted, nothing in CI would.
5. G2: README.md:229 still says "self- and last-of-role guards"; true now, optionally add "brand-scoped". Open until README is free of other sessions' edits.

Nits (assertions that would pass whatever the behaviour was)
- A1c: passes on the pre-change code (the claim never counted). It is a no-regression arm, not proof of the new behaviour.
- A1a / A1b: pass with step 2 reverted because step 4 gives the same refusal; only A2d pins step 2.
- D2b, D4a, D4b are bare `lives_ok` on an UPDATE with no check that the row changed. An UPDATE filtered to 0 rows would pass them. D2b is backed by L-2 (lock taken means trigger fired); D4a/D4b are backed by their mutation kills but not by a post-state assertion. Add a rb191() check after each.
- D3a-c are bare lives_ok too, but the following combined D3 `ok` checks the resulting roles, so they are fine.
- B1a/B1b/D2a-d use throws_ok with errcode + message; those are strict and would not pass vacuously.
- C5's fourth check (policy text contains the new helper) is exercised only by the successful apply; there is no arm that proves the abort path.

### Notes
- Arm 7b was named so because an Arm 8 already exists (spec 167); spec text says Arm 8. Fine.
- Developer claimed "102/102" for test:db; I observed 103/103 because spec 195's user_stores_own_row_writes.test.sql is now on disk. It passes.
- The three-key (instead of two-key) L-scope check, ASCII-ised comments in the trigger function, and the P1' correction are all sensible deviations; none changes behaviour.
- No code or tests were modified. Nothing was committed. The one live request I made was a read-only RPC call that is refused before any lock or write.
