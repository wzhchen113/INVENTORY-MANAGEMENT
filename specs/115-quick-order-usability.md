# Spec 115: Quick-order usability completion (order-code import · per-vendor order unit · reorder-card export · stub cleanup · missing-code visibility)

Status: READY_FOR_REVIEW

> **Origin (owner ask, verbatim intent):** Spec 114 shipped the per-vendor
> order-code *foundation* — `item_vendors.order_code` + a PO "Quick-order list"
> paste block (`<code>\t<qty>`, `??? <name>` for unmapped). A post-ship gap review
> found four things standing between "foundation" and "daily-usable," plus a fifth
> workstream to kill a wrong-order risk the owner surfaced. The owner ruled scope
> and the quantity-unit risk; both rulings are binding (below). All five
> workstreams are ONE spec.

## Owner rulings (binding — do not re-litigate)

- **R-1 — BUNDLE.** All four gaps + the order-unit workstream land in THIS one
  spec (W-1 … W-5 below). Not five specs.
- **R-2 — QUANTITY UNIT DEFAULT.** The quick-order block's number becomes a
  **per-vendor "order unit"** setting: **`case` vs `unit`**, **defaulting to
  `case`.** Rationale (owner): most wholesale quick-order boxes are case-based, so
  pasting counted units (e.g. `24`) into a case-based box silently orders a pallet.
  The owner will verify per vendor on live logins and flip any that differ. `case`
  is the safe default; the conversion is the load-bearing correctness surface (W-2).

## User story

As a **store manager**, I want (a) to bulk-import my vendors' order codes from a
spreadsheet instead of typing each one, (b) the quick-order paste block to emit
the number in **the unit that vendor's order box expects** (cases by default) so I
never accidentally order a pallet, (c) the same one-tap quick-order export from a
Reorder vendor card (not only from a saved PO), and (d) an at-a-glance signal of
which items still lack a code for a given vendor — so recording and using
order codes is a daily-fast operation, not a hand-typed chore with a wrong-order
trap.

Sub-stories:

- **US-1 (bulk import codes).** As an admin importing an ingredient CSV, I want a
  `vendor_sku` / "vendor code" column to actually WRITE to each item's per-vendor
  order code (it is parsed today but silently dropped), so I can seed hundreds of
  codes at once. I want the import result to tell me how many codes were written,
  how many links were created, and how many rows were skipped and why.
- **US-2 (order unit).** As an admin editing a vendor, I want to set whether that
  vendor's quick-order box counts in **cases** or in **counted units**, defaulting
  to **cases**, so the paste block divides my counted-unit order into whole cases
  for a case-based vendor and leaves it alone for a unit-based one.
- **US-2b (fractional safety).** As an admin, when a case conversion isn't a whole
  number of cases (e.g. 30 units ÷ a 24-case = 1.25), I want the block to **round
  UP to whole cases and tell me it rounded** — never silently truncate to a short
  order and never paste a fraction the vendor box rejects.
- **US-3 (reorder-card export).** As an admin on the Reorder screen, I want the
  same "Quick-order list" export on each vendor card (there is none today), sourced
  from that card's suggested order, so I can place a pre-PO order without first
  creating and opening a draft PO.
- **US-4 (stub cleanup).** As an admin, I want the obsolete read-only item-level
  "vendor sku · schema pending" field GONE from the ingredient form (it now sits
  confusingly next to the real per-vendor order-code field), so there is exactly
  one place codes live.
- **US-5 (missing-code visibility).** As an admin, I want to see how many items
  lack an order code for a given vendor without opening a PO, so I know where to go
  fill gaps in.

## Acceptance criteria

### W-1 — Bulk order-code import (backend write path)

- [ ] **AC-1.** `src/lib/csvImport.ts` gains a WRITE path for the already-parsed
  `vendor_sku` column (parsed at `csvImport.ts:27` / aliased at `:42`; today
  dropped in `rowToPayload`, `:138`). On commit, a row's `vendor_sku` value is
  persisted to `item_vendors.order_code` for the resolved `(item, vendor)` pair.
  The parsed value is NO LONGER silently discarded.
- [ ] **AC-2 (vendor resolution rule — pinned).** The vendor a row's code applies
  to is: **(a) the row's `vendor_name` column resolved to a brand vendor id when
  present and it matches an existing vendor for the store's brand; else (b) the
  item's existing PRIMARY-vendor link** (`inventory_items.vendor_id` /
  `is_primary` link). If NEITHER resolves — `vendor_name` present but matches no
  vendor, AND the item has no primary link — the row's code is **skipped, not
  written to a guessed vendor** (see AC-6 + OQ-2). Vendor names are matched
  case-insensitively against `vendors.name` within the item's brand. **A CSV cell
  NEVER auto-creates a vendor.**
- [ ] **AC-3 (upsert-vs-update semantics — pinned).** For the resolved `(item,
  vendor)`: if an `item_vendors` link already exists, UPDATE its `order_code`; if
  no link exists, CREATE one with `is_primary = false` (mirroring the receive/
  create-item link-insert precedent — `db.ts:362-378` / `:494-509`). The composite
  unique `(item_id, vendor_id)` + `onConflict` is the idempotency backstop. The new
  link carries the code + `cost_per_unit`/`case_price` defaults of `0` (the import
  is a CODE seed, not a cost edit).
- [ ] **AC-4 (blank cell = no-op — pinned, fail-safe).** A **blank / whitespace-only
  `vendor_sku` cell does NOT null out an existing `order_code`.** A blank cell is a
  no-op for the code (it neither writes nor clears). Only a NON-empty cell writes.
  Rationale: a partial CSV that omits codes for some rows must not wipe codes the
  admin already typed. (Clearing a code stays a per-card edit in `IngredientForm`,
  where an empty input → SQL NULL — spec 114 AC-4.)
- [ ] **AC-5 (import result report).** The import result surfaces THREE new counts
  distinct from the existing create/update/skip item counts: **codes written**
  (rows whose non-empty code landed on a link), **links created** (rows that needed
  a new non-primary `item_vendors` link), and **code rows skipped** (rows with a
  non-empty code that resolved to no vendor, per AC-2). The `RunImportModal` /
  `commitImport` result (`csvImport.ts:223-267`, surfaced via
  `RunImportModal.tsx:57-63`) reports these; the existing archive-deferred + item
  counts are unchanged.
- [ ] **AC-6 (skip is visible, not silent).** Every code row skipped per AC-2 is
  reflected in the AC-5 "code rows skipped" count AND (where the existing diff
  surfaces per-row reasons) tagged with a reason (e.g. `unmatched vendor "<name>"`),
  so the operator can see which rows didn't map rather than assuming all codes wrote.
- [ ] **AC-7 (tests — jest).** The extended csvImport write-mapping is jest-covered:
  a row with a matching `vendor_name` writes the code to that vendor's link; a row
  with a blank `vendor_name` writes to the item's primary link; a row with an
  unmatched `vendor_name` and no primary link is skipped (and counted); a blank
  `vendor_sku` cell is a no-op (does not clear an existing code); the three result
  counts are correct for a mixed batch.

### W-2 — Per-vendor order unit (R-2)

- [ ] **AC-8 (column).** `public.vendors` gains ONE new column recording the
  vendor's quick-order counting unit, constrained to `'case'` | `'unit'`,
  **defaulting to `'case'`** (R-2). Additive: existing rows default to `'case'` (no
  backfill needed — the default supplies it). The architect fixes the exact column
  name (PM recommends `order_unit`) + the CHECK/enum shape. A pgTAP test asserts the
  column exists, is `NOT NULL DEFAULT 'case'`, rejects a value outside
  `{case, unit}`, and that an existing row reads `'case'`.
- [ ] **AC-9 (RLS inherited).** The new column inherits the existing `vendors` RLS
  unchanged: INSERT is gated by the existing `"Vendors admin only"` policy
  (`auth_is_privileged()` — `20260517010000_vendors_master_role_fix.sql`); SELECT by
  the existing `"Vendors visible to all"` policy; UPDATE by whatever governs vendor
  UPDATE (see OQ-4 — vendor UPDATE currently has no dedicated policy; the architect
  confirms the write path the admin editor already uses succeeds and a non-privileged
  caller cannot set `order_unit`). No new policy is added by W-2 unless the architect
  finds the UPDATE path is currently ungated and rules one in.
- [ ] **AC-10 (vendor admin UI).** The vendor editor (`VendorFormDrawer.tsx` —
  where vendors are created/edited from `VendorsSection`) gains an **order-unit
  control** (segmented `Cases` / `Counted units`, defaulting to `Cases` on a new
  vendor). Saving persists it via the existing `addVendor`/`updateVendor` →
  `db.ts createVendor`/`updateVendor` path (`db.ts:1806` / `:2927`); reopening the
  drawer shows the saved value. The `Vendor` type (`types/index.ts:435`) + the
  `fetchVendors` mapper (`db.ts:1794-1802`) thread the field.
- [ ] **AC-11 (conversion — the load-bearing rule).** The quick-order builder
  converts each line's quantity by the PO/card vendor's order unit:
  - When the vendor's unit is **`'case'`**: `qty = ceil( orderedQty ÷ coalesce(caseQty, 1) )`
    — **division by `coalesce(caseQty, 1)`** (never divide by 0/null; a null/`1`
    case size means the item has no case, so cases == units), and the result is
    **rounded UP to whole cases** (`Math.ceil`). `caseQty` is already in memory: on
    the PO path via `PoLine.caseQty` (`db.ts:1422`), on the reorder path via
    `ReorderItem.caseQty` (`types/index.ts:816`).
  - When the vendor's unit is **`'unit'`**: qty is the counted-unit value verbatim
    (today's behavior — spec 114 `formatQty(orderedQty)`), no division.
- [ ] **AC-12 (fractional = fail LOUD, never silent — pinned requirement).** When a
  `'case'` conversion rounds a fractional case count up (i.e. `orderedQty` is not an
  exact multiple of `caseQty`), the discrepancy MUST be surfaced, NOT hidden:
  - the builder returns a **`roundedCount`** (how many lines were rounded up from a
    fraction), sibling to spec 114's `unmappedCount`;
  - the `POsSection` / Reorder handler fires a **summary warning** on
    `roundedCount > 0` (a count toast, e.g. "2 items rounded up to whole cases"),
    mirroring the unmapped-count warning.
  - The PM pins the *requirement* (round UP + a visible count-level marker; never a
    silent truncate, and NOT a chatty per-line `(rounded from X.Y)` suffix inside the
    machine block). **The architect fixes the exact mechanism** (return-shape field
    name + whether any inline sentinel appears in the block) in the design doc,
    keeping the block machine-pasteable.
- [ ] **AC-13 (unit-in-play visible on the share).** The share preview/dialog
  indicates **which unit the block is counted in** for that vendor (e.g. a
  preview-pane note or dialog subtitle "counting in cases" / "counting in units"),
  so the operator confirms the block matches the vendor's box before pasting. Copy
  is localized ×3 (AC-19).
- [ ] **AC-14 (tests — jest).** The extended builder is jest-covered byte-for-byte:
  a `'case'` vendor with `caseQty=24` and `orderedQty=48` emits `2` (exact); with
  `orderedQty=30` emits `2` AND increments `roundedCount`; a `caseQty` of `null`/`1`
  divides by `1` (units == cases, no rounding); a `'unit'` vendor emits the counted
  value unchanged with `roundedCount=0`; still NO `$` anywhere; unmapped `???` lines
  still surface. A pgTAP test covers AC-8 (column shape + CHECK + default).

### W-3 — Reorder-card quick-order export

- [ ] **AC-15.** Each vendor card in `ReorderSection.tsx` (`VendorCard`,
  `ReorderSection.tsx:241`) gains a **"Quick-order list"** export affordance next to
  the existing "+ Create PO" (`CreatePoButton`, `:182`). It reuses the spec-114 pure
  builder `buildPoQuickOrderText` (extended per W-2) and the spec-108 I/O orchestrator
  `sharePurchaseOrder` (`src/screens/cmd/lib/sharePo.ts`) verbatim — same native
  share-sheet / `navigator.share` / desktop-web clipboard+preview branching,
  never-throw / swallow-AbortError. Works on web (Vercel) AND native (EAS).
- [ ] **AC-16 (source quantities).** The lines are the card's **suggested order** per
  item: the builder's `orderedQty` is the reorder item's counted-unit suggestion
  (`ReorderItem.suggestedUnits` — the server-authoritative ordered base-unit total,
  `types/index.ts:818`), and the W-2 case conversion applies IDENTICALLY (divide by
  `coalesce(caseQty, 1)`, ceil, surface `roundedCount`) using `ReorderItem.caseQty`.
  The order code resolves for `(item, this vendor card's vendorId)` the same way the
  PO path does — from the hydrated `inventory` store rows'
  `vendors[].orderCode`.
- [ ] **AC-17 (pre-PO posture — no mark-sent).** The reorder-card export carries the
  SAME unmapped `???` flagging + unmapped-count warning + rounded-count warning as
  the PO path, and the SAME **no-status-change posture** — there is no PO yet (this
  is pre-PO), so there is no "did you send it?" prompt and no mark-sent side effect.
  It is purely a copy/paste aid.

### W-4 — Remove the dead item-level `vendorSku` stub

- [ ] **AC-18.** The read-only item-level "vendor sku · schema pending" field is
  REMOVED from `IngredientForm.tsx`: the `vendorSku` form field
  (`IngredientForm.tsx:43` on `IngredientFormValues`; `:86` in `blankValues`; the
  `InputLine` render at `:1283`) is deleted, AND the grey-fields helper text is
  updated to drop the "vendor sku" mention (`:1304-1308`, "…sku, reorder pt, max,
  **vendor sku**, avg cost…"). The per-vendor order-code field added by spec 114
  (`:1261-1268`) is UNTOUCHED and remains the only place codes live. The
  `csvImport.ts` `vendor_sku` header alias is KEPT — W-1 makes it the REAL write
  path (it no longer maps to a dead stub). Any other reference to the removed
  `values.vendorSku` (e.g. in `IngredientFormDrawer.tsx` hydration/save, if present)
  is removed so the build stays green. A jest/type check confirms no dangling
  `vendorSku` reference remains on the form values type.

### W-5 — Missing-codes visibility (ONE cheap surface)

- [ ] **AC-19-pre → renumber note:** (i18n AC is AC-20 below.)
- [ ] **AC-19.** `VendorsSection` surfaces, per selected vendor, a **count of items
  linked to that vendor that lack an `order_code`** — the cheapest surface: a stat
  on the vendor **detail** pane (the profile/catalog tab already shows
  `catalog.length` per vendor — `VendorsSection.tsx:344,363`), e.g. a
  "N missing codes" figure derived in-memory from the hydrated `inventory` rows
  (`item.vendors.find(v => v.vendorId === sel.id)?.orderCode` empty). This is the
  ONLY new missing-code surface (no per-row list-pane badge, no new query, no
  gold-plating). The existing PO-preview unmapped warning (spec 114 AC-9) stays as
  the second, in-flow signal.

### Cross-cutting

- [ ] **AC-20 (i18n ×3).** Every NEW user-visible string exists in all three locales
  (en / es / zh-CN) in the admin catalog (`src/i18n/*.json`, read via `useT`): the
  order-unit control label + its two options (W-2), the "counting in cases/units"
  share note (AC-13), the rounded-count warning (AC-12), the reorder-card
  "Quick-order list" label (W-3), the missing-codes stat label (W-5), and any new
  import-result copy the modal renders (W-1). The pasted BLOCK itself stays
  machine-facing / NOT localized (spec 114 OQ-8). Reuse the spec-114 keys already
  present (`section.inventory.orderCode*`, `section.purchaseOrders.quickOrder*` —
  `en.json:294,709`) where the same string applies; add new keys alongside them. No
  user-visible hardcoded English on the admin surface.

## In scope

- **W-1:** finish the CSV `vendor_sku` → `item_vendors.order_code` write path
  (vendor resolution rule AC-2, upsert-vs-create AC-3, blank-cell no-op AC-4, result
  report AC-5/6) through the existing `csvImport.ts` + `RunImportModal` commit
  pipeline. The write likely rides an EXTENDED store-action commit path (see
  Dependencies / OQ-1) rather than a brand-new `db.ts` helper — the architect pins
  the exact write plumbing (the existing `commitImport` calls store `addItem`/
  `updateItem`, NOT `db.ts` directly).
- **W-2:** one additive `vendors` column (`order_unit`, `case`|`unit`, default
  `case`); `Vendor` type + `fetchVendors`/`createVendor`/`updateVendor` threading;
  the `VendorFormDrawer` order-unit control; the case-conversion + `roundedCount` in
  the shared `poQuickOrderText` builder; the unit-in-play share note.
- **W-3:** a Reorder-vendor-card "Quick-order list" export reusing the SAME
  (W-2-extended) builder + the spec-108 `sharePurchaseOrder` orchestrator; sourced
  from `ReorderItem.suggestedUnits`; pre-PO (no mark-sent).
- **W-4:** delete the dead item-level `vendorSku` form field + its grey-fields
  helper mention; keep the csvImport alias (now the real write path).
- **W-5:** a per-vendor missing-code count on the `VendorsSection` detail pane.
- **i18n ×3** for all new admin-surface strings (AC-20).
- Tests on the matching tracks (named under Project-specific notes).

## Out of scope (explicitly)

- **Everything spec 114 excluded, still excluded.** Vendor-specific file FORMATS /
  transport (US Foods MOXē Import-Order file, Sysco `.700` upload-back, X12 EDI,
  cXML/OCI punchout), pulling codes FROM vendors (any inbound integration), and
  browser automation. Rationale: unchanged from spec 114 — no self-serve buyer API
  exists; this spec makes the *manual* foundation daily-usable, it does not add
  automation.
- **No staff-app changes.** This is admin Cmd UI only. No `src/screens/staff/` edit.
  Rationale: the admin authors codes/units and exports; staff receiving (spec 113)
  and staff reorder are separate surfaces with their own screens.
- **No change to the human-readable spec-108 Share.** `buildPoShareText` / its output
  / its button are untouched. Rationale: the human-readable message and the machine
  quick-order block serve different readers; W-2's order-unit conversion applies to
  the *quick-order block only* (the human-readable share keeps showing counted-unit
  `qty × unit`, which is correct for a person reading it).
- **No per-item order-unit override.** The order unit is a **per-vendor** setting
  (R-2), not per-(item, vendor). Rationale: R-2 scoped it to the vendor; a per-item
  override is a heavier data model the owner did not ask for and can be a later spec
  if a single vendor genuinely mixes case- and unit-based ordering across items.
- **No server-side order-code uniqueness** (spec 114 OQ-2 stands — free-form text,
  no cross-item uniqueness constraint). W-1's bulk write does not add one.
- **No auto-creating vendors from CSV cells** (AC-2). An unmatched `vendor_name`
  never creates a vendor; the row's code is skipped and reported.
- **No second missing-code surface beyond W-5's one stat.** No list-pane per-row
  badge, no dedicated "gaps" report/screen, no cross-vendor rollup. Rationale: W-5
  says pick ONE cheap surface; the detail-pane stat + the existing PO-preview warning
  are enough.
- **The `app.json` slug, identity drift, and the repo-root spreadsheet** — untouched
  (CLAUDE.md load-bearing / DO-NOT-AUTO-FIX). W-2 touches no build identifiers.

## Open questions resolved

Owner rulings R-1/R-2 are binding and cited above. Remaining mechanism/UX questions
are resolved with recommended defaults per the origin instruction ("resolve
remaining OQs with recommended defaults; owner accepts unless flagged"). **OQ-3 and
OQ-4 are the two FLAGGED forks** where a wrong default carries real cost — the owner
should confirm or redirect; if silent, the recommended default holds.

- **OQ-1 — W-1 write plumbing (store action vs new db.ts helper).** →
  **Recommend: extend the EXISTING commit path**, not a new isolated write. The CSV
  commit runs `computeDiff` → `commitImport` (`csvImport.ts:233`) → the store's
  `addItem`/`updateItem` (`RunImportModal.tsx:59`), which already own the
  `item_vendors` reconcile via the spec-102/114 `vendors?` payload. The cleanest fit
  is to thread the resolved `(vendorId, orderCode)` into that same payload so codes
  ride the reconcile the store already performs (no parallel write, no new RLS
  surface). **The architect confirms the exact seam** — whether the code joins the
  existing `vendors[]` payload the store action builds, and how the store action
  resolves `vendor_name` → `vendorId` (it already turns the form's vendor into a
  link). **Default; architect pins the plumbing.**

- **OQ-2 — W-1 unmatched-vendor semantics.** → **Recommend: SKIP + report (AC-2 /
  AC-6), never fall back to a guessed vendor when a `vendor_name` is *present but
  unmatched*.** A present-but-unmatched name means the operator named a specific
  vendor that doesn't exist — writing the code to the item's primary vendor instead
  would silently attach it to the WRONG vendor. Only a **blank** `vendor_name` falls
  back to the item's primary link (AC-2 branch b). **Default; owner accepts unless
  flagged.** (This is the fail-safe consistent with the whole spec's wrong-order
  theme.)

- **OQ-3 — [FLAGGED] W-2 order-unit realtime.** → **Recommend: ADD `public.vendors`
  to the `supabase_realtime` publication** so an `order_unit` edit (and, as a bonus,
  EVERY vendor edit) replays live to other admin clients. **Finding that forces the
  question:** `useRealtimeSync.ts:68` ALREADY subscribes to `vendors` on the
  `brand-{id}` channel, but **no migration ever added `public.vendors` to the
  `supabase_realtime` publication** — so vendor edits are subscribed-but-never-
  delivered TODAY (a latent gap). Adding the table fixes that gap and makes
  order_unit behave like `item_vendors` did after spec 102/114. **COST to surface:**
  this is a publication-*membership* change, so it (a) needs the mid-session `docker
  restart supabase_realtime_imr-inventory` locally to re-snapshot the slot (the
  realtime publication gotcha — CLAUDE.md / project memory), and (b) is a prod
  publication change applied via the Supabase MCP, NOT a no-op. **Alternative** (if
  the owner prefers minimal blast radius): leave the publication as-is; `order_unit`
  persists correctly and appears on other clients' next full reload (store switch /
  refresh), matching how vendor edits already behave. **PM leans "add to publication"
  (fixes a real latent gap); owner/architect may choose reload-only. Architect pins
  the observable + the docker-restart/prod-publication note either way.**

- **OQ-4 — [FLAGGED] W-2 vendor UPDATE RLS.** → **Recommend: architect audits the
  vendor UPDATE path before shipping the editor control.** The `vendors_master_role_fix`
  migration comment states "UPDATE/DELETE on vendors have no policies today;
  intentionally leaving them denied" (`20260517010000_vendors_master_role_fix.sql:14`)
  — yet `db.ts updateVendor` (`:2927`) issues a plain `vendors` UPDATE that the admin
  editor already relies on (existing vendor edits save today). This must mean either
  (a) admin edits pass via `auth_is_admin()`/service context, or (b) UPDATE is in
  fact ungated. The architect confirms the actual state and, if UPDATE is ungated,
  rules whether W-2 should ADD a privileged UPDATE policy (`auth_is_privileged()`,
  mirroring the INSERT policy) so a non-privileged caller cannot flip `order_unit` (or
  any vendor field). **Flagged because it is a pre-existing RLS question this
  column-add legitimately triggers — the architect decides whether to close it here
  or leave the pre-existing posture; either way pgTAP should prove a non-privileged
  caller cannot set `order_unit`.**

- **OQ-5 — W-2 column name + shape.** → **Recommend `order_unit text NOT NULL DEFAULT
  'case' CHECK (order_unit IN ('case','unit'))`.** `text` + CHECK matches the
  codebase's existing enum-ish columns (`vendors` uses plain text for cutoff/schedule)
  and avoids a Postgres ENUM type migration; `NOT NULL DEFAULT 'case'` supplies R-2's
  default to every existing row with no backfill. **Architect confirms the final name
  + whether a CHECK or a DB enum.** **Default; architect pins.**

- **OQ-6 — W-2 fractional mechanism.** → **Recommend: `ceil` + a builder-returned
  `roundedCount` + a summary count-warning toast** (AC-12), NO per-line
  `(rounded from X.Y)` suffix in the machine block (too chatty; would break clean
  paste). **Architect fixes the exact return-shape field + whether any inline
  sentinel appears** (PM pins only the fail-loud REQUIREMENT: round up + a visible
  count marker, never a silent truncate). **Default; architect pins mechanism.**

- **OQ-7 — W-5 which surface.** → **Recommend the vendor DETAIL pane stat** (a
  "N missing codes" figure next to the existing per-vendor catalog count), NOT a
  list-pane per-row badge. Cheapest (reuses the already-hydrated `inventory` rows +
  the existing `catalog` memo in `VendorsSection`), one number, no new query.
  **PM picks ONE surface per the origin instruction; owner accepts unless flagged.**

- **OQ-8 — Does the pasted block get an order-unit header?** → **No.** The block stays
  bare `<code>\t<qty>` (machine-facing, spec 114 OQ-8). The order-unit context lives
  in the SURROUNDING UI (the AC-13 "counting in cases/units" note on the preview/
  dialog), not in the pasted text. **Default; owner accepts unless flagged.**

## Dependencies

- **Spec 114 (live) — the foundation this completes.** `item_vendors.order_code`
  (`supabase/migrations/20260708000000_item_vendor_order_code.sql`); the pure builder
  `src/utils/poQuickOrderText.ts` (`buildPoQuickOrderText(lines, resolveCode,
  resolveName) → { text, unmappedCount }`) — W-2 EXTENDS its signature/return
  (order-unit-aware qty + `roundedCount`) and W-3 REUSES it; the PO handler
  `POsSection.onShareQuickOrder` (`POsSection.tsx:256-289`); the per-vendor
  order-code card input (`IngredientForm.tsx:1261-1268`) — untouched by W-4; the
  `ItemVendorLink.orderCode` hydration through `db.ts fetchInventory` embed
  (`db.ts:238-239`) + `mapItem`. The i18n keys `section.inventory.orderCode*`
  (`en.json:294`) + `section.purchaseOrders.quickOrder*` (`en.json:709`).
- **Spec 108 (live) — reused I/O.** `src/screens/cmd/lib/sharePo.ts`
  `sharePurchaseOrder` (native sheet / `navigator.share` / desktop clipboard+preview,
  never-throw, swallow-AbortError, returns `{ shared, previewText }`) reused VERBATIM
  by BOTH the PO path (unchanged) and the new Reorder-card path (W-3). The shared
  `formatQty` (`src/utils/reorderExport.ts:26`).
- **Spec 102 (live) — `item_vendors` write path.** The create-item link upsert
  (`db.ts:362-378`) + update-reconcile upsert (`db.ts:494-509`) that W-1 threads the
  imported code through (via the store `addItem`/`updateItem` `vendors?` payload —
  OQ-1); the composite unique `(item_id, vendor_id)`.
- **Spec 021/107 (live) — reorder payload.** `ReorderItem.suggestedUnits` +
  `ReorderItem.caseQty` (`types/index.ts:816-818`) feed W-3's quantities + the W-2
  conversion; the `VendorCard` (`ReorderSection.tsx:241`) that W-3 adds the export to.
- **CSV import pipeline (W-1).** `src/lib/csvImport.ts` (parse `:100`, `rowToPayload`
  `:138`, `computeDiff` `:168`, `commitImport` `:233`, `CommitResult` `:223`);
  `src/components/cmd/UploadCsvModal.tsx` (column-mapping surface) +
  `src/components/cmd/RunImportModal.tsx` (commit + result toast, `:57-63`);
  `src/screens/cmd/sections/POSImportsSection.tsx:347-363` (wires both modals +
  `computeDiff`). Note: `commitImport` calls the STORE's `addItem`/`updateItem`, NOT
  `db.ts` directly (OQ-1).
- **A new migration (W-2).** Additive `order_unit` column on `public.vendors`
  (`text NOT NULL DEFAULT 'case' CHECK …`, PM recommendation — architect confirms).
  No backfill (the default supplies existing rows). **IF OQ-3 resolves to "add to
  publication":** the SAME or a sibling migration adds `public.vendors` to
  `supabase_realtime` (a publication-membership change → the docker-restart gotcha +
  a prod publication apply). Applied to prod via the Supabase MCP (project memory
  "Prod migration via Supabase MCP" — `db push` lacks the prod password), then the
  exact version inserted into `schema_migrations` so `db-migrations-applied.yml`
  (spec 064) stays green. The developer FLAGS the prod-apply in the handoff; they do
  not push it themselves. Filename sorts after
  `20260708000000_item_vendor_order_code.sql` (architect fixes the timestamp).
- **`src/lib/db.ts`** — `fetchVendors` mapper (`:1794`), `createVendor` insert
  (`:1809`), `updateVendor` dbUpdates (`:2929`) thread `order_unit` (W-2). No change
  to the `item_vendors` embed/upsert beyond what spec 114 already landed (W-1 rides
  the store `addItem`/`updateItem` payload — OQ-1).
- **`src/types/index.ts`** — `Vendor` (`:435`) gains the order-unit field (W-2).
- **`src/components/cmd/VendorFormDrawer.tsx`** — the order-unit control (W-2);
  `FormValues` + `blank()` + `fromVendor()` + `toUpdates()` (`:20-70`) thread it.
- **`src/utils/poQuickOrderText.ts`** — signature/return extended for the order-unit
  conversion + `roundedCount` (W-2); consumed by both `POsSection` (existing) and
  `ReorderSection` (new — W-3).
- **`src/lib/csvImport.ts`** — the `vendor_sku` → `order_code` write mapping +
  vendor-resolution + result counts (W-1).
- **`src/components/cmd/IngredientForm.tsx`** — remove the item-level `vendorSku`
  stub field + grey-fields helper mention (W-4).
- **`src/screens/cmd/sections/VendorsSection.tsx`** — the per-vendor missing-code
  stat (W-5).
- **i18n catalogs** — `src/i18n/{en,es,zh-CN}.json` `section.*` — new order-unit /
  rounded-warning / reorder-export / missing-code / import-result keys ×3 (AC-20).

## Project-specific notes

- **Cmd UI section / legacy:** all five workstreams land in EXISTING admin Cmd UI
  surfaces — `POSImportsSection` + `csvImport`/`RunImportModal` (W-1),
  `VendorFormDrawer`/`VendorsSection` (W-2/W-5), `ReorderSection` (W-3),
  `IngredientForm` (W-4), `POsSection`/`poQuickOrderText` (W-2 conversion). No new
  section; no legacy admin surface (spec 025 deleted it).
- **Which app:** this repo, admin Cmd UI ONLY. Staff app OUT (no `src/screens/staff/`
  change). Customer PWA is a sibling repo — untouched.
- **Per-store or admin-global:** MIXED, matching the underlying data. `item_vendors`
  codes (W-1) are per-store via the transitive `item_id → inventory_items.store_id`
  RLS (unchanged from spec 114). `vendors.order_unit` (W-2) is **brand-level** (the
  `vendors` table is brand-scoped, not store-scoped — a vendor's counting unit is the
  vendor's, shared across the brand's stores), gated by the existing `vendors`
  policies (INSERT `auth_is_privileged()`; UPDATE — see OQ-4). W-5's missing-code
  count is computed in-memory from the store-scoped `inventory` slice.
- **Edge function or PostgREST:** **PostgREST only.** W-1 rides the existing
  `item_vendors` upsert (via the store action — OQ-1); W-2 is a plain column on
  `vendors` read/written through `db.ts`. **No RPC, no edge function** — no cross-row
  invariant or role gate beyond the existing table RLS. No `staff-*` / service-token /
  `pwa-catalog` surface.
- **Realtime channels touched:** **`brand-{id}` (W-2 vendors) — and this is a real
  publication decision (OQ-3), NOT the "already published" ABSENCE spec 114 had.**
  `item_vendors` was already in `supabase_realtime` (spec 102), so spec 114's column
  add needed no publication work. `public.vendors` is DIFFERENT: it is subscribed in
  `useRealtimeSync.ts:68` but was NEVER added to the publication — so vendor edits do
  not replay live today. If OQ-3 resolves to "sync live," W-2's migration ADDS
  `public.vendors` to the publication, which DOES incur the `docker restart
  supabase_realtime_imr-inventory` gotcha (local re-snapshot) + a prod publication
  apply. W-1's `item_vendors` writes replay on `store-{id}` unchanged (already
  published). Flag both explicitly so the deploy checklist is neither padded (W-1) nor
  missing a real step (W-2).
- **Migrations needed:** **yes — one** (W-2): additive `vendors.order_unit`
  (`text NOT NULL DEFAULT 'case' CHECK …`), no backfill. Optionally the publication
  add (OQ-3). Prod-apply via Supabase MCP + `schema_migrations` insert (spec 064
  gate). W-1, W-3, W-4, W-5 need NO migration (W-1 writes to the existing
  `item_vendors.order_code` column spec 114 already shipped).
- **Two share paths must share ONE builder (flag for frontend):** the PO
  `onShareQuickOrder` (W-2 conversion) and the new Reorder-card export (W-3) MUST call
  the SAME extended `poQuickOrderText` builder so the case-conversion + `roundedCount`
  + `???` unmapped logic is byte-for-byte identical across both surfaces. Do NOT fork
  a second builder.
- **The order-unit conversion is the correctness surface (flag for reviewers):** the
  `ceil(orderedQty / coalesce(caseQty, 1))` + fail-loud `roundedCount` is where a
  wrong-order regression would live (R-2's whole reason). It gets byte-for-byte jest
  coverage (AC-14) AND is the primary post-impl backend-architect drift check for the
  builder-signature change.
- **Edge functions touched:** **none.**
- **Web/native scope:** **both.** The vendor editor + PO/Reorder share render on web
  (Vercel) and native (EAS); `sharePurchaseOrder` already branches native sheet /
  web `navigator.share` / desktop clipboard+preview (spec 108). No web-only affordance.
  (The CSV import file-picker in `UploadCsvModal` is already web-guarded — W-1 changes
  the write mapping, not the picker, so it inherits that posture unchanged.)
- **`app.json` slug:** untouched — no bearing on build identifiers; `slug` stays
  `towson-inventory` pending explicit approval.
- **Test tracks (spec 022):**
  - **pgTAP:** (W-2) `vendors.order_unit` exists + is `NOT NULL DEFAULT 'case'` +
    rejects a value outside `{case, unit}` (CHECK) + an existing row reads `'case'`
    (AC-8); AND (OQ-4) a non-privileged caller cannot set `order_unit` (RLS proof —
    reuse/extend `supabase/tests/vendors_role_access.test.sql`). No new `item_vendors`
    pgTAP needed for W-1 (the column + its RLS were proven in spec 114's
    `item_vendors_rls.test.sql`). The spec-053 permissive-policy lint arm scans
    automatically; if OQ-4 adds a privileged UPDATE policy it is scoped (not
    trivially-wide) so no allowlist edit is expected — state this so a green lint
    isn't read as a gap.
  - **jest:** (W-1) the extended csvImport write-mapping — vendor resolution
    (matched name / blank→primary / unmatched→skip), blank-cell no-op, the three
    result counts (AC-7). (W-2) the extended `poQuickOrderText` builder byte-for-byte
    — case ceil, exact-multiple no-round, `caseQty` null→÷1, `'unit'` verbatim,
    `roundedCount`, still no `$`, `???` unmapped still surfaced (AC-14). (W-4) a
    type/reference check that no `vendorSku` field remains on `IngredientFormValues`.
  - **shell smoke:** none anticipated.

## Handoff (PM → architect — superseded by the design below)
next_agent: backend-architect
prompt: Design the contract for spec 115. Fix the deferred/flagged items:
  (OQ-5) the `vendors.order_unit` column name + shape (PM recommends
  `text NOT NULL DEFAULT 'case' CHECK (order_unit IN ('case','unit'))`);
  (OQ-3, FLAGGED) whether to ADD `public.vendors` to the `supabase_realtime`
  publication — note the latent gap (vendors is subscribed in
  useRealtimeSync.ts:68 but never published, so vendor edits don't replay today)
  and pin the docker-restart/prod-publication note whichever way you rule;
  (OQ-4, FLAGGED) audit the vendors UPDATE RLS path (the master-role-fix migration
  says UPDATE is unpoliced, yet db.ts updateVendor issues a plain UPDATE the admin
  editor already uses) and decide whether W-2 adds a privileged UPDATE policy;
  (OQ-1) the W-1 write seam (recommend threading the resolved (vendorId, orderCode)
  into the existing store addItem/updateItem `vendors?` payload the commit path
  already uses, NOT a new db.ts helper — confirm how the store action resolves
  vendor_name→vendorId); (OQ-6) the exact fractional mechanism (PM pins only the
  fail-loud requirement: ceil + a visible count marker, never a silent truncate;
  you fix the builder return-shape field + any inline sentinel). Specify the extended
  `poQuickOrderText` signature/return (order-unit-aware qty + `roundedCount`, shared
  by BOTH the PO and Reorder-card paths), the `Vendor` type + fetchVendors/
  createVendor/updateVendor threading, and the csvImport write-mapping contract.
  Then set Status: READY_FOR_BUILD.
payload_paths:
  - specs/115-quick-order-usability.md

---

## Backend design

Design mode. Live-schema audit performed by reconstructing the applied
`pg_policies` / `pg_publication_tables` state from the full migration lineage
(the repo is the faithful mirror of prod — `supabase db pull` 2026-05-02, and the
`db-migrations-applied.yml` gate enforces repo↔prod parity, so the ordered
migration set IS the live state). Two of the spec's flagged premises turned out
to be **factually wrong against the applied schema** — corrected below. One
**undisclosed data-loss trap** in the W-1 seam was found and is closed by design.

### 0. Audit findings (the two FLAGGED forks + one trap) — read first

**OQ-3 (realtime publication) — PM PREMISE IS FALSE. No publication change.**
The spec states "no migration ever added `public.vendors` to the
`supabase_realtime` publication … vendor edits are subscribed-but-never-delivered
today." **This is incorrect.** The publication was rebuilt from `FOR ALL TABLES`
to an explicit allowlist in `20260514140000_realtime_publication_tighten.sql`, and
that allowlist **explicitly lists `public.vendors`** (line 52), right next to the
`vendors` subscription rationale it documents (lines 30, 52). No later migration
drops/recreates the publication (the only other `create publication` is the
superseded `20260502190000`; `item_vendors` and `order_code` used additive `alter
publication … add table`). **Therefore `public.vendors` HAS been in
`supabase_realtime` since 2026-05-14 and vendor edits DO replay live today** — the
`useRealtimeSync.ts:68` subscription is delivered, not latent.
- **Ruling:** W-2 adds **NO** publication membership change. `order_unit` is a
  column on an already-published table (exactly the spec-114 `order_code`-on-
  `item_vendors` situation): an `order_unit` edit replays on `brand-{id}` with zero
  wiring change.
- **Deploy/dev consequence:** the `docker restart supabase_realtime_imr-inventory`
  ritual **does NOT apply** to the W-2 migration (it changes no publication
  membership — same deliberate-absence as spec-114's order_code migration, which
  called this out explicitly). The prod apply is column-only; **no publication
  apply.** Do not pad the deploy checklist with a no-op restart.
- **If the owner still observes vendor edits not replaying live**, that is a
  DIFFERENT bug (WebSocket reconnect / a since-`FOR ALL TABLES` local container
  that never re-snapshotted after 20260514140000) and is out of scope for 115 —
  surface it separately; do not fold a speculative publication re-add into this
  spec.

**OQ-4 (vendors UPDATE RLS) — MIGRATION COMMENT IS STALE. UPDATE is already
gated correctly. No new policy.** The `20260517010000_vendors_master_role_fix.sql`
comment ("UPDATE/DELETE on vendors have no policies today; intentionally leaving
them denied", and "`Vendors visible to all` … untouched") is **stale
documentation that does not match the applied state.** The true lineage, in
timestamp order:
- `20260405000759` (init): RLS enabled on `vendors`; SELECT `Vendors visible to
  all`, INSERT `Vendors admin only`. No UPDATE/DELETE.
- `20260504073942` (P5): creates `admin_update_vendors` / `admin_delete_vendors`
  (`auth_is_admin()`).
- `20260509000000` (multi-brand RLS) **is the decisive last-writer for
  UPDATE/DELETE**: it drops the P5 policies AND creates
  **`privileged_update_vendors`** (`for update using (auth_is_privileged() AND
  auth_can_see_brand(brand_id)) with check (same)`, lines 586-595) and
  `privileged_delete_vendors` (same gate), plus `brand_member_read_vendors`
  (SELECT, `auth_can_see_brand`) and `privileged_insert_vendors`.
- `20260517010000` (master-role-fix) only re-creates an INSERT policy named
  `Vendors admin only` (`with check auth_is_privileged()`). Its `drop policy if
  exists "Vendors admin only"` is a **no-op** (509 had already dropped that name),
  so the net effect is a SECOND permissive INSERT policy added alongside the
  surviving `privileged_insert_vendors`. Its comment about UPDATE/DELETE was simply
  written without awareness that 509 (8 days earlier) had already installed the
  `privileged_*` UPDATE/DELETE policies.

**Net applied `vendors` policy state (what actually governs the live editor):**

| cmd | policy(ies) | gate |
|-----|-------------|------|
| SELECT | `brand_member_read_vendors` | `auth_can_see_brand(brand_id)` |
| INSERT | `privileged_insert_vendors` **OR** `Vendors admin only` (two permissive) | `auth_is_privileged() AND auth_can_see_brand` **OR** `auth_is_privileged()` |
| UPDATE | `privileged_update_vendors` | `auth_is_privileged() AND auth_can_see_brand(brand_id)` (USING + WITH CHECK) |
| DELETE | `privileged_delete_vendors` | `auth_is_privileged() AND auth_can_see_brand(brand_id)` |

- **Why the editor "works" today:** `db.ts updateVendor` (`:2938`) issues a plain
  `vendors` UPDATE that succeeds because the caller is an admin →
  `auth_is_privileged()` true and `auth_can_see_brand(brand_id)` true. A
  non-privileged member is ALREADY denied by `privileged_update_vendors`. It is NOT
  ungated and NOT denied — it is correctly privileged-gated.
- **Ruling:** W-2 adds **NO new UPDATE policy.** `order_unit` is a column;
  `privileged_update_vendors` is row-level and column-agnostic, so it gates
  `order_unit` the instant the column exists — identical inheritance to spec-114's
  `order_code` under the `item_vendors` policies. Adding a new permissive UPDATE
  policy would be redundant AND would trip the spec-053 permissive-policy-lint
  fan-out; adding a RESTRICTIVE one would be a behavior change nobody asked for.
- **Honesty obligation (AC-9 / test-track):** the pgTAP **must make the stale
  comment honest by proving the real behavior** — extend
  `supabase/tests/vendors_role_access.test.sql` with UPDATE cases (see §7). This
  closes OQ-4: the column-add "legitimately triggered" the question; the answer is
  "already gated, prove it," not "add a policy."
- **Pre-existing latent gaps observed, explicitly OUT of scope for 115** (surface,
  do not fix here): (a) the second INSERT policy `Vendors admin only` lacks the
  `auth_can_see_brand` clause, so a privileged user of brand A could INSERT a vendor
  row for brand B via that ORed policy — a cross-brand INSERT gap predating this
  spec; (b) `db.ts updateVendor` silently drops `deliveryDays` and `categories` on
  update (they're in `toUpdates()` but not threaded in `dbUpdates` — `:2929-2937`),
  a pre-existing partial-write bug. Both are noted for a future vendor-RLS/vendor-
  editor spec; 115 neither depends on nor fixes them. (The `order_unit` threading
  in §5 does NOT re-introduce (b) — it adds its own explicit thread.)

**OQ-1 (W-1 write seam) — UNDISCLOSED DATA-LOSS TRAP. The naive
"thread `{vendorId,orderCode}` into the store `vendors?` payload" is UNSAFE for
existing items and MUST NOT be shipped as-is.** Root cause: `db.ts
updateInventoryItem` treats `updates.vendors` as a **FULL RECONCILE**, not a merge
(`:474-517`): it upserts the submitted links AND **deletes every link whose
`vendorId` is not in the submitted array** (`:510-517`), and the upsert writes
`cost_per_unit: 0, case_price: 0` for any field the caller omits (`:499-500`). A
CSV code-seed only knows `(vendorId, orderCode)` — it has no costs and no
knowledge of the item's OTHER vendor links. So calling `updateItem(id, { vendors:
[{ vendorId: X, orderCode: 'ABC' }] })` on an item that already links vendors A, B,
C would **delete links B and C** and **zero out A's per-vendor cost/case_price**.
That is silent destruction of existing per-vendor cost data and other-vendor links
— the exact opposite of AC-3 ("a CODE seed, not a cost edit") and AC-4's fail-safe
posture. `createInventoryItem` (`:362-378`) is upsert-only (no delete) so the
CREATE path is safe, but a CSV that touches an existing item is the common case.

- **Ruling — the W-1 write MUST send the item's EXISTING `vendors[]` link set with
  the code merged onto the resolved link, not a code-only array.** The commit path
  already has the hydrated `inventory` rows (`RunImportModal` has
  `useStore((s)=>s.inventory)` available; the diff already carries `existing:
  InventoryItem` for updates and `computeDiff` receives `existing`). Concretely,
  `commitImport` builds the `vendors[]` payload for a row from the item's CURRENT
  `item.vendors[]` (each `{ vendorId, costPerUnit, casePrice, orderCode }`),
  overwriting `orderCode` ONLY on the entry whose `vendorId === resolvedVendorId`,
  and appending a new `{ vendorId: resolvedVendorId, costPerUnit: 0, casePrice: 0,
  orderCode: code }` when no such link exists (AC-3 create-with-`is_primary=false`).
  Every other link rides through UNCHANGED (its real cost/case_price preserved), so
  the reconcile is a no-op for them and a targeted code write for the resolved one.
  This keeps OQ-1's "no new db.ts helper, ride the existing `vendors?` payload"
  intent **while defusing the reconcile-delete**. See §3 for the exact plumbing.
- **This makes W-1 a mixed backend+frontend workstream** even though it needs no
  migration and no db.ts change: the CSV-write logic lives in `csvImport.ts` (a
  `src/lib/` module — backend-owned per the db.ts-adjacency convention) but reads
  the store's `inventory` slice via the `CommitContext`, and `RunImportModal`
  (frontend) threads the slice + the new report counts into the toast. Assigned
  to backend-developer (csvImport contract + the merge logic + jest) with
  frontend-developer wiring the modal report copy.

### 1. Data model changes

**One additive migration. Additive-only, non-destructive, instant on PG17.**

- **File:** `supabase/migrations/20260709000000_vendor_order_unit.sql` (sorts
  immediately after `20260708000000_item_vendor_order_code.sql`; keeps the one-
  migration-per-day cadence the recent history uses).
- **DDL (developer authors; shown here as the contract, not committed by
  architect):**
  ```
  alter table public.vendors
    add column if not exists order_unit text not null default 'case'
      check (order_unit in ('case', 'unit'));

  comment on column public.vendors.order_unit is
    'spec 115 (W-2): the counting unit the vendor''s web quick-order box expects. '
    '''case'' (default) → the quick-order builder divides counted units by the '
    'item''s case_qty and rounds UP to whole cases; ''unit'' → counted units '
    'verbatim (spec 114 behavior). Brand-level (vendors is brand-scoped). Inherits '
    'the existing vendors RLS (brand_member_read_vendors / privileged_insert_vendors '
    '+ "Vendors admin only" / privileged_update_vendors / privileged_delete_vendors) '
    'column-agnostically. Additive: existing rows read ''case'' from the DEFAULT — '
    'no backfill.';
  ```
- **Shape confirmation (OQ-5):** `text NOT NULL DEFAULT 'case' CHECK (order_unit
  IN ('case','unit'))` — CONFIRMED as the PM recommended. Rationale: matches the
  codebase's enum-ish text columns (`vendors.order_cutoff_time`, statuses on
  `purchase_orders` use text+CHECK, not PG enums); a real PG enum type would add a
  `create type` + a harder-to-alter dependency for no benefit. `NOT NULL DEFAULT
  'case'` supplies R-2's safe default to every existing row **without a backfill
  statement** (`add column … default` is metadata-only on PG17 for a constant
  default → instant, non-rewriting, safe on the seed and prod).
- **`if not exists`** keeps a manual re-apply idempotent (mirrors the spec-114
  order_code migration's guard).
- **Destructive?** No. Purely additive. Reversible-by-design: `alter table
  public.vendors drop column order_unit;` returns the system to its prior state (no
  index, no dependent object, no FK).
- **Rollout safety:** the DEFAULT means the app is forward/backward compatible
  across the apply window — a client that hasn't loaded the new `order_unit` field
  yet is unaffected (it never selects or writes it), and a client that DOES select
  it gets `'case'` for every existing vendor. No ordering hazard vs the FE deploy.
- **No index.** `order_unit` is read as part of the full `vendors` row fetch
  (`fetchVendors` `select('*')`) and consumed in-memory; it is never a query
  predicate. Adding an index would be dead weight.

### 2. RLS impact

- **New table?** None.
- **New/changed policies?** **NONE** (per the OQ-4 ruling in §0). `order_unit`
  inherits the four existing `vendors` policies unchanged, exactly as spec-114's
  `order_code` inherited `item_vendors` RLS. The migration carries **no policy
  hunk.**
- **spec-053 permissive-policy-lint:** unaffected. No policy is added, so the lint
  arm stays green **and no allowlist edit is expected** — state this in the PR so a
  green lint is not misread as "the RLS test was skipped." (If a reviewer or the
  owner later insists on a dedicated `order_unit` UPDATE policy despite the audit,
  it would be scoped — `auth_is_privileged() AND auth_can_see_brand` — hence NOT
  trivially-wide, so still no allowlist row; but the design position is: do not add
  it, it is redundant.)
- **W-1 `item_vendors` writes** inherit the four `store_member_*_item_vendors`
  policies (transitive store scope via `item_id → inventory_items.store_id`) —
  unchanged from spec 114/102. No new RLS surface for the code seed.

### 3. API contract

**PostgREST only. No RPC, no edge function** (confirmed — no cross-row invariant,
no role gate beyond table RLS). Two surfaces:

**(a) W-2 `vendors.order_unit` — plain column read/write through existing
PostgREST paths in `db.ts`.**
- Read: `fetchVendors` `select('*')` already returns the column; the mapper threads
  it (§5).
- Write: `createVendor` INSERT / `updateVendor` UPDATE thread `order_unit` (§5).
- Error cases: a value outside `{case,unit}` → Postgres `23514` check_violation →
  surfaces through the store's optimistic-then-revert + `notifyBackendError`. In
  practice the UI is a segmented control that can only emit `'case'|'unit'`, so
  `23514` is a defense-in-depth backstop, not a user-reachable path. `updateVendor`
  is gated by `privileged_update_vendors`; a non-privileged caller gets `42501`
  (RLS) → the update silently no-ops the row (0 rows) and the optimistic value
  reverts on the next reload (the pgTAP proves the DENY at the DB boundary).

**(b) W-1 CSV code seed — rides the EXISTING `updateInventoryItem` /
`createInventoryItem` `vendors?` payload via the store `updateItem`/`addItem`
actions. No new db.ts helper, no new RPC (OQ-1 honored).** The contract change is
entirely inside `csvImport.ts`:

- **`ColumnMapping` / `rowToPayload` (`csvImport.ts:138`):** carry the parsed
  `vendor_sku` value onto the diff. Add a private field to the mapped payload —
  since `order_code` is NOT an `InventoryItem` field, do NOT put it on
  `Partial<InventoryItem>`. Instead, thread it on the `DiffOp` as a sibling scalar:
  extend `DiffOp` with `orderCode?: string` (the trimmed non-empty `vendor_sku`
  cell; **absent when the cell is blank/whitespace** — AC-4) and `vendorNameRaw?:
  string` (the raw `vendor_name` cell for resolution + skip reporting).
  `rowToPayload` continues to set `payload.vendorName` for the existing
  create/update-vendor-name behavior; the NEW `orderCode`/`vendorNameRaw` live on
  the op, not the payload.
- **Vendor resolution (AC-2, runs in `computeDiff` or a resolver passed to it):**
  the resolver needs the brand's `vendors[]` slice + the item's existing links.
  Signature the store/modal supplies to the pure diff:
  ```
  resolveVendorForCode(args: {
    vendorNameRaw?: string;                 // the row's vendor_name cell (trimmed)
    itemExistingLinks: ItemVendorLink[];    // item.vendors[] for an update; [] for a create
    itemPrimaryVendorId?: string;           // inventory_items.vendor_id (scalar primary)
    brandVendors: Array<{ id: string; name: string }>;
  }): { vendorId: string } | { skip: 'unmatched_vendor'; name: string } | { skip: 'no_vendor' }
  ```
  Rule (pinned by AC-2):
  1. `vendorNameRaw` present → case-insensitive match against `brandVendors.name`
     (normalize with the existing `norm()` in csvImport for whitespace/case). Match
     → `{ vendorId }`. **No match → `{ skip: 'unmatched_vendor', name }`** (NEVER
     fall back to primary — OQ-2 fail-safe). A CSV cell **never creates a vendor.**
  2. `vendorNameRaw` blank → the item's PRIMARY vendor
     (`itemPrimaryVendorId`, which is `inventory_items.vendor_id` / the
     `is_primary` link). Present → `{ vendorId }`. Absent → `{ skip: 'no_vendor' }`.
- **Upsert-vs-create + the RECONCILE-SAFE merge (AC-3 + the §0 trap fix):** in
  `commitImport`, for each op that carries an `orderCode` AND resolved to a
  `vendorId`, build the `vendors[]` payload from the item's **existing links**:
  ```
  const base = existingLinks.map(l => ({
    vendorId: l.vendorId,
    costPerUnit: l.costPerUnit,      // PRESERVE — never zero an existing cost
    casePrice: l.casePrice,          // PRESERVE
    orderCode: l.vendorId === resolvedVendorId ? code : l.orderCode, // overwrite ONLY the target
  }));
  const vendorsPayload = base.some(l => l.vendorId === resolvedVendorId)
    ? base
    : [...base, { vendorId: resolvedVendorId, costPerUnit: 0, casePrice: 0, orderCode: code }];
  ```
  - For a **CREATE** op (`existingLinks` empty), this collapses to a single
    non-primary link `{ resolvedVendorId, 0, 0, code }` — but note the create path
    ALSO carries the item's own `vendorName`/`vendorId` scalar; the link whose
    `vendorId === scalar` becomes `is_primary` in db.ts. When the code resolves to
    the primary vendor, its link is primary; when it resolves elsewhere, that link
    is non-primary (AC-3). No delete risk (create path is upsert-only).
  - For an **UPDATE** op, the full existing link set is resent with only the target
    `orderCode` changed → db.ts's reconcile deletes NOTHING (submitted set ==
    existing set + maybe one) and zeroes NOTHING (each link resent with its real
    cost). **The trap is closed.**
  - **Blank cell (AC-4):** an op with no `orderCode` does NOT build a `vendors[]`
    payload at all → `updateItem`/`addItem` is called WITHOUT the `vendors` key →
    db.ts leaves the link set (and existing codes) **untouched** (omit-key-to-skip
    semantics, `db.ts:474` "Omitting the key leaves the link set untouched"). A
    blank cell can neither write nor clear a code. Confirmed safe.
  - **Idempotency backstop:** the `(item_id, vendor_id)` composite unique +
    `onConflict: 'item_id,vendor_id'` (db.ts `:375`/`:506`) makes a re-run a no-op.
- **Interaction with the existing item create/update:** a row may BOTH change item
  fields (name/cost/par) AND carry a code. The existing `create`/`update`/`skip`
  classification is unchanged; the `orderCode` merge is layered onto whichever op
  the row produces. Important edge: a row that is classified **`skip: 'no changes'`
  (`computeDiff:197`) but carries a NEW code** must NOT be dropped — the code is a
  change even if no item field changed. **Design rule:** in `computeDiff`, a row
  with a resolvable code whose `orderCode` differs from the existing link's
  `orderCode` is promoted from `skip('no changes')` to an `update` op (with an empty
  item-field `payload` but a populated `orderCode`). `commitImport` then calls
  `updateItem(id, { vendors: <merged> })` with no item-field changes. (If the code
  equals the existing link's code, it stays `skip('no changes')` — a true no-op.)

**Request/response shapes (W-1 result — AC-5/6):** `CommitResult` gains three
fields:
```
export interface CommitResult {
  created: number;
  updated: number;
  archived: number;
  archiveSkipped: number;
  codesWritten: number;   // ops whose non-empty code landed on a link (create or update)
  linksCreated: number;   // ops that appended a NEW non-primary item_vendors link
  codeRowsSkipped: Array<{ item: string; reason: 'unmatched_vendor'; vendorName: string }
                        | { item: string; reason: 'no_vendor' }>;  // AC-6 reasoned skips
}
```
- `codesWritten` counts every op where a resolved `orderCode` was merged (whether
  onto an existing link or a newly appended one). `linksCreated` counts the subset
  that appended a link (`!existingLinks.some(vendorId===resolved)`). `codeRowsSkipped`
  is the reasoned list (AC-6) for rows that had a non-empty code but no resolvable
  vendor. The existing `created/updated/archiveSkipped` are unchanged.
- `RunImportModal.onRun` (`:59-63`) reads the three new fields and extends the
  success toast + (per AC-6, "where the existing diff surfaces per-row reasons")
  the op-breakdown/skip surface. Suggested toast tail:
  `… · N codes written` + (`linksCreated>0` ? ` · ${linksCreated} links created` : '')
  + (`codeRowsSkipped.length>0` ? ` · ${codeRowsSkipped.length} codes skipped` : '').
  The skipped reasons render in the existing skip-sample row (`RunImportModal:52-53`
  already shows skip reasons) — feed `codeRowsSkipped` reasons into that surface.

### 4. Edge function changes

**None.** No function is new or modified. No `verify_jwt` change. No service-token
surface. (Confirmed: 115 is PostgREST-only.)

### 5. `src/lib/db.ts` surface

**W-2 threading (the only db.ts change — additive, three functions).** snake_case
`order_unit` ↔ camelCase `orderUnit`.

- **`Vendor` type (`src/types/index.ts:455`, after `eodDeadlineTime?`):**
  ```
  /** Spec 115 (W-2) — the vendor's quick-order counting unit. 'case' (default)
   *  → the quick-order builder divides counted units by case_qty and rounds UP to
   *  whole cases; 'unit' → counted units verbatim. Brand-level. */
  orderUnit: 'case' | 'unit';
  ```
  NOT optional — the column is `NOT NULL DEFAULT 'case'`, so every fetched vendor
  has it; making it non-optional lets the builder treat it as always-present and
  keeps the segmented control's value type total.
- **`fetchVendors` mapper (`db.ts:1794-1802`):** add
  `orderUnit: v.order_unit ?? 'case'` (the `?? 'case'` guards a null defensively —
  e.g. a row read before the migration applied in a mixed window — and matches the
  DB default).
- **`createVendor` INSERT (`db.ts:1809-1816`):** add `order_unit: vendor.orderUnit
  ?? 'case'` to the insert object. (Unconditional, not spread-guarded like the
  optional times — it's NOT NULL with a value always in hand.)
- **`updateVendor` `dbUpdates` (`db.ts:2929-2937`):** add
  `if (updates.orderUnit !== undefined) dbUpdates.order_unit = updates.orderUnit;`
  — omit-key-to-skip, consistent with the other fields. (Does NOT touch the
  pre-existing deliveryDays/categories drop noted in §0; that stays as-is for a
  future spec.)
- **W-1 needs NO db.ts change** — it rides the existing `updateInventoryItem` /
  `createInventoryItem` `vendors?` payload (already carries `orderCode?: string`,
  `db.ts:373`/`:504`, `:193`/`:200` in the store). Confirmed feasible per OQ-1.

**Frontend `VendorFormDrawer` threading (`src/components/cmd/VendorFormDrawer.tsx`,
frontend-owned):** `FormValues` gains `orderUnit: 'case' | 'unit'`; `blank()` →
`orderUnit: 'case'`; `fromVendor()` → `orderUnit: v.orderUnit ?? 'case'`;
`toUpdates()` → `orderUnit: v.orderUnit`. Add a segmented control (Cases / Counted
units) to the drawer body (AC-10); reuse the drawer's existing `Field`-row visual
idiom or a two-button segment. `addVendor`/`updateVendor` in the store already
spread `toUpdates()`, so the value flows to db.ts unchanged.

### 6. The extended `poQuickOrderText` builder (W-2 conversion — the correctness surface)

**One builder, shared byte-for-byte by BOTH the PO path (existing) and the Reorder
card (W-3). Do NOT fork a second builder** (spec flag). Extend
`src/utils/poQuickOrderText.ts`:

- **`PoQuickOrderLine` gains `caseQty`** (units-per-case; `1` when no case):
  ```
  export interface PoQuickOrderLine {
    itemId: string;
    itemName: string;
    orderedQty: number;
    caseQty: number;   // NEW — PoLine.caseQty (db.ts:1422) | ReorderItem.caseQty (types:816)
  }
  ```
  Both callers already have `caseQty` in memory (PO: `PoLine.caseQty`; Reorder:
  `ReorderItem.caseQty`), so this is a pure add to the mapped line, no new fetch.
- **New parameter `orderUnit: 'case' | 'unit'`** (the PO/card vendor's unit; the
  caller resolves it from the selected vendor's `orderUnit`). Placed as a 4th
  positional param after `resolveName` to keep the existing call order stable:
  ```
  export function buildPoQuickOrderText(
    lines: PoQuickOrderLine[],
    resolveCode: CodeResolver,
    resolveName: NameResolver,
    orderUnit: 'case' | 'unit',        // NEW
  ): PoQuickOrderResult
  ```
- **`PoQuickOrderResult` gains `roundedCount`** (OQ-6 fail-loud mechanism, sibling
  to `unmappedCount`):
  ```
  export interface PoQuickOrderResult {
    text: string;
    unmappedCount: number;
    roundedCount: number;   // NEW — how many 'case' lines were rounded UP from a fraction
  }
  ```
- **Conversion logic (AC-11 / AC-12), applied per line to compute the emitted qty:**
  ```
  let emitQty: number;
  if (orderUnit === 'case') {
    const cq = line.caseQty && line.caseQty > 0 ? line.caseQty : 1;  // coalesce(caseQty,1); never /0
    const exact = line.orderedQty / cq;
    emitQty = Math.ceil(exact);
    if (emitQty !== exact) roundedCount += 1;   // fractional → rounded up → counted
  } else {
    emitQty = line.orderedQty;                   // 'unit' → verbatim (spec 114 behavior)
  }
  const qty = formatQty(emitQty);                // SAME formatQty; still no $; still TAB delim
  ```
  - `caseQty` null/`0`/`1` → divide by `1` → cases == units, `emitQty === exact` →
    NO rounding (AC-14: caseQty null → ÷1, roundedCount unaffected).
  - `orderUnit==='unit'` → `roundedCount` stays 0 for that line (AC-14).
  - The rounding test is `emitQty !== exact` (i.e. `orderedQty % cq !== 0`), which
    correctly counts ONLY lines that actually rounded up.
- **OQ-6 mechanism ruling — NO inline sentinel in the block.** The block stays
  bare `<code>\t<emitQty>` (mapped) / `??? <name>\t<emitQty>` (unmapped),
  machine-pasteable, byte-for-byte as today except the qty is now case-converted.
  There is **no `(rounded from X.Y)` suffix**, no per-line marker — the fail-loud
  signal is EXCLUSIVELY the returned `roundedCount`, surfaced by the caller as a
  summary count toast (AC-12). This keeps the block clean for paste (the PM's pin)
  while making the rounding un-ignorable at the UI level. `unmappedCount` semantics
  are unchanged (the `???` lines still surface, still counted).
- **Purity preserved:** still no React/theme/supabase/i18n import; `orderUnit` is
  injected by the caller (the caller reads the vendor's `orderUnit` from the
  `vendors` slice / the selected PO vendor). Byte-for-byte jest coverage (AC-14).

**Caller changes:**
- **PO path (`POsSection.onShareQuickOrder`, `:256-289`):** map `poLines` to include
  `caseQty: l.caseQty`; resolve the PO vendor's `orderUnit` (the PO row already has
  `sel.vendorId`; look it up in the `vendors` slice → `.orderUnit ?? 'case'`); pass
  it as the 4th arg. Add the `roundedCount` warning toast next to the existing
  `unmappedCount` one (fire when `roundedCount > 0`), and the AC-13 unit-in-play
  note on the preview (see §8 i18n).
- **Reorder path (W-3, new — `ReorderSection`):** §9.

### 7. Realtime impact

- **W-2 (`vendors.order_unit`):** replays on **`brand-{id}`** (the `vendors`
  subscription, `useRealtimeSync.ts:68`). Since `public.vendors` is ALREADY in
  `supabase_realtime` (§0, OQ-3), an `order_unit` edit reaches other admin clients
  live with **zero wiring change** and **NO publication migration**. **The
  `docker restart supabase_realtime_imr-inventory` gotcha DOES NOT APPLY** (no
  publication membership change — same deliberate absence as spec-114's order_code
  migration). Flag in the W-2 migration header exactly like the spec-114 header did:
  "ADDS A COLUMN to an already-published table → restart step does NOT apply."
- **W-1 (`item_vendors.order_code` writes):** replay on **`store-{id}`** (the
  `item_vendors` subscription, `useRealtimeSync.ts:46`, published since
  `20260630000000`). Unchanged from spec 114. No publication work, no restart.
- **Net:** **no realtime publication change in this spec.** The deploy checklist
  carries NO docker-restart step and NO prod publication apply. State this
  affirmatively so the checklist is neither padded nor missing a step.

### 8. Frontend store impact

- **`useStore.ts` vendor slice (`addVendor`/`updateVendor`):** thread `orderUnit`
  through the `Omit<Vendor,'id'>` create payload and the `Partial<Vendor>` update —
  the store actions already spread the drawer's `toUpdates()`; the optimistic
  vendor row should carry `orderUnit` so the drawer reflects it before the reload.
  Optimistic-then-revert with `notifyBackendError` applies (a `23514`/`42501` on
  save reverts the optimistic `orderUnit`). Same pattern as the existing vendor
  fields — no new slice, no new action.
- **`useStore.ts` item slice:** **no change for W-1** — `addItem`/`updateItem`
  already accept the `vendors?: [{vendorId, costPerUnit?, casePrice?, orderCode?}]`
  payload (`:193`/`:200`). The CSV commit merges onto it (§3). The optimistic link
  synthesis (`:1259-1281`, `:1327-1339`) already carries `orderCode` through
  (spec 114). No store edit needed.
- **W-5 missing-code count — SEPARATE memo required (do NOT reuse `catalog`).**
  The existing `catalog` memo (`VendorsSection.tsx:85-87`) filters on the SCALAR
  `i.vendorId === sel.id` (primary pointer only). AC-19's population is items
  **linked** to the vendor via `item.vendors[]` — a SUPERSET that includes
  non-primary links. Reusing `catalog` would UNDER-count (miss items where this
  vendor is a secondary link). **Design rule:** add a sibling memo:
  ```
  const missingCodeCount = React.useMemo(() => {
    if (!sel) return 0;
    return inventory.filter((i) =>
      i.storeId === currentStore.id &&
      (i.vendors ?? []).some((v) => v.vendorId === sel.id && !(v.orderCode ?? '').trim())
    ).length;
  }, [inventory, sel, currentStore.id]);
  ```
  Confirmed the `inventory` slice carries what's needed: `VendorsSection` already
  reads `useStore((s)=>s.inventory)` (`:29`) and each row's `vendors[]` carries
  `vendorId` + `orderCode` (hydrated by `mapItem`, spec 114). Render as a 5th
  detail-pane stat (AC-19) next to the existing `catalog.length` stat
  (`:344`/`:363`), e.g. a `StatCard` "N missing codes". This is the ONLY new
  missing-code surface (no list-pane badge). Note the count uses the `item.vendors[]`
  link set while the neighboring "catalog" stat uses the scalar `vendorId` — that's
  intentional and they can legitimately differ; the missing-code stat is
  link-scoped by AC-19's definition.

### 9. W-3 wiring (Reorder-card quick-order export) — frontend

- **Surface:** in `ReorderSection.tsx`, add a "Quick-order list" export button in
  the `VendorCard` next to `<CreatePoButton vendor={vendor} />` (`:455`). Model it
  on `CreatePoButton` (same button idiom) but wire it to a share handler, not
  `createPoDraft`.
- **New imports ReorderSection currently LACKS (confirmed absent via grep):**
  `useStore((s)=>s.inventory)`, the `vendors` slice, `getLocalizedName`, the current
  `locale` (via the app's locale hook), `buildPoQuickOrderText`,
  `sharePurchaseOrder`, `useT`. The frontend dev adds these to build the closures.
- **Handler (mirrors `POsSection.onShareQuickOrder` `:256-289` verbatim in
  structure, MINUS the mark-sent posture — AC-17 pre-PO, no status change):**
  ```
  const onShareQuickOrder = async () => {
    const orderUnit = vendors.find(v => v.id === vendor.vendorId)?.orderUnit ?? 'case';
    const resolveCode = (itemId) =>
      inventory.find(i => i.id === itemId)?.vendors?.find(v => v.vendorId === vendor.vendorId)?.orderCode;
    const resolveName = (itemId, fallback) => {
      const row = inventory.find(i => i.id === itemId);
      return row ? getLocalizedName({ name: row.name, i18nNames: row.i18nNames }, locale) : fallback;
    };
    const { text, unmappedCount, roundedCount } = buildPoQuickOrderText(
      vendor.items.map(it => ({
        itemId: it.itemId, itemName: it.itemName,
        orderedQty: it.suggestedUnits,     // AC-16 — server-authoritative ordered base-unit total
        caseQty: it.caseQty,               // AC-16 — ReorderItem.caseQty, SAME conversion as PO
      })),
      resolveCode, resolveName, orderUnit,
    );
    const { previewText } = await sharePurchaseOrder(text, { dialogTitle: T(...), onCopyToast: () => Toast.show(...) });
    // preview pane (desktop-web) + unmapped + rounded warnings; NO mark-sent (pre-PO).
    if (unmappedCount > 0) Toast.show({ type:'error', text1: T('…quickOrderUnmappedWarning', { count: unmappedCount }) });
    if (roundedCount > 0)  Toast.show({ type:'error', text1: T('…quickOrderRoundedWarning',  { count: roundedCount  }) });
  };
  ```
- **AC-16 code source:** the code resolves from the hydrated `inventory` rows'
  `vendors[].orderCode` (NOT from `ReorderItem`, which carries no code) — identical
  to the PO path. `orderedQty = ReorderItem.suggestedUnits` (base-unit total); the
  W-2 `ceil(orderedQty / coalesce(caseQty,1))` conversion applies identically via
  the shared builder (AC-16).
- **AC-17 posture:** NO PO exists, so NO mark-sent prompt, NO `sharePurchaseOrder`
  `shared`-gated status flip — it is purely a copy/paste aid. Same `???` unmapped +
  unmapped-count + rounded-count warnings as the PO path.
- **Preview pane:** ReorderSection needs a `sharePreview` state + a preview surface
  (desktop-web clipboard branch returns `previewText`) analogous to POsSection's
  `setSharePreview`. Small local state add.

### W-4 (stub removal) — frontend, no backend surface

- Delete `IngredientForm.tsx`: the `vendorSku` field on `IngredientFormValues`
  (`:43`), its `blankValues` entry (`:86`), and the `InputLine` render (`:1283`).
- Update the grey-fields helper text (`:1304-1308`) to drop the "vendor sku"
  mention.
- The per-vendor order-code field (`:1261-1268`, spec 114) is UNTOUCHED — it stays
  the only place codes live.
- Remove any dangling `values.vendorSku` reference (e.g. in
  `IngredientFormDrawer.tsx` hydrate/save if present) so the build stays green.
- **KEEP** the `csvImport.ts` `vendor_sku` header alias (`:27`/`:42`) — W-1 makes
  it the REAL write path. A jest/type check confirms no `vendorSku` remains on the
  form values type (AC-18).

### i18n (AC-20) — new admin-surface keys ×3 (en / es / zh-CN)

Add under existing sections, reusing spec-114 keys where the string already fits:
- `section.vendors.orderUnitLabel`, `section.vendors.orderUnitCase` ("Cases"),
  `section.vendors.orderUnitUnit` ("Counted units") — the drawer control (W-2).
- `section.vendors.missingCodes` / `section.vendors.missingCodesLabel` — the W-5
  stat (label + count-formatted string).
- `section.purchaseOrders.quickOrderRoundedWarning` (`"{count} items rounded up to
  whole cases"`) — the AC-12 rounded-count toast (used by BOTH the PO and Reorder
  paths).
- `section.purchaseOrders.quickOrderCountingInCases` / `…quickOrderCountingInUnits`
  — the AC-13 unit-in-play preview note.
- Reorder-card export: **reuse** `section.purchaseOrders.quickOrderAction`
  (`en.json:709`, "QUICK-ORDER LIST") + `…quickOrderDialogTitle` /
  `…quickOrderCopiedToast` / `…quickOrderUnmappedWarning` (`:710-712`) — same
  strings apply on the Reorder card. If a distinct label reads better on the card,
  add `section.reorder.quickOrderLabel` alongside, but prefer reuse.
- W-1 import report: add `section.imports.*` (or the existing imports-section
  namespace) keys for "N codes written / N links created / N codes skipped" and the
  skip reasons (`unmatched vendor "<name>"`, `no vendor`). The pasted BLOCK stays
  machine-facing / NOT localized (spec 114 OQ-8).
- No user-visible hardcoded English on the admin surface (AC-20).

### 10. Risks and tradeoffs (explicit)

- **[CRITICAL, closed by design] W-1 reconcile-delete data loss.** Documented in
  §0/§3. If a developer takes the spec's literal OQ-1 wording ("thread
  `{vendorId,orderCode}` into the `vendors?` payload") and sends a code-only array
  for an existing item, `updateInventoryItem` deletes the item's other vendor links
  and zeroes the resolved link's cost. **The merge-onto-existing-links rule (§3) is
  mandatory, not optional.** This is the #1 post-impl backend-architect drift check
  for W-1: verify `commitImport` resends the FULL existing link set with only the
  target `orderCode` changed, and that a blank cell sends NO `vendors` key.
- **[Correctness, the R-2 raison d'être] The `ceil(orderedQty /
  coalesce(caseQty,1))` conversion.** A wrong-order regression lives here (dividing
  by 0/null, truncating instead of ceiling, or applying the division on a `'unit'`
  vendor). Byte-for-byte jest (AC-14) is the guard; it is the #1 post-impl drift
  check for the builder-signature change. The 4th-positional-param change is a
  breaking signature change to a pure function with existing callers — the PO caller
  MUST be updated in the same PR or it won't typecheck (this is a feature: the
  compiler forces the PO path to pass `orderUnit`).
- **[Skip-vs-drop] The `skip('no changes')`-with-a-new-code promotion (§3).** If the
  developer forgets to promote a row that has no item-field change but a new code,
  the code silently won't write (the op is dropped as a no-op). Jest must cover "an
  item whose only change is a new code writes the code" (extends AC-7). Flagged for
  test-engineer.
- **[Stale-doc honesty] OQ-4.** The pgTAP UPDATE extension is REQUIRED to make the
  stale `20260517010000` comment honest (§0/§7). Do NOT skip it on the grounds that
  "no policy changed" — the whole point is proving the pre-existing gate denies a
  non-privileged `order_unit` flip.
- **[Migration ordering] `20260709000000` sorts after `20260708000000`.** Clean —
  no dependency on any concurrent migration, additive column only. Prod apply is
  column-only via the Supabase MCP; no publication, no policy.
- **[Performance on the 286 KB seed / 564-link set] Negligible.** `order_unit` is
  a constant-default add (metadata-only, no rewrite). W-1's merge reads the item's
  existing links from the already-hydrated `inventory` slice (in-memory, no extra
  query). The W-5 memo is a single in-memory filter over `inventory` (same cost as
  the existing `catalog` memo). No N+1, no new round-trips. The CSV commit's
  per-row `updateItem` calls are the SAME volume as today (the code merge adds no
  extra calls — it rides the existing per-op `updateItem`).
- **[Edge function cold-start] N/A** — no edge function touched.
- **[Realtime] No publication change → no re-snapshot risk, no docker-restart, no
  prod publication apply.** (See §0/§7 — the spec's OQ-3 premise was false.)
- **[Cross-brand INSERT gap + updateVendor partial-write] pre-existing, surfaced,
  NOT fixed here** (§0). Neither blocks 115.

### 11. Prod-apply verification (user-gated — enumerate per piece)

The developer FLAGS the prod apply in the handoff and does NOT push it. Applied via
the Supabase MCP (`db push` lacks the prod password — project memory).
- **W-2 column (the ONLY DDL):**
  1. `execute_sql` the `alter table … add column` + the `comment on column`.
  2. INSERT version `'20260709000000'` into
     `supabase_migrations.schema_migrations` so `db-migrations-applied.yml`
     (spec 064) goes back green.
  3. VERIFY by COLUMN PRESENCE (not a body-md5 — no function here):
     `select 1 from information_schema.columns where table_schema='public' and
     table_name='vendors' and column_name='order_unit';` and confirm
     `column_default = '''case'''::text` and `is_nullable='NO'`.
- **Publication:** NONE (OQ-3 — already published). No prod publication step.
- **Policy:** NONE (OQ-4 — already gated). No prod policy step.
- **W-1 / W-3 / W-4 / W-5:** NO migration, NO prod DDL (W-1 writes to the existing
  `item_vendors.order_code` column shipped by spec 114). Code-only deploy.
- `db-migrations-applied.yml` goes red between merge and the prod apply of the ONE
  column migration (expected; resolves when the `schema_migrations` row lands).

### 12. Test plan (per workstream)

- **pgTAP:**
  - **W-2 column (AC-8) — new file
    `supabase/tests/vendor_order_unit.test.sql`:** assert the column exists, is
    `NOT NULL DEFAULT 'case'`, rejects a value outside `{case,unit}` (a
    `check_violation`/`23514` via `throws_ok`), and that an existing seed vendor
    reads `'case'`.
  - **OQ-4 RLS (AC-9) — EXTEND `supabase/tests/vendors_role_access.test.sql`** (bump
    `plan(4)` → `plan(7)`): (5) an admin/master (`auth_is_privileged`) CAN UPDATE a
    seed vendor's `order_unit` (`lives_ok`, brand-visible); (6) a non-privileged
    `user` CANNOT — the UPDATE is denied (an RLS-blocked UPDATE affects 0 rows;
    assert via `results_eq`/`is` that the `order_unit` value is UNCHANGED after the
    attempted update under the user JWT, OR use `throws_ok` if the policy path
    raises — `privileged_update_vendors` USING-clause failure yields a 0-row update,
    not a raise, so the value-unchanged assertion is the correct shape here); (7)
    regression — the value the non-privileged caller tried to write did NOT land.
    This makes the stale 20260517 comment honest.
  - **spec-053 permissive-policy-lint:** runs automatically; stays green (no policy
    added). No allowlist edit. State this in the PR.
  - **No new `item_vendors` pgTAP for W-1** — the column + its RLS were proven in
    spec 114's `item_vendors_rls.test.sql`; W-1 adds no schema/RLS.
- **jest:**
  - **W-2 builder (AC-14) — extend `poQuickOrderText` test byte-for-byte:**
    `orderUnit='case'`, `caseQty=24`, `orderedQty=48` → emits `2`, `roundedCount=0`;
    `orderedQty=30` → emits `2`, `roundedCount=1`; `caseQty=null|1` → ÷1 (units ==
    cases), `roundedCount=0`; `orderUnit='unit'` → verbatim counted value,
    `roundedCount=0`; still NO `$` anywhere; `???` unmapped lines still surface with
    correct `unmappedCount`; TAB delimiter unchanged.
  - **W-1 csvImport (AC-7) — extend/author csvImport test:** matched `vendor_name`
    writes the code to that vendor's link; blank `vendor_name` writes to the item's
    primary link; unmatched `vendor_name` + no primary → skipped AND counted in
    `codeRowsSkipped` with reason; blank `vendor_sku` cell is a no-op (does NOT
    clear an existing code); an existing item whose ONLY change is a new code is NOT
    dropped (promoted to update, `codesWritten` increments); the RECONCILE-SAFETY
    case — an existing item with links {A(cost 5), B(cost 7)} that gets a code for A
    keeps B's link AND A's cost 5 (proves the §3 merge, not a code-only array); the
    three result counts correct for a mixed batch.
  - **W-4 (AC-18) — type/reference check:** no `vendorSku` field remains on
    `IngredientFormValues`; no dangling `values.vendorSku` reference.
- **shell smoke:** none anticipated.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec (## Backend design). Split:
  BACKEND-DEVELOPER owns — the W-2 migration
  `supabase/migrations/20260709000000_vendor_order_unit.sql` (additive
  `order_unit text NOT NULL DEFAULT 'case' CHECK (order_unit IN ('case','unit'))`,
  NO policy hunk, NO publication hunk — §1/§2/§7; header must note the docker-
  restart step does NOT apply per the spec-114 pattern, and FLAG the prod apply,
  do not push it); the db.ts W-2 threading (fetchVendors/createVendor/updateVendor
  `orderUnit`, §5); the extended `poQuickOrderText` builder (add `caseQty` to the
  line, add the `orderUnit` 4th param + `roundedCount` return, the
  `ceil(orderedQty/coalesce(caseQty,1))` conversion — §6, THE correctness surface);
  the W-1 csvImport write-mapping — vendor resolution (§3 resolveVendorForCode),
  the RECONCILE-SAFE merge (§0/§3 — resend the FULL existing link set with only the
  target orderCode changed; a code-only `vendors[]` array WILL delete other links
  and zero costs — this is mandatory), the CommitResult codesWritten/linksCreated/
  codeRowsSkipped, the `skip('no changes')`-with-new-code promotion; the pgTAP
  (new `vendor_order_unit.test.sql` for AC-8 + EXTEND `vendors_role_access.test.sql`
  with UPDATE cases proving privileged-allowed / non-privileged-denied on
  order_unit — §12) and the jest for the builder + csvImport.
  FRONTEND-DEVELOPER owns — the VendorFormDrawer order-unit segmented control
  (§5); the store vendor-slice orderUnit threading + optimistic (§8); the PO caller
  update (pass caseQty + resolved orderUnit + the roundedCount warning + the
  unit-in-play note — §6/§8); the W-3 Reorder-card export button + handler (§9,
  new inventory/vendors/locale imports, pre-PO no-mark-sent, roundedCount warning);
  W-4 stub removal in IngredientForm (§W-4); the W-5 missing-code SEPARATE memo +
  detail-pane stat (§8 — do NOT reuse the `catalog` scalar-vendorId memo, it
  under-counts; key on item.vendors[]); the RunImportModal report toast/skip
  surface (§3); i18n ×3 for all new keys (AC-20). After implementation set
  Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/115-quick-order-usability.md

---

## Files changed (backend — spec 115 W-2 + pgTAP)

Backend-developer slice. The narrowed backend lane for THIS pass was
`supabase/` + `src/lib/db.ts` + `src/types/index.ts` (+ `src/store/useStore.ts`
only if a type change forced it — it did not; see note). W-2 backend threading,
the migration, and the pgTAP landed here. Two W-1/W-2 items the design assigned
to "backend-developer" fall OUTSIDE this narrowed lane and are flagged for a
separate landing (see the Handoff notes below): the `src/lib/csvImport.ts` W-1
merge logic, and `src/utils/poQuickOrderText.ts` (both currently owned/in-flight
by the frontend-developer per the working tree).

### migrations
- `supabase/migrations/20260709000000_vendor_order_unit.sql` — NEW. Additive
  `order_unit text NOT NULL DEFAULT 'case' CHECK (order_unit in ('case','unit'))`
  on `public.vendors` + `comment on column`. NO policy hunk (inherits
  `privileged_update_vendors` UPDATE / `brand_member_read_vendors` SELECT —
  cite `20260509000000_multi_brand_schema_rls.sql:575,586`; the header records
  that the `20260517010000` "UPDATE is denied" comment is STALE). NO publication
  hunk (`public.vendors` already in `supabase_realtime` since
  `20260514140000_realtime_publication_tighten.sql:52`) → the docker-restart
  gotcha does NOT apply. Metadata-only / instant on PG17 (constant default, no
  rewrite). Prod-apply note embedded (execute_sql + `schema_migrations` insert
  '20260709000000' + column-presence verify). **Applied LOCALLY only; NOT pushed
  to prod — FLAGGED for user-gated prod apply.**

### src/lib/db.ts
- `fetchVendors` mapper — thread `orderUnit: v.order_unit ?? 'case'` (:1805).
- `createVendor` INSERT — add `order_unit: vendor.orderUnit ?? 'case'`
  (unconditional; NOT NULL with a value always in hand) (:1823).
- `updateVendor` `dbUpdates` — add
  `if (updates.orderUnit !== undefined) dbUpdates.order_unit = updates.orderUnit;`
  (omit-key-to-skip) (:2949). Pre-existing deliveryDays/categories partial-write
  drop noted in design §0 left untouched.

### src/types/index.ts
- `Vendor` — add non-optional `orderUnit: 'case' | 'unit'` after
  `eodDeadlineTime?`. Non-optional because the DB column is NOT NULL DEFAULT
  'case'. Confirmed this does NOT force a `src/store/useStore.ts` change:
  `addVendor`/`updateVendor` bodies only spread the incoming payload
  (`...vendor` / `...updates`) — no from-scratch `Vendor` literal — so the
  action signatures widen transparently and the supply obligation falls on the
  frontend `VendorFormDrawer` caller (frontend lane).

### supabase/tests
- `supabase/tests/vendors_role_access.test.sql` — EXTENDED `plan(4)` → `plan(11)`.
  Seeds a dedicated test vendor `99999999-…-9944` (as the superuser default role,
  RLS-free) as a stable UPDATE target. New cases: (5a/5b/5c) `order_unit` column
  default `'case'::text` + `NOT NULL` + a row reads `'case'` from the DEFAULT
  (AC-8); (6) the CHECK rejects `'pallet'` with `23514` (run as superuser so RLS
  doesn't mask the CHECK); (7a/7b) an admin (privileged, brand-visible) CAN
  UPDATE `order_unit` and it persists (proves the column inherits
  `privileged_update_vendors`); (8) a non-privileged `user` CANNOT — the RLS
  USING clause filters the row → 0-row update → value-UNCHANGED assertion
  (`UPDATE 0` confirmed at runtime), which makes the stale `20260517010000`
  comment honest.

### Verification (this slice)
- Migration applied locally via `docker exec … psql`; `information_schema` +
  `pg_constraint` confirm `order_unit` is `text NOT NULL DEFAULT 'case'::text`
  with `vendors_order_unit_check`.
- `bash scripts/test-db.sh`: **64/64 DB test files pass**;
  `vendors_role_access.test.sql` = 11 assertions passing.
- `tsc --noEmit` and `tsc -p tsconfig.test.json --noEmit`: **zero errors from
  this slice.** Both configs report exactly ONE error —
  `src/screens/cmd/sections/POsSection.tsx(270,37): Expected 4 arguments, but
  got 3` — which is the FRONTEND-DEVELOPER'S in-flight lag: they already
  extended `src/utils/poQuickOrderText.ts` to the 4-arg (`orderUnit`) signature
  but have not yet updated the PO caller. NOT this slice's file; left untouched
  per the parallel-work instruction.
- `npx jest`: **93 suites / 1071 tests, all passing.**

### Explicitly NOT touched (design-assigned but outside this narrowed lane — FLAGGED)
- `src/lib/csvImport.ts` — the W-1 vendor-resolution + RECONCILE-SAFE merge
  (design §0/§3: resend the FULL existing `vendors[]` link set with only the
  target `orderCode` changed; a code-only array WOULD delete other links + zero
  costs) + the `CommitResult` `codesWritten`/`linksCreated`/`codeRowsSkipped` +
  the `skip('no changes')`-with-new-code promotion + its jest. On the **db.ts
  side, W-1 required NO change and none was made** (design §5): the existing
  `updateInventoryItem`/`createInventoryItem` `vendors?` payload ALREADY carries
  `orderCode?: string` (db.ts:373/:504) and the FULL-RECONCILE semantics are
  exactly what the merge rule feeds — `updateInventoryItem`'s reconcile semantics
  were left unchanged as instructed. The `csvImport.ts` module edit itself was
  NOT in this pass's owned-paths list (`supabase/` + `db.ts` + `types`) and the
  task said not to touch csvImport UI wiring, so that module-level merge slice
  needs a separate landing.
- `src/utils/poQuickOrderText.ts` — the builder signature/return extension is
  already in the working tree from the frontend-developer; NOT re-touched here.

---

## Files changed (frontend — spec 115 W-1 / W-2 / W-3 / W-4 / W-5 + i18n + jest)

Frontend-developer slice. Owned paths: `csvImport.ts` + `RunImportModal` +
`POSImportsSection` (W-1), `poQuickOrderText.ts` + `VendorFormDrawer` +
`POsSection` (W-2), `ReorderSection` (W-3), `IngredientForm` + `JsonPreview`
(W-4), `VendorsSection` (W-5), the i18n catalogs, and the matching jest. Did NOT
touch `supabase/`, `src/lib/db.ts`, `src/types/index.ts` (backend-developer's
lane — their `Vendor.orderUnit` + db threading + migration landed in parallel and
are consumed here). Both tsc configs exit 0; full `npx jest` = 95 suites / 1096
tests green.

### W-1 — Bulk order-code CSV import (RECONCILE-SAFE)
- `src/lib/csvImport.ts` — WRITE path for the parsed `vendor_sku` column.
  - `DiffOp` gains `orderCode?` (trimmed non-empty `vendor_sku`; ABSENT on a
    blank cell — AC-4) + `vendorNameRaw?`; new `BrandVendorLite`,
    `CodeVendorResolution`.
  - NEW exported pure helpers: `resolveVendorForCode` (AC-2 rule: matched
    `vendor_name` → that vendor; blank → primary link; unmatched/no-primary →
    reasoned skip, never a guessed write, never creates a vendor) and
    `buildOrderCodeVendorsPayload` (the §0/§3 **RECONCILE-SAFE merge** — resend
    the FULL existing link set with all costs, overwrite ONLY the target
    `orderCode`, append a non-primary link when the vendor isn't linked yet).
  - `mapRowFields`/`rowToOrderCodeFields` extract the code fields off a row.
  - `computeDiff` takes a `brandVendors` param (default `[]`), attaches the code
    fields to create/update ops, and PROMOTES a `skip('no changes')` row that
    carries a NEW resolvable code to an `update` (§3 — a code is a change).
  - `CommitContext` gains `brandVendors` + `inventory` and widens `updateItem`
    to accept the `vendors?` merge payload; `CommitResult` gains `codesWritten`
    / `linksCreated` / `codeRowsSkipped` (AC-5/AC-6). `commitImport` omits the
    `vendors` key entirely for a blank cell (AC-4 no-op) and reports
    unresolvable codes.
  - **On `db.ts`: NO change** — rides the existing `addItem`/`updateItem`
    `vendors?` payload (design §5).
- `src/components/cmd/RunImportModal.tsx` — passes `brandVendors` + `inventory`
  into `commitImport`; appends localized `codesWritten`/`linksCreated`/
  `codesSkipped` to the success toast; adds a pre-commit "codes" preview row
  (resolves via the shared `resolveVendorForCode`) showing to-write + will-skip
  reasons (`testID="import-code-preview"`).
- `src/screens/cmd/sections/POSImportsSection.tsx` — reads the `vendors` slice;
  passes `vendors.map(v => ({id, name}))` to `computeDiff`.
- `src/lib/csvImport.test.ts` — NEW. The **CRITICAL reconcile-safety pin** (a
  CSV touching one vendor's code keeps the item's other links AND all costs),
  the append-link case, blank-cell no-op, matched/blank/unmatched resolution,
  the `skip`-with-new-code promotion, idempotent-equal no-op, mixed-batch counts.

### W-2 — Per-vendor order unit + builder conversion (THE correctness surface)
- `src/utils/poQuickOrderText.ts` — `PoQuickOrderLine` gains `caseQty`; new 4th
  positional param `orderUnit: 'case' | 'unit'`; `PoQuickOrderResult` gains
  `roundedCount`. `'case'` → `Math.ceil(orderedQty / coalesce(caseQty,1))` (never
  ÷0/null; count a fractional round-up into `roundedCount`); `'unit'` → verbatim.
  NO inline `(rounded from …)` sentinel — the block stays machine-pasteable; the
  fail-loud signal is `roundedCount` only. ONE shared builder for both callers.
- `src/utils/poQuickOrderText.test.ts` — EXTENDED byte-for-byte: exact division,
  fractional → ceil + `roundedCount`, `caseQty` null/0/1 → ÷1, `'unit'` verbatim
  + `roundedCount=0`, converted `???` line, mixed-batch count, still no `$`.
- `src/components/cmd/VendorFormDrawer.tsx` — `FormValues.orderUnit` +
  `blank()`/`fromVendor()`/`toUpdates()` threading; new `SegmentField` control
  (`Cases` / `Counted units`, default `Cases`) with `testID="vendor-order-unit-*"`.
- `src/components/cmd/VendorFormDrawer.test.tsx` — NEW render smoke: control
  renders both options, defaults to Cases, toggles, and threads `orderUnit`
  through `addVendor`/`updateVendor` (create + edit prefill).
- `src/screens/cmd/sections/POsSection.tsx` — `onShareQuickOrder` maps
  `caseQty`, resolves `selVendor.orderUnit ?? 'case'`, passes it 4th; fires the
  `roundedCount` warning toast alongside the unmapped one; renders the AC-13
  "counting in cases/units" note as a SEPARATE caption above the preview
  (`testID="po-share-unit-note"`), kept OUT of the pasteable text.

### W-3 — Reorder-card quick-order export (pre-PO)
- `src/screens/cmd/sections/ReorderSection.tsx` — new `ReorderQuickOrderButton`
  (next to `CreatePoButton`) reusing the SAME builder + `sharePurchaseOrder`,
  sourced from `ReorderItem.suggestedUnits` + `caseQty`, resolving codes from the
  hydrated `inventory` rows for the card's `vendorId`. Same unmapped + rounded
  toasts; NO mark-sent (AC-17). `VendorCard` owns the desktop-web preview block
  (rendered in-card below the footer, not an overlay) + the unit-in-play note.

### W-4 — Dead item-level `vendorSku` stub removed
- `src/components/cmd/IngredientForm.tsx` — removed the `vendorSku` field from
  `IngredientFormValues`, `blankValues`, and the read-only `InputLine` render;
  dropped "vendor sku" from the grey-fields helper text; updated the stale OQ-4
  comments. The spec-114 per-vendor order-code card is UNTOUCHED (the only place
  codes live). The `csvImport.ts` `vendor_sku` alias is KEPT (now the real path).
- `src/components/cmd/JsonPreview.tsx` — dropped the dead `values.vendorSku`
  `"sku"` line from the vendor preview block.
- `src/components/cmd/IngredientForm.test.ts` — added a W-4 pin: `blankValues()`
  has no `vendorSku` key.

### W-5 — Per-vendor missing-code stat
- `src/screens/cmd/sections/VendorsSection.tsx` — a SEPARATE `missingCodeCount`
  memo keyed on `item.vendors[]` LINKS (not the scalar `catalog` memo, which
  under-counts secondary links); rendered as a 5th detail-pane `StatCard`
  ("Missing codes", `testID="vendor-missing-codes"`).
- `src/components/cmd/StatCard.tsx` — added an optional `testID` prop (threaded
  to the root View) so the missing-codes stat is selectable.

### i18n (AC-20) — 16 new keys ×3 (en / es / zh-CN), parity verified
- `src/i18n/{en,es,zh-CN}.json`:
  - `section.vendors.orderUnitLabel` / `orderUnitHint` / `orderUnitCase` /
    `orderUnitUnit` (W-2 control); `missingCodes` / `missingCodesSub` (W-5).
  - `section.purchaseOrders.quickOrderRoundedWarning` (AC-12, shared by PO +
    Reorder); `quickOrderCountingInCases` / `quickOrderCountingInUnits` (AC-13).
  - `section.reorder.quickOrderAria` (W-3 button a11y label; the button LABEL
    reuses `section.purchaseOrders.quickOrderAction`).
  - `section.posImports.codesLabel` / `codesToWrite` / `codesWillSkip` /
    `codesWritten` / `linksCreated` / `codesSkipped` / `codeSkipUnmatched` /
    `codeSkipNoVendor` (W-1 report + preview).
  - The pasted BLOCK itself stays machine-facing / NOT localized (OQ-8).

### Verification (this slice)
- `tsc --noEmit` = 0; `tsc -p tsconfig.test.json --noEmit` = 0.
- `npx jest` = **95 suites / 1096 tests, all passing** (incl. the reconcile
  pin, builder conversion cases, CSV resolution rules, W-4 stub-gone, W-2
  order-unit render smoke).
- i18n key parity confirmed across en/es/zh-CN (1189 keys each; 16 new).
- Expo web bundle boots clean (no runtime/module errors); local DB has the
  `order_unit` column (`NOT NULL DEFAULT 'case'`), so the vendor-save path is live.
- **Interactive browser golden path NOT self-driven:** this session had no
  `preview_*` / Chrome-MCP tools and browsers are read-tier under computer-use
  (no click/type), so the CSV-import-of-codes, order-unit-flip-on-a-live-vendor,
  and PO/Reorder-export click-throughs were verified via render-smoke + the
  byte-for-byte builder/csv jest rather than manual clicks. **Main Claude should
  run the browser pass** (see the list in the handoff) to confirm the on-screen
  case-converted qtys + rounded/unmapped toasts + the missing-codes stat.
