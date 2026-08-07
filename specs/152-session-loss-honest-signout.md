# Spec 152: Session loss must be honest — no silent blank shell

Status: READY_FOR_REVIEW

> Prod incident (2026-08-03, owner / super_admin). Every surface read empty —
> Inventory `0 items`, Prep `no prep recipes for Charles` — while the chrome
> still showed `2P://charles`, `BRAND All brands` and a green **connected**
> dot; Ordering failed with `permission denied for function
> report_reorder_list`. Frontend-only; no backend / migration / edge-function
> change. Spec 150's brand logic is NOT involved and is NOT touched.

## Root cause (reproduced in a browser, not inferred)

The client was making requests **without a valid user JWT** — PostgREST ran
them as `anon`.

Verified against the local stack:

| caller | `report_reorder_list` | table reads (`stores`, `inventory_items`, `prep_recipes`, `brands`) |
|---|---|---|
| authenticated (owner JWT) | `200` + payload | rows |
| `anon` | `42501 permission denied for function report_reorder_list` | `200 []` — **silent** |

That asymmetry is the whole bug. RLS-denied **table** reads return an empty
array with a 200, and `loadFromSupabase` is documented as "cloud is the source
of truth — always replace, even if empty", so an anon read **overwrites good
in-memory data with nothing**. RPCs, by contrast, hard-fail (`42501`), which is
the one symptom that named the real cause: the function's own store gate raises
a *different* string (`Not authorized for store <uuid>`), so
`permission denied for function` can only mean "no user JWT on the request".

Two amplifiers turned a recoverable auth blip into an unreadable app:

1. **No `onAuthStateChange` subscription exists anywhere** (`grep` across
   `src/` + `App.tsx` returned only a comment in `recoveryRedirect.ts`).
   `RoleRouter` gates purely on the in-memory `currentUser`, so a session that
   dies mid-session leaves a fully-mounted, signed-in-looking shell forever.
2. **The connection indicator reads the realtime websocket only**
   (`useConnectionStatus`, spec 059). The socket stays open on the old token,
   so the chrome actively asserted `connected` while every read was anon.

Confirmed by simulation: sign in normally, strip the user JWT off every REST
call, let the app's own realtime reload run → the screen reproduces the prod
report byte-for-byte, including `no prep recipes for Charles` and the verbatim
`permission denied for function report_reorder_list` console warning.

Not the cause, checked and excluded: spec 150's `reconcileActiveBrand` /
`setCurrentBrandId`. With a cached store-less brand the app self-heals to "All
brands" + a real store + full data on cold boot, and no data loader reads
`currentBrandId` at all (its only non-test consumers are `TitleBar`,
`PhoneStoreSwitch`, `BrandPicker`). `BRAND All brands` in the incident
screenshot is just the post-sign-in default — `login()` clears the cached brand
by design.

## Design

Three parts, all frontend, all "tell the truth instead of rendering a lie".

### 1 — Honest sign-out on session loss (`src/lib/sessionWatch.ts`, new)

One `supabase.auth.onAuthStateChange` subscription, installed once from
`App.tsx` and torn down on unmount.

- **Loss predicate** — `isSessionLossEvent(event, session)`: a `null` session on
  any event except `INITIAL_SESSION`. Keyed on the *session*, not on an event
  name allow-list, so a supabase-js rename can't silently disable the guard.
  `INITIAL_SESSION` fires with `null` on every signed-out cold start and must
  never toast.
- **Identity change counts too** (security-auditor M1). auth-js replays other
  tabs' auth events into this tab over a `BroadcastChannel`, so signing in as
  user B in tab 2 hands tab 1 a `SIGNED_IN` with a **non-null** session. Keying
  only on `session == null` would leave tab 1 rendering A's shell while every
  request went out with B's JWT — RLS bounds the data, but the shell would be
  asserting the wrong identity. `handleAuthEvent` therefore treats
  `session.user.id !== <surface's current user id>` as a loss for that surface,
  with its own copy (`chrome.sessionSwitched`, "Signed in as a different user")
  because "expired" would be a lie. An identity change is never suppressed by
  the intentional-sign-out flag.
- **Reaction** — tear down every affected surface, then **one** announcement
  from the highest-priority affected surface. `RoleRouter` re-renders to the
  shared sign-in portal.
- **Store-agnostic seam** (code-reviewer Should-fix / spec 063). `sessionWatch`
  imports **neither store**. Surfaces register themselves —
  `registerSessionSurface({ id, getUserId, tearDown, announce })` — from
  `App.tsx`, the root bridge that already owns both stores (the role
  `RoleRouter` plays for rendering). That is what keeps "staff code never
  imports `useStore`" true even though the staff `Settings` sheet imports
  `markIntentionalSignOut` from this module. Registration order is announcement
  priority (admin first, mirroring `RoleRouter`'s precedence), and each surface
  supplies its own catalog + toast convention, so the two i18n trees stay
  independent.
- **Intentional sign-out is not "expired"** — `markIntentionalSignOut()` is
  called by the two deliberate sign-out paths (`useStore.logout()` and the staff
  `Settings` sheet) before they call `signOut()`; the watcher consumes the flag
  and stays silent. It is consumed on *any* null-session event (even one with no
  affected surface) so it can't leak into a later real loss, and it is
  **un-armed** when `signOut()` rejects — auth-js skips the `SIGNED_OUT`
  emission on anything but 401/404/403, so a network-failed sign-out would
  otherwise leave the flag armed for the tab's lifetime and swallow the next
  genuine loss (security-auditor Low). `login()` disarms it too.
- Belt-and-braces: the reaction no-ops for any surface with no session (covers
  `checkAuthGate`'s not-staff / no-stores `signOut()` and `RecoveryScreen`'s
  post-recovery `signOut()`).

### 2 — Never let an anon read blank the app (`loadFromSupabase`)

Before any fetch, `loadFromSupabase` probes `hasActiveSession()` (new in
`src/lib/auth.ts` — the documented auth carve-out). No session ⇒ **return
early**: prior slices are kept, `storeLoading` / `switching` are cleared (so a
bailed store switch can't strand the spec-111 overlay), and `sessionLost` flips
true, which renders a dismissible banner in the Cmd shell (all three
breakpoints) offering **Sign in**. A successful probe clears `sessionLost`, so
the banner self-heals when the session comes back.

The probe is a dynamic `import('../lib/auth')` inside a try/catch that **fails
OPEN** — mirrors the existing `logout()` / `deleteProfile()` dynamic-import
idiom, keeps `src/lib/supabase` out of `useStore`'s static graph (it throws at
import time without `EXPO_PUBLIC_*`), and guarantees a probe that can't be
resolved degrades to exactly the pre-spec behaviour rather than blocking loads.
It is also **time-bounded** (`SESSION_PROBE_TIMEOUT_MS`, 4 s, code-reviewer
Should-fix): the probe can drive a token refresh and now sits in front of every
load including each 400 ms-debounced realtime reload, so a hung auth endpoint
degrades to the documented fail-open outcome instead of freezing the pipeline.

`getSession()` also drives supabase-js's refresh, so the probe is what converts
"token expired 3 seconds ago" into either a fresh token (load proceeds) or a
`SIGNED_OUT` event (part 1 fires).

**The bail is identity-guarded** (security-auditor M2). It lands after two
awaits, so it can describe a session that has already been torn down and
replaced. The action captures `currentUser?.id` before probing and drops the
result if the identity moved — otherwise the next user's shell would mount
wearing the previous session's red "signed out" dot plus a banner whose primary
button force-ejects them, with their in-flight load's progress gates cleared out
from under it. `login()` also resets `sessionLost`, which is the only thing that
helps when `login()`'s own `fetchStores` REJECTS (that branch never reaches the
self-heal inside `loadFromSupabase`).

**Both signed-out exits drop the loaded rows** (security-auditor Medium). One
shared `SIGNED_OUT_DATA_RESET` — mirroring the `create()` initial-state literal
— is applied by `logout()` and `handleSessionLost()`, so the next sign-in on a
shared terminal never renders the previous identity's inventory/recipes/users/
notifications in the window before its own load resolves. Device preferences
(`darkMode`, `locale`, `sidebarLayoutOverride`, `timezone`) are deliberately not
in it; `logout()` keeps owning the spec-038 locale reset.

### 3 — The indicator reflects auth, not just the socket (`TitleBar`)

Third state on the existing dot + label: `sessionLost` ⇒ danger dot +
`chrome.signedOutIndicator` ("signed out"), ahead of the connected /
reconnecting pair. `useConnectionStatus` itself is **unchanged** — it stays the
spec-059 websocket oracle, because `InventoryCountSection` consumes it as an
offline-queue oracle where "no session" is not the same question. The phone tier
has no indicator in its top bar (spec 142); its honest signal is the banner,
which renders in the phone branch too.

## Acceptance criteria

- AC-1 A `null`-session auth event while the admin surface is signed in clears
  `currentUser` and shows the "Session expired — sign in again" toast; the shell
  falls back to the sign-in portal.
- AC-2 Same for a signed-in staff session (staff store cleared, staff catalog
  copy, staff toast position).
- AC-3 `INITIAL_SESSION` with a `null` session (signed-out cold start) does
  nothing — no toast, no state write.
- AC-4 An intentional sign-out (admin `logout()`, staff Settings) does NOT
  toast "session expired".
- AC-5 `loadFromSupabase` with no session keeps every prior slice, calls no
  `db` fetcher, and sets `sessionLost`.
- AC-6 The bail clears `storeLoading` + `switching` (no stranded spec-111
  overlay).
- AC-7 A successful load clears `sessionLost` (banner self-heals).
- AC-8 The banner renders when `sessionLost`, offers Sign in + dismiss, and is
  dismissible without touching `sessionLost`'s meaning for the indicator.
- AC-9 The TitleBar indicator shows the signed-out state ahead of
  connected/reconnecting.
- AC-10 A probe that cannot be resolved fails OPEN — the load proceeds exactly
  as before this spec.
- AC-11 (review round) A non-null session for a DIFFERENT user tears down the
  stale surface and announces the *switched* copy, not "expired"; the same user
  re-appearing (refresh / re-emit) is not a loss; an identity change is never
  suppressed by the intentional-sign-out flag.
- AC-12 (review round) A bail whose identity moved during the probe neither arms
  the banner nor clears the new load's `storeLoading` / `switching`; `login()`
  clears `sessionLost` even when its own `fetchStores` rejects.
- AC-13 (review round) `logout()` and `handleSessionLost()` both clear the
  loaded data slices.
- AC-14 (review round) Both sign-out call sites raise the intentional marker
  BEFORE `signOut()` and un-arm it when `signOut()` rejects.
- AC-REG1 Normal signed-in flows are byte-unchanged: with a live session,
  `loadFromSupabase` fetches and writes every slice as before.
- AC-REG2 Spec 150's brand logic is untouched (`reconcileActiveBrand`,
  `setCurrentBrandId`, `storeVisibility` unmodified).
- AC-REG3 `useConnectionStatus`'s contract is unchanged (spec 058/059 pins).

## Non-goals

- No retry / silent re-auth. The honest outcome is the sign-in screen.
- No change to RLS, grants, or any RPC. The DB behaved correctly throughout —
  an anon caller SHOULD see nothing.
- No global "wrap every db.ts read in an auth check". One chokepoint
  (`loadFromSupabase`) covers the blanking path; RPC callers already surface
  their own errors.
- Not diagnosing *why* the owner's token died (multi-tab refresh-token rotation
  is the leading candidate). This spec makes the failure honest and
  self-describing regardless of trigger.

## Verification

Jest (`npx jest`, full run green — 192 suites / 1979 tests) — new pins:

- `src/lib/sessionWatch.test.ts` (23) — AC-1…AC-4, AC-11, the loss-predicate
  table, surface precedence, and the register/unregister contract.
- `src/store/useStore.sessionLoss.spec152.test.ts` (19) — AC-5…AC-7, AC-10,
  AC-12, AC-13, AC-14 (admin half), AC-REG1.
- `src/screens/staff/screens/Settings.test.tsx` (+2) — AC-14 (staff half): the
  marker is raised BEFORE `signOut()` and un-armed when it rejects.
- `src/components/cmd/SessionLostBanner.test.tsx` (4) — AC-8.
- `src/components/cmd/TitleBar.test.tsx` (+2) — AC-9 and its regression pair.

Plus `npx tsc --noEmit` and `npm run typecheck:test`.

### Manual browser recipe (the incident repro — NOT wired into CI)

Playwright is already a devDependency (spec 078) but this recipe runs as an
ad-hoc driver, deliberately **not** added to `e2e/` or any CI gate. It is the
only way to exercise "the JWT stops being accepted mid-session".

Prereqs: local stack up (`npm run dev:db`), `npx expo start --web --port 8081`,
and a `super_admin` fixture with no `user_stores` rows.

The load-bearing detail is HOW the session is killed. Two shapes behave
differently and only one matches the incident:

| simulation | what supabase-js does | reproduces prod? |
|---|---|---|
| strip the `Authorization` header off REST calls | nothing — the client still believes it holds a valid token | symptoms only |
| refresh returns a **network error** | retries; keeps the session (correct — a blip is not a sign-out) | no |
| refresh returns **400 `invalid_grant`** | drops the session; subsequent calls go out with the anon key | **yes** |

The third row is prod: the incident's `report_reorder_list` call EXECUTED as
`anon` (a merely-expired JWT would have 401'd instead), which means the client
held no session at all.

```js
// node <file>.js — requires the repo's own @playwright/test
const { chromium } = require('<repo>/node_modules/@playwright/test');
const { execSync } = require('child_process');

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:8081');
await page.getByTestId('signin-email').fill('<super_admin email>');
await page.getByTestId('signin-password').fill('<password>');
await page.getByTestId('signin-submit').click();
await page.getByTestId('cmd-shell-root').waitFor();
// 1. every refresh attempt is REJECTED (revoked / already-used token)
await page.route('**/auth/v1/token**', (r) => r.fulfill({
  status: 400, contentType: 'application/json',
  body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid Refresh Token' }),
}));
// 2. the stored access token is already past its expiry
await page.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.startsWith('sb-') && x.endsWith('-auth-token'));
  const v = JSON.parse(localStorage.getItem(k));
  v.expires_at = Math.floor(Date.now() / 1000) - 3600; v.expires_in = 0;
  localStorage.setItem(k, JSON.stringify(v));
});
// 3. trigger the app's OWN reload path (realtime → handleSync → loadFromSupabase)
execSync(`docker exec supabase_db_imr-inventory psql -U postgres -d postgres -c ` +
  `"update inventory_items set updated_at = now() where store_id='<store uuid>';"`);
```

Observed, same driver, both sides of the change:

- **Before** (`git stash` the spec): Inventory `0 items`, chrome still green
  `connected`, shell stays mounted — the incident, reproduced.
- **After**: "Session expired / Sign in again to continue." toast and the
  sign-in screen.

To see the BANNER half in a browser (the race where a load bails before/without
an auth event, which is not naturally reachable on demand), temporarily make
`hasActiveSession` return `false` after its first call, then trigger the same
realtime reload: the data STAYS (143 items), the banner appears under the title
bar, and the indicator flips to `signed out`. Verified at 1440×900 and 390×844.
Revert the shim afterwards.

AC-4 live check: sign in, press **sign out**, accept the confirm → sign-in
screen with NO "Session expired" toast.

AC-11 live check (identity switch, review round). One browser context, two
tabs — they share localStorage and auth-js's `BroadcastChannel`:

1. Tab 1 signs in as user A and lands on Inventory.
2. Mint a session for user B server-side
   (`POST /auth/v1/token?grant_type=password`) and open tab 2 at
   `/?session=<url-encoded {access_token, refresh_token}>` — the `__DEV__`-only
   hook in `App.tsx` calls `supabase.auth.setSession`, which emits `SIGNED_IN`
   with **B's non-null session**; auth-js replays it into tab 1.
3. Tab 1 must land on the sign-in screen showing the *"Signed in as a different
   user"* copy — NOT keep rendering A's shell (which would then be issuing every
   request with B's JWT).

Observed: `tab1 on sign-in screen: 1`, `tab1 says different user: true`.

## Files changed

- `specs/152-session-loss-honest-signout.md` (new)
- `src/lib/sessionWatch.ts` (new)
- `src/lib/sessionWatch.test.ts` (new)
- `src/lib/auth.ts`
- `src/store/useStore.ts`
- `src/store/useStore.sessionLoss.spec152.test.ts` (new)
- `src/types/index.ts`
- `src/components/cmd/SessionLostBanner.tsx` (new)
- `src/components/cmd/SessionLostBanner.test.tsx` (new)
- `src/components/cmd/TitleBar.tsx`
- `src/components/cmd/TitleBar.test.tsx`
- `src/screens/cmd/ResponsiveCmdShell.tsx`
- `src/screens/staff/screens/Settings.tsx`
- `src/screens/staff/screens/Settings.test.tsx` (review round — AC-14 staff half)
- `App.tsx`
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`
- `src/screens/staff/i18n/en.json`, `es.json`, `zh-CN.json`

## Review round (2026-08-04)

Three reviews, 0 Criticals. Applied:

| finding | resolution |
|---|---|
| security M1 — identity change not detected | `handleAuthEvent` treats a non-null session for a different user id as a loss for that surface, with its own `sessionSwitched` copy (AC-11) |
| security M2 — stale bail arms a false banner | identity-guarded bail + `login()` clears `sessionLost` (AC-12) |
| security M3 — marker stuck armed when `signOut()` fails | `clearIntentionalSignOut()` on both rejection paths + on `login()` (AC-14) |
| security Medium — data slices survive teardown | shared `SIGNED_OUT_DATA_RESET` applied by `logout()` and `handleSessionLost()` (AC-13) |
| code SF — spec-063 seam | inverted: `sessionWatch` imports no store; surfaces register from `App.tsx` |
| code SF — `handleSessionLost` doc claims one caller | doc now names both (watcher + banner button) |
| code SF — unbounded probe latency | `SESSION_PROBE_TIMEOUT_MS` (4 s) race, fail-open |
| code nits — outer-catch rationale, flag wording | comments clarified |
| test gap — call sites not pinned | `logout()` + staff `Settings` order pins (AC-14) |

Deferred, with reasons:

- **CLAUDE.md carve-out list** (code-reviewer nit): `sessionWatch.ts` calls
  `supabase.auth.onAuthStateChange` directly and isn't in CLAUDE.md's enumerated
  list. `onAuthStateChange` is not PostgREST/RPC so the rule's letter doesn't
  require it; a cross-reference comment is in the module header instead. Editing
  CLAUDE.md is the user's call, not an agent's.
- **Escalate the banner after N bails** (security Low): a dead session can sit
  on a populated screen indefinitely if no auth event ever arrives. The banner +
  the signed-out indicator make it visible; auto-ejecting on a timer is a
  product decision, not a review fix.
- **Staff-surface read paths** (code-reviewer, out-of-scope): the staff EOD
  screens' own `supabase.rpc` reads weren't audited for the same
  "RLS-empty replaces good data" shape. Follow-up spec.
