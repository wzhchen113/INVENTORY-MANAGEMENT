## Verdict
verdict: SHIP_READY
rationale: Zero Critical across all four reviewers; both code-reviewer Should-fix items were addressed in the post-review fix-pass (pgTAP arms F+G added; UTC-vs-NY drift kept as architect-approved with a documented follow-up doc patch); security-critical surface is clean; latest `test.yml` on main is green.

## What shipped

**Backend (single new migration `supabase/migrations/20260530000000_record_missed_orders_rpc.sql`):**
- `SECURITY DEFINER` RPC `public.record_missed_orders_for_day(p_date date)` with `search_path = public, pg_temp` + `lc_time = 'C'` set at the function header.
- Idempotency via the architect-corrected `lower(detail) = lower(<computed>)` dedupe predicate (NOT the PM's `(store_id, action, item_ref, created_at::date)` key, which had a backfill-rerun hole — header DEDUPE-KEY block documents the fix).
- Grant lockdown: `revoke execute … from public, anon, authenticated` + `grant execute … to postgres, service_role` (zero session callers; tighter than spec 050's pattern).
- `cron.schedule('record-missed-orders-daily', '0 7 * * *', …)` body computes `((now() at time zone 'UTC') - interval '1 day')::date` (architect post-impl review approved the UTC form — functionally identical at 07:00 UTC vs the design's `'America/New_York'`; UTC is simpler at cron-fire time).
- One-shot 28-day backfill at apply time (`generate_series(today-28, today-1)` inside a `DO $$` block). Atomic + idempotent.
- pgTAP file `supabase/tests/missed_order_audit_rpc.test.sql` — `plan(9)`, arms A (function exists), B (SECURITY DEFINER + grant lockdown via `has_function_privilege` catalog-query, NOT the spec-067 segfault pattern), C.1+C.2 (positive case + row shape), D (matched-day suppression), E1 (idempotency), E2 (3-call backfill simulation), and the two newly-added arms — F (case-insensitive vendor-name match) and G (vendor_id NULL fallback for `item_ref`).

**Frontend (TS / catalog only — no `src/lib/db.ts` change; new rows flow through existing `fetchAuditLog`):**
- `src/types/index.ts` — `'Order missed'` appended to the `AuditAction` union (between `'Stock adjusted'` and the closing `;`).
- `src/utils/formatAuditAction.ts` — `'Order missed': 'orderMissed'` added to `KEY_BY_ACTION`.
- `src/screens/cmd/sections/AuditLogSection.tsx` — `'Order missed': 'warn'` added to `ACTION_TONE`; `inferKind` maps `'Order missed'` → `'order'`.
- `src/i18n/en.json` / `es.json` / `zh-CN.json` — `enum.auditAction.orderMissed` added in all three locales (`"order missed"` / `"pedido omitido"` / `"漏单"`).
- `src/utils/enumLabels.test.ts` — `'Order missed'` appended to the `ACTIONS` drift-guard array, plus two new spot-check tests pinning the es + zh-CN translation values.

**Post-review fix-pass:**
- code-reviewer Should-fix #2a (case-insensitive vendor-name match arm) — FIXED via new pgTAP **Arm F**.
- code-reviewer Should-fix #2b (vendor_id NULL fallback for `item_ref`) — FIXED via new pgTAP **Arm G**. `plan(7)` → `plan(9)`.
- code-reviewer Nit #1 (spec attribution comment in migration header) — fixed.
- code-reviewer Should-fix #1 (UTC vs America/New_York in cron body) — NOT changed; backend-architect post-impl drift review explicitly approved the shipped UTC form; the docs-vs-code divergence in the spec doc is logged for a future doc-only patch.
- code-reviewer Nit #2 (`revoke execute` vs `revoke all`) — left as-is per codebase-dominant convention (22 occurrences vs 2).

**Independent end-to-end verification (main Claude):**
- RPC invocation against a fresh `order_schedule` row → 1 `audit_log` row with correct `detail` / `item_ref` / `value` / `user_id IS NULL` shape; re-run → 0 additional rows (dedupe predicate works).
- Cmd UI (admin@local.test, dark mode, desktop 1440x900) → Audit log section renders the `'Order missed'` row with localized en label "order missed" and architect-locked `'warn'` tone (yellow dot). Full RPC → audit_log → fetch → format → i18n → tone → render chain confirmed.

## Findings summary

- **code-reviewer**: 0 Critical, 2 Should-fix (BOTH addressed in post-review fix-pass — see Resolution block at the bottom of `specs/075/reviews/code-reviewer.md`), 2 Nit (one fixed, one deliberately left per codebase convention). Top issue: missing pgTAP arms for case-insensitive vendor-name match + vendor_id NULL fallback — both now pinned by new Arms F + G.
- **security-auditor**: 0 Critical, 0 High, 0 Medium, 1 Low (follow-up note only — flagging that a future "rerun for date" admin button should go through `callEdgeFunction` / `supabase.rpc(...)` for error-handling consistency; no change required in this spec). All 8 security gates explicitly PASS: `SECURITY DEFINER` + function-level `search_path` + `lc_time` lock; explicit grant lockdown pinned by pgTAP arm B catalog-query; `p_date IS NULL` defense-in-depth refusal raising `P0001`; SECURITY DEFINER intentionally bypasses INSERT RLS (system actor); cron body is static SQL literal (no concatenation, no service-role token); 28-day backfill atomic + idempotent + ~280 rows worst case; no SQLi surface (parameterized concatenation inside `INSERT … SELECT`); audit_log read policy unchanged. `npm audit`: 17 pre-existing vulns, **0 introduced by spec 075** (zero new dependencies).
- **test-engineer**: PASS. 380/380 jest across 39 test files (2 new tests added — es + zh-CN translation pins); 38/38 pgTAP DB files; `tsc --noEmit -p tsconfig.json` exit 0; `tsc --noEmit -p tsconfig.test.json` exit 0. Original NOT-TESTED gap (case-insensitive vendor-name parity) is now CLOSED by the post-review fix-pass's Arm F addition. All 15 acceptance criteria PASS.
- **backend-architect (post-impl)**: 11 PASS, 2 ADVISORY DRIFT (items 7 + 8 — same root cause: pg_cron body + 28-day backfill compute "yesterday" in UTC rather than the design's NY-local; functionally equivalent at the chosen 07:00 UTC schedule hour; multi-region note in the migration body covers the rationale), 0 BLOCK. Security-critical surface clean: grants, search_path, dedupe predicate, audit-log realtime non-change, pgTAP arm-B catalog-query-only — all byte-for-byte match the design. Recommendation: doc-only patch to align the spec file with the shipped UTC form; not a release blocker.

## Recommended next steps (ordered)

1. **Commit and deploy.** The implementation is SHIP_READY. The user authorizes the commit.
2. **Deploy is two-stage — this spec applies a NEW prod migration.** Unlike the recent Vercel-only TS-or-i18n-only specs, spec 075 ships a real DB change: `supabase/migrations/20260530000000_record_missed_orders_rpc.sql`. After the commit lands on main and the Vercel deploy ships the FE changes, the user (or post-merge automation) runs `npx supabase db push --linked` (or the equivalent post-merge migration step) to apply the migration to prod. At apply time the 28-day backfill runs against prod's `order_schedule` (worst case ~280 rows for a 2-store × 5-vendor brand — trivial); after that the pg_cron job `record-missed-orders-daily` starts firing daily at 07:00 UTC. No docker-restart ritual required (audit_log is not in the realtime publication; the migration header explicitly documents this).
3. **(Follow-up, not blocking ship — doc-only)** When anyone next touches this spec, align the spec's design code-block (lines 537-546 + 597-614 of `specs/075-missed-order-audit-log-parity.md`) with the shipped UTC form. The two are functionally equivalent at the 07:00 UTC schedule hour (UTC→NY rollover is 19:00 UTC, so `(now() at NY)::date - 1` and `(now() at UTC)::date - 1` produce the same date at 07:00 UTC for any operational day), but the spec-of-record should match what's deployed. Both backend-architect (item 7) and code-reviewer (Should-fix #1) flagged this — the architect, as design authority, resolved it in favor of keeping the shipped code; the spec doc is the one to patch when it gets re-touched.

## Out of scope for this review

- Per-vendor cutoff-time-aware misses (PM-flagged follow-up — today the spec uses whole-business-day as the atomic unit for "missed").
- Per-store / multi-region timezone handling (PM-flagged follow-up — same brand-TZ approximation as spec 074; the UTC/NY drift in items 7+8 is a v1 tradeoff inside this envelope).
- Realtime push of missed-order rows to AuditLogSection (PM-flagged out-of-scope — adding `audit_log` to `supabase_realtime` would require the docker-restart ritual for a once-a-day event class; new rows surface on next AuditLogSection mount via existing `fetchAuditLog`).
- "System" actor pill in the byUser tab (PM-flagged out-of-scope — `user_id = NULL` rows fall under the existing "—" actor bucket).
- A "rerun for date X" admin panel button (security-auditor Low note — currently no client callsite; `service_role` is granted EXECUTE as defense-in-depth for this future shape).
- `npm audit` dependency cleanup (17 pre-existing vulns through the Expo SDK 54 toolchain — none introduced by spec 075; resolution belongs in a separate Expo upgrade spec).

## Handoff
next_agent: NONE
prompt: SHIP_READY — zero Critical across 4 reviewers; both Should-fix pgTAP gaps closed by Arms F+G; architect approved the shipped UTC form for cron body; doc-only follow-up patch logged. Commit + DB-migration push to prod is the user's call.
payload_paths:
  - specs/075/reviews/release-proposal.md
