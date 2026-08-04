## Test report for spec 151

Scope: "Last-order context on count and ordering rows" — the new
`report_last_order_context` RPC, the pure `buildLastOrderContext` formatter,
and the context sub-line on the phone (`VendorOrderCard`, serving both
`PhoneOrdering` and `PhoneApproveOrder`) and desktop (`ReorderSection`)
ordering surfaces. Reviewed against both the acceptance-criteria section and
the backend-design addendum (§0 rulings R-A..R-I, §10 test map) in
`specs/151-last-order-context.md`.

### Acceptance criteria status

**A. The context line — content and honesty**

- AC-1 (the line) → PASS — `src/utils/lastOrderContext.test.ts::sentence variants (AC-1/AC-7/AC-8/R-I) > AC-1`; rendered via i18n in `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.lastOrderContext.spec151.test.tsx::AC-1` (both surfaces) and `src/screens/cmd/sections/__tests__/ReorderSection.lastOrderContext.spec151.test.tsx::AC-15`.
- AC-2 (anchor selection, deterministic, pinned) → PASS — `supabase/tests/report_last_order_context.test.sql` arms A1–A4 (tier walked row-by-row, each on an isolated vendor with adjacent-tier candidates present so tier is proven to dominate, not inferred from deletes), X1/X2 (cancelled/pending excluded), T1–T4 (tie-breaks + strict `<` window + NULL-`reference_date` legacy fallback).
- AC-3 (confidence label) → PASS — `lastOrderContext.test.ts::AC-2 tiers → AC-3 confidence qualifier` (all 4 tiers) + component pin `PhoneOrdering.lastOrderContext.spec151.test.tsx::AC-3`; i18n keys `lastOrderNotConfirmed` present in all 3 catalogs.
- AC-4 (units, case-aware) → PASS — `lastOrderContext.test.ts::AC-4 unit rendering (R-H)`. Note: AC-4's literal test text ("13 CS"/"13 lb" from the *same* base number) is arithmetically impossible as written; the design's R-H ruling reinterprets it as one base value through both branches (`78/6→"13 CS"`, `13/1→"13 lb"`) and the test is written exactly that way — a faithful resolution of an unfixable AC, not a shortcut.
- AC-5 (no cost in the line) → PASS by construction — `LastOrderQty`/`LastOrderLine` types carry no cost field, `buildLastOrderContext`'s `Pick<>` cannot see `costPerUnit`/`estimatedCost`; confirmed by `AC-10 — never fabricate` test asserting the rendered string never contains injected cost-adjacent sentinel values.
- AC-6 (counted from the anchoring count only) → PASS — pgTAP F1–F4 (`source_submission_id` precedence, R-E NULL-fallback, PO reference_date match, non-`submitted` status excluded); "forbidden substitutions" (current_stock, inventory_counts, reorder payload) verified absent by code read of the migration (no such table/column referenced anywhere in the function body).
- AC-7 (counted missing) → PASS — pgTAP L3 (`jsonb_typeof(...) = 'null'`, not `0`); jest `lastOrderContext.test.ts::AC-7` + component pin in both `PhoneOrdering.lastOrderContext.spec151.test.tsx::AC-7` and `ReorderSection` desktop row (no-counted line covered by the same formatter test; desktop-specific AC-7 rendering not separately pinned but rides the identical `lastOrderSentence` call — low risk).
- AC-8 (item not on that order) → PASS — pgTAP L4; jest `lastOrderContext.test.ts::AC-8` + `PhoneOrdering.lastOrderContext.spec151.test.tsx::AC-8 / R-10` (also proves it never renders "ORDERED 0").
- AC-9 (no anchor at all → card-level line, once) → PASS — pgTAP X1/X2 (vendor structurally omitted); jest `lastOrderContext.test.ts::lastOrderCardState — R-G tri-state`, `PhoneOrdering.lastOrderContext.spec151.test.tsx::AC-9` (asserts exactly 1 occurrence via `queryAllByText`), `ReorderSection.lastOrderContext.spec151.test.tsx::AC-9` (same, desktop footer strip).
- AC-10 (never fabricate) → PASS — type-level enforcement (`Pick<ReorderItem, 'itemId'|'caseQty'|'unit'|'onHand'|'flags'>` on the formatter's `item` arg) plus a runtime pin (`lastOrderContext.test.ts::AC-10 — never fabricate`) that injects `suggestedUnits: 999` etc. onto the item and asserts the rendered output never contains `999`. SQL side: no `inventory_items.current_stock` / `inventory_counts` reference anywhere in the new migration (verified by reading the full function body).

**B. Trend marker**

- AC-11 (delta) → PASS — `lastOrderContext.test.ts::AC-11 delta` (up/down/same, non-case-row unit rendering); component pins in both phone (`AC-11`) and desktop (`AC-11`) test files.
- AC-12 (delta suppressed on stock fallback) → PASS — `lastOrderContext.test.ts::AC-12 — SUPPRESSED when the vendor fell back to stock`; component pins in both phone and desktop suites. Row-grain tightening (R-F, `eod_missing_for_item` flag) → PASS — `lastOrderContext.test.ts::R-F — SUPPRESSED at ROW grain...` plus a negative control (`an unrelated flag does NOT suppress the marker`) proving the suppression is keyed on the specific flag string, not "any flag present." The flag itself (`eod_missing_for_item`) is confirmed to be a real, already-shipped signal from `report_reorder_list` (present in migrations back to `20260514130000_report_reorder_list.sql`), not an invented one.
- AC-13 (neutral, non-prescriptive) → PASS — delta i18n keys (`lastOrderDeltaUp/Down/Same`) contain no imperative copy in any of the 3 catalogs (manually inspected); render code uses `C.fg3` exclusively for both the qualifier and the delta (`grep` of `ReorderSection.tsx`/`PhoneOrdering.tsx` shows no `C.danger`/`C.ok`/`C.warn` on these nodes).

**C. Surfaces**

- AC-14 (phone — one insertion point) → PASS — `PhoneApproveOrder.tsx` has a zero-line diff (`git diff` empty), and `PhoneOrdering.lastOrderContext.spec151.test.tsx` runs its full assertion set via `describe.each` over `[PhoneOrdering, PhoneApproveOrder]`, which is the executable proof: forking `VendorOrderCard` would fail the approve-screen half of every case in that file.
- AC-15 (desktop) → PASS — `ReorderSection.lastOrderContext.spec151.test.tsx::AC-15`; line placed below `BreakdownLine` per code read (`ReorderSection.tsx:845-874`).
- AC-16 (phone a11y bar) → PASS — `PhoneOrdering.lastOrderContext.spec151.test.tsx::the context line never adds a tappable target (AC-16)` pins `onPress`/`accessibilityRole` undefined and `numberOfLines={1}`. The "flex:1 parent, no horizontal scroll" layout claims are verified by source read (the line sits inside the existing `flex:1, minWidth:0` container at `PhoneOrdering.tsx:420`) rather than an executable layout assertion — RN Testing Library has no layout engine, so this is the same verification ceiling every other a11y-bar spec in this codebase has hit; not a gap specific to this spec.
- AC-17 (graceful degradation) → PASS — `lastOrderContext.test.ts::lastOrderCardState — R-G tri-state` (null→hidden); `useStore.lastOrderContext.spec151.test.ts::AC-17` (rejected fetch → `console.warn` only, `Toast.show` NOT called, `reorderPayload`/`reorderError` untouched, promise still resolves so a `void` caller can't unhandled-reject); component pins in both phone (`R-G / AC-17 — renders NOTHING while the context is null`) and desktop (`R-G / AC-17 — a null context renders nothing at all`) suites, each also asserting the underlying order line/row is untouched.

**D. Backend — the read**

- AC-18 (new RPC, `report_reorder_list` frozen) → PASS — `report_reorder_list` has zero diff (migration diffstat shows only the one new `20260803000000` file); the new RPC is genuinely separate.
- AC-19 (contract shape) → PASS — pgTAP field-by-field assertions (`source_id`, `last_order_date`, `confidence`, `source`, `counted_date`) across A1–A4/F1–F4/L1–L4; the "no anchor → omitted, not null-dated" question is resolved (R-D) and pinned by X1/X2 (SQL) and `lastOrderCardState` (FE).
- AC-20 (per-store authorization) → PASS — pgTAP Z1 (foreign-brand store), Z2 (unknown store id, same refusal — no existence leak), Z3/Z4 (non-privileged caller: `order_approvals`-sourced anchor invisible, PO-sourced anchor still resolves — proves the privilege conjunct is a row filter, not a feature gate, matching the R-B design decision) and P5 (`prosecdef = false`, i.e. genuinely `security invoker`, structurally pinned against a future flip to `definer`).
- AC-21 (no new RLS policy, lint stays green) → PASS — full `permissive_policy_lint.test.sql` run green with zero diff to that file (no allowlist row added); new suite's own P1 arm independently re-checks the five source tables for trivially-wide permissive policies.
- AC-22 (input bounds) → **PARTIAL**. Vendor-id-count bound → PASS (pgTAP B1: 101→`22023`; B2: 100→ok; B3/B4: `{}`/`null`→`vendors: []`, no exception; jest `db.lastOrderContext.spec151.test.ts::AC-22 — over 100 vendors`). **Per-vendor item-count bound (≤500, `items_truncated`) → NOT TESTED.** No pgTAP fixture seeds >500 items for one vendor to exercise the `rn <= 500` filter or the `items_truncated := total_n > 500` flag against real SQL execution; the only place `itemsTruncated` is exercised is the jest `db` mapper test, which hand-supplies `items_truncated: true` in a stub envelope — that tests the snake→camel mapping, not that the backend actually enforces the cap. See Notes.
- AC-23 (indexed reads, no N+1) → PASS — pgTAP P4 (`idx_eod_entries_submission_id` exists) plus the single-`_ctx`-temp-table-for-18-vendors pattern in the test file structurally proves one call covers many vendors; jest `ReorderSection.lastOrderContext.spec151.test.tsx::AC-23 — ONE call for MANY vendors` and the derived-string-key no-refetch-on-replay test.
- AC-24 (client call path) → PASS — `fetchLastOrderContext` wrapped in `useInflight.getState().track(..., { kind: 'read', label: 'fetchLastOrderContext' })` with `.abortSignal`; `git diff` of the touched surface files shows zero new `supabase.from/rpc` call sites outside `db.ts`.

**E. Regression group**

- AC-REG-1 (`report_reorder_list` byte-frozen) → PASS — zero diff to the file (verified via migration diffstat and `git diff` on the function name across all touched migrations).
- AC-REG-2 (suggested quantities unchanged, display-only) → PASS — `ReorderSection.lastOrderContext.spec151.test.tsx::AC-REG — keeps the ORDER input seeded from suggestedUnits with the context present`; the existing `applyReorderEdits`/`setReorderEditQty`/`poCaseDisplay` suites all still green in the full `npx jest` run.
- AC-REG-3 (phone/desktop fork intact) → PASS — new case in `PhoneOrdering.acReg.test.tsx::the last-order context line lands on the tier that is actually rendering` mounts the SAME `ReorderSection` at both `mockTier='phone'` and `mockTier='desktop'` and asserts each tree carries only its own testID; the existing `PhoneOrdering.acReg`/`ReorderSection.acReg`-style suites (the ones with `+5` line diffs) still pass unmodified in assertion content.
- AC-REG-4 (spec-149 Approve Order behavior) → PASS — `PhoneApproveOrder.tsx` zero-line diff; `PhoneOrdering.lastOrderContext.spec151.test.tsx::AC-REG — ...PhoneApproveOrder keeps its single primary + disclosure with context null` pins `phone-approve-primary`/`phone-approve-disclosure` present with `lastOrderContext: null`.
- AC-REG-5 (extension contract frozen) → PASS — `extension/` directory zero diff (`git diff --stat` empty); this repo's PO/approval read paths (`get_pending_extension_orders`, `get_extension_order_payload`, `upsertVendorDraftOrder`, `markPurchaseOrderSent`) untouched — no migration or `db.ts` diff touches them.
- AC-REG-6 (staff surface untouched) → PASS — `src/screens/staff/` zero diff.
- AC-REG-7 (no realtime publication change) → PASS — the new migration contains no `ALTER PUBLICATION`/`supabase_realtime` statement (grepped); no `docker restart supabase_realtime_imr-inventory` was required or performed for this test pass, consistent with the spec's own claim.

**F. i18n**

- AC-25 (three catalogs, parity green) → PASS — all nine keys (`lastOrderFull`, `lastOrderNoCounted`, `lastOrderNotOrdered`, `lastOrderNotOrderedNoCounted`, `lastOrderNotConfirmed`, `lastOrderNone`, `lastOrderDeltaUp`, `lastOrderDeltaDown`, `lastOrderDeltaSame`) present under `section.reorder.*` in `en.json`/`es.json`/`zh-CN.json` (independently verified by direct JSON inspection, not just trusting the diff); `src/i18n/i18n.test.ts::i18n catalog parity > en, es, zh-CN have identical key sets` passes in the full run. The R-I fourth key (`lastOrderNotOrderedNoCounted`, beyond AC-25's working set) is present and used — a correct, in-spirit extension.
- AC-26 (no string concatenation across locales) → PASS — `lastOrderSentence`/`lastOrderDeltaText` each select ONE full-sentence key per variant and interpolate `{date}`/`{counted}`/`{ordered}`/`{qty}` via `T(key, vars)`; `NOT CONFIRMED` and the delta marker are separate sibling `<Text>` nodes in both `ReorderSection.tsx` and `PhoneOrdering.tsx` (confirmed by source read), not string-joined into the sentence.

**G. Tests (spec 022 tracks)**

- AC-27 (jest) → PASS — `src/utils/lastOrderContext.test.ts` (pure formatter, all sub-bullets present), `src/lib/db.lastOrderContext.spec151.test.ts`, `src/store/useStore.lastOrderContext.spec151.test.ts`, `PhoneOrdering.lastOrderContext.spec151.test.tsx`, `ReorderSection.lastOrderContext.spec151.test.tsx`, and the `acReg` addition all exist and are green.
- AC-28 (pgTAP) → PASS with the one item-cap gap noted under AC-22 above — `supabase/tests/report_last_order_context.test.sql`, 32/32 assertions green.
- AC-29 (shell smoke, N/A) → PASS (confirmed N/A) — `supabase/functions/`, `scripts/smoke-edge.sh`, `scripts/smoke-rpc.sh` all zero-diff; no shell smoke was invented, correctly.

### Test run

```
$ npx tsc --noEmit
(clean, no output)

$ npm run typecheck:test
> tsc -p tsconfig.test.json --noEmit
(clean, no output)

$ npx jest
Test Suites: 189 passed, 189 total
Tests:       1923 passed, 1923 total
Snapshots:   2 passed, 2 total
Time:        5.816 s

$ npm run test:db
...
== supabase/tests/report_last_order_context.test.sql ==
  PASS supabase/tests/report_last_order_context.test.sql (32 assertion(s) passed)
...
✓ 80/80 DB test file(s) passed

$ npx expo export --platform web
Web Bundled 382ms node_modules/expo/AppEntry.js (1932 modules)
Exported: dist
(clean — no bundling/import regression on the Vercel path)
```

All four gates match the numbers claimed in the spec's own "Verification" sections exactly (189/1923 jest, 80/80 DB files incl. 32/32 new, clean typechecks). Local migration `20260803000000` confirmed present in the local `supabase_migrations.schema_migrations` (prod apply is explicitly owner-gated per the spec and MEMORY `project_prod_migration_via_mcp` — not evaluated here since it is a deploy step, not a test-coverage step).

### Notes

1. **Gap — AC-22's per-vendor item cap (≤500) is unexercised.** The migration's `rn <= 500` window filter and `items_truncated := total_n > 500` computation have no fixture that actually seeds more than 500 rows for one vendor in `supabase/tests/report_last_order_context.test.sql`. The jest coverage of `itemsTruncated` only checks that the FE mapper passes a hand-supplied boolean through unmodified — it does not exercise the SQL truncation logic at all. This is the one acceptance-criterion sub-clause I can't mark PASS. It's a low-probability-in-practice edge (no vendor in this business ships >500 distinct items on one order, per the design's own R-8 note), but the code path is untested and a future refactor of the `items_ranked`/`vendor_items` CTEs could silently break the cap or the flag with nothing catching it. Recommend a follow-up pgTAP arm (seed 501 `po_items` rows for one vendor, assert `jsonb_array_length(items) = 500` and `items_truncated = true`, and assert the retained rows are the top-500 by `ordered_qty_base desc`) before or shortly after ship — this does not have to block the release given the scope of the gap, but I'm flagging it plainly per the "any NOT TESTED sub-clause is a Critical for release-coordinator purposes" instruction.
2. **AC-16's layout-only claims (flex:1 sizing, no horizontal scroll)** are verified by source inspection rather than an executable assertion. This is a pre-existing ceiling of the RN Testing Library setup in this repo (no layout engine), not a spec-151-specific gap — every other phone a11y-bar acceptance criterion in this codebase has the same verification ceiling.
3. **No fourth test framework introduced.** All new tests land in the two existing tracks (jest, pgTAP) exactly as the spec's Test section (G) mandates; AC-29 correctly declines to invent a shell smoke for a spec that adds no edge function.
4. **Spec 150 files are commingled in the working tree** (staged alongside spec 151: `App.tsx`, `PhoneStoreSwitch.tsx`, `storeVisibility.ts`/`.test.ts`, `useStore.activeBrand.test.ts`, `useStore.switching.test.ts`). These are out of scope for this review (a separate spec) and were not evaluated here beyond confirming they don't break the jest/tsc gates run above.
5. **CI gates on `main` not applicable yet.** This work is staged but not committed/pushed (branch is even with `origin/main`), so the CLAUDE.md "confirm both `test.yml` and `db-migrations-applied.yml` are green after every push to main" rule does not yet apply. Flagging so the release-coordinator/user re-runs that check after the actual push.
6. **`app.json` slug untouched** — confirmed no diff to that file; consistent with the spec's explicit non-goal.
