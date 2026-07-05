# Spec 114: Per-vendor order codes + universal quick-order list export

Status: READY_FOR_REVIEW

> **Origin (owner ask, verbatim):** "integrate auto order from US Foods, Sysco,
> BJ's, Sam's Club, and Webstaurant." A verified deep-research pass (2026-07-05,
> 21 sources, memory file `project_vendor_ordering_integration.md`) established the
> hard reality below (cited in Background — **do not re-litigate**). The owner then
> ruled the binding scope for THIS increment: build the **universal quick-order
> list + per-vendor SKU/order-code mapping** — NOT vendor-specific file formats,
> NOT EDI, NOT browser automation. This spec is that ruling, in two slices:
>
> 1. **Per-vendor order-code mapping** (backend + admin UI): store the vendor's
>    order/SKU code PER (item, vendor) on a new nullable column of the existing
>    `public.item_vendors` join, entered/edited in the existing multi-vendor
>    editor's per-vendor card.
> 2. **Universal quick-order list export** (frontend): from an existing PO, generate
>    a paste-ready **item-code + quantity** block (NO prices) for the PO's vendor,
>    reusing the spec-108 share plumbing as a SECOND artifact alongside the existing
>    human-readable share text.

## Background (verified — cited, not re-litigated)

Per `project_vendor_ordering_integration.md` (2026-07-05, adversarially verified):
**none of the five named vendors exposes a public self-serve buyer ordering API.**

- **US Foods** — MOXē "Import Order" accepts an operator-uploaded order FILE
  (CSV / XML / EDI-850 layout) needing only **customer # + product # + qty**
  (description/pack/price ignored on upload). No signed agreement. It is a
  file-upload UI, not an API. (US Foods also runs a full X12 EDI loop — heavier,
  trading-partner onboarding + VAN/AS2 — out of scope.)
- **Sysco** — customer side is order-guide import/export in a proprietary FoodTrak
  **`.700`** format; whether a *completed* order can be uploaded back (vs only the
  guide downloaded) is UNCONFIRMED and needs a live account. Sysco's public EDI is
  supplier-facing only.
- **BJ's / Sam's Club / Webstaurant** — NO buyer-side programmatic ordering. BJ's
  EDI runs outbound to *its* suppliers; Sam's bulk POs are a manual email queue
  (one nuance: a Sam's "Reorder for Pickup using a List" page accepts an Excel
  list, pickup only); Webstaurant has only consumer Rapid/Auto Reorder.
- **Middleware** (xtraCHEF, reciProfity) is INBOUND-only (invoices, order guides) —
  none submits outbound POs, so none can serve as an ordering API.

**Consequence for this spec:** the only broadly-useful, ToS-safe, no-live-account
artifact that helps ALL five is a **paste-ready `<order code> + <qty>` block** an
operator drops into each vendor's web quick-order box — and that requires storing
the vendor's order code per (item, vendor) first. That mapping is ALSO the shared
prerequisite for any future vendor-specific file export (US Foods Import-Order,
Sysco upload-back), so it is the correct foundation to build first.

## User story

As a **store manager**, I want to record each vendor's own order/SKU code for the
items I buy from them, and then, from a purchase order, generate a plain
**code + quantity** list I can paste straight into that vendor's web quick-order
form — so I can place the order in seconds without hand-typing every product
number, and without exposing my costs to the vendor.

Sub-stories:

- **US-1 (author codes — admin).** As an admin editing an ingredient, I want to
  type the vendor's order code next to each vendor I've attached that item to (US
  Foods code AND Sysco code can differ for the same item), so the code travels with
  the (item, vendor) link.
- **US-2 (export a paste block).** As an admin looking at a purchase order, I want a
  second Share action that produces a bare `<order code>\t<qty>` block (one line per
  item, no prices, no labels) for the PO's vendor, so I can paste it into the
  vendor's quick-order box.
- **US-3 (see the gaps).** As an admin, when some items on the PO have no order code
  for that vendor yet, I want those lines clearly flagged in the output (a visible
  placeholder + a count warning) rather than silently dropped, so I know exactly
  which codes to go fill in.

## Acceptance criteria

Slice 1 — per-vendor order code (backend):

- [ ] **AC-1.** `public.item_vendors` gains ONE new nullable text column holding the
  vendor's order/SKU code for that (item, vendor) link (architect confirms the
  name; PM recommends `vendor_sku`). The migration is additive: no backfill, no
  change to any existing column, no drop. Existing rows get `NULL`. A pgTAP test
  asserts the column exists, is nullable, and that inserting/updating a link with
  and without a code both succeed.
- [ ] **AC-2.** The new column inherits the existing `item_vendors` RLS unchanged: a
  store member (`auth_can_see_store()` via the `item_id → inventory_items.store_id`
  parent join) can SELECT/INSERT/UPDATE the code on a link for an item in a store
  they can see; a non-member cannot. No new policy is added; the existing four
  `store_member_*_item_vendors` policies already gate the whole row. A pgTAP test
  asserts a member of Store A can write the code on a Store-A item's link and a
  Store-B-only member cannot (RLS-denied).
- [ ] **AC-3.** `src/lib/db.ts` threads the code through the full `item_vendors`
  round-trip it already owns: (a) the `fetchInventory` SELECT embed
  (`db.ts:238` — add the new column to the `item_vendors:item_vendors(...)`
  projection); (b) the `mapItem` hydration (`db.ts:4785-4799`) maps it snake→camel
  onto each `ItemVendorLink`; (c) the create upsert (`db.ts:362-368`) and the update
  reconcile upsert (`db.ts:489-495`) persist it. The `ItemVendorLink` type
  (`src/types/index.ts:187`) and the create/update `vendors?` payload types
  (`db.ts:302`, `db.ts:397`) gain the optional code field. A round-trip is asserted
  (save a link with a code → refetch → the code is present); an omitted/empty code
  round-trips as `NULL`/empty, not the string `"undefined"`.

Slice 1 — admin code entry (frontend):

- [ ] **AC-4.** The existing multi-vendor editor (`IngredientForm.tsx`, the
  per-vendor link card at lines ~1174-1227) renders an editable **order code** text
  input inside EACH attached-vendor card, keyed on that row's `vendorId`, alongside
  the existing `cost / each` (read-only) + `case price` (editable) inputs. Editing
  one card's code updates ONLY that link's code (the `values.vendors[]` row for that
  `vendorId`), mirroring the existing `updateVendorLinkField` pattern; other cards
  are untouched. The code is free-form text, trimmed on save; an empty code saves as
  `NULL` (removes the code). A jest test on the extended pure mapper asserts
  per-card isolation and the empty→null mapping.
- [ ] **AC-5.** Saving the ingredient persists each card's code to its `item_vendors`
  link via the existing create/update path (AC-3). Reopening the drawer shows each
  card's saved code. No new save button, no separate RPC — the code rides the
  existing "save ingredient" reconcile.

Slice 2 — universal quick-order export (frontend, extends spec 108):

- [ ] **AC-6.** The PO detail pane in `POsSection.tsx` exposes a SECOND share
  affordance — "Quick-order list" (or equivalent) — DISTINCT from and ADDITIONAL to
  the existing spec-108 human-readable "Share" (the existing button, builder
  `buildPoShareText`, and its output are UNCHANGED). It is available on the same PO
  statuses the existing Share is (`draft`, `sent`, `partial`; absent on
  `received`/`cancelled`).
- [ ] **AC-7.** Pressing it builds a paste-ready block for the PO's vendor
  (`sel.vendorId`): **one line per PO item**, format `<order code><TAB><qty>`
  (architect fixes the exact delimiter — PM recommends a literal TAB `\t`; a
  comma is the fallback). The block carries **NO prices** and **NO dollar signs**
  anywhere (mirrors spec-108's no-`$` ruling — a jest test asserts the output
  contains no `$`), and no header/labels beyond what's needed to paste. The `<qty>`
  is the PO line's `orderedQty`, formatted via the shared `formatQty` (the same
  formatter `poShareText.ts` reuses).
- [ ] **AC-8.** The order code for each line is resolved for the (item, PO-vendor)
  pair: `PoLine.itemId` + `sel.vendorId` → the `vendor_sku` on that item's
  `ItemVendorLink` (from the hydrated `inventory` store rows, the same source
  `POsSection.onShare` already reads for name resolution). `PoLine` itself is NOT
  extended (it carries no per-line vendor code today, by design — AC-3's column feeds
  the resolver via the inventory embed, not via `po_items`).
- [ ] **AC-9 (unmapped items surfaced, not dropped).** When a PO line's item has NO
  order code for the PO's vendor (null/empty `vendor_sku`, or no matching
  `ItemVendorLink` at all), that line is NOT silently dropped: it renders a visible
  placeholder line (PM recommends `??? <item name> <qty>` so the operator can see
  which item + qty needs a code), AND the export surfaces a **count warning** of how
  many lines are unmapped (e.g. a toast / inline note "3 items have no US Foods
  code"). A jest test asserts: a mix of mapped + unmapped lines produces the mapped
  lines as `<code>\t<qty>` and the unmapped lines as the `???` placeholder, and the
  unmapped count is correct.
- [ ] **AC-10.** The export reuses the spec-108 I/O orchestrator `sharePurchaseOrder`
  (`src/screens/cmd/lib/sharePo.ts`) verbatim — same native share-sheet /
  `navigator.share` / desktop-web clipboard+preview branching, same never-throw /
  swallow-AbortError posture. On desktop web it returns the preview text so the
  caller renders the selectable preview pane (as the existing Share does). No new I/O
  plumbing is written; only a new pure builder + the wiring in `onShare`'s sibling
  handler. Works on react-native-web (Vercel) AND native (EAS).
- [ ] **AC-11 (i18n ×3).** Every new user-visible string exists in all three locales
  (en / es / zh-CN) in the admin catalog (`src/i18n/*.json`, the `section.*` block
  read via `useT`): the order-code input label + help (Slice 1), the "Quick-order
  list" button label, the copied toast, the share dialog title, and the unmapped
  count warning (Slice 2). The pasted BLOCK ITSELF is intentionally NOT localized
  (it is machine-facing `<code>\t<qty>`; the `???` placeholder marker is a fixed
  sentinel, though the item NAME inside it resolves in the current locale via the
  same `getLocalizedName` path spec 108 uses). No user-visible hardcoded English on
  the admin surface.

## In scope

- **Migration:** one additive nullable text column on `public.item_vendors` (PM
  recommends `vendor_sku`), no backfill, existing RLS + realtime membership + grants
  inherited unchanged.
- **`db.ts` threading:** extend the existing `item_vendors` embed / `mapItem`
  hydration / create-upsert / update-reconcile-upsert to carry the code; extend the
  `ItemVendorLink` type + the two `vendors?` payload types.
- **Admin code entry:** a third input in each per-vendor card of the existing
  `IngredientForm` multi-vendor editor, keyed on `vendorId`, saved via the existing
  ingredient reconcile. Extend the pure `updateVendorLinkField` / `vendorRowsToLinkPayload`
  helpers to carry the code.
- **Quick-order export:** a NEW pure builder (sibling to `poShareText.ts`, e.g.
  `src/utils/poQuickOrderText.ts`) that emits the `<code>\t<qty>` block + `???`
  placeholders + an unmapped count, jest-covered byte-for-byte; a second Share
  handler in `POsSection.tsx` that resolves codes from the hydrated `inventory` rows,
  calls the builder, then hands the text to the EXISTING `sharePurchaseOrder`
  orchestrator; a second Share button in the PO detail pane.
- **i18n ×3** for all new admin-surface strings (AC-11).
- Tests on the matching tracks (named under Project-specific notes).

## Out of scope (explicitly)

- **Any vendor-specific file FORMAT or transport.** US Foods MOXē Import-Order file
  (CSV/XML/EDI-850 layout), Sysco `.700` order-guide upload-back, X12 EDI 850/855/856,
  cXML/OCI punchout, and browser automation are ALL out. Rationale: the research shows
  none is a self-serve buyer API; a paste-ready block serves all five today with zero
  live-account dependency. **A FUTURE spec CAN add the US Foods file export on top of
  THIS mapping** (the per-vendor code is the shared prerequisite) — and that future
  work has two open prerequisites to verify on a live account FIRST: (a) US Foods
  Import-Order availability per account, and (b) whether Sysco accepts a completed
  order upload-back. Those are flagged for that future spec, NOT this one.
- **Pulling order codes FROM vendors automatically** (any inbound integration —
  order-guide download, invoice parse, xtraCHEF/reciProfity bridge). Codes are entered
  by the admin by hand in this increment. Rationale: no inbound path is in scope; the
  mapping table is the manual foundation.
- **The item-level `vendorSku` stub on `inventory_items`.** `IngredientForm` today
  has a READ-ONLY, item-level `values.vendorSku` field labeled "vendor sku · schema
  pending" (`IngredientForm.tsx:43, 79, 1241`) plus a `csvImport.ts` header alias
  (`vendor_sku` → "vendor code / item #"). This spec does NOT wire that stub — the
  owner requirement is a code PER VENDOR (an item bought from US Foods AND Sysco needs
  two different codes), which the single item-level stub cannot express. The code
  lives on the per-`(item,vendor)` `item_vendors` link instead. The obsolete stub is
  left as-is (a later cleanup spec may remove it); flagged so the frontend does NOT
  wire the wrong field. (OQ-4.)
- **A Reorder-vendor-card export button.** `ReorderSection.tsx` has NO share
  affordance today (verified — the spec-108 share lives only in `POsSection`;
  ReorderSection's role is to CREATE draft POs via `createPurchaseOrderDraft`, which
  are then shared from POsSection). Adding a share surface there is a larger, separate
  lift. The owner said "POsSection and/or a Reorder vendor card"; PM recommends
  PO-only for this increment (the vendor is fixed on a PO and the lines exist there),
  and defers the Reorder-card export to a possible follow-up. (OQ-3.)
- **Changing the existing spec-108 human-readable Share.** `buildPoShareText`, its
  output, and its button are untouched. The quick-order block is a SECOND artifact
  alongside it. Rationale: the human-readable text (with names + qty × unit) and the
  machine paste-block (bare codes) serve different readers.
- **Server-enforced order-code uniqueness.** The code is free-form text with NO DB
  uniqueness constraint. Two different items CAN carry the same vendor code (rare, but
  the DB does not police it), and the same item CANNOT have two links to one vendor
  anyway (the existing `(item_id, vendor_id)` composite unique already ensures one
  code per (item, vendor)). Rationale: the owner ask never requests cross-item
  uniqueness; over-enforcing would reject legitimate data and add an opaque `23505`.
  (OQ-2.)
- **Realtime publication changes.** `item_vendors` is ALREADY in the
  `supabase_realtime` publication (spec 102), so an ADDED COLUMN needs no publication
  change and no `docker restart` gotcha — code edits already replay on the `store-{id}`
  channel via the existing subscription. Flagged as an ABSENCE so the deploy checklist
  isn't padded. (OQ-5.)
- **The `app.json` slug, identity drift, and the repo-root spreadsheet** — untouched
  (CLAUDE.md load-bearing / DO-NOT-AUTO-FIX).

## Open questions resolved

Owner-verified context is binding and cited above (Background + the two-slice
ruling). Remaining mechanism/UX questions resolved with recommended defaults
(owner accepts unless flagged); the architect fixes the two items explicitly
deferred to them.

- **OQ-1 — Column name + placement.** → **`item_vendors.vendor_sku` (text,
  nullable), PM recommendation; architect confirms the final name.** Rationale: the
  code is a per-(item, vendor) attribute; `item_vendors` is the existing join that
  already holds `case_price` / `cost_per_unit` / `is_primary` per link, has the right
  RLS, and is already in realtime. A separate table would be gratuitous. (`order_code`
  is an acceptable alt name; the architect picks one in the design doc — the rest of
  the spec says "the order-code column" abstractly.)

- **OQ-2 — Uniqueness of a vendor code.** → **Free-form text, NO uniqueness
  constraint** (see Out of scope). The `(item_id, vendor_id)` composite unique already
  gives one code per (item, vendor); cross-item uniqueness is not required and would
  reject legitimate data. **Default; owner accepts unless flagged.**

- **OQ-3 — Which surface(s) get the export button.** → **PO detail pane in
  `POsSection` only** for this increment; Reorder-card export deferred (see Out of
  scope). Rationale: the vendor is fixed on a PO, the lines exist there, and it mirrors
  spec-108's home exactly with zero new share plumbing; ReorderSection has no share
  surface today. **PM recommendation; owner accepts unless they want the Reorder card
  too now.**

- **OQ-4 — The existing item-level `vendorSku` stub.** → **Left untouched; NOT wired**
  (see Out of scope). The per-vendor requirement supersedes the single item-level stub.
  **Default; flagged so the frontend wires `item_vendors`, not the stub.**

- **OQ-5 — Realtime for the new column.** → **No publication change needed**
  (`item_vendors` is already published — spec 102). Code edits replay on the existing
  `store-{id}` subscription; the `docker restart` gotcha does NOT apply to a column
  add on an already-published table. **Default; flagged as an ABSENCE.**

- **OQ-6 — Export delimiter + line format.** → **PM recommends one line per item,
  `<order code><TAB><qty>` (literal `\t`), no prices, no header.** A TAB pastes
  cleanly into the multi-column quick-order boxes these vendors expose; a comma is the
  fallback if the architect finds a target box that mis-parses TAB. **Architect fixes
  the exact delimiter in the design doc** (pinned observable: bare code + qty, no `$`,
  one line per item). Owner accepts the architect's call.

- **OQ-7 — Unmapped-item handling.** → **Surface, do not drop:** a visible
  `??? <item name> <qty>` placeholder line PER unmapped item + an aggregate count
  warning (AC-9). Rationale: silently dropping lines would produce a short order the
  operator can't detect; the placeholder tells them exactly which codes to fill in.
  **PM recommendation; owner accepts unless flagged.**

- **OQ-8 — Is the pasted block localized?** → **No — the block is machine-facing**
  (`<code>\t<qty>`); only the surrounding UI (button, toast, warning) localizes ×3,
  and the item NAME inside a `???` placeholder resolves in the current locale via the
  same `getLocalizedName` path spec 108 uses (AC-11). **Default; owner accepts unless
  flagged.**

## Dependencies

- **Spec 102 (live) — `public.item_vendors`.** The join this spec extends:
  `supabase/migrations/20260630000000_item_vendors.sql` (composite unique
  `(item_id, vendor_id)`; store-scoped transitively via `item_id → inventory_items.store_id`;
  four `store_member_*_item_vendors` RLS policies gating the whole row via the parent
  join; already in the `supabase_realtime` publication; explicit spec-097 grants). The
  new column inherits ALL of this — no new policy, no publication change, no grant
  change needed (the existing table-level grants cover the added column).
- **Spec 108 (live) — the share plumbing this REUSES.** `src/utils/poShareText.ts`
  (pure builder — the sibling pattern for the new quick-order builder), the shared
  `formatQty` (from `src/utils/reorderExport.ts`, re-used for the qty), and
  `src/screens/cmd/lib/sharePo.ts` `sharePurchaseOrder` (the IMPURE I/O orchestrator —
  native share-sheet / `navigator.share` / desktop-web clipboard+preview, never-throw,
  swallow-AbortError) reused VERBATIM for the second artifact. The wiring point is
  `POsSection.onShare` (`POsSection.tsx:200-242`) — a sibling handler alongside it.
- **A new migration** — adds the nullable order-code column to `public.item_vendors`.
  Additive, instant (no backfill; PG 17), reversible-by-design (`alter table … drop
  column`). Applied to prod via the Supabase MCP (project memory "Prod migration via
  Supabase MCP" — `db push` lacks the prod password), then the exact version inserted
  into `schema_migrations` so `db-migrations-applied.yml` (spec 064) stays green. The
  developer FLAGS the prod-apply in the handoff; they do not push it themselves.
  Proposed filename sorts after the latest on disk (`20260707000000_staff_receiving_price_gate.sql`)
  — the architect fixes the timestamp (e.g. `20260708000000_item_vendor_order_code.sql`).
- **`src/lib/db.ts`** — extend the existing `item_vendors` embed (`:238`), `mapItem`
  hydration (`:4785-4799`, `:4842-4844`), create upsert (`:362-368`), and update
  reconcile upsert (`:489-495`). No new helper file; the code rides the existing
  create/update reconcile.
- **`src/types/index.ts`** — `ItemVendorLink` (`:187`) gains the optional code field.
- **`src/components/cmd/IngredientForm.tsx`** — a third input in the per-vendor card
  (`~:1207-1226`); extend the pure `updateVendorLinkField` (`:219`) and
  `vendorRowsToLinkPayload` (`:237`) to carry the code; add the field to
  `IngredientFormValues.vendors[]` (`:71`).
- **`src/utils/poQuickOrderText.ts` (new)** — pure builder for the `<code>\t<qty>`
  block + `???` placeholders + unmapped count; jest-covered. Mirrors `poShareText.ts`'s
  purity discipline (no React / theme / supabase / i18n import; name resolution and the
  code lookup INJECTED as callbacks so the caller closes over `inventory` + locale).
- **i18n catalogs** — `src/i18n/*.json` `section.*` block gains the order-code
  label/help + the quick-order button/toast/dialog/warning strings ×3 (the existing
  spec-108 `section.purchaseOrders.share*` keys live around `en.json:695-705` — the new
  keys sit alongside them).
- **Existing helpers reused (no change):** `getLocalizedName` (name resolution in the
  `???` placeholder), `formatQty`, `sharePurchaseOrder`, `Toast`.

## Project-specific notes

- **Cmd UI section / legacy:** both slices land in existing Cmd UI surfaces —
  `src/components/cmd/IngredientForm.tsx` (the multi-vendor editor drawer, admin) and
  `src/screens/cmd/sections/POsSection.tsx` (PO detail pane, admin). No legacy admin
  surface (spec 025 deleted it). No new section.
- **Which app:** this repo, admin Cmd UI ONLY. The **staff app is out of scope** — the
  admin authors codes and exports; staff receiving is spec 113 (separate). No
  `src/screens/staff/` change, no sibling-app (customer PWA) work.
- **Per-store or admin-global:** **per-store**, inherited unchanged from
  `item_vendors`. The code column is gated by the existing `store_member_*_item_vendors`
  RLS policies (SELECT/INSERT/UPDATE/DELETE all `auth_can_see_store(ii.store_id)` via
  the `item_id → inventory_items.store_id` parent join). No new policy; the added column
  is covered by the existing whole-row policies.
- **Edge function or PostgREST:** **PostgREST only** — the code rides the existing
  `item_vendors` upsert/select through `db.ts`. **No RPC, no edge function** (the
  read/write is a plain column on an already-RLS'd table; there is no cross-row
  invariant or role gate to enforce beyond the existing store RLS, unlike spec 110's
  privileged-write layouts). No `staff-*` / service-token / `pwa-catalog` surface
  involved.
- **Realtime channels touched:** **`store-{id}` — but NO migration/publication work.**
  `item_vendors` is ALREADY in the `supabase_realtime` publication and ALREADY
  subscribed in `useRealtimeSync.ts` (spec 102), so a code edit already replays to
  other admin clients on the existing channel. The mid-session-publication `docker
  restart supabase_realtime_imr-inventory` gotcha does NOT apply to an ADDED COLUMN on
  an already-published table — flagged as an ABSENCE (OQ-5).
- **Migrations needed:** **yes** — one purely additive migration: a nullable text
  column on `public.item_vendors`, no backfill, no policy change, no publication change,
  no grant change (existing table grants cover the column). Prod-apply via Supabase MCP
  + `schema_migrations` insert (spec 064 gate). The lone non-default hunk is the column
  add itself — instant in PG 17.
- **Two share buttons on the PO detail pane (flag for frontend):** the existing
  spec-108 "Share" (human-readable) and the new "Quick-order list" (machine paste block)
  both live in the PO detail pane and MUST be visually + textually distinct (distinct
  labels ×3 locales, distinct placement) so the admin doesn't confuse the vendor-facing
  message with the paste block. Called out so the frontend designs for coexistence.
- **The per-vendor card gains a THIRD input (flag for frontend):** the existing card
  (`IngredientForm.tsx:1207-1226`) has `cost / each` (read-only) + `case price`
  (editable); the order code is a third input, keyed on `row.vendorId`, isolated per
  card. Do NOT wire the obsolete item-level `values.vendorSku` stub at `:1241` (OQ-4).
- **Edge functions touched:** **none.**
- **Web/native scope:** **both.** The admin editor + PO share render on web (Vercel)
  and native (EAS); the reused `sharePurchaseOrder` already branches native
  share-sheet vs web `navigator.share` vs desktop-web clipboard+preview (spec 108). No
  web-only affordance.
- **`app.json` slug:** untouched — no bearing on build identifiers; `slug` stays
  `towson-inventory` pending explicit approval.
- **Test tracks (spec 022):**
  - **pgTAP:** (a) the new column exists + is nullable; insert/update a link with and
    without a code both succeed (AC-1). (b) RLS — a member of Store A can write the code
    on a Store-A item's link; a Store-B-only member cannot (AC-2). Extend the existing
    `supabase/tests/item_vendors_rls.test.sql`. (c) The spec-053 permissive-policy lint
    arm scans automatically — no new policy is added, so no allowlist edit is expected.
  - **jest:** (a) the extended pure vendor-link mapper — editing one card's code
    isolates to that `vendorId`; empty code → null (AC-4). (b) the new
    `poQuickOrderText` builder byte-for-byte: mapped lines → `<code>\t<qty>`, unmapped
    → `??? <item name> <qty>`, correct unmapped count, and NO `$` anywhere in the output
    (AC-7/AC-9). (c) the round-trip payload shape (a code threads through
    `vendorRowsToLinkPayload` and the create/update `vendors?` payload — AC-3).
  - **shell smoke:** none anticipated.

## Handoff
next_agent: backend-architect
prompt: Design the contract for spec 114. Confirm the order-code column name on
  `public.item_vendors` (PM recommends `vendor_sku`, nullable text; alt `order_code`),
  pin the additive migration (no backfill, no policy/publication/grant change), and
  fix the two items deferred to you: OQ-1 (final column name) and OQ-6 (exact
  quick-order delimiter — PM recommends literal TAB `\t`, comma fallback; pin the
  no-`$`, one-line-per-item, bare code+qty observables either way). Specify the
  `db.ts` threading (embed / mapItem / create-upsert / update-reconcile-upsert) and the
  `ItemVendorLink` + payload type changes, and the `poQuickOrderText` builder's pure
  signature (INJECTED code lookup + name resolver, mirroring `poShareText.ts`). Then
  set Status: READY_FOR_BUILD.
payload_paths:
  - specs/114-vendor-quick-order-list.md

---

## Backend design

Read `CLAUDE.md`, this spec in full, and the load-bearing code: `item_vendors`
migration (`supabase/migrations/20260630000000_item_vendors.sql`), the four
`db.ts` `item_vendors` touchpoints (embed `:238`, `mapItem` `:4785`, create-upsert
`:362`, update-reconcile `:489`), `IngredientForm.tsx` (per-vendor card `:1207`,
pure helpers `:219`/`:237`, `values.vendors[]` `:71`), `IngredientFormDrawer.tsx`
(hydration `:63`, `toUpdates` `:104`), `POsSection.tsx` (`onShare` `:200`),
`poShareText.ts`, `sharePo.ts`, `reorderExport.ts` (`formatQty`), and the existing
pgTAP at `supabase/tests/item_vendors_rls.test.sql`.

**The two deferred decisions, fixed.** OQ-1 → the column is `order_code` (NOT the
PM's `vendor_sku`). OQ-6 → the delimiter is a literal TAB (`\t`), no header line.
Rationale for both is in D-1 and D-3 below.

The spec's AC line-number anchors were verified against the current tree and all
resolve; no drift. This design is a thin extension of a round-trip `db.ts` already
owns end-to-end (spec 102) plus a new pure builder sibling to spec 108's — no RPC,
no edge function, no new policy, no publication change.

### D-1. Data model changes

One purely additive column on the existing `public.item_vendors` join.

- **Column:** `order_code text` (nullable, **no default**, no backfill).
- **Migration filename:** `supabase/migrations/20260708000000_item_vendor_order_code.sql`.
  Verified this sorts after the latest on disk
  (`20260707000000_staff_receiving_price_gate.sql`).
- **Body (developer authors; shape only):**
  `alter table public.item_vendors add column if not exists order_code text;`
  plus a `comment on column` documenting it as the per-(item,vendor) vendor
  order/SKU code pasted into the vendor's quick-order box (spec 114), free-form,
  no uniqueness (OQ-2).

**Column name — why `order_code`, not `vendor_sku` (OQ-1 resolved).** There is a
dead **item-level** `values.vendorSku` field in `IngredientForm.tsx:43,79,1241`
(read-only, help text "schema pending", NO backing DB column) and a
`csvImport.ts:42` header alias mapping `vendor_sku → 'vendor code / item #'`.
Naming the new **per-vendor** column `vendor_sku` would create two live things
both surfaced as "vendor sku" — the obsolete item-level stub (which this spec
explicitly does NOT wire, OQ-4) and the new per-(item,vendor) column — inviting a
future dev to wire the wrong one. `order_code` is unambiguous against that stub,
and names the artifact by its purpose (the code the operator types into the
vendor's order box). The `vendorSku` stub is left exactly as-is per OQ-4; this
design does not repurpose or retire it (a later cleanup spec may). The
`csvImport.ts` alias is untouched — CSV import does not flow into `item_vendors`
in this increment and is out of scope.

**Additive-safety / inheritance (PM's claim — confirmed).** `add column` on
Postgres 17 with no default and no `not null` is a metadata-only, instant,
non-rewriting operation — safe on the 286 KB / 564-link seed and on prod. It is
reversible-by-design (`alter table … drop column order_code`). The added column
inherits, with **zero** policy/grant/publication change:

- **RLS:** confirmed. The four `store_member_*_item_vendors` policies gate the
  **whole row** via `exists(… inventory_items ii where ii.id = item_vendors.item_id
  and auth_can_see_store(ii.store_id))` (`20260630000000_item_vendors.sql:121-142`).
  Row-level policies are column-agnostic — a new column is covered by SELECT /
  INSERT / UPDATE / DELETE the instant it exists. No new policy, no policy edit.
- **Grants:** confirmed. `grant select, insert, update, delete, references,
  trigger … to anon, authenticated` (`:98`) and `grant all … to service_role`
  (`:100`) are **table-level** grants — they extend to every column automatically,
  including one added later. Combined with the spec-097 default-privileges
  migration (`20260618000000_public_grants_explicit.sql`), there is no grant hunk
  in this migration and no grant leak. (A future column-level `revoke` is the only
  thing that would need re-stating; nothing here does.)
- **spec-053 permissive-policy lint:** no new policy is added, so no allowlist
  edit; the CI lint arm stays green untouched.

### D-2. RLS impact

**No RLS change.** No new table, no new policy, no policy edit. The four existing
`item_vendors` policies (all using `auth_can_see_store(ii.store_id)` via the
`item_id → inventory_items.store_id` parent join) already gate `order_code` because
they gate the row. Admin/master paths are covered transitively —
`auth_can_see_store()` is `auth_is_admin() OR exists(user_stores …)`, so no
standalone admin policy is or was needed (consistent with `inventory_items`
itself).

Pinned regression risk for the reviewer: the pgTAP must prove a **non-member
cannot write `order_code`** on a store they can't see (see D-7) — i.e. the added
column did not somehow escape the whole-row policy. It cannot (policies are
row-scoped), but the test is the durable proof.

### D-3. API contract

**PostgREST only. No RPC, no edge function.** The read/write is a plain column on
an already-RLS'd table; there is no cross-row invariant, no role gate beyond the
existing store RLS (contrast spec 110's privileged-write layouts, which needed an
RPC). Both directions ride the existing `db.ts` `item_vendors` round-trip:

- **Read:** the `fetchInventory` SELECT embed adds `order_code` to the
  `item_vendors:item_vendors(…)` projection; `mapItem` hydrates it onto each
  `ItemVendorLink`. Response shape: each inventory row's `vendors[]` gains
  `orderCode: string`.
- **Write (create):** `createInventoryItem`'s `item_vendors` upsert adds
  `order_code` to each upserted row.
- **Write (update/reconcile):** `updateInventoryItem`'s reconcile upsert adds
  `order_code` to each upserted row; the de-select delete path is unchanged.
- **Error cases:** none new. The column is free-form nullable text with no
  constraint — no `23505`, no `23514`, no check. An RLS denial on a
  cross-store write surfaces as the existing `42501` the whole-row policies
  already raise (the same path spec 102's writes already hit).

**No new artifact for the quick-order EXPORT read.** Confirmed against
`POsSection.onShare` (`:200-226`): the existing Share handler already reads
`poLinesById[sel.id]` for lines and `inventory` (the hydrated store rows) for
name resolution. The quick-order builder resolves each line's code the **same
way** — `inventory.find(i => i.id === line.itemId)?.vendors.find(v => v.vendorId
=== sel.vendorId)?.orderCode`. So:

- `fetchPurchaseOrderLines` / `poLinesById` is **NOT** extended. `PoLine` carries
  no per-line vendor code (AC-8, by design).
- **No new fetch keyed on `(po.vendor_id, line.item_id)`.** The code is already in
  memory once `order_code` rides the `fetchInventory` embed above — the same store
  slice `onShare` already reads. The resolver is a closure over `inventory` +
  `sel.vendorId`, mirroring the existing `resolveName` closure over `inventory` +
  `locale`. This is the cheapest correct source and avoids an N-query fan-out on
  the PO detail pane.

### D-4. Edge function changes

**None.** No `verify_jwt` decision, no service-token strategy. Explicitly flagged
as an absence so the deploy checklist isn't padded. No `staff-*` / `pwa-catalog`
surface is touched.

### D-5. `src/lib/db.ts` surface

No new helper. Four in-place edits to the existing `item_vendors` round-trip, plus
the shared type. Exact changes:

1. **Embed** (`db.ts:238`) — add `order_code` to the `item_vendors` projection:
   `item_vendors:item_vendors(vendor_id, cost_per_unit, case_price, is_primary,
   order_code, vendor:vendors(id, name))`.
2. **`mapItem` hydration** (`db.ts:4785-4799`) — the inline `vendorLinks` mapper's
   element type gains `orderCode: string` and the `.map` gains
   `orderCode: lv.order_code || ''` (snake→camel; null/absent → `''`, never the
   string `"undefined"`).
3. **Create upsert** (`db.ts:362-368`) — the upserted row object gains
   `order_code: l.orderCode || null` (empty/undefined → SQL `NULL`, not `''` and
   not `"undefined"` — matches AC-3's "empty round-trips as NULL").
4. **Update reconcile upsert** (`db.ts:489-495`) — the upserted row object gains
   `order_code: v.orderCode || null` (same null-coalesce).
5. **Payload types** — both `vendors?` payload shapes
   (`createInventoryItem` arg `db.ts:302`, `updateInventoryItem` arg `db.ts:397`)
   gain `orderCode?: string`:
   `vendors?: Array<{ vendorId: string; costPerUnit?: number; casePrice?: number;
   orderCode?: string }>`.

**Type change** — `src/types/index.ts:187` `ItemVendorLink` gains
`orderCode: string;` (non-optional on the hydrated shape, defaulting to `''` from
`mapItem`, mirroring how `vendorName` is a required `string` on the same
interface).

**camelCase mapping:** `order_code` (wire) ↔ `orderCode` (app), added to the
existing local `item_vendors` mapper — consistent with `cost_per_unit ↔
costPerUnit`, `is_primary ↔ isPrimary` already in the same block. No new
`mapItem`-style helper; the code rides the existing hydrate.

### D-6. Frontend surface

**Slice 1 — admin code entry (`IngredientForm.tsx` + `IngredientFormDrawer.tsx`).**

- `IngredientFormValues.vendors[]` (`:71`) and the `VendorLinkRow` type (`:172`)
  gain `orderCode: string` (held as a string like the sibling cost fields, per the
  form's "everything is a string until save" convention). `blankValues` needs no
  change (the rows are built dynamically).
- **Pure `updateVendorLinkField`** (`:219`) — widen the `field` union to
  `'costPerUnit' | 'casePrice' | 'orderCode'`. The body is already generic
  (`{ ...r, [field]: value }`), so per-card isolation and the "only that vendorId"
  guarantee are inherited unchanged. A new `handleVendorOrderCodeChange(vendorId,
  value)` calls it with `field: 'orderCode'` (mirror of `handleVendorCasePriceChange`
  `:833`, minus the derived-cost recompute — the code is free text with no derived
  sibling).
- **Pure `vendorRowsToLinkPayload`** (`:237`) — the mapped payload gains
  `orderCode: (r.orderCode || '').trim() || undefined`. Trim on save; an
  all-whitespace or empty code becomes `undefined`, which `db.ts` coalesces to SQL
  `NULL` (AC-4's empty→null). Payload return type widens to include
  `orderCode?: string`.
- **`IngredientFormDrawer.tsx` hydration** (`:63-76`) — the two branches that build
  `values.vendors[]` from `it.vendors` add `orderCode: v.orderCode || ''`; the
  scalar-fallback branch (no embed) sets `orderCode: ''` (a legacy single-vendor
  item has no code until the admin types one). `toUpdates` (`:104`) needs no direct
  edit — it already delegates the vendors payload to `vendorRowsToLinkPayload(v.vendors)`.
- **The per-vendor card** (`:1207-1226`) gains a THIRD `InputLine` (order code),
  keyed on `row.vendorId`, free-form text (NOT `numericOnly`, NOT `readOnly`),
  alongside the existing read-only `cost / each` and editable `case price`. Label +
  help from the i18n catalog (D-8). **Do NOT wire the obsolete item-level
  `values.vendorSku` stub at `:1241`** — it stays untouched (OQ-4).

**Slice 2 — quick-order export (`POsSection.tsx` + new builder).** PO-only for
this increment (OQ-3 confirmed — see D-10). A second Share handler
`onShareQuickOrder`, sibling to `onShare` (`:200`), gated by the same `canShare`
(`:250`; `draft`/`sent`/`partial`), rendered as a second, textually + visually
distinct button next to the existing Share in the PO detail pane action row
(near `:462`). It:

1. Builds the block via the new pure `buildPoQuickOrderText` (D-9), passing a
   `resolveCode(itemId)` closure over `inventory` + `sel.vendorId` and a
   `resolveName(itemId, fallback)` closure identical to `onShare`'s (`:208`).
2. Hands the text to the **existing** `sharePurchaseOrder` orchestrator
   (`sharePo.ts`) verbatim — reusing its native/mobile-web/desktop-web branching,
   never-throw, swallow-AbortError posture (AC-10). Same `setSharePreview` on
   the returned `previewText` (the existing preview pane at `:450` renders it).
3. On a non-zero unmapped count, fires a warning Toast with the localized count
   string (D-9 / AC-9). **No draft "did you send it?" auto-prompt** on the
   quick-order path — that prompt is spec 108's mark-sent affordance for the
   human-readable share; the quick-order block is a paste aid, and firing
   mark-sent off a paste-to-clipboard would be a status-change surprise. (State
   this as a deliberate divergence from `onShare` for the reviewer.)

### D-7. Realtime impact

**Channel:** `store-{id}`. `item_vendors` is ALREADY in the `supabase_realtime`
publication (`20260630000000_item_vendors.sql:172`) and ALREADY subscribed in
`useRealtimeSync.ts` (spec 102), so an `order_code` edit replays to other admin
clients on the existing channel with no wiring change.

**Publication gotcha — deliberate ABSENCE (OQ-5 confirmed).** The mid-session
`docker restart supabase_realtime_imr-inventory` step applies only when a
migration changes `supabase_realtime` publication *membership*. This migration
ADDS A COLUMN to an already-published table — it does **not** touch the
publication. So the restart step does NOT apply here. Flagged explicitly so the
deploy checklist is not padded with a no-op restart.

### D-8. Frontend store impact

**No `useStore.ts` slice change.** The code rides the existing `item_vendors`
hydrate into the `inventory` slice (via `fetchInventory` → `mapItem`) and the
existing ingredient save/reconcile — no new store field, no new action. The
optimistic-then-revert pattern is **inherited** from the existing
`createInventoryItem` / `updateInventoryItem` store wrappers (any RLS/write error
reverts the slice and toasts via `notifyBackendError`, `useStore.ts:23`); the added
column changes no control flow there, so no new revert path is authored.

### D-9. The quick-order builder — `src/utils/poQuickOrderText.ts` (new, pure)

Sibling to `poShareText.ts`. **Pure** — no React / theme / supabase / i18n import;
the code lookup and name resolver are INJECTED as callbacks (mirrors
`poShareText.ts`'s `NameResolver`). jest-covered byte-for-byte. Reuses the shared
`formatQty` from `reorderExport.ts` for the qty (same formatter `poShareText.ts`
uses).

**Signature (developer authors; shape only):**

    export interface PoQuickOrderLine {
      itemId: string;
      itemName: string;   // plain-English fallback, routed through resolveName
      orderedQty: number;
    }
    // Injected: returns the order code for this line's item at the PO's vendor,
    // or null/'' when unmapped (the caller closes over inventory + sel.vendorId).
    export type CodeResolver = (itemId: string) => string | null | undefined;
    // Injected name resolver — identical contract to poShareText.ts's NameResolver.
    export type NameResolver = (itemId: string, fallbackName: string) => string;

    export interface PoQuickOrderResult {
      text: string;         // the paste-ready block
      unmappedCount: number;// how many lines had no code (for the warning toast)
    }

    export function buildPoQuickOrderText(
      lines: PoQuickOrderLine[],
      resolveCode: CodeResolver,
      resolveName: NameResolver,
    ): PoQuickOrderResult;

**Output format (pinned observables — OQ-6 resolved):**

- **Delimiter: literal TAB (`\t`).** One line per PO item, in input order.
- **No header line, no labels, no trailing count line** in the block itself (it is
  machine-facing; the count is surfaced separately as a toast — see below). Lines
  joined with `\n`.
- **Mapped line:** `<order code>\t<formatQty(orderedQty)>`.
- **Unmapped line (null/empty code, or no matching link):** NOT dropped. Renders
  `??? <resolved item name>\t<formatQty(orderedQty)>` — a fixed `??? ` sentinel
  prefix + the current-locale item name (via `resolveName`, so the operator reads
  the item in their language, OQ-8), then TAB + qty. The leading `??? ` makes the
  gap visually obvious in the pasted block AND guarantees the line will not
  accidentally parse as a valid code+qty pair in the vendor box.
- **NO prices, NO `$` anywhere** (spec 108 ruling; jest asserts `!output.includes('$')`).
- **Empty `lines`:** returns `{ text: '', unmappedCount: 0 }`. (The caller may
  short-circuit; the builder is still total.)

**Why TAB over comma (OQ-6).** These vendor quick-order boxes are multi-column
paste grids (code | qty); TAB is the delimiter spreadsheet-style grids consume on
paste, and a vendor order code can itself contain a comma or a hyphen but never a
raw TAB — so TAB is unambiguous where comma is not. Comma remains the documented
fallback ONLY if a future live-account test finds a target box that mis-parses TAB;
that would be a one-line change to this builder plus its jest pin.

**Unmapped count surfacing (OQ-7).** The builder RETURNS `unmappedCount`; the
`POsSection` handler decides how to surface it. Decision: on `unmappedCount > 0`,
fire a warning Toast with a localized, interpolated count string (D-8 key
`quickOrderUnmappedWarning`, e.g. "3 items have no order code for this vendor").
The placeholder lines are ALSO visible inline in the desktop-web preview pane (the
same `sharePreview` pane the human-readable share uses), so the operator sees both
the aggregate warning and exactly which lines need a code. Toast + inline preview,
not one or the other.

### D-10. Surface decision (OQ-3)

**PO-only, confirmed.** The quick-order export lands solely in the `POsSection`
detail pane, next to spec 108's Share. Rationale: the vendor is fixed on a PO
(`sel.vendorId`) and the lines exist there, so the code resolver has an
unambiguous vendor to key on; and it mirrors spec 108's home with zero new I/O
plumbing. `ReorderSection.tsx` has NO share affordance today (verified — the
spec-108 share lives only in `POsSection`; ReorderSection creates draft POs which
are then shared from `POsSection`), so adding an export there is a larger,
separate lift. **Reorder-card export is a deferred follow-up**, not part of this
increment (matches spec Out-of-scope). If the owner wants the Reorder-card export
now, that is a scope addition to route back through the PM.

### D-11. Test plan

**pgTAP — extend `supabase/tests/item_vendors_rls.test.sql`** (do NOT create a new
file; the existing 8-assertion suite already has the Frederick/Charles fixture and
manager impersonation this needs). Bump `plan(8)` → the new count and add:

1. **Column exists + nullable + writable both ways (AC-1).** A member INSERT/UPDATE
   of a Frederick link WITH an `order_code` and WITHOUT one both succeed; a
   `col_is_null('item_vendors', 'order_code', …)` or an equivalent read-back proves
   the omitted case persisted `NULL` (not `''`). (Column-metadata can also be
   asserted via `has_column` / `col_type_is`.)
2. **RLS still gates the column (AC-2).** A member of Store A (the manager, on a
   Frederick item's link) CAN write `order_code`; the Charles-item link (non-member
   store) UPDATE of `order_code` is a no-op under the USING clause (0 rows, value
   unchanged) — reusing the exact seeded-under-postgres / re-impersonate pattern of
   assertions (3)/(6). This is the inherited-policy regression proof.
3. **No grant leak** — implicitly covered: the member write succeeding + the
   non-member write being denied proves the `authenticated` grant reaches the
   column and RLS still bounds it. No separate `has_table_privilege` assertion is
   required, but the developer may add one for `order_code` explicitness.

The spec-053 permissive-policy lint arm scans automatically; no policy is added, so
no allowlist edit is expected (state this so a green lint isn't mistaken for a
gap).

**jest:**

1. **Extended vendor-link mapper (AC-4)** — in `IngredientForm.test.ts`:
   `updateVendorLinkField(rows, v2, 'orderCode', 'ABC123')` mutates only the `v2`
   row's `orderCode`; other rows untouched. `vendorRowsToLinkPayload` maps a
   present code to `orderCode: 'ABC123'`, trims `'  X9 '` → `'X9'`, and maps an
   empty/whitespace code to `orderCode: undefined` (the empty→null contract). Assert
   the code writes to the right `(vendorId)` row and NOT to any item-level stub
   (there is no stub in this pure surface — the assertion is that only the
   `vendors[]` row carries it).
2. **New `poQuickOrderText` builder, byte-for-byte (AC-7/AC-9)** — new
   `src/utils/poQuickOrderText.test.ts`:
   - mapped lines → `<code>\t<qty>` (assert the TAB, assert `formatQty` shape);
   - unmapped lines → `??? <name>\t<qty>` with the resolved name;
   - a mixed input → correct `unmappedCount`;
   - `expect(result.text).not.toContain('$')` (no-money pin);
   - empty input → `{ text: '', unmappedCount: 0 }`.
3. **Round-trip payload shape (AC-3)** — assert `orderCode` threads through
   `vendorRowsToLinkPayload` into the `vendors?` payload the create/update helpers
   consume (extends the existing payload-shape test in `IngredientForm.test.ts`).

No shell smoke anticipated.

### D-12. Risks and tradeoffs (explicit)

- **Migration ordering / prod apply.** Additive DDL. Apply to prod via the Supabase
  MCP per project memory "Prod migration via Supabase MCP" (`db push` lacks the prod
  password): `execute_sql` the `alter table … add column`, then INSERT the exact
  version `20260708000000` into `supabase_migrations.schema_migrations`, then VERIFY
  the column is present (`information_schema.columns` for
  `item_vendors.order_code`). This is a DDL apply — verify by **column presence**,
  NOT a body-only normalized-md5 (that md5 verification is for CREATE-OR-REPLACE
  FUNCTION bodies; there is no function here). The developer FLAGS the prod-apply in
  the handoff and does NOT push it themselves. `db-migrations-applied.yml` (spec
  064) goes red until the `schema_migrations` row lands — expected, resolves on apply.
- **RLS gap:** none introduced — row-level policies are column-agnostic and the
  pgTAP proves the non-member write is still denied. The only way this regresses is
  a future column-level `revoke`, which nothing here does.
- **Performance on the seed:** the embed gains ONE text column on the existing
  `item_vendors` projection already fetched by `fetchInventory` — no new query, no
  new join, no N+1. The quick-order resolver is an in-memory `inventory.find(...)
  → vendors.find(...)` per PO line (PO line counts are small — tens, not
  thousands), same cost class as the existing `resolveName`. `add column` is
  metadata-only on PG 17 — instant on the 564-link table.
- **Edge function cold-start:** N/A — no edge function touched.
- **Free-form code / no uniqueness (OQ-2):** two items CAN share a vendor code; the
  DB does not police it. Accepted — the owner ask never requests cross-item
  uniqueness, and over-enforcing would reject legitimate data with an opaque
  `23505`. The existing `(item_id, vendor_id)` composite unique already guarantees
  one code per (item, vendor).
- **Unmapped-line safety:** the `??? ` sentinel is deliberately NOT a valid code, so
  an operator who pastes without filling gaps produces a visibly-broken line the
  vendor box rejects rather than a silently-short order. The aggregate toast is the
  second signal. This is the intended fail-loud posture (AC-9).
- **Reviewer fan-out (per the dispatch ask):** backend surface DOES change
  (`order_code` column + `db.ts` threading + type), so the **post-impl
  backend-architect drift pass is warranted**, **pgTAP is required** (RLS-inherited
  regression on the added column), and the **prod apply is user-gated** — it is
  `execute_sql` the ALTER + `schema_migrations` insert + verify column present (NOT
  a body-only md5, since this is DDL, not a function body).

---

## Files changed

### Backend (backend-developer)

**migrations**
- `supabase/migrations/20260708000000_item_vendor_order_code.sql` (new) — additive
  `alter table public.item_vendors add column if not exists order_code text;`
  (nullable, no default, no backfill) + `comment on column`. House header documents:
  additive-only / metadata-only-instant-on-PG17 / inherits the four
  `store_member_*_item_vendors` RLS policies + spec-097 grants + realtime publication
  membership with ZERO change, the realtime-`docker restart` gotcha as a deliberate
  ABSENCE (column-add on an already-published table — OQ-5), and the prod-apply DDL
  note (execute_sql the ALTER + `schema_migrations` insert '20260708000000' + verify
  column present, NOT body-only md5). Sorts after
  `20260707000000_staff_receiving_price_gate.sql`.

**src/lib/db.ts**
- `fetchInventory` embed (`:238`) — added `order_code` to the `item_vendors:item_vendors(…)` projection.
- `mapItem` hydration — `vendorLinks` element type gains `orderCode: string`; the
  `.map` adds `orderCode: lv.order_code || ''` (snake→camel; null/absent → `''`).
- `createInventoryItem` upsert — each upserted link row gains `order_code: l.orderCode || null` (empty/blank/absent → SQL NULL).
- `updateInventoryItem` reconcile upsert — each upserted link row gains `order_code: v.orderCode || null` (same null-coalesce).
- Both `vendors?` payload types (`createInventoryItem` arg + `updateInventoryItem` arg)
  gain `orderCode?: string`.

**src/types/index.ts**
- `ItemVendorLink` gains `orderCode: string;` (required on the hydrated shape,
  defaulting to `''` from `mapItem`, mirroring `vendorName`). **This is the shared
  contract the frontend writes against.**

**src/store/useStore.ts** (type-forced by the required `ItemVendorLink.orderCode`)
- `addItem` optimistic `linkSet.map` → `orderCode: l.orderCode || ''`; scalar-fallback
  link → `orderCode: ''`.
- `updateItem` optimistic `linkSet.map` → `orderCode: l.orderCode || ''`.
  (The `addItem`/`updateItem` `vendors?` param signatures were extended with
  `orderCode?: string` by the frontend-developer in the same file — the two halves
  converge cleanly, both tagged spec 114.)

**supabase/tests** (pgTAP)
- `supabase/tests/item_vendors_rls.test.sql` — extended `plan(8)` → `plan(14)`. Added
  (9) `has_column` order_code, (10a) `col_is_null` nullable, (10b) `col_type_is` text,
  (11a) member's own link starts NULL (omitted→NULL, not `''`/`"undefined"`), (11b)
  member CAN write+read `order_code` on their store's link, (12) non-member UPDATE of
  `order_code` on a Charles link is a USING no-op (stays NULL) — the inherited-policy
  regression pin. Hermetic begin/rollback; reuses the existing manager-impersonation
  + postgres-seeded-Charles pattern.

### Frontend (frontend-developer)

**src/utils/poQuickOrderText.ts** (new) — PURE, framework-free quick-order builder
(D-9), sibling to `poShareText.ts`. `buildPoQuickOrderText(lines, resolveCode,
resolveName) → { text, unmappedCount }`. Emits one `<order code>\t<qty>` line per PO
item (literal TAB, no header/labels), `??? <resolved name>\t<qty>` for unmapped items
(null/blank code or no matching link) + increments `unmappedCount`, `formatQty` for the
qty, NO `$` anywhere. Empty input → `{ text: '', unmappedCount: 0 }`. Code + name
resolvers INJECTED (caller closes over `inventory` + `sel.vendorId` + locale).

**src/components/cmd/IngredientForm.tsx** (Slice 1 — per-vendor code entry)
- `IngredientFormValues.vendors[]` (`:71`) + `VendorLinkRow` (`:172`) gain `orderCode: string`.
- `addVendorLink` seeds new rows `orderCode: ''` (attach never carries a code).
- `updateVendorLinkField` field union widened to `… | 'orderCode'` (body already generic
  → per-card isolation inherited).
- `vendorRowsToLinkPayload` maps `orderCode: (r.orderCode || '').trim() || undefined`
  (trim on save; empty/whitespace → `undefined` → db coalesces to SQL NULL); return
  type widened with `orderCode?: string`.
- New `handleVendorOrderCodeChange(vendorId, value)` — plain single-link patch (free
  text, no numeric guard, no derived recompute).
- The per-vendor card (`:1207`) gains a THIRD `InputLine` (order code), keyed on
  `row.vendorId`, free-form (not numericOnly/readOnly), label+help from
  `section.inventory.orderCodeLabel/orderCodeHelp`. **The obsolete item-level
  `values.vendorSku` stub (`:1283`) is UNTOUCHED (OQ-4).**

**src/components/cmd/IngredientFormDrawer.tsx**
- `fromItem` hydration — both `it.vendors` branches add `orderCode: v.orderCode || ''`;
  the scalar-fallback branch sets `orderCode: ''` (AC-5 round-trip on reopen).
- `ItemUpdatesWithVendors` `vendors` payload type widened with `orderCode?: string`.

**src/screens/cmd/sections/POsSection.tsx** (Slice 2 — quick-order export)
- Import `buildPoQuickOrderText`.
- New `onShareQuickOrder` handler, sibling to `onShare`, gated by the same `canShare`
  (`draft`/`sent`/`partial`). `resolveCode` closes over `inventory` + `sel.vendorId`
  (`row.vendors.find(v => v.vendorId === sel.vendorId)?.orderCode`); `resolveName`
  identical to `onShare`'s. Hands the block to the EXISTING `sharePurchaseOrder`
  verbatim, sets the shared `sharePreview` pane from `previewText`. On
  `unmappedCount > 0` fires a warning Toast. **DELIBERATE DIVERGENCE (D-8): NO
  mark-sent "did you send it?" auto-prompt on this path** — it is a copy-the-codes aid,
  not a send.
- Second, textually + visually distinct button (`testID="po-action-quick-order"`,
  outlined secondary) next to the accent Share in the PO detail action row.

**src/store/useStore.ts** (frontend half — action signatures)
- `addItem` / `updateItem` `vendors?` param types extended with `orderCode?: string`
  (the optimistic `linkSet.map` bodies were patched by the backend-developer in the same
  file — the two halves converge cleanly, both tagged spec 114).

**i18n (×3 — en / es / zh-CN)**
- `section.inventory.orderCodeLabel` + `orderCodeHelp` (Slice 1 field label + help).
- `section.purchaseOrders.quickOrderAction` + `quickOrderDialogTitle` +
  `quickOrderCopiedToast` + `quickOrderUnmappedWarning` (Slice 2). Real es/zh
  translations. The paste block itself is NOT localized (machine-facing, OQ-8); the
  quick-order preview reuses the existing shared `sharePreviewLabel` pane (no new
  preview key).

**Tests (jest)**
- `src/utils/poQuickOrderText.test.ts` (new, 15 cases) — byte-for-byte: mapped
  `<code>\t<qty>`, unmapped `??? <name>\t<qty>` + correct `unmappedCount`, TAB delimiter,
  code trim, locale-resolved placeholder name, NO `$`, empty-input edge.
- `src/components/cmd/IngredientForm.test.ts` — new spec-114 suite (orderCode per-card
  isolation via `updateVendorLinkField`; `vendorRowsToLinkPayload` trims + empty→undefined
  + per-vendor independence + round-trip payload shape). Existing spec-102 `VendorLinkRow`
  literals updated with `orderCode: ''` (type-forced by the new required field).
- `src/screens/cmd/sections/__tests__/POsSection.test.tsx` — new spec-114 suite (quick-order
  visibility gate matches Share; the handler hands `sharePurchaseOrder` a bare
  `<code>\t<qty>` block with `??? <name>` for unmapped lines and NO `$`; unmapped-count
  warning toast fires; **NO mark-sent prompt on draft — the divergence**; no warning when
  all mapped; desktop-web preview pane renders from `previewText`).

**Verification:** `npx tsc --noEmit` + `npx tsc -p tsconfig.test.json --noEmit` both exit
0; full `npx jest` green (93 suites / 1062 tests, incl. the new spec-114 coverage).
Browser pass deferred to main Claude (preview tools unavailable to this subagent) — see
the handoff's browser-verify note.
