# Release proposal — Spec 016 (Reports Runner Foundation, REPORTS-1) — Round 2

## Verdict
verdict: SHIP_READY
rationale: All Critical and High findings from earlier rounds are resolved (cross-store INSERT spoof closed by trigger; PostgrestError text leak closed by sanitization; `ran_by` forgery closed by the round-3 unconditional trigger override `new.ran_by := auth.uid()`); no reviewer currently flags a Critical, and the remaining items are informational Mediums, Lows, and nits that do not gate this spec.

## Why

Per CLAUDE.md hard rule, the release-coordinator cannot recommend SHIP_READY if any reviewer flagged an unresolved Critical. Reading the actual review files in full:

- **backend-architect** (`reviews/backend-architect.md`) — drift-only review, **no block**. The implementation is faithful to the design contract for REPORTS-1. Three approved drifts (`revoke from public, anon` widened to close the inherited PUBLIC grant trap, `fetchLatestRun.storeId` made optional, hand-rolled SVG line chart instead of react-native-chart-kit) all preserve the design's intent and follow existing codebase precedent. REPORTS-2 and REPORTS-3 inherit a clean foundation (per-template RPC convention documented inline at `20260510120000_report_runs.sql:21-49`, dispatcher slots reserved at `:240-241`, indexes already covering both saved-definition and ad-hoc reads).

- **code-reviewer** (`reviews/code-reviewer.md`) — round 1: **0 Critical, 3 Should-fix, 6 nits**. Per round-2 test-engineer verification (STORE-3-REVERT, FE-RDF-3-ACCENT, FE-RS-7-ACCENT, FE-RDF-2-TYPED), all 3 Should-fix items are closed in the round-2 patch. The 6 nits remain unaddressed but are stylistic (`|| []` defensive fallbacks on never-undefined slices, `isToneKey` redundancy, comment accuracy on the UPDATE policy, `title` HTML attribute spread into a style prop, array-index row keys, pre-existing `'#000'` literals in `NewReportModal`).

- **security-auditor** (`reviews/security-auditor.md`) — round 2: **0 Critical, 1 carry-over High (PARTIAL), 2 Medium informational, 4 Low informational**. The round-1 Critical (cross-store INSERT spoof) is **fully resolved** by the BEFORE INSERT/UPDATE trigger — verified live across four exploit vectors (canonical spoof, wrong-template variant, fabricated UUID, UPDATE re-point). Round-1 High #2 (PostgrestError text leak) is **fully resolved** by the `db.runReport` sanitization at `src/lib/db.ts:1672-1678`. Round-1 High #1 (`ran_by` audit-trail forgery) was PARTIAL after round 2 because `default auth.uid()` only fires on column omission. **Main Claude landed a round-3 one-line fix that closes the carry-over.**

- **test-engineer** (`reviews/test-engineer.md`) — round 2: **34 PASS / 0 FAIL / 0 NOT TESTED** across 27 original ACs + 7 round-2 ACs. No BLOCK.

### Round-3 fix verification (read directly from the migration source)

`supabase/migrations/20260510130000_report_runs_consistency.sql:48-88`:

```sql
create or replace function public.report_runs_check_definition_consistency()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
...
begin
  -- Override any client-supplied `ran_by` with the authenticated caller.
  -- The column-level `default auth.uid()` only fires on omission; this
  -- closes the case where a client explicitly names `ran_by` in the body.
  new.ran_by := auth.uid();          -- ← line 61, FIRST executable statement

  if new.definition_id is null then
    return new;                      -- ← line 64, early return for null definition_id
  end if;
  ...
```

Confirmed: `new.ran_by := auth.uid()` (line 61) executes **before** the early return for null `definition_id` (line 64) and before the consistency check (lines 67-84). A forged `ran_by` value in a hand-crafted PostgREST body — including the auditor's round-2 reproduction with `99999999-9999-9999-9999-999999999999` — is overridden with `auth.uid()` from the JWT sub regardless of whether `definition_id` is null or non-null. The header comment at lines 22-30 of the migration documents the intent explicitly. The trigger function remains `security invoker` with `set search_path = public` locked, so no new attack surface is introduced.

The cross-store consistency block at lines 67-84 still fires after the override, so the round-2 Critical fix continues to hold.

Note on independent live DB verification: my tool grants in this turn are limited to `Read` and `Write`. Round-2 security-auditor verification transcripts at `reviews/security-auditor.md:146-360` confirm the trigger is installed (`tgenabled='O'`), `prosecdef = f` (security invoker), `proconfig = {search_path=public}`, `column_default = auth.uid()` on `ran_by`, and that all four exploit vectors raise `42501`. The round-3 patch is a one-line addition to the same trigger function whose installation those transcripts verified, and the change is plainly visible in the migration source I read directly. The round-3 spec note from main Claude documents the live re-verification (forged `ran_by = 99999999-9999-9999-9999-999999999999` overridden to JWT sub's actual UUID, cross-store block still firing).

## Findings summary

- **backend-architect**: 0 Critical, 0 High, 3 approved drifts (load-bearing widening of `revoke from anon` → `revoke from public, anon`; optional `storeId` on `fetchLatestRun`; hand-rolled SVG chart). No block. Forward-compat clean for REPORTS-2/3.
- **code-reviewer**: 0 Critical, 3 Should-fix (all closed in round-2 patch per test-engineer verification), 6 nits (deferred — stylistic, not blocking). No block.
- **security-auditor**: 0 Critical, 0 unresolved High after round-3 fix (round-1 Critical RESOLVED via trigger; round-1 High #2 RESOLVED via sanitization; round-1 High #1 RESOLVED via round-3 unconditional trigger override). 2 informational Mediums and 4 informational Lows remain (see "Pre-existing issues" below).
- **test-engineer**: 34 PASS / 0 FAIL across 27 original ACs + 7 round-2 ACs. No coverage gaps that block. No automated test framework (project policy — requires user approval before introducing one). All acceptance criteria from the spec verified pass.

## Round-by-round resolution table

| Finding (origin)                                                                | Severity | R1                  | R2                          | R3                    |
|---------------------------------------------------------------------------------|----------|---------------------|-----------------------------|-----------------------|
| `report_runs` cross-store INSERT spoof (forged `definition_id`)                 | Critical | OPEN                | **CLOSED** (trigger)        | (held)                |
| `error_message` may surface raw PostgrestError text cross-tenant                | High     | OPEN                | **CLOSED** (sanitize)       | (held)                |
| `ran_by` audit-trail forgery (default fires only on omission)                   | High     | OPEN                | PARTIAL                     | **CLOSED** (override) |
| Error revert deletes pre-existing good run (`runReport` catch)                  | Should   | OPEN                | **CLOSED** (`prev` snapshot) | (held)               |
| Inline `'#000'` on RUN button (low contrast in light mode)                      | Should   | OPEN                | **CLOSED** (`C.accentFg`)   | (held)                |
| Inline `'#000'` on `+ NEW REPORT` button                                        | Should   | OPEN                | **CLOSED** (`C.accentFg`)   | (held)                |
| `as any` cast to read `params.range`                                            | Should   | OPEN                | **CLOSED** (typed lookup)   | (held)                |

All Critical, High, and Should-fix items closed.

## Pre-existing issues to track separately (NOT blocking REPORTS-1)

These were surfaced by reviewers but are not introduced by this spec. They should be addressed in dedicated follow-up specs, not retrofitted into REPORTS-1.

1. **~436 React `Maximum update depth exceeded` errors during cold-boot of the Inventory section** (code-reviewer pre-existing finding; test-engineer round-1 retained note #2). Predates Spec 016. Recommend a separate investigation spec — likely a useEffect/setState loop in an Inventory section component.

2. **`supabase_realtime` publication is `FOR ALL TABLES`** (security-auditor Medium informational; test-engineer round-1 retained note #3). Established by `20260502190000_realtime_publication.sql`, so `report_runs` is replicated whether the spec wanted it or not. RLS still gates per-store visibility, and now that the round-2 trigger closes the cross-store spoof the realtime channel cannot propagate forged-row poison. No realtime consumer reads `report_runs` today. Recommend revisiting publication scope as a separate hardening spec; do not retrofit here.

3. **6 pre-existing `npm audit` advisories in dev tooling** (security-auditor round 1; unchanged round 2). Expo CLI / Metro / build pipeline. None introduced by Spec 016. `package.json` and `package-lock.json` unchanged this spec. Track via a tooling-upgrade spec.

4. **`report_run_stub` reachable to all authenticated users** (security-auditor Medium informational, both rounds). Stub returns hardcoded dummy data; data-leak risk is zero. Will be rendered moot when REPORTS-2 lands and the `'stub'` arm becomes dead code. No action this spec.

5. **`title` HTML attribute spread into the `style` prop on the RUN button** (code-reviewer nit). Tooltip silently does not render on web. Consider `accessibilityHint` for REPORTS-2 if a tooltip is wanted.

6. **Array-index row keys in the result table** (code-reviewer nit). Acceptable while the table is read-only; revisit when REPORTS-2/3 introduce sortable rows.

7. **Pre-existing `'#000'` literals in `NewReportModal.tsx:108, 192`** (code-reviewer out-of-scope nit). Predates this spec's accent-text path. Cleanup pass.

## Recommended next steps (ordered)

1. **User reviews the round-3 patch** — `supabase/migrations/20260510130000_report_runs_consistency.sql` (edited in place, not committed) and the new "Round-3 carry-over fix" section in `spec.md`. Verify the migration matches expectations.

2. **User confirms commit.** Per CLAUDE.md ("Main Claude does not auto-commit on SHIP_READY. The user confirms the commit."), the commit step is the user's decision. Suggested commit scope: the round-2 patch + round-3 fix together (migration `20260510130000_report_runs_consistency.sql`, `src/lib/db.ts` sanitization, `src/store/useStore.ts` `prev`-snapshot revert, `ReportDetailFrame.tsx` and `ReportsSection.tsx` accent-color and typed-range fixes, `spec.md` round-3 note).

3. **After commit, REPORTS-2 (COGS template) is the next spec for `product-manager`.** The forward-compat checklist in `reviews/backend-architect.md` (lines 280-292) confirms REPORTS-2 inherits a clean foundation — adding `report_run_cogs` plus a single `when 'cogs' then` arm in the dispatcher, flipping `templates.ts` status from `'preview'` to `'live'`, and adding a date-range picker that lands in the existing `params jsonb` column. No schema or RLS change required.

4. **(Optional, not blocking)** Open follow-up specs for the pre-existing issues above (Inventory cold-boot loop, realtime publication scope, dev-tooling vuln upgrade).

## Out of scope for this review

- Changing `Status:` in the spec — owned by the developer/PM, not the release-coordinator.
- Auto-committing on SHIP_READY — explicitly disallowed by CLAUDE.md.
- Adding a test framework — requires user approval per CLAUDE.md.
- Modifying `app.json` slug, `useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`, or `AdminScreens.tsx` — all explicitly off-limits per CLAUDE.md.
- Path B (moving the `report_runs` INSERT into the dispatcher RPC) — track as a forward-compat consideration for REPORTS-2 if COGS RPC latency makes the two-step race material.

## Handoff
next_agent: NONE
prompt: SHIP_READY — all Critical / High / Should-fix closed; user reviews round-3 patch (`supabase/migrations/20260510130000_report_runs_consistency.sql`) and confirms commit.
payload_paths:
  - specs/016-reports-runner-foundation/reviews/release-proposal.md
