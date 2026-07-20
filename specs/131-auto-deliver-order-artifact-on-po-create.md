# Spec 131: Expose the pending-PO order payload for the browser-extension cart-filler (BJ's / Sam's Club)

Status: READY_FOR_REVIEW

> **Origin + this session's owner scope change (binding — do NOT re-litigate):**
> Spec 131 was originally "auto-prepare the vendor order artifact on PO create and
> DELIVER it to the operator via push + email." **This session the owner KILLED the
> delivery arm.** Owner reasoning, verbatim: *"if i need to login to bjs and sams
> clubs that's mean i dont need a message anymore."* The ordering flow is becoming a
> **Chrome extension** that acts in the admin's OWN logged-in browser session on
> `bjs.com` / `samsclub.com` (spec 132). Because the same admin who creates the PO
> is the one who opens the vendor site to pay, a push/email notification is
> **redundant** — the PO itself IS the pending order, and the extension picks it up
> when the admin lands on the vendor site.
>
> **What this spec now is:** the BACKEND half — expose a pending PO's order payload
> (structured, not just a text blob) to an authenticated browser extension, define
> what "pending" means, and provide a mark-as-ordered write-back. The extension
> that CONSUMES this payload is **spec 132**. This spec builds nothing that logs
> into or acts on a vendor site.
>
> **Binding vendor research (verified 2026-07, memory
> `project_vendor_ordering_integration.md`, extended this session):**
> - No buyer-side ordering API exists for BJ's, Sam's Club, US Foods, Sysco, or
>   Webstaurant. Confirmed again this session.
> - **Sam's Club** has a real **"Reorder for Pickup using a List"** page that
>   accepts an **Excel list upload** — exact accepted format UNVERIFIED, needs the
>   owner's logged-in account to confirm (carried forward as OQ-6).
> - **BJ's (`bjs.com`) has NO quick-order or item-number entry at all** — only
>   order-history reorder, saved shopping lists, and a separate **$5k-minimum B2B
>   program**. So for BJ's there is no paste/upload target; the extension (spec 132)
>   fills the cart via the site UI. This spec exposes the structured lines the
>   extension needs to do that.

## What already exists (this spec composes it, does not rebuild it)

- **The artifact builder (KEPT)** — `src/utils/poQuickOrderText.ts`
  `buildPoQuickOrderText(lines, resolveCode, resolveName, orderUnit)` (spec
  114/115): a pure function that emits the paste-ready `<order code>\t<qty>` block,
  order-unit-aware (`case` vs `unit`, ceil-to-cases, `roundedCount`), with `??? <name>`
  placeholders and an `unmappedCount`. This spec RETAINS it for the human-readable /
  Sam's-list-paste text-blob use, but the extension's primary need is the
  **structured** lines behind it (see AC-4).
- **Per-vendor order data** — `item_vendors.order_code` (spec 114) and
  `vendors.order_unit` (spec 115) — the per-(item,vendor) order code and the vendor's
  counting unit that feed both the text blob and the structured payload.
- **The PO-create trigger point** — `createPoDraft` (`src/store/useStore.ts`) →
  `db.createPurchaseOrderDraft` (`src/lib/db.ts`), invoked from the Reorder vendor
  card's "+ CREATE PO" button (spec 107/123). Spec 123 made that button persist as
  "PO CREATED" keyed on `(store, vendor, reference_date)`. The created draft PO IS
  the pending order.

## What this revision CUTS (was in the prior 131 design; removed by the owner ruling)

- **The push notification arm** — no web push on PO create. The admin is already at
  the vendor site; a push is redundant (owner ruling). No reuse of the spec-120
  `submission-push-fanout` path for this feature.
- **The email arm** — no Resend edge function, no HTML email body, no `escapeHtml`
  email-template requirement, no per-recipient (creator) email resolution.
- **The delivery edge function** entirely (the prior `deliver-order-artifact`) and
  its `artifact_delivered_at` delivery-idempotency marker, its idempotency/
  delivery-failure ACs, and the "delivery never blocks PO create" posture — all
  removed. There is no side-band delivery to fail.

## User story

As a **store manager** who orders from **BJ's / Sam's Club**, when I create a
purchase order for that vendor and then open the vendor's website (logged into my
own account) to place the order, I want my browser extension to be able to read
that PO's exact order lines — each item's vendor order code, name, quantity, and
whether it's counted in cases or units — and mark the PO as ordered once I've put
it in the cart, so the PO I already created drives the cart-fill and I never
re-type the order by hand.

Sub-stories:

- **US-1 (opt a vendor into extension ordering).** As an admin, I turn on a
  per-vendor "extension ordering" flag for my BJ's and Sam's vendors so only those
  vendors' draft POs are picked up by the extension.
- **US-2 (per-vendor order page).** As an admin, I record each vendor's order page
  URL (BJ's landing / Sam's "Reorder for Pickup using a List") so the extension
  knows which page a pending PO belongs to.
- **US-3 (structured pending order, read authenticated).** As my extension (acting
  as me), I read the structured order payload for a pending PO — per line: vendor
  order code, item name, quantity, unit — using my own authenticated session, so I
  can fill the cart. I can only read POs for stores I can see.
- **US-4 (mark ordered).** As my extension (or as the admin), once the cart is
  filled I mark the PO ordered, so it drops out of the pending set and isn't picked
  up again.

## Acceptance criteria

Vendor opt-in + order page (data):

- [ ] **AC-1 (per-vendor extension-ordering opt-in).** `public.vendors` gains a new
  additive boolean column (PM recommends `extension_ordering`, renamed from the
  prior `auto_deliver_order` to reflect that the consumer is now a browser
  extension, not a delivery channel) — `NOT NULL DEFAULT false`. It is editable in
  the vendor editor (`VendorFormDrawer`), persists via the existing `createVendor` /
  `updateVendor` path, and round-trips (reopen shows the saved value). Default OFF →
  no behavior change for existing vendors. The owner turns it ON for the BJ's and
  Sam's vendors. Inherits the existing `vendors` RLS unchanged (privileged UPDATE via
  `privileged_update_vendors`, spec 115 §0 — no new policy).
- [ ] **AC-2 (per-vendor order-page URL).** `public.vendors` gains a new additive
  nullable `order_page_url text` column, editable in `VendorFormDrawer`, persisting
  through the same path and round-tripping. BJ's → its site landing / order page;
  Sam's → its "Reorder for Pickup using a List" page. Nullable; absent → the payload
  still exposes the PO, just without a page URL.

Pending set (definition):

- [ ] **AC-3 (definition of "pending").** A PO is **pending** for extension pickup
  iff ALL of: (a) its `status` is `draft` (it has not been marked ordered — AC-6);
  AND (b) its vendor's `extension_ordering` flag is `true`. A PO whose vendor is
  opted-out, or a PO already marked ordered, is NOT pending and MUST NOT appear in
  the pending set. The pending set is scoped to stores the caller can see
  (`auth_can_see_store`).

Structured payload (the extension's primary need):

- [ ] **AC-4 (structured order payload — NOT just a text blob).** The backend
  exposes, for a pending PO, a **structured** order payload the extension consumes:
  vendor identity (`vendorId`, vendor `name`, `order_page_url`, `order_unit`), the
  PO id, and an array of lines where **each line carries the item's vendor order
  code (`order_code` from the item's `item_vendors` link for that vendor), the item
  name, the quantity, and the unit (`case`/`unit`)** — structured fields, not a
  single joined string. A line whose item has no order code for that vendor is
  surfaced explicitly (e.g. a null/empty `orderCode` + the item name), never
  silently dropped, so the extension can report the gap. The read is authenticated
  and respects `auth_can_see_store` — a caller can only read payloads for POs in
  stores they can see. **Where/how the payload is exposed — a scoped PostgREST read
  over the existing tables, or a dedicated RPC — is an architect decision (OQ-1);
  this AC pins the REQUIRED shape and the auth boundary, not the mechanism.**
- [ ] **AC-5 (text artifact retained, byte-identical).** The `buildPoQuickOrderText`
  paste block (spec 114/115) remains available for the Sam's-list-paste / human
  fallback and MUST stay byte-identical to what the manual "Quick-order list" button
  produces for the same PO (no forked builder). The structured payload (AC-4) and
  this text blob are two views of the SAME order-unit-aware lines — the quantity /
  case-conversion / `orderCode` resolution logic is shared, not re-derived
  divergently. The quick-order casing (`case` → ceil-to-cases via `order_unit`) that
  spec 115 applies to the text blob applies identically to the structured `qty`.

Mark ordered (write-back):

- [ ] **AC-6 (mark-as-ordered write-back).** An authenticated write the extension
  (or the admin in-app) calls marks a pending PO as **ordered**, removing it from the
  pending set (AC-3) so it is not picked up again. The write respects
  `auth_can_see_store` (a caller cannot mark a PO ordered in a store they can't see)
  and is idempotent (marking an already-ordered PO is a no-op, not an error). **The
  exact mechanism — reuse the existing `status` → `sent` transition (spec 120/123)
  vs a new `ordered_at timestamptz` marker — is an architect decision (OQ-2); this AC
  pins the observable (a marked PO leaves the pending set, idempotent, store-scoped),
  not the column.**

Boundary:

- [ ] **AC-7 (never checks out, never pays — the softened invariant).** The prior
  "never auto-orders" invariant softens to: **the I.M.R backend and every surface it
  exposes NEVER check out, submit payment, or complete an order on a vendor site.**
  Cart PREPARATION is now allowed — but it happens exclusively in the admin's OWN
  browser session via the spec-132 extension, NOT via any server-side automation.
  Nothing in THIS spec logs into, navigates, fetches, or submits anything on a vendor
  site; it exposes data and accepts a mark-ordered write. No stored vendor
  credentials, no headless browser, no server-side vendor-site fetch.

i18n:

- [ ] **AC-8 (i18n ×3).** Every new user-visible string — the vendor-editor
  extension-ordering control + its help, the order-page-URL field label + help, and
  any in-app mark-ordered affordance copy — is authored in all three locales
  (en / es / zh-CN) in the admin catalog (`src/i18n/*.json`, `section.*`). The
  structured payload and the machine paste-block are machine-facing and NOT localized
  (spec 114 OQ-8); an item NAME surfaced in a gap resolves in the caller's locale via
  the same `getLocalizedName` path spec 114 uses.

## In scope

- Two additive `public.vendors` columns: `extension_ordering boolean not null
  default false` (AC-1) and `order_page_url text` (AC-2), edited in
  `VendorFormDrawer`, threaded through `db.ts` `fetchVendors` / `createVendor` /
  `updateVendor` and the `Vendor` type.
- A definition of the **pending** PO set (AC-3: draft + opted-in vendor + store-
  visible) and a backend surface that exposes each pending PO's **structured** order
  payload (AC-4), authenticated and `auth_can_see_store`-scoped. Mechanism (scoped
  PostgREST read vs RPC) is the architect's call (OQ-1).
- Retention of the `buildPoQuickOrderText` text-blob artifact, byte-identical to the
  manual Quick-order button, sharing the order-unit-aware line logic with the
  structured payload (AC-5).
- A **mark-as-ordered write-back** (AC-6), store-scoped and idempotent; mechanism
  (status→sent vs new `ordered_at`) is the architect's call (OQ-2).
- i18n ×3 for all new admin-surface strings (AC-8).
- Tests on the matching tracks (named under Project-specific notes).

## Out of scope (explicitly)

- **Push + email delivery — CUT this session (owner ruling).** No web push on PO
  create, no Resend email, no HTML email template / `escapeHtml` email requirement,
  no delivery edge function, no delivery-idempotency marker, no per-recipient
  resolution. Rationale: the admin is already at the vendor site; a notification is
  redundant. This is the core of the revision.
- **The Chrome extension itself — that is spec 132.** This spec is the backend
  contract the extension reads/writes against. The cart-fill mechanics, item
  matching per vendor, dry-run mode, and the MV3 build artifact live in spec 132.
- **Auto-checkout / payment / completing an order on a vendor site.** Never. Cart
  preparation is allowed (spec 132), but only in the admin's own browser session and
  never server-side (AC-7).
- **Vendor-specific file FORMATS shipped in this increment.** The exact format Sam's
  "Reorder for Pickup using a List" accepts is UNVERIFIED and needs an owner
  live-account check (OQ-6); a vendor-verified Sam's/BJ's upload file is a follow-up
  on top of this payload plumbing. The retained text blob + `order_page_url` get the
  operator to the page; the extension fills the cart from the structured payload.
- **US Foods / Sysco vendors.** Their file export already exists (spec 116/117). This
  spec's `extension_ordering` targets the BJ's / Sam's paste-block vendors the owner
  named. Extending to US Foods/Sysco is a follow-up.
- **Changing the manual "Quick-order list" button (spec 114), the "PO CREATED"
  button state (spec 123), the reorder engine, receiving, or the human-readable
  spec-108 vendor Share.** Untouched.
- **Auto-creating vendors or auto-populating order codes.** A missing code surfaces
  as an explicit gap in the payload (AC-4), not a silent fix.
- **The `app.json` slug, identity drift, and the repo-root spreadsheet** — untouched
  (CLAUDE.md load-bearing / DO-NOT-AUTO-FIX).

## Open questions resolved / carried to the architect

The owner ruled the shape (cut delivery; expose a structured pending-PO payload for
an extension). Remaining mechanism items are for the architect.

- **OQ-1 — [FOR ARCHITECT] How is the structured payload exposed?** A scoped
  PostgREST read over `purchase_orders` + `po_items` + `item_vendors` + `vendors`
  (relying on existing RLS to bound it to visible stores), OR a dedicated
  `SECURITY DEFINER` RPC that returns the assembled pending set / a single PO's
  payload. PM leans a **read RPC** (e.g. `get_pending_extension_orders()` +
  `get_extension_order_payload(po_id)`) because the pending predicate (draft +
  `extension_ordering` + store-visible) and the per-line `order_code`/`order_unit`
  join are non-trivial and better assembled server-side than reconstructed in the
  extension — but a scoped PostgREST embed is acceptable if the architect prefers.
  **Pin: whatever the mechanism, the auth boundary is `auth_can_see_store` and the
  shape is AC-4's structured lines.**
- **OQ-2 — [FOR ARCHITECT] Mark-ordered mechanism.** Reuse the existing PO
  `status` → `sent` transition (spec 120/123 already move POs to `sent`), OR add a
  dedicated additive `ordered_at timestamptz` on `purchase_orders`. PM leans reusing
  `status = 'sent'` if it cleanly means "no longer a draft to pick up" and does not
  collide with the reorder/receiving lifecycle; else a distinct `ordered_at` avoids
  overloading `status`. **Pin the observable (AC-6), not the column.**
- **OQ-3 — [FOR ARCHITECT] Extension authentication to the backend.** The extension
  reads/writes as the admin. Does it ride the owner's existing Supabase session
  (token surfaced to the extension from the web app), or a scoped token minted for
  the extension? This intersects spec 132's auth OQ — resolve consistently across
  both specs. **Flagged; do not ship the read/write surface until the architect fixes
  the extension's auth path** (must remain `auth_can_see_store`-bounded either way).
- **OQ-4 — column name for the opt-in flag.** PM recommends `extension_ordering`
  (renamed from `auto_deliver_order`). Architect confirms.
- **OQ-5 — recipient / notification.** RESOLVED: none. No delivery, no recipient.
- **OQ-6 — [FLAGGED, owner live-account gate] Sam's list-upload file format.** Not
  shipped here; the exact columns Sam's "Reorder for Pickup using a List" accepts
  need an owner logged-in check. Carried forward for spec 132 / a follow-up.
- **OQ-7 — `app.json` slug.** Untouched (CLAUDE.md load-bearing). No push cert / build
  identifier work in this revision.

## Dependencies

- **Spec 114 (live)** — `item_vendors.order_code`
  (`supabase/migrations/20260708000000_item_vendor_order_code.sql`), the pure builder
  `src/utils/poQuickOrderText.ts` `buildPoQuickOrderText`, `getLocalizedName`. The
  structured payload's per-line `orderCode` + the retained text blob both derive from
  here.
- **Spec 115 (live)** — `vendors.order_unit`
  (`supabase/migrations/20260709000000_vendor_order_unit.sql`) + the order-unit-aware
  qty / `roundedCount`. The structured payload's `qty` + `unit` and the text blob
  share this conversion (AC-5).
- **Spec 107 (live)** — `db.createPurchaseOrderDraft`, `createPoDraft`, and the
  `store_member_*_purchase_orders` RLS (spec 107 §0) the payload read + mark-ordered
  write inherit.
- **Spec 123 (live)** — the "+ CREATE PO" → "PO CREATED" flow keyed on
  `(store, vendor, reference_date)`; the draft PO that becomes the pending order.
- **Spec 132 (this session, new)** — the browser-extension cart-filler that CONSUMES
  the AC-4 payload and calls the AC-6 write-back. 131 is the backend contract; 132 is
  the consumer. The OQ-3 auth decision spans both.
- **A new migration (expected)** — the two additive `vendors` columns
  (`extension_ordering`, `order_page_url`), no backfill, inheriting the privileged
  `vendors` RLS (spec 115 §0); plus, if OQ-2 resolves to a marker column, an additive
  `purchase_orders.ordered_at`. If OQ-1 resolves to an RPC, the `SECURITY DEFINER`
  read function(s). Prod-apply via Supabase MCP + exact `schema_migrations` insert
  (spec 064 gate); developer FLAGS the prod-apply, does not push it.
- **`src/components/cmd/VendorFormDrawer.tsx`** + `db.ts` `fetchVendors` /
  `createVendor` / `updateVendor` + the `Vendor` type — thread `extension_ordering`
  and `order_page_url` (AC-1/AC-2).
- **i18n catalogs** — `src/i18n/{en,es,zh-CN}.json` `section.*` — the new
  vendor-editor + mark-ordered strings ×3 (AC-8).

## Project-specific notes

- **Cmd UI section / legacy:** the vendor-editor controls land in the existing
  `VendorFormDrawer` (admin Cmd UI). Any in-app mark-ordered affordance rides the
  existing PO surface. No new section; no legacy admin surface (spec 025 deleted it).
- **Which app:** this repo, **admin Cmd UI only** — the vendor settings + the PO the
  extension reads. The **consumer is a browser extension (spec 132)**, a separate
  build artifact. **No staff app change, no customer PWA change.**
- **Per-store or admin-global:** MIXED. The vendor settings (`extension_ordering`,
  `order_page_url`, `order_unit`) are **brand-level** (`vendors` is brand-scoped;
  privileged UPDATE via `auth_is_privileged() AND auth_can_see_brand` — spec 115 §0).
  The PO + `po_items` + the pending set + the mark-ordered write are **per-store**
  (`auth_can_see_store` — spec 107 §0). The payload read and the write-back MUST both
  stay `auth_can_see_store`-bounded.
- **Edge function or PostgREST:** the vendor-setting read/write is plain PostgREST via
  `db.ts`. The pending-payload read + the mark-ordered write are a scoped PostgREST
  read/RPC (OQ-1/OQ-2) — **NOT** a `staff-*` / service-token / `pwa-catalog` surface.
  **No Resend/email/push edge function** (cut this session). If OQ-1 is an RPC, it is
  JWT-authenticated (the admin's session), `SECURITY DEFINER` with an internal
  `auth_can_see_store` check.
- **Realtime channels touched:** `brand-{id}` for the vendor columns (`vendors` is
  already in `supabase_realtime` — spec 115 §0, so adding columns needs no publication
  change; the `docker restart` gotcha does NOT apply — flag as an ABSENCE). The
  mark-ordered write replays on `store-{id}` if it flips `purchase_orders` state
  (already published). No new channel.
- **Migrations needed:** **yes** — the two additive `vendors` columns; optionally an
  additive `purchase_orders.ordered_at` (OQ-2) and an RPC (OQ-1). Additive, no
  backfill, no policy/publication change for the vendor columns. Prod-apply via
  Supabase MCP + `schema_migrations` insert (spec 064 gate).
- **Never-check-out invariant (flag for reviewers):** AC-7. No code path in THIS
  repo may authenticate to, fetch, or submit anything on a vendor site. Cart prep is
  the extension's job (spec 132), in the admin's own session. Any dependency implying
  a server-side vendor-site fetch or stored vendor credentials is a scope violation.
- **Extension auth (flag for architect + security):** OQ-3 — the extension's read/
  write must stay `auth_can_see_store`-bounded. Do not expose an unauthenticated or
  service-token surface for extension reads.
- **Edge functions touched:** none new (the delivery edge function is CUT). Possibly
  a read RPC (OQ-1) — a DB function, not an edge function.
- **Web/native scope:** the vendor-editor controls render on the admin Cmd surface
  (web + native). The consuming extension is **web/Chrome only** (spec 132). No push,
  so no web-vs-native push split.
- **`app.json` slug:** untouched — no push cert / build-identifier work in this
  revision (OQ-7). `slug` stays `towson-inventory` pending explicit approval.
- **Test tracks (spec 022):**
  - **jest:** (a) the structured payload assembler produces AC-4's per-line shape
    (orderCode / name / qty / unit) with case-conversion identical to the text blob
    (AC-5), and surfaces an unmapped line explicitly rather than dropping it; (b) the
    pending predicate (draft + `extension_ordering` → pending; opted-out or ordered →
    not pending); (c) the mark-ordered write is idempotent.
  - **pgTAP:** the two new `vendors` columns exist with the right default/type and
    inherit the privileged `vendors` UPDATE RLS (a non-privileged caller cannot set
    `extension_ordering` / `order_page_url`) — extend
    `supabase/tests/vendors_role_access.test.sql`. If OQ-1 is an RPC or OQ-2 adds
    `ordered_at`: a test that the payload read / mark-ordered write is bounded by
    `auth_can_see_store` (a non-member cannot read another store's pending PO or mark
    it ordered).
  - **shell smoke:** optional — a curl round-trip of the read RPC / mark-ordered write
    against a fixture PO if OQ-1/OQ-2 land as functions.

## Handoff
next_agent: backend-architect
prompt: Design the contract for the REVISED spec 131. The delivery arm (push +
  email + Resend + escapeHtml email template + delivery edge function) is CUT — do
  not design it. Fix the carried mechanism items: (OQ-1) how the pending-PO
  structured payload is exposed (scoped PostgREST read vs a SECURITY DEFINER read
  RPC — PM leans an RPC pair for the pending set + a single PO payload), keeping the
  AC-4 structured shape (orderCode / item name / qty / unit + vendor name +
  order_page_url) and the auth_can_see_store boundary; (OQ-2) the mark-ordered
  write-back mechanism (reuse status→sent vs a new additive purchase_orders.ordered_at)
  keeping AC-6's idempotent, store-scoped observable; (OQ-3) the extension's auth path
  to the backend (Supabase session vs scoped token) — resolve consistently with spec
  132; (OQ-4) confirm the vendors opt-in column name (PM recommends extension_ordering).
  Pin the two additive vendors columns (extension_ordering, order_page_url) inheriting
  the privileged vendors RLS with no publication change, define "pending" (AC-3), and
  keep the buildPoQuickOrderText text blob byte-identical to the manual button while
  sharing the order-unit-aware line logic with the structured payload (AC-5). Enforce
  AC-7 (never checks out / pays; cart prep is spec 132's extension in the admin's own
  session, never server-side). Then set Status: READY_FOR_BUILD.
payload_paths:
  - specs/131-auto-deliver-order-artifact-on-po-create.md
  - specs/132-browser-extension-cart-filler.md

---

## Backend design

Read `CLAUDE.md`, this spec + spec 132 in full, and the load-bearing code:
`buildPoQuickOrderText` (`src/utils/poQuickOrderText.ts`, spec 114/115 — the
pure, order-unit-aware builder), the `vendors` db.ts threading
(`fetchVendors` `:1880`, `createVendor` INSERT `:1922`, `updateVendor`
`dbUpdates` `:3179`), the `Vendor` type (`src/types/index.ts:451`), the
`vendors` RLS (`20260709000000_vendor_order_unit.sql` header — the applied
policy state), the PO lifecycle (spec 107 §1 status vocabulary + `markPurchaseOrderSent`
§7), the spec-120 submission-notification trigger
(`20260715000000_submission_notifications.sql` — the `po` notification fires on
transition INTO `status='sent'`), and the `item_vendors` store RLS (spec 114).

**The four carried mechanism items, fixed.**
- **OQ-1 → a SECURITY INVOKER read-RPC pair** (`get_pending_extension_orders`,
  `get_extension_order_payload`), NOT a scoped PostgREST embed. Rationale D-3.
- **OQ-2 → reuse the `status` → `'sent'` transition** (a guarded `draft → sent`
  PostgREST UPDATE), NOT a new `ordered_at` column. This is the decisive call —
  it ALSO closes the spec-107 reorder loop, and it deliberately fires the
  spec-120 `po` notification. Rationale D-5.
- **OQ-3 → the extension embeds `supabase-js` and authenticates as the admin via
  the existing email+password Supabase auth**, session in `chrome.storage.local`,
  RLS-bounded exactly as the admin's web session — no service key, no new
  token-minting backend, no cross-origin token theft. Resolved identically in
  spec 132 OQ-1. Rationale D-6.
- **OQ-4 → the opt-in column is `extension_ordering`** (confirmed).

This spec builds nothing that logs into, fetches, or submits on a vendor site
(AC-7). The delivery arm (push/email/Resend/`escapeHtml`-email/delivery edge
function) is CUT and is NOT designed here.

### D-1. The AC-4 / AC-5 / 132-AC-6 reconciliation (read FIRST — it drives every other decision)

The three specs frame the case-conversion of the payload qty slightly
differently, and the naive readings collide. Resolved as follows, toward the
**load-bearing invariant: ONE canonical case-math implementation, no forked
builder** (131 AC-5, "not re-derived divergently"):

1. **The backend read surface (the RPC, D-3) returns the RAW structured
   ingredients per line** — `orderCode` (from `item_vendors.order_code`, null
   when unmapped), `itemName`, `orderedQty` (COUNTED units, verbatim
   `po_items.ordered_qty`), `orderUnit` (`case`/`unit`, from `vendors`),
   `caseQty` (from `inventory_items`), and `productPageUrl` (D-2). It does **NOT**
   re-implement the counted-unit → whole-case ceil in SQL. Re-implementing it in
   SQL would be a SECOND implementation of `buildPoQuickOrderText`'s spec-115
   logic — exactly the "forked builder" AC-5 forbids.
2. **The order-unit case conversion is applied by the SHARED pure builder**
   `src/utils/poQuickOrderText.ts`. It is already pure by design (spec 114 D-9:
   "no React / theme / supabase / i18n import; resolvers injected") — that purity
   was authored precisely so a second consumer can reuse it. The extension
   (spec 132), which lives in-repo (`extension/`, spec 132 OQ-4), **imports this
   exact file**. So the Expo `POsSection` quick-order button AND the extension
   run the same bytes. This is the single implementation AC-5 requires.
3. **Refactor (additive, non-breaking): extract a structured-line core** from
   `buildPoQuickOrderText` so both the text blob AND the structured payload derive
   from it (see D-8). `buildPoQuickOrderText`'s existing signature + byte-for-byte
   text output are UNCHANGED (AC-5's "byte-identical to the manual button" holds).

**Reconciliation ruling for reviewers:** 131 AC-4's "the quantity" is exposed by
the RPC as the raw `orderedQty` + the `orderUnit`/`caseQty` needed to convert it;
131 AC-5's "structured qty" (case-converted) and 132 AC-6's "already in the
payload" are both satisfied by the shared builder materializing the converted qty
at the extension's entry point, BEFORE any matching/cart-fill code runs. The
extension therefore authors NO case math of its own (132 AC-6 honored in
substance) — it delegates to spec-115's shared builder. This is a deliberate
interpretation and is flagged so a reviewer does not read 132 AC-6 as "the RPC
must ceil in SQL" (which would fork the builder — rejected).

### D-2. Data model changes

**One migration, three additive columns, two RPCs.** Filename
`supabase/migrations/20260720000000_extension_ordering.sql` — verified next free
slot (latest on disk is `20260719000000_auto_receive_due_purchase_orders.sql`).
Wrap `begin; … commit;`. All DDL is additive/metadata-only (instant on PG 17), no
backfill, reversible-by-design.

**Column 1 — `public.vendors.extension_ordering` (AC-1, OQ-4):**
`boolean not null default false`. Default OFF → zero behavior change for existing
vendors; the owner flips it ON for the BJ's / Sam's vendors. Brand-level
(`vendors` is brand-scoped).

**Column 2 — `public.vendors.order_page_url` (AC-2):** `text` (nullable). BJ's
landing / Sam's "Reorder for Pickup using a List" page. Nullable → absent leaves
the payload exposed without a page URL. Also carries the **vendor↔site-origin
join** spec 132 needs (132 OQ-5): the extension matches the current tab origin to
`new URL(order_page_url).origin` — no separate origin field needed.

**Column 3 — `public.item_vendors.product_page_url` (text, nullable) — the
spec-132 OQ-2 robust BJ's fallback, speced additively here.** Per-(item, vendor)
direct product-page link. Nullable, no backfill, no owner data-entry burden for
v1: the extension PREFERS a non-null `product_page_url` (direct navigate) and
FALLS BACK to per-vendor search when null (spec 132 D-3). Adding the (cheap,
nullable) column now avoids a second migration + prod-apply when the owner starts
populating URLs incrementally after live testing. **Wiring an editor field for it
(in `IngredientForm`'s per-vendor card, sibling to spec-114's `order_code` input)
is a spec-132 / follow-up FRONTEND task — flagged, not built in 131.** For v1 the
column is populated by direct DB / a later editor field; the extension consumes it
when present.

**RLS inheritance (all three columns — zero policy change):**
- `vendors.extension_ordering` / `order_page_url` inherit the privileged
  `vendors` policies verbatim (spec 115 §0): `brand_member_read_vendors` (SELECT,
  `auth_can_see_brand`), `privileged_update_vendors` (UPDATE,
  `auth_is_privileged() AND auth_can_see_brand`, USING + WITH CHECK),
  `privileged_insert_vendors` / `privileged_delete_vendors`. Row-level policies
  are column-agnostic → a non-privileged member CANNOT set `extension_ordering`
  or `order_page_url` the instant the columns exist. **No new policy, identical
  posture to spec 115's `order_unit`.**
- `item_vendors.product_page_url` inherits the four `store_member_*_item_vendors`
  policies (spec 114) — `auth_can_see_store(ii.store_id)` via the
  `item_id → inventory_items.store_id` parent join. Column-agnostic → gated the
  instant it exists. No new policy.
- **Grants:** table-level grants extend to every column (spec-097 explicit-grants
  migration) — no grant hunk, no leak.
- **spec-053 permissive-policy lint:** no policy added → no allowlist edit; stays
  green untouched.

### D-3. API contract — the pending-payload read (OQ-1: RPC pair, SECURITY INVOKER)

**A SECURITY INVOKER read-RPC pair, NOT a scoped PostgREST embed.** Rationale: the
per-line join is `po_items → inventory_items → item_vendors` filtered by a value
from the PARENT (the PO's `vendor_id`) — PostgREST embedding cannot filter a
nested embed by a parent-row column, so a PostgREST read would force the extension
to reconstruct the resolver (duplicating `db.ts`'s `onShare` code) and would leak
whole `item_vendors` rows. The RPC assembles the join server-side and returns
clean structured lines. `SECURITY INVOKER` (matching the reorder / `receive_purchase_order`
RPCs, NOT the staff `DEFINER` RPCs) + `set search_path = public` → the caller's
RLS on `purchase_orders`/`item_vendors`/`vendors` already bounds every read to
`auth_can_see_store` / `auth_can_see_brand` visible rows.

```sql
-- RPC 1: the pending set (AC-3). Optionally filtered to one vendor (spec 132
-- resolves the vendor from the site origin first, or passes NULL for "all").
create or replace function public.get_pending_extension_orders(
  p_vendor_id uuid default null
) returns jsonb                     -- jsonb array
language sql
security invoker
set search_path = public
as $$
  -- Per pending PO: { poId, storeId, vendorId, vendorName, orderPageUrl,
  --   orderUnit, lineCount, unmappedCount }. "Pending" (AC-3) = status='draft'
  --   AND vendors.extension_ordering. RLS bounds to auth_can_see_store /
  --   auth_can_see_brand. p_vendor_id NULL → all opted-in vendors' pending POs.
  … select over purchase_orders po join vendors v on v.id = po.vendor_id
     where po.status = 'draft' and v.extension_ordering
       and (p_vendor_id is null or po.vendor_id = p_vendor_id) …
$$;
```

```sql
-- RPC 2: one PO's full structured lines (AC-4). Explicit store gate
-- (belt-and-suspenders + clean error, mirroring receive_purchase_order §3).
create or replace function public.get_extension_order_payload(
  p_po_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
  -- (1) resolve store + vendor; raise P0002 if not found (RLS may hide it).
  -- (2) if not auth_can_see_store(store_id) raise 42501.
  -- (3) return {
  --   poId, storeId, vendorId, vendorName, orderPageUrl, orderUnit,
  --   lines: [ { itemId, itemName, orderCode /* item_vendors.order_code, NULL
  --     when unmapped — NEVER dropped (AC-4) */, orderedQty /* COUNTED units,
  --     verbatim po_items.ordered_qty — NOT case-converted here (D-1) */,
  --     caseQty /* inventory_items.case_qty */, productPageUrl /* item_vendors,
  --     nullable */ } ... ]
  -- }
$$;
```

**Auth boundary (both RPCs):** `auth_can_see_store` (PO/lines) + `auth_can_see_brand`
(vendor) via INVOKER RLS; RPC 2 adds the explicit gate. A caller reads ONLY
payloads for POs in stores they can see (AC-4). **GRANT execute … to authenticated;
REVOKE … from public, anon** (mirror the reorder RPCs). NOT a `staff-*` /
service-token / `pwa-catalog` surface (AC per Project notes).

**Error cases:** RPC 2 → `P0002` (PO not found / RLS-hidden), `42501` (store not
visible). RPC 1 → never errors; an empty pending set is `[]`. A line with no
`order_code` returns `orderCode: null` + the `itemName` (AC-4 — surfaced, never
dropped; the extension reports the gap, spec 132 AC-5).

**These RPCs are consumed by the EXTENSION, not the Expo app** — the app already
has POs + `item_vendors` in memory (the `inventory` slice). So `src/lib/db.ts`
gains NO wrapper for them; the extension calls them via its own `supabase-js`
client (a carve-out analogous to the `src/screens/staff/` subtree — a separate
bundle that legitimately talks to Supabase outside `db.ts`). Flagged in D-7.

### D-4. API contract — mark-as-ordered write-back (AC-6, OQ-2 → status → 'sent')

**Reuse the `status` `draft → 'sent'` transition — NOT a new `ordered_at`
column.** The mark-ordered write is a **guarded PostgREST UPDATE** (no new RPC, no
new migration), mirroring spec 107 §7's `markPurchaseOrderSent`:

```
update purchase_orders set status = 'sent' where id = :poId and status = 'draft'
```

- **Store-scoped:** `store_member_update_purchase_orders` (spec 107 §0) bounds it
  to visible stores — a caller cannot mark a PO ordered in a store they can't see
  (AC-6). RLS denial / invisible row → 0 rows, no leak.
- **Idempotent (AC-6):** the `and status = 'draft'` guard makes a re-mark a 0-row
  no-op (already `sent` → nothing to do), and CANNOT resurrect a `received` /
  `cancelled` / `partial` PO back to `sent`. No error either way.

**Why status→'sent' is the DECISIVE choice over an `ordered_at` marker:** a PO
marked ordered but LEFT in `status='draft'` (the `ordered_at`-column option) would
NOT be counted by the spec-107 reorder `pending_po_qty` aggregate, whose "open"
predicate is `status IN ('sent','partial') AND received_at IS NULL`
(`20260704000000_po_loop.sql`, spec 107 §4). The just-ordered items would keep
showing as "reorder this again" → the exact double-order bug spec 107 closes.
Transitioning to `'sent'` (a) drops the PO out of THIS spec's pending set (AC-3 is
`status='draft'`), AND (b) drops the ordered quantity INTO the reorder inbound
set, closing the loop. One transition, two correct effects. An `ordered_at` column
would need a THIRD state and a change to spec-107's predicate — rejected.

**The spec-120 `po` notification WILL fire — ruled DESIRABLE.** The spec-120
trigger (`20260715000000_submission_notifications.sql`) emits a `po` notification
on any transition INTO `status='sent'`. Marking a PO ordered via the extension is
semantically "the order went to the vendor" = a send, so firing the brand-scoped
bell notification ("a PO for BJ's was ordered") is correct and consistent with the
manual `send-po-email` / mark-as-sent-manually paths, which also reach `'sent'`.
The owner's "no message" ruling that killed 131's delivery arm was about a
redundant PUSH/EMAIL to the ACTING admin — the spec-120 bell is a DIFFERENT
surface (a brand-wide feed for OTHER admins' visibility), not a push to the person
who just ordered. **Dependency to verify at build:** the spec-120 trigger's WHEN
clause must guard `OLD.status IS DISTINCT FROM 'sent'` so a re-mark (sent→sent,
the idempotent replay) does NOT emit a duplicate notification. The guarded UPDATE
(`and status='draft'`) already prevents the sent→sent UPDATE from touching the
row, so no duplicate fires regardless — but confirm the trigger guard as a
belt-and-suspenders (flag for backend-developer + test-engineer).

**In-app mark-ordered affordance (AC-6 "or the admin in-app"):** already exists —
spec 107's "mark as sent manually" button in `POsSection` IS this affordance
(`draft → 'sent'`). No new in-app control, no new copy. So AC-8's "mark-ordered
affordance copy" reuses spec-107's existing `section.purchaseOrders.*` strings —
131's ONLY new user-visible strings are the two vendor-editor fields (D-9).

### D-5. Extension authentication (OQ-3 — resolved identically in spec 132 OQ-1)

**The extension embeds `supabase-js` and authenticates as the admin via the
EXISTING Supabase email+password auth** (CLAUDE.md: "Auth: Supabase email+password").
Full detail is in spec 132's design (D-2 there); the 131-side contract:

- The extension signs in with `supabase.auth.signInWithPassword` using the
  project URL + the **public anon key** (already shipped in the web bundle — not a
  secret; RLS does the bounding). It obtains the ADMIN'S OWN JWT
  (`app_metadata.role` + `user_stores` visibility baked in).
- Every RPC read (D-3) and the mark-ordered UPDATE (D-4) ride that JWT →
  `auth_can_see_store` / `auth_can_see_brand` bound them to EXACTLY the admin's own
  visibility. The extension gains NO broader access than the admin's web session
  (131 US-3, 132 AC-2).
- **No service-role key in the extension. No new token-minting edge function. No
  cross-origin token extraction from the web app's storage.** This keeps 131's
  read/write surface strictly RLS-bounded (the OQ-3 hard requirement) with ZERO
  new backend. Session persisted in `chrome.storage.local` (extension-sandboxed,
  not page-readable); refresh-token rotation handled by `supabase-js`.
- Security-audited surface (flag): token-at-rest in `chrome.storage.local`, the
  anon key as compile-time public config, session lifetime = Supabase default.
  No elevation path exists — the JWT is the admin's own.

### D-6. Edge function changes

**None.** The delivery edge function is CUT (owner ruling). The two new DB
functions (D-3) are RPCs, not edge functions — no `verify_jwt` decision, no
service-token strategy. No `staff-*` / `pwa-catalog` surface touched. Flagged as a
deliberate absence.

### D-7. `src/lib/db.ts` surface + the shared builder

**`src/lib/db.ts` — vendor CRUD threading only** (the RPCs are extension-side, D-3):
- `fetchVendors` (`:1886` map) — add `extensionOrdering: v.extension_ordering ?? false`
  and `orderPageUrl: v.order_page_url ?? null`. (`select('*')` already returns the
  new columns; only the map grows.)
- `createVendor` INSERT (`:1922`) — add `extension_ordering: vendor.extensionOrdering ?? false`,
  `order_page_url: vendor.orderPageUrl ?? null`.
- `updateVendor` `dbUpdates` (`:3179`) — add
  `if (updates.extensionOrdering !== undefined) dbUpdates.extension_ordering = updates.extensionOrdering;`
  and the same for `orderPageUrl`. (Mirrors the `orderUnit` line exactly.)
- **`Vendor` type** (`src/types/index.ts:451`) gains `extensionOrdering: boolean;`
  and `orderPageUrl: string | null;`.
- snake↔camel: `extension_ordering ↔ extensionOrdering`, `order_page_url ↔
  orderPageUrl`, `product_page_url ↔ productPageUrl` — added to the existing local
  vendor / item_vendors mappers, consistent with `order_unit ↔ orderUnit`.

**`src/utils/poQuickOrderText.ts` — extract a structured-line core (additive,
non-breaking, D-1):** add an exported `computePoQuickOrderLines(lines,
resolveCode, resolveName, orderUnit)` returning
`{ lines: StructuredOrderLine[]; unmappedCount; roundedCount }` where
`StructuredOrderLine = { itemId; orderCode: string | null; itemName: string; qty:
number /* case-converted emitQty */; unit: 'case' | 'unit'; unmapped: boolean;
rounded: boolean }`. Refactor `buildPoQuickOrderText` to call this core then
`.join('\n')` the text — its existing signature + byte-for-byte output UNCHANGED
(the existing jest byte-pins must stay green — AC-5). The extension imports
`computePoQuickOrderLines` to build the AC-4 structured payload from the RPC's raw
lines; `POsSection` keeps calling `buildPoQuickOrderText` for the text blob. ONE
implementation, no fork.

**Extension-side data layer (NOT `db.ts`):** the extension has its own thin
`imrClient` calling the two RPCs + the mark-ordered UPDATE via its own
`supabase-js` client. This is a legitimate carve-out (separate bundle, like
`src/screens/staff/`) — CLAUDE.md's "all DB access through db.ts" governs the Expo
app, not the extension artifact. Detailed in spec 132.

### D-8. Realtime impact

- **`vendors.extension_ordering` / `order_page_url`** replay on **`brand-{id}`**
  (`vendors` already in `supabase_realtime` since 2026-05-14, subscribed at
  `useRealtimeSync.ts:68`). Column adds → no publication change.
- **`item_vendors.product_page_url`** replays on **`store-{id}`** (`item_vendors`
  already published, spec 102). Column add → no publication change.
- **The mark-ordered UPDATE** (`purchase_orders.status → 'sent'`) replays on
  **`store-{id}`** (`purchase_orders` already published, spec 107 §6) → the Reorder
  section's `pending_po_qty` reflects the just-ordered items within one 400ms
  debounce.
- **Publication gotcha — DELIBERATE ABSENCE.** No migration changes
  `supabase_realtime` membership (all three tables already published), so the
  `docker restart supabase_realtime_imr-inventory` step does NOT apply. Flagged so
  the deploy checklist is not padded (same posture as spec 114/115).

### D-9. Frontend store impact + i18n

- **`VendorFormDrawer` / the vendor editor:** add an `extension_ordering` toggle
  (AC-1) and an `order_page_url` text field (AC-2), threaded through the existing
  `createVendor` / `updateVendor` path (D-7) — no new store action; the vendor CRUD
  slice already exists (spec 115). Round-trips on reopen (AC-1/AC-2). The
  optimistic-then-revert + `notifyBackendError` pattern is inherited from the
  existing vendor-save wrapper — no new revert path.
- **No new `useStore.ts` slice** for the mark-ordered write in-app — it reuses
  spec-107's existing `markPurchaseOrderSentManually` action (D-4).
- **i18n ×3 (AC-8) — minimal.** Only the two vendor-editor strings ×2 (label +
  help) ×3 locales in the admin catalog `section.*`
  (`section.vendors.extensionOrderingLabel/Help`,
  `section.vendors.orderPageUrlLabel/Help`). The mark-ordered affordance reuses
  spec-107 copy (D-4). The structured payload + RPC output are machine-facing, NOT
  localized (spec 114 OQ-8); a gap `itemName` is the item's canonical name (deep
  per-locale gap naming is out of scope for the machine payload — flag).

### D-10. Boundary (AC-7 — the softened invariant, restated as a review-reject contract)

Nothing in THIS spec logs into, navigates, fetches, or submits on a vendor site.
The RPCs (D-3) read ONLY I.M.R data; the mark-ordered write (D-4) UPDATEs ONLY
`purchase_orders.status`. No stored vendor credentials, no headless browser, no
server-side vendor-site fetch. Cart PREPARATION is exclusively spec 132's
extension, in the admin's OWN browser session. **Reviewer-reject:** any code path
in this repo that authenticates to, fetches from, or submits to `bjs.com` /
`samsclub.com`, or stores a vendor credential, is a scope violation.

### D-11. Risks / tradeoffs

- **Migration ordering / prod apply.** Additive DDL (3 columns) + 2 RPCs. Apply
  via Supabase MCP `execute_sql` (db push lacks the prod password), then INSERT
  version `20260720000000` into `supabase_migrations.schema_migrations` (spec 064
  gate goes red until then — expected). DDL columns verify by COLUMN PRESENCE
  (`information_schema.columns`); the two RPCs verify by normalized-md5 of the
  function body (CREATE-OR-REPLACE FUNCTION — the md5 path applies here, unlike a
  bare column add). Developer FLAGS the prod-apply; does not push it.
- **spec-120 trigger duplicate-notification (D-4).** Confirm the trigger guards
  `OLD.status IS DISTINCT FROM 'sent'`. The `and status='draft'` UPDATE guard
  already prevents a duplicate, but pin it in pgTAP.
- **Shared-builder coupling.** The extension imports `src/utils/poQuickOrderText.ts`.
  If a future spec makes that file impure (adds a React/store import), it breaks
  the extension build. Mitigation: the file's header already forbids impure
  imports (spec 114); the extension typecheck arm (spec 132 OQ-4) catches a
  regression at CI. Flag.
- **RLS gap:** none introduced — all three columns inherit column-agnostic
  row-level policies; the RPCs are INVOKER (caller RLS applies) + an explicit gate
  on RPC 2. pgTAP proves a non-privileged caller cannot set `extension_ordering`
  and a non-member cannot read another store's pending payload.
- **Performance on the 286 KB seed:** the pending-set RPC joins
  `purchase_orders ⋈ vendors` filtered on `status='draft' AND extension_ordering`
  — indexed by the existing `idx_purchase_orders_store_status_open` (spec 107 §2)
  and tiny on seed. The per-PO payload RPC joins ≤ tens of `po_items`. No N+1.
- **Edge function cold-start:** N/A — no edge function.

### D-12. Test plan (spec 022 tracks)

- **pgTAP** — extend `supabase/tests/vendors_role_access.test.sql`: the two
  `vendors` columns exist with the right type/default and a non-privileged caller
  CANNOT set `extension_ordering` / `order_page_url` (inherited privileged UPDATE).
  Plus a new suite (or extend `po_loop`): `get_pending_extension_orders` returns a
  draft+opted-in PO and NOT an opted-out or non-draft PO; a non-member gets neither
  the pending row nor `get_extension_order_payload` (P0002/42501); the mark-ordered
  guarded UPDATE flips `draft → sent`, is a no-op on a non-draft PO (idempotent),
  and a non-member cannot flip it; `item_vendors.product_page_url` exists +
  nullable + inherits store RLS.
- **jest** — `computePoQuickOrderLines` produces the AC-4 per-line structured
  shape (orderCode / name / qty / unit / unmapped), case-converts identically to
  `buildPoQuickOrderText` (assert both derive from the same core — an unmapped line
  is surfaced, never dropped); the existing `buildPoQuickOrderText` byte-pins stay
  green (AC-5 unchanged); `db.ts` vendor round-trip threads
  `extensionOrdering`/`orderPageUrl`.
- **shell smoke** — optional curl round-trip of the two RPCs + the mark-ordered
  UPDATE against a fixture draft PO.

### D-13. Slice ownership

- **backend-developer:** `20260720000000_extension_ordering.sql` (3 columns + 2
  RPCs + grants + comments); the `db.ts` vendor threading (D-7) + `Vendor` type;
  the `computePoQuickOrderLines` extraction in `src/utils/poQuickOrderText.ts`
  (D-7) keeping `buildPoQuickOrderText` byte-identical; the pgTAP (D-12); the
  prod-apply notes in the migration header + the spec-120-trigger-guard confirmation.
- **frontend-developer:** the `VendorFormDrawer` `extension_ordering` toggle +
  `order_page_url` field (D-9); the i18n ×3 (D-9); the jest for the vendor
  round-trip + `computePoQuickOrderLines`. (The `product_page_url` editor field is
  a spec-132/follow-up — NOT built here.)

---

## Files changed

### Build notes / flags for reviewers

- **Migration timestamp bumped (filename deviation, flagged).** The design named
  the migration `20260720000000_extension_ordering.sql` and asserted the latest
  on-disk slot was `20260719000000`. The tree had moved on: `20260720000000` is
  already taken by `20260720000000_staff_reports_issue_notifications.sql` and the
  latest on disk is `20260722000000_ingredient_changed_badge.sql`. To honor the
  design's intent ("next free slot", additive) without a collision, the migration
  landed as **`20260723000000_extension_ordering.sql`**. Column/RPC contents are
  UNCHANGED from the design. The prod-apply `schema_migrations` version string is
  therefore `20260723000000`.
- **`product_page_url` editor field — built; EXCEEDS the design's deferral
  (flagged for architect drift-review).** Design D-2 and D-13 explicitly deferred
  the `item_vendors.product_page_url` EDITOR field to spec 132 / a follow-up
  ("NOT built here"). The build task (item 4) explicitly directed building it in
  `IngredientForm`'s per-vendor card "per design". Resolving that conflict toward
  the explicit task instruction, the field WAS built, threaded exactly like
  spec-114's `order_code` (form row + `updateVendorLinkField` + `vendorRowsToLinkPayload`
  + `IngredientFormDrawer` hydration + db.ts create/update upsert). The column +
  read-path mapper threading (unambiguous in both task item 2 and design D-7) are
  also present. **Reviewers/architect: reconcile this scope. If the editor field
  should NOT ship in 131, the `IngredientForm` + `IngredientFormDrawer` + form
  helper hunks + i18n `productPageUrl*` keys revert cleanly; the column + db.ts
  mapper threading stay.**
- **`apply_item_vendors_to_brand` does NOT propagate `product_page_url` (follow-up).**
  Threading it would require modifying that SECURITY DEFINER RPC (a migration
  surface the design did not scope). Left as-is; "Apply vendors to all stores"
  propagates order codes but not product page URLs. Flagged as a follow-up.
- **spec-120 po-notification trigger guard — CONFIRMED (item 6, read-only).**
  `20260715000000_submission_notifications.sql:256` already guards
  `(tg_op = 'INSERT' or old.status is distinct from 'sent')`, so a re-mark
  (sent→sent) emits no duplicate `po` notification. No change made (guard present,
  as the design required).
- **Prod-apply PENDING (item 7 — NOT pushed).** Apply
  `20260723000000_extension_ordering.sql` to prod via Supabase MCP `execute_sql`,
  then INSERT version `20260723000000` into
  `supabase_migrations.schema_migrations`. Verify the 3 columns by presence
  (`information_schema.columns`) and the 2 RPCs by normalized-md5 of the function
  body. `db-migrations-applied.yml` (spec 064) goes red until the
  `schema_migrations` row lands — expected. Realtime `docker restart` does NOT
  apply (no publication membership change).
- **Verification:** `npx tsc --noEmit` (base) and `npx tsc -p tsconfig.test.json
  --noEmit` both exit 0; full `npx jest` green (122 suites / 1318 tests, incl. the
  new spec-131 coverage); `scripts/test-db.sh` green (75/75 files, incl. the
  extended `vendors_role_access` at plan(21) and the new `extension_ordering`
  suite at plan(18)); migration applied + smoke-tested against the local stack
  (columns present, RPC 1 → `[]` on empty set, RPC 2 → P0002 on not-found).
  Browser pass deferred to main Claude (interactive drawer/auth navigation not
  driven by this subagent; the new controls reuse existing primitives —
  `ToggleField` mirrors `SegmentField`, the URL `Field` + per-vendor `InputLine`
  are pre-existing).

### Migrations (backend)
- `supabase/migrations/20260723000000_extension_ordering.sql` (new) — 3 additive
  columns (`vendors.extension_ordering boolean not null default false`,
  `vendors.order_page_url text`, `item_vendors.product_page_url text`) + 2
  SECURITY INVOKER read RPCs (`get_pending_extension_orders(uuid)`,
  `get_extension_order_payload(uuid)`) with grants (revoke public/anon, grant
  authenticated) + column/function comments. No policy change, no publication
  change. House header documents RLS inheritance, the realtime-restart ABSENCE,
  and the prod-apply steps.

### src/lib/db.ts (backend)
- `fetchVendors` map — added `extensionOrdering: v.extension_ordering ?? false`,
  `orderPageUrl: v.order_page_url ?? null`.
- `createVendor` INSERT — added `extension_ordering`, `order_page_url`.
- `updateVendor` `dbUpdates` — added `extension_ordering` (plain boolean) +
  `order_page_url` (empty → null) with the omit-key-to-skip guard.
- `fetchInventory` embed — added `product_page_url` to the `item_vendors`
  projection.
- `mapItem` hydration — `vendorLinks` element type + `.map` gain
  `productPageUrl: lv.product_page_url || ''`.
- `createInventoryItem` / `updateInventoryItem` upserts — each upserted link row
  gains `product_page_url: (l|v).productPageUrl || null`.
- Both create/update `vendors?` payload types gain `productPageUrl?: string`.

### src/types/index.ts (backend)
- `Vendor` gains `extensionOrdering: boolean;` and `orderPageUrl: string | null;`.
- `ItemVendorLink` gains `productPageUrl: string;` (required on the hydrated
  shape, defaults `''` from mapItem — mirrors `orderCode`).

### src/utils/poQuickOrderText.ts (backend — shared builder extraction, D-1/D-7)
- Added exported `computePoQuickOrderLines(lines, resolveCode, resolveName,
  orderUnit)` → `{ lines: StructuredOrderLine[]; unmappedCount; roundedCount }`
  (+ exported `StructuredOrderLine` / `PoQuickOrderLinesResult`). This is the ONE
  canonical case-math/code-resolution core the spec-132 extension imports.
- Refactored `buildPoQuickOrderText` to derive its text from the core — signature
  and byte-for-byte output UNCHANGED (existing jest byte-pins pass unmodified).

### src/store/useStore.ts (frontend — type-forced by required fields)
- `addItem` / `updateItem` `vendors?` param types gain `productPageUrl?: string`.
- The two optimistic `linkSet.map` bodies + the scalar-fallback link gain
  `productPageUrl: l.productPageUrl || ''` / `productPageUrl: ''`.

### src/components/cmd/VendorFormDrawer.tsx (frontend)
- `FormValues` + `blank()` + `fromVendor()` + `toUpdates()` thread
  `extensionOrdering` (boolean) + `orderPageUrl` (string).
- New `ToggleField` component (boolean pill, mirrors `SegmentField`'s label idiom;
  `testID="vendor-extension-ordering-toggle"`).
- Rendered the extension-ordering toggle + a conditional order-page-URL `Field`
  (shown when the toggle is ON) after the order-unit segment.

### src/components/cmd/IngredientForm.tsx (frontend — product_page_url editor field)
- `IngredientFormValues.vendors[]` + `VendorLinkRow` gain `productPageUrl: string`.
- `addVendorLink` seeds `productPageUrl: ''`; `updateVendorLinkField` field union
  widened with `'productPageUrl'`; `vendorRowsToLinkPayload` maps
  `productPageUrl: (r.productPageUrl||'').trim() || undefined` (empty→undefined→NULL).
- New `handleVendorProductPageUrlChange` + a per-vendor-card `InputLine` (keyed on
  `row.vendorId`), sibling to spec-114's order-code input.

### src/components/cmd/IngredientFormDrawer.tsx (frontend)
- `fromItem` hydration — both branches add `productPageUrl` (embed → `v.productPageUrl
  || ''`; scalar-fallback → `''`).
- `ItemUpdatesWithVendors` `vendors` payload type widened with `productPageUrl?: string`.

### i18n (×3 — en / es / zh-CN)
- `section.vendors.extensionOrderingLabel` + `extensionOrderingHelp`,
  `section.vendors.orderPageUrlLabel` + `orderPageUrlHelp`.
- `section.inventory.productPageUrlLabel` + `productPageUrlHelp`.

### Tests
- **pgTAP:** `supabase/tests/vendors_role_access.test.sql` extended `plan(13)` →
  `plan(21)` (the two new `vendors` columns' shape + the inherited privileged
  UPDATE gate: admin CAN set them, `user` CANNOT). New
  `supabase/tests/extension_ordering.test.sql` `plan(18)` (product_page_url column
  shape; `get_pending_extension_orders` pending-set membership incl. opted-out /
  non-draft exclusion + `p_vendor_id` filter + `unmappedCount` + non-member RLS;
  `get_extension_order_payload` structured lines incl. the order-code join + the
  unmapped `orderCode:null` line + non-member P0002 refusal; the guarded
  mark-ordered draft→sent UPDATE + its idempotency + pending-set drop-out).
- **jest:** `src/utils/poQuickOrderText.test.ts` — added the
  `computePoQuickOrderLines` extraction pin (AC-4 per-line shape, case-conversion
  identical to `buildPoQuickOrderText`, unmapped surfaced with `orderCode:null`,
  empty-input edge); the existing byte-pins stay green unchanged.
  `src/lib/db.updateVendor.test.ts` — added the `extensionOrdering` /
  `orderPageUrl` UPDATE-threading suite.
- **Test-fixture updates (type-forced by the new required fields):**
  `src/components/cmd/IngredientForm.test.ts` (VendorLinkRow literals gain
  `productPageUrl: ''`), `src/components/cmd/VendorFormDrawer.test.tsx`,
  `src/lib/csvImport.test.ts`, `src/utils/vendorImportShared.test.ts` (Vendor /
  ItemVendorLink fixtures gain the new fields).

### Post-review fixes (release-proposal FIXES_NEEDED — 2026-07-19)
- **[BLOCKING resolved] `supabase/tests/extension_ordering.test.sql`** — implemented
  the M3 assertion the header already documented (previously undelivered): a
  non-member (the Frederick manager 2222) attempting the guarded `draft→'sent'`
  UPDATE against the Charles-store PO fixture (already created for P5/Q2) is denied
  by `store_member_update_purchase_orders` (0-row update, RAISES NOTHING → status
  stays `draft`, verified as master since RLS hides the row from the manager). This
  is the WRITE side of the store gate the READ side already had (P5/Q2), backing
  AC-6's "a caller cannot mark a PO ordered in a store they can't see." `plan(18)`
  → `plan(19)`; header comment now matches the implemented set.
- **[Minor resolved] `src/components/cmd/VendorFormDrawer.test.tsx`** — added a
  spec-131 describe block pinning the `extensionOrdering` toggle + `orderPageUrl`
  Field round-trip (mirroring the existing spec-115 `order_unit` prefill test): NEW
  vendor defaults toggle OFF + hides the URL field; toggling ON reveals the URL
  field and threads both through `addVendor`; EDIT mode prefills toggle ON + the
  saved URL and writes both back through `updateVendor`; EDIT with toggle OFF hides
  the URL field even when a URL is stored. The component's prefill logic
  (`fromVendor`) was already correct — this closes the AC-1/AC-2 test caveat, not a
  code bug.
- **Not touched (per task):** the `item_vendors.product_page_url` editor field
  (keep/revert decision pending with the owner).
- **Re-verified:** `scripts/test-db.sh` green (75/75 files; `extension_ordering`
  now 19/19); full `npx jest` green (122 suites / 1322 tests, +4 new); `npx tsc
  --noEmit` exit 0.

### Post-review fixes — round 2 (owner KEEP ruling on `product_page_url` field — 2026-07-19)
The owner ruled **KEEP** on the `item_vendors.product_page_url` editor field. Per
the release-proposal step 2 (KEEP branch) and backend-architect M-1 / code-reviewer
finding 2, the KEEP ruling is paired here with the `apply_item_vendors_to_brand`
propagation fix so admins do not get a silent order-code-propagates /
product-URL-doesn't inconsistency.
- **[Should-fix resolved] New migration `supabase/migrations/20260724000000_apply_item_vendors_product_page_url.sql`**
  — `CREATE OR REPLACE` of the spec-119 SECURITY DEFINER RPC
  `apply_item_vendors_to_brand` to carry `product_page_url` IDENTICALLY to its
  sibling `order_code`: added to the upsert INSERT column list + the `SELECT`
  (`nullif(elem->>'product_page_url','')`) + the `ON CONFLICT DO UPDATE` set-list
  (overwrite, matching `order_code`'s AC-7 propagate semantics). Security posture,
  guards, guard order, and primary-unset ordering are byte-for-byte unchanged; the
  only delta is the one column. Additive / reversible (re-apply the 20260714000000
  body to revert).
- **[Correctness — required for parity, avoids a wipe] Client threading.** Because
  the RPC's `DO UPDATE` now overwrites `product_page_url` from the submitted payload
  (identical to `order_code`), the client wrapper MUST send it or an "Apply vendors
  to all stores" would wipe existing links' `product_page_url` to NULL.
  `src/lib/db.ts applyItemVendorsToBrand` `vendors` param type widened with
  `productPageUrl?: string` and the mapped payload now emits
  `product_page_url: v.productPageUrl || null`; `src/store/useStore.ts`
  `applyVendorsToAllStores` interface `vendors` param type widened to match. The
  form already collected + emitted `productPageUrl` via `vendorRowsToLinkPayload`
  (spec-131 build) — this closes the drop between the form and the RPC.
- **[pgTAP extended] `supabase/tests/apply_item_vendors_to_brand.test.sql`** — Towson
  V1 fixture seeded with a stale `product_page_url`; the apply call submits
  `product_page_url` for V1 + V2; three new assertions (19/20/21): Towson V1's stale
  URL is OVERWRITTEN by the submitted one (overwrite parity with `order_code`, not
  the cost/case_price preserve), Towson V2's new link is SEEDED with it, and it fans
  out to Charles V2 too. `plan(19)` → `plan(22)`.
- **Re-verified:** `scripts/test-db.sh` green (75/75 files;
  `apply_item_vendors_to_brand` now 22/22); full `npx jest` green (122 suites /
  1322 tests); `npx tsc --noEmit` exit 0.
- **Prod-apply pending (flagged, NOT pushed):** BOTH `20260723000000_extension_ordering.sql`
  and this `20260724000000_apply_item_vendors_product_page_url.sql` are pending
  prod-apply via Supabase MCP (`db push` lacks the prod password). Apply 20260723
  first, then 20260724; INSERT both version strings into
  `supabase_migrations.schema_migrations`. `db-migrations-applied.yml` reads red on
  `main` until both land.
