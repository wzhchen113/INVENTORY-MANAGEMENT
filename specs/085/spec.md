# Spec 085: Admin-initiated password reset — fix the broken landing flow end-to-end

Status: READY_FOR_REVIEW

## Background

An admin clicks **Reset PW** for a user in the **Users & access** section
(`src/screens/cmd/sections/UsersSection.tsx:86`). The target user receives a
Supabase password-reset email. Clicking the link **fails**. The user pasted the
exact landing URL:

```
http://localhost:3000/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=
```

Decoded, this surfaces two distinct defects:

1. **Wrong destination.** The link redirects to `http://localhost:3000/` — the
   Supabase dashboard **Auth → URL Configuration → Site URL** is still the dev
   default `http://localhost:3000`, so the deployed app's reset links point at
   localhost. Confirmed in code: `sendPasswordReset(email)`
   (`src/lib/auth.ts:541`) calls `supabase.auth.resetPasswordForEmail(email)`
   (`auth.ts:543`) with **no `redirectTo`** argument, so every link falls back to
   the dashboard's Site URL.

2. **Token rejected / nothing catches it.** `error_code=otp_expired`
   ("Email link is invalid or has expired") means the recovery token failed
   verification. AND, even if it had succeeded, there is **no recovery-landing
   handler anywhere in production code**: no `supabase.auth.onAuthStateChange`
   listener (the only `onAuthStateChange` references in `src/` are jest mocks in
   `useStore.test.ts` and two `IngredientForm` tests), no "set a new password"
   screen, and no `supabase.auth.updateUser({ password })` call site. So even
   when the link opens the app, nothing catches the `PASSWORD_RECOVERY` session
   to let the user enter a new password — the link "does nothing."

Root cause of the `otp_expired` symptom is one or more of (to be confirmed
empirically by the architect AFTER the config + `redirectTo` fix lands):

- **(a)** the Site-URL / redirect mismatch bouncing the token;
- **(b)** genuine short token expiry;
- **(c)** the one-time link being **pre-consumed by an email-scanner / Outlook
  Safe-Links prefetch** before the human clicks — a well-documented Supabase
  gotcha with the implicit (hash) flow, where the scanner's GET consumes the
  single-use OTP. This hypothesis biases the auth-flow choice toward PKCE or
  `verifyOtp({ token_hash })` (see Open questions Q3).

All three are hypotheses; the architect root-causes empirically once the
deterministic config/`redirectTo` defects are removed.

## User story

As an **admin or master**, I want the **Reset PW** button to send the target
user a working password-reset link, so that the user can click the link on
**web or native mobile**, land on a "set a new password" screen, choose a new
password, and then sign in with it — without the link silently failing or
dumping a raw Supabase error fragment.

## Acceptance criteria

End-to-end, concrete, testable:

- [ ] **Web (prod + local dev):** An admin-initiated reset email link, when
  clicked on web, lands on a "set a new password" screen that establishes the
  recovery session (a Supabase session with the recovery grant is present) and,
  on submit, successfully calls `supabase.auth.updateUser({ password })`. The
  user can subsequently sign in with the new password through the existing
  `LoginScreen`.
- [ ] **Native (Expo iOS/Android):** The same flow works via deep link — the
  recovery URL opens the app, the recovery session is established, the screen
  accepts a new password, and `updateUser({ password })` succeeds.
- [ ] **`redirectTo` is passed.** `sendPasswordReset` passes a correct
  **per-platform `redirectTo`** (web prod URL / web localhost in dev / native
  scheme) to the recovery call, so links no longer fall back to the dashboard
  Site URL. The exact resolution strategy (env var, `Platform.OS` branch,
  `expo-linking` `createURL`) is an architect decision; the testable assertion
  is that the call receives a non-empty `redirectTo` (or `options.emailRedirectTo`
  / equivalent for the chosen flow) matching the running platform.
- [ ] **Recovery session is caught without enabling RoleRouter `linking`.** The
  recovery URL/fragment is handled by **boot-time URL inspection** —
  `window.location.hash` / `window.location.search` on web, and `expo-linking`
  (`getInitialURL` + `addEventListener`) on native — NOT by enabling
  react-navigation deep-link routing on the shared `<NavigationContainer>`
  (`src/navigation/RoleRouter.tsx:20-26`). The single shared NavigationContainer
  is not disrupted.
- [ ] **Password validation.** The set-new-password screen validates the new
  password (length/confirm-match at minimum) before calling `updateUser`, and
  surfaces field-level errors.
- [ ] **Success state.** On a successful `updateUser`, the user is shown a clear
  success state and routed to / able to reach the sign-in portal
  (`src/screens/LoginScreen.tsx`).
- [ ] **Friendly expired/invalid-link handling.** When the landing URL carries
  `error_code=otp_expired` (or any `error`/`error_description` fragment, or the
  recovery session fails to establish), the screen shows a **friendly error**
  ("This reset link is invalid or has expired") with a clearly-labeled path to
  **request a new link** — NOT a raw Supabase error fragment in the URL bar or a
  blank screen. Because one-time links can legitimately expire, this is a
  first-class state, not just an edge case.
  - Note: "request a new link" from the landing page may need an admin to
    re-trigger (since this spec does NOT add self-service login-time "Forgot
    password"). The minimum bar is a clear instruction telling the user the link
    expired and what to do (e.g. "ask your administrator to send a new reset
    link"); whether the page also exposes a self-service re-request is an
    architect/UX call, but MUST NOT become a login-screen "Forgot password"
    entry point (out of scope below).
- [ ] **`sendPasswordReset` return contract preserved.** The function keeps its
  `Promise<{ error: string | null }>` shape so `UsersSection.tsx`'s existing
  toast handling at the call site is unchanged.
- [ ] **Tests (jest):** unit coverage for (1) the recovery-URL parser/handler
  (web hash + native URL → recovery vs error vs none), (2) the set-new-password
  screen's validation + `updateUser` call (mocked supabase), and (3)
  `sendPasswordReset` passing the correct per-platform `redirectTo`.

## In scope

- New **"set a new password" recovery screen** (web + native).
- **Boot-time recovery-URL handling** that runs without enabling RoleRouter's
  `linking` config: web reads `location.hash`/`location.search` at app boot;
  native uses `expo-linking` `getInitialURL` + `addEventListener`.
- A production **recovery-session listener** (e.g. `onAuthStateChange` for the
  `PASSWORD_RECOVERY` event, and/or explicit session exchange depending on the
  chosen flow) — the first such listener in production code.
- The first production `supabase.auth.updateUser({ password })` call site.
- Adding a per-platform **`redirectTo`** to `sendPasswordReset`
  (`src/lib/auth.ts:541`).
- Friendly **expired/invalid-link** error state.
- jest tests per the criteria above.
- Documenting the **manual Supabase dashboard steps** for the user (see the
  clearly-labeled section below) — the spec documents them; agents do NOT change
  Supabase settings.

## Out of scope (explicitly)

- **Self-service "Forgot password" on the login screen.** The model stays
  admin-initiated: an admin/master clicks **Reset PW**. We are building only the
  LANDING side so the admin-initiated link works end-to-end. Rationale: the user
  explicitly chose to keep the current admin-driven model; adding a login-time
  reset entry point is a separate feature with its own rate-limiting / abuse
  surface.
- **Changing Supabase auth/security settings.** Site URL, redirect-URL allowlist,
  token expiry, and email-template edits are the user's manual dashboard steps
  (documented below). Agents do not touch them. Rationale: per project policy
  agents never mutate Supabase auth config; these are environment/console
  settings, not code.
- **Changing the `app.json` `slug`** (`towson-inventory`). Forbidden without
  explicit approval per CLAUDE.md; unrelated to this fix.
- **Enabling react-navigation `linking` on the shared `<NavigationContainer>`.**
  Explicitly avoided to preserve spec 063's single-NavigationContainer contract;
  the recovery flow works around it via boot-time URL inspection. Rationale:
  turning on `linking` introduces a new "URL is meaningful" contract across the
  whole merged admin+staff shell — far larger blast radius than this bug fix.
- **The staff EOD surface** (`src/screens/staff/`). Password reset targets are
  managed from the admin Users & access section; the recovery landing is a
  shared, pre-auth surface, not a staff-stack feature. Rationale: keep the change
  in the admin/shared auth path.
- **Customer PWA.** Sibling app; not in this repo.

## Open questions resolved

- Q: Which platforms must work? → A: **Web AND native mobile** (Expo). Both.
- Q: Self-service "Forgot password" on login, or keep admin-initiated? → A:
  **Keep admin-initiated** (admin/master clicks Reset PW). Build the landing side
  only.
- Q: Is there any existing recovery-landing handler / set-password screen /
  `updateUser({ password })` call? → A: **No** — confirmed by grep across `src/`.
  Only `onAuthStateChange` references are jest mocks; `updateUser` matches are the
  Zustand store's local user action, not `supabase.auth.updateUser`.
- Q: Does `sendPasswordReset` pass a `redirectTo`? → A: **No** — `auth.ts:543`
  calls `resetPasswordForEmail(email)` with one argument, so links fall back to
  the dashboard Site URL (currently localhost).
- Q: Does `app.json` have a URL `scheme` for native deep-linking? → A: **No** —
  only `slug` + `bundleIdentifier`/`package`. Native deep-linking requires ADDING
  a `scheme` (see Open questions still pending, Q1).
- Q: Can we just turn on react-navigation `linking`? → A: **No** — RoleRouter
  intentionally ships `linking` off and owns the single `<NavigationContainer>`
  (`RoleRouter.tsx:20-26`); the recovery flow must work around it via boot-time
  URL inspection.
- Q: Does the web side need a server route? → A: **No** — `vercel.json` is a pure
  SPA rewrite (all non-asset routes → `/index.html`), so a recovery route is
  served `index.html` and the app inspects the URL on boot.

## Open questions still pending (for the user / architect — NOT build blockers for the parts that don't depend on them)

These are genuinely external and CANNOT be resolved by reading the repo:

- **Q1 — Native URL scheme approval (USER APPROVAL REQUIRED).** Native
  deep-linking for the recovery URL requires **adding a `scheme` field to
  `app.json`** (e.g. `"scheme": "imrinventory"`). `app.json` is sensitive (EAS
  builds, push certificates, store identifiers); CLAUDE.md forbids changing the
  `slug` without approval, and adding `scheme` — though a different field — must
  likewise be **explicitly approved by the user** before any agent writes it.
  **Do not add the `scheme` silently.** The web half of this spec does not depend
  on Q1 and can proceed; native deep-linking is gated on this approval.
- **Q2 — Production web domain (USER MUST PROVIDE).** The correct prod web URL
  for `redirectTo` and for the dashboard Site URL is a Vercel project setting
  unknown to the repo. The user must provide the canonical prod domain
  (e.g. `https://<project>.vercel.app` or a custom domain). Until provided, the
  architect can parameterize it via an env var (e.g. `EXPO_PUBLIC_*`) and the
  user supplies the value; local-dev `redirectTo` can default to the localhost
  origin.
- **Q3 — Auth flow choice (ARCHITECT DECISION).** Which Supabase recovery flow:
  - **Implicit / hash flow** (current — `#access_token` / `#error` fragment): no
    template change, but most vulnerable to the email-scanner prefetch that likely
    causes `otp_expired`.
  - **PKCE** (`?code=` + `supabase.auth.exchangeCodeForSession`): more robust to
    prefetch; requires the client to use the PKCE flow type.
  - **`verifyOtp({ token_hash, type: 'recovery' })`** with a custom email
    template using `{{ .TokenHash }}`: most robust to prefetch, but requires a
    **dashboard email-template edit** (a user-owned manual step, see manual steps
    below).

  The architect picks the flow, weighing prefetch-robustness vs. the cost of a
  template edit, and documents the tradeoff. The choice determines (a) whether an
  email-template manual step is added below, and (b) the exact client-side
  exchange code.

## Manual Supabase-dashboard steps (USER-OWNED — agents will NOT perform these)

These must be done by the user in the Supabase dashboard for the fix to work in
each environment. The spec documents them; no agent changes Supabase settings.

1. **Set the Site URL.** Auth → URL Configuration → **Site URL** → set to the
   **production web domain** (from Q2), not `http://localhost:3000`.
2. **Add recovery redirect URLs to the allowlist.** Auth → URL Configuration →
   **Redirect URLs** → add each `redirectTo` target this spec will use:
   - the **prod web** recovery URL (e.g. `https://<prod-domain>/reset-password`
     or the chosen hash/route — architect finalizes the exact path),
   - the **localhost dev** recovery URL (e.g. `http://localhost:8081/...` /
     `http://localhost:3000/...` — match the local Expo web origin),
   - the **native scheme** recovery URL (e.g. `imrinventory://reset-password`),
     contingent on Q1 approval.
3. **(Conditional) Email-template edit.** Only if the architect chooses the
   `verifyOtp({ token_hash })` flow (Q3): Auth → Email Templates → **Reset
   Password** → update the link to use `{{ .TokenHash }}` + the recovery
   `redirect_to` per Supabase's token_hash recipe.
4. **(Optional, diagnostic) Token expiry.** If empirical root-causing (architect)
   points at genuine short expiry rather than prefetch, the email OTP expiry
   setting is here too — but the user adjusts it, not an agent.

## Dependencies

- `@supabase/supabase-js` recovery APIs already in use via
  `src/lib/supabase.ts` / `src/lib/auth.ts` (`resetPasswordForEmail`;
  newly: `updateUser`, `onAuthStateChange`, and—per Q3—possibly
  `exchangeCodeForSession` or `verifyOtp`).
- `expo-linking` for native `getInitialURL` + URL events (verify it is already a
  dependency; the architect/dev confirms and adds if missing).
- The shared sign-in portal `src/screens/LoginScreen.tsx` (post-reset
  destination) and the `RoleRouter` boot path (`src/navigation/RoleRouter.tsx`,
  `App.tsx`) for where boot-time URL inspection mounts.
- **Q1** (native `scheme` in `app.json`) gates the native half only.
- **Q2** (prod web domain) needed before the prod `redirectTo` / Site URL are
  final; web-dev path can proceed with the localhost origin and an env-var
  placeholder for prod.
- The **manual dashboard steps** above are an operational dependency for the
  link to work in each environment — not a code dependency, but the feature is
  not "done end-to-end" in prod until step 1 + 2 are applied.

## Project-specific notes

- **Cmd UI section / legacy:** Trigger is the existing **Users & access** Cmd
  section (`src/screens/cmd/sections/UsersSection.tsx`); no legacy surface. The
  new recovery screen is a **shared pre-auth surface** reached via boot-time URL
  inspection, NOT a Cmd section and NOT a staff screen.
- **Per-store or admin-global:** N/A for the recovery flow itself (it acts on the
  authenticated user's own auth account). The trigger respects the existing
  role gates in `UsersSection` (master can reset anyone except master; admin can
  reset only `user`-role rows — unchanged).
- **Realtime channels touched:** None.
- **Migrations needed:** **No** — password reset is a Supabase Auth operation,
  not an app-table change. No SQL migration. (Confirms no `db-migrations-applied`
  drift impact.)
- **Edge functions touched:** **None expected.** `resetPasswordForEmail` and
  `updateUser` are client-side Supabase Auth calls. The architect should confirm
  the chosen Q3 flow needs no edge function; if a custom email-template approach
  somehow implies one, that is an architect call-out, not assumed here.
- **Web/native scope:** **Both.** Web ships to Vercel (SPA rewrite already serves
  any recovery route as `index.html`); native ships to EAS and is gated on the
  Q1 `scheme` approval.
- **`app.json`:** Do NOT change `slug`. Adding a `scheme` is a separate field but
  still requires explicit user approval (Q1) — surfaced as an open question, not
  a silent edit.
- **Tests:** **jest** track for the recovery-URL handler, the set-new-password
  screen logic, and the `sendPasswordReset` `redirectTo`. A **Playwright e2e**
  (Track 4) is **likely not feasible** here because the happy path needs a real
  email round-trip + live token; at most an e2e could assert the friendly
  expired-link UI when the app boots with a synthetic `#error=...&error_code=otp_expired`
  fragment — the architect decides whether that slice is worth a Track-4 test. No
  pgTAP (no DB change) and no shell smoke is expected.

## Implementation hints (non-binding — architect owns the contract)

- Boot-time web handling can live at app entry (`App.tsx` / a tiny pre-RoleRouter
  gate) so it reads `window.location.hash`/`search` before RoleRouter decides a
  branch; on detecting a recovery fragment/`code`, render the recovery screen
  instead of the normal shell.
- Native: `Linking.getInitialURL()` for cold start + `Linking.addEventListener`
  for warm, parsing the same recovery params.
- Keep the recovery screen self-contained and pre-auth (it may run with no admin
  store initialized), consistent with the auth-path probes that already bypass
  the store/slice chain (`src/lib/authGate.ts`, `src/lib/sessionRestore.ts`).

## Backend design (architect)

This is a **frontend-heavy** spec: a new pre-auth recovery screen, a boot-time
URL gate, a recovery-URL parser, a small `src/lib/auth.ts` change, and a new
`flowType` line in `src/lib/supabase.ts`. **No SQL migration, no edge function,
no RLS change, no realtime change** (confirmed in detail below). The bulk of the
work goes to **frontend-developer**; there is **no backend-developer work**.

### 0. Grounding — what the code actually shows today

Confirmed by reading the repo (cited so the developer doesn't re-investigate):

- `src/lib/supabase.ts` sets **no `flowType`** → the client defaults to the
  **implicit (hash) flow**. It already sets `detectSessionInUrl: Platform.OS === 'web'`
  and uses `localStorage` on web / `AsyncStorage` on native.
- `sendPasswordReset` (`src/lib/auth.ts:541-549`) calls
  `supabase.auth.resetPasswordForEmail(email)` with **one argument** — no
  `redirectTo`. Return shape is `Promise<{ error: string | null }>`. Call site is
  `UsersSection.handleSendReset` (`src/screens/cmd/sections/UsersSection.tsx:86`),
  which only reads `result.error` to choose a toast — **the return contract must
  not change**.
- **`expo-linking` is NOT in `package.json`** — it must be ADDED (native half).
- `app.json` has **no `scheme`** (Q1, user-gated) and `slug: towson-inventory`
  (do NOT touch).
- `App.tsx` is the boot owner: it already does boot-time URL inspection in two
  places — `hydrateDevSessionFromUrl()` (reads `?session=`, `__DEV__`-gated) and
  the `?register=true` redirect in `LoginScreen` (`LoginScreen.tsx:43-52`). These
  are the **precedent** for the recovery gate: read `window.location` on boot,
  branch, then `history.replaceState` to scrub the URL.
- `RoleRouter` (`src/navigation/RoleRouter.tsx:39-65`) owns the **single**
  `<NavigationContainer>`, ships `linking` OFF, and branches on
  `useStore.currentUser` / `useStaffStore.authState`. **Do not enable `linking`**
  (out of scope, spec 063 hard constraint).
- The auth-path probes (`src/lib/authGate.ts`, `src/lib/sessionRestore.ts`)
  bypass the store/slice chain and call `supabase.*` directly — they are the
  **documented carve-out precedent** the recovery screen + parser follow.

### 1. Q3 decision — auth flow choice (the central technical decision)

**Recommendation: PKCE flow** (`?code=` + `exchangeCodeForSession`), set via
`flowType: 'pkce'` in `src/lib/supabase.ts`. Reasoning and the rejected
alternatives:

**Why not implicit/hash (status quo).** The user is hitting
`error_code=otp_expired`. The single most common documented cause with the
implicit recovery flow is **email-scanner / Outlook Safe-Links prefetch**: the
scanner issues a GET against the one-time recovery link and consumes the OTP
before the human clicks. Implicit flow is the most exposed to this because the
token is verified by the GET itself. Keeping implicit flow risks shipping a fix
that still intermittently fails for exactly the users on scanned mailboxes —
unacceptable for a bug whose whole point is "the link must work."

**Why not `verifyOtp({ token_hash, type: 'recovery' })`.** This is the most
prefetch-robust option (the link carries a `token_hash` that is only redeemed by
the explicit client `verifyOtp` call, so a scanner GET that just loads the page
does not consume it). BUT it **requires a user-owned dashboard email-template
edit** (rewrite the Reset Password template to emit `{{ .TokenHash }}` +
`redirect_to`). That couples the fix to a manual template change that, if the
user forgets or mistypes, silently breaks the flow with no code-level signal.
PKCE gets ~the same prefetch-robustness **with no template edit** (Supabase's
default recovery email already emits the `{{ .ConfirmationURL }}` that, under
PKCE, carries `?code=`). Lower operational blast radius. (If, after the user
applies Site URL + redirect-allowlist and we still see prefetch consumption in
the wild, `token_hash` is the documented escalation — note it as a fallback, not
the v1 choice.)

**Blast radius of `flowType: 'pkce'` — analyzed (this is the real cost of PKCE).**
Changing `flowType` is global to the supabase client, so it touches every auth
entry point. I traced each:

| Auth path | Method | PKCE impact |
|---|---|---|
| Admin/staff sign-in (`signIn`, `auth.ts:60`) | `signInWithPassword` | **None.** Password grant does not use the PKCE code-exchange leg; `flowType` only governs the OAuth/magic-link/recovery `?code=` redirect family. Email+password is unaffected. |
| Invited-user registration (`registerInvitedUser`, `auth.ts:353`) | `signUp` (email+password, `data` only — **no `emailRedirectTo`**) | **None.** No redirect leg is used; the session is returned inline. Email-confirm is not in this flow. |
| Cold-start restore (`getSession`, `auth.ts:80`; `restoreSession`) | `getSession` | **None.** Reads the persisted session; flowType-agnostic. |
| Dev session inject (`hydrateDevSessionFromUrl`, `App.tsx:110`) | `setSession({ access_token, refresh_token })` | **None.** Direct token set; flowType-agnostic. `__DEV__`-only anyway. |
| Web URL session detect | `detectSessionInUrl: true` | **Changes for the BETTER.** With `flowType: 'pkce'`, `detectSessionInUrl` knows to look for `?code=` and run the exchange; with implicit it looks for `#access_token`. Recovery is the only redirect-bearing flow in this app, so this only affects recovery. |

Net: **PKCE is functionally inert for every existing path** because the app's
only redirect-returning auth flow is the recovery link we're adding. The one
hard requirement PKCE imposes is that the **code verifier** (written to storage
when `resetPasswordForEmail` is called) must be present in the **same storage**
when `exchangeCodeForSession` runs. On web that is the same browser
`localStorage` — but the verifier is written in the **admin's** browser when they
click Reset PW, and the **code is redeemed in the target user's** browser. **PKCE
recovery does NOT require the verifier to be co-located** — Supabase's
recovery/magic-link PKCE variant stores the verifier server-side keyed to the
OTP, and `exchangeCodeForSession` on the landing device completes without a
local verifier. This is the standard Supabase "PKCE for email links across
devices" behavior; the developer should treat `exchangeCodeForSession(code)` as
self-sufficient on the landing device. **Flag for empirical verification (§9):**
the developer must confirm on the local stack that a `?code=` recovery link
opened in a *fresh* browser profile (no prior verifier) still exchanges — if the
local GoTrue is configured for strict same-device PKCE and it fails, fall back to
`verifyOtp({ token_hash })` (which has no verifier dependency at all) and add the
email-template manual step. This is the one place the flow choice could flip; it
is cheap to test and the design is structured so only `establishRecoverySession()`
+ one manual step change if it does.

**Dashboard manual steps this choice implies** (user-owned, documented in §10):
Site URL + redirect-allowlist entries. **No email-template edit** (the PKCE win).

### 2. Boot-time recovery-URL handling (no RoleRouter `linking`)

**New gate component: `src/navigation/RecoveryGate.tsx`** — wraps `RoleRouter`
inside `App.tsx`. It is the pre-RoleRouter branch the spec asks for. Shape
(pseudocode — developer authors):

```
function RecoveryGate({ children }) {
  const [recovery, setRecovery] = useState<RecoveryParse | null>(null);
  // web: synchronous read on first render (mirrors readCachedDarkModeSync)
  // native: getInitialURL() in an effect + addEventListener for warm links
  // On a 'recovery' or 'error' parse → render <SetNewPasswordScreen parse={...}/>
  // On 'none' → render children (the normal RoleRouter shell)
}
```

Mount point in `App.tsx` — replace the bare `<RoleRouter />` (line 338) with:

```
<RecoveryGate>
  <RoleRouter />
</RecoveryGate>
```

Critically, `RecoveryGate` renders the recovery screen **instead of**
`RoleRouter`, so the recovery screen does **not** live inside the shared
`<NavigationContainer>` and does **not** require `linking`. It is a sibling
render branch, exactly like the spec's "render the recovery screen instead of
the normal shell" hint. The recovery screen is **self-contained / pre-auth** (no
admin store, no nav container) — modeled on the `authGate.ts` / `sessionRestore.ts`
carve-out.

- **Web detection:** synchronous read of `window.location.hash` +
  `window.location.search` on the gate's first render (before RoleRouter paints),
  matching the `readCachedDarkModeSync` / `hydrateDevSessionFromUrl` pattern.
  Recovery is present if `search` has `?code=`, OR `hash`/`search` carries
  `error`/`error_code`/`error_description` (the friendly-error path), OR (defense
  for an implicit fallback) `hash` carries `type=recovery`/`access_token`.
- **Native detection:** `Linking.getInitialURL()` for cold start +
  `Linking.addEventListener('url', …)` for warm. Parse the same params off the
  URL's query/fragment.
- **Ordering vs `hydrateDevSessionFromUrl`:** the recovery gate's web read must
  run BEFORE the existing `getSession()` cold-start effect commits a branch.
  Because the gate renders synchronously and short-circuits to the recovery
  screen, `RoleRouter`'s effects never run in the recovery case — no ordering
  hazard. The dev `?session=` param and a recovery `?code=` are mutually
  exclusive in practice (different links); if both are somehow present, recovery
  wins (the gate is outermost).
- **URL scrubbing:** after a successful `exchangeCodeForSession`, call
  `window.history.replaceState({}, '', window.location.pathname)` (web) so the
  one-time `code`/`error` fragment is not left in history/referrer — same hygiene
  as `hydrateDevSessionFromUrl` (`App.tsx:124-129`).

### 3. New recovery-URL parser util

**New file: `src/lib/recoveryUrl.ts`** — pure, dependency-free (no
`supabase`, no React), so it is trivially jest-testable (criteria test #1). It is
the single source of truth for "is this a recovery URL, and what kind."

```
export type RecoveryParse =
  | { kind: 'recovery'; code: string }                 // PKCE ?code=
  | { kind: 'recovery-implicit'; accessToken: string } // defensive: #access_token&type=recovery
  | { kind: 'error'; code: string | null; description: string | null } // otp_expired etc.
  | { kind: 'none' };

// Web entry: pass window.location.search + window.location.hash
export function parseRecoveryFromWebLocation(search: string, hash: string): RecoveryParse;
// Native entry: pass the full deep-link URL string
export function parseRecoveryFromUrl(url: string): RecoveryParse;
```

Both delegate to one internal parser that reads a merged param bag from the
query string AND the fragment (Supabase puts errors in the fragment under
implicit, in the query under PKCE — parse both, error wins over recovery so an
`otp_expired` link always lands on the friendly state). `parseRecoveryFromUrl`
uses `expo-linking`'s `Linking.parse(url)` (or a hand-rolled split) to extract
`queryParams` + the fragment. Keep this util free of `expo-linking` import if
feasible (take the URL string and parse with `URL`/regex) so the jest test needs
no native mock; if `Linking.parse` is used, the native test mocks it.

### 4. The `src/lib/auth.ts` edit — `sendPasswordReset` gets `redirectTo`

**Preserve the `Promise<{ error: string | null }>` return shape exactly** (the
`UsersSection` toast handling is unchanged). Only the body changes:

```
export async function sendPasswordReset(email: string): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: resolveRecoveryRedirectUrl(),
    });
    if (error) return { error: error.message };
    return { error: null };
  } catch (e: any) {
    return { error: e.message || 'Failed to send password reset email' };
  }
}
```

**New helper: `resolveRecoveryRedirectUrl()`** — lives in a new
`src/lib/recoveryRedirect.ts` (kept separate from `recoveryUrl.ts` because this
one imports `Platform` + `expo-linking` and is NOT pure; separating keeps the
parser test clean). Resolution (criteria test #3 asserts the per-platform
branch):

```
// src/lib/recoveryRedirect.ts
import { Platform } from 'react-native';
// native only — guarded import or Platform branch
export function resolveRecoveryRedirectUrl(): string {
  if (Platform.OS === 'web') {
    // prod: env var (Q2); dev: window.location.origin
    const prod = process.env.EXPO_PUBLIC_WEB_RECOVERY_URL; // e.g. https://<domain>/reset-password
    if (prod && prod.length > 0) return prod;
    return `${window.location.origin}/reset-password`;     // localhost dev
  }
  // native (gated on Q1 scheme): Linking.createURL('/reset-password')
  // → e.g. imrinventory://reset-password  (scheme comes from app.json once approved)
  return Linking.createURL('/reset-password');
}
```

Decisions baked in:
- **Path: `/reset-password`.** Web SPA rewrite (`vercel.json`) serves any
  non-asset route `index.html`, so the path is purely a marker for the
  redirect-allowlist + a human-readable URL; the gate inspects `?code=` regardless
  of path. Using a stable path (not `/`) keeps the redirect-allowlist entries
  precise and avoids colliding with the dev `?session=` / `?register=` flows on
  `/`.
- **Web prod env var: `EXPO_PUBLIC_WEB_RECOVERY_URL`** (new). Mirrors the existing
  `EXPO_PUBLIC_*` convention (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_GIT_SHA`,
  `EXPO_PUBLIC_VAPID_PUBLIC_KEY`). **Q2 supplies the value.** Until set, dev falls
  through to `window.location.origin` and works locally. Set this in Vercel env +
  `playwright.config.ts`'s `webServer.env` block if an e2e slice is added.
- **Native: `Linking.createURL('/reset-password')`** resolves to
  `<scheme>://reset-password` using the `app.json` `scheme`. **Gated on Q1** — the
  developer must NOT add the scheme to `app.json`; until approved, the native
  branch is dead code (web build unaffected). Make the native branch
  scheme-agnostic: `createURL` reads the scheme from app config, so no hardcoded
  `imrinventory` constant is needed in code — the only native-specific artifact is
  the `app.json` `scheme` field itself, which is the gated edit.

**Web-half independent shippability:** the web path (parser, gate web branch,
`resolveRecoveryRedirectUrl` web branch, screen, `flowType: 'pkce'`) has **zero
dependency** on Q1. The native branch (`Linking.*`, `expo-linking` dep,
`app.json` scheme) is additive and can land in a follow-up commit without
touching the web path.

### 5. The chosen-flow client exchange — `establishRecoverySession()`

**New helper: `establishRecoverySession(parse: RecoveryParse)`** — lives in
`src/lib/recoveryRedirect.ts` (or its own `recoverySession.ts`; developer's call,
but it imports `supabase` so it is NOT in the pure parser file). It is the only
new `supabase.auth` exchange call site and is the documented carve-out (auth-path
probe, pre-store):

```
export async function establishRecoverySession(
  parse: RecoveryParse,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (parse.kind === 'recovery') {
    const { error } = await supabase.auth.exchangeCodeForSession(parse.code);
    return error ? { ok: false, error: error.message } : { ok: true };
  }
  if (parse.kind === 'recovery-implicit') {
    // defensive fallback if a hash-flow link ever arrives:
    // detectSessionInUrl already set the session on web; verify via getSession
    const { data } = await supabase.auth.getSession();
    return data.session ? { ok: true } : { ok: false, error: 'recovery session missing' };
  }
  return { ok: false, error: 'invalid or expired link' };
}
```

- **No `onAuthStateChange` PASSWORD_RECOVERY listener is required** for PKCE — the
  recovery session is established **synchronously by `exchangeCodeForSession`**,
  not delivered as an async event. (An `onAuthStateChange` listener is the pattern
  for the *implicit* hash flow, where `detectSessionInUrl` fires
  `PASSWORD_RECOVERY` after parsing `#access_token`.) Choosing PKCE means we
  **skip** the first-ever `onAuthStateChange` listener the spec anticipated — a
  net simplification (no listener lifecycle/cleanup to get right in a pre-auth
  screen). The spec's "and/or explicit session exchange depending on the chosen
  flow" clause covers this; explicit exchange is the chosen mechanism.
- After `establishRecoverySession` returns `ok`, the recovery screen now has an
  authenticated **recovery-grant session** in the supabase client; the subsequent
  `updateUser({ password })` rides that session.

### 6. The set-new-password screen contract

**New file: `src/screens/RecoveryScreen.tsx`** (top-level `src/screens/`, peer to
`LoginScreen.tsx` — it is a shared pre-auth surface, NOT a Cmd section, NOT a
staff screen, per spec §"Project-specific notes"). Self-contained: light-only or
`useColors()` default theme, no `useStore` dependency for its core flow.

Props: `{ parse: RecoveryParse }` (passed from `RecoveryGate`).

State machine (4 states):
1. **`exchanging`** — on mount, if `parse.kind` is a recovery kind, call
   `establishRecoverySession(parse)`. Show a spinner. On `ok` → `form`; on
   `!ok` → `error`. If `parse.kind === 'error'` (e.g. `otp_expired`) skip straight
   to `error`.
2. **`form`** — two `TextInput`s (new password, confirm), submit button.
   **Validation (before `updateUser`):**
   - non-empty
   - length ≥ 8 (matches no weaker than Supabase's default min; surface
     field-level error if shorter)
   - confirm === password (field-level "passwords do not match")
   Reuse the `LoginScreen` input/error visual idiom (`useColors()`, inline error
   `Text`). On submit → call `supabase.auth.updateUser({ password })`:
   - error → stay on `form`, show the Supabase message inline (e.g. "password
     should be different from the old password"); do not navigate.
   - success → `success` state.
3. **`success`** — clear confirmation ("Password updated"). Primary action routes
   the user to the sign-in portal. **Routing mechanism:** because the recovery
   screen renders *outside* `RoleRouter`'s NavigationContainer, it cannot
   `nav.navigate('Login')`. Instead, on the success CTA:
   - call `await supabase.auth.signOut()` (drops the recovery-grant session so the
     user must sign in fresh with the new password — also prevents the
     recovery session from auto-logging them into the admin/staff shell), THEN
   - **web:** `window.history.replaceState({}, '', '/')` + flip `RecoveryGate`
     state to `none` (via a callback prop) so `RoleRouter` mounts and shows
     `LoginScreen` (no `currentUser` → AdminStack → LoginScreen).
   - **native:** flip `RecoveryGate` state to `none`; `RoleRouter` mounts
     `LoginScreen`.
   This is the spec's "routed to / able to reach the sign-in portal
   (`LoginScreen.tsx`)" — achieved by tearing down the gate and letting the normal
   shell render the login screen, not by react-navigation routing.
4. **`error`** — friendly, first-class state (criteria: "This reset link is
   invalid or has expired"). Copy: a clear message + an instruction to **request a
   new link from an administrator** (NO self-service "Forgot password" entry
   point — explicitly out of scope). A secondary CTA "Back to sign-in" tears down
   the gate to `none` (same mechanism as success). **Must NOT** leak the raw
   Supabase error fragment in the URL bar — the gate already scrubbed it via
   `history.replaceState`, and this screen renders the human copy instead.

**Self-guard note:** the recovery flow acts on the **landing user's own** auth
account (whoever holds the recovery session). No `caller.id != target.id` guard
applies (that convention is for admin-on-other-user destructive ops, CLAUDE.md);
this is a user changing their own password. No last-of-role guard either (not a
role change). Confirmed N/A.

### 7. RLS / migration / edge-function / realtime impact — confirmed NONE

- **RLS:** none. `resetPasswordForEmail`, `exchangeCodeForSession`, and
  `updateUser({ password })` are **Supabase Auth (GoTrue)** operations against
  `auth.users` — they do not touch any `public.*` app table, so no policy, no
  `auth_can_see_store` / `auth_is_admin` interaction. The existing `UsersSection`
  role gate (master/admin who may click Reset PW) is unchanged and is the only
  authorization surface.
- **Migration:** **none.** No schema change → no `db-migrations-applied` drift,
  no `supabase_realtime` publication change → **no realtime container restart
  needed** (the `docker restart supabase_realtime_imr-inventory` gotcha does NOT
  apply here).
- **Edge functions:** **none.** Confirmed the chosen PKCE flow needs no edge
  function — it is entirely client-side GoTrue calls. (Only the `token_hash`
  alternative could imply a template; PKCE does not. `verify_jwt` settings in
  `config.toml` are untouched.)
- **Realtime:** **none.** No `store-{id}` / `brand-{id}` channel replays an auth
  operation.

### 8. Frontend store impact

**None to `src/store/useStore.ts`.** The recovery flow is pre-auth and
self-contained; it does not read or write the admin Zustand store, and the
optimistic-then-revert / `notifyBackendError` pattern does **not** apply (there is
no app-table mutation to optimistically reflect — `updateUser` is a one-shot auth
call whose result drives the local screen state machine directly). The only store
interaction is *implicit and downstream*: after the success-CTA `signOut()` +
gate teardown, `RoleRouter` reads `useStore.currentUser` (null) and mounts
`LoginScreen` — existing behavior, no new store code.

### 9. Risks, tradeoffs, and empirical checks

- **[Must verify on local stack — highest-priority unknown] Cross-device PKCE
  exchange.** As noted in §1, the developer MUST confirm a `?code=` recovery link
  opened in a fresh browser profile exchanges via `exchangeCodeForSession`
  without a local code-verifier. Test path: local stack (`npm run dev:db`),
  trigger `sendPasswordReset` against a seeded user, pull the recovery link from
  Inbucket/Mailpit (local mail catcher), open it in an incognito window, confirm
  the screen reaches `form`. **If it fails** (strict same-device PKCE), pivot
  `establishRecoverySession` to `verifyOtp({ token_hash, type: 'recovery' })` and
  ADD the email-template manual step (§10 step 3). The design isolates this to one
  function + one manual step.
- **`otp_expired` root-cause confirmation.** Once Site URL + redirect-allowlist
  are set (manual steps) and `redirectTo` is passed, re-test the real prod link.
  If `otp_expired` persists on scanned mailboxes specifically, that is the
  prefetch hypothesis (c) and PKCE should resolve it; if it persists everywhere,
  suspect genuine short token expiry (manual step 4) — surface to user, do not
  guess in code.
- **`flowType: 'pkce'` regression surface.** Analyzed in §1 as inert for existing
  paths, but it is still a one-line change to a shared client. Mitigation: the
  jest suite already mounts components that import `supabase` (e.g.
  `useStore.test.ts`, `IngredientForm.test.ts`); a green typecheck + existing
  auth-touching tests passing is the guard. The **CI status check after push**
  (CLAUDE.md) applies — confirm `test.yml` green on `main` post-merge.
- **Web-first sequencing.** Ship the web half (no Q1, no `expo-linking` runtime
  dependency on web) first; it is fully testable on the local stack. Native lands
  after Q1 approval. The design keeps the native branch behind `Platform.OS` so a
  web-only build never executes `Linking.createURL`.
- **Seed-dataset / cold-start performance:** N/A — the recovery gate is a
  synchronous string parse on boot (microseconds) and short-circuits before any
  data load. No impact on the 286 KB seed path; the recovery screen loads no app
  data at all.
- **`expo-linking` version pin.** Add via `npx expo install expo-linking` so the
  version matches Expo SDK 54 (do not hand-pick a version in `package.json`).
- **Don't enable `linking`.** Re-stated as a guardrail: the gate is a render-time
  branch *outside* the NavigationContainer; if a developer is tempted to wire
  `linking` to route to the recovery screen, that violates the spec 063 contract —
  reject in review.

### 10. Manual Supabase-dashboard steps this design requires (USER-OWNED)

Agents do NOT perform these. For the chosen **PKCE** flow:

1. **Site URL** → Auth → URL Configuration → set to the **prod web domain** (Q2),
   not `http://localhost:3000`.
2. **Redirect URLs allowlist** → add each `redirectTo` target:
   - **prod web:** `https://<prod-domain>/reset-password` (value of
     `EXPO_PUBLIC_WEB_RECOVERY_URL`),
   - **localhost dev:** `http://localhost:8081/reset-password` (match the local
     Expo web origin; if the dev serves on `:8081`, use that — confirm the running
     port),
   - **native:** `imrinventory://reset-password` — **only after Q1 scheme
     approval**.
3. **(NOT required for PKCE)** Email-template edit — **skip unless** the §9 local
   PKCE check fails and the flow pivots to `token_hash`. If it pivots: Auth →
   Email Templates → Reset Password → use `{{ .TokenHash }}` + recovery
   `redirect_to`.
4. **(Diagnostic only)** Token/OTP expiry — adjust ONLY if §9 root-causing points
   at genuine expiry rather than prefetch.

### 11. Test contract (jest — Track 1)

Three required unit tests (mirror the acceptance criteria), plus an optional e2e
slice:

1. **`src/lib/recoveryUrl.test.ts`** — table-driven over
   `parseRecoveryFromWebLocation` and `parseRecoveryFromUrl`:
   - web `?code=abc` → `{ kind: 'recovery', code: 'abc' }`
   - web `#error=access_denied&error_code=otp_expired&error_description=...` →
     `{ kind: 'error', code: 'otp_expired', description: '...' }`
   - web no params → `{ kind: 'none' }`
   - native `imrinventory://reset-password?code=abc` → `recovery`
   - native `...#error=...&error_code=otp_expired` → `error`
   - error-wins-over-code when both present.
2. **`src/screens/RecoveryScreen.test.tsx`** — mock `supabase.auth.updateUser`
   (resolve / reject) and `establishRecoverySession`:
   - short password / mismatch → validation error, `updateUser` NOT called
   - valid + matching → `updateUser({ password })` called once → success state
   - `updateUser` rejects → stays on form, shows message
   - `parse.kind === 'error'` on mount → renders friendly expired state, no
     `updateUser`.
3. **`src/lib/recoveryRedirect.test.ts`** (or fold into a `sendPasswordReset`
   test) — assert `resolveRecoveryRedirectUrl()` returns the env-var value when
   `EXPO_PUBLIC_WEB_RECOVERY_URL` is set, `window.location.origin + '/reset-password'`
   on web dev, and that `sendPasswordReset` calls `resetPasswordForEmail(email, {
   redirectTo })` with a non-empty `redirectTo` (mock `Platform.OS` per branch;
   mock `supabase.auth.resetPasswordForEmail`). The testable assertion from the
   acceptance criteria is "the call receives a non-empty `redirectTo` matching the
   running platform."

**Playwright (Track 4) — architect call: ONE optional synthetic slice.** The
happy path needs a real email + live token (infeasible in e2e). The **only**
deterministic slice is: boot the web app with a synthetic
`#error=access_denied&error_code=otp_expired` fragment and assert the friendly
expired-link UI renders (not a blank screen, not a raw fragment). This is
worthwhile because it locks the most user-visible failure state, and it needs no
email round-trip. **Recommend adding it** if cheap (`e2e/recovery-expired.spec.ts`)
but it is NOT a blocker — the jest screen test already covers the error state's
logic; the e2e only adds the boot-gate integration. Leave to developer/test-eng
discretion. No pgTAP (no DB change), no shell smoke.

### 12. Exact new/changed files (developer checklist)

**New:**
- `src/lib/recoveryUrl.ts` — pure parser (no supabase/React import).
- `src/lib/recoveryRedirect.ts` — `resolveRecoveryRedirectUrl()` +
  `establishRecoverySession()` (imports `Platform`, `supabase`, native-gated
  `expo-linking`).
- `src/navigation/RecoveryGate.tsx` — boot-time gate; wraps `RoleRouter` in
  `App.tsx`.
- `src/screens/RecoveryScreen.tsx` — set-new-password screen (4-state machine).
- Tests: `src/lib/recoveryUrl.test.ts`, `src/screens/RecoveryScreen.test.tsx`,
  `src/lib/recoveryRedirect.test.ts`. Optional `e2e/recovery-expired.spec.ts`.

**Changed:**
- `src/lib/supabase.ts` — add `flowType: 'pkce'` to the `auth` config.
- `src/lib/auth.ts` — `sendPasswordReset` passes
  `{ redirectTo: resolveRecoveryRedirectUrl() }`; return shape unchanged.
- `App.tsx` — wrap `<RoleRouter />` (line 338) in `<RecoveryGate>`.
- `package.json` — add `expo-linking` via `npx expo install` (native half).

**USER-APPROVAL-GATED (developer must NOT write until approved):**
- `app.json` — add `"scheme": "imrinventory"` (Q1). Native deep-linking is dead
  without it; the web half ships independently.

**USER-MUST-PROVIDE before prod path is final:**
- `EXPO_PUBLIC_WEB_RECOVERY_URL` value (Q2) in Vercel env (and
  `playwright.config.ts` if the e2e slice is added).

## Flow decision + manual steps (frontend-developer)

### Chosen flow: **token_hash (`verifyOtp`)**, NOT PKCE — empirically forced.

The architect chose **PKCE** (`exchangeCodeForSession`) but flagged §1/§9 that it
**must** be verified cross-device because admin-initiated recovery is inherently
cross-device (the admin triggers the reset in THEIR browser; the target clicks
the link in a DIFFERENT browser that holds no PKCE code-verifier). I ran that
test on the local stack and **PKCE FAILED**, so I pivoted to the architect's
documented escalation (`verifyOtp({ token_hash, type: 'recovery' })`), which is
stateless and works cross-device.

**Evidence — PKCE cross-device test (FAILED):**
Two isolated supabase-js clients with `flowType:'pkce'` and separate storages.
Client A (admin) called `resetPasswordForEmail` (wrote `sb-127-auth-token-code-verifier`
to A's storage). The real Mailpit link redeemed to `?code=...`. Client B (fresh,
empty storage — the target's browser) called `exchangeCodeForSession(code)`:

```
exchangeCodeForSession ERROR: PKCE code verifier not found in storage. This can
happen if the auth flow was initiated in a different browser or device, or if the
storage was cleared.
RESULT: CROSS-DEVICE PKCE FAILED — pivot to verifyOtp({ token_hash }).
```

**Evidence — token_hash cross-device test (PASSED):**
A fresh client (no verifier) called `verifyOtp({ token_hash, type: 'recovery' })`
with the `hashed_token` GoTrue emits for `{{ .TokenHash }}`:

```
verifyOtp → session user: manager@local.test | has access_token: true
updateUser({ password }) → success
RESULT: token_hash flow SUCCEEDED in a fresh client — STATELESS / cross-device works.
```

**Evidence — full end-to-end behavioral test (PASSED):** existing admin login
still works post-`flowType` change; real recovery email → token_hash link →
fresh-context `verifyOtp` → `updateUser` → sign in with NEW password works → OLD
password rejected.

**Evidence — REAL-BROWSER verification (Playwright/chromium against the running
Expo web app at :8081), screenshots in `/tmp/spec085-*.png`:**
- Synthetic `#error=access_denied&error_code=otp_expired` boot → friendly
  "Reset link expired" screen (not blank, not a raw fragment).
- Real token_hash link in a FRESH browser context (no verifier) → "Set a new
  password" form → fill + submit → "Password updated" success state.
- Non-recovery boot → normal app (LoginScreen). Success/error CTAs tear down the
  gate and reach the sign-in portal.

### What this changes vs. the architect's design
- **`flowType: 'pkce'` is KEPT** (the architect's blast-radius analysis holds —
  verified login + session-restore still work) but is now **defense-in-depth**,
  not the recovery mechanism. The parser handles a `?code=` link as a defensive
  same-device fallback; the primary path is `token_hash`.
- **`establishRecoverySession` primary branch is `verifyOtp`**, with the
  `exchangeCodeForSession` branch retained as a same-device fallback.
- **The email-template edit is now REQUIRED**, not skipped. The default
  `{{ .ConfirmationURL }}` template produces a `/verify?token=pkce_...` link that
  redirects to `?code=` (PKCE, broken cross-device). The template MUST emit a
  `?token_hash={{ .TokenHash }}&type=recovery` link instead.

### Required manual Supabase-dashboard steps (USER-OWNED — agents did NOT do these in prod)
For the **prod** deployment (the local stack is already configured via
`supabase/config.toml` + `supabase/templates/recovery.html`, see Files changed):

1. **Site URL** — Auth → URL Configuration → Site URL → set to the prod web
   domain (Q2), not `http://localhost:3000`.
2. **Redirect URLs allowlist** — Auth → URL Configuration → Redirect URLs → add:
   - prod web: `https://<prod-domain>/reset-password` (== `EXPO_PUBLIC_WEB_RECOVERY_URL`),
   - native: `imrinventory://reset-password` — only after Q1 scheme approval.
3. **Email template (NOW REQUIRED — this is the pivot)** — Auth → Email Templates
   → **Reset Password** → change the body's link to:
   `<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery">Set a new password</a>`
   (mirror of `supabase/templates/recovery.html`). Without this, prod recovery
   links will be `?code=` PKCE links that **fail cross-device** — the exact bug
   class this spec fixes. This is the single most important manual step.
4. **`EXPO_PUBLIC_WEB_RECOVERY_URL`** — set in Vercel env to the prod
   `https://<prod-domain>/reset-password`.

### Local-dev artifacts (committed, flagged for user review)
To make the LOCAL stack demonstrate the chosen flow (the prod dashboard steps
have no local equivalent), I changed two repo files — both clearly commented as
spec-085 LOCAL-DEV mirrors:
- `supabase/config.toml` — added localhost redirect targets to
  `additional_redirect_urls` and an `[auth.email.template.recovery]` block.
- `supabase/templates/recovery.html` — the local recovery email template emitting
  the token_hash link.
These require `npx supabase stop && npm run dev:db` to take effect. If you prefer
not to carry local email-template config in the repo, they can be reverted — the
prod behavior is unaffected (it's driven by the dashboard steps above).

### Open items unchanged
- **Q1 (native `app.json` scheme)** — NOT written. The native branch
  (`Linking.createURL`, `Linking.getInitialURL`/`addEventListener`) is in place
  behind `Platform.OS` as DEAD CODE with a `// TODO(spec-085 Q1)` marker; it
  won't function until the scheme is approved + added. Web ships independently.
- **Q2 (prod domain)** — parameterized via `EXPO_PUBLIC_WEB_RECOVERY_URL` with a
  `window.location.origin` local-dev fallback.
- **`expo-linking`** — added via `npx expo install expo-linking` (`~8.0.12`) and
  added to the jest `transformIgnorePatterns` allow-list (it ships untranspiled
  ESM and `auth.ts` now imports it transitively).

## Files changed

**New:**
- `src/lib/recoveryUrl.ts` — pure recovery-URL parser (no supabase/React/expo-linking import).
- `src/lib/recoveryRedirect.ts` — `resolveRecoveryRedirectUrl()` + `establishRecoverySession()`.
- `src/navigation/RecoveryGate.tsx` — boot-time URL gate wrapping `RoleRouter`.
- `src/screens/RecoveryScreen.tsx` — set-new-password 4-state screen.
- `src/lib/recoveryUrl.test.ts` — parser unit tests.
- `src/lib/recoveryRedirect.test.ts` — `resolveRecoveryRedirectUrl` + `sendPasswordReset` redirectTo + `establishRecoverySession` tests.
- `src/screens/RecoveryScreen.test.tsx` — screen validation + mocked `updateUser`/`establishRecoverySession` tests.
- `supabase/templates/recovery.html` — LOCAL-DEV recovery email template (token_hash). Flagged for user review.

**Changed:**
- `src/lib/supabase.ts` — add `flowType: 'pkce'` (defense-in-depth; recovery uses token_hash).
- `src/lib/auth.ts` — `sendPasswordReset` passes `{ redirectTo: resolveRecoveryRedirectUrl() }`; return shape unchanged. Added the import.
- `App.tsx` — wrap `<RoleRouter />` in `<RecoveryGate>`; import it.
- `jest.config.js` — add `expo-linking` to `RN_TRANSPILE_DEPS` (untranspiled ESM).
- `package.json` / `package-lock.json` — add `expo-linking ~8.0.12`.
- `supabase/config.toml` — LOCAL-DEV recovery redirect allowlist entries + `[auth.email.template.recovery]` block. Flagged for user review.

**NOT changed (user-gated):**
- `app.json` — no `scheme` added (Q1, pending user approval); native branch is dead code behind `Platform.OS`.
