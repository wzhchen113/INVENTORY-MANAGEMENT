# Release proposal — Spec 129 (EOD vendor status + submit/edit flow)

## Verdict
verdict: SHIP_READY
rationale: No reviewer flagged a Critical; all ACs PASS, and every code-reviewer Should-fix was resolved and re-verified before this synthesis.

## Findings summary
- code-reviewer: 0 Critical, 3 Should-fix, 4 Nits. All 3 Should-fixes resolved post-review — (#1) success/success-replay near-duplicate + skipped authoritative reconcile and (#2) fragile SUBMITTED_LOCKED transition on a swallowed post-submit refetch were fixed together via a shared `enterLockedAfterWrite` that synthesizes a local `existing` from just-written entries first (deterministic lock even if refetch fails), then refines from the refetch, then does the authoritative `fetchSubmittedVendorIds` reconcile; (#3) inert status-badge accessibilityLabel fixed by adding `accessible` + `accessibilityRole="image"` to both badge variants. 4 nits remain, non-blocking (misleading `testID="eod-submit"` on the Edit button, badge-lookup duplication, corner-badge padding on long vendor names, read-vs-write `dateIso`/`countIso` comment).
- security-auditor: not run — deliberate skip. Zero new backend surface: no migration, RPC, or edge function; the only new data access is a scoped, RLS-gated `select vendor_id from eod_submissions` on the staff's own store+date, governed by the existing `auth_can_see_store` policy. No new attack surface justified a full audit.
- test-engineer: all ACs PASS, 0 FAIL, 0 NOT TESTED. EODCount + submittedStatus 56/56; full jest 1298/1298 across 121 suites; `tsc --noEmit` and `typecheck:test` clean; i18n parity confirmed for new `eod.edit`/`eod.cancel`/`eod.status.*` keys across en/es/zh-CN. Minor non-blocking gaps: no dedicated "partial-but-unsubmitted stays red" fixture (holds by construction — the Set is only populated by a confirmed/queued submit) and no dedicated single-vendor-badge test (spec marked that variant optional).
- backend-architect: 0 Critical, 0 Should-fix, 2 Minor. Drift review confirms all 5 requested points hold (no backend change, helper matches design, state machine matches, navigate-to-Reorder removed on all branches + queued optimistic-green, badge additive/not unified with the spec-126 notification red). Minor notes: the benign `status='submitted'` predicate beyond the design query shape, and the now-moot success-replay reconcile note (resolved by the `enterLockedAfterWrite` refactor).

## CI gate status
- Frontend-only change; `test.yml` is the applicable gate on push and evidences green locally (jest 1298/1298, typechecks clean).
- No migration on disk for this spec, so `db-migrations-applied.yml` should stay green (unchanged). Confirm both gates' latest `main` runs are green after push per the CI-status-check rule before closing out.

## Recommended next steps (ordered)
Since SHIP_READY:
1. Commit and push (user confirms the commit — no auto-commit).
2. After push, verify the latest run of both `test.yml` and `db-migrations-applied.yml` on `main` is green before considering the pipeline closed.
3. (optional, non-blocking follow-ups) Rename the Edit button `testID` from `eod-submit` to `eod-edit`; extract a shared `VendorStatusDot` component to remove the multi/single-vendor badge duplication; add a named regression guard test that types partial cases/units without submitting and asserts the chip stays red; add a single-vendor-badge test.

## Out of scope for this review
- Corner-badge padding vs. long `numberOfLines={1}` vendor names (cosmetic, pre-existing padding untouched by this spec) — belongs in a chip-layout polish pass, not this ship.
- Reconciling the one-predicate difference between `submittedStatus.ts` (filters `status='submitted'`) and `fetchExistingSubmission` (does not) — only relevant if a future spec introduces staff-written drafts; not reachable through the current staff surface.
- Any amber "pending sync" per-chip state — architect explicitly deferred this; the footer `QueueIndicator` remains the authoritative not-synced signal for v1.

## Handoff
next_agent: NONE
prompt: SHIP_READY
payload_paths:
  - specs/129-eod-vendor-status-edit-flow/reviews/release-proposal.md
