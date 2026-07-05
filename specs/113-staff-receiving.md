# Spec 113: Staff-side receiving against open POs

Status: READY_FOR_REVIEW

> Two owner rulings already collected (binding — cited throughout): **R-1
> STOCK-ONLY for staff** (staff record delivered quantities → stock; the spec-109
> price/cost path stays admin-only and is now enforced **server-side**, not merely
> by UI absence) and **R-2 ONLINE-ONLY v1** (receiving requires a live connection;
> no offline queue). This is a two-slice spec: a **backend** slice (a
> `receive_purchase_order` re-CREATE that adds a privileged gate on the PRICE PATH
> only + pgTAP) and a **frontend** slice (a staff Receiving screen + a read/RPC
> carve-out lib + i18n ×3 + tests). It reuses the spec-107/109 receive RPC and its
> `{ po_id, status, conflict, lines[], price_changes[] }` envelope unchanged except
> for the one added gate hunk.

## User story

As a **store staff member on shift** (staff app), I want to open one of my store's
OPEN purchase orders and record how much of each line actually arrived in this
delivery — with the "received now" inputs prefilled to the outstanding remainder —
and commit that receive so the stock updates, **without** touching prices — so
deliveries get logged the moment they land (when the manager usually isn't there)
instead of waiting for a manager to sit at the admin desktop. As the **brand
owner**, I want the price/cost side of receiving to remain admin-only and enforced
in the database, so a staff session — even one crafting a raw RPC call — cannot
rewrite item costs.

Sub-stories:

- **US-1 (staff receive stock).** As staff, I want a Receiving tab that lists my
  store's OPEN POs (sent / partial), lets me pick one, shows its real lines with
  the outstanding remainder prefilled, and commits the receive after a confirm —
  the same core flow the admin has, minus the price column.
- **US-2 (partial + idempotent).** As staff, I want partial receives to be allowed
  (a short delivery flips the PO to `partial` and the remainder stays inbound), and
  a double-tap / retry to not double-count (the receive is idempotent on a client
  uuid).
- **US-3 (price stays admin, enforced server-side).** As the owner, I want a staff
  receive to be STOCK-ONLY: staff cannot enter a case price, and if a staff session
  sends a `new_case_price` on any line via a hand-crafted RPC call, the WHOLE call
  is refused server-side with nothing durable written (no stock, no cost, no audit).
  The existing admin price path is unchanged.
- **US-4 (online-only).** As staff, I want the app to prevent me from committing a
  receive while offline (a delivery I "receive" offline that silently drops would
  be worse than being told to wait for signal), reusing the staff app's existing
  connection-status affordance.
- **US-5 (feedback + refresh).** As staff, I want a success confirmation and the
  open-PO list to refresh after a commit (a fully-received PO leaves the list), and
  a clear empty state when there are no open POs.

## Problem / current state (verified in code)

**Today receiving is admin-only.** The only receiving surface is the admin Cmd UI
`ReceivingSection.tsx` (`src/screens/cmd/sections/ReceivingSection.tsx`), which has
a PO-driven mode: it lists OPEN POs filtered to `status === 'sent' || 'partial'`
(lines 120-129), prefills each line's "received now" input to the outstanding
remainder `Math.max(0, orderedQty - receivedQty)` (149-156), sends ADDITIVE deltas,
and commits via a confirm (242-273). Spec 109 added a **case-price column** to that
section (the `prices` state + the `receiving-price-*` `TextInput`, 416-429, and the
30% fat-finger guard, 197-206) — **this price column is exactly what staff must NOT
get** (R-1). Deliveries typically arrive on-shift, when managers aren't at the admin
desktop.

**The receive RPC and its store gate.** `receive_purchase_order(uuid, jsonb, uuid)`
is SECURITY INVOKER, gated at the top on `auth_can_see_store()` only
(`supabase/migrations/20260705000000_cost_on_receipt.sql:163-165`; the same gate in
the spec-107 base `20260704000000_po_loop.sql`). Its stock path (§3a, cost_on_receipt
:216-222) is ADDITIVE/idempotent (spec 107). Its **cost/price path (§3b,
cost_on_receipt:228-322) has NO role gate** — it fires whenever a line carries a
non-null `new_case_price` that differs from the link's current case price, and it
UPSERTs `item_vendors` + UNCONDITIONALLY updates `inventory_items.case_price` /
`cost_per_unit` + writes a `'PO price change'` audit row. Because the only gate is
`auth_can_see_store()`, **any authenticated store member — including a staff-role
member — could craft an RPC call with `new_case_price` and rewrite item costs.**
That is the hole R-1 requires closing. The envelope is
`{ po_id, status, conflict, lines[], price_changes[] }`.

**RLS on the read surface already admits staff.** `purchase_orders` + `po_items`
are ALREADY under `auth_can_see_store()` for SELECT (spec 107;
`20260704000000_po_loop.sql:32` documents it, and spec 107 pgTAP pins R1/R4). So a
staff-role member of the store can already read the store's POs and lines — **the
staff read surface needs NO new policies** (verified; confirmed below in AC-6).

**Staff app structure.** `src/screens/staff/` is a peer to `cmd/` (spec 063). It
uses a bottom-tab bar `StaffTabs` (`navigation/StaffStack.tsx:72-133`) with three
tabs today: `EODCount`, `Reorder`, `WeeklyCount`. Data flows through the documented
staff carve-out (direct `supabase.from/rpc` in `src/screens/staff/lib/`, NOT
`db.ts`) — e.g. `fetchReorder.ts` reads POs/schedule and copies `db.ts:mapReorderVendor`
verbatim; `countLayouts.ts` reads `store_count_layouts` directly. The staff app has
its own light/dark theme (`theme.ts`), i18n catalog (`i18n/*.json`, `weekly.*` /
`reorder.*` / `eod.*` / `chrome.*`), `notifyBackendError`, and a `useStaffStore`
Zustand store. **Realtime is not used in the staff app** (spec 062) — screens
refresh on focus / pull / manual Refresh.

**Connection status affordance exists.** `src/screens/staff/hooks/useConnectionStatus.ts`
returns a `boolean` (true = online), event-driven (spec 059). The EOD screen already
consumes it for its online/offline Save branch + a `QueueIndicator`
(`EODCount.tsx:254-255`, `36`, `1110`). WeeklyCount does not use it yet. Receiving
is ONLINE-ONLY (R-2), so it uses this hook to block submit when offline.

**Reference shape for the receive call.** The admin store action
`receivePurchaseOrder` (`src/store/useStore.ts:2571-2602`) mints a `client_uuid`
ONCE per receive event (2577-2580) and calls `db.receivePurchaseOrder(poId, lines,
clientUuid)`; `db.ts:1576-1625` maps camelCase deltas → the RPC's snake_case shape
and only sends `new_case_price` when it's a finite number (1600-1602). The staff
path mirrors the uuid-mint + RPC call in the carve-out (NOT via `db.ts`). The
`PoLine` shape (`db.ts:1405-1428`) already carries `poItemId, itemName, unit,
orderedQty, receivedQty, costPerUnit, caseQty` and deliberately does NOT expose a
case price — the staff read reuses that exact projection minus any price display.

## Acceptance criteria

Backend — server-side price gate (R-1):

- [ ] **AC-1 (staff can receive stock-only).** A non-privileged store member (a
  staff-role user who passes `auth_can_see_store(po.store_id)`) calling
  `receive_purchase_order` with lines that carry NO `new_case_price` (or an absent /
  JSON-null key) succeeds exactly as today: `received_qty` accumulates additively,
  `current_stock` increments by the same counted-unit delta, status flips
  `partial`/`received`, the `'PO received'` audit row is written, and the envelope
  returns with `price_changes: []`. Pinned by pgTAP.
- [ ] **AC-2 (price path requires privilege; whole-call refusal, nothing durable).**
  A non-privileged store member calling `receive_purchase_order` with **any** line
  carrying a **non-null `new_case_price`** is refused: the RPC raises a stable error
  (recommend SQLSTATE `42501`, message `'forbidden: price change requires admin'` —
  **architect fixes the exact string/errcode**, following the house `'cannot <verb>'`
  / errcode convention) **BEFORE any side-effect**, so after the failed call there
  is: no `po_items.received_qty` change, no `current_stock` change, no `item_vendors`
  write, no `inventory_items` cost/price change, no `audit_log` row, and no
  `receive_client_uuid` stamp — for that PO. The refusal fires whenever the gate
  detects a priced line regardless of whether that price actually differs from the
  current one (the presence of `new_case_price` is what triggers the gate, matching
  R-1's "price ENTRY stays admin-only"). Pinned by pgTAP asserting NOTHING durable.
- [ ] **AC-3 (privileged price path unchanged — regression guard).** A privileged
  caller (`auth_is_privileged()` — admin / master / super_admin) receiving with a
  changed `new_case_price` behaves byte-identically to spec 109: both `item_vendors`
  and `inventory_items` update via the ★ formula, a `'PO price change'` audit row is
  written per changed line, and `price_changes[]` carries the entries. The spec-109
  semantics (§3b HUNK 2/3/4, the always-update-the-scalar OQ-1 AGGRESSIVE behavior)
  are preserved unchanged. Pinned by a pgTAP regression assertion.
- [ ] **AC-4 (idempotency / replay unaffected).** The `receive_client_uuid` dedup
  short-circuit still fires before the loop (cost_on_receipt:173-189). A staff
  stock-only receive replayed with the same `p_client_uuid` returns the prior
  envelope with `conflict: true` and re-applies nothing. The gate is evaluated on
  the lines actually submitted; a replay carrying no priced line is not spuriously
  refused. Pinned by pgTAP.
- [ ] **AC-5 (re-CREATE is body-only, verbatim + one hunk).** The migration
  re-CREATEs `receive_purchase_order(uuid, jsonb, uuid)` by copying its CURRENT
  on-disk source (`20260705000000_cost_on_receipt.sql:122-386`) **verbatim** and
  adding **one** gate hunk (the priced-line-detected-and-not-privileged refusal),
  placed so it fires before any write and before the idempotency stamp — following
  the house verbatim-copy discipline (the same discipline cost_on_receipt itself
  documents against `po_loop.sql`). Signature unchanged, so `create or replace`
  preserves the existing grants (no grant/revoke re-emit). SECURITY INVOKER +
  `search_path = public` unchanged. No schema DDL, no policy change, no publication
  change. A code-review diff confirms the ONLY delta vs cost_on_receipt is the gate
  hunk (+ its comment).

Backend — read surface (verify, no change):

- [ ] **AC-6 (staff read needs no new policy).** A staff-role member of Store A can
  already SELECT Store A's `purchase_orders` and `po_items` under the existing
  `auth_can_see_store()` RLS; a non-member cannot. This spec adds **no** new RLS
  policy for the read path — pinned/confirmed by a pgTAP assertion (may reuse the
  spec-107 R1/R4 posture) that a staff-role Store-A member reads Store A's open POs
  and their lines and a Store-B-only member gets 0 rows.

Frontend — staff Receiving screen:

- [ ] **AC-7 (open-PO list + empty state).** The staff Receiving surface lists the
  active store's OPEN POs (`status ∈ {sent, partial}`, same filter as admin),
  sorted newest-first, each showing a short id, a status pill (sent / partial), the
  vendor name, and the date. When there are no open POs it shows a clear empty
  state. Works on react-native-web (Vercel) AND native (EAS).
- [ ] **AC-8 (pick → prefilled lines).** Picking a PO loads its real `po_items`
  lines and renders, per line: item name, ordered qty, already-received qty,
  outstanding remainder, and a numeric "received now" input **prefilled to the
  outstanding remainder** `max(0, orderedQty - receivedQty)`. **No case-price input
  and no cost/price display of any kind** appears on the staff screen (R-1). A
  per-PO / per-line loading + empty ("no line items") state is handled.
- [ ] **AC-9 (commit — confirm, additive, partial allowed).** A **Commit / Receive**
  button builds the this-receive ADDITIVE deltas (skipping zero rows), requires a
  confirm (mirroring the admin commit confirm — receiving mutates stock), and calls
  the receive RPC with a client uuid minted once per receive. Lines with NO price
  key are sent (stock-only). A partial delivery is allowed and flips the PO to
  `partial` per the existing RPC semantics; a full delivery flips it to `received`.
  Committing with all-zero inputs is blocked with a "nothing to receive" message.
- [ ] **AC-10 (idempotent submit).** The client uuid is minted ONCE per commit
  (mirrors `useStore.receivePurchaseOrder` / `submitInventoryCount`), so a
  double-tap or in-flight retry dedupes server-side (AC-4). The commit button is
  disabled while a receive is in flight.
- [ ] **AC-11 (online-only gate — R-2).** The commit control is disabled (and shows
  an offline affordance / message) when `useConnectionStatus()` reports offline, and
  a receive cannot be submitted offline. When the connection returns, commit
  re-enables. There is NO offline queue — an offline attempt is blocked, not
  deferred.
- [ ] **AC-12 (success feedback + refresh).** On a successful receive, the screen
  shows a success confirmation (toast) and the open-PO list refreshes — a
  now-fully-received PO leaves the list, a partial one keeps its (updated) place.
  The refresh happens without realtime (AC-14): a re-fetch of the POs/lines on
  success (and on screen focus). A backend error surfaces via the staff
  `notifyBackendError` and leaves the inputs intact (no phantom success). In
  particular, the AC-2 server refusal (should staff ever reach it) surfaces as an
  error, not a success.
- [ ] **AC-13 (data path via carve-out).** The staff read of POs/lines and the
  receive RPC call go through the documented staff carve-out (direct `supabase.from`
  / `supabase.rpc` in a new `src/screens/staff/lib/` module), NOT `src/lib/db.ts`.
  The snake↔camel mapping is authored in the carve-out (verbatim-copy discipline,
  mirroring `fetchReorder.ts`'s copy of `mapReorderVendor`); the staff module NEVER
  sends a `new_case_price` key (belt to the server's braces — R-1).
- [ ] **AC-14 (no realtime).** The staff Receiving surface uses NO realtime
  subscription (spec 062). The list stays current via re-fetch on screen focus,
  after a successful commit, and via a manual Refresh affordance. `purchase_orders`
  is already in the realtime publication for the ADMIN side; this spec adds nothing
  to the publication and the mid-session-publication `docker restart` gotcha does not
  apply.

i18n:

- [ ] **AC-15 (staff catalog ×3 locales).** All new user-visible strings on the
  staff Receiving screen exist in **all three** staff locales (`src/screens/staff/i18n/{en,es,zh-CN}.json`)
  under a new `receiving.*` block (tab label, title/subtitle, list/empty states,
  column headers, received-now label, commit + committing + confirm strings,
  offline message, success + nothing-to-receive messages), matching the staff app's
  tone (compare `weekly.*` / `reorder.*`). No user-visible hardcoded English. **No
  admin catalog (`src/i18n/*.json`) change is expected** (the admin Receiving
  section is untouched).

## In scope

- **Backend slice:** a new migration `receive_purchase_order` re-CREATE (verbatim
  copy of the spec-109 body + ONE gate hunk) that refuses the PRICE PATH for
  non-privileged callers server-side (whole-call refusal, nothing durable), leaving
  the stock path unchanged for store members and the privileged price path unchanged
  (regression). pgTAP pinning AC-1..AC-4 (+ the AC-6 read confirmation).
- **Frontend slice:** a new staff Receiving screen (list of open POs → prefilled
  per-line "received now" inputs, minus price → confirm → idempotent commit →
  success + refresh + empty state), wired into the staff bottom-tab bar as a **4th
  tab** (PM recommendation; architect confirms — see OQ-2); a new staff carve-out
  lib (`src/screens/staff/lib/receiving.ts` or similar) that READS the store's open
  POs + lines and CALLS the receive RPC directly (never sending a price); the
  online-only gate via `useConnectionStatus`; staff i18n `receiving.*` ×3 locales.
- **Reuse (no change):** the spec-107/109 `receive_purchase_order` RPC + its
  `{ po_id, status, conflict, lines[], price_changes[] }` envelope (staff ignores
  `price_changes` — always `[]` on its calls); the existing `auth_can_see_store()`
  RLS on `purchase_orders` / `po_items`; the shared `confirmAction`
  (`src/utils/confirmAction.ts`) for the commit confirm; the staff
  `notifyBackendError`, theme, and `useConnectionStatus`.
- Tests on the matching tracks (named under Project-specific notes).

## Out of scope (explicitly)

- **Price / cost entry on the staff side (R-1).** No case-price input, no cost
  display, no fat-finger price guard on the staff screen; staff NEVER send
  `new_case_price`. The spec-109 price column, ghost, and 30% confirm stay
  ADMIN-only. Rationale: the binding R-1 ruling.
- **Offline queue / deferred receive (R-2).** Receiving requires a live connection;
  an offline attempt is blocked, not queued. Rationale: R-2. **Note (forward-looking,
  not a commitment):** the RPC's `receive_client_uuid` idempotency makes a future
  queued-receive version straightforward (a queued replay dedupes exactly like the
  EOD queue) — but that is a separate later spec, not v1.
- **Freeform (non-PO) receiving on the staff side.** The admin `FreeformReceivingMode`
  (`ReceivingSection.tsx:462+`, `adjustStock` + audit, no `po_items`) is NOT ported.
  Staff receive ONLY against real open POs. Rationale: the request is "receive
  deliveries against open purchase orders"; freeform stock adjustment is an admin
  affordance out of the ask.
- **Changing the admin Receiving section.** `ReceivingSection.tsx` (both modes) is
  untouched. Rationale: this spec adds a staff surface; it does not refactor admin.
- **The receive envelope / stock / status / idempotency semantics.** The RPC's
  additive stock accumulation, `partial`/`received` status flip, `received_at` NULL
  semantics, and `receive_client_uuid` dedup are unchanged — the ONLY backend delta
  is the price-path privilege gate. Rationale: R-1 is a targeted authorization fix,
  not a receive-logic rewrite.
- **Realtime propagation.** No realtime subscription for the staff screen and no
  publication change (spec 062; `purchase_orders` is already published for admin).
  Rationale: staff app has no realtime in v1.
- **Editing PO lines / creating POs / other PO lifecycle ops from staff** (send,
  mark-sent, cancel, close-short, add/remove/edit lines). Staff only RECEIVE against
  an already-open PO. Rationale: out of the ask; those stay admin.
- **The `app.json` slug, identity drift, and the repo-root spreadsheet** — untouched
  (CLAUDE.md load-bearing / DO-NOT-AUTO-FIX).

## Open questions resolved

### Owner rulings collected (binding — cited throughout)

- **R-1 (STOCK-ONLY for staff, enforced server-side).** Staff record delivered
  quantities → stock via the existing receive path. Price entry (`new_case_price` →
  the spec-109 ★ cost updates) stays ADMIN-ONLY and is enforced SERVER-SIDE, not by
  UI absence: a line carrying a non-null `new_case_price` from a non-privileged
  caller refuses the WHOLE call with a stable error + errcode, nothing durable
  written; the stock path is unchanged for store members. Body-only re-CREATE of
  the RPC (spec 109's migration is the source — copy verbatim + the one gate hunk).
  pgTAP pins staff-can-receive-stock, staff-price-refused-nothing-durable,
  privileged-price-unchanged, replay-unaffected. (Exact refusal string/errcode is
  the architect's to fix; recommend `42501` / `'forbidden: price change requires
  admin'`.)
- **R-2 (ONLINE-ONLY v1).** Receiving requires a live connection — the staff app's
  existing `useConnectionStatus` blocks submit when offline. No offline queue in v1
  (explicitly out-of-scope; `receive_client_uuid` idempotency noted as making a
  future queued version straightforward).

### PM defaults (owner accepts unless flagged)

- **OQ-1 — Which lines trigger the server refusal: any non-null `new_case_price`, or
  only a priced line whose price actually DIFFERS from the current one?**
  → **A (default): ANY non-null `new_case_price` triggers refusal for a
  non-privileged caller** — regardless of whether it differs. Rationale: R-1 says
  price ENTRY stays admin-only; refusing on the mere PRESENCE of a price is simpler,
  matches "staff can't enter prices," and avoids a same-price bypass. Architect
  confirms the predicate site (evaluate across all submitted lines before any write).
  **Owner-accepted as written** unless flagged.
- **OQ-2 — Placement in the staff nav: a 4th bottom-tab, or an entry point inside an
  existing screen?**
  → **A (PM recommendation): a 4th bottom-tab `Receiving`** in `StaffTabs`
  (`navigation/StaffStack.tsx`), a peer to Count / Reorder / Weekly, with a distinct
  icon (e.g. a truck / cube "receipt" glyph — the bar already uses
  clipboard / cart / calendar). Rationale: the nav is a flat bottom-tab bar that
  already grew from 1→3 tabs additively; receiving is a distinct top-level task, not
  a sub-view of counting or reordering. **Architect confirms** the exact tab
  slot + icon. If the architect prefers an entry point elsewhere, the screen and
  carve-out are unchanged — only the mount point moves. **Owner-accepted (mechanism
  deferred to architect).**
- **OQ-3 — Where does the server gate live: inline in the RPC body, an RLS policy, or
  a helper?**
  → **A (PM lean): inline in the `receive_purchase_order` body**, right after the
  existing `auth_can_see_store()` gate and before the loop / any write — a single
  guard that scans the submitted `p_lines` for a non-null `new_case_price` and, if
  present, requires `auth_is_privileged()` (else raises). Rationale: the RPC is
  SECURITY INVOKER and already co-locates the store gate; a body-only hunk keeps the
  verbatim-copy discipline (R-1) and one authorization site. RLS can't easily express
  "refuse based on a value inside the RPC's jsonb argument," so the inline guard is
  the natural fit. **Architect fixes the exact mechanism + string/errcode.**
  **Owner-accepted (mechanism deferred to architect).**
- **OQ-4 — Does the staff screen show the PO's `price_changes` result at all?**
  → **A (default): NO.** Staff never send a price, so `price_changes` is always `[]`
  on staff calls; the staff success feedback is the received/partial status only (no
  "prices updated" toast — that stays admin, `ReceivingSection.tsx:227-232`).
  Rationale: R-1 keeps cost invisible to staff. **Owner-accepted as written.**
- **OQ-5 — Refresh trigger without realtime.**
  → **A (default): re-fetch on screen focus + after a successful commit + a manual
  Refresh affordance** (the staff Reorder pattern, `Reorder.tsx:357-373`). No
  realtime subscription (AC-14). **Owner-accepted as written.**

## Dependencies

- **Spec 107 (live)** — the PO-driven receive flow + the `receive_purchase_order`
  RPC (additive/idempotent stock, `partial`/`received` status, `receive_client_uuid`)
  + the existing `auth_can_see_store()` RLS on `purchase_orders` / `po_items`. The
  staff screen mirrors the admin PO-driven UX (open-PO list, outstanding prefill,
  additive deltas, commit confirm) minus the price column.
- **Spec 109 (live)** — the CURRENT `receive_purchase_order` source
  (`supabase/migrations/20260705000000_cost_on_receipt.sql`) that the backend slice
  copies VERBATIM and adds the one gate hunk to. The §3b price/cost path is the code
  the gate now guards. `price_changes[]` stays in the envelope (staff ignore it).
- **A new migration** — re-CREATEs `receive_purchase_order(uuid, jsonb, uuid)`
  (body-only; verbatim spec-109 body + the priced-line privilege gate). Proposed
  filename sorts after the latest on disk (`20260706000000_store_count_layouts.sql`):
  e.g. `supabase/migrations/20260707000000_staff_receiving_price_gate.sql`. Signature
  unchanged ⇒ `create or replace` preserves the spec-107 grants (no grant/revoke
  re-emit). No schema DDL, no policy change, no publication change. Applied to prod
  via the Supabase MCP (project memory "Prod migration via Supabase MCP" — `db push`
  lacks the prod password), then the exact version inserted into `schema_migrations`
  so `db-migrations-applied.yml` (spec 064) stays green; POST-APPLY verify the body
  carries the gate (a body-only change is invisible to the migration-list drift gate
  — same caveat spec 104 / 107 / 109 documented; e.g. `pg_get_functiondef` LIKE the
  gate's error string). The developer FLAGS the prod-apply in the handoff; they do
  not push it themselves.
- **`auth_can_see_store()` and `auth_is_privileged()`**
  (`supabase/migrations/20260504173035_per_store_rls_hardening.sql` + the privileged
  predicate) — the store gate (already in the RPC) and the admin-OR-super-admin gate
  the new price-path guard adds. `auth_can_see_store()` works for the staff JWT
  (staff read + stock-receive); `auth_is_privileged()` is false for staff (so the
  price path refuses).
- **The staff-subtree carve-out** (`src/screens/staff/`, spec 063) — a new staff-local
  lib that READS the store's open POs + their lines
  (`supabase.from('purchase_orders')...` / `supabase.from('po_items')...`) and CALLS
  `supabase.rpc('receive_purchase_order', ...)` directly, minting the client uuid,
  NEVER sending a `new_case_price`. Mapping copied verbatim (mirrors
  `fetchReorder.ts` / the `PoLine` mapper). No `db.ts` import.
- **`useConnectionStatus`** (`src/screens/staff/hooks/useConnectionStatus.ts`) — the
  online-only gate (R-2).
- **`confirmAction`** (`src/utils/confirmAction.ts`) — the commit confirm (used by the
  admin section too).
- **Staff i18n catalogs** (`src/screens/staff/i18n/{en,es,zh-CN}.json`) — a new
  `receiving.*` block (AC-15). No admin catalog change.
- **`StaffTabs`** (`src/screens/staff/navigation/StaffStack.tsx`) — the mount point
  for the new tab (OQ-2).

## Project-specific notes

- **Cmd UI section / legacy:** N/A for the frontend — this is the **staff surface**
  (`src/screens/staff/`, folded in per spec 063), not a Cmd UI section and not
  legacy (spec 025 deleted the legacy admin surface). The admin Cmd UI
  `ReceivingSection.tsx` is the sibling that already exists and is NOT touched.
- **Which app:** this repo only — the folded-in **staff** app (native + web). No
  admin Cmd UI change, no customer-PWA work.
- **Per-store or admin-global:** **per-store.** Receiving is store-scoped: the staff
  member's `activeStore` (shared with EOD / Reorder / Weekly), and every read + the
  RPC ride the existing `auth_can_see_store()` gate. The NEW server-side rule adds an
  `auth_is_privileged()` gate on the **price path only** — the stock path stays
  store-member-scoped. Do NOT gate the stock path on privilege (that would break
  staff receiving entirely — R-1 is stock-for-staff).
- **Server-side price gate is load-bearing (not UI-only).** Per R-1 / AC-2, hiding
  the price input on the staff screen is necessary but NOT sufficient — a staff
  session sending `new_case_price` via a crafted RPC call must be refused
  server-side with nothing durable. The security-auditor / reviewer should confirm
  the gate is in the RPC body (mirrors the CLAUDE.md convention that privileged
  operations enforce the gate server-side — `auth_is_privileged()` is the
  admin-OR-super-admin DB predicate; the edge-function `ADMIN_ROLES` set is its TS
  mirror), fires BEFORE any side-effect, and uses a stable refusal string/errcode.
- **Realtime channels touched:** **none — deliberate ABSENCE (spec 062 / AC-14).**
  The staff app uses no realtime; the screen refreshes on focus / commit / manual
  Refresh. `purchase_orders` is ALREADY in `supabase_realtime` (for the admin
  `store-{id}` reload) — this spec adds nothing to the publication, so the
  mid-session-publication `docker restart supabase_realtime_imr-inventory` gotcha
  does NOT apply.
- **Migrations needed:** **yes** — one body-only re-CREATE of
  `receive_purchase_order` (verbatim spec-109 body + the priced-line privilege gate).
  No schema DDL, no RLS/policy change, no publication change. Prod-apply via Supabase
  MCP + `schema_migrations` insert (spec 064 gate); POST-APPLY body verification
  (the drift gate can't see a body-only change).
- **Edge functions touched:** **none.** This is PostgREST reads + the existing
  Postgres RPC (via the staff carve-out) + RLS entirely. No `staff-*` /
  service-token / `pwa-catalog` bearer surface (those `staff-*` functions are HTTP
  410 stubs — the staff app talks to PostgREST/RPCs directly, spec 061).
- **Web/native scope:** **both** — the staff app runs on native (EAS) and web
  (Vercel). The Receiving screen (list, per-line numeric inputs, commit confirm,
  offline gate) renders on both, in the staff light/dark theme. No web-only
  affordance.
- **`app.json` slug:** untouched — this feature has no bearing on build identifiers;
  `slug` stays `towson-inventory` pending explicit approval.
- **Test tracks (spec 022):**
  - **pgTAP** (primary — the headline of the backend slice): (a) a staff-role member
    of Store A CAN receive stock-only lines (stock + received_qty + status +
    'PO received' audit + envelope, AC-1); (b) a staff-role member sending
    `new_case_price` on a line is REFUSED with the stable error/errcode and NOTHING
    durable — assert `po_items.received_qty`, `inventory_items.current_stock` /
    `case_price` / `cost_per_unit`, `item_vendors`, `audit_log`, and
    `receive_client_uuid` are all UNCHANGED after the failed call (AC-2); (c) a
    privileged caller's changed-price receive still updates both targets + writes the
    'PO price change' audit + returns `price_changes[]` (AC-3 regression); (d)
    idempotent replay of a staff stock-only receive returns `conflict: true` and
    re-applies nothing, and is not spuriously refused (AC-4); (e) the read
    confirmation — a staff-role Store-A member SELECTs Store A's open POs + lines, a
    Store-B-only member gets 0 rows (AC-6; may lean on the spec-107 R1/R4 fixtures).
    The spec-053 permissive-policy lint arm runs automatically (no new policy is
    added, so no allowlist edit is expected).
  - **jest**: the staff Receiving screen — open-PO list + empty state render; picking
    a PO prefills the outstanding remainder and shows NO price input; the commit
    builds additive stock-only deltas (no `new_case_price` key ever present) and
    mints one client uuid; the online-only gate disables commit when
    `useConnectionStatus` is mocked offline (AC-11); success toast + list refresh on
    resolve; a backend error surfaces via notifyBackendError and leaves inputs
    intact. Any extracted pure helper (e.g. the outstanding-remainder / delta builder)
    gets a unit test.
  - **e2e (Playwright, spec 078/079)** — **optional**: the e2e track MAY extend the
    staff flow with an open-PO → receive → list-refresh happy path on web. Noted as
    optional (not a blocking acceptance criterion); the jest + pgTAP tracks are the
    required coverage.

## Backend design

Verified against the code before designing: `receive_purchase_order`'s current
on-disk source (`20260705000000_cost_on_receipt.sql:122-386`, read in full), the
`auth_is_privileged()` helper (`20260509000000_multi_brand_schema_rls.sql:235-243`
— `auth_is_admin() OR auth_is_super_admin()`, SECURITY DEFINER, granted to
`authenticated, anon`, returns false for `staff`/`user` roles), the latest
on-disk migration (`20260706000000_store_count_layouts.sql`; no `2026071*` files
exist), the spec-109 pgTAP suite (`supabase/tests/cost_on_receipt.test.sql`, 55
assertions, master-JWT + `set role authenticated` + jwt-claims pattern, hermetic
`begin;…rollback;`), the staff carve-out shape (`fetchReorder.ts`,
`useConnectionStatus.ts`, `uuid.ts`, `StaffStack.tsx`), and the admin
`PoLine`/`receivePurchaseOrder` reference (`db.ts:1404-1625`,
`useStore.ts:2571-2602`).

This is a **targeted authorization fix + a new staff read/write surface** — no
schema DDL, no new RLS policy, no publication change, no edge function. The
entire backend delta is **one gate hunk** in a signature-stable re-CREATE.

### 0. Decision summary (the fixed rulings, byte-for-byte)

| # | Decision | Value |
|---|----------|-------|
| Migration filename | proposed | `supabase/migrations/20260707000000_staff_receiving_price_gate.sql` |
| Sort order | confirmed | `…0707…` > `…0706…` (latest on disk) — sorts last ✓ |
| Gate placement | fixed | inside the §3b cost branch, as the FIRST statement after `if v_item_id is not null and v_line.new_case_price is not null then` (cost_on_receipt.sql:228), **before** the `< 0` validation (line 229) |
| Refusal errcode | fixed | `42501` (insufficient_privilege — the house errcode for authorization refusals; matches the `auth_can_see_store` gate three lines up) |
| Refusal string | **PINNED** | `forbidden: price change requires admin` |
| Gate predicate | fixed | `not public.auth_is_privileged()` |
| pgTAP file | fixed | NEW file `supabase/tests/staff_receiving_gate.test.sql` (do NOT extend `cost_on_receipt.test.sql`) |
| Staff carve-out | fixed | new `src/screens/staff/lib/receiving.ts` (never sends `new_case_price`) |
| Nav mount | fixed | 4th bottom-tab `Receiving` in `StaffTabs` |

**The pinned refusal string joins the house stable-string family.** It is a
byte-for-byte contract — the same discipline as `'cannot delete self'`
(delete-user/index.ts:168), `'cannot demote self'`
(20260520000000_demote_profile_to_user_rpc.sql), and `'cannot delete the last
super_admin'` (assert_not_last_of_role). pgTAP pins it byte-equal (case f below);
the string may not be reworded without editing the test in the same PR. It follows
the `'forbidden: <what> requires <who>'` shape (parallel to the `'cannot <verb>
self'` convention — a stable, greppable, human-legible refusal).

---

### 1. Data model changes

**None.** No `CREATE TABLE`, no `ALTER TABLE`, no column, no index, no
constraint. Every target the RPC touches already exists at the right type (the
cost_on_receipt.sql:87-92 inventory confirms this). Purely additive at the
authorization layer.

**Migration (body-only re-CREATE):**
`supabase/migrations/20260707000000_staff_receiving_price_gate.sql`

- **Rollout safety: ADDITIVE + signature-stable.** `create or replace function
  public.receive_purchase_order(uuid, jsonb, uuid)` with the byte-identical
  signature ⇒ `create or replace` PRESERVES the spec-107 ACL (`revoke … from
  public, anon; grant … to authenticated`). **No grant/revoke re-emit** (matches
  the spec-104/107/109 discipline). SECURITY INVOKER + `set search_path = public`
  unchanged.
- **NOT destructive.** The stock path, status flip, idempotency stamp, envelope
  shape, and the privileged cost path are all byte-identical to spec 109. A
  non-privileged caller *gains* a refusal on the price path (which they should
  never have had access to); a privileged caller sees no behavior change; a
  store-member stock-only receive is unaffected.
- **House verbatim-copy discipline.** The body is copied VERBATIM from
  `20260705000000_cost_on_receipt.sql:122-386` and exactly **one** gate hunk is
  added. The migration header must document this the way cost_on_receipt.sql:22-75
  documented its copy against po_loop.sql — cite the source line range and state
  the single delta. A code-review diff must confirm the ONLY change vs
  cost_on_receipt is the gate hunk + its comment (AC-5).

**The one gate hunk (exact placement + pseudocode).** In the verbatim body, the
§3b branch currently reads:

```
-- (3b) COST — spec 109 HUNK 2/3. Only when the line resolved to a real item
-- AND a new case price was entered. …
if v_item_id is not null and v_line.new_case_price is not null then
  if v_line.new_case_price < 0 then
    raise exception 'invalid new_case_price % for po_item %', …
```

The gate is inserted as the FIRST statement inside that `if`, **before** the
`< 0` check:

```
if v_item_id is not null and v_line.new_case_price is not null then
  -- spec 113 GATE (R-1): the price path is admin-only, enforced server-side.
  -- A non-privileged caller who reaches a priced line — even via a hand-crafted
  -- RPC call — is refused for the WHOLE call before any write or idempotency
  -- stamp. Refuse on PRESENCE (OQ-1), not on value, and BEFORE the <0 validation
  -- so a non-privileged caller gets the SAME refusal regardless of the price
  -- value (0, negative, equal, or different). auth_is_privileged() = admin OR
  -- super_admin (false for staff/user). auth_can_see_store already passed above;
  -- this is the SECOND, price-specific gate.
  if not public.auth_is_privileged() then
    raise exception 'forbidden: price change requires admin' using errcode = '42501';
  end if;

  if v_line.new_case_price < 0 then
    raise exception 'invalid new_case_price % for po_item %', …   -- (unchanged)
```

**Why this placement is correct (the load-bearing reasoning):**

- **It fires before ANY durable write for the priced line.** But note the loop
  order: the §3a stock `UPDATE` (cost_on_receipt.sql:216-222) and the
  `po_items.received_qty` `UPDATE` (208-212) run EARLIER in the SAME loop
  iteration, before §3b. **This is safe because plpgsql functions run in a single
  implicit transaction: a `raise exception` aborts and rolls back the entire
  function**, including any stock/received_qty writes from earlier iterations and
  the current one. So "nothing durable" (AC-2) holds even though the raise is
  physically after the stock UPDATE in source order — the rollback is atomic. The
  pgTAP asserts this directly (case b below: after the refused call, `received_qty`,
  `current_stock`, `case_price`, `cost_per_unit`, `item_vendors`, `audit_log`, and
  `receive_client_uuid` are ALL unchanged). This mirrors the spec-109 pgTAP case
  (5), which proved the `< 0` P0001 abort three lines below already rolls back the
  stock write in the same loop.
- **It fires BEFORE the idempotency stamp** (the step-4 `receive_client_uuid`
  UPDATE at 344-350 is after the loop), so a refused call never stamps the PO's
  dedup key. AC-2's "no `receive_client_uuid` stamp" holds.
- **Presence, not value (OQ-1).** Placed before the `< 0` check, the gate keys
  ONLY on `v_line.new_case_price is not null` (the enclosing `if`). A staff caller
  sending `new_case_price: -1`, `0`, `20` (equal), or `99` (different) gets the
  identical `42501 forbidden: price change requires admin` — no value-dependent
  branch is reachable by a non-privileged caller. A privileged caller falls
  through to the existing `< 0` / distinct-from logic unchanged.

**The JSON-null / absent-key / zero cases (state explicitly, per the task):**

- **Absent key or explicit JSON `null`** → `jsonb_to_recordset` yields SQL `NULL`
  (cost_on_receipt.sql:199-202 documents this). The enclosing `if v_item_id is not
  null and v_line.new_case_price is not null` is FALSE, so the §3b branch — and
  the new gate inside it — is **skipped entirely**. A staff stock-only receive
  (no price key) never reaches the gate and flows the spec-107 stock path
  untouched. ✓ (AC-1)
- **`new_case_price` present-but-null (JSON `null`)** → same as absent: SQL NULL →
  outer `is not null` is FALSE → gate skipped. The gate does NOT need to special-
  case JSON null; the existing `is not null` disambiguator already handles it. So
  a staff payload that (harmlessly) carries `"new_case_price": null` is NOT
  refused — it is treated as stock-only, which is the correct staff behavior. (The
  staff carve-out never sends the key at all — belt-and-braces — but the server is
  robust to a null-valued key regardless.)
- **`new_case_price: 0` from staff** → `0 is not null` is TRUE → the §3b branch is
  entered → the gate fires → `42501`. This is intentional per OQ-1: a zero price
  is still price ENTRY, and staff should never send the key. (Contrast: a
  *privileged* caller sending `0` falls through the gate to the `> 0` test and
  treats it as "no price entered" — the spec-109 no-op. The gate does not change
  privileged-caller semantics.) The staff carve-out never sends `0` either — it
  omits the key — so this path is only reachable by a hand-crafted staff RPC call,
  which is exactly what R-1 exists to refuse.

**Prod-apply (owner-gated — the spec-104/107/109 pattern, body-only caveat):**

- `db push` lacks the prod password (project MEMORY). Apply via Supabase MCP
  `execute_sql` against `ebwnovzzkwhsdxkpyjka`, then INSERT the exact version
  `20260707000000` into `supabase_migrations.schema_migrations` so the
  `db-migrations-applied.yml` gate (spec 064) stays green.
- **A body-only change is INVISIBLE to the migration-list drift gate** (same
  caveat spec 104/107/109 documented). POST-APPLY, verify the function carries the
  gate — normalized-md5 local-vs-prod OR a `pg_get_functiondef` LIKE probe:
  `select 1 from pg_proc where proname = 'receive_purchase_order' and
  pg_get_functiondef(oid) like '%forbidden: price change requires admin%';`
- **The developer FLAGS the prod-apply in the handoff; they do NOT push it
  themselves.** (Consistent with the dependencies section.)

### 2. RLS impact

**No new policy. No policy change.** Enumerated:

- **Read surface (`purchase_orders`, `po_items`)** — already under
  `auth_can_see_store()` for SELECT (spec 107, po_loop.sql:32; R1/R4 pinned by
  spec-107 pgTAP). A staff-role member of Store A already reads Store A's POs and
  lines; a non-member gets 0 rows. **This spec adds NO read policy** (AC-6). The
  staff read rides the existing gate exactly as the admin read does.
- **Write surface (the RPC)** — SECURITY INVOKER, so every write inside it rides
  the CALLER's RLS: the top-of-function `auth_can_see_store(v_store_id)` gate
  (cost_on_receipt.sql:163-165) is the store gate for the stock path, unchanged.
  The NEW `auth_is_privileged()` gate is a SECOND, price-path-specific
  authorization check layered on top — it does NOT touch RLS policy definitions;
  it is an inline guard inside the function body (OQ-3 resolution: RLS can't
  express "refuse based on a value inside the jsonb argument," so the inline guard
  is the natural fit).
- **Do NOT gate the stock path on privilege.** The gate is strictly inside §3b
  (the price branch). The §3a stock write and the `po_items.received_qty` write
  stay gated ONLY by the store-membership check. Gating stock on privilege would
  break staff receiving entirely (R-1 is stock-FOR-staff). The reviewer must
  confirm the gate is inside the §3b `if`, not before the loop.
- **Permissive-policy lint (spec 053).** No new policy is added, so **no allowlist
  edit** to `permissive_policy_lint.test.sql` is expected. The lint arm runs
  automatically and should stay green.

### 3. API contract

**RPC (unchanged surface + one new error case).** `receive_purchase_order(p_po_id
uuid, p_lines jsonb, p_client_uuid uuid) returns jsonb`. This is the spec-107/109
RPC — signature, request shape, and envelope are all unchanged.

- **Request shape** (per line in `p_lines`): `{ "po_item_id": uuid,
  "received_qty": numeric, "new_case_price"?: numeric }`. **Staff calls omit
  `new_case_price` entirely** (stock-only). Admin calls may include it.
- **Response (envelope, unchanged):** `{ po_id, status, conflict, lines[],
  price_changes[] }`. On staff calls `price_changes` is always `[]` (staff never
  send a price). `lines[]` carries `{ po_item_id, received_qty }` cumulative
  totals.
- **Error cases:**
  | Condition | errcode | HTTP (PostgREST) | Note |
  |-----------|---------|------------------|------|
  | PO not found | `P0002` | 404 | unchanged (line 161) |
  | Caller can't see store | `42501` | 403 | unchanged (line 164) — `Not authorized for store …` |
  | **Priced line + non-privileged caller** | **`42501`** | **403** | **NEW — `forbidden: price change requires admin`** |
  | Priced line, privileged, `new_case_price < 0` | `P0001` | 400 | unchanged (line 230) — order: gate first, then this |
  | Non-numeric `new_case_price` | `22P02` | 400 | unchanged (cast, line 205) |

  Note both authorization refusals share errcode `42501` but are distinguishable
  by message: the store gate says `Not authorized for store <uuid>`; the new price
  gate says `forbidden: price change requires admin`. pgTAP pins the price-gate
  message byte-equal (case f). PostgREST surfaces the SQL `message` field, so the
  staff `notifyBackendError` receives the pinned string (though staff should never
  reach it — the carve-out omits the key).

- **PostgREST vs RPC decision:** the write MUST be the RPC (it is the existing
  idempotent additive receive; not expressible as a table write). The read is
  plain PostgREST SELECT on `purchase_orders` + `po_items` (RLS-gated, no RPC
  needed — mirrors the admin `fetchPurchaseOrderLines` projection).

### 4. Edge function changes

**None.** No new or modified edge function; no `verify_jwt` change; no
service-token surface. This is PostgREST reads + the existing Postgres RPC via the
staff carve-out + RLS entirely. (The `staff-*` functions are HTTP 410 stubs — the
staff app talks to PostgREST/RPCs directly, spec 061 — and stay untouched.)

### 5. `src/lib/db.ts` surface

**No change to `src/lib/db.ts`.** Per the documented staff carve-out (CLAUDE.md
"DB access centralized"; spec 063), the staff subtree calls `supabase.from/rpc`
directly. The new read + RPC call live in a **new staff-local lib**, NOT in
`db.ts`. The admin `db.receivePurchaseOrder` (db.ts:1576-1625) is the reference
shape the carve-out mirrors, but is not imported.

**New carve-out lib: `src/screens/staff/lib/receiving.ts`** (mirrors
`fetchReorder.ts`'s carve-out discipline — direct supabase, verbatim-copied
mapper, no `db.ts` import, no `useInflight.track()`, plain `await`). Signatures:

```ts
// Staff-local PO line shape — MIRRORS the admin PoLine (db.ts:1404-1428) MINUS
// every price/cost field. No costPerUnit, no case price, no subUnitSize/caseQty
// (those exist only to drive the admin case-price ghost + 30% bridge — R-1: no
// price surface on staff). Verbatim-copy discipline: if the po_items projection
// changes, this AND the admin copy update, but this copy NEVER gains a price field.
export interface StaffPoLine {
  poItemId: string;      // po_items.id
  itemId: string;        // inventory_items.id
  itemName: string;      // catalog_ingredients.name (localizable via i18nNames)
  unit: string;          // catalog_ingredients.unit
  orderedQty: number;    // ordered_qty (0 when null)
  receivedQty: number;   // cumulative received_qty (0 when null)
  i18nNames?: LocalizedNames;  // spec 100 per-item name overrides (staff renders localized)
}

// One open PO header for the list (AC-7).
export interface StaffOpenPo {
  id: string;
  status: 'sent' | 'partial';   // the two OPEN states (same filter as admin)
  vendorName: string;           // joined vendors.name
  referenceDate: string | null; // reference_date (the delivery/order date shown)
  createdAt: string;            // for newest-first sort
}

// (a) List the active store's OPEN POs (status ∈ {sent, partial}), newest-first.
//     RLS auth_can_see_store — staff-readable. Throws on PostgREST error (screen
//     catches → notifyStaffBackendError + error pane, the fetchReorder idiom).
export async function fetchStaffOpenPos(storeId: string): Promise<StaffOpenPo[]>;

// (b) Load one PO's real po_items lines, joined inventory_items →
//     catalog_ingredients for name/unit/i18n_names. NO price/cost column selected
//     (R-1). Throws on error.
export async function fetchStaffPoLines(poId: string): Promise<StaffPoLine[]>;

// (c) Commit a stock-only receive. Calls receive_purchase_order with the additive
//     deltas and the caller-minted clientUuid. NEVER sends a new_case_price key
//     (belt to the server's braces — R-1). Returns the resulting status +
//     conflict flag. Throws on error (incl. the AC-2 42501 should staff ever
//     hand-craft a priced call — surfaced as an error, never a phantom success).
export async function submitStaffReceive(
  poId: string,
  lines: Array<{ poItemId: string; receivedQty: number }>,  // NO price field in the type
  clientUuid: string,
): Promise<{ status: string; conflict: boolean }>;
```

**snake_case → camelCase mapping (authored in the carve-out, verbatim-copy
discipline):**

- `fetchStaffOpenPos`: `.from('purchase_orders').select('id, status,
  reference_date, created_at, vendors(name)').eq('store_id',
  storeId).in('status', ['sent','partial']).order('created_at', { ascending:
  false })`. Map `vendors.name → vendorName`, `reference_date → referenceDate`,
  `created_at → createdAt`. (The `vendors(name)` join rides the existing vendor
  read RLS; if that join is awkward under RLS, fall back to `vendor_id` + a
  separate vendors fetch — but the join is the same shape `fetchReorder` and the
  admin PO list already use.)
- `fetchStaffPoLines`: `.from('po_items').select('id, item_id, ordered_qty,
  received_qty, inventory_items(catalog_id, catalog_ingredients(name, unit,
  i18n_names))').eq('po_id', poId)`. Map through `inventory_items.catalog_ingredients`
  for `itemName`/`unit`/`i18nNames` — the admin `mapPoItemRow` (db.ts:1416-1430)
  is the reference, MINUS `costPerUnit`/`subUnitSize`/`caseQty` (**do not select
  or map `cost_per_unit`** — R-1). Note the admin projection does NOT fetch
  `i18n_names`; the staff copy ADDS it (mirroring the `fetchReorder.ts`
  divergence, spec 100 — staff renders localized names, admin stays English).
- `submitStaffReceive`: `supabase.rpc('receive_purchase_order', { p_po_id: poId,
  p_lines: lines.map(ln => ({ po_item_id: ln.poItemId, received_qty:
  ln.receivedQty })), p_client_uuid: clientUuid })`. **The mapped line object
  contains exactly two keys — no `new_case_price`.** Read back `data.status`,
  `!!data.conflict`; ignore `data.price_changes` (always `[]` — OQ-4).

### 6. Realtime impact

**None — deliberate absence (spec 062 / AC-14).** The staff app uses NO realtime.
The Receiving screen refreshes on: screen focus (`useFocusEffect`), after a
successful commit (re-fetch open POs), and a manual Refresh affordance (OQ-5 — the
`Reorder.tsx` pattern).

**Publication gotcha does NOT apply.** The migration makes NO change to
`supabase_realtime` publication membership (no `alter publication … add table`).
`purchase_orders` is ALREADY in the publication for the admin `store-{id}` reload.
Because the migration touches only a function body, **no `docker restart
supabase_realtime_imr-inventory` step is needed** after `npm run dev:db`. Flag
for the reviewer: this is a non-event for realtime — call it out explicitly so no
one adds a spurious publication line to the migration.

### 7. Frontend store impact

**No slice of `src/store/useStore.ts` changes** (that is the ADMIN store; the
admin Receiving section is untouched — out of scope). The staff app uses
`useStaffStore` + screen-local `useState`.

**Optimistic-then-revert does NOT apply here.** Receiving is ONLINE-ONLY (R-2) and
mutates stock through the RPC; the screen uses a **synchronous request/await +
success-then-refetch** model (mirrors `WeeklyCount` submit and the admin
`receivePurchaseOrder`), NOT the optimistic-write-then-revert pattern. On error,
the staff `notifyBackendError` (`notifyStaffBackendError` alias) surfaces a toast
and the inputs stay intact (no phantom success — AC-12). There is no local slice
holding a to-be-reverted optimistic value.

- **`useStaffStore` slice:** the screen reads `activeStore` (shared with EOD /
  Reorder / Weekly) and the sign-out/switch-store actions (mirroring `Reorder.tsx`
  header). No NEW slice is added — receiving state (selected PO, per-line inputs,
  in-flight flag) is screen-local `useState` (the `Reorder`/`WeeklyCount`
  decision-B pattern).
- **Client uuid mint:** minted ONCE per commit via the staff `uuidv4()`
  (`src/screens/staff/lib/uuid.ts`) — mirrors `useStore.receivePurchaseOrder` /
  `submitWeeklyCount`. A double-tap/in-flight retry dedupes server-side (AC-4/AC-10).
- **Online gate:** `useConnectionStatus()` → `isOnline`; the commit control is
  disabled when offline and the submit handler early-returns with an offline
  message if `!isOnline` (the `WeeklyCount.tsx:546` idiom). No offline queue.

### 8. Risks and tradeoffs (explicit)

- **Migration ordering — LOW.** `20260707000000` sorts after the latest on-disk
  `20260706000000`. No inter-migration dependency beyond the function already
  existing (it does, from spec 109). Verified no `2026071*` collision.
- **RLS gap — the whole point, and it's closed here.** The pre-existing hole:
  §3b had NO role gate, so any store member (incl. staff) could rewrite item costs
  via a crafted `new_case_price`. This spec closes it. The residual risk is a
  reviewer/dev placing the gate in the wrong spot (before the loop → would also
  refuse a privileged caller's non-priced lines spuriously; or after §3a but
  keyed on value → same-price bypass). The FIXED placement (first statement in
  §3b, presence-keyed, before `< 0`) avoids both. Reviewer must confirm the exact
  site and that AC-3 (privileged price path) still passes byte-identically.
- **"Nothing durable" depends on transaction rollback, not statement order.**
  The stock UPDATE runs before the gate in source order; correctness relies on the
  plpgsql implicit-transaction rollback on `raise`. This is proven behavior (the
  spec-109 `< 0` case (5) already relied on it), and the new pgTAP case (b) pins
  it directly across all six durable targets. Low risk, but it is the subtlest
  point in the design — hence the inline comment and the dedicated test.
- **Performance on the 286 KB seed — negligible.** The gate is a single
  `auth_is_privileged()` call (a STABLE SECURITY-DEFINER function already invoked
  across the RLS layer, cached per-statement) inside a branch that only executes
  when a priced line is present. Staff calls never enter the branch. No new
  query, no new index need. The staff read is two RLS-filtered SELECTs (same
  shape as the admin PO list, which performs fine on seed).
- **Edge-function cold-start — N/A.** No edge function involved.
- **`price_changes` invariant for staff — belt-and-braces.** Staff never send a
  price, so `price_changes` is always `[]` on their calls (OQ-4). The screen does
  not surface it. Even if a future refactor accidentally sent a key, the server
  gate refuses it — the two layers (carve-out omits the key; server rejects it if
  present) are independent, per R-1's "UI absence is necessary but not sufficient."
- **i18n completeness — reviewer check.** All new strings must exist in all three
  staff locales (`en`, `es`, `zh-CN`) under `receiving.*`. A missing key surfaces
  the raw key at runtime; the jest render tests + a locale-parity check catch it.

---

### pgTAP plan — `supabase/tests/staff_receiving_gate.test.sql` (NEW file)

Rationale for a new file: keep the 55-assertion spec-109 suite pinned to its own
migration (`cost_on_receipt.test.sql` proves the cost path); this file proves the
gate + the read confirmation. Same harness idioms: `begin; create extension if not
exists pgtap; select plan(N); … select * from finish(); rollback;`, `set local
role authenticated`, jwt-claims via `set_config('request.jwt.claims', …)`,
fixtures created INSIDE the transaction (hermetic under seed AND CI-fresh), NO `set
role anon` (segfaults CI per spec 067), master JWT (`3333…`, `app_metadata.role =
master` → `auth_is_privileged()` true) for privileged fixtures/probes.

**JWT roles used:** a **staff-role** member of Store A (a `user`/`staff` role that
passes `auth_can_see_store(A)` but fails `auth_is_privileged()`), a Store-B-only
member (fails `auth_can_see_store(A)`), and the master (privileged). Reuse the
seed member ids the spec-109 test uses: `2222…` is a Towson+Frederick member with
`app_metadata.role = user` (NON-privileged, passes `auth_can_see_store` for
Frederick) — this is the "staff store-member" caller for cases a/b/d. Charles is
the store `2222` is NOT a member of (case e non-member). Master `3333` is the
privileged caller (case c). ★ packing: `case_qty = 4, sub_unit_size = 1` (divisor
4) as in the spec-109 suite, so case 40 ⇒ per-each 10.

Enumerated cases:

- **(a) AC-1 — staff store-member stock-only receive SUCCEEDS.** As `2222` (user
  role, Frederick member): a fresh Frederick PO (`sent`, one line ordered 8,
  received null, `case_price` 20 baseline on item + link). Call
  `receive_purchase_order(po, [{po_item_id, received_qty: 8}], uuid)` — NO price
  key. Assert: envelope `status = 'received'`, `conflict = false`,
  `price_changes = []`; `po_items.received_qty = 8`; `inventory_items.current_stock
  = 18` (10 + 8); `item_vendors.case_price` and `inventory_items.case_price` STILL
  20 (unchanged — no price path); exactly one `'PO received'` audit row for the
  store; NO `'PO price change'` row. (Proves staff CAN receive stock and the price
  side stays put.)
- **(b) AC-2 — staff member with `new_case_price` on ANY line → 42501, NOTHING
  durable.** As `2222`: a fresh Frederick PO (one line ordered 8, received null,
  baseline 20, current_stock 10). `throws_ok(… receive with
  [{po_item_id, received_qty: 8, new_case_price: 40}] …, '42501', …)`. Then
  (as master, to read past RLS) assert EVERY durable target is unchanged:
  - `po_items.received_qty` still null (or 0) — NOT 8;
  - `inventory_items.current_stock` still 10 — NOT 18;
  - `inventory_items.case_price` still 20; `inventory_items.cost_per_unit` still 5;
  - `item_vendors.case_price` still 20; `item_vendors.cost_per_unit` still 5;
  - `audit_log`: NO `'PO received'` AND NO `'PO price change'` row for this PO;
  - `purchase_orders.receive_client_uuid` still null (dedup key NOT stamped);
  - `purchase_orders.status` still `'sent'` (NOT flipped).
  This is the headline assertion cluster — the whole-call-refusal / nothing-durable
  proof. Additionally pin the presence-not-value predicate: repeat `throws_ok`
  with `new_case_price: 0`, `new_case_price: 20` (equal-to-current), and
  `new_case_price: -1` — ALL must raise `42501` (the gate fires before the `< 0`
  P0001 and regardless of value; a non-privileged caller can never reach the value
  branches).
- **(c) AC-3 — privileged caller's changed-price receive STILL works (regression).**
  As master `3333`: a fresh Frederick PO (line ordered 8, baseline 20). Receive
  with `new_case_price: 40`. Assert the spec-109 semantics survive the re-CREATE
  byte-identically: `item_vendors.case_price 20 → 40` + `cost_per_unit → 10` (★);
  `inventory_items.case_price 20 → 40` + `cost_per_unit → 10`; `current_stock 10 →
  18`; one `'PO price change'` audit row (old→new case + per-each); envelope
  `price_changes` has one element with the full shape. (A focused regression pin —
  the full spec-109 matrix stays in `cost_on_receipt.test.sql`; this proves the
  hunk didn't break the privileged path.)
- **(d) AC-4 — staff replay idempotency UNAFFECTED + not spuriously refused.** As
  `2222`: a fresh Frederick PO (line ordered 4). First call: stock-only receive
  `[{received_qty: 4}]` with a FIXED `client_uuid` → succeeds, `status =
  'received'`, stock 10 → 14. Replay the SAME `client_uuid`, SAME stock-only lines
  (no price key) → assert `conflict = true`, `price_changes = []`, stock STILL 14
  (NOT double-incremented), `received_qty` still 4, exactly one `'PO received'`
  audit row. Crucially: the replay carries NO priced line, so the gate is NOT
  reached — assert the replay does NOT raise (it returns the prior envelope). This
  pins "the gate is evaluated on the lines actually submitted; a replay carrying
  no priced line is not spuriously refused."
- **(e) AC-6 — read confirmation (staff reads own store, not others).** As `2222`
  (Frederick member): `SELECT` Frederick's open POs (`status in ('sent','partial')`)
  returns the fixture PO(s) with > 0 rows; `SELECT` their `po_items` returns the
  lines. Then as a Store-B-only member (or the same `2222` against a Charles PO —
  `2222` is NOT a Charles member): the Charles open-PO SELECT returns 0 rows and
  the Charles `po_items` SELECT returns 0 rows. (May lean on the spec-107 R1/R4
  fixtures / posture. Confirms no new read policy is needed — the existing
  `auth_can_see_store` already admits the member and denies the non-member.)
- **(f) PINNED refusal string — byte-equal.** Assert the gate's message is exactly
  `forbidden: price change requires admin`. Use `throws_ok(…, '42501', 'forbidden:
  price change requires admin')` (the third arg pins the message byte-for-byte),
  and additionally a `throws_matching` / explicit message equality so a reword
  fails the build. This is the house stable-string pin (the `'cannot delete self'`
  discipline).

`plan(N)` count is the developer's to finalize; the case list above enumerates
the required assertions. The spec-053 permissive-policy lint arm runs
automatically (no new policy → no allowlist edit expected).

---

### jest plan — the staff Receiving screen (`src/screens/staff/screens/Receiving.test.tsx`, NEW)

Mirror the `Reorder.test.tsx` / `WeeklyCount.test.tsx` harness (mock the staff
carve-out lib + `useConnectionStatus`, render under the staff i18n + theme
providers, assert via testIDs). Cases:

- **List renders open POs (AC-7).** Mock `fetchStaffOpenPos` → two POs (`sent` +
  `partial`); assert both rows render with short id, status pill, vendor name,
  date; newest-first order.
- **Empty state (AC-7).** Mock `fetchStaffOpenPos` → `[]`; assert the empty-state
  testID renders (no PO rows).
- **Pick → prefill = outstanding (AC-8).** Mock `fetchStaffPoLines` → a line with
  `orderedQty: 10, receivedQty: 3`; assert the "received now" input is prefilled
  to `7` (`max(0, 10 - 3)`), and assert NO price input / NO cost text renders
  anywhere on the screen (query for a price testID and assert absent — the R-1
  belt).
- **Zero-row filter + additive delta builder (AC-9).** Extract a pure helper
  (`buildReceiveDeltas(lines, inputs)` → `Array<{poItemId, receivedQty}>` skipping
  zero/blank rows) and unit-test it directly: blank/zero rows dropped; the
  resulting objects have exactly `{poItemId, receivedQty}` — **assert no
  `newCasePrice` / `new_case_price` key is ever present** (the carve-out-never-
  sends-price contract, testable at the helper boundary).
- **Commit confirm (AC-9).** Mock `confirmAction`; tap Commit → assert the confirm
  is invoked (receiving mutates stock); on confirm, assert `submitStaffReceive` is
  called with the built deltas and a single client uuid.
- **Offline blocks submit (AC-11).** Mock `useConnectionStatus` → `false`; assert
  the Commit control is disabled and the offline affordance/message renders;
  assert `submitStaffReceive` is NOT called on tap. Then flip to `true` and assert
  Commit re-enables.
- **Success → refresh (AC-12).** Mock `submitStaffReceive` → `{status:
  'received', conflict: false}`; assert a success toast fires and
  `fetchStaffOpenPos` is re-invoked (list refresh) — a now-received PO leaves the
  list.
- **Error surfaces, inputs intact (AC-12).** Mock `submitStaffReceive` to throw
  (incl. a simulated `42501` — the AC-2 refusal should staff ever reach it);
  assert `notifyStaffBackendError` fires, NO success toast, and the per-line
  inputs retain their values (no phantom success).
- **Idempotent-envelope handling (RPC envelope note).** Mock `submitStaffReceive`
  → `{status: 'received', conflict: true}` (a replay); assert the screen treats it
  as SUCCESS (refreshes the list, shows the received status) and does NOT re-apply
  or double-toast — a `conflict: true` replay is a success-no-reapply, not an
  error. (The carve-out returns `conflict` so the screen can make this
  distinction; per AC-4 the server has already deduped.)

Any extracted pure helper (the outstanding-remainder prefill computation and the
delta builder) gets a direct unit test independent of the render.

---

### Frontend: nav mount + i18n (architect confirmations)

- **4th tab CONFIRMED (OQ-2).** Add a 4th `<Tab.Screen name="Receiving"
  component={Receiving}>` to `StaffTabs` (`StaffStack.tsx:72-133`), a peer to
  EODCount / Reorder / WeeklyCount. **Icon:** `Ionicons name="cube-outline"` (a
  receipt/delivery "cube" glyph — visually distinct from the clipboard (EOD) /
  cart (Reorder) / calendar (Weekly); the PM's "truck/cube" suggestion, resolved
  to `cube-outline` for consistency with the existing outline set). **Options
  shape:** mirror the siblings exactly — `tabBarLabel: t('receiving.tabLabel')`,
  `tabBarAccessibilityLabel: t('receiving.tabLabel')`, `tabBarTestID:
  'staff-tab-receiving'`, `tabBarIcon` as above. The tab bar already grew 1→2→3
  additively; this is the same additive move.
- **Screen structure (AC-7/8/9).** Mirror `Reorder.tsx` idioms: `SafeAreaView` +
  header (store name → switch-store, sign-out, `LocaleSwitcher`) + a manual
  Refresh affordance; `useFocusEffect` to re-fetch open POs on focus (OQ-5); the
  four states (loading / empty / error-with-retry / list). A picked PO shows the
  per-line "received now" inputs (staff `Input`/`ListRow` components, the
  `WeeklyCount` list idiom) with NO price column. Confirm via `confirmAction`
  (`src/utils/confirmAction.ts` — the shared cross-platform confirm `WeeklyCount`
  and `Reorder` already use). Online gate via `useConnectionStatus` (the
  `WeeklyCount.tsx:546` early-return idiom). Data via the `receiving.ts` carve-out
  (never `db.ts`).
- **i18n `receiving.*` ×3 (AC-15).** Add a `receiving.*` block to
  `src/screens/staff/i18n/{en,es,zh-CN}.json` (tone matching `weekly.*` /
  `reorder.*`). Required keys (at minimum): `tabLabel`, `title`, `subtitle`,
  `list.empty`, `list.statusSent`, `list.statusPartial`, `col.item`,
  `col.ordered`, `col.received`, `col.outstanding`, `col.receiveNow`,
  `commit.label`, `commit.committing`, `commit.confirmTitle`,
  `commit.confirmMessage`, `offline.message`, `success.message`,
  `nothingToReceive.message`, `error.title`, `error.retry`, `loading`,
  `noLineItems`. NO admin catalog (`src/i18n/*.json`) change. NO user-visible
  hardcoded English.

---

### Reviewer fan-out (explicit, per the task)

**This spec HAS a backend surface (the RPC body change), so the post-impl
architect drift pass IS warranted.** After implementation:

- **backend-architect (post-impl mode)** — REQUIRED. Confirm the re-CREATE is
  verbatim + exactly one gate hunk (diff vs cost_on_receipt.sql:122-386), the gate
  is at the fixed site (first statement in §3b, presence-keyed, before `< 0`),
  the refusal string/errcode are byte-exact, no grant/revoke re-emit, no schema/
  RLS/publication drift, and no code path bypassed `db.ts` improperly (the staff
  carve-out is sanctioned; an admin-side raw `supabase.from` would be drift).
- **pgTAP — REQUIRED** (the headline of the backend slice). Cases a–f above must
  land in `supabase/tests/staff_receiving_gate.test.sql` and pass in CI. The
  `cost_on_receipt.test.sql` suite must stay green (unchanged).
- **security-auditor** — the load-bearing server-side gate (R-1): confirm the gate
  is in the RPC body, fires before any side-effect (atomic rollback), uses a stable
  string/errcode, and that the staff carve-out never sends `new_case_price`
  (belt-and-braces). This is a privilege-escalation fix — treat the gate placement
  and the nothing-durable pgTAP as the primary evidence.
- **code-reviewer / test-engineer** — standard: contract adherence, the jest plan
  coverage, i18n ×3 parity, no hardcoded English, the carve-out isolation.
- **Prod apply is USER-GATED.** The developer FLAGS the MCP apply +
  `schema_migrations` insert + post-apply body verification in the handoff; they
  do NOT push it. `release-coordinator` must not recommend SHIP_READY until both CI
  gates are green AND the user has authorized (or scheduled) the prod apply.

## Files changed

### Backend (backend-developer)

Migrations:
- `supabase/migrations/20260707000000_staff_receiving_price_gate.sql` (NEW) —
  body-only signature-stable re-CREATE of `receive_purchase_order(uuid, jsonb,
  uuid)`: the RPC body copied VERBATIM from
  `20260705000000_cost_on_receipt.sql:122-386` + EXACTLY ONE gate hunk (the
  first statement inside the §3b `if v_item_id is not null and
  v_line.new_case_price is not null then` branch, before the `< 0` check:
  `if not public.auth_is_privileged() then raise exception 'forbidden: price
  change requires admin' using errcode = '42501'; end if;`). `comment on
  function` updated to document the gate. No grant/revoke re-emit (signature
  stable — `create or replace` preserves the spec-107 ACL). No schema / RLS /
  publication change. Diff-verified: the ONLY delta vs the source body is the
  15-line gate hunk (11 comment lines + the 3-line guard + 1 blank) at the fixed
  site. Applied to the LOCAL stack; POST-APPLY verified the function carries the
  pinned string. **Prod-apply NOT done — user-gated (see Handoff below).**

pgTAP:
- `supabase/tests/staff_receiving_gate.test.sql` (NEW) — `plan(45)`, hermetic
  `begin; … rollback;`, master-JWT (`3333`, role master → privileged) + staff-
  member-JWT (`2222`, role user, Frederick member → non-privileged) switch
  pattern mirroring `po_loop.test.sql` / `store_count_layouts.test.sql`. Cases
  a–f: (a) staff stock-only receive succeeds — stock increment + status flip +
  `price_changes: []` + price side untouched; (b) staff line WITH new_case_price
  → 42501 whole-call refusal with ALL SIX durable targets asserted unchanged
  (`po_items.received_qty`, `inventory_items.current_stock` /
  `case_price` / `cost_per_unit`, `item_vendors.case_price` / `cost_per_unit`,
  `audit_log`) + `receive_client_uuid` not stamped + status not flipped + the
  presence-not-value pin (0 / 20-equal / -1 all raise 42501 identically); (c)
  privileged price path regression (★ updates on both targets + `PO price change`
  audit + `price_changes[0]`); (d) staff replay idempotency unaffected + not
  spuriously refused (`lives_ok` on the no-priced-line replay); (e) read
  confirmation (staff reads Frederick open POs + lines > 0, non-member reads 0
  Charles rows); (f) the refusal string byte-equal pin (`throws_ok` third-arg +
  an explicit `SQLERRM` equality). Full `npm run test:db` stays green — the
  spec-109 `cost_on_receipt.test.sql` (55 assertions, runs as master) is
  unaffected by the gate.

No `src/lib/db.ts` change (the staff read/RPC path is the frontend dev's
carve-out `src/screens/staff/lib/receiving.ts`; the admin `db.ts` receive path
is untouched). No edge-function / config change. No frontend file touched by the
backend slice.

### Frontend (frontend-developer)

Staff carve-out lib:
- `src/screens/staff/lib/receiving.ts` (NEW) — the staff receiving data + RPC
  carve-out (direct `supabase.from/rpc`, NOT `db.ts` — the documented staff
  subtree carve-out; mirrors `fetchReorder.ts` / `countLayouts.ts`). Exports:
  `fetchStaffOpenPos(storeId)` (open sent|partial POs + `vendors(name)` join,
  newest-first), `fetchStaffPoLines(poId)` (po_items → inventory_items →
  catalog_ingredients name/unit/i18n_names — **NO price/cost column selected or
  mapped**, R-1), and `submitStaffReceive(poId, lines, clientUuid)` (calls
  `receive_purchase_order` with EXACTLY `{ po_item_id, received_qty }` per line —
  **NEVER a `new_case_price` key**, belt to the server's braces; reads back
  `status` + `conflict`, ignores `price_changes`). Types `StaffOpenPo` /
  `StaffPoLine` / `StaffReceiveDelta` carry no price surface. Also exports the
  pure `buildReceiveDeltas(lines, inputs)` (zero/blank/negative rows dropped;
  objects are exactly `{ poItemId, receivedQty }`) + `outstandingRemainder(line)`
  (`max(0, ordered − received)`), unit-tested independently. Throws on
  PostgREST/RPC error (incl. the AC-2 42501, surfaced as an error).

Screen:
- `src/screens/staff/screens/Receiving.tsx` (NEW) — the staff Receiving screen,
  mirroring the Reorder/WeeklyCount idioms: open-PO list (short id + status pill +
  vendor + date, newest-first) → empty/loading/error-with-retry states → pick a PO
  → per-line "received now" inputs **prefilled to the outstanding remainder**
  (NO price/cost display anywhere — R-1) → commit behind `confirmAction`
  (receiving mutates stock) → success toast + list refresh + return to list. Zero
  rows filtered from the payload (via `buildReceiveDeltas`); an all-zero commit is
  blocked with a "nothing to receive" message. Client uuid minted ONCE per commit
  (`uuidv4`) for idempotency; commit disabled while in flight. Online-only gate via
  `useConnectionStatus` (R-2) — offline shows a banner + disables/blocks commit.
  `useFocusEffect` re-fetch on focus + a manual Refresh affordance (no realtime —
  AC-14). A `conflict: true` replay is treated as success-no-reapply; a backend
  error surfaces via `notifyBackendError` and leaves inputs intact (no phantom
  success). Localized item names via `getLocalizedName` (staff-only, spec 100).
  Light-only staff theme via `useStaffColors`/`useStaffElevation` — no inline
  color literals.

Nav:
- `src/screens/staff/navigation/StaffStack.tsx` (EDIT) — added the 4th
  `<Tab.Screen name="Receiving">` to `StaffTabs` (peer to EODCount / Reorder /
  WeeklyCount), icon `Ionicons name="cube-outline"`, `tabBarTestID:
  'staff-tab-receiving'`, label/accessibilityLabel `t('receiving.tabLabel')`. The
  additive `1→2→3→4` tab move; no other nav change.

i18n (staff catalogs ONLY — no admin `src/i18n/*` change):
- `src/screens/staff/i18n/en.json`, `es.json`, `zh-CN.json` (EDIT) — added the
  `receiving.*` block to all three locales (tab label, title/subtitle, back,
  refresh, loading, list empty-title/empty/status pills/unnamed-vendor/po-meta,
  column labels incl. `receiveNow`, per-line ordered/received/outstanding, commit
  label/committing/confirm-title/confirm-message/confirm-cta, offline message,
  success message + received/partial status, nothing-to-receive message,
  no-line-items, error title/retry). Real es/zh-CN translations; interpolation
  tokens (`{id}`/`{date}`/`{ordered}`/`{received}`/`{qty}`/`{item}`/`{count}`/
  `{total}`) identical across locales — pinned by the existing `i18n.test.ts`
  parity + placeholder-token tests.

Jest:
- `src/screens/staff/lib/receiving.test.ts` (NEW) — carve-out lib: the two reads'
  mapping (vendor join, snake→camel), the `po_items` projection selects NO
  price/cost column (asserted on the exact select string + absence of
  `cost_per_unit`/`case_price`/`sub_unit_size`), `submitStaffReceive` sends
  EXACTLY `{ po_item_id, received_qty }` per line with NO price key anywhere in
  the payload, reads back status/conflict, surfaces a `conflict: true` replay, and
  propagates the AC-2 42501; the pure `buildReceiveDeltas` (drops zero/blank rows,
  never emits a price key) + `outstandingRemainder`.
- `src/screens/staff/screens/Receiving.test.tsx` (NEW) — the screen: list renders
  open POs + empty state; prefill = outstanding + NO price input present; commit
  builds additive stock-only deltas (no price key) + is confirm-gated + mints one
  client uuid; zero rows filtered; all-zero commit blocked; offline disables +
  blocks submit (and re-enables online); success → success toast + list refetch;
  error surfaces via `notifyBackendError` + inputs intact + no phantom success; a
  `conflict: true` replay treated as success without re-apply/double-submit.

Verification: `npx tsc --noEmit` and `npx tsc -p tsconfig.test.json --noEmit`
both exit 0; full `npx jest` green (92 suites / 1031 tests). No admin file, no
`supabase/`, no `src/lib/db.ts`, and no EOD/Weekly/Reorder screen touched beyond
the StaffTabs wiring. Browser pass NOT run by the frontend dev (preview tools
unavailable in-agent) — flagged for main Claude (see Handoff): login
`manager@local.test` → staff app → Receiving tab → receive against an open PO on
Towson/Frederick.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec. Backend: author
  supabase/migrations/20260707000000_staff_receiving_price_gate.sql as a
  verbatim body-only re-CREATE of receive_purchase_order (copy
  20260705000000_cost_on_receipt.sql:122-386) with EXACTLY one gate hunk — the
  first statement inside the §3b `if v_item_id is not null and v_line.new_case_price
  is not null then` branch, before the `< 0` check: `if not
  public.auth_is_privileged() then raise exception 'forbidden: price change
  requires admin' using errcode = '42501'; end if;` (that string is a PINNED house
  contract). Add supabase/tests/staff_receiving_gate.test.sql with cases a–f.
  FLAG the prod-apply (MCP execute_sql on ebwnovzzkwhsdxkpyjka + schema_migrations
  insert of 20260707000000 + post-apply pg_get_functiondef LIKE the pinned string)
  in your handoff — do NOT push it. Frontend: add the src/screens/staff/lib/receiving.ts
  carve-out (fetchStaffOpenPos / fetchStaffPoLines / submitStaffReceive — NEVER
  sending new_case_price), the Receiving screen + the 4th `Receiving` tab
  (cube-outline icon) in StaffTabs, the online-only gate via useConnectionStatus,
  the receiving.* i18n block ×3 locales, and the jest tests. After implementation,
  set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/113-staff-receiving.md
