# Release proposal — spec 157 (super_admin RLS parity + honest DB Inspector banner)

Synthesized by `release-coordinator` from the four reviewer files in
`specs/157-super-admin-rls-parity/reviews/`, read in full, plus the spec at
`specs/157-super-admin-rls-parity.md`.

## Verdict

verdict: SHIP_READY
rationale: Zero Criticals across all four reviewers, both architect Should-fixes
are already applied to the spec, and the only open AC (AC-7, prod apply + gate
re-green) is unsatisfiable before the user's commit by design — it is a deploy
step, not a defect.

### Why the one open AC is not a FIXES_NEEDED

`test-engineer` marks **AC-7 NOT TESTED / NOT YET DONE** and calls it a
"Critical-class gap", but files it under *"Non-blocking process items (not
test-engineer's call, surfacing for the release-coordinator)"* — i.e. it is
handed to this proposal as a sequencing question, not filed as a Critical
finding. Three things resolve it in favour of SHIP_READY:

1. **AC-7 cannot close before the commit.** §10 fixes the order as
   merge → MCP prod apply → gate re-check → owner smoke. Nothing in the working
   tree can advance it. Blocking on it would deadlock the pipeline.
2. **The risk AC-7 was protecting against is already closed.** The Critical-class
   risk here was R-1 ("the repo is not prod"). The dispatcher ran D-0's read-only
   verification against prod `ebwnovzzkwhsdxkpyjka` on 2026-08-09: query (a) →
   exactly 7 rows (no eighth prod-only policy), corrected query (b) → 4 rows,
   none a gate, gate-only regex probe → 0 rows. The spec records
   **"D-0 gate: SATISFIED"**, and `backend-architect` independently ruled
   **"I consider R-1 closed."** So the blast-radius claim that AC-REG-1 pins is
   verified against prod, not just against the migration chain.
3. **The migration is convergent and non-destructive.** Every `create policy` is
   preceded by a `drop policy if exists` of the same name, the function is
   `create or replace`, and the whole body is `begin; … commit;` wrapped — which
   `security-auditor` verified statement-by-statement across all 407 lines closes
   the drop/create window against the non-atomic MCP apply path. A failed or
   partial apply reverts/re-converges rather than leaving a hole.

This is therefore **SHIP_READY-with-mandatory-deploy-steps**: the steps in the
next section are not optional follow-ups. Until step 4 lands, AC-7 stays open and
the RLS bug is still live on prod.

## Findings summary

- **code-reviewer**: 0 Critical, 0 Should-fix, **3 Nits**. Independently diffed all
  seven policy swaps against their source migrations (`20260504173035:160-181`,
  `20260507015244:37-48`) — names, quoted-identifier spelling, `permissive` kind,
  implicit `to public`, and the `auth_can_see_store(store_id)` OR-arms all
  byte-preserved; only the helper token differs. Probe RPC delta confirmed
  additive-only (2 keys). Confirmed `classifyAuthBanner`'s absence-before-false
  rule ordering and that both banned banner strings are gone. Nits: a doubled
  apostrophe in a `comment on policy`, the rollback block not restoring the
  `comment on function` metadata, and a generically-named `auth()` jest fixture
  builder.
- **security-auditor**: 0 Critical, 0 High, 0 Medium, **2 Low** + 1 deploy-time
  condition. Answered the central question arm by arm: each rewritten predicate is
  a provable strict superset adding exactly one principal class
  (`profiles.role = 'super_admin'`) — anon cannot gain, self-promotion is closed by
  the `20260517050000` role-change trigger, `to` role lists and `PERMISSIVE` kind
  unchanged, no store/brand scope dropped, `auth_is_admin()` body untouched
  (comment writes `pg_description`, not `prosrc`), no ORed-neutralization risk, and
  the client privilege value feeds display copy only — never a gate. Re-derived
  AC-8 independently: no allowlist row needed. Lows: (a) `audit_log`
  UPDATE/DELETE remain unscoped by store and the widening adds a second principal
  to that pre-existing hole — concurs with the deferral, but recommends the
  follow-up spec be *filed* rather than left as a `comment on policy`; (b)
  `set search_path = public` omits explicit `pg_temp` — copied verbatim from
  `20260517020000`, explicitly says **do not change it in this spec**.
- **test-engineer**: **18 of 19 ACs PASS; AC-7 NOT TESTED** (prod apply, deploy-
  sequenced — see above). No coverage gaps found. `npm run test:db` 81/81 files
  (new 20-arm suite 20/20), `npx jest` 202 suites / 2203 tests, `tsc --noEmit`
  clean, `typecheck:test` clean. Went beyond re-running recorded commands: re-applied
  the migration a second time via `psql` (idempotency, AC-6) then re-ran the full
  81-file suite, and live-queried `pg_policies` (0 rows naming `auth_is_admin`),
  `pg_get_functiondef`/`obj_description` for `auth_is_admin()`, and the probe body.
  Verified the sharp arms are sharp: AL-7/AL-8 use a store-*scoped* row so they
  cannot pass for the wrong reason, IC-3's documented false-pass is fixed, LINT-1
  scans `pg_policies` only.
- **backend-architect** (post-impl drift): 0 Critical, **2 Should-fix (both
  documentation — BOTH NOW APPLIED, verified in the spec by this review)**, 7 Minor.
  Full contract-conformance table held on every clause. S-1 (stale
  `## Files changed` / "Still owed") — the spec now carries the `### Frontend`
  subsection at `:1583-1593` and strikes items 1 and 3 as DONE at `:1637-1641`.
  S-2 (§10 deploy-window imprecision) — §10 step 5 at `:1420-1425` now states
  Vercel ships at merge rather than on an operator's schedule, that the banner
  shows the neutral `unknown` state in the window, and that the step-6 smoke must
  not run before step 2. **Both Should-fixes are closed.** The architect also
  recorded two places the implementation beat the design (IC-3's dual-name target,
  AL-7/AL-8 asserting on the surviving `detail` rather than a row count) and
  accepted the `prokind='f'`, four-rows, and Ionicons-union corrections as
  improvements on its own design.

**Cross-reviewer agreement:** all four independently confirm the same three
load-bearing facts — the seven swaps are byte-preserving apart from the helper, the
probe change is additive-only, and the classifier's absence-before-false ordering
prevents a false green under deploy skew. No reviewer contradicts another.

## Recommended next steps (ordered)

0. **Pre-commit gate check (CLAUDE.md CI rule).** This coordinator has no `Bash`
   tool and could not run `gh run list`. Before committing, confirm the latest run
   of **both** `test.yml` and `db-migrations-applied.yml` on `main` is green at
   `6dda20c`. If either is already red, stop and surface the run URL — the
   merge→apply red window below is only interpretable against a green baseline.
1. **Commit and push the 5-file diff.** `specs/157-super-admin-rls-parity.md`,
   `supabase/migrations/20260809000000_super_admin_policy_parity.sql`,
   `supabase/tests/super_admin_policy_parity.test.sql`,
   `src/screens/DBInspectorScreen.tsx`,
   `src/screens/__tests__/DBInspectorScreen.test.tsx`. Nothing else — `db.ts`,
   `permissive_policy_lint.test.sql`, `CLAUDE.md`, `app.json` and
   `supabase/functions/**` staying out is itself an AC (AC-8 / AC-REG-5..7).
2. **Expect `db-migrations-applied.yml` to go red immediately.** Known window per
   §10 step 1, not drift. Surface the run URL; do not diagnose it.
3. **Apply to prod via the house MCP flow** (§10 step 2, project
   `ebwnovzzkwhsdxkpyjka`): `execute_sql` the `begin; … commit;`-wrapped body,
   then insert the exact version `20260809000000` into
   `supabase_migrations.schema_migrations` **only after the body commits** (R-3),
   then normalized-md5 verify both touched functions (`auth_is_admin` unchanged,
   `admin_db_inspector_probe` replaced).
4. **Post-apply verification — closes AC-7.**
   - Re-run D-0 query (a) → expect **0 rows**. `security-auditor` names this the
     only remaining evidence that the widening landed on all seven and nowhere else.
   - If anyone re-runs query (b), expect **4 rows, not 0** — the probe still emits
     `is_admin` per AC-11 and `auth_is_admin()` self-matches. Do not read 4 as a
     failed apply (architect M-2).
   - Re-check **both** gates green on `main` *after* the apply. A red migration
     gate is not automatically drift — diff repo migrations against
     `schema_migrations` first, and note CI is pinned to CLI 2.108.0 while local
     `npx supabase` resolves to 2.113.x with a different table format.
5. **Owner smoke (§10 step 6) — do not run before step 3 completes.** Sign in as
   `super_admin`; add / rename / delete an ingredient category and confirm it
   survives a refresh; open DB Inspector and confirm the affirmative banner.
6. **Owner decision on the OQ-5 CLAUDE.md bullet.** Drafted in the spec at
   `:516-522`; agents do not edit `CLAUDE.md` unilaterally. Accept or decline.

### Optional follow-ups, not blocking ship

- File **FUTURE-1** as its own spec rather than leaving it as a `comment on policy`
  (`security-auditor` Low #1): store/brand-scope `admin_update_audit_log` /
  `admin_delete_audit_log`, co-designed with `cleanupOldRecords`' global unfiltered
  retention purge. A `comment on policy` is only visible to someone running `\d+`.
- **LINT-2** (architect M-7): promote the gate-only function-body probe
  (`~* 'not\s+public\.auth_is_admin\s*\(\s*\)'`) into a standing pgTAP arm
  (`plan(21)`). Provably `= 0` on local and prod today, no false-positive surface,
  and it guards the exact regression `20260517020000` had to clean up once.
- **Nits sweep next time either file is touched** (code-reviewer): the
  `cleanupOldRecords''` dangling possessive at `migration:207/216`; the rollback
  block's missing `comment on function` restore step; renaming the jest `auth()`
  fixture builder to `buildAuth()`.
- **Architect Minors** M-1 (`p.prokind in ('f','p')` in the canonical D-0 query),
  M-2 (record the query-(b)-stays-4 expectation in §10), M-3 (CLI-pin clause in
  §10 step 4), M-4 (downgrade R-5 to a resolved note — the var-free qual is a
  one-time filter, and prod `audit_log` is 4,485 rows), M-6 (export `IoniconName`).
  All spec/doc polish.

## Out of scope for this review

- **FUTURE-1 / OQ-3** — `audit_log` UPDATE/DELETE store/brand scoping. Deferred by
  design; `security-auditor` concurs with the deferral and confirms the widening
  grants a `super_admin` nothing they could not already obtain transitively.
- **FUTURE-2 / OQ-4** — honest `error` surfacing in `db.ts`'s three
  `ingredient_categories` writers. Changes optimistic-then-revert semantics at
  every call site; needs its own jest pins.
- **FUTURE-3** — the repo-wide zero-row-write blind spot (PostgREST `204` on an
  RLS-shadowed UPDATE/DELETE is indistinguishable from success throughout `db.ts`).
  A real architectural question; deserves its own spec.
- **`set search_path` / `pg_temp` hardening** — `security-auditor` explicitly says
  do not change it here; if ever hardened it should be a schema-wide sweep.
- **Internationalizing or restyling `DBInspectorScreen`** — AC-14 pins the
  exclusion; the screen stays hardcoded English on the legacy `useColors()` palette.
- **Broadening `auth_is_admin()` itself (option (a))** — rejected in the spec with
  four reasons and pinned by AC-5. Not re-openable without new prod evidence.

## Handoff
next_agent: NONE
prompt: SHIP_READY — 0 Criticals across all four reviewers; both architect
  Should-fixes verified applied; AC-7 (prod apply + gate re-green) is deploy-
  sequenced by design with the D-0 prod gate already SATISFIED. Deploy steps in
  the proposal are mandatory, not optional.
payload_paths:
  - specs/157-super-admin-rls-parity/reviews/release-proposal.md
