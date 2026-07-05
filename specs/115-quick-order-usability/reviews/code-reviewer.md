# Code review for spec 115

Scope: quick-order usability completion — W-1 CSV order-code bulk import
(reconcile-safe merge), W-2 per-vendor order unit + case-conversion builder,
W-3 Reorder-card quick-order export, W-4 dead `vendorSku` stub removal, W-5
missing-codes stat. Reviewed against `specs/115-quick-order-usability.md`
(ACs + `## Backend design`) and CLAUDE.md conventions. Architecture and
security are out of scope for this review (architect / security-auditor own
those lanes); this pass is naming, structure, TS strictness, project
conventions, and idiom.

## Critical

None. The one genuinely dangerous surface this spec called out —
`updateInventoryItem`'s full-reconcile deleting/zeroing other vendor links
when a code-only payload is sent (design §0/§10) — is closed correctly.
Verified end-to-end:

- `buildOrderCodeVendorsPayload` (`src/lib/csvImport.ts:193-214`) resends the
  item's **complete** existing link set (`costPerUnit`/`casePrice` preserved
  verbatim) and overwrites `orderCode` ONLY on the resolved link, appending a
  new non-primary link only when the vendor isn't linked yet.
- The jest pin at `src/lib/csvImport.test.ts:153-202` ("CSV code write does
  NOT drop links or alter costs (CRITICAL)") is a genuine end-to-end proof,
  not a unit-level assertion in isolation: a 3-vendor-linked item gets a code
  write for vendor A, and the test asserts the `updateItem` payload contains
  all three links with B's and C's costs and codes byte-for-byte intact.
- A blank `vendor_sku` cell produces an op with no `orderCode`
  (`rowToOrderCodeFields`, `csvImport.ts:262-270`), and `commitImport` omits
  the `vendors` key entirely in that case (`csvImport.ts:479-481`) — proven
  by the no-op test at `csvImport.test.ts:205-229` (`'vendors' in
  ctx.updates[0].updates` is `false`).
- Vendor resolution never guesses: an unmatched `vendor_name` skips and
  reports (`resolveVendorForCode`, `csvImport.ts:161-176`), never falls back
  to primary — pinned by `csvImport.test.ts:106-110` and the end-to-end skip
  test at `csvImport.test.ts:271-291`.
- The W-2 conversion (`src/utils/poQuickOrderText.ts:138-151`) divides by
  `coalesce(caseQty, 1)` (never 0/null), rounds up via `Math.ceil`, and
  increments `roundedCount` only on an actual fraction — byte-for-byte pinned
  in `poQuickOrderText.test.ts:198-305` including the `caseQty=0` and
  `caseQty=null` edge cases and a mixed-batch count.
- The pgTAP extension (`supabase/tests/vendors_role_access.test.sql:136-170`)
  genuinely proves the privileged/non-privileged UPDATE split on
  `order_unit` rather than asserting a policy exists in the abstract.

## Should-fix

- `src/components/cmd/RunImportModal.tsx:70-86` — the pre-commit
  `codePreview.toWrite` count and the post-commit `result.codesWritten`
  count use different definitions and can diverge. `codePreview`'s loop
  counts every op whose `orderCode` *resolves to a vendor*, regardless of
  whether that code differs from the vendor's existing `orderCode`. But
  `computeDiff`'s promotion rule (`csvImport.ts:320-335`) only turns a row
  into a write when the resolved code **differs** from the existing link's
  code — a `skip('no changes')` row whose code already matches the existing
  link (the idempotent-re-run case pinned at `csvImport.test.ts:329-339`)
  still reaches `codePreview`'s loop (skip ops carry `orderCode` too,
  `computeDiff` line 344) and increments `toWrite`, but `commitImport` will
  correctly report `0` for that row in `codesWritten`. Net effect: re-running
  an already-imported CSV shows "N codes to write" in the confirm dialog and
  then "0 codes written" in the success toast for the same batch — no data
  loss, but a confusing pre/post mismatch for the exact "re-run the CSV"
  workflow the idempotency backstop is meant to make safe. Suggest either
  (a) threading the same "existing code equals new code" check into
  `codePreview`, or (b) relabeling the preview stat to something like
  "N codes resolve to a vendor" so it doesn't imply "N will change."

## Nits

- `src/lib/csvImport.ts:161-165` / design §3 — the design doc's
  `resolveVendorForCode` signature included an `itemExistingLinks:
  ItemVendorLink[]` parameter; the shipped signature drops it (only
  `vendorNameRaw` / `itemPrimaryVendorId` / `brandVendors`). This is correct
  behavior — the pinned AC-2 rule never actually consults the existing link
  set for *resolution* (only `buildOrderCodeVendorsPayload` needs the links,
  for the merge) — so the simplification is a genuine improvement, not a
  gap. Flagging only because a reader comparing the design doc to the code
  might momentarily wonder if a param was dropped by mistake; a one-line
  comment noting the intentional narrowing would close that.
- `src/components/cmd/RunImportModal.tsx:100,105` — `'Import complete'` and
  the `created N · updated N` / `N archive deferred` summary segments are
  hardcoded English, which on its face reads like an AC-20 gap ("No
  user-visible hardcoded English on the admin surface"). Confirmed this is
  **pre-existing** code untouched by spec 115 (the spec only appended the
  three new `T('section.posImports.*')` calls onto the existing string at
  lines 102-104); AC-20 scopes the localization requirement to "any new
  import-result copy the modal renders (W-1)," which was honored — the new
  segments are localized. (out-of-scope) worth a follow-up spec to close the
  pre-existing gap, not this one.
- `src/components/cmd/VendorFormDrawer.tsx:246,276` and
  `src/components/cmd/RunImportModal.tsx:191,219` — `color: '#000'` literals.
  All four are pre-existing lines untouched by this spec (header badge text,
  save-button label, checkbox glyph, run-import button label) — not
  introduced by W-1/W-2. Matches the already-tracked cleanup-backlog item
  ("'#000'-on-accent sweep (~35 left)"); the new W-2 `SegmentField` control
  and the new W-1 `codePreview` block are clean of literals (all `C.*`
  tokens). (out-of-scope)
- `src/screens/cmd/sections/POsSection.tsx` / `ReorderSection.tsx` /
  `src/components/cmd/RunImportModal.tsx` — no dedicated `*.test.*` files for
  these three call sites (the new `onShareQuickOrder` / `ReorderQuickOrderButton`
  / `commitImport` wiring only get indirect coverage via the pure-builder and
  csvImport jest suites, not a render/interaction test of the section
  components themselves). The byte-for-byte builder + csvImport tests are
  strong and this is likely an intentional scope call (the pure logic is the
  correctness surface per the spec's own risk section), but flagging for
  test-engineer to confirm the acceptance-criteria coverage is judged
  sufficient without a section-level smoke test, since `VendorFormDrawer`
  got one (`VendorFormDrawer.test.tsx`) and these three did not. (deferred to
  test-engineer)

## Resolution (main Claude, post-review fix pass — 2026-07-05)

- **Should-fix (RunImportModal pre/post count mismatch) — FIXED.** The
  pre-commit `codePreview.toWrite` loop now mirrors `commitImport`'s promotion
  rule (csvImport.ts:333-336): a resolved code only counts toward "N codes to
  write" when it actually DIFFERS from the existing link's `orderCode` (trimmed
  compare), so re-importing an already-coded CSV shows the same 0 in both the
  confirm dialog and the success toast. New items / link-missing / changed
  codes still count. Chose option (a) — the honest count — over relabeling.
  jest 1096/1096, both typechecks clean.
- **Nits — LEFT** (pre-existing `#000` literals nearby untouched; the rest
  preferential).
