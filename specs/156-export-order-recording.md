# Spec 156: Record quick-order / CSV / PDF exports as draft orders

Status: READY_FOR_REVIEW

> **Owner request (verbatim intent — the thing being built).**
> Orders that leave the app as a quick-order paste list, a CSV, a vendor-import
> CSV (US FOODS / SYSCO), or a PDF — and are then phoned, texted, or emailed to
> the vendor — record **nothing**. There is no row anywhere that says what was
> asked for. So the POs list never shows those orders, and the spec-151
> `LAST JUL 29 · COUNTED 5 CS · ORDERED 13 CS` context line can never render for
> those vendors. It shows `NO PRIOR ORDER ON RECORD` forever, which is honest
> but useless — and US FOODS, the owner's largest vendor, is exactly one of them.
>
> **Shape.** When an admin generates an export for a vendor from the Ordering
> surface, the app ALSO records the exported lines as a **draft purchase order**
> via the SAME `upsertVendorDraftOrder` path FILL CART already uses. Same
> function, same idempotent per-`(store, vendor, reference_date)` upsert
> semantics, same `status = 'draft'`. Nothing about the export output changes.
>
> **Honesty rule (inherited from spec 151, binding).** An export is not a
> confirmed order. It is recorded as a `draft`, which spec 151 already renders as
> a tier-4 anchor tagged **NOT CONFIRMED**. MARK-SENT stays a deliberate human
> action in `POsSection`. Nothing in this spec promotes a draft to `sent`, and
> nothing in this spec claims an order was placed.

This closes **spec 151 OQ-5**, which the PM deferred with:
*"Should the quick-order-text / CSV / PDF export paths start recording a `draft`
PO so those orders gain a line record going forward? Default: NO in this spec —
it changes three shipped export flows and is a write-path change hiding inside a
display feature. Flagged for a follow-up spec."* This is that spec.

---

## PM summary (plain language, for the owner)

Today there are two ways an order leaves this app:

1. **FILL CART** (BJ's / Sam's, via the Chrome extension). This one *is*
   recorded — spec 138 writes a hidden draft purchase order, which is what the
   extension reads, and what the POs list shows.
2. **Everything else** — the quick-order paste list, the CSV, the US FOODS /
   SYSCO order file, the PDF. You export it, you phone or text the vendor, and
   the app forgets it ever happened.

After this spec, path 2 records the same kind of row path 1 already does. No new
button, no new screen, no confirmation dialog, no change to a single byte of the
exported file. You export exactly as you do today; a draft order quietly lands
behind it.

What you get from that, for free, with no further work:

- **The POs list shows the order.** Order history stops having a hole in it.
- **Spec 151's context line starts working for US FOODS.** Next week, the Wings
  row reads `LAST AUG 08 · COUNTED 5 CS · ORDERED 13 CS · NOT CONFIRMED`
  instead of `NO PRIOR ORDER ON RECORD`. Spec 151's anchor precedence already
  has a tier for exactly this kind of row — tier 4, `purchase_orders` with
  `status='draft'` — so no query, no RPC, and no UI in spec 151 changes.
- **Re-exporting the same day does not double-count.** The upsert is keyed on
  `(store, vendor, reference_date)` and replaces the lines. Export the CSV, then
  the PDF, then the quick-order list, all on the same day: one draft order, with
  whatever quantities were on screen at the last export.

Three things stated plainly:

1. **The export output does not change.** Same CSV bytes, same PDF, same paste
   text, same filenames, same toasts. If a reviewer diffs an exported file
   before and after this spec and finds a difference, that is a Critical.
2. **A recorded export is not a placed order, and we never say it is.** It sits
   at `draft` until a human taps MARK-SENT. Spec 151 renders it with the
   **NOT CONFIRMED** qualifier. That is the truth: you exported a list; whether
   the vendor picked up the phone is not something the app knows.
3. **The Approve Order screen is untouched.** Spec 149 already writes a real
   `order_approvals` row there — a better record than a draft PO. Recording a
   second row for the same decision would put a phantom draft in your POs list.
   See AC-14 and the precedence note.

### What actually changes, per path (investigated, not assumed)

| Export path | Call site | Records today | Records after this spec |
|---|---|---|---|
| Desktop quick-order share/copy | `ReorderSection.tsx:362` `ReorderQuickOrderButton.onShareQuickOrder` | no | **yes** |
| Desktop CSV (generic) | `ReorderSection.tsx:464` `onCsv` → `handleCsvExport` | no | **yes** |
| Desktop CSV (US FOODS / SYSCO import file) | `ReorderSection.tsx:464` `onCsv` → `handleImportExport` | no | **yes** |
| Desktop PDF | `ReorderSection.tsx:474` `onPdf` → `handlePdfExport` | no | **yes** |
| Phone quick-order share/copy | `PhoneOrdering.tsx:581` `OverflowSheet.runQuickOrder` | no | **yes** |
| Phone CSV (generic + import file) | `PhoneOrdering.tsx:609` `runCsv` | no (web-only path) | **yes**, on the successful web path |
| Phone PDF | `PhoneOrdering.tsx:624` `runPdf` | no (web-only path) | **yes**, on the successful web path |
| FILL CART | `useStore.ts:3388` `fillCartForVendor` | **yes** (spec 138) | unchanged |
| Approve Order (all 4 channels) | `useStore.ts` `approveAndOrder` | `order_approvals` (spec 149); extension channel also drafts via `fillCartForVendor` | **unchanged — no new write** |
| `POsSection` quick-order (existing PO) | `POsSection.tsx` | the PO already exists | **unchanged — not a call site** |
| Staff Reorder share/export | `src/screens/staff/lib/shareReorder.ts` | no | **unchanged — out of scope** |

Six call sites, four logical export kinds, two tiers. All six sit in the admin
Ordering surface and all six already gate their success on a boolean
(`ok` / `shared`) that the spec-138 edit-buffer reset uses — the same boolean
gates the recording.

## User stories

- **US-1 (the hole in history).** As a store admin who exports a US FOODS order
  file and phones the order in, I want the app to keep a record of what I
  ordered, so my POs list is a complete history instead of a partial one.
- **US-2 (last-order context for the vendors that need it most).** As a store
  admin, I want spec 151's `LAST … · ORDERED …` line to appear for my
  phone-in vendors, because those are precisely the vendors where I have no
  other way to recall last week's quantities.
- **US-3 (no accidental double-counting).** As a store admin who exports the
  CSV, changes my mind, edits a quantity and exports again, I want ONE order on
  record for that day, reflecting the last export — not two.
- **US-4 (no false confidence).** As a store admin, I want an exported order to
  read as *recorded, not confirmed*, until I say otherwise. The app must not
  imply the vendor received anything.
- **US-5 (nothing about my exports changes).** As a store admin, I want the
  exported files, the paste text, the filenames, and the toasts to be exactly
  what they are today. This feature is invisible at the moment of export.

## Acceptance criteria

### A. The recording — mechanism and reuse

- [ ] **AC-1 (reuse, do not fork).** The recording goes through the EXISTING
      `db.upsertVendorDraftOrder` ([src/lib/db.ts:1661](src/lib/db.ts)) with no
      change to its signature, body, or semantics. No second draft-PO writer is
      introduced, no direct `supabase.from('purchase_orders')` call site is
      added outside `db.ts`, and the CLAUDE.md `supabase.from/rpc` carve-out
      list is **not** extended. A reviewer finding a forked insert path treats
      it as a **Critical**.
- [ ] **AC-2 (one shared line builder).** The `{ itemId, orderedQty,
      costPerUnitCounted }` line array is produced by a single **pure**,
      exported helper (working name `buildDraftOrderLines(vendor, vendorEdits,
      inventory)`), extracted from the inline builder currently living inside
      `fillCartForVendor` ([src/store/useStore.ts:3399-3417](src/store/useStore.ts))
      and placed as a peer to `buildOrderApprovalLines`
      ([src/store/useStore.ts:96](src/store/useStore.ts)). `fillCartForVendor`
      is refactored to call it. The helper preserves, byte-for-byte:
      - the edit overlay `edits[itemId] ?? (suggestedUnits || suggestedQty || 0)`;
      - the spec-104 ★ bridge `costPerUnitCounted = costPerUnit × subUnitSize`
        (`subUnitSize` resolved from `inventory` by `itemId`, defaulting to 1) —
        **do not drop `subUnitSize`**;
      - the `itemId && orderedQty > 0` filter.
      A jest test pins the helper's output identical to the pre-refactor
      `fillCartForVendor` behavior on a fixture vendor with and without edits.
- [ ] **AC-3 (the store action).** A single new store action (working name
      `recordExportedOrder(vendor: ReorderVendor): Promise<string | null>`) is
      the ONLY thing the six call sites call. It resolves `storeId` from
      `currentStore`, `createdByUserId` from `currentUser`, `referenceDate` from
      `reorderPayload.asOfDate` — the SAME four values `fillCartForVendor`
      passes ([src/store/useStore.ts:3426-3433](src/store/useStore.ts)) — and
      returns the PO id or `null`. Call sites do not construct lines, do not
      touch `db.ts` directly, and do not duplicate the guards.
- [ ] **AC-4 (guard: no active single store).** When `currentStore` is missing
      or its id is `'__all__'`, the action performs **no write** and returns
      `null` **silently** — no toast, no `notifyBackendError`. Rationale: unlike
      FILL CART (an explicit user action whose failure must be reported), this
      is a background side effect of an export that already succeeded; shouting
      about it teaches the operator to ignore toasts.
- [ ] **AC-5 (guard: nothing to record).** When the built line array is empty
      (every line filtered out by the `qty > 0` / `itemId` filter), the action
      performs **no write** and returns `null` silently. An export with no
      orderable lines records nothing — no empty draft header, no zero-line PO.
      Pinned by a test.
- [ ] **AC-6 (failure posture — never breaks the export).** A recording failure
      (`upsertVendorDraftOrder` returns `null`, or throws) does **not** revert
      the export, does not re-open the export dialog, does not block or undo the
      spec-138 edit-buffer reset, and does not throw into the call site. It
      surfaces through the house `notifyBackendError('Record exported order', e)`
      path (console.warn + toast) and the action returns `null`. The export
      already left the building; the app reports that it failed to file a copy.
- [ ] **AC-7 (post-write refresh — POs list only).** On success the action calls
      `refreshPurchaseOrders()` so the new draft appears in `POsSection` order
      history. It does **not** call `loadReorderSuggestions()`. Rationale: a
      reorder reload after a CSV download is a visible mid-flow re-render of the
      list the operator is still reading, and the only reorder-payload field the
      write affects (`has_po`) is not rendered anywhere today (AC-REG-7). The
      architect may overrule with a written rationale in the design.

### B. Wiring — the six call sites

- [ ] **AC-8 (all six, no others).** `recordExportedOrder(vendor)` is invoked
      from exactly these six sites and nowhere else:
      1. `ReorderSection.tsx:362` `ReorderQuickOrderButton.onShareQuickOrder`
      2. `ReorderSection.tsx:464` `ReorderVendorExportButtons.onCsv` — **both**
         branches (`handleImportExport` for US FOODS / SYSCO, `handleCsvExport`
         otherwise)
      3. `ReorderSection.tsx:474` `ReorderVendorExportButtons.onPdf`
      4. `PhoneOrdering.tsx:581` `OverflowSheet.runQuickOrder`
      5. `PhoneOrdering.tsx:609` `OverflowSheet.runCsv` — both branches
      6. `PhoneOrdering.tsx:624` `OverflowSheet.runPdf`
- [ ] **AC-9 (success-gated — the same boolean the edit reset uses).** The
      recording fires ONLY on the branch that already resets the edit buffer:
      `ok === true` from `handleCsvExport` / `handleImportExport` /
      `handlePdfExport`, and `shared === true` from `sharePurchaseOrder`. A
      cancelled share sheet, a dismissed dialog, a failed PDF build, and the
      phone's non-web `Platform.OS !== 'web'` early return (which toasts
      `common.availableOnDesktop` and returns) all record **nothing**. Pinned by
      a test per branch.
- [ ] **AC-10 (ordering — record before clearing edits).** At every call site
      the recording is invoked **before** `clearReorderEditsForVendor(...)`, so
      the quantities recorded are the ones that were exported. A test pins the
      call order. (The `vendor` object is already overlaid by `applyReorderEdits`
      and `buildDraftOrderLines` re-derives the overlay defensively, so both
      orderings currently agree — the ordering is pinned so a future change to
      either side cannot silently record pre-edit quantities.)
- [ ] **AC-11 (the vendor object recorded is the one exported).** The `vendor`
      passed to `recordExportedOrder` is the SAME buffer-overlaid
      `ReorderVendor` the export builder consumed at that call site, so the
      recorded quantities equal the exported quantities line for line. A test
      pins one edited line: the CSV row, the PDF row, the paste line, and the
      recorded `ordered_qty` all carry the edited base quantity.

### C. Idempotency, precedence, and honesty

- [ ] **AC-12 (no double-recording on re-export — pinned, not assumed).** Two or
      more exports for the same `(store, vendor, reference_date)` on the same day
      — in any combination of quick-order / CSV / import-CSV / PDF / FILL CART —
      leave **exactly one** `purchase_orders` row with `status='draft'` for that
      key, whose `po_items` are the lines of the LAST export. This is the
      existing `upsertVendorDraftOrder` find-by-`(store_id, vendor_id,
      status='draft', reference_date)` → replace-lines behavior
      ([src/lib/db.ts:1683-1760](src/lib/db.ts)); this spec adds no new
      idempotency mechanism and must not need one. Pinned by a jest test that
      asserts every call passes an identical `(storeId, vendorId, referenceDate)`
      key, and — if the architect wants server-side proof — one pgTAP/scripted
      check that two upserts leave one header and one line set.
- [ ] **AC-13 (spec-151 anchor tier — verified, no spec-151 change).** An
      export-recorded draft is a **tier-4** anchor in spec 151's AC-2 precedence
      (`purchase_orders` with `status='draft'` → confidence `recorded`), which
      renders with the **NOT CONFIRMED** qualifier (spec 151 AC-3). It is
      **strictly before**-dated relative to the viewing date, so today's export
      does not annotate today's own list — it appears from the next cycle
      onward. **No change** is required to `report_last_order_context`,
      `src/utils/lastOrderContext.ts`, `buildLastOrderContext`,
      `lastOrderCardState`, or either tier's rendering. If the architect finds
      any spec-151 artifact needs editing to make this work, that is a design
      finding to raise **before** implementation, not a quiet edit.
- [ ] **AC-14 (Approve Order records nothing new — and precedence says which
      wins).** `approveAndOrder` ([src/store/useStore.ts](src/store/useStore.ts))
      is **not** a call site. Its `manual` channel shares the quick-order text
      *builder* but not the export *button*, so the seam is structural, not
      conventional. Stated precedence, should both records ever coexist for one
      `(store, vendor, date)` — e.g. an admin approves on the phone and later
      exports a CSV on the desktop:
      - `order_approvals` `status='ordered'` (tier 2) and `status='approved'`
        (tier 3) **both outrank** a `draft` PO (tier 4). The approval wins the
        spec-151 anchor. The context line is unaffected either way.
      - The only visible consequence of coexistence is an extra `draft` row in
        `POsSection`. That is why Approve Order does not record: one decision,
        one record.
      - The `extension` channel's existing `fillCartForVendor` draft write
        (spec 149 AC-17) is **unchanged** — it is the spec-138 path, not this
        one, and it is not double-fired.
      Pinned by a test: running `approveAndOrder` through the `manual`,
      `instacart`, and `webstaurant` channels calls `upsertVendorDraftOrder`
      **zero** times; the `extension` channel calls it exactly once (unchanged).
- [ ] **AC-15 (MARK-SENT stays manual).** No code path in this spec writes
      `status = 'sent'`, and `markPurchaseOrderSent` /
      `markPurchaseOrderSentManually` / `sendPurchaseOrderEmail` / `POsSection`
      are unchanged. An export produces a `draft` and stops. Promoting an export
      to `sent` would convert spec 151's honest **NOT CONFIRMED** into a
      fabricated **placed** — the exact thing spec 151's out-of-scope list
      forbids.

### D. Consequences that are real and must be surfaced, not discovered

- [ ] **AC-16 (extension pending-queue interaction — explicit, defaulted).** For
      a vendor with `vendors.extension_ordering = true`, an export-recorded draft
      becomes visible to the Chrome extension as a "pending order"
      (`get_pending_extension_orders` selects `status='draft' AND
      v.extension_ordering`,
      [supabase/migrations/20260723000000_extension_ordering.sql:175-180](supabase/migrations/20260723000000_extension_ordering.sql)).
      **PM default: record anyway**, uniformly, for every vendor. Rationale: the
      upsert key means an export and a FILL CART for the same day are the SAME
      row (never two), and the extension never auto-fills — a human picks the
      order off the pending list. The residual risk (an admin phones an order in
      via the export, then later fills the same draft from the extension and
      orders twice) is real but human-gated and is the price of a uniform rule.
      Flagged as **OQ-2** so the owner can flip it to "skip recording when
      `extensionOrdering` is true" at architect review; a test pins whichever
      behavior is chosen.
- [ ] **AC-17 (`has_po` flips — known and inert today).** Recording sets
      `report_reorder_list`'s per-vendor `has_po` to `true` for that
      `(store, vendor, as_of_date)`
      ([supabase/migrations/20260726000000_reorder_drop_inbound_term.sql:603](supabase/migrations/20260726000000_reorder_drop_inbound_term.sql)),
      exactly as FILL CART already does. `hasPo` is mapped
      ([src/lib/db.ts:4562](src/lib/db.ts),
      [src/screens/staff/lib/fetchReorder.ts:110](src/screens/staff/lib/fetchReorder.ts))
      but **rendered nowhere** today, so there is no visible change. Recorded
      here so that whoever eventually renders a "PO EXISTS" badge knows exports
      light it too.
- [ ] **AC-18 (no notification fires).** `tg_notify_purchase_order`
      ([supabase/migrations/20260715000000_submission_notifications.sql:244-276](supabase/migrations/20260715000000_submission_notifications.sql))
      emits only on a PO reaching `sent` / `partial` / `received`. A `draft`
      INSERT emits nothing, so exports produce **no** new bell entries and no
      push. Asserted, not assumed — a reviewer should confirm the trigger's
      status guard rather than trust this line.
- [ ] **AC-19 (realtime — no publication change).** `purchase_orders` is already
      a member of `supabase_realtime`
      ([supabase/migrations/20260705000000_cost_on_receipt.sql:94-98](supabase/migrations/20260705000000_cost_on_receipt.sql)),
      so the draft INSERT propagates on the existing `store-{id}` channel and
      other admin clients reload on the existing 400 ms debounce — identical to
      FILL CART today. **No table is added to or removed from the publication**,
      therefore the `docker restart supabase_realtime_imr-inventory` re-snapshot
      ritual (project MEMORY `project_realtime_publication_gotcha`) does **not**
      apply. If a revision does touch publication membership, that is a scope
      change and the gotcha must be raised.

### E. Regression group (AC-REG — nothing already shipped changes behavior)

- [ ] **AC-REG-1 (export outputs byte-unchanged).** `buildReorderCsv`,
      `buildPoQuickOrderText`, `planUsFoodsExport`, `planSyscoExport`,
      `handleCsvExport`, `handleImportExport`, `handlePdfExport`,
      `sharePurchaseOrder`, and every formatter in `src/utils/reorderExport.ts`
      are **unmodified**. Exported CSV bytes, PDF content, paste text,
      filenames, the desktop quick-order preview block, and every existing
      success/warning toast (`CSV exported`, unmapped-count, rounded-count,
      `common.availableOnDesktop`) are identical to today. The existing suites
      stay green with no edits: `src/utils/reorderExport.test.ts`,
      `src/utils/poQuickOrderText.test.ts`,
      `ReorderSectionCases.test.tsx`, `ReorderSection.spec123.test.tsx`,
      `ReorderSection.resetAfterExport.spec138.test.tsx`.
- [ ] **AC-REG-2 (FILL CART unchanged).** `fillCartForVendor`'s observable
      behavior is identical after the AC-2 extraction: same lines, same
      `upsertVendorDraftOrder` params, same `refreshPurchaseOrders()` +
      `loadReorderSuggestions()` + `clearReorderEditsForVendor` chain, same
      confirm dialog, same toasts, same `notifyBackendError('Fill cart', …)`
      strings on the no-store / no-lines / null-poId paths.
      `useStore.fillCartForVendor.spec138.test.ts` stays green **without
      edits** — if it needs editing, the extraction changed behavior.
- [ ] **AC-REG-3 (spec 151 unchanged).** `report_last_order_context`,
      `src/utils/lastOrderContext.ts`, the `lastOrderContext` store slice, the
      desktop context sub-line, and the phone `VendorOrderCard` context sub-line
      are **untouched**. This spec only causes more tier-4 anchors to exist.
- [ ] **AC-REG-4 (spec 149 unchanged *by this spec*).** `approveAndOrder`,
      `createOrderApproval`, `advanceOrderApproval`, `approveOrderState`, **the
      channel→disclosure-key resolution helper (whatever its current name and
      arity)**, channel routing, the `retailer_unavailable` fallback, and
      `PhoneApproveOrder` render output carry **no edit originating in spec
      156**. `useStore.approveOrder.spec149.test.ts` stays green against spec
      156's changes.
      > **Architect amendment (cross-spec, 2026-08-08).** Originally this AC
      > froze the symbol `disclosureKeyForChannel` by name. Spec 155
      > (READY_FOR_BUILD, building in parallel) **replaces** it with
      > `disclosureKeysForChannel(): string[]`. Freezing the outgoing symbol
      > would deadlock the two specs at review. The freeze is therefore on the
      > **behavior/surface**, not the identifier: spec 156 must not touch the
      > approve-order disclosure path at all, and a rename or arity change
      > arriving there is spec 155's and is **not** spec-156 drift. Likewise, if
      > spec 155 legitimately edits `useStore.approveOrder.spec149.test.ts`, that
      > is not an AC-REG-4 violation for this spec — the assertion is that the
      > suite is green **after** both land, with no spec-156-authored edit to it.
      > See Backend design §8 D-5.
- [ ] **AC-REG-5 (extension contract frozen).** `get_pending_extension_orders`,
      `get_extension_order_payload`, `markPurchaseOrderSent`, and the
      `extension/` build are unchanged; the extension vitest suite stays green.
      This spec writes the same rows via the same function the extension
      pipeline already reads.
- [ ] **AC-REG-6 (staff surface untouched).** `src/screens/staff/` is unchanged —
      including `shareReorder.ts` / `reorderExportStaff.ts`, which have their own
      cross-platform export orchestrator and are **not** wired to record.
- [ ] **AC-REG-7 (no backend change).** No migration, no RPC, no RLS policy, no
      index, no edge function, no publication change, no `db.ts` signature
      change. The write rides the existing `store_member_*` insert/update/delete
      policies on `purchase_orders` / `po_items` that FILL CART already uses from
      the same admin surface. The spec-053 `permissive_policy_lint` probe is
      untouched and stays green with no allowlist row. If the architect
      concludes a backend change IS required (see Design guidance 4), that is a
      design finding to raise before implementation.
- [ ] **AC-REG-8 (phone/desktop tier fork intact).** The spec-143 `isPhone` guard
      in `ReorderSection.tsx` stays placed AFTER all hooks; the existing
      `PhoneOrdering.acReg` suite stays green; no hook is added inside a
      conditional at any of the six call sites (three of them are inside
      `OverflowSheet` / button components that already call hooks — the new store
      selector goes at the top of the component body with the others).
- [ ] **AC-REG-9 (no new user-visible copy on the success path).** The feature
      adds **no** i18n key for the success case — a successful export looks
      exactly as it does today. The only new user-visible string is the AC-6
      failure toast, which routes through the existing `notifyBackendError`
      label convention (the same untranslated-label shape as
      `notifyBackendError('Fill cart', …)`). If the architect or the owner wants
      that failure surfaced with a localized string instead, it becomes an i18n
      key in **all three** catalogs (`en`, `es`, `zh-CN`) and the parity test
      must stay green.

### F. Tests (spec 022 tracks — the test-engineer routes by track name)

- [ ] **AC-20 (jest — the required track).** Covering:
      - `buildDraftOrderLines` purity + parity with the pre-refactor
        `fillCartForVendor` builder: edit overlay, ★ `subUnitSize` bridge,
        zero-qty and id-less line drops (AC-2).
      - Each of the six call sites records exactly once on success, with the
        correct `(storeId, vendorId, createdByUserId, referenceDate, lines)`
        (AC-8, AC-3).
      - Each failure/cancel branch records zero times: `handleCsvExport` false,
        `handleImportExport` false, `handlePdfExport` false,
        `sharePurchaseOrder` `shared:false`, and the phone non-web early return
        (AC-9).
      - No active store / `'__all__'` → no write, no toast (AC-4); empty lines →
        no write, no toast (AC-5).
      - Recording precedes `clearReorderEditsForVendor` (AC-10).
      - An edited quantity appears identically in the export payload and in the
        recorded lines (AC-11).
      - Re-export same day: every call carries an identical
        `(storeId, vendorId, referenceDate)` key (AC-12).
      - `approveAndOrder`: `manual` / `instacart` / `webstaurant` call
        `upsertVendorDraftOrder` zero times; `extension` calls it exactly once
        (AC-14).
      - A recording failure leaves the export result and the edit-buffer reset
        untouched and does not throw (AC-6).
      - AC-REG-1: the existing export-output suites pass unedited.
- [ ] **AC-21 (pgTAP — N/A unless the architect adds SQL).** This spec adds no
      migration, RPC, policy, or index, so **no pgTAP test is required**. Stated
      explicitly so the test-engineer does not invent one and a reviewer does not
      flag its absence as a gap. The one server-side property worth proving —
      "two upserts leave one header and one line set" (AC-12) — is already the
      shipped spec-138 behavior; if the architect wants it pinned, a pgTAP or
      scripted check is welcome but is not a gate.
- [ ] **AC-22 (shell smoke — explicitly N/A).** No edge function is added or
      modified.

## In scope

- One pure extracted helper (working name `buildDraftOrderLines`) shared by
  `fillCartForVendor` and the new recording action.
- One new store action (working name `recordExportedOrder`) that calls the
  existing `db.upsertVendorDraftOrder`.
- Wiring that action into the six enumerated export call sites in
  `ReorderSection.tsx` and `PhoneOrdering.tsx`, success-gated on the existing
  boolean and ordered before the existing edit-buffer reset.
- `refreshPurchaseOrders()` after a successful record so POs history shows it.
- Jest coverage per AC-20.

## Out of scope (explicitly — non-goals)

- **Changing any export output, builder, formatter, filename, preview, or
  toast.** Rationale: the whole value of this spec is that it is invisible at
  the moment of export (AC-REG-1).
- **Auto-marking an exported draft as `sent`.** Rationale: it would turn spec
  151's honest **NOT CONFIRMED** into a fabricated **placed**. MARK-SENT stays a
  human action (AC-15).
- **Recording from the Approve Order screen.** Rationale: spec 149 already
  writes `order_approvals` there — a strictly better record. A second row would
  be a phantom draft in POs history (AC-14).
- **Recording from `POsSection`'s quick-order action.** Rationale: that action
  shares an order for a PO that already exists. Nothing to record.
- **Recording from the staff Reorder screen** (`src/screens/staff/lib/shareReorder.ts`).
  Rationale: a separate surface with its own orchestrator, its own non-privileged
  auth posture, and its own spec lineage. Adding a PO write to a staff surface is
  an authorization decision, not a wiring decision — it needs its own spec.
  Flagged as **OQ-3**.
- **A provenance marker distinguishing an export-recorded draft from a
  cart-filled one** (e.g. a `source` column, a note, a badge). Rationale: it
  requires a migration and a UI decision for a distinction that changes nothing
  about how the row is read — both are honestly `draft` / NOT CONFIRMED.
  Flagged as **OQ-4**.
- **Backfilling past exports.** Rationale: the data does not exist. Forward-only,
  same as spec 151.
- **Making `upsertVendorDraftOrder` transactional.** The known non-atomic
  insert-then-delete window and the deferred "single SECURITY-INVOKER RPC that
  replaces the lines in one statement" FOLLOW-UP note
  ([src/lib/db.ts:1719-1721](src/lib/db.ts)) are inherited as-is. Rationale: this
  spec adds a second caller to an existing function; hardening that function is a
  separate, backend-shaped change. Flagged as **OQ-5**.
- **Rendering `has_po` anywhere** (AC-17), **changing the reorder math /
  suggestions / pars**, **any new section or button**, **any spec-151 query or
  UI change** (AC-REG-3), **any edge function, migration, RPC, policy, index, or
  realtime publication change** (AC-REG-7, AC-19).
- **`app.json` slug / identity drift.** Untouched — this feature adds no build
  identifier, store listing, or push-cert change (CLAUDE.md DO-NOT-AUTO-FIX).

## Open questions resolved

- Q: Which export paths record? → A: **All of them on the admin Ordering
  surface** — quick-order share/copy, generic CSV, US FOODS / SYSCO import CSV,
  and PDF, on **both** the desktop `ReorderSection` and the phone
  `PhoneOrdering` overflow sheet. Six call sites, enumerated in AC-8. The
  import-CSV branch is explicitly included because US FOODS — the owner's
  motivating example — goes out that way.
- Q: New write path or reuse? → A: **Reuse `upsertVendorDraftOrder` verbatim**
  (AC-1). Same function, same idempotent per-`(store, vendor, reference_date)`
  upsert, same `status='draft'`. No fork, no new RPC.
- Q: Double-recording when an export is regenerated the same day? → A: **The
  existing upsert semantics already cover it** — find-by-key, replace lines. One
  draft per `(store, vendor, reference_date)` regardless of how many exports
  fire. Pinned rather than assumed (AC-12).
- Q: Record when the export is empty? → A: **No.** Zero orderable lines ⇒ no
  write at all, silently (AC-5). No empty draft headers.
- Q: Record from the Approve Order screen? → A: **No** (AC-14). Spec 149 already
  writes `order_approvals`. Precedence if both somehow exist: the approval (tier
  2 or 3) outranks the draft (tier 4), so spec 151's line is unaffected; the
  only cost of coexistence would be a phantom draft in POs history, which is why
  we don't create it.
- Q: Does spec 151 need any change to pick these up? → A: **No** (AC-13,
  verified against the shipped tier table). `purchase_orders` `status='draft'` is
  already tier 4 → confidence `recorded` → rendered with **NOT CONFIRMED**.
  Zero further work.
- Q: MARK-SENT? → A: **Stays manual in `POsSection`** (AC-15). An export is a
  draft, honestly NOT CONFIRMED.
- Q: Frontend-only, or is backend work needed? → A: **Frontend-only.**
  `upsertVendorDraftOrder` suffices; the write rides the same `store_member_*`
  policies FILL CART already uses from the same admin surface. No migration, no
  RPC, no policy, no edge function (AC-REG-7). The architect is asked to confirm
  this at design time rather than inherit it (Design guidance 4).
- Q: Web or native? → A: **Both**, as far as each path already goes. Quick-order
  share/copy works on web and native; CSV/PDF are already web-only and stay so —
  the phone `Platform.OS !== 'web'` early return records nothing (AC-9).
- Q: Per-store or admin-global? → A: **Per-store**, keyed on `currentStore.id`;
  `'__all__'` records nothing (AC-4).
- Q: Realtime? → A: `purchase_orders` is **already published**; the draft INSERT
  rides the existing `store-{id}` channel exactly as FILL CART does. **No
  publication change ⇒ the `docker restart supabase_realtime_imr-inventory`
  ritual does not apply** (AC-19).
- Q: Edge function or PostgREST? → A: **PostgREST only**, through `db.ts`. No
  secret, no upstream, no HTML.

## Open questions (non-blocking — PM defaults chosen so the architect is unblocked)

Each has a default. The owner can override any at architect review without
reshaping the work.

- **OQ-1 — failure visibility.** A recording failure after a successful export:
  toast or silence? **Default: `notifyBackendError('Record exported order', e)`**
  — console.warn + toast (AC-6), matching the house convention. The counter-case
  is that the operator can do nothing about it and the export already worked, so
  a toast is noise. If the owner prefers silence, drop to `console.warn` only and
  accept that history can silently miss a row.
- **OQ-2 — extension-ordering vendors.** Record for them too, or skip?
  **Default: record uniformly** (AC-16), because the upsert key makes an export
  and a FILL CART the same row. Cost: an exported-and-phoned-in order for an
  extension vendor also appears in the extension's pending list, where a human
  could fill it and order twice. Alternative: skip recording when
  `vendor.extensionOrdering` is true — cleaner queue, but then those vendors keep
  the spec-151 blind spot whenever the admin exports instead of filling.
- **OQ-3 — the staff Reorder export.** Should staff exports record too?
  **Default: NO** — out of scope, separate surface, separate auth posture
  (staff are not privileged and a PO write from a staff surface is a policy
  decision). If the owner wants it, it is its own spec with an RLS review.
- **OQ-4 — provenance.** Should an export-recorded draft be distinguishable from
  a cart-filled one? **Default: NO marker** — both are `draft` / NOT CONFIRMED
  and read identically. Adding one costs a migration and a UI decision. If the
  owner wants to know "did I phone this in or fill a cart?", that becomes a
  column + a badge in a follow-up.
- **OQ-5 — transactional line replacement.** `upsertVendorDraftOrder`'s
  insert-then-delete has a documented non-atomic window with a deferred
  single-RPC follow-up ([src/lib/db.ts:1719-1721](src/lib/db.ts)). **Default:
  inherit as-is** — this spec adds a caller, not a hardening. If the architect
  judges that a second caller materially raises the odds of the transient
  doubled-lines state, say so in the design and the follow-up gets scheduled
  rather than smuggled in here.
- **OQ-6 — post-record refresh.** **Default: `refreshPurchaseOrders()` only, no
  `loadReorderSuggestions()`** (AC-7). If the architect wants full parity with
  FILL CART's refresh chain, the trade to argue is the visible mid-flow reorder
  re-render right after a download.

## Design guidance for the architect (not owner questions — do not reopen)

1. **Extract the line builder before wiring anything.** `fillCartForVendor` and
   the new action must produce byte-identical lines forever. That is a property
   of sharing one pure function, not of two careful copies. Put
   `buildDraftOrderLines` next to `buildOrderApprovalLines`
   ([src/store/useStore.ts:96](src/store/useStore.ts)), give it the same
   `(vendor, vendorEdits, inventory)` shape, and refactor `fillCartForVendor` to
   call it in the same commit. If `useStore.fillCartForVendor.spec138.test.ts`
   needs an edit to stay green, the extraction changed behavior — stop.

2. **Wire at the call sites, never inside the shared builders.**
   `sharePurchaseOrder`, `buildPoQuickOrderText`, `handleCsvExport`, and
   `handlePdfExport` are shared with `POsSection`, with `approveAndOrder`'s
   manual channel, and (in formatter form) with the staff surface. A recording
   call inside any of them would fire from surfaces this spec explicitly
   excludes. The six enumerated call sites are the seam, and the seam is what
   keeps AC-14 structural rather than conventional.

3. **One action, one guard set.** All six sites call the same
   `recordExportedOrder(vendor)` with nothing but the vendor. Store resolution,
   the `'__all__'` guard, the empty-lines guard, the failure posture, and the
   refresh all live inside it. Six copies of a guard is six places to drift.

4. **Confirm the frontend-only claim in writing, don't inherit it.** The claim is
   that FILL CART's existing `store_member_insert_purchase_orders` /
   `store_member_insert_po_items` posture already covers this caller because it
   is the same function, the same admin surface, and the same role. Verify that
   against the shipped policies and record the verification in the design. If it
   holds, AC-REG-7 stands and no backend developer is needed. If it does not,
   say so loudly — it changes the pipeline.

5. **Do not touch spec 151.** The whole point is that the tier-4 anchor path
   already exists and already renders NOT CONFIRMED. If you find yourself editing
   `lastOrderContext.ts` or the RPC, stop and raise it — either the tier table
   was misread, or scope has grown.

6. **Watch the "strictly before" boundary.** An export recorded today is dated
   today (`reference_date = reorderPayload.asOfDate`), and spec 151 anchors only
   on records strictly *before* the viewed date. So today's export never
   annotates today's own list, and there is no self-reference loop to design
   around. This also means the owner will not see the feature work until the next
   ordering cycle — worth saying out loud in the release notes so it does not
   read as a bug.

7. **Nothing here is realtime work.** `purchase_orders` is already published; the
   INSERT rides the existing channel. Keep it that way and the
   `project_realtime_publication_gotcha` ritual never enters this spec (AC-19).

## Dependencies

- [src/lib/db.ts:1661](src/lib/db.ts) — `upsertVendorDraftOrder` (spec 138): the
  reused write, unchanged. Its find-by-`(store_id, vendor_id, status='draft',
  reference_date)` → replace-lines behavior IS the AC-12 idempotency guarantee.
- [src/store/useStore.ts:3388](src/store/useStore.ts) — `fillCartForVendor`: the
  source of the AC-2 line builder and of the AC-3 parameter set.
  [src/store/useStore.ts:96](src/store/useStore.ts) — `buildOrderApprovalLines`:
  the shape/placement precedent for the extracted helper.
- [src/screens/cmd/sections/ReorderSection.tsx](src/screens/cmd/sections/ReorderSection.tsx)
  — `ReorderQuickOrderButton.onShareQuickOrder` (:362), `ReorderVendorExportButtons.onCsv`
  (:464), `.onPdf` (:474), `handleCsvExport` (:1042), `handleImportExport` (:1102),
  `handlePdfExport` (:1134), `narrowReorderToVendor` (:146), `applyReorderEdits` (:115).
- [src/screens/cmd/sections/phone/PhoneOrdering.tsx](src/screens/cmd/sections/phone/PhoneOrdering.tsx)
  — `OverflowSheet.runQuickOrder` (:581), `runCsv` (:609), `runPdf` (:624).
- [src/screens/cmd/lib/sharePo.ts](src/screens/cmd/lib/sharePo.ts) —
  `sharePurchaseOrder`'s `{ shared }` boolean (the AC-9 gate on the share paths).
- [src/utils/poQuickOrderText.ts](src/utils/poQuickOrderText.ts),
  [src/utils/reorderExport.ts](src/utils/reorderExport.ts),
  [src/utils/usFoodsImport.ts](src/utils/usFoodsImport.ts),
  [src/utils/syscoImport.ts](src/utils/syscoImport.ts) — the export builders.
  **Read-only; frozen** (AC-REG-1).
- [src/utils/lastOrderContext.ts](src/utils/lastOrderContext.ts) + the spec-151
  `report_last_order_context` RPC — the downstream consumer. **Not modified**
  (AC-13, AC-REG-3).
- [supabase/migrations/20260723000000_extension_ordering.sql](supabase/migrations/20260723000000_extension_ordering.sql)
  — `get_pending_extension_orders`' `status='draft' AND extension_ordering`
  predicate (AC-16). Frozen (AC-REG-5).
- [supabase/migrations/20260726000000_reorder_drop_inbound_term.sql](supabase/migrations/20260726000000_reorder_drop_inbound_term.sql)
  — `report_reorder_list`'s `has_po` EXISTS (AC-17). Read-only.
- [supabase/migrations/20260715000000_submission_notifications.sql](supabase/migrations/20260715000000_submission_notifications.sql)
  — `tg_notify_purchase_order`'s sent/partial/received guard (AC-18). Read-only.
- [supabase/migrations/20260704000000_po_loop.sql](supabase/migrations/20260704000000_po_loop.sql)
  — the `draft | sent | partial | received | cancelled` vocabulary and the
  `store_member_*` policies on `purchase_orders` / `po_items` the write rides.
- [supabase/migrations/20260705000000_cost_on_receipt.sql](supabase/migrations/20260705000000_cost_on_receipt.sql)
  — the on-record note that `purchase_orders` is already in `supabase_realtime`
  (AC-19).
- Existing suites that must stay green unedited:
  `src/store/useStore.fillCartForVendor.spec138.test.ts`,
  `src/store/useStore.approveOrder.spec149.test.ts`,
  `src/screens/cmd/sections/__tests__/ReorderSection.resetAfterExport.spec138.test.tsx`,
  `ReorderSection.spec123/130/135.test.tsx`, `ReorderSectionCases.test.tsx`,
  `src/utils/reorderExport.test.ts`, `src/utils/poQuickOrderText.test.ts`,
  the `PhoneOrdering.acReg` suite, and the `extension/` vitest suite.
- **No new migration.** Therefore no MCP prod-apply and no
  `schema_migrations` insert — `db-migrations-applied.yml` should never go red
  for this spec. If it does, something outside this spec's scope was added.

## Project-specific notes

- **Cmd UI section / legacy:** admin Cmd UI. Desktop
  `src/screens/cmd/sections/ReorderSection.tsx`; phone
  `src/screens/cmd/sections/phone/PhoneOrdering.tsx`. No legacy admin surface
  exists (spec 025).
- **Which app:** this repo (admin) only. `src/screens/staff/` is untouched
  (AC-REG-6, OQ-3); the customer PWA is a sibling; the Chrome extension is an
  unmodified downstream reader of the rows this spec writes (AC-16, AC-REG-5).
- **Per-store or admin-global:** **per-store.** Keyed on `currentStore.id`;
  `'__all__'` records nothing (AC-4). The write inherits the existing
  `store_member_*` RLS on `purchase_orders` / `po_items` — **no new policy**, so
  the spec-053 `permissive_policy_lint` probe stays green with no allowlist
  addition.
- **Edge function or PostgREST:** **PostgREST only**, via the existing
  `db.upsertVendorDraftOrder`. No edge function; the CLAUDE.md
  `supabase.from/rpc` carve-out list is **not** extended.
- **Realtime channels touched:** **`store-{id}`, existing propagation only.**
  `purchase_orders` is already in `supabase_realtime`, so the draft INSERT is
  picked up by the existing debounced sync exactly as FILL CART's is. **No
  publication membership change ⇒ the `docker restart
  supabase_realtime_imr-inventory` re-snapshot ritual (project MEMORY
  `project_realtime_publication_gotcha`) does NOT apply.** A revision that
  changes publication membership is a scope change and must raise the gotcha.
- **Migrations needed:** **no.** No DDL, no RPC, no policy, no index.
- **Edge functions touched:** **none.**
- **Web/native scope:** admin app, **both** web (Vercel) and native (EAS), phone
  and desktop tiers. The quick-order share path runs on both; CSV/PDF stay
  web-only exactly as today, and the native early-return records nothing (AC-9).
- **Tests (spec 022 tracks):** **jest** (AC-20). **pgTAP explicitly N/A**
  (AC-21) — no SQL changes. **Shell smoke explicitly N/A** (AC-22) — no edge
  function.
- **`app.json` slug:** untouched. Nothing here touches build identifiers, store
  listings, or push certs (CLAUDE.md DO-NOT-AUTO-FIX).
- **CI:** both gates (`test.yml`, `db-migrations-applied.yml`) must be green on
  `main` before this ships. Unlike spec 151, this spec adds no migration, so
  `db-migrations-applied.yml` should stay green throughout — a red run means
  scope escaped.

## Handoff

next_agent: backend-architect
prompt: Design the contract for this spec. Read the acceptance criteria
  and any project-specific notes, then produce the design doc and set
  Status: READY_FOR_BUILD.
payload_paths:
  - specs/156-export-order-recording.md

---

# Backend design

**Verdict: FRONTEND-ONLY. Confirmed, not inherited — see §1.** No migration, no
RPC, no policy, no index, no edge function, no publication change. One backend
artifact is *read* and reused verbatim (`db.upsertVendorDraftOrder`); nothing in
`src/lib/db.ts` changes. `backend-developer` is **not** required for this spec.

Two design findings the PM did not have, both resolved inside the spec's existing
envelope (no scope growth, no new backend surface):

- **F-1 (Should-fix, resolved in D-4).** Two of the six call sites
  (`ReorderVendorExportButtons.onCsv` / `.onPdf`, ReorderSection.tsx:464/474)
  have **no `busy` guard** — a double-click fires two overlapping records for the
  same key. `upsertVendorDraftOrder` has no unique index behind it, so two
  concurrent find-then-insert passes can leave **two** draft headers for one
  `(store, vendor, reference_date)` — an AC-12 violation. Fixed with an in-action
  in-flight key guard (D-4), not with a migration.
- **F-2 (Known-consequence, no code change — see §6).** The draft INSERT echoes
  back to the *exporting* client on the existing `store-{id}` channel, and
  `loadFromSupabase` sets `reorderPayload: null` on **every** reload (not only on
  store switch — the spec-138 comment at [src/store/useStore.ts:1836](src/store/useStore.ts)
  states this explicitly). So the reorder list blanks and refetches ~400 ms after
  every export. Identical to FILL CART today, but exports are far more frequent.
  This must be in the release notes so it does not read as a bug; it also makes
  the AC-7 / OQ-6 ruling (no `loadReorderSuggestions()`) *more* correct, not less.

---

## 1. The frontend-only claim — verified in writing (Design guidance 4)

The claim is that FILL CART's existing RLS posture already covers this caller.
Verified against the shipped policies, not assumed.

`upsertVendorDraftOrder` ([src/lib/db.ts:1661-1795](src/lib/db.ts)) performs at
most six statements. Every one is already admitted by a `store_member_*` policy
created in [supabase/migrations/20260504173035_per_store_rls_hardening.sql:183-251](supabase/migrations/20260504173035_per_store_rls_hardening.sql):

| Statement in `upsertVendorDraftOrder` | Policy | Predicate |
|---|---|---|
| `select id from purchase_orders` (find-by-key) | `store_member_read_purchase_orders` (SELECT) | `auth_can_see_store(store_id)` |
| `insert into purchase_orders` (fresh header) | `store_member_insert_purchase_orders` (INSERT) | `with check (auth_can_see_store(store_id))` |
| `update purchase_orders set total_cost` | `store_member_update_purchase_orders` (UPDATE) | `auth_can_see_store(store_id)` USING + WITH CHECK |
| `delete from purchase_orders` (orphan-header cleanup, [db.ts:1790](src/lib/db.ts)) | `store_member_delete_purchase_orders` (DELETE) | `auth_can_see_store(store_id)` |
| `select id from po_items` / `insert into po_items` | `store_member_read_po_items` / `store_member_insert_po_items` | `exists (select 1 from purchase_orders po where po.id = po_items.po_id and auth_can_see_store(po.store_id))` |
| `delete from po_items` (old lines) | `store_member_delete_po_items` | same FK-scoped `exists` |

Findings:

1. **No new policy, no policy edit, no allowlist row.** The write is `store_id`
   = `currentStore.id`, and `currentStore` is by construction a store the caller
   can see (it comes from the RLS-clipped `stores` load). `auth_can_see_store()`
   therefore passes for exactly the same reason it passes for FILL CART.
2. **No privilege escalation.** These policies gate on *store visibility*, not on
   `auth_is_admin()` / `auth_is_privileged()`. That is the pre-existing posture
   for `purchase_orders`; this spec adds no new caller *class* — the six call
   sites live in `src/screens/cmd/sections/`, which `RoleRouter` only mounts for
   admin roles. A non-privileged store member could already write a draft PO via
   PostgREST before this spec; that is a pre-existing (accepted) property of the
   spec-138 design and is explicitly **not** widened here. If a reviewer wants
   role-gating on `purchase_orders` writes, that is its own spec.
3. **spec-053 `permissive_policy_lint` stays green with no edit.** No policy is
   added, so there is nothing new to lint; none of the six existing policies is
   trivially-wide.
4. **AC-REG-7 stands.** No migration filename is proposed. There is no
   `supabase/migrations/YYYYMMDDHHMMSS_*.sql` in this spec, therefore no MCP
   prod-apply, no `schema_migrations` insert, and `db-migrations-applied.yml`
   must stay green. A red run on this spec means scope escaped.

Three read-only backend facts the spec asserts, re-verified at source so the
developer and reviewers do not have to:

- **AC-18 (no notification).** `tg_notify_purchase_order`
  ([20260715000000_submission_notifications.sql:251-269](supabase/migrations/20260715000000_submission_notifications.sql))
  emits only when `new.status = 'sent'` or `new.status in ('partial','received')`.
  A `draft` INSERT and a `total_cost`-only UPDATE both fall through both guards
  and emit nothing. **Confirmed — no bell entry, no push.**
- **AC-19 (publication).** `public.purchase_orders` is a member of
  `supabase_realtime` as of
  [20260514140000_realtime_publication_tighten.sql:47](supabase/migrations/20260514140000_realtime_publication_tighten.sql).
  `po_items` is **not** a member and is not added. **Confirmed — no publication
  membership change; see §6 for the gotcha ruling.**
- **AC-16 (extension queue).** `get_pending_extension_orders`
  ([20260723000000_extension_ordering.sql:177-178](supabase/migrations/20260723000000_extension_ordering.sql))
  selects `po.status = 'draft' and v.extension_ordering`. **Confirmed —
  export-recorded drafts for an extension vendor DO appear in the pending list.**
  Ruling in §2 (OQ-2).

## 2. Open-question rulings

| OQ | Ruling | Rationale |
|---|---|---|
| **OQ-1** failure visibility | **PM default stands** — `notifyBackendError('Record exported order', e)` | House convention ([useStore.ts:23](src/store/useStore.ts)). Silence here would mean order history can lose a row with no signal anywhere; a `console.warn`-only posture is exactly the spec-031/032 silent-fake-success shape the project has twice regressed on. The toast is rare (only on a failed write) and never fires on the happy path (AC-REG-9). |
| **OQ-2** extension-ordering vendors | **RECORD UNIFORMLY — PM default stands.** See below. | |
| **OQ-3** staff Reorder export | **NO** — out of scope, unchanged | A PO write from `src/screens/staff/` is an authorization decision (staff are non-privileged; the `store_member_*` policies would admit them, which is precisely why it needs a deliberate spec + RLS review, not a wiring change). `src/screens/staff/` is untouched (AC-REG-6). |
| **OQ-4** provenance marker | **NO marker in this spec** — but see the OQ-2 residual | Costs a migration + a UI decision. Named below as the correct home for the OQ-2 residual mitigation. |
| **OQ-5** transactional line replacement | **Inherit as-is. Do NOT harden `upsertVendorDraftOrder` here.** | The non-atomic insert-then-delete window ([db.ts:1719-1721](src/lib/db.ts)) is bounded by sequential awaits in a single client; a second *caller* does not raise its odds. What *does* raise the odds is a second **concurrent** call for the same key — finding F-1 — and that is closed client-side by D-4, without touching `db.ts`. The single-RPC follow-up stays deferred and unscheduled by this spec. |
| **OQ-6** post-record refresh | **PM default stands** — `refreshPurchaseOrders()` only, **no** `loadReorderSuggestions()` | Strengthened rationale: the realtime self-echo (§6 / F-2) already nulls `reorderPayload` and forces a section refetch ~400 ms after the write. Calling `loadReorderSuggestions()` would add a **second** `report_reorder_list` round trip on top of that, on the 286 KB seed, for a field (`has_po`) that is rendered nowhere (AC-17). Full parity with FILL CART's chain would be strictly worse here. |

### OQ-2 ruling in full: record uniformly, for every vendor

**Decision: record for extension-ordering vendors too.** The PM default stands.
Do **not** branch on `vendor.extensionOrdering` anywhere in this feature.

Reasoning, in the order that decided it:

1. **The upsert key makes export and FILL CART the same row — always.** The find
   is `(store_id, vendor_id, status='draft', reference_date)`
   ([db.ts:1683-1696](src/lib/db.ts)). An export followed by a FILL CART (or the
   reverse, or five of each) for the same vendor on the same day converges on
   **one** header with the last-written line set. The extension's pending list
   therefore **cannot** grow beyond one entry per (vendor, day) as a result of
   this spec. The failure mode "the queue fills with export ghosts" does not
   exist.
2. **The hazard class already ships.** For an extension vendor, an admin can
   already FILL CART *and* export a CSV and phone the order in. This spec widens
   the entry point into the pending list; it does not create the double-order
   risk. And consumption is human-gated end to end — `get_pending_extension_orders`
   feeds a list the operator picks from; nothing auto-fills, nothing auto-submits.
3. **Skipping would silently reintroduce the exact blind spot this spec exists to
   close, for a moving subset of vendors.** `vendors.extension_ordering` is an
   operator-flippable field in the Vendors admin. A "skip when extensionOrdering"
   rule means the spec-151 context line works for a vendor on Monday and stops
   working on Tuesday because someone ticked a checkbox in another section, with
   no user-visible explanation. That is a worse bug than the one being avoided.
4. **It keeps AC-3 honest.** "One action, one guard set" survives only if the
   action has no per-vendor conditionals. A `extensionOrdering` branch is a
   vendor-shaped exception that every future caller of `recordExportedOrder` would
   have to re-derive.
5. **The exposure is small in practice.** For an extension vendor the primary CTA
   *is* FILL CART — on the phone it replaces the quick-order button entirely
   ([PhoneOrdering.tsx:500-541](src/screens/cmd/sections/phone/PhoneOrdering.tsx));
   the export paths are the overflow route.

**Named residual (do not bury it).** An admin who exports for an extension
vendor, phones the order in, then later fills the same draft from the extension
and submits it, orders twice. Human-gated, but real. The correct mitigation is
**OQ-4 provenance** — a `purchase_orders.source` column (`'export'` |
`'fill_cart'`) plus a "PHONED IN" tag on the extension's pending row — which is a
migration + an extension-build change and therefore **explicitly out of this
spec**. Recommended as the immediate follow-up spec; recorded here so the owner
is choosing it rather than discovering it.

## 3. Data model changes

**None.** No table, column, index, constraint, view, RPC, trigger, or grant.
No migration file. Rows written are `purchase_orders` (one header per
`(store, vendor, reference_date)`) and `po_items` (its lines), through the
existing writer. Rollout safety is trivial: additive rows in an existing shape
that the POs list, the extension RPCs, `report_reorder_list.has_po`, and spec
151's tier-4 anchor already know how to read.

One consequence worth recording so no reviewer mis-flags it: **recorded
quantities are base COUNTED units** (`po_items.ordered_qty`), exactly as FILL
CART records them. An export file that ceils to cases (quick-order text, the US
FOODS / SYSCO import file) will show a *case* figure that differs numerically
from the recorded base figure. That is a presentation-layer conversion, not
drift — it is the same basis relationship that already exists between the
quick-order text and the spec-138 draft. AC-11 ("the recorded qty equals the
exported qty") is satisfied at the **base-unit** level, which is the level
`po_items` and spec 151 both speak.

## 4. RLS impact

**No new table, no policy added, no policy modified.** See §1 for the
statement-by-policy verification. For the record, in the format this project's
designs use:

- `public.purchase_orders` — SELECT/INSERT/UPDATE/DELETE all via
  `store_member_*_purchase_orders`, helper `auth_can_see_store(store_id)`.
  **Unchanged.**
- `public.po_items` — SELECT/INSERT/UPDATE/DELETE all via
  `store_member_*_po_items`, helper `auth_can_see_store(po.store_id)` through the
  FK `exists`. **Unchanged.**
- `auth_is_admin()` is **not** used on this path and is not introduced. The
  admin-only property comes from `RoleRouter` mounting the Cmd surface, which is
  where it already comes from for FILL CART.
- spec-053 `permissive_policy_lint` allowlist: **no row added.**

## 5. API contract

**PostgREST, through `src/lib/db.ts`. No RPC, no edge function, no new
`db.ts` export.** The decision is forced by AC-1 and is correct on the merits: a
new RPC would be a second draft-PO writer with its own drift surface, for a
caller that needs exactly the semantics the shipped writer already has.

Reused verbatim (signature, body and semantics **frozen**):

```ts
// src/lib/db.ts:1661 — UNCHANGED
upsertVendorDraftOrder(params: {
  storeId: string;
  vendorId: string;
  createdByUserId?: string;
  referenceDate?: string;                                  // YYYY-MM-DD
  lines: Array<{ itemId: string; orderedQty: number; costPerUnitCounted: number }>;
}): Promise<string | null>
```

- **Request shape** (what `recordExportedOrder` passes): `storeId` =
  `currentStore.id`; `vendorId` = `vendor.vendorId`; `createdByUserId` =
  `currentUser?.id`; `referenceDate` = `reorderPayload?.asOfDate || undefined`;
  `lines` = `buildDraftOrderLines(...)`. Identical to the four values
  `fillCartForVendor` passes ([useStore.ts:3426-3433](src/store/useStore.ts)) —
  AC-3.
- **Response shape:** the po id (`string`) on success; `null` on empty lines,
  RLS denial, or any step failure (the function `console.warn`s internally at
  each step).
- **Error cases and how they surface:** `null` return → `notifyBackendError`
  from the action (OQ-1); a thrown error (network, or the 30 s
  `InflightTimeoutError` from `useInflight.track`, which this call runs under with
  `kind: 'write'`, [db.ts:1794](src/lib/db.ts)) → caught by the action's own
  `try/catch` → same `notifyBackendError`. **Neither ever propagates to a call
  site** (D-3).
- **No `expected_delivery`** is set — inherited from the writer's doc comment
  ([db.ts:1650-1653](src/lib/db.ts)); the spec-125 auto-receive cron stays inert
  by starvation for export-recorded drafts exactly as for cart-filled ones.

## 6. Realtime impact

**Channel: `store-{id}`. Existing propagation only.**

`purchase_orders` is already published
([20260514140000_realtime_publication_tighten.sql:47](supabase/migrations/20260514140000_realtime_publication_tighten.sql))
and already subscribed with `filter: store_id=eq.<id>`
([useRealtimeSync.ts:54](src/hooks/useRealtimeSync.ts)). The header INSERT (first
export of the day) and the header `total_cost` UPDATE (every subsequent export
for the same key) both fire `onSync` → the 400 ms debounce
([CmdNavigator.tsx:63-70](src/navigation/CmdNavigator.tsx)) → `loadFromSupabase`.
`po_items` is **not** published, so line churn emits nothing on its own.

**Publication gotcha: DOES NOT APPLY.** This spec changes no
`supabase_realtime` membership, so **no `docker restart
supabase_realtime_imr-inventory` is needed after `npm run dev:db`** (project
MEMORY `project_realtime_publication_gotcha`). This is stated so the developer
does not perform the ritual "just in case" and then attribute an unrelated local
symptom to it. If any revision of this work adds or removes a published table,
that is a scope change and the gotcha must be raised as a **dev/deploy step**,
never treated as a runtime concern.

**F-2 — the self-echo, and what the owner will actually see.** Realtime
`postgres_changes` has no originator suppression: the exporting client receives
its own INSERT/UPDATE. `loadFromSupabase` sets `reorderPayload: null`
unconditionally in its main `set({...})` block
([useStore.ts:1827](src/store/useStore.ts)) — the "on store switch" comment above
it is misleading, and the spec-138 comment fourteen lines below
([useStore.ts:1836-1843](src/store/useStore.ts)) says so outright: *"This `set`
runs on EVERY realtime reload … incl. the purchase_orders change Fill cart itself
emits."* Consequences:

1. **~400 ms after every export the reorder list blanks and refetches.** Not new
   code, not caused by anything this design adds, and identical to FILL CART and
   to any inventory/EOD/waste change from any admin client on the store today.
   But exports are frequent, so the operator will notice it *more*.
2. **The edit buffer survives** — `reorderEdits` is deliberately not reset there
   (same comment), so the AC-10 clear at the call site remains the only thing
   that clears it. No interaction.
3. **Ruling: accept, change nothing, put it in the release notes.** Suppressing
   it would require narrowing the realtime handler (a separate spec's worth of
   blast radius) or a publication change (which drags in the gotcha). It is not
   an AC-REG-1 violation — export bytes, filenames, preview text and toasts are
   untouched; this is a list repaint on the underlying section.
4. It is also the reason AC-7 / OQ-6 is right: adding `loadReorderSuggestions()`
   would stack a second refetch on top of a refetch that is already coming.

Other admin clients on the same store reload on the same debounce — the intended
behavior, unchanged from FILL CART.

## 7. `src/lib/db.ts` surface

**No change. No new export, no signature change, no new helper, no new
`mapItem`-style mapper.** There is no snake_case → camelCase mapping to add:
`upsertVendorDraftOrder` is a write and returns a bare id string. The CLAUDE.md
`supabase.from/rpc` carve-out list is **not** extended — a direct
`supabase.from('purchase_orders')` anywhere outside `db.ts` is a **Critical**
(AC-1).

## 8. Frontend store impact — `src/store/useStore.ts`

Slice touched: the **spec-138 reorder edit-buffer / cart-filler slice**
(interface [useStore.ts:651-671](src/store/useStore.ts); implementation
[useStore.ts:3367-3451](src/store/useStore.ts)). Nothing else in the store moves.

**Optimistic-then-revert: DOES NOT APPLY.** There is no local mirror of the
written row and no UI that renders it before the server confirms — the POs list
is repopulated from the server by `refreshPurchaseOrders()`. The only
optimistic-shaped state nearby is the edit buffer, and AC-6 forbids reverting it
on a record failure (the export already left the building). `notifyBackendError`
is used purely as the failure *reporter* (OQ-1), not as the revert trigger.

### D-1 — `buildDraftOrderLines` (pure, exported, peer of `buildOrderApprovalLines`)

Placement: immediately after `buildOrderApprovalLines`
([useStore.ts:96-117](src/store/useStore.ts)), same module-level "spec helpers"
block, above `const DARK_MODE_KEY`.

```ts
/** The line shape `db.upsertVendorDraftOrder` consumes. Naming the type here is
 *  NOT a db.ts signature change — db.ts keeps its inline literal and accepts
 *  this structurally. */
export type DraftOrderLine = {
  itemId: string;
  orderedQty: number;          // BASE / COUNTED units
  costPerUnitCounted: number;  // ★ spec-104 bridge: costPerUnit(per-each) × subUnitSize
};

export function buildDraftOrderLines(
  vendor: ReorderVendor,
  vendorEdits: Record<string, number> | undefined,
  inventory: InventoryItem[],
): DraftOrderLine[];
```

Behavior — a **verbatim** lift of the inline builder at
[useStore.ts:3399-3417](src/store/useStore.ts), no cleanups, no renames, no
"while I'm here":

- `const edits = vendorEdits || {}` (matches `buildOrderApprovalLines`' `|| {}`,
  and matches `fillCartForVendor`'s current `|| {}` on the caller side — same
  result);
- per item: `subUnitSize = inventory.find(i => i.id === it.itemId)?.subUnitSize || 1`;
- `orderedQty = edits[it.itemId] ?? (it.suggestedUnits || it.suggestedQty || 0)`
  — the defensive re-derive of the overlay, kept for the same reason it exists
  today (both callers pass an `applyReorderEdits`-overlaid vendor, so the two
  paths agree; the re-derive keeps the helper correct for a future non-overlaid
  caller);
- `costPerUnitCounted = it.costPerUnit * subUnitSize` — **the ★ spec-104 bridge.
  Dropping `subUnitSize` here silently mis-costs every recorded order and is the
  single easiest thing in this spec to get wrong** (see project MEMORY
  `project_menu_costing_state`);
- `.filter(ln => ln.itemId && ln.orderedQty > 0)`.

`fillCartForVendor` is refactored **in the same commit** to:

```ts
const lines = buildDraftOrderLines(vendor, get().reorderEdits[vendor.vendorId], get().inventory);
```

with everything else in that action byte-identical. **Gate:
`src/store/useStore.fillCartForVendor.spec138.test.ts` must stay green with
ZERO edits** (AC-REG-2). If it needs an edit, the extraction changed behavior —
stop and revert rather than adjust the test.

### D-2 — `recordExportedOrder` (the one action the six sites call)

Interface entry goes directly below `fillCartForVendor`
([useStore.ts:671](src/store/useStore.ts)):

```ts
/**
 * Spec 156 — record an already-completed export as a `draft` purchase order,
 * through the SAME db.upsertVendorDraftOrder path FILL CART uses. Background
 * side effect of an export that already succeeded: it NEVER throws, never
 * reverts the export, and never blocks the caller. Returns the po id, or null
 * (no active single store / no orderable lines / write failed / duplicate call
 * already in flight for this key).
 */
recordExportedOrder: (vendor: ReorderVendor) => Promise<string | null>;
```

Implementation contract — five properties, all load-bearing:

1. **Synchronous snapshot before the first `await`.** `storeId`, `createdByUserId`,
   `referenceDate`, `edits`, `inventory` and the built `lines` are all resolved
   **before** any `await`. This is what makes the fire-and-forget call-site shape
   (D-3) safe: the call site clears the edit buffer immediately after invoking,
   and the action must already hold the pre-clear quantities. A developer who
   moves the `get().reorderEdits[...]` read after an `await` silently records
   post-clear (server-suggestion) quantities and breaks AC-10/AC-11 in a way no
   type checker catches.
2. **Guards, silent (AC-4, AC-5).** `!storeId || storeId === '__all__'` → return
   `null`, **no toast, no `notifyBackendError`**. `lines.length === 0` → return
   `null`, silently. Deliberately unlike `fillCartForVendor`, which toasts on
   both (`'No active store'` / `'No orderable lines'`) because FILL CART is an
   explicit user action whose failure must be reported. Do not copy those two
   toasts across.
3. **Never rejects (AC-6).** The entire body after the guards sits in one
   `try/catch`. `catch` → `notifyBackendError('Record exported order', e)` →
   return `null`. A `null` from `upsertVendorDraftOrder` → the same
   `notifyBackendError` with `new Error('Draft not recorded')` → return `null`.
   Because the returned promise can never reject, an unawaited call at a call
   site cannot produce an unhandled rejection — that is *why* D-3 is allowed to
   be fire-and-forget.
4. **Post-write refresh (AC-7 / OQ-6).** On a non-null po id: `await
   get().refreshPurchaseOrders()` and **nothing else**. No
   `loadReorderSuggestions()`. No `clearReorderEditsForVendor` — the call site
   owns that, unchanged from today.
5. **Label string.** `'Record exported order'` exactly, matching the
   `notifyBackendError('Fill cart', …)` untranslated-label convention (AC-REG-9).
   No new i18n key in any of the three catalogs; the i18n parity test is
   untouched.

### D-3 — Call-site wiring shape (all six identical)

```
if (<the existing success boolean>) {
  recordExportedOrder(vendor);                 // AC-8/AC-9 — invoked, NOT awaited
  clearReorderEditsForVendor(vendor.vendorId); // AC-10 — unchanged line, now second
}
```

- **Do NOT `await` the record before clearing.** Awaiting would push the
  edit-buffer clear behind a network round trip, changing the timing that
  `ReorderSection.resetAfterExport.spec138.test.tsx` pins — and that suite must
  stay green **unedited** (AC-REG-1). AC-10 requires the record to be *invoked*
  before the clear, which the shape above satisfies, and D-2 property 1
  guarantees the pre-clear quantities are already captured. The unawaited call is
  safe only because of D-2 property 3.
- **The `vendor` passed is the one the export builder consumed** (AC-11) — the
  `applyReorderEdits`-overlaid object. Verified at every site: desktop cards are
  overlaid at [ReorderSection.tsx:1406](src/screens/cmd/sections/ReorderSection.tsx)
  and passed down to both button components
  ([ReorderSection.tsx:647-648](src/screens/cmd/sections/ReorderSection.tsx));
  the phone sheet's vendor is resolved from the overlaid memo
  ([PhoneOrdering.tsx:723, 740, 826](src/screens/cmd/sections/phone/PhoneOrdering.tsx)).
- **Selector placement (AC-REG-8).** `const recordExportedOrder = useStore((s) =>
  s.recordExportedOrder);` goes at the **top of the component body**, beside the
  existing `clearReorderEditsForVendor` selector, in `ReorderQuickOrderButton`
  (:346), `ReorderVendorExportButtons` (:452) and `OverflowSheet` (:565). Never
  inside a conditional, a callback, or after the spec-143 `isPhone` guard.
- **The six sites, and the boolean each gates on:**

  | # | Site | Gate |
  |---|---|---|
  | 1 | `ReorderQuickOrderButton.onShareQuickOrder` ([:396](src/screens/cmd/sections/ReorderSection.tsx)) | `shared` from `sharePurchaseOrder` |
  | 2 | `ReorderVendorExportButtons.onCsv` ([:471](src/screens/cmd/sections/ReorderSection.tsx)) | `ok` — covers **both** the `handleImportExport` (US FOODS / SYSCO) and `handleCsvExport` branches; one call after the `if (ok)`, not one per branch |
  | 3 | `ReorderVendorExportButtons.onPdf` ([:477](src/screens/cmd/sections/ReorderSection.tsx)) | `ok` from `handlePdfExport` |
  | 4 | `OverflowSheet.runQuickOrder` ([:600](src/screens/cmd/sections/phone/PhoneOrdering.tsx)) | `shared` |
  | 5 | `OverflowSheet.runCsv` ([:621](src/screens/cmd/sections/phone/PhoneOrdering.tsx)) | `ok`, and only past the `Platform.OS !== 'web'` early return |
  | 6 | `OverflowSheet.runPdf` ([:632](src/screens/cmd/sections/phone/PhoneOrdering.tsx)) | `ok`, same early-return note |

- **Nowhere else.** Not in `sharePurchaseOrder`, `buildPoQuickOrderText`,
  `handleCsvExport`, `handleImportExport`, `handlePdfExport`, `approveAndOrder`,
  `POsSection`, or `src/screens/staff/` (Design guidance 2). Those builders are
  shared with surfaces this spec excludes; a call inside one of them makes AC-14
  conventional instead of structural.

### D-4 — In-flight key de-dupe (fixes F-1; serves AC-12)

`ReorderVendorExportButtons` has **no `busy` state** — unlike
`ReorderQuickOrderButton` (:360) and `FillCartButton` (:278), and unlike the
phone sheet (which calls `onClose()` first and unmounts). So desktop CSV and PDF
are double-clickable. Today that yields two identical harmless downloads. After
this spec it yields two concurrent `upsertVendorDraftOrder` passes on the same
key, and because there is **no unique index** on
`(store_id, vendor_id, status, reference_date)`, both find-passes can return no
row and both insert — **two draft headers for one key**, violating AC-12 and
putting two rows in the POs list and (for an extension vendor) two entries in the
pending list.

Required, inside `recordExportedOrder`, module-scope — not Zustand state:

```ts
// Module-level, next to buildDraftOrderLines. NOT store state: it is never
// rendered, so keeping it out of Zustand avoids a re-render on every export.
const recordingKeys = new Set<string>();
// key = `${storeId}|${vendorId}|${referenceDate ?? ''}`
```

- Add to the set **only after** the AC-4/AC-5 guards pass and immediately before
  the first `await`; if the key is already present, return `null` **silently**
  (it is a double-fire of the same export, not an error).
- `delete` in a `finally` that wraps everything from the add onward — including
  the `refreshPurchaseOrders()` await — so a thrown error or an aborted inflight
  can never wedge the key.
- Rejected alternatives, for the record: adding a `busy` state to the export
  buttons (changes shipped UX — a disabled-button flash — and touches
  AC-REG-1-adjacent surface); a partial unique index (a migration, which breaks
  AC-REG-7 and forces a prod-apply); making `upsertVendorDraftOrder` idempotent
  server-side (that is OQ-5's deferred RPC, out of scope).
- **Note for the developer:** tests reset store state with
  `useStore.setState(INITIAL_STATE, true)`, which does **not** clear a
  module-level Set. The `finally` is what keeps it clean; do not rely on test
  isolation to empty it.

### D-5 — Explicitly unchanged in the store

`approveAndOrder` is **not** a call site (AC-14). Its `extension` branch keeps
its single existing `fillCartForVendor` call
([useStore.ts:3596](src/store/useStore.ts)) and nothing is double-fired; its
`manual` branch shares the quick-order *builder*
([useStore.ts:3623](src/store/useStore.ts)) but not the export *button*, which is
exactly the structural seam AC-14 relies on. `createPoDraft`,
`markPurchaseOrderSent*`, `sendPurchaseOrderEmail`, `receivePurchaseOrder` and
every spec-151 artifact are untouched (AC-15, AC-REG-3/4/5).

**Cross-spec: spec 155 (parallel, READY_FOR_BUILD).** Spec 155 replaces
`disclosureKeyForChannel` with `disclosureKeysForChannel(): string[]` in the
approve-order path. That is spec 155's change, not drift from this spec.
AC-REG-4 has been amended (see its architect note) to freeze the
channel→disclosure-key **behavior/surface** rather than the outgoing symbol, so
the two specs cannot deadlock at review. Concretely, for spec 156:

- The approve-order disclosure path is **read-nothing / touch-nothing** here.
  This spec adds no call site in `approveAndOrder` and imports nothing from that
  path, so a rename or arity change there cannot conflict with any spec-156 file.
- **The only shared file is `src/store/useStore.ts`.** Spec 155 edits the
  approve-order/disclosure region; spec 156 edits the module-level helper block
  near [useStore.ts:96-117](src/store/useStore.ts) and the spec-138 reorder slice
  ([:651-671](src/store/useStore.ts), [:3367-3451](src/store/useStore.ts)).
  Disjoint regions — expect a clean merge; if a conflict appears it is textual,
  not semantic, and neither side's behavior should be adjusted to resolve it.
- `useStore.approveOrder.spec149.test.ts`: spec 156 must not edit it. If spec 155
  edits it, that is spec 155's to justify. The AC-14 pin (`manual` / `instacart` /
  `webstaurant` → 0 `upsertVendorDraftOrder` calls, `extension` → exactly 1) lives
  in **spec 156's own new file** (§9 test (a)(9)), specifically so this spec never
  needs to touch spec 149's or spec 155's suites.

**Design guidance 5 check: spec 151 needs no change.** Verified — an
export-recorded row is `purchase_orders.status = 'draft'`, which is already
tier 4 → confidence `recorded` → the **NOT CONFIRMED** qualifier. No edit to
`report_last_order_context`, `src/utils/lastOrderContext.ts`,
`buildLastOrderContext`, `lastOrderCardState`, or either tier's rendering. And
per Design guidance 6, `reference_date = reorderPayload.asOfDate` = today, while
the anchor query is strictly *before* the viewed date — so **today's export never
annotates today's own list; the feature first becomes visible on the next
ordering cycle.** That belongs in the release notes verbatim, alongside F-2, or
the owner will read the first day as a broken feature.

## 9. Test plan (jest — AC-20; pgTAP N/A per AC-21; shell smoke N/A per AC-22)

Three new files. No existing suite is edited.

**(a) `src/store/useStore.recordExportedOrder.spec156.test.ts`** — mocking
mirrors `useStore.fillCartForVendor.spec138.test.ts` verbatim (stub
`../lib/supabase`, `../lib/auth`, `../lib/db`; `db.upsertVendorDraftOrder` is the
assertion surface; `fetchRecentPurchaseOrders` / `fetchReorderSuggestions`
stubbed inert; snapshot-and-replace state isolation).

1. `buildDraftOrderLines` purity + parity (AC-2): with edits, without edits,
   `subUnitSize` ≠ 1 → `costPerUnitCounted === costPerUnit * subUnitSize`,
   `subUnitSize` missing → ×1, zero-qty dropped, id-less dropped, input objects
   not mutated. **Parity assertion:** the helper's output deep-equals the
   `lines` argument `fillCartForVendor` passes to `upsertVendorDraftOrder` for
   the same fixture (drive `fillCartForVendor`, read `upsertMock.mock.calls[0][0].lines`).
2. Params (AC-3): one success call asserts the full param object —
   `{ storeId, vendorId, createdByUserId, referenceDate, lines }` — sourced from
   `currentStore.id` / `vendor.vendorId` / `currentUser.id` /
   `reorderPayload.asOfDate`.
3. AC-4: `currentStore` null → 0 calls, `Toast.show` not called. Same for
   `currentStore.id === '__all__'`.
4. AC-5: vendor whose every line filters out (qty 0 / blank itemId) → 0 calls,
   no toast.
5. AC-6: `upsertVendorDraftOrder` resolves `null` → returns `null`, toast fired
   once, does not throw. `upsertVendorDraftOrder` rejects → same, and
   `expect(promise).resolves.toBeNull()` (never rejects).
6. AC-7: success → `fetchRecentPurchaseOrders` called (via
   `refreshPurchaseOrders`); `fetchReorderSuggestions` **not** called.
7. **AC-12 same-day re-export pin:** drive four records for the same vendor with
   different edited quantities between calls, and assert every
   `upsertMock.mock.calls[i][0]` carries an **identical**
   `(storeId, vendorId, referenceDate)` triple while `lines` reflects the latest
   edits. (The "one row survives" property is `upsertVendorDraftOrder`'s own,
   already covered by `src/lib/db.upsertVendorDraftOrder.test.ts` — do not
   re-prove it here.)
8. **D-4 de-dupe:** with `upsertVendorDraftOrder` held on a deferred promise,
   fire `recordExportedOrder` twice for the same vendor without awaiting →
   exactly **one** call; resolve, then fire a third → a second call (the key was
   released).
9. **AC-14:** `approveAndOrder` through `manual`, `instacart`, `webstaurant` →
   `upsertVendorDraftOrder` called **0** times; `extension` → exactly **1**
   (unchanged spec-138 path).

**(b) `src/screens/cmd/sections/__tests__/ReorderSection.recordExport.spec156.test.tsx`**
— boundary mocking cloned from `ReorderSection.resetAfterExport.spec138.test.tsx`
(web `Platform`, stubbed `buildReorderCsv`, stubbed `jspdf` + `jspdf-autotable`,
stubbed `../../lib/sharePo`, mocked `useStore` with a `recordExportedOrder`
jest.fn on the state object).

1. Quick-order press, `shared: true` → recorded once with this vendor.
2. Quick-order press, `shared: false` → **0** records (and, as today, no clear).
3. CSV press, generic branch, `ok: true` → recorded once.
4. **CSV press, US FOODS import branch → recorded once.** Fixture: the mocked
   `vendors` slice entry for the card's vendor carries
   `orderImportFormat: 'us_foods'` so `pickImportVendor`
   ([src/utils/vendorImportShared.ts:117](src/utils/vendorImportShared.ts))
   returns it and `onCsv` takes `handleImportExport`. Add a `'sysco'` variant if
   cheap. This branch is the owner's motivating case and must not be covered only
   by the generic one.
5. CSV press with the export forced to fail (`ok: false`) → **0** records, and
   the edit buffer is still preserved (existing behavior, re-asserted here only
   as a co-located sanity check — the canonical pin stays in the spec-138 suite).
6. PDF press `ok: true` → 1 record; PDF failure → 0.
7. **AC-10 ordering:** a shared `calls: string[]` recorder pushes `'record'` from
   the `recordExportedOrder` mock and `'clear'` from the
   `clearReorderEditsForVendor` mock; assert `['record', 'clear']`.
8. **AC-11:** with an inline edit applied to one line, assert the vendor object
   handed to `recordExportedOrder` carries the edited `suggestedUnits`, and that
   the same edited base reached the export builder (`buildReorderCsv` mock's
   payload argument).
9. **AC-6 at the seam:** `recordExportedOrder` mock rejects → the press still
   resolves, the clear still happened, no unhandled rejection.

**(c) `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.recordExport.spec156.test.tsx`**
— same three call sites through `OverflowSheet` (quick / CSV / PDF, success and
failure), **plus** the AC-9 native pin: with `Platform.OS = 'ios'`, pressing CSV
and PDF toasts `common.availableOnDesktop` and records **0** times. Mirrors the
existing `PhoneOrdering.test.tsx` mocking.

**AC-REG pins — run unedited, assert green, do not touch:**
`src/utils/reorderExport.test.ts`, `src/utils/poQuickOrderText.test.ts`,
`ReorderSectionCases.test.tsx`, `ReorderSection.spec123/130/135.test.tsx`,
`ReorderSection.spec138.test.tsx`,
`ReorderSection.resetAfterExport.spec138.test.tsx` (**export outputs +
FILL-CART-unchanged + edit-reset timing**),
`src/store/useStore.fillCartForVendor.spec138.test.ts` (**the AC-REG-2
extraction gate**), `src/store/useStore.approveOrder.spec149.test.ts`,
`PhoneOrdering.acReg.test.tsx` + `PhoneOrdering.test.tsx` (**phone/desktop tier
fork**), `PhoneOrdering.lastOrderContext.spec151.test.tsx` (**spec-151 tier
pickup unchanged**), `PhoneApproveOrder.acReg.test.tsx`, and the `extension/`
vitest suite. Per project MEMORY (`feedback_run_full_jest_before_commit`), run
the **full** `npx jest` plus `npm run typecheck` and the test-graph typecheck
before handing off — the test-graph typecheck is a CI gate jest alone misses.

## 10. Risks and tradeoffs

| # | Risk | Severity | Position |
|---|---|---|---|
| R-1 | **Concurrent double-record → two draft headers** (F-1). No unique index behind the upsert; desktop CSV/PDF have no `busy` guard. | High if unaddressed | Closed by **D-4**. Must be implemented and tested, not deferred. |
| R-2 | **★ spec-104 bridge dropped in the extraction** — `costPerUnitCounted` without `× subUnitSize` silently mis-costs every recorded order and every downstream `total_cost`. | High | D-1 pins it; test (a)(1) asserts it; AC-REG-2's untouched spec-138 suite is the backstop. The most likely way this spec goes wrong. |
| R-3 | **F-2 reorder-list repaint ~400 ms after every export**, plus a full `fetchAllForStore` per export per admin client on the 286 KB seed. | Medium | Accepted, unchanged, **must be in the release notes**. Not new behavior — same as FILL CART and any realtime traffic today. Narrowing the realtime handler is a separate spec. |
| R-4 | **OQ-2 residual**: export-recorded draft for an extension vendor is fillable from the pending list → possible double order. | Medium, human-gated | Accepted per the §2 ruling. Mitigation is the **OQ-4 provenance follow-up**, recommended as the next spec. Surfaced, not buried. |
| R-5 | **Recording call added inside a shared builder** by a later change, firing from `POsSection` / staff / `approveAndOrder`. | Medium | Structural: the seam is the six call sites (Design guidance 2). Test (a)(9) pins `approveAndOrder` at zero. A reviewer should grep for `recordExportedOrder` and expect exactly 6 call sites + 1 definition + tests. |
| R-6 | **`await`-before-clear creeping in**, pushing the edit-buffer reset behind a round trip and forcing an edit to the spec-138 reset suite. | Medium | D-3 forbids it and names the tell: if `ReorderSection.resetAfterExport.spec138.test.tsx` needs an edit, the wiring is wrong. |
| R-7 | **Base-units vs. cases confusion** — a US FOODS file showing `4 CS` beside a recorded `ordered_qty` of `40`. | Low | Documented in §3. Not drift; same basis relationship as the shipped quick-order/FILL-CART pair. |
| R-8 | **Global LoadingBar flashes after an export** — the record runs under `useInflight.track({ kind: 'write' })` ([db.ts:1794](src/lib/db.ts)). | Low | Accepted. It is the house write indicator, not part of the export output, and FILL CART already produces it. Not an AC-REG-1 violation. |
| R-9 | **Perf on the seed.** Per export: 1 find + (1 insert \| 1 read + 1 insert + 1 delete + 1 update) + 1 `refreshPurchaseOrders` read. All indexed (`idx_purchase_orders_store_status_open`, `idx_po_items_po_id` — [20260704000000_po_loop.sql:144-146](supabase/migrations/20260704000000_po_loop.sql)). | Low | No index added. The dominant cost is R-3's realtime-triggered full reload, not these writes. |
| R-10 | **Migration ordering / CI.** None — no migration. | None | `db-migrations-applied.yml` must stay green throughout. A red run on this spec means SQL escaped the scope. Both gates green on `main` before ship (CLAUDE.md). |
| R-11 | **Edge-function cold start.** N/A — no edge function is added, modified, or called. | None | AC-22 stands. |
| R-12 | **Parallel merge with spec 155** (`disclosureKeyForChannel` → `disclosureKeysForChannel(): string[]`). Shared file: `src/store/useStore.ts` only. | Low | Disjoint regions (§8 "Cross-spec"). AC-REG-4 amended to freeze behavior, not the symbol, so neither spec blocks the other at review. Land order does not matter; a textual conflict is resolved by keeping **both** sides verbatim. |

## 11. Files the implementer is expected to touch

- `src/store/useStore.ts` — `DraftOrderLine` + `buildDraftOrderLines` (new,
  exported, beside `buildOrderApprovalLines`); `recordingKeys` module Set;
  `recordExportedOrder` interface entry + implementation; `fillCartForVendor`
  refactored to call the helper.
- `src/screens/cmd/sections/ReorderSection.tsx` — 3 call sites + 2 selectors.
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx` — 3 call sites + 1 selector.
- 3 new jest files per §9.

**Not touched, and a reviewer should verify it:** `src/lib/db.ts`,
`supabase/**` (any file), `src/utils/reorderExport.ts`,
`src/utils/poQuickOrderText.ts`, `src/utils/usFoodsImport.ts`,
`src/utils/syscoImport.ts`, `src/screens/cmd/lib/sharePo.ts`,
`src/utils/lastOrderContext.ts`, `src/screens/staff/**`, `extension/**`,
`src/i18n/*.json`, `app.json`.

## Handoff

next_agent: frontend-developer
prompt: Implement against the design in this spec. Frontend-only — do NOT add a
  migration, an RPC, a policy, an edge function, or any change to src/lib/db.ts.
  Build D-1 (buildDraftOrderLines extraction + fillCartForVendor refactor) first
  and confirm useStore.fillCartForVendor.spec138.test.ts stays green unedited
  before wiring anything; then D-2/D-3/D-4 and the three jest files in §9. After
  implementation, set Status: READY_FOR_REVIEW and list files changed under
  ## Files changed.
payload_paths:
  - specs/156-export-order-recording.md

---

## Files changed

Frontend-only, as designed. **No** migration, RPC, policy, index, edge function,
publication change, or `src/lib/db.ts` edit. `supabase/**`,
`src/utils/reorderExport.ts`, `src/utils/poQuickOrderText.ts`,
`src/utils/usFoodsImport.ts`, `src/utils/syscoImport.ts`,
`src/screens/cmd/lib/sharePo.ts`, `src/utils/lastOrderContext.ts`,
`src/screens/staff/**`, `extension/**`, `src/i18n/*.json` and `app.json` are all
untouched (AC-REG-1/3/5/6/7/9, §11).

**Modified (3)**

- `src/store/useStore.ts`
  - D-1: new exported `DraftOrderLine` type + pure `buildDraftOrderLines(vendor,
    vendorEdits, inventory)` placed immediately after `buildOrderApprovalLines`
    (module helper block). Verbatim lift of the builder that lived inline in
    `fillCartForVendor` — same edit overlay, same ★ spec-104
    `costPerUnit × subUnitSize` bridge, same `itemId && orderedQty > 0` filter.
  - D-4: module-level `recordingKeys: Set<string>` (not Zustand state).
  - New exported `ExportRecordingContext` type (security review — see below).
  - D-2: `recordExportedOrder` interface entry (directly below
    `fillCartForVendor`) + implementation (directly below `fillCartForVendor`'s
    body). Export-start snapshot + synchronous reads before the first await;
    silent `'__all__'` / no-reference-date / empty-lines guards; reported
    store-mismatch refusal; single `try/catch` → `notifyBackendError('Record
    exported order', …)`; `refreshPurchaseOrders()` only; key released in
    `finally`.
  - `fillCartForVendor` refactored to call `buildDraftOrderLines`; everything
    else in that action byte-identical.
  - Four diff hunks total, all in the spec-138 reorder slice + the module helper
    block — disjoint from spec 155's approve-order/disclosure region (R-12).
- `src/screens/cmd/sections/ReorderSection.tsx` — 2 store selectors +
  3 call sites (`ReorderQuickOrderButton.onShareQuickOrder` on `shared`;
  `ReorderVendorExportButtons.onCsv` on `ok`, one call covering BOTH the
  US FOODS / SYSCO import branch and the generic CSV branch; `.onPdf` on `ok`).
  Recording invoked, never awaited, before `clearReorderEditsForVendor`.
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx` — 1 store selector in
  `OverflowSheet` + 3 call sites (`runQuickOrder` on `shared`; `runCsv` on `ok`,
  both branches, past the non-web early return; `runPdf` on `ok`). Same shape.

**Added (3 jest files, §9)**

- `src/store/useStore.recordExportedOrder.spec156.test.ts` — 26 tests:
  `buildDraftOrderLines` purity / overlay / ★ bridge / drops + **parity** with
  the lines `fillCartForVendor` actually passes; AC-3 params; AC-4/AC-5 silent
  guards (no write, no toast); AC-6 (null → one toast, throw → resolves null,
  never rejects, buffer untouched); AC-7 (`fetchRecentPurchaseOrders` yes,
  `fetchReorderSuggestions` no); AC-12 identical same-day key across four
  re-exports; D-4 de-dupe (double-fire → one write, key released, other vendors
  unblocked, released on throw); AC-14 (`manual`/`instacart`/`webstaurant` → 0
  `upsertVendorDraftOrder` calls, `extension` → exactly 1).
- `src/screens/cmd/sections/__tests__/ReorderSection.recordExport.spec156.test.tsx`
  — 13 tests: sites 1-3 success/failure; the **US FOODS** and **SYSCO** import
  branches explicitly; AC-10 `['record','clear']` for CSV / PDF / quick-order;
  AC-11 (edited base 120 in both the recorded vendor and `buildReorderCsv`'s
  payload); AC-6 at the seam.
- `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.recordExport.spec156.test.tsx`
  — 9 tests: sites 4-6 success/failure + the import branch, AC-10 ordering, and
  the AC-9 native pin (`Platform.OS = 'ios'` → `common.availableOnDesktop`
  toast, 0 records).

## Post-review round 1 — security-auditor Mediums 1 + 2 (fixed)

`specs/156-export-order-recording/reviews/security-auditor.md` found no Critical
and no High, and two Mediums with **one root cause**: `recordExportedOrder`
derived the write key from *live* global state read AFTER the async gap the
export itself introduces (a user-paced share sheet, `handlePdfExport`'s two
dynamic `jspdf` chunk imports, the CSV build).

1. **Medium 1 — cross-store exposure.** The desktop TitleBar store switcher is
   live during that window. On resolution the closure still held store A's
   `vendor`, but the action read `get().currentStore?.id` — now store **B** —
   and would file store A's item ids, quantities and per-unit costs under
   `store_id = B`. RLS admits it (the operator can see both), after which
   store-B-only members can read those quantities and costs.
2. **Medium 2 — the undated second draft header.** `loadFromSupabase` nulls
   `reorderPayload` on **every** realtime reload, including the self-echo of the
   draft this feature just wrote (design F-2). A second export still in flight
   would then read `referenceDate = undefined`, sending
   `upsertVendorDraftOrder` down its `reference_date IS NULL` branch → a SECOND
   `draft` header for the same day, invisible to `report_reorder_list.has_po`,
   and un-collapsible by D-4 (whose key string embedded `referenceDate ?? ''`,
   so the undated call was a *different* key). AC-12 failed on a path D-4 did
   not cover, and for an extension-ordering vendor it doubled the §2 R-4
   residual.

**Fix — one mechanism, no backend change, no new `db.ts` surface.** The
`(storeId, referenceDate)` half of the upsert key is now snapshotted by the call
site **before its first `await`** and handed to the action as a second argument:

```ts
export type ExportRecordingContext = {
  storeId: string | undefined;        // currentStore.id at export START
  referenceDate: string | undefined;  // reorderPayload.asOfDate at export START
};
recordExportedOrder(vendor: ReorderVendor, exportedAt: ExportRecordingContext)
```

Chosen semantics, per the coordinator's "your call — document it":

| Condition | Behavior | Why |
|---|---|---|
| Snapshot `storeId` missing / `'__all__'` | no write, **silent** | AC-4, unchanged — just now evaluated against export start. |
| `get().currentStore?.id !== snapshot.storeId` (**store switched mid-export**) | no write, **reported** via `notifyBackendError('Record exported order', 'Active store changed during the export — not recorded')` | Refusing beats mis-filing (auditor: "dropping a record in a rare race is strictly better than filing it against the wrong tenant"). Reported, not silent, because the operator *caused* it, it is rare, and it is actionable — switch back and re-export. Silently losing an order record here would be the spec-031/032 silent-failure class. |
| Snapshot `referenceDate` empty | no write, **silent** | An undated draft escapes the upsert key, the D-4 key and `has_po` — worse than no draft. Silent because it is a degenerate "nothing to key against" state, same family as AC-4/AC-5, not an operator mistake. |

The guards all still live in the one action (AC-3 "one action, one guard set");
the call sites only *snapshot*, they never decide. The D-4 key is now
`${storeId}|${vendorId}|${referenceDate}` with `referenceDate` non-empty by
construction, so it can no longer drift between two in-flight exports.

Call-site changes: `ReorderQuickOrderButton` gained `currentStore` +
`reorderPayload` selectors (top of the component body, AC-REG-8);
`ReorderVendorExportButtons` and the phone `OverflowSheet` already had both and
gained a small local `snapshot()` / `exportContext()` helper called as the first
statement of each handler.

**New jest pins (11 added, 2182 → 2193 total):**

- store suite: mid-export store switch → **0 writes** (not under the new store,
  not under the old one) + exactly one error toast with the exact refusal string;
  unchanged store → still records normally (the guard is not over-eager);
  `reorderPayload` nulled mid-export → still records the **export-start** date;
  **the Medium-2 chain end to end** — export #1 in flight, echo nulls the
  payload, export #2 resolves → collapses to **ONE** write (D-4 key stable);
  empty snapshot date → 0 writes, silent. AC-4's two guards restated against the
  snapshot.
- desktop + phone suites: the second argument equals
  `{ storeId, referenceDate }` at export start; a store switch **during** the
  share does not move the snapshot; a realtime reload nulling `reorderPayload`
  **during** the share does not move the date.

The code-reviewer's `console.warn` Should-fix on the six `.catch` handlers (also
the auditor's Low 1 — a swallowed rejection with zero signal) was applied by the
coordinator and is **preserved**, not reverted.

**Not changed in this round:** the auditor's Low 2 (`notifyBackendError`
rendering `e.message`) is inherited house convention with no store / vendor /
user / item / quantity / cost interpolated — recorded, no action requested.

---

**Deviation from the literal D-3 snippet (one, deliberate, reported):** the six
call sites read
`void recordExportedOrder?.(vendor, exportedAt).catch((e) => console.warn(…));`
rather than `recordExportedOrder(vendor);`.

- The **optional call** is required by AC-REG-1: three shipped suites
  (`ReorderSection.resetAfterExport.spec138`, `ReorderSection.spec123`,
  `ReorderSection.spec138`) mock `useStore` with a literal state object that
  carries no `recordExportedOrder`, and all three press an export button on the
  success path. A bare call would crash them, forcing an edit to suites the spec
  froze. All three stay **unedited and green**.
- The **`.catch`** is required by the design's own §9(b)(9) ("recordExportedOrder
  mock rejects → … no unhandled rejection"): `void`-ing a rejected promise is an
  unhandled rejection. The action never rejects by contract (D-2 property 3);
  the catch keeps that contract from being load-bearing at six call sites.
- Neither changes the contract: the recording is still *invoked, not awaited*,
  still gated on the existing success boolean, still ordered before the clear.

**Second signature deviation (security-driven, round 1):** AC-3 specified
`recordExportedOrder(vendor: ReorderVendor)`. It is now
`(vendor, exportedAt: ExportRecordingContext)`. The one-arg shape is not
implementable safely: "what store / what reorder date did this export belong to"
is only knowable at export *start*, and the action runs at export *end*. The
alternative the auditor floated — gating at each call site with
`if (currentStore?.id === useStore.getState().currentStore?.id)` — would put a
duplicated guard at six sites (against AC-3's "one action, one guard set") and
would not fix Medium 2 at all. Guards stay centralized; only the snapshot moves
to the caller.

**Gates (re-run after the security fix)**

- `npx tsc --noEmit` — clean.
- `npm run typecheck:test` — clean.
- `npx jest` (full) — **201 suites / 2193 tests passed**, including every AC-REG
  pin unedited: `useStore.fillCartForVendor.spec138.test.ts` (the AC-REG-2
  extraction gate — verified green **before** any wiring landed),
  `useStore.approveOrder.spec149.test.ts`,
  `ReorderSection.resetAfterExport.spec138.test.tsx`,
  `ReorderSection.spec123/130/135/138`, `ReorderSectionCases`,
  `reorderExport.test.ts`, `poQuickOrderText.test.ts`, `PhoneOrdering.acReg`,
  `PhoneOrdering.lastOrderContext.spec151`, `PhoneApproveOrder.acReg`.
- Web build path: the Metro **web** bundle
  (`/node_modules/expo/AppEntry.bundle?platform=web`) compiles 200 / 16.4 MB and
  contains `buildDraftOrderLines`, `recordExportedOrder`, the
  `'Record exported order'` label and the new
  `'Active store changed during the export'` refusal — i.e.
  `expo export --platform web` resolves and transforms the change.

**Browser verification — NOT performed, stated honestly.** No `preview_*` tools
were available in this session, so the golden path was not clicked through in a
live browser. Note the feature is invisible at the moment of export by design
(AC-REG-9: no new success-path copy, no output/toast/filename change), and the
observable effects — a draft row in the POs list and spec 151's
`… · ORDERED … · NOT CONFIRMED` line on the **next** ordering cycle (Design
guidance 6) — need a live Supabase session with a reorder payload. A reviewer
with preview tooling should exercise: export CSV for a vendor → POs list shows a
`draft` for that vendor; re-export the same day → still one row.

**Release-note items carried forward from the design (not bugs):**

1. F-2 — the reorder list blanks and refetches ~400 ms after every export (the
   realtime self-echo nulls `reorderPayload`). Unchanged behavior, same as FILL
   CART; exports are just more frequent.
2. Design guidance 6 — an export recorded today is dated today, and spec 151
   anchors strictly *before* the viewed date, so the context line first appears
   on the **next** ordering cycle.
3. §2 named residual (OQ-2) — for an `extension_ordering` vendor, an
   export-recorded draft is also visible in the extension's pending list; the
   OQ-4 provenance marker is the recommended follow-up spec.
