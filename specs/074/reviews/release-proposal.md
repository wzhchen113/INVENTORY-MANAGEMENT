# Release proposal — spec 074

## Verdict

verdict: SHIP_READY
rationale: 0 Critical across all reviewers, both Should-fix items already addressed in the post-review fix-pass, test-engineer added 2 discriminating tests on top of the implementer's 19 and reports 378/378 green with both `tsc` configs exit 0, latest `test.yml` on `main` is green.

## Summary

Spec 074 swaps the Dashboard `unconfirmed_po` rule from a fixed 4..7-day lookback to a Monday-reset week-window computed in the store's configured IANA timezone (`useStore.timezone`). The change is contained to:

- `src/utils/weekWindow.ts` (NEW pure helper — UTC-anchored Date math; `getWeekWindow`, `isoDateRange`, `getLocalDateISO`).
- `src/utils/weekWindow.test.ts` (NEW — 11 tests + 1 added by test-engineer for DST fall-back symmetry).
- `src/lib/cmdSelectors.ts` (signature: `timezone: string` inserted before optional `now`; the `unconfirmed_po` loop iterates `[mondayStart, today)` in tz; inline comment pins the intentional tz-aware-here / tz-naive-elsewhere split as per architect's mitigation).
- `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts` (NEW — 8 tests + 1 added by test-engineer for today-exclusion + the structural-invariant refactor of the originally vacuous out-of-window assertion).
- `src/screens/cmd/sections/DashboardSection.tsx` (reads `timezone` slice, threads through call, adds it to the queue `useMemo` deps).

No backend, RLS, RPC, edge function, migration, realtime, or `db.ts` surface is touched, so security-auditor and post-impl backend-architect were correctly skipped.

### Verification evidence

- `jest --no-coverage`: 378/378 across 39 suites green (376 from implementer + 2 added by test-engineer).
- `tsc --noEmit -p tsconfig.json`: exit 0.
- `tsc --noEmit -p tsconfig.test.json`: exit 0.
- Visual non-regression confirmed by main Claude at desktop viewport 1440x900, dark theme, signed in as `admin@local.test`: per-store ATTENTION QUEUE tightened from the user's prod-screenshot baseline of "11 items per store" to "2 items per store" — the dropped 9 per store are `unconfirmed_po` rows older than this Monday. 0 `unconfirmed_po` rows currently surface in local dev because the seed only has 2 `order_schedule` entries (Frederick + Thursday) and the food-cost variance heatmap is all-zero — same data-sparse signal, NOT a filter defect. Filter correctness is pinned by 21 spec-074 unit tests with hand-crafted fixtures.
- Latest `test.yml` run on `main` (spec 073, run 26670268827): exit 0.

### Residual Nit (not blocking, surfaced for visibility)

- code-reviewer Nit #1 (`weekWindow.ts` header — return-shape divergence from architect's original `{ weekStartISO: string; todayISO: string }` ISO-string sketch vs the as-shipped `{ mondayStart: Date; nextMondayStart: Date }` Date objects). The fix-pass added a JSDoc paragraph explaining the rationale (Date arithmetic is cheaper than repeated parse/format at the single consumer); the divergence itself is intentional and documented. Same applies to `isoDateRange(Date, Date)` vs the spec draft's `(string, string)` shape — TS CI confirms internal consistency. Leaving as-is.

## Findings summary

- **code-reviewer:** 0 Critical, 2 Should-fix, 3 Nits. Both Should-fix items addressed in the post-review fix-pass (default-arg restored on `getWeekWindow`; vacuous out-of-window assertion refactored into a structural invariant — every emitted id's ISO suffix >= `weekStartISO`, which would fail if `pastISOsInWindow` were accidentally widened). All 3 Nits also addressed (JSDoc note on return-shape divergence; "Monday on a Monday" test now asserts full week shape; "Sunday night" test comment spells out the EDT->UTC offset). Verdict was effectively SHIP-clear before the fix-pass and is unambiguously clear after.
- **security-auditor:** SKIPPED (correctly — pure frontend; no auth, no input surface, no DB or edge function path).
- **test-engineer:** PASS on all 9 acceptance criteria. Final suite: 378/378 / 39 suites green. Added 2 discriminating tests: (a) DST fall-back symmetry pin (Nov 2026 in NY; symmetric with the existing spring-forward test) and (b) today-exclusion test asserting today's date does NOT appear in the queue even though it's in the current week — this would FAIL if the `< todayISOInTz` filter were removed from `cmdSelectors.ts:880`, closing the discriminating-test gap the code-reviewer flagged.
- **backend-architect (post-impl):** SKIPPED (correctly — `cmdSelectors.ts` is a pure selector over already-loaded state, not a `db.ts` loader / route; no contract surface to drift against).

## Recommended next steps (ordered)

1. **Commit the staged changes.** The commit is the user's to authorize. Suggested message scope: spec 074 ship; references both the implementer's 19 tests and test-engineer's +2.
2. **Push to `main`.** Vercel auto-deploys the web bundle on push — no manual prod step beyond merge.
3. **After push, confirm the `test.yml` run on `main` goes green** (per CLAUDE.md "CI status check after every push to `main`" rule).

### Deploy notes

- **NO prod migration applies for this spec.** Pure frontend; no `supabase/migrations/*.sql` touched, no edge function deploy, no `db-migrations-applied` workflow impact. Vercel handles the web ship on push.
- **No realtime publication change** — no `docker restart supabase_realtime_imr-inventory` step is needed locally or in prod.
- **No `app.json` touch** — slug stays as-is per CLAUDE.md "DO NOT AUTO-FIX" rule.

## Out of scope for this review (follow-ups flagged, do not block ship)

1. **Tz-naive drift in sibling rules.** `eod_missing` (cmdSelectors.ts lines 753-784) and `food_cost_streak` (lines 814-848) still derive `todayISO` from `now.toISOString().slice(0,10)` — tz-naive — while the new `unconfirmed_po` block is tz-aware. This is a pre-existing inconsistency (predates spec 074) and is explicitly out of scope per the spec body's "No other attention rule's window changes" clause. The architect's mitigation — an inline comment in cmdSelectors.ts above the `unconfirmed_po` block — landed and protects against drive-by "fixes" by a future reader who sees the two windows side-by-side. A dedicated spec to align all three rules on a shared tz-aware ISO derivation is a candidate follow-up.

2. **AuditLog parity for missed-order events.** The user's original "look back on logs" intent (that motivated this spec) can't actually look back through `AuditLogSection` today, because missed-order events are NOT in `AuditAction` — the audit log tracks user actions, not system-derived alerts. Building a missed-order log surface is a separate, larger feature; PM-flagged as follow-up #1 in the spec body. `AuditLogSection.tsx` is intentionally untouched here.

## Handoff

next_agent: NONE
prompt: SHIP_READY — spec 074 (Dashboard Attention Queue weekly window — Monday-reset in store timezone). 0 Critical, 0 outstanding Should-fix, residual Nit is intentional and documented. 378/378 jest tests green, both tsc configs exit 0, visual verification confirms the per-store queue tightened from "11 items" to "2 items" per the user's prod screenshot. Pure frontend — no prod migration. Commit is the user's to authorize.
payload_paths:
  - specs/074/reviews/release-proposal.md
