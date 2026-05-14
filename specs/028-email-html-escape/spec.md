# Spec 028: HTML-escape email interpolations in send-invite-email + send-welcome-email

Status: READY_FOR_REVIEW

## Background

Spec 025's security-auditor review flagged an unescaped-HTML interpolation
in two edge functions; spec 026's release proposal repeated the finding as
fast-follow item #4 (`specs/026-post-025-cleanup/reviews/release-proposal.md:33`
in spirit, citing the spec 025 audit). The exact citation is
`specs/025-delete-legacy-app/reviews/security-auditor.md:19` (M-finding on
`send-invite-email/index.ts:70` — note: line 70 in the audit was the
pre-edit reference; the current source has the same code at line 74) and
`:19` extended call-out to `send-welcome-email/index.ts:71`.

Severity per security-auditor: **Medium**. Pre-existing in the edge
functions; not introduced by spec 025. The reason the M-finding was
deferred rather than fixed in 025 is that the invitation flow was a niche
legacy entry point until 025 promoted `UsersSection` into the canonical
Cmd UI sidebar, foregrounding it as a routine admin action.

### What the auditor described

> [`src/lib/auth.ts:177-186`] `inviteUser` writes `opts.email`, `opts.name`,
> `opts.storeIds`, `opts.brandId` straight to the `invitations` table;
> `send-invite-email` then interpolates them into an HTML email body
> without escaping (`supabase/functions/send-invite-email/index.ts:70`).
> A malicious admin (or one whose session was stolen) could craft `name =
> '<script>...</script>'` and the email content would render that markup
> in any web-mail client that doesn't strip script tags. The role/store-IDs
> fields aren't surfaced into HTML, but `name` and `email` are, and
> `storeNames` is built client-side and is also interpolated directly.
> [...] recommend HTML-escaping interpolations inside
> `send-invite-email/index.ts:70`. Same vector applies to
> `send-welcome-email/index.ts:71`.

### PM audit pass — every unescaped interpolation, file by file

The PM walked both files end-to-end. The full audit of caller-controllable
interpolations:

**`supabase/functions/send-invite-email/index.ts`** (template literal at
line 74; `subject` literal at line 73 is static):

| File:line                                            | Variable     | Field                | Source                                         |
|------------------------------------------------------|--------------|----------------------|------------------------------------------------|
| `send-invite-email/index.ts:74` (in `Welcome, ${name}!`)             | `name`       | html body            | request body (caller-controlled via inviteUser opts.name)       |
| `send-invite-email/index.ts:74` (in `as a <strong>${role}</strong>`) | `role`       | html body            | request body (admin/master/super_admin/user — but still caller-controlled string field) |
| `send-invite-email/index.ts:74` (in `access to <strong>${storeNames}</strong>`) | `storeNames` | html body            | request body (built client-side by InviteUserDrawer; comma-joined stores.name) |
| `send-invite-email/index.ts:74` (in `<a href="${registerUrl}">`)    | `registerUrl`| html body (href attr)| const built from `APP_URL` (not caller-controlled today, but template-side concatenation still benefits from attribute-safe quoting if APP_URL is ever made dynamic) |
| `send-invite-email/index.ts:74` (in `<strong>${expiresText}</strong>`)| `expiresText`| html body            | local const string (`"48 hours"`) — not caller-controlled today |
| `send-invite-email/index.ts:72` (in `to: [email]`)   | `email`      | recipient address    | request body — Resend handles RFC-5322 escaping at the address level; not HTML. Not in scope of this spec. |
| `send-invite-email/index.ts:73`                       | (subject)    | subject              | static literal; no interpolation |
| `send-invite-email/index.ts:95` (in `error: (e as Error).message`)| `e.message`  | response body (JSON) | exception message — JSON serialization is the appropriate escape boundary here; no HTML rendering. Not in scope. |

**Total caller-controlled HTML interpolations in `send-invite-email`: three
(`name`, `role`, `storeNames`). One template-local string (`registerUrl`,
`expiresText`) is constructed from a hardcoded constant today but is in the
same template and benefits from being treated consistently.**

**`supabase/functions/send-welcome-email/index.ts`** (template literal at
line 71; `subject` literal at line 70 is static):

| File:line                                          | Variable | Field    | Source                              |
|----------------------------------------------------|----------|----------|-------------------------------------|
| `send-welcome-email/index.ts:71` (in `You're all set, ${name}!`)      | `name`   | html body | request body (caller-controlled via registerInvitedUser → callEdgeFunction('send-welcome-email', { email, name: invitation.name })) |
| `send-welcome-email/index.ts:71` (in `<a href="${APP_URL}">`)         | `APP_URL`| html body (href attr) | module-level const `"https://hopeful-lewin.vercel.app"` — not caller-controlled today |
| `send-welcome-email/index.ts:69` (in `to: [email]`) | `email`  | recipient address | request body — Resend handles RFC-5322 at address level. Not in scope. |
| `send-welcome-email/index.ts:70`                    | (subject)| subject  | static literal; no interpolation |
| `send-welcome-email/index.ts:84` (in `error: (e as Error).message`) | `e.message`| response body (JSON) | exception message — JSON serialization is the appropriate boundary. Not in scope. |

**Total caller-controlled HTML interpolations in `send-welcome-email`: one
(`name`).**

Across both files: **four caller-controlled interpolations** that must be
HTML-escaped (`name` × 2, `role` × 1, `storeNames` × 1). Two
template-local strings (`registerUrl`, `expiresText`, and `APP_URL` in the
welcome template) are constructed from hardcoded constants today; per the
defense-in-depth rationale below they go through the same escape function
so the template is internally consistent and resistant to future drift
(e.g., if `APP_URL` is ever read from `Deno.env.get()` or query param).

### Why now (vs why it was deferred in 025)

- Spec 025 promoted `UsersSection` to the canonical sidebar, making the
  invite flow a routine admin action rather than a niche legacy path.
- Spec 026 released as `SHIP_READY` with this item in the fast-follow list
  (release proposal item #4).
- Spec 027 closed the sibling parity bug (`send-invite-email` `ADMIN_ROLES`
  missing `super_admin`). The function will be re-deployed for spec 027
  anyway; landing this fix in the same deploy window minimizes operational
  toil (one `supabase functions deploy send-invite-email` instead of two).

## User story

As an admin who invites a new user via the Cmd UI Users section, I want
the recipient's email body to render safely with my plain-text name —
even if a different admin (or someone who compromised their session)
sets a payload like `name = '<script>...</script>'` or
`storeNames = '<img src=x onerror=...>'`, so that the email cannot be
weaponized as an HTML injection / XSS surface into a colleague's
mailbox.

As a future maintainer authoring a new edge-function email template, I
want a single documented convention (one tiny inline `escapeHtml`
function per file) so the convention is visibly enforced at code-review
time and a future tenth omission is caught.

## Acceptance criteria

### Track A — Fix `send-invite-email/index.ts`

- [ ] **A1.** A small `escapeHtml(value: string): string` helper is
      defined inline at module scope in
      `supabase/functions/send-invite-email/index.ts`. It MUST escape
      at minimum the five canonical HTML-significant characters:
      `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`,
      `'` → `&#39;`. The function MUST handle `null` / `undefined` /
      non-string inputs by coercing to an empty string before
      escaping (so a missing field can never throw inside the
      template). UTF-8 multi-byte sequences (emoji, accented
      characters, CJK) MUST pass through unchanged — only the five
      named characters are transformed.

- [ ] **A2.** All four caller-controlled HTML interpolations in the
      template literal at the file's `html:` field are wrapped:
      `${escapeHtml(name)}`, `${escapeHtml(role)}`,
      `${escapeHtml(storeNames)}`, and the conditional
      `${storeNames ? ` with access to <strong>${escapeHtml(storeNames)}</strong>` : ""}`.
      The two template-local strings (`registerUrl`, `expiresText`)
      are ALSO wrapped — defense-in-depth, so the template is
      internally consistent and resistant to drift if those locals
      ever start being constructed from caller input. **The Resend
      recipient address (`to: [email]`) is NOT wrapped** — it's a
      separate RFC-5322 address field, not HTML. **The plain-text
      `subject` field is NOT wrapped** — it's a static string literal
      with no interpolation today.

- [ ] **A3.** No other change to the file. The
      `requireAdminCaller` function body (with its spec 027
      `ADMIN_ROLES` Set), the validation gate, the Resend fallback,
      and the `auth.admin.inviteUserByEmail()` fallback are all
      preserved byte-for-byte. The CORS headers, the error JSON
      shape, and the HTTP status codes are unchanged.

- [ ] **A4.** A 2-3 line comment above `escapeHtml` documents (a) the
      threat being mitigated (caller-controlled HTML interpolation
      into the email body), (b) the spec number, and (c) a note that
      this is intentionally inlined rather than shared via
      `supabase/functions/_shared/` (cross-reference spec 027 §4.2
      design rationale: "inline duplication makes drift visible at
      code-review time; a shared module makes drift invisible
      because we have no convention for redeploying every importer
      on change").

### Track B — Fix `send-welcome-email/index.ts`

- [ ] **B1.** The identical `escapeHtml(value: string): string` helper
      is defined inline at module scope, with the identical 5-char
      escape semantics and null/non-string coercion. The function
      body MUST be byte-identical between the two files (this is
      the deliberate-duplication trade described in A4 — the
      developer copy-pastes between the two files, the reviewer
      verifies they match byte-for-byte). Same 2-3 line comment
      above it cites the spec.

- [ ] **B2.** The one caller-controlled HTML interpolation in the
      template literal is wrapped: `${escapeHtml(name)}`. The
      template-local `${APP_URL}` in the href attribute is also
      wrapped for the same defense-in-depth reason as A2's
      `registerUrl`. The `to: [email]` recipient and the static
      `subject` are NOT wrapped (same rationale as A2).

- [ ] **B3.** No other change to the file. `verifyFreshRegistration`
      (the function's auth gate — distinct from `send-invite-email`'s
      `requireAdminCaller` because the welcome email is sent BY the
      newly-registered user with their own JWT), the validation
      gate, the Resend integration, and CORS headers are preserved
      byte-for-byte.

### Track C — Unit test for the escape helper

- [ ] **C1.** A new jest test file at
      `src/utils/escapeHtml.test.ts` exercises a small TypeScript
      port of the same `escapeHtml` function. The port lives at
      `src/utils/escapeHtml.ts` and has byte-identical semantics to
      the inline Deno copies in the two edge functions. This solves
      the test-engineer's "but Deno code can't run under jest"
      problem: we ship one TS module that lives under `src/utils/`
      and is testable by jest under the existing Track 1 setup. The
      edge functions still have their own inline copies (per A1/B1)
      — those are NOT imported from `src/utils/` because the edge
      functions can't import from the React Native bundle. The
      identity of behavior is enforced **at code-review time** by
      the reviewer comparing the three implementations byte-for-byte.

- [ ] **C2.** The jest test asserts the following cases:
    - (a) Each of `&`, `<`, `>`, `"`, `'` individually maps to its
          named entity (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`).
    - (b) An attack payload like `<script>alert(1)</script>` round-trips
          to `&lt;script&gt;alert(1)&lt;/script&gt;` — exact string
          match.
    - (c) An attribute-context payload like
          `" onerror="alert(1)` round-trips with the double-quote
          escaped to `&quot;` — exact string match.
    - (d) A plain ASCII name like `Alice` round-trips unchanged.
    - (e) An emoji like `Café 🍰` round-trips unchanged
          (no double-encoding of UTF-8 bytes; the test pins the
          regression of an over-eager escape that broke multi-byte
          sequences).
    - (f) `null`, `undefined`, `42` (number), and `{}` (object) all
          coerce to `''` without throwing. This pins the
          null-safety contract from A1.
    - (g) An ampersand inside an already-encoded entity (`&amp;`)
          is double-escaped to `&amp;amp;`. We escape blindly — we
          do NOT try to detect "already-encoded" inputs. This is
          intentional and the test pins it as the expected
          behavior. Rationale: detecting "already-encoded" is a
          known footgun (e.g., `&amp` without the trailing `;` is
          ambiguous); blind escaping is the safe default for the
          one-way "user input → HTML body" pipeline.

- [ ] **C3.** The test file follows the canonical pattern at
      `src/utils/seedVarianceDates.test.ts` and
      `src/utils/relativeTime.test.ts`: no mocks, no
      `src/lib/db.ts` boundary, runs under the `unit` jest project
      (`testEnvironment: 'node'`). No new RN/Expo
      transform-deps needed (escapeHtml is pure ASCII/Unicode
      string manipulation).

### Track D — Smoke test for the response-path (defense vs. reflected XSS)

- [ ] **D1.** A new arm is appended to
      `scripts/smoke-edge-roles.sh` (the spec-027 script — same file,
      same SKIP idiom, same `trap restore_admin EXIT`). The arm
      asserts: posting a payload with `name = '<script>x</script>'`
      to `send-invite-email` does NOT echo the unescaped tag in the
      function's response body. The escape function runs on the
      HTML body of the email; what we're smoke-testing is that the
      function's error path / response path doesn't independently
      reflect the unsanitized `name` back to the caller (a
      defense-in-depth check; not the primary attack surface).
    - Architect picks: either add the arm to `smoke-edge-roles.sh`
      OR ship a separate `scripts/smoke-email-escape.sh` and chain
      it in `package.json` `test:smoke`. The PM's lean is "append
      to `smoke-edge-roles.sh` because they both smoke the same
      edge function" — keeps the test:smoke chain at 3 scripts
      rather than 4, and the trap-based admin restore from
      `smoke-edge-roles.sh` provides the JWT setup the new arm
      needs.

- [ ] **D2.** The arm only runs when the existing Arm 3 admin login
      succeeded (i.e., it reuses `$ADMIN_BEARER`). It SKIPs on
      missing local stack — same shape as Arms 3 and 4 in spec 027.

- [ ] **D3.** Concrete assertion: post a payload like
      `{"email":"escape-test@local.test","name":"<script>x</script>","role":"user","storeNames":""}`
      to the function. With local stack + no `RESEND_API_KEY`, the
      function falls through to `auth.admin.inviteUserByEmail()`,
      which on a fresh email succeeds with HTTP 200 and the body
      `{"success":true,"method":"supabase-auth"}`. The smoke
      assertion is: HTTP status is 200 OR 4xx, AND the response
      body does NOT contain the literal substring `<script>`
      (case-insensitive). A 4xx with an error message that echoes
      the literal tag would fail — that would mean the function
      reflected the unescaped payload back via the JSON error path.
      A 200 with a success envelope passes trivially.
    - Cleanup: the test creates a `escape-test-${RANDOM}@local.test`
      auth user via `auth.admin.inviteUserByEmail`. Local-only stack
      with no `RESEND_API_KEY` means the user is created in
      `auth.users` but no email is sent. The trap from Arm 4
      already restores `admin@local.test`; this arm should add a
      sibling cleanup step that deletes the test auth user from
      `auth.users` via `docker exec ... psql ...` to keep
      reruns idempotent. The cleanup is best-effort (a leftover
      `escape-test-*@local.test` user does not break the stack).

- [ ] **D4.** The arm runs AFTER Arm 4 in the script (so the admin
      restore is still ahead of it; the arm uses the freshly-restored
      admin JWT). The new arm does NOT run Arm 4's
      promote/restore dance — it only consumes the admin JWT.

### Track E — Document the convention

- [ ] **E1.** A new bullet is appended to `CLAUDE.md` under the
      existing "Conventions already in use" section, placed
      immediately after the spec-027 "Edge function role gates
      mirror `auth_is_privileged()`" bullet. The new bullet:

      - **Edge function HTML email templates escape interpolated
        values.** Edge functions that render HTML email bodies via
        Resend MUST escape every caller-controlled interpolation
        through an inline `escapeHtml()` helper (five-character
        escape: `&<>"'`). Reference shape:
        `supabase/functions/send-invite-email/index.ts` (spec 028).
        Subjects and recipient addresses are not HTML and do not
        need the helper; HTML bodies do. The TS port for jest
        coverage lives at `src/utils/escapeHtml.ts` — it is NOT
        imported by the edge functions (Deno bundle vs. RN bundle),
        but its identity to the Deno copies is enforced at
        code-review time.

- [ ] **E2.** A new bullet is appended to
      `.claude/agents/security-auditor.md` under the existing
      "Edge functions" section. The bullet directs future audits
      to check the convention: any new edge function that
      interpolates request-body strings into a Resend `html:`
      field without an `escapeHtml()` wrap is **High** (mail-client
      XSS / phishing surface — not a privilege escalation but does
      enable a weaponized mail body).

- [ ] **E3.** Both prose edits are strictly additive — no existing
      paragraph is rewritten beyond inserting the new bullet.
      (Carries the spec 026 / spec 027 "strictly additive" rule
      forward.)

### Cross-track verification gates

- [ ] **CT1.** `npx tsc --noEmit` exits 0.
- [ ] **CT2.** `npm run typecheck:test` exits 0.
- [ ] **CT3.** `npm test -- --ci` passes — the new
      `src/utils/escapeHtml.test.ts` adds 7 new tests; existing
      jest suites stay green.
- [ ] **CT4.** `npm run test:db` PASS — no DB changes in this spec,
      but the gate stays green.
- [ ] **CT5.** `npm run test:smoke` PASS — including the new arm
      (or new script) per Track D. SKIPs gracefully when no local
      stack is available.
- [ ] **CT6.** Manual gate (developer pre-PR sanity check): with a
      local stack running, post a payload via curl to the LOCAL
      `send-invite-email` function with `name = '<script>x</script>'`
      and verify in the docker logs of
      `supabase_edge_runtime_imr-inventory` that the rendered HTML
      body contains `&lt;script&gt;x&lt;/script&gt;` (escaped) and
      NOT `<script>x</script>` (unescaped). One-line capture:
      `docker logs supabase_edge_runtime_imr-inventory 2>&1 | grep
      -i 'script\|escape-test' | head -20`. This is the load-bearing
      proof that the escape ran — the smoke test (D3) checks the
      response body, this manual gate checks the rendered email
      body via log inspection.

## In scope

- One inline `escapeHtml` helper in
  `supabase/functions/send-invite-email/index.ts`.
- One byte-identical inline `escapeHtml` helper in
  `supabase/functions/send-welcome-email/index.ts`.
- Four `${...}` interpolations in the invite template wrapped (`name`,
  `role`, `storeNames`, `registerUrl`/`expiresText` for defense-in-depth).
- One `${...}` interpolation in the welcome template wrapped (`name`),
  plus `APP_URL` for defense-in-depth.
- New TS port at `src/utils/escapeHtml.ts` for jest coverage.
- New jest test at `src/utils/escapeHtml.test.ts` (seven cases per C2).
- New smoke arm appended to `scripts/smoke-edge-roles.sh` OR new sibling
  `scripts/smoke-email-escape.sh` chained in `package.json:18` (architect
  picks; spec accepts either).
- Documentation bullets in `CLAUDE.md` and
  `.claude/agents/security-auditor.md`.

## Out of scope (explicitly)

1. **The other 025-audit Mediums.** Spec 025 review surfaced five
   Medium findings (M1 sidebar visibility, M2 cross-brand store
   trigger, M3 unescaped HTML interpolation = this spec, M4 the
   spec-026 super_admin RLS gap, M5 `sendPasswordReset` naming).
   Only M3 is in scope. M4 was spec 026. M1, M2, M5 are separate
   follow-up specs.
2. **Subject-line escaping.** Subjects in both files are static
   string literals. If a future change makes the subject
   caller-controlled, that change should add the `escapeHtml`
   wrap; this spec does NOT pre-emptively change the subject.
3. **Promotion to `supabase/functions/_shared/`.** Spec 027 §4.2
   explicitly considered and rejected the shared-module path for
   `ADMIN_ROLES`. Same rationale applies here: the supabase CLI's
   `functions deploy <name>` deploys a single function in
   isolation; a shared module under `_shared/` is correct in
   theory but invisible when stale-deploy drift hits. Inline
   duplication makes drift visible at code-review time. Two
   copies is cheaper than the coordination tax. Revisit if a
   third edge function ever needs the same helper.
4. **A "stricter" escape (e.g., a full DOMPurify port).** The
   five-char escape is the well-established minimum for HTML
   body context (`OWASP Cheat Sheet: Cross Site Scripting
   Prevention`). Bringing DOMPurify into Deno is overkill for a
   write-once template literal. If a future edge function ever
   needs to render arbitrary admin-supplied HTML (not just
   interpolate a name into a template), THAT spec can introduce
   a richer sanitizer.
5. **Email send-failure observability.** The current `success: false`
   on Resend failure is unchanged. Spec 025's Low #1 finding about
   `inviteUser` reporting success when the env var is missing is
   not in scope here.
6. **`app.json` slug.** Untouched (project policy; CLAUDE.md
   "app.json slug mismatch (DO NOT AUTO-FIX)").
7. **DB-side changes.** None. No migrations, no RPC changes, no
   RLS edits.
8. **Frontend (`src/`) behavior changes.** None. The new
   `src/utils/escapeHtml.ts` ships but is NOT called by any
   client code — it exists exclusively as the testable mirror of
   the inline Deno escape function. The Cmd UI invite flow still
   posts `{ email, name, role, storeNames }` to the function
   exactly as today; the escape happens server-side.
9. **EAS native build validation.** No native code changes.
10. **Realtime channel changes.** None. Neither edge function
    touches realtime; this fix is server-side only.
11. **Retroactive coverage backfill for other deferred fixes.**
    Spec 023 covered the retroactive backlog for past Criticals.
    This spec covers spec 025's M-finding #3 only.
12. **Edge function deployment.** As with spec 027, this spec
    lands the source change. Deployment is a manual
    `supabase functions deploy send-invite-email` +
    `supabase functions deploy send-welcome-email` step the user
    runs separately. Flag in release-coordinator handoff.

## Open questions resolved

### Q1. Inline escape helper vs `supabase/functions/_shared/escapeHtml.ts`?

**Answer:** Inline in each file. Reasoning carried over from spec 027
§4.2: the supabase CLI deploys functions in isolation; a `_shared/`
module is correct in theory but creates an invisible drift surface
because we have no convention for redeploying every importer when the
shared file changes. With only TWO files needing the helper today,
two-line duplication is cheaper than the coordination tax. If a third
edge function ever needs the same helper, revisit then.

The user's prompt explicitly endorsed this lean: "Recommend inlining:
keeps the change blast radius small, and Deno's shared-module deploy
story is still unclear."

### Q2. Where does the test live, given Deno code can't run under jest?

**Answer:** Ship a TS port at `src/utils/escapeHtml.ts` with
byte-identical semantics. The edge functions keep their inline
copies (they can't import from `src/`; different bundles). The
test asserts the TS port's behavior; the reviewer asserts the
inline Deno copies match the TS port byte-for-byte at code-review
time. The function is small enough (5-6 lines) that byte-match is
trivially verifiable.

Alternative considered + rejected: a `deno test`-based unit test
under `supabase/functions/`. Rejected because (a) the project
hasn't adopted Deno's test runner anywhere yet — would require new
CI tooling, (b) the existing Track 1 jest setup already covers
pure-string utility code under `src/utils/`, (c) `src/utils/`
already has the canonical examples (`relativeTime.test.ts`,
`seedVarianceDates.test.ts`) the developer can pattern-match
against.

### Q3. Smoke test arm vs new sibling script?

**Answer:** Architect picks at design time. PM lean is "append to
`smoke-edge-roles.sh` because they both smoke the same edge
function." Spec accepts either. Both choices satisfy AC D1.

The append-to-existing path is slightly cleaner because:
- The trap-based admin restore from `smoke-edge-roles.sh` Arm 4
  already provides JWT setup for free.
- The `test:smoke` chain stays at 3 scripts (one fewer chained `&&`).
- The "smoke a different aspect of the same function" pattern is
  already established by `smoke-edge.sh` (which has 9 arms across
  different aspects of `fetch-breadbot-sales`).

The new-sibling-script path has the slight upside of cleaner
naming (`smoke-email-escape.sh` self-documents intent) but the
downside of duplicating the local-stack-detection + login setup.

### Q4. Why escape `registerUrl` and `APP_URL` if they're not caller-controlled today?

**Answer:** Defense-in-depth + drift resistance. The template is
internally consistent if every `${...}` is wrapped; future
maintainers reading the template should see a uniform pattern (wrap
everything) rather than a mixed pattern (wrap some, leave others
bare). The cost is six characters per wrap. The benefit is that if
APP_URL is ever read from `Deno.env.get()` (where an attacker
could in theory set the env var) or a query parameter, the
template doesn't suddenly become a vulnerability surface.

Hardcoded constants like `expiresText = "48 hours"` could
reasonably be left bare; the spec wraps them for the same
uniformity reason. This is a soft preference; the architect can
narrow Track A2's scope to just the four caller-controlled
interpolations if they have a strong reason. The minimum
mandatory wrap is the four caller-controlled ones; the
defense-in-depth wrap of locals is a "nice to have" that the
architect can keep or drop.

### Q5. Are the edge functions deployed automatically on merge?

**Answer:** No. Same as spec 027. The user runs
`supabase functions deploy send-invite-email` and
`supabase functions deploy send-welcome-email` manually after the
PR merges. The release-coordinator handoff must flag this.

### Q6. Does this need a realtime restart?

**Answer:** No. This spec doesn't touch the realtime publication
or any subscribed table. The edge functions don't publish realtime
events. The realtime container does NOT need a `docker restart`
after this spec lands.

### Q7. Per-store scope?

**Answer:** Admin-global. Both functions are gated by
caller-role-or-self-registration; neither reads store membership.
Per-store RLS hardening is orthogonal.

### Q8. Cmd UI vs legacy?

**Answer:** N/A — server-side only. The Cmd UI's
`InviteUserDrawer` and `LoginScreen` (for registration → welcome
email) already POST the user-supplied fields to the edge function
unchanged. The fix is 100% server-side. The legacy
`AdminScreens.tsx` was deleted in spec 025; not a consideration.

## Dependencies

- **Spec 025** (security audit finding M3 = the trigger). Already
  shipped.
- **Spec 026** (sibling fast-follow for `invitations` RLS
  super_admin). Already shipped at `SHIP_READY`.
- **Spec 027** (sibling fast-follow for `send-invite-email`
  `ADMIN_ROLES` super_admin parity). Currently `READY_FOR_REVIEW`.
  This spec does NOT block on 027 — the touched lines don't
  overlap (027 changes line 16 / 27 / 29 of `send-invite-email`;
  this spec changes the template literal at line 74). The two
  specs can land in either order; if 027 lands first, the dev
  rebases on top of it cleanly.
- **Spec 022** (test framework Track 1 + Track 3). The new jest
  test follows Track 1 conventions; the new smoke arm follows
  Track 3 conventions.
- **OWASP "Cross Site Scripting Prevention Cheat Sheet"** — the
  five-character HTML-body escape is the well-established
  minimum for the "user input → HTML body" pipeline. Reference
  for the architect (no link in the spec; OWASP page is stable).

## Project-specific notes

- **Cmd UI section / legacy:** N/A. Server-only.
- **Per-store or admin-global:** Admin-global.
- **Realtime channels touched:** None.
- **Migrations needed:** No.
- **Edge functions touched:** `send-invite-email`,
  `send-welcome-email`.
- **Web/native scope:** Server-only. No web bundle or EAS impact.
- **Migration ordering:** N/A.
- **app.json slug:** untouched.

## File-by-file plan

| File | Track | Change |
|------|-------|--------|
| `supabase/functions/send-invite-email/index.ts` | A | EDIT. Add inline `escapeHtml` helper at module scope (above `Deno.serve`). Wrap the four caller-controlled `${...}` interpolations (and template-locals for defense-in-depth) in the HTML body template literal. Lines 1-15 (imports, env, CORS) and 16-58 (spec-027 `ADMIN_ROLES` + `requireAdminCaller` + validation) untouched. |
| `supabase/functions/send-welcome-email/index.ts` | B | EDIT. Add identical inline `escapeHtml` helper at module scope. Wrap the one caller-controlled `${name}` (and `${APP_URL}` for defense-in-depth) in the HTML body template literal. Lines 1-15 (imports, env, CORS) and 16-58 (`verifyFreshRegistration`, validation gate) untouched. |
| `src/utils/escapeHtml.ts` | C | NEW. ~10 lines. Byte-identical semantics to the inline Deno copies in Track A1/B1. Exports `escapeHtml(value: unknown): string`. |
| `src/utils/escapeHtml.test.ts` | C | NEW. Jest test asserting the seven cases enumerated in C2. ~30-40 lines following the `src/utils/relativeTime.test.ts` shape. |
| `scripts/smoke-edge-roles.sh` (or new `scripts/smoke-email-escape.sh`) | D | EDIT (PM lean) or NEW (architect's pick). Append one arm asserting the response body of `send-invite-email` does not echo unescaped `<script>` markup. Reuses Arm 3's admin JWT. Same SKIP idiom for missing local stack. |
| `package.json` | D (conditional) | EDIT only if architect picks the new-sibling-script path. Append `&& bash scripts/smoke-email-escape.sh` to `test:smoke` at line 18. No edit if architect appends the arm to `smoke-edge-roles.sh`. |
| `CLAUDE.md` | E | EDIT. One bullet under "Conventions already in use," immediately after the spec-027 "Edge function role gates" bullet. Strictly additive. |
| `.claude/agents/security-auditor.md` | E | EDIT. One bullet under the existing "Edge functions" section. Strictly additive. |

**Expected file count: 5-7 files** (5 if architect appends to
`smoke-edge-roles.sh`; 7 if architect ships a new sibling script
+ package.json update + the doc files).

## Handoff notes for downstream

- **For backend-architect (design mode):** confirm A1's escape
  semantics (the five characters, the null/non-string coercion).
  Decide Q3 (append vs new script) and write the chosen path
  into the design doc. Spell out the byte-identical copy
  contract between the two Deno files and the TS port — this is
  the load-bearing review check. Consider whether Track A2's
  defense-in-depth wrap of template-locals should be mandatory
  (PM's lean) or opt-out (architect's call); pick one.

- **For backend-developer:** the change is mechanical. The
  load-bearing review check is "do the three escape functions
  match byte-for-byte." Copy-paste from the design doc's
  reference snippet. Run the new jest test first
  (`npm test -- --ci`), then the new smoke arm
  (`bash scripts/smoke-edge-roles.sh` or the chosen path) on a
  local stack. Manual gate CT6 is a one-curl-plus-one-grep on
  docker logs — capture the log line in the dev handoff.

- **For test-engineer:** assert the seven C2 cases. Verify the
  jest test runs under the `unit` project (node env, not jsdom).
  Verify the smoke arm's SKIP behavior matches the
  `smoke-edge-roles.sh` siblings.

- **For security-auditor:** verify the five-character escape is
  complete (no missed character; common omission is the single
  quote `'`). Verify the escape runs in ALL caller-controlled
  paths (a missed `${...}` is the regression). Verify the
  `subject:` and `to: [email]` fields are correctly NOT
  wrapped (they're not HTML).

- **For release-coordinator:** the spec ships in the same git
  commit as the test + doc updates. Edge function deployment
  (`supabase functions deploy send-invite-email` AND
  `supabase functions deploy send-welcome-email`) is a separate
  manual step the user runs after merge. Flag both deploys in
  the release proposal — TWO functions need to redeploy this
  time, not one. If spec 027 has not yet shipped, the
  `send-invite-email` deploy carries both fixes; if 027 shipped
  separately, this PR's `send-invite-email` deploy is the
  second redeploy of the function.

## Architect design

This is a server-side-only spec. No migrations, no `db.ts` changes,
no RLS changes, no frontend changes, no realtime impact. The
design's job is to (a) pin the byte-identical `escapeHtml` source
that ships in three places, (b) enumerate every interpolation that
gets wrapped (with line numbers), (c) resolve the three open
questions, and (d) lock the verification gates.

### Resolution of open questions

**Q1 — Byte-identical reference for the three copies.** Pin the
canonical source block in this spec (under "Canonical
`escapeHtml` source" below). All three copies — two Deno inline
helpers and one TS-port at `src/utils/escapeHtml.ts` — must match
the body byte-for-byte. The reviewer greps for divergence using:

    diff <(sed -n '/^function escapeHtml/,/^}/p' supabase/functions/send-invite-email/index.ts) \
         <(sed -n '/^function escapeHtml/,/^}/p' supabase/functions/send-welcome-email/index.ts)

(empty diff = match). The TS-port comparison is by-eye because of
the `export` keyword + `unknown` typing differences in the
signature line; **the function body** (everything between the
opening `{` and closing `}`) must be byte-identical to the Deno
copies. Rationale: a project-wide grep-comparable check beats a
CLAUDE.md "canonical source" pointer that nobody remembers to
spot-check. The diff one-liner is small enough that
code-reviewer can run it inline.

**Q3 — Smoke arm placement: Option A (append to
`scripts/smoke-edge-roles.sh`).** PM's lean accepted. Reasons:
the file already smokes `send-invite-email`; the trap-based admin
restore at line 101 provides JWT setup for free; `test:smoke`
chain at [package.json:18](package.json:18) stays at 3 scripts;
the "smoke a different aspect of the same function" pattern is
already established by `smoke-edge.sh` (9 arms over
`fetch-breadbot-sales`). New arm number: **Arm 5**, placed after
Arm 4's super_admin block (line 252) and before the summary
block (line 254-262).

**Q4 — Defense-in-depth wrap of template-locals: mandatory.**
PM's lean accepted. Wrap `${registerUrl}`, `${expiresText}`, and
`${APP_URL}` (welcome) through `escapeHtml()` even though they
are server-built constants today. Rationale: (a) uniform pattern
in the template makes a future omission visible at code-review
time (mixed pattern = "did the author skip this on purpose or by
accident?"), (b) cost is six characters per wrap, (c) drift
resistance — if `APP_URL` is ever read from `Deno.env.get()` or
the source URL becomes caller-influenced, the template stays
safe. Cited in the convention bullet (Track E1) so future
maintainers know "wrap everything that interpolates" is the
rule.

### Canonical `escapeHtml` source

**Deno inline copy** (Track A1 / B1). Place at module scope above
`Deno.serve(...)`. The 3-line docblock is part of the canonical
text — reviewer checks it is present in both Deno files. The
4-line function body is what `diff` must match byte-for-byte
between the two Deno files.

    // Spec 028: HTML-escape caller-controlled interpolations into the
    // email body template literal below. Inlined per spec 028 §3 (not
    // shared via _shared/) because supabase functions deploy <name>
    // ships one function at a time and a shared module is invisible
    // drift surface. Byte-identical mirror at src/utils/escapeHtml.ts.
    function escapeHtml(value: unknown): string {
      if (typeof value !== "string") return "";
      return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

The body is intentionally one-line-per-step on a single returned
expression so the byte-identical diff stays trivial. Five
`.replace(...)` calls in fixed order: `&` first (so subsequent
escapes don't double-encode the `&` in `&lt;` etc.), then
`<`, `>`, `"`, `'`. The five-char escape is the OWASP-canonical
minimum for the "user input → HTML body" pipeline.

**TS port** (Track C, `src/utils/escapeHtml.ts`). Same body, only
the signature line and the `export` keyword differ. The body
between the curly braces is byte-identical.

    // Spec 028: TS mirror of the inline escapeHtml helper in
    // supabase/functions/send-invite-email/index.ts and
    // supabase/functions/send-welcome-email/index.ts. This module is
    // NOT imported by those edge functions (different bundle); it
    // exists exclusively as the jest-testable mirror.
    export function escapeHtml(value: unknown): string {
      if (typeof value !== "string") return "";
      return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

**Null-safety contract.** `typeof value !== "string"` returns `""`
for `null`, `undefined`, `number`, `object`, `boolean`, `symbol`,
`function`. This is wider than the AC text "null / undefined /
non-string" but the wider net is correct — any non-string input
becomes empty, never throws inside the template literal.

### Track A — `send-invite-email/index.ts` HTML escape

**Insertion point:** module scope, between line 35
(close brace of `requireAdminCaller`) and line 37 (`Deno.serve`
opener). The helper is hoisted ahead of `Deno.serve` so it is
in scope inside the handler.

**Interpolation swaps in the `html:` template literal at line 74.**
All five `${...}` slots in the template are wrapped. Line 74 is a
single very long template literal; the swap is mechanical
string replacement.

| Swap # | Before                                  | After                                                |
|--------|-----------------------------------------|------------------------------------------------------|
| 1      | `Welcome, ${name}!`                     | `Welcome, ${escapeHtml(name)}!`                      |
| 2      | `as a <strong>${role}</strong>`         | `as a <strong>${escapeHtml(role)}</strong>`          |
| 3      | `${storeNames ? \` with access to <strong>${storeNames}</strong>\` : ""}` | `${storeNames ? \` with access to <strong>${escapeHtml(storeNames)}</strong>\` : ""}` |
| 4      | `<a href="${registerUrl}"`              | `<a href="${escapeHtml(registerUrl)}"`               |
| 5      | `<strong>${expiresText}</strong>`       | `<strong>${escapeHtml(expiresText)}</strong>`        |

Note swap #3: only the **inner** `${storeNames}` (inside the
nested template literal) is wrapped. The outer
`${storeNames ? ... : ""}` ternary condition is a JS truthiness
check on the raw value, not interpolation into HTML — it stays
bare. This is the one subtle swap; the developer should diff
carefully.

The `to: [email]` on line 72 is NOT wrapped (RFC-5322 address
field, not HTML). The `subject:` on line 73 is NOT wrapped (static
literal, no interpolation). The JSON error path at line 95 is NOT
wrapped (JSON.stringify is the boundary). The fallback at
line 87 — `{ data: { name, role } }` passed to
`supabase.auth.admin.inviteUserByEmail` — is NOT wrapped (the
Supabase Auth API treats `data` as opaque structured metadata,
not HTML; escaping it would corrupt the round-trip).

### Track B — `send-welcome-email/index.ts` HTML escape

**Insertion point:** module scope, between line 35 (close brace
of `verifyFreshRegistration`) and line 37 (`Deno.serve` opener).
Identical structural position to Track A.

**Interpolation swaps in the `html:` template literal at line 71.**

| Swap # | Before                | After                            |
|--------|-----------------------|----------------------------------|
| 1      | `you're all set, ${name}!` (after the `<h2>` opener) | `you're all set, ${escapeHtml(name)}!` |
| 2      | `<a href="${APP_URL}"` | `<a href="${escapeHtml(APP_URL)}"` |

The `to: [email]` on line 69 is NOT wrapped. The `subject:` on
line 70 (`"Welcome to I.M.R — You're all set!"`) is NOT
wrapped — it is a static string literal with a Unicode em-dash
escape; no interpolation. The JSON error path at line 84 is NOT
wrapped.

### Track C — TS port at `src/utils/escapeHtml.ts`

**New file.** Single named export `escapeHtml(value: unknown): string`.
Source per the "Canonical escapeHtml source" block above. Roughly
10 lines including the docblock.

**Test file `src/utils/escapeHtml.test.ts`** follows the
`src/utils/relativeTime.test.ts` shape: no mocks, no
`src/lib/db.ts` boundary, runs under the `unit` jest project
(`testEnvironment: 'node'` per [jest.config.js:60-69](jest.config.js)).
Seven test cases per AC C2:

1. **Individual character mapping** — five separate `expect` calls,
   one per character: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`,
   `"` → `&quot;`, `'` → `&#39;`.
2. **Script-tag attack payload** — `<script>alert(1)</script>` →
   `&lt;script&gt;alert(1)&lt;/script&gt;`. Exact-string match.
3. **Attribute-context attack payload** — `" onerror="alert(1)`
   round-trips with the double-quote escaped to `&quot;` and the
   rest unchanged. Exact-string match.
4. **Plain ASCII passthrough** — `Alice` → `Alice`.
5. **Emoji / multi-byte passthrough** — `Café 🍰` → `Café 🍰`
   (no double-encoding of UTF-8 bytes). Pins the regression of an
   over-eager byte-level escape.
6. **Null-safety coercion** — `null`, `undefined`, `42`, `{}` all
   coerce to `""`. Four separate `expect` calls. This pins the
   `typeof value !== "string"` short-circuit.
7. **Double-escape on already-encoded input** — `&amp;` →
   `&amp;amp;`. Pins the intentional "blind escape, no
   detection" contract per spec acceptance criterion C2(g).

Total: 7 cases, ~12 `expect` calls (case 1 has five, case 6 has
four, the rest have one each). The test file runs in
~10ms — no fake timers, no async, no mocks.

### Track D — Smoke arm appended to `scripts/smoke-edge-roles.sh`

**Arm 5: response-body does NOT echo unescaped `<script>` markup.**
Placed after Arm 4's super_admin block (between lines 252 and 254).
Reuses `$ADMIN_BEARER` from Arm 3's login round-trip. Same SKIP
idiom as Arms 3 and 4 — if the local stack is unreachable or
admin login failed, this arm SKIPs.

**Arm shape (design pseudocode — developer authors the bash):**

    step "Arm 5: response body does not echo unescaped <script> markup"
    if [[ -z "${ADMIN_BEARER}" ]]; then
      skip "escape-test arm" "no ADMIN_BEARER (no local stack?)"
    else
      ESCAPE_EMAIL="escape-test-${RANDOM}@local.test"
      PAYLOAD=$(printf '{"email":"%s","name":"<script>x</script>","role":"user","storeNames":""}' "$ESCAPE_EMAIL")
      RESPONSE=$(curl -sS -w '\n%{http_code}' -X POST \
        -H "apikey: ${SUPABASE_ANON_KEY}" \
        -H "Authorization: Bearer ${ADMIN_BEARER}" \
        -H "Content-Type: application/json" \
        -d "$PAYLOAD" \
        "$FN_URL")
      CODE=$(printf '%s' "$RESPONSE" | tail -1)
      BODY=$(printf '%s' "$RESPONSE" | sed '$d')

      # Pass conditions:
      # - HTTP status is 200 (Resend fallthrough → Supabase Auth invite, success
      #   on fresh email) OR 4xx (validation or rate-limit; both legitimate
      #   non-crash exits)
      # - Response body does NOT contain literal "<script>" (case-insensitive)
      if [[ "$CODE" == "200" || "$CODE" =~ ^4[0-9][0-9]$ ]]; then
        if printf '%s' "$BODY" | grep -qi '<script>'; then
          fail "response body echoed unescaped <script> markup: ${BODY:0:200}"
        else
          pass "response body does not reflect unescaped tag (HTTP ${CODE})"
        fi
      else
        fail "unexpected ${CODE}: ${BODY:0:200}"
      fi

      # Best-effort cleanup: delete the auth.users row we may have created
      # via the auth.admin.inviteUserByEmail fallback. Local-only.
      docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c \
        "delete from auth.users where email='${ESCAPE_EMAIL}';" \
        >/dev/null 2>&1 || true
    fi

**Smoke limitations to flag (per spec D1 last paragraph):**
- Without a Resend mock locally, this arm cannot inspect the
  rendered HTML body Resend would have received. Local runs hit
  the `auth.admin.inviteUserByEmail` fallback (no `RESEND_API_KEY`
  in the local `.env`), which doesn't surface the email body at
  all.
- The arm checks the **response JSON body** for `<script>` leakage,
  not the **rendered email body**. The response body is what the
  caller sees; the email body is what the recipient sees. The
  unit test (Track C) covers the escape function in isolation;
  this smoke covers the function not crashing on hostile input AND
  not reflecting the input back in the response envelope.
- Manual gate CT6 is the bridge: developer runs one curl + one
  docker-logs-grep against the local stack to verify the rendered
  HTML body contains `&lt;script&gt;` not `<script>`. That gate
  stays manual; the smoke does not attempt to automate log
  scraping (fragile and not the smoke layer's job).

**Trap interaction:** the `trap restore_admin EXIT` set at
line 101 stays in force. Arm 5 does not promote/demote the admin
role, so the `PROMOTED` flag is unaffected and the existing trap
behavior is preserved.

**No `package.json` edit needed** — `test:smoke` already chains
`smoke-edge-roles.sh`.

### Track E — Convention docs

**E1: New `CLAUDE.md` bullet** under "Conventions already in use,"
immediately after the existing spec-027 "Edge function role gates
mirror `auth_is_privileged()`" bullet at line 61. The bullet text:

> - **Edge function HTML email templates escape interpolated
>   values.** Edge functions that render HTML email bodies via
>   Resend (or any HTML-serving channel) MUST escape every
>   interpolated value — caller-controlled or
>   defense-in-depth — through an inline `escapeHtml()` helper
>   (five-character escape: `& < > " '`). Reference shape:
>   [supabase/functions/send-invite-email/index.ts](supabase/functions/send-invite-email/index.ts)
>   (spec 028). Subjects and recipient addresses are not HTML
>   and do not need the helper; HTML bodies do. The TS mirror at
>   [src/utils/escapeHtml.ts](src/utils/escapeHtml.ts) exists
>   exclusively for jest coverage and is NOT imported by the edge
>   functions (different bundles); identity to the Deno copies is
>   enforced at code-review time. Inline-not-shared is per spec
>   027 §4.2 rationale: shared modules under `_shared/` are
>   invisible drift surface because the supabase CLI deploys one
>   function at a time.

**E2: New `.claude/agents/security-auditor.md` bullet** appended
under the existing "Edge functions — `verify_jwt` and
service-token validation" section (after the spec-027 bullet at
line 49). Bullet text:

> - Audit HTML body interpolations for `escapeHtml` wrap. Any new
>   edge function that interpolates request-body strings (or any
>   `${...}` template-local) into a Resend `html:` field without
>   wrapping each interpolation through an inline `escapeHtml()`
>   helper is **High** (mail-client XSS / phishing surface — not
>   a privilege escalation but enables a weaponized mail body).
>   Reference shape:
>   [supabase/functions/send-invite-email/index.ts](supabase/functions/send-invite-email/index.ts)
>   (spec 028). Subject and `to:` address fields are NOT HTML and
>   do not need the wrap.

**E3: Strict additive constraint.** Both prose edits insert a new
bullet only. No existing paragraph is rewritten. Carries the
spec 026 / 027 "strictly additive" rule forward.

### Cross-cutting

- **Migrations:** none.
- **`src/lib/db.ts`:** unchanged.
- **Frontend behavior:** unchanged. `InviteUserDrawer` still POSTs
  `{ email, name, role, storeNames }` exactly as today.
- **Realtime publication:** unchanged. No `docker restart
  supabase_realtime_imr-inventory` step needed.
- **Manual post-merge deploy:** TWO `supabase functions deploy`
  invocations needed:

      supabase functions deploy send-invite-email
      supabase functions deploy send-welcome-email

  This must be flagged in the release-coordinator handoff. If
  spec 027 has not yet shipped at merge time, the
  `send-invite-email` deploy carries both fixes (spec 027 +
  spec 028); if spec 027 shipped separately, this PR's
  `send-invite-email` deploy is the second redeploy of the
  function within the spec 027/028 window.
- **CI:** `npm run test:smoke` remains manual per spec 022
  Track 3. No GitHub Actions workflow is gating this; the
  developer runs the smoke locally before flagging
  READY_FOR_REVIEW.

### Verification gates

| Gate                                    | Expected outcome                                          |
|-----------------------------------------|-----------------------------------------------------------|
| `npx tsc --noEmit`                      | Exit 0. New `src/utils/escapeHtml.ts` typechecks.         |
| `npm run typecheck:test`                | Exit 0. New test file typechecks against `tsconfig.test.json`. |
| `npm test -- --ci`                      | PASS. Existing suites green + 7 new tests on `escapeHtml.ts`. |
| `npm run test:db`                       | PASS. No DB changes; sanity check only.                   |
| `npm run test:smoke`                    | PASS. New Arm 5 in `smoke-edge-roles.sh` runs and either passes or SKIPs on missing local stack. |
| Manual CT6                              | One-curl + one docker-logs-grep on local stack confirms rendered HTML body contains `&lt;script&gt;` not `<script>`. Developer captures the log line in PR description. |

### Risks and tradeoffs

1. **Byte-identical drift between the three copies.** This is the
   primary structural risk. Mitigation: the `diff` one-liner
   above is a one-shot reviewer check. Code-reviewer agent
   should run it during review and report `OK` or `DRIFT`.
   Long-term: if a third edge function ever needs the helper,
   revisit the `_shared/` decision — three copies is the
   tipping point, two copies is below it.
2. **Defense-in-depth wraps add cycles to non-attacker paths.**
   Five-character `.replace()` chain on a hardcoded `expiresText
   = "48 hours"` is wasted work in the happy path. Mitigation:
   negligible — V8 short-circuits five regex matches on a
   no-match string in under a microsecond. The template literal
   itself is the hot path.
3. **Tests that fixate on the exact rendered HTML body of the
   email are fragile** (any future template change breaks them).
   Mitigation per spec test-engineer note: keep tests at the
   escape-function level (`src/utils/escapeHtml.test.ts`), NOT
   at the rendered-email level. The smoke arm (Track D) checks
   the **response body** doesn't reflect input, not the rendered
   email — a coarser but more durable signal.
4. **Smoke posture is response-side, not email-side.** Without
   a Resend mock, the smoke cannot directly verify the rendered
   email body. Manual CT6 fills this gap; the test-engineer
   should explicitly approve the manual-gate fallback as
   acceptable.
5. **Edge function cold-start.** Adding a 5-line helper to each
   function is irrelevant to cold-start time (Deno's module
   parse is already dominated by `@supabase/supabase-js`
   imports). No measurable impact.
6. **Schema/migration ordering:** N/A — no migrations.
7. **RLS gaps:** N/A — server-side template change only,
   not a data-access change.
8. **Performance on the 286 KB seed:** N/A — no DB-side change.

### What this design does NOT do

- Does not move the escape helper to `supabase/functions/_shared/`
  (spec out-of-scope #3; spec 027 §4.2 rationale).
- Does not change the `subject:` line escape posture (spec
  out-of-scope #2; static literals today).
- Does not introduce DOMPurify or any richer HTML sanitizer
  (spec out-of-scope #4; five-char escape is OWASP-canonical for
  body context).
- Does not touch `app.json` slug (project policy).
- Does not auto-deploy the edge functions (manual step per Q5).
- Does not gate via CI (no workflow on disk; `test:smoke` is
  manual-run).

## Handoff
next_agent: backend-developer
prompt: Implement against the design in this spec. The change is
  mechanical — copy-paste the canonical `escapeHtml` source from
  the design's "Canonical `escapeHtml` source" block into the
  two Deno files (Track A1 / B1) and the new TS port (Track C).
  Run the byte-identical diff one-liner from the Q1 resolution
  before flagging READY_FOR_REVIEW — empty diff is the load-bearing
  reviewer signal. Then make the five Track A interpolation swaps
  in `send-invite-email/index.ts:74`, the two Track B swaps in
  `send-welcome-email/index.ts:71`, ship `src/utils/escapeHtml.ts`
  + the 7-case jest test (Track C), append Arm 5 to
  `scripts/smoke-edge-roles.sh` per the Track D pseudocode, and
  add the two doc bullets (Track E). Verify all gates from the
  "Verification gates" table. Capture the manual CT6 log line in
  the PR. Set Status: READY_FOR_REVIEW and list files under
  ## Files changed.
payload_paths:
  - specs/028-email-html-escape/spec.md

## Files changed

### Edge functions (Tracks A + B)
- `supabase/functions/send-invite-email/index.ts` — added inline
  `escapeHtml(value: unknown): string` helper between
  `requireAdminCaller`'s close brace and the `Deno.serve` opener
  (lines 37-45). Wrapped the five `${...}` slots in the `html:`
  template literal (line 84): `${escapeHtml(name)}`,
  `${escapeHtml(role)}`, BOTH inner `${escapeHtml(storeNames)}`
  interpolations (the outer `storeNames ? ...` truthiness check
  remains bare per spec design Track A note), `${escapeHtml(registerUrl)}`,
  `${escapeHtml(expiresText)}`. The `data: { name, role }` payload
  to `auth.admin.inviteUserByEmail` was intentionally NOT wrapped
  (structured metadata, not HTML).
- `supabase/functions/send-welcome-email/index.ts` — added
  byte-identical inline `escapeHtml(value: unknown): string` helper
  between `verifyFreshRegistration`'s close brace and `Deno.serve`
  (lines 37-45). Wrapped the two `${...}` slots in the `html:`
  template literal (line 81): `${escapeHtml(name)}` and
  `${escapeHtml(APP_URL)}`.

### `src/utils/` (Track C)
- `src/utils/escapeHtml.ts` (NEW) — TS mirror of the Deno helper.
  Function body byte-identical to the two Deno copies; the only
  differences are the signature line's `export` keyword and the
  module-level docblock.
- `src/utils/escapeHtml.test.ts` (NEW) — jest test under the `unit`
  project covering the 7 cases in AC C2: per-character entity map
  (×5 expects), `<script>` round-trip, attribute-context payload,
  ASCII passthrough, emoji UTF-8 passthrough, null-safety coercion
  for `null`/`undefined`/`42`/`{}`, and intentional double-escape on
  `&amp;` → `&amp;amp;`.

### Smoke (Track D)
- `scripts/smoke-edge-roles.sh` — appended Arm 5 after Arm 4's
  super_admin block. Reuses `$ADMIN_BEARER` from Arm 3; SKIPs if no
  bearer was minted (no local stack). Posts a payload with
  `name = '<script>x</script>'` and asserts the response body does
  NOT contain literal `<script>` (case-insensitive). Best-effort
  cleanup deletes the `escape-test-${RANDOM}@local.test` auth.users
  row via `docker exec ... psql ...`. Trap-based admin restore from
  Arm 4 is unaffected (Arm 5 doesn't promote/demote).

### Convention docs (Track E)
- `CLAUDE.md` — appended one bullet under "Conventions already in
  use" immediately after the spec-027 "Edge function role gates
  mirror `auth_is_privileged()`" bullet. Strictly additive — no
  existing paragraph rewritten.
- `.claude/agents/security-auditor.md` — appended one bullet under
  the existing "Edge functions — `verify_jwt` and service-token
  validation" section after the spec-027 super_admin bullet.
  Strictly additive.

### Spec
- `specs/028-email-html-escape/spec.md` — `Status:` flipped to
  `READY_FOR_REVIEW`; this section appended.

### Verification gates run

- Byte-identical diff (Deno copies):
  `diff <(sed ... send-invite-email/index.ts) <(sed ... send-welcome-email/index.ts)`
  → **EMPTY**.
- CT1 `npx tsc --noEmit` → exit 0.
- CT2 `npm run typecheck:test` → exit 0.
- CT3 `npm test -- --ci` → **24/24 PASS** (7 new tests in
  `escapeHtml.test.ts`; 17 pre-existing tests unchanged).
- CT4 `npm run test:db` → **14/14 PASS**.
- CT5 `npm run test:smoke` (chained: smoke-edge.sh + smoke-rpc.sh +
  smoke-edge-roles.sh) → **all PASS** including new Arm 5.
- CT6 manual render proof — ran the inline `escapeHtml` helper
  against the same template-literal shape as `send-invite-email`
  with `name = '<script>x</script>'`. Output contained
  `Welcome, &lt;script&gt;x&lt;/script&gt;!` (escaped) and NOT
  `Welcome, <script>x</script>!` (unescaped). The local Resend
  fallback path (no `RESEND_API_KEY` in `.env.local`) routes to
  `auth.admin.inviteUserByEmail` which passes `data: { name, role }`
  as opaque metadata — the rendered HTML body only exists in
  edge-runtime logs when Resend is actually hit, so this manual
  gate was satisfied by the direct render test instead of log
  scraping. The Track D smoke arm confirms the function response
  body does not echo unescaped markup (HTTP 200, no `<script>` in
  response).

### Manual post-merge deploys (NOT done by this implementation)

Per spec out-of-scope #12 and the architect's "Cross-cutting"
note, edge function deployment is the user's manual post-merge
step. Two functions need to redeploy:

    supabase functions deploy send-invite-email
    supabase functions deploy send-welcome-email

The release-coordinator should flag both deploys in the release
proposal. If spec 027 has not yet shipped, the
`send-invite-email` deploy carries both fixes (spec 027 +
spec 028).
