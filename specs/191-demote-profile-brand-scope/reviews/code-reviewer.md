## Code review for spec 191

Scope: `supabase/migrations/20261109191000_demote_profile_brand_scope.sql`, `supabase/tests/demote_profile_brand_scope.test.sql`, the spec 191 parts of `supabase/tests/profiles_insert_hardening.test.sql` (K-2, K-16..K-18, section E, `plan(79)`) and `scripts/smoke-edge-roles.sh` (Arm 7b, header, EXIT trap). I had no shell, so I could not run `git diff`. I read the spec 191 regions of those two files in full, so the line numbers below are real, but I cannot certify which neighbouring lines are untouched.

I did not run anything. The pgTAP results are the developer's, from the spec's implementation notes.

Refusal strings follow the `'cannot <verb> ...'` convention. The self-guard fires before every side effect, on both the RPC path and the trigger path. The last-of-role count lives only in `assert_not_last_of_role`. The deviation from the CLAUDE.md "mirror `auth_is_privileged()`" convention is recorded inline in the migration, as the spec 157 rule requires. No `src/` changes, no legacy-file edits, no `app.json` change, no inline colors, no new realtime channels.

### Critical
None.

### Should-fix

- `20261109191000_demote_profile_brand_scope.sql:72-73` — The header says the wrapper's message coupling is "pinned by pgTAP K-6". It is not.
  - K-6 (`demote_profile_brand_scope.test.sql:209-219`) only checks that the wrapper's own source contains the literal `'cannot delete the last '`. That is always true, whatever the helper emits.
  - If someone rewords `assert_not_last_of_role`, K-6 stays green. B1a, B1b, D2a, D2c and D2d are what go red: the wrapper then re-raises the "delete" wording and the `throws_ok` strings no longer match.
  - Fix: change the header to "pinned by B1a/B1b/D2a (K-6 only checks structure)". The same sentence in the spec's section 11 should be corrected too.

- `20261109191000_demote_profile_brand_scope.sql:82, 351` — "byte-identical" is not true.
  - The developer's deviation 2 replaced three non-ASCII characters in the first branch's comments. The logic and message strings are unchanged, but the text is not byte-identical.
  - A later reader diffing against `20260517050000` (or comparing normalized md5 of `prosrc`) will see a difference and wonder whether behaviour changed.
  - Fix: say "logic and message strings identical; comments ASCII-fied (em dash, arrow, section sign)".

- `20261109191000_demote_profile_brand_scope.sql:6, 44, 50, 55, 68, 75, 92, 115, 118` and the section comments (`:126, :158, :213, :346, :437`) — The comments cite spec-document coordinates that will drift:
  - "spec A step 4", "spec B4", "spec B3", "spec C", "spec D, OQ-5", "design 1.1/1.2/1.3/1.4/1.5", "spec section 10 H1".
  - "spec A" collides with the spec's own "separate spec A" (= spec 195). A reader of this header cannot tell which is meant.
  - The migration will outlive the spec's section numbering, and the rollback pointer says the SQL is in spec section 10, but the spec's own text puts it in the review notes.
  - Fix: use self-describing labels ("acceptance criterion A, step 4" or just "the check order below"). Replace section numbers with the spec file name only. Say where the rollback SQL actually lives, or inline it as a comment block.

- `20261109191000_demote_profile_brand_scope.sql:178-181` — The comment "Lock scope only; the guarded-role decision stays in the helper" is misleading.
  - The early `return` means the helper is never called for any role other than `super_admin`/`master`. The decision is therefore duplicated here (as well as in the helper), not left in the helper.
  - If `assert_not_last_of_role` ever guards a third role, this wrapper silently skips it for demotions. The spec's design says this too, but no test pins it.
  - Fix: reword to say the role list is deliberately mirrored from `assert_not_last_of_role` and must be updated together. Ideally add one pgTAP arm or a K-6 clause that pins the pair.

- `20261109191000_demote_profile_brand_scope.sql:279-280` — The step-4 caller re-read hard-codes `('admin','master','super_admin')` a second time inside the same function.
  - Step 2 gets the same list from `auth_profile_is_privileged()`. The role set now lives in two places in one function, plus the helper, plus the `ADMIN_ROLES` copies elsewhere.
  - Fix: either comment that the two lists must stay equal, or compute `v_caller_role in (...)` once.

- `demote_profile_brand_scope.test.sql:549-552` (A5c) — The arm calls `set local role authenticated` without re-asserting claims. It relies on the S1 claims set at line 464 surviving four `reset role` / `set local role` cycles (the `reset role` at line 472 leaves claims in place).
  - D4a (`:558`) documents the same dependency ("claims deliberately NOT cleared"). A5c does not.
  - Anyone who inserts a `set_config('request.jwt.claims','',true)` earlier will break A5c with a confusing "cannot demote self" or "forbidden".
  - Fix: add `select pg_temp.as191(current_setting('test.s1', true), 'super_admin');` before A5c.

- `profiles_insert_hardening.test.sql:1008-1019` (E-2) — E-2 passes if the row does not exist, because it only asserts `count = 0`.
  - It depends on invitation `d1-164@local.test` surviving from section D (inserted around line 829). Nothing at that point checks that it is there.
  - If a future edit to section D removes or renames it, E-2 goes green for the wrong reason.
  - Fix: before `set local role authenticated`, add an `ok(exists (select 1 from public.invitations where email = 'd1-164@local.test'), ...)`, or fold that into the E-2 assertion. Remember to bump `plan()`.

- `scripts/smoke-edge-roles.sh:131-133, 550-552, 614-616` — The same three-statement cleanup SQL (delete profile, delete `auth.users` row, delete brand) is written out three times, and the header recovery note at lines 50-52 is a fourth variant.
  - Fix: define one `XB_CLEANUP_SQL` variable near `XB_BRAND` / `XB_TARGET` and use it in all three places.

### Nits

- `20261109191000_demote_profile_brand_scope.sql:229` — `v_found` really means "target row found". Rename it `v_target_found`. The loop at lines 268-275 reads more clearly that way.

- `20261109191000_demote_profile_brand_scope.sql:399-401` — The new `elsif` repeats `tg_op = 'UPDATE'`. The trigger is BEFORE UPDATE only (K-8 pins this), so it is redundant. It is also carried over from the original, so leaving it is defensible.
  - More useful: add a one-line comment that reaching the `elsif` implies `auth_is_super_admin()`, because the reader has to invert the `not` in the first condition. Line 402 says "the caller is a super_admin" but not why that follows.

- `20261109191000_demote_profile_brand_scope.sql:449-455` — The profiles INSERT policy comment joins two sentences awkwardly: "Rest of predicate unchanged from spec 164. spec 164: privileged + brand-scoped only; ..." (lowercase "spec 164:" after a full stop). Split it into two clean sentences.

- `20261109191000_demote_profile_brand_scope.sql:97` — "spec 163 M1 lesson" is opaque. One clause saying what the lesson was (for example, "non-ASCII broke a normalized-md5 comparison") would save a lookup.

- `20261109191000_demote_profile_brand_scope.sql:63-64` — "nothing in the app raises the isolation level" is a claim about other code that can go stale. State only the assumption (READ COMMITTED) and where to verify it.

- Naming: `auth_profile_is_privileged()` and `auth_is_privileged()` differ by one word, and a grep for the second misses the first by design. The G3 CLAUDE.md proposal only adds the demote sentence. Suggest the owner also add a line saying role-changing writes use `auth_profile_is_privileged()` and why, so the next policy author does not pick the wrong one.

- `demote_profile_brand_scope.test.sql:209-219` (K-6) — `d !~ 'count\s*\('` is brittle. It scans `pg_get_functiondef`, which includes body comments, so a future comment such as "recount (see ...)" would fail the arm.

- `demote_profile_brand_scope.test.sql:221-224` (K-7) — `obj_description(...) ~ 'profiles'` is weak for A8's "comment records the check order and why". Any description mentioning `public.profiles` passes. Consider matching on `'auth_is_privileged'` and `'jwt_expiry'`, which are the rationale terms.

- `demote_profile_brand_scope.test.sql` (labels) — "A4a" and "A4b" are each used for two assertions (return value and post-state), and arm letters run out of order (B4 and L-scope sit between A4b and A4c). The header explains the lock-driven ordering, which is fine. Labelling the post-state arms "A4a-RU" / "A4b-RU", as is done elsewhere in the file, would be consistent.

- `demote_profile_brand_scope.test.sql` (whole file) — The file is one ~50-arm linear script where each arm mutates state that later arms rely on (M2 and MB demoted, M3 flipped back and forth, S3 demoted). The header says order matters, which is honest. A one-line "state after this section" comment at each reset boundary (for example, "masters now: M1 only") would make D2a-D2d much easier to audit.

- `scripts/smoke-edge-roles.sh:570-578` — If the `XB_PRE` query fails, `XB_PRE` is empty and the arm treats it as "not admin". It then swaps the caller and later tries to "restore" role `''`, which fails. If the swap itself fails, the arm still sends the request as a super_admin, where it can legitimately succeed.
  - Fix: skip the request and fail early on an empty snapshot or a failed swap.

- `scripts/smoke-edge-roles.sh:600-602` — The `[[ ... ]] && pass || fail` idiom (shellcheck SC2015) would run `fail` if `pass` ever returned non-zero. It is harmless here because `pass` is a `printf`. An `if` block would match Arm 7's style (lines 507-511).

- `profiles_insert_hardening.test.sql:248` (K-2 label) — "is auth_profile_is_privileged (spec 191, not auth_is_privileged)" reads clumsily. Suggest "uses auth_profile_is_privileged() (spec 191), not auth_is_privileged()", which matches K-16.

- (out-of-scope) `README.md:229` — G2 is still open; the "self- and last-of-role guards" claim becomes true with this migration. The developer left README.md alone on purpose, so this needs a separate edit.
