# Spec 193 release proposal

Synthesized 2026-11-10 from the four reviewer files in this folder: code-reviewer.md, security-auditor.md, test-engineer.md and backend-architect.md. I read each file in full, plus the spec's `## Files changed`.

## Verdict
verdict: SHIP_READY
rationale: None of the four reviewers flagged a Critical or High finding, every applicable AC passes (AC-17 to AC-19 are correctly N/A), and both CI gates on `main` were green at 97f0f17 (checked 2026-11-10). The open should-fixes are a smoke script and a docs note. None of them changes either function body. One condition: the prod MCP apply must happen before the push to `main` (step 4).

## Findings summary

- **code-reviewer:** 0 Critical, 2 Should-fix, 8 Nits.
  - Both bodies were confirmed against the 189 file, one hunk each, with `admin_submit_eod` untouched.
  - Should-fix 1: `scripts/smoke-staff-eod.sh` cleanup doesn't track step 8c's `OOW_UUID`. If the bound ever regresses, the smoke leaves a real A - 36 row behind.
  - Should-fix 2: smoke step 8b carries on after `pick_free_date` fails and POSTs `"p_date": ""`, which buries the real cause under secondary failures.
  - Nits: R9 calls in the pgTAP suite are bare `select`s rather than `lives_ok`; the source-text pin on `current_date` (arm 36); the refusal string now exists in four copies; the `[::1]` / uppercase `LOCALHOST` usage text; the stale jest file header; the queued item's date in the jest fixture.
- **security-auditor:** 0 Critical, 0 High, 0 Medium, 3 Low.
  - Probes ran on the local stack inside rollback, and none of the bypass attempts worked:
    - session TimeZone and `Prefer: timezone`
    - NULL, `infinity`, `-infinity` and BC dates
    - three-valued logic in `auth_is_privileged()`
    - a replay at A - 200
    - calling the writer directly (permission denied)
  - The refusal (22023, HTTP 400, constant message) can't push the shipped client into the dequeue or network branch. The R9 CTE audits every dropped item, and the posture of both functions matches 189. Live `md5(prosrc)` equals the file bodies.
  - L1: a store member can blank a count by re-sending an item with a NULL value or NO NEED, and no `Count cleared` row is written. This is an accepted residual and is already out of scope in the spec.
  - L2: the smoke script's host guard can be bypassed with `#@` or `?@` in the URL. The requests can't reach `/rest/v1` or `/auth/v1`, but the fix is to allowlist the whole URL.
  - L3: the jest error fixture is an `Error` instance, but postgrest-js 2.101.1 returns a plain object. Classification is the same either way. However, `lastError` is `'unknown'` in production, so AC-9's `lastError === MSG` assertion pins behaviour real traffic won't produce.
- **test-engineer:** 0 FAIL, 0 NOT TESTED.
  - AC-1 to AC-14 and AC-20 to AC-28 pass. AC-17 to AC-19 are N/A because the landed 189 wrapper already carries O-1, so R8 was rightly skipped.
  - The test-engineer's own runs:
    - `bash scripts/test-db.sh`: 106/106 files, with the new suite at 69/69.
    - `npx jest`: 307 suites / 3948 tests.
  - Not re-run by the test-engineer, so these rest on the developer's runs only: the smoke (AC-11) and `npm run typecheck` / `npm run typecheck:test` (developer reports only environmental TS2688 noise from stray `@types/* 2` folders).
  - The flake and collision analysis is clean: A is fixed at transaction start, there's a distinct k per suite, and pre-deletes are in place wherever seed vendors persist.
- **backend-architect (post-impl):** 0 Critical, 1 Should-fix, 5 Minor. No contract drift.
  - Both builder deviations were accepted. D1: in-transaction vendors in the new suite. D2: a wider Frederick pre-delete in `staff_role_eod_rls`, which also corrects a §6.2 design erratum.
  - S1 (should-fix): the PROD-APPLY notes in the migration header (L52-60), the spec's `## Prod apply` and §9 don't say "apply on prod BEFORE pushing to `main`". Pushing first turns `db-migrations-applied.yml` red, which is the 2026-06-28 failure mode.
  - N1: the version sorts before other sessions' pending migrations. Note it as "MCP plus an explicit version insert, not `db push`".
  - N2: the same smoke step 8b continue-on-fail issue as code-reviewer's second should-fix.
  - N3: `pick_free_date` reads a PostgREST error body as "taken" and then prints a misleading message. It fails closed.
  - N4: rename `TODAY` to `EOD_DATE` in the smoke script.
  - N5: arm (42)'s scalar subquery depends on arm order.

Cross-checks:
- **189 baseline.** Main Claude confirmed that the working-tree `20261109120000` migration equals HEAD. That closes the "compared against the working tree" caveat raised by code-reviewer and backend-architect. The security-auditor compared against HEAD directly.
- **189 on prod.** A green `db-migrations-applied` at 97f0f17 implies `20261109120000` is in prod's `schema_migrations`, which satisfies the "only after 189 is on prod" precondition. The §9 md5 pre-check is still required.

## Recommended next steps (ordered)

1. **(Recommended, before commit) Fold in the five cheap fixes.** Each is a few lines, and none touches a `$$ … $$` function body, so the reviewed md5s are unaffected.
   - a. **Prod-before-push note (architect S1, plus N1).** Cheapest of the five, and the most valuable because it prevents a red gate.
     - Add one line to the migration header's PROD-APPLY paragraph: "Apply on prod via MCP (after 189 is verified on prod) BEFORE pushing this commit to `main`; out-of-order version by design — explicit `schema_migrations` insert, not `db push`."
     - Add the same line to the spec's `## Prod apply` and §9. The header sits outside `$$`, so the md5 doesn't change.
     - Optionally fix the §6.2 erratum from the architect's D2 in the same spec pass.
   - b. **Smoke cleanup of `OOW_UUID`** (code-reviewer should-fix 1). Assign it to a tracked cleanup variable before the step 8c call, and add it to the `for u in …` list. One or two lines.
   - c. **Smoke stops when no free date is found** (code-reviewer should-fix 2 / architect N2). Wrap the prime and NO NEED calls in an `else`, or skip them when `NN_DATE` is empty. This mirrors step 4's existing bail-out. A few lines.
   - d. **Smoke URL allowlist** (security L2). Replace the sed host extraction with one whole-URL match: `[[ "$SUPABASE_URL" =~ ^https?://(127\.0\.0\.1|localhost)(:[0-9]+)?/?$ ]] || exit 2`. One line. It also makes the `[::1]` / uppercase usage-text nit moot.
   - e. **Jest error shape** (security L3). Change the fixture to a plain `{ code: '22023', message: MSG, details: null, hint: null }` object. Then change AC-9's `lastError` assertion to whatever the hook actually records for a plain object (the auditor says `'unknown'`), or drop it. Two or three lines, test-only.
   - Re-verify after folding in:
     - b to d: re-run `bash scripts/smoke-staff-eod.sh`. That also closes the gap that no reviewer independently ran the smoke. Re-run the guard negatives too, including `http://evil.invalid#@127.0.0.1`.
     - e: run `npx jest src/screens/staff/hooks/useEodSubmit.test.ts`, then the full `npx jest`, then `npm run typecheck:test`. `typecheck:test` is a CI gate jest misses.
     - a: optionally re-run the new pgTAP suite.
   - If the user would rather not fold these in, steps 2 onward still apply. Only (a) carries real risk if skipped, and step 4 below covers it operationally.
2. **Run both typechecks yourself before commit.** `npm run typecheck` and `npm run typecheck:test` were reported only by the developer. Expect only the TS2688 `@types/* 2` noise.
3. **Stage only spec 193's files and hunks. The user runs the commit.** The working tree is shared with other sessions:
   - Spec 196 files are **already staged** (`specs/196-*`, `supabase/migrations/20261109200000_po_number_server_assigned.sql`). A plain `git commit` would sweep them in.
   - `supabase/tests/audit_log_rls_hardening.test.sql` holds another session's uncommitted spec 187 hunks. The builder's `## Files changed` says so. Use `git add -p` for this file.
   - `admin_submit_eod.test.sql`, `useEodSubmit.test.ts` and `scripts/smoke-staff-eod.sh` also show as modified. Check `git diff` on each for hunks that aren't spec 193's.
   - The spec 193 set is the 13 paths in the spec's final `## Handoff` payload, plus the spec file and this reviews folder.
4. **Apply to prod via the Supabase MCP BEFORE pushing to `main`.** Project `ebwnovzzkwhsdxkpyjka`, per spec §9, on the owner's go-ahead:
   - Pre-check: the normalized md5s of `staff_submit_eod` and `eod_write_submission` on prod equal the post-189 bodies. Record `admin_submit_eod`'s md5.
   - Apply: run the migration body (its pre-flight re-checks 189), then insert version `20261109190000` into `supabase_migrations.schema_migrations`.
   - Verify: both md5s, `prosecdef` (wrapper t, writer f), `proconfig {search_path=public}`, `proacl` (wrapper owner + `authenticated`; writer owner only), `admin_submit_eod` unchanged.
   - Use the MCP path, not `db push`: the version sorts before other sessions' pending migrations.
5. **Push, then confirm the gates.** Run `gh run list --branch main --workflow test.yml --limit 1` and the same for `db-migrations-applied.yml`. Check `e2e.yml` by hand. If any of them is red or still running, stop and surface the run URL.
   - Other sessions' pending migrations (`…191000`, `…195000`, `…200000`, `…230000`, `20261110120000`) will also turn the drift gate red if they're pushed without a prod apply. That is independent of this spec, but keep it in mind when reading the gate.
6. **(Optional, non-blocking) Nits for a later touch:**
   - Architect N3 (`pick_free_date` error-body check), N4 (`TODAY` to `EOD_DATE`), N5 (make arm 42 independent of arm order).
   - Code-reviewer nits: `lives_ok` around the R9 calls, and the jest header and fixture date.

## Out of scope for this review

- **Security L1: a re-sent item blanked to NULL or NO NEED leaves no `Count cleared` row.** The spec rules this out ("recording a re-sent item's old value"). It's a possible future spec: write a "replaced" audit row when numeric becomes NULL or NO NEED.
- **Pre-existing, seen during security probe P5:** a payload element with a missing or cross-store item raises 42501 from `eod_entries_check_store_trg`. The shipped `isForbidden` treats that as a dequeue, so the count is lost. This is outside spec 193's diff but worth its own ticket alongside the staff-queue follow-up.
- **Named follow-ups the spec already lists:**
  - a RESTRICTIVE date predicate on direct `eod_submissions` / `eod_entries` INSERTs;
  - the `attempts >= 5` "needs attention" queue UI, and GC of items with an unparseable `queued_at` (L3's `lastError = 'unknown'` matters for that UI);
  - a per-store time-zone column (the NY anchor literal is one more place to update);
  - 189's other security findings (L1 to L3).
- **Spec 185 overlap:** whichever of 185 and 193 lands second must carry the other's hunks in both functions' `create or replace`. This is a sequencing risk, already recorded in Dependencies.
