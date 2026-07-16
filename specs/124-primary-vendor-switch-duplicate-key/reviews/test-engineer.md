## Test report for spec 124

### Acceptance criteria status

- AC1: Switching primary on a 2-vendor item (A→B) saves with no error toast; after reload item is "supplied by" B →
  **PASS (indirect, ordering proof)** — `src/lib/db.updateInventoryItemPrimarySwitch.test.ts::issues the is_primary=false demote BEFORE the upsert on a primary switch`.
  The root cause was a *statement-ordering* bug (a single multi-row upsert transiently holding two `is_primary=true`
  rows within the same statement, tripping the partial unique index). The test deterministically asserts the fix's
  entire mechanism: the demote UPDATE is issued and completes (mocked, but call-order is exactly what the
  duplicate-key repro depends on) strictly before the upsert call. This is a legitimate proof of the fix for a
  client-ordering bug — it doesn't require a live DB to demonstrate that two non-overlapping statements no longer
  collide within one. The "after reload shows B" half of this AC is UI/e2e and not exercised by any test (no
  live-DB or component-level assertion) — see Notes.

- AC2: After the switch, exactly one `item_vendors` row has `is_primary=true` (new primary B); old primary A row is
  `false` — **verified by a DB read, not just the UI** → **NOT TESTED (live DB)**. The jest test proves the
  *statements issued* would produce this end-state (demote sets A false, unaffected by `.neq(B)`; upsert then sets
  B true), but the AC's own wording explicitly calls for a DB read, and no pgTAP/shell end-state test was written.
  The design's Test-surface section named this pgTAP/shell check "optional / belt-and-suspenders" and it was not
  implemented in this round.

- AC3: Legacy scalar `inventory_items.vendor_id` mirrors the new primary after save (SD-1) → **NOT TESTED (no new
  test)**. This behavior is unchanged by the spec 124 diff — the scalar mirror write is a separate, earlier
  statement in `updateInventoryItem` (db.ts:457-464) that the demote/upsert reorder does not touch. No dedicated
  test (old or new) exercises it at the `db.ts` level; risk is low because the code path is untouched by this fix.

- AC4: `primaryVendorId = null` demotes ALL existing primaries, zero `is_primary=true` rows remain, no duplicate-key
  error → **PASS** — `src/lib/db.updateInventoryItemPrimarySwitch.test.ts::primaryVendorId=null: demotes ALL
  primaries (no .neq filter)`. Directly asserts the demote fires and the `.neq('vendor_id', …)` filter is absent
  when `primaryVendorId` resolves to `null`.

- AC5: Par/cost/case-price/order-code edits submitted in the same save still persist correctly (no regression to
  the existing upsert) → **NOT TESTED (no dedicated regression test)**. The upsert payload construction
  (`cost_per_unit`, `case_price`, `order_code`) is unchanged by this diff — only a new statement was inserted
  *before* it. No test in this spec's file asserts the upsert payload's cost/case-price/order-code fields; the one
  test that inspects payload shape (`does NOT set updated_at in the demote payload`) only checks the *demote*
  payload, not the upsert. Pre-existing coverage of these fields at the `db.ts` write-path level does not exist
  either (only pure-helper coverage in `src/components/cmd/IngredientForm.test.ts`, which stops at the
  form→payload transform and never calls `db.updateInventoryItem`).

- AC6: Single-vendor saves and no-primary-change saves are unaffected (same resulting rows as before this fix) →
  **NOT TESTED (no dedicated case)**. No test in the new file exercises a single-vendor item or a save where the
  primary does not change. By code inspection the demote's `.neq('vendor_id', primaryVendorId)` filter would match
  zero rows in that scenario (the sole/unchanged primary's `vendor_id` equals `primaryVendorId`, so it's excluded),
  so the extra statement is a real no-op UPDATE — but this is reasoned from reading `db.ts`, not asserted by a test.

- AC7: Removing a vendor (de-selected link) still deletes that link (AC-C from spec 102 preserved) → **NOT TESTED
  (no `db.ts`-level test)**. The delete statement (db.ts:524-529) is untouched by this diff and sits after the new
  demote/upsert calls. The new jest file does not exercise it. `IngredientForm.test.ts::removeVendorLink` /
  `vendorRowsToLinkPayload` tests only the pure form-side helper, not the actual `db.ts` delete call this AC is
  about.

- AC8: Test track named per the "Tests" note; the primary-switch case is covered → **PASS** — the design's named
  primary track (jest ordering assertion covering demote-before-upsert, filter shape, and the
  `primaryVendorId=null` variant) was implemented exactly as specified in
  `src/lib/db.updateInventoryItemPrimarySwitch.test.ts`, plus two bonus assertions (`updated_at` omission, and the
  demote-error-throws optimistic-revert contract) beyond what the design strictly required.

### Test run

```
npx jest updateInventoryItemPrimarySwitch
  PASS unit src/lib/db.updateInventoryItemPrimarySwitch.test.ts
  5 passed, 5 total

npx jest   (full suite)
  Test Suites: 108 passed, 108 total
  Tests:       1218 passed, 1218 total   (matches expected ~1218)

npx tsc --noEmit                → clean, exit 0
npm run typecheck:test          → clean, exit 0

npm run test:db  (pgTAP, local stack already running — no migration in this
spec, so no realtime restart needed)
  69/70 files PASS
  1/70 FAIL: supabase/tests/item_vendors_rls.test.sql
    test 12 — "(12) non-member UPDATE cannot write order_code on a Charles
    link (stays NULL — RLS regression pin)" — have: 8302192, want: NULL.
    PRE-EXISTING and UNRELATED to spec 124: this spec ships no migration, no
    RLS change, and touches no `order_code` write path. Confirmed present as
    noted going in; not caused by or fixed by this diff.
```

### Notes

- **Verdict: not blocking.** The core acceptance criterion — a primary switch on a 2-vendor item no longer trips
  `item_vendors_one_primary_per_item` — is a client statement-*ordering* bug, and the jest ordering test
  deterministically pins the exact mechanism of the fix (demote issued and awaited strictly before the upsert, with
  the correct filter shape, including the `primaryVendorId=null` demote-all variant). That is sufficient proof for
  an ordering fix; per the task framing, a live-DB integration test was explicitly out of scope for this round and
  the design itself named the pgTAP/shell end-state check "optional."
- **Genuine gap, flagged not blocked:** AC2 literally asks for "verified by a DB read, not just the UI," and that
  DB read was not produced (the optional pgTAP/shell confirmation named in the design's Test-surface section was
  not implemented). If a future regression reintroduces the bug in a way that changes call semantics but not order
  (e.g., a batching change that merges the demote and upsert back into one call), the current jest suite—which
  only inspects mocked call args/order, not real constraint enforcement—would not catch it. Recommend a follow-up
  pgTAP or shell smoke that drives a real 2-vendor primary switch against the local stack and reads back
  `item_vendors.is_primary` state, closing AC2/AC3 with an actual DB read. Not required to ship this fix, but
  should be tracked.
- **AC5/AC6/AC7 are structurally low-risk, not zero-risk.** The diff is purely additive (one new statement inside
  an existing guard, before the pre-existing upsert); the cost/case-price/order-code payload construction, the
  single-vendor/no-change path, and the delete-de-selected-link path are all byte-for-byte unchanged by this spec.
  No test regressed and the full jest + typecheck runs are clean. But none of these ACs has a *dedicated* test at
  the `db.ts` write-path level — before OR after this spec — so "no regression" here rests on code inspection, not
  an assertion that would fail if someone touched that code later. Surfacing as a pre-existing coverage gap in
  `updateInventoryItem`'s vendor-link reconcile, not something this spec was asked to backfill.
- **Pre-existing unrelated pgTAP failure confirmed:** `item_vendors_rls.test.sql` test 12 fails exactly as noted
  going in — an RLS gap where a non-member's UPDATE can still write `order_code` on a link it shouldn't see. This
  predates spec 124 (no migration/RLS change here) and is out of scope for this fix; flagging for tracking
  elsewhere, not blocking this spec.
- **No framework drift.** All new coverage is jest, matching the in-tree track; no vitest/playwright introduced.
- **`app.json` slug:** untouched, not implicated by this spec.
