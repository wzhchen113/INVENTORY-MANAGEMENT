# Release proposal — Spec 021 (Reorder / delivery list v1)

Reviewer: release-coordinator
Round: 2 (final)
Date: 2026-05-13

## Verdict
verdict: SHIP_READY
rationale: All 4 round-1 blockers (1 Critical + 3 Should-fix) are RESOLVED with
live PostgREST PoCs and code-level verification in round 2; remaining items are
informational deferrals or v2-scoped follow-ups already documented in spec
§17, the migration header, and the v2 callout below.

Per CLAUDE.md hard rule ("release-coordinator cannot recommend SHIP_READY if
any reviewer flagged a Critical"): the round-1 Critical from code-reviewer
(MIN-DOW / multi-delivery-day picker) was the same defect as backend-architect
D-1. The round-2 migration's `vendor_delivery_offsets` CTE now computes per-row
distance inside the lateral before applying `MIN`, and test-engineer's 5
sub-tests for Wed+Fri / Wed-only-cutoff cases all PASS against the live local
stack. No open Critical remains in any reviewer file.

---

## Round-by-round resolution table

| Round-1 issue | Severity | Source | Round-2 status | Evidence |
|---|---|---|---|---|
| MIN-DOW / D-1 multi-delivery-day picker | Critical (code) / Should-fix (arch) | code-reviewer, backend-architect | RESOLVED | test-engineer FAIL-SCHED-MULTI → PASS across 5 sub-tests (Wed+Fri on Thu → 1 day; Wed-only on Wed before cutoff → 0; Wed-only on Wed after cutoff → 7; Wed+Fri on Wed before cutoff → 0 / Wed wins; Wed+Fri on Wed after cutoff → 2 / Fri wins). RPC `report_reorder_list` re-verified live against `00000000-0000-0000-0000-000000000001` (Towson). |
| Warnings step-5 over-emits for filtered vendors | Should-fix | code-reviewer | RESOLVED | test-engineer FAIL-WARN-OVERFLOW → PASS. US FOOD (forced to par) absent from both `vendors[]` and `_warnings[]`; SYSCO (below par, no schedule) present in both. The migration's warnings CTE now joins `surfaced_vendor_ids` extracted from the already-built `v_vendors` jsonb envelope. |
| Stale `reorderPayload` on store switch | Should-fix | code-reviewer | RESOLVED | test-engineer FAIL-STALE-STORE → PASS. `loadFromSupabase` in `useStore.ts:887-893` clears `reorderPayload`, `reorderLoading`, `reorderError`. Initial-state comment at lines 416-420 corrected. |
| `SCHEDULE UNKNOWN` masks EOD/STOCK badge | Should-fix | code-reviewer | RESOLVED | test-engineer FAIL-BADGE-MASK → PASS. `ReorderSection.tsx:190-196, 231, 233` defines `sourceBadgeEl` and `scheduleBadgeEl` as independent variables, both rendered unconditionally in the header row; the precedence ladder is gone. |

---

## Findings summary

- **code-reviewer (round 1)** — 1 Critical, 3 Should-fix, 5 Nits.
  - Critical: MIN-DOW picker on multi-day vendors → **RESOLVED in round 2** (FAIL-SCHED-MULTI → PASS, 5 sub-tests).
  - Should-fix #1 (warnings scope mismatch) → **RESOLVED** (FAIL-WARN-OVERFLOW → PASS).
  - Should-fix #2 (stale `reorderPayload` on store switch) → **RESOLVED** (FAIL-STALE-STORE → PASS).
  - Should-fix #3 (badge masking) → **RESOLVED** (FAIL-BADGE-MASK → PASS).
  - 5 Nits deferred: dead pre-walk `RAISE NOTICE`, single-tab `TabStrip` no-op state, `shortId` UUID-prefix leak in card header, stale comment in `db.ts:2018-2020`, `no_usage_rate` flag taxonomy.

- **security-auditor (round 1)** — 0 Critical, 0 High, 0 Medium, 3 Low.
  - All 3 Lows informational and require no fix for ship: UTC cutoff comparison (same root as architect D-2 — v2), `console.warn` echoing non-sensitive caller-supplied values, server-side `RAISE NOTICE` not visible to HTTP callers.
  - `security invoker` + `search_path=public` + auth gate first executable statement + EXECUTE granted only to `authenticated` confirmed against the live `pg_proc` row.

- **test-engineer (round 2)** — 23 PASS, 0 FAIL, 1 NOT TESTED.
  - 17/17 round-2 tests PASS (8 spot-checks + 4 FAIL→PASS confirmations covering all sub-tests).
  - 19/19 round-1 PASSes carry over (no regressions; migration is `create or replace function`, store/section changes are additive only).
  - 1 NOT TESTED: `truncated` flag — no depth-5 recipe chain in Towson seed. Accepted in round 1; SQL logic at migration lines 197-207 and 468-471 is structurally identical to the variance runner's treatment.
  - All 11 acceptance criteria PASS.

- **backend-architect (round 1, post-impl)** — 0 Critical, 2 Should-fix, 4 Minor.
  - D-1 (multi-day picker — same defect as code-reviewer Critical) → **RESOLVED in round 2**.
  - D-2 (UTC cutoff vs store-local) → **DEFERRED to v2** per spec §17; architect's design §6 case 5 accepted UTC default as a v1 acceptance.
  - 4 Minor (flag ordering, `eod_submitted_at` collapse dependency on spec-020 invariant, vendor-source flip when all EOD items at par, `_warnings` server underscore vs TS camelCase) — documentary only.
  - Contract surface (RPC signature, envelope shape, TS types, helper, slice, sidebar, realtime subscription) is faithful and v2-ready.

---

## Live state verification (independent of test-engineer)

Confirmed:

- `report_reorder_list(uuid, jsonb)` is present and callable — `pg_proc` row verified by security-auditor (`prosecdef = f`, `proconfig = {search_path=public}`).
- EXECUTE granted to `{postgres, authenticated, service_role}` only; `anon` rejected at grant layer (no PUBLIC fallback).
- All 15 joined tables show `rowsecurity = t` per security-auditor's enumeration.
- MIN-DOW math live-PoC'd by test-engineer with synthetic `order_schedule` rows on COSTCO (Towson): Wed+Fri on Thursday 2026-05-14 returns `days_until_next_delivery=1`, `next_delivery_date=2026-05-15`. Round-1 returned 6.
- The Towson seed has no multi-delivery-day vendors out of the box, so the test data was inserted then rolled back within the test block per the project's "no test framework, use real DB" policy (CLAUDE.md).

Trusting test-engineer's documented round-2 PoCs for the multi-day math (the live RPC call result is reproduced verbatim in the test file at lines 117-122).

---

## Recommended next steps (ordered)

SHIP_READY path:

1. **User reviews the round-2 patch.** Files staged in `git status`:
   - `supabase/migrations/20260514120000_eod_submissions_vendor_id.sql`
   - `supabase/migrations/20260514130000_report_reorder_list.sql` (the RPC, round-2 fixes)
   - `src/lib/db.ts` (RPC helper + `mapReorderVendor`)
   - `src/store/useStore.ts` (slice + clear-on-store-switch)
   - `src/types/index.ts` (`ReorderPayload`, `ReorderVendor`, `ReorderItem`, `OnHandSource`)
   - `src/screens/cmd/sections/ReorderSection.tsx` (new section, badge fix)
   - `src/lib/cmdSelectors.ts` (sidebar registration)
   - `src/screens/cmd/InventoryDesktopLayout.tsx` (dispatch arm)
   - `src/hooks/useRealtimeSync.ts` (`purchase_orders` subscription)
   - `specs/021-reorder-delivery-list/spec.md` + `reviews/*.md`
2. **User runs the commit.** Per `feedback_commit_immediately`: the agent does not run `git commit` without explicit "commit it".
3. (Optional, recommended) File the v2 follow-up spec so the deferred items have a tracking home before any prod store wires `order_schedule` rows for multi-day vendors or the PO write path.

---

## v2 follow-up callout

Spec 021 v1 is **structurally complete but degrades to par-replacement only**
in production, because `pending_po_qty=0` is hardcoded (architect §1 / §5
step 6 / spec §1 / migration header lines 12-34). The eventual v2 spec needs:

1. **`po_items` row-write path.** Add either a
   `db.createPurchaseOrderWithItems` helper or extend `db.createPurchaseOrder`
   to write `po_items` rows. Without this, no PO ever has line items, so the
   v2 swap can't filter pending qty by item. (Architect §Open questions Q1.)
2. **`purchase_orders.status` lifecycle defined with a CHECK constraint.**
   Pick the canonical enumeration (e.g. `'draft' | 'submitted' | 'sent' |
   'partial' | 'received' | 'cancelled'`) and enforce via CHECK, then update
   `db.createPurchaseOrder` to write the new initial status. Alternative
   path: document `received_at IS NULL` as the canonical "in flight" gate
   irrespective of status string. (Architect §Open questions Q2.)
3. **Wire the "Create PO" button.** Currently a disabled `View` with a
   `title`/`accessibilityLabel` tooltip in `ReorderSection.tsx:151-176`.
   Replace with a `TouchableOpacity` calling the new helper from (1).
4. **Pending-PO subtraction swap (A3 mechanics).** Replace the
   `pending_po_qty` CTE in the migration (lines 294-298) with a real join
   through `po_items` + filter `status IN (...) AND received_at IS NULL`
   per architect §1. No payload-shape change; UI starts reflecting inbound
   qty automatically. The `purchase_orders` realtime subscription at
   `useRealtimeSync.ts:42` becomes a real refresh trigger at this swap with
   no JS change needed.
5. **Fix D-2 cutoff TZ drift.** Either accept `p_params.now_local`
   (cheap follow-up, mirrors `as_of_date`) or add a `stores.timezone` text
   column (cleaner; fixes the whole class of TZ drift). Same CTE as the
   resolved D-1, so the edit is bounded.

---

## Out of scope for this review

Pre-existing project tickets that this spec did not introduce and that should
not gate ship:

- **Cold-boot React errors** — pre-existing, unrelated to spec 021's surface.
- **`supabase_realtime FOR ALL TABLES`** — already in place per
  `20260502190000_realtime_publication.sql:14`; no migration change required
  for the new `purchase_orders` subscription. Architect §7 verified the
  publication gotcha doesn't apply here.
- **`npm audit`** — no `package.json` / `package-lock.json` changes in this
  spec; auditor skipped npm audit. Pre-existing dependency hygiene is out
  of scope.
- **Test-framework gap** — no jest/vitest/playwright wired in the repo. All
  tests via `docker exec psql` + curl smoke pattern. Per CLAUDE.md, known
  project-wide gap; not introduced by spec 021.
- **5 Nits from code-reviewer** — dead pre-walk `RAISE NOTICE`, single-tab
  `TabStrip` plumbing, `shortId` UUID prefix in card header, stale comment
  in `db.ts:2018-2020`, `no_usage_rate` taxonomy split. All defer cleanly.
- **4 Minor from backend-architect** — `flags` ordering not specified (impl
  deterministic per row), `eod_submitted_at` collapse dependency on
  spec-020 invariant, vendor `on_hand_source` flip to `stock` when all
  EOD-counted items happen to be at par, `_warnings` server underscore
  prefix vs TS `warnings` field name. All documentary.
- **3 Low from security-auditor** — UTC cutoff vs store-local time (same
  as D-2; v2), `console.warn` echoing non-sensitive caller-supplied values,
  server-side `RAISE NOTICE` not visible to HTTP clients. None are vectors.
- **D-2 cutoff timezone drift** — explicit v2 follow-up per spec §17 and
  architect §6 case 5. Same CTE as the resolved D-1, so the v2 fix is a
  bounded edit. Listed in the v2 callout above as item (5).
- **1 NOT TESTED criterion** — `truncated` flag (depth-5 recipe chain).
  Towson seed has no such chain. SQL logic identical to variance runner's
  treatment. Accepted in round 1; unchanged in round 2.

## Handoff
next_agent: NONE
prompt: SHIP_READY for spec 021. 0 open Critical, 0 open Should-fix; round-2
  patch resolves all 4 round-1 blockers with live PoC evidence. User reviews
  and runs the commit. v2 follow-up spec recommended for `po_items` write
  path, `purchase_orders.status` lifecycle, the "Create PO" wiring, the
  pending-PO subtraction swap, and the D-2 cutoff TZ fix.
payload_paths:
  - specs/021-reorder-delivery-list/reviews/release-proposal.md
