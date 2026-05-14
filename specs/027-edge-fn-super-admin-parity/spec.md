# Spec 027: Edge function ADMIN_ROLES super_admin parity

Status: READY_FOR_REVIEW

## Background

Spec 026 (commit `43c8b3e`) shipped Track A — `invitations` RLS broadened
to include `super_admin` via `public.auth_is_privileged()`. The
security-auditor's review of spec 026
(`specs/026-post-025-cleanup/reviews/security-auditor.md:34`) recorded a
Low finding which spec 026 explicitly punted (Out of scope §7): the
`send-invite-email` edge function's `ADMIN_ROLES` constant still
hard-codes `["admin", "master"]` and excludes `super_admin`. With the
RLS broadening landed, a super-admin's invitation flow now half-works:

1. `inviteUser()` in `src/lib/auth.ts:~192` inserts the `invitations`
   row successfully (the policy now permits it).
2. The same code path then calls
   `callEdgeFunction("send-invite-email", ...)`. The function's
   `requireAdminCaller()` gate
   (`supabase/functions/send-invite-email/index.ts:18-31`) checks
   `app_metadata.role ∈ ADMIN_ROLES` first, then falls back to
   `profiles.role ∈ ADMIN_ROLES`. Both checks reject `super_admin`
   because the set is `{"admin", "master"}`.
3. Result: 403 from the edge function. The DB row exists, the email is
   never sent, and the user sees a silent fan-out failure.

Prior art for the fix is one file over:
`supabase/functions/delete-user/index.ts:14-19` already includes
`super_admin` correctly with an explanatory comment dating back to
Spec 012c §14 / Probe 16. That is the canonical edge-function-side shape:

    const ADMIN_ROLES = new Set(["admin", "master", "super_admin"]);

The DB-side canonical check is `public.auth_is_privileged()`. The
edge-function-side `ADMIN_ROLES` set should always mirror it (admin +
master + super_admin).

## User story

As a super-admin who clicks the "Invite User" button in Cmd UI's Users
section, I want the invitation email to actually be sent to the
invitee (not just the row inserted), so that the end-to-end invitation
flow is not silently broken for my role.

As a future contributor authoring a new edge function with an admin
gate, I want a single documented convention for the `ADMIN_ROLES`
constant — including `super_admin` — so that I do not repeat the
spec-026 inconsistency on a tenth edge function.

## Acceptance criteria

### Track A — Fix `send-invite-email`

- [ ] **A1.** `supabase/functions/send-invite-email/index.ts:16` —
      replace `const ADMIN_ROLES = new Set(["admin", "master"]);` with
      `const ADMIN_ROLES = new Set(["admin", "master", "super_admin"]);`.
      Mirror the byte-for-byte shape used in
      `supabase/functions/delete-user/index.ts:19`.

- [ ] **A2.** Add a 1-2 line comment above the constant explaining the
      convention and citing the canonical DB-side check. Suggested
      wording (developer may rephrase but must preserve intent):
      "Mirror of `public.auth_is_privileged()` on the edge-function
      side. Must include `super_admin` so that role-broadened RLS
      callers (spec 026 Track A) don't get 403'd at the edge layer."

- [ ] **A3.** No other change to `send-invite-email/index.ts`. The
      `requireAdminCaller` function body, the email-rendering
      template, the Resend fallback, and the
      `auth.admin.inviteUserByEmail()` fallback are all preserved
      byte-for-byte.

### Track B — Audit and (where mechanical) fix sibling edge functions

- [ ] **B1.** Audit every file under `supabase/functions/` for
      role-gate patterns that hard-code `["admin", "master"]` or
      equivalent and either omit `super_admin` or omit `master` from
      what should be the canonical set. The audit is enumerated as a
      table in the design doc (architect to confirm; the spec's
      §"Audit baseline" section below pre-fills what the PM found).

- [ ] **B2.** For every audit hit where the array is used as a
      **privilege gate** (i.e., "is this caller allowed to do
      this?"), apply the same mechanical fix as Track A — extend the
      set to include `super_admin`. Each fixed file must include the
      same 1-2 line comment referencing the canonical
      `public.auth_is_privileged()` mirror.

- [ ] **B3.** For every audit hit where the array is used as
      **recipient selection** (i.e., "who do we notify?") rather than
      a privilege gate, the spec does **not** modify it. Document the
      hit in the design doc with a one-line "not a privilege gate —
      product call deferred" note. The current known case:
      `supabase/functions/eod-reminder-cron/index.ts:192` selects
      admins/masters to broadcast EOD reminders to. Whether
      super-admins should also receive those reminders is a product
      decision, not a parity fix. Out of scope for this spec — flagged
      as a follow-up in §"Out of scope" below.

- [ ] **B4.** The audit table in the design doc covers all 10 edge
      functions and records exactly one of these per file:
      `[NO ROLE GATE]` / `[ALREADY CORRECT — references super_admin]` /
      `[NEEDS FIX — privilege gate]` / `[NOT A PRIVILEGE GATE — defer]`.

### Track C — Smoke test for the fixed role-gate logic

- [ ] **C1.** A new shell script lands at
      `scripts/smoke-edge-roles.sh` that asserts the role-gate logic
      of `send-invite-email` on the local Supabase stack. The script
      follows the patterns established by
      `scripts/smoke-edge.sh` (curl + grep + colored pass/fail/skip
      printf, top-level `set -u`, non-zero exit on first failure,
      `FAILED` accumulator) and runs in the existing
      `npm run test:smoke` pipeline.

- [ ] **C2.** The smoke test invokes the function against the **local**
      stack (default `SUPABASE_URL=http://127.0.0.1:54321`, override
      via env). Four assertions:
    - (i) `OPTIONS` preflight returns 200 + CORS headers (regression
          check; same shape as `scripts/smoke-edge.sh` step 1).
    - (ii) `POST` with no `Authorization` header returns 401
           ("missing bearer token"). Verifies the gate function's
           entry guard.
    - (iii) `POST` with a `Bearer <admin-jwt>` succeeds — the gate
            returns 200 and the function proceeds to its body. The
            body assertion accepts either a 200 success or a 4xx
            **post-gate** error (e.g., "email and name required") —
            what we are smoke-testing is that the gate let the
            request through. We are NOT verifying email delivery.
            Implementation note: rather than running a real auth flow
            to mint an admin JWT, the smoke test takes an
            `ADMIN_BEARER` env var (consistent with how
            `scripts/smoke-edge.sh` takes `BOBBY_TOKEN`). If unset,
            steps (iii) and (iv) print `SKIP` with the reason and do
            not fail the run — same pattern as `smoke-edge.sh:92`.
    - (iv) `POST` with a `Bearer <super-admin-jwt>` succeeds — same
           assertion shape as (iii). This is the load-bearing arm:
           pre-fix, this returns 403; post-fix, this returns 200 (or
           a 4xx post-gate error).

- [ ] **C3.** The smoke test does NOT hit Resend or the
      `auth.admin.inviteUserByEmail()` fallback. It either passes an
      empty body (triggering the "email and name required" 400
      post-gate error — which is acceptable evidence that the gate
      let the request through) OR a minimal valid body that the local
      stack will accept without sending a real email. Architect
      decides at design time; the spec accepts either as long as no
      real email is sent to a real address.

- [ ] **C4.** `npm run test:smoke` is updated to chain the new
      script after the existing ones. Concretely,
      `package.json:18` becomes:

          "test:smoke": "bash scripts/smoke-edge.sh && bash scripts/smoke-rpc.sh && bash scripts/smoke-edge-roles.sh"

      (or the architect's preferred chain order). The exit-on-first-failure
      semantics are preserved by `&&`.

- [ ] **C5.** Documentation comment at the top of
      `scripts/smoke-edge-roles.sh` cites spec 027 and the parity
      convention (the same one comment Track A adds to the
      edge-function source).

### Track D — Document the role-constants convention

- [ ] **D1.** A short paragraph is added to `CLAUDE.md` (architect
      picks the section — most natural fit is under "Conventions
      already in use", paired with the existing "Edge function auth
      split" bullet) stating: "Edge functions that gate on caller
      role must mirror `public.auth_is_privileged()` on the edge side
      via `const ADMIN_ROLES = new Set(["admin", "master",
      "super_admin"]);`. Reference shape:
      `supabase/functions/delete-user/index.ts:19`. The DB-side
      canonical check is `public.auth_is_privileged()`."

- [ ] **D2.** The same convention is added to
      `.claude/agents/security-auditor.md` so future security audits
      have an explicit checklist item: "When reviewing a new edge
      function with a role gate, verify `ADMIN_ROLES` includes
      `super_admin`. The omission is the spec-026 / spec-027 pattern;
      do not let a tenth instance ship."

- [ ] **D3.** Both prose edits are strictly additive — no existing
      paragraph is rewritten beyond inserting the new bullet/line.
      "While I was here" cleanup is out of scope (rule from spec 026
      Out of scope §3 carries forward).

### Cross-track verification gates

- [ ] **CT1.** `npx tsc --noEmit` exits 0. (No type changes expected,
      but the gate stays green.)
- [ ] **CT2.** `npm run typecheck:test` exits 0.
- [ ] **CT3.** `npm test -- --ci` PASS — existing jest suites green;
      no new jest tests added (smoke-test is shell, per the project's
      existing pattern at `scripts/smoke-edge.sh`).
- [ ] **CT4.** `npm run test:db` PASS — no DB changes in this spec,
      but the gate stays green.
- [ ] **CT5.** `npm run test:smoke` PASS — including the new
      `scripts/smoke-edge-roles.sh`. When run without
      `ADMIN_BEARER` / `SUPER_ADMIN_BEARER` env vars (e.g. in CI),
      the auth-required arms print SKIP and the script still exits
      0. When run with both env vars (developer-local), all four
      arms PASS.
- [ ] **CT6.** Manual gate (developer pre-PR sanity check, not
      automated): with a real super-admin session in the local
      Cmd UI, clicking "Invite User" in `UsersSection`:
    1. inserts a row in `public.invitations` (verifiable via
       Supabase Studio at http://127.0.0.1:54323),
    2. results in a 200 response from `send-invite-email`
       (verifiable in the docker logs of
       `supabase_edge_runtime_imr-inventory`),
    3. produces no console error in the browser.
      Pre-fix this returns 403 at step 2. Post-fix it returns 200.
      Capture-of-evidence is a screenshot or the curl/log line; spec
      026's manual gate set the precedent that "end-to-end works"
      is enough.

## In scope

- One-line constant change at
  `supabase/functions/send-invite-email/index.ts:16`.
- One short comment above the constant (Track A2).
- Sibling-edge-function audit (Track B). Mechanical fixes only —
  only the constant + matching comment, no behavior changes.
- New shell smoke script `scripts/smoke-edge-roles.sh`.
- `package.json:18` `test:smoke` script chain update.
- Documentation updates in `CLAUDE.md` and
  `.claude/agents/security-auditor.md`.

## Out of scope (explicitly)

1. **DB-side RLS changes.** Spec 026 already broadened the
   `invitations` policies. This spec is edge-function-only +
   smoke-test + doc.
2. **Frontend changes.** No `src/`, no `useStore.ts`, no Cmd UI
   sections, no `src/lib/db.ts`. The bug is server-side; the UI
   already calls `inviteUser()` correctly.
3. **New migrations.** None.
4. **Realtime channel changes.** None.
5. **`app.json` slug.** Untouched (project policy; CLAUDE.md
   "app.json slug mismatch (DO NOT AUTO-FIX)").
6. **EOD reminder cron product call.** The
   `supabase/functions/eod-reminder-cron/index.ts:192` query
   `.in('role', ['admin', 'master'])` is recipient selection (who
   gets pinged about pending EOD submissions), not a privilege gate.
   Whether super-admins should also receive those broadcasts is a
   product decision the user can answer in a follow-up spec. This
   spec deliberately does NOT touch that line. Rationale: it is the
   wrong shape for a mechanical parity fix and would re-introduce
   product-decision review into what should be a one-line server-side
   fix.
7. **Real-Resend-API smoke test.** The smoke test does not send a
   real email. We are smoke-testing the role gate, not the email
   delivery pipeline. Email-delivery validation is a separate
   concern (manual / Postmark dashboard / customer report).
8. **EAS native build validation.** No native code changes.
9. **Backfilling test coverage for past super_admin edge-function
   regressions.** Spec 023 covered the retroactive backlog. This
   spec adds one smoke test for one function; it does not retrofit
   tests for `delete-user` (which already correctly includes
   super_admin) or other already-correct functions.
10. **Edge function deployment.** Edge functions are deployed via
    `supabase functions deploy <name>` separately from `git push`.
    The spec lands the source change; the user runs the deploy.
    Documented as a release-coordinator handoff note.

## Open questions resolved

### Q1. Smoke test against local stack vs stubbed fetch?

**Answer:** Local stack via curl. Rationale: matches the project's
existing pattern at `scripts/smoke-edge.sh` (which curls a live
function). A stubbed-fetch unit test is a different framework choice
(jest-fetch-mock + deno-test) that the project has not adopted. The
shell-smoke track from spec 022 is the right home for this kind of
"does the deployed function return the right status code?" assertion.
The smoke test SKIPs (does not fail) the auth-required arms in CI
where no JWT is available — same shape as `smoke-edge.sh:92`. This
keeps the smoke step hermetic-enough for CI and useful for
developer-local.

### Q2. Fix the audit hits at once or enumerate and defer?

**Answer:** Fix at once for every hit that is a **privilege gate**.
Defer for every hit that is **recipient selection** (the only known
case is `eod-reminder-cron`'s `.in('role', ['admin', 'master'])`).
Rationale: spec 026 set the precedent that mechanical, low-risk
parity fixes ship together when they share the same shape; that
keeps PR review focused on one shape, not ten. Recipient-selection
queries are a different shape (product decision, not a security
parity fix) — they need their own spec. The audit baseline in the
"Audit baseline" section below pre-fills the PM's pass; the
architect re-confirms at design time.

### Q3. Should the convention live in CLAUDE.md or only in the
security-auditor agent prompt?

**Answer:** Both. CLAUDE.md is the project contract every agent
reads on first invocation; the security-auditor prompt is the
specialist checklist. Spec 026 §B3 set the precedent of fixing
agent-prompt rot in lockstep with CLAUDE.md prose. Same shape here:
one paragraph in CLAUDE.md + one paragraph in
`.claude/agents/security-auditor.md`. Both are strictly additive
(Track D3).

### Q4. Why not also update `frontend-developer.md` /
`backend-developer.md` with the role-constants convention?

**Answer:** Those agents do not author edge functions — that's the
backend-developer's surface, and the backend-developer already reads
CLAUDE.md. Adding the convention there would be redundant prose and
out of step with Track D3's "strictly additive" rule. If a future
spec touches the backend-developer prompt for another reason, the
convention can be ported then.

### Q5. Realtime publication impact?

**Answer:** None. This spec changes only edge-function source files
+ a shell script + two doc files. The `invitations` table's
realtime status is unchanged (it is not in the realtime publication
anyway; spec 026's security audit confirmed this at
`reviews/security-auditor.md:114`).

### Q6. Per-store scope?

**Answer:** Admin-global. `send-invite-email` and the other audited
functions gate on caller role only; none of them are store-scoped.
Per-store RLS hardening from
`supabase/migrations/20260504173035_per_store_rls_hardening.sql` is
orthogonal.

## Audit baseline (PM's first pass; architect re-confirms)

The PM walked all 10 edge functions under `supabase/functions/` and
recorded each file's role-gate posture. The architect should
re-verify but the expected result is:

| File | Status | Detail |
|------|--------|--------|
| `delete-user/index.ts` | ALREADY CORRECT | `ADMIN_ROLES = new Set(["admin", "master", "super_admin"])` at line 19; reference shape. |
| `send-invite-email/index.ts` | NEEDS FIX — privilege gate | `ADMIN_ROLES = new Set(["admin", "master"])` at line 16; **Track A target**. |
| `send-welcome-email/index.ts` | NO ROLE GATE | Uses `verifyFreshRegistration()` (email-matches-token + profile-exists). Not a role check. No fix needed. |
| `pwa-catalog/index.ts` | NO ROLE GATE | Service-token bearer (`PWA_SERVICE_TOKEN`). Not a per-user role check. |
| `staff-catalog/index.ts` | NO ROLE GATE | Service-token bearer (`STAFF_SERVICE_TOKEN`). Not a per-user role check. |
| `staff-eod-submit/index.ts` | NO ROLE GATE | Service-token bearer + RPC. Not a per-user role check. |
| `staff-waste-log/index.ts` | NO ROLE GATE | Service-token bearer + RPC. Not a per-user role check. |
| `fetch-breadbot-sales/index.ts` | NO ROLE GATE | (no role/admin/master string in the file; cron-like). Verify at design time. |
| `breadbot-nightly-sync/index.ts` | NO ROLE GATE | Cron; service_role; no per-user check. |
| `eod-reminder-cron/index.ts` | NOT A PRIVILEGE GATE — defer | Line 192: `.in('role', ['admin', 'master'])` is recipient selection (broadcast list). Out of scope §6. |

**Net result for Track B:** zero additional fixes beyond Track A. The
audit produces the table above; the only mechanical fix is the one
already specified in Track A. This is good — the parity convention
is already mostly enforced; spec 027 closes the one remaining gap
and documents the convention so a tenth instance does not ship.

If the architect's re-walk finds a hit the PM missed, Track B kicks
in for that hit with the same one-line mechanical fix as Track A.

## Dependencies

- Spec 026 (`Status: READY_FOR_REVIEW` at commit `43c8b3e`) — DB-side
  parity already landed. This spec lands the edge-function-side
  parity.
- Spec 022 — the shell-smoke test track (`scripts/smoke-edge.sh`,
  `scripts/smoke-rpc.sh`, `npm run test:smoke`). The new
  `scripts/smoke-edge-roles.sh` follows the same shape.
- `public.auth_is_privileged()` helper from
  `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:235-239`
  — already shipped. This spec references it for the convention but
  does not modify it.

## Project-specific notes

- **Cmd UI section / legacy:** N/A. No UI code changes; the bug is
  server-side.
- **Per-store or admin-global:** Admin-global. The role gate
  doesn't read store membership.
- **Realtime channels touched:** None.
- **Migrations needed:** No.
- **Edge functions touched:** `send-invite-email` (Track A); any
  other audit hits found at design time (Track B; expected zero).
- **Web/native scope:** Server-only. The fix ships when the user
  runs `supabase functions deploy send-invite-email`; no web bundle
  or EAS build is involved.
- **Migration ordering:** N/A (no migrations).
- **app.json slug:** untouched.

## File-by-file plan

| File | Track | Change |
|------|-------|--------|
| `supabase/functions/send-invite-email/index.ts` | A | EDIT. One-line constant: add `"super_admin"` to the `ADMIN_ROLES` Set at line 16. Add 1-2 line comment above per A2. |
| `scripts/smoke-edge-roles.sh` | C | NEW. Four-arm shell smoke test per C2. |
| `package.json` | C | EDIT. Append `&& bash scripts/smoke-edge-roles.sh` to `scripts.test:smoke` at line 18. |
| `CLAUDE.md` | D | EDIT. One-paragraph addition under "Conventions" (or architect's preferred section) per D1. |
| `.claude/agents/security-auditor.md` | D | EDIT. One-paragraph addition per D2. |
| Other `supabase/functions/*/index.ts` | B | EDIT (conditional). Per the audit baseline: zero expected; if architect's re-walk finds a hit, mechanical fix per Track A's shape. |

5-6 files total in the expected (zero-additional-Track-B-hits) case.

## Handoff notes for downstream

- **For backend-architect (design mode):** re-walk the audit baseline
  table. Confirm or reject each row. If any row flips from
  `NO ROLE GATE` to `NEEDS FIX — privilege gate`, add that file to
  Track B at design time. The expected delta is zero, but the
  architect's pass is the load-bearing check; the PM's pass is
  advisory.

- **For backend-developer:** the change is mechanical. The
  load-bearing piece is the smoke test — design it so it SKIPs
  (does not fail) in CI without env vars, and PASSes locally with
  the env vars. See `scripts/smoke-edge.sh:92` for the SKIP idiom.

- **For release-coordinator:** the spec ships in the same git commit
  as the smoke test + doc updates. The edge function deployment
  (`supabase functions deploy send-invite-email`) is a separate
  manual step the user runs after merge. Do not block the SHIP_READY
  recommendation on edge deployment; flag it as a post-merge
  deployment step in the release proposal.

- **For security-auditor:** verify that `Track A` is a strict
  superset (admin + master still pass; super_admin newly passes) and
  that no other access path opens. Same shape as the spec-026 truth
  table the security-auditor produced at
  `specs/026-post-025-cleanup/reviews/security-auditor.md:53-68`.
  Pre-fix vs post-fix:

  | Caller | Pre-fix gate result | Post-fix gate result |
  |--------|---------------------|----------------------|
  | anon (no Bearer) | 401 (entry guard) | 401 (entry guard) |
  | bad token | 401 ("invalid token") | 401 ("invalid token") |
  | authenticated user (role = 'user') | 403 ("forbidden") | 403 ("forbidden") |
  | admin JWT | 200 (gate passes) | 200 (gate passes) |
  | master JWT | 200 (gate passes) | 200 (gate passes) |
  | super_admin JWT | **403 ("forbidden") — bug** | **200 (gate passes) — fix** |
  | super_admin via profiles.role (JWT not super_admin) | 403 ("forbidden") | 200 (gate passes via profiles fallback) |

  Strict superset confirmed.

## Architect design

### 1. Audit verification — re-walked all 10 edge functions

I read every `supabase/functions/*/index.ts` and grepped the directory for
any of `admin|master|super_admin|ADMIN_ROLES|\.role` to catch role-comparison
logic the PM might have missed. **No drift from the PM's baseline.** The
audit table at the spec's §"Audit baseline" is correct as written:

| File | Status | Verified at |
|------|--------|-------------|
| `delete-user/index.ts` | ALREADY CORRECT | line 19 — `ADMIN_ROLES = new Set(["admin", "master", "super_admin"])` |
| `send-invite-email/index.ts` | NEEDS FIX — privilege gate | line 16 — `ADMIN_ROLES = new Set(["admin", "master"])` |
| `send-welcome-email/index.ts` | NO ROLE GATE | uses `verifyFreshRegistration()` (email-match + profile-exists); no role string in the file beyond JSDoc context |
| `pwa-catalog/index.ts` | NO ROLE GATE | `PWA_SERVICE_TOKEN` bearer check at line 56-66; no per-user role |
| `staff-catalog/index.ts` | NO ROLE GATE | `STAFF_SERVICE_TOKEN` bearer check at line 41-57; no per-user role |
| `staff-eod-submit/index.ts` | NO ROLE GATE | `STAFF_SERVICE_TOKEN` bearer at line 44-50; RPC delegates auth to DB |
| `staff-waste-log/index.ts` | NO ROLE GATE | `STAFF_SERVICE_TOKEN` bearer at line 41-47; RPC delegates auth to DB |
| `fetch-breadbot-sales/index.ts` | NO ROLE GATE | line 91-102 — Supabase session check only (any authenticated user). No role-band test. |
| `breadbot-nightly-sync/index.ts` | NO ROLE GATE | line 425-433 — `x-cron-secret` shared-secret only. No role check. |
| `eod-reminder-cron/index.ts` | NOT A PRIVILEGE GATE — defer | line 192 — `.in('role', ['admin', 'master'])` is the broadcast recipient list (`adminUserIds` Set used to fan reminders OUT). Confirmed as recipient selection, NOT a caller gate. Out of scope §6 — product call. |

The `admin` substring elsewhere in these files is either (a) the noun
"admin" in JSDoc/comments, (b) the local variable name for the
service-role Supabase client (e.g. `const admin = createClient(..., SERVICE_ROLE_KEY)`),
or (c) calls into `sb.auth.admin.*` (the supabase-js admin namespace).
None of those are role gates. Verified by reading the surrounding context
for every grep hit.

**Net for Track B: zero additional fixes.** Track A's one-line change at
`send-invite-email/index.ts:16` is the entire mechanical-fix surface.

### 2. Track A — exact edits to `send-invite-email/index.ts`

**Surgical change at line 16, plus a 2-line comment immediately above it.**
Lines 17–96 unchanged (Acceptance criteria A3).

Before (current state, line 16):

    const ADMIN_ROLES = new Set(["admin", "master"]);

After (target state, replaces line 16; the comment lines push the
constant declaration down a few lines, but the literal change is
the addition of `"super_admin"` to the Set plus the comment):

    // Mirror of `public.auth_is_privileged()` on the edge-function side.
    // Must include `super_admin` so role-broadened RLS callers (spec 026
    // Track A) don't get 403'd at the edge layer. Reference shape:
    // `supabase/functions/delete-user/index.ts:19`.
    const ADMIN_ROLES = new Set(["admin", "master", "super_admin"]);

No changes to `requireAdminCaller` (lines 18-31), the body handler
(lines 33-96), the Resend POST (lines 60-72), or the
`auth.admin.inviteUserByEmail` fallback (lines 81-85).

#### Inline vs shared module

**Keep the constant inline.** I considered promoting `ADMIN_ROLES` to
`supabase/functions/_shared/roles.ts` so future edge functions could
import a single source of truth. The PM-supplied lean is "inline because
Deno edge functions don't have a great shared-module story without
changing build config." I agree, with two additional reasons:

1. **The supabase CLI's `functions deploy <name>` deploys a single
   function in isolation.** A shared module under `_shared/` works in
   local development (Deno can resolve relative imports across
   function directories) and in `supabase functions deploy` (the CLI
   bundles `../_shared/*` for each function via esbuild), but only if
   every function that imports it is re-deployed when the shared file
   changes. We have no current convention or CI gate enforcing
   "redeploy every importer when a shared file changes." Inline
   duplication makes drift visible at code-review time; a shared
   module makes drift invisible (the source-of-truth file looks
   right, but stale deploys hold the old value). With only 2 fixed +
   8 not-applicable files, two-line duplication is cheaper than the
   coordination tax.

2. **The convention already lives in CLAUDE.md and now the
   security-auditor checklist (Track D).** Future code-review +
   security-audit on a new edge function will catch the omission
   before it ships. The convention is enforced at the review layer,
   not the build layer.

If a tenth function lands and the duplication count crosses three,
revisit then. Cost of refactor at that point: ~10 lines, one PR.

#### Function-internal logic on `ADMIN_ROLES`

`ADMIN_ROLES` is used in exactly two places (`send-invite-email/index.ts:27`
and `:29`), both as `ADMIN_ROLES.has(role)` membership checks. No
iteration, no `.size` check, no log message that enumerates it. Adding
a third element does not change any other line. Verified by reading
the full function body.

### 3. Track B — confirmed zero additional fixes

See §1 above. The audit re-walk produced the same table the PM
prefilled. No sibling function has a hidden role check the PM missed.

The one borderline case worth calling out explicitly:

- `eod-reminder-cron/index.ts:192` — `.in('role', ['admin', 'master'])`
  selects profiles to PING with EOD reminders. It is the destination
  set of a broadcast, not the privileged-callers set of a gate. A
  super-admin running the cron (which they wouldn't — it's invoked
  by pg_cron with a shared secret, not a user JWT) would not be
  rejected; rather, they wouldn't *receive* the reminder. Whether
  super-admins should be on the reminder list is a product decision
  (do super-admins want to be paged for every store's EOD count?),
  not a parity fix. Out of scope §6 — flagged as a follow-up.

### 4. Track C — smoke test design

#### File and shape

- **File:** `scripts/smoke-edge-roles.sh` (per PM's pick at C1).
- **Style:** matches `scripts/smoke-edge.sh` and `scripts/smoke-rpc.sh`
  byte-for-byte at the shell-conventions layer:
  - `#!/usr/bin/env bash` shebang + `set -u`.
  - `pass() / fail() / skip() / step()` printf helpers with the same
    colour codes (`\033[32m` / `\033[31m` / `\033[33m`).
  - `FAILED=0` accumulator + non-zero exit on first failure.
  - Defaults to local stack: `SUPABASE_URL=http://127.0.0.1:54321`,
    `SUPABASE_ANON_KEY=sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH`
    (the local-stable publishable key, identical to `smoke-rpc.sh:45`).
  - SKIP-on-missing-credentials idiom matches `smoke-edge.sh:92` and
    `smoke-rpc.sh:60`.

#### Target function URL

    FN_URL="${SUPABASE_URL}/functions/v1/send-invite-email"

#### Arms (four, matching C2)

**Arm 1 — CORS preflight (no auth).** Curl `OPTIONS` with `Origin`,
`Access-Control-Request-Method: POST`, and
`Access-Control-Request-Headers: authorization,content-type`. Expect
`HTTP 200` and the three `Access-Control-Allow-*` response headers.
Same shape as `smoke-edge.sh:53-71`. Always runs (no auth needed).

**Arm 2 — POST without `Authorization` header → 401.** Curl `POST`
with `Content-Type: application/json` and a minimal body
`{}`. Expect `HTTP 401` and a body matching `missing bearer token`.
This is the entry-guard check in `requireAdminCaller`
(`send-invite-email/index.ts:19`). Always runs.

> Note on the gateway: unlike `fetch-breadbot-sales`, `send-invite-email`
> does NOT have a `verify_jwt = false` entry in `supabase/config.toml`,
> so the Supabase gateway will reject anon callers with 401 BEFORE the
> function body runs. Either way the observable behaviour is "401 on
> no-auth", and the smoke test just asserts the status code. If a
> future config change disables the gateway gate, the function-internal
> gate still produces 401, so the assertion is durable.

**Arm 3 — POST with admin JWT → 200 (or 4xx post-gate).** Mint an
admin JWT by logging in as `admin@local.test / password` against
`${SUPABASE_URL}/auth/v1/token?grant_type=password` (identical to
`smoke-rpc.sh:67-78`). Then curl `POST` to the function with the
returned `access_token` as `Bearer` and an **empty body** (`-d '{}'`).

Expected outcome: the gate passes (line 27 of the function returns
`status: 200`), the body parses, and the post-gate validation at
line 49 returns `400 {"error":"email and name required"}`. The smoke
test asserts:
1. HTTP status is `200`, `400`, or `4xx`. NOT `401` (gate rejection)
   and NOT `403` (forbidden-after-token-verify).
2. If 400, body contains `email and name required` — confirms we
   reached the post-gate handler.

A 403 here is a regression. A 401 here means the gate rejected the
admin token entirely (or the admin login failed). Either is fatal.

If `admin@local.test` login fails (no local stack, or seed not
applied), SKIP with `"reason: no local stack / could not acquire
admin token"`. Same shape as `smoke-rpc.sh:74-78` but soft-fail
rather than hard-fail.

> Why empty body, not a fake email: the function's Resend path is
> guarded by `if (RESEND_API_KEY)` (line 59). On the local stack
> `RESEND_API_KEY` is unset, so the function falls through to
> `supabase.auth.admin.inviteUserByEmail()` (line 82) — which would
> attempt a real email send via the local gotrue (logged to
> Inbucket at port 54324). Empty body short-circuits at the validation
> check on line 49 with 400, BEFORE the Resend or gotrue paths run.
> No real email is attempted. Satisfies C3.

**Arm 4 — POST with super_admin JWT → 200 (or 4xx post-gate). Load-bearing.**

This is the regression-prevention arm. Pre-fix it returns 403; post-fix
it returns 200 / 4xx.

Auth setup:
1. Run `docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c "..."`
   to UPDATE `public.profiles SET role='super_admin', brand_id=null
   WHERE id = (SELECT id FROM auth.users WHERE email='admin@local.test')`.
   This is the same pattern as `scripts/smoke-multi-brand.sh:65-68`.
   The `profiles_sync_role_to_jwt` AFTER trigger
   (`supabase/migrations/20260502071736_remote_schema.sql:515`) fires
   on the UPDATE and writes `app_metadata.role = 'super_admin'` into
   `auth.users.raw_app_meta_data`.
2. Re-login as `admin@local.test / password` to mint a FRESH JWT
   that contains the post-update `app_metadata.role`. Old JWTs
   issued before the role change are not relevant — the trigger
   updates the source, but only a new login round-trip serializes
   the new claim into a token.
3. **Restore step (runs even on failure via `trap`):** UPDATE the
   profile back to `role='admin', brand_id='2a000000-0000-0000-0000-000000000001'`
   so a subsequent re-run of the smoke (or any other smoke that
   logs in as admin) sees the canonical seed state. Use `trap
   restore_admin EXIT` so an early `exit 1` from `fail` still
   restores. This is the only state-mutation in any smoke script; it
   is reverted before the script returns.
4. Assert: HTTP status is `200` or `400`-with-`email and name required`
   in the body. **NOT 403.** A 403 is the regression-detector.
5. SKIP if `docker exec` fails (no local stack running) with `"reason:
   no local Postgres container"`. Same soft-fail shape as Arm 3.

Why we have to mutate the seed: §"Audit baseline" / Q1 notwithstanding,
the local `seed.sql` does NOT ship a super_admin user. The seed's
super-admin promotion at `20260509000000_multi_brand_schema_rls.sql:294-319`
only fires if `wzhchen113@gmail.com` exists in `auth.users`, which it
doesn't on a fresh local stack (the seed prints a NOTICE and skips).
Mutating-and-restoring is the canonical pattern; the only smoke script
doing it today is `scripts/smoke-multi-brand.sh`, which sets the
precedent.

#### Env vars (overrides)

    SUPABASE_URL              default http://127.0.0.1:54321
    SUPABASE_ANON_KEY         default the local stable publishable key
    ADMIN_EMAIL               default admin@local.test
    ADMIN_PASSWORD            default password
    ADMIN_BEARER              optional — skip Arm 3's login round-trip
    SUPER_ADMIN_BEARER        optional — skip Arm 4's promote/login dance

If the developer pre-mints both bearers (e.g. running against prod
or against a staging stack), the script uses them and skips the
docker/login setup. Otherwise it falls back to local-stack login.
If neither env vars nor local stack work, Arms 3 and 4 print SKIP
and the script exits 0 — matching the C2(iii) / `smoke-edge.sh:92`
contract.

#### `package.json` wiring (C4)

Replace line 18:

    "test:smoke": "bash scripts/smoke-edge.sh && bash scripts/smoke-rpc.sh"

with:

    "test:smoke": "bash scripts/smoke-edge.sh && bash scripts/smoke-rpc.sh && bash scripts/smoke-edge-roles.sh"

The chain order matters slightly: `smoke-edge-roles.sh` mutates
`profiles.role` (briefly) for `admin@local.test`. Putting it LAST
in the chain means a failure earlier in the chain doesn't leave a
half-mutated profile around. The script's own `trap restore_admin EXIT`
is the primary restore mechanism, but chain-ordering is the
defense-in-depth.

#### Header comment (C5)

Top of `scripts/smoke-edge-roles.sh`:

    #!/usr/bin/env bash
    # scripts/smoke-edge-roles.sh — Spec 027 smoke for the send-invite-email
    # role gate. Asserts the ADMIN_ROLES Set in the edge function mirrors
    # `public.auth_is_privileged()` on the DB side — admin, master, and
    # super_admin all reach the post-gate handler.
    #
    # Sibling of scripts/smoke-edge.sh (which smokes fetch-breadbot-sales)
    # and scripts/smoke-rpc.sh (which smokes report_run RPC). Same pass/fail
    # output shape, same SKIP idiom for missing creds, same set -u + non-
    # zero-exit-on-first-failure contract.
    #
    # Convention: edge functions that role-gate must include super_admin in
    # ADMIN_ROLES. Reference: supabase/functions/delete-user/index.ts:19.
    # DB-side canonical check: public.auth_is_privileged().

### 5. Track D — prose snippets

#### D1. `CLAUDE.md` addition

Insert a new bullet **immediately after** the existing "Edge function
auth split" bullet at line 60 (under §"Conventions already in use").
The new bullet:

    - **Edge function role gates mirror `auth_is_privileged()`.** Edge
      functions that gate on caller role must define
      `const ADMIN_ROLES = new Set(["admin", "master", "super_admin"]);`
      and check membership in `requireAdminCaller()`. The set mirrors
      `public.auth_is_privileged()` (admin OR super-admin) on the DB
      side. Reference shape:
      [supabase/functions/delete-user/index.ts:19](supabase/functions/delete-user/index.ts).
      Spec 026 broadened DB policies and spec 027 closed the edge-function
      parity gap; a tenth omission is a regression.

Lines 1-60 and 62 onwards unchanged.

#### D2. `.claude/agents/security-auditor.md` addition

Insert a new bullet **under the existing "Edge functions — `verify_jwt`
and service-token validation" section** (lines 44-48), as a new
fourth bullet:

    - If the function does its own role-band check (`app_metadata.role`
      compared against an `ADMIN_ROLES` Set, or `profiles.role` compared
      similarly), verify the Set includes `super_admin`. The omission is
      the spec-026 / spec-027 pattern — `public.auth_is_privileged()` on
      the DB side is the canonical mirror (admin OR master OR super-admin).
      A new role-gated edge function whose ADMIN_ROLES Set lacks
      `super_admin` is **High** (silent privilege-denial for super-admins;
      not a critical-because-it-doesn't-grant-extra-access but does break
      legitimate flows). Reference correct shape:
      `supabase/functions/delete-user/index.ts:19`.

Lines 44-48 unchanged; the new bullet appends. Severity-labelling
(High vs Critical) is the security-auditor's call at audit time; the
guidance here is "this is the omission shape, here is how to severity-rank
it." High is correct per spec 026's review treatment of the exact
finding (`specs/026-post-025-cleanup/reviews/security-auditor.md:34`
labelled it Low, but in the context of a deliberately-deferred fix; a
NEW omission going forward should be High because the convention is
now documented and the architect-developer is on notice).

#### D3. Strict-additivity check

Both prose edits are append-only at the bullet level:
- CLAUDE.md gets one new bullet at line 61 (between the existing 60 and 61).
- security-auditor.md gets one new bullet at the end of the existing
  "Edge functions — `verify_jwt` and service-token validation" section.

No existing paragraphs are reworded. No "while I was here" cleanup.

### 6. Cross-cutting confirmations

- **Migrations:** none. No SQL files touched.
- **`src/lib/db.ts`:** untouched. No new helpers; the existing
  `inviteUser()` in `src/lib/auth.ts` already calls
  `callEdgeFunction('send-invite-email', ...)` correctly; only the
  server side was rejecting super-admins.
- **Frontend (`src/`):** no changes. No `useStore.ts` modifications,
  no Cmd UI section changes, no realtime channel touched. The bug is
  100% server-side.
- **Realtime publication:** not modified. The `invitations` table is
  not in `supabase_realtime` publication (verified in spec 026 audit
  at `reviews/security-auditor.md:114`); even if it were, this spec
  doesn't ALTER PUBLICATION. The realtime container does NOT need
  `docker restart` after this spec lands.
- **`app.json` slug:** untouched (project policy).
- **`db.json` / legacy stores:** untouched (frozen per CLAUDE.md).
- **`AdminScreens.tsx`:** untouched (frozen).
- **EAS / native build:** no native code changes.
- **Edge function deployment:** the source change lands in git via
  this spec. The actual prod cutover requires the user to run
  `supabase functions deploy send-invite-email` separately. This is
  the project's standard edge-function release flow (no auto-deploy
  on merge). Flag this in the release-coordinator handoff per the
  PM's note.

### 7. CI / test-coverage gate

Per spec 022 §Track 3, `npm run test:smoke` is **a manual-run gate**,
not a CI step (no `.github/workflows/test-smoke.yml` exists). The
new smoke script will run when:

1. A developer runs `npm run test:smoke` locally pre-PR (developer
   discipline).
2. A reviewer runs it during code review.
3. Future CI work (out of scope here) adds a `test:smoke` job.

The script's SKIP-on-no-local-stack contract means CI without a
local stack can still invoke it without failing — it just won't
exercise Arms 3 and 4. To exercise Arms 3 and 4 in CI, a future
job would need to spin up `supabase start` first. That is not
this spec's problem.

The other gates (`tsc --noEmit`, `typecheck:test`, `npm test`,
`npm run test:db`) all stay green by construction — no TypeScript,
no test source, no SQL changes in this spec.

### 8. Risks and tradeoffs

- **Smoke-script state mutation risk (LOW).** Arm 4 mutates
  `admin@local.test`'s profile.role briefly. If the script is
  interrupted between mutate and restore (e.g. `Ctrl-C`, killed),
  the local seed admin is left as a super-admin until the next
  `npm run dev:db:reset`. Mitigation: `trap restore_admin EXIT` in
  the script (runs on any exit path, including SIGINT). Worst case
  is a one-command recovery: `psql -c "update profiles set
  role='admin', brand_id='2a000000-0000-0000-0000-000000000001'
  where id = '11111111-1111-1111-1111-111111111111';"`.
- **Trigger ordering (LOW).** The `profiles_sync_role_to_jwt`
  trigger fires AFTER UPDATE OF role. The script must therefore
  re-login (not refresh a token) to pick up the new claim. The
  smoke-multi-brand precedent (`scripts/smoke-multi-brand.sh:69-71`)
  already does it this way.
- **Pre-existing risk surface unchanged.** The fix only ADDS
  `super_admin` to the allowed set; it does not change the gate
  for `admin` or `master`. Pre-fix vs post-fix truth table is in
  the spec's `## Handoff notes for downstream / For
  security-auditor` block and confirmed correct.
- **Inline duplication of the ADMIN_ROLES set across delete-user
  and send-invite-email (acknowledged, accepted).** Two-line cost
  vs the operational cost of a shared module that requires
  redeploying every importer on change. Revisit if a third occurrence
  lands.
- **The PM's Track D2 severity-label (High not Critical) is a
  deliberate softening (accepted).** A missing super_admin in
  ADMIN_ROLES does not grant unauthorized access — it BLOCKS
  legitimate super-admin access. That is a functional bug, not a
  privilege-escalation. The security-auditor still flags it; it
  just doesn't BLOCK the merge unless paired with a broken
  acceptance criterion. Test-engineer enforces the AC, security
  flags the omission.

### 9. Files to be modified

| Path | Track | Operation |
|------|-------|-----------|
| `supabase/functions/send-invite-email/index.ts` | A | EDIT — replace line 16 + add 4-line comment above |
| `scripts/smoke-edge-roles.sh` | C | NEW — ~150 lines following `smoke-rpc.sh` shape |
| `package.json` | C | EDIT — append `&& bash scripts/smoke-edge-roles.sh` to `test:smoke` |
| `CLAUDE.md` | D | EDIT — insert one bullet after line 60 |
| `.claude/agents/security-auditor.md` | D | EDIT — insert one bullet in the verify_jwt section |

5 files. Zero migrations. Zero realtime impact. Zero frontend impact.

## Handoff
next_agent: backend-developer
prompt: Implement against the design in this spec's `## Architect
  design` section. Five files total. Track A is one constant change
  + a 4-line comment. Track C is a new shell smoke script — read
  `scripts/smoke-rpc.sh` for the login pattern and
  `scripts/smoke-multi-brand.sh:65-71` for the super-admin
  promote/restore pattern. Track D is two strictly-additive prose
  bullets. After implementation, run `bash scripts/smoke-edge-roles.sh`
  yourself against a local stack to validate (boot via `npm run dev:db`
  if needed), then set Status: READY_FOR_REVIEW and list the five
  files under ## Files changed. Edge function deployment
  (`supabase functions deploy send-invite-email`) is a separate manual
  step the user runs post-merge — do NOT run it; flag it in your
  handoff so the release-coordinator surfaces it.
payload_paths:
  - specs/027-edge-fn-super-admin-parity/spec.md

## Files changed

- `supabase/functions/send-invite-email/index.ts` — Track A: added 4-line
  comment above the `ADMIN_ROLES` Set and appended `"super_admin"` to the
  set. Lines 17-96 byte-for-byte preserved.
- `scripts/smoke-edge-roles.sh` — Track C: new four-arm shell smoke
  asserting the role gate. Arm 4 promotes `admin@local.test` to
  super_admin, re-logs-in to mint a fresh JWT, asserts the gate passes,
  and restores via `trap restore_admin EXIT`. SKIP idiom for missing
  local stack creds matches `smoke-edge.sh:92`.
- `package.json` — Track C: chained `&& bash scripts/smoke-edge-roles.sh`
  onto `test:smoke` so the new arm runs last (defense-in-depth for the
  state-mutation: any earlier failure short-circuits before the
  promote/restore dance).
- `CLAUDE.md` — Track D1: inserted one new bullet under "Conventions
  already in use" immediately after the existing "Edge function auth
  split" bullet, documenting the `ADMIN_ROLES` mirror convention.
  Strictly additive — surrounding bullets unchanged.
- `.claude/agents/security-auditor.md` — Track D2: appended one bullet
  to the existing "Edge functions — `verify_jwt` and service-token
  validation" section, directing future audits to check
  `ADMIN_ROLES` for `super_admin` inclusion. Severity guidance: **High**.
  Strictly additive — surrounding bullets unchanged.
- `specs/027-edge-fn-super-admin-parity/spec.md` — Status: READY_FOR_BUILD
  → READY_FOR_REVIEW + this file list.

### Verification gates run

- `npx tsc --noEmit` → exit 0
- `npm run typecheck:test` → exit 0
- `npm test -- --ci` → 17 tests across 3 suites all PASS
- `npm run test:db` → 14/14 DB test files PASS
- `bash scripts/smoke-edge-roles.sh` (local stack) → all four arms PASS;
  trap restored `admin@local.test` to admin role + brand A
- `npm run test:smoke` (chained: smoke-edge + smoke-rpc + smoke-edge-roles)
  → all PASS; Arms 3-4 of smoke-edge-roles required local stack (worked
  here) and ran cleanly

### Post-merge deployment note

This spec lands the SOURCE change in git only. Edge function deployment
is a manual step the user runs separately:

    supabase functions deploy send-invite-email

The fix is not live in prod until that command runs. Flag in the
release proposal.
