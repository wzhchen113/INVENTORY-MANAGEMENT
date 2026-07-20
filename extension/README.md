# I.M.R Cart Filler — Chrome MV3 extension (spec 132)

Fills your **BJ's Wholesale** / **Sam's Club** cart from a pending I.M.R
purchase order, in **your own already-logged-in browser session**. It is the
CONSUMER of the spec-131 backend contract (the pending-PO structured payload +
the mark-ordered write-back).

This is a **separate build artifact** — it does NOT ship in the Expo web/native
bundle. It lives in `extension/`, out of the Metro graph, with its own
`tsconfig`, esbuild build, and vitest test runner (spec 132 D-6).

## The hard boundary (AC-9 — non-negotiable)

- **Never checks out / pays.** It stops at a FILLED cart. There is no
  checkout/payment/place-order code path (the add-to-cart button finder
  explicitly EXCLUDES checkout/pay controls).
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
                          match, dry-run gate, report assembly, URL scheme guard
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
  (added / would-add / unmatched / ambiguous / failed); URL scheme validation.
- **Manual owner verification (AC-11):** the live BJ's / Sam's DOM selectors and
  add-to-cart flow. There is no vendor sandbox — the owner runs dry-run then a
  bounded live run on real accounts and tunes selectors in the `adapters/`
  OWNER-TUNE ZONE as the sites drift.
