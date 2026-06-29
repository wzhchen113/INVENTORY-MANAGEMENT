# Release proposal — spec 102 (multi-vendor ingredients)

Synthesized by release-coordinator, 2026-06-29, from the actual reviewer files in
`specs/102/reviews/`. Advisory only — the decision to redo work and to authorize
the prod migration push is the user's.

## Verdict
verdict: FIXES_NEEDED
rationale: test-engineer flagged 3 Criticals (zero pgTAP for AC-A/AC-B/AC-F, all bound by AC-I), and 4 unpushed migrations mean the `db-migrations-applied` CI gate goes red on `main` the moment this lands — both are hard SHIP blockers even though security + architecture review are clean.

## Process gap (read first)
**Only 3 of the expected 4 reviewer files exist on disk.** `specs/102/reviews/`
contains `security-auditor.md`, `backend-architect.md`, and `test-engineer.md`.
There is **no `code-reviewer.md`** (confirmed via Glob + directory listing). My
hard rule forbids synthesizing reviewer findings from a second-hand summary, so I
have NOT fabricated code-reviewer findings — the dispatch referenced a
"code-reviewer edit-mode inline-new-vendor link-deletion bug" that has no backing
file. **Before SHIP, either run the code-reviewer pass and re-synthesize, or the
user explicitly waives the code-reviewer track for this spec.** This does not
change today's verdict (already FIXES_NEEDED on independent grounds), but a
missing quality-review track is itself a gap.

## Findings summary
- **code-reviewer**: NO FILE ON DISK — track did not run (or its output was not written). See process gap above. Not synthesized.
- **security-auditor**: 0 Critical, 0 Should-fix, 2 Nits. `item_vendors` RLS is complete + correct (all 4 commands, USING + WITH CHECK); on-hand reconciliation cannot cross-write stores (admin path RLS-gated on `inventory_items`, staff RPC keeps the spec-061 `auth_can_see_store` gate first); the 3 RPCs have search_path pinned, no dynamic SQL, scoped grants; spec-053 lint stays green; no edge-function/JWT-path change. Nits: (1) `item_vendors` grant lists `references,trigger` beyond the 4 DML verbs (harmless, RLS is the boundary); (2) a `vendors`-only edit can leave zero `is_primary` links — flagged as data-integrity, **explicitly handed to code-reviewer/test-engineer**, not a security boundary.
- **backend-architect**: 0 Critical drift, 2 Should-fix, 4 Nits. Both named traps clean — the reorder + staff RPC bodies copied the LATEST prior bodies with no prior-spec reversion (spec 088 case math + spec 100 i18n + spec 086/061 staff logic all byte-verified present); the 3 on-hand paths now agree on junction membership; the 2 reorder CTE fixes (DISTINCT fan-out collapse, EXISTS-via-junction delivery-offset) are sound; backfill is idempotent/additive/prod-safe. SF-1: `db.fetchWeeklyLowStock` is dead code (zero callers — `WeeklyCount.tsx` forked its own `fetchLowStock`), two hand-maintained mappers for one envelope. SF-2: missing pgTAP for the new multi-vendor behavior, with `staff_submit_eod_cases_each.test.sql:79-83` selecting its mutate-target by scalar `vendor_id` and inserting NO `item_vendors` row → on a CI-fresh DB the new `exists()` predicate is false and the on-hand write is skipped untested (the classic local-green/CI-red asymmetry). N-1: `is_primary` can transiently land zero-primary for a non-form caller (db.ts:360/469).
- **test-engineer**: suites GREEN (jest 721/721, pgTAP 51/51 under BOTH seeded and CI-fresh-truncate states, tsc + typecheck:test clean) — but **3 Criticals are MISSING coverage AC-I explicitly requires, not failing tests**. AC-A backfill idempotency: NOT TESTED in pgTAP. AC-B `item_vendors` RLS non-member denial: NOT TESTED in pgTAP. AC-F junction-membership EOD on-hand write: NOT TESTED in pgTAP (the path the architect said must be updated). Plus 2 Significant (AC-H `report_weekly_lowstock` has zero pgTAP of any kind; AC-G per-vendor-cost-distinguishability + two-vendor explosion not exercised — all 6 reorder tests seed exactly 1 link/item at cost=1) and 1 Minor (AC-E staff test never asserts `from('item_vendors')`). AC-C and AC-D jest coverage is PASS (the KEY counted-in-every-tab case is explicitly asserted).

## De-duplicated cross-reviewer findings
- **Zero-`is_primary` on a `vendors`-only / non-form edit** — raised by **security-auditor (Nit, db.ts:~437-487)** AND **backend-architect (N-1, db.ts:360/469)**. Same root cause: `is_primary` is derived as `l.vendorId === vendorId`, and when the payload omits the scalar `vendorId`, every upserted link gets `is_primary:false`. Both agree the partial unique index still prevents the dangerous case (two primaries), so it leaks nothing and grants no access — it is an SD-1 mirror drift, not a security or build blocker. Merged into fix #5 (Should-fix). Security explicitly handed ownership to code-reviewer/test-engineer.
- **Missing pgTAP for the new multi-vendor behavior** — raised by **test-engineer (Criticals 1-3 + Significants 4-5)** AND **backend-architect (SF-2)**. Same surface. The architect deferred final severity to the test-engineer; the test-engineer rated AC-A/AC-B/AC-F as Critical (zero coverage on AC-I-bound items) and AC-H/AC-G as Significant. Merged into fixes #1-#4 below, severity per the test-engineer's call.

## Required pre-SHIP checklist (ALL must hold — none optional)
This feature is not committed or pushed. SHIP is gated on every step below, in order:
1. Land fixes #1-#4 (the Critical + Significant test-coverage items). Optionally #5-#8.
2. Run the **full** `npx jest` + `bash scripts/test-db.sh` (under BOTH seeded and CI-fresh `truncate item_vendors` states, as the test-engineer did) + `npx tsc --noEmit` + `npm run typecheck:test` — all green. (Behavior-change rule: grep for any suite pinning the old single-vendor shape before running — none should remain per AC-I.8.)
3. **User authorizes the prod migration push.** The 4 new migrations (`20260630000000`–`20260630000300`) are local-applied + verified but NOT yet `db push`ed to prod.
4. `supabase db push` the 4 migrations to PROD. Without this, `db-migrations-applied.yml` hard-fails on `main` (a repo migration missing from prod's `schema_migrations` is exactly the bug spec 064 added that gate to catch).
5. User confirms the commit (main Claude does not auto-commit). Commit + push to `main`.
6. **Confirm BOTH CI gates are green on `main` post-push** — `test.yml` AND `db-migrations-applied.yml` — via `gh run list --branch main --workflow <file> --limit 1` each. A green `test.yml` alone is NOT sufficient (the 2026-06-28 incident: `db-migrations-applied` sat red for days unnoticed). If either is red or in-progress, surface the run URL and wait.

Per the project hard rule, release-coordinator must NOT recommend SHIP_READY while either gate's latest `main` run is not green. Because the migrations are unpushed, that gate WILL be red until step 4 completes — so SHIP is structurally impossible until both the test fixes AND the prod push land.

## Recommended next steps (ordered: Critical → Should-fix → Nit)
FIXES_NEEDED. Blockers (#1-#4) must land before SHIP; #5-#8 are nice-to-have and may ship as follow-ups at the user's discretion.

1. **[CRITICAL — BLOCKER] AC-F junction-membership EOD on-hand write — no pgTAP.**
   `supabase/tests/staff_submit_eod_cases_each.test.sql:79-83` (selects mutate-target by scalar `vendor_id`, inserts NO `item_vendors` row).
   What & why: this is the core spec-102 on-hand reconciliation behavior AND the one path the architect flagged as untested-on-a-fresh-DB. On a CI-fresh `truncate item_vendors`, the new `exists(item_vendors …)` predicate is false → the on-hand write silently skips, untested — the exact local-green/CI-red asymmetry CLAUDE.md warns about. Add a test that inserts an `item_vendors` link and asserts a shared item counted under a (non-primary) vendor actually writes `current_stock` + `eod_remaining`. First because it has live-DB regression risk a green suite is actively hiding.
   Raised by: test-engineer (Critical 3), backend-architect (SF-2).

2. **[CRITICAL — BLOCKER] AC-B `item_vendors` RLS non-member denial — no pgTAP.**
   New test file under `supabase/tests/` (RLS sits in `20260630000000_item_vendors.sql:101-125`).
   What & why: AC-B + AC-I bind pgTAP for the new RLS. Policies look correct by inspection, but a future `create or replace` that misnames `auth_can_see_store` or drops the EXISTS-join WHERE would regress silently, exposing per-vendor `cost_per_unit`/`case_price` cross-store. Assert: a non-member gets 0 rows on SELECT and is denied INSERT/UPDATE/DELETE (42501 / RLS block) on a foreign store's links.
   Raised by: test-engineer (Critical 2), backend-architect (SF-2).

3. **[CRITICAL — BLOCKER] AC-A backfill idempotency + count/cost preservation — no pgTAP.**
   New test file under `supabase/tests/` (backfill in `20260630000000_item_vendors.sql`).
   What & why: AC-A + AC-I bind pgTAP. Verification today is manual only. Assert: (a) a re-run INSERT produces 0 new rows, (b) a vendor-bearing item's link carries its exact cost, (c) a null-vendor item produces 0 links. No regression guard exists for the backfill contract otherwise.
   Raised by: test-engineer (Critical 1), backend-architect (SF-2).

4. **[SIGNIFICANT — BLOCKER] AC-H `report_weekly_lowstock` + AC-G multi-vendor explosion/per-vendor-cost — no/insufficient pgTAP.**
   New test for `20260630000300_report_weekly_lowstock.sql`; extend the 6 reorder tests for `20260630000100`.
   What & why: AC-H RPC has zero pgTAP of any kind (anon-EXECUTE denial, `low_stock=true` branch, `usage_per_day=0` fallback, nearest-delivery) — it breaks the project pattern where every report RPC has at least an anon-revoke test. AC-G is PARTIAL: all 6 reorder tests seed exactly 1 link/item at cost=1, so the OQ-5 fallback (junction cost 0 → item cost), a junction-cost-≠-item-cost producing a distinct `estimated_cost`, the two-vendor explosion (one item under TWO cards), and `other_vendor_count`/`also_from_vendors` are never exercised. Treated as a blocker: AC-I lists AC-G pgTAP as binding and the new explosion is the headline behavior of the spec; shipping it unverified is the same risk class as #1-#3. (If the user wants to ship the AC-H anon-revoke test as the minimum bar and defer the branch tests, that is a user call — but the anon-revoke test at least is non-negotiable for an authenticated-only RPC.)
   Raised by: test-engineer (Significant 4 + 5), backend-architect (SF-2).

5. **[SHOULD-FIX — non-blocking] Zero-`is_primary` on a non-form / `vendors`-only edit.**
   `src/lib/db.ts:360` (`createInventoryItem`) and `src/lib/db.ts:469` (`updateInventoryItem`).
   What & why: when the payload's `vendors[]` has no row matching the scalar `vendorId` (or omits `vendorId`), every upserted link lands `is_primary:false`, leaving the SD-1 mirror with no primary. Not a security/build blocker (the partial unique index permits ≤1 primary, reorder/EOD don't read `is_primary`), but it desyncs the SD-1 invariant the design promised. Defensive fix: "if no row matches the scalar, mark the first row primary" in both writers. De-duped from two reviewers.
   Raised by: security-auditor (Nit, db.ts:~437-487), backend-architect (N-1).

6. **[SHOULD-FIX — non-blocking] `db.fetchWeeklyLowStock` is dead code.**
   `src/lib/db.ts:3048` (zero callers); `WeeklyCount.tsx:121` forked its own `fetchLowStock`.
   What & why: two hand-maintained snake→camel mappers for one envelope (byte-equivalent today, so no behavioral bug) — a future maintainer editing one won't know the other exists. Resolve by deleting the unused db.ts helper + trimming spec §9/§10 to "staff carve-out, mapped in WeeklyCount.tsx", OR wiring WeeklyCount to the db.ts helper. The staff direct-rpc carve-out is permitted by CLAUDE.md, so this is intent-drift cleanup, not a layering violation.
   Raised by: backend-architect (SF-1).

7. **[NIT — non-blocking] AC-E staff test does not assert `from('item_vendors')`.**
   `src/screens/staff/screens/EODCount.test.tsx` (`mockFromCalls` tracked but never asserted).
   What & why: the mock intercepts any table name identically, so a silent revert of `from('item_vendors')` back to `from('inventory_items')` would not be caught by jest. Add one assertion on the queried table. Minor — behavior is implemented and passing.
   Raised by: test-engineer (Minor 6).

8. **[NIT — non-blocking] `item_vendors` grant breadth + prefetch store-filter asymmetry.**
   `20260630000000_item_vendors.sql:73-75` (grant lists `references,trigger`); `src/lib/db.ts:751-755` (admin prefetch has no explicit `store_id` filter, unlike the staff fetch's `.eq('item.store_id', storeId)`).
   What & why: both are sound as written (RLS is the boundary, not the grant; UUIDs make a cross-store collision implausible), flagged only because each reads as an omission to a future maintainer. Tighten the grant to the 4 DML verbs and/or add the explicit store filter for symmetry. No change required for correctness.
   Raised by: security-auditor (Nit 1), backend-architect (N-4).

## Out of scope for this review
- **The pre-existing stale 6-arg `staff_submit_eod` overload** — backend-architect explicitly recommends NOT dropping it in this spec (it is a deliberate fail-loud `errcode=22023` stub for pre-update sibling-app deploys; PostgREST resolves the 7-arg and 6-arg as distinct signatures with no ambiguity). A future cleanup spec that removes it must also drop the GRANT and confirm no caller sends 6 args.
- **Pre-existing high-severity `npm audit` advisories** (`@babel/core`, `@xmldom/xmldom`, `form-data`) — transitive deps unrelated to and untouched by spec 102; `package.json` is not in the staged diff. Belongs in a dependency-hygiene spec.
- **N-2 / N-3 (architect) — `deriveCountedItemIds` crediting DRAFT submissions; staff `fetchLowStock` omitting `as_of_date`** — both documented as intentional/acceptable for an advisory surface; no action.
- **The missing code-reviewer track itself** — surfaced under "Process gap" above; running it (or an explicit user waiver) is a workflow decision for the user, not a code fix.

## Handoff
next_agent: NONE
prompt: FIXES_NEEDED, 4 blocking items, top: AC-F junction-membership EOD on-hand write has no pgTAP (untested on a fresh DB). Security + architecture clean; suites green but 3 Criticals are MISSING AC-I-bound coverage, not failures. Note: code-reviewer.md is absent from specs/102/reviews/ — track did not run; not fabricated. Hard SHIP gate on top of fixes: 4 migrations must be db-pushed to prod (user authorizes) + both CI gates green before SHIP is even possible.
payload_paths:
  - specs/102/reviews/release-proposal.md
