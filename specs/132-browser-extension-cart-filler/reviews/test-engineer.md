## Test report for spec 132

### Acceptance criteria status

- **AC-1 (MV3 extension, two vendor sites).** `extension/manifest.json` is
  `manifest_version: 3`, `host_permissions: ["https://www.bjs.com/*",
  "https://www.samsclub.com/*"]` (no `<all_urls>`); `build.mjs` additively
  injects only the one Supabase origin at build time. `adapters/registry.ts`
  resolves exactly `bjsAdapter` / `samsClubAdapter`. → **PASS (verified by
  direct inspection this session)** — but **NOT covered by an automated
  test**. No vitest spec parses `manifest.json` or asserts
  `adapterForOrigin` returns `null` for a third-party origin. A future PR
  could silently widen `host_permissions` (e.g. to `<all_urls>`) without CI
  catching it. Recommend a cheap `extension/src/core/__tests__/manifest.test.ts`
  that reads `manifest.json` and asserts the exact `host_permissions` array —
  not blocking, since I independently re-verified the current file, but
  flagged as a coverage gap.
- **AC-2 (authenticated to I.M.R as the admin, store-scoped).**
  `extension/src/lib/imrClient.ts` rides the admin's own
  `signInWithPassword` session (no service-role key); every RPC/UPDATE call
  is unauthenticated-by-design except via that session. The RLS boundary
  itself is exercised by `supabase/tests/extension_ordering.test.sql`
  (P5/Q2/M3 — a non-member cannot read or write another store's pending
  PO/payload/mark-ordered, `auth_can_see_store`-bound). → **PASS** —
  `supabase/tests/extension_ordering.test.sql::(P5,Q2,M3)` (pgTAP, spec 131's
  file, exercises the exact RPCs/UPDATE this extension calls) + code
  inspection of `imrClient.ts` (no service-role key, no broader-than-admin
  path).
- **AC-3 (pickup on the right site for the right vendor).**
  `extension/src/core/origin.ts::pendingOrdersForOrigin` — matches by
  `order_page_url` origin, excludes other-vendor / null / unsafe URLs, no
  match on an unparseable current origin. → **PASS** —
  `extension/src/core/__tests__/origin.test.ts` (5 cases).
- **AC-4 (per-vendor item matching strategy).**
  `extension/src/core/plan.ts::resolveLine`/`buildPlan` — prefers a stored
  `product_page_url`, falls back to order-code search, imports the shared
  `computePoQuickOrderLines` for case math (no re-derivation). → **PASS** for
  the pure resolution/qty logic — `extension/src/core/__tests__/plan.test.ts`
  (9 cases, incl. unit vs. case-ceil math and URL-preferred resolution). The
  vendor-specific DOM search itself (`adapters/bjs.ts`,
  `adapters/samsclub.ts` `pagePickSearchResult`) is **NOT unit-tested**
  (page-context DOM code) — correctly scoped to AC-11 manual verification per
  the spec's own AC-12 text.
- **AC-5 (match ambiguity is surfaced, never silently guessed).**
  `plan.ts::resolveLine(null, null) → 'unmapped'`,
  `report.ts::assembleReport` always renders an `'unmapped'` plan line as
  `status: 'unmatched'` in both dry-run and live, and maps a live
  `'ambiguous'` execution outcome straight through. → **PASS** —
  `extension/src/core/__tests__/plan.test.ts` ("surfaces an unmapped line
  with orderCode:null") + `extension/src/core/__tests__/report.test.ts`
  ("always reports an unmapped line as unmatched regardless of mode",
  "maps live execution outcomes to added / ambiguous / failed") +
  `supabase/tests/extension_ordering.test.sql::(Q1c)` (orderCode:null
  surfaced, never dropped, at the payload layer). **Minor note (not a
  failure):** the DOM adapters (`bjs.ts`/`samsclub.ts`
  `pagePickSearchResult`) return `'failed'` for **zero** search results and
  `'ambiguous'` only for **multiple** results — the spec's AC-5 prose says
  "zero or multiple candidates... marks unmatched/ambiguous." Zero-result
  lines land in the report as `status: 'failed'`, not `'unmatched'` or
  `'ambiguous'`. This still satisfies the substance of AC-5 (never
  silently guessed, always surfaced for the admin to resolve, distinguishable
  from a true add) but the exact status label differs from the AC's literal
  wording — flagged for awareness, not blocking.
- **AC-6 (fills the cart in the admin's session).** Matching/qty resolution
  is pure and unit-tested (see AC-4). The actual add-to-cart DOM interaction
  (`adapters/*.ts::pageAddToCartOnProduct`) and the per-item
  fail-does-not-abort orchestration (`background/service-worker.ts::handleRun`
  — the loop only `return`s early on a detected challenge; any other
  `'failed'`/`'ambiguous'` outcome is pushed to `results` and the loop
  continues) are **NOT unit-tested**. This orchestration logic is
  chrome-API-heavy and could in principle be tested with a mocked adapter +
  mocked `chrome.scripting`/`chrome.tabs`, but no such test exists. → **PASS
  (partial)** on the qty/quantity-passthrough contract
  (`extension/src/core/__tests__/plan.test.ts` — "unit" quantities pass
  through verbatim, "case" ceils via the shared builder) — the live
  cart-fill mechanics + graceful-degradation control flow are **NOT TESTED**
  automatically; this matches the spec's own AC-12 scoping ("site-UI
  automation itself... is NOT unit-testable... verified manually per
  AC-11") but I note the per-item-continue orchestration specifically is a
  control-flow claim that is closer to testable-with-mocks than pure DOM
  automation, and currently has zero coverage of either kind (unit or
  manual-checklist).
- **AC-7 (per-item success/failure report).**
  `extension/src/core/report.ts::assembleReport`/`summarizeReport` — full
  status matrix (`added`/`would-add`/`unmatched`/`ambiguous`/`failed`),
  preserves order, carries qty/unit/orderCode, fail-loud on a missing
  execution result. → **PASS** —
  `extension/src/core/__tests__/report.test.ts` (6 cases).
- **AC-8 (mark ordered after the human pays).**
  `extension/src/lib/imrClient.ts::markOrdered` issues the GUARDED
  `update purchase_orders set status='sent' where id=:poId and
  status='draft'` (not the unguarded write). `popup/popup.ts::onMarkOrdered`
  is a separate, explicit button offered only after a **live** run
  (`show(markBtn, !dryRun && !res.stopped)`) — never automatic on cart-fill.
  → **PASS** — the guard itself is pgTAP-verified at
  `supabase/tests/extension_ordering.test.sql::(M1,M2,M3)` (real transition,
  idempotent 0-row re-run, RLS denies a non-member's write) against the
  exact SQL shape `imrClient.markOrdered` sends; the dry-run-never-writes
  half is `extension/src/core/__tests__/dryRun.test.ts::canMarkOrdered`
  (2 cases) + `background/service-worker.ts::handleMarkOrdered`'s
  `canMarkOrdered(req.dryRun)` gate (code inspection — this call site itself
  has no dedicated unit test, but it is a one-line delegation to the tested
  `canMarkOrdered`).
- **AC-9 (HARD boundary — never checkout/pay, never store credentials, never
  fight a CAPTCHA).** Verified by direct source inspection (grep across
  `extension/src` + `manifest.json`, per the design's own "review-REJECT
  contract" framing, D-8):
  - No checkout/place-order/pay code path — the add-to-cart button finders
    in `adapters/bjs.ts` / `adapters/samsclub.ts` explicitly EXCLUDE
    `checkout|place order|pay|continue to` text; no navigation to a
    checkout/payment URL exists anywhere in the source.
  - No vendor-credential input/storage — the only password field
    (`popup/popup.ts` `#password`) round-trips to
    `imrClient.signIn(email, password)`, which is the admin's own I.M.R
    Supabase login (`auth.signInWithPassword`), never a vendor field; the
    session lives in `chrome.storage.local` (extension-sandboxed,
    `storageAdapter.ts`).
  - Challenge-detection stop — `adapters/*.ts::pageDetectChallenge` (CAPTCHA
    iframe / `px-captcha` / "verify you are human" / "access denied"
    markers) is called both in the AC-9 `preflight()` before a live run
    starts and mid-run after every navigation
    (`background/service-worker.ts::executeAction`); a detected challenge
    halts the whole run (`handleRun`'s early `return` on
    `res.detail.startsWith('Challenge detected')`).
  - `host_permissions` scoped to exactly the two vendor origins + the one
    injected Supabase origin, never `<all_urls>` (same evidence as AC-1).
  → **PASS by code inspection.** As with AC-1, there is **no automated
  regression test** (e.g., a grep-based lint script or a manifest-shape
  vitest test) that would catch a future PR silently reintroducing a
  checkout path or widening host_permissions — the D-8 "review-REJECT
  contract" is currently a human-inspection duty every time, not a CI gate.
  Not blocking (matches the design's own stated verification method for
  this AC), but flagged as a durable-regression-prevention gap, same as
  AC-1.
- **AC-10 (dry-run mode).** `extension/src/core/dryRun.ts::actionsToExecute`
  returns `[]` in dry-run (no cart side effect) and only resolvable actions
  live; `canMarkOrdered` blocks the write in dry-run. Default-ON in the UI
  (`public/popup.html` `#dry-run checked`). Report renders `'would-add'` in
  dry-run (`report.ts`). → **PASS** —
  `extension/src/core/__tests__/dryRun.test.ts` (4 cases) +
  `extension/src/core/__tests__/report.test.ts` ("renders would-add for
  resolvable lines in dry-run") + `background/service-worker.ts::handleRun`
  returns before any preflight/execute call when `req.dryRun` is true (code
  inspection — structurally impossible to reach a cart/write side effect in
  that branch).
- **AC-11 (owner-in-the-loop verifiable).** Explicitly a manual acceptance
  gate per the spec itself ("no CI test can exercise the live vendor
  sites"). → **NOT TESTED (expected — owner-manual)**, correctly documented
  in `extension/README.md` ("What is and isn't tested automatically") and
  the OWNER-TUNE-ZONE comments in `adapters/bjs.ts` / `adapters/samsclub.ts`.
  Not a BLOCK per the spec's own scoping.
- **AC-12 (automated coverage of pure logic; live sites are manual).**
  29 vitest cases across 5 files
  (`urlGuard`/`origin`/`plan`/`dryRun`/`report`) cover exactly the pure
  logic the AC names: pending-PO parse/match, per-vendor matching decision
  (fixture-driven), report assembly, the dry-run gate. → **PASS** —
  `extension/` (`npm test`, vitest, 29/29 green, see Test run below).

### Test run

**Extension (vitest + tsc, `extension/`):**
```
cd extension && npm run typecheck   # tsc -p tsconfig.json --noEmit → clean, 0 errors
cd extension && npm test            # vitest run
  ✓ src/core/__tests__/report.test.ts (6 tests)
  ✓ src/core/__tests__/origin.test.ts (5 tests)
  ✓ src/core/__tests__/urlGuard.test.ts (5 tests)
  ✓ src/core/__tests__/dryRun.test.ts (4 tests)
  ✓ src/core/__tests__/plan.test.ts (9 tests)
  Test Files  5 passed (5)
  Tests       29 passed (29)
```
(`extension/node_modules` was already installed; no `npm install` needed.)

**Repo root — Expo/jest graph unaffected by the extension tree:**
```
npx tsc --noEmit                          → clean, 0 errors
npx tsc -p tsconfig.test.json --noEmit    → clean, 0 errors
npx jest                                  → Test Suites: 122 passed, 122 total
                                             Tests:       1322 passed, 1322 total
                                             (matches the "Files changed" claim exactly)
```

**pgTAP (`scripts/test-db.sh` via `npm run test:db`, local Supabase stack
already running):**
```
75/75 DB test file(s) passed
```
including `supabase/tests/extension_ordering.test.sql` (19 assertions —
`get_pending_extension_orders`, `get_extension_order_payload`, and the
guarded mark-ordered UPDATE that `extension/src/lib/imrClient.ts` calls)
and `supabase/tests/apply_item_vendors_to_brand.test.sql` /
`supabase/tests/vendors_role_access.test.sql` (both modified for the
spec-131 additive columns this extension consumes).

**CI wiring check (`.github/workflows/test.yml`):** a fifth job, `extension`
("Track 1c — extension typecheck + unit tests"), runs with
`working-directory: extension`, does `npm ci` against
`extension/package-lock.json`, then `npm run typecheck` and `npm test`.
Confirmed present and correctly scoped (does not touch
`db-migrations-applied.yml`, which was not modified by this spec).

**Isolation from the Expo graph — confirmed via direct file read, not just
the claim in "Files changed":**
- `tsconfig.json` — `"exclude"` includes `"extension/**"`.
- `metro.config.js` — `resolver.blockList` includes a RegExp scoped to the
  `extension/` absolute path.
- `jest.config.js` — `modulePathIgnorePatterns` includes
  `'<rootDir>/extension/'`.
- `.gitignore` — `extension/node_modules/`, `extension/dist/`.
- `.github/workflows/db-migrations-applied.yml` — untouched (not in the
  spec's diff).
- `app.json` `slug` — untouched (not in the spec's diff).

### Notes

- **Framework note (no violation).** `extension/` uses vitest, which is
  explicitly design-authorized in this spec's own "Build / verification
  notes" as NOT a fourth main-repo track — the extension is outside the
  Expo jest/pgTAP/shell three-track graph entirely, has its own
  `package.json`/`package-lock.json`, and the root `package.json` is
  untouched. Confirmed: `git diff --stat` shows no change to the root
  `package.json`. This matches CLAUDE.md's "surface, don't silently
  introduce" bar — it was surfaced in the spec text itself, not silently
  slipped in.
- **Two durable-regression gaps, both low-severity, both currently PASS by
  manual inspection only:**
  1. **AC-1 / AC-9 static-config assertions (host_permissions scope, no
     checkout code path) have no automated CI guard.** A future PR could
     widen `host_permissions` to `<all_urls>` or reintroduce a
     checkout/pay code path and neither `npm run typecheck` nor `npm test`
     would catch it — only a human reviewer re-doing the D-8 grep would.
     Recommend (follow-up, not blocking): a small
     `extension/src/core/__tests__/manifest.test.ts` that imports
     `manifest.json` and asserts the exact `host_permissions` array, plus a
     grep-based check (even a simple Node script in `extension/scripts/`)
     for `checkout|place order|pay` navigation/click targets outside the
     adapters' explicit-exclusion regexes.
  2. **AC-5's zero-search-result path reports `'failed'`, not
     `'unmatched'`/`'ambiguous'`.** Not a functional bug (the line is
     surfaced, never silently guessed or dropped, and is visually
     distinguishable from a true `'added'` outcome) but a label mismatch
     against the AC's literal wording. Worth a one-line spec/architect
     clarification in a follow-up, not a ship-blocker.
- **AC-6's per-item-continue orchestration (service-worker.ts::handleRun)
  has zero automated coverage** — neither the pure-logic vitest suite (out
  of scope by design, since it needs chrome-API mocks) nor the manual
  AC-11 checklist explicitly calls it out as a thing the owner should
  verify (the checklist as currently documented in `README.md` focuses on
  matching/selectors, not "does a single item's add-to-cart failure abort
  the whole run"). Recommend the owner's AC-11 live/dry-run pass include at
  least one deliberately-unmatched or deliberately-failing line in the test
  PO to visually confirm the run continues past it — flagging as a
  suggestion for the manual verification step, not a code gap.
- **Backend dependency confirmed live locally.** Spec 131's migrations
  (`20260723000000_extension_ordering.sql`,
  `20260724000000_apply_item_vendors_product_page_url.sql`) and RPCs are
  present in the working tree and pass pgTAP locally, so the two RPCs +
  guarded UPDATE this extension calls are real, not aspirational. Spec 131
  itself is still READY_FOR_REVIEW per the spec header — 132's tests here
  don't re-litigate 131's own review, but confirm the contract 132 depends
  on is live and shaped as `extension/src/lib/types.ts` expects.
- No mutation of `supabase/seed.sql`; the pgTAP fixture data in
  `extension_ordering.test.sql` is created and rolled back inside a single
  transaction (`begin; ... rollback;`), consistent with project policy.
- No file under the "Hard rules" section (`app.json` `slug`) was touched.

### Summary

- **10 PASS** (AC-2, AC-3, AC-4, AC-5, AC-7, AC-8, AC-9, AC-10, AC-12, and
  AC-1 by direct inspection)
- **1 PASS-partial** (AC-6 — matching/qty logic covered; live cart-fill
  mechanics and the fail-per-item orchestration are uncovered by design,
  consistent with the spec's own AC-12 scoping, but the orchestration
  specifically is flagged as an addressable gap)
- **1 NOT TESTED (expected, owner-manual, not a BLOCK)** — AC-11
- No AC is FAIL. No AC is an unexplained/unexpected NOT TESTED. The two
  "no automated CI guard" notes (AC-1/AC-9 static config, AC-6 orchestration)
  are flagged as follow-up hardening, not blockers, because in every case I
  independently verified the current state is correct by direct inspection
  and the gaps are about **regression protection**, not present-state
  correctness.
