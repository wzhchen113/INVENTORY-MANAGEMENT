# Spec 095: Username login

Status: READY_FOR_REVIEW

## User story
As a 2AM PROJECT user (admin or staff), I want to sign in with EITHER my username
OR my email address (plus password) so that I can log in without having to
remember or type the exact email on file, while existing users who only know
their email continue to work unchanged.

## Background (current state — investigated)
- The app has a **single shared sign-in portal**, `src/screens/LoginScreen.tsx`
  (spec 063 folded the former staff app in; staff has no separate login UI).
  Login branches on `result.user.role` AFTER sign-in succeeds. So a
  username-login change touches one client surface, not two.
- `signIn(email, password)` in `src/lib/auth.ts` calls
  `supabase.auth.signInWithPassword({ email, password })`. **Supabase has no
  native username auth** — `signInWithPassword` requires an email (or phone).
  Username login must therefore resolve username → email server-side, then sign
  in with the resolved email.
- The `profiles` table has **no `username` column** today
  (`supabase/migrations/20260405000759_init_schema.sql`). `name` exists but is a
  display name and is NOT unique.
- Email is **not stored on `profiles`** — it lives in `auth.users`, and the
  UsersSection currently infers it from the `invitations` table. So a
  username→email resolver must reach into `auth.users`, which the anon/client
  role cannot read. This drives the resolver toward a dedicated edge function
  (service-token bearer, `verify_jwt = false`, same pattern as `staff-*` /
  `pwa-catalog`) — see "Resolution mechanism" below.
- User creation is invite-based: `inviteUser` → `registerInvitedUser` in
  `src/lib/auth.ts`, with `send-invite-email` edge function. Username assignment
  hooks into this flow plus a one-time backfill — see below.

## Acceptance criteria

### Login (the shared portal)
- [ ] On `src/screens/LoginScreen.tsx`, a user can enter EITHER a username OR an
      email address in a single identifier field (relabeled to "Username or
      email"), plus a password, and authenticate successfully.
- [ ] When the entered identifier contains an `@` it is treated as an email and
      flows through the existing `signInWithPassword({ email, password })` path
      unchanged (existing-users-keep-email path).
- [ ] When the entered identifier does NOT contain an `@` it is treated as a
      username, resolved to an email server-side, then signed in with the
      resolved email.
- [ ] Successful sign-in ends in the SAME post-login state as today: role branch
      sends admin → AdminStack, staff → StaffStack (no change to the post-login
      routing).
- [ ] Invalid username, unknown email, and wrong password all return ONE
      indistinguishable generic error string (e.g. "Invalid login. Check your
      username/email and password."). The error MUST NOT reveal whether a
      username or email exists (no enumeration oracle).
- [ ] An existing user who has never typed a username (uses their email) signs in
      with no behavior change vs. before this spec.

### Username column + constraints (migration)
- [ ] A new `profiles.username` column exists.
- [ ] Usernames are **globally unique across all brands**, enforced
      case-insensitively. Implemented as a `CITEXT` column with a UNIQUE
      constraint, OR a UNIQUE index on `lower(username)` — architect's choice;
      compare/store case-folded either way.
- [ ] A `CHECK` constraint (or equivalent validation) enforces: length 3–20
      characters; allowed characters are letters, numbers, underscore (`_`), and
      dot (`.`) only.
- [ ] The column is nullable to allow the existing-users path, but after the
      backfill (below) every existing row has a non-null value.

### Backfill (one-time, deterministic, collision-safe)
- [ ] A one-time backfill assigns a username to every existing user whose
      `username` is currently NULL. The backfill is deterministic: re-running it
      produces the same result and never overwrites an already-set username.
- [ ] Backfill algorithm — derive a candidate from the user's email local-part
      (everything before `@`), then:
      1. Lowercase it.
      2. Strip/replace any character that is not a letter, number, `_`, or `.`
         (replace with `_` or remove — architect picks one and documents it; the
         result must contain only allowed characters).
      3. Truncate to the 20-character maximum.
- [ ] Minimum-length edge case: if the sanitized candidate is shorter than 3
      characters, pad it deterministically (e.g. append `_` or zero-pad with
      digits) up to 3 characters before collision handling.
- [ ] Empty-after-sanitization edge case: if the candidate collapses to empty
      (e.g. local-part was all disallowed characters, or no email on file), fall
      back to a deterministic generated handle (e.g. `user_<short-stable-token>`
      derived from the user id) that satisfies the 3–20 + allowed-chars rules.
- [ ] Collision handling: if the candidate is already taken (case-insensitively),
      append the smallest numeric suffix that makes it unique (`sam` → `sam1` →
      `sam2` …), re-truncating to 20 chars if the suffix pushes it over.
- [ ] After the backfill runs, `SELECT count(*) FROM profiles WHERE username IS
      NULL` returns 0, and all usernames satisfy the format + uniqueness
      constraints.

### Admin assignment (invite / user creation)
- [ ] The admin invite / user-creation flow (UsersSection / InviteUserDrawer
      under `src/screens/cmd/sections/`) gains a username input so admins assign
      a username when inviting/creating a user going forward.
- [ ] The admin UI validates the username client-side against the same rules
      (3–20, allowed chars) and surfaces a clear error when the chosen username
      is already taken (case-insensitive), distinct from the generic login error
      (this is an authenticated admin action, not the anonymous login oracle).
- [ ] The assigned username is persisted to `profiles.username` for the new user
      as part of the existing invite/registration flow.

### Resolution mechanism
- [ ] Username → email resolution happens server-side and the mapping is NOT
      exposed to the unauthenticated client beyond a single sign-in attempt (no
      bulk/list endpoint).
- [ ] **Recommended (not mandated):** a dedicated edge function using the
      service-token bearer pattern (`verify_jwt = false`, validates the service
      token itself, mirroring `staff-*` / `pwa-catalog`), so `auth.users` reads
      and enumeration stay controlled server-side. The architect MAY instead use
      a `SECURITY DEFINER` RPC if it can satisfy the no-oracle + controlled-reads
      requirements; the choice is the architect's, but the edge-function path is
      the PM-recommended default.
- [ ] Whichever path is chosen, edge-function role/auth conventions from CLAUDE.md
      apply (if an edge function: `config.toml` entry, service-token validation,
      `callEdgeFunction` envelope on the client side per the auth.ts convention).

## In scope
- New `profiles.username` column + case-insensitive global uniqueness constraint
  + format CHECK (migration).
- One-time deterministic, collision-safe backfill of usernames for all existing
  users (migration or migration-invoked routine).
- Server-side username → email resolution mechanism (recommended: dedicated edge
  function with service-token bearer; RPC allowed at architect's discretion).
- `src/screens/LoginScreen.tsx`: relabel the identifier field to accept username
  OR email; route to the resolver when the value has no `@`.
- `signIn()` in `src/lib/auth.ts`: branch on `@`-presence; resolve username →
  email when needed, then call `signInWithPassword` with the resolved email;
  collapse all failures into one generic error.
- Admin invite / user-creation UI (UsersSection / InviteUserDrawer) gains a
  username field; assignment persisted via the existing invite/registration flow.

## Out of scope (explicitly)
- **Phone-number login.** Not requested.
- **Social / SSO login.** Not requested.
- **Username-based password reset / account recovery.** Recovery stays
  email-based (Supabase `resetPasswordForEmail`). Login may use a username, but
  there is no username-based recovery in this spec. Rationale: recovery must hit
  a verified email channel regardless; adding a username path is extra surface
  with no user benefit here.
- **Self-service username changes / a profile settings screen for usernames.**
  Usernames are admin-set (at invite/creation) plus the one-time backfill.
  User-editable usernames are a possible follow-up, not this spec.
- **Forced migration of existing users off email login.** Existing users keep
  using email; nothing forces them to adopt or type their username.
- **Changing the customer PWA login** (sibling app, separate repo).
- **Migrating the `src/screens/staff/` auth code into `db.ts`.** Pre-existing
  carve-out (spec 063); not part of this change.
- **Changing `app.json` slug.** Load-bearing value; untouched (CLAUDE.md).

## Open questions resolved
- Q1 (either/or vs replace): **Either/or.** Login accepts EITHER username OR
  email in the same field. No forced migration of existing email-login users.
- Q2 (which surfaces): **The one shared login UI** (`src/screens/LoginScreen.tsx`)
  for all roles (admin + staff). No split.
- Q3 (where usernames come from): **Admin sets + backfill all.** Admins assign
  usernames at invite/creation going forward, AND a one-time backfill assigns a
  username to every existing user now. Backfill algorithm specified in
  Acceptance criteria (email local-part → lowercase → sanitize → truncate →
  pad-if-short → fallback-if-empty → numeric suffix on collision).
- Q4 (uniqueness + format): **Global, case-insensitive, 3–20.** Globally unique
  across all brands, stored/compared case-folded (CITEXT or UNIQUE on
  `lower(username)`), 3–20 chars, allowed chars = letters / numbers / `_` / `.`.
  Reserved-name blocking (e.g. `admin`, `root`) is a SHOULD-HAVE, not a blocker
  — architect may add a small reserved list as a CHECK or validation step.
- Q5 (resolution mechanism): **Dedicated edge function recommended** (service-
  token pattern like `staff-*`), to keep enumeration controlled. Final
  RPC-vs-edge-function decision is the architect's; edge function is the
  recommended default, not a hard requirement. **Enumeration-oracle risk is
  flagged for the security-auditor** — login error messages and the resolver
  response MUST NOT reveal whether a username (or email) exists.
- Q6 (password reset): **Stay email-based.** Recovery remains Supabase email
  recovery; no username-based recovery in this spec (see Out of scope).

## Dependencies
- New migration: `profiles.username` column + case-insensitive global UNIQUE
  (CITEXT or UNIQUE on `lower(username)`) + format CHECK (3–20, allowed chars).
- Backfill routine (migration or migration-invoked) for existing users, per the
  algorithm in Acceptance criteria.
- Resolver mechanism: if an edge function, a new function under
  `supabase/functions/` plus a `config.toml` entry with `verify_jwt = false` and
  service-token validation, mirroring `staff-*` / `pwa-catalog`; if an RPC, a
  `SECURITY DEFINER` function that satisfies the no-oracle + controlled-reads
  requirements.
- Touches `src/lib/auth.ts` (`signIn` branch + resolver call via
  `callEdgeFunction`; `inviteUser` / `registerInvitedUser` for assignment).
- Touches `src/screens/LoginScreen.tsx` (identifier field relabel + routing).
- Touches the admin Users / Invite UI under `src/screens/cmd/sections/`
  (UsersSection / InviteUserDrawer) for username assignment.
- `send-invite-email` edge function only if a username needs to appear in the
  invite email body (HTML-escape per CLAUDE.md if so).

## Project-specific notes
- Cmd UI section / legacy: admin assignment lands in the existing Users / Invite
  UI under `src/screens/cmd/sections/`. No legacy surface.
- Per-store or admin-global: username is a per-user identity attribute on
  `profiles`; uniqueness scope is **global across all brands** (resolved Q4).
- Realtime channels touched: none (login is pre-session; username assignment is
  an admin action on `profiles` and does not require a live cross-client push in
  v1).
- Migrations needed: yes — `profiles.username` column + unique index/constraint +
  format CHECK + one-time backfill.
- Edge functions touched: likely one new resolver function (recommended path);
  possibly `send-invite-email` if usernames are surfaced in invites.
- Web/native scope: both (shared LoginScreen ships to Vercel web + EAS native;
  admin invite UI is web/Cmd UI).
- Tests (spec 022 three-track model):
  - **pgTAP** — username case-insensitive uniqueness + format CHECK; backfill
    determinism / collision-safety / edge cases (short, empty-after-sanitize);
    any `SECURITY DEFINER` resolver if that path is chosen.
  - **jest** — `signIn` routing logic (`@`-branch, generic-error collapse).
  - **shell smoke** — the resolver edge function if one is added.
- Security: **username-enumeration oracle** is the headline risk. Login error
  messages and the resolver response must be indistinguishable across
  "no such username", "unknown email", and "wrong password". Flagged for the
  security-auditor. Consider rate limiting on the resolver. (CLAUDE.md edge-
  function auth/role/escape conventions apply to any new function.)

## Backend design

Authored by backend-architect (design mode). Investigated: `src/lib/auth.ts`
(signIn / inviteUser / registerInvitedUser / callEdgeFunction / fetchProfile),
`supabase/config.toml` (verify_jwt split), the `profiles` table
(`20260405000759_init_schema.sql:20`), the profiles SELECT/UPDATE/DELETE RLS
sweep (`20260517060000_profiles_rls_sweep.sql`,
`20260520010000_legacy_permissive_policy_dropout.sql`), the live service-token
pattern (`supabase/functions/pwa-catalog/index.ts:56` `checkAuth`), the
deprecated staff-* functions (HTTP 410 stubs — NOT a copy source), the
invitation flow (`get_pending_invitation` latest def in
`20260528020000_staff_brand_id_backfill.sql`; `consume_invitation` in
`20260531000000`), and `LoginScreen.tsx`.

### Delegated decisions — final calls

**(a) CITEXT vs UNIQUE on lower(username) → UNIQUE index on `lower(username)`.**
`citext` is NOT enabled anywhere in this codebase (no `create extension citext`
in any of the 88 migrations; `list_extensions` shows only `uuid-ossp`, `pg_cron`,
`pg_net`). Enabling a new extension on prod is heavier rollout surface than we
need, and `citext`'s collation semantics interact subtly with `LIKE`/index
planning. We already have a precedent for case-folded comparison via `lower()`
everywhere in this codebase (`lower(email)` throughout `auth.ts`,
`get_pending_invitation`, `consume_invitation`). So: store `username text`,
fold-on-write at every writer, and enforce uniqueness with
`CREATE UNIQUE INDEX profiles_username_lower_key ON profiles (lower(username))`.
Format is enforced by a CHECK on the raw column. Justification: reuses the
established `lower()` idiom, no extension dependency, no prod extension-enable
step.

**(b) Resolver mechanism → dedicated service-token edge function**
(`username-resolve`, `verify_jwt = false`), per the PM recommendation. An RPC was
considered and rejected: a SECURITY DEFINER RPC granted to `anon` is directly
callable over PostgREST by anyone with the (public) anon key, giving an
unauthenticated attacker an unmetered, scriptable oracle endpoint with no
shared-secret gate. The edge function adds a `USERNAME_RESOLVE_SERVICE_TOKEN`
bearer (mirroring `pwa-catalog`'s `checkAuth`) so only our own client — which
ships the token — can call it, plus a single choke point for rate-limiting and
uniform-response shaping. The function reads `auth.users.email` via the
service-role client (anon/client roles cannot read `auth.users` — the same
constraint that drives `get_pending_invitation` to SECURITY DEFINER).

  Response contract (anti-oracle — see (b-contract) below): the resolver
  **always returns HTTP 200** with `{ "email": string | null }`. `null` for
  "no such username" AND for "username maps to a user with no resolvable email."
  It NEVER returns 404/400 to distinguish existence. The client then calls
  `signInWithPassword` with the resolved email (or a throwaway non-existent
  email when `null`) and collapses every failure into ONE generic string. The
  resolver itself reveals nothing actionable: a `null` and a real email are
  indistinguishable to the attacker UNLESS they also have the correct password,
  which is the same bar as email login. Note: returning a real email for a known
  username IS a minor email-disclosure surface, but it is gated behind the
  service token (not anon-reachable) and is the irreducible cost of mapping
  username→email server-side. Flagged for security-auditor with the mitigations
  below.

**(c) Backfill sanitize strategy.** Deterministic, written as a single data
migration (see Data model). Algorithm per existing user (NULL username only):
  1. `local := lower(split_part(email, '@', 1))` (email read from `auth.users`;
     migration runs as postgres → can read it, same pattern as
     `staff_brand_id_backfill` and `consume_invitation_sets_profile_id`).
  2. **Sanitize by REMOVAL** (not replacement): strip every char not in
     `[a-z0-9_.]` via `regexp_replace(local, '[^a-z0-9_.]', '', 'g')`.
     Decision: remove rather than replace-with-`_`, because replacement on a
     local-part like `a+b@…` would yield `a_b` (a plausible-but-wrong handle and
     a needless collision magnet); removal yields `ab`, which is closer to the
     human's intent and shorter. Documented here as the chosen path per AC.
  3. Truncate to 20: `left(candidate, 20)`.
  4. **Pad-if-short (<3):** right-pad with `0` to length 3:
     `rpad(candidate, 3, '0')` (e.g. `ab` → `ab0`, `x` → `x00`). Deterministic,
     stays within allowed chars.
  5. **Empty-after-sanitize / no email fallback:** if candidate is empty,
     `candidate := 'user_' || left(replace(id::text, '-', ''), 8)` (id is the
     profile UUID — globally stable, always satisfies 3–20 + allowed chars; `_`
     and hex are all allowed; total length 13).
  6. **Collision suffix:** check `lower(candidate)` against already-assigned
     usernames (case-insensitive). If taken, append the smallest integer `n`
     starting at 1 (`sam` → `sam1` → `sam2` …), re-truncating the BASE to
     `20 - len(suffix)` before appending so the result never exceeds 20. Loop
     until free. Implemented in a `plpgsql DO` block that iterates `profiles`
     ordered by `created_at, id` (stable order → deterministic suffix
     assignment) and accumulates assigned names in a temp set so re-running
     produces identical output and never overwrites a non-NULL username
     (`WHERE username IS NULL` guard).

  Backfill is a **data migration** (a `DO $$ … $$` block in the same migration
  file that adds the column), NOT a one-off script — repo convention is that
  schema + its backfill ship together and re-run idempotently (cf.
  `staff_brand_id_backfill`, `invitations_brand_id_backfill`,
  `consume_invitation_sets_profile_id`). The `db-migrations-applied` gate then
  flags the new local migration; `npx supabase db push --linked` post-merge.

**(d) Reserved-name list (should-have) → YES, small list, enforced in the
shared validator (not a DB CHECK).** Reserved set:
`{admin, root, master, superadmin, super_admin, support, system, null,
undefined, me, owner}`. Enforced in the TS validator (client + admin UI) AND
re-checked in the resolver/assignment path is unnecessary (assignment is an
authenticated admin action; the validator runs there). NOT a DB CHECK because a
CHECK with a hardcoded IN-list is awkward to evolve and the backfill could
legitimately produce e.g. `admin` from `admin@2am.com` — the backfill is exempt
from the reserved list (it must not fail; a reserved-derived backfilled name is
acceptable and admins can reassign later). So reserved-name blocking applies to
forward admin assignment only, surfaced as a distinct validation error.

### Data model changes

Migration: `supabase/migrations/20260607120000_profiles_username.sql` (additive;
tail-append after `20260602120000`). Single file, three parts:

1. **Column (additive, nullable):**
   `ALTER TABLE public.profiles ADD COLUMN username text;`
2. **Constraints:**
   - Format CHECK (nullable-tolerant):
     `ALTER TABLE public.profiles ADD CONSTRAINT profiles_username_format CHECK (username IS NULL OR (char_length(username) BETWEEN 3 AND 20 AND username ~ '^[A-Za-z0-9_.]+$'));`
   - Case-insensitive UNIQUE:
     `CREATE UNIQUE INDEX profiles_username_lower_key ON public.profiles (lower(username));`
     (NULLs are not indexed-as-equal by btree → multiple NULLs allowed pre/post
     backfill; partial `WHERE username IS NOT NULL` not required but may be added
     for clarity.)
3. **Backfill** `DO $$ … $$` block per algorithm (c). Reads `auth.users.email`
   joined on `profiles.id = auth.users.id`. Post-block assertion:
   `IF EXISTS (SELECT 1 FROM profiles WHERE username IS NULL) THEN RAISE EXCEPTION …`
   to satisfy AC "count NULL = 0".

Also add `username` to the **invitations** carrier so admin assignment threads
through the invite flow:
   `ALTER TABLE public.invitations ADD COLUMN username text;` (nullable; same
   format CHECK shape but NO uniqueness on invitations — uniqueness is enforced
   on `profiles` at register time; a pre-flight check in the admin UI surfaces
   collisions early). Add it in the same migration.

Rollout safety: fully additive (new column + new index + new CHECK, all on a
table the app already reads with `select *`). No destructive drops. Rollback =
drop the column/index/constraint; git holds the prior shape. No down migration
(repo convention).

### RLS impact

No new tables. The `username` column rides on existing `profiles` policies — no
new policies needed, but the visibility question must be answered explicitly:

- **Can a user read others' usernames?** Under the spec-043 SELECT policy
  (`20260517060000_profiles_rls_sweep.sql`), a caller sees a profile row iff
  `auth_is_privileged() AND auth_can_see_brand(brand_id)` OR `id = auth.uid()`.
  So: a user reads their OWN username; admin/master read usernames within their
  brand; super_admin reads all. **This is the desired posture** — username is no
  more sensitive than `name`/`initials` which already ride this policy, and the
  admin Users screen needs to display/assign usernames within-brand. We do NOT
  add username to any anon-readable path. Crucially, the username→email RESOLVER
  does NOT use these policies — it runs service-role inside the edge function,
  which is why the policy staying brand-scoped does not break cross-brand login.
- **No new permissive policy** is introduced, so the spec-051/053 permissive-
  policy lint (`permissive_policy_lint.test.sql`) is not triggered.
- **invitations.username** rides the existing admin-only invitation policies
  (`20260424211733_security_fixes.sql:42-57`) — read/insert/update gated to
  admin/master. `get_pending_invitation` (SECURITY DEFINER) is the anon read
  path and must add `username` to its return set (below).

### API contract

**Resolver — new edge function `username-resolve`** (chosen over RPC, see (b)):
- Request: `POST /functions/v1/username-resolve`
  `Authorization: Bearer ${USERNAME_RESOLVE_SERVICE_TOKEN}`,
  body `{ "username": string }`.
- Response: ALWAYS `200 { "email": string | null }` for any well-formed request
  (found → email; not-found / no-email / malformed-but-present username → null).
  `401 { "error": "invalid service token" }` only for a bad/missing service
  token. `500 { "error": "USERNAME_RESOLVE_SERVICE_TOKEN unset on server" }` if
  the secret is missing (mirrors `pwa-catalog`).
- Error cases: the function NEVER distinguishes "no such username" from "found"
  at the HTTP level — both are 200. Internal lookup uses the service-role client:
  `SELECT id FROM profiles WHERE lower(username) = lower($1) LIMIT 1`, then
  `auth.admin.getUserById(id)` (or a direct `auth.users` read via service role)
  for the email. Any internal failure → `200 { email: null }` (fail-closed to
  the generic login error, NOT 500, so a transient DB blip is indistinguishable
  from not-found and does not become an oracle).
- Anti-oracle mitigations to flag for security-auditor: (1) service-token gate
  keeps it off the anon surface; (2) uniform 200 shape; (3) recommend a
  light per-IP rate limit (Supabase edge has no built-in — a simple in-memory or
  Deno KV counter, or rely on GoTrue's `sign_in_sign_ups` rate limit downstream
  since every resolve is immediately followed by a sign-in attempt); (4)
  constant-ish work — do not early-return faster on not-found in a way that
  leaks timing (best-effort; documented as residual).

**`get_pending_invitation` RPC — modify** (latest def in
`20260528020000_staff_brand_id_backfill.sql`): add `username text` to the
`RETURNS TABLE (…)` and the inner SELECT so `registerInvitedUser` can stamp it.
CREATE OR REPLACE, preserve the existing grant (`anon, authenticated`), preserve
`resolved_brand_id` logic. Backward-compatible (TS read is loose).

**`consume_invitation`** — no change (it only flips `used`/`profile_id`).

**Username assignment** stays PostgREST table writes (no new RPC): the admin UI
inserts `invitations.username` via the existing `inviteUser` insert;
`registerInvitedUser` writes `profiles.username` in its existing profile INSERT.
The `profiles_username_lower_key` UNIQUE index is the server-side authority on
collision; PostgREST surfaces a 23505 which the client maps to "username taken."

### Edge function changes

- **New: `username-resolve`** — `verify_jwt = false` (add
  `[functions.username-resolve]` block to `config.toml` mirroring
  `[functions.pwa-catalog]`). Service-token validation strategy: copy the
  `checkAuth(req)` shape from `pwa-catalog/index.ts:56` verbatim against a NEW
  secret `USERNAME_RESOLVE_SERVICE_TOKEN` (do NOT reuse `PWA_SERVICE_TOKEN` —
  different blast radius). CORS headers identical to pwa-catalog. Uses the
  service-role client. No HTML output → no `escapeHtml` needed. No
  `requireAdminCaller`/`ADMIN_ROLES` gate — this is a pre-auth, service-token
  endpoint, not a role-gated one. New secret must be set: locally in
  `supabase/functions/.env` (or `edge_runtime.secrets`), in prod via the
  dashboard/`supabase secrets set`, AND `EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN` on
  the client build (Vercel + EAS env) — flag as a deploy step.
- **`send-invite-email`** — OPTIONAL, only if product wants the username in the
  invite email body. Default: do NOT surface it (matches current template which
  omits brand). If added later, the new value MUST go through the inline
  `escapeHtml()` helper per CLAUDE.md (it's interpolated into an HTML body).
- The deprecated `staff-*` functions are NOT a copy source (they are 410 stubs);
  use `pwa-catalog` as the reference shape.

### `src/lib/db.ts` surface

Username assignment writes go through the existing `inviteUser` /
`registerInvitedUser` in `auth.ts` (documented carve-out — auth path), so no new
`db.ts` write helper is strictly required for the invite flow. Two additions:

- **`fetchAllUsers` / `fetchBrandAdmins` mapping** — add `username:
  p.username ?? null` to the `User` mapper rows in `auth.ts:fetchAllUsers` and
  the parallel `db.ts:fetchBrandAdmins`, plus `username` on `fetchProfile`'s
  `User` build, so the admin Users screen can display the assigned username.
  snake_case `username` → camelCase `username` (no rename; add to the `User`
  type in `src/types`).
- **Resolver call lives in `auth.ts`, not `db.ts`** — it goes through a raw
  `fetch` with the service-token bearer (NOT `callEdgeFunction`, which attaches
  the user's session JWT — there is no session at login time). This is a NEW
  pattern justified explicitly: `callEdgeFunction` short-circuits with "Not
  authenticated" when there's no session (`auth.ts:198`), which is exactly the
  pre-login state. The staff path already has service-token fetches; this is the
  admin/shared-portal analogue. Keep it in `auth.ts` (auth-path carve-out)
  alongside `signIn`. Signature:
  ```ts
  // src/lib/auth.ts
  async function resolveUsernameToEmail(username: string): Promise<string | null>
  ```
  Returns the email or `null` (never throws; network/any error → `null` →
  generic login failure downstream).

  `signIn` signature stays `signIn(identifier: string, password: string)`:
  ```ts
  export async function signIn(identifier: string, password: string): Promise<AuthResult> {
    const id = identifier.trim();
    const email = id.includes('@') ? id : (await resolveUsernameToEmail(id));
    if (!email) return { user: null, error: GENERIC_LOGIN_ERROR };
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) return { user: null, error: GENERIC_LOGIN_ERROR };
    return await fetchProfile(data.user.id);
  }
  ```
  `GENERIC_LOGIN_ERROR = 'Invalid login. Check your username/email and
  password.'` — the SINGLE error string for unknown username, unknown email, AND
  wrong password (AC: no enumeration oracle). NOTE this changes the existing
  behavior of surfacing `error.message` verbatim for the email path — that is
  intentional and required by AC (today's email path leaks "Invalid login
  credentials" vs other GoTrue strings; collapsing to one string is the spec).

### Realtime impact

None. Login is pre-session (no channel subscribed yet). Username assignment is
an admin write on `profiles`; the spec explicitly scopes realtime cross-client
push OUT for v1 (project-specific notes). `profiles` is not in the
`supabase_realtime` publication for username purposes here, and **this migration
does NOT alter publication membership** → the realtime-publication restart
ritual (`docker restart supabase_realtime_imr-inventory`) does NOT apply. Called
out explicitly so the developer does not add `profiles` to the publication.

### Frontend store impact

- **`LoginScreen.tsx`** — relabel the identifier field "Username or email",
  remove `keyboardType="email-address"` (or keep `default`), keep
  `autoCapitalize="none"`, update the empty-field guard copy. Call
  `signIn(identifier.trim(), password)`. The role-branch post-login block
  (staff vs admin) is UNCHANGED. The optimistic-then-revert /
  `notifyBackendError` pattern does NOT apply here — login is a blocking,
  awaited call with inline error display, not an optimistic store mutation.
- **Admin Users/Invite UI** (`src/screens/cmd/sections/` — UsersSection /
  InviteUserDrawer) — add a username input + the shared client-side validator
  (3–20, `[A-Za-z0-9_.]`, reserved-list). Thread `username` into the
  `InviteUserOptions` (`auth.ts:254`) and the `invitations` insert. Surface the
  23505 unique-violation as "username taken" (distinct from the generic login
  error — this is an authenticated admin action). This DOES use the existing
  admin store slice for the users list refresh after assignment.
- **Shared validator** — add `src/lib/usernameValidation.ts` (pure, TS) used by
  both the admin UI and any client-side pre-check, mirroring the DB CHECK +
  reserved list. (The TS↔SQL parity is a code-review checkpoint, like
  `escapeHtml.ts`.)
- **`User` type** (`src/types`) — add `username?: string | null`.

### Risks and tradeoffs (explicit)

- **Migration ordering.** `20260607120000` tail-appends cleanly after
  `20260602120000`. The `get_pending_invitation` CREATE OR REPLACE must carry
  forward the spec-069 `resolved_brand_id` body — do NOT regress to the older
  `20260424211733` shape. Put the RPC redefinition in the SAME new migration so
  it lands atomically with the column.
- **Backfill performance on the 286 KB seed / prod.** The backfill is O(n) over
  profiles with a per-row collision loop. Prod has a handful of users (spec 069
  noted ~1 staff user; total profiles is small — restaurant staff, not
  consumers). Negligible. The `lower()` UNIQUE index build is trivial at this
  row count. No CONCURRENTLY needed.
- **RLS gap — none introduced**, but confirm the resolver's service-role read of
  `auth.users` is the ONLY cross-brand username→email path; the brand-scoped
  profiles SELECT policy is intentionally NOT widened. A future "user-editable
  username" spec (out of scope) would need a self-UPDATE arm + uniqueness
  re-check.
- **Enumeration oracle (headline risk, for security-auditor).** Residual: the
  resolver returns a real email to any holder of the service token for a known
  username. Mitigated by token gate + uniform 200 + recommended rate limit. The
  LOGIN error is fully collapsed. The ADMIN assignment path intentionally DOES
  reveal "username taken" — acceptable, it is authenticated and brand-scoped.
- **Edge function cold-start.** `username-resolve` adds one cold-start hop to
  username (not email) logins. Email logins are unaffected (no resolver call).
  Acceptable; same cold-start profile as `pwa-catalog`.
- **New-secret deploy dependency.** Username login is BROKEN until
  `USERNAME_RESOLVE_SERVICE_TOKEN` (server) + `EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN`
  (client) are set in all environments. Email login keeps working regardless.
  Flag prominently in the PR description as a manual deploy step (dashboard
  secret + Vercel/EAS env), analogous to the spec-085 dashboard recovery steps.
- **Behavior change to email login error string.** Collapsing GoTrue's verbatim
  message into `GENERIC_LOGIN_ERROR` is required by AC but is a visible UX change
  for existing email users (less specific error). Intentional.

### Test surface (spec 022 three-track)

- **pgTAP** — (1) `profiles_username_format` CHECK rejects <3, >20, and
  disallowed chars, accepts NULL; (2) `profiles_username_lower_key` rejects
  case-insensitive duplicates (`Sam` vs `sam`); (3) backfill determinism:
  re-running the DO block produces identical usernames and zero NULLs, with
  collision-suffix, short-pad, and empty-fallback fixtures; (4)
  `get_pending_invitation` returns the new `username` column.
- **jest** — `signIn` routing: `@`-branch uses email path; no-`@` branch calls
  `resolveUsernameToEmail`; all three failure modes (null resolve, wrong
  password, unknown email) collapse to `GENERIC_LOGIN_ERROR`. Plus
  `usernameValidation.ts` unit tests (length, charset, reserved list).
- **shell smoke** — `username-resolve` edge function: 401 on bad token, 200
  `{email:null}` on unknown username, 200 `{email:"…"}` on known username (uses
  the local stack + a seeded user).

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec. backend-developer owns the
  migration (`20260607120000_profiles_username.sql`: column + format CHECK +
  lower() UNIQUE index + deterministic backfill + `invitations.username` column
  + `get_pending_invitation` redefinition carrying forward spec-069
  resolved_brand_id), the new `username-resolve` edge function (verify_jwt=false,
  service-token gate copied from pwa-catalog, service-role auth.users read,
  uniform-200 anti-oracle contract) + its config.toml entry, and the pgTAP +
  shell smoke tests. frontend-developer owns LoginScreen (relabel + signIn
  branch), `signIn`/`resolveUsernameToEmail`/`GENERIC_LOGIN_ERROR` in auth.ts,
  the shared `usernameValidation.ts`, the admin Users/Invite UI username field +
  reserved-list + "username taken" handling, the `User` type + db.ts/auth.ts
  mappers, and jest tests. Coordinate on the auth.ts seam (resolver call +
  signIn branch are frontend-owned but call the backend function). Do NOT alter
  the supabase_realtime publication. Flag the new secret
  (USERNAME_RESOLVE_SERVICE_TOKEN / EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN) as a
  manual deploy step. After implementation, set Status: READY_FOR_REVIEW and
  list files changed under ## Files changed.
payload_paths:
  - specs/095-username-login.md

## Files changed (frontend — frontend-developer)

Status note: NOT setting `Status:` — the backend-developer is implementing the
migration / `username-resolve` edge function / config.toml / pgTAP + smoke
tests in parallel. Frontend work below is complete and verified; the combined
slice should move to READY_FOR_REVIEW once the backend half lands.

- `src/lib/usernameValidation.ts` (NEW) — shared client-side validator: format
  (3–20, `[A-Za-z0-9_.]`) + reserved-name list (`admin`, `root`, `master`,
  `superadmin`, `super_admin`, `support`, `system`, `null`, `undefined`, `me`,
  `owner`) per spec §(d). Exports `validateUsername`, `isValidUsername`,
  `RESERVED_USERNAMES`, length/regex constants. TS mirror of the DB CHECK.
- `src/lib/auth.ts` — added `GENERIC_LOGIN_ERROR`, `resolveUsernameToEmail`
  (RAW service-token fetch to `username-resolve`, fail-closed → null on any
  error), rewrote `signIn(identifier, password)` to branch on `@` and collapse
  ALL failures to the one generic string; threaded `username` into
  `InviteUserOptions`, the `inviteUser` invitations insert (lower-cased on
  write), `registerInvitedUser`'s profile insert, `fetchProfile`'s User build,
  and the `fetchAllUsers` mapper.
- `src/screens/LoginScreen.tsx` — relabeled the identifier field to
  "Username or email", renamed the state to `identifier`, dropped
  `keyboardType="email-address"` (added `autoCorrect={false}`), updated the
  empty-field guard copy, call `signIn(identifier.trim(), password)`. Post-login
  role-branch unchanged.
- `src/components/cmd/InviteUserDrawer.tsx` — added an optional username field +
  inline validation via `validateUsername` (blank allowed; invalid blocks
  send), passes `username` (trimmed, or null) to `inviteUser`, and maps a
  unique-violation (23505 / duplicate-key) to a "username already taken" toast.
- `src/lib/db.ts` — added `username` to the `fetchBrandAdmins` active-row and
  pending-invite mappers + the invitations `.select(...)` column list.
- `src/types/index.ts` — added `username?: string | null` to `User`.
- `.env.example`, `.env.local` — documented + stubbed
  `EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN` (client) and the server-side
  `USERNAME_RESOLVE_SERVICE_TOKEN` secret note.
- Tests (NEW): `src/lib/usernameValidation.test.ts`,
  `src/lib/auth.signIn.test.ts`; EXTENDED:
  `src/components/cmd/InviteUserDrawer.test.tsx` (username assignment block).

### FIXES_NEEDED follow-up (release-proposal — frontend items)

- `src/lib/auth.signIn.test.ts` — **CRITICAL/CI fix.** Gave the self-referential
  `eq` jest mock an explicit return-type annotation
  (`jest.fn((): { single: jest.Mock; eq: jest.Mock } => …)`) so the strict-mode
  inferencer no longer chokes (was TS7022/TS7024 at line 22). `npm run
  typecheck:test` now exits 0; jest stays green.
- `src/components/cmd/InviteUserDrawer.tsx` — (1) **#2** narrowed the "username
  taken" heuristic from the broad `/23505|duplicate key|already exists|username/i`
  to discriminate on the actual index name `/profiles_username_lower_key/i`, so an
  unrelated 23505 (e.g. duplicate-email invitation) is no longer mislabeled;
  user-facing message unchanged. (2) **#3** the username field now lowercases on
  input (`onChange={(v) => set('username')(v.toLowerCase())}`) so the displayed
  value matches the case-folded stored form — no silent `Bobby_B` → `bobby_b`.
- `src/components/cmd/InviteUserDrawer.test.tsx` — extended with: a casing test
  (field folds to `bobby_b`, folded value reaches `inviteUser`), and two
  "username taken" heuristic tests (index-name match → "username taken"; unrelated
  23505 → raw error verbatim, NOT mislabeled). Suite now 632/632.

## Files changed (backend — backend-developer)

Status note: NOT setting `Status:` per the parallel-build coordination above.
Backend half is complete and verified locally: `npx tsc --noEmit` clean,
`npm test` 629/629 pass, `bash scripts/test-db.sh` 45/45 DB test files pass
(including `staff_brand_id_backfill.test.sql`, confirming the
`get_pending_invitation` redefinition carried the spec-069 `resolved_brand_id`
shape forward), and `scripts/smoke-username-resolve.sh` passes all checks
(401 token gate; anti-oracle uniform-200 for existent + non-existent username;
LIKE-wildcard escaping verified — `%` and `_`-bearing inputs do not leak).
Once both halves are confirmed, the combined slice moves to READY_FOR_REVIEW.

### Review fixes (backend — security Medium-1 + code-reviewer #1, 2026-06-07)

Addressing the `FIXES_NEEDED` release proposal. The CRITICAL typecheck blocker
and the frontend should-fixes were handled by the frontend-developer in parallel;
the items below are the backend-owned fixes.

- **[security Medium-1] Rate limit on `username-resolve` (was specified in the
  Backend design §API-contract mitigation (3) but not implemented).** Built a
  DB-backed fixed-window per-IP limiter (20 req/min/IP — inside the design's
  "~10-30 req/min/IP" guidance) so a holder of the bundle-public client token
  cannot script username→email harvesting. Chose a DB-backed limiter over an
  in-memory/Deno-KV counter because edge functions are stateless isolates that
  scale horizontally — an in-memory counter cannot enforce a shared per-IP
  budget. The limiter keys on the CLIENT IP only (never the username), so the
  over-budget HTTP 429 is a per-IP signal and does NOT reopen the enumeration
  oracle: the non-429 success path remains ALWAYS `200 { email: string | null }`.
  The function fails OPEN on a limiter RPC error (an infra blip must not block
  legitimate logins) but honors a clean DENY.
  - `supabase/migrations/20260607130000_username_resolve_rate_limit.sql` (NEW) —
    `username_resolve_rate_limit` table (RLS on, no permissive policy);
    `check_username_resolve_rate_limit(text)` SECURITY DEFINER RPC (atomic
    fixed-window upsert, returns allow/deny, EXECUTE granted to service_role
    only); `prune_username_resolve_rate_limit()` + a daily pg_cron prune job. No
    `supabase_realtime` publication change; no down migration.
  - `supabase/functions/username-resolve/index.ts` — added `clientIp(req)`
    (x-forwarded-for first entry → x-real-ip fallback) + a pre-lookup
    `check_username_resolve_rate_limit` RPC call via the service-role client; 429
    on over-budget; the service-role client is hoisted above the rate-limit check
    so it is reused for the username lookup.
  - `supabase/tests/username_resolve_rate_limit.test.sql` (NEW) — pgTAP plan(7):
    budget (1st allowed, 2..20 allowed, 21st denied), per-IP isolation, blank-IP
    → shared bucket, RLS blocks authenticated from the counter table, anon lacks
    EXECUTE on the limiter RPC.
  - `scripts/smoke-username-resolve.sh` — extended with a rate-limit arm (fire
    >budget from one forwarded IP → asserts both a within-budget 200 and an
    over-budget 429) PLUS an anti-oracle-under-the-limit arm (a fresh IP still
    gets uniform-200 for existent + non-existent usernames).

- **[code-reviewer #1] Document `USERNAME_RESOLVE_SERVICE_TOKEN` for a fresh
  checkout.** Added the secret (with rotation/parity guidance mirroring the
  `STAFF_SERVICE_TOKEN` / `PWA_SERVICE_TOKEN` blocks) to
  `supabase/functions/.env.local.example` and seeded a pinned local-dev value in
  the gitignored `supabase/functions/.env.local`, so the smoke test is runnable
  from a clean clone.

Verification (local, post-fix): `npx tsc --noEmit` clean; `npm test` 632/632
pass; `bash scripts/test-db.sh` 46/46 DB test files pass (45 prior + the new
rate-limit test); `scripts/smoke-username-resolve.sh` all checks pass including
the new 429 rate-limit + anti-oracle-under-limit arms.

NEW manual deploy step (in addition to the existing ones below): the rate-limit
migration `20260607130000` ships a new table + RPCs + a pg_cron job — applied by
the existing `npx supabase db push --linked` step (no extra action), and
`supabase functions deploy username-resolve` must be re-run to ship the limiter
call in the function.

### migrations
- `supabase/migrations/20260607120000_profiles_username.sql` (NEW) — additive,
  three parts: (1) `profiles.username` text column + `profiles_username_format`
  CHECK (NULL-tolerant; 3–20 chars; `^[A-Za-z0-9_.]+$`) + case-insensitive
  `profiles_username_lower_key` UNIQUE index on `lower(username)` (partial
  `WHERE username IS NOT NULL`); (2) `invitations.username` carrier column +
  `invitations_username_format` CHECK (same format shape, NO uniqueness) and a
  DROP+CREATE of `get_pending_invitation(text)` adding `username` to the return
  set while carrying the spec-069 `resolved_brand_id` body verbatim (grant to
  anon, authenticated preserved); (3) idempotent `DO` backfill (`WHERE username
  IS NULL` guard) over `profiles ⋈ auth.users` — local-part → lower() → strip
  `[^a-z0-9_.]` → left(20) → rpad-to-3 with `0` → `user_<8hex-of-uuid>` fallback
  → smallest numeric suffix on case-insensitive collision, ordered by
  `(created_at, id)`; post-assertion raises if any NULL username remains. No
  `supabase_realtime` publication change; no down migration (repo convention).

### edge functions
- `supabase/functions/username-resolve/index.ts` (NEW) — `verify_jwt = false`
  service-token endpoint mirroring `pwa-catalog`'s `checkAuth` shape against the
  NEW `USERNAME_RESOLVE_SERVICE_TOKEN` secret. POST `{ username }` →
  service-role `profiles` lookup (case-insensitive exact match via `ilike` with
  LIKE-metacharacter escaping so `%`/`_`/`\` cannot wildcard-match) →
  `auth.admin.getUserById` for the email. ANTI-ORACLE: ALWAYS returns
  `200 { email: string | null }` for any well-formed request (null for
  not-found / no-email / malformed / any internal failure — fail-closed);
  only 401 (bad/missing token) and 500 (secret unset) are non-200. JSON only,
  no HTML → no `escapeHtml` needed; no ADMIN_ROLES gate (pre-auth endpoint).
- `supabase/config.toml` — added `[functions.username-resolve]` with
  `verify_jwt = false`.

### tests
- `supabase/tests/profiles_username.test.sql` (NEW) — pgTAP, plan(16): format
  CHECK accept/reject (short/long/disallowed-char/valid/NULL); case-insensitive
  UNIQUE rejects `Sam` vs `sam`; two NULLs coexist; backfill algorithm run
  end-to-end over real seeded rows (post-backfill 0-NULL invariant, format,
  global case-insensitive uniqueness) plus controlled fixtures for basic
  sanitize, collision-suffix, short-pad, empty-fallback, and re-run idempotency;
  `get_pending_invitation` returns the new `username` column. (NB: migrations
  run BEFORE seed.sql on `db reset`, so the test runs the backfill ALGORITHM
  over the seeded NULL rows rather than asserting the migration already ran on
  them — documented inline.)
- `scripts/smoke-username-resolve.sh` (NEW) — shell smoke: CORS preflight; 401
  on missing/wrong token; the anti-oracle parity check (existent and
  non-existent username BOTH return 200, status indistinguishable); optional
  known-username non-null-email assertion via `RESOLVE_USERNAME`. Follows
  `scripts/smoke-edge.sh` conventions; non-zero exit on first failure.

### Manual deploy steps (REQUIRED — username login is BROKEN until done)
- Set `USERNAME_RESOLVE_SERVICE_TOKEN` (server) in prod via
  `supabase secrets set USERNAME_RESOLVE_SERVICE_TOKEN=<token>` (and locally in
  `supabase/functions/.env` for dev — gitignored).
- Set `EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN` (client) to the SAME value in the
  Vercel + EAS build environments.
- Deploy the function: `supabase functions deploy username-resolve`.
- Apply the migration: `npx supabase db push --linked`.
- Email login keeps working regardless of these steps; only the no-`@`
  username path depends on the token + function.
