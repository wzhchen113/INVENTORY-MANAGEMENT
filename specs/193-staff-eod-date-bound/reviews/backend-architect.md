# Spec 193: backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode). Date: 2026-11-10.
Scope: `supabase/migrations/20261109190000_staff_eod_date_bound.sql`, `supabase/tests/staff_submit_eod_date_bound.test.sql`, the reworked fixtures in the eight staff/admin suites, `src/screens/staff/hooks/useEodSubmit.test.ts` (AC-9, AC-10) and `scripts/smoke-staff-eod.sh`. I compared them against `## Backend design` §0 to §13 and the Builder checklist.

**Limits.** This pass had no shell, so I didn't run `git show`, the pgTAP runner, jest or the smoke. I compared the bodies against the working-tree `supabase/migrations/20261109120000_admin_eod_replace.sql`. That file doesn't appear as modified in the session's git status snapshot, and the builder states it matches HEAD 97f0f17, so I treat it as the committed spec 189 file. The test results quoted below are the builder's.

## Verdict

**No contract drift.** Both functions match the design: the date block, the R9 CTE, the clause sets, the pre-flight, the re-issued writer revoke, the comments and the statement order. Both body diffs are one hunk each. The two stated deviations are improvements, and I accept both. There are no Critical findings, one Should-fix (documentation of prod-apply sequencing, which my own design also left out) and five Minor ones.

| Severity | Count |
|---|---|
| Critical | 0 |
| Should-fix | 1 |
| Minor | 5 |

## Contract conformance (checked, no finding)

- **Wrapper body diff: one hunk, additions only.** The 193 wrapper body (L326-424) matches the 189 wrapper body (189 L315-394) line for line, plus one inserted block (L390-408: comment, `if`, `raise`, `end if`, blank line). The block sits between the end of the O-1 `if` and the `-- (5)-(7) Parent upsert` comment, as §2.3 asked. The predicate matches §0 and §2.3 exactly: `p_date is null`, both bounds with the NY anchor inline twice, `and not public.auth_is_privileged()`, and errcode `22023`. The message matches §3.2 byte for byte. Nothing is interpolated.
- **Writer body diff: one hunk, inside the NULL arm.** The 193 writer body (L122-301) matches the 189 writer body (189 L140-289), except that the bare `delete from public.eod_entries where submission_id = v_submission_id;` line is replaced by the comment and the CTE (L153-183). The `else` branch, the loop, the on-hand write, the per-entry audit and the envelope are unchanged. The staff CTE's `returning` list, its six-value select and its two left joins are character-identical to the admin branch (L189-207). The CTE drops only the `and e.item_id = any (p_removed_item_ids)` line and adds only the `where not exists (… jsonb_to_recordset(coalesce(p_entries, '[]'::jsonb)) …)` clause. As §2.5 requires, the delete is unconditional and the filter sits on the insert. The hunk's comment text doesn't contain the quoted literal `'Count cleared · vendor: '`, so AC-28's count of 2 is sound.
- **Clauses.** The writer restates `language plpgsql security invoker set search_path = public`. The wrapper restates `security definer set search_path = public`. The builder's catalog readout matches §9.3: writer `prosecdef=f`, `{search_path=public}`, `{postgres=X/postgres}`; wrapper `prosecdef=t`, `{search_path=public}`, `{postgres=X/postgres,authenticated=X/postgres}`.
- **Statement order (§2.2).** `begin`, then `lock_timeout`, then the pre-flight `do` block (55000, naming 189), the writer, its comment, its revoke (verbatim from 189 L296-297, with the required no-op note), the wrapper and its comment, then `commit`. The wrapper has no grant or revoke, as §2.6 decided.
- **Comments.** Each starts with a `spec 193:` sentence, followed by the 189 comment verbatim. I compared both against 189 L292 and L397 by eye, and the builder's scripted check agrees.
- **Header.** It covers both changes, the R2 reasoning, the R9 rule (which rows, same statement, NOT EXISTS vs NOT IN), the pre-flight, PROD-APPLY, ROLLBACK (full and partial), the 189-rollback/R9 interaction from §11, the tests and "no publication change". It also states that `admin_submit_eod` isn't in this migration.
- **R8 / R9 decisions.** Both are correct against the landed 189. O-1 is present at 189 L368-377, so R8 is skipped. The NULL arm at 189 L169-171 is a bare delete, so R9 applies.
- **No surface drift.** No table, policy, publication, edge-function, `db.ts`, store or client-hook change belongs to this spec. (`src/lib/db.ts` shows as modified in the working tree, but that's other sessions' invitation work and isn't in this spec's file list.)
- **New suite.** It covers every arm in §6.1 and §6.5:
  - AC-1, AC-2, AC-13 and AC-14, including the no-parent read-backs.
  - AC-3 and R5 through `state_of` (parent, entries with ids, on-hand for I1 to I4, notifications for S, Frederick's audit count).
  - The AC-4 lint arm, which adds `network` to the regex. That's stricter than the design asked, and fine.
  - AC-6, AC-7 and AC-20.
  - AC-21 under both `Etc/GMT-14` and `Etc/GMT+12`.
  - AC-5: six arms, run after the no-row arms.
  - AC-8 and the R6 structural pins.
  - AC-22 to AC-27, as deltas with tag-scoped helpers. Arm (39) carries the "probe P7 re-run" description, and both the 23514 and the 23505 writer-error arms are present (the §13 tightening of AC-26).
  - AC-28: `prosecdef`, the exact `proconfig`, `proacl is not null`, no grantee 0, three `has_function_privilege` negatives, a two-literal count and a `not exists` pin.
  - `plan(69)` matches arms (1) to (69). The builder's mutation check (23 of 69 fail on the 189 bodies) is the right evidence that the arms bite.
- **Fixture rework (§6.2).** The dates match the design table: cases_each A-10/A-11, no_need A-12/A-13, update_notifications A-14, audit_log W-1 A-15, identity_lock T22 A-16, multi_vendor A-17, role_eod_rls A-18, admin_submit_eod D3 A-19. A grep for the old literals (`1999-11-02`, `1999-12-03/20/26/27/29/30/31`) across the reworked suites finds nothing, apart from the dates the design says to keep (`1999-12-28` out-of-membership, W-3's `1999-12-27`, the `1999-11-01/03/04` direct inserts, and admin_submit_eod's admin-only `1999-12-*`). Pre-deletes are present exactly where the store and vendor persist (cases_each, audit_log W-1, multi_vendor, role_eod_rls) and absent where the vendor is in the transaction (no_need, update_notifications, identity_lock, admin_submit_eod). The "smoke residue" header text was rewritten. A re-grep of `supabase/tests/`, `scripts/` and `e2e/` for `staff_submit_eod` finds no unlisted caller: `reports_anon_revoke` and `eod_submissions_edit_flow` are catalog-only or comment-only, and `e2e/eod.spec.ts` uses `todayIso()`.
- **Jest (§7).** The error fixture is `Object.assign(new Error(MSG), { name: 'PostgrestError', code: '22023', details: null, hint: null })` with MSG declared once and a comment naming the migration, as specified. AC-9 asserts:
  - two RPC calls in FIFO order (`q-old` first);
  - `q-good` dequeued;
  - `q-old` kept with `attempts = 1` and `lastError = MSG`;
  - no `type: 'error'` toast. This matches the dequeue branch's `chrome.queue.syncErrorBanner` toast at `useEodSubmit.ts` L180-181.

  AC-10 asserts `{ kind: 'failed', message: t('eod.toast.failed') }` and an empty queue.
- **Smoke (§8).** It matches §8 point by point:
  - The loopback guard runs before login, has no override, and exits 2.
  - The remote usage line and the "prod-safe" rationale are gone.
  - It has an NY anchor with the BSD/GNU split.
  - `pick_free_date` picks `k ∈ [3, 33]` in uuid-seeded order, separately for `VENDOR_ID` and `NN_VENDOR_ID`.
  - Step 8 reuses the in-window date.
  - Step 8c asserts 400, `.code == "22023"`, the exact `.message`, and no row by client_uuid (not by triple).
  - `trap cleanup EXIT` deletes the run's rows by `CLIENT_UUID`/`PRIME_UUID` with a warn-only failure.
  - No R9 smoke step, as decided.

  The guard's host extraction strips the scheme and any userinfo, then cuts at the first `/ : ?`. The builder's negative probes (`example.supabase.co`, `localhost.evil.com`, `127.0.0.1@evil.com`) are refused, and malformed or bracketed hosts fail closed.

## The builder's stated deviations

### D1. In-transaction vendors V, V2 and VR in the new suite instead of seed vendors plus §6.1 pre-deletes: **accepted, and better than the design**

§6.1 told the builder to resolve a seed vendor V, add a second vendor V2, and pre-delete five triples. §6.5 already used an in-transaction vendor VR for the R9 arms. Moving V and V2 in-transaction too applies the design's own §6.2 rule ("a triple built on an in-transaction vendor can't pre-exist and needs no pre-delete") to the whole file. That removes five pre-deletes, and with them any chance a local leftover row turns a first-submit arm into a replace.

The on-hand claims in AC-3 still mean something. I1 and I2 are linked to V through `item_vendors` (L138-143), and `state_of` snapshots their `current_stock`/`eod_remaining` at 42/42, which differs from every payload value. One side effect is neutral: the wrapper doesn't check the vendor's brand (189 L2, out of scope), and the fixture vendors are in Frederick's brand anyway, so nothing depends on it. No design change is needed beyond noting that §6.1's pre-delete list is moot for this file.

### D2. Wider pre-delete in `staff_role_eod_rls` (every Frederick row at A-18, all vendors): **accepted. This corrects a miss in my §6.2.**

§6.2 asked for a pre-delete of the (store, date, vendor) triple only. But arm (7) (`staff_role_eod_rls.test.sql` L284-293) counts `eod_submissions` by `(store_id, date)` with no vendor filter, and expects 1. A leftover row at (Frederick, A-18, any other vendor) on a non-reset stack would make (7) fail. With the old `1999-12-31` date that couldn't happen. With an in-window date it can. The wider delete is the minimal fix:
- it's scoped to one store and one date;
- it runs as `postgres` inside the rolled-back transaction;
- `eod_entries` cascades, `order_approvals.source_submission_id` is `on delete set null` (spec 178), and there are no delete triggers;
- it changes no assertion.

The fixture comment (L106-112) states the reason. **Design erratum:** §6.2's "Known cases" line for `staff_role_eod_rls` should read "pre-delete every Frederick row at A-18, because arm (7) counts per (store, date)". The code is right and the design text was wrong. I'm not editing the spec in this pass, per instructions.

## Prod apply and rollback notes vs what was built

- **Prod apply (spec top-level section, and §9).** These still match the built artefacts:
  - Pre-check: normalized md5 of both functions against the landed 189 bodies, and record `admin_submit_eod`'s md5.
  - Apply: the body (its pre-flight re-checks 189), then the exact version `20261109190000`.
  - Verify: both md5s, `prosecdef` (wrapper t, writer f), `proconfig {search_path=public}`, `proacl` (wrapper owner + `authenticated`; writer owner only, not NULL), comments start `spec 193:`, the writer `prosrc` holds the literal twice (pinned locally by arm (68)), and `admin_submit_eod` unchanged (the builder recorded the local raw md5 `3dc3f5ab…` as unchanged).
  - The migration header's PROD-APPLY paragraph is an accurate summary that defers to §9.
- **Rollback (§10, the header's ROLLBACK paragraph).** These still match:
  - The two hunks are independent, so the partial rollbacks work as stated. The 189 wrapper alone drops the bound and keeps R9; the 189 writer alone drops R9 and keeps the bound.
  - The writer restore must re-issue 189's revoke, and it does say so.
  - The §11 note that a 189 rollback drops R9 silently is in the header.
- The one gap, push sequencing, is S1 below.

## Findings

### Critical

None.

### Should-fix

**S1. The prod-apply notes don't say "apply on prod before pushing to `main`". Pushing first turns `db-migrations-applied.yml` red.**
Files:
- `supabase/migrations/20261109190000_staff_eod_date_bound.sql` L52-60 (PROD-APPLY);
- spec `## Prod apply` (L255-267) and §9 (L652-667).

The 189 header (`20261109120000_admin_eod_replace.sql` L61) says "execute_sql this body via the Supabase MCP **BEFORE pushing**". The 193 header and the spec's §9 both say only "after the push, confirm the gates". The spec also frames prod apply as "owner, later; not part of this spec's done state". If the commit lands on `main` before the MCP apply, the bi-directional gate hard-fails on `20261109190000` missing from prod. That's the 2026-06-28 failure mode CLAUDE.md calls out.

My design's §9 left this out too, so it's my gap as much as the builder's. **Fix:** add one line to the header's PROD-APPLY paragraph and to §9: "Apply on prod via MCP (after 189 is on prod and verified) BEFORE pushing this commit to `main`, or hold the push until the owner applies it." It's documentation only, with no body change and no md5 effect, because the header sits outside `$$`.

### Minor

**N1. The migration version sorts before other sessions' pending files.**
`20261109190000` sorts before `…191000`, `…195000`, `…200000` (spec 196, staged in this working tree), `…230000` and `20261110120000`. If any of those reaches prod first, 193's version is inserted out of order. That's harmless for the MCP path (an explicit `schema_migrations` insert) and for CI (fresh, filename order), and none of those files touches either function (builder grep). But a `supabase db push` would need `--include-all`, and the builder already had to `psql -f` locally for this reason. Suggest one line in the header next to S1's: "Out-of-order version by design; apply via MCP plus an explicit version insert, not `db push`."

**N2. Smoke step 8b continues after `pick_free_date` fails.**
`scripts/smoke-staff-eod.sh` L429-432. When `NN_DATE` is empty the script calls `fail`, then still primes and submits with `"p_date": ""`. That produces two or three secondary failures that bury the real cause. Wrap the prime/NO NEED block in an `else`, or skip it when `NN_DATE` is empty.

**N3. `pick_free_date` treats a PostgREST error body as "taken".**
`scripts/smoke-staff-eod.sh` L146-151. On a 4xx/5xx, `jq 'length'` of an error object returns its key count (for example 4), not `0`. Every candidate then looks taken, and the script ends with the misleading "no free in-window date; run `npx supabase db reset`". It fails closed, so it's safe, but checking `jq -e 'type == "array"'` first would give an honest message.

**N4. `TODAY` now holds `A - k`.**
`scripts/smoke-staff-eod.sh` L231 and its uses at L249, L319 and L365. The variable keeps its old name and is explained only by the comment at L226-230. Renaming it to `EOD_DATE` would stop a later editor from assuming it's today. This is cosmetic.

**N5. Arm (42)'s scalar subquery depends on arm order.**
`supabase/tests/staff_submit_eod_date_bound.test.sql` L622-631. It selects I1's per-entry row under VR without a delta or a `limit`, and relies on being "the only VR row so far" (as its description says). An arm later inserted before it that writes an I1 row under VR would raise "more than one row returned" rather than fail cleanly. It's correct today. Keying it to the newest row (`order by created_at desc limit 1`, which is safe because `now()` is constant, or better a count of rows matching the exact expected detail) would make it order-independent. This is optional.

## Gates (builder-reported; not re-run here)

- Full pgTAP: 106/106 files pass, and the new suite passes 69/69.
- `npx jest`: 307 suites and 3948 tests pass.
- `typecheck` and `typecheck:test` are clean apart from environmental TS2688 noise from stray `@types/* 2` directories.
- The smoke passes, including 8c, and the guard refuses three non-loopback URLs.

Release-coordinator should treat these as reported, not independently verified, by this reviewer.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 6 findings by severity: 0 Critical, 1 Should-fix (prod-apply notes must say apply before pushing to main), 5 Minor. Both stated deviations accepted; D2 corrects a design miss in §6.2.
payload_paths:
  - specs/193-staff-eod-date-bound/reviews/backend-architect.md
