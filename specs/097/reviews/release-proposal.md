## Verdict
verdict: SHIP_READY
rationale: All four reviewers cleared spec 097 with zero Criticals; the only open items are pending-by-design release steps (the 2.106.0 Track-2-on-main proof and prod reconciliation), and the two Should-fix items are test-comment polish that does not block ship.

> Conditional note: SHIP_READY is granted on the implementation as-staged. The headline load-bearing acceptance criterion — Track 2 green against CLI **2.106.0** on `main` — is provable ONLY after this change is pushed (the pin bump lives in this very commit). The push + green 2.106.0 Track-2 run is the FINAL GATE; if that run is red, this verdict reverts to FIXES_NEEDED. See "Recommended next steps."

## Findings summary

- **code-reviewer**: 0 Critical, 2 Should-fix, 4 Nits. Both Should-fix are clarity-only, both in the probe `supabase/tests/public_grants_explicit.test.sql`: (1) arm (3)'s comment + `is()` message don't explain why the expected violation count is 1 not 2 (only `authenticated` is revoked; `anon`/`service_role` retain inherited grants) — `:277-304`; (2) arm (4) is mislabeled "negative" in the plan-count block when it is a false-positive guard — `:110`. The 4 nits are comment cross-reference polish (spec-section pointers inside the migration `:52`, a CLAUDE.md heading reference in `test.yml:138`, plan-count counting-convention note `:102-116`, and a "ZERO matches" grep claim that should be scoped to `< 20260618000000` — migration `:21-22`). None are functional; the assertions and migration behavior are correct as written.

- **security-auditor**: 0 Critical, 0 High, 0 Medium, 1 Low (informational, "No action required"). The Low (`migration :161-162`) only notes the audit-table re-lock lists six privileges rather than `revoke all`; the end-state ACL is identical because the broad grant never granted TRUNCATE, and probe arm 6a/6b pins it. All five security-crux questions answered YES/NO-as-required with file:line evidence: TRUNCATE omission durably preserves the spec-041 anti-escalation Critical (`:145-146`, `:187-189`); the spec-093 audit re-lock ordering is correct (revoke at `:161-162` follows the broad grant at `:145-146`); restoring the broad grant exposes NO RLS-locked table (`username_resolve_rate_limit`, `_edge_auth` stay deny-all via RLS); no RLS policy touched; exactly two table-level REVOKEs exist repo-wide and both are handled.

- **test-engineer**: All 9 code-review-time ACs (AC1–AC3, AC5–AC9) PASS. Local suite is **47/47 green** via `npm run test:db`, including the new `public_grants_explicit.test.sql` (10 assertions) and the two formerly-failing guards `auth_can_see_store_brand_scope.test.sql` (arm 14) and `profiles_rls_sweep.test.sql` (arm 12). Developer meta-test confirms the probe is not vacuously passing (re-applying the flawed `GRANT ALL` turned arms 5a/5b/6a/6b red). **Two items PENDING BY DESIGN**: AC4 (prod reconciliation via `supabase db push`) and the load-bearing AC (Track 2 green at 2.106.0 on `main`). Both are operational ship steps, not code gaps; test-engineer explicitly states the release coordinator must not call SHIP_READY until the 2.106.0 run is confirmed green — captured as the final gate below.

- **backend-architect** (post-impl drift): **No drift.** 0 Critical, 0 Should-fix, 0 Minor across all five axes (§1a grants, §1b default privileges, §4 probe, contract/RLS/realtime/edge/db.ts, §5 CI pin). Independently verified the two load-bearing source REVOKEs exist at the cited lines and sort earlier than this migration (`20260517040000:305`, `20260602120000:68`), and that a repo-wide grep finds ONLY this migration issuing a table-level grant to anon/authenticated (no later migration undoes the posture). `plan(10)` matches the 10 authored assertions. Recorded the same two pending-by-design items as non-drift observations for this coordinator.

## Recommended next steps (ordered)

SHIP_READY — exact remaining sequence (main Claude does NOT auto-commit; the user confirms each step):

1. **User commits** the staged change set (migration `20260618000000_public_grants_explicit.sql`, probe `public_grants_explicit.test.sql`, `.github/workflows/test.yml` Track-2 pin + comment, `CLAUDE.md` line 205).
2. **Push to `main`.**
3. **Watch the 2.106.0 Track-2 run (FINAL GATE).** Per the CLAUDE.md "CI status check after every push to `main`" rule, confirm the latest `test.yml` run on `main` is GREEN — specifically the Track 2 `db` job, now pinned to `version: 2.106.0`, must pass all 46/47 pgTAP files against the image that previously failed 34. This is the load-bearing proof the explicit grants work; it cannot be confirmed before the push because the pin bump lives in this commit.
   - **If that run is RED:** surface the run URL, do NOT proceed, and reopen as FIXES_NEEDED. Most-likely diagnosis order: (a) a grant line the local OLD image (`postgres:17.6.1.084`) treated as a no-op behaves differently under the 2.106.0 image; (b) a `public.*` object class the migration didn't cover; (c) the probe's own arms under the revoking image. Do not bump back to 2.105.0 as a "fix" — that re-freezes the project and defeats the spec; fix forward.
4. **Post-merge prod reconciliation (required, user runs — AC4).** Apply migration `20260618000000` to prod via `supabase db push` / `supabase migration up` (NOT the dashboard SQL editor) so its filename lands in prod's `supabase_migrations.schema_migrations`. The body is an idempotent no-op against prod (prod predates the image change and already carries both deliberate REVOKEs), but the filename MUST be present or the `db-migrations-applied.yml` drift gate hard-fails on the next run.

## Non-blocking follow-ups (do NOT block ship; bundle into a later touch of this probe)

These are the code-reviewer's polish items — all comment/message clarity, zero behavior change. They can land as a tiny follow-up PR or be folded into the next edit of these files:

1. (Should-fix, clarity) Probe `:277-304` — add one sentence to arm (3)'s comment and to its `is()` message explaining the expected violation count is 1 because only `authenticated` is revoked while `anon`/`service_role` retain inherited grants, so CI failure output is self-explanatory.
2. (Should-fix, clarity) Probe `:110` — relabel arm (4) from "negative" to "false-positive guard" to match the spec §4c wording and the spec-053 reference probe.
3. (Nit) Probe `:102-116` — make the 1-vs-3 plan-count convention explicit for arms (1)–(4).
4. (Nit) Migration `:21-22` — scope the "ZERO matches" grep claim to `< 20260618000000`.
5. (Nit) Migration `:52` — trim the `§1a/§1b/§7 risk 1` spec-section cross-reference to a self-contained phrase.
6. (Nit) `test.yml:138` — fix the CLAUDE.md cross-reference to the actual section name ("CI status check after every push to main").

## Out of scope for this review
- **The spec-096 empty-`sub_unit_unit` re-model** — a separate deferred spec in the same `>= 20260617000000` migration slot; explicitly out of scope per spec 097 lines 138–144. Do NOT fold in.
- **Pinning/changing the other three CI jobs** (jest, typecheck, typecheck-base) — they do not boot Postgres and are unaffected; out of scope per spec lines 158–160.
- **Retroactive pgTAP coverage of historical Criticals** — a separate tests/README track; this spec adds exactly one probe for one regression class.
- **The `app.json` slug** (`towson-inventory`) — not touched; noted only because this spec edits CI config.
