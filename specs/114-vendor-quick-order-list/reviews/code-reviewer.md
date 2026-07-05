## Code review for spec 114

Scope: per-vendor order codes (`item_vendors.order_code`) + universal
quick-order list export. Reviewed every file under the spec's `## Files
changed`: the migration, `src/lib/db.ts` (four threading points), `src/types/index.ts`,
`src/store/useStore.ts` (both mutation sites), `supabase/tests/item_vendors_rls.test.sql`,
`src/utils/poQuickOrderText.ts` (+ test), `src/components/cmd/IngredientForm.tsx`
(+ test), `src/components/cmd/IngredientFormDrawer.tsx`, `src/screens/cmd/sections/POsSection.tsx`
(+ test), and all three i18n catalogs. Cross-checked `poShareText.ts` / `sharePo.ts`
/ `reorderExport.ts` as the sibling-idiom baseline, and `src/lib/csvImport.ts` to
confirm the out-of-scope `vendor_sku` alias is untouched.

### Critical

None.

### Should-fix

None.

### Nits

- **The type-shape call (main focus item 1) — defensible, not a drift.**
  `ItemVendorLink.orderCode: string` (required, `''` default) is consistent with
  the existing siblings on the same interface: `vendorName: string` (required,
  `''` default, `src/lib/db.ts:4804`/`4839`) and — even more directly on point —
  `costPerUnit: number` / `casePrice: number` (both required, `0`-defaulted via
  `parseFloat(...) || 0`, `src/lib/db.ts:4805-4806`). `ItemVendorLink` has no
  precedent for an optional/nullable field; every hydrated member is
  required-with-a-safe-default. Making `orderCode` the odd one out as
  `orderCode?: string | null` would have been the actual inconsistency. The
  `db.ts` write-side coalesce (`l.orderCode || null` at `db.ts:373`/`504`) mirrors
  the `expiryDate: v.expiryDate || null` idiom already in `updateInventoryItem`
  (`IngredientFormDrawer.tsx:132`), so empty→NULL is the established pattern, not
  a new one invented for this field. The forced touch to `useStore.ts` (two
  optimistic `linkSet.map` bodies, `useStore.ts:1269`/`1335`) is the honest cost of
  that choice and is paid correctly — both sites default `l.orderCode || ''`,
  matching `mapItem`'s hydrated default exactly, so the optimistic row is never
  out of sync with what the next fetch will produce. No finding; this is the
  right call given the surrounding idiom.
- **`IngredientFormValues.vendors[]` (`IngredientForm.tsx:78`) and `VendorLinkRow`
  (`IngredientForm.tsx:179-186`) are structurally duplicated interfaces** —
  `{vendorId, costPerUnit, casePrice, orderCode}` (all strings) declared twice
  rather than `vendors: VendorLinkRow[]`. Pre-existing from spec 102 (not
  introduced here); spec 114 correctly added `orderCode: string` to both in
  parallel so no drift was introduced. (out-of-scope) a future pass could
  collapse these into one declaration.
- `POsSection.tsx:284` — the unmapped-count warning toast is fired with
  `type: 'error'`. The spec calls this a "warning," and `error` red-styling for a
  non-blocking, expected-in-normal-use signal (some items simply don't have a
  vendor code yet) is a slightly heavier visual weight than the situation
  warrants — `type: 'info'` might read more accurately as "here's a gap to fill,"
  not "something broke." Not a functional issue (the toast fires correctly, with
  the right count, only when `unmappedCount > 0`), purely a severity-of-styling
  preference — deferred to product/design judgment, not a code-quality finding.

### Notes on the four focus items from the dispatch

1. **Type shape** — assessed above; the required-string-with-`''`-default is
   consistent with `vendorName`/`costPerUnit`/`casePrice` on the same interface,
   not a special case. The `'' → null` coalesce in `db.ts` matches the
   `expiryDate` idiom already in the file. No finding.
2. **Dead stub** — verified `values.vendorSku` (`IngredientForm.tsx:43,79,1283`) is
   untouched: `blankValues()` still seeds it `''`, and the render at line 1283
   sits OUTSIDE the `values.vendors.map((row) => ...)` loop (lines 1200-1272) that
   the new order-code `InputLine` (lines 1256-1268) is scoped inside. No
   accidental wiring. `csvImport.ts`'s `vendor_sku` header alias is confirmed
   untouched (not in the diff, grep confirms no `order_code` reference there).
3. **Builder byte-level correctness** — `poQuickOrderText.ts` is pure (no React /
   theme / supabase / i18n import), reuses `formatQty` from `reorderExport.ts`,
   emits `<code>\t<qty>` (literal `\t`, `DELIM` const at line 71) or
   `??? <name>\t<qty>` (`UNMAPPED_PREFIX` const at line 67) per line, joins with
   `\n`, no trailing newline, empty input → `{text: '', unmappedCount: 0}`
   (lines 91-105). `resolveCode`'s return is `.trim()`-ed before the truthy check
   (line 96), so a whitespace-only code correctly falls to the unmapped branch —
   the jest suite pins this exactly (`poQuickOrderText.test.ts:84-95`). No `$`
   anywhere; `PoQuickOrderLine` has no cost field at all, so there's no money
   surface to leak. Byte-for-byte correct against the design (D-9).
4. **Second Share handler** — `onShareQuickOrder` (`POsSection.tsx:256-289`)
   reuses `sharePurchaseOrder` verbatim (confirmed `sharePo.ts` has zero edits),
   resolves `resolveCode` as a closure over `inventory` + `sel.vendorId`
   (line 262, exactly the design's pinned lookup shape), and correctly omits the
   `if (shared && selStatus === 'draft') confirmAction(...)` block that `onShare`
   has at lines 235-242 — the divergence is real, intentional, and commented
   (lines 251-255). `POsSection.test.tsx:485-494` asserts `mockConfirmAction` and
   `markPurchaseOrderSentManually` are never called on this path. Both Share
   buttons gate on the identical `canShare` (line 297) and render with distinct
   visual treatment (accent-filled vs `borderColor: C.borderStrong` outlined,
   lines 417-440) — no color literals, both from `useCmdColors()`.
5. **i18n ×3 + empty→NULL + CLAUDE.md conventions** — all six new keys
   (`orderCodeLabel`, `orderCodeHelp`, `quickOrderAction`, `quickOrderDialogTitle`,
   `quickOrderCopiedToast`, `quickOrderUnmappedWarning`) present in en/es/zh-CN
   with real (non-placeholder) translations, confirmed at `en.json:294-295,709-712`
   and the parallel es/zh-CN locations. `vendorRowsToLinkPayload`
   (`IngredientForm.tsx:265`) trims and coalesces empty/whitespace → `undefined`
   → `db.ts`'s `|| null`, matching AC-4's empty→NULL contract exactly, pinned in
   `IngredientForm.test.ts:606-641`. No direct `supabase.from`/`supabase.rpc` in
   any of the five changed frontend files (grep-confirmed zero hits). No
   `Alert.alert` / `window.confirm` introduced. pgTAP `plan(14)` matches exactly
   14 assertion calls in the file (manually counted) — no off-by-one. Migration
   filename (`20260708000000_...`) sorts after `20260707000000_staff_receiving_price_gate.sql`
   as claimed.

### Browser verification note

Main Claude's live pass (order code persisted to `item_vendors.order_code`,
blank → SQL NULL, export produced exactly `TOGO-9001\t5` + `??? #3 Togo Box\t8`,
no `$`, unmapped toast, no mark-sent prompt) matches the code paths traced above
exactly — the runtime behavior and the source are in agreement.
