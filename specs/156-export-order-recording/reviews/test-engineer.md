## Test report for spec 156

Tree verified at working-tree state on top of `74ffabe` (branch `main`, nothing
committed — 26 files staged/modified per `git status`, spec 155 and spec 156
building in parallel in the same tree). Every gate below is attributed
precisely between the two specs' staged surfaces via `git diff --stat` /
`git diff` on the specific files, not assumed:

- `src/lib/db.ts` (+34/-2) — **spec 155 only** (`InstacartAdvisory` type,
  `isInstacartAdvisory` guard, `mintInstacartCartLink`'s optional `advisory`
  field). Zero lines touch `upsertVendorDraftOrder` or any purchase-order
  writer. Confirms spec 156's §7 "no `db.ts` change" claim (AC-REG-7).
  `src/lib/db.upsertVendorDraftOrder.test.ts` — 0-line diff, green, unedited.
- `src/store/useStore.approveOrder.spec149.test.ts` (+96) — **spec 155 only**
  (a new `describe('approveAndOrder — advisory toasts (spec 155 AC-17)')`
  block, read in full). No line in the diff touches
  `disclosureKeyForChannel`/`disclosureKeysForChannel`, the export call sites,
  or `recordExportedOrder`. This is the exact cross-spec case the AC-REG-4
  amendment (2026-08-08) pre-authorizes: spec 156 must not edit this file, and
  it did not — the edit is spec 155's.
- `src/i18n/{en,es,zh-CN}.json` (+8/-2 lines each) — **spec 155 only**
  (`instacartRetailerKeyHelp`, `retailerUnavailable`, `instacartPicker`, three
  `advisory*` keys). Zero new keys for spec 156's success path, confirming
  AC-REG-9.
- `supabase/functions/instacart-cart-link/index.ts`,
  `scripts/smoke-instacart-cart-link.sh` — **spec 155 only**; the only diff
  under `supabase/**` in the whole tree. No migration, no publication change —
  confirms AC-REG-7/AC-19/AC-21/AC-22 (N/A) for spec 156.
- `src/components/cmd/StoreFormDrawer.{tsx,test.tsx}`, `BrandsSection.tsx`,
  `src/screens/cmd/sections/__tests__/StoresTab.edit.test.tsx`,
  `src/utils/postalCode.{ts,test.ts}`, `src/lib/db.updateStore.test.ts`,
  `src/store/useStore.updateStore.test.ts`,
  `src/screens/cmd/sections/phone/PhoneApproveOrder.{tsx}` +
  `__tests__/PhoneApproveOrder.test.tsx` — **spec 155 only** (store-ZIP edit
  surface + DG-1 disclosure work); disjoint from every file this report
  attributes to spec 156.
- **Attributed to spec 156**: `src/store/useStore.ts` (D-1 `buildDraftOrderLines`
  + D-4 `recordingKeys` Set + D-2 `recordExportedOrder`, `fillCartForVendor`
  refactor — disjoint region from spec 155's advisory-toast edits in the same
  file, confirmed by reading both diff hunks), `ReorderSection.tsx`,
  `PhoneOrdering.tsx`, and the three new `*.spec156.test.*` files.

### Acceptance criteria status

**A. The recording — mechanism and reuse**

- AC-1 (reuse, do not fork) → PASS — `db.upsertVendorDraftOrder` unchanged
  (`src/lib/db.ts` diff is spec-155-only, verified above); `grep -rn
  "from('purchase_orders')"` outside `db.ts` finds only the pre-existing
  `src/screens/staff/lib/receiving.ts` carve-out (staff subtree, untouched,
  read-only). No new `supabase.from/rpc` call site was added by spec 156.
- AC-2 (one shared line builder) → PASS —
  `src/store/useStore.recordExportedOrder.spec156.test.ts::buildDraftOrderLines
  — purity, overlay, and the ★ spec-104 bridge` (8 tests: edit overlay,
  `suggestedQty` fallback, `subUnitSize` defaulting to 1, zero-qty/id-less
  drops, purity/no-mutation, and two explicit PARITY tests that deep-equal the
  helper's output against the actual `lines` argument `fillCartForVendor`
  passes to the writer, with and without edits). Source read of
  `src/store/useStore.ts:143-186` confirms the ★ `costPerUnit × subUnitSize`
  bridge and the `qty>0 && itemId` filter are byte-preserved from the old
  inline builder.
- AC-3 (the store action) → PASS —
  `...spec156.test.ts::recordExportedOrder — params (AC-3)` asserts the full
  `{ storeId, vendorId, createdByUserId, referenceDate, lines }` object sourced
  from `currentStore.id` / `vendor.vendorId` / `currentUser.id` /
  `reorderPayload.asOfDate` — the same four values `fillCartForVendor` passes
  (confirmed identical at `useStore.ts:3518-3554` vs `3575-3636`).
- AC-4 (guard: no active single store) → PASS —
  `...spec156.test.ts::recordExportedOrder — silent guards (AC-4, AC-5)` (both
  `currentStore: null` and `currentStore.id === '__all__'` → 0 write calls, 0
  `Toast.show` calls).
- AC-5 (guard: nothing to record) → PASS — same describe block, "every line
  filtered out → no write, no toast, no empty draft header".
- AC-6 (failure posture) → PASS —
  `...spec156.test.ts::recordExportedOrder — failure posture (AC-6 / OQ-1)` (a
  `null` return → one error toast, `Draft not recorded`; a thrown/rejected
  write → `resolves.toBeNull()`, never rejects, one error toast; edit buffer
  left untouched on failure) plus
  `ReorderSection.recordExport.spec156.test.tsx::AC-6 — a failing recorder
  never breaks the export` (rejected recorder still clears the buffer, no
  unhandled rejection, component doesn't throw).
- AC-7 (post-write refresh — POs list only) → PASS —
  `...spec156.test.ts::recordExportedOrder — post-write refresh (AC-7 / OQ-6)`
  (`fetchRecentPurchaseOrders` called, `fetchReorderSuggestions` NOT called on
  success; neither called when nothing was written).

**B. Wiring — the six call sites**

- AC-8 (all six, no others) → PASS — `grep -rn "void recordExportedOrder"
  src --include="*.tsx"` (excluding tests) returns exactly **6** matches:
  `ReorderSection.tsx` ×3 (quick-order, CSV covering both branches, PDF),
  `PhoneOrdering.tsx` ×3 (quick-order, CSV covering both branches, PDF); exactly
  **1** definition (`useStore.ts:3575 recordExportedOrder: async`). All six are
  exercised: `ReorderSection.recordExport.spec156.test.tsx` (sites 1-3, 13
  tests, incl. explicit US FOODS AND SYSCO import-branch cases) and
  `PhoneOrdering.recordExport.spec156.test.tsx` (sites 4-6, 9 tests, incl. the
  US FOODS import branch).
- AC-9 (success-gated) → PASS — every failure/cancel branch pinned at 0
  records: `shared:false` (both surfaces), CSV `ok:false` (`buildReorderCsv`
  throws), PDF `ok:false` (`jsPDF.prototype.save` throws), and the phone
  `Platform.OS !== 'web'` early return (`PhoneOrdering.recordExport
  ::AC-9 — native (Platform.OS !== "web") records zero times`, both CSV and
  PDF, asserts the `common.availableOnDesktop` toast fires and `recordMock`
  and `clearMock` are never called).
- AC-10 (ordering — record before clear) → PASS — both new component-level
  suites pin `['record', 'clear']` via a shared `calls: string[]` recorder, for
  quick-order/CSV/PDF on desktop and all three on phone. Source read confirms
  the `if (ok) { void recordExportedOrder?.(vendor).catch(() => {}); 
  clearReorderEditsForVendor(vendor.vendorId); }` shape at all 6 call sites.
- AC-11 (the vendor object recorded is the one exported) → PASS —
  `ReorderSection.recordExport.spec156.test.tsx::AC-11` seeds an inline edit
  (base 120, server suggestion 72) and asserts the vendor object handed to
  `recordExportedOrder` carries `suggestedUnits: 120` / `suggestedQty: 120`,
  identical to the payload `buildReorderCsv` received.

**C. Idempotency, precedence, and honesty**

- AC-12 (no double-recording on re-export) → PASS —
  `...spec156.test.ts::recordExportedOrder — same-day re-export (AC-12)` drives
  four records with different edited quantities and asserts every
  `upsertMock.mock.calls[i][0]` carries an identical `(storeId, vendorId,
  referenceDate)` triple while the last call's `lines` reflect the latest
  edit. The "one row survives server-side" property is `upsertVendorDraftOrder`'s
  own and is already covered by `src/lib/db.upsertVendorDraftOrder.test.ts`
  (unedited, green) — not re-proven here, per the spec's own instruction.
  **Additional coverage beyond AC-20's minimum**: the D-4 in-flight de-dupe
  (`recordExportedOrder — in-flight key de-dupe (D-4 / F-1)`, 3 tests) closes
  the concurrent-double-record hazard the backend-architect flagged as finding
  F-1 — a double-fire on the same key writes once, the key releases in
  `finally` (including on throw), and a different vendor is never blocked.
- AC-13 (spec-151 anchor tier) → PASS by inspection — `git diff --stat HEAD --
  src/utils/lastOrderContext.ts` and the `report_last_order_context` migration
  are both empty; `src/store/useStore.lastOrderContext.spec151.test.ts` is
  unedited and green in the full run.
- AC-14 (Approve Order records nothing new) → PASS —
  `...spec156.test.ts::approveAndOrder records no export draft (AC-14)`:
  `manual`/`instacart`/`webstaurant` channels → `upsertVendorDraftOrder` called
  **0** times; `extension` channel → exactly **1** call (the unchanged
  spec-138 `fillCartForVendor` path). `useStore.approveOrder.spec149.test.ts`
  itself was not edited by spec 156 (verified above).
- AC-15 (MARK-SENT stays manual) → PASS — `grep -n "'sent'"` across the diffed
  `ReorderSection.tsx` / `PhoneOrdering.tsx` / the `recordExportedOrder`
  region of `useStore.ts` returns nothing; `markPurchaseOrderSent*` /
  `sendPurchaseOrderEmail` / `POsSection.tsx` show zero diff.

**D. Consequences that are real and must be surfaced**

- AC-16 (extension pending-queue interaction) → PASS — verified by source read
  that `recordExportedOrder` (`useStore.ts:3575-3636`) contains **no**
  `extensionOrdering` conditional — records uniformly, per the PM/architect
  default. Documented, not silently chosen.
- AC-17 (`has_po` flips) → PASS by inspection — inherited, unchanged behavior
  of `upsertVendorDraftOrder`/`report_reorder_list`, neither of which this
  spec touches; not independently re-tested (correctly — the spec calls this
  "known and inert today," not a new behavior to pin).
- AC-18 (no notification fires) → PASS — re-verified at source, not just
  trusted: `public.tg_notify_purchase_order`
  (`supabase/migrations/20260715000000_submission_notifications.sql:251-269`)
  guards on `new.status = 'sent'` or `new.status in ('partial','received')`
  only; a `draft` INSERT falls through both branches.
- AC-19 (realtime — no publication change) → PASS — `git diff --stat HEAD --
  supabase/` shows only `instacart-cart-link/index.ts` (spec 155); no
  migration touches `supabase_realtime` membership. The
  `docker restart supabase_realtime_imr-inventory` ritual correctly does not
  apply to this spec's local verification.

**E. Regression group**

- AC-REG-1 (export outputs byte-unchanged) → PASS — `src/utils/reorderExport.ts`,
  `poQuickOrderText.ts`, `usFoodsImport.ts`, `syscoImport.ts`,
  `src/screens/cmd/lib/sharePo.ts` show zero diff (`git diff --stat` empty for
  each); `src/utils/reorderExport.test.ts`, `poQuickOrderText.test.ts`,
  `ReorderSectionCases.test.tsx`, `ReorderSection.spec123.test.tsx`,
  `ReorderSection.resetAfterExport.spec138.test.tsx` all show zero diff and
  pass green in the full run.
- AC-REG-2 (FILL CART unchanged) → PASS —
  `src/store/useStore.fillCartForVendor.spec138.test.ts` shows **zero diff**
  (the gate the design called for) and is green; source read of
  `fillCartForVendor` (`useStore.ts:3518-3572`) confirms it now calls
  `buildDraftOrderLines` but is otherwise byte-identical (same guards, same
  toasts, same `refreshPurchaseOrders()` + `loadReorderSuggestions()` +
  `clearReorderEditsForVendor` chain — unlike `recordExportedOrder`, which
  deliberately omits `loadReorderSuggestions()` per AC-7).
- AC-REG-3 (spec 151 unchanged) → PASS — see AC-13.
- AC-REG-4 (spec 149 unchanged *by this spec*) → PASS — see the file
  attribution note above; the one edit to
  `useStore.approveOrder.spec149.test.ts` is spec 155's advisory-toast block,
  pre-authorized by the architect's 2026-08-08 amendment to this AC. Spec 156
  adds no edit to that file and adds its own AC-14 pin in its own new test
  file instead, exactly as the design specifies.
- AC-REG-5 (extension contract frozen) → PASS — `extension/` shows zero diff;
  the `get_pending_extension_orders` / `get_extension_order_payload` /
  `markPurchaseOrderSent` migrations show zero diff.
- AC-REG-6 (staff surface untouched) → PASS — `git diff --stat HEAD --
  src/screens/staff/` is empty.
- AC-REG-7 (no backend change) → PASS — no migration file added; `db.ts` diff
  is spec-155-only (verified above); `permissive_policy_lint` untouched
  (pgTAP run below, 80/80 green, no new file).
- AC-REG-8 (phone/desktop tier fork intact) → PASS — the `isPhone` guard in
  `ReorderSection.tsx` (line 1622-1623) remains placed after all hooks
  (comment block at lines 1613-1622 confirms this was deliberately preserved);
  the new `recordExportedOrder` selector is placed at the top of the component
  body in all three consuming components (`ReorderQuickOrderButton:363`,
  `ReorderVendorExportButtons:481`, `OverflowSheet:584`), beside the other
  selectors, never inside a conditional or callback; `PhoneOrdering.acReg.test.tsx`
  passes unedited (0-line diff) in the full run.
- AC-REG-9 (no new user-visible copy on the success path) → PASS — i18n diff
  is entirely spec 155's (verified above); the only new string is the AC-6
  failure toast (`'Record exported order' + ' failed'`), which routes through
  the existing untranslated `notifyBackendError` label convention
  (`useStore.ts:53-62`), matching `'Fill cart' + ' failed'` byte-for-byte in
  shape.

**F. Tests**

- AC-20 (jest) → PASS — 48 new tests across the three files named in the
  design's §9 test plan (26 + 13 + 9), all passing; every named AC-REG pin
  ran unedited and green in the full `npx jest` run (see Test run).
- AC-21 (pgTAP — N/A) → CONFIRMED N/A, correctly not invented. No migration in
  the diff; `npm run test:db` is untouched-green (80/80, identical file count
  to what spec 155's review reported, no new `.test.sql` file added by spec
  156).
- AC-22 (shell smoke — N/A) → CONFIRMED N/A. No edge function added or
  modified by spec 156 (`scripts/smoke-edge.sh` / `scripts/smoke-rpc.sh` show
  zero diff attributable to spec 156).

### Test run

```
npx tsc --noEmit                         → clean, 0 errors
npm run typecheck:test                   → clean, 0 errors
npx jest --silent                        → 201 suites / 2182 tests passed (2 snapshots passed)
npm run test:db (scripts/test-db.sh)     → 80/80 DB test file(s) passed (untouched — no migration
                                            diff, no test.sql diff attributable to spec 156)
```

Targeted re-runs of the three new spec-156 files, isolated:

```
npx jest src/store/useStore.recordExportedOrder.spec156.test.ts
  → 1 suite / 26 tests passed

npx jest src/screens/cmd/sections/__tests__/ReorderSection.recordExport.spec156.test.tsx
  → 1 suite / 13 tests passed

npx jest src/screens/cmd/sections/phone/__tests__/PhoneOrdering.recordExport.spec156.test.tsx
  → 1 suite / 9 tests passed
```

No failures. No test was edited to make a failure pass — nothing failed.

**db-migrations-applied.yml applicability**: not evaluated locally (it is a
CI-only gate against prod's `schema_migrations`), but is a no-op for this
spec: `git diff --stat HEAD -- supabase/migrations/` is empty, so there is
nothing this spec could have caused that gate to flag. The
`project_realtime_publication_gotcha` ritual does not apply for the same
reason (AC-19).

### Notes

**No framework gap.** All new tests land in the existing jest track, matching
the spec's own AC-21/AC-22 rulings that pgTAP and shell smoke are N/A here (no
SQL, no edge function). No fourth framework was introduced.

**Live-browser check — PENDING MANUAL EVIDENCE, not NOT TESTED.** The
frontend-developer's implementation record states no `preview_*` browser
tooling was available in that session, so the golden path (export CSV for a
vendor → POs list shows a `draft` for that vendor; re-export the same day →
still one row) was never clicked through live. Per the dispatcher's framing,
this is being tracked as a **pending manual browser pass**, not a coverage
gap — the underlying behavior (both the recording call and the
`upsertVendorDraftOrder` upsert-by-key semantics) is fully pinned at the unit
level by `...spec156.test.ts` AC-12 (identical key across four re-exports) and
by the pre-existing `db.upsertVendorDraftOrder.test.ts` (the "one header
survives" server-side property, unedited and green). The design also predicts
(§8 F-2 / Design guidance 6) that the feature will not be *visibly* observable
in the POs list / spec-151 context line until the next ordering cycle, because
`reference_date` is dated today and spec 151 anchors strictly-before the
viewed date — worth keeping in mind when the dispatcher runs the live pass: a
same-day recheck of the POs list draft row is the correct live assertion, NOT
a same-day recheck of the spec-151 context line (that only appears the
*following* cycle, by design).

**No AC is unverified.** All 22 lettered/numbered acceptance criteria (AC-1
through AC-22, plus the AC-REG group) resolved to PASS, either by a named jest
test or, for the explicitly-inherited/read-only claims (AC-13, AC-16 branch
absence, AC-17, AC-18, AC-19, AC-21, AC-22), by direct source/diff inspection
as the spec itself calls for ("pinned by a test" vs. "asserted, not assumed" vs.
"N/A, stated explicitly" are three different bars set by the spec text itself,
and each item was checked against the bar the spec actually set for it).

**One deliberate, disclosed deviation from the literal D-3 snippet** (already
called out in the spec's own "Files changed" section, and independently
re-verified here against source, not just trusted): all six call sites use
`void recordExportedOrder?.(vendor).catch(() => {});` rather than a bare
`recordExportedOrder(vendor);`. The optional-call (`?.`) is required so the
three shipped suites that mock `useStore` with a literal state object
carrying no `recordExportedOrder` (`ReorderSection.resetAfterExport.spec138`,
`ReorderSection.spec123`, `ReorderSection.spec138`) don't crash — confirmed
all three are present, unedited, and green. The `.catch(() => {})` prevents an
unhandled rejection on a `void`-ed promise, which is required by the design's
own AC-6-at-the-seam test. Neither changes the contract (still invoked-not-
awaited, still success-gated, still ordered before the clear) — this is a
correctness fix to the literal snippet, not a scope or behavior change, and it
is exercised directly by the AC-6-at-the-seam tests in both new component
suites.

**No Critical, no Should-fix, no gap found in this review.** All ACs are PASS.
