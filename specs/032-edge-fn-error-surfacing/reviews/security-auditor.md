# Security audit for spec 032

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

- `supabase/functions/delete-user/index.ts:122`, `supabase/functions/send-invite-email/index.ts:105`, `supabase/functions/send-welcome-email/index.ts:94` — Pre-existing catch-all surfaces `(e as Error).message` verbatim as the JSON `error` field with HTTP 500. After spec 032, that string now lands in the operator's toast verbatim (previously swallowed). The strings are produced by the Deno runtime / Supabase JS client and historically have been generic ("relation X does not exist", "JSON object requested, multiple rows returned", JWT errors). Risk profile: the toast consumer is a JWT-validated admin (the helper short-circuits on missing session at `src/lib/auth.ts:132` with `error: 'Not authenticated'` BEFORE any fetch), so the disclosure surface is admin-to-admin, not cross-tenant. No stack traces are exposed (`.message` only, not `.stack`). PII risk: a future `lookupError.message` from `delete-user/index.ts:85` could echo a `userId` UUID, which is already known to the caller (they supplied it as the request body). **Not a finding against spec 032** — the leak surface is in the edge functions, pre-existed this spec, and the audience is privileged. Flagged for awareness: any future leakier message added to an edge function will now be visible to the operator without a follow-up client change. Suggested follow-up: edge functions should consider mapping `e.message` to a generic "Internal server error" with `console.error(e)` for server-side observability instead of forwarding the raw message — but that is a separate cleanup, not a spec 032 prerequisite.

- `src/lib/auth.ts:148` — The `fetch` rejection branch returns `e?.message || 'Network error'` verbatim. On modern browsers `fetch` rejection messages are typically generic ("Failed to fetch", "NetworkError when attempting to fetch resource") and contain no PII or secrets. On Deno / native runtimes the message may include the URL fragment of the failing host, which in our case is `EXPO_PUBLIC_SUPABASE_URL` — already publishable (it ships in the web bundle). No disclosure risk beyond what the client already exposes.

- `src/lib/auth.ts:132` — Missing-session returns `error: 'Not authenticated'`. This does NOT create a new probing surface for "am I logged in?" — the call requires a valid admin to traverse `requireAdminCaller()` server-side anyway, and `supabase.auth.getSession()` is freely readable from the same client. The change is strictly informational for the operator. No new attack surface.

## Dependencies

No `package.json` / `package-lock.json` changes in this spec (`git diff HEAD --stat` confirms only `CLAUDE.md`, `specs/031-...spec.md`, `src/lib/auth.ts` modified). `npm audit` not run — no dependency delta to evaluate.

## Threat-model coverage walk

The audit brief's six focus areas, addressed in order:

1. **Information disclosure via error messages.** The new helper extracts strings verbatim from `parsed.error` / `parsed.message`. Edge functions inspected for leak shape (`delete-user`, `send-invite-email`, `send-welcome-email`):
   - **Intentional disclosures** (OK): `"cannot delete self"`, `"cannot delete the last super_admin"` (spec 031), `"cannot delete master"`, `"forbidden"`, `"missing bearer token"`, `"invalid token"`, `"userId required"`, `"email and name required"`, `"email mismatch"`, `"profile not found"`. All static literals, no caller-controlled data interpolated, no PII.
   - **Forwarded Postgres/Deno messages** (pre-existing low-risk, see Low §1): `lookupError.message`, `guardError.message`, `(e as Error).message` from generic catch blocks. Spec 032 makes these visible where they were silently swallowed before. Audience is privileged admin per session check.
   - No stack traces, no SQL fragments, no secrets, no cross-tenant row data observed in the inspected paths.

2. **Spoofing surface — trusted error fields.** The helper accepts `parsed.error` (preferred) then `parsed.message` (fallback), both as strings. Worst case: a compromised edge function returns arbitrary text. Rendering path verified:
   - `src/store/useStore.ts:25` `notifyBackendError` wraps the string into a `Toast.show({ text1, text2: message })` payload.
   - `App.tsx:222` mounts `<Toast />` with NO `toastConfig` prop, so the library default `BaseToast` renders via plain `<Text>` components — text-only, no HTML interpretation.
   - Grep for `dangerouslySetInnerHTML`, `RenderHtml`, `BaseToast` config in `src/` returns zero hits.
   - The string also lands in `console.warn` at `src/store/useStore.ts:27` — operator-visible console only, not a remote logging endpoint (`notifyBackendError` has no telemetry sink).
   - No path observed where the error string is concatenated into an HTTP redirect URL, written to localStorage / sessionStorage, or fed back to a server endpoint. No exploitable spoofing surface.

3. **Missing session handling.** `src/lib/auth.ts:130-132` short-circuits with `{ data: null, error: 'Not authenticated' }` and does NOT call `fetch`. Confirmed by `src/lib/auth.test.ts:197-208` (case 10). No new probing channel — `supabase.auth.getSession()` is already client-readable, this branch adds no information beyond what the client already has.

4. **Caller chain.** Three consumers of `callEdgeFunction`:
   - `inviteUser` (`src/lib/auth.ts:242`) — fire-and-forget. Envelope discarded. No new disclosure path.
   - `registerInvitedUser` (`src/lib/auth.ts:327`) — fire-and-forget. Same.
   - `deleteUser` (`src/lib/auth.ts:437-440`) — destructures `{ error }`, returns it to `deleteProfile` at `src/store/useStore.ts:796-799`, which calls `notifyBackendError('Delete profile', new Error(error))`. The string reaches a Toast and `console.warn`. No further sinks.
   No caller pipes the string into a URL, an HTTP body for a re-request, or a storage write. Confirmed via grep across `src/`.

5. **`npm audit` baseline.** No `package.json` / `package-lock.json` changes (verified via `git diff HEAD --stat`). Baseline unchanged. Skipped.

6. **Toast rendering surface.** Verified at App.tsx and via grep: `<Toast />` mounts with library defaults, no custom `toastConfig`, no `dangerouslySetInnerHTML` usage anywhere in `src/`. `react-native-toast-message` `BaseToast` renders `text1` / `text2` as `<Text>` children — text-only, no HTML, no XSS surface. Spec 028's `escapeHtml` convention does NOT apply here because the rendering surface is not HTML. Confirmed.

## Spec-specific positive observations

- `src/lib/auth.ts:147-149` — The fetch try/catch ONLY wraps the network call, not the body parse. This is correct per the architect's §2 walk-through and means a hypothetical bug in `response.text()` would surface (not silently swallow) — better than the previous blanket catch-all.
- `src/lib/auth.ts:152-159` — The body-parse try/catch is scoped to JSON parsing only and explicitly degrades to `parsed = null`. A non-JSON 5xx (e.g. nginx 502 HTML error page) cannot crash the helper, and the operator still sees `HTTP 500` via the tier-3 fallback. Defense-in-depth.
- `src/lib/auth.test.ts:171-183` — Case 8 pins the `HTTP 401 + { error: "Unauthorized" }` surface, which exercises the gateway-level path. Good regression cover.
- `src/lib/auth.test.ts:200-207` — Case 10 asserts `fetch` is NEVER called when session is null. This pins the short-circuit and prevents a future refactor from accidentally leaking session-state probes.
- `src/lib/auth.test.ts:225-228` — Case 11 pins the `Authorization: Bearer <token>` header shape AND the `/functions/v1/<fnName>` URL routing. Defense against an accidental hardcoded-bearer or path-traversal-via-fnName regression.

## Notes / non-findings

- The audit brief flagged `inviteUser` / `registerInvitedUser` fire-and-forget patterns as a potential silent-failure surface. The spec is explicit (§"In scope" / "Out of scope") that this is intentional — the invitation row is the load-bearing artifact, the email is best-effort. Documented in `src/lib/auth.ts:120-123` JSDoc. Not a finding.
- The CLAUDE.md convention bullet (line 67-77 area) prescribing `callEdgeFunction` as the single transport boundary is a positive drift-prevention measure — it forecloses the failure mode where a future developer hand-rolls `fetch('/functions/v1/<fn>')` and silently re-introduces the swallow bug. Architect-required grep `grep -RE 'await fetch.*functions/v1' src/` confirmed zero hits outside `src/lib/auth.ts:139` (the helper itself).
- `src/hooks/useRole.ts` placeholder is unchanged and is not used by any caller in this spec. No client-side role-boundary regression.
- No new RLS policies, no new tables, no migration changes, no realtime publication changes. No `verify_jwt` setting changes in `supabase/config.toml`. No new edge functions.

## Verdict

Spec 032 is a pure client-side correctness fix that converts silent fake-success into structured error envelopes. No new attack surface, no new disclosure channel beyond what the edge functions already emit to privileged callers, no XSS / spoofing surface via the toast rendering path. Safe to ship.
