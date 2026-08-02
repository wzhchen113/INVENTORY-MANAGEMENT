# Spec 149: EOD → Approve & Order pipeline (phone)

Status: READY_FOR_REVIEW

> **Owner concept (approved before this spec was written — do NOT re-open).**
> When staff submits an EOD count, the admin gets a notification on their phone
> (the spec-120/121 notification system + the spec-148 phone notification sheet
> already exist). Tapping it deep-links to an **Approve Order** review screen:
> the server-computed suggested order for that vendor (`report_reorder_list` —
> the same data the spec-143 phone Ordering cards render) with editable steppers,
> a fee/markup disclosure line, and ONE primary **APPROVE & ORDER** button. What
> that button does is per-vendor:
>
> - **BJ's / Sam's Club / other Instacart storefronts** → a server-side call to
>   the **Instacart Developer Platform** `POST connect.instacart.com/idp/v1/products/products_link`
>   (free public REST API) with the order lines + `retailer_key`; the returned
>   pre-filled cart link opens on the phone and the admin completes checkout on
>   Instacart with saved payment (~3-4 taps).
> - **WebstaurantStore** → no API. Approve records the order and deep-links their
>   Rapid Reorder page. Their scheduled **Auto Reorder** covers staples — that is
>   *operational guidance in this spec, not code*.
> - **Other / extension vendors** → approve queues the order for the existing
>   spec-131/132 Chrome cart-filler (the existing FILL CART flow, unchanged).
>
> **ToS posture (binding, not negotiable):** no headless, unattended, or
> automated checkout anywhere in this pipeline. Instacart C&Ds that behavior. The
> human always completes payment in their own session. See "Out of scope".
>
> **Prior vendor research (memory `project_vendor_ordering_integration.md`,
> binding — do not re-litigate):** no vendor has a buyer-side ordering API; the
> Chrome cart-filler shipped (specs 131/132), BJ's live-tuned, Sam's adapter
> awaits its first live pass. The Instacart IDP link path is *additive* to that
> reality — it is a **cart-link generator**, not a buyer API, which is exactly why
> it is ToS-clean.

---

## PM summary (plain language, for the owner)

Today: staff finishes the count, you find out later, you open Ordering, you scan
the vendor cards, you fill a cart or export a list. Four surfaces, several
minutes, easy to forget.

After this spec: staff hits submit → your phone buzzes → you tap the
notification → you are looking at *exactly* what to order from that one vendor,
with +/− steppers to adjust → you hit **APPROVE & ORDER** once. For BJ's / Sam's
the phone opens an Instacart cart that is already filled with your items; you
check out with your saved card. For WebstaurantStore it opens Rapid Reorder. For
your cart-filler vendors it queues the order the way FILL CART does today.

Two things stated plainly, with eyes open:

1. **Instacart is not in-club pricing.** Ordering through Instacart normally
   costs more than walking into BJ's/Sam's — item markup plus service and
   delivery fees. The review screen shows a disclosure line every time so you
   never approve without seeing it. We do not attempt to display Instacart's
   real-time prices (we have no price feed on the free API); the estimate on the
   screen is *your* catalog cost, labeled as such.
2. **Nothing checks out for you.** You always tap "place order" yourself in your
   own Instacart / vendor session. Automating that would get the integration
   killed, so it is a hard non-goal.

---

## User stories

- **US-1 (the ping).** As a store admin, when staff submits the EOD count for a
  vendor, I want a phone notification that says an order is ready for review —
  distinct from a routine "count submitted" FYI — so I act while the count is
  fresh.
- **US-2 (the review).** As a store admin, tapping that notification lands me on
  an **Approve Order** screen for that one vendor, showing the server-computed
  suggested order with case-aware +/− steppers, so I can adjust before approving
  without leaving the phone.
- **US-3 (honest cost).** As a store admin, before I approve I see a disclosure
  line telling me whether this path costs more than buying in-club (Instacart
  markup + delivery/service fees), so I am never surprised at checkout.
- **US-4 (one button, right destination).** As a store admin, one **APPROVE &
  ORDER** button does the right thing for the vendor I am looking at: opens a
  pre-filled Instacart cart, opens WebstaurantStore Rapid Reorder, or queues the
  order for my Chrome cart-filler.
- **US-5 (the paper trail).** As a store admin (and later as the owner reviewing
  spend), I want a record of who approved what and when, and whether it was
  actually ordered, so an approved-but-never-placed order is visible instead of
  silently lost.
- **US-6 (I stay in control of payment).** As a store admin, I always complete
  checkout myself in my own logged-in session — the app never stores my vendor
  credentials, never pays, never checks out unattended.

## Acceptance criteria

### A. Notification — "count submitted, order ready for review"

- [ ] **AC-1.** A new notification type (working name `order_ready`) is added to
      the `public.notifications.type` CHECK constraint (currently
      `('eod','weekly','waste','receiving','po','missed_eod','issue')`) via an
      additive drop-and-re-add migration, exactly as specs 121 and 137's
      predecessors did. All existing rows and types stay valid.
- [ ] **AC-2 (emit).** When an `eod_submissions` row for `(store_id, date,
      vendor_id)` reaches `status = 'submitted'` AND that vendor resolves to a
      non-empty server-computed suggested order, exactly ONE `order_ready`
      notification is emitted, deduped on the existing
      `notifications_type_source_uidx` `(type, source_id)` index so re-submission
      / re-run is a no-op.
- [ ] **AC-3 (no double ping).** The store admin receives ONE notification per
      `(store, vendor, business_date)` submission event, not two. Default
      resolution: `order_ready` is emitted **instead of** the routine spec-120
      `eod` submission notification for that same `(store, vendor, date)` when the
      vendor is order-configured and the computed order has ≥1 line; otherwise the
      existing `eod` notification fires unchanged. (See OQ-1 — this is the one AC
      that touches already-shipped spec-120 behavior.)
- [ ] **AC-4 (badge rules preserved — regression-sensitive).** The spec-121 badge
      rule is unchanged byte-for-byte: the bell/notification badge is `C.danger`
      **only** while an unread `missed_eod` exists; every other unread type,
      including the new `order_ready`, uses `C.accent` with `C.accentFg` text. The
      per-row unread dot for an `order_ready` row is `C.accent` (not danger).
      `feedHasUnreadMissed` / `badgeBackgroundColor` / `badgeTextColor` /
      `rowDotColor` (exported from `NotificationBell.tsx`) are reused, not forked
      — both bells (desktop `NotificationBell`, phone `PhoneNotifications`) keep
      reading the same helpers.
- [ ] **AC-5 (row copy + i18n).** An `order_ready` row reads
      "Order ready to approve · &lt;store&gt;" with the vendor on the secondary
      line, via a new `chrome.submissionBell.type.order_ready` key present in all
      three catalogs (`en`, `es`, `zh-CN`) — i18n parity test stays green.
- [ ] **AC-6 (deep link).** Tapping an `order_ready` row in the phone
      notification sheet marks it read AND navigates to the Approve Order screen
      **for that specific vendor and business date** — not merely to the Ordering
      section. The spec-148 `usePaletteAction` bridge currently carries only
      `{ section, selectedName, eodFocusItemId }`; extending it with a vendor /
      approval-scoped field is required and is the architect's call (see Design
      guidance 4).
- [ ] **AC-7 (push copy).** The push body for `order_ready` does NOT read
      "… submitted" — it phrases the review ask (e.g. title "Order ready to
      approve", body "&lt;store&gt; · &lt;vendor&gt;"), via the existing
      `submission-push-fanout` `TYPE_LABEL` + payload branch. Recipients and
      brand scoping are inherited from spec 120 — unchanged.

### B. Approve Order review screen (phone)

- [ ] **AC-8 (screen).** A phone Approve Order screen renders, for one vendor +
      business date: vendor name, count status, the **server-computed**
      suggested lines from `report_reorder_list` (the same payload the spec-143
      phone Ordering cards read — no forked reorder math, no client-side
      re-derivation of suggestions), and a totals line (lines · cases · est $).
- [ ] **AC-9 (steppers).** Each line has the spec-143 case-aware − / N CS / +
      stepper (44px tall, ± 40px wide), writing BASE units through the existing
      `setReorderEditQty` (clamped ≥ 0) via the spec-134 `poCaseDisplay`
      conversions, with `applyReorderEdits` recomputing qty/cost — reusing the
      `PhoneOrdering` card components (`LineStepper` / `VendorOrderCard`), not
      re-implementing them. Est-$ uses the spec-104 per-each → per-counted-unit
      bridge (`base × costPerUnit × subUnitSize`).
- [ ] **AC-10 (fee / markup disclosure — required, per channel).** Above the
      primary button the screen renders a disclosure line that is honest per
      channel:
      - Instacart channel → states that Instacart pricing may exceed in-club
        pricing and that delivery/service fees apply, and labels the on-screen
        estimate as "your catalog cost — not the Instacart price".
      - Webstaurant / extension / manual channels → the estimate is labeled as
        the catalog-cost estimate; no Instacart fee copy is shown.
      The disclosure is a first-class element, not a tooltip, and is covered by
      i18n in all three catalogs.
- [ ] **AC-11 (one primary action).** Exactly ONE primary 48px button —
      **APPROVE & ORDER** — plus at most one secondary/dismiss affordance. No
      competing primaries.
- [ ] **AC-12 (a11y / phone-tier rules).** Full vendor + item names (flex:1,
      ellipsize only past full width); no horizontal scroll; every tappable
      ≥ 44×44; both themes via tokens only — the spec-140/142/143 phone-tier bar.
- [ ] **AC-13 (empty / stale states).** If the suggested order is empty, or the
      approval was already actioned (status `ordered`), or the underlying count
      changed since the notification fired, the screen says so plainly and the
      primary button is disabled or re-labeled — it never silently approves a
      stale set of lines.

### C. Per-vendor routing of APPROVE & ORDER

- [ ] **AC-14 (channel resolution).** Each vendor resolves to exactly one order
      channel: `instacart` | `webstaurant` | `extension` | `manual`. The
      resolution is data-driven (a vendor column, architect's shape call), NOT a
      hard-coded vendor-name match. `vendors.extension_ordering = true` (specs
      131/132) remains the source of truth for the extension path; the new
      channel field must not be able to contradict it — precedence is stated in
      the design and pinned by a test.
- [ ] **AC-15 (Instacart channel).** APPROVE & ORDER on an `instacart` vendor
      (a) persists the approval (AC-19), then (b) calls the new edge function,
      which calls IDP `POST /idp/v1/products/products_link` with the approved
      lines + that vendor's `retailer_key`, and (c) opens the returned
      `products_link_url` on the phone (`Linking.openURL` / new tab on web). A
      non-2xx or timeout from IDP surfaces a real error toast — never a silent
      fake success — and leaves the approval in a retriable state.
- [ ] **AC-16 (WebstaurantStore channel).** APPROVE & ORDER on a `webstaurant`
      vendor records the approval and opens that vendor's Rapid Reorder URL
      (from existing vendor config — `order_page_url` or successor). No API call
      is made; no order is transmitted. The spec documents their scheduled Auto
      Reorder as operational guidance for staples — **documentation only, zero
      code**.
- [ ] **AC-17 (extension channel).** APPROVE & ORDER on an `extension` vendor
      records the approval and then performs the EXISTING spec-138
      `fillCartForVendor` handoff — `get_pending_extension_orders` /
      `get_extension_order_payload` keep their current signatures and behavior,
      and the Chrome extension itself is not modified (AC-REG-3).
- [ ] **AC-18 (manual channel).** APPROVE & ORDER on a `manual` vendor records
      the approval and offers the existing quick-order-text / export path — no
      new export builders.

### D. Backend — edge function + audit trail

- [ ] **AC-19 (`order_approvals` audit trail).** A new per-store table records:
      store, vendor, business date, approver `user_id`, approved-at timestamp,
      the approved line snapshot (item, qty in base units, unit cost at approval
      time), the resolved channel, an external reference where one exists (e.g.
      the returned Instacart link), and `status` in
      `('pending','approved','ordered')`. Rows are append-only in spirit: the
      only permitted mutation is the status transition (AC-20) and the external
      reference write.
- [ ] **AC-20 (status transitions).** `pending → approved → ordered` only.
      `approved → ordered` is an **explicit human confirmation** (the admin marks
      it ordered after checking out) — the free IDP link API returns no order
      webhook, so the app MUST NOT infer "ordered" from link generation. An
      illegal transition is rejected server-side.
- [ ] **AC-21 (RLS, per-store).** `order_approvals` is store-scoped via
      `auth_can_see_store()`, with no trivially-wide permissive policy (the spec-053
      `permissive_policy_lint` pgTAP probe must stay green without an allowlist
      entry). A user who cannot see the store gets zero rows on SELECT and is
      refused on INSERT/UPDATE.
- [ ] **AC-22 (edge function holds the API key).** A new JWT-protected edge
      function (working name `instacart-cart-link`) is the ONLY place the
      Instacart IDP API key lives (a Supabase function secret). The key is never
      shipped in the Expo bundle, never returned in a response, and never logged.
      A client-side `fetch` to `connect.instacart.com` anywhere in `src/` is a
      Critical.
- [ ] **AC-23 (role gate).** The function defines
      `const ADMIN_ROLES = new Set(["admin", "master", "super_admin"]);` and gates
      via `requireAdminCaller()`, mirroring `auth_is_privileged()` — the CLAUDE.md
      edge-function role-gate convention (reference shape:
      `supabase/functions/delete-user/index.ts:19`). A non-privileged caller gets
      401/403 with no upstream call made.
- [ ] **AC-24 (store-scope gate).** The function verifies the CALLER can see the
      target store before contacting IDP — it does not trust a client-supplied
      `store_id`. Cross-store link minting is refused.
- [ ] **AC-25 (client call path).** The app calls the function through
      `callEdgeFunction` in `src/lib/auth.ts` (or `supabase.functions.invoke` for
      typed data, per the documented exception) — never a bare `fetch`, which
      would re-introduce the spec-031/032 silent-fake-success regression.
- [ ] **AC-26 (no HTML surface).** The function returns JSON only; it renders no
      HTML email/body, so the `escapeHtml()` convention does not apply. Called out
      explicitly so review does not flag its absence as drift.
- [ ] **AC-27 (input validation).** Line payloads are validated server-side
      (item count bound, quantity numeric and > 0, name length bound) before the
      IDP call; malformed input returns 400 with a structured error and no
      upstream call.

### E. Regression group (AC-REG — nothing already shipped changes behavior)

- [ ] **AC-REG-1 (phone Ordering unchanged).** The spec-143 `PhoneOrdering`
      screen keeps its current behavior: same cards, same steppers, same overflow
      sheet, same FILL CART primary. Component reuse by the new screen must not
      alter `PhoneOrdering`'s rendered output; its existing suites stay green
      unmodified except for additive store-mock fields.
- [ ] **AC-REG-2 (desktop + tablet byte-unchanged).** Desktop (≥1100px) and
      tablet (768–1099px) render output for `ReorderSection` / `OrderingSection`
      / the desktop `NotificationBell` is unchanged. Any new phone screen is
      reached only through an `isPhone` guard placed AFTER all hooks (the
      spec-140/143 guard-after-hooks pattern), pinned by an `acReg` suite.
- [ ] **AC-REG-3 (extension contract frozen).** `get_pending_extension_orders`,
      `get_extension_order_payload`, `upsertVendorDraftOrder`, and the
      `extension/` build are unchanged; the extension vitest suite stays green.
- [ ] **AC-REG-4 (spec-121 badge rule).** Covered by AC-4 — restated here so the
      reviewers treat a badge-color change as a Critical, not a nit.
- [ ] **AC-REG-5 (staff surface untouched).** `src/screens/staff/` behavior is
      unchanged. Staff submit as they do today; approval is an admin-only surface.

### F. Tests (spec 022 tracks — the test-engineer routes by track name)

- [ ] **AC-28 (jest).** Approve Order screen renders server lines + stepper
      write-through (case → base, clamp ≥ 0) + the per-channel disclosure copy;
      channel resolution (AC-14) picks the right primary action for each of the
      four channels; the `order_ready` row dot + badge color derivation (AC-4);
      the deep-link payload (AC-6); stale/empty/already-ordered states (AC-13);
      the `acReg` fork pin (phone → new screen; desktop + tablet → the unchanged
      desktop tree).
- [ ] **AC-29 (pgTAP).** `notifications.type` CHECK accepts `order_ready` and all
      legacy values; emit is deduped per `(store, vendor, date)` (AC-2) and does
      not double-fire with `eod` (AC-3); `order_approvals` RLS — same-store admin
      reads/writes, other-store denied, non-privileged denied (AC-21); the
      status-transition guard rejects illegal transitions (AC-20); the
      `permissive_policy_lint` probe stays green.
- [ ] **AC-30 (shell smoke).** A round trip against the new edge function: an
      admin JWT gets a link (against a sandbox/stub upstream), a non-privileged
      JWT is refused (AC-23), a cross-store `store_id` is refused (AC-24), and a
      non-2xx upstream surfaces as a structured error, not a fake success.

## In scope

- New `order_ready` notification type + emit + dedupe + push copy + i18n.
- Phone **Approve Order** review screen, reusing the spec-143 `PhoneOrdering`
  card/stepper components and the existing `report_reorder_list` payload.
- Per-vendor channel resolution (`instacart` / `webstaurant` / `extension` /
  `manual`) as vendor data.
- ONE new JWT-protected edge function holding the Instacart IDP API key,
  minting `products_link` cart URLs.
- `order_approvals` table + RLS + status lifecycle (`pending`/`approved`/`ordered`).
- Fee/markup disclosure copy in the review UI.
- Deep-link plumbing from the notification row to a vendor-scoped approval view.
- Tests on all three tracks (AC-28/29/30).

## Out of scope (explicitly — non-goals)

- **Headless / unattended / automated checkout, anywhere, for any vendor.**
  Rationale: Instacart issues C&Ds for it and it would end the integration; the
  human always completes payment in their own session. This is a hard product
  boundary, not a phase-2 item.
- **Storing vendor credentials or payment instruments.** Rationale: same; the
  spec-132 extension already established "act in the user's own logged-in
  session, never hold credentials".
- **MealMe (or any other aggregator) evaluation or integration.** Rationale: the
  owner explicitly deferred it — a future spec decides whether it is worth it.
  Do not add an abstraction layer "for MealMe later" in this spec.
- **A WebstaurantStore API integration.** Rationale: none exists for buyers. This
  spec deep-links Rapid Reorder and documents Auto Reorder as operational
  guidance — zero code for Auto Reorder.
- **Changing the Chrome cart-filler extension (specs 131/132) or its two RPCs.**
  Rationale: live-tuned on BJ's; AC-REG-3 freezes it.
- **Real-time Instacart pricing, availability, or substitution handling in the
  review screen.** Rationale: no price feed on the free IDP surface; AC-10 solves
  the honesty problem with a disclosure instead of a fake number.
- **A desktop/tablet Approve Order surface.** Rationale: the owner asked for
  phone-first; desktop already has the full Ordering section. AC-REG-2 keeps
  desktop/tablet byte-unchanged. A desktop tier is a follow-up if wanted.
- **Changing the reorder math** (pars, run-rate, counted on-hand). The screen
  renders `report_reorder_list` output as-is.
- **Auto-approval, approval thresholds, multi-step approval chains, or spend
  limits.** Rationale: one admin, one tap — the owner asked for a review screen,
  not a workflow engine.
- **Weekly / waste / spot counts triggering the pipeline.** EOD only, mirroring
  spec 121's scoping.
- **Backfilling `order_approvals` from historical POs.** Forward-only.
- **`app.json` slug / identity drift.** Untouched (CLAUDE.md DO-NOT-AUTO-FIX).
  This feature adds no build identifier, store listing, or push-cert change; the
  existing web-push path (spec 120/121) is reused as-is.

## Open questions resolved (owner, before this spec)

- Q: What triggers the admin's attention? → A: The staff EOD submission. The
  admin gets a phone notification deep-linking to an Approve Order review screen.
- Q: What does the review screen show? → A: The server-computed suggested order
  for that vendor (`report_reorder_list`, same data as the spec-143 phone
  Ordering cards) with editable steppers.
- Q: How many actions? → A: ONE primary — APPROVE & ORDER.
- Q: How do BJ's / Sam's / Instacart storefront orders get placed? → A: Server
  side call to Instacart IDP `products_link` with the lines + `retailer_key`;
  open the returned pre-filled cart on the phone; admin checks out with saved
  payment (~3-4 taps).
- Q: WebstaurantStore? → A: No API. Approve records the order + deep-links Rapid
  Reorder. Their scheduled Auto Reorder covers staples — documented as
  operational guidance, not built.
- Q: Everything else? → A: Approve queues the order for the existing spec-131/132
  Chrome cart-filler (the existing FILL CART flow).
- Q: Any automated checkout? → A: **No.** Explicit non-goal — Instacart C&Ds it.
- Q: Where does the Instacart API key live? → A: Server side, in an edge
  function. Never client-side.
- Q: MealMe? → A: Explicit non-goal; a future spec may evaluate it.

## Open questions (non-blocking — defaults chosen so the architect is unblocked)

Each has a PM default. The owner can override any at architect review without
reshaping the contract.

- **OQ-1 — double-notification fork (touches shipped spec-120 behavior).**
  Should `order_ready` *replace* the routine `eod` submission notification for an
  order-configured vendor, or ride alongside it? **Default: replace** (AC-3) —
  two pings for one event trains the admin to ignore the bell. If the owner wants
  the audit-style "count submitted" FYI preserved, AC-3 softens to "both fire"
  and the phone sheet groups them.
- **OQ-2 — Sam's Club ZIP availability (the real integration risk).** Instacart
  retailer coverage is postal-code dependent, and Sam's Club coverage in
  particular varies by market. **The architect MUST verify, against the live IDP
  retailers endpoint for the store's actual ZIP, that a usable `retailer_key`
  exists for Sam's Club (and for BJ's) before the Instacart channel is enabled
  for that vendor.** Default behavior when no `retailer_key` resolves for the
  store's ZIP: the vendor falls back to the `extension` channel (BJ's/Sam's both
  already have cart-filler adapters), and the review screen says so rather than
  offering a link that lands on an empty retailer. Pin the fallback with a test.
- **OQ-3 — who marks `ordered`.** Default: the admin taps a "MARK ORDERED"
  affordance after checking out (AC-20), because the free IDP link API returns no
  order webhook. Optional softener the architect may add: auto-advance to
  `ordered` after the linkback returns, if IDP's `partner_linkback_url` proves
  reliable — but never infer `ordered` merely from link generation.
- **OQ-4 — approval scope: per vendor or per submission batch.** Default: **per
  vendor** (one notification, one Approve Order screen, one approval row per
  `(store, vendor, business_date)`), matching how `eod_submissions` and
  `order_schedule` are already keyed. A "approve all of tonight's vendors"
  roll-up is a follow-up.
- **OQ-5 — IDP request shape drift.** The exact `products_link` request body
  field names (`line_items[]`, `landing_page_configuration`, `retailer_key`
  placement, `expires_in`) must be pinned against the **current** Instacart
  Developer Platform docs at design time rather than from memory; the API has
  evolved. Default: architect verifies against live docs and records the pinned
  shape in the design section, with a smoke test that fails loudly on a shape
  change.
- **OQ-6 — link expiry / re-open.** Default: store the returned link on the
  approval row and let the admin re-open it from the approval until it expires;
  regenerate on demand if expired. No silent auto-regeneration.

## Design guidance for the architect (not owner questions — do not reopen)

1. **Reuse the spec-120/121 notification spine wholesale.** New TYPE only — same
   `public.notifications` table, same `notifications_type_source_uidx` dedupe,
   same `privileged_brand_read_notifications` RLS, same
   `enqueue_submission_push` → `submission-push-fanout` path, same phone sheet.
   No new notification table, RLS model, store slice, or push function. Note that
   `public.notifications` is ALREADY in the `supabase_realtime` publication — a
   new row *type* needs no publication edit and therefore NO
   `docker restart supabase_realtime_imr-inventory` ritual. If you DO add
   `order_approvals` to the publication, the restart gotcha applies (see
   Project-specific notes).

2. **Channel field shape (AC-14).** `vendors.extension_ordering` (boolean, specs
   131/132) is already load-bearing and read by the extension RPCs. Recommended:
   add a nullable `vendors.order_channel text check (... in ('instacart',
   'webstaurant','extension','manual'))` plus an Instacart `retailer_key`
   column, and define precedence explicitly — e.g. `extension_ordering = true`
   wins unless `order_channel = 'instacart'` AND a `retailer_key` resolves for the
   store ZIP (OQ-2). Whatever you choose, one pgTAP/jest case must pin the
   precedence so a later edit cannot silently reroute BJ's away from the tuned
   cart-filler.

3. **Approval write path vs link minting — keep them separate.** Recommended
   split: the approval row is written through `src/lib/db.ts` (PostgREST/RPC,
   under the existing per-store RLS), and the edge function ONLY mints the
   Instacart link from an already-persisted approval id. That keeps the edge
   function's blast radius to "holds a secret, calls one upstream", keeps the
   audit write inside RLS, and makes AC-24's store-scope check a lookup of the
   approval row under the caller's token rather than a trust-the-body check.

4. **Deep-link carrier (AC-6).** `usePaletteAction.request({ section,
   selectedName, eodFocusItemId })` is the existing bridge and today carries no
   vendor/approval id — spec 148 explicitly deferred vendor-tab-depth deep-links
   for exactly this reason. Extend the bridge additively (an optional
   `approvalId` / `orderVendorId` field) rather than forking a second navigation
   mechanism; every existing caller must keep compiling and behaving identically.

5. **Reuse `PhoneOrdering`'s components, do not fork them.** `LineStepper` and
   `VendorOrderCard` are currently module-local in
   `src/screens/cmd/sections/phone/PhoneOrdering.tsx`. Export them (the spec-143
   precedent for `handleCsvExport` et al.) rather than copy-pasting; the same
   applies to `applyReorderEdits` / `narrowReorderToVendor` (`ReorderSection`) and
   `isCaseRow` / `poCasesToBase` (`poCaseDisplay`). Watch the est-$ bridge: the
   RPC's `costPerUnit` is per-EACH (spec 104) and must be multiplied by
   `subUnitSize` — the single easiest thing to get wrong here.

6. **Idempotency of APPROVE & ORDER.** A double-tap or a retry after a network
   error must not create two approval rows or two Instacart links for the same
   `(store, vendor, business_date)`. Key the approval accordingly and make the
   link-mint call safe to repeat.

7. **Secrets + observability.** The IDP key is a Supabase function secret. Log
   upstream failures with status + a correlation id, never the key or the full
   request body. Set a request timeout so a hung upstream cannot pin the function.

## Dependencies

- `supabase/migrations/20260715000000_submission_notifications.sql` (spec 120) —
  `notifications` / `notification_reads`, `notifications_type_source_uidx`,
  `privileged_brand_read_notifications`, `emit_submission_notification`,
  `enqueue_submission_push`.
- `supabase/migrations/20260716000000_missed_eod_notification_type.sql` (spec 121)
  and `20260720000000_staff_reports_issue_notifications.sql` (the `issue` type) —
  the CHECK-widening precedent this spec follows; the current value list.
- `supabase/functions/submission-push-fanout/index.ts` — `TYPE_LABEL` + payload
  branch for `order_ready`.
- `src/components/cmd/NotificationBell.tsx` — exported `feedHasUnreadMissed` /
  `badgeBackgroundColor` / `badgeTextColor` / `rowDotColor` (spec 121), reused by
  both bells.
- `src/screens/cmd/sections/phone/PhoneNotifications.tsx` (spec 148) — the phone
  feed sheet + `sectionForNotification` map + the deep-link call site.
- `src/lib/paletteAction.ts` (`usePaletteAction`) — the deep-link bridge to
  extend (Design guidance 4).
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx` (spec 143) — `LineStepper`,
  `VendorOrderCard`, the overflow sheet idiom, `ResponsiveSheet`.
- `src/screens/cmd/sections/ReorderSection.tsx` — `applyReorderEdits`,
  `narrowReorderToVendor`; `src/utils/poCaseDisplay.ts` (spec 134).
- `report_reorder_list` (`supabase/migrations/20260718000000_reorder_list_has_po.sql`,
  as amended by spec 138's `20260726000000_reorder_drop_inbound_term.sql`) — the
  suggested-order source. **Read-only here; not modified.**
- `supabase/migrations/20260723000000_extension_ordering.sql` (specs 131/132) —
  `vendors.extension_ordering` / `order_page_url`,
  `get_pending_extension_orders` / `get_extension_order_payload`. Frozen
  (AC-REG-3).
- `src/store/useStore.ts` — `reorderPayload`, `reorderEdits`, `setReorderEditQty`,
  `clearReorderEditsForVendor`, `fillCartForVendor`, `submissionNotifications`.
- `src/lib/db.ts` — new approval read/write helpers; `src/lib/auth.ts`
  `callEdgeFunction` for the edge call (AC-25).
- `eod_submissions`, `order_schedule`, `stores`, `vendors` — emit-side inputs.
- External: Instacart Developer Platform (`connect.instacart.com/idp/v1`) — free
  public REST API, server-side key. No SDK dependency assumed.
- New migration(s) + a new edge function; prod apply via the Supabase MCP path
  (`db push` lacks the prod password) with the exact version inserted into
  `supabase_migrations.schema_migrations` so `db-migrations-applied.yml` stays
  green (project MEMORY).

## Project-specific notes

- **Cmd UI section / legacy:** admin Cmd UI. New phone screen under
  `src/screens/cmd/sections/phone/` (peer to `PhoneOrdering`), reached via the
  notification deep-link and gated by `useIsPhone()` with the guard placed AFTER
  all hooks. No legacy admin surface exists (spec 025).
- **Which app:** this repo (admin) only. Staff (`src/screens/staff/`) is the
  trigger source but is not modified (AC-REG-5). The customer PWA and the Chrome
  extension are siblings — the extension is a consumer of the frozen contract
  (AC-REG-3), not a target of this spec.
- **Per-store or admin-global:** **per-store.** `order_approvals` scopes via
  `auth_can_see_store()` (AC-21); notification visibility is brand-scoped and
  inherited from spec 120 (`auth_can_see_brand`). No trivially-wide permissive
  policy — the spec-053 lint probe must stay green with no allowlist addition.
- **Edge function or PostgREST:** **both, split deliberately.** Approval writes +
  reads go through PostgREST/RPC via `src/lib/db.ts` under existing RLS. The
  Instacart link mint is a **new JWT-protected edge function** (default
  `verify_jwt = true` — this is NOT a `staff-*` / `pwa-catalog` service-token
  function) with a `requireAdminCaller()` gate mirroring `auth_is_privileged()`
  (AC-23) and the caller-store check (AC-24). Client calls go through
  `callEdgeFunction` (AC-25). JSON only — no HTML, so `escapeHtml()` does not
  apply (AC-26).
- **Realtime channels touched:** `store-{id}` (if `order_approvals` is added to
  the `supabase_realtime` publication so a second admin device sees an approval
  land) and the existing `notifications-{brandId}` channel for the new
  notification type. **Risk / gotcha:** adding `order_approvals` to the
  publication mid-session requires `docker restart
  supabase_realtime_imr-inventory` to re-snapshot the slot (project MEMORY
  `project_realtime_publication_gotcha`); a new notification *type* on the
  already-published `notifications` table does NOT.
- **Migrations needed:** **yes** — (a) widen `notifications_type_check` with
  `order_ready`; (b) create `order_approvals` + RLS + status guard; (c) the vendor
  channel/`retailer_key` column(s); (d) the emit function/trigger. Additive; no
  destructive DDL. Prod apply via MCP + `schema_migrations` insert.
- **Edge functions touched:** NEW `instacart-cart-link` (working name);
  MODIFIED `submission-push-fanout` (`TYPE_LABEL` + `order_ready` payload
  branch). `staff-*` stubs and every other function untouched.
- **Web/native scope:** phone tier of the admin app — **both** web (Vercel) and
  native (EAS). Opening the Instacart link must work on both (`Linking.openURL`
  on native, new tab on web); web-push notification delivery remains web-only, as
  it already is (specs 120/121) — native notification delivery is unchanged and
  out of scope.
- **Tests (spec 022 tracks):** jest (AC-28), pgTAP (AC-29), shell smoke (AC-30).
  All three tracks are in play — the test-engineer routes each AC to its named
  track.
- **`app.json` slug:** untouched. Nothing in this spec touches build identifiers,
  store listings, or push certs (CLAUDE.md DO-NOT-AUTO-FIX).
- **CI:** both gates (`test.yml`, `db-migrations-applied.yml`) must be green on
  `main` before this ships; the migration gate will be red between commit and MCP
  prod-apply, which is expected and must be flagged, not "fixed".

## Backend design

> Authored by `backend-architect` (design mode). Verified against: spec 120
> `20260715000000_submission_notifications.sql`, spec 121
> `20260716000000_missed_eod_notification_type.sql`, spec 126
> `20260720000000_staff_reports_issue_notifications.sql`, specs 131/132
> `20260723000000_extension_ordering.sql`, spec 138
> `20260726000000_reorder_drop_inbound_term.sql` (current owner of
> `report_reorder_list`), `20260504173035_per_store_rls_hardening.sql`,
> `20260509000000_multi_brand_schema_rls.sql`, `src/lib/db.ts`,
> `src/store/useStore.ts`, `src/lib/paletteAction.ts`,
> `src/screens/cmd/sections/phone/PhoneOrdering.tsx`,
> `src/screens/cmd/sections/phone/PhoneNotifications.tsx`,
> `src/components/cmd/NotificationBell.tsx`, `src/hooks/useRealtimeSync.ts`,
> `supabase/functions/delete-user/index.ts`,
> `supabase/functions/submission-push-fanout/index.ts`,
> `supabase/config.toml`.

### §0 — Rulings up front (read this before anything else)

| # | Ruling | AC / OQ |
|---|--------|---------|
| R-1 | `order_ready` **replaces** the routine `eod` notification when the vendor is order-configured AND the cheap below-par predicate is true. Exactly one row per submission either way. | OQ-1 / AC-3 |
| R-2 | The emit-time "is there an order?" test is a **cheap SQL predicate** (`par_replacement` arm only), NOT a call to `report_reorder_list` in the staff submit path. Documented divergence — see §3.3. | AC-2 |
| R-3 | Channel precedence: `instacart` wins **only** when `order_channel='instacart'` AND a non-empty `instacart_retailer_key` exists; otherwise `extension_ordering=true` wins; otherwise `webstaurant`; otherwise `manual`. `order_channel='extension'` with `extension_ordering=false` resolves to `manual` — the new column can never contradict the specs-131/132 flag. | AC-14 |
| R-4 | The live IDP ZIP/retailer-availability check (OQ-2) happens **server-side at mint time**, inside `instacart-cart-link`, not at emit or render time. Unavailable ⇒ HTTP 409 `retailer_unavailable` + `fallbackChannel`, and the client re-runs the approve action on the fallback channel. | OQ-2 |
| R-5 | **No migration in this spec changes `supabase_realtime` publication membership.** `public.notifications` is already published (spec 120 Part 7) so a new *type* needs nothing; `order_approvals` is deliberately **NOT** published in v1. ⇒ **no `docker restart supabase_realtime_imr-inventory` step.** See §6. | project note |
| R-6 | Re-approval of an already-`approved` `(store, vendor, business_date)` is **refused**, not overwritten. The screen offers RE-OPEN LINK / MARK ORDERED instead. Keeps the row genuinely append-only and satisfies AC-13's "already actioned" branch. | AC-13/19/20 |
| R-7 | **I could not verify the IDP request shape or retailer coverage live** — this agent has no network tool in this session. Every IDP-facing field in §5.4 is marked **MUST-VERIFY** and the backend-developer must diff it against `docs.instacart.com/developer_platform_api` **before** writing the call. OQ-2's Sam's/BJ's ZIP check is likewise an implementation-time + operator-time gate, specified as executable steps in §5.5. | OQ-5 / OQ-2 |
| R-8 | Scope addition, flagged for the PM: **`VendorFormDrawer` gains 2 fields and `StoreFormDrawer` gains 1** (§7.6). Without them AC-14's "data-driven, not a name match" channel is unsettable except by hand-SQL, which the project MEMORY forbids ("don't drift via dashboard SQL editor"). Neither drawer is in the AC-REG-2 frozen tree. | AC-14 |

---

### §1 — Data model changes

Latest migration on disk is `20260726000000_reorder_drop_inbound_term.sql`. Three
new migrations, **strictly additive**, applied in this order (later ones depend
on earlier ones):

#### 1.1 `supabase/migrations/20260801000000_vendor_order_channel.sql`

Additive columns only. No backfill, no data touched, metadata-only on PG 17.

```
alter table public.vendors
  add column if not exists order_channel text;
alter table public.vendors
  add constraint vendors_order_channel_check
  check (order_channel is null
         or order_channel in ('instacart','webstaurant','extension','manual'));

alter table public.vendors
  add column if not exists instacart_retailer_key text;   -- nullable, IDP retailer slug

alter table public.stores
  add column if not exists postal_code text;              -- nullable; ZIP for the IDP
                                                          -- retailer-availability lookup
```

`stores.address` is free text and is NOT parsed — a dedicated `postal_code`
column is the ZIP source (OQ-2). NULL `postal_code` ⇒ the Instacart channel is
unavailable for that store and falls back (R-4).

**RLS inheritance — zero policy change.** `vendors.*` inherits
`brand_member_read_vendors` / `privileged_update_vendors` etc. verbatim (policies
are column-agnostic); `stores.postal_code` inherits the existing `stores`
policies. Grants ride the spec-097 table-level grants. No `permissive_policy_lint`
allowlist edit (no policy added).

**Channel-resolution helper — the single SQL truth for R-3:**

```
create or replace function public.vendor_order_channel(p_vendor_id uuid)
returns text language sql stable security invoker set search_path = public as $$
  select case
    when v.order_channel = 'instacart'
     and nullif(btrim(coalesce(v.instacart_retailer_key,'')),'') is not null
      then 'instacart'
    when v.extension_ordering            then 'extension'
    when v.order_channel = 'webstaurant' then 'webstaurant'
    else 'manual'
  end
  from public.vendors v where v.id = p_vendor_id;
$$;
revoke all     on function public.vendor_order_channel(uuid) from public, anon;
grant  execute on function public.vendor_order_channel(uuid) to authenticated;
```

`security invoker` — the caller's `brand_member_read_vendors` policy clips the
row; an invisible vendor yields NULL, and `create_order_approval` (§1.2) raises
on NULL. Mirrors the `get_pending_extension_orders` posture (specs 131/132), not
the staff DEFINER RPCs.

**AC-14 precedence truth table — pinned by BOTH tracks** (pgTAP against
`vendor_order_channel`, jest against the TS mirror in §7.2). The developer must
implement all eight rows:

| `order_channel` | `instacart_retailer_key` | `extension_ordering` | ⇒ resolved |
|---|---|---|---|
| `'instacart'` | `'sams_club'` | `true` | **`instacart`** (only case that beats the flag) |
| `'instacart'` | `NULL` / `''` | `true` | **`extension`** (BJ's stays on the tuned cart-filler) |
| `'instacart'` | `NULL` / `''` | `false` | `manual` |
| `'webstaurant'` | — | `true` | **`extension`** |
| `'webstaurant'` | — | `false` | `webstaurant` |
| `'extension'` | — | `false` | **`manual`** (column cannot contradict the flag) |
| `NULL` | — | `true` | `extension` |
| `NULL` | — | `false` | `manual` |

#### 1.2 `supabase/migrations/20260801000100_order_approvals.sql`

```
create table if not exists public.order_approvals (
  id                      uuid primary key default gen_random_uuid(),
  store_id                uuid not null references public.stores(id)          on delete cascade,
  vendor_id               uuid not null references public.vendors(id)         on delete restrict,
  business_date           date not null,
  approved_by             uuid          references public.profiles(id)        on delete set null,
  approved_at             timestamptz not null default now(),
  channel                 text not null check (channel in ('instacart','webstaurant','extension','manual')),
  status                  text not null default 'pending'
                            check (status in ('pending','approved','ordered')),
  lines                   jsonb not null,       -- snapshot, see shape below
  line_count              integer not null default 0,
  est_total_cost          numeric(12,4) not null default 0,
  external_ref            text,                 -- instacart products_link_url | po id | order page url
  external_ref_expires_at timestamptz,
  ordered_at              timestamptz,
  source_submission_id    uuid          references public.eod_submissions(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- AC-19 / design-guidance-6 idempotency spine: ONE approval per
-- (store, vendor, business_date). A double-tap or retry hits this key.
create unique index if not exists order_approvals_store_vendor_date_uidx
  on public.order_approvals (store_id, vendor_id, business_date);

-- Feed / history read path (store-scoped, newest first).
create index if not exists order_approvals_store_approved_idx
  on public.order_approvals (store_id, approved_at desc);
```

`lines` element shape (snake_case in the DB, camelCase at the `db.ts` boundary):

```
{ "item_id": uuid, "item_name": text, "qty_base": numeric,
  "case_qty": numeric, "unit": text, "cost_per_counted_unit": numeric }
```

`qty_base` is **BASE / COUNTED units** — the same basis `fillCartForVendor` and
`createPurchaseOrderDraft` already persist. `cost_per_unit_counted` is the
**spec-104 ★ bridge**: `ReorderItem.costPerUnit` (per-EACH) `× subUnitSize`. The
RPC does NOT re-derive it (it has no `inventory` array); the client computes it
exactly as `useStore.fillCartForVendor` does today (`useStore.ts:2892`) and the
RPC validates `> 0` shape only. **This is the single easiest thing to get wrong
in the whole spec** (design guidance 5).

**Status-transition + immutability guard (AC-20).** One `BEFORE UPDATE` trigger,
`tg_order_approvals_guard()`, `security definer`, `set search_path = public`:

* Legal status moves: `pending→approved`, `approved→ordered`, and any no-op
  (`x→x`). Anything else ⇒ `raise exception 'illegal order approval status
  transition: % -> %' using errcode = 'P0001'` (PostgREST ⇒ HTTP 400).
* Always-immutable: `id`, `store_id`, `vendor_id`, `business_date`,
  `approved_by`, `approved_at`, `source_submission_id`, `created_at`. Change ⇒
  `raise exception 'order approval is immutable' using errcode = 'P0001'`.
* Immutable **once `old.status <> 'pending'`**: `lines`, `line_count`,
  `est_total_cost`, `channel`. (Mutable while `pending` so a failed mint can be
  retried with corrected lines — the only write-amplification the spec needs.)
* **Channel-escalation guard while `pending`** *(added in the post-review fix
  round — security-auditor Medium 2; the original design left this open)*.
  `channel` is a general-purpose PostgREST-writable column (`advanceOrderApproval`
  exposes it for the OQ-2 fallback) and `instacart-cart-link` gates only on the
  **stored** channel, so a privileged caller could PATCH `channel='instacart'`
  onto a pending row whose vendor resolves to `extension`/`manual` and reach the
  mint path — routing around the R-3 precedence that keeps BJ's / Sam's on the
  tuned cart-filler. A `pending`-row `channel` change is therefore legal only
  when the new value is **downward** (`'extension'` / `'manual'` — the only
  values the shipped OQ-2 fallback writes) **or** equals the server-resolved
  `public.vendor_order_channel(new.vendor_id)` (which is what
  `create_order_approval`'s retry path re-writes after a vendor config change —
  refusing that would permanently wedge a row, since there is no DELETE policy).
  Anything else ⇒ `raise … 'order approval channel may not be changed to %'
  using errcode = 'P0001'`. Pinned by `order_approvals.test.sql` (G7)/(G8)/(G9).
* `external_ref` / `external_ref_expires_at` writable at `pending` and
  `approved`; frozen at `ordered` (OQ-6 re-open + expiry re-mint).
* Auto-set: `new.updated_at := now()`; on transition into `'ordered'`,
  `new.ordered_at := coalesce(new.ordered_at, now())`.

No `DELETE` policy is created ⇒ deletes are default-denied ⇒ "append-only in
spirit" (AC-19) is enforced by RLS, not convention.

**Create RPC (the only INSERT path).**

```
create or replace function public.create_order_approval(
  p_store_id      uuid,
  p_vendor_id     uuid,
  p_business_date date,
  p_lines         jsonb,
  p_submission_id uuid default null
) returns public.order_approvals
language plpgsql security invoker set search_path = public
```

Order of operations (mirrors `submit_staff_report` / `get_extension_order_payload`
discipline):

1. **Top gate, before any write:** `if not public.auth_can_see_store(p_store_id)
   then raise … errcode='42501'` (⇒ HTTP 403). Second gate:
   `if not public.auth_is_privileged() then raise … errcode='42501'` — approval
   is an admin surface (AC-REG-5: staff never approve).
2. **Validate `p_lines`** (server-side mirror of AC-27, so the DB path is as
   strict as the edge path): array, `1 ≤ length ≤ 200`; every element has a
   `item_id` castable to uuid, `qty_base` numeric `> 0` and `≤ 100000`,
   `item_name` trimmed length `1..200`, `cost_per_counted_unit` numeric `>= 0`.
   Violation ⇒ `errcode='22023'` (⇒ HTTP 400).
3. **Resolve the channel server-side** via `public.vendor_order_channel(p_vendor_id)`.
   NULL (vendor invisible/missing) ⇒ `errcode='P0002'` (⇒ HTTP 404). The client
   never supplies the channel.
4. **Idempotent upsert on `(store_id, vendor_id, business_date)`:**
   * no row ⇒ INSERT at `status='pending'`, `approved_by = auth.uid()`.
   * existing row `status='pending'` ⇒ UPDATE `lines`/`line_count`/
     `est_total_cost`/`channel` (retry path), status untouched.
   * existing row `status in ('approved','ordered')` ⇒ **no write**, return the
     existing row verbatim (R-6). The client reads `status` and renders the
     already-actioned state (AC-13).
   * **lost race** *(added in the post-review fix round — backend-architect S-3;
     the original design's plain INSERT had a select-then-insert window)*: two
     approvals for the same key arriving concurrently (two admin devices, or a
     retry racing its own in-flight predecessor) both see "no row"; the loser
     hits `order_approvals_store_vendor_date_uidx` and would surface a raw
     `23505` ⇒ PostgREST 409 ⇒ a raw error toast, since §3.2 has no `23505` row
     and the client has no branch for it. The INSERT is therefore wrapped in
     `exception when unique_violation then` — re-read the winner's row and fall
     through the SAME retry / R-6 logic above, so a lost race is
     indistinguishable from a plain replay (design guidance 6's "safe to
     repeat"). If the re-read finds nothing the exception is re-raised (it was a
     different constraint, not the idempotency key). Pinned by
     `order_approvals.test.sql` (C7).
5. Return the whole row.

```
revoke all     on function public.create_order_approval(uuid, uuid, date, jsonb, uuid) from public, anon;
grant  execute on function public.create_order_approval(uuid, uuid, date, jsonb, uuid) to authenticated;
```

Status advances (`pending→approved`, `approved→ordered`) and `external_ref`
writes are plain **PostgREST UPDATEs** under RLS + the trigger — no extra RPC.
The trigger is the server-side rejection AC-20 asks for.

#### 1.3 `supabase/migrations/20260801000200_order_ready_notification_type.sql`

1. **Widen the CHECK** exactly as specs 121/126 did — drop-then-re-add under the
   same auto-generated name, all legacy values preserved:

```
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('eod','weekly','waste','receiving','po','missed_eod','issue','order_ready'));
```

2. **Cheap below-par predicate** (R-2, AC-2). **Amended in the post-review fix
   round (backend-architect S-2):** the design's `left join public.eod_entries`
   was **inert on every real path** — the trigger is `AFTER INSERT` on
   `eod_submissions` and `submit_staff_eod_*` writes entries only *after* the
   parent row lands, so the join never matched and the predicate always read
   `inventory_items.current_stock`. It was dropped rather than left as a decoy
   (three reviewers had to re-derive this). **Zero behavior change.**
   `p_submission_id` is retained for signature stability and for the future
   "make the entries participate" change. Shipped form:

```
create or replace function public.eod_vendor_has_below_par(
  p_store_id uuid, p_vendor_id uuid, p_submission_id uuid  -- p_submission_id unused
) returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.inventory_items ii
      join public.item_vendors iv on iv.item_id = ii.id and iv.vendor_id = p_vendor_id
     where ii.store_id = p_store_id
       and coalesce(ii.par_level, 0) - coalesce(ii.current_stock, 0) >= 0.001
  );
$$;
revoke execute on function public.eod_vendor_has_below_par(uuid, uuid, uuid)
  from public, anon, authenticated;
```

3. **`public.emit_order_ready(p_store_id, p_vendor_id, p_vendor_name, p_actor,
   p_submission_id)`** — a thin sibling of `emit_submission_notification`,
   `security definer`, wrapped in the same `begin/exception when others → raise
   warning` envelope so a notify failure can never roll back a staff submit.
   Writes `type='order_ready'`, `source_id = p_submission_id`,
   `actor_name = coalesce(username, name)` of the submitter (unchanged semantics —
   unlike `missed_eod`, an `order_ready` HAS an actor), `store_name` denormalized,
   and **`body = p_vendor_name`** (the spec-126 general-purpose free-text column,
   explicitly "reusable by any future free-text type"). `category` stays NULL.
   `on conflict (type, source_id) do nothing`, then `enqueue_submission_push` on a
   real insert. EXECUTE revoked from `public, anon, authenticated`.

4. **`create or replace public.tg_notify_eod_submission()`** — the trigger
   `notify_eod_submission` itself is **unchanged** (still `after insert … when
   (new.status = 'submitted')`), only the function body branches:

```
if new.vendor_id is not null
   and public.vendor_order_channel(new.vendor_id) is not null   -- vendor visible
   and public.eod_vendor_has_below_par(new.store_id, new.vendor_id, new.id)
then
  perform public.emit_order_ready(new.store_id, new.vendor_id,
            (select name from public.vendors where id = new.vendor_id),
            new.submitted_by, new.id);
else
  perform public.emit_submission_notification('eod', new.store_id, new.submitted_by, new.id);
end if;
```

Because the branch is exclusive and the trigger is INSERT-only, exactly one
notification fires per submission (AC-3), deduped by
`notifications_type_source_uidx` on `(type, source_id)` (AC-2).

> **`vendor_order_channel` is `security invoker` and this trigger function is
> `security definer`** — inside a DEFINER function the invoker helper runs as the
> function owner, so `brand_member_read_vendors` does not clip it. That is the
> desired behavior here (a staff submitter must not need vendor-read to trigger
> the admin's notification). Developer: call it out in a comment; do NOT "fix" it
> to DEFINER.

**"Order-configured" is deliberately permissive.** Every vendor resolves to some
channel (worst case `manual`), so the gate is effectively "vendor exists AND has
below-par items". That is intentional: a `manual` vendor still benefits from the
review screen (AC-18). If the owner later wants `order_ready` restricted to
non-`manual` vendors, that is a one-line predicate change — flagged, not built.

---

### §2 — RLS impact

#### New table: `public.order_approvals`

```
alter table public.order_approvals enable row level security;

create policy "privileged_store_read_order_approvals"
  on public.order_approvals for select
  using (public.auth_is_privileged() and public.auth_can_see_store(store_id));

create policy "privileged_store_insert_order_approvals"
  on public.order_approvals for insert
  with check (public.auth_is_privileged()
              and public.auth_can_see_store(store_id)
              and approved_by = auth.uid());

create policy "privileged_store_update_order_approvals"
  on public.order_approvals for update
  using       (public.auth_is_privileged() and public.auth_can_see_store(store_id))
  with check  (public.auth_is_privileged() and public.auth_can_see_store(store_id));

-- NO delete policy → default-deny (append-only, AC-19).
```

Why the `auth_is_privileged()` conjunct is **load-bearing** (same rationale as
spec 120's `privileged_brand_read_notifications` and spec 126's
`privileged_brand_read_staff_reports`): `auth_can_see_store()` returns TRUE for a
store-linked staff `user` row. Staff submit counts; they do not approve orders
(AC-REG-5). Without the conjunct a staff session could INSERT approvals.

**Spec-053 `permissive_policy_lint` (AC-21):** all three predicates are
conjunctions of two helper calls — not `true`, not `auth.uid() IS NOT NULL`, not
`auth.role() = 'authenticated'`, and no OR-tail. The probe stays green with **no
allowlist row added**. Developer: do not add one.

**Permissive-OR audit (CLAUDE.md rule):** `order_approvals` is a brand-new table;
`pg_policies` has zero pre-existing rows for it, so there is no wide policy to OR
against. Nothing to consolidate.

**Grants:** inherits the `20260618000000_public_grants_explicit.sql` ALTER DEFAULT
PRIVILEGES posture. **Do not** `revoke` from `anon`/`authenticated` — that would
trip the spec-097 grant lint. RLS is the gate.

#### Changed existing tables

| Table | Policy change |
|---|---|
| `public.notifications` | **None.** Only the `type` CHECK widens. `privileged_brand_read_notifications` covers `order_ready` rows unchanged (AC-4 inherits spec 120/121 scoping). |
| `public.vendors` | **None.** Two new columns inherit `brand_member_read_vendors` / `privileged_update_vendors` column-agnostically — a non-privileged member cannot set `order_channel` or `instacart_retailer_key` the instant the columns exist. |
| `public.stores` | **None.** `postal_code` inherits the existing store policies (incl. the spec-051 rewritten ones). |
| `public.eod_submissions` | **None.** The new `db.ts` context read rides `store_member_read_eod_submissions`. |

---

### §3 — API contract

#### 3.1 PostgREST vs RPC — the split

| Operation | Mechanism | Why |
|---|---|---|
| Create/replay an approval | **RPC** `create_order_approval` | Server must resolve the channel (untrusted client), validate lines, and do the idempotent upsert atomically. |
| Read an approval | **PostgREST** `order_approvals` select | Trivial RLS-clipped row read. |
| Advance status / write `external_ref` | **PostgREST** update | The trigger is the guard; an RPC would add surface for nothing. |
| Read the deep-link context | **PostgREST** `eod_submissions` select | One RLS-clipped row. |
| Suggested lines | **existing RPC** `report_reorder_list` | Unmodified (AC-8, "no forked reorder math"). |
| Mint the Instacart link | **edge function** `instacart-cart-link` | Holds the IDP secret (AC-22). |

#### 3.2 `create_order_approval` — request / response / errors

Request (via `supabase.rpc`, from `db.ts`):

```
{ p_store_id: uuid, p_vendor_id: uuid, p_business_date: 'YYYY-MM-DD',
  p_lines: [{ item_id, item_name, qty_base, case_qty, unit, cost_per_counted_unit }],
  p_submission_id: uuid | null }
```

Response: the full `order_approvals` row (PostgREST returns the composite as a
JSON object).

| Condition | SQLSTATE | HTTP | Message |
|---|---|---|---|
| Store not visible | `42501` | 403 | `not authorized for this store` |
| Caller not privileged | `42501` | 403 | `not authorized to approve orders` |
| Bad/empty/oversized lines | `22023` | 400 | `invalid approval lines: <reason>` |
| Vendor missing or invisible | `P0002` | 404 | `vendor % not found` |
| Already `approved`/`ordered` | — | 200 | existing row returned unchanged (client branches on `status`) |

#### 3.3 Emit-predicate divergence — stated plainly (R-2)

AC-2 says the emit fires when the vendor "resolves to a non-empty
server-computed suggested order". Running `report_reorder_list` inside the EOD
submit trigger would put a recursive recipe-graph walk + a 7-day POS aggregation
on the **staff submit path** (286 KB seed; the engine is the heaviest read in the
schema). That is an unacceptable latency and failure-coupling regression on a
surface AC-REG-5 freezes.

`eod_vendor_has_below_par` implements the engine's `par_replacement` arm
(`par_level − on_hand > 0`) over the same `item_vendors` join, with no recipe
walk.

> **CORRECTED in the post-review fix round (backend-architect S-2). The original
> wording — "sufficient, not necessary … never a false positive" — was wrong,
> and a future reader relying on it would make a bad call.** The design assumed
> the predicate's `left join public.eod_entries` supplied tonight's counted
> `actual_remaining`. It never did: `notify_eod_submission` is `AFTER INSERT` on
> `eod_submissions` and `submit_staff_eod_*` writes entries (and bumps
> `current_stock`) only *after* the parent row lands, so at trigger time no
> entries exist. The join was inert on every real path and has been dropped;
> `on_hand` is, and always was, the **pre-count `inventory_items.current_stock`**.

The honest statement of the approximation — it errs in **both** directions:

* pre-count stock **higher** than the counted remaining (the normal case, stock
  depleted through the day) ⇒ `par − current_stock` < `par − actual_remaining` ⇒
  **under**-fires ⇒ degrades to the existing spec-120 `eod` notification, which
  still pings the admin. Safe, as originally intended.
* pre-count stock **lower** than the counted remaining (an unrecorded receipt, or
  a prior under-count corrected by tonight's count) ⇒ can fire while
  `report_reorder_list`'s `par_replacement` is ≤ 0 — a **false positive**. The
  backstop is **AC-13's empty-order state**: the admin lands on the Approve Order
  screen, the vendor is absent from `reorderPayload.vendors`, and the primary
  action is disabled. The failure mode is *wrong notification copy*, never a
  wrong order and never a data change.

**The async job is NOT needed sooner (architect's ruling).** The false positive
requires an unrecorded receipt, is contained by an acceptance criterion that
already exists, and pulling the async post-commit job (pg_net → an edge function
that runs the engine and emits) forward would be an overreaction to a
copy-accuracy bug. Engine-exact emission stays a follow-up spec.

*PM: if you want exactness anyway, that async job is the shape it takes. It is a
strictly bigger build and was not in scope; say the word and it becomes its own
spec.*

#### 3.4 Notification row → deep-link resolution (AC-6)

The notification carries `source_id` = the `eod_submissions.id`, `store_id`, and
`body` = the vendor name. Vendor **id** and business **date** are resolved with
one RLS-clipped read rather than by widening the `notifications` schema:

```
GET /rest/v1/eod_submissions?id=eq.<sourceId>&select=id,store_id,vendor_id,date,status,submitted_at
```

Rejected alternative: a `notifications.vendor_id` column. Generic-column creep on
a table that already carries two reuse-slots (`body`, `category`); one cheap
single-row read is cheaper than schema churn on the notification spine that
design-guidance-1 tells us to reuse wholesale.

---

### §4 — Push copy (`submission-push-fanout`) — AC-7

`supabase/functions/submission-push-fanout/index.ts`, **`verify_jwt = false`
unchanged** (it is the pg→function cron-bearer path, not a user-invoked op — no
`ADMIN_ROLES` gate applies, per the file's own header and `config.toml:451`).

Two edits only:

1. `TYPE_LABEL['order_ready'] = 'Order ready to approve'`.
2. A third branch alongside `isIssue` / `isMiss`:

```
const isOrderReady = notif.type === 'order_ready';
…
} else if (isOrderReady) {
  title    = 'Order ready to approve';
  bodyText = [notif.store_name ?? '', notif.body ?? ''].filter(Boolean).join(' · ');
}
```

The body must **not** contain the word "submitted" (AC-7). Recipients, brand
scoping, actor exclusion, and the VAPID path are inherited from spec 120 —
untouched. The function serves JSON + web-push payloads, never HTML ⇒ the
`escapeHtml()` convention does not apply (AC-26 parallel).

**Testability (added in the post-review fix round — test-engineer Critical
AC-7).** As shipped, the four title/body branches live in one exported pure
function, `derivePushCopy(notif)`, and the handler calls it. AC-7 is not
observable from a shell smoke: the function's response body carries only
`{ ok, recipients, pushed }`, and the copy travels inside an *encrypted*
web-push payload, so no HTTP assertion can see it. It is covered instead by the
repo's existing pattern for Deno-side pure logic — a source-level TS mirror at
`src/utils/pushNotificationCopy.ts` (byte-identical body, **not imported** by the
edge function, identity enforced at code-review time — exactly like
`src/utils/escapeHtml.ts` vs. the `send-*-email` functions, CLAUDE.md/spec 028),
exercised by `src/utils/pushNotificationCopy.test.ts` in the jest track. No
fourth test framework; no Deno harness introduced. The pre-existing zero coverage
of the `isMiss` (spec 121) and `isIssue` (spec 126) branches is closed by the
same file as a side effect.

---

### §5 — Edge function: `instacart-cart-link` (NEW)

`supabase/functions/instacart-cart-link/index.ts`.

#### 5.1 `config.toml`

```
# Spec 149 — Instacart IDP cart-link minting. Explicitly pinned TRUE (same
# posture as send-po-email): an admin-triggered action carrying the CALLER's
# Supabase JWT, gated by requireAdminCaller()/ADMIN_ROLES mirroring
# auth_is_privileged(). NOT a staff-* / pwa-catalog service-token function.
[functions.instacart-cart-link]
verify_jwt = true
```

#### 5.2 Auth + gates

* `const ADMIN_ROLES = new Set(["admin", "master", "super_admin"]);` and an
  **inline** `requireAdminCaller()` copied byte-for-byte in shape from
  `supabase/functions/delete-user/index.ts:19-47` — including the
  `profiles.role` fallback for stale JWTs. Inline, **not** `_shared/`
  (CLAUDE.md spec-027 §4.2 rationale). Non-privileged ⇒ 401/403 **with no
  upstream call** (AC-23).
* **AC-24 store scope without trusting the body:** the function accepts
  `{ approvalId }` only. It builds an **anon-key client carrying the caller's
  bearer** (`createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers:
  { Authorization: 'Bearer ' + token } } })` — the same construction
  `requireAdminCaller` already uses) and reads the approval + its vendor + its
  store through it. RLS clips the read: a cross-store `approvalId` returns zero
  rows ⇒ **404**, before any upstream contact. There is no service-role read on
  the request path. This is design-guidance 3 realized: the edge function's blast
  radius is "holds a secret, calls one upstream".
* `escapeHtml()` **does not apply** — JSON-only responses, no HTML body, no email
  (AC-26). Called out here so review does not flag its absence as drift.
* Self-guard / last-of-role guard: **N/A** — this function performs no
  role-change and no deletion. Called out explicitly for the same reason.

#### 5.3 Contract

`POST /functions/v1/instacart-cart-link`

Request: `{ "approvalId": "<uuid>" }` — nothing else. Any extra key is ignored.

Success `200`:

```
{ "ok": true, "approvalId": "...", "url": "https://www.instacart.com/...",
  "expiresAt": "2026-08-31T00:00:00.000Z" | null, "reused": false }
```

Errors (all JSON, all `{ ok: false, error: '<stable token>', … }`):

| HTTP | `error` | When |
|---|---|---|
| 400 | `approvalId required` | missing / non-uuid body |
| 400 | `invalid lines: <reason>` | AC-27 validation fails |
| 401 | `missing bearer token` / `invalid token` | no/bad JWT |
| 403 | `forbidden` | role not in `ADMIN_ROLES` |
| 404 | `approval not found` | RLS-hidden or absent (**this is the cross-store refusal**, AC-24) |
| 409 | `wrong_channel` | approval `channel <> 'instacart'` |
| 409 | `retailer_unavailable` + `{ fallbackChannel: 'extension'\|'manual', postalCode: null\|'…' }` | OQ-2 |
| 409 | `already_ordered` | approval `status = 'ordered'` |
| 502 | `upstream_error` + `{ upstreamStatus, correlationId }` | IDP non-2xx |
| 504 | `upstream_timeout` + `{ correlationId }` | 10 s `AbortController` fired |

**Idempotency (design guidance 6):** if the approval already has a non-null
`external_ref` whose `external_ref_expires_at` is in the future, return it with
`reused: true` and **make no upstream call**. If expired, mint fresh (the user
pressed the button — not a silent auto-regeneration, OQ-6).

**Write-back:** on a successful mint the function updates, **through the
caller-token client** (RLS + the §1.2 trigger both apply):
`external_ref = <url>`, `external_ref_expires_at = <now + expires_in>`,
`status = 'approved'` (legal `pending→approved`). If the row is already
`approved`, the status write is a no-op self-transition — also legal.

**Observability (design guidance 7):** mint a `correlationId`
(`crypto.randomUUID()`) per request, echo it in every error body, and
`console.log`/`console.error` **only**: `correlationId`, `approvalId`, HTTP
status, upstream status, and elapsed ms. **Never** the API key, never the full
request body, never the returned URL. Request timeout: `AbortController`, 10 000 ms.

#### 5.4 Instacart IDP call — **MUST-VERIFY** (OQ-5)

> ⚠️ **This agent had no network access this session and could not open
> `docs.instacart.com/developer_platform_api`.** Everything below is the
> architect's best reconstruction and is **normative only after the
> backend-developer diffs it against the live docs**. Any field that differs:
> update the code AND update this table in the same PR, and record the doc URL +
> date checked in the migration/function header comment.

**Secret:** `INSTACART_IDP_API_KEY`, a Supabase **function secret**
(`supabase secrets set INSTACART_IDP_API_KEY=…`), read via `Deno.env.get`. Never
in `.env` shipped to Expo, never in a response body, never logged (AC-22). A
client-side `fetch` to `connect.instacart.com` anywhere under `src/` is a
Critical.

**Endpoint (MUST-VERIFY):**
`POST https://connect.instacart.com/idp/v1/products/products_link`

**Headers (MUST-VERIFY):**
`Authorization: Bearer ${INSTACART_IDP_API_KEY}`, `Content-Type: application/json`,
`Accept: application/json`.

**Body (MUST-VERIFY — field names, nesting, and the `unit` enum are exactly what
OQ-5 warns has drifted):**

```
{
  "title": "<Store> · <Vendor> · <YYYY-MM-DD>",
  "link_type": "shopping_list",
  "expires_in": 30,                         // days; drives external_ref_expires_at
  "instructions": ["Review quantities before checkout."],
  "line_items": [
    { "name": "<item_name>",
      "quantity": <number>,
      "unit": "each",
      "display_text": "<n> case(s) of <case_qty> · <item_name>" }
  ],
  "landing_page_configuration": {
    "partner_linkback_url": "<optional>",
    "enable_pantry_items": true
  }
}
```

**Response (MUST-VERIFY):** `{ "products_link_url": "https://www.instacart.com/…" }`.
The function returns that value as `url`; if the key is absent from a 2xx body,
treat it as `502 upstream_error` (never a fake success — AC-15).

**Retailer pinning (MUST-VERIFY):** the vendor's `instacart_retailer_key` is
appended/attached per the current docs (query param on the returned URL vs a body
field vs a retailer-scoped endpoint variant — **verify which**). If the docs no
longer support pinning a retailer on `products_link`, STOP and surface to the PM
rather than shipping a link that lands on a retailer picker.

**Quantity mapping.** Approval lines are BASE/COUNTED units. For a case row
(`case_qty > 1`) send `quantity = ceil(qty_base / case_qty)` with `display_text`
naming the case size; otherwise `quantity = qty_base`. Reuse the existing
`poOrderedToCases` semantics conceptually — the edge function is a separate Deno
bundle and cannot import `src/utils/poCaseDisplay.ts`, so it carries a two-line
inline equivalent, commented as a deliberate mirror.

**Validation before the upstream call (AC-27):** `1 ≤ line_items.length ≤ 100`;
each `quantity` finite, `> 0`, `≤ 9999`; each `name` trimmed to `1..200` chars;
non-conforming ⇒ `400 invalid lines: <reason>` with **no upstream call**.

#### 5.5 OQ-2 — Sam's Club / BJ's retailer availability + extension fallback

**Runtime check (in the function, before minting):**

1. Read `stores.postal_code` for the approval's store (caller-token client).
   NULL/empty ⇒ short-circuit `409 retailer_unavailable` with `postalCode: null`.
2. `GET https://connect.instacart.com/idp/v1/retailers?postal_code=<zip>&country_code=US`
   with the same bearer (**MUST-VERIFY path, query params, and response shape;
   expected `{ retailers: [{ retailer_key, name, … }] }`**). Same 10 s timeout.
3. If `vendors.instacart_retailer_key` is not present in the returned
   `retailer_key` set ⇒ `409 retailer_unavailable` with
   `fallbackChannel = vendor.extension_ordering ? 'extension' : 'manual'`.
   **No `products_link` call is made.**
4. Otherwise mint.

**Client fallback (pinned by a jest case, AC-28):** on `retailer_unavailable`,
`approveAndOrder` does **not** toast a raw error — it re-runs the approve action
on `fallbackChannel` (extension ⇒ the existing `fillCartForVendor` handoff;
manual ⇒ the quick-order-text path), updates the approval's `channel` (legal
while `status = 'pending'`), and the screen shows the OQ-2 copy:
`section.approveOrder.retailerUnavailable` — "Instacart doesn't cover
&lt;vendor&gt; at &lt;store&gt;'s ZIP. Falling back to the cart-filler." It never
opens a link that lands on an empty retailer.

**Operator gate before enabling the channel (OQ-2's "the architect MUST
verify"):** this cannot be discharged from the repo — it needs a live key and a
real ZIP. It is a **release checklist item**, and the shell smoke (AC-30) is its
executable form:

```
# scripts/smoke-instacart-cart-link.sh  (new, AC-30)
# 1. GET  /idp/v1/retailers?postal_code=<the store's real ZIP>&country_code=US
#    → assert a retailer_key exists for BJ's and for Sam's Club. RECORD both keys
#      in the spec's Files-changed notes; they become vendors.instacart_retailer_key.
# 2. If either is missing → leave that vendor's order_channel NULL
#    (⇒ resolves to 'extension' by R-3) and note it. DO NOT set the column.
# 3. Admin JWT + valid approvalId       → 200 { url }
# 4. Non-privileged JWT                 → 403, no upstream call
# 5. Cross-store approvalId             → 404
# 6. Forced upstream non-2xx (bad key)  → 502 { error: 'upstream_error' }, NOT ok:true
```

---

### §6 — Realtime impact

* **`public.notifications`** is already in the `supabase_realtime` publication
  (spec 120 Part 7). `order_ready` is a new row **type** on that table, not a
  membership change ⇒ the existing `notifications-{brandId}` channel replays it
  with **zero** client or publication work.
* **`public.order_approvals` is NOT added to the publication in v1** (R-5).
  Rationale: one admin, one device, and the Approve screen re-reads the row on
  mount and after every write. Adding it would buy a second-device echo at the
  cost of a publication change, a `useRealtimeSync` edit, and the deploy ritual
  below — not worth it for this feature's actual usage.
* **`store-{id}` / `brand-{id}`:** unchanged. `useRealtimeSync.ts` is **not
  modified by this spec**. The existing `eod_submissions` subscription on
  `store-{id}` already reloads on the submission that triggers the pipeline.

> **Publication gotcha — conditional, and currently NOT triggered.** Because no
> migration here touches `supabase_realtime` membership, **there is no
> `docker restart supabase_realtime_imr-inventory` step for spec 149.** Do not
> pad the deploy checklist with a no-op restart. **If** a follow-up (or a
> reviewer-requested change) adds `alter publication supabase_realtime add table
> public.order_approvals`, then the local container **must** be restarted with
> `docker restart supabase_realtime_imr-inventory` after `npm run dev:db` to
> re-snapshot the replication slot (project MEMORY
> `project_realtime_publication_gotcha`) — that is a **deploy/dev step, not a
> runtime concern**; prod's managed realtime re-snapshots automatically.

---

### §7 — `src/lib/db.ts` surface + frontend contract

#### 7.1 New `db.ts` helpers (all inside the existing `tracked()` chain)

```ts
export type OrderChannel = 'instacart' | 'webstaurant' | 'extension' | 'manual';
export type OrderApprovalStatus = 'pending' | 'approved' | 'ordered';

export interface OrderApprovalLine {
  itemId: string; itemName: string; qtyBase: number;
  caseQty: number; unit: string; costPerCountedUnit: number;
}
export interface OrderApproval {
  id: string; storeId: string; vendorId: string; businessDate: string;
  approvedBy: string | null; approvedAt: string;
  channel: OrderChannel; status: OrderApprovalStatus;
  lines: OrderApprovalLine[]; lineCount: number; estTotalCost: number;
  externalRef: string | null; externalRefExpiresAt: string | null;
  orderedAt: string | null; sourceSubmissionId: string | null;
}
export interface EodSubmissionContext {
  id: string; storeId: string; vendorId: string;
  businessDate: string; status: string; submittedAt: string | null;
}

/** RPC create_order_approval. Idempotent on (store, vendor, date). */
export async function createOrderApproval(params: {
  storeId: string; vendorId: string; businessDate: string;
  sourceSubmissionId?: string | null; lines: OrderApprovalLine[];
}): Promise<OrderApproval | null>;

/** PostgREST read, RLS-clipped. */
export async function fetchOrderApproval(params: {
  storeId: string; vendorId: string; businessDate: string;
}): Promise<OrderApproval | null>;

/** PostgREST update; the §1.2 trigger rejects illegal moves (P0001 → 400). */
export async function advanceOrderApproval(
  id: string,
  patch: { status?: OrderApprovalStatus; externalRef?: string | null;
           externalRefExpiresAt?: string | null; channel?: OrderChannel },
): Promise<OrderApproval | null>;

/** Deep-link context for an order_ready notification's source_id. */
export async function fetchEodSubmissionContext(
  submissionId: string,
): Promise<EodSubmissionContext | null>;

/** AC-25: goes through callEdgeFunction — NEVER a bare fetch. */
export async function mintInstacartCartLink(approvalId: string): Promise<
  | { ok: true; url: string; expiresAt: string | null; reused: boolean }
  | { ok: false; error: string; fallbackChannel?: OrderChannel; postalCode?: string | null }
>;
```

**snake_case → camelCase** via a new local `mapOrderApproval(row: any):
OrderApproval` beside the existing `mapItem`-style helpers, including a nested
`mapOrderApprovalLine` for the `lines` jsonb array
(`item_id→itemId`, `qty_base→qtyBase`, `case_qty→caseQty`,
`cost_per_counted_unit→costPerCountedUnit`; `external_ref_expires_at→
externalRefExpiresAt`; `business_date→businessDate`). Write path inverts in the
same file. `mapVendor` (`db.ts:2067`) gains `orderChannel: v.order_channel ?? null`
and `instacartRetailerKey: v.instacart_retailer_key ?? null`, with the matching
write-side entries at `db.ts:2099` and `db.ts:3362` (the `updates.x !== undefined`
idiom, empty string ⇒ `null`).

`mintInstacartCartLink` uses **`callEdgeFunction('instacart-cart-link',
{ approvalId })` from `src/lib/auth.ts`** (AC-25). `callEdgeFunction` collapses
non-2xx to a string `error`, which is enough for every branch here because the
error tokens are stable strings — but the `retailer_unavailable` branch needs
`fallbackChannel` from the body. **Therefore use the documented exception**:
`supabase.functions.invoke` the way `fetchBreadbotSales` (`db.ts:1143`) does, so
the structured body survives. Either is compliant; the invoke path is the one
this contract needs. **A bare `fetch` is a Critical.**

#### 7.2 New pure util — `src/utils/orderChannel.ts`

```ts
export type OrderChannel = 'instacart' | 'webstaurant' | 'extension' | 'manual';
export function resolveOrderChannel(v: {
  orderChannel?: string | null;
  instacartRetailerKey?: string | null;
  extensionOrdering: boolean;
}): OrderChannel;
```

The **display-side mirror** of `public.vendor_order_channel` (§1.1). Both
implement the same eight-row truth table; jest pins the TS side, pgTAP pins the
SQL side, and the table above is the shared fixture. Deliberate duplication (a
DB round-trip per vendor per render is not acceptable, and the edge-function
bundle can't import either) — flagged so review reads it as intent, not drift.

#### 7.3 Deep-link bridge — `src/lib/paletteAction.ts` (AC-6, guidance 4)

**Additive optional field only. Every existing caller keeps compiling and
behaving identically.**

```ts
interface PendingAction {
  section: string;
  selectedName: string | null;
  eodFocusItemId?: string;
  // Spec 149 — vendor/date-scoped Approve Order deep link. Set ONLY by the
  // phone notification sheet; consumed by PhoneApproveOrder.
  orderApproval?: { submissionId: string; storeId: string };
}
```

`InventoryDesktopLayout.tsx:246` currently defers `consume()` while
`eodFocusItemId` is in flight. Extend that condition symmetrically:

```ts
if (!pendingPaletteAction.eodFocusItemId && !pendingPaletteAction.orderApproval) {
  usePaletteAction.getState().consume();
}
```

Desktop/tablet never set `orderApproval`, so the desktop render tree is
**byte-unchanged** (AC-REG-2) — this is a guard-condition edit, not a render edit.

#### 7.4 Phone mount point (AC-REG-2, guard-after-hooks)

`ReorderSection.tsx:1453-1454` today:

```ts
const isPhone = useIsPhone();
if (isPhone) return <PhoneOrdering />;
```

becomes (the new hook goes **with the other hooks**, above the guard):

```ts
const pendingApproval = usePaletteAction((s) => s.pending?.orderApproval ?? null);
…
const isPhone = useIsPhone();
if (isPhone) return pendingApproval
  ? <PhoneApproveOrder request={pendingApproval} />
  : <PhoneOrdering />;
```

No new section id enters `InventoryDesktopLayout`'s dispatch (`:330`), so
desktop/tablet `ReorderSection` / `OrderingSection` render output is untouched.
`PhoneApproveOrder` calls `usePaletteAction.getState().consume()` on dismiss/back,
which returns the phone to `PhoneOrdering` — pin both directions in the `acReg`
suite.

#### 7.5 Notification sheet (AC-5, AC-6) — `PhoneNotifications.tsx`

* `sectionForNotification('order_ready') → 'Ordering'` (this map is **phone-only**;
  the desktop `NotificationBell` does not import it ⇒ desktop unchanged).
* `onRowPress`: when `n.type === 'order_ready'`, additionally pass
  `orderApproval: { submissionId: n.sourceId, storeId: n.storeId }`.
* Row title: `${typeLabel('order_ready')} · ${n.storeName}`; the **secondary line
  renders `n.body` (the vendor name) instead of `actorName`** for this type only —
  a two-branch ternary beside the existing `issue` branch.
* **AC-4 is a hard freeze:** `feedHasUnreadMissed` / `badgeBackgroundColor` /
  `badgeTextColor` / `rowDotColor` in `NotificationBell.tsx:42-64` are **reused,
  not forked and not edited**. `rowDotColor` already returns `C.accent` for every
  non-`missed_eod` type, so `order_ready` gets accent for free. A change to any of
  those four functions is a Critical.

#### 7.6 Vendor / store config surface (R-8 — flagged scope addition)

* `VendorFormDrawer`: an ORDER CHANNEL segmented control / select
  (`—` / instacart / webstaurant / extension / manual) and an INSTACART RETAILER
  KEY text input rendered **only** when the channel is `instacart`. Wire through
  the existing `updateVendor` path (`db.ts:3362` idiom).
* `StoreFormDrawer`: a POSTAL CODE text input.
* `Vendor` type gains `orderChannel?: OrderChannel | null` and
  `instacartRetailerKey?: string | null`; `Store` gains `postalCode?: string | null`.

Neither drawer is in the AC-REG-2 frozen tree. If the PM prefers to defer these,
the columns still ship and the owner sets them once via the Supabase MCP path —
say so explicitly and the frontend-developer drops §7.6.

#### 7.7 i18n (AC-5, AC-10, OQ-2) — all three of `en` / `es` / `zh-CN`

`chrome.submissionBell.type.order_ready`, plus a new
`section.approveOrder.*` group: `title`, `subtitle`, `totals`, `approveCta`,
`markOrderedCta`, `reopenLinkCta`, `dismissCta`, `emptyOrder`,
`alreadyOrdered`, `alreadyApproved`, `countChanged`, `switchStore`,
`retailerUnavailable`, `disclosureInstacart`, `disclosureCatalog`,
`linkFailed`. The i18n parity test must stay green.

**AC-10 disclosure copy (English source; translators mirror):**

* `instacart` → *"Estimate is your catalog cost — not the Instacart price.
  Instacart pricing can exceed in-club pricing, and delivery/service fees apply."*
* every other channel → *"Estimate is your catalog cost."*

Rendered as a first-class block directly above the primary button — not a
tooltip, not a `numberOfLines={1}` caption.

---

### §8 — Frontend store impact (`src/store/useStore.ts`)

New slice, alongside the existing reorder slice (`reorderPayload`,
`reorderEdits`, `setReorderEditQty`, `clearReorderEditsForVendor`,
`fillCartForVendor`):

```ts
// state
approvalContext: { submissionId: string; storeId: string; vendorId: string;
                   businessDate: string } | null;
approval: OrderApproval | null;
approvalLoading: boolean;
approvalError: string | null;
approvalBusy: boolean;

// actions
loadOrderApproval: (req: { submissionId: string; storeId: string }) => Promise<void>;
approveAndOrder: (vendor: ReorderVendor) => Promise<{ channel: OrderChannel; url?: string } | null>;
markOrderApprovalOrdered: () => Promise<void>;
clearOrderApproval: () => void;
```

**`loadOrderApproval`** — `fetchEodSubmissionContext(submissionId)` → set
`approvalContext` → `fetchOrderApproval({storeId, vendorId, businessDate})` (may
be null, that's the normal first-visit case). Pure read; errors land in
`approvalError` and render as an in-screen pane, **not** a toast (mirrors
`loadReorderSuggestions`, `useStore.ts:3305`).

**`approveAndOrder`** — sequential, **not optimistic** (a multi-step server
sequence with a user-visible external side effect; faking success is exactly the
spec-031/032 regression AC-15 forbids):

1. Build lines from the vendor's items with the **`reorderEdits` overlay**
   (`edits[itemId] ?? suggestedUnits`) and the **spec-104 ★ bridge**
   `costPerCountedUnit = it.costPerUnit × subUnitSize` — copy the shape from
   `fillCartForVendor` (`useStore.ts:2877-2895`) verbatim, do not re-derive.
2. `db.createOrderApproval(...)` → row. If `status !== 'pending'` ⇒ stop, set
   `approval`, let the screen render the already-actioned state (R-6 / AC-13).
3. Branch on `row.channel`:
   * `instacart` → `db.mintInstacartCartLink(row.id)`.
     * ok ⇒ open `url` (`Linking.openURL` native / `window.open(url,'_blank')`
       web) and re-read the approval (the edge function already advanced it to
       `approved` and wrote `external_ref`).
     * `retailer_unavailable` ⇒ **fall back** per §5.5 to `fallbackChannel`,
       `advanceOrderApproval(id,{channel:fallback})` (legal while `pending`), and
       recurse once into the fallback branch. Toast the OQ-2 copy (info, not error).
     * any other error ⇒ `notifyBackendError('Approve & order', e)`, leave the row
       at `pending` (**retriable**, AC-15), return null.
   * `webstaurant` → open `vendor.orderPageUrl` (existing spec-131 column; null ⇒
     error toast "no order page configured"), then
     `advanceOrderApproval(id,{status:'approved',externalRef:orderPageUrl})`.
     **No API call, no order transmitted** (AC-16).
   * `extension` → call the EXISTING `get().fillCartForVendor(vendor)` **unchanged**
     (AC-17 / AC-REG-3), then
     `advanceOrderApproval(id,{status:'approved',externalRef:poId})`.
   * `manual` → run the existing quick-order-text path
     (`buildPoQuickOrderText` + `sharePurchaseOrder`, the `PhoneOrdering`
     `OverflowSheet.runQuickOrder` shape — **no new export builders**, AC-18),
     then advance to `approved`.
4. `approvalBusy` guards the whole sequence ⇒ a double-tap is a client-side no-op,
   and the unique index is the server-side belt (guidance 6).

**`markOrderApprovalOrdered`** (OQ-3) — **this one IS optimistic-then-revert with
`notifyBackendError`**: flip `approval.status` to `'ordered'` locally, call
`db.advanceOrderApproval(id,{status:'ordered'})`, and on rejection restore the
previous row and `notifyBackendError('Mark ordered', e)`. The app **never**
infers `ordered` from link generation (AC-20) — the free IDP link API has no
order webhook.

**Store/date alignment.** The Approve screen reads the shared `reorderPayload`.
If `approvalContext.storeId !== currentStore.id`, the screen renders a
SWITCH TO &lt;store&gt; affordance (existing store-switch action) rather than
silently fetching another store's data — this also keeps the vendor-keyed
`reorderEdits` buffer unambiguous. If `businessDate !== reorderPayload.asOfDate`,
call the existing `loadReorderSuggestions(businessDate)`.

**AC-13 stale detection** (pure, jest-testable):
`stale = vendor absent from reorderPayload.vendors` (nothing to order)
`|| approval?.status === 'ordered'` (already actioned)
`|| (vendor.eodSubmittedAt && notification.createdAt && new Date(vendor.eodSubmittedAt) > new Date(notification.createdAt))` (count re-submitted after the ping).
Each maps to distinct copy and a disabled-or-relabeled primary button.

---

### §9 — Component reuse (AC-9, AC-REG-1, guidance 5)

`LineStepper` and `VendorOrderCard` are module-local in `PhoneOrdering.tsx`.
**Export them** (`export function LineStepper` / `export function
VendorOrderCard`) — the spec-143 precedent for `handleCsvExport` et al. — and
import them in `PhoneApproveOrder`. **Adding an export changes no rendered
output**, so `PhoneOrdering`'s existing suites stay green unmodified except for
additive store-mock fields (AC-REG-1). Copy-pasting either component is a
Should-fix at review.

Likewise reuse, do not fork: `applyReorderEdits` / `narrowReorderToVendor`
(`ReorderSection`), `isCaseRow` / `poCasesToBase` / `poOrderedToCases`
(`src/utils/poCaseDisplay.ts`), `formatMoney` / `formatQty`
(`src/utils/reorderExport.ts`), `ResponsiveSheet`.

`PhoneApproveOrder` may need a variant of `VendorOrderCard` without the FILL CART
footer (AC-11 forbids competing primaries). Prefer an **additive optional prop**
(e.g. `footer?: 'default' | 'none'`, defaulting to `'default'`) over a second
component — and the default path must render byte-identically for `PhoneOrdering`.

---

### §10 — Risks and tradeoffs

1. **CRITICAL / unresolved: the IDP contract is unverified (R-7, OQ-5).** No
   network tool this session. If `products_link` no longer accepts a retailer
   pin, or the retailers endpoint moved, the `instacart` channel is not
   buildable as specified. **The backend-developer's first action must be to open
   the live docs and reconcile §5.4/§5.5**; a mismatch bigger than field renames
   goes back to the PM, not around the design.
2. **OQ-2 cannot be closed in code.** Sam's Club Instacart coverage is
   market-dependent. The design's answer is the R-3 precedence (unkeyed vendor ⇒
   `extension`), the runtime 409 + client fallback, and the smoke script — all
   three pinned by tests. But whether Sam's actually resolves for this store's ZIP
   is an **operator verification** at enable time. Until it's verified, leave
   `order_channel` NULL on both BJ's and Sam's: they resolve to `extension` and
   the shipped behavior is **identical to today**. That is the safe default and I
   recommend shipping that way.
3. **Emit-predicate approximation (R-2, §3.3).** *Corrected post-review (S-2).*
   The predicate compares `par_level` against the **pre-count**
   `inventory_items.current_stock`, so it errs in BOTH directions: it under-fires
   when stock depleted through the day (⇒ degrades to the spec-120 `eod`
   notification) and can over-fire after an unrecorded receipt (⇒ an
   `order_ready` deep link whose Approve Order screen renders AC-13's empty
   state with the primary disabled). Wrong copy, never a wrong order. Accepted to
   keep the staff submit path fast; engine-exact emission is a follow-up spec and
   is not needed sooner.
4. **Migration ordering.** `20260801000000` → `000100` → `000200` is a hard
   dependency chain: `create_order_approval` calls `vendor_order_channel`, and the
   trigger swap calls both. Applying out of order fails loudly (function not
   found) — no silent half-state. Latest on disk is `20260726000000`, so all three
   slots are free.
5. **Prod apply + the `db-migrations-applied` gate.** `db push` lacks the prod
   password (project MEMORY): apply each migration body via the Supabase MCP
   `execute_sql`, then INSERT the exact versions `20260801000000`,
   `20260801000100`, `20260801000200` into
   `supabase_migrations.schema_migrations`, then verify — columns/table/index by
   **presence** (`information_schema`), functions by **normalized-md5**. The gate
   goes **red between commit and prod-apply**; that is expected and must be
   flagged, not "fixed". Do not push to `main` and walk away.
6. **RLS gap to watch.** The `auth_is_privileged()` conjunct on `order_approvals`
   is the only thing keeping a store-linked staff `user` from inserting approval
   rows. A future "let a shift lead pre-approve" spec must change the policy, not
   route around it with a DEFINER RPC.
7. **Edge-function cold start.** A first call after idle costs ~300-800 ms before
   the two upstream round-trips (retailers + products_link). Worst realistic case
   ≈ 2-3 s from tap to link. The screen must show a busy state on the primary
   button; the 10 s abort caps the tail.
8. **Performance on the 286 KB seed.** `eod_vendor_has_below_par` is one indexed
   join over `inventory_items × item_vendors` (the design's third join on
   `eod_entries` was inert and was dropped post-review — S-2) — sub-millisecond
   at this size and it replaces nothing existing.
   The approve screen adds no new heavy read (it reuses the already-loaded
   `reorderPayload`). `order_approvals` grows at ≤ vendors × days.
9. **Cross-store notification tap.** A super_admin can see another brand's
   `order_ready`. The SWITCH TO &lt;store&gt; interstitial (§8) is what keeps that
   from silently mixing two stores' data through the shared `reorderPayload` /
   vendor-keyed `reorderEdits`. Do not "simplify" it away.
10. **Edge-function role-gate parity.** `instacart-cart-link` is the eleventh
    function; omitting the `ADMIN_ROLES` set or `requireAdminCaller()` is the
    regression CLAUDE.md's spec-026/027 bullet names explicitly. It must be
    inline, not `_shared/`.
11. **No CI safety net beyond the two gates.** `test.yml` and
    `db-migrations-applied.yml` are the only gates; there is no smoke-test runner
    in CI, so AC-30's shell script is a **manual** step. Say so in the handoff
    rather than assuming it runs.
12. **`app.json` slug:** untouched. Nothing here adds a build identifier, store
    listing, or push cert (CLAUDE.md DO-NOT-AUTO-FIX). The spec-120/121 web-push
    path is reused as-is.

---

### §11 — Test map (which track owns which AC)

| Track | Covers |
|---|---|
| **pgTAP** `supabase/tests/order_ready_notifications.test.sql` | AC-1 (CHECK accepts `order_ready` + all eight legacy values), AC-2 (one row per `(store,vendor,date)`; re-run is a no-op via `(type,source_id)`), AC-3 (never both `eod` and `order_ready` for one submission — both branches). |
| **pgTAP** `supabase/tests/order_approvals.test.sql` | AC-19 (shape), AC-20 (`pending→ordered` rejected P0001; `approved→pending` rejected; immutability of `lines` once approved; `ordered_at` auto-set; **(G7/G8/G9)** the pending-row channel-escalation guard — no PATCH onto the `instacart` mint path, downward + server-resolved changes still legal), AC-21 (same-store privileged read/write ✓; other-store ✗; store-linked non-privileged ✗; delete always ✗), **(C7)** the S-3 lost-race replay, `permissive_policy_lint` still green with no allowlist row. |
| **pgTAP** `supabase/tests/vendor_order_channel.test.sql` | AC-14 — all eight rows of the §1.1 truth table, incl. the BJ's-stays-on-extension case. |
| **jest** | AC-28 in full: screen renders server lines; stepper case→base write-through + clamp ≥ 0; per-channel disclosure copy (AC-10); `resolveOrderChannel` truth table (TS mirror); channel→primary-action routing for all four channels; `retailer_unavailable` → extension fallback (OQ-2); `rowDotColor`/badge derivation for `order_ready` (AC-4); the `orderApproval` deep-link payload (AC-6); stale/empty/already-ordered (AC-13); `acReg` fork pin (phone→new screen, desktop+tablet→unchanged tree, and `PhoneOrdering` unchanged when no `orderApproval` is pending). |
| **jest** `src/utils/pushNotificationCopy.test.ts` | AC-7 — the `submission-push-fanout` push copy, via the byte-identical TS mirror of `derivePushCopy` (see §4): `order_ready` title/body, the "must not say submitted" rule, and the spec-120/121/126 branches it must not disturb. Added in the post-review fix round. |
| **shell smoke** `scripts/smoke-instacart-cart-link.sh` | AC-30 + the OQ-2 retailer probe (§5.5). Manual — not wired into CI. |

## Handoff

next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec's `## Backend design` section.
  Backend owns the three migrations (`20260801000000_vendor_order_channel`,
  `20260801000100_order_approvals`, `20260801000200_order_ready_notification_type`),
  the `submission-push-fanout` `order_ready` branch, the new JWT-protected
  `instacart-cart-link` edge function + its `config.toml` pin, the three pgTAP
  suites, and the AC-30 smoke script — and MUST reconcile §5.4/§5.5 against the
  live Instacart Developer Platform docs before writing the upstream call (every
  IDP field is marked MUST-VERIFY; escalate to the PM if the contract has moved
  beyond field renames). Frontend owns `src/lib/db.ts` (§7.1 helpers + mappers),
  `src/utils/orderChannel.ts`, the additive `usePaletteAction.orderApproval` field
  + the `InventoryDesktopLayout` consume-deferral, the `PhoneApproveOrder` screen
  mounted through `ReorderSection`'s guard-after-hooks phone fork, the
  `PhoneOrdering` component exports (additive — no render change), the
  `PhoneNotifications` `order_ready` row + deep link, the `useStore` approval
  slice, the i18n keys in all three catalogs, and the §7.6 vendor/store config
  fields. Respect every AC-REG freeze: specs 131/132 RPCs and the extension build
  are frozen, desktop/tablet render output is byte-unchanged, the four
  `NotificationBell` badge helpers are reused not forked, and
  `src/screens/staff/` is untouched. No publication change ⇒ no
  `docker restart supabase_realtime_imr-inventory`. After implementation, set
  Status: READY_FOR_REVIEW and list files changed under `## Files changed`.
payload_paths:
  - specs/149-eod-approve-order-pipeline.md

---

<details>
<summary>Original PM handoff (superseded — kept for provenance)</summary>

next_agent: backend-architect
prompt: Design the contract for this spec. Read the acceptance criteria and the
  "Design guidance for the architect" + "Open questions (non-blocking)" sections
  — especially OQ-2 (verify a live Instacart `retailer_key` resolves for the
  store's ZIP for Sam's Club and BJ's, and pin the extension-channel fallback)
  and OQ-5 (pin the `products_link` request shape against the CURRENT Instacart
  Developer Platform docs, not memory). Decide the `order_approvals` schema +
  status guard + per-store RLS, the vendor channel field and its precedence over
  `vendors.extension_ordering`, the `order_ready` emit/dedupe path and whether it
  replaces the spec-120 `eod` notification (OQ-1), the deep-link bridge
  extension, and the `instacart-cart-link` edge-function contract (JWT +
  `requireAdminCaller` + caller-store check + secret handling). Keep specs
  131/132 and the desktop/tablet render byte-frozen per the AC-REG group. Produce
  the design doc and set Status: READY_FOR_BUILD.
payload_paths:
  - specs/149-eod-approve-order-pipeline.md

</details>

---

## Blocker RESOLVED — gate status at handoff

The `submission_notifications.test.sql` arm-(5) failure flagged by the frontend
half is **fixed**. The diagnosis was correct: arm (5) picked
`(select id from public.vendors limit 1)` against the seeded Towson store, that
vendor has below-par Towson inventory, and spec 149's `tg_notify_eod_submission`
branch therefore correctly emits `order_ready` instead of `eod` (AC-3 working as
designed). The arm was pinning behavior this spec deliberately changes.

Fix: arm (5) is split into **(5a)** and **(5b)**, each against a **dedicated
fixture vendor** rather than seed state, so neither branch can drift with the
seed again — (5a) a vendor with no `item_vendors` links ⇒ exactly one `eod`;
(5b) a vendor with one below-par linked item ⇒ exactly one `order_ready` and
**zero** `eod`. `plan(11)` → `plan(12)`. Side effect worth noting: this also
restored arm (10)'s meaning — the dedupe arm re-emits `eod` for the arm-(5a)
source, which now genuinely exists to conflict against (with the arm red, arm 10
was inserting into an empty slot and asserting nothing).

**All gates green on this branch:**

| Gate | Result |
|---|---|
| `npm run test:db` (pgTAP) | **79/79 files pass** |
| `npx jest` | **178 suites / 1739 tests pass** |
| `npx tsc --noEmit` | clean |
| `npm run typecheck:test` | clean |

Two things that are NOT gate failures but MUST be carried into review:

1. **Prod migrations are NOT applied** — local-only by instruction. The three
   `20260801*` versions must be applied via the Supabase MCP `execute_sql` path
   with the exact versions inserted into `supabase_migrations.schema_migrations`
   (project MEMORY; `db push` lacks the prod password).
   `db-migrations-applied.yml` will be **red between commit and prod-apply** —
   expected per §10.5, flag it, do not "fix" it.
2. **An open PM decision on the Instacart channel** — see "IDP contract
   reconciliation" below. It does **not** block ship, because the recommended
   shipping posture (§10.2) leaves the channel dark.

## IDP contract reconciliation (R-7 / OQ-5) — one MUST-VERIFY escalation

Reconciled against the live docs on 2026-08-01 (all pages "Last updated on
May 14, 2026"):
`docs.instacart.com/developer_platform_api/api/products/create_shopping_list_page`,
`…/api/retailers/get_nearby_retailers`, `…/api/units_of_measurement`,
`…/api/changelog`. The full finding is recorded in the header comment of
`supabase/functions/instacart-cart-link/index.ts`.

**Confirmed unchanged from §5.4/§5.5:** the `POST /idp/v1/products/products_link`
endpoint and its headers; `title` / `link_type` / `expires_in` (days, max 365) /
`instructions[]` / `line_items[]` / `landing_page_configuration`; the
`{ products_link_url }` response; the entire §5.5 retailers probe
(`GET /idp/v1/retailers?postal_code=&country_code=` ⇒
`{ retailers: [{ retailer_key, name, retailer_logo_url }] }`); and `each` as a
valid unit.

**Two field-level drifts — handled in code, no escalation needed:**

- `line_items[].quantity` / `.unit` are **deprecated** (changelog 2026-03-18) in
  favor of `line_items[].line_item_measurements: [{ quantity, unit }]`. The
  function sends the current shape and not the deprecated fields.
- `landing_page_configuration.enable_pantry_items` is documented as
  **`recipe` link_type only**; §5.4 set it `true` on a `shopping_list`. Omitted.
  `landing_page_configuration` is now sent only when the optional
  `INSTACART_PARTNER_LINKBACK_URL` secret is set.

**ESCALATED — §5.4's explicit STOP condition is met:**

> **There is no retailer-pinning field on `products_link` in the current API.**

No `retailer_key` / `retailer_id` / preferred-retailer parameter exists in the
shopping-list request body, in `landing_page_configuration`, or on the recipe
endpoint. The Shopping list page concept doc states plainly: *"On the shopping
list page, the user selects their preferred store."* The changelog's only
preferred-retailer entry (2025-04-17, recipe pages) is no longer reflected in the
reference. §5.4 says: *"If the docs no longer support pinning a retailer on
`products_link`, STOP and surface to the PM rather than shipping a link that
lands on a retailer picker."*

- **Product consequence:** APPROVE & ORDER on an `instacart` vendor opens a
  pre-filled shopping list on which the admin **picks the retailer** (one extra
  tap, and the wrong retailer is pickable). The PM summary's "the phone opens an
  Instacart cart that is already filled with your items" still holds for the
  items; the *store* is no longer pinned. **This is a PM call, not an
  architecture call.**
- **Why it does not block ship:** the design's own §10.2 recommends leaving
  `vendors.order_channel` NULL on BJ's and Sam's, so R-3 resolves both to
  `extension` and shipped behavior is **identical to today**. Nothing reaches
  this function until an operator explicitly opts a vendor in. The channel is
  dark on ship.
- **What `instacart_retailer_key` still does:** it is the key the §5.5
  availability probe must find for the store's ZIP before a link is minted at
  all — the 409 `retailer_unavailable` + `fallbackChannel` path is fully built
  and verified. So the column is not vestigial; it just cannot pin the landing
  page.
- **Everything else in §5.4/§5.5 is built as designed.** If the PM accepts the
  retailer picker, the code ships as-is. If not, the `instacart` channel needs a
  different mechanism and that is a new spec — no code here needs to be undone.

## Files changed

### Frontend (this half)

New:

- `src/utils/orderChannel.ts` — the pure `resolveOrderChannel` + `OrderChannel`
  union + `isOrderChannel` guard; TS mirror of `public.vendor_order_channel`
  (§7.2, the eight-row R-3 truth table).
- `src/utils/orderChannel.test.ts` — all eight truth-table rows + the
  whitespace-key and unknown-literal edges (AC-14).
- `src/screens/cmd/sections/phone/PhoneApproveOrder.tsx` — the phone Approve
  Order review screen, plus the exported pure helpers `approveOrderState`
  (AC-13) and `disclosureKeyForChannel` (AC-10).
- `src/screens/cmd/sections/phone/__tests__/PhoneApproveOrder.test.tsx` — render,
  stepper write-through, per-channel disclosure, the four AC-13 states, the
  cross-store interstitial, dismiss→consume.
- `src/screens/cmd/sections/phone/__tests__/PhoneApproveOrder.acReg.test.tsx` —
  the fork pin, both directions (AC-REG-1 / AC-REG-2 / AC-6).
- `src/store/useStore.approveOrder.spec149.test.ts` — the ★ cost bridge, the
  four channel routes, the OQ-2 fallback, failure/replay/double-tap, and
  `markOrderApprovalOrdered`'s optimistic-then-revert.
- `src/lib/db.mintInstacartCartLink.spec149.test.ts` — the client side of the
  edge-function contract, incl. the structured-409 recovery (see the deviation
  note below).

Modified:

- `src/lib/db.ts` — §7.1 surface: `OrderApproval` / `OrderApprovalLine` /
  `OrderApprovalStatus` / `EodSubmissionContext` types, `mapOrderApproval` +
  `mapOrderApprovalLine` + the inverse write mapper, `createOrderApproval`,
  `fetchOrderApproval`, `advanceOrderApproval`, `fetchEodSubmissionContext`,
  `mintInstacartCartLink`; `stores.postal_code` and
  `vendors.order_channel` / `instacart_retailer_key` read + write mappings.
- `src/types/index.ts` — `Vendor.orderChannel` / `.instacartRetailerKey`,
  `Store.postalCode`, `SubmissionNotificationType |= 'order_ready'`, and the
  `OrderChannel` re-export.
- `src/lib/paletteAction.ts` — the additive optional
  `PendingAction.orderApproval` field (AC-6).
- `src/screens/cmd/InventoryDesktopLayout.tsx` — the symmetric `consume()`
  deferral (guard-condition edit only; no render change).
- `src/screens/cmd/sections/ReorderSection.tsx` — the `pendingApproval` hook
  (with the other hooks) + the phone fork through the existing `isPhone` guard.
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx` — `LineStepper` and
  `VendorOrderCard` EXPORTED (not forked) + the additive `footer` prop
  (defaults to `'default'`, so PhoneOrdering renders unchanged).
- `src/screens/cmd/sections/phone/PhoneNotifications.tsx` — `order_ready` →
  `Ordering` in `sectionForNotification`, the `orderApproval` deep-link payload,
  and the vendor-on-the-secondary-line row copy. The four `NotificationBell`
  badge helpers are reused untouched (AC-4).
- `src/components/cmd/VendorFormDrawer.tsx` — ORDER CHANNEL segmented control +
  the conditional INSTACART RETAILER KEY field; `SegmentField` gained an
  additive `testIDPrefix` (defaulting to the historical literal).
- `src/components/cmd/StoreFormDrawer.tsx` — the POSTAL CODE input.
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` —
  `chrome.submissionBell.type.order_ready`, the `section.approveOrder.*` group,
  and the `section.vendors.orderChannel*` / `instacartRetailerKey*` keys. Parity
  test green.
- `src/screens/cmd/sections/phone/__tests__/PhoneNotifications.test.tsx` —
  `order_ready` routing, the AC-4 badge/dot pins, and the deep-link payload.
- `src/lib/db.updateStore.test.ts` — the store projection now carries the
  additive `postalCode: null`.

### Backend (other half)

**Migrations** — all three strictly additive; NO `supabase_realtime` publication
change anywhere (R-5) ⇒ **no `docker restart supabase_realtime_imr-inventory`
step**. Applied and exercised locally only; prod apply is via the Supabase MCP
path (see the gate note above). Hard dependency chain, apply in order:

- `supabase/migrations/20260801000000_vendor_order_channel.sql` — new
  `vendors.order_channel` (+ `vendors_order_channel_check`),
  `vendors.instacart_retailer_key`, `stores.postal_code`, and the
  `public.vendor_order_channel(uuid)` SECURITY INVOKER helper (the SQL truth for
  the R-3 precedence). Zero policy change; column-agnostic RLS inheritance.
- `supabase/migrations/20260801000100_order_approvals.sql` — the
  `public.order_approvals` table, the `(store_id, vendor_id, business_date)`
  UNIQUE idempotency index, the store-scoped feed index, the
  `tg_order_approvals_guard()` BEFORE UPDATE status/immutability guard (AC-20,
  **incl. the post-review channel-escalation rule while `pending`**), the three
  `privileged_store_*_order_approvals` policies with **no DELETE policy**
  (append-only by default-deny), and
  `public.create_order_approval(uuid, uuid, date, jsonb, uuid)` — the only INSERT
  path (server-resolved channel, AC-27 line validation, R-6 no-overwrite replay,
  **post-review `unique_violation` race handler**).
- `supabase/migrations/20260801000200_order_ready_notification_type.sql` —
  `notifications_type_check` widened with `order_ready` (all eight legacy values
  preserved), `public.eod_vendor_has_below_par(...)` (the R-2 cheap predicate —
  **post-review: the inert `eod_entries` LEFT JOIN dropped, comment corrected**),
  `public.emit_order_ready(...)`, and the branched
  `public.tg_notify_eod_submission()`. The `notify_eod_submission` **trigger
  itself is unchanged**.

**Edge functions**

- `supabase/functions/instacart-cart-link/index.ts` (**new**) — JWT-protected
  mint. Inline `ADMIN_ROLES` + `requireAdminCaller()` (AC-23), caller-token
  client for every request-path read so RLS is the cross-store gate (AC-24),
  `INSTACART_IDP_API_KEY` held server-side and never echoed/logged (AC-22),
  AC-27 line validation before any upstream call, the §5.5 retailer-availability
  probe with 409 `retailer_unavailable` + `fallbackChannel`, live-link reuse,
  10 s `AbortController`, correlation-id logging, and the full §5.3 error table.
  Header comment records the IDP reconciliation + the escalated retailer-pin
  finding.
- `supabase/functions/submission-push-fanout/index.ts` (**modified**) —
  `TYPE_LABEL.order_ready` plus the `order_ready` branch: title "Order ready to
  approve", body `"<store> · <vendor>"` from `notif.body`. No "submitted"
  (AC-7). Post-review: the four title/body branches are now the exported pure
  `derivePushCopy(notif)` and the handler calls it, so the jest mirror can cover
  AC-7 (§4). Recipients, brand scoping, actor exclusion, VAPID path and the
  `verify_jwt = false` posture are untouched.
- `supabase/config.toml` (**modified**) — the `[functions.instacart-cart-link]`
  `verify_jwt = true` pin, with the send-po-email-style rationale comment.

**pgTAP (spec 022 Track 2)**

- `supabase/tests/vendor_order_channel.test.sql` (**new**, 11 arms) — all eight
  R-3 truth-table rows + the blank-key edge + NULL for an unknown vendor + the
  CHECK bound (AC-14).
- `supabase/tests/order_approvals.test.sql` (**new**, 24 arms) — shape, the
  idempotency spine, the create RPC (happy/replay/retry/R-6/AC-27/P0002 **+ (C7)
  the lost-race replay**), the six AC-20 guard cases **+ (G7)/(G8)/(G9) the
  channel-escalation guard**, the four AC-21 RLS cases, and the
  trivially-wide-policy lint (AC-19/20/21/27).
- `supabase/tests/order_ready_notifications.test.sql` (**new**, 10 arms) — the
  CHECK widening in all three directions, both sides of the exclusive emit branch,
  the denormalized `body`/`store_name`/`actor_*`, and `(type, source_id)` dedupe
  (AC-1/2/3). Header note corrected for the dropped `eod_entries` join (S-2).
- `supabase/tests/submission_notifications.test.sql` (**modified**) — arm (5)
  split into (5a)/(5b) against dedicated fixture vendors; `plan(11)` → `plan(12)`.
  See "Blocker RESOLVED" above.

**jest (spec 022 Track 1) — backend-owned**

- `src/utils/pushNotificationCopy.ts` (**new**) — the byte-identical TS mirror of
  `submission-push-fanout`'s `TYPE_LABEL` / `ISSUE_CATEGORY_LABEL` /
  `derivePushCopy`. Not imported by anything at runtime; the escapeHtml-mirror
  pattern (CLAUDE.md, spec 028).
- `src/utils/pushNotificationCopy.test.ts` (**new**, 9 tests) — AC-7 coverage
  (see §4 and the fix-round record below).

**Shell smoke (spec 022 Track 3)**

- `scripts/smoke-instacart-cart-link.sh` (**new**, executable) — AC-30 round trip
  (preflight, 401 no-auth, 200 admin mint, 403 non-privileged, 404 cross-store,
  502-not-fake-success) plus the OQ-2 operator retailer probe for BJ's / Sam's at
  the store's real ZIP. **Manual — not wired into CI** (§10.11).

### Backend deviations / notes for review

1. **Trigger-body exception envelope (addition beyond the literal design).**
   §1.3.3 states the invariant "a notify failure can never roll back a staff
   submit", but the two new predicate calls (`vendor_order_channel`,
   `eod_vendor_has_below_par`) run in `tg_notify_eod_submission`'s body, OUTSIDE
   the emitters' own envelopes. The body is therefore wrapped in the same
   `begin/exception when others → raise warning` envelope so the invariant holds
   on a surface AC-REG-5 freezes. Contract-neutral; called out so the drift
   review reads it as intent.
2. **`INSTACART_IDP_BASE_URL` env override (addition).** The docs publish a
   development host (`connect.dev.instacart.tools`) for pre-production keys, and
   AC-30 requires exercising the function "against a sandbox/stub upstream". The
   base URL is an optional env var defaulting to `https://connect.instacart.com`.
   Same for the optional `INSTACART_PARTNER_LINKBACK_URL`.
3. **Secret check ordering (deliberate).** The `INSTACART_IDP_API_KEY` presence
   check sits immediately before the FIRST outbound call, not at the top of the
   handler. A misconfigured deployment must not turn the AC-24 cross-store 404
   (or the 409s) into a generic 500 — the AC-24 smoke has to be exercisable
   without a live key. Verified both orderings locally.
4. **`emit_order_ready`'s `p_vendor_id` is unused** in the body — the vendor
   *name* is what gets denormalized. Kept for the design's published signature
   and call-site symmetry with `emit_missed_count`; commented as such.
5. **`eod_vendor_has_below_par`'s `LEFT JOIN public.eod_entries` was inert —
   RESOLVED in the post-review fix round (architect S-2).** Flagged at
   implementation time as "harmless"; the architect's ruling corrected that:
   with the join inert the predicate reads the **pre-count** `current_stock`, so
   §3.3's "never a false positive" was false in the unrecorded-receipt direction.
   The join is now **dropped** (zero behavior change — it never matched on the
   real path), `p_submission_id` is retained for signature stability, and §3.3 /
   risk 3 / the migration comment / the pgTAP header now state the two-directional
   approximation and name AC-13's empty state as the backstop. No async job: the
   architect ruled it is not needed sooner.
6. **End-to-end verification performed** against the local stack with a stubbed
   IDP upstream: happy-path mint (payload byte-checked against the verified
   contract — `line_item_measurements`, no deprecated fields, no
   `enable_pantry_items`, 24 base ÷ case 6 ⇒ `quantity: 4` with case-naming
   `display_text`), live-link reuse with no second upstream call, re-mint after
   expiry, write-back to `approved` + `external_ref`, 403 non-privileged, 404
   cross-brand, 409 `wrong_channel` / `already_ordered` /
   `retailer_unavailable` (both the null-ZIP and the key-not-in-ZIP paths, with
   `fallbackChannel`), 400 invalid lines, 502 on retailers-503 / mint-500 /
   2xx-without-`products_link_url`, and 504 after exactly 10 s on a hung
   upstream. Every failed mint left the row `pending` and retriable (AC-15).
   Logs were grepped: neither the API key nor the minted URL appears in any log
   line. All local fixtures were removed afterward (`order_approvals` back to 0
   rows, no `postal_code` set on any store).

### Frontend deviations / notes for review

1. **`db.ts` structured-409 recovery (fixed during implementation).** Design
   §7.1 says to use `supabase.functions.invoke` so `fallbackChannel` survives.
   `functions.invoke` throws `FunctionsHttpError` whose `.context` is the **raw
   `Response`**, not a parsed body, so the body must be read via
   `await ctx.json()`. The first cut read `ctx.body` (a `ReadableStream` —
   truthy, but useless), which type-checked and passed a db-mocked store test
   while silently degrading the OQ-2 re-route to a raw error toast in
   production. Fixed, and pinned by `db.mintInstacartCartLink.spec149.test.ts`
   plus a live round trip against the local edge function (real 409 →
   `fallbackChannel: 'manual'` recovered). **`fetchBreadbotSales`
   (`db.ts`) has the same latent `ctx?.error` assumption** — pre-existing, out
   of scope here, flagged as a follow-up.
2. **`stores.postal_code` has no EDIT surface.** §7.6 scoped the field to
   `StoreFormDrawer`, which is create-only (`StoresTab` offers only a status
   toggle). Existing stores therefore cannot get a ZIP through the UI, which is
   the hand-SQL situation R-8 was written to avoid. `db.updateStore` accepts
   `postalCode` so the write path is ready; a follow-up needs a store EDIT
   drawer. Until then the Instacart channel is unavailable for existing stores
   and falls back per R-4 — the safe default risk 2 recommends shipping with.
3. **`manual`-channel share import is dynamic.** §8 puts the quick-order-text
   path inside `approveAndOrder`, but `sharePurchaseOrder` lives under
   `src/screens/cmd/lib/` and pulls in `expo-sharing`. It is loaded via
   `await import(...)` at the call site — the same idiom `deleteProfile` already
   uses — so the store's static module graph is unchanged and no existing suite
   picks up a new native dependency.
4. **Toast copy in the store uses `t(get().locale, …)`.** The OQ-2 fallback
   notice is an i18n key (`section.approveOrder.retailerUnavailable`), so the
   store imports the pure `t` rather than hardcoding English like the older
   toasts in that file.
5. **Browser verification was not possible** — no preview/browser tooling was
   exposed in the implementing session. Compensating evidence: the production
   web build (`npx expo export --platform web`, the Vercel command) succeeds and
   the emitted bundle contains the new screen, disclosure copy, and
   `order_ready` handling; and the db.ts contract was exercised **live** against
   the local Supabase stack (vendor/store projections, `vendor_order_channel`
   SQL-vs-TS agreement, `create_order_approval` + idempotent replay,
   `pending→approved→ordered`, the refused `approved→pending` transition, the
   default-denied DELETE, and the real edge-function 409). A human should still
   click through the phone tier at <768px in both themes before ship.

---

## Review fix round — frontend (2026-08-02)

Three items from the reviewer reports in
`specs/149-eod-approve-order-pipeline/reviews/`. Backend items (security Medium
2, the Low findings, AC-7 coverage) ran in a parallel backend fix round and are
**not** touched here — nothing under `supabase/` or `scripts/` was modified by
this round.

### 1. code-reviewer Should-fix — `openInNewContext` had no `.catch`

Resolved by the **extraction option** the finding offered, not by copying the
`.catch` into the second site: the two near-duplicates
(`useStore.openExternalOrderUrl` and `PhoneApproveOrder.openInNewContext`) now
both delegate to one shared `src/utils/openExternalUrl.ts`, so they cannot drift
on error handling again. `notifyBackendError` is additively `export`ed from
`useStore.ts` (every in-file caller unchanged) and passed in as the reporter, so
the util itself stays toast-free like the rest of `src/utils/`. Verified deduped
in the shipped web bundle: the refusal string and `noopener,noreferrer` each
appear exactly once in `AppEntry-*.js`.

### 2. security-auditor Medium 1 — no scheme allowlist on operator-editable URLs

`openExternalUrl` gates on `/^https?:\/\/\S/i` (after `trim()`) before anything
reaches `window.open` / `Linking.openURL`, covering BOTH sources the finding
names — `vendors.order_page_url` (webstaurant channel) and
`order_approvals.external_ref` (RE-OPEN LINK). A refusal returns `false` and
toasts through `notifyBackendError`; nothing opens. The webstaurant branch of
`approveAndOrder` now branches on that `false` and **refuses instead of
half-approving**, i.e. the same posture as the existing "no order page
configured" path — no approval row is advanced for a page that never opened.
`noopener,noreferrer` is retained on the web branch.

Jest pins (the finding's requested `javascript:` rejection and more):
`src/utils/openExternalUrl.test.ts` (27 cases — `javascript:` in three
spellings, `data:`, `file:`, `tel:`, `intent:`, a custom app scheme,
protocol-relative, scheme-less, non-string; plus the web `noopener` shape, the
trimmed native hand-off, and the native-rejection report) and a store-level arm
in `useStore.approveOrder.spec149.test.ts` ("webstaurant with a `javascript:`
order page opens nothing and does not approve").

**Not done (deliberately, out of the brief's scope):** the auditor's "ideally
also reject non-http(s) in `advanceOrderApproval`'s `externalRef` mapping and in
`updateVendor`'s `order_page_url`" write-side validation. The open-side gate is
the exploitable boundary and is now closed; a write-side reject is a separate
(cheap) follow-up.

### 3. test-engineer Should-fixes 2 + 3 — untested config UI and db.ts mappers

- `VendorFormDrawer.test.tsx` gained a 7-case spec-149 block: all five ORDER
  CHANNEL options render under their own `vendor-order-channel-*` testID prefix
  (no collision with the order-unit / import-format segments), the R-3 safe
  default is `auto`, the INSTACART RETAILER KEY field is revealed only by the
  `instacart` choice, `auto` persists `orderChannel: null`, the key is trimmed,
  the EDIT round trip prefills and writes back, and an unrecognized stored
  literal falls back to `auto`.
- `StoreFormDrawer.test.tsx` is **new** (the drawer had no test file at all):
  blank ⇒ `postalCode: null` (not `''`), whitespace-only ⇒ `null`, filled ⇒
  trimmed, the field never gates the required-field counter, it resets between
  opens, and `address` is never parsed for the ZIP.
- `db.orderApprovalMappers.spec149.test.ts` is **new** — direct coverage of the
  snake ⇄ camel layer through its public callers with a stubbed supabase client:
  every `mapOrderApproval` rename incl. `external_ref_expires_at` /
  `source_submission_id`, PostgREST numeric-as-string coercion, the
  unknown-channel ⇒ `manual` and unknown-status ⇒ `pending` degradations, the
  null-lines tolerance, `toOrderApprovalLineRow`'s RPC payload (and that no
  `p_channel` is ever sent), the bare-vs-array composite response,
  `advanceOrderApproval`'s UPDATE body incl. omit-key-to-skip / empty-patch
  no-op / blank-ref-clears-to-NULL, `fetchEodSubmissionContext`'s date clip, and
  `mapVendor`'s two new columns incl. the pre-migration-row degradation.

### Gates

```
npx tsc --noEmit          → clean
npm run typecheck:test    → clean
npx jest                  → 181 suites / 1800 tests passed (was 178 / 1739)
npx expo export --platform web (the Vercel build command) → succeeds
```

**Browser verification was again not possible** — no preview/browser tooling is
exposed in this session (same limitation as the original implementing session,
deviation note 5 above). Compensating evidence: the production web export
succeeds and the emitted bundle carries the new helper exactly once; the two
drawer surfaces are exercised through `@testing-library/react-native` renders
(golden path AND edge cases: blank/whitespace ZIP, unrecognized channel literal,
channel→auto clear) rather than typecheck alone. A human should still click the
phone tier at <768px in both themes before ship.

### Files changed (this round)

New:

- `src/utils/openExternalUrl.ts` — the shared cross-platform external-link
  opener: http(s) scheme allowlist, `noopener,noreferrer` on web, native
  `.catch` → the caller's reporter.
- `src/utils/openExternalUrl.test.ts`
- `src/components/cmd/StoreFormDrawer.test.tsx`
- `src/lib/db.orderApprovalMappers.spec149.test.ts`

Modified:

- `src/store/useStore.ts` — `openExternalOrderUrl` delegates to the shared util
  and returns a boolean; the webstaurant branch refuses on a rejected URL;
  `notifyBackendError` additively `export`ed; unused `Linking` import dropped.
- `src/screens/cmd/sections/phone/PhoneApproveOrder.tsx` — `openInNewContext`
  delegates to the shared util with `notifyBackendError`; unused
  `Platform`/`Linking` imports dropped.
- `src/store/useStore.approveOrder.spec149.test.ts` — the `javascript:`
  order-page arm.
- `src/components/cmd/VendorFormDrawer.test.tsx` — the spec-149 channel /
  retailer-key block.
- `specs/149-eod-approve-order-pipeline.md` — this section.

---

## Review fix round — backend (2026-08-02)

Four items from the reviewer reports in
`specs/149-eod-approve-order-pipeline/reviews/`. The frontend items (code-reviewer
Should-fix, security Medium 1, test-engineer Should-fixes 2/3) ran in a parallel
frontend fix round — nothing under `src/store/`, `src/screens/`, `src/lib/`,
`src/components/` or `src/i18n/` was modified by this round.

### 1. test-engineer Critical — AC-7 (`order_ready` push copy) had zero coverage

**Track chosen: jest, via a source-level mirror.** A shell smoke was evaluated and
rejected as dishonest for this criterion: `submission-push-fanout` answers with
`{ ok, recipients, pushed }` only, and the copy itself travels inside an
*encrypted* web-push payload, so no HTTP-level assertion can observe the title or
body — a smoke could prove the branch does not crash, never that it says the right
thing. A Deno test harness would be a fourth framework (spec 022 forbids that
without PM sign-off).

So the four title/body branches were extracted, unchanged, into an exported pure
`derivePushCopy(notif)` inside the edge function, and mirrored byte-for-byte at
`src/utils/pushNotificationCopy.ts` — the pattern CLAUDE.md already documents for
Deno-side pure logic (`src/utils/escapeHtml.ts` ↔ the `send-*-email` functions):
the mirror is **not imported** by the function (different bundle; `_shared/` is
invisible drift surface because the CLI deploys one function at a time) and
identity is a code-review check. Verified byte-identical in-session by diffing the
two blocks programmatically.

`src/utils/pushNotificationCopy.test.ts` (9 tests) pins the `order_ready` title
and body, the "neither title nor body contains 'submitted'" rule, the
missing-vendor / missing-store separator behavior, and — as a side effect — the
`isMiss` (spec 121) and `isIssue` (spec 126) branches the test-engineer noted had
*also* never been covered. The handler is otherwise untouched: recipients, brand
scoping, actor exclusion, the VAPID path and `verify_jwt = false` are unchanged.

Residual honesty note: this covers the *derivation*, not the wire. The wire path
was smoke-checked live only as far as the local stack allows — the function boots
and the cron-bearer gate passes (403 on a bogus bearer, past-403 on the real one),
but it then returns `500 Missing: VAPID_PUBLIC/VAPID_PRIVATE` because this
sandbox has no VAPID keypair. That is a pre-existing local-env limit, identical
for the spec-120/121/126 branches.

### 2. security-auditor Medium 2 — channel escalation on a `pending` row

`tg_order_approvals_guard()` now refuses a `pending`-row `channel` change unless
the new value is **downward** (`'extension'`/`'manual'` — the only values the
shipped OQ-2 fallback writes) **or** equals the server-resolved
`public.vendor_order_channel(new.vendor_id)`. `P0001` ⇒ HTTP 400.

The auditor offered both forms; both are implemented because pure-downward alone
would have introduced a **wedge**: if a vendor's config changes to `instacart`
while a row is pending, `create_order_approval`'s retry path re-writes the
server-resolved channel through this same trigger, and refusing it would strand
that `(store, vendor, date)` key forever — there is no DELETE policy. The
server-resolved arm is not an escape hatch: it admits exactly the value a fresh
`create_order_approval` would have written. The vendor lookup only runs when the
channel actually changed *and* the new value is outside the downward set, so the
ordinary status advance and `external_ref` write pay nothing.

pgTAP: `order_approvals.test.sql` (G7) refusal on the ext-vendor row, (G8)
downward move allowed, (G9) down-then-back-to-server-resolved allowed on a vendor
that genuinely resolves to `instacart` (the anti-wedge pin). `plan(20) → plan(24)`.

### 3. backend-architect S-3 — `create_order_approval` select-then-insert race

The INSERT is wrapped in `exception when unique_violation then` — re-read the
winner's row and fall through the **same** retry / R-6 logic, so a lost race is
indistinguishable from a plain replay (design guidance 6's "safe to repeat"). If
the re-read finds nothing the exception is **re-raised**: that means some other
constraint fired, and swallowing it would hide a real fault.

pgTAP arm (C7) reproduces the window without a second session — impossible in a
hermetic single-file test, since a second connection can neither see nor avoid
deadlocking against our uncommitted fixtures. Instead a test-only RESTRICTIVE
SELECT policy hides exactly one row exactly once (the predicate function disarms
itself), so the pre-select returns NOT FOUND against a row that demonstrably
exists — byte-for-byte the state a losing racer is in when it reaches its INSERT.
The unique index still fires (indexes ignore RLS), the handler re-reads, and the
arm asserts the winner's id, `pending`, the refreshed `line_count`, the
`<consumed>` marker (so it fails loudly if the hide never fired and the arm
silently degraded into a plain replay) and that only one row exists. Both
test-only objects are dropped immediately after; the file rolls back regardless.

### 4. backend-architect S-2 — the inert `eod_entries` LEFT JOIN + §3.3 wording

The join is **dropped** (option 2, the architect's preference): it never matched on
the real path, so this is a zero-behavior-change edit that removes a decoy three
reviewers had to re-derive. `p_submission_id` is retained for signature stability
and for the future "make the entries participate" change, commented as such —
same posture as `emit_order_ready`'s unused `p_vendor_id`.

The wording is corrected everywhere it appeared, since "never a false positive"
would have led a future reader to a wrong call: §3.3 (rewritten — pre-count
`current_stock`, approximates in **both** directions, AC-13's empty state is the
backstop), §1.3 item 2 (the SQL snippet + an amendment note), §10 risk 3, §10 risk
8's performance note, backend deviation 5, the migration's Part-2 comment block,
the `comment on function`, and the pgTAP header note in
`order_ready_notifications.test.sql`.

**No async job.** Per the architect's explicit ruling: the false positive requires
an unrecorded receipt, is contained by an acceptance criterion that already
exists, and pulling the pg_net → engine → emit build forward would be an
overreaction to a copy-accuracy bug. Recorded in §3.3 as a follow-up spec, not a
now-item.

### Not addressed in this round (deliberate)

- **S-1 / S-4 (retailer pinning, `stores.postal_code` edit surface)** — PM
  decisions and a follow-up spec, per the architect's own classification. Neither
  blocks merge; both block turning any vendor's `order_channel` to `instacart`.
- **M-1…M-7, the security Lows** — advisory; none was in this round's brief. M-3
  (the untested `eod_entries` fallback arm) evaporates with item 4 above.

### Gates

```
npm run test:db        → 79/79 DB test file(s) passed (order_approvals now 24 arms)
npx jest               → 182 suites / 1809 tests passed (incl. this round's 9)
npx tsc --noEmit       → clean
npm run typecheck:test → clean
```

Local-stack note for the next agent: `npx supabase db reset` **stalls
indefinitely at "Initialising schema…"** in this sandbox (the CLI step needs
outbound network, which is blocked), and it drops the database *before* stalling —
so the local DB was left empty. It was rebuilt by hand: all 127 migrations applied
in order via `docker exec … psql -f -`, `auth.jwt()` created as `supabase_admin`
and then **reassigned to `supabase_auth_admin`** (GoTrue's own
`20220531120530_add_auth_jwt_function` migration fails with `must be owner of
function jwt` otherwise, which silently leaves `auth.users` on an old column set),
the auth/storage/realtime containers restarted so they re-ran their own
migrations, then `supabase/seed.sql`. Final state verified: 4 stores / 11 vendors
/ 572 inventory items / 3 users. No `supabase_realtime` publication change was
made at any point (R-5), so no `docker restart supabase_realtime_imr-inventory`
ritual applies.

### Files changed (this round)

New:

- `src/utils/pushNotificationCopy.ts` — TS mirror of the fanout's copy derivation
  (jest-only; not imported at runtime). **This is the round's single exception to
  the "backend does not touch `src/`" split** — it is additive, collision-free
  with the parallel frontend round, and `src/utils/` is where CLAUDE.md's
  documented edge-function-mirror pattern lives.
- `src/utils/pushNotificationCopy.test.ts`

Modified:

- `supabase/migrations/20260801000100_order_approvals.sql` — the pending-row
  channel-escalation guard in `tg_order_approvals_guard()`; the
  `unique_violation` handler in `create_order_approval`; both `comment on`
  strings and the file header updated.
- `supabase/migrations/20260801000200_order_ready_notification_type.sql` — inert
  `eod_entries` LEFT JOIN dropped from `eod_vendor_has_below_par`; the Part-2
  comment block and `comment on function` rewritten to state the two-directional
  approximation.
- `supabase/functions/submission-push-fanout/index.ts` — copy derivation
  extracted into the exported pure `derivePushCopy()`; handler now calls it.
- `supabase/tests/order_approvals.test.sql` — arms (G7)(G8)(G9)(C7),
  `__oa_vendor_instacart__` fixture, `plan(20) → plan(24)`.
- `supabase/tests/order_ready_notifications.test.sql` — header note corrected for
  the dropped join.
- `specs/149-eod-approve-order-pipeline.md` — §1.2, §1.3, §3.3, §4, §10 risks
  3/8, §11 test map, Files changed, backend deviation 5, and this section.
