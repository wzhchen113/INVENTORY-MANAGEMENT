# Code review for spec 152 — session loss must be honest

Reviewed all 20 non-spec files under `## Files changed`. Frontend-only, no
migration/edge-function touched, consistent with the spec's claim.

## Judgment on the three flagged seams

1. **Fail-open `hasActiveSession` probe (`src/lib/auth.ts:181-188`).** Right
   call. This probe never gates authorization — Postgres RLS is still the only
   real boundary, and an anon-shaped read already comes back `200 []` whether
   or not this probe exists. The only question this probe answers is "fetch or
   bail with a banner," so failing open reproduces exactly the pre-spec
   behaviour instead of manufacturing a false "you're signed out" bounce on a
   legitimate session whenever the probe itself glitches (bad dynamic import,
   local exception). Fail-closed would trade a rare stale-blank-screen bug for
   a rare false-logout bug, which is not obviously better. Security-auditor's
   report already walks the residual fail-open cases in detail (Low, accepted
   per AC-10) — I don't re-litigate that here, but see Should-fix #3 below for
   a craft-level gap the probe introduces (no timeout).

2. **`markIntentionalSignOut()` crossing the dynamic-import boundary in
   `logout()` (`src/store/useStore.ts:1100-1110`).** Safe, no race. The chain
   is `import('../lib/sessionWatch').then(setFlag).catch(...).finally(() =>
   import('../lib/auth').then(signOut))` — `.finally()` only runs after the
   first promise settles, so the flag is unconditionally set (or the import
   itself failed) before `signOut()` is even requested, and `signOut()` still
   has to complete a real network round-trip before supabase-js can emit
   `SIGNED_OUT`. Independently confirms security-auditor's "Clean" finding on
   this same seam. The flag is also provably redundant for the *admin* path
   specifically — `set({ currentUser: null })` runs synchronously at the very
   top of `logout()` (line 1076), before either dynamic import starts, so
   `handleSessionLoss`'s `hadAdmin` guard (`sessionWatch.ts:82`) would already
   no-op even if the flag never got set. That redundancy is intentional
   ("belt-and-braces," `sessionWatch.ts:69-71`), not a bug.

3. **`sessionWatch` clearing the staff store from a shared lib vs spec-063
   slice isolation.** This is the one seam I'd push back on — see Should-fix
   #2.

**Subscription lifecycle:** single install confirmed — one
`useEffect(() => watchSessionLoss(), [])` in `App.tsx:350`, mounted at the
component that owns the app's lifetime (not inside `RoleRouter`, so it
survives the admin↔staff↔signed-out transitions it exists to catch), deps
array empty so it never re-subscribes, and the returned cleanup
(`sessionWatch.ts:131-137`) unsubscribes exactly once. Standard React effect
cleanup semantics mean Fast Refresh re-running this effect tears down the old
subscription before installing the new one — no accumulation. Pinned by the
`watchSessionLoss` test's explicit `unsubscribe` assertion.

**Toast/i18n parity:** checked all six files. Admin (`src/i18n/{en,es,zh-CN}.json`)
carries `chrome.sessionExpired.{title,body}` + `chrome.signedOutIndicator` +
`chrome.sessionBanner.{title,body,action}`; staff
(`src/screens/staff/i18n/{en,es,zh-CN}.json`) carries only
`chrome.sessionExpired.{title,body}` (staff has no TitleBar indicator or
banner, so it correctly doesn't need the other two key families). All three
locales are present and non-empty on both catalogs — no missing-key drift.

## Critical

None.

## Should-fix

- `src/store/useStore.ts:190-193` — the JSDoc for `handleSessionLost` says
  "Called by `lib/sessionWatch`, never by a UI control," but
  `src/components/cmd/SessionLostBanner.tsx:61` calls it directly from the
  banner's "Sign in" button `onPress`. This is a deliberate second call site
  per the banner's own comment (`SessionLostBanner.tsx:55-58`: "Same action
  the auth watcher fires; exposed here for the window where no auth event
  ever arrives") — not a bug — but the action's doc comment asserts an
  invariant the same spec violates one file later, which will mislead the
  next person who greps for callers and trusts the comment over the code.
  Update the comment to name both callers.

- `src/lib/sessionWatch.ts:23-24` + `src/screens/staff/screens/Settings.tsx:28,92`
  — `sessionWatch.ts` statically imports both `useStore` (admin) and
  `useStaffStore` (staff), and the staff `Settings` screen statically imports
  `markIntentionalSignOut` from `sessionWatch.ts` — the only thing it needs
  from that module. That means staff code now transitively pulls in the
  entire admin store module graph (`src/store/useStore.ts`, admin `src/i18n`)
  through one import, which is exactly the coupling
  `src/screens/staff/store/useStaffStore.ts:6-7` documents as off-limits
  ("staff code never imports `useStore`"). `RoleRouter.tsx:30-31` is a
  precedent for a *root-only* bridge file crossing both stores, but that file
  is never imported *by* the staff subtree — this one now is. It's zero-cost
  today (App.tsx already statically imports both stores at the root
  regardless, so there's no bundle-splitting to break), but it's an
  undocumented erosion of a written portability contract. Either split the
  pure flag (`markIntentionalSignOut`/`_resetIntentionalSignOut`, which has no
  store dependency at all) into its own zero-dependency module that both
  `sessionWatch.ts` and `Settings.tsx` import, or add an explicit note (here
  and/or in `useStaffStore.ts`'s isolation comment) recording this as an
  intentional third exception, the way the `supabase.from/rpc` carve-out list
  in CLAUDE.md is explicit about its exceptions.

- `src/store/useStore.ts:1594-1599` — the session probe
  (`await import('../lib/auth')` → `await hasActiveSession()`, which itself
  awaits `supabase.auth.getSession()` and may drive a network token refresh)
  has no timeout or race. Before this spec, `loadFromSupabase` went straight
  into `db.fetchStores()`; now every call — including every 400ms-debounced
  realtime reload — is gated behind this new awaited step first. A slow (not
  failed — failed already fails open per the try/catch) auth endpoint now
  stalls the entire load pipeline where it previously wouldn't have blocked at
  all. Consider `Promise.race([hasActiveSession(), delay(N).then(() => true)])`
  so a hung probe degrades to the documented fail-open outcome without also
  freezing every store switch / brand switch / realtime reload behind it.

## Nits

- `src/store/useStore.ts:1593-1599` — the outer `try/catch` around the
  dynamic import is largely redundant: `hasActiveSession`
  (`src/lib/auth.ts:181-188`) already swallows every internal error and
  returns `true` on its own. The outer catch can only ever fire if
  `import('../lib/auth')` itself throws (module resolution failure). Harmless
  double bookkeeping — a one-line comment clarifying that the outer catch
  exists solely for the import-resolution case (not for anything
  `hasActiveSession` itself can throw) would save a future reader the
  re-derivation.

- `src/lib/sessionWatch.ts:34-35` — "Consumed exactly once by
  `handleSessionLoss` (or by the next call to itself)" is a confusing
  parenthetical for a plain boolean flag; calling `markIntentionalSignOut()`
  twice before it's consumed is just a no-op re-set, not a second consumption
  path. Minor clarity nit on the wording, not the logic.

- CLAUDE.md's enumerated carve-out list for direct `supabase.from/rpc` calls
  outside `db.ts` (auth.ts, webPush.ts, authGate.ts, sessionRestore.ts, the
  staff subtree) doesn't mention `src/lib/sessionWatch.ts`, which now also
  calls `supabase.auth.onAuthStateChange` directly. `onAuthStateChange` isn't
  PostgREST/RPC so the rule's letter doesn't require the addition, but for an
  auditor grepping that list in six months, a one-line addition (or a comment
  in `sessionWatch.ts` cross-referencing the precedent) would keep the trail
  complete.

- (out-of-scope) The staff EOD surface's own data-loading paths (weekly
  count, reorder, etc. — direct `supabase.rpc` calls per the spec-063
  carve-out) weren't audited here for the same "RLS-denied read silently
  replaces good data" shape that caused the incident on the admin side. The
  spec explicitly scopes its part-2 fix to `loadFromSupabase` only and the
  incident itself was an admin/super_admin session, so this is a reasonable
  scope cut, not a gap in this diff — flagging only as a possible follow-up
  spec, not a finding against this one.
