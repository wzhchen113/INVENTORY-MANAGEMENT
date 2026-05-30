# Release proposal — spec 077 (housekeeping: stale test comments + spec-075 doc drift)

Pure housekeeping, zero runtime behavior change: test-comment edits, one type-correct
literal swap (`'fine' as ItemStatus` → `'ok'`) in a never-invoked test stub, and a
markdown doc patch aligning the spec-075 design block with the as-shipped UTC migration.
No security-auditor / post-impl backend-architect ran — correctly skipped (no
auth/RLS/RPC/migration/backend surface).

## Verdict
verdict: SHIP_READY
rationale: No Critical from any reviewer, the one Should-fix + one Nit are both fixed in the post-review pass, tests/typechecks green, and the latest test.yml on main is green.

## Findings summary
- code-reviewer: 0 Critical, 1 Should-fix, 1 Nit — both resolved in the post-review fix-pass (see Resolution block). Should-fix: a factual error the reviewer's own context flagged in main Claude's doc-patch ("UTC→NY rollover at 19:00 UTC" — wrong; NY midnight is 04:00–05:00 UTC); both occurrences in `specs/075-…md` corrected to "NY midnight is 04:00–05:00 UTC, before the 07:00 fire time." Underlying equivalence argument was always sound. Nit: test-file comment "above" → "within" the unconfirmed_po block — fixed. Verified `cmdSelectors.ts` runtime selector and `20260530000000_record_missed_orders_rpc.sql` migration both unmodified.
- security-auditor: not invoked — correctly skipped (no auth/RLS/RPC/migration/edge-function/backend surface).
- test-engineer: PASS. `npx jest` 40 suites / 386 tests green (unchanged from spec-076 baseline — no regressions, no accidental new tests); `tsconfig.json` and `tsconfig.test.json` both exit 0. `'fine'`→`'ok'` swap confirmed behavior-preserving (empty `inventory` ⇒ stub never invoked; both values keep `low_out_stock` silent). "No new tests" call confirmed correct — no pinnable surface in a comment, a behavior-preserving literal swap, or a markdown doc.
- backend-architect (post-impl): not invoked — but this spec IS the application of the architect's spec-075 post-impl recommendation (doc-only patch aligning the spec with the shipped UTC form; migration untouched).

## Recommended next steps (ordered)
1. Authorize the commit — the commit is the user's to make. No prod migration: this is a pure frontend test-fixture + markdown change; Vercel deploys on push.
2. No follow-ups. This clears the last of the deferred-nit backlog logged across specs 074 / 075 / 076 — no new specs spawned.

## Out of scope for this review
- Nothing. All three changes were the deferred cleanups themselves; reviewers surfaced no new out-of-scope items.
