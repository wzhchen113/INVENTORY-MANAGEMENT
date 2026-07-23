## Test report for spec 138

Reviewed against `specs/138-reorder-only-retire-po-receiving.md` (all ACs +
"## Backend design" §12 test plan) and the files listed under "## Files
changed (backend)" / "## Files changed (frontend)". Working tree is
uncommitted (`git status`) — all spec-138 edits are unstaged/untracked, as
expected pre-review.

### Acceptance criteria status

- **AC-1** (Ordering lands directly on reorder list, no tab strip) → **PASS**
  — `src/screens/cmd/sections/__tests__/OrderingSection.test.tsx::OrderingSection — reorder-only shell (spec 138) > mounts the reorder pane and has NO Purchase-orders tab`
  + `e2e/reorder.spec.ts::AC-REORD-DEPTH-1` (nav-Ordering lands directly on
  `reorder-root`, no tab click).

- **AC-2** (admin Receiving removed from sidebar) → **PASS, but only
  indirectly tested.** Source confirms removal: `src/lib/cmdSelectors.ts:1094-1105`
  (OPERATIONS group no longer lists `{ id: 'Receiving' }`) and
  `src/screens/cmd/InventoryDesktopLayout.tsx` has zero `Receiving` references
  (branch + import both gone). Test coverage is indirect only:
  `src/lib/cmdSelectors.paletteScreens.test.ts::routes NO screen entry to the
  retired Reorder / PurchaseOrders / Receiving section names` (palette, not
  the sidebar-groups list itself) and the AC-4 remap tests (below), which
  only make sense if `Receiving` is absent from `defaultGroups`. **Gap:** no
  test directly renders/calls `useDefaultSidebarGroups()` and asserts the
  OPERATIONS group's item ids no longer contain `Receiving`. Low risk (single
  literal array, three independent signals already point the same way) but
  worth a 5-line follow-up test.

- **AC-3** (staff Receiving tab removed) → **NOT TESTED.** Source confirms
  removal: `src/screens/staff/navigation/StaffStack.tsx:137-140` — the
  `Receiving` `Tab.Screen` is gone, replaced by a comment. There is **no**
  test file for `StaffStack.tsx` at all (none existed before this spec
  either — `git log -- src/screens/staff/navigation/StaffStack.tsx` shows no
  test ever landed for this file), and no e2e spec asserts the staff tab bar
  lacks a Receiving tab (`e2e/*.spec.ts` has zero `Receiving` references).
  This is a real, disclosed-nowhere gap: nothing would catch a future
  accidental re-add of the tab, or a StaffStack refactor that silently drops
  a different tab instead.

- **AC-4** (sidebar-override fallback for removed ids) → **PASS** —
  `src/screens/cmd/sections/__tests__/OrderingSection.test.tsx::remapLegacySidebarOverrideIds — spec-008 override fallback (spec 137/138)`
  — 9 cases incl. `'drops the retired Receiving override id entirely (spec
  138, AC-4)'` and `'applySidebarOverride resolves a dropped Receiving id
  cleanly (no dangling entry)'`. `src/lib/sidebarLayout.ts` `REMOVED_SIDEBAR_IDS`
  / `remapLegacySidebarOverrideIds` implementation matches.

- **AC-5** (inline case-qty editing, `poCaseDisplay` reuse) → **PASS** —
  `src/screens/cmd/sections/__tests__/ReorderSection.spec138.test.tsx::Inline edit → poResolveEdit → setReorderEditQty (cases)`
  (both the case-count write and the re-type-seed-is-no-op case). Source
  (`ReorderSection.tsx:54,811-825`) imports `isCaseRow` / `poOrderedDisplay` /
  `poResolveEdit` from `src/utils/poCaseDisplay.ts` verbatim — no forked
  conversion logic.

- **AC-6** (edited qty flows to every artifact + on-screen est-$/KPI) →
  **PASS** — `ReorderSection.spec138.test.tsx::applyReorderEdits (pure buffer
  overlay + est-$ bridge)` (asserts `estimatedCost = base × costPerUnit ×
  subUnitSize` on a `subUnitSize>1` row, and that an untouched item keeps the
  server `estimated_cost` verbatim) + `::Edited qty flows to display + CSV
  export` (breakdown text + `buildReorderCsv` receives the overridden
  vendor). Source confirms the KPI strip (`ReorderSection.tsx:1380,1498`)
  reads from the same `applyEdits`-overlaid vendor list, not the raw payload.

- **AC-7** (edit persistence until export/cart-fill, then reset) →
  **FAIL (partial).** The **persist** half works and is tested (buffer holds
  edits until explicitly cleared — `ReorderSection.spec138.test.tsx`). The
  **reset** half is only partially implemented and entirely untested:
  - Reset-on-Fill-cart: implemented (`src/store/useStore.ts:2916`
    `get().clearReorderEditsForVendor(vendor.vendorId)` inside
    `fillCartForVendor`) but **untested** — every component test mocks
    `fillCartForVendor` as a bare `jest.fn()`, so the real implementation
    (including this reset call) is never exercised.
  - Reset-on-store-switch / date-change: implemented
    (`ReorderSection.tsx:1322,1329` `clearReorderEdits()`) but **untested** —
    no test asserts `clearReorderEdits` is called on a store-switch or
    `selectedDate` change effect.
  - **Reset-after CSV / PDF / quick-order-text export is NOT IMPLEMENTED AT
    ALL.** `ReorderVendorExportButtons`'s `onCsv`/`onPdf` handlers
    (`ReorderSection.tsx:435-449`) and `ReorderQuickOrderButton`'s
    `onShareQuickOrder` (`ReorderSection.tsx:340-391`) never call
    `clearReorderEditsForVendor` or `clearReorderEdits`. The ONLY call site
    of `clearReorderEditsForVendor` in the whole tree is inside
    `fillCartForVendor` (`grep -rn clearReorderEditsForVendor src` returns
    exactly one production call site). This directly contradicts the AC-7
    text: *"after an export / cart-fill for that vendor, the next reorder
    cycle starts fresh from the computed suggestions for that vendor"* — the
    export half of that sentence is not built. It's also explicitly named in
    the design's own test plan (§12: *"edit persistence + reset-after-export
    and reset-after-Fill-cart per vendor (AC-7)"*), and neither the backend
    nor frontend "Files changed" notes disclose dropping the export-reset
    behavior. Net effect: edit a vendor's qty, export CSV, come back later
    (same session, same store, same date) — the edited qty is still there
    instead of resetting to a fresh suggestion, until the buffer is cleared
    wholesale by a store switch or date change.

- **AC-8** (read-only history panel) → **PASS** —
  `OrderingSection.test.tsx::OrderingSection — read-only History (AC-8)` —
  open/refresh, date/vendor/total row rendering, cancelled-status filtering,
  empty state. No edit/receive/re-open affordance present in
  `OrderHistoryPanel` (source-confirmed, read-only render only).

- **AC-9** (Fill cart button on `extension_ordering` vendors) →
  **PARTIAL.** UI-gating is well tested: `ReorderSection.spec123.test.tsx::Fill
  cart button (extension-ordering gating, spec 138)` — button renders only
  for `extensionOrdering: true`, is confirm-gated
  (`src/utils/confirmAction.ts`), and calls `fillCartForVendor` with the
  correct vendor. **Gap:** the actual handoff plumbing this button triggers —
  `src/store/useStore.ts::fillCartForVendor` (buffer-overlay line-building,
  optimistic-then-revert, `notifyBackendError` on failure) and
  `src/lib/db.ts::upsertVendorDraftOrder` (find-existing-draft /
  update-vs-insert / `expected_delivery` omission) — has **zero** automated
  test coverage. Every test that touches `fillCartForVendor` stubs it as
  `jest.fn(() => Promise.resolve('po-1'))`; the real function bodies are
  never executed by any test. This is the highest-risk code this spec adds
  (it writes the record the browser extension reads to fill a real vendor
  cart) and the design's own test plan named it explicitly (§12: *"fillCartForVendor
  / upsertVendorDraftOrder: create when no draft, update the existing draft
  when one exists, new draft when only a 'sent' exists, `expected_delivery`
  omitted (mock db)"*) — this test was never written. The codebase has clear
  precedent for exactly this shape of test (`src/lib/db.poLoop.test.ts`,
  `src/store/useStore.createPoDraft.spec125.test.ts` — mocked-supabase unit
  tests of `db.ts`/`useStore.ts` write paths), so there's no framework
  obstacle; it was simply not written.

- **AC-10** (extension RPC contract unchanged) → **PASS** for the
  "unchanged" half: `supabase/migrations/20260723000000_extension_ordering.sql`
  has no newer migration touching it (`ls supabase/migrations | sort | tail`
  confirms `20260726000000_reorder_drop_inbound_term.sql` is the only new
  file, and it only touches the two reorder-report functions), and
  `supabase/tests/extension_ordering.test.sql` is part of the green 76/76
  pgTAP run. **Same gap as AC-9** for the "creates/updates the hidden
  draft-order record" half — untested (see AC-9).

- **AC-11** (no Fill-cart button when `extension_ordering = false`) →
  **PASS** — `ReorderSection.spec123.test.tsx::renders NO Fill cart button
  on a non-extension vendor (exports only, AC-11)`.

- **AC-12** (+ CREATE PO / PO CREATED chip removed) → **PASS** —
  `ReorderSection.spec123.test.tsx` asserts `reorder-create-po-v-a` is null
  and neither `section.reorder.createPoLabel` nor
  `section.reorder.poCreatedLabel` render, on both the extension and
  non-extension gating tests.

- **AC-13** (CSV/PDF/quick-order exports unchanged capability, fed edited
  qty) → **PASS** — `ReorderSection.spec123.test.tsx::per-vendor CSV/PDF
  export` (both buttons present per card, single-vendor narrowed payload,
  global buttons gone) unchanged and green; quick-order button
  (`reorder-quick-order-v-a`) confirmed present in the non-extension-vendor
  test; `ReorderSection.spec138.test.tsx` confirms the CSV builder receives
  the edited qty.

- **AC-14** (jest — spec 022 track) → **PARTIAL.** Covers inline-edit → export
  flow, sidebar-override fallback, Fill-cart button gating (all PASS above).
  Does **not** cover the two items named in its own design bullet: (a)
  reset-after-export / reset-after-Fill-cart assertions (AC-7 gap above), and
  (b) `fillCartForVendor` / `upsertVendorDraftOrder` create-vs-update-vs-new
  logic (AC-9/AC-10 gap above).

- **AC-15** (pgTAP — reorder RPC changed) → **PASS** —
  `supabase/tests/report_reorder_list_no_inbound.test.sql` (6/6: pending_po_qty=0,
  suggested_qty/par_replacement un-netted, envelope key present, has_po
  intact) + `supabase/tests/po_loop.test.sql` updated per the architect's
  OPTION A ruling (cases 20/21/22 re-pinned to no-netting values on BOTH
  `report_reorder_list` and `report_reorder_for_counted_onhand`, byte-parity
  test 23 kept at the un-netted baseline) — 30/30. Both engines confirmed
  live-patched in the local DB (`pg_proc.prosrc` inspection shows the `where
  false` CTE on `report_reorder_list`). The shell-smoke round-trip named as
  "recommended" in design §12 (Fill cart → `upsertVendorDraftOrder` →
  `get_pending_extension_orders` → `get_extension_order_payload`) was not
  built — acceptable per AC-15's own wording (B1 reuses existing RPCs, so the
  shell-smoke requirement is conditional/N/A), but it would have caught the
  AC-9/AC-10 gap above and is worth adding as a follow-up.

### Test run

```
npx jest
  → Test Suites: 131 passed, 131 total
  → Tests:       1388 passed, 1388 total
  → exit 0

npm run test:db   (scripts/test-db.sh against supabase_db_imr-inventory)
  → 76/76 DB test file(s) passed
  → includes report_reorder_list_no_inbound.test.sql (6/6),
    po_loop.test.sql (30/30), extension_ordering.test.sql (unchanged, green)

cd extension && npx vitest run
  → Test Files  5 passed (5)
  → Tests       31 passed (31)
  → exit 0   (extension untouched by this spec — confirmed via
    `git log --oneline -- extension/`, last touch predates spec 138)

npx tsc --noEmit            → exit 0
npx tsc -p tsconfig.test.json --noEmit  → exit 0
```

No grep-piped test runs — all four commands run directly, real exit codes
captured above.

Playwright (`e2e/`) was NOT run by this agent (no browser/preview tooling in
this session — consistent with the frontend developer's own note). Per the
task, browser verification is covered externally by main Claude. The golden
path to exercise there:

1. Sign in as admin → click sidebar **Ordering** → lands directly on the
   reorder pane (no PO tab, `reorder-root` visible immediately) — AC-1.
2. Confirm the sidebar has **no Receiving entry** in Operations, and the
   staff app's bottom tab bar (sign in as a staff/`user`-role account) has
   **no Receiving tab** — AC-2/AC-3 (currently the only verification of
   AC-3 at all, given the jest/e2e gap above).
3. Expand a vendor card, edit a case quantity inline → est-$ updates on that
   card and in the KPI strip — AC-5/AC-6.
4. Export CSV/PDF for that vendor → downloaded file reflects the edited qty
   — AC-6/AC-13. Then check whether the on-screen edited value **persists**
   after the export (per the AC-7 gap above, it currently will — confirm
   this is the behavior the owner wants, or file it as a bug).
5. For a BJ's/Sam's (`extension_ordering=true`) vendor, press **Fill cart**,
   confirm the dialog → verify a `draft` row appears in
   `purchase_orders` for (store, vendor, today) via Studio/DB inspector, and
   that the edit buffer for that vendor visibly resets to suggestions
   afterward — AC-7 (Fill-cart half)/AC-9/AC-10.
6. Open the History panel → the just-filled draft shows date/vendor/total,
   read-only — AC-8.
7. Check the 1100px responsive boundary and dark mode on the Ordering
   surface (no regressions expected, not spec-138-specific).

### Notes

- **Framework posture:** no new test framework introduced. jest / pgTAP /
  shell-smoke / Playwright e2e are all pre-existing tracks (Playwright landed
  in spec 078, documented in `tests/README.md` — CLAUDE.md's "three tracks"
  line is stale relative to that doc but this is not a new-framework
  question). The developer extended `e2e/reorder.spec.ts` in-place; no
  vitest/other framework was added to the main repo. The `extension/`
  package's pre-existing vitest suite is a separate, already-approved
  sub-project (spec 132) and was correctly left untouched.
- **Prod-apply flag (inherited, not this agent's job to apply):** the spec's
  own backend section flags that `20260726000000_reorder_drop_inbound_term.sql`
  is applied to the LOCAL stack only; prod apply goes through Supabase MCP +
  `schema_migrations` insert per project MEMORY. `db-migrations-applied.yml`
  will read red until that happens — expected, not a test finding.
- **Two Critical-adjacent findings for the release-coordinator:**
  1. **AC-7 export-reset is unimplemented** (not just untested) — a real
     behavior gap against the acceptance criterion's explicit wording.
  2. **AC-9/AC-10's core write path (`fillCartForVendor` /
     `upsertVendorDraftOrder`) has no automated test at any layer** (jest,
     pgTAP, or shell smoke), despite being explicitly named in the design's
     own test plan and despite in-tree precedent for exactly this test shape.
     This is the piece of the spec that actually writes to the table the
     browser extension reads before touching a real vendor's live cart.
- **AC-3 (staff Receiving tab) has never had test coverage**, before or after
  this spec — flagging so it isn't mistaken for a spec-138-introduced
  regression, but it remains a genuine "no test protects this" gap the
  release-coordinator should weigh.

---

## Addendum (2026-07-23) — re-verification of the fix-plan

Re-checked ONLY the two items this report FAILED/flagged as Critical-adjacent
(AC-7 export-reset, AC-9/AC-10 write-path coverage), against the fixes applied
since the original review: `ReorderSection.tsx` wiring changes (staged) +
three new test files (`ReorderSection.resetAfterExport.spec138.test.tsx`,
`db.upsertVendorDraftOrder.test.ts`, `useStore.fillCartForVendor.spec138.test.ts`).
Also re-ran the full three-track suite and re-confirmed the AC-3 gap.

### 1. AC-7 reset-after-export — RESOLVED

Read `git diff --cached -- src/screens/cmd/sections/ReorderSection.tsx` in full.

- `handleCsvExport` / `handleImportExport` / `handlePdfExport` now return
  `boolean` (`true` only on the actual download/save success path, `false` in
  the `catch`). `ReorderVendorExportButtons`'s `onCsv`/`onPdf` are now `async`,
  await the boolean, and call `clearReorderEditsForVendor(vendor.vendorId)`
  **only when `ok` is true**. `ReorderQuickOrderButton.onShareQuickOrder` reads
  `{ shared, previewText }` off `sharePurchaseOrder(...)` and clears **only
  when `shared` is true** (share dismissed/failed → `shared: false` → no
  clear). All three failure paths are structurally unable to reach the clear
  call (it's inside an `if (ok)` / `if (shared)` guard, not a `finally`).
- `fillCartForVendor` (`src/store/useStore.ts:2916`) already called
  `clearReorderEditsForVendor` on success only (pre-existing per the original
  report) — unchanged, now also test-covered (see item 2).

**Test genuinely pins it — mutation-verified.** I read the full assertion set
in `ReorderSection.resetAfterExport.spec138.test.tsx` (CSV success/failure/
scoped-to-vendor, PDF success, quick-order shared/dismissed — 6 cases, mocked
`useStore` with `clearReorderEditsForVendor: jest.fn()` as the assertion
surface) and then did a live mutation check rather than trusting the reading:
I temporarily deleted the `if (ok) clearReorderEditsForVendor(...)` line from
`onCsv` in `ReorderSection.tsx`, reran
`npx jest ReorderSection.resetAfterExport.spec138.test.tsx`, and got **2
failing / 4 passing** (the two CSV-success assertions failed with "Number of
calls: 0" — exactly the expected failure mode; the failure-preserves and PDF/
quick-order cases were unaffected, as expected since I only touched `onCsv`).
Reverted the line immediately; re-ran the same file → 6/6 green; re-ran full
`npx jest` → 134/134 suites, 1407/1407 tests, clean `git diff` on the file
afterward (no residue). This is about as strong a confirmation as a
static read can get that the test is not vacuous.

**Verdict: AC-7 is now PASS** (both halves — persist-until-export/cart-fill
AND reset-after — are implemented and tested; scoped-to-vendor and
failure-preserves behavior are both asserted).

### 2. AC-9 / AC-10 write-path coverage — RESOLVED

- `src/lib/db.upsertVendorDraftOrder.test.ts` imports the REAL
  `upsertVendorDraftOrder` from `./db` (not a stub) against a hand-rolled
  chainable `supabase.from` mock scripted via a `terminalQueue` (same shape as
  the pre-existing `db.poLoop.test.ts` pattern). It exercises:
  - **INSERT path** — no existing draft: header insert (`status:'draft'`,
    summed `total_cost`, `expected_delivery` asserted ABSENT via
    `not.toHaveProperty`), then `po_items` insert with the cost snapshot
    verbatim and `received_qty: null`. Asserts the `eq('status','draft')` /
    `eq('reference_date', ...)` filter shape directly.
  - **Skip-non-draft** — "creates a NEW draft when only a non-draft (e.g.
    sent) order exists for the key": the find query is scoped to
    `status='draft'` so a `sent` row never matches → falls through to insert,
    asserted via `mockBuilder.delete).not.toHaveBeenCalled()` (proves the
    "sent" row was never touched, not just that a new id came back).
  - **NULL reference_date match** when none supplied (`is('reference_date',
    null)`), and empty-lines short-circuit (no query at all).
  - **UPDATE path (reordered insert-new-then-delete-old)** — explicitly
    asserts `insertOrder < deleteOrder` via
    `mock.invocationCallOrder`, that the delete targets **exactly the
    captured old ids** (`in('id', ['old-1','old-2'])`, not a blanket
    `eq('po_id', ...)` delete), and `total_cost` recomputed on the existing
    header.
  - **Failure ordering** — "leaves the OLD lines intact... when the new-line
    insert fails": insert error → `delete` never called, `update` never
    called, returns `null`. This is the exact data-loss regression the
    developer's own comment says the reordering fixes; the test pins the
    reordering, not just the happy path.
  - **No-lines-to-delete** edge case (existing draft had zero prior lines).

  This is real function coverage, not a shape assertion on a stub — every
  Postgres call sequence, filter, and payload shape named in the design's
  test-plan bullet is asserted.

- `src/store/useStore.fillCartForVendor.spec138.test.ts` uses the REAL
  `useStore` (only `../lib/db` / `../lib/supabase` / `../lib/auth` /
  `react-native-toast-message` mocked — same isolation pattern as the
  pre-existing `useStore.createPoDraft.spec125.test.ts`). `db.upsertVendorDraftOrder`
  is the mocked assertion surface (`jest.fn().mockResolvedValue('po-1')`).
  Covers:
  - **Edited-qty overlay**: seeds `reorderEdits = { v1: { 'item-1': 5 } }`
    against a vendor whose item has `suggestedUnits: 3`; asserts the line
    passed to `upsertVendorDraftOrder` carries `orderedQty: 5` (not 3) and
    `costPerUnitCounted: costPerUnit(2) × subUnitSize(4) = 8` — the spec-104
    per-COUNTED-unit bridge, read from the real `inventory` slice.
  - **Fallback to server suggestion** when no edit exists for the item
    (`orderedQty: 3`).
  - **referenceDate keying** — asserts `params.referenceDate ===
    reorderPayload.asOfDate` verbatim.
  - **Clear-on-success**: after a successful call, `reorderEdits.v1` is
    `undefined` (the REAL `clearReorderEditsForVendor` reducer ran, inspected
    via actual state — not a mock assertion) AND
    `fetchRecentPurchaseOrders`/`fetchReorderSuggestions` were invoked (the
    refresh chain).
  - **Preserve-on-failure**: both `upsertMock.mockResolvedValueOnce(null)`
    (RLS-denial-shaped failure) and `upsertMock.mockRejectedValueOnce(...)`
    (thrown-error-shaped failure) leave `reorderEdits.v1` intact at its
    pre-call value, and both return `null`.
  - **No-active-store guard**: `currentStore: null` → `upsertMock` never
    called, buffer untouched.

  I did not additionally mutation-test this file (the assertions inspect real
  reducer-produced state, e.g. `reorderEdits.v1` being `undefined` vs. its
  seeded value, which is a much harder thing to satisfy by accident than a
  mock call-count — I judge the read sufficient here given the CSV mutation
  check already validated the general pattern this developer used).

**Verdict: AC-9/AC-10's previously-uncovered write path (`fillCartForVendor` /
`upsertVendorDraftOrder`) is now PASS.** Both the pgTAP-adjacent "RPC contract
unchanged" half (already PASS in the original report) and the
create/update/skip/edited-qty/clear/failure-preserve write-path half are now
covered.

### 3. Full three-track re-run (post-fix)

```
npx jest
  → Test Suites: 134 passed, 134 total
  → Tests:       1407 passed, 1407 total
  → exit 0
  (up from 131 suites/1388 tests pre-fix — the 3 new spec-138 files account
  for the +3 suites / +19 tests)

npm run test:db   (scripts/test-db.sh against supabase_db_imr-inventory)
  → 76/76 DB test file(s) passed
  → exit 0 (unchanged from original review — no DB-layer change in this fix
    round; report_reorder_list_no_inbound.test.sql / po_loop.test.sql /
    extension_ordering.test.sql all still green)

cd extension && npx vitest run
  → Test Files  5 passed (5)
  → Tests       31 passed (31)
  → exit 0 (unchanged — extension/ untouched by this spec, confirmed again)
```

No grep-piped runs; all three commands run directly with real exit codes
captured (`echo "EXIT:$?"` immediately after each). A one-off mutation check
(delete-then-restore the `onCsv` reset line) additionally confirmed
`npx jest` returns to 134/134 clean afterward with no residual diff.

### 4. AC-3 (staff Receiving tab) — restated, unchanged

Re-checked: `src/screens/staff/navigation/StaffStack.tsx` still has zero test
file (`find src/screens/staff -iname "*StaffStack*test*"` → no results), and
`e2e/` still has zero `Receiving` references. This fix round did not touch
AC-3 at all (correctly — it wasn't in scope; the fix-plan targeted AC-7 and
AC-9/AC-10 specifically) and I consider that a defensible, disclosed scoping
decision, not an omission from this round.

**My position is unchanged from the original report: I do NOT consider this
acceptable to note-and-ship without at least a flag, but it is a
pre-existing, disclosed gap rather than a spec-138 regression.** The
production-behavior risk is small (a single `Tab.Screen` removal, source-
confirmed absent, no plausible accidental re-add path since the screen file
itself is intentionally left on disk per the design's own note) — but "small
risk" is not the same as "tested," and the release-coordinator should treat
it as a NOT TESTED line item for AC-3 specifically, distinct from the two
items that ARE now resolved. If the team's bar is "every AC needs a test
before ship," this alone still blocks; if the bar is "no Critical regressions
introduced by this spec, pre-existing gaps tracked separately," this does not
block, since it long-predates spec 138 and none of the fix-plan's own claims
depended on it.

### Updated per-AC verdict table (spec 138, this addendum's scope only)

| AC | Original verdict | Addendum verdict | Notes |
|----|-------------------|-------------------|-------|
| AC-1 | PASS | PASS (unchanged) | not re-checked this round |
| AC-2 | PASS (indirect) | PASS (indirect, unchanged) | not re-checked this round |
| AC-3 | NOT TESTED | **NOT TESTED (unchanged)** | source-confirmed removal; zero test at any layer; pre-existing gap, not a regression |
| AC-4 | PASS | PASS (unchanged) | not re-checked this round |
| AC-5 | PASS | PASS (unchanged) | not re-checked this round |
| AC-6 | PASS | PASS (unchanged) | not re-checked this round |
| **AC-7** | **FAIL (partial — export-reset unimplemented)** | **PASS** | export-reset now implemented (success-only guard on CSV/PDF/quick-order) + mutation-verified test |
| AC-8 | PASS | PASS (unchanged) | not re-checked this round |
| **AC-9** | **PARTIAL (write path untested)** | **PASS** | `fillCartForVendor` now covered end-to-end (real store action, mocked `db`) |
| AC-11 | PASS | PASS (unchanged) | not re-checked this round |
| AC-12 | PASS | PASS (unchanged) | not re-checked this round |
| **AC-10** | **PARTIAL (write path untested)** | **PASS** | `upsertVendorDraftOrder` now covered end-to-end (real fn, mocked `supabase`) — create/update/skip-non-draft/insert-before-delete/failure-preserves all asserted |
| AC-13 | PASS | PASS (unchanged) | not re-checked this round |
| AC-14 | PARTIAL (named the AC-7 + AC-9/10 gaps) | **PASS** | both named gaps now closed |
| AC-15 | PASS | PASS (unchanged) | not re-checked this round |

### Overall statement

**Both previously-failed/flagged items are now resolved.** AC-7's
export-reset is implemented (success-only, correctly scoped per vendor,
mutation-verified against its test) and AC-9/AC-10's core write path
(`fillCartForVendor` → `upsertVendorDraftOrder`) now has real, non-stub
coverage matching every behavior named in the design's own test-plan bullet
(create/update/skip-non-draft, edited-qty overlay, referenceDate keying,
clear-on-success/preserve-on-failure, and the insert-before-delete ordering
fix). Full three-track re-run is green (134/134 jest suites, 1407/1407 tests;
76/76 pgTAP; 31/31 extension vitest). The only remaining gap from the
original report is **AC-3 (staff Receiving tab), still NOT TESTED** — a
pre-existing, disclosed gap that this fix round correctly did not attempt to
close (out of scope for the fix-plan), but which the release-coordinator
should still weigh as an open NOT TESTED acceptance criterion rather than
treat as resolved by this round.
