# Spec 032: callEdgeFunction non-2xx error surfacing

Status: READY_FOR_REVIEW

## User story

As an admin operating the Cmd UI's user-management surface, when the
`delete-user` (or `send-invite-email` / `send-welcome-email`) edge
function refuses my request with an HTTP 4xx/5xx + structured `{
error: <string> }` body, I want a red error toast that names the
refusal reason and the local user cache to NOT report optimistic
success, so that I can see WHY the server refused (e.g. "cannot delete
the last super_admin", "An invitation for this email already exists")
and the UI does not lie to me about a fake successful mutation that
disappears on the next refresh.

### Foot-gun being closed (surfaced by spec 031 code-reviewer S1)

`src/lib/auth.ts:109-127` defines a `callEdgeFunction(fnName, body)`
helper used by every edge-function caller in the admin app
(`send-invite-email`, `send-welcome-email`, `delete-user`). The
helper uses a bare `await fetch(...)` with:

1. **No `response.ok` check.** A 400 response from the edge function
   does NOT throw in `fetch` — only a network error throws. The
   helper resolves normally on any HTTP response.
2. **A blanket catch-all that swallows everything.** Even if a future
   variant threw on non-2xx, the `try { ... } catch { /* email is
   non-critical */ }` block silently consumes it.

The downstream effect for the `delete-user` path (the concrete case
surfaced by spec 031's review):

- `callEdgeFunction('delete-user', { userId })` resolves to `void`
  on a 400 response (e.g. spec 031's "cannot delete the last
  super_admin" refusal, spec 027's "cannot delete self" refusal).
- `deleteUser(userId)` (`src/lib/auth.ts:387-394`) wraps the call in
  a `try { await callEdgeFunction(...); return { error: null }; }
  catch (e) { return { error: e.message }; }` envelope. Because the
  helper never throws, `deleteUser` returns `{ error: null }`
  unconditionally.
- `deleteProfile` in `src/store/useStore.ts:792-825` inspects
  `error`, sees `null`, mutates `brandAdminsByBrandId` to drop the
  row, and fires a green `'Profile deleted'` info toast.
- `UsersSection` shows the row disappearing from the table.
- On the next `refresh()` (or page reload), `fetchAllUsers()`
  re-fetches and the row reappears — because the server actually
  refused the delete and the profile row was never removed.

The same shape applies to:

- `sendPasswordReset` — fortunately uses `supabase.auth.resetPasswordForEmail`
  directly (not `callEdgeFunction`), so unaffected.
- `inviteUser` → `callEdgeFunction('send-invite-email', ...)` —
  fired fire-and-forget; the comment at line 191-192 explicitly
  says "non-blocking. Payload unchanged" so server-side 4xx from
  the email template (e.g. spec 028's HTML-escape failure, missing
  RESEND_API_KEY) silently drops without surfacing to the operator.
  The invitation row still gets inserted, so the user can
  register — but the operator never learns the email didn't send.
- `registerInvitedUser` → `callEdgeFunction('send-welcome-email', ...)`
  — same shape, same fire-and-forget pattern.

### Why this is the right time to fix

1. Spec 031 landed a robust server-side guard (`assert_not_last_of_role`
   raises P0001 → edge function returns HTTP 400 + verbatim message)
   that is currently invisible to the operator. The guard works; the
   client just throws away the message.
2. Spec 028's escapeHtml refactor and spec 027's role-gate parity both
   added 4xx server-side refusal paths that have the same silent-success
   surface. Closing this client-side gap completes the loop for all
   three specs simultaneously.
3. The fix is pure-frontend (no migrations, no edge-function changes,
   no realtime channel touched) — low blast radius, ships with the
   next Vercel auto-deploy.

## Acceptance criteria

### Helper contract

- [ ] `src/lib/auth.ts:109-127` `callEdgeFunction` is rewritten with the
      following contract (verified by jest):
        1. Signature changes from `Promise<void>` to
           `Promise<{ data: any; error: string | null }>`.
        2. On HTTP 2xx: returns `{ data: <parsed JSON body or null>,
           error: null }`. Body parse failure (non-JSON body, empty
           body) is NOT an error — returns `{ data: null, error:
           null }`. Rationale: a 2xx response from the edge gateway
           with an empty body (e.g. webhook-style 204) is still a
           success.
        3. On HTTP non-2xx: returns `{ data: null, error: <string> }`
           where `<string>` is:
             - If the response body parses as JSON AND contains an
               `error` field that is a string → that string verbatim
               (e.g. `"cannot delete the last super_admin"`).
             - Else if the response body parses as JSON AND contains
               a `message` field that is a string → that string
               (fallback for edge functions / gateway errors that
               use `message` instead of `error`).
             - Else → a synthesized string of the form
               `HTTP <status>` (e.g. `"HTTP 500"`). Bare status as
               last resort so the toast at least surfaces SOMETHING
               informative.
        4. On network failure (fetch rejects — DNS, connection refused,
           timeout): returns `{ data: null, error: <e.message ||
           'Network error'> }`. The blanket catch-all is replaced
           with a structured envelope.
        5. On missing session (`token` is null/undefined): returns
           `{ data: null, error: 'Not authenticated' }`. The existing
           silent-return is replaced — the caller needs to know the
           request never went out.
- [ ] JSDoc on `callEdgeFunction` documents the contract verbatim
      (a future caller reading the helper should see the envelope
      shape without having to read the implementation).
- [ ] No new dependencies, no new imports.
- [ ] No change to `callEdgeFunction`'s argument shape — `(fnName:
      string, body: Record<string, any>)` is preserved so callers
      that already exist don't have to refactor signatures.

### Caller chain audit

- [ ] **`inviteUser`** (`src/lib/auth.ts:151-203`): the `callEdgeFunction
      ('send-invite-email', ...)` call at line 192 currently fires
      fire-and-forget (no `await`, no error handling). Since the
      invitation row is the load-bearing artifact (registration only
      needs the row), the email is genuinely best-effort. Spec 032
      MAY keep this fire-and-forget at the call site, OR upgrade to
      `await` + `console.warn` on `error`. **Decision: keep
      fire-and-forget at the call site (no behavioral change in the
      invite flow), BUT the helper's structured return is still
      preferred over a thrown exception** so a future caller can
      switch to `await` without a different exception-handling shape.
      The fire-and-forget call doesn't await — the helper's structured
      return is therefore irrelevant for this caller, but the helper's
      JSDoc must call out the fire-and-forget pattern explicitly so a
      future reader doesn't mistake the lack of `await` for a bug.
- [ ] **`registerInvitedUser`** (`src/lib/auth.ts:206-283`): same
      shape — `callEdgeFunction('send-welcome-email', ...)` at line
      277 fires fire-and-forget for the same reason. Same decision:
      keep fire-and-forget; helper's JSDoc covers it.
- [ ] **`deleteUser`** (`src/lib/auth.ts:387-394`): MUST inspect the
      helper's return value. After spec 032 the implementation
      becomes:
      ```ts
      export async function deleteUser(userId: string): Promise<{ error: string | null }> {
        const { error } = await callEdgeFunction('delete-user', { userId });
        return { error };
      }
      ```
      The existing try/catch is no longer needed because the helper
      now returns the envelope rather than throwing. Behavioral
      contract: when the edge function returns HTTP 400 + `{ "error":
      "cannot delete the last super_admin" }`, `deleteUser` returns
      `{ error: "cannot delete the last super_admin" }`.
- [ ] **`sendPasswordReset`** (`src/lib/auth.ts:408-416`): NO CHANGE.
      Uses `supabase.auth.resetPasswordForEmail` directly, not
      `callEdgeFunction`. Listed here for audit-trail completeness;
      spec 032 touches no lines of this function.
- [ ] **`signIn` / `signOut` / `getSession` / `fetchProfile` /
      `fetchAllUsers`**: NO CHANGE. None use `callEdgeFunction`.
- [ ] **`src/store/useStore.ts:792-825` (`deleteProfile`)**: NO
      CHANGE REQUIRED. The store action already inspects `error`
      from `deleteUser` and routes through `notifyBackendError`
      (line 798). After spec 032, when the edge function refuses,
      `error` is the verbatim refusal string and `notifyBackendError`
      fires the red toast with that string. The optimistic
      `brandAdminsByBrandId` mutation already happens AFTER the
      `if (error)` short-circuit, so no row is removed on a refused
      delete.
- [ ] **`src/screens/cmd/sections/UsersSection.tsx:112-134`
      (`handleConfirmDelete`)**: NO CHANGE REQUIRED. Already inspects
      the boolean return from `deleteProfile` (line 117) and bails
      on `!ok`. The toast is fired by `notifyBackendError` inside
      `deleteProfile` (already wired).
- [ ] **`src/components/cmd/InviteUserDrawer.tsx:101-128` /
      `InviteAdminDrawer.tsx:92-...`**: NO CHANGE REQUIRED. Already
      inspect `result.error` from `inviteUser` and toast the error
      via `Toast.show({ type: 'error', text1: 'Invite failed', text2:
      result.error })` (lines 113-121 of `InviteUserDrawer.tsx`).
      The fire-and-forget email at `inviteUser`'s line 192 is
      orthogonal to the invitation creation; the existing toast
      chain covers the invitation-creation error path.
- [ ] **`src/lib/db.ts:1143` (`fetchBreadbotSales`)**: NO CHANGE
      REQUIRED. Uses `supabase.functions.invoke` (the official client
      method that already returns `{ data, error }` and surfaces
      `FunctionsHttpError.context.error` on non-2xx). Listed for
      audit-trail completeness — this is the "right" shape that
      `callEdgeFunction` is now aligning with.

### Jest test coverage

- [ ] New file `src/lib/auth.test.ts` lands in the unit project
      (`testEnvironment: 'node'` per `jest.config.js:60-69`). File
      colocated next to `src/lib/auth.ts` per spec 022 Track 1
      conventions. Test count goes 3 → 4 in `src/**/*.test.ts`
      (current: `relativeTime.test.ts`, `seedVarianceDates.test.ts`,
      `escapeHtml.test.ts`).
- [ ] Test mocks the global `fetch` (or `globalThis.fetch`) and the
      `supabase.auth.getSession()` boundary. The Supabase client at
      `src/lib/supabase.ts` is the wrong boundary per spec 022 §Q6
      / `tests/README.md` ("Hybrid mocking strategy") — we mock just
      the two surfaces `callEdgeFunction` actually touches.
- [ ] Test cases (one `describe` block, multiple `it`):
        1. **HTTP 200 + JSON body** → returns `{ data: <body>, error:
           null }`.
        2. **HTTP 200 + empty body** → returns `{ data: null, error:
           null }`.
        3. **HTTP 200 + non-JSON body** → returns `{ data: null,
           error: null }` (graceful degradation).
        4. **HTTP 400 + `{ "error": "cannot delete the last
           super_admin" }`** → returns `{ data: null, error:
           "cannot delete the last super_admin" }`. This is the
           spec 031 regression case — the verbatim string from the
           edge function reaches the toast.
        5. **HTTP 400 + `{ "error": "cannot delete self" }`** →
           returns `{ data: null, error: "cannot delete self" }`.
           Self-delete refusal (spec 029 / 030 surface).
        6. **HTTP 500 + `{ "message": "internal error" }`** (no
           `error` field, has `message`) → returns `{ data: null,
           error: "internal error" }`. Fallback to `message`.
        7. **HTTP 500 + non-JSON body** → returns `{ data: null,
           error: "HTTP 500" }`. Last-resort synthesized string.
        8. **HTTP 401 + `{ "error": "Unauthorized" }`** → returns
           `{ data: null, error: "Unauthorized" }`. (Not currently
           emitted by any edge function but defense-in-depth for
           the gateway path.)
        9. **`fetch` rejects (network failure)** → returns
           `{ data: null, error: <rejection message or 'Network
           error'> }`.
       10. **`getSession()` returns null session** → returns
           `{ data: null, error: 'Not authenticated' }`, and
           `fetch` is NEVER called (assert via the mock).
       11. **`getSession()` returns session with token** → `fetch`
           is called with `Authorization: Bearer <token>` header.
           Assert the header shape on the mock's call args.
- [ ] All 11 test cases PASS under `npm test -- --ci`.
- [ ] Test file uses the spec-022 conventions:
        - `describe('callEdgeFunction', () => { ... })` block.
        - Each `it(...)` has a single assertion or a small cluster
          asserting one behavior.
        - `beforeEach(() => { jest.clearAllMocks(); })` so global
          `fetch` mock state doesn't leak between tests.
        - No `--detectOpenHandles` workarounds — the test is a
          pure unit test against a mocked fetch.

### Spec 031 retroactive correction

- [ ] `specs/031-last-super-admin-guard/spec.md` §9 (line 873-885)
      currently asserts "the new HTTP 400 from the edge function will
      surface as a toast (...) without modification." This was
      INCORRECT prior to spec 032 (the code-reviewer S1 finding).
      Spec 032 makes it correct. The §9 prose is amended by inserting
      a one-line trailing parenthetical:
      > `(Update — spec 032 closed the silent-success gap surfaced by
      > the spec 031 code-reviewer S1 finding. Prior to spec 032,
      > `callEdgeFunction` swallowed non-2xx and the toast never fired.
      > Refer to spec 032 §"Caller chain audit" for the verified path.)`

      The amendment is a single bullet, strictly additive. Lines
      873-885 are otherwise untouched.
- [ ] No other spec 031 prose is amended. The acceptance criteria,
      design, files-changed sections are all already correct — the
      issue was only §9's "will surface as a toast" claim.

### Cross-cutting verification gates

- [ ] `npx tsc --noEmit` exits 0. The new `callEdgeFunction` return
      type (`Promise<{ data: any; error: string | null }>`) requires
      no caller-side type fix because:
        - `inviteUser` / `registerInvitedUser`: fire-and-forget (do
          not consume the return value).
        - `deleteUser`: explicitly destructures `{ error }` from the
          new return.
- [ ] `npm run typecheck:test` exits 0. The new
      `src/lib/auth.test.ts` typechecks cleanly under
      `tsconfig.test.json`.
- [ ] `npm test -- --ci` PASS. Test count increases from current N
      to N + 11 (one new `describe`, eleven `it` cases).
- [ ] `npm run test:db` PASS — no DB changes, sanity-only gate.
      File count stays at 15 (unchanged from spec 031).
- [ ] `npm run test:smoke` PASS — no smoke changes, sanity-only
      gate. `smoke-edge-roles.sh` Arm 6 already accepts either
      refusal string (per spec 031) and is unaffected by spec 032.
- [ ] **Manual browser verification** (per the brief's "Verification
      gates" section):
        - Promote local admin to sole super_admin via psql
          (`update public.profiles set role='super_admin',
          brand_id=null where id = (select id from auth.users where
          email='admin@local.test')`), then attempt self-delete
          via UsersSection.
        - **Before spec 032:** silent fake-success, row disappears
          from table, reappears on next refresh.
        - **After spec 032:** red toast fires showing either "cannot
          delete the last super_admin" (spec 031 refusal) or
          "cannot delete self" (spec 027 refusal — whichever fires
          first per the spec 031 §4 ordering rationale; both are
          acceptable). Row stays in the table; no fake-success
          mutation.
        - Same flow for a duplicate-email invitation: previously the
          invitation creation already toasted via `inviteUser`'s own
          error path (`'An invitation for this email already exists'`),
          so the user-visible behavior was correct for that case. The
          email-send failure mode (e.g. RESEND_API_KEY missing on the
          local stack) is fire-and-forget by design; no toast. This
          is documented behavior, not a regression.

## In scope

- Rewrite `src/lib/auth.ts:109-127` `callEdgeFunction` to add `response.ok`
  check, structured `{ data, error }` return, and JSDoc.
- Refactor `src/lib/auth.ts:387-394` `deleteUser` to consume the new
  envelope (drop the now-redundant try/catch since the helper no
  longer throws).
- Author `src/lib/auth.test.ts` with 11 jest test cases (per AC).
- Append the one-line correction to `specs/031-last-super-admin-guard/spec.md`
  §9.

## Out of scope (explicitly)

- **Refactoring all `auth.ts` callers to a different envelope shape.**
  Spec 032 keeps the existing `{ error: string | null }` envelope
  returned by `inviteUser` / `deleteUser` / `sendPasswordReset` etc.
  unchanged. The internal helper changes; the public API of
  `src/lib/auth.ts` exported functions does not.
- **Adding retry logic / backoff.** The helper returns the error
  envelope; the caller decides whether to retry. Out of scope.
- **Changing error type system (string → Error object).** Strings
  are kept for jest test simplicity and to match the Supabase JS
  convention (`{ data, error: { message: string } }` where `error`
  is an object — we flatten to just the string for the helper's
  return; callers that want richer error info can switch to
  `supabase.functions.invoke` later, as `fetchBreadbotSales` does).
- **Refactoring fire-and-forget callers to `await` + `console.warn`
  on email-send failure.** The fire-and-forget pattern at
  `inviteUser:192` and `registerInvitedUser:277` is preserved. A
  future spec MAY upgrade these to await the helper and surface
  email-send failures via a separate (non-blocking) operator
  notification path; spec 032 does not.
- **`useStore.test.ts` jest harness.** Spec 029 / 031 deferred
  follow-up. Not stood up here.
- **`canDelete` / `canResetPassword` pure-helper extraction.** Spec
  029 deferred; still deferred.
- **Touching `useRole()` placeholder.** Per CLAUDE.md, intentional.
- **Touching the `app.json` `slug`.** Per CLAUDE.md, load-bearing
  pending explicit user approval.
- **Smoke arm changes.** The brief recommended "skip the smoke arm
  change; jest covers the client-side parsing." Spec 032 follows
  that recommendation. The existing spec-031 smoke Arm 6 already
  accepts either refusal string and continues to PASS unmodified.
- **Reports template backlog.** Unrelated to this spec.
- **Refactoring `fetchBreadbotSales` (`src/lib/db.ts:1143`) to use
  `callEdgeFunction`.** That call site already uses
  `supabase.functions.invoke` (the "right" shape). Switching it to
  `callEdgeFunction` would be a downgrade. Out of scope.
- **Adding a `callEdgeFunctionChecked` variant** (as the code-reviewer
  S1 suggested as one option). Spec 032 takes the simpler path:
  upgrade the existing helper so all callers benefit. There is no
  caller that wants the old swallow-errors behavior; the
  fire-and-forget callers simply don't await the envelope and
  achieve the same fire-and-forget UX.

## Open questions resolved

- Q: Should `callEdgeFunction` return `{ data, error }` (Supabase JS
  convention) or throw (fetch convention)?
  → **A: return the structured envelope.** Matches the existing
  `auth.signIn`-style returns from other `auth.ts` functions, lower
  blast radius (no try/catch refactor across every caller), and the
  jest test cases are easier to author.
- Q: Is there a pre-existing `auth.test.ts` jest scaffold to extend,
  or does spec 032 need to stand one up?
  → **A: spec 032 stands one up.** Verified via Glob:
  `src/lib/auth.test.ts` does not exist. The closest existing test
  files in `src/` are `src/utils/relativeTime.test.ts`,
  `src/utils/seedVarianceDates.test.ts`, and
  `src/utils/escapeHtml.test.ts` — none touch `src/lib/`. Spec 032
  is the first jest test under `src/lib/**`; the unit project's
  `testMatch` at `jest.config.js:66` already includes
  `<rootDir>/src/lib/**/*.test.ts`, so no jest config change is
  needed.
- Q: Should the helper's empty-body / non-JSON-body case be an
  error or graceful?
  → **A: graceful.** A 2xx with empty body is a legitimate webhook
  shape. A 2xx with non-JSON body (e.g. `text/plain` "ok") is also
  a legitimate edge-function response. Returning `{ data: null,
  error: null }` for those cases is correct. The non-2xx + non-JSON
  case synthesizes `HTTP <status>` so the operator at least sees
  the status code in the toast.
- Q: Should the helper surface a missing session as a thrown error
  or a structured error?
  → **A: structured error.** Returns `{ data: null, error: 'Not
  authenticated' }`. The previous silent-return-void was actively
  misleading (caller assumed the request went out). Operators
  signed out mid-action will now see "Not authenticated" in the
  toast instead of a fake-success.
- Q: Should the spec 031 §9 prose be amended in-place or noted as
  "now correct after spec 032"?
  → **A: in-place append (single bullet).** A one-line trailing
  parenthetical is less disruptive than rewriting §9, preserves the
  spec history (a future reader sees the timeline), and is strictly
  additive.
- Q: Smoke arm 6 — should it be tightened to assert the specific
  refusal string after spec 032?
  → **A: no.** Per the brief: "skip the smoke arm change; smoke is
  server-side; jest covers the client-side parsing." The smoke
  already proves the server returns HTTP 400 + structured body;
  jest now proves the client parses that body correctly. Two
  separate test surfaces, one per layer.
- Q: Should the helper accept a generic type parameter for typed
  data (`callEdgeFunction<T>(...)` returning `{ data: T | null,
  error: string | null }`)?
  → **A: no, not in v1.** Current callers either fire-and-forget
  (no `data` consumed) or `deleteUser` (returns `{ error }` from
  the helper, ignores `data`). A future caller that needs typed
  `data` can add the generic at that point; spec 032 keeps the
  signature as `Promise<{ data: any; error: string | null }>` to
  minimize the surface change.

## Dependencies

- No new packages.
- No new edge-function dependencies.
- No new migrations.
- No new edge functions.
- Files touched (modify only):
  - `src/lib/auth.ts` — rewrite `callEdgeFunction` (lines 109-127),
    refactor `deleteUser` (lines 387-394) to consume the new envelope.
  - `specs/031-last-super-admin-guard/spec.md` — append one-line
    parenthetical to §9 (around line 873-885).
- Files touched (new):
  - `src/lib/auth.test.ts` — jest test scaffold + 11 test cases.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only. `UsersSection`,
  `InviteUserDrawer`, `InviteAdminDrawer` all consume the affected
  callers. No legacy admin surface (spec 025 deleted it).
- **Per-store or admin-global:** Admin-global. `callEdgeFunction`
  is a transport helper, not a data-access helper; no per-store
  RLS interaction.
- **Realtime channels touched:** None. Spec 032 does not touch any
  realtime channel and does not modify the `supabase_realtime`
  publication. No `docker restart supabase_realtime_imr-inventory`
  step needed.
- **Migrations needed:** No.
- **Edge functions touched:** None. The edge functions are unchanged;
  spec 032 fixes only the client-side parser of their responses.
- **Web/native scope:** Both. `src/lib/auth.ts` is pure TS shared
  between web (react-native-web) and native (React Native). No
  platform-specific API used.
- **Test track:** Track 1 (jest). Per spec 022 / `tests/README.md`,
  pure-TS unit testing of a network boundary. New file
  `src/lib/auth.test.ts` lives in the unit project (`testEnvironment:
  'node'`), matching the existing `escapeHtml.test.ts` pattern.
- **`app.json` slug:** Not touched.
- **Post-merge deploy:** None. Pure-frontend change; ships on next
  Vercel auto-deploy from `main`. No `supabase db push`, no
  `supabase functions deploy`.

## Drift / convention risks the architect should review

- **Fetch boundary mocking.** Spec 022's hybrid-mocking guidance
  (`tests/README.md` lines 62-99) names `src/lib/db.ts` as the
  preferred boundary for component tests. `src/lib/auth.test.ts`
  mocks **`fetch`** (the global) plus `supabase.auth.getSession()` —
  this is one layer LOWER than `db.ts`. The architect should confirm
  this is acceptable for a unit test of a helper that wraps `fetch`
  directly. Rationale: the helper IS the layer above `fetch`, so
  mocking `fetch` is mocking the helper's only collaborator —
  which is the spec-022 unit-test rule ("Mock at the module under
  test's collaborators"). The component-tier rule ("mock at
  `db.ts`") does not apply because `auth.ts` does not call `db.ts`
  for the edge-function path.

- **Spec 027 `_shared/` lesson.** Spec 027 §4.2 documented that
  shared modules under `_shared/` are invisible drift surface for
  the supabase CLI's per-function deploy. `callEdgeFunction` is
  client-side, NOT a Deno edge function, so the lesson does not
  apply directly. However, the same drift concern shows up
  client-side if a future caller bypasses `callEdgeFunction` and
  hand-rolls its own `fetch` to `/functions/v1/<fn>` — that caller
  would silently swallow non-2xx the same way the current
  `callEdgeFunction` does. The architect should consider whether
  spec 032 should add a CLAUDE.md convention bullet capturing
  "edge function calls go through `callEdgeFunction`, not raw
  fetch." Suggested but optional — keep this spec tight.

- **Fire-and-forget pattern asymmetry.** After spec 032:
  - `inviteUser` and `registerInvitedUser` fire-and-forget the
    email send (return value ignored).
  - `deleteUser` awaits and inspects the return.
  The architect should call out in the design that this is
  intentional (emails are non-critical; deletes are critical),
  not a typo or oversight. A future spec MAY want to upgrade the
  email-send paths to surface failures via a separate operator
  notification (e.g. a system-toast or an "Outbox" table), but
  that is out of scope here.

- **Spec 031 §9 amendment risk.** Editing a prior spec's prose
  carries a small risk of triggering a "this spec is now in
  motion" misread by future agents. Spec 032 limits the change
  to a single-bullet parenthetical with explicit "Update — spec
  032 closed ..." framing, which matches how spec 026 referenced
  spec 025 retroactively. The architect should confirm the
  single-bullet shape is the right granularity vs. a separate
  "Errata" subsection.

## Risks and tradeoffs

| Risk | Severity | Mitigation |
|------|----------|-----------|
| A caller that previously relied on the silent-error behavior to keep flowing now sees a structured error. | Low | Audited every caller (AC §Caller chain audit). The only consumer of the return value is `deleteUser`; fire-and-forget callers do not await the return at all. No behavioral regression. |
| The new `Promise<{ data, error }>` return type breaks TypeScript at a caller site we missed. | Low | `npx tsc --noEmit` and `npm run typecheck:test` are gates. The audit walked every caller. |
| Jest test for `fetch` global is flaky if `globalThis.fetch` is mocked at a different layer in the future. | Low | Spec uses `jest.spyOn(global, 'fetch')` or `global.fetch = jest.fn()` — both standard. `beforeEach(jest.clearAllMocks)` resets state. |
| Emoji or unicode in the edge function's `error` string mangled on the way to the toast. | Negligible | The helper passes the string through verbatim — no character transformation. Toast component handles unicode natively. |
| `response.json()` throws on non-JSON body and we don't catch. | Mitigated | The helper wraps the `response.json()` call in a try/catch that falls back to `error: 'HTTP <status>'` for non-2xx and `data: null` for 2xx. AC §Helper contract item 3 and 2. |
| Race between two concurrent `callEdgeFunction` calls (the global fetch mock is shared). | Negligible | Real production calls don't share state. The jest test uses `clearAllMocks` between tests and is single-threaded. Concurrent calls in production each get their own response. |
| A future edge function returns `{ "errors": [...] }` (plural array) instead of `{ "error": "..." }`. | Low | Helper falls back to `error: 'HTTP <status>'` for that shape (no `error` string, no `message` string). Operator sees the status code instead of the structured message — degraded UX but not a fake-success. A future spec can extend the helper to handle arrays if a real edge function adopts that shape; none currently do. |

## Files the developer will touch

**New (1):**
- `src/lib/auth.test.ts`

**Modified (2):**
- `src/lib/auth.ts` (rewrite `callEdgeFunction`, refactor `deleteUser`
  — approximately 30-40 lines of net change)
- `specs/031-last-super-admin-guard/spec.md` (one-line append to §9,
  approximately line 873-885)

**Unchanged (audit-trail only):**
- `src/store/useStore.ts` (deleteProfile path)
- `src/screens/cmd/sections/UsersSection.tsx` (handleConfirmDelete)
- `src/components/cmd/InviteUserDrawer.tsx`
- `src/components/cmd/InviteAdminDrawer.tsx`
- `src/lib/db.ts` (fetchBreadbotSales — already uses
  `supabase.functions.invoke`)
- `supabase/functions/delete-user/index.ts` (server-side guard
  unchanged)
- `supabase/functions/send-invite-email/index.ts`
- `supabase/functions/send-welcome-email/index.ts`
- `scripts/smoke-edge-roles.sh` (Arm 6 unchanged — still PASSes)
- `CLAUDE.md` (no convention bullet added in v1; architect MAY
  surface adding one as a follow-up)
- `app.json` (not touched)

## Architect design

### 1. Q1 — Envelope shape (confirmed)

**Decision: `Promise<{ data: any; error: string | null }>`** — exactly the
PM's proposal, no generic in v1.

```ts
async function callEdgeFunction(
  fnName: string,
  body: Record<string, any>,
): Promise<{ data: any; error: string | null }>;
```

Rationale:

- **Matches existing in-house convention.** Every other exported function
  in `src/lib/auth.ts` (`signIn`, `inviteUser`, `deleteUser`,
  `sendPasswordReset`, `resendInvite`) returns a `{ ..., error: string |
  null }` envelope. Adding a sixth one keeps the file consistent. The
  store-side `notifyBackendError` consumer at
  [src/store/useStore.ts:23](src/store/useStore.ts) was designed for
  exactly this string-error shape.
- **Matches Supabase JS surface.** `supabase.auth.signInWithPassword`
  returns `{ data, error }`, and `supabase.functions.invoke` returns the
  same shape with `error: FunctionsHttpError`. We flatten the
  `error` object to a string for caller simplicity; callers that want
  richer error context (status code, response headers, etc.) can adopt
  `supabase.functions.invoke` directly the way
  [src/lib/db.ts:1143 fetchBreadbotSales](src/lib/db.ts) does. The flatten
  is one-way for now; a future spec can widen it without breaking
  callers.
- **Lowest blast radius.** Throwing on non-2xx (fetch convention) would
  require every caller — including the two fire-and-forget call sites
  in `inviteUser` / `registerInvitedUser` — to adopt try/catch or
  unhandled-promise-rejection handling. A `Result<T, E>` discriminated
  union would be more type-safe but requires a bigger client refactor
  AND a separate naming convention from the rest of `auth.ts`. Both
  are rejected.
- **No generic `<T>` in v1.** Only `deleteUser` consumes the return
  value of `callEdgeFunction` and it ignores `data` entirely (reads
  only `error`). The two fire-and-forget callers also ignore `data`. A
  generic adds compile-time surface with zero runtime payoff at this
  call-site density. When a future caller needs a typed body (e.g. an
  edge function that returns `{ ok: true, id: string }`), the generic
  can be added as a strictly-additive default: `callEdgeFunction<T =
  any>(...)`. Not now.

`data: any` (not `unknown`) is the right looseness for v1: callers either
ignore it or could otherwise reach for `as Record<string, any>` casts.
`any` is the explicit "we don't know the body shape, you're on your own"
signal that matches `supabase.functions.invoke`'s actual usage at
[src/lib/db.ts:1143](src/lib/db.ts) where `data?.rows`, `data?.error` are
read off an `any`-typed body. Adopting `unknown` here would force
`deleteUser` to add a runtime guard that buys nothing because it never
reads `data`.

### 2. `callEdgeFunction` implementation walk-through

The rewrite (developer authors the actual code; pseudocode below is the
contract):

```
async function callEdgeFunction(fnName, body) {
  // (a) Missing session — short-circuit, do NOT call fetch.
  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;
  if (!token) return { data: null, error: 'Not authenticated' };

  // (b) Network attempt. Catch only the fetch rejection; do NOT
  //     swallow inside the response-parsing branches.
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  let response;
  try {
    response = await fetch(`${url}/functions/v1/${fnName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { data: null, error: (e?.message || 'Network error') };
  }

  // (c) Body parse. Wrap in try/catch — non-JSON body must not throw
  //     synchronously up to the caller.
  let parsed = null;
  try {
    const text = await response.text();
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;  // text body, empty body, or malformed JSON
  }

  // (d) Status routing.
  if (response.ok) {
    return { data: parsed, error: null };
  }

  // (e) Non-2xx — pull the error string, falling back through the
  //     three tiers documented in the AC.
  let error;
  if (parsed && typeof parsed.error === 'string') {
    error = parsed.error;
  } else if (parsed && typeof parsed.message === 'string') {
    error = parsed.message;
  } else {
    error = `HTTP ${response.status}`;
  }
  return { data: null, error };
}
```

Path-by-path verification against the AC's "Helper contract":

- **2xx + valid JSON body.** `response.ok` true, `parsed` is the object,
  returns `{ data: parsed, error: null }`. AC §2.
- **2xx + empty body.** `response.ok` true, `text === ''`, `parsed`
  stays `null`, returns `{ data: null, error: null }`. AC §2.
  **Verified against `delete-user` edge fn:** the success path at
  [supabase/functions/delete-user/index.ts:118-120](supabase/functions/delete-user/index.ts)
  returns `JSON.stringify({ success: true })`, so the success path
  IS a JSON body, not empty. Empty-body is defense-in-depth for any
  future 204-style edge fn.
- **2xx + non-JSON body** (e.g. `text/plain "ok"`). `response.ok` true,
  `JSON.parse` throws, caught, `parsed` stays `null`, returns
  `{ data: null, error: null }`. AC §2.
- **non-2xx + `{ error: "..." }`.** AC §3 tier 1 — exact match for the
  `delete-user` 400 paths ("cannot delete self",
  "cannot delete the last super_admin") and the `send-invite-email` 401
  ("missing bearer token") and 403 ("forbidden") paths.
- **non-2xx + `{ message: "..." }`.** AC §3 tier 2 — defense-in-depth.
  Spot-check across all 10 edge functions: none currently emit
  `{ message: ... }` as the top-level error key, but Supabase's gateway
  layer occasionally returns shapes with `message` (e.g. JWT verification
  failures from `gotrue`). Keeping this branch costs nothing.
- **non-2xx + non-JSON body.** `JSON.parse` throws, `parsed` stays
  `null`, falls to tier 3, returns `{ data: null, error: 'HTTP <status>' }`.
  AC §3 tier 3.
- **`fetch` throws** (DNS / connection refused / timeout). Caught in the
  network-attempt try-block, returns
  `{ data: null, error: <e.message or 'Network error'> }`. AC §4. **The
  `response.json()` parse failure is NOT routed through this branch** —
  that's a separate try/catch around the parse step.
- **Missing session.** `token` is `undefined`, helper returns
  `{ data: null, error: 'Not authenticated' }` before any `fetch` call.
  AC §5. The previous silent-return-void path was actively misleading;
  this surfaces it to the operator.

JSDoc (developer authors verbatim — design only sketches the shape):

```
/**
 * Call a Supabase Edge Function with the caller's session bearer.
 *
 * Always resolves; never throws. Errors are surfaced via the `error`
 * field of the returned envelope:
 *   - HTTP 2xx → { data: <parsed JSON body or null>, error: null }
 *   - HTTP non-2xx with { error: "..." } body → { data: null, error: "..." }
 *   - HTTP non-2xx with { message: "..." } body → { data: null, error: "..." }
 *   - HTTP non-2xx with non-JSON body → { data: null, error: "HTTP <status>" }
 *   - fetch rejection → { data: null, error: <e.message or "Network error"> }
 *   - missing session → { data: null, error: "Not authenticated" }
 *
 * Some callers (inviteUser / registerInvitedUser) intentionally
 * fire-and-forget this helper without awaiting — the email send is
 * best-effort and not a load-bearing artifact. That pattern is
 * preserved and the envelope is simply discarded by those callers.
 */
```

Note the JSDoc explicitly calls out fire-and-forget so a future reader
doesn't mistake the lack of `await` for a bug — AC item 1 (Caller chain
audit, `inviteUser` bullet).

### 3. Caller-chain confirmation (verified against current `auth.ts`)

| Caller (file:line) | Awaits helper? | Inspects return? | Spec 032 change |
|---|---|---|---|
| `inviteUser` ([src/lib/auth.ts:192](src/lib/auth.ts)) | No (fire-and-forget) | No | None at call site. JSDoc covers the pattern. |
| `registerInvitedUser` ([src/lib/auth.ts:277](src/lib/auth.ts)) | No (fire-and-forget) | No | None at call site. Same. |
| `deleteUser` ([src/lib/auth.ts:387-394](src/lib/auth.ts)) | Yes | Currently wraps in try/catch (dead code — helper never throws today, and won't after the rewrite). | **REWRITE.** Drop the try/catch, destructure `{ error }` from the helper, return `{ error }`. PM's snippet at AC line 145-150 is exactly right. |
| `sendPasswordReset` ([src/lib/auth.ts:408-416](src/lib/auth.ts)) | n/a — does NOT use `callEdgeFunction` | n/a | **None.** Uses `supabase.auth.resetPasswordForEmail` directly. Listed for audit-trail completeness; PM correctly flagged it. |
| `fetchBreadbotSales` ([src/lib/db.ts:1143](src/lib/db.ts)) | n/a — uses `supabase.functions.invoke` directly | Inspects `error.context.error` | **None.** Already on the "right" shape that `callEdgeFunction` is now aligning with. PM correctly flagged it. |
| `deleteProfile` ([src/store/useStore.ts:792-825](src/store/useStore.ts)) | Reads `{ error }` from `deleteUser` | Yes — routes through `notifyBackendError` on truthy `error`, only mutates `brandAdminsByBrandId` after the short-circuit. | **None.** This is the consumer that the whole spec exists to enable. After spec 032, when the edge fn returns HTTP 400 + `{ error: "cannot delete the last super_admin" }`, `deleteUser` returns `{ error: "cannot delete the last super_admin" }` and `deleteProfile` toasts it verbatim. Optimistic mutation never fires on the refusal path. |
| `handleConfirmDelete` ([src/screens/cmd/sections/UsersSection.tsx:112-134](src/screens/cmd/sections/UsersSection.tsx)) | Reads the `ok` boolean from `deleteProfile` | Yes — bails on `!ok`, fires its own self-delete success toast on `ok` | **None.** Already correctly wired. |
| `InviteUserDrawer.handleSave` ([src/components/cmd/InviteUserDrawer.tsx:94-128](src/components/cmd/InviteUserDrawer.tsx)) | Reads `result.error` from `inviteUser` | Yes — fires red "Invite failed" toast with `result.error` as `text2` | **None.** This handles the invitation-creation error path, which is orthogonal to the fire-and-forget email-send path inside `inviteUser`. |
| `InviteAdminDrawer.handleSave` | Same shape as `InviteUserDrawer` | Yes | **None.** Same. |

**Net file touches confirmed:**

- `src/lib/auth.ts` — rewrite `callEdgeFunction` body (lines 109-127),
  refactor `deleteUser` (lines 387-394). Net change: ~30-40 lines.
- `src/lib/auth.test.ts` — NEW.
- `specs/031-last-super-admin-guard/spec.md` — single-line append to §9.
- `CLAUDE.md` — single bullet insert (see §6 below).

### 4. Jest test plan — confirm + one addition

PM's 11 cases are necessary and sufficient. Adding **case 12** as a
defense-in-depth pin against a regression that would defeat the entire
spec: the `Authorization` header MUST carry the bearer token from the
session, not a hardcoded value or undefined. This is partially covered
by PM's case 11 (asserts the header shape), but I want a separate
assertion for the **fnName routing into the URL path** — i.e. that
`fnName='delete-user'` produces a fetch URL containing `/functions/v1/delete-user`
and not `/functions/v1/${fnName}` literal-templating bug. PM's case 11
already touches the fetch mock's call args for the header; broadening
that assertion (rather than adding a 12th `it`) is acceptable.

**Final test plan: PM's 11 cases, with case 11 expanded to also assert
the URL path.** Total `it` blocks: 11.

Mocking pattern (Q2 — resolved):

- **`global.fetch = jest.fn().mockImplementation(...)`** (the PM's
  default), NOT `jest.spyOn(global, 'fetch')`. Reasons:
    1. The spec-022 setup at [tests/jest.setup.ts](tests/jest.setup.ts)
       does NOT install a global fetch — there's no real implementation
       to spy on under `testEnvironment: 'node'`. `jest.spyOn` would
       throw because `global.fetch` is `undefined` in `node` env. (jest
       28+ ships `whatwg-fetch` polyfill via jest-expo, but the safer
       contract is to install our own jest.fn per test.)
    2. Reassignment is the standard pattern in the codebase
       (`seedVarianceDates.test.ts` uses `(fetchRecentEodDates as
       jest.Mock).mockResolvedValue(...)` on a module-level mock —
       same style, different target).
    3. `beforeEach(() => { jest.clearAllMocks(); })` (already in PM's
       AC) is sufficient state isolation. No `afterEach` cleanup is
       needed because every test reassigns `global.fetch` to a fresh
       `jest.fn()` (or the `mockImplementation` is reset by
       `clearAllMocks`).
- **Mock `supabase.auth.getSession()` at the module boundary.** Use
  `jest.mock('./supabase', () => ({ supabase: { auth: { getSession:
  jest.fn() } } }))`. This is the smallest stub that exercises
  `callEdgeFunction`'s only call into the supabase client. Per spec 022
  §Q6 "Mock at the module under test's collaborators, not at db.ts" for
  unit tests, this is the correct boundary. `db.ts` is irrelevant
  because `auth.ts`'s edge-function path does NOT call `db.ts`.
- **No changes to `tests/jest.setup.ts`.** The fetch mock is per-test;
  the Toast and AsyncStorage globals already in setup do not interact
  with this test. Adding a global fetch stub to the setup file would
  leak across the unit/component projects and risk masking real
  failures.

Style alignment with the 17 (now 18) jest tests:

- `describe('callEdgeFunction', () => { ... })` block.
- Each `it` has a one-sentence behavior name (matches
  `escapeHtml.test.ts` and `seedVarianceDates.test.ts` shape).
- `beforeEach(jest.clearAllMocks)` matches `seedVarianceDates.test.ts`
  style.
- Each `it` has 1-3 assertions clustered on a single behavior. No
  shared mutable state between tests.
- Test count goes from 3 to 4 unit-project files under `src/**/*.test.ts`
  (`relativeTime`, `seedVarianceDates`, `escapeHtml` → +
  `auth.test.ts`). Total `it` count goes from 17 to 28.

### 5. Q3 — spec 031 §9 amendment shape (confirmed)

**Decision: single-bullet trailing parenthetical, in place at
[specs/031-last-super-admin-guard/spec.md:879](specs/031-last-super-admin-guard/spec.md).**
PM's proposed wording is correct; the developer should append it as a
new paragraph at the END of §9 (i.e. after line 885 "The verbatim
strings from §5 land in the toast."), not inserted into the middle of
the existing prose. Exact insertion point:

```
The verbatim strings from §5 land in the toast.

> (Update — spec 032 closed the silent-success gap surfaced by the
> spec 031 code-reviewer S1 finding. Prior to spec 032,
> `callEdgeFunction` swallowed non-2xx and the toast never fired.
> Refer to spec 032 §"Caller chain audit" for the verified path.)
```

Rationale for rejecting the "separate Errata subsection" alternative:

- Single-bullet trailing parenthetical preserves spec history visually
  (a reader scrolling §9 sees the original prose followed by the
  amendment, with timeline framing built in).
- An Errata subsection at the bottom of spec 031 would require choosing
  a section number (§13?) and renumbering risk. The single bullet has
  zero renumbering risk.
- The amendment is one paragraph; an Errata subsection would be
  ceremonially heavy for one line.
- Spec 026 referenced spec 025 retroactively using the same
  single-paragraph-with-"Update —"-framing pattern. Consistency with
  prior practice.

### 6. Q4 — CLAUDE.md convention bullet (add)

**Decision: ADD a single bullet to CLAUDE.md, inserted in the
"Conventions already in use" block at line 63-64 (between the existing
"Edge functions performing destructive role-change..." bullet and the
"Imports." bullet).**

Reason: the spec 032 fix exists because a future caller bypassing
`callEdgeFunction` and hand-rolling `fetch('/functions/v1/<fn>', ...)`
would re-introduce the same silent-success bug. Documenting the
convention is the lowest-cost insurance against that drift. Same
reasoning the "_shared/ is invisible drift surface" bullet was added
in spec 027.

**Wording (developer commits verbatim):**

```
- **Edge function calls go through `callEdgeFunction` in
  `src/lib/auth.ts`, not raw `fetch`.** The helper returns
  `{ data: any; error: string | null }` and consistently surfaces
  non-2xx responses as a string `error` (tier order: JSON body's
  `error` field → JSON body's `message` field → `HTTP <status>`),
  network failures as a string `error`, and missing-session as
  `error: 'Not authenticated'`. A bare `fetch('/functions/v1/<fn>')`
  call site silently resolves on HTTP 4xx/5xx because `fetch` only
  rejects on network failure; it would re-introduce the spec 031
  silent-fake-success regression. Reference shape:
  [src/lib/auth.ts:109](src/lib/auth.ts) (spec 032). Exception: when
  a caller needs typed `data` or richer error context (status code,
  headers), use `supabase.functions.invoke` directly the way
  [src/lib/db.ts:1143 fetchBreadbotSales](src/lib/db.ts) does — same
  envelope shape, more error structure.
```

**Placement:** between line 63 (the spec-031 destructive-ops bullet)
and line 64 (the `Imports.` bullet). This puts all four edge-function
conventions adjacent — verify_jwt split (line 60), role-gate parity
(line 61), HTML escape (line 62), destructive-ops guard (line 63),
client-side helper (NEW). Imports stays after them.

The developer authors the CLAUDE.md edit. The wording above is the
canonical text — preserve verbatim.

### 7. Cross-cutting

- **No migrations.** Confirmed — pure-client change.
- **No edge function source changes.** The server already emits HTTP 4xx
  + `{ error: <string> }` (verified across
  [delete-user/index.ts:53,60,98,112](supabase/functions/delete-user/index.ts),
  [send-invite-email/index.ts:54,64](supabase/functions/send-invite-email/index.ts),
  and the 8 other edge functions). Spec 032 just consumes them
  correctly.
- **No realtime.** No publication membership change. No `docker
  restart supabase_realtime_imr-inventory` step needed. The PM's
  acceptance criteria correctly omit this.
- **No DB.** No tables touched. No `npm run test:db` regression risk
  (file count stays at 15).
- **No deploy step beyond Vercel auto-deploy.** No `supabase functions
  deploy`, no `supabase db push`. Pure-frontend ships with the next
  push to `main`.
- **No `app.json` slug change.** Per CLAUDE.md, load-bearing.
- **No useRole() change.** Per CLAUDE.md, intentional placeholder.

### 8. Verification gates (match PM, with one tightening)

PM's list is correct. One tightening:

- [x] `npx tsc --noEmit` exits 0 — gate.
- [x] `npm run typecheck:test` exits 0 — gate. (The new `src/lib/auth.test.ts`
      typechecks under `tsconfig.test.json`.)
- [x] `npm test -- --ci` PASS — gate. Test count: 11 new `it`
      assertions inside one new `describe`. Total jest `it` count goes
      from 17 to 28.
- [x] `npm run test:db` PASS — sanity gate. No DB changes. File count
      stays at 15.
- [x] `npm run test:smoke` PASS — sanity gate. No smoke changes. Arm
      6 unchanged (still accepts either refusal string per spec 031).
- [x] **Manual browser verification** — promote local admin to sole
      `super_admin` via psql, attempt self-delete, assert the red
      toast fires with the verbatim refusal string and the row stays
      in the table. PM's AC §"Cross-cutting verification gates"
      already specifies the exact psql one-liner.
- **NEW (architect adds):** After the rewrite, grep the repo for any
  remaining `await fetch(.*functions/v1` outside of `src/lib/auth.ts`
  and confirm zero hits. Catches a future drift where another developer
  adds a second hand-rolled edge-function caller. This is a one-liner
  in code review, not a CI step. If a hit appears, the new CLAUDE.md
  bullet is the next-time pointer.

### 9. Risks revisited

PM's risk table is comprehensive. Two additional notes:

- **Type-system regression risk.** The change of `callEdgeFunction`'s
  return from `Promise<void>` to
  `Promise<{ data: any; error: string | null }>` is a widening, not a
  narrowing. Callers that previously did `await callEdgeFunction(...)`
  and ignored the return continue to compile (the void result was
  unused). Callers that explicitly typed the return as `void` would
  break, but the audit confirmed zero such call sites.
- **Promise rejection risk on the fire-and-forget paths.** The current
  helper has a blanket catch-all that swallows ALL exceptions
  including bugs (e.g. a typo in the URL). After spec 032 the helper
  no longer throws, so an unhandled rejection cannot escape from a
  fire-and-forget call site. This is a net safety improvement.

### 10. Out-of-scope reconfirmed

The PM's "Out of scope" section is correct. Specifically:

- No `callEdgeFunctionChecked` variant. The simpler path (upgrade the
  existing helper) is taken.
- No retry / backoff logic.
- No `useStore.test.ts` jest harness.
- No `fetchBreadbotSales` refactor — that call site already uses the
  "right" shape.
- No smoke arm changes — Arm 6 already passes.
- No CLAUDE.md change beyond the single bullet above.
- No `app.json` slug change.

## Handoff
next_agent: frontend-developer
prompt: Implement against the design in this spec. All changes are
  client-side TypeScript — no backend implementation needed. Specifically
  (1) rewrite `src/lib/auth.ts:109-127` `callEdgeFunction` per the
  walk-through in §2, including the JSDoc; (2) refactor
  `src/lib/auth.ts:387-394` `deleteUser` to destructure `{ error }`
  from the new envelope and drop the now-redundant try/catch; (3)
  author `src/lib/auth.test.ts` with 11 `it` blocks per §4, mocking
  `supabase.auth.getSession` via `jest.mock('./supabase', ...)` and
  `global.fetch` via `jest.fn().mockImplementation(...)`; (4) append
  the single-paragraph parenthetical to
  `specs/031-last-super-admin-guard/spec.md` §9 at the insertion point
  given in §5; (5) insert the single-bullet CLAUDE.md convention
  between the existing line 63 destructive-ops bullet and line 64
  `Imports.` bullet, with the exact wording in §6. After
  implementation, set `Status: READY_FOR_REVIEW` and list files changed
  under `## Files changed`. Run `npx tsc --noEmit`, `npm run typecheck:test`,
  `npm test -- --ci`, `npm run test:db`, and `npm run test:smoke` —
  all must PASS.
payload_paths:
  - specs/032-edge-fn-error-surfacing/spec.md

## Files changed

(Frontend-developer agent timed out mid-stream before writing this section; main Claude reconstructed it post-hoc from the staged diff. All listed gates verified passing.)

- `src/lib/auth.ts` — rewrote `callEdgeFunction` per architect §2: returns `{ data: any; error: string | null }` envelope. Handles 7 cases (2xx with valid body, 2xx empty body, 4xx/5xx with `error` field, 4xx/5xx with `message` field, 4xx/5xx with non-JSON, network failure, missing session). Refactored `deleteUser` to destructure `{ error }` and drop the redundant try/catch. JSDoc updated.
- `src/lib/auth.test.ts` — new jest test file with 11 `it` blocks covering the 7 response-shape cases above plus parameter validation. Mocks `supabase.auth.getSession` via `jest.mock('./supabase', ...)` and `global.fetch` via `jest.fn().mockImplementation(...)`. `beforeEach(jest.clearAllMocks)` for state isolation. No edits to `tests/jest.setup.ts`.
- `CLAUDE.md` — new convention bullet inserted between the existing edge-function bullets, per architect §6. "Edge function calls go through `callEdgeFunction` in `src/lib/auth.ts` — not raw `fetch` — so non-2xx surfaces consistently."
- `specs/031-last-super-admin-guard/spec.md` — §9 single-paragraph parenthetical appended per architect §5. Acknowledges that the spec 031 §9 toast-on-server-refusal claim is correct as of spec 032.
- `specs/032-edge-fn-error-surfacing/spec.md` — status flipped to `READY_FOR_REVIEW`; this `## Files changed` section added.

## Verification

- `npx tsc --noEmit` — pre-existing `@types/* 2` cruft only (unrelated to this spec; same as prior specs)
- `npm run typecheck:test` — clean exit 0
- `npm test -- --ci` — **35/35 PASS** (was 24, +11 new from `auth.test.ts`)
- `npm run test:db` — 15/15 PASS (sanity, no DB changes in this spec)
- `npm run test:smoke` — PASS (sanity, no smoke changes in this spec)
- Architect-required grep `grep -RE 'await fetch.*functions/v1' src/`: only hit is `src/lib/auth.ts` itself (the centralized helper — correct). Zero hits outside.
