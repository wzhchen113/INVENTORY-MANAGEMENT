# Spec 132: Browser-extension cart-filler for BJ's / Sam's Club (Chrome MV3)

Status: READY_FOR_REVIEW

> **Origin (owner scope change, this session — binding):** The owner killed the
> push+email delivery arm of spec 131 in favor of a **Chrome extension** that acts
> in the admin's OWN logged-in browser session on `bjs.com` / `samsclub.com`. Owner
> reasoning, verbatim: *"if i need to login to bjs and sams clubs that's mean i dont
> need a message anymore"* — the same admin who creates the PO is the one who opens
> the vendor site to pay, so the extension picks up the pending PO at the vendor site
> and fills the cart. This spec is the CONSUMER of the spec-131 backend contract (the
> pending-PO structured payload + the mark-ordered write-back).
>
> **Binding vendor research (verified 2026-07, memory
> `project_vendor_ordering_integration.md`, extended this session — do NOT
> re-litigate):**
> - **No buyer-side ordering API** exists for BJ's or Sam's Club. There is no
>   programmatic checkout.
> - **Sam's Club** has a real **"Reorder for Pickup using a List"** page that accepts
>   an **Excel list upload** — exact accepted format UNVERIFIED, needs the owner's
>   logged-in account to confirm (OQ-6). Sam's item numbers are also searchable, so
>   per-item site search is a matching path.
> - **BJ's (`bjs.com`) has NO quick-order or item-number entry** — only order-history
>   reorder, saved shopping lists, and a separate **$5k-minimum B2B program**. So for
>   BJ's there is **no paste/upload target**; the extension fills the cart via the
>   site UI (search / product-page add-to-cart).

## Repo reality (flag up front)

This repo (`imr-inventory`) is an **Expo React Native app** (web via Vercel, native
via EAS). A **Chrome MV3 extension is a NEW, separate build artifact** — it does not
fit the Expo bundle. **Where it lives and how it is built/typechecked/CI-gated is an
open question for the architect (OQ-4):** a candidate is an `extension/` subdirectory
at the repo root with its own `tsconfig` / build, kept out of the Expo Metro graph;
whether the two active CI gates (`test.yml`, `db-migrations-applied.yml`) grow an
extension typecheck/lint arm is likewise open. The extension SHARES the spec-131
backend contract but not the app's runtime.

## User story

As a **store manager**, after I create a purchase order for BJ's / Sam's Club and
open that vendor's website logged into my own account, I want a browser extension to
fill my cart with the PO's items — matched to that vendor's products — so I can
review and pay manually without re-typing the order, and then mark the PO ordered in
I.M.R. I want to see exactly which items did and didn't make it into the cart, and I
never want the extension to check out, pay, store my vendor password, or fight a
CAPTCHA on my behalf.

Sub-stories:

- **US-1 (pick up the pending PO).** As the admin, when I land on `bjs.com` /
  `samsclub.com` with a pending PO for that vendor, the extension recognizes it and
  offers to fill the cart from that PO's structured payload (spec 131 AC-4).
- **US-2 (fill the cart in MY session).** As the admin, the extension adds the PO's
  items to my cart in my already-logged-in session — never logging in for me, never
  storing my credentials.
- **US-3 (see what made it, what didn't).** As the admin, I get a per-item
  success/failure report so I can see which items were added, which weren't matched,
  and which need my attention.
- **US-4 (I pay, then mark ordered).** As the admin, I review the cart and pay
  manually; then the extension (or I) mark the PO ordered in I.M.R (spec 131 AC-6),
  so it drops out of the pending set.
- **US-5 (dry-run for safe iteration).** As the owner testing against my real BJ's /
  Sam's accounts, I want a dry-run mode that LOGS the intended cart actions without
  performing them, so I can validate matching before anything touches a live cart.

## Acceptance criteria

Pickup + auth:

- [ ] **AC-1 (MV3 extension, two vendor sites).** The deliverable is a Chrome
  Manifest V3 extension the owner installs (unpacked / side-loaded is acceptable for
  v1). It activates only on `bjs.com` and `samsclub.com` (host permissions scoped to
  exactly those origins — no broad `<all_urls>`).
- [ ] **AC-2 (authenticated to I.M.R as the admin, store-scoped).** The extension
  authenticates to the I.M.R backend as the signed-in admin and reads only
  `auth_can_see_store`-visible pending POs (spec 131 AC-3/AC-4). **The exact auth
  mechanism — riding the owner's existing Supabase session vs a scoped token minted
  for the extension — is an open question for the architect (OQ-1), resolved
  consistently with spec 131 OQ-3.** Whatever the mechanism, the extension MUST NOT
  gain broader access than the admin's own session.
- [ ] **AC-3 (pickup on the right site for the right vendor).** When the admin is on
  `samsclub.com` and a pending PO exists for the Sam's vendor (or on `bjs.com` for the
  BJ's vendor), the extension surfaces that PO and its structured lines. It matches
  the current site to a vendor via the spec-131 `order_page_url` / a per-vendor
  site-origin mapping (architect confirms the join — OQ-5). It does not act on a site
  with no pending PO.

Item matching (per vendor):

- [ ] **AC-4 (per-vendor item matching strategy).** For each PO line, the extension
  resolves the vendor's product:
  - **Sam's Club:** by the line's **vendor order code (item number)** via site search
    / the item-number path (Sam's item numbers are searchable); the "Reorder for
    Pickup using a List" upload is a candidate bulk path (OQ-6, format unverified).
  - **BJ's:** there is NO item-number entry, so matching is by **site search on the
    order code / item name** and/or a **stored per-(item, vendor) product-page URL**.
  - **Robust fallback (recommended):** storing the vendor **PRODUCT PAGE URL per
    (item, vendor)** — so a resolved product is a direct navigable link rather than a
    fragile search-result guess. **Whether product-page URLs are stored (and where —
    an addition to `item_vendors`, or extension-local) is an open question for the
    architect (OQ-2); if added to the backend it is a spec-131 / follow-up data
    change, flagged, not assumed.**
- [ ] **AC-5 (match ambiguity is surfaced, never silently guessed).** When site search
  returns zero or multiple candidates for a line, the extension does NOT silently pick
  one — it marks that line **unmatched / ambiguous** in the report (AC-7) for the
  admin to resolve. An item with no vendor order code (spec 131 AC-4 gap) is reported
  as unmatched, never dropped.

Cart fill (requirements-level; site-UI automation is fragile by nature):

- [ ] **AC-6 (fills the cart in the admin's session).** For each matched line, the
  extension adds the resolved product to the cart at the line's quantity, in the
  admin's already-logged-in session, via the site's own UI / add-to-cart affordance.
  Site-UI automation fragility is ACKNOWLEDGED as inherent — the extension MUST fail
  gracefully per item (a failed add is reported, AC-7, and does not abort the whole
  run). Quantity uses the spec-131 payload's unit (`case`/`unit`); the extension does
  NOT re-derive case math (that is spec 115's job, already in the payload).
- [ ] **AC-7 (per-item success/failure report).** After a run the extension shows the
  admin a per-item report: **added** (product + qty in cart), **unmatched/ambiguous**
  (AC-5), and **failed** (matched but the add-to-cart step errored). The admin sees
  exactly what did and did not make it into the cart before reviewing/paying.
- [ ] **AC-8 (mark ordered after the human pays).** After the admin reviews and pays
  manually, the extension (or the admin via an explicit control) calls the spec-131
  mark-ordered write-back (spec 131 AC-6) so the PO leaves the pending set. Marking is
  the admin's confirmed action, not automatic on cart-fill (payment happens between
  fill and mark).

Hard boundary:

- [ ] **AC-9 (HARD boundary — never checkout/pay, never store credentials, never
  fight a CAPTCHA).** The extension:
  - **NEVER proceeds to checkout or submits payment.** It stops at a filled cart; the
    human reviews and pays.
  - **NEVER stores or handles vendor credentials.** It relies entirely on the admin's
    existing logged-in session; if the admin is not logged in, it stops and asks the
    human to log in.
  - **NEVER circumvents a CAPTCHA or bot challenge.** If the site presents a CAPTCHA,
    an interstitial, a login wall, or any anti-bot challenge, the extension STOPS and
    hands control to the human — no solving, no evasion, no automation-detection
    workarounds.
  These are non-negotiable acceptance conditions, testable by asserting the extension
  has no checkout/payment code path, no credential storage, and a challenge-detection
  stop.

Dry-run + testing:

- [ ] **AC-10 (dry-run mode).** The extension supports a **dry-run** mode that LOGS
  the intended cart actions (which product it would match, at what qty, via what
  selector/URL) WITHOUT performing any add-to-cart or write-back. Dry-run is the
  default posture for iteration against the owner's live accounts; a live run is an
  explicit opt-in. The per-item report (AC-7) renders in dry-run too (as "would add"),
  so matching is validated before anything touches a real cart.
- [ ] **AC-11 (owner-in-the-loop verifiable).** Acceptance is verified against the
  **owner's real BJ's / Sam's accounts** (there is no vendor sandbox). The spec's
  acceptance for AC-4/AC-6 is demonstrated by the owner running the extension in
  dry-run, then a bounded live run, on his own logged-in accounts and confirming the
  report matches the PO. This is called out because no CI test can exercise the live
  vendor sites — automated coverage is limited to the extension's pure logic (AC-12).

Tests:

- [ ] **AC-12 (automated coverage of pure logic; live sites are manual).** The
  extension's testable-in-isolation logic is covered: the pending-PO fetch/parse
  (against a fixture spec-131 payload), the per-vendor matching decision (given
  fixture search results → matched / ambiguous / unmatched), the report assembly, and
  the dry-run gate (dry-run performs no cart/write side effects). The site-UI
  automation itself (selectors, add-to-cart) is NOT unit-testable against live sites
  and is verified manually per AC-11. **Test track + where extension tests run is an
  open question tied to OQ-4** (the extension is outside the Expo jest graph).

## In scope

- A Chrome MV3 extension (new build artifact) scoped to `bjs.com` + `samsclub.com`
  (AC-1) that: authenticates to I.M.R as the admin (AC-2), picks up the pending PO for
  the current vendor site (AC-3), matches each line per vendor (AC-4/AC-5), fills the
  cart in the admin's session (AC-6), reports per-item outcomes (AC-7), and calls the
  spec-131 mark-ordered write-back after the human pays (AC-8).
- The AC-9 hard boundary (no checkout/pay, no credential storage, no CAPTCHA
  circumvention) baked into the design.
- A dry-run mode (AC-10) and owner-in-the-loop live verification (AC-11).
- Automated coverage of the extension's pure logic (AC-12).

## Out of scope (explicitly)

- **The backend contract itself — that is spec 131.** The pending-PO structured
  payload (spec 131 AC-4), the pending definition (AC-3), the `extension_ordering` /
  `order_page_url` vendor columns, and the mark-ordered write-back (AC-6) are built in
  spec 131. This spec CONSUMES them.
- **Checkout, payment, order completion on the vendor site.** Never (AC-9). The
  extension stops at a filled cart.
- **Storing vendor credentials / logging in for the admin.** Never (AC-9). It uses
  the admin's existing session only.
- **CAPTCHA solving / anti-bot circumvention.** Never (AC-9). Challenge → stop → human.
- **US Foods / Sysco / Webstaurant vendors.** This extension targets the BJ's / Sam's
  cart-fill the owner named. Their file exports (spec 116/117) are a different path.
- **A production Chrome Web Store listing / store-review submission.** v1 is an
  owner-installed (unpacked / side-loaded) extension for the owner's own use. A public
  listing is a follow-up.
- **Firefox / Safari / Edge ports.** Chrome MV3 only for v1.
- **Changing the Expo app's runtime, bundle, or navigation.** The extension is a
  separate artifact; it does not import the RN app.
- **The `app.json` slug, identity drift, and the repo-root spreadsheet** — untouched.

## Open questions (for the architect)

The owner ruled the shape (a Chrome extension cart-filler in the admin's own
session, never checkout). The following are mechanism decisions the architect fixes;
none blocks starting the design (each is a design fork, not a missing requirement),
so this spec is READY_FOR_ARCH with them flagged.

- **OQ-1 — [FLAGGED] Extension → I.M.R auth.** Ride the owner's existing Supabase
  session (token surfaced from the web app / captured from the authenticated origin)
  vs a scoped token minted for the extension. Must resolve **consistently with spec
  131 OQ-3** and stay `auth_can_see_store`-bounded. Security-sensitive — the architect
  + security-auditor pin the token handling (where it is stored in the extension, its
  scope, its lifetime). No broader-than-the-admin access.
- **OQ-2 — [FLAGGED] Product-page URL per (item, vendor) — stored where?** The robust
  BJ's fallback is a stored vendor product-page URL per item. Options: (a) add a
  column to `item_vendors` (a spec-131 / follow-up backend change — flag, do not
  assume), (b) keep it extension-local, (c) defer and rely on search-only for v1.
  Architect decides; if (a), it routes back through spec 131 / a data-model
  follow-up.
- **OQ-3 — Sam's list-upload bulk path vs per-item search.** Sam's "Reorder for
  Pickup using a List" Excel upload could fill the whole cart in one shot, but the
  format is UNVERIFIED (needs the owner's live account — carried from spec 131 OQ-6).
  Per-item item-number search is the safe v1 path. Architect chooses v1 posture; the
  list-upload arm is a follow-up gated on the owner's live-account format check.
- **OQ-4 — [FLAGGED] Where the extension lives + CI integration.** Repo subdir (e.g.
  `extension/`) with its own build/tsconfig, kept out of the Expo Metro graph; whether
  `test.yml` grows an extension typecheck/lint/test arm; the extension test track
  (AC-12). Architect fixes the layout + CI posture.
- **OQ-5 — Vendor ↔ site-origin join.** How the extension maps `samsclub.com` /
  `bjs.com` to the I.M.R vendor whose PO to pick up — via `order_page_url` origin, a
  per-vendor site-origin field, or a fixed extension-side map. Architect confirms.
- **OQ-6 — [FLAGGED] Live-account verification.** AC-11 requires the owner to run the
  extension against his real BJ's / Sam's accounts to verify matching + cart-fill.
  This is a human verification gate, not a CI gate; the architect + test-engineer note
  it as a manual acceptance step, and the DOM selectors are expected to need
  owner-observed tuning (site UIs drift).

## Dependencies

- **Spec 131 (this session, revised)** — the backend contract this extension
  consumes: the pending-PO structured payload (spec 131 AC-4), the pending definition
  (AC-3), the `extension_ordering` + `order_page_url` vendor columns (AC-1/AC-2), and
  the mark-ordered write-back (AC-6). 132 cannot ship before 131's read/write surface
  exists. The OQ-1 auth decision spans both specs.
- **Spec 114/115 (live)** — the per-line `order_code` and `order_unit` already baked
  into the spec-131 payload (the extension does NOT re-derive case math).
- **A new build artifact** — the MV3 extension source, layout + CI per OQ-4.
- **No new I.M.R migration owned by THIS spec** — the vendor columns + mark-ordered
  surface are spec 131's. IF OQ-2 resolves to a stored product-page URL column, that
  is a flagged spec-131 / follow-up data change, not owned here.

## Project-specific notes

- **Cmd UI section / legacy:** none — the extension is a separate artifact, not a
  Cmd UI section. Any in-app affordance (e.g. a mark-ordered control) is spec 131's.
- **Which app:** NEITHER the admin Cmd UI, the staff app, nor the customer PWA — a
  **new Chrome MV3 extension** that talks to the same Supabase backend as the admin.
  No `src/screens/` change owned here.
- **Per-store or admin-global:** the extension reads/writes **per-store** POs bounded
  by `auth_can_see_store` (inherited from spec 131). It must never exceed the admin's
  own store visibility (AC-2).
- **Edge function or PostgREST:** the extension calls the spec-131 read surface + the
  mark-ordered write (scoped PostgREST or an RPC — spec 131 OQ-1/OQ-2). **NOT** a
  `staff-*` / service-token / `pwa-catalog` surface. Auth per OQ-1.
- **Realtime:** none — the extension polls / reads on demand when the admin lands on a
  vendor site; no realtime channel.
- **Migrations needed:** none owned here (spec 131 owns the vendor columns + mark-
  ordered surface). A product-page-URL column (OQ-2) would be a flagged follow-up /
  spec-131 addition.
- **Never-checkout / never-credential / never-CAPTCHA (flag for reviewers +
  security):** AC-9 is the hard security boundary. Reviewers assert the extension has
  no checkout/payment path, no credential storage, and a challenge-detection stop. The
  host permissions are scoped to exactly `bjs.com` + `samsclub.com` (no `<all_urls>`).
  The OQ-1 token handling is security-audited.
- **Edge functions touched:** none new here.
- **Web/native scope:** **Chrome (web) only.** No Expo native / EAS involvement; the
  extension is outside the RN bundle.
- **`app.json` slug:** untouched — the extension is a separate artifact with its own
  manifest identifiers; it does NOT touch `app.json`. `slug` stays `towson-inventory`
  pending explicit approval.
- **Test tracks (spec 022):** the three existing tracks (jest / pgTAP / shell smoke)
  are Expo-repo tracks; the extension is outside them (OQ-4). Pure-logic coverage
  (AC-12) needs an extension-local test setup the architect specifies; live-site
  behavior (AC-4/AC-6) is manual owner verification (AC-11), not CI.

## Handoff
next_agent: backend-architect
prompt: Design the contract for spec 132 (the Chrome MV3 cart-filler that consumes
  spec 131's backend). Fix the flagged forks: (OQ-1) the extension → I.M.R auth path
  (Supabase session vs scoped token), resolved consistently with spec 131 OQ-3 and
  kept auth_can_see_store-bounded — this is security-sensitive, pin token storage /
  scope / lifetime; (OQ-2) whether to store a vendor product-page URL per (item,
  vendor) as the robust BJ's fallback (and if so, that it is a flagged spec-131 /
  follow-up data change, not assumed here); (OQ-3) Sam's list-upload bulk path vs
  per-item search for v1 (format unverified — owner live-account gate); (OQ-4) where
  the extension lives (e.g. an extension/ subdir out of the Expo Metro graph) + its
  build/typecheck/CI/test posture; (OQ-5) the vendor ↔ site-origin join. Design the
  per-vendor matching strategy (Sam's item-number search; BJ's search / stored
  product-page URL), the per-item success/failure report, the dry-run gate (no cart /
  write side effects), and the AC-9 hard boundary (never checkout/pay, never store
  credentials, never circumvent a CAPTCHA — challenge → stop → human). Note that live
  acceptance (AC-4/AC-6) is owner-in-the-loop against real BJ's/Sam's accounts, not
  CI. This design depends on spec 131's read/write surface — sequence accordingly.
  Then set Status: READY_FOR_BUILD.
payload_paths:
  - specs/132-browser-extension-cart-filler.md
  - specs/131-auto-deliver-order-artifact-on-po-create.md

---

## Backend / extension design

This design DEPENDS on spec 131's backend surface (the read-RPC pair, the
mark-ordered write, the three additive columns, the shared builder). Read spec
131's `## Backend design` first — especially **131 D-1** (the AC-4/AC-5/132-AC-6
reconciliation), **131 D-3** (the RPC pair), **131 D-4** (mark-ordered =
`draft → sent`), and **131 D-5** (the shared auth ruling). This spec fixes the
extension-side forks and pins the AC-9 hard boundary. **132 CANNOT ship before
131's migration + RPCs are live.**

The forks, fixed:
- **OQ-1 (auth) → the extension embeds `supabase-js`, admin email+password login,
  session in `chrome.storage.local`, RLS-bounded** — resolved identically to 131
  OQ-3 (D-2).
- **OQ-2 (product-page URL) → `item_vendors.product_page_url` is added additively
  in spec 131's migration** (131 D-2). The extension PREFERS a non-null URL, else
  falls back to search (D-3). Populating URLs is optional/incremental — v1 matching
  works search-first with no URL data.
- **OQ-3 (Sam's list-upload vs per-item search) → per-item search for v1** (D-3);
  the list-upload bulk path is a follow-up gated on the owner's live-account format
  check (OQ-6, unverified).
- **OQ-4 (layout + CI) → `extension/` subdir, own build, out of the Expo Metro
  graph, its own typecheck + unit-test CI arm** (D-6).
- **OQ-5 (vendor↔site-origin join) → `vendors.order_page_url` origin** (131 D-2),
  matched client-side (D-3). No separate origin field.

### D-1. What the extension is (and is NOT)

A Chrome Manifest V3 extension, owner-installed unpacked/side-loaded for v1
(AC-1). Host permissions scoped to EXACTLY `https://www.bjs.com/*` +
`https://www.samsclub.com/*` (plus the I.M.R Supabase origin for the auth/data
calls) — **never `<all_urls>`** (AC-1, AC-9). It reads the admin's pending POs
from I.M.R, matches each line to the vendor's product, fills the cart in the
admin's own logged-in session, reports per-item outcomes, and (after the human
pays) marks the PO ordered. It NEVER checks out, pays, stores a credential, or
fights a CAPTCHA (AC-9, D-8).

### D-2. Extension → I.M.R auth (OQ-1 — resolved identically to 131 OQ-3)

**The extension embeds `@supabase/supabase-js` and authenticates as the admin via
the EXISTING email+password Supabase auth.** Chosen over (b) riding the web app's
session and (c) a minted scoped token.

- **Login:** a small extension popup calls `supabase.auth.signInWithPassword({
  email, password })` against the project URL + the **public anon key**. The anon
  key is already shipped in the web bundle — it is NOT a secret; RLS is the only
  thing that bounds access. This is compile-time config in the extension, not a
  stored credential.
- **Session:** `supabase-js` persists the session (access + refresh token) in
  `chrome.storage.local` via a custom storage adapter (extension-sandboxed — NOT
  readable by any web page, including the vendor sites). Refresh-token rotation is
  handled by `supabase-js`. On expiry with no refresh → the popup re-prompts login.
- **Scope:** the JWT is the ADMIN'S OWN — `app_metadata.role` + `user_stores`
  visibility baked in. Every RPC read (131 D-3) and the mark-ordered UPDATE (131
  D-4) ride it → `auth_can_see_store` / `auth_can_see_brand` bound the extension to
  EXACTLY the admin's web-session visibility (AC-2). **No service-role key, no new
  token-minting backend, no cross-origin token theft, no broader-than-admin access.**
- **Why NOT (b) ride the web session:** extracting the web app's token from another
  origin's storage needs either a content script injected into the I.M.R web origin
  (extra host permission + fragile) or a web-app code change to `postMessage` the
  token (a new handoff surface in the Expo app). (a) is self-contained and reuses
  the standard auth with zero app change. Tradeoff: the admin logs into the
  extension once, separately — acceptable for an owner-installed v1 tool.
- **Security-audited surface (flag for security-auditor):** token-at-rest in
  `chrome.storage.local`; the anon key as public compile-time config; session
  lifetime = Supabase default; the login popup handling the admin's I.M.R password
  (never a vendor password — AC-9). No elevation path exists.

**Vendor credentials are NEVER touched (AC-9):** the extension relies entirely on
the admin's EXISTING logged-in `bjs.com` / `samsclub.com` browser session. If the
admin is not logged in on the vendor site, the extension STOPS and asks the human
to log in — it never logs in for them, never stores a vendor password.

### D-3. Per-vendor item matching (AC-4 / AC-5 + OQ-2 / OQ-3 / OQ-5)

**The extension consumes spec 131's RPC pair via its own `imrClient`
(`extension/src/lib/imrClient.ts`), then applies the SHARED pure builder.**

1. **Pickup (AC-3, OQ-5).** On landing on a vendor site the extension calls
   `get_pending_extension_orders(null)` → the pending set across all opted-in
   vendors, each row carrying its `orderPageUrl`. It matches the current tab
   origin to `new URL(row.orderPageUrl).origin` — that IS the vendor↔site join
   (OQ-5; no separate origin field, no fixed extension-side map). If a pending PO
   matches the current origin, the extension offers to fill from it; on a site with
   no matching pending PO it does nothing (AC-3).
2. **Payload + case math (131 D-1).** For the matched PO it calls
   `get_extension_order_payload(poId)` → raw structured lines
   (`orderCode`, `itemName`, `orderedQty` counted, `orderUnit`, `caseQty`,
   `productPageUrl`). It applies the SHARED
   `computePoQuickOrderLines(lines, resolveCode, resolveName, orderUnit)` imported
   from `../src/utils/poQuickOrderText.ts` (131 D-7) → per-line case-converted
   `qty` + `unit`. **The extension authors NO case math** (AC-6 — "spec 115's job,
   already in the payload," honored via the shared builder, not a re-derivation).
3. **Per-vendor product resolution (AC-4):**
   - **Sam's Club:** by the line's **vendor order code (item number)** — site
     search / the item-number path (Sam's item numbers are searchable). If a
     `productPageUrl` is stored for that (item, vendor), navigate it directly
     (more robust than a search guess).
   - **BJ's:** NO item-number entry → match by **stored `productPageUrl` when
     present** (direct navigate), else **site search on the order code / item
     name**.
   - **v1 posture (OQ-3):** per-item SEARCH is the baseline path for both vendors;
     `productPageUrl` is the preferred override WHEN populated. Sam's
     "Reorder for Pickup using a List" Excel bulk upload is a FOLLOW-UP gated on
     the owner's live-account format check (OQ-6, unverified — carried from 131
     OQ-6). No bulk-upload code in v1.
4. **Ambiguity is surfaced, never guessed (AC-5).** Zero or multiple search
   candidates for a line → mark it **unmatched / ambiguous** in the report (D-4),
   never auto-pick. A line whose `orderCode` is `null` (the 131 AC-4 gap) is
   reported **unmatched**, never dropped.

### D-4. Cart fill + the per-item report (AC-6 / AC-7)

- **Fill (AC-6).** For each RESOLVED line the extension adds the product to the
  cart at the line's `qty` via the site's OWN add-to-cart UI, in the admin's
  logged-in session. Site-UI automation fragility is acknowledged inherent — the
  extension MUST fail gracefully PER ITEM: a failed add is reported, not fatal to
  the run.
- **Report (AC-7).** After a run the extension shows a per-item report — an array
  of `{ itemId, orderCode, itemName, qty, unit, status, detail }` where `status ∈
  { 'added', 'unmatched', 'ambiguous', 'failed', 'would-add' }` (`would-add` is the
  dry-run rendering, D-5). The admin sees exactly what did and did not make it into
  the cart BEFORE reviewing/paying.
- **Mark ordered AFTER the human pays (AC-8).** Marking is the admin's explicit,
  confirmed action (a button in the report), NOT automatic on cart-fill — payment
  happens between fill and mark. It calls spec 131's mark-ordered write (131 D-4:
  the guarded `draft → sent` UPDATE via the extension's `imrClient`), dropping the
  PO out of the pending set + into the reorder inbound loop. Idempotent (131 D-4).

### D-5. Dry-run mode (AC-10)

A dry-run flag (**the DEFAULT posture** for iteration against the owner's live
accounts; a live run is an explicit opt-in toggle) gates ALL side effects:

- Dry-run LOGS the intended action per line (which product it WOULD match, at what
  qty, via what selector/URL) and renders the report (D-4) with `status:
  'would-add'` — but performs **NO** add-to-cart AND **NO** mark-ordered write.
- The dry-run gate wraps BOTH the cart-fill side effect AND the 131 mark-ordered
  RPC/UPDATE — a single boundary, testable in isolation (AC-12: "dry-run performs
  no cart/write side effects"). Matching + report assembly run identically in both
  modes, so matching is validated before anything touches a real cart.

### D-6. Extension location, build, CI (OQ-4)

- **Location:** `extension/` at the repo root — its own `package.json`,
  `tsconfig.json`, and MV3 `manifest.json`. **Kept OUT of the Expo Metro graph:**
  add `extension/` to Metro's `blockList` / `.easignore` / `.vercelignore` /
  `.expoignore` as needed so `npx expo export --platform web` (Vercel) and EAS
  builds NEVER pick it up. It shares the spec-131 backend contract, NOT the app's
  runtime bundle.
- **Build tooling:** a lightweight MV3 bundler (esbuild or Vite `@crxjs`) — NOT
  Metro. It emits an unpacked extension the owner side-loads. The `tsconfig`
  path-maps `../src/utils/poQuickOrderText.ts` so the shared pure builder (131 D-7)
  compiles into the extension bundle. Import ONLY that pure util — do NOT import
  `src/lib/db.ts` / `src/store/` (they carry Expo/React deps).
- **CI (extend `.github/workflows/test.yml`, per the CLAUDE.md two-gate reality):**
  add an `extension` job/arm that runs `tsc --noEmit` on the `extension/` tsconfig
  and the extension unit tests (AC-12). It does NOT touch `db-migrations-applied.yml`
  (no migration owned here). The base Expo typecheck + jest are unaffected because
  `extension/` is out of their graphs. If wiring the CI arm is deferred, the
  extension typecheck/test MUST at minimum be runnable locally and documented in
  `extension/README.md` — flag, do not silently drop coverage.
- **Test track (AC-12):** the extension is outside the Expo jest graph, so it runs
  its OWN unit runner (vitest or a second jest project under `extension/`) covering
  the PURE logic: pending-PO fetch/parse against a fixture 131 payload; the
  per-vendor matching decision (fixture search results → matched / ambiguous /
  unmatched); report assembly; the dry-run gate (asserts no cart/write side
  effect). Site-UI automation (selectors, add-to-cart) is NOT unit-testable against
  live sites — manual owner verification (AC-11).

### D-7. No new I.M.R migration owned here

Spec 131 owns the three additive columns (`vendors.extension_ordering`,
`vendors.order_page_url`, `item_vendors.product_page_url`) + the two RPCs + the
mark-ordered write + the `computePoQuickOrderLines` extraction. **132 owns ZERO
schema.** The `item_vendors.product_page_url` editor field (in `IngredientForm`'s
per-vendor card, sibling to spec-114's `order_code`) is a 132/follow-up FRONTEND
task if/when the owner wants in-app URL entry — flagged, not required for v1 (URLs
can be populated by direct DB while search-first matching carries v1).

### D-8. AC-9 hard boundary — restated as a review-REJECT contract

These are non-negotiable, testable by asserting the extension source has NO such
path (AC-9, AC-12). Any violation is a Critical, ship-blocking finding:

1. **NEVER checkout / pay.** The extension stops at a FILLED cart. There is NO code
   path that clicks "checkout," "place order," "pay," or submits a payment/billing
   form. Reviewer greps for and rejects any checkout/payment navigation or form
   submission.
2. **NEVER store or handle vendor credentials.** No vendor-password input, no
   vendor-credential storage, no login-for-the-user. Relies solely on the admin's
   existing vendor-site session; not-logged-in → STOP + ask the human. (The only
   credential the extension handles is the admin's own I.M.R password at the
   Supabase login popup — D-2.)
3. **NEVER circumvent a CAPTCHA / bot challenge.** On a CAPTCHA, interstitial,
   login wall, or any anti-bot challenge, the extension STOPS and hands control to
   the human — no solving, no evasion, no automation-detection workaround. A
   challenge-detection stop is a required, tested behavior.
4. **Host permissions scoped to exactly `bjs.com` + `samsclub.com`** (+ the I.M.R
   Supabase origin) — never `<all_urls>`. Reviewer inspects `manifest.json`.

### D-9. Realtime / store / edge

- **Realtime:** none — the extension polls/reads on demand when the admin lands on
  a vendor site (Project notes). No realtime channel, no publication change.
- **Store:** no `src/store/useStore.ts` change — the extension has its own state
  (its popup + content-script messaging), separate from the Expo app.
- **Edge functions:** none new (131 D-6). The extension calls RPCs + a guarded
  PostgREST UPDATE via its own `supabase-js` client — NOT a `staff-*` /
  service-token / `pwa-catalog` surface.

### D-10. Risks / tradeoffs

- **Live-site fragility + owner-in-the-loop (AC-11 / OQ-6).** DOM selectors WILL
  drift as BJ's / Sam's UIs change; acceptance is the owner running dry-run then a
  bounded live run on his REAL accounts (no vendor sandbox). This is a MANUAL
  acceptance gate, not CI — CI covers only pure logic (D-6). Test-engineer notes it
  as a manual step; expect owner-observed selector tuning.
- **Shared-builder coupling (131 D-11).** The extension imports the pure
  `poQuickOrderText.ts`. A future spec making that file impure breaks the extension
  build — the extension typecheck arm (D-6) catches it at CI.
- **Auth token at rest (D-2).** `chrome.storage.local` is extension-sandboxed but
  a compromised extension environment could read it. Mitigation: it is the admin's
  OWN JWT (no elevation), Supabase-default lifetime, refresh rotation. Security-audited.
- **Sam's bulk-upload deferral (OQ-3/OQ-6).** v1 is per-item search only; if search
  proves too slow/fragile at real cart sizes, the list-upload path is the
  follow-up — but its format needs the owner's live account first.

### D-11. Slice ownership

- **frontend-developer** (extension is a frontend/client artifact): the entire
  `extension/` subtree — MV3 `manifest.json`, the `supabase-js` `imrClient` (auth
  D-2 + the RPC/mark-ordered calls), the pickup/origin-match logic (D-3), the
  per-vendor matching + cart-fill content scripts (D-3/D-4), the report UI (D-4),
  the dry-run gate (D-5), the build tooling + CI arm + unit tests (D-6). Imports
  the shared `computePoQuickOrderLines` (owned by 131's backend-developer).
- **No backend-developer work owned by 132** — all backend is 131's. 132 waits on
  131's RPCs being live before its integration/live testing.

---

## Files changed

### Build / verification notes (flags for reviewers)

- **Test runner — vitest (design-authorized, NOT a fourth main-repo track).**
  D-6 explicitly rules "vitest or a second jest project under `extension/`". The
  extension is OUTSIDE the Expo three-track graph (jest / pgTAP / shell), so its
  own vitest runner is not the "silently introduce a fourth framework" CLAUDE.md
  hazard — that rule governs the main repo's tracks. vitest + esbuild +
  @types/chrome are `extension/`-local devDependencies (own `package.json` +
  `package-lock.json`); root `package.json` is UNTOUCHED. Flagged for the
  test-engineer to confirm the scoping.
- **Shared-builder import, no fork (131 D-1/D-7).** `extension/src/core/plan.ts`
  imports `computePoQuickOrderLines` from `../../../src/utils/poQuickOrderText.ts`
  — the ONE canonical spec-115 case-math implementation. esbuild tree-shakes the
  unused `buildPoQuickOrderText`/`formatQty`/i18n/papaparse chain out of the
  bundle; the shared file's transitive graph is react-native-free (verified), so
  the extension typecheck + build stay clean. Coupling risk is the acknowledged
  D-11/131-D-11 tradeoff (the CI typecheck arm catches a future impurity).
- **Mark-ordered = guarded PostgREST UPDATE (architect post-impl S-1).**
  `imrClient.markOrdered` issues `update purchase_orders set status='sent' where
  id=:poId AND status='draft'` (NOT the unguarded markPurchaseOrderSent) — the
  `and status='draft'` guard is REQUIRED. Verified live: 1-row on the real
  transition, drops out of the pending set, 0-row idempotent re-run.
- **AC-9 self-audit (ship-blocking contract, D-8).** Grepped the whole
  `extension/src` + manifest: NO checkout/place-order/pay navigation or form
  submit (the add-to-cart finder EXCLUDES those controls); NO vendor-credential
  input or storage; NO `<all_urls>` (host_permissions = exactly `bjs.com` +
  `samsclub.com` + the one injected Supabase origin); NO service-role key. The
  challenge-detection STOP (`pageDetectChallenge` + the background preflight /
  mid-run guard) hands control to the human.
- **Isolation from the Expo graph (D-6).** `extension/**` excluded in
  `tsconfig.json`; `extension/` added to `metro.config.js` `resolver.blockList`
  and `jest.config.js` `modulePathIgnorePatterns`; `extension/node_modules` +
  `extension/dist` gitignored. Verified: base `tsc --noEmit`, `tsc -p
  tsconfig.test.json`, and full `npx jest` (122 suites / 1322 tests) all green,
  unaffected.
- **Live-RPC smoke (local stack, admin@local.test).** Both spec-131 RPCs return
  EXACTLY the shapes `extension/src/lib/types.ts` expects: RPC 1 surfaced a
  fixture draft BJ's PO (`unmappedCount:1`, `orderUnit:'case'`); RPC 2 returned
  the structured lines incl. the `orderCode:null` unmapped line; the guarded
  mark-ordered write transitioned draft→sent and dropped it from the pending set
  (idempotent 0-row re-run). Fixture created + rolled back (no residual data).
- **Owner-in-the-loop remains manual (AC-11).** The BJ's / Sam's DOM selectors
  in `adapters/*.ts` are first-pass, marked OWNER-TUNE, and NOT unit-tested
  against live sites — the owner runs dry-run then a bounded live run and tunes.

### New — the extension artifact (all NEW, outside the Expo bundle)
- `extension/package.json`, `extension/package-lock.json` — extension-local deps
  (esbuild, vitest, @types/chrome, @supabase/supabase-js) + scripts (build,
  typecheck, test).
- `extension/tsconfig.json` — extension-only strict typecheck (imports the one
  shared builder; `skipLibCheck`; chrome + node types).
- `extension/manifest.json` — MV3 manifest, host-scoped to `bjs.com` +
  `samsclub.com` (Supabase origin injected at build).
- `extension/build.mjs` — esbuild bundler (NOT Metro); env → compile-time
  Supabase config; injects the Supabase origin into `host_permissions`.
- `extension/vitest.config.ts` — extension-only unit runner (node env).
- `extension/README.md` — build/typecheck/test commands, install steps, the AC-9
  boundary, dry-run posture, and the manual owner-verification note.
- `extension/public/popup.html` — popup markup + styles.
- `extension/src/lib/types.ts` — RPC payload / plan / report / execution types.
- `extension/src/lib/config.ts` — compile-time Supabase URL + public anon key.
- `extension/src/lib/storageAdapter.ts` — supabase-js session storage over
  `chrome.storage.local` (extension-sandboxed).
- `extension/src/lib/imrClient.ts` — supabase-js client: admin email+password
  auth (D-2), the two spec-131 RPCs, and the GUARDED mark-ordered UPDATE (AC-6).
- `extension/src/lib/messages.ts` — popup↔background message protocol.
- `extension/src/core/urlGuard.ts` — http(s) scheme validation before any
  navigation/origin compare (AC-9).
- `extension/src/core/origin.ts` — vendor↔site join by `order_page_url` origin
  (AC-3 / OQ-5).
- `extension/src/core/plan.ts` — payload → PlannedAction[] via the shared builder
  (AC-4/AC-5/AC-6).
- `extension/src/core/dryRun.ts` — the single dry-run gate over BOTH side effects
  (AC-10).
- `extension/src/core/report.ts` — per-item report assembly + summary (AC-7).
- `extension/src/adapters/types.ts` — the per-vendor adapter contract.
- `extension/src/adapters/bjs.ts`, `extension/src/adapters/samsclub.ts` —
  best-effort DOM adapters (OWNER-TUNE selectors; challenge/login stops; no
  checkout).
- `extension/src/adapters/registry.ts` — origin → adapter map.
- `extension/src/background/service-worker.ts` — MV3 background: auth, pickup,
  the dry-run-gated run, the AC-9 preflight/mid-run stops, mark-ordered.
- `extension/src/popup/popup.ts` — thin popup UI logic.
- `extension/src/core/__tests__/{urlGuard,origin,plan,dryRun,report}.test.ts` —
  29 vitest cases over the pure adapter-agnostic core (AC-12).

### Modified — Expo-graph isolation only (no runtime/behavior change to the app)
- `tsconfig.json` — added `extension/**` to `exclude`.
- `metro.config.js` — added `extension/` to `resolver.blockList`.
- `jest.config.js` — added `<rootDir>/extension/` to `modulePathIgnorePatterns`.
- `.gitignore` — ignore `extension/node_modules/` + `extension/dist/`.
- `.github/workflows/test.yml` — new **Track 1c** job: extension typecheck +
  vitest (D-6 / OQ-4).

### Not changed (owned by spec 131, flagged)
- No migration, no `src/lib/db.ts`, no `src/store/`, no Cmd UI, no `app.json`
  change owned here. The three additive columns + two RPCs + the shared-builder
  extraction are spec 131's (READY_FOR_REVIEW; prod-apply is 131's gate). The
  `item_vendors.product_page_url` in-app EDITOR field remains a 131/follow-up
  frontend decision — the extension consumes the column when populated.
