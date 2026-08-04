# Code review for spec 151

Scope: the spec-151 surface only (`src/utils/lastOrderContext.ts` + its tests,
`src/lib/db.ts` fetcher/mapper + its test, `src/store/useStore.ts` slice + its
test, `src/screens/cmd/sections/ReorderSection.tsx` + its tests,
`src/screens/cmd/sections/phone/PhoneOrdering.tsx` + its tests, the three
i18n catalogs, `src/types/index.ts`, the migration
`20260803000000_report_last_order_context.sql`, and
`supabase/tests/report_last_order_context.test.sql`). Spec-150 files touched
in the same working tree were not reviewed here (already reviewed).

Overall: this is an unusually faithful implementation of its design. The
honesty rule (AC-10/R-10) is enforced at three independent layers (SQL —
`item_union` as a UNION, never an inner join; the `db.ts` mapper — explicit
`== null` checks with a comment banning `?? 0`; the pure formatter — the
`Pick<>` type that makes the forbidden fields unreachable), AC-14's single
insertion point is proven structurally by a `describe.each` test that runs
every phone assertion through both `PhoneOrdering` and `PhoneApproveOrder`,
`PhoneApproveOrder.tsx` is untouched (confirmed by grep), the RLS posture
(security invoker, no top-level privilege gate) is pinned by pgTAP including
the Z3/Z4 non-privileged-caller asymmetry, and i18n parity holds across all
three catalogs (9 keys each). No direct `supabase.from/rpc` call outside
`db.ts`, no inline color literals, no `Alert.alert`/`window.confirm`, no
web-only APIs, no legacy-file edits, no realtime/publication change, no new
RLS policy.

### Critical

None found.

### Should-fix

- `src/screens/cmd/sections/ReorderSection.tsx:777-976` (guard) and `:959-969`
  (the AC-9 line) — the desktop card-level **"NO PRIOR ORDER ON RECORD"**
  empty state is rendered inside the footer strip, which sits inside the
  `{!collapsed ? (<>…</>) : null}` block (line 777). Desktop vendor cards
  default to **collapsed** (`expandedKeys` starts as an empty `Set`, line
  1544, and every `VendorCard` gets `collapsed={!expandedKeys.has(k)}` —
  lines 1853/1880/1934), so on first paint this line is invisible for every
  vendor until the admin manually expands that specific card. Contrast with
  the phone tier, where the equivalent line
  (`src/screens/cmd/sections/phone/PhoneOrdering.tsx:311-322`) is placed in
  the **header block**, which is rendered unconditionally (the collapse
  guard on phone only hides the item-row body, starting at line 372) — so on
  phone the empty state is visible immediately, matching AC-9's rationale
  ("so the empty state is stated once, not repeated on every row" — implying
  a glanceable card-level fact, not something buried behind an expand tap).
  The test file itself is evidence this was noticed but not fixed:
  `ReorderSection.lastOrderContext.spec151.test.tsx:241-249` calls
  `expandAll(getAllByTestId)` **before** asserting the empty-state text is
  present — i.e., the suite was written to accommodate the gated visibility
  rather than to catch it. Recommend moving the desktop AC-9 line into the
  always-visible stats row (`ReorderSection.tsx:749-770`, alongside
  `next delivery` / `items` / `qty (base)` / `est cost`) so it renders
  regardless of collapse state, mirroring the phone placement and US-5's
  "desktop parity" story.

### Nits

- `src/screens/cmd/sections/ReorderSection.tsx:1468` — `const
  lastOrderContextVendorIds = useStore((s) => s.reorderPayload?.vendors);` is
  a second Zustand subscription reading a field already available through
  `reorderPayload` (subscribed at line 1379, same component scope). Could
  read `reorderPayload?.vendors` directly instead of adding a second
  selector for the same slice.
- (out-of-scope) `supabase/migrations/20260803000000_report_last_order_context.sql:201-208`
  — `sum(coalesce(pit.ordered_qty, 0))` on the PO branch would silently
  render "ORDERED 0" instead of surfacing a gap if a `po_items` row exists
  with a genuinely-NULL `ordered_qty` (the column has no `NOT NULL`
  constraint — `20260405000759_init_schema.sql:170`). This exactly mirrors
  the architect's design (§2.4) and every current write path
  (`createPurchaseOrderDraft`, `upsertVendorDraftOrder`, the line-edit RPC)
  always sets a numeric value, so the practical risk is low — flagging for
  the architect's awareness rather than as an implementation defect; a
  defensive pgTAP case (a `po_items` row with `ordered_qty = NULL`) would
  make the current behavior an explicit, tested claim instead of an
  assumption.
