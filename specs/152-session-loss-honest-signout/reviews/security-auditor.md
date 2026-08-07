# Security audit for spec 152 — session loss must be honest

Reviewed: the full staged diff (20 files, frontend-only). No migration, no edge
function, no RLS/grant/RPC change — the server-side authorization boundary
(`auth_is_admin()` / `auth_can_see_store()`) is untouched and remains the only
real boundary. Nothing in this change is used as an authorization decision:
`hasActiveSession()` only decides whether to *skip a fetch*, never whether to
*allow* one. That is the correct shape.

### Critical (BLOCKS merge)

None. Nothing here blocks — spec 152 may advance on the security axis.

### High (must fix before deploy)

None. Every failure mode I could construct degrades to either (a) the exact
pre-spec-152 behaviour or (b) a UI-truth defect bounded by server-side RLS.
No new authorization bypass, no new secret surface, no new network surface.

### Medium

- `src/store/useStore.ts:1600-1609` + `src/store/useStore.ts:1033-1039` —
  **the bail raises `sessionLost` unconditionally, and `login()` never clears
  it.** The bail runs after two `await`s (`import('../lib/auth')`, then
  `hasActiveSession()`), so a load that was already in flight when the user
  signed out can land *after* `logout()` (line 1099) or `handleSessionLost()`
  (line 1129) already set `sessionLost: false`. The result is a banner armed
  over the *next* session: the following user signs in, `login()` does not reset
  the flag, and their shell mounts with the red "signed out" dot
  (`src/components/cmd/TitleBar.tsx:258`) plus the banner — whose primary button
  calls `handleSessionLost()` (`src/components/cmd/SessionLostBanner.tsx:61`)
  and force-ejects a legitimately authenticated user. It normally self-heals on
  their first successful load (line 1612), but `login()`'s failure branch
  (`src/store/useStore.ts:1064-1068`) never calls `loadFromSupabase`, so a
  `fetchStores()` failure leaves the false "signed out" state stuck. The same
  stale bail also clears `storeLoading` / `switching` (lines 1606-1607) out from
  under the *new* load, dropping the spec-055 skeleton / spec-111 overlay early.
  This is a lie in the opposite direction from the incident, in the one
  indicator the spec exists to make honest.
  **Fix:** guard the bail with the current identity — e.g. capture
  `const owner = get().currentUser?.id` before the probe and `if (get().currentUser?.id !== owner) return;`
  (or a monotonic load-generation counter) before the `set()` — and add
  `sessionLost: false` to `login()`'s first `set()`.

- `src/lib/sessionWatch.ts:58-61` (+ `src/lib/auth.ts:181-188`) — **the loss
  predicate does not detect an identity CHANGE.** `isSessionLossEvent` keys
  purely on `session == null`, and `hasActiveSession()` returns `true` for *any*
  session regardless of subject. auth-js 2.101.1 replays other tabs' auth events
  into this tab over a `BroadcastChannel`
  (`node_modules/@supabase/auth-js/dist/main/GoTrueClient.js:186-201`), so
  signing in as user B in a second tab hands tab A a `SIGNED_IN` event with a
  **non-null** session — not a loss. Tab A therefore keeps `currentUser = A`,
  keeps A's already-loaded slices on screen, keeps the `AdminStack` branch
  mounted (`src/navigation/RoleRouter.tsx:50-52`), and issues every subsequent
  request with **B's JWT**. Data exposure is bounded by RLS — B's JWT only
  returns rows B may see — so this is not a leak; it is the shell asserting the
  wrong identity, and a possibly lower-privileged subject driving admin-only
  client UI (server-side gates still hold). Pre-existing in the sense that there
  was no listener at all before, but this spec is where the listener lands and
  the fix is three lines.
  **Fix:** in the subscription callback, also treat
  `session.user.id !== useStore.getState().currentUser?.id` (and the staff
  `authState.userId` equivalent) as a loss and route it through
  `handleSessionLoss()`.

- `src/store/useStore.ts:1116-1136` (and pre-existing `logout()` at 1075) —
  **neither teardown clears the loaded data slices.** `handleSessionLost` resets
  user/brand context, `lastOrderContext`, `sessionLost`, `storeLoading` and
  `switching`, but `items`, `recipes`, `sales`, `users`,
  `submissionNotifications` etc. stay in the Zustand store after the bounce to
  the sign-in portal. On a shared terminal the next user's `login()` mounts the
  shell with the previous user's rows rendered until `loadFromSupabase` resolves
  — and `login()` reaches the shell before its own fetch completes. This is the
  same class of finding spec 038 fixed for `locale` and spec 151 fixed for
  `lastOrderContext`; the data slices are the larger remainder. Pre-existing on
  the `logout()` path, but spec 152 adds a **second** entrance to it
  (involuntary loss), so it is worth closing here.
  **Fix:** extract the reset both actions share and null/empty the store-scoped
  data slices in it.

### Low

- `src/lib/sessionWatch.ts:32-38` + `src/screens/staff/screens/Settings.tsx:92`
  + `src/store/useStore.ts:1105-1110` — **the intentional-sign-out flag can get
  stuck armed.** Both call sites set the flag *before* `supabase.auth.signOut()`,
  which is correct for ordering, but auth-js returns early **without** emitting
  `SIGNED_OUT` when the sign-out call fails with anything other than
  401/404/403 — including a network failure
  (`GoTrueClient.js:3157-3171`: `_removeSession()` is skipped on that path). The
  flag is module-global with no TTL and is only consumed by an actual loss
  event, so it stays armed for the tab's lifetime and **swallows the next
  genuine session loss**: no store teardown, no toast. On the admin surface the
  `loadFromSupabase` bail still raises the banner; on the staff surface there is
  no banner and no probe, so it is fully silent — i.e. exactly the pre-spec
  incident state. Worst case equals pre-fix behaviour, hence Low.
  **Fix:** disarm on a short timer (`setTimeout(..., 10_000)`) and/or clear the
  flag in `login()` / staff `setAuthState({kind:'signed-in'})`.

- `src/lib/auth.ts:181-188` — **fail-open probe residuals (answering the brief's
  question directly).** Three ways the probe returns `true` when it arguably
  should bail: (1) the dynamic import or `getSession()` throws → `catch` returns
  `true`; (2) a locally-valid session whose JWT the server no longer accepts
  (user deleted server-side, keys rotated) — `getSession()` is a local-storage
  read plus refresh, not a server validation; (3) a session belonging to a
  *different* user (see the Medium above). In cases (1) and (2) the load
  proceeds, the anon/denied reads come back `200 []`, and the slices are blanked
  — **the pre-fix behaviour exactly**. That is an availability/UX regression
  only, with no confidentiality impact (an anon read returns nothing). Accepted
  as documented in AC-10; no change requested for (1)/(2).

- `src/components/cmd/SessionLostBanner.tsx:78-94` +
  `src/store/useStore.ts:1137` — **the banner path retains data on screen
  indefinitely.** By design the bail keeps prior slices; the banner is
  dismissible and `sessionLost` never escalates to a forced bounce, so a dead
  session can sit on a fully-populated screen until someone reloads. The
  realistic cross-user version of this (user A signs out in another tab, user B
  reads A's data in this tab) is **covered**: auth-js replays `SIGNED_OUT` over
  the BroadcastChannel and the intentional flag is per-tab module state, so the
  other tab treats it as a real loss, calls `handleSessionLost()` and unmounts
  the shell. The residual window is a token that dies with no auth event ever
  arriving. Consider escalating to `handleSessionLost()` after N consecutive
  bails or an idle timeout so a shared terminal cannot sit on a dead session's
  data forever.

- `src/store/useStore.ts:1117-1136` — `handleSessionLost` deliberately skips the
  `locale: 'en'` + `persistLocaleLocal('en')` reset that `logout()` performs
  (the spec-038 shared-machine Low). The rationale in the doc comment is
  reasonable (an involuntary loss is overwhelmingly the same person) and locale
  is a preference, not PII. Informational only — flagged so the divergence from
  the spec-038 precedent is recorded rather than rediscovered later.

- `src/lib/sessionWatch.ts:89-95` — **staff teardown completeness (answering the
  brief's question).** `setActiveStore(null)` also nulls the persisted
  `activeStoreId` (`src/screens/staff/store/useStaffStore.ts:190-194`), and
  `setAuthState({kind:'signed-out'})` matches the deliberate path byte-for-byte
  (`src/screens/staff/screens/Settings.tsx:95-100`). What survives in both paths
  is `weeklyStatus` (store-scoped count status) and the persisted `eodQueue`.
  The queue is intentionally durable offline data and `pendingCountForUser`
  filters by `intent_user_id`, so a next user is not shown another user's
  queued counts. No divergence from the deliberate sign-out — no fix required;
  `weeklyStatus` would ride along free if the Medium slice-clearing fix lands.

### Clean (checked, no finding)

- **No token or session material logged or persisted.** The only `console.*` in
  the diff is the pre-existing `console.warn('[Supabase]', e?.message || e)`
  around `signOut()` (`src/store/useStore.ts:1109`) — an auth error message, no
  token. `hasActiveSession` swallows silently. `sessionWatch` logs nothing.
- **`sessionLost` is in-memory only** — no zustand `persist` middleware anywhere
  in `src/store/`, and the flag is never written to localStorage/AsyncStorage.
- **No new env vars, no `EXPO_PUBLIC_*` additions, no secrets.** The spec's
  manual repro script (`specs/152-session-loss-honest-signout.md:187-214`) uses
  `<super_admin email>` / `<password>` placeholders — no real credentials
  committed. It reads the local auth-token key only inside the ad-hoc driver and
  is deliberately not wired into CI.
- **Toast/banner copy is static i18n** (`src/i18n/en.json:153-162`,
  `src/screens/staff/i18n/en.json:441-444`) — no interpolation of user, store,
  error or SQL text, so no PII or internal detail reaches the surfaced message.
- **Intentional-sign-out ordering is correct on both paths.** `logout()` chains
  `markIntentionalSignOut()` in a `.then()` and only calls `signOut()` in the
  `.finally()` (`src/store/useStore.ts:1110-1114`), so the flag is always armed
  before the event can fire; the staff path calls it synchronously before
  `await supabase.auth.signOut()`. If the sessionWatch import fails, the
  `currentUser !== null` / `authState.kind` guard (`sessionWatch.ts:82-84`) is
  the backstop, since `logout()` nulls `currentUser` synchronously first.
- **The null-keyed predicate is the conservative direction** — an unknown future
  event with a null session is treated as a loss (`sessionWatch.ts:58-61`),
  which fails toward signing the user out rather than toward a stale shell.
  `INITIAL_SESSION` exclusion is correct and cannot be abused (it cannot carry a
  session for a user who never authenticated).
- **`watchSessionLoss()`'s try/catch cannot mask an auth failure into
  authorization** — it only returns a no-op unsubscribe if the client can't be
  subscribed to, and nothing downstream trusts the subscription's existence.
- Spec 150's brand logic, `useConnectionStatus`, and every RLS/edge-function
  surface are untouched (AC-REG2/AC-REG3 hold in the diff).

### Dependencies

`package.json` / `package-lock.json` unchanged in this diff — `npm audit`
skipped per process.
