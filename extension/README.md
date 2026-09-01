# I.M.R Cart Filler — Chrome MV3 extension (specs 132 + 162)

Fills your **BJ's Wholesale** / **Sam's Club** cart from a pending I.M.R
purchase order, in **your own already-logged-in browser session**. It is the
CONSUMER of the spec-131 backend contract (the pending-PO structured payload +
the mark-ordered write-back).

On **BJ's only** it can also **place the order** (spec 162), under a spend cap
you set, reporting every failure back to I.M.R as a bell notification + email.

This is a **separate build artifact** — it does NOT ship in the Expo web/native
bundle. It lives in `extension/`, out of the Metro graph, with its own
`tsconfig`, esbuild build, and vitest test runner (spec 132 D-6).

## Auto-place (spec 162 — BJ's only)

"Fill cart + place order" runs the normal fill, then stops at **five
independent gates** before it clicks BJ's own place-order button:

1. **Every** PO line must be in the cart. One unmatched item aborts the whole
   placement — a short order placed unattended is worse than a manual checkout.
2. The cart's line count must equal the PO's, and the cart page must be
   readable at all.
3. The cart subtotal must be readable AND at or under your spend cap.
4. BJ's must be about to charge the **card last-4 you pinned**. Never
   auto-corrected — a wrong or unreadable card stops the run.
5. BJ's must be about to ship to the address of the **store you picked**. This
   one IS auto-corrected, but only by selecting an address BJ's already has
   saved, and only after re-reading the page to confirm the switch took.

All five fail CLOSED: an unreadable cart, total, card or address blocks. The
card is gated before the address, so an address switch can never run on a
checkout whose card is wrong. Past the click, an order counts as PLACED only if
BJ's returns an order number — and the attempt record then names the address it
shipped to and the card that paid.

The cap, the shipping store and the card last-4 are all set in the popup and
stored in `chrome.storage.local`. All three are **required** — unset is a
refusal, not a skipped check. The card value is four digits, an identifier for a
card BJ's already holds; a card number is never typed, stored, or sent.

The shipping address is **picked from your I.M.R stores**, never typed
(`get_extension_store_addresses`), and the picker defaults to the store of the PO
in hand. What's stored locally is the STORE ID — the address is re-resolved on
every popup open, so correcting a store's address in the app corrects the
extension too. `stores.address` is mandatory as of spec 162 rev 2; a store
without one appears in the picker flagged rather than missing, so the gap is
obvious and fixable.

Every terminal outcome writes ONE `vendor_order_attempts` row via
`record_vendor_order_attempt`. A failure emits an `order_failed` notification
(bell + push) and emails the store's admins plus `ORDER_FAILURE_OPS_EMAIL`; a
success flips the PO `draft → sent` and stores the BJ's order number.

These settings live in `chrome.storage.local`, not the DB — they are
blast-radius limits on THIS browser's unattended clicking, not business rules.
Cap defaults to `$500`; the card starts blank and must be filled in before
auto-place will run. A second machine re-sets them.

Sam's Club is untouched: its adapter declares no `checkout` block, the popup
hides the auto-place arm there, and the background refuses the request.

## The hard boundary (AC-9 — amended by spec 162)

- **Checks out on BJ's ONLY, and only when you press the auto-place button.**
  The spec-132 "Fill cart from PO" path still stops at a FILLED cart and its
  add-to-cart finder still EXCLUDES checkout/pay controls. Spec 162 adds a
  separate, gated `PLACE_ORDER` path that drives BJ's own checkout using the
  payment already on your BJ's account. It never types a card number.
- **Never stores or handles a vendor credential.** It relies solely on your
  existing `bjs.com` / `samsclub.com` session. Not logged in → it STOPS and
  asks you to log in. The only credential it touches is your own I.M.R password
  at the Supabase login popup.
- **Never circumvents a CAPTCHA / bot challenge.** On a detected challenge it
  STOPS and hands control to you.
- **Host permissions scoped to exactly `bjs.com` + `samsclub.com`** (+ the one
  Supabase origin for auth/data) — never `<all_urls>`.

## Commands

Run from `extension/`:

```bash
npm install            # one-time — installs esbuild, vitest, @types/chrome, supabase-js
npm run typecheck      # tsc --noEmit on the extension tsconfig (+ the shared builder)
npm test               # vitest — the pure adapter-agnostic logic (AC-12)
npm run build          # esbuild → extension/dist/ (unpacked MV3 extension)
```

`npm run typecheck` and `npm test` are gated in CI as **Track 1c** in
`.github/workflows/test.yml`. The base Expo `typecheck` / `jest` jobs never see
this tree (`extension/**` is excluded from `tsconfig.json` and
`jest.config.js`).

## Build config (Supabase URL + anon key)

The build injects the Supabase project URL + **public anon key** at compile time
(131 D-2 — the anon key is not a secret; RLS bounds access). It reads, in order:

1. `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` (env)
2. `SUPABASE_URL` / `SUPABASE_ANON_KEY` (env)
3. the repo-root `.env.local` (so a local build "just works")

The build also injects the Supabase origin into the manifest's
`host_permissions` so the background service worker can reach the auth/data
endpoints.

## Install the built extension

1. `npm run build`
2. Chrome → `chrome://extensions` → enable **Developer mode**
3. **Load unpacked** → select `extension/dist/`
4. Click the toolbar icon → sign in with your **I.M.R** email + password
5. Open a BJ's / Sam's tab with a pending PO for that vendor → the popup lists
   it → **Fill cart from PO**

## Dry-run (default ON — AC-10)

The **Dry-run (safe)** toggle is ON by default. In dry-run the extension LOGS
the intended actions and renders the per-item report as **would-add**, but
performs **no** add-to-cart and **no** mark-ordered write. Turn it off for a
live run. Marking the PO ordered is an explicit button you press AFTER you've
reviewed and paid.

## Layout

```
extension/
  manifest.json           MV3 manifest (host-scoped to the two vendor sites)
  build.mjs               esbuild bundler (NOT Metro)
  tsconfig.json           extension-only typecheck
  vitest.config.ts        extension-only unit runner
  public/popup.html       popup markup
  src/
    lib/                  config, chrome.storage session adapter, supabase-js
                          imrClient (RPCs + guarded mark-ordered UPDATE), types,
                          popup↔background messages
    core/                 PURE, unit-tested: plan (payload → actions), origin
                          match, dry-run gate, report assembly, URL scheme guard,
                          checkout (the spec-162 cart/cap gate + failure copy)
    adapters/             ONE best-effort DOM adapter per vendor (bjs, samsclub)
                          + registry. Selectors are OWNER-TUNED against real
                          accounts (AC-11) — NOT unit-tested against live sites.
    background/           MV3 service worker — the only place that touches
                          supabase-js + chrome tabs/scripting; orchestrates the
                          run + enforces the AC-9 stops
    popup/               thin popup UI logic
```

## What is and isn't tested automatically

- **Unit-tested (vitest, AC-12):** payload → planned actions incl. the shared
  spec-115 case-math via `computePoQuickOrderLines`; the vendor↔site origin
  match; the dry-run gate (no cart/write side effect); the report shape
  (added / would-add / unmatched / ambiguous / failed); URL scheme validation;
  the spec-162 cart/cap gate, its money-string parser, the address/card
  selection gate (formatting tolerance, the never-auto-correct-a-card rule), and
  the store picker's resolution + default precedence.
- **DOM-tested (vitest + jsdom):** `src/popup/__tests__/` mounts the REAL
  `public/popup.html` with a stubbed `chrome`, so the popup's wiring is covered,
  not just its pure helpers — specifically that changing the shipping store
  repaints the address AND changes the address sent to the background. Renaming
  an element id fails here rather than silently in a browser nobody is watching.
- **DB-tested (pgTAP):** `supabase/tests/auto_place_order_attempts.test.sql` —
  the attempt record, the store gate, idempotency, the guarded `draft → sent`
  flip, and the `order_failed` notification shape.
- **Manual owner verification (AC-11):** the live BJ's / Sam's DOM selectors and
  add-to-cart flow. There is no vendor sandbox — the owner runs dry-run then a
  bounded live run on real accounts and tunes selectors in the `adapters/`
  OWNER-TUNE ZONE as the sites drift. **The spec-162 checkout selectors have had
  NO live pass yet** — they are first-pass guesses that fail loud and name the
  visible controls they did see, so one screenshot from a failed run is enough
  to re-target.
