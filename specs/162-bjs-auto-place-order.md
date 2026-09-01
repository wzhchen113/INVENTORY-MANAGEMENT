# Spec 162: BJ's auto-place order + failure notification & email

Status: READY_FOR_REVIEW

> **Origin (owner request, 2026-08-28, binding):** *"i want bjs auto fill cart and
> make the order on the website itself, if the order couldn't purchase or failed
> then send a notification to IMR and email that the order failed to order"*
>
> This **deliberately crosses spec 132's AC-9 hard boundary** ("no adapter has a
> checkout/payment routine"). The owner was shown the risk — a checkout misfire
> spends real money rather than wasting a run — and chose to proceed with a
> **spend cap** guardrail rather than a human confirm.

## Owner decisions (this session — do NOT re-litigate)

| Question | Decision |
|---|---|
| Guardrail between "cart filled" and "order placed" | **Cap + auto-place.** One button fills, verifies the cart against the PO, checks the total against a cap, then places the order with no further clicks. Over cap or cart mismatch = stop + failure notification. |
| Failure recipients | **Store admins + a fixed ops address.** In-app bell + web push to the brand's privileged users, plus an email to every one of them AND to a configured ops mailbox. |
| BJ's account shape | **One account, one shipping address** for all four stores. |
| Wrong address at checkout | **Switch to the right one, then place** — but only to an address BJ's already has saved. |
| Payment card | **Refuse unless it matches a card the operator names** (last 4, pinned in the popup). |

### Revision (same session): where it ships and what pays

The first cut clicked "Place Order" without ever reading the delivery address or
the card — it took whatever BJ's had defaulted to. The owner asked the obvious
question ("which address, which card?") and this is the answer.

The two account answers pull against each other: with **one** saved address
there is nothing per-store to match, so deriving the expected address from the
PO's store would have blocked three of four stores; and "switch the address"
only means anything if BJ's ever shows a picker. Resolution: the operator
**pins one shipping address and one card last-4 in the popup**, and the
extension enforces them on every order regardless of which store the PO came
from. If BJ's shows a different address AND has the pinned one saved, it
switches; otherwise it refuses.

The card is **never** auto-corrected and is checked FIRST, so an address switch
can never become a path around a wrong card. Neither value goes in the repo, the
database, or any request to I.M.R — both live in `chrome.storage.local` beside
the spend cap, and the card value is four digits, never a card number.

### Revision 2 (same session): pick a store, don't type an address

Owner instruction, verbatim: *"i dont want to write the address, but pick the
address of existing stores, each stores should have address filled in when
creating the store."*

The free-text "Ship to" box is replaced by a **store picker** sourced from
`get_extension_store_addresses()`, defaulting to the store of the PO in hand and
overridable. Two consequences worth stating:

- **`chrome.storage.local` now holds the STORE ID, not the address text.** The
  address is re-resolved from I.M.R on every popup open, so fixing a store's
  address in the app fixes the extension too. A cached string would keep
  enforcing the old address and refuse every order until someone worked out why.
- **`stores.address` becomes mandatory** — `stores_address_present`, a NOT VALID
  CHECK, plus the second required field in `StoreFormDrawer`. NOT VALID so the
  migration applies to a prod that may still hold addressless stores; the
  drawer's gate is what forces those to be filled in on their next edit, turning
  an opaque constraint error into "fill in the address to save".

**Standing consequence of rev 1 + rev 2 together:** with ONE address saved at
BJ's and four store addresses in I.M.R, picking a store whose address BJ's
doesn't have saved will refuse at `address-verify` — correctly, and with an
email naming both addresses. Either save each store's address in the BJ's
account, or keep picking the one store BJ's ships to.

## Scope

**BJ's only.** Sam's Club keeps the spec-132 fill-then-pay-by-hand flow — its
adapter grows no checkout routine, and `VendorAdapter`'s checkout half is
**optional** precisely so Sam's opts out by omission.

## User story

As the **store manager**, after I open `bjs.com` logged into my own account with a
pending PO, I want one button that fills my cart from the PO **and places the
order**, so I don't have to sit through checkout. If anything stops it — a wrong
cart, a total over my cap, a CAPTCHA, a declined card, a checkout page that
changed — I want I.M.R to tell me immediately in the app **and** by email, and I
want the PO left alone so I can finish it by hand.

- **US-1 (auto-place).** One click: fill → verify → cap-check → checkout → place.
- **US-2 (never overspend).** A per-browser dollar cap. Over it, the run stops
  before the place-order click, every time.
- **US-3 (never order the wrong thing).** The BJ's cart is read back and compared
  to the PO plan before checkout starts. A mismatch stops the run.
- **US-4 (told when it fails).** Any non-placed outcome writes an attempt record,
  raises an `order_failed` in-app notification + push, and emails the store's
  admins and the ops mailbox.
- **US-5 (the PO stays honest).** Only a CONFIRMED placement flips the PO to
  `sent` and records the BJ's order number. A failure leaves it `draft`.

## Acceptance criteria

- **AC-1** The popup's "Fill cart + place order" control is separate from the
  spec-132 "Fill cart from PO" control. Dry-run remains the default posture and
  suppresses the place-order side effect exactly as it suppresses the cart-fill.
- **AC-2** Before any place-order click the extension reads the live BJ's cart
  (line count + subtotal) and compares it to the executed plan. A line-count
  mismatch, or a cart it cannot read, is a `cart-verify` failure — no checkout.
- **AC-3** The cart total is compared to the operator's cap. Over cap is a
  `cap-check` failure — no checkout. The cap is required; there is no "no cap"
  setting.
- **AC-4** A CAPTCHA / bot challenge / login wall detected at ANY checkout stage
  stops the run as a `challenge` failure (spec 132 AC-9 is unchanged for
  everything except the deliberate place-order click).
- **AC-4a** Before the place-order click the extension reads the card BJ's would
  charge. It is never auto-corrected: a card that doesn't match the pinned last-4
  — or one it cannot read at all — is a `card-verify` failure.
- **AC-4b** It also reads the delivery address. A mismatch is corrected ONLY by
  selecting an address BJ's already has saved, after which it re-reads and
  re-gates; a switch that doesn't take, an address with no matching saved option,
  and an unreadable address are all `address-verify` failures.
- **AC-4c** The card is gated BEFORE the address, so an address switch can never
  run on a checkout whose card is wrong.
- **AC-4d** The pinned address and card last-4 are REQUIRED. Unset is a refusal,
  never a skipped check. Neither leaves the operator's browser except as a
  comparison inside the vendor page; the last-4 is an identifier for a card BJ's
  already holds, never a card number.
- **AC-5** A placement is only "placed" when the confirmation page yields a BJ's
  order number. A checkout that ends anywhere else — including a page that looks
  successful but has no order number — is a `confirm` failure, never a success.
- **AC-6** Every terminal outcome (placed or failed) is recorded by ONE
  `record_vendor_order_attempt` RPC call, idempotent on a client-supplied uuid.
- **AC-7** On `outcome = 'failed'` the RPC emits an `order_failed` notification
  (bell + push) and enqueues the failure email. On `outcome = 'placed'` it flips
  the PO `draft → sent` (guarded) and stores the vendor order number.
- **AC-8** The failure email reaches every `super_admin` plus every
  `admin`/`master` in the PO's brand, plus `ORDER_FAILURE_OPS_EMAIL`. Every
  interpolated value is HTML-escaped (CLAUDE.md spec-028 rule).
- **AC-9** A notification/email failure NEVER rolls back the attempt record.
- **AC-10** The `order_failed` bell row is RED (badge + dot), joining
  `missed_eod`. Spec 121 reserved red for "a count was missed"; this widens the
  reservation to "something needs you NOW", which a failed money-order is.
- **AC-11** Never handles a BJ's credential and never logs in for the operator.
  Payment is whatever BJ's already has on file for that account.

## Design

### Extension (`extension/`)

- `adapters/types.ts` — `VendorAdapter.checkout?: VendorCheckout`. Sam's omits it;
  the service worker refuses to place for an adapter without it.
- `adapters/bjs.ts` — the checkout page routines (`pageReadCart`,
  `pageStartCheckout`, `pagePlaceOrder`, `pageReadConfirmation`). Same
  OWNER-TUNE-ZONE posture as the cart-fill selectors: first-pass guesses that
  WILL need a live tuning pass. Each returns a stage-tagged failure with the
  visible candidate labels, so one screenshot from a failed live run is enough
  to re-target.
- `core/checkout.ts` — the PURE, unit-tested gate: `evaluateCartGate` (cart vs
  plan vs cap) and `failureReason` (stage → human sentence). No DOM, no chrome.
- `background/service-worker.ts` — `PLACE_ORDER`, staged, recording exactly one
  attempt at the end of every path including a thrown error.
- `popup/` — cap input (persisted in `chrome.storage.local`, default `$500`),
  the place-order button, and the staged outcome banner.

**Why the cap lives in `chrome.storage.local`, not the DB:** it guards THIS
browser's unattended clicking. Putting it on `vendors` would need an admin UI to
edit it and would read as a business rule rather than what it is — a blast-radius
limit on one machine's automation. Flagged as a follow-up if a second operator
ever runs the extension.

### Backend

`supabase/migrations/20260829000000_auto_place_order_attempts.sql`:

1. `public.vendor_order_attempts` — the audit spine. Store-scoped RLS SELECT for
   privileged brand members; NO client INSERT policy (writes only via the RPC).
2. `notifications.type` CHECK widened with `'order_failed'` (drop/re-add, all
   nine prior values preserved verbatim — the spec-121/126/149 pattern).
3. `public.emit_order_failed(...)` — thin sibling of `emit_order_ready`.
   `source_id` = the ATTEMPT id, not the PO id, so a retry re-notifies instead of
   being swallowed by `notifications_type_source_uidx`.
   **`actor_user_id` is deliberately NULL** even though there is a real actor:
   `submission-push-fanout` excludes `actor_user_id` from push recipients, and in
   an UNATTENDED auto-place the operator who started it is precisely the person
   who walked away and needs the push. Provenance lives on
   `vendor_order_attempts.attempted_by` instead; `actor_name` still carries their
   name for the bell's secondary line.
4. `public.enqueue_order_failure_email(uuid)` — pg_net POST, `_edge_auth` name
   `order_failure_email_url`, `cron_bearer` shared bearer. Unconfigured (local
   dev) = NOTICE + skip, same as `enqueue_submission_push`.
5. `public.record_vendor_order_attempt(...)` — SECURITY DEFINER, gated on
   `auth_can_see_store`. Inserts the attempt; on `'placed'` runs the guarded
   `draft → sent` UPDATE; on `'failed'` emits + enqueues. Idempotent on
   `p_client_uuid`.

`supabase/functions/send-order-failure-email/` — shared-bearer gate (NOT an
ADMIN_ROLES gate: event-driven like `submission-push-fanout`), service-role
authoritative re-read, inline `escapeHtml`, Resend. `verify_jwt = false` pinned
in `config.toml`.

### App

`'order_failed'` joins `SubmissionNotificationType`, the three i18n catalogs, the
push-copy pair (`src/utils/pushNotificationCopy.ts` + its Deno mirror), the bell's
red fork, and the phone sheet.

## Open questions / owner to-do

- **OQ-1 (BLOCKING a live run).** The BJ's checkout selectors are unverified
  first-pass guesses. The owner must do one live pass — dry-run first, then a
  real one on a SMALL PO — and send the failure detail so the selectors can be
  tuned, exactly as the 2026-07-20 cart-fill pass went.
- **OQ-2.** `ORDER_FAILURE_OPS_EMAIL` must be set as an edge-function secret, and
  `order_failure_email_url` seeded into `public._edge_auth` on prod, or the email
  arm silently no-ops (by design — it degrades to bell + push).
- **OQ-3.** BJ's delivery-vs-pickup and slot selection are assumed to be already
  chosen on the account. If BJ's demands a slot mid-checkout the run fails at
  `checkout-nav` and the owner finishes by hand; making the extension pick a slot
  is out of scope. (The address and card are NO LONGER in this bucket — see the
  revision above.)
- **OQ-4.** The pinned address/card are per-BROWSER, like the cap. A second
  operator on a second machine re-pins them. If auto-place ever runs from more
  than one machine, these three settings become the thing to move server-side —
  and at that point the address probably wants to be per-store on `stores`
  rather than a single pinned value.
