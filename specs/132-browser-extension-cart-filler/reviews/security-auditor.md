# Security audit for spec 132

Scope: the new `extension/` Chrome MV3 cart-filler artifact. Focus per task —
AC-9 hard boundary, Supabase auth posture, guarded mark-ordered UPDATE, URL-scheme
validation, content-script injection scope, `npm audit`.

## Verdict

**No Critical findings. The spec is NOT blocked on security grounds.** The AC-9
hard boundary holds on every one of its four legs, the auth posture is anon-key-only
with no service-role reachable, the mark-ordered write is correctly guarded and
RLS-bounded, and URL-scheme validation gates every navigation. Findings below are
Medium/Low hardening items.

### AC-9 boundary — verified clean (all four legs)

1. **No checkout / payment path.** No navigation to a checkout/pay/order URL exists.
   The add-to-cart finders in `extension/src/adapters/bjs.ts:73-74` and
   `extension/src/adapters/samsclub.ts:70-71` positively EXCLUDE any button whose
   text matches `/checkout|place order|pay(|continue to)/i`. `navigateAndWait`
   (`service-worker.ts:52`) only ever receives a `searchUrl(...)` or a resolved
   product URL — never a checkout route. No payment/billing form is submitted
   anywhere.
2. **No vendor-credential handling.** The only credential touched is the admin's own
   I.M.R email+password at the popup (`popup.ts:47-60`, cleared after submit). The
   adapters' `pageIsLoggedIn` (`bjs.ts:49`, `samsclub.ts:49`) DETECT an existing
   session only — no vendor password is read, stored, or typed. `not-logged-in` →
   STOP + ask the human (`service-worker.ts:96-99`).
3. **No CAPTCHA circumvention.** `pageDetectChallenge` (`bjs.ts:34`, `samsclub.ts:33`)
   is detection-only and every code path treats a positive as a hard STOP —
   preflight (`service-worker.ts:92-94`), on the search navigation
   (`service-worker.ts:120-122`), on the product page (`service-worker.ts:134-136`),
   and mid-run (`service-worker.ts:200-207`). No solving, evasion, or
   automation-detection workaround exists.
4. **Host permissions scoped.** `extension/manifest.json:7-10` = exactly
   `https://www.bjs.com/*` + `https://www.samsclub.com/*`; the build appends only the
   single Supabase origin (`build.mjs:105-109`, confirmed in
   `dist/manifest.json:11-15`). No `<all_urls>`. No `content_scripts` block — injection
   is programmatic via `chrome.scripting.executeScript` gated on `adapterForOrigin`
   (`service-worker.ts:155,170-173`), so page routines only ever run on the two
   host-permitted origins.

### Auth posture — verified clean

- Anon key only (`config.ts`, injected at build from `EXPO_PUBLIC_SUPABASE_ANON_KEY`;
  `build.mjs:45-49` never reads any service-role var). No service-role key anywhere in
  `extension/src`. The `service_role` strings in `dist/background/service-worker.js`
  are supabase-js JSDoc literals, not a key.
- `dist/` is gitignored and untracked (`git ls-files` empty) — no baked key is
  committed.
- Every data call rides the admin's own JWT (`imrClient.ts`), so the two RPCs and the
  mark-ordered UPDATE are `auth_can_see_store`-bounded — no broader-than-admin access.

### Mark-ordered UPDATE — verified clean

`imrClient.markOrdered` (`imrClient.ts:91-100`) issues the guarded
`update purchase_orders set status='sent' where id=:poId AND status='draft'` — the
architect-required shape. Idempotent (0-row re-run), cannot resurrect a
received/cancelled PO, RLS-bounded to visible stores, and gated behind the dry-run
boundary (`canMarkOrdered`, `service-worker.ts:217-219`).

---

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

- `extension/package.json:13-16` — `npm audit` reports 1 critical + 1 high in the
  test/build devDependency tree (vitest → vite → esbuild). The critical
  (GHSA-5xrq-8626-4rwp, arbitrary file read/exec) only triggers with the **Vitest UI
  server**, which this project does not run (test script is `vitest run`, `package.json:10`).
  The vite/esbuild issues are dev-server-only and never ship in the built extension
  (esbuild produces the bundle; its runtime dev-server vuln is not in the output). Real
  exposure is developer-machine/CI only, not the shipped artifact. **Fix:** bump the
  devDependencies when convenient (`npm audit fix --force` pulls vitest@4 — a breaking
  major, so pin deliberately rather than blind-force). Not deploy-blocking because none
  of these code paths ship to the owner's browser.

### Low

- `extension/src/background/service-worker.ts:123-127` — a search-result product URL
  (`pick.url`) is validated as http(s) via `isSafeHttpUrl` but is NOT constrained to
  the current vendor origin. A product tile whose `href` points off-origin would cause
  the extension to navigate the admin's tab to an arbitrary http(s) URL. Impact is
  low: the subsequent `pageAddToCartOnProduct` injection would fail outside
  host_permissions (reported `failed`), and there is no data exfiltration. **Hardening:**
  reject a `pick.url` whose origin != the adapter's origin before navigating.
- `extension/src/lib/storageAdapter.ts` — the admin's Supabase session (access +
  refresh token) persists unencrypted in `chrome.storage.local`. This is the design's
  acknowledged tradeoff (D-2/D-10) and standard for extensions (equivalent to the web
  app's localStorage); the token is the admin's OWN JWT with no elevation, Supabase
  default lifetime, refresh rotation. Local-profile compromise could read it — accepted
  posture for an owner-installed v1 tool. Informational, no change required.
- `extension/src/adapters/bjs.ts:49-60`, `samsclub.ts:49-58` — `pageIsLoggedIn`
  fail-OPENs: when neither a logout affordance nor a sign-in link is found it returns
  `true` (assumes logged in). Worst case is a wasted add attempt reported as `failed`,
  not a security issue — but a fail-CLOSED default (assume not-logged-in → STOP) would
  align better with the AC-9 "stop and ask the human" posture. Best-effort selectors are
  OWNER-TUNE per AC-11; noting for the tuning pass.
- `extension/src/background/service-worker.ts:200` — the mid-run challenge STOP keys off
  `res.detail.startsWith('Challenge detected')`, a string-match coupling between the
  executor's detail text and the stop logic. Functionally correct today; a typed
  `outcome`/`stopReason` field would be less brittle. Not a security gap (the STOP still
  fires), just fragile.

### Dependencies

`npm audit --audit-level=high` on `extension/package.json`: 5 vulnerabilities
(1 critical, 1 high, 3 moderate), ALL in the vitest/vite/esbuild dev-test tree — none
in a runtime dependency of the shipped extension. `@supabase/supabase-js` (the only
runtime dep) is clean. See the Medium finding for disposition. Root `package.json` was
not modified by this spec.
