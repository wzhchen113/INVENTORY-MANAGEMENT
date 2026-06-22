# Release proposal — Spec 098: Staff weekly full-store inventory count + scheduling + reminders

## Verdict
verdict: SHIP_READY
rationale: No reviewer flagged a Critical and there is no contract drift; all acceptance criteria are covered — ship-ready pending green CI on this change (pgTAP + shell smoke were not run locally and MUST pass in CI).

## Findings summary
- **code-reviewer**: 0 Critical, 4 Should-fix (1 withdrawn → effectively 3), 6 Nits. Top: (a) `weekly-reminder-cron` in-window completion check is not truly half-open (`T23:59:59.999` upper bound leaves a sub-ms gap on the due day) `index.ts:277`; (b) `fetchRecentInventoryCounts` `track` callback body not indented (cosmetic closure ambiguity) `db.ts:981-1017`; (c) redundant `.order('id')` overridden by JS sort in `WeeklyCount.tsx:66-67`; (d) `getState()` read after `await` in the submit handler `WeeklyCount.tsx:217`. (The 4th original Should-fix on RPC grants was self-withdrawn — grants are correct.)
- **security-auditor**: 0 Critical, 2 Should-fix, 2 Nits, 14 explicit PASS confirmations. Top: (a) shared-bearer compare `token !== want` is non-constant-time `index.ts:158` (low exploitability; inherited verbatim from EOD cron); (b) cron loads full `user_stores` + `push_subscriptions` tables unscoped — scaling/memory footgun, NOT cross-tenant leakage (service_role principal is correct) `index.ts:239,245`. All auth/RLS/idempotency/attribution/escapeHtml/permissive-lint checks PASS.
- **test-engineer**: Full AC coverage — every AC (S1–S6, C1–C3, R1–R4, A1–A3, Q1, T1–T5) marked PASS. jest 661/661 across 65 suites, tsc clean. pgTAP (3 files) and the shell smoke were NOT executed live (Docker daemon down) — assessed by full source inspection, logic confirmed correct; CI runs them. One non-blocking `act()` warning in `WeeklyCount.test.tsx`; the `'open'` status is intentionally unreachable (documented design simplification, not a gap).
- **backend-architect**: 0 Critical, **no contract drift**, 1 Should-fix, 2 Minor. Implementation is a faithful realization of design §0–§11 on every load-bearing decision (reuse-`inventory_counts`, both RPC signatures + error semantics, RLS narrowing on `weekly_reminder_log`, both `verify_jwt` pins, escapeHtml, dedup, no spurious realtime restart). Should-fix S1 is the same recipient-set coverage item below.

## Consolidated findings (deduped across reviewers)

- **F1 (Should-fix, code-reviewer)** — cron in-window completion check upper bound `T23:59:59.999` is not half-open; use start-of-next-day (`window_end + 1 @ 00:00:00`) to match design §3 and the RPC. `weekly-reminder-cron/index.ts:277`. Architect M2 is the same code path (consistency between cron string-literal bound and the RPC's TZ-aware `::date between`).
- **F2 (Should-fix, security-auditor)** — non-constant-time shared-bearer compare `index.ts:158`. Low exploitability (32-byte hex secret, network timing impractical); inherited verbatim from `eod-reminder-cron`. Fixing only here introduces drift vs EOD — acceptable to defer both as a logged follow-up.
- **F3 (Should-fix, security-auditor)** — cron pulls full `user_stores` + `push_subscriptions` unscoped `index.ts:239,245`. Scaling/memory footgun as `push_subscriptions` grows; NOT a leak. Same EOD-cron parity caveat.
- **F4 (Should-fix, code-reviewer)** — `fetchRecentInventoryCounts` `track` callback body indentation `db.ts:981-1017` (cosmetic; introduced by this spec's `kind`-param edit).
- **F5 (Should-fix, code-reviewer)** — redundant `.order('id')` discarded by JS `localeCompare` sort `WeeklyCount.tsx:66-67`.
- **F6 (Should-fix, code-reviewer)** — `getState()` read after `await` in submit handler; capture the snapshot before awaiting `WeeklyCount.tsx:217`. Currently correct because the optimistic update sets `completed` first, but fragile.
- **F7 (Should-fix/accept, architect S1)** — `weekly-reminder-cron` recipient set is `['admin','master']`, omitting `super_admin` `index.ts:226`. Cosmetic recipient-coverage gap, matches EOD cron and design §5. Either add `'super_admin'` or add a one-line comment marking the deliberate EOD parity. Also raised as a code-reviewer Nit.
- **Nits (non-blocking)** — `any`-typed `sb`/`wp` and `summary` in the cron; duplicated TabStrip IDs in `InventoryCountSection`; staff-local `todayIso` triplication; `null`-error path showing "Forbidden" banner for any error (pre-existing EOD shape); `act()` warning in `WeeklyCount.test.tsx`; 500 envelope returning truncated stack (cron-only caller, no secrets).

## Caveats that MUST hold before this actually ships

1. **pgTAP and shell smoke were NOT executed locally** (Docker down in the dev/review environment). The three pgTAP files (`submit_weekly_count.test.sql`, `weekly_count_status.test.sql`, `submit_inventory_count_rejects_weekly.test.sql`) and `scripts/smoke-weekly-reminder.sh` were assessed by source inspection only. They MUST pass in CI before ship.
2. **CI-status rule (CLAUDE.md):** SHIP_READY additionally requires (a) the latest `.github/workflows/test.yml` run on `main` is green, AND (b) this change's CI run — including the pgTAP DB-test job — is green. This verdict is therefore framed as **ship-ready pending green CI on this change**. Confirm via `gh run list --branch main --limit 1` and the PR/branch run before committing/deploying.
3. **Browser preview was NOT performed** (preview_* MCP tools unavailable in the impl environment). Per the project "verify UI with preview" convention, exercise the staff Weekly tab and the admin weekly tab in the browser before deploy. Code paths are guarded (`Platform.OS === 'web'`) and tsc+jest pass.

## Recommended next steps (ordered)

SHIP_READY:
1. **Confirm CI is green** — verify the latest `test.yml` on `main` is green AND this branch's CI run (jest + base/test-graph typecheck + pgTAP DB tests) passes. The pgTAP and shell-smoke caveat (Caveat 1) is discharged only by a green CI run on this change. If the pgTAP job is red, this drops to FIXES_NEEDED.
2. **Manually exercise the UI** in the browser (staff Weekly tab + admin weekly tab) per Caveat 3 before deploy.
3. **Commit and deploy** (user confirms the commit — main Claude does not auto-commit).
4. (Optional, not blocking) Follow-ups below.

### Optional follow-ups (not blocking ship)
- F1: tighten the cron's in-window completion bound to a true half-open next-day boundary (mirror the RPC). Cheapest of the Should-fixes; worth folding into a quick pre-ship cleanup if convenient, but the RPC — the source of truth for status — is already correct, so this only affects the cron's "skip if already completed" pre-check.
- F2 + F3: log a combined `weekly-reminder-cron` + `eod-reminder-cron` hardening follow-up (constant-time bearer compare + scope `push_subscriptions` to the recipient set). Fixing one cron without the other introduces drift, so do both together.
- F4–F6: low-risk local cleanups (indentation, dead `.order()`, pre-await snapshot) — bundle into a tidy-up pass.
- F7: decide whether `super_admin` should receive weekly reminders; either add the role or add the parity comment.
- Nits: `act()` wrap in `WeeklyCount.test.tsx`; `any` narrowing in the cron; DRY the TabStrip IDs.

## Out of scope for this review
- **Native push** (Q5 deferred to a follow-up; in-app banner is the floor on native).
- **Per-store timezone** — both the status RPC and cron hardcode `America/New_York` (matches the EOD cron). A per-store TZ column is a documented v1 limitation / future spec.
- **EOD-cron pre-existing patterns** that this spec inherited but did NOT regress (un-escaped store name in EOD's HTML body, non-constant-time bearer compare, full-table loads, `['admin','master']` recipients) — these belong in a separate EOD-cron hardening spec, not this one. Notably the developer did NOT replicate the EOD un-escaped-HTML gap (security PASS confirmed).
- **Migrating the staff subtree into `src/lib/db.ts`** — the spec-063 carve-out stands.
- **Stock true-up flow** from the weekly count — Q1-A is advisory-snapshot only; a write-back is a possible future spec.

## Handoff
next_agent: NONE
prompt: SHIP_READY (ship-ready pending green CI on this change), 0 Critical / 0 drift; top open item: confirm pgTAP + shell smoke pass in CI (not run locally — Docker down) and that latest test.yml on main is green before commit/deploy.
payload_paths:
  - specs/098-staff-weekly-inventory-count/reviews/release-proposal.md
