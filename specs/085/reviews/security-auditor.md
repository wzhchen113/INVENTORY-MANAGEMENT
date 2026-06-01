# Security audit for spec 085 — admin-initiated password reset (recovery landing flow)

Reviewed working-tree changes (UNSTAGED + untracked) for the pre-auth password-recovery surface:
boot-time gate, set-new-password screen, recovery-URL parser, the `flowType: 'pkce'` client change,
the `sendPasswordReset` `redirectTo`, and the LOCAL-DEV `config.toml` / `recovery.html` artifacts.

This is a credential-handling surface, so I held a high bar — every one of the seven requested
questions is audited explicitly below.

**Verdict: NO Critical findings. NO High findings.** The flow is well-constructed; the token never
lands in history, logs, or third-party referers, and the set-password call is correctly gated behind
a real recovery session. Three Low notes (defense-in-depth / docs), and the dependency picture is
clean for this spec. Reasoning on the load-bearing items (1–3) is given in full.

---

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `src/screens/RecoveryScreen.tsx:32` / `:94` — **client-side password floor (8) is stricter than
  the documented local-stack GoTrue minimum (6), but neither this screen nor the spec pins the PROD
  `minimum_password_length`.** The screen defers strength entirely to Supabase's policy beyond the
  length-8 + confirm-match check, which is a reasonable tradeoff (Supabase is the authority for
  password policy). Not a blocker. Note for the user's manual-dashboard checklist: confirm the prod
  project's Auth → Policies `minimum_password_length` is >= 8 so the server floor matches the client
  floor; otherwise a user could be told "min 8" by the UI while the server would have accepted 6.
  No code change required.

- `src/lib/recoveryRedirect.ts:46` — **web-dev fallback derives `redirectTo` from
  `window.location.origin`.** This is correct and safe for the LOCAL dev path (the value is only the
  link the *email* points back at, and GoTrue independently validates it against the
  `additional_redirect_urls` allowlist — an attacker cannot redirect the recovery link to an
  arbitrary origin just by controlling `window.location` at send-time, because send-time happens in
  the trusted admin's already-authenticated browser and the allowlist is the real gate). In PROD the
  env var `EXPO_PUBLIC_WEB_RECOVERY_URL` takes precedence, so `window.location.origin` is never used
  in prod. No finding — flagged only so the reviewer understands the origin-derived value is gated by
  the server-side redirect allowlist, not trusted blindly. The genuinely load-bearing control here is
  manual dashboard step 2 (redirect-URL allowlist); if that allowlist is left wide-open
  (`*`) in prod, recovery links could be redirected to an attacker origin carrying the
  `token_hash` — call this out to the user as the one prod setting that MUST be a tight exact-match
  list, not a wildcard.

- `supabase/config.toml:159-165` — **the local redirect allowlist adds `http://localhost:8081/**`
  wildcard-path entries.** This is LOCAL-STACK ONLY (confirmed below) and harmless for dev, but
  note the wildcard is a path wildcard on a fixed localhost origin, which is fine. The PROD allowlist
  (user-owned, step 2) should use the exact `https://<domain>/reset-password` path, NOT a host-level
  wildcard — already correctly documented in the spec's manual steps as an exact URL. No code change;
  reinforces the Low above.

---

## Detailed answers to the seven load-bearing questions

### 1. Recovery-token URL hygiene — PASS (this is the most important check; it is correctly handled)

The `token_hash` (and the defensive `code` / `#access_token`) arrives in the URL. After the gate's
synchronous read captures the parse into React state, it scrubs the URL:

- `src/navigation/RecoveryGate.tsx:47-54` — `scrubRecoveryUrl()` calls
  `window.history.replaceState({}, '', window.location.pathname)`, which drops the **entire** query
  string AND fragment (it replaces with `pathname` only). The one-time `token_hash`/`code`/`error`
  payload is gone from the address bar.
- `src/navigation/RecoveryGate.tsx:65-71` — the scrub fires in a mount effect *after* the synchronous
  read already captured the parse into `useState` (line 59), so the value is preserved for the screen
  while the URL is cleaned. Correct ordering — no race where the screen reads a scrubbed URL.

Hygiene properties this gives us, all confirmed:
- **History:** `replaceState` (not `pushState`) means the token URL is not added as a back-button
  history entry — it is overwritten in place.
- **Referer:** because the token is removed from the URL before any in-app navigation or outbound
  asset request that could carry a `Referer`, it will not leak to third parties via the referer
  header. (The recovery screen also loads no third-party resources.)
- **Screenshot/share:** the address bar shows `/reset-password` with no token after the first paint's
  scrub.

**Logging:** I grepped every new file (`recoveryUrl.ts`, `recoveryRedirect.ts`, `RecoveryGate.tsx`,
`RecoveryScreen.tsx`) for `console.*`, `notifyBackendError`, `analytics`, `track(` — **zero matches**.
The token is never logged, never put in a toast, never sent to `notifyBackendError`. The friendly
error screen renders static human copy ("This reset link is invalid or has expired"), not the raw
fragment or the token. This is exactly right for a credential-bearing URL.

One sequencing nuance, NOT a finding: on web the verify (`verifyOtp`) is fired from `RecoveryScreen`'s
mount effect (`RecoveryScreen.tsx:63-86`) using the `parse` already in memory, so even though the URL
is scrubbed by the gate, the token is still available to redeem. Confirmed the scrub does not strand
the token before it is consumed.

### 2. Pre-auth surface abuse — PASS (the gate grants no access on its own)

`RecoveryGate` runs before `RoleRouter`/auth. I traced every path a crafted URL can drive:

- The gate only renders `<RecoveryScreen>` when `parse.kind !== 'none'`
  (`RecoveryGate.tsx:102-104`); otherwise it renders `children` (the normal unauthenticated shell)
  (`:106`). A malformed/junk URL parses to `{ kind: 'none' }` (the parser's default fall-through,
  `recoveryUrl.ts:117`) and falls straight through to the normal shell — no special access.
- `RecoveryScreen` renders only four states (`exchanging`/`error`/`success`/`form`). **None of them
  render any authenticated app content** — no store data, no Cmd sections, no staff screens. It does
  not mount `RoleRouter`, does not read `useStore`, and has no path to authenticated UI. The worst an
  attacker can do with a hand-crafted `?token_hash=...&type=recovery` is reach a password *form* that
  is inert without a real recovery session (see #3). A hand-crafted `#error=...` reaches the static
  friendly-error screen. Neither exposes data or authenticates anyone.
- The gate cannot be driven into rendering authenticated content because the only non-`none` branch is
  `RecoveryScreen`, which is a self-contained leaf. There is no `parse` value that makes the gate
  render `children` *and* a recovery overlay, or that grants a session by itself — establishing a
  session requires a successful server-side `verifyOtp`/exchange (#3).

The parser is also correctly narrow: it requires `type === 'recovery'` for both the `token_hash` and
the implicit-`access_token` branches (`recoveryUrl.ts:96`, `:113`), so it will not hijack a signup /
email-change / magic-link token that happens to be in the URL. Error wins over recovery
(`recoveryUrl.ts:81-89`), so an `otp_expired` link always lands on the friendly state rather than
attempting a doomed redeem. Good.

### 3. `updateUser({ password })` requires a valid recovery session — PASS

This is the core authorization invariant and it holds:

- `RecoveryScreen.tsx:105` calls `supabase.auth.updateUser({ password })` with NO user id and NO
  token — it operates purely on whatever session the supabase client currently holds. That session is
  established **only** by `establishRecoverySession` (`recoveryRedirect.ts:79-106`), which calls
  `supabase.auth.verifyOtp({ token_hash, type: 'recovery' })` (`:83`) — a server-side GoTrue redeem.
  If `verifyOtp` returns an error (bad/expired/forged `token_hash`), `establishRecoverySession`
  returns `{ ok: false }` (`:87`), the screen transitions to the `error` state
  (`RecoveryScreen.tsx:74-78`), and the form — and therefore `updateUser` — is **never reached**.
- An attacker cannot reach the set-password form against someone else's account: the form
  (`state === 'form'`) is only entered after `establishRecoverySession(...).ok === true`
  (`RecoveryScreen.tsx:73`). Supabase scopes `updateUser` to the session the recovery token minted;
  the code never calls `updateUser` pre-session. There is no code path that calls `updateUser` from
  the `exchanging`/`error`/`success` states.
- The `error`-parse case short-circuits even earlier: initial state is `'error'` when
  `parse.kind === 'error'` (`RecoveryScreen.tsx:49-51`), and the mount effect's redeem only runs for
  recovery-kinds (`:65-69`), so an `error` URL never even calls `establishRecoverySession`. The jest
  test `RecoveryScreen.test.tsx:56-64` locks this ("renders the friendly expired state and never
  establishes a session or calls updateUser").
- The test suite pins the rest of the invariant: `updateUser` is NOT called on too-short password
  (`RecoveryScreen.test.tsx:88-98`), on mismatch (`:100-110`), or on a failed exchange (`:81-86`);
  and is called exactly once with a valid matching password (`:112-123`). The validation gate runs
  before `updateUser` (`RecoveryScreen.tsx:88-104`).

Verified there is no other `supabase.auth.updateUser` / `exchangeCodeForSession` / `verifyOtp` /
`onAuthStateChange` call site in production `src/` (grep, excluding tests/mocks). This is genuinely the
first and only such call site, and it is correctly gated.

### 4. Password validation — PASS (reasonable; tradeoff noted)

`RecoveryScreen.tsx:88-101` validates BEFORE submit: non-empty, length >= 8
(`MIN_PASSWORD_LENGTH`, `:32`), and confirm-match, with field-level errors. No strength floor beyond
length — deferred to Supabase's server policy, which is the correct authority. The only follow-up is
the Low above: align the prod `minimum_password_length` to >= 8 so the server matches the UI promise.
Not a blocker.

### 5. `flowType: 'pkce'` change — PASS (independently verified inert for existing flows)

I did NOT take the architect's word for this; I re-derived it. `flowType` only governs the
OAuth/magic-link/recovery `?code=` redirect-exchange leg. I grepped every existing auth entry point and
confirmed none exercise that leg:

- `signInWithPassword` (sign-in) — password grant, no `?code=` exchange. Unaffected.
- `signUp` (invited registration, `auth.ts`) — inline session, no redirect leg, no `emailRedirectTo`.
  Unaffected.
- `getSession` (cold-start restore) — reads persisted session; flowType-agnostic. Unaffected.
- `setSession({ access_token, refresh_token })` (`App.tsx:119`, dev `?session=` inject) — direct token
  set, flowType-agnostic, and `__DEV__`-gated (stripped from prod bundles). Unaffected.
- `detectSessionInUrl: Platform.OS === 'web'` (`supabase.ts:18`) — this is the ONE behavior that
  changes with PKCE (it now looks for `?code=` rather than `#access_token`). But the app's only
  redirect-returning auth flow is the recovery link this spec adds, and the recovery flow now uses
  `token_hash` (redeemed explicitly by `verifyOtp`, not by `detectSessionInUrl`). No existing flow
  relies on `detectSessionInUrl` parsing a fragment, because there was previously no redirect-returning
  flow at all (no `resetPasswordForEmail` `redirectTo`, no OAuth). So the `detectSessionInUrl` change
  is inert for existing paths.

Net: confirmed independently that `flowType: 'pkce'` does not break or alter sign-in,
session-restore, invited-registration, or the dev session-inject. It is defense-in-depth here (the
recovery mechanism is `token_hash`, not PKCE). No finding.

### 6. `config.toml` / `recovery.html` local-dev changes — PASS (local-stack only; no prod weakening; no secrets)

- `supabase/config.toml:153` — `site_url` is **unchanged** (still `http://127.0.0.1:3000`, the local
  default). The diff does not touch prod posture.
- `supabase/config.toml:159-165` — the added `additional_redirect_urls` are all
  `localhost:8081` / `127.0.0.1:8081` (the local Expo web origin). No prod URL, no wildcard host.
  These are the local GoTrue allowlist only; the prod redirect allowlist is a user-owned dashboard
  step (correctly documented in the spec, NOT committed here).
- `supabase/config.toml:257-264` — the `[auth.email.template.recovery]` block points
  `content_path` at `./supabase/templates/recovery.html`. This is the local-stack mirror of the
  user-owned prod email-template edit. It does not alter prod (prod templates are dashboard-owned).
- `supabase/templates/recovery.html` — contains only GoTrue template variables
  (`{{ .RedirectTo }}`, `{{ .TokenHash }}`) and static copy. **No secret, no token, no API key, no
  service-role key** is committed. `{{ .TokenHash }}` is a GoTrue-rendered placeholder, not a literal
  value. Confirmed clean.

These are LOCAL-STACK ONLY and require `npx supabase stop && npm run dev:db` to take effect (per the
header comments). They do not weaken any prod security posture. The committed config is the local dev
stack; prod `site_url` / redirect allowlist / template are the user's dashboard settings, as the
threat model requires.

### 7. Error-state info leak — PASS

The friendly error screen (`RecoveryScreen.tsx:147-171`) renders **static human copy** only ("Reset
link expired" / "This reset link is invalid or has expired" / "ask your administrator to send you a
new reset link"). It does NOT render:
- the raw Supabase error fragment / `error_description` from the URL (the gate scrubbed the URL; the
  screen shows fixed copy, not the fragment — note `exchangeError`/`parse.description` is held in
  state but the JSX deliberately does NOT print it, it prints the canned string),
- token values,
- internal stack traces or SQL,
- user-existence signals — the copy is identical whether the token was expired, malformed, forged, or
  for a non-existent user (all roads lead to the same generic message). No account-enumeration oracle.

The `establishRecoverySession` failure path surfaces `error.message` into `exchangeError`
(`RecoveryScreen.tsx:76`), but again the error JSX prints the canned copy, not `exchangeError`, so no
GoTrue internal message reaches the screen on the *exchange* failure path. (On the `form` submit path,
`updateUser`'s `error.message` IS shown inline at `:109` — e.g. "New password should be different from
the old password" — which is appropriate, user-facing, non-sensitive policy feedback, not an internal
leak.) No finding.

---

## Cross-cutting threat-model checks (project-specific)

- **RLS / migrations / edge functions / realtime:** none touched. `resetPasswordForEmail`,
  `verifyOtp`, `updateUser`, `signOut` are GoTrue (auth.users) operations — no `public.*` table, no
  policy, no `auth_can_see_store` / `auth_is_admin` interaction, no new table, no migration, no
  publication change. Confirmed against the diff. Nothing for the RLS / new-table / verify_jwt checks
  to flag.
- **Secrets:** no service-role key, no service token, no third-party API key anywhere in the diff or
  new files. The only env var added is `EXPO_PUBLIC_WEB_RECOVERY_URL` — a non-sensitive public
  recovery URL (correct `EXPO_PUBLIC_*` usage; it is a URL, not a credential). No secret reachable from
  the client.
- **PII:** the recovery screen reads/writes nothing from the seed or any store; it operates only on the
  landing user's own auth account. No row exfiltration path.
- **Self-guard / last-of-role:** N/A and correctly so — the recovery flow is a user changing THEIR OWN
  password (the session is the landing user's own recovery grant). The `caller.id != target.id` and
  last-of-role disciplines apply to admin-on-other-user destructive ops, not self-service password
  change. Confirmed N/A.
- **`useRole()` placeholder:** not used as a security boundary anywhere in this change. Not flagged.
- **CSRF:** the recovery API is token-bearer / same-origin GoTrue with no cookie auth in this app's
  client flow; no CSRF surface introduced. Not flagged (per threat-model rules).

---

### Dependencies

`package.json` changed (added `expo-linking ~8.0.12`) → ran `npm audit --audit-level=high`.

Result: **1 high, 17 moderate, 0 critical.** The single high is `@xmldom/xmldom@0.8.12` (XML
serialization DoS / XML injection). I traced its dependency path:

```
expo@54.0.33 → @expo/config-plugins → xcode → simple-plist → plist → @xmldom/xmldom
```

This is reachable through the **root `expo` dependency independent of `expo-linking`** — it is a
build-time / iOS-prebuild (`xcode` plist parsing) dependency carried by every Expo SDK 54 project,
present before this spec. `expo-linking` appears in the advisory tree only because it shares the
`expo-constants` transitive node, NOT because it pulls in `@xmldom/xmldom`. Removing `expo-linking`
would not remove the high.

**Attribution: this spec does NOT introduce the high (or any new) vulnerability.** `expo-linking`
itself adds no new advisory. The `@xmldom/xmldom` high is a pre-existing, build-time-only,
not-runtime-reachable Expo toolchain issue — out of scope for this spec and not a blocker for it.
Recommend tracking the Expo-toolchain `@xmldom/xmldom` upgrade as its own housekeeping item (it is not
on the shipped web/native runtime bundle or any request path), but it does NOT block spec 085.

---

## Summary

Spec 085 ships a pre-auth password-recovery surface, the most security-sensitive class of change in
this codebase, and it is built correctly. The recovery token is scrubbed from the URL via
`history.replaceState` to `pathname` before any navigation (no history/referer/screenshot leak), and is
never logged, toasted, or sent to analytics. The boot gate grants no access on its own — a malformed
URL falls through to the normal unauthenticated shell, and the recovery screen is a self-contained leaf
that renders no authenticated content. The set-password call (`updateUser`) is correctly gated behind a
real server-side recovery session established by `verifyOtp({ token_hash, type: 'recovery' })`; an
attacker cannot reach or fire it against another account without a valid token, and the jest suite pins
that invariant (no `updateUser` on validation failure, on exchange failure, or on an error-parse).
Password validation (length>=8 + confirm-match) runs before submit, deferring strength to Supabase's
policy. The `flowType: 'pkce'` change is independently verified inert for sign-in /
session-restore / invited-registration / dev-inject (the recovery flow uses `token_hash`, not PKCE).
The `config.toml` / `recovery.html` changes are local-stack only, weaken no prod posture, and commit no
secret. The friendly error state leaks nothing (no token, no internal error, no user-existence oracle).
The lone `npm audit` high (`@xmldom/xmldom`) is a pre-existing build-time Expo-toolchain dependency NOT
introduced by this spec and not runtime-reachable. **No Critical, no High, no Medium; three Low
defense-in-depth/docs notes (align prod `minimum_password_length`, keep the prod redirect allowlist a
tight exact-match list, the local wildcard is fine). This spec is clear to advance from a security
standpoint.**
