# Spec 155: Instacart channel enablement — store ZIP surface + picker disclosure + go-live runbook

Status: READY_FOR_REVIEW

> **Owner decision (already made — do NOT re-open).** Spec 149 shipped the
> Instacart channel **dark** behind four gates and escalated three decision gates
> to the PM. The owner has now **ACCEPTED DG-1**: the live Instacart Developer
> Platform API has **no retailer-pinning parameter** on
> `POST /idp/v1/products/products_link`, so a minted link opens on Instacart's
> shopping-list page where the admin picks the store. The *items* are pre-filled;
> the *retailer* is not. The extra tap is accepted.
>
> This spec turns on the remaining product/UI gates that acceptance requires, and
> writes the go-live runbook. It does **not** re-litigate whether Instacart is the
> right channel, and it does **not** attempt to recover retailer pinning — that
> mechanism does not exist upstream (spec 149, "IDP contract reconciliation",
> reconciled against the live docs 2026-08-01).
>
> Scope is three code changes + one ops document:
> 1. **DG-2** — an edit path for `stores.postal_code` on EXISTING stores.
> 2. **DG-1** — one added disclosure line on the Instacart approve path.
> 3. **§5.5** — demote the retailer-availability probe from blocking to advisory.
> 4. **Runbook** — key acquisition, per-vendor opt-in, verification, rollback.

---

## PM summary (plain language, for the owner)

Spec 149 built the whole Instacart path and then deliberately left it switched
off, because three things were unresolved. One of them — "does the link land on
BJ's, or on a store picker?" — turned out to be a limitation of Instacart's own
API, not of our code. You have accepted that: the link opens with your items
already in it, and you tap your store once.

Accepting that costs three small things, and this spec is those three things plus
the instructions for turning the channel on:

1. **You need to be able to type a ZIP for a store that already exists.** Today
   the ZIP field only appears when you *create* a store, so none of your existing
   stores have one. There is currently no way to edit a store at all — only
   activate/deactivate it — so this adds a small EDIT affordance.
2. **The approve screen has to say the store is picked on Instacart.** One extra
   line, right where the fee/markup disclosure already is. Without it the screen
   promises something the link does not deliver.
3. **The "is this retailer available at your ZIP?" check has to stop refusing.**
   It was written to prevent minting a link that lands on an empty retailer. With
   no retailer pinning, the link never lands on a specific retailer at all, so the
   check has nothing to protect — it just blocks orders that would have worked. It
   stays, as a warning, because "is Instacart in this market at all" is still
   worth knowing.

Then the runbook: you get a free API key from Instacart's developer site (only
you can do that — it needs your account), we set it as a server secret, you type
your store ZIPs, you flip ONE vendor to the Instacart channel as a pilot, and you
check out once. If anything is off, flipping that vendor's channel back is
instant and needs no deploy.

**Nothing changes for BJ's, Sam's, WebstaurantStore or your Chrome cart-filler
vendors until you personally flip a vendor's ORDER CHANNEL.** That is still true
after this spec ships.

---

## User stories

- **US-1 (ZIP).** As a store admin, I want to set or correct a store's postal
  code for a store that already exists, so the Instacart market check has a ZIP
  to work with without anyone running hand-SQL against prod.
- **US-2 (honesty).** As a store admin, before I tap APPROVE & ORDER on an
  Instacart vendor, I want to be told that I will pick the store on Instacart, so
  the screen never promises a pre-selected retailer it cannot deliver.
- **US-3 (no false refusal).** As a store admin, I do not want the app to refuse
  to build my cart link because a retailer key did not appear in a market
  listing, when the link works regardless of which retailer I end up picking.
- **US-4 (go-live).** As the owner, I want a written, ordered runbook for turning
  the Instacart channel on for one vendor, verifying it end-to-end, and turning it
  back off in one action — so enablement is a decision, not an expedition.

---

## Findings from the codebase (what already exists — so the architect is not designing blind)

Verified against the tree at `74ffabe`.

### DG-2 — the store edit surface does not exist *at all*

| piece | state |
|---|---|
| `stores.postal_code` column | **exists** (spec 149 migration `20260801000000_vendor_order_channel.sql`), nullable text, inherits existing `stores` RLS — no policy change was made or is needed |
| `Store.postalCode` type | **exists** — [src/types/index.ts:614](../src/types/index.ts) |
| `db.updateStore` | **already accepts it** — the `Pick<>` includes `'postalCode'` ([src/lib/db.ts:119](../src/lib/db.ts)) and maps `postalCode || null` → `postal_code` ([db.ts:134](../src/lib/db.ts)) |
| read mappers | **already map it** — [db.ts:77](../src/lib/db.ts), [db.ts:104](../src/lib/db.ts) |
| `StoreFormDrawer` | **create-only.** Calls `addStore` ([StoreFormDrawer.tsx:52](../src/components/cmd/StoreFormDrawer.tsx)); header badge is hardcoded `NEW`, primary button `CREATE ⌘⏎`. Has the POSTAL CODE input (`testID="store-postal-code"`, [line 269](../src/components/cmd/StoreFormDrawer.tsx)) with `postalCode.trim() \|\| null` semantics |
| the only store-management surface | `StoresTab`, defined **inside** [src/screens/cmd/sections/BrandsSection.tsx:1081](../src/screens/cmd/sections/BrandsSection.tsx) and rendered from the Brands section's store tab ([line 657](../src/screens/cmd/sections/BrandsSection.tsx)). Each row shows short id, name, address, a `StatusPill`, and ONE action: `ACTIVATE` / `DEACTIVATE`. **There is no edit affordance for any store field anywhere in the app.** |
| `eodDeadlineTime` / `weeklyCountDueDow` | likewise have no general edit drawer; `weeklyCountDueDow` got a *dedicated* action (`setStoreWeeklyDueDow`, spec 098) precisely because of the next row |

**★ The load-bearing gotcha the architect must rule on.**
`useStore.updateStore` deliberately narrows to an explicit **four-field literal**
and **silently drops `postalCode`**:

```ts
// src/store/useStore.ts:3031-3035
db.updateStore(id, {
  name: updates.name,
  address: updates.address,
  eodDeadlineTime: updates.eodDeadlineTime,
  status: updates.status,
})
```

The comment above it says the literal is "REQUIRED, not redundant" and must not be
"simplified back into a passthrough" (brand-transfer / `auth_can_see_brand`
hazard). So an edit drawer that calls `useStore.updateStore({ postalCode })` will
**optimistically update the local row, persist nothing, and never error** — the
exact silent-fake-success shape the project has burned specs on. Two viable
shapes: widen the literal to five fields (and extend
[src/store/useStore.updateStore.test.ts](../src/store/useStore.updateStore.test.ts)),
or add a dedicated action following the spec-098 `setStoreWeeklyDueDow` precedent
([useStore.ts:3046](../src/store/useStore.ts)). Architect's call; AC-4 pins the
outcome either way.

### DG-1 — the disclosure block already exists and is per-channel

- `disclosureKeyForChannel(channel)` is **exported** from
  [PhoneApproveOrder.tsx:82](../src/screens/cmd/sections/phone/PhoneApproveOrder.tsx)
  and returns exactly one key: `section.approveOrder.disclosureInstacart` for
  instacart, `…disclosureCatalog` otherwise.
- It renders inside a first-class bordered block, `testID="phone-approve-disclosure"`,
  directly above the single 48px primary button
  ([lines 418-444](../src/screens/cmd/sections/phone/PhoneApproveOrder.tsx)).
- Its contract is pinned by
  [PhoneApproveOrder.test.tsx:170-172](../src/screens/cmd/sections/phone/__tests__/PhoneApproveOrder.test.tsx)
  — a single-string return. Going to a list is a deliberate contract change, not a
  refactor, and that test moves with it.
- Keys live in `src/i18n/{en,es,zh-CN}.json` under `section.approveOrder.*`
  (en.json:1276-1301). **Admin catalogs only** — the staff catalog has no
  approve-order tree and must not gain one.

### §5.5 — where the probe currently refuses

[supabase/functions/instacart-cart-link/index.ts](../supabase/functions/instacart-cart-link/index.ts)
has four arms that can stop a mint on availability grounds:

| line | condition | today |
|---|---|---|
| 374 | `!postalCode \|\| !retailerKey` | `409 retailer_unavailable` + `fallbackChannel`, no upstream call |
| 401 | retailers probe returns non-2xx | `502 upstream_error` |
| 416 | `!availableKeys.has(retailerKey)` | `409 retailer_unavailable` + `fallbackChannel` |
| (implicit) | probe returns an empty retailer list | falls into the 416 arm |

Client side, `useStore.approveAndOrder`'s `runChannel` has a one-shot
`retailer_unavailable` → info-toast → `advanceOrderApproval({ channel: fallback })`
→ re-run-on-fallback branch ([useStore.ts:3535-3561](../src/store/useStore.ts)),
guarded against recursion by `allowFallback`.

**R-3 precedence (spec 149 §1.1) is unaffected by this spec:** `vendor_order_channel()`
resolves `instacart` **only** when `order_channel='instacart'` AND
`instacart_retailer_key` is non-blank. That SQL function, its eight-row truth
table, and its pgTAP + jest pins are **frozen here** (AC-REG-2). The retailer key
stops being a *pinning* mechanism; it stays the explicit **opt-in token** and the
third dark-launch gate.

### DG-3 — the secret

`INSTACART_IDP_API_KEY` is read via `Deno.env.get` and its absence returns
`500 not_configured` *after* every caller-facing refusal
([index.ts:386-389](../supabase/functions/instacart-cart-link/index.ts)). Optional
`INSTACART_PARTNER_LINKBACK_URL` gates `landing_page_configuration`. Neither is
set today. Obtaining the key is an **owner task, external to this repo** — see the
runbook.

---

## Acceptance criteria

### A. Store ZIP edit surface (DG-2)

- [ ] **AC-1 (edit mode).** `StoreFormDrawer` gains an EDIT mode: with a store
      supplied it renders prefilled `name` / `address` / `postalCode`, an EDIT (not
      `NEW`) header badge, and a SAVE primary; with no store supplied it renders
      exactly as today. The create path's rendered output and `addStore` payload
      are unchanged (AC-REG-1).
- [ ] **AC-2 (affordance).** Each `StoresTab` row renders an EDIT affordance
      (stable testID, ≥44×44 effective hit target incl. `hitSlop`) that opens the
      drawer in edit mode for that row. The existing `ACTIVATE` / `DEACTIVATE`
      button, its confirm-on-deactivate flow, and the row's other content are
      unchanged — [StoresTab.toggle.test.tsx](../src/screens/cmd/sections/__tests__/StoresTab.toggle.test.tsx)
      passes **unmodified**.
- [ ] **AC-3 (ZIP validation, shared).** One exported pure validator is used by
      **both** the create and edit paths: trimmed input must match
      `^\d{5}(-\d{4})?$` (5-digit US ZIP, optional `+4`); blank/whitespace-only ⇒
      `null` (explicit clear, never `''`); anything else ⇒ the save is refused with
      an inline field error and **no write is issued**. Testable as a truth table:
      `'21204'`→`'21204'`, `' 21204 '`→`'21204'`, `'21204-1234'`→`'21204-1234'`,
      `''`/`'   '`→`null`, `'2120'`/`'212045'`/`'ABCDE'`/`'21204 1234'`→ invalid.
- [ ] **AC-4 (it actually persists — the ★ gotcha).** Saving an edit with ZIP
      `21204` results in **exactly one** `db.updateStore` call whose payload
      contains `postalCode: '21204'`, and a subsequent read of that store returns
      `postalCode: '21204'`. A path that updates local Zustand state without
      reaching PostgREST fails this AC. The four-field narrowing at
      [useStore.ts:3031](../src/store/useStore.ts) must be addressed explicitly
      (widen + extend `useStore.updateStore.test.ts`, or a dedicated action per the
      spec-098 precedent) — architect's shape call, pinned by a jest case either way.
- [ ] **AC-5 (list reflects the edit).** After the edit drawer closes, the
      `StoresTab` row shows the saved values without a manual reload. (The existing
      `[refresh, drawerOpen]` effect at
      [BrandsSection.tsx:1105](../src/screens/cmd/sections/BrandsSection.tsx) is the
      mechanism; confirm it fires for the edit drawer's close.)
- [ ] **AC-6 (failure is honest).** A refused write (RLS / network) reverts the
      optimistic row and surfaces `notifyBackendError` — no silent success, matching
      the spec-083 optimistic-then-revert posture already in `updateStore`.
- [ ] **AC-7 (no new backend surface).** No migration, no new RLS policy, no new
      RPC, no edge-function change for this part. The existing
      `privileged_update_stores` policy is the server-side gate; a caller who cannot
      see the store gets a 0-row update, which AC-5's re-read surfaces as drift
      rather than as a fake success.

### B. DG-1 picker disclosure

- [ ] **AC-8 (the string).** A new admin i18n key (working name
      `section.approveOrder.instacartPicker`) exists in **all three** admin
      catalogs — `src/i18n/{en,es,zh-CN}.json`. The existing i18n parity suite stays
      green. The **staff** catalogs are not touched.
- [ ] **AC-9 (copy).** English source: *"Opens in Instacart — pick your store
      there (e.g. BJ's), then check out."* It must state, unambiguously, that the
      store is selected on Instacart. es / zh-CN mirror the meaning.
- [ ] **AC-10 (render, instacart only).** The line renders inside the existing
      `phone-approve-disclosure` block, adjacent to `disclosureInstacart`, **only**
      when the resolved channel is `instacart`. For `webstaurant` / `extension` /
      `manual` the block's rendered content is byte-unchanged from today
      (`disclosureCatalog` alone).
- [ ] **AC-11 (contract, pinned).** The per-channel disclosure helper's contract is
      updated deliberately and pinned: for `'instacart'` it yields **both** the
      existing `…disclosureInstacart` key and the new picker key, in that order; for
      every other channel it yields exactly `…disclosureCatalog`. Whether that is a
      list-returning `disclosureKeysForChannel` or a sibling helper is the
      architect's call; the existing
      [PhoneApproveOrder.test.tsx:170](../src/screens/cmd/sections/phone/__tests__/PhoneApproveOrder.test.tsx)
      assertions move with the contract in the same PR.
- [ ] **AC-12 (still first-class).** The disclosure remains a bordered block
      directly above the single primary button — not a tooltip, not
      `numberOfLines={1}`, not collapsed behind a chevron. Both themes via tokens
      only; no horizontal scroll at 390px width.

### C. §5.5 retailer probe → advisory

- [ ] **AC-13 (no ZIP no longer refuses).** A null / blank `stores.postal_code`
      **skips** the retailers probe and proceeds to mint. The
      `409 retailer_unavailable` short-circuit for the null-ZIP case
      ([index.ts:374](../supabase/functions/instacart-cart-link/index.ts)) is
      removed. The response carries a non-blocking advisory marker
      (e.g. `advisory: 'no_postal_code'`).
- [ ] **AC-14 (key-not-in-market no longer refuses).** When the probe succeeds but
      the vendor's `instacart_retailer_key` is absent from the returned
      `retailer_key` set, the function **mints anyway** and returns
      `advisory: 'retailer_not_in_zip'`. Rationale recorded in the function header:
      the link is retailer-agnostic, so the key's absence predicts nothing about
      whether the link works.
- [ ] **AC-15 (probe failure no longer refuses).** A non-2xx or timeout **on the
      retailers probe** (not on `products_link`) is logged with the correlationId and
      returns `advisory: 'retailers_probe_failed'`; the mint proceeds. A non-2xx or
      timeout on `products_link` itself keeps its current `502 upstream_error` /
      `504 upstream_timeout` behavior **unchanged** — that one is a real failure.
- [ ] **AC-16 (opt-in token still required).** A blank
      `vendors.instacart_retailer_key` at mint time still refuses (the vendor has been
      de-opted out of the channel; R-3 would no longer resolve `instacart` either).
      The refusal token / status for this arm is the architect's call, but it must be
      distinguishable in logs from the two demoted arms.
- [ ] **AC-17 (advisory surfaces to the human).** When the response carries an
      advisory, the client shows a **non-blocking info toast** (new i18n key, all
      three admin catalogs) and still opens the link. It never blocks, never
      re-routes the channel, and never converts the advisory into an error toast.
- [ ] **AC-18 (deploy-skew safety — the client 409 branch stays).** The client's
      existing `retailer_unavailable` → fallback branch
      ([useStore.ts:3535-3561](../src/store/useStore.ts)) and its jest pins are
      **kept unmodified**. The web bundle and the edge function do not deploy
      atomically; during that window a new client can still receive the old 409 and
      must keep degrading gracefully.
- [ ] **AC-19 (retailer key documented as advisory).** `instacart_retailer_key`'s
      role — *advisory metadata + the explicit opt-in token, NOT a pinning
      mechanism* — is stated in the `instacart-cart-link` header comment and in the
      `VendorFormDrawer` help string (`section.vendors.instacartRetailerKeyHelp`,
      all three admin catalogs). **Default: no migration** — a `comment on column`
      change alone is not worth a prod-apply + `db-migrations-applied` cycle (OQ-4).
- [ ] **AC-20 (secret handling unchanged).** The key is still read only via
      `Deno.env.get`, never logged, never echoed, never returned. No
      `connect.instacart.com` fetch appears anywhere under `src/`. The AC-22/23/24
      posture of spec 149 (`verify_jwt = true`, `ADMIN_ROLES` + `requireAdminCaller()`,
      caller-token store scoping, 404 for a cross-store approval before any upstream
      contact) is byte-unchanged.

### D. Go-live runbook

- [ ] **AC-21.** This spec carries an ordered, executable runbook (the "Go-live
      runbook" section below): key acquisition (flagged as an owner-only external
      task), secret set + verify, ZIP entry, retailer-key discovery, per-vendor
      opt-in, end-to-end verification, and a one-action rollback. It is
      **documentation, not code** — no script is required to ship this AC, and the
      existing `scripts/smoke-instacart-cart-link.sh` is updated, not replaced.

### E. Regression group (AC-REG — nothing already shipped changes behavior)

- [ ] **AC-REG-1 (create path frozen).** `StoreFormDrawer`'s create mode renders
      and behaves identically; `StoreFormDrawer.test.tsx` passes with only
      **additive** edit-mode cases.
- [ ] **AC-REG-2 (R-3 precedence frozen).** `public.vendor_order_channel`, its
      eight-row truth table, `src/utils/orderChannel.ts` and both sets of pins
      (`orderChannel.test.ts`, the `vendor_order_channel` pgTAP arms) are
      **unchanged**. A vendor with `order_channel='instacart'` and a blank key still
      resolves to `extension`/`manual`.
- [ ] **AC-REG-3 (other channels byte-unchanged).** `extension`, `manual` and
      `webstaurant` approve paths — including the spec-138 `fillCartForVendor`
      handoff, the two extension RPCs, the `extension/` build and its vitest suite,
      the `openExternalUrl` http(s) allowlist, and the quick-order-text path — are
      unchanged, byte for byte.
- [ ] **AC-REG-4 (spec-149 approve flow otherwise unchanged).** `order_ready` emit +
      dedupe, the badge/dot color rules, the deep link, the steppers, the ★ per-each
      cost bridge, `order_approvals` RLS, the status-transition trigger, and the
      idempotency key are all untouched. The only intended behavior deltas are the
      added disclosure line (B) and the probe demotion (C).
- [ ] **AC-REG-5 (staff untouched).** `src/screens/staff/` and the staff i18n
      catalogs are not modified.
- [ ] **AC-REG-6 (desktop/tablet).** The desktop and tablet render trees are
      unchanged except for the additive `StoresTab` EDIT affordance and the
      drawer's edit mode, both of which are outside the spec-149 AC-REG-2 frozen
      tree.
- [ ] **AC-REG-7 (`app.json`).** Untouched, slug included.

### F. Tests (spec 022 tracks — the test-engineer routes by track name)

- [ ] **AC-22 (jest).** ZIP validator truth table (AC-3); drawer edit mode
      prefill / save payload / create-mode freeze (AC-1, AC-4, AC-REG-1); the
      `StoresTab` EDIT affordance opening the drawer for the right row (AC-2);
      the write actually reaching `db.updateStore` with `postalCode` (AC-4); the
      revert-on-error path (AC-6); the disclosure key contract for all four channels
      (AC-11) and the instacart-only render (AC-10); the advisory info-toast branch
      and the preserved 409 fallback branch (AC-17, AC-18).
- [ ] **AC-23 (pgTAP).** No new arms required. The existing `vendor_order_channel`
      truth-table arms and `order_approvals` arms must stay green **unmodified**
      (AC-REG-2, AC-REG-4). If OQ-4 resolves to "ship the column comment", one
      migration lands and the `db-migrations-applied` gate cycle applies.
- [ ] **AC-24 (shell smoke).** `scripts/smoke-instacart-cart-link.sh` is updated for
      the advisory posture: null-ZIP → 200 with `advisory: 'no_postal_code'` (was
      409); unknown retailer key for the ZIP → 200 with
      `advisory: 'retailer_not_in_zip'` (was 409); blank retailer key → still
      refused; non-privileged JWT → 403 with no upstream call; cross-store
      `approvalId` → 404; forced `products_link` non-2xx → 502, never `ok: true`.
      Still manual, still not wired into CI — say so in the PR.

---

## Go-live runbook (operational — documentation, not code)

Run in order. Steps marked **OWNER** cannot be done by an agent.

### 0 — Obtain the API key **(OWNER, external to this repo)**

Sign in at **docs.instacart.com** / the Instacart Developer Platform and create a
Developer Platform API key (free tier). This requires the owner's Instacart
account and acceptance of their terms; no agent can or should do it. Copy the key
once — it is not re-displayable.

*ToS reminder, unchanged and non-negotiable:* no headless, unattended or automated
checkout. The human always completes payment in their own session.

### 1 — Set the function secret

```
npx supabase secrets set INSTACART_IDP_API_KEY='<key>' --project-ref ebwnovzzkwhsdxkpyjka
npx supabase secrets list --project-ref ebwnovzzkwhsdxkpyjka     # name only — never prints the value
```

Optional: `INSTACART_PARTNER_LINKBACK_URL` (gates `landing_page_configuration`;
leave unset unless there is a real linkback destination).

Verify the function stops returning `not_configured`: any mint attempt that
previously returned `500 not_configured` should now progress past that gate.
(A secret set here only reaches the running function after step 1b — do not skip
it.)

### 1b — Deploy the spec-155 function build **(REQUIRED — not conditional)**

```
npx supabase functions deploy instacart-cart-link --project-ref ebwnovzzkwhsdxkpyjka
npx supabase functions list --project-ref ebwnovzzkwhsdxkpyjka   # confirm the new version/updated_at
```

The edge function and the web bundle **do not deploy atomically** (§4.6). Merging
this spec ships the client half; the function half only ships when this command
runs. **Run it once, unconditionally, before step 4** — do not treat it as a
fallback for step 1.

*Why this step is its own numbered line:* the deploy-skew failure is **silent by
construction**. An un-redeployed function keeps returning the pre-155
`409 retailer_unavailable` for a missing ZIP or an out-of-market key; the
deliberately preserved AC-18 client branch absorbs that 409 into an info toast
plus a channel fallback, so the operator sees "Instacart just didn't happen" with
no error to trace. Same class as the `docker restart supabase_realtime_imr-inventory`
publication gotcha — a deploy step whose omission produces no error, only absence.

### 2 — Set store ZIPs (needs this spec's DG-2 surface shipped)

Cmd UI → **Brands** → select the brand → **Stores** tab → row **EDIT** → *Postal
code* → SAVE. Re-open the drawer to confirm the value persisted (this is the
AC-4 check in human form — a value that vanishes on re-open means the write never
left the client).

With the advisory posture (part C) a missing ZIP no longer blocks minting, so this
step is **recommended, not required**. It is what makes the market warning
meaningful.

### 3 — Discover retailer keys **(OWNER or agent, needs the key)**

```
curl -sS -H "Authorization: Bearer $INSTACART_IDP_API_KEY" \
  "https://connect.instacart.com/idp/v1/retailers?postal_code=<ZIP>&country_code=US"
# ⇒ { "retailers": [ { "retailer_key": "...", "name": "...", "retailer_logo_url": "..." }, ... ] }
```

Record the `retailer_key` for BJ's and for Sam's Club **per store ZIP**. If a
vendor's retailer does not appear for that ZIP, that is now a **warning, not a
blocker** — you may still opt the vendor in, and the approve path will mint the
link with an advisory toast. Note it in the enablement log below either way.

### 4 — Per-vendor opt-in (this is the switch)

Cmd UI → **Vendors** → the vendor → **ORDER CHANNEL** = `Instacart` →
**INSTACART RETAILER KEY** = the key from step 3 → SAVE.

R-3 recap (unchanged): the channel resolves to `instacart` **only** when *both*
`order_channel='instacart'` **and** a non-blank retailer key are set. Either one
blank ⇒ the vendor stays on `extension` (the tuned cart-filler) or `manual`.

**Pilot on ONE vendor and ONE store first.** Do not flip BJ's and Sam's together.

### 5 — Verify end to end

1. Staff submits an EOD count for that store + vendor (or open an existing pending
   approval).
2. Phone notification arrives as **"Order ready to approve"** with an **accent**
   (not red) dot.
3. Tap it → Approve Order screen for that vendor and business date.
4. The disclosure block shows **both** the catalog-cost / fees line **and** the new
   picker line (AC-9).
5. Tap **APPROVE & ORDER** → Instacart opens with a shopping list carrying your
   items. If an advisory toast appears, note which one.
6. Pick your store on Instacart, check out with saved payment.
7. Return to the app → **MARK ORDERED**.
8. Confirm the `order_approvals` row for `(store, vendor, business_date)` is
   `status='ordered'` with a non-null `external_ref` and `ordered_at`.
9. Check the function logs: a correlationId, an approvalId, statuses and elapsed
   ms — and **no key, no request body, no minted URL**. The terminal success line
   carries `advisory=<token|none>`, and a failed probe carries
   `cause=timeout|parse|network`, so one grep gives the whole outcome.
10. **Deploy-skew check.** If the tap produced the "not available at this store"
    fallback toast (the AC-18 branch) instead of an Instacart link, the deployed
    function is almost certainly **pre-spec-155**: after this spec, only a *blank*
    `vendors.instacart_retailer_key` can produce a 409, and step 4 just set one.
    Confirm in the logs (`status=409 retailer_unavailable reason=blank_retailer_key`
    is the only legitimate 409) and re-run **step 1b**.

### 6 — Rollback (one action, no deploy, no migration)

Cmd UI → **Vendors** → the vendor → **ORDER CHANNEL** back to `—` (or
`Extension`) → SAVE. R-3 immediately resolves the vendor to `extension` / `manual`
and no further link is minted. Optionally clear the retailer key too.

Rows already at `status='ordered'` keep their `external_ref` (immutable at
`ordered` by the spec-149 trigger) — that is intended audit history, not drift.

### 7 — Emergency kill (all vendors at once)

Unset `INSTACART_IDP_API_KEY`. Every mint then returns `500 not_configured` and
approvals stay `pending` and retriable. Blunt, total, instant.

### Enablement log (fill in during step 3/4 — keep in this file)

| store | ZIP | vendor | retailer_key | in-market? | enabled on |
|---|---|---|---|---|---|
| _(pending owner run)_ | | | | | |

---

## In scope

- An EDIT path for existing stores that can set / correct / clear
  `stores.postal_code`, with shared 5-digit (+4) ZIP validation and create-path
  trim/null parity.
- One added Instacart-only disclosure line on the phone Approve Order screen, in
  all three **admin** catalogs.
- Demoting the `instacart-cart-link` retailer-availability probe from blocking
  (409 / short-circuit) to advisory, with a non-blocking client info toast.
- Documenting `instacart_retailer_key` as advisory metadata + opt-in token.
- The go-live runbook above, plus the updated shell smoke arms.

## Out of scope (explicitly — non-goals)

- **Recovering retailer pinning.** No such parameter exists on the IDP
  `products_link` endpoint (reconciled against live docs 2026-08-01). Nothing to
  build; a different mechanism would be a different spec.
- **MealMe or any other aggregator.** Deferred by the owner in spec 149 and still
  deferred. Do not add an abstraction "for MealMe later".
- **Headless / unattended / automated checkout, or storing vendor credentials or
  payment instruments.** Hard product boundary, unchanged.
- **Real-time Instacart pricing, availability or substitution handling.** No price
  feed on the free surface; the disclosure is still the honesty mechanism.
- **A general store-settings surface.** This adds *edit-a-store* with the fields
  the drawer already has (name / address / postal code) — not `eodDeadlineTime`,
  not `weeklyCountDueDow`, not brand transfer, not store delete. A real store
  settings screen is its own spec.
- **Changing R-3 channel precedence.** The retailer key remains required for
  `instacart` to resolve. Loosening it would silently reroute vendors away from the
  tuned cart-filler — the exact failure spec 149 pinned an eight-row truth table
  against.
- **Removing the client's `retailer_unavailable` fallback branch.** Kept for
  deploy-skew safety (AC-18).
- **A desktop/tablet Approve Order surface.** Still phone-first; unchanged.
- **Backfilling ZIPs by parsing `stores.address`.** `address` is free text and is
  deliberately never parsed (spec 149 §1.1). ZIPs are typed by a human.
- **Wiring the shell smoke into CI.** Still a repo-wide gap for
  service-token / key-dependent functions; not solved here.
- **`app.json` slug / identity drift.** Untouched (CLAUDE.md DO-NOT-AUTO-FIX).
  Nothing here touches build identifiers, store listings or push certs.

## Open questions resolved (owner, before this spec)

- Q: Accept that the Instacart link opens on a store picker instead of a pinned
  retailer? → **A: ACCEPTED.** The extra tap is fine. Do not attempt to recover
  pinning; it does not exist upstream.
- Q: How do existing stores get a postal code? → A: Add an edit path — extend the
  existing store drawer and add an EDIT affordance where stores are managed. Do
  not do it with hand-SQL.
- Q: What does accepting DG-1 require on screen? → A: One added i18n string on the
  Instacart approve path telling the admin the store is chosen on Instacart, in
  the admin catalog set.
- Q: Should the retailer-availability probe keep refusing? → A: No — keep the
  probe, demote its failure to advisory (warn + proceed to the generic link),
  since the link works regardless of which retailer is picked.
- Q: Who gets the Instacart API key? → A: The owner, from the Instacart Developer
  Platform. Explicitly an external owner task.
- Q: MealMe / headless checkout / retailer pinning? → A: Non-goals, all three.

## Open questions (non-blocking — defaults chosen so the architect is unblocked)

Each has a PM default. The owner can override any at architect review without
reshaping the contract.

- **OQ-1 — where the EDIT affordance lives.** **Default: `StoresTab` row action,
  beside ACTIVATE/DEACTIVATE**, opening the existing `StoreFormDrawer` in edit
  mode. That is the only surface where stores are managed today, and reusing the
  drawer keeps one ZIP input and one validator. Alternative the architect may
  prefer: making the row itself pressable. Either satisfies AC-2.
- **OQ-2 — how `postalCode` reaches `db.updateStore` (the ★ gotcha).** **Default:
  widen the four-field literal at [useStore.ts:3031](../src/store/useStore.ts) to
  five and extend `useStore.updateStore.test.ts`** — smaller than a new action and
  the drawer will want `name`/`address` on the same save anyway. Keep the
  `brandId`-drop comment intact. Alternative: a dedicated action per the spec-098
  `setStoreWeeklyDueDow` precedent.
- **OQ-3 — empty market (zero retailers returned for the ZIP).** **Default:
  advisory, like every other probe outcome** — coherent with DG-1, and a stale or
  partial market listing should not block an order. The architect may argue this
  one arm should stay blocking (it is the only signal that Instacart does not
  serve the market at all); if so, say which token it returns and pin it.
- **OQ-4 — `comment on column` migration for `instacart_retailer_key`.**
  **Default: no migration.** The advisory role is recorded in the edge-function
  header, the vendor-drawer help string, and this spec. A comment-only migration
  costs a prod MCP apply + a `db-migrations-applied` red window for zero runtime
  effect. Architect may overrule if it is bundled with other DDL.
- **OQ-5 — advisory transport shape.** **Default: an optional `advisory` string
  field on the existing 200 body** (`'no_postal_code' | 'retailer_not_in_zip' |
  'retailers_probe_failed'`), stable tokens, mapped client-side to one i18n string
  each. Alternative: a single boolean + a separate reason. Whatever ships, the
  tokens are stable strings and the smoke asserts them.
- **OQ-6 — one advisory string or three.** **Default: three distinct i18n
  strings**, because the operator's next action differs (type a ZIP / ignore /
  check the key). If translation load is a concern, one generic string is
  acceptable and the token still lands in the logs.
- **OQ-7 — ZIP+4.** **Default: accepted by the validator, passed through
  verbatim.** The IDP retailers endpoint takes `postal_code`; if it rejects ZIP+4
  in practice, the function may truncate to the first five digits at call time —
  but the stored value stays as typed. Confirm during the runbook's step 3.

## Dependencies

- **Spec 149** (`specs/149-eod-approve-order-pipeline.md`) and its release
  proposal (`specs/149-eod-approve-order-pipeline/reviews/release-proposal.md`) —
  DG-1/DG-2/DG-3 and the "IDP contract reconciliation" section are the source of
  this spec's scope.
- `supabase/migrations/20260801000000_vendor_order_channel.sql` — `stores.postal_code`,
  `vendors.order_channel`, `vendors.instacart_retailer_key`,
  `public.vendor_order_channel()`. **Read-only here; not modified.**
- `supabase/migrations/20260801000100_order_approvals.sql` — the approval table,
  its trigger and `create_order_approval`. **Frozen.**
- `supabase/functions/instacart-cart-link/index.ts` — the only function modified.
- `src/components/cmd/StoreFormDrawer.tsx` (+ `.test.tsx`),
  `src/screens/cmd/sections/BrandsSection.tsx` (`StoresTab`),
  `src/screens/cmd/sections/__tests__/StoresTab.toggle.test.tsx`.
- `src/lib/db.ts` — `updateStore` already accepts `postalCode`; read mappers already
  map it. No new helper expected beyond the advisory field on
  `mintInstacartCartLink`'s result type.
- `src/store/useStore.ts` — `updateStore` (the ★ narrowing) and `approveAndOrder` /
  `runChannel` (the advisory toast; the 409 branch stays).
- `src/screens/cmd/sections/phone/PhoneApproveOrder.tsx` +
  `__tests__/PhoneApproveOrder.test.tsx` — the disclosure contract.
- `src/utils/orderChannel.ts` + `orderChannel.test.ts` — **frozen** (AC-REG-2).
- `src/i18n/{en,es,zh-CN}.json` — new keys; the parity suite is the gate.
- `scripts/smoke-instacart-cart-link.sh` — updated arms (AC-24).
- External: Instacart Developer Platform (`connect.instacart.com/idp/v1`) — free
  REST API, server-side key, owner-obtained.

## Project-specific notes

- **Cmd UI section / legacy:** admin Cmd UI only. The store edit surface lands in
  the **Brands** section's Stores tab (`StoresTab` inside
  `src/screens/cmd/sections/BrandsSection.tsx`) plus the shared
  `src/components/cmd/StoreFormDrawer.tsx`. The disclosure lands in the existing
  phone screen `src/screens/cmd/sections/phone/PhoneApproveOrder.tsx`. No legacy
  admin surface exists (spec 025).
- **Which app:** this repo (admin) only. Staff (`src/screens/staff/`) is not
  modified (AC-REG-5). The customer PWA and the Chrome extension are siblings and
  are untouched (AC-REG-3).
- **Per-store or admin-global:** **per-store.** `stores` writes ride the existing
  `privileged_update_stores` policy; `order_approvals` and the edge function keep
  the spec-149 `auth_can_see_store()` + `auth_is_privileged()` posture. No new
  policy, so the spec-053 `permissive_policy_lint` probe needs no allowlist entry.
- **Edge function or PostgREST:** **both, unchanged in split.** The ZIP write is
  PostgREST via `src/lib/db.ts` under RLS. The probe demotion is inside the
  existing JWT-protected `instacart-cart-link` function (`verify_jwt = true`, NOT a
  service-token `staff-*` / `pwa-catalog` function); its `ADMIN_ROLES` +
  `requireAdminCaller()` gate and caller-token store scoping are unchanged. Client
  calls keep going through the documented `supabase.functions.invoke` path in
  `db.mintInstacartCartLink` — never a bare `fetch`. JSON only, so `escapeHtml()`
  does not apply.
- **Realtime channels touched:** **none.** No publication membership changes ⇒
  **no `docker restart supabase_realtime_imr-inventory` step** (spec 149 R-5 still
  holds; `order_approvals` remains unpublished). Stated so nobody pads the
  checklist with a no-op restart.
- **Migrations needed:** **no**, at the OQ-4 default. If OQ-4 flips, exactly one
  comment-only migration lands and the CLAUDE.md prod-apply-via-MCP +
  `db-migrations-applied` re-green sequence applies.
- **Edge functions touched:** `instacart-cart-link` (modified). Every other
  function, including the three permanent `staff-*` 410 stubs, is untouched.
- **Web/native scope:** **both.** The store edit surface is admin Cmd UI (web
  Vercel + native EAS). The approve screen is the phone tier of the same app and
  opens the link via the shared `openExternalUrl` helper on both platforms.
  Web-push delivery remains web-only, as it already is.
- **Tests (spec 022 tracks):** jest (AC-22) is the primary track; pgTAP (AC-23) is
  regression-only; shell smoke (AC-24) is updated but stays manual.
- **`app.json` slug:** untouched (`towson-inventory`), per CLAUDE.md's
  DO-NOT-AUTO-FIX rule. Nothing here touches build identifiers, app store listings
  or push certs.
- **CI:** both gates (`test.yml`, `db-migrations-applied.yml`) must be green on
  `main` before this ships. At the OQ-4 default this spec adds no migration, so the
  migration gate should never go red for it.

## Files expected to change (architect may refine)

- `specs/155-instacart-enablement.md` (this file)
- `src/components/cmd/StoreFormDrawer.tsx` — edit mode + shared ZIP validation
- `src/components/cmd/StoreFormDrawer.test.tsx` — additive edit-mode cases
- `src/screens/cmd/sections/BrandsSection.tsx` — `StoresTab` EDIT affordance
- `src/screens/cmd/sections/__tests__/` — a new `StoresTab.edit` suite (the
  existing `StoresTab.toggle.test.tsx` stays unmodified)
- `src/store/useStore.ts` — the `updateStore` narrowing (OQ-2) + the advisory toast
  branch in `runChannel`
- `src/store/useStore.updateStore.test.ts` — the `postalCode` pin
- `src/lib/db.ts` — the advisory field on `mintInstacartCartLink`'s result type
- `src/screens/cmd/sections/phone/PhoneApproveOrder.tsx` + its test — the
  disclosure contract
- `src/i18n/{en,es,zh-CN}.json` — picker disclosure, advisory string(s), the
  retailer-key help revision
- `supabase/functions/instacart-cart-link/index.ts` — advisory probe posture +
  header note
- `scripts/smoke-instacart-cart-link.sh` — updated arms

Explicitly **not** in the diff: `supabase/migrations/*` (at the OQ-4 default),
`src/utils/orderChannel.ts`, `src/screens/staff/**`, `src/screens/staff/i18n/*`,
`extension/**`, `supabase/config.toml`, `app.json`, `vercel.json`.

---

# Backend design

Verified against the tree at `74ffabe`. Every finding in the PM's "Findings from
the codebase" table was re-read at source; the ★ four-field narrowing, the
`disclosureKeyForChannel` single-string contract, the four probe arms, and the
`StoresTab.toggle.test.tsx` mock seams are all confirmed as described.

## 0. Ruling summary (the open questions, decided)

| OQ | Ruling | Where the rationale lives |
|---|---|---|
| OQ-1 | **PM default.** Row-level `EDIT` button beside ACTIVATE/DEACTIVATE. Row is NOT made pressable. | §5.2 |
| OQ-2 | **Widen the literal to five fields** (`+ postalCode`), keep the explicit-literal rule, and additionally change `updateStore`'s return type from `void` to `Promise<boolean>`. NOT a dedicated action. | §6.1 |
| OQ-3 | **Advisory**, and it does **not** get its own wire token — an empty market reuses `retailer_not_in_zip` and is distinguished by `retailers=0` in the log line. | §4.3 |
| OQ-4 | **PM default upheld — no migration.** | §1 |
| OQ-5 | **PM default.** Optional `advisory` string on the existing 200 body, three stable tokens, omitted when absent. | §3.2 |
| OQ-6 | **PM default.** Three distinct i18n strings. | §7.2 |
| OQ-7 | **PM default.** ZIP+4 accepted and stored verbatim; the edge function does **not** truncate in this spec (see §4.6 risk). | §5.1 |
| AC-16 | Blank retailer key keeps the **existing** `409 retailer_unavailable` wire token + `fallbackChannel`, plus a new non-load-bearing `reason: 'blank_retailer_key'` body field and a distinct log line. | §4.2 |
| AC-11 | `disclosureKeyForChannel` is **replaced** by `disclosureKeysForChannel(channel): string[]`. No sibling helper, no two sources of truth. | §7.1 |

## 1. Data model changes

**None. No migration in this spec.** OQ-4's default is upheld: a `comment on
column` for `vendors.instacart_retailer_key` buys zero runtime behavior and costs
a prod MCP apply plus a `db-migrations-applied` red window (CLAUDE.md "CI status
check after every push to `main`"). The advisory role is recorded durably in three
places instead — the `instacart-cart-link` header comment (AC-19), the
`section.vendors.instacartRetailerKeyHelp` string (AC-19), and this spec.

Everything the feature needs already exists and is read-only here:

- `stores.postal_code` — nullable text, `20260801000000_vendor_order_channel.sql`.
- `vendors.order_channel`, `vendors.instacart_retailer_key`,
  `public.vendor_order_channel()` — same migration. **Frozen** (AC-REG-2).
- `public.order_approvals` + its status-transition trigger + `create_order_approval`
  — `20260801000100_order_approvals.sql`. **Frozen** (AC-REG-4).

`supabase/migrations/` must be empty in this diff. If a reviewer finds a `.sql`
file in the PR, that is contract drift, not a bonus.

## 2. RLS impact

**No new table, no new policy, no policy edit.** Named for the record:

| write | policy | helper |
|---|---|---|
| `stores` UPDATE (the ZIP edit, AC-4) | `privileged_update_stores` | `auth_is_privileged()` AND `auth_can_see_brand(brand_id)` |
| `stores` SELECT (`fetchStoresIncludingInactive`) | `store_member_read_stores` | brand/store scoping, unchanged |
| `order_approvals` SELECT/UPDATE inside the edge function | spec-149 policies | `auth_can_see_store(store_id)` + `auth_is_privileged()` |

Consequences the developer must not paper over:

- A caller who cannot see the store gets a **0-row PATCH, not an error** —
  PostgREST returns 204 and `db.updateStore` resolves cleanly. This is the one
  path where "success" is not proof of persistence. §6.2 handles it with a
  post-write reconciling re-read (AC-7).
- Because no policy is added, the spec-053 `permissive_policy_lint` pgTAP probe
  needs **no allowlist entry**. Adding one would itself be drift.
- `brandId` stays non-writable through `db.updateStore` (a brand transfer trips
  `auth_can_see_brand` WITH CHECK). The widening in §6.1 does not touch this.

## 3. API contract

### 3.1 Store ZIP write — PostgREST, not RPC

Reuse `db.updateStore` verbatim. It already takes `postalCode` in its `Pick<>`
([src/lib/db.ts:119](../src/lib/db.ts)) and already maps
`updates.postalCode || null → postal_code` ([db.ts:134](../src/lib/db.ts)) under an
`!== undefined` guard, so an omitted key never clobbers. No RPC is justified: the
write is a single-table partial UPDATE with an existing policy as the gate, and an
RPC would be a new SECURITY DEFINER surface for zero benefit.

```
PATCH /rest/v1/stores?id=eq.<uuid>
body: { name?, address?, postal_code? }   // only keys present on `updates`
→ 204 (0 or 1 rows — indistinguishable; see §2)
```

### 3.2 `instacart-cart-link` — response contract after the demotion

Request is unchanged: `POST { approvalId: uuid }`, caller's JWT in
`Authorization`. Response envelope adds exactly one optional field.

**Success (200):**
```jsonc
{
  "ok": true,
  "approvalId": "<uuid>",
  "url": "https://...",
  "expiresAt": "<iso>",
  "reused": false,
  "correlationId": "<uuid>",
  "advisory": "no_postal_code" | "retailer_not_in_zip" | "retailers_probe_failed"  // OPTIONAL — omitted when the probe was clean
}
```

`advisory` is **omitted**, never `null`/`""`, when the probe ran and matched. The
three tokens are stable strings; the smoke asserts them (AC-24) and `db.ts`
type-guards them (§8).

**Full status/token table after this spec** (the frozen contract):

| condition | status | body | delta |
|---|---|---|---|
| no/blank bearer | 401 | `error: 'missing bearer token' \| 'invalid token'` | unchanged |
| non-privileged caller | 403 | `error: 'forbidden'` | unchanged |
| bad/absent `approvalId` | 400 | `error: 'approvalId required'` | unchanged |
| approval hidden by RLS / absent / vendor or store hidden | 404 | `error: 'approval not found'` | unchanged |
| `status = 'ordered'` | 409 | `error: 'already_ordered'` | unchanged |
| `channel <> 'instacart'` | 409 | `error: 'wrong_channel', channel` | unchanged |
| live `external_ref` | 200 | `reused: true`, **no `advisory`** (no probe ran) | unchanged |
| invalid lines | 400 | `error: 'invalid lines: <reason>'` | unchanged |
| **blank `instacart_retailer_key`** | **409** | `error: 'retailer_unavailable', fallbackChannel, postalCode, reason: 'blank_retailer_key'` | **AC-16 — token kept, `reason` added** |
| secret unset | 500 | `error: 'not_configured'` | unchanged |
| **ZIP null/blank** | **200** | `advisory: 'no_postal_code'` | **was 409** |
| **probe non-2xx / timeout / unparseable** | **200** | `advisory: 'retailers_probe_failed'` | **was 502 / 504** |
| **key absent from probe result (incl. empty list)** | **200** | `advisory: 'retailer_not_in_zip'` | **was 409** |
| `products_link` non-2xx | 502 | `error: 'upstream_error', upstreamStatus` | **unchanged — a real failure** |
| `products_link` 2xx without `products_link_url` | 502 | `error: 'upstream_error'` | unchanged (AC-15 no-fake-success) |
| `products_link` timeout | 504 | `error: 'upstream_timeout'` | **unchanged** |
| write-back error | 500 | `error: 'writeback_failed'` | unchanged |

## 4. Edge function changes — `instacart-cart-link`

`verify_jwt = true` — **unchanged**, and `supabase/config.toml` must stay out of
the diff. This is not a `staff-*` / `pwa-catalog` service-token function; the
inline `ADMIN_ROLES` + `requireAdminCaller()` gate mirroring
`public.auth_is_privileged()` is unchanged, as is the caller-token-only read path
(no `service_role` anywhere), the correlation-id logging discipline, and the
`escapeHtml()` N/A note (JSON-only). AC-20 is a no-touch AC.

### 4.1 New ordering of the post-validation block

Replace the current lines 364-426 with this sequence. The invariant that **every
caller-facing refusal resolves before the `INSTACART_IDP_API_KEY` check** is
preserved — that is what keeps the AC-24 smoke exercisable without a live key.

```
1. resolve postalCode  (trim → string | null)
2. resolve retailerKey (trim → string | null)
3. if (!retailerKey) → 409 retailer_unavailable  [AC-16, §4.2]      ← caller-facing
4. if (!INSTACART_IDP_API_KEY) → 500 not_configured                  ← config
5. let advisory: Advisory | null = null
6. if (!postalCode) advisory = 'no_postal_code'
   else try { probe } catch/non-2xx { advisory = 'retailers_probe_failed' }
        → if probe ok and !availableKeys.has(retailerKey)
              advisory = 'retailer_not_in_zip'
7. mint (unchanged)   ← the only arm that can still 502 / 504
8. write-back (unchanged)
9. 200 { ...existing, ...(advisory ? { advisory } : {}) }
```

### 4.2 AC-16 — the blank-key arm keeps `retailer_unavailable`

Ruled deliberately, against the temptation to mint a new token:

- AC-16 requires distinguishability **in logs**, not on the wire. The log line
  carries `reason=blank_retailer_key`; the two demoted arms never reach 409 at all,
  so the log sets are disjoint by construction.
- Reusing the token keeps the client's preserved 409 → `fallbackChannel` branch
  (AC-18) **live past the deploy window** rather than turning it into dead code
  the next cleanup spec deletes. A vendor whose key was cleared mid-flight should
  fall through to the tuned cart-filler, which is exactly what that branch does.
- Zero client change, zero new i18n key, zero change to
  `useStore.approveOrder.spec149.test.ts` or
  `db.mintInstacartCartLink.spec149.test.ts` — both of which pin this token.

One copy consequence: `section.approveOrder.retailerUnavailable` currently reads
"Instacart doesn't cover {vendor} at {store}'s ZIP…", which is now the wrong
*cause* (the only remaining trigger is a blank key). Revise the **copy** in all
three admin catalogs; **do not rename the key** (§7.2).

Body shape for this arm:
`{ ok:false, error:'retailer_unavailable', fallbackChannel, postalCode, reason:'blank_retailer_key', correlationId }`.
`reason` is additive and MUST NOT be consumed by the client — `db.ts` ignores it.

### 4.3 OQ-3 — empty market is advisory and shares a token

A probe that returns `{ "retailers": [] }` already falls into the
`!availableKeys.has(retailerKey)` arm. It stays there and returns
`advisory: 'retailer_not_in_zip'`. Rationale: with no retailer pinning, an empty
market and a missing retailer produce the **same operator action** (proceed; if it
repeats, check the ZIP), so a fourth wire token and a fourth translated string buy
nothing at the UI. Distinguishability is preserved where it matters — the log line
for the probe arm MUST include the retailer count:

```
instacart-cart-link cid=<id> approval=<id> advisory=retailer_not_in_zip retailers=<n> ms=<n>
```

`retailers=0` is the "Instacart does not serve this market" signal, and the runbook
step 3 curl is the human confirmation. No ZIP, no key, no URL, no request body in
any log line — unchanged discipline.

### 4.4 Probe timeout budget

`idpFetch` gains an optional third arg: `idpFetch(url, init, timeoutMs = UPSTREAM_TIMEOUT_MS)`.
Add `const RETAILERS_PROBE_TIMEOUT_MS = 3_000;`. The retailers probe uses the
3 s budget; `products_link` keeps the 10 s `UPSTREAM_TIMEOUT_MS`.

Justification: the probe's result no longer gates correctness, so a hung probe must
not spend a third of the caller's patience on advice. Without this, worst-case
latency after the demotion becomes 10 s (probe) + 10 s (mint) ≈ 20 s on a path that
previously bailed at 10 s. With it, the ceiling is ~13 s.

**The probe's `UpstreamTimeout` must NOT reach the outer catch.** Today
`idpFetch`'s abort throws through to the `catch (e)` at line 502 and becomes a
`504 upstream_timeout`. Wrap the entire probe — fetch, `.json()`, and the
`availableKeys` construction — in its own `try { } catch { advisory = 'retailers_probe_failed'; }`.
A probe timeout that still produced a 504 is an AC-15 failure.

**★ Post-review amendment (backend-architect S4) — the budget must cover the
BODY READ.** The spec-149 `idpFetch` cleared its abort timer in a `finally` as
soon as `fetch` resolved, i.e. at **response headers**; the subsequent
`await res.json()` then ran with **no deadline**. An upstream that answers 200 and
stalls the body therefore hung the *advisory* probe indefinitely and took the mint
with it — §11 risk 2 arriving through the body read instead of the fetch — and
voided the 10 s `products_link` budget the same way. The ~13 s ceiling above was
not actually guaranteed.

Fix (both call sites, since the shape is inherited): `idpFetch` returns a small
handle `{ res, json(), done() }` instead of a bare `Response`. The
`AbortController` and its timer stay alive across `json()`, which maps an abort to
`UpstreamTimeout` and anything else to a new `UpstreamParseError`; `done()` (called
from a `finally`) clears the timer and discards an unread body. Consequences:

- the probe's stalled body aborts at 3 s and lands in the probe's own catch ⇒
  `advisory: 'retailers_probe_failed'`, mint proceeds (AC-15 unchanged);
- a stalled `products_link` body aborts at 10 s and reaches the outer catch ⇒
  `504 upstream_timeout`, exactly as §3.2 already specifies for that arm. An
  *unparseable* `products_link` body still degrades to the missing-`products_link_url`
  `502` — the `UpstreamTimeout` is deliberately re-thrown, everything else is not.

Pinned by smoke arm 11 (a stub that sends 200 headers then holds the body open):
200 + `advisory: 'retailers_probe_failed'` **within** the ceiling.

### 4.5 Header comment (AC-19)

Rewrite the `DRIFT #3` block. It currently says the escalation is open and that
`instacart_retailer_key` "is the key the §5.5 availability probe requires to
resolve … before the channel is offered at all" — both are now false. The
replacement must state, in the function header:

1. DRIFT #3 was **escalated and ACCEPTED by the owner** (spec 155). The minted
   link opens Instacart's shopping-list page; the admin picks the retailer. The
   screen discloses this (`section.approveOrder.instacartPicker`).
2. `vendors.instacart_retailer_key` is **advisory metadata + the explicit opt-in
   token, NOT a pinning mechanism.** Because the link is retailer-agnostic, the
   key's absence from a market listing predicts nothing about whether the link
   works — which is why §5.5's probe is advisory (spec 155 AC-14).
3. R-3 precedence is unchanged: `instacart` resolves only when
   `order_channel='instacart'` AND the key is non-blank. The key is still load-
   bearing — as a switch, not as a pin.

### 4.6 Deploy step — flag it like the realtime gotcha

**The edge function and the web bundle do not deploy atomically.** The function
must be redeployed explicitly:

```
npx supabase functions deploy instacart-cart-link --project-ref ebwnovzzkwhsdxkpyjka
```

This is a **deploy step, not a runtime concern** — same class as the
`docker restart supabase_realtime_imr-inventory` publication gotcha, and the same
class as the CLAUDE.md edge-runtime bind-mount note when testing locally. Until
that command runs, prod keeps returning the old 409s; AC-18's preserved client
branch is what makes that window safe. Put the command in the PR description.

ZIP+4 (OQ-7): the function passes `postal_code` through
`encodeURIComponent(postalCode)` verbatim. If `21204-1234` is rejected by
`/idp/v1/retailers` in the field, the arm now degrades to
`advisory: 'retailers_probe_failed'` and **still mints** — so the failure mode is
a toast, not a blocked order. No truncation logic in this spec; confirm during
runbook step 3 and open a follow-up only if it actually bites.

## 5. Frontend contracts (the new/changed surfaces)

### 5.1 New pure module — `src/utils/postalCode.ts` (AC-3)

Precedent: `src/utils/orderChannel.ts` — a small, dependency-free, jest-pinned
pure module shared by more than one caller. No i18n import, no React.

```ts
export type PostalCodeParse =
  | { ok: true;  value: string | null }   // null = explicit clear
  | { ok: false; value: null };

/** Trim; '' | whitespace-only ⇒ ok/null. Otherwise must match
 *  /^\d{5}(-\d{4})?$/ ⇒ ok/<trimmed>. Anything else ⇒ ok:false. */
export function parsePostalCode(raw: string | null | undefined): PostalCodeParse;
```

Truth table (AC-3, pinned verbatim in jest):
`'21204'`→ok/`'21204'` · `' 21204 '`→ok/`'21204'` · `'21204-1234'`→ok/`'21204-1234'` ·
`''`→ok/`null` · `'   '`→ok/`null` · `undefined`/`null`→ok/`null` ·
`'2120'`, `'212045'`, `'ABCDE'`, `'21204 1234'`, `'21204-12'`→`ok:false`.

`ok:false` ⇒ **no write is issued** and an inline field error renders. Never
produce `''` — `null` is the explicit clear (matches `db.updateStore`'s
`|| null` and the spec-149 R-4 semantics already pinned in
`StoreFormDrawer.test.tsx`).

**Deliberate, spec-authorized delta on the create path:** create currently accepts
any text (`'ABCDE'` would have been stored). AC-3 requires the shared validator on
*both* paths, so create now refuses an invalid ZIP. This is the only behavioral
change to create mode and it does not contradict AC-REG-1 — every existing case in
`StoreFormDrawer.test.tsx` feeds either a valid ZIP or blank. **Do not fold ZIP
validity into the `n/1 required valid` counter** — that string must stay
byte-identical (`'0/1 required valid'` / `'1/1 required valid'` are asserted).

### 5.2 `StoreFormDrawer` — edit mode (AC-1, AC-REG-1)

Props gain **one optional field**; everything else is unchanged.

```ts
interface Props {
  visible: boolean;
  onClose: () => void;
  brandId: string;             // still required — create needs it for RLS
  brandName?: string;
  /** Spec 155 — present ⇒ EDIT mode; absent/null ⇒ CREATE mode (unchanged). */
  store?: Store | null;
}
```

| aspect | create (frozen) | edit (new) |
|---|---|---|
| badge | `NEW` | `EDIT` |
| chrome title | `new-store` | `store.name` (fallback `store.id`) |
| primary label | `CREATE  ⌘⏎` | `SAVE  ⌘⏎` (submitting → `SAVING…`, both) |
| sheet `accessibilityLabel` | `New store` | `Edit store` |
| prefill | all `''` | `store.name` / `store.address ?? ''` / `store.postalCode ?? ''` |
| action | `addStore({...})` | `await updateStore(store.id, { name, address, postalCode })` |
| success toast | `Created store` | `Saved store` — **only when the write succeeded** |
| on failure | n/a | drawer **stays open**, input preserved; `notifyBackendError` already toasted from the store |

Reset effect: change the dependency from `[visible]` to `[visible, store?.id]` and
seed from `store` when present. Keep the `submitting` reset.

`⌘⏎` / `⌘S` / `Esc` handler: unchanged; it calls `handleSaveRef.current()`, which
now branches on mode.

**No i18n keys for this drawer.** It is entirely hardcoded English today
(`Postal code (optional)`, `CREATE  ⌘⏎`, …); the inline ZIP error string
(`Enter a 5-digit ZIP (optionally +4), or leave blank.`) is hardcoded to match its
neighbours. Reviewers: this is intentional consistency, not a missed key. A future
Cmd-drawer i18n pass is its own spec.

Required-field gate stays `name.trim().length > 0` in both modes.

### 5.3 `StoresTab` — the EDIT affordance (AC-2, AC-5, OQ-1)

Row action, beside the existing toggle. The row itself is **not** made pressable:
the row already holds two interactive children, and wrapping it would create
nested-touch ambiguity and put `StoresTab.toggle.test.tsx` at risk — that file must
pass **unmodified** (AC-2).

```
testID:            store-edit-<store.id>
accessibilityRole: "button"
accessibilityLabel: `Edit store ${s.name}`
label text:        EDIT
hitSlop:           { top: 11, bottom: 11, left: 8, right: 8 }   // ≥44×44 effective
```

Placement: immediately **before** the ACTIVATE/DEACTIVATE button so the
consequential action stays right-most. Style mirrors the toggle's bordered
secondary button (no new tokens).

Drawer state — **two separate pieces of state, deliberately**:

```ts
const [drawerOpen, setDrawerOpen] = React.useState(false);      // CREATE — unchanged
const [editStore, setEditStore]  = React.useState<Store | null>(null);  // EDIT — new
```

The existing `React.useEffect(..., [refresh, drawerOpen])` at
[BrandsSection.tsx:1105](../src/screens/cmd/sections/BrandsSection.tsx) keeps its
current dependency array **verbatim**.

**Architect override of the AC-5 parenthetical.** The PM asked to "confirm it
fires for the edit drawer's close". It would — and that is precisely the problem:
`useStore.updateStore` is fire-and-forget today, so a refetch triggered by the
close races the in-flight PATCH and can read the pre-write value, flickering the
row back with nothing left to correct it. That is the exact race the spec-094
comment at [BrandsSection.tsx:1119-1125](../src/screens/cmd/sections/BrandsSection.tsx)
documents for the toggle. AC-5's *normative* text ("the row shows the saved values
without a manual reload") is met by a deterministic sequence instead:

```
onSaved(patch) →  setStores(prev => prev.map(...patch))   // instant, spec-094 setStatus precedent
onClose()      →  editStore = null                        // does NOT hit the [refresh, drawerOpen] effect
                  then await-sequenced refresh() from the drawer's resolved write (§6.1)
```

Concretely: the drawer `await`s `updateStore` (now promise-returning, §6.1) and
only then calls `onSaved` + `onClose`; `StoresTab`'s edit-close handler applies the
optimistic patch and calls `refresh().catch(...)` using the same error handling as
the mount effect. Because the write has already settled, the re-read is the
authoritative reconciliation AC-7 asks for — including the RLS 0-row case, where
the row snaps back to the server value with no fake success.

### 5.4 `PhoneApproveOrder` disclosure (AC-10, AC-11, AC-12)

See §7.1 for the helper contract. Render:

```tsx
<View testID="phone-approve-disclosure" style={{ ...existing, gap: 6 }}>
  {disclosureKeysForChannel(channel).map((k) => (
    <Text key={k} style={[PhoneType.body, { color: C.fg2 }]}>{T(k)}</Text>
  ))}
</View>
```

- **No per-line testIDs** — they would mutate the non-instacart render tree, which
  AC-10 freezes. Assert with `toHaveTextContent` on the block.
- `gap: 6` is visually inert for the single-child (non-instacart) case.
- Still a bordered block directly above the single 48px primary button; no
  `numberOfLines`, no chevron, tokens only (AC-12). At 390px the two lines wrap
  vertically — no horizontal scroll.

## 6. `src/store/useStore.ts` impact

### 6.1 ★ OQ-2 — widen the literal to five fields, and return a promise

**Ruling: widen. Not a dedicated action.** Rationale, decisively:

- The spec-098 `setStoreWeeklyDueDow` precedent exists because
  `weeklyCountDueDow` is a **standalone control on a different surface**, saved by
  itself. Here the drawer saves `name` + `address` + `postalCode` as **one form
  submission**. A dedicated action would mean two PATCHes, two revert snapshots,
  and a genuine partial-failure state (name saved, ZIP not) with no defined
  recovery. That is worse than the thing the precedent protects against.
- The hazard the `useStore.ts:3024-3030` comment guards is a **passthrough that
  reintroduces `brandId`**. Adding one explicitly-named field keeps the literal
  explicit; it does not become a passthrough. The comment stays and gets one
  sentence extending the rule to "name every field; never spread `updates`".
- `db.updateStore` already accepts `postalCode` and already guards on
  `!== undefined`, so an omitted key still cannot clobber. `setStatus`'s
  `updateStore(id, { status })` call remains a single-column PATCH.

```ts
db.updateStore(id, {
  name: updates.name,
  address: updates.address,
  eodDeadlineTime: updates.eodDeadlineTime,
  status: updates.status,
  postalCode: updates.postalCode,   // spec 155 — 5th named field, NOT a passthrough
})
```

`weeklyCountDueDow` deliberately stays **out** of the literal — `setStoreWeeklyDueDow`
owns it and nothing in this spec's UI writes it.

**Second, smaller change — the return type** ([useStore.ts:557](../src/store/useStore.ts)):

```ts
updateStore: (id: string, updates: Partial<Store>) => Promise<boolean>;
```

Resolves `true` when the write settled, `false` after the revert + `notifyBackendError`.
**It never rejects**, so existing fire-and-forget call sites (`StoresTab.setStatus`)
are unchanged and cannot produce an unhandled rejection. This is what lets the
drawer (a) toast success only on success, (b) keep itself open with the operator's
input intact on failure, and (c) sequence the reconciling re-read (§5.3). Only two
production call sites exist; both were checked.

Optimistic-then-revert posture is otherwise **unchanged** — `prevStores` /
`prevCurrentStore` snapshot, local `set()` first, revert + `notifyBackendError` on
error (AC-6).

### 6.2 `runChannel` — the advisory toast (AC-17), the 409 branch frozen (AC-18)

Inside the `if (channel === 'instacart')` arm, in the `res.ok` branch, **before**
`openExternalOrderUrl(res.url)`:

```ts
if (res.advisory) {
  Toast.show({
    type: 'info',                                   // never 'error', never notifyBackendError
    text1: translate(locale, ADVISORY_TOAST_KEY[res.advisory], {
      vendor: vendor.vendorName || '',
      store: get().currentStore?.name || '',
    }),
    visibilityTime: 5000,
  });
}
```

Toast first, then open — on web `openExternalOrderUrl` may hand the tab away.
The link **always** opens; no re-route, no channel change, no `allowFallback`
consumption.

Module-scope map next to the other spec-149 helpers:

```ts
const ADVISORY_TOAST_KEY: Record<InstacartAdvisory, string> = {
  no_postal_code:         'section.approveOrder.advisoryNoPostalCode',
  retailer_not_in_zip:    'section.approveOrder.advisoryRetailerNotInZip',
  retailers_probe_failed: 'section.approveOrder.advisoryProbeFailed',
};
```

An unrecognized token can never reach this map — `db.ts` type-guards it to
`undefined` (§8).

**Frozen (AC-18):** the `res.error === 'retailer_unavailable' && allowFallback`
branch at [useStore.ts:3535-3561](../src/store/useStore.ts), its info toast, its
`advanceOrderApproval({ channel: fallback })`, the recursion guard, and both pinning
tests in `useStore.approveOrder.spec149.test.ts` are **byte-unchanged**. Only the
*copy* of `section.approveOrder.retailerUnavailable` changes (§7.2) — the key, the
branch and the assertions do not.

## 7. Helper + i18n contracts

### 7.1 `disclosureKeysForChannel` (AC-11)

**Replace** the single-string helper; do not add a sibling. Two sources of truth
for the same disclosure is exactly the drift this project keeps paying for.

```ts
/** Spec 155 AC-11 — instacart yields the fee/markup disclosure AND the
 *  store-picker disclosure, in that order. Every other channel yields exactly
 *  the catalog-cost line. Order is part of the contract. */
export function disclosureKeysForChannel(channel: OrderChannel): string[] {
  return channel === 'instacart'
    ? ['section.approveOrder.disclosureInstacart', 'section.approveOrder.instacartPicker']
    : ['section.approveOrder.disclosureCatalog'];
}
```

`disclosureKeyForChannel` is deleted. Its only importers are the screen and its
test; both move in the same PR.

> **Cross-spec coordination (not a blocker).** `specs/156-export-order-recording.md`
> (Status: READY_FOR_ARCH, not yet built) names `disclosureKeyForChannel` in its
> AC-REG-4 freeze list. 155 is ahead in the pipeline; 156's AC-REG-4 must be
> re-worded to `disclosureKeysForChannel` when it reaches design. Surfacing so the
> PM catches it rather than a reviewer discovering a phantom regression.

### 7.2 i18n — admin catalogs only (AC-8, AC-9, AC-17, AC-19)

`src/i18n/{en,es,zh-CN}.json`. All three, same key set — `i18n.test.ts`'s parity
assertion is the gate. **`src/screens/staff/i18n/*` is not touched** (AC-REG-5).

**New** under `section.approveOrder` (place adjacent to `disclosureCatalog`, en.json:1296):

| key | en source |
|---|---|
| `instacartPicker` | `Opens in Instacart — pick your store there (e.g. BJ's), then check out.` |
| `advisoryNoPostalCode` | `No ZIP set for {store} — the Instacart market check was skipped. Your list still opens.` |
| `advisoryRetailerNotInZip` | `{vendor} isn't listed for {store}'s ZIP on Instacart. Your list still opens — pick a store there.` |
| `advisoryProbeFailed` | `Couldn't check Instacart's store list. Your list still opens — pick your store there.` |

`instacartPicker` is verbatim AC-9 and must state unambiguously that the store is
selected on Instacart. es / zh-CN mirror the meaning (not a literal gloss). The
three advisory strings all accept `{vendor}` and `{store}` so one call site handles
them; a string may ignore a placeholder.

**Revised copy, same keys** (no renames, no test churn):

| key | why | en source |
|---|---|---|
| `section.approveOrder.retailerUnavailable` | its only remaining trigger is a blank key, not ZIP coverage (§4.2) | `Instacart isn't set up for {vendor} yet. Falling back to the cart-filler.` |
| `section.vendors.instacartRetailerKeyHelp` | AC-19 | `IDP retailer slug, e.g. sams_club — the opt-in token for the Instacart channel. Advisory only: it does not pin the store. Blank keeps the cart-filler.` |

`VendorFormDrawer.tsx:497` already renders that hint; no component change there.

## 8. `src/lib/db.ts` surface

No new helper. Two additive changes to the existing `mintInstacartCartLink`
contract:

```ts
export type InstacartAdvisory =
  | 'no_postal_code'
  | 'retailer_not_in_zip'
  | 'retailers_probe_failed';

export type InstacartCartLinkResult =
  | { ok: true;  url: string; expiresAt: string | null; reused: boolean;
      advisory?: InstacartAdvisory }                                   // ← added
  | { ok: false; error: string; fallbackChannel?: OrderChannel; postalCode?: string | null };

// local, module-scope, sits beside the existing isOrderChannel guard
function isInstacartAdvisory(v: unknown): v is InstacartAdvisory;
```

In the `ok: true` return: `advisory: isInstacartAdvisory(data?.advisory) ? data.advisory : undefined`.
Unknown/future tokens are **dropped**, not surfaced raw — same defensive posture as
`isOrderChannel(body.fallbackChannel)` at [db.ts:2605](../src/lib/db.ts), and it is
what makes the `ADVISORY_TOAST_KEY` lookup total.

The `ok: false` variant is **unchanged** — `reason: 'blank_retailer_key'` (§4.2) is
deliberately not surfaced to the client; it is a logs/smoke affordance.

Transport stays `supabase.functions.invoke` under `useInflight.track({kind:'write'})`
— the documented CLAUDE.md exception (needs structured error context), never a bare
`fetch`, never `callEdgeFunction`. **snake_case → camelCase:** none required — the
function's body is already camelCase (`expiresAt`, `fallbackChannel`, `advisory`),
so no `mapItem`-style helper is added. `db.updateStore`'s existing
`postalCode → postal_code` mapping at [db.ts:134](../src/lib/db.ts) is the only
case-conversion in this spec and it is unchanged.

## 9. Realtime impact

**None, and no restart step.**

- No `supabase_realtime` publication membership change ⇒ **do NOT add
  `docker restart supabase_realtime_imr-inventory`** to any checklist. Spec 149's
  R-5 still holds (`order_approvals` stays unpublished). Called out explicitly so
  nobody pads the runbook with a no-op restart.
- The `stores` UPDATE rides whatever publication membership `stores` already has
  on the `store-{id}` channel; membership is untouched either way. The admin
  `useRealtimeSync` 400ms-debounced reload may fire for the ZIP edit — harmless,
  and §5.3's explicit `refresh()` is what AC-5 actually depends on. Do not add a
  realtime subscription for `StoresTab`; it holds tab-local state by design
  (spec 083).
- `brand-{id}` is untouched.

The one **deploy** step in this spec is §4.6's function redeploy — same "flag it as
deploy, not runtime" treatment as the publication gotcha.

## 10. Test plan (spec 022 tracks)

### Track 1 — jest (AC-22, the primary track)

| file | cases |
|---|---|
| `src/utils/postalCode.test.ts` **(new)** | the full §5.1 truth table, incl. `null`/`undefined` input and `'21204-12'` |
| `src/components/cmd/StoreFormDrawer.test.tsx` | **additive only.** edit-mode prefill (name/address/ZIP); `EDIT` badge + `SAVE  ⌘⏎`; save calls `updateStore(id, {name,address,postalCode})` **once**; invalid ZIP ⇒ inline error, **zero** `updateStore` calls; blank ⇒ `postalCode: null`; failed write (`updateStore` resolves `false`) ⇒ drawer stays open, no success toast. Mock gains `updateStore` alongside `addStore`. **All seven existing create cases stay green unmodified** (AC-REG-1) |
| `src/screens/cmd/sections/__tests__/StoresTab.edit.test.tsx` **(new)** | `store-edit-<id>` exists per row with the right a11y label; pressing it opens the drawer with **that** row's store; the drawer's `onSaved` patches the row in place; `refresh()` re-called after the resolved write |
| `src/screens/cmd/sections/__tests__/StoresTab.toggle.test.tsx` | **unmodified, must stay green** (AC-2) |
| `src/store/useStore.updateStore.test.ts` | `postalCode: '21204'` reaches `db.updateStore` (the ★ AC-4 pin); explicit `null` reaches it too; `weeklyCountDueDow` is still **dropped**; revert + `notifyBackendError` on error and the action resolves `false`; resolves `true` on success |
| `src/lib/db.updateStore.test.ts` | additive: `postalCode → postal_code` and `null → null` mapping arms |
| `src/lib/db.mintInstacartCartLink.spec149.test.ts` | additive: `advisory` passthrough on a 200; unknown advisory token dropped to `undefined`; absent advisory ⇒ `undefined`. **All existing refusal cases unmodified** |
| `src/store/useStore.approveOrder.spec149.test.ts` | additive: each of the three advisories fires **one info toast** and still opens the link and still re-reads the approval; **no** advisory ⇒ no extra toast. **The two `retailer_unavailable` fallback cases stay byte-unchanged** (AC-18) |
| `src/screens/cmd/sections/phone/__tests__/PhoneApproveOrder.test.tsx` | the `disclosureKeyForChannel` describe block **moves** to `disclosureKeysForChannel`: instacart ⇒ `['…disclosureInstacart','…instacartPicker']` in that order; the other three ⇒ `['…disclosureCatalog']`. Render: the block contains both lines for instacart, exactly the catalog line otherwise |
| `src/i18n/i18n.test.ts` | unmodified; its parity assertion is the AC-8 gate |
| `src/utils/orderChannel.test.ts` | **unmodified, frozen** (AC-REG-2) |

### Track 2 — pgTAP (AC-23)

**No new arms, no new file.** The `vendor_order_channel` eight-row truth table and
the `order_approvals` arms must stay green **unmodified** (AC-REG-2, AC-REG-4). No
migration ships (§1), so the `db-migrations-applied` gate has nothing to react to
and must not go red for this spec.

### Track 3 — shell smoke (AC-24, manual, not in CI)

Update `scripts/smoke-instacart-cart-link.sh` — **update, do not replace**:

- Step 3's `409 retailer_unavailable` acceptance branch is now the **blank-key**
  outcome only; assert `reason":"blank_retailer_key"` alongside `fallbackChannel`.
- New arm: store with null ZIP ⇒ **200** with `"advisory":"no_postal_code"` (was 409).
- New arm: vendor key not in the ZIP's market ⇒ **200** with
  `"advisory":"retailer_not_in_zip"` (was 409).
- New arm: `INSTACART_IDP_BASE_URL` pointed at a 500 stub for `/idp/v1/retailers`
  ⇒ **200** with `"advisory":"retailers_probe_failed"` — and explicitly **not**
  502/504.
- Unchanged arms: 401 no-auth, 403 non-privileged (no upstream call), 404
  cross-store, forced `products_link` non-2xx ⇒ **502** and never `ok:true`.
- The header's step-1 guidance ("a MISSING key ⇒ leave order_channel NULL; DO NOT
  set the column") is now wrong — a missing key is a warning, not a blocker.
  Rewrite those two `note` lines.
- Keep the "NOT WIRED INTO CI / manual pre-post-deploy step" banner, and repeat it
  in the PR description.

## 11. Risks and tradeoffs

**Critical / must-not-get-wrong**

1. **The ★ silent-fake-success.** If the developer ships the edit drawer without
   the §6.1 widening, the row updates locally, nothing persists, nothing errors,
   and the runbook's step 2 "re-open to confirm" is the only thing that catches
   it. The `useStore.updateStore.test.ts` `postalCode` case is the pin; treat a
   missing pin as a Critical at review.
2. **Probe timeout leaking to 504.** If the probe's `UpstreamTimeout` is not
   caught locally (§4.4), a slow *advisory* probe kills a mint that would have
   succeeded — the demotion's whole point, inverted. Explicit try/catch around the
   entire probe block, not just the fetch.
3. **Deploy skew.** Web bundle and edge function ship separately (§4.6). New
   client + old function ⇒ 409s the preserved AC-18 branch handles. Old client +
   new function ⇒ 200s with an `advisory` field an older `db.ts` ignores — also
   safe, because the field is optional and additive. Both directions were checked;
   deploy order does not matter, but the function redeploy must actually happen or
   nothing in part C takes effect.

**Should-watch**

4. **Latency.** Worst case after the demotion is 3 s probe + 10 s mint ≈ 13 s
   (was 10 s hard-stop). On a cold Deno start add ~0.5-1 s. The screen's
   `approvalBusy` already disables the primary button for the duration; no
   spinner-timeout work is in scope.
5. **RLS 0-row silent no-op.** PostgREST returns 204 for a PATCH that matches
   nothing. The §5.3 post-write `refresh()` is the only thing that surfaces it. If
   the developer drops that re-read for simplicity, AC-7 is unmet.
6. **Create-path validation delta** (§5.1) — the one intentional behavior change
   inside an AC-REG-1-frozen surface. Called out here so review reads it as
   designed, not as drift.
7. **`updateStore` return-type change.** Widening `void → Promise<boolean>` touches
   a shared action. Both production call sites were checked; the promise never
   rejects. The risk is a future contributor `await`ing it and assuming a rejection
   on failure — the JSDoc at [useStore.ts:557](../src/store/useStore.ts) must say
   "resolves false; never rejects".
8. **Seed dataset / performance.** No new query, no new index, no new table.
   `fetchStoresIncludingInactive` is unchanged and already brand-filtered
   client-side over a handful of rows; the 286 KB seed is irrelevant here.
9. **Copy drift on `retailerUnavailable`.** Revising the string without renaming the
   key is deliberate (§7.2) — a rename would touch AC-18's frozen branch. Verify no
   test asserts that string's *text* (none does today).

**Accepted, not mitigated**

10. ZIP+4 pass-through (OQ-7) may make the probe 4xx in the field; it degrades to
    an advisory toast rather than a blocked order (§4.6).
11. The shell smoke stays manual — the repo-wide gap for key-dependent functions is
    not solved here, and a green CI is not evidence these arms ran.

## 12. Ownership split

**backend-developer**
`supabase/functions/instacart-cart-link/index.ts` (§4 in full — ordering, advisory
arms, probe timeout + local catch, `reason` field, header rewrite);
`scripts/smoke-instacart-cart-link.sh` (§10 Track 3);
`src/lib/db.ts` (§8 — `InstacartAdvisory`, the guard, the result type).
No migration, no `config.toml`.

**frontend-developer**
`src/utils/postalCode.ts` (new) + its test;
`src/components/cmd/StoreFormDrawer.tsx` + `.test.tsx`;
`src/screens/cmd/sections/BrandsSection.tsx` (`StoresTab`) + the new
`StoresTab.edit.test.tsx`;
`src/store/useStore.ts` (§6.1 widening + return type + JSDoc at :557; §6.2 advisory
toast) + `useStore.updateStore.test.ts` + the additive
`useStore.approveOrder.spec149.test.ts` cases;
`src/screens/cmd/sections/phone/PhoneApproveOrder.tsx` + its test (§7.1);
`src/i18n/{en,es,zh-CN}.json` (§7.2);
`src/lib/db.updateStore.test.ts` + `src/lib/db.mintInstacartCartLink.spec149.test.ts`
additive arms.

Shared seam: the `advisory` token set and `InstacartAdvisory` — backend owns the
producer, frontend owns `ADVISORY_TOAST_KEY`. Both must land in the same PR.

---

# Files changed — BACKEND half (part C, §4 + §10 Track 3)

Scope as dispatched: the edge function and the shell smoke only. The frontend
half (parts A, B, and the §6/§7 client seams) landed in parallel and lists its
own files.

## Edge functions

- `supabase/functions/instacart-cart-link/index.ts`
  - Header `DRIFT #3` block rewritten (§4.5 / AC-19): the escalation is recorded
    as **ACCEPTED by the owner**, and `vendors.instacart_retailer_key` is now
    documented as *advisory metadata + the explicit opt-in token, NOT a pinning
    mechanism*, with R-3 precedence explicitly restated as unchanged.
  - New `Advisory` union type (`no_postal_code | retailer_not_in_zip |
    retailers_probe_failed`) — §3.2 / OQ-5.
  - New `RETAILERS_PROBE_TIMEOUT_MS = 3_000`; `idpFetch` gained an optional
    third `timeoutMs` arg defaulting to `UPSTREAM_TIMEOUT_MS` (§4.4).
    `products_link` keeps the 10 s budget.
  - Post-validation block reordered to §4.1: blank-key refusal → secret gate →
    advisory probe → mint → write-back.
  - **AC-16** — the blank-`instacart_retailer_key` arm keeps the `409
    retailer_unavailable` wire token + `fallbackChannel` (AC-18 deploy-skew) and
    gains a non-load-bearing `reason: 'blank_retailer_key'` body field plus a
    distinct log line.
  - **AC-13** — a null/blank `stores.postal_code` now **skips the probe
    entirely** and mints with `advisory: 'no_postal_code'` (was a 409).
  - **AC-14 / OQ-3** — a key absent from the market listing, *and* an empty
    market, both mint with `advisory: 'retailer_not_in_zip'`; the log line
    carries `retailers=<n>` so `retailers=0` remains the "Instacart does not
    serve this market" signal (§4.3).
  - **AC-15** — probe non-2xx / timeout / unparseable body mints with
    `advisory: 'retailers_probe_failed'` (was 502). The entire probe — fetch,
    `.json()`, and the `availableKeys` construction — is wrapped in its own
    `try/catch` so a probe `UpstreamTimeout` can **never** reach the outer 504
    arm (§11 risk 2).
  - 200 body spreads `advisory` only when set — omitted, never `null`/`""`.
  - `products_link` 502 / 504 / missing-`products_link_url` arms, the auth gate,
    the caller-token store scoping, the idempotency reuse path and the
    correlation-id log discipline are **unchanged**.
  - **★ Post-review fix round (backend-architect S4 / M1 / M2):**
    - **S4** — `idpFetch` now returns `{ res, json(), done() }` instead of a bare
      `Response`, and the abort deadline covers the **body read** on BOTH call
      sites (the 3 s probe and the 10 s `products_link` mint). See the §4.4
      amendment. New `UpstreamParseError` class; `isAbortError()` helper
      (`AbortError` + `TimeoutError`). Wire behaviour per §3.2 is unchanged:
      probe stall ⇒ advisory, mint stall ⇒ `504`, unparseable mint body ⇒ the
      existing missing-url `502`.
    - **M1** — the terminal success log line now carries
      `advisory=<token|none>`, so an outcome and its advice are one grep, not a
      `cid` join. Still no ZIP / key / URL in any log line.
    - **M2** — the probe's catch adds `cause=timeout|parse|network` beside the
      pre-existing `timeout=<bool>` token.

## Shell smokes (spec 022 Track 3)

- `scripts/smoke-instacart-cart-link.sh` — **updated, not replaced** (AC-24).
  - Header rewritten for the advisory posture; the stale step-1 guidance ("a
    MISSING key ⇒ leave order_channel NULL; DO NOT set the column") replaced —
    a key missing from a ZIP's listing is now a warning, not a blocker.
  - Step 3's `409` acceptance branch is now the **blank-key** outcome only and
    asserts `"reason":"blank_retailer_key"` alongside `fallbackChannel`; its 200
    branch reports any `advisory` as informational.
  - New arms 7-10: blank key → 409 + `reason`; null ZIP → 200
    `advisory:no_postal_code`; unknown key → 200 `advisory:retailer_not_in_zip`;
    probe 5xx/hang → 200 `advisory:retailers_probe_failed` and **explicitly not
    502/504**. New fixture env vars `BLANK_KEY_APPROVAL_ID`,
    `NO_ZIP_APPROVAL_ID`, `UNKNOWN_KEY_APPROVAL_ID`, `PROBE_FAIL_APPROVAL_ID`.
  - Unchanged arms: CORS preflight, 401 no-auth, 403 non-privileged, 404
    cross-store, forced `products_link` non-2xx → 502.
  - **★ Post-review fix round (backend-architect S2 / S4):**
    - A `FIXTURE HYGIENE` banner: arms 7-11 each need a **fresh** approval per
      run (the idempotency path returns `reused:true` with no probe and no
      advisory once a fixture has been minted), with the exact
      `update public.order_approvals set external_ref = null …` reset.
    - `is_reused()` + a shared `REUSE_HINT`: arms 7-11 now **SKIP with that
      instruction** on a `reused:true` body instead of failing with a misleading
      "expected advisory:&lt;token&gt;" (arms 8/9) or passing it off as a benign
      "the probe is HEALTHY" note (arm 10).
    - `PROBE_FAIL_APPROVAL_ID` **no longer defaults to `APPROVAL_ID`** — step 3
      mints that row earlier in the same run, so arm 10 was guaranteed to land on
      the no-advisory reuse path and silently never run. It now skips loudly when
      unset.
    - Arm 10's clean-probe branch is a `skip` (with "point the stub at a
      5xx/hang") rather than a `note`.
    - **New arm 11** — the S4 pin: against a stub that answers 200 headers then
      stalls the body, assert `200` + `advisory:'retailers_probe_failed'` + a url
      **and** a wall clock under `STALL_BODY_MAX_SECONDS` (default 12 s). New env
      `STALL_BODY_APPROVAL_ID`, `STALL_BODY_MAX_SECONDS`.
    - Step 6's inherited reuse-shadowing (spec 149) is left as-is — flagged by
      the reviewer as pre-existing, out of this fix round's scope.
  - Still **NOT wired into CI** — manual pre/post-deploy step; banner kept and
    repeated here for the PR description.

## Deliberately NOT in this diff

`supabase/migrations/*` (OQ-4 default upheld — no migration), `supabase/config.toml`
(`verify_jwt = true` unchanged), `app.json`, and any realtime publication change
(§9 — so **no** `docker restart supabase_realtime_imr-inventory` step).

## ★ Open seam — RESOLVED

`src/lib/db.ts` §8 was orphaned by the ownership split (§12 assigned it to the
backend-developer, but that dispatch scoped the backend half to
`supabase/functions/` + `scripts/` only). It was re-assigned mid-run to the
frontend half and is now implemented — see the FRONTEND section below. No open
seam remains; all gates are green.

---

# Files changed — FRONTEND half (parts A, B, and the §5-§8 client seams)

## New pure module

- `src/utils/postalCode.ts` **(new)** — §5.1 / AC-3. `parsePostalCode(raw)`
  returning `{ ok, value }`; trim, `''`/whitespace/`null`/`undefined` ⇒
  `ok/null` (the explicit clear, never `''`), otherwise
  `/^\d{5}(-\d{4})?$/` ⇒ `ok/<trimmed>`, else `ok:false`. ZIP+4 accepted and
  stored verbatim (OQ-7). No React / i18n / supabase imports — the
  `orderChannel.ts` purity precedent.

## Store ZIP edit surface (part A / DG-2)

- `src/components/cmd/StoreFormDrawer.tsx`
  - Props gained `store?: Store | null` (present ⇒ EDIT mode) and
    `onSaved?: (patch) => void` (edit only; fired **after** a resolved
    successful write, so the parent can sequence its re-read). Create mode with
    no `store` is byte-unchanged (AC-REG-1).
  - EDIT badge / `store.name` chrome title / `SAVE  ⌘⏎` primary /
    `accessibilityLabel="Edit store"` / prefill from the store; `SAVING…` and
    the `n/1 required valid` counter string are unchanged.
  - Reset effect dependency `[visible]` → `[visible, store?.id]` so re-opening
    on a different row re-seeds.
  - Edit save `await`s `updateStore(id, { name, address, postalCode })`; on
    `false` the drawer **stays open** with the input intact and no success
    toast (AC-6); on `true` it toasts `Saved store`, calls `onSaved`, closes.
  - **Documented intentional delta (§5.1):** the shared validator now gates
    **both** paths, so create refuses an invalid ZIP where it previously stored
    any text. Inline error `store-postal-code-error` (hardcoded English to match
    this drawer's other strings — no i18n keys here by design), red border, and
    it clears on the next keystroke. Deliberately **not** folded into the
    `n/1 required valid` counter.
- `src/screens/cmd/sections/BrandsSection.tsx` (`StoresTab`)
  - Row `EDIT` affordance: `testID="store-edit-<id>"`,
    `accessibilityLabel="Edit store <name>"`, `hitSlop {11,11,8,8}` (≥44×44
    effective), placed **before** ACTIVATE/DEACTIVATE. The row is NOT made
    pressable; the toggle, its confirm flow and the rest of the row are
    untouched — `StoresTab.toggle.test.tsx` passes **unmodified** (AC-2).
  - New `editStore` state, **separate** from `drawerOpen`; the
    `[refresh, drawerOpen]` effect keeps its dependency array verbatim.
  - **AC-5 per the architect's override, not the PM parenthetical:**
    `onSaved(patch)` applies the optimistic row patch and *then* calls
    `refresh()` — the write has already settled, so the re-read is
    authoritative reconciliation (AC-7: an RLS 0-row PATCH snaps the row back)
    rather than the spec-094 race. Cancelling an edit costs no round-trip.
  - A second `StoreFormDrawer` instance renders in edit mode.
- `src/store/useStore.ts`
  - **★ §6.1** — `db.updateStore` literal widened from four to **five** named
    fields (`+ postalCode`, an explicit named field, never a spread). The
    `brandId`-drop comment is kept and extended with "name every field; never
    spread `updates`". `weeklyCountDueDow` deliberately stays out.
  - `updateStore` return type `void → Promise<boolean>`: `true` on a settled
    write, `false` after the revert + `notifyBackendError`. **Never rejects**
    (JSDoc at the interface says so). Optimistic-then-revert posture otherwise
    unchanged.
  - Both production call sites updated: `StoresTab.setStatus` stays
    fire-and-forget (now explicit `void`), the drawer awaits the boolean.

## DG-1 picker disclosure (part B)

- `src/screens/cmd/sections/phone/PhoneApproveOrder.tsx`
  - `disclosureKeyForChannel` **replaced** by
    `disclosureKeysForChannel(channel): string[]` (AC-11) — no sibling helper.
    `instacart` ⇒ `['…disclosureInstacart', '…instacartPicker']` **in that
    order**; every other channel ⇒ `['…disclosureCatalog']`.
  - The `phone-approve-disclosure` block maps the keys with `gap: 6` (visually
    inert for the single-child case) and **no per-line testIDs**, so the
    non-instacart render tree is unchanged (AC-10). Still a bordered block
    directly above the single 48px primary, tokens only (AC-12).

## Advisory client seam (part C, §6.2 + §8)

- `src/lib/db.ts` (re-assigned mid-run — §8)
  - New exported `InstacartAdvisory` union + module-scope `isInstacartAdvisory`
    guard beside the existing `isOrderChannel` precedent.
  - `InstacartCartLinkResult`'s `ok:true` variant gained
    `advisory?: InstacartAdvisory`; the `ok:false` variant is unchanged (the
    function's `reason: 'blank_retailer_key'` is a logs/smoke affordance and is
    deliberately not surfaced).
  - `mintInstacartCartLink` returns
    `advisory: isInstacartAdvisory(data?.advisory) ? data.advisory : undefined`
    — unknown/future tokens are dropped, which is what makes the client's
    key lookup total. Transport unchanged (`supabase.functions.invoke` under
    `useInflight.track`).
- `src/store/useStore.ts` (§6.2)
  - Module-scope `ADVISORY_TOAST_KEY: Record<InstacartAdvisory, string>`.
  - In `runChannel`'s instacart `res.ok` branch, **before**
    `openExternalOrderUrl`: one `type: 'info'` toast,
    `visibilityTime: 5000`, `{vendor}`/`{store}` interpolated. Never an error
    toast, never `notifyBackendError`, never a channel re-route.
  - **AC-18 frozen:** the `retailer_unavailable && allowFallback` branch, its
    info toast, `advanceOrderApproval({ channel: fallback })`, the recursion
    guard and both pinning tests are byte-unchanged.

## i18n — admin catalogs only (AC-8 / AC-9 / AC-17 / AC-19)

- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`
  - **New** under `section.approveOrder`: `instacartPicker` (AC-9 verbatim in
    en), `advisoryNoPostalCode`, `advisoryRetailerNotInZip`,
    `advisoryProbeFailed` (OQ-6 — three distinct strings).
  - **Revised copy, same keys (no renames):**
    `section.approveOrder.retailerUnavailable` now names the blank-key cause
    ("Instacart isn't set up for {vendor} yet…") instead of ZIP coverage, and
    `section.vendors.instacartRetailerKeyHelp` states the advisory /
    opt-in-token role (AC-19). `VendorFormDrawer` renders the latter already —
    no component change.
  - `src/screens/staff/i18n/*` untouched (AC-REG-5).

## Tests — spec 022 Track 1 (jest)

- `src/utils/postalCode.test.ts` **(new)** — the §5.1 truth table incl.
  `null`/`undefined`, `'21204-12'`, `'21204-12345'`, `'21204 1234'`.
- `src/components/cmd/StoreFormDrawer.test.tsx` — **additive only**; all seven
  existing create cases unmodified and green. Adds the shared-validator arms on
  the create path, edit-mode prefill / EDIT badge / SAVE primary / re-seed on a
  different row, the ★ single `updateStore(id, {name,address,postalCode})` call,
  blank ⇒ `null`, invalid ⇒ inline error + **zero** writes, and the
  resolves-`false` path (drawer stays open, no success toast).
- `src/screens/cmd/sections/__tests__/StoresTab.edit.test.tsx` **(new)** — the
  affordance per row + hitSlop, opens the drawer for **that** row, create drawer
  keeps its own state, close does not refetch, `onSaved` patches the row and
  re-reads, the RLS 0-row snap-back, and the failed-re-read toast.
- `src/screens/cmd/sections/__tests__/StoresTab.toggle.test.tsx` —
  **unmodified**, green (AC-2).
- `src/store/useStore.updateStore.test.ts` — the `beforeEach` was hoisted from
  the spec-083 describe to file scope (body unchanged) so the added describes
  get the same isolation. Adds: ★ `postalCode` reaches `db.updateStore`,
  explicit `null` reaches it, all three fields in ONE save, `weeklyCountDueDow`
  and `brandId` still dropped, resolves `true` / resolves `false` (never
  rejects) + revert + error toast.
- `src/lib/db.updateStore.test.ts` — additive `postal_code` mapping arms
  (value, ZIP+4 verbatim, explicit `null`, `''` ⇒ `null`, alongside
  name/address in one PATCH, omitted key never clobbers).
- `src/lib/db.mintInstacartCartLink.spec149.test.ts` — additive advisory arms
  (each of the three tokens passes through; absent ⇒ `undefined`; unrecognized
  and non-string tokens dropped; a reused link carries none). All existing
  refusal cases unmodified.
- `src/store/useStore.approveOrder.spec149.test.ts` — additive: each advisory
  fires exactly ONE info toast, still opens the link, still re-reads the row,
  never advances the channel; the three tokens produce three distinct strings;
  no advisory ⇒ no toast. The two `retailer_unavailable` fallback cases are
  byte-unchanged (AC-18).
- `src/screens/cmd/sections/phone/__tests__/PhoneApproveOrder.test.tsx` — the
  `disclosureKeyForChannel` describe **moved** to `disclosureKeysForChannel`
  (order asserted); render arms for both instacart lines, their order, and the
  instacart-only freeze of the other channels.
- `src/utils/orderChannel.test.ts` and the `vendor_order_channel` pgTAP arms —
  **untouched** (AC-REG-2).

## Gates

- `npx tsc --noEmit` — clean.
- `npm run typecheck:test` — clean.
- `npx jest` — **198 suites / 2134 tests, all green** (incl. the i18n parity
  suite, the frozen `StoresTab.toggle` and `orderChannel` suites).
- Web bundle: `expo start --web` bundles `AppEntry.js` (1979 modules) with no
  errors and the new symbols present. **Interactive browser verification was
  not possible in this run** — the `preview_*` tooling was unavailable to the
  implementing agent; the build-level check plus the RTL render suites are what
  stands in for it. A human pass through Brands → Stores → EDIT is still
  recommended before merge.
- Not run here: pgTAP (`npm run test:db`) — no migration and no DB change ships
  (§1); shell smoke — manual by design (AC-24).

---

## Files changed

Combined, both halves. Staged, **not committed**.

- `specs/155-instacart-enablement.md`
- `src/utils/postalCode.ts` *(new)*
- `src/utils/postalCode.test.ts` *(new)*
- `src/components/cmd/StoreFormDrawer.tsx`
- `src/components/cmd/StoreFormDrawer.test.tsx`
- `src/screens/cmd/sections/BrandsSection.tsx`
- `src/screens/cmd/sections/__tests__/StoresTab.edit.test.tsx` *(new)*
- `src/screens/cmd/sections/phone/PhoneApproveOrder.tsx`
- `src/screens/cmd/sections/phone/__tests__/PhoneApproveOrder.test.tsx`
- `src/store/useStore.ts`
- `src/store/useStore.updateStore.test.ts`
- `src/store/useStore.approveOrder.spec149.test.ts`
- `src/lib/db.ts`
- `src/lib/db.updateStore.test.ts`
- `src/lib/db.mintInstacartCartLink.spec149.test.ts`
- `src/i18n/en.json`
- `src/i18n/es.json`
- `src/i18n/zh-CN.json`
- `supabase/functions/instacart-cart-link/index.ts`
- `scripts/smoke-instacart-cart-link.sh`

**Deploy note for the PR description (§4.6):** the edge function and the web
bundle do NOT deploy atomically. Run
`npx supabase functions deploy instacart-cart-link --project-ref ebwnovzzkwhsdxkpyjka`
— until it runs, prod keeps returning the old 409s, which the preserved AC-18
client branch handles. It is now **runbook step 1b**, unconditional (S1). No
migration, no `config.toml` change, and **no**
`docker restart supabase_realtime_imr-inventory` (§9).

---

## Post-review fix round #1 — backend (S1 / S2 / S4 + M1 / M2)

Against `specs/155-instacart-enablement/reviews/backend-architect.md`. Backend
scope only; `src/**` was owned by a parallel agent in the same window and is
untouched by this round.

**Files changed in this round** (staged, not committed):

*Edge functions*
- `supabase/functions/instacart-cart-link/index.ts` — **S4** (abort deadline now
  covers the response BODY read on both the 3 s probe and the 10 s
  `products_link` call; `idpFetch` returns `{ res, json(), done() }`; new
  `UpstreamParseError` + `isAbortError()`), **M1** (`advisory=<token|none>` on
  the terminal success log line), **M2** (`cause=timeout|parse|network` on the
  probe's failure log line).

*Shell smokes*
- `scripts/smoke-instacart-cart-link.sh` — **S2** (FIXTURE HYGIENE banner;
  `is_reused()` + shared `REUSE_HINT` so arms 7-11 SKIP with an actionable reason
  on a consumed fixture; `PROBE_FAIL_APPROVAL_ID` no longer defaults to
  `APPROVAL_ID`, which step 3 consumes; arm 10's clean-probe branch is a `skip`,
  not a `note`), **S4** (new arm 11 — stalled probe body, asserting the advisory
  *and* a wall clock under `STALL_BODY_MAX_SECONDS`).

*Spec*
- `specs/155-instacart-enablement.md` — **S1** (new unconditional runbook step
  **1b** "Deploy the spec-155 function build", plus verification step 5.10 that
  reads a 409-shaped fallback as deploy skew), the §4.4 S4 amendment, and these
  implementation notes.

**Not done in this round, deliberately:**
- **S3** (stale comments in the frozen AC-18 branch of `src/store/useStore.ts`) —
  `src/**` is out of this dispatch's scope; still open.
- **M3 / M6** (`BrandsSection` refresh race, double-mounted drawer) — `src/**`.
- **M4** (reciprocal pointer comment in `src/lib/db.ts`) — `src/**`.
- **M5** — spec-internal §12 ownership wording; already annotated as resolved.
- Step 6's inherited (spec 149) reuse-shadowing in the smoke — the reviewer
  scoped it as pre-existing.

**Gates re-run after the fix round:**
- `npx tsc --noEmit` — clean. `npm run typecheck:test` — clean.
- `npx jest` — **201 suites / 2182 tests green** (the count is above the previous
  note because the parallel spec-156 suites were present in the same tree).
- `npm run test:db` — **80/80 pgTAP files pass** (untouched; no DB change ships).
- Shell smoke, run **live** against the local stack + a local IDP stub
  (`INSTACART_IDP_BASE_URL` → the stub): all arms exercised, including
  - arm 10 with a fresh fixture and a 5xx probe ⇒ 200 + `retailers_probe_failed`;
  - **arm 11** with a 200-headers-then-30 s-stalled body ⇒ 200 +
    `retailers_probe_failed` in **3 s** (pre-fix this read had no deadline);
  - a re-run against the now-consumed fixtures ⇒ arms 8-11 **SKIP** with the
    reuse hint instead of failing misleadingly;
  - the frozen arms unchanged: blank key 409 + `reason`, null ZIP / unknown key /
    empty market advisories, `products_link` 500 ⇒ 502, 2xx-without-url ⇒ 502,
    hung `products_link` ⇒ 504 at 10 s, and a `products_link`
    200-headers-then-25 s-stalled body ⇒ **504 at 10 s** (previously unbounded),
    401 / 403 / 404, and the reuse path carrying no advisory.
- Log lines observed for all three `cause=` values and for `advisory=none` /
  `advisory=<token>`; no key, ZIP, or URL in any of them.
