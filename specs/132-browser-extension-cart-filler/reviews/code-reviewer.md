# Code review for spec 132

Scope: the `extension/` subtree (Chrome MV3 cart-filler) and the five Expo-graph
isolation edits (`tsconfig.json`, `metro.config.js`, `jest.config.js`,
`.gitignore`, `.github/workflows/test.yml`). Craftsmanship + structure review
only — architecture and security are covered by the architect / security-auditor.

## Summary

The implementation matches the design closely and the ship-blocking contracts
hold up under inspection:

- `extension/src/core/plan.ts` imports `computePoQuickOrderLines` from
  `../../../src/utils/poQuickOrderText.ts` verbatim — no forked case math. The
  extension only adds its own resolution-strategy layer (`url` / `search` /
  `unmapped`) on top of the shared builder's already-trimmed `orderCode`.
- `extension/src/lib/imrClient.ts:91-100` (`markOrdered`) issues the guarded
  `update ... set status='sent' where id=:poId AND status='draft'` — confirmed
  against spec 131 D-4's exact SQL shape, not the unguarded pattern.
- `extension/src/adapters/bjs.ts` and `samsclub.ts` both carry an explicit
  `OWNER-TUNE ZONE` banner around the best-effort DOM selectors, and neither
  file (nor `service-worker.ts`) contains a checkout/payment code path or any
  vendor-credential handling — grepped `checkout|place.?order|payment|password`
  across `extension/src` and every hit is either the documented AC-9 exclusion
  regex or the I.M.R login (never a vendor credential).
- `manifest.json` host_permissions are exactly `bjs.com` + `samsclub.com`; the
  Supabase origin is injected additively by `build.mjs` at build time — no
  `<all_urls>` anywhere, matching AC-1/AC-9.
- Isolation is correctly wired: `tsconfig.json` excludes `extension/**`,
  `metro.config.js` blocklists it, `jest.config.js` ignores it via
  `modulePathIgnorePatterns`, `.gitignore` covers `extension/node_modules` +
  `extension/dist`, and `.github/workflows/test.yml` adds a genuine Track 1c
  job (own `working-directory`, own `package-lock.json` cache key, runs
  `typecheck` then `test`) independent of the three existing jobs. Root
  `package.json` has no `workspaces` field, so `npm ci` at repo root can't
  accidentally pull the extension's deps in either direction.
- The 29 vitest cases across `core/__tests__/*` are real, un-padded coverage of
  the pure logic (resolution strategy, plan building incl. case-math delegation,
  origin join, dry-run gate, report assembly, URL scheme guard) — recounted by
  hand against the design's AC-12 checklist and the claimed count matches
  exactly.

No Critical findings.

## Critical

None.

## Should-fix

- `extension/src/background/service-worker.ts:200` — the mid-run "a challenge
  appeared, abort the whole run" decision is implemented as
  `res.detail.startsWith('Challenge detected')`, i.e. a string-prefix match on
  human-readable text that's also produced at `executeAction` (lines 121, 135).
  This is a security-relevant control-flow decision (it's what makes AC-9's
  "challenge → stop the whole run" real) coupled to free-text copy that has no
  test coverage (this file sits outside the pure `core/` that AC-12 covers). A
  future copy edit to either detail string silently turns a mid-run CAPTCHA hit
  into "just another failed line" instead of a full stop. Add a structured
  signal instead — e.g. `outcome: 'challenge'` on `ExecutionResult` / a
  `challenge: boolean` field — and branch on that.
- `extension/src/adapters/bjs.ts:59` and `extension/src/adapters/samsclub.ts:57`
  — `pageIsLoggedIn` defaults to **logged in** (`return signIn ? false : true`)
  when the page has neither a recognizable "signed in" marker nor a "sign in"
  prompt. AC-9's "not logged in → stop" is the hard boundary this routine
  exists to enforce; on an ambiguous/unrecognized page state it currently fails
  open (assumes logged in, proceeds) rather than fail closed. Given the rest of
  this spec's posture is explicitly "never guess, surface instead" (AC-5), this
  one heuristic should default to `false` (stop, ask the human) when neither
  marker is found, not `true`.
- `extension/src/core/plan.ts:49-68` (`buildPlan`) discards the shared
  builder's per-line `rounded` flag (`StructuredOrderLine.rounded` from
  `computePoQuickOrderLines`). `src/utils/poQuickOrderText.ts` documents
  `rounded`/`roundedCount` as the deliberate fail-loud signal for a case-qty
  round-up (the admin Cmd UI and staff app both surface it as a warning); the
  extension's `PlannedAction`/`ReportLine` types carry no equivalent field, so
  an admin running a live fill gets no visibility into which lines were rounded
  up to a whole case. Not an explicit AC-12 requirement, but a real information
  loss against the project's own "fail loud, never silently drop" convention —
  worth surfacing via the report `detail` text (e.g. append "(rounded up from
  X.Y cases)" when `s.rounded` is true).
- `extension/src/adapters/types.ts:60-66` / `bjs.ts:84-103` /
  `samsclub.ts:81-98` — `PageActionResult.outcome: 'added'` is overloaded with
  two different meanings on the same type: from `pagePickSearchResult` it means
  "resolved to exactly one search candidate" (no cart mutation has happened
  yet — `service-worker.ts:123-127` still has to navigate to the product page
  and call `pageAddToCartOnProduct` afterward), while from
  `pageAddToCartOnProduct` it means "the add-to-cart click actually fired."
  Reusing one enum value for two different steps on a type whose whole purpose
  is to report what happened invites a future caller to short-circuit on the
  wrong step. Give the search-pick step its own value (e.g. `'resolved'`) or
  split `PageActionResult` into two purpose-specific types.

## Nits

- `.gitignore:34-35` — `extension/node_modules/` and `extension/dist/` are
  already covered by the pre-existing unscoped `node_modules/` (line 1) and
  `dist/` (line 3) patterns. Harmless belt-and-suspenders, but redundant.
- `metro.config.js:11` — `EXTENSION_BLOCK` is built as
  `` `${path.resolve(__dirname, 'extension')}/.*` `` with a hardcoded forward
  slash; `path.resolve` on Windows returns backslash separators, so this
  wouldn't match there. Not a real risk given CI and the documented dev flow
  are unix-based, but a `path.sep`-aware join would be more portable if that
  ever changes.
- `extension/src/adapters/bjs.ts` and `samsclub.ts` — the challenge/login
  detection selectors are near-duplicated between the two files. This looks
  like it should be extracted, but `adapters/types.ts:6-13` explains why it
  can't be: `chrome.scripting.executeScript` serializes each page routine
  independently, so they must be self-contained with no module-scope helpers.
  Flagging only so a future reader doesn't mistake this for an oversight.
