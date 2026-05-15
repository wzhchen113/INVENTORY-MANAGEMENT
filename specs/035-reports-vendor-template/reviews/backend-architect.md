# Backend-architect post-impl drift review — Spec 035

Mode: post-impl drift (Status: READY_FOR_REVIEW).
Verdict: no Critical findings; no Should-fix findings; 2 Nits.

## What I walked

- `## Architect design` (§A1-§A11) in
  `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/035-reports-vendor-template/spec.md:555-1190`
- New migration
  `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260514180000_report_run_vendor.sql`
- New pgTAP
  `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/report_run_vendor.test.sql`
- Modified pgTAP
  `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/reports_anon_revoke.test.sql`
- Frontend
  `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/reports/templates.ts`,
  `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/components/cmd/NewReportModal.tsx`,
  `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/reports/ReportDetailFrame.tsx`,
  `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/ReportsSection.tsx`
- Cross-checks against
  `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260514170000_report_run_waste.sql`,
  `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/lib/db.ts`,
  `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/store/useStore.ts`,
  `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions/`,
  `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/app.json`.

## Critical

None.

## Should-fix

None.

## Nits

### N1 — pgTAP arm ordering deviates from §A6 (functional equivalence, sequencing only)

Design §A6 enumerated the 11 plan arms in this order:

1. Fixture sanity (1)
2. Fixture sanity (2)
3. Auth gate
4. Empty range
5. Single-row happy path
6. Missing-cost zero-out
7. Multi-vendor ordering
8. Status filter (unique-to-vendor)
9. by='category'
10. by='item'
11. Envelope shape

The landed file in
`/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/report_run_vendor.test.sql`
ships the arms in this order:

1. Fixture (1)
2. Fixture (2)
3. Auth gate
4. Empty range
5. Single-row happy path
6. **Multi-vendor ordering**         (was §A6 arm 7)
7. **Status filter**                 (was §A6 arm 8)
8. **Missing-cost zero-out**         (was §A6 arm 6)
9. by='category'
10. by='item'
11. Envelope shape

The developer pushed missing-cost down to arm 8 because the multi-vendor
ordering / status filter assertions both run against the same
`_env` temp table inserted at line 137 (before the NULL-cost row is
appended at line 263). The NULL-cost insert mutates state, so it has
to be last among the 2026-06-01-window assertions; otherwise the
multi-vendor ordering arm would also have to model the NULL-cost
contribution. This is the right sequencing for the fixture pattern
the developer chose — the design author (me) didn't fully account
for the shared-temp-table constraint when enumerating §A6.

Coverage is identical to what §A6 specified. Plan(11) hits. No
finding action needed; this nit is documentation-only so future
reviewers comparing the spec to the file don't flag the reordering
as drift.

### N2 — `vendor_a` / `vendor_b` seed-id assumption is documented but worth a watch-line

The pgTAP fixture at lines 58-69 resolves SYSCO + RESTAURANT DEPOT
by *name* lookup against the seed. The fixture comment correctly
notes these are stable in `supabase/seed.sql:204-215`, and the
fixture uses `name =` rather than hard-coded UUIDs (more resilient
to seed-id churn). This is the right call.

The watch-line: if a future seed refresh ever drops or renames either
vendor, arms 5/6/7/9/10 break with a clear "no such row" error
during the `insert into purchase_orders ... (vendor_id, ...)`. The
design didn't flag this fragility explicitly; the developer's choice
to use named lookups already minimises it. No finding action.

## Drift verification against §A1-§A11

| § | Design item | Verified |
|---|---|---|
| §A1 | Filename `20260514180000_report_run_vendor.sql` (next free hour-slot after waste `170000`) | Pass — file exists at the named path. |
| §A2 | Signature `(p_store_id uuid, p_params jsonb) returns jsonb`, `language plpgsql`, `security invoker`, `set search_path = public`, AUTH GATE first statement raising 42501, GRANT/REVOKE shape | Pass — migration lines 99-128, 463-464 match byte-for-byte. |
| §A3 | Header documents 10 design notes including tone-band divergence | Pass — lines 1-97 cover all 10 notes (per-mode named keys, closed-window divergence, snapshot cost, no recursive CTE, tone-band omission, from==to allowed, top-vendor cross-cut, series cross-cut, index reuse, status filter). |
| §A4 | CTE pipeline: shared prelude → columns → totals + top-vendor → empty short-circuit → KPIs → branched rows → series → envelope | Pass — lines 122-460 walk all 10 sections in order. Date anchor `coalesce(po.reference_date, po.received_at::date)` at lines 196, 208-209, 297-298 etc. Status filter `(po.status = 'received' or po.received_at is not null)` at lines 207, 296, 335, 381, 433. Per-vendor series implemented at lines 421-450. All three KPIs emit `"tone": null` at lines 252, 266, 272. |
| §A5 | Dispatcher arm `when 'vendor'` slotted immediately after `'waste'`, all existing arms + fallback preserved verbatim | Pass — migration lines 488-508 vs waste `:440-458`: arm order `stub/cogs/variance/waste/vendor`, fallback identical, `revoke`/`grant` lines re-emitted at 512-513. |
| §A6 | pgTAP plan(11) with arm-by-arm coverage including unique-to-vendor status-filter regression arm; back-fix stale "8 RPCs covered" comment to "10 RPCs covered" | Pass — `report_run_vendor.test.sql:31` plan(11), all 11 arms present (status filter at the file's arm 7, see N1 about ordering). `reports_anon_revoke.test.sql:10-13` shows the stale-header back-fix done correctly ("Header was stale at '8 RPCs covered' pre-spec-035 — spec 034 added the waste arm without bumping the comment; spec 035 fixes that and adds the vendor arm at the same time. Net: comment goes 8 → 10 here."). |
| §A7 | Frontend 4-file wiring: templates flip, ByOption union + BY_OPTIONS + defaultByForTemplate widening in modal, savedBy/effectiveBy/onPickBy/byOpts widening in detail frame, OverrideState['by'] + setOverrideBy widening in ReportsSection | Pass — all four files match the design's per-line specs. Spec 035 callouts in code comments at templates.ts:15, NewReportModal.tsx:71-74, ReportsSection.tsx:35-39, ReportDetailFrame.tsx:56-61/186-194/266-271. |
| §A8 | Cross-cutting: no realtime publication touch, no edge function changes, no `src/lib/db.ts` change, no `src/store/useStore.ts` change, no `app.json` slug change, no new table/index | Pass — grep on db.ts/useStore.ts/functions/app.json confirms zero references to `report_run_vendor` or `Spec 035`. `app.json:4` slug remains `towson-inventory`. |
| §A9 | Verification gates pass | Reported by dispatcher: tsc, typecheck:test, jest 54, pgTAP 17/17, smoke all pass. Not independently re-run by this review. |
| §A10 | `npx supabase db push --linked --yes` is a *post-merge* step, NOT auto-run by the developer | Pass — `## Post-merge deploy` section at spec lines 1245-1251 explicitly: "DO NOT run `db push` automatically — flagged by the backend-developer for release-coordinator to surface in the proposal." Developer correctly did not run it. |
| §A11 | Documented risks accepted | Pass — `idx_po_items_po_id` deferred per design; tone-band omission documented in header; `(no vendor)` vs `(deleted vendor)` discrimination documented in header. No change recommended at ship-time. |

## Boundary check

- `src/lib/db.ts`: no occurrences of `report_run_vendor` or "Spec 035". Untouched.
- `src/store/useStore.ts`: no occurrences. Untouched.
- `supabase/functions/`: no occurrences of `report_run_vendor` or "Spec 035". Untouched (no edge fn work in scope).
- `app.json`: slug still `towson-inventory` per the DO-NOT-AUTO-FIX rule.
- Realtime publication: no `alter publication supabase_realtime add table` statements in the migration. No `docker restart supabase_realtime_imr-inventory` step needed.

## Realtime / edge fn / db.ts / useStore — all untouched

Confirmed. The vendor runner is reachable through the existing
`runReport` PostgREST call against the `report_run(p_template_id,
p_store_id, p_params)` dispatcher; the new `'vendor'` arm makes
the new template reachable without any client-side helper.

## Summary

Implementation matches the design contract end-to-end. No
contract drift, no boundary violations, no security regressions,
no realtime publication footgun. Two nits documented for future
spec-vs-file comparisons (arm-ordering rationale, vendor name-lookup
fragility watch). Recommend SHIP_READY from a backend-architecture
standpoint.

## Handoff

next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix,
  2 Nits.
payload_paths:
  - specs/035-reports-vendor-template/reviews/backend-architect.md
