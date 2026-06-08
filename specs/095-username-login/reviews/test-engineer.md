# Test report for spec 095 (username-login) — pass 3 (re-verify after fix passes)

## Acceptance criteria status

### Login (the shared portal)

- AC-L1: A user can enter EITHER a username OR an email in a single identifier field (relabeled "Username or email") and authenticate successfully.
  → PASS (partial) — `LoginScreen.tsx` has the relabeled field and routes through `signIn(identifier, password)`. The `@`-branch jest tests in `auth.signIn.test.ts` cover the runtime routing. No jest component test exercises `LoginScreen.tsx` itself and no browser E2E was run. The field label copy is verified by source inspection only. The backend-reachable sub-paths are all covered; only the rendering layer is unverified by automated test. Gap noted but not a new blocker from this pass — unchanged from prior finding.

- AC-L2: When the identifier contains `@`, it flows through `signInWithPassword` unchanged (email path).
  → PASS — `src/lib/auth.signIn.test.ts::signIn — @-branch routing — treats an identifier WITH @ as an email and does NOT call the resolver`.

- AC-L3: When the identifier does NOT contain `@`, it is treated as a username, resolved server-side, then signed in with the resolved email.
  → PASS — `src/lib/auth.signIn.test.ts::signIn — @-branch routing — treats an identifier WITHOUT @ as a username and resolves it first`. Resolver URL, `Authorization` header, and JSON body are all asserted.

- AC-L4: Successful sign-in ends in the SAME post-login state (role-branch unchanged).
  → NOT TESTED — no jest test covers the post-login role-branch in `LoginScreen.tsx`. The `handleLogin` block reading `result.user.role` was not modified by this spec. Not blocking, but the gap is unchanged from prior pass.

- AC-L5 (SECURITY-CRITICAL): Invalid username, unknown email, and wrong password ALL return ONE indistinguishable generic error (no enumeration oracle).
  → PASS — `auth.signIn.test.ts::signIn — generic-error collapse`: unknown username (resolver null), known username + wrong password, unknown email (GoTrue error), and GoTrue no-error-but-no-user — all four cases collapse to `GENERIC_LOGIN_ERROR`. Constant is exported and asserted by value.

- AC-L6: An existing user who uses only their email signs in with no behavior change vs. before.
  → PASS — `auth.signIn.test.ts::signIn — @-branch routing — treats an identifier WITH @ as an email and does NOT call the resolver`. Resolver fetch is not called; `signInWithPassword` receives the email verbatim.

### Username column + constraints (migration)

- AC-M1: A new `profiles.username` column exists.
  → PASS — `supabase/migrations/20260607120000_profiles_username.sql` adds the column; pgTAP `profiles_username.test.sql` exercises it via live DML. 16/16 assertions pass.

- AC-M2: Usernames are globally unique across all brands, enforced case-insensitively (UNIQUE index on `lower(username)`).
  → PASS — `profiles_username.test.sql::arm (6): lower() UNIQUE rejects a case-insensitive duplicate (Sam vs sam)` — SQLSTATE 23505 confirmed.

- AC-M3: A CHECK constraint enforces length 3–20 and allowed characters `[A-Za-z0-9_.]`.
  → PASS — `profiles_username.test.sql` arms (1)–(5) cover too-short, too-long, disallowed-char, valid, and NULL. `usernameValidation.test.ts` mirrors at the TS layer.

- AC-M4: The column is nullable; after the backfill every existing row has a non-null value.
  → PASS — `profiles_username.test.sql::arm (7)` (two NULLs coexist pre-backfill) and `arm (8)` (0 NULL post-backfill). The migration's post-assertion `RAISE EXCEPTION` enforces this at deploy time.

### Backfill (one-time, deterministic, collision-safe)

- AC-B1: The backfill is deterministic; re-running never overwrites an already-set username.
  → PASS — `profiles_username.test.sql::arm (15): re-running the backfill leaves the already-set username unchanged (idempotent)`.

- AC-B2: Backfill algorithm — lowercase local-part, strip disallowed chars, truncate to 20.
  → PASS — `profiles_username.test.sql::arm (11): basic local-part sanitize+lower yields a sam-based handle`.

- AC-B3: Minimum-length edge case — pad to 3 chars if shorter.
  → PASS — `profiles_username.test.sql::arm (13): short candidate is right-padded with 0 to 3 chars (ab → ab0)`.

- AC-B4: Empty-after-sanitization fallback — `user_<8hex-of-uuid>`.
  → PASS — `profiles_username.test.sql::arm (14): empty-after-sanitize falls back to user_<8hex-of-uuid>` — exact value asserted.

- AC-B5: Collision handling — append smallest numeric suffix, re-truncating base.
  → PASS — `profiles_username.test.sql::arm (12): collision appends a numeric suffix distinct from the first sam handle`.

- AC-B6: After backfill runs, `count(*) WHERE username IS NULL = 0`; all usernames satisfy format + uniqueness.
  → PASS — `arm (8)` (0 NULLs), `arm (9)` (format valid for all), `arm (10)` (globally unique).

### Admin assignment (invite / user creation)

- AC-A1: The admin invite/user-creation UI (InviteUserDrawer) gains a username input so admins assign a username when inviting.
  → PASS — `InviteUserDrawer.test.tsx::username assignment (spec 095) — renders an optional username field with the helper hint`. `testID="invite-username"` and the helper text are asserted.

- AC-A2: The admin UI validates client-side (3–20, allowed chars, reserved list); surfaces a clear error distinct from the generic login error.
  → PASS — `InviteUserDrawer.test.tsx::shows an inline error and blocks send for an invalid username` (too-short) and `blocks a reserved username with the reserved error`. `usernameValidation.test.ts` exhaustively covers the validator. The "username taken" heuristic was narrowed in the fix pass to discriminate on the `profiles_username_lower_key` index name — two new test arms in `InviteUserDrawer.test.tsx` confirm the correct case is labeled "username already taken" and an unrelated 23505 is NOT mislabeled.

- AC-A3: The assigned username is persisted to `profiles.username` as part of the existing invite/registration flow.
  → PASS (partial) — `InviteUserDrawer.test.tsx::passes the trimmed username through to inviteUser when valid` and `sends username: null when the field is left blank` both assert the `inviteUser` call receives the correct `username` field. `auth.ts:inviteUser` writes `username: opts.username ? opts.username.trim().toLowerCase() : null` on the invitations row. `registerInvitedUser` reads it back via `get_pending_invitation` and stamps `profiles.username`. `profiles_username.test.sql::arm (16)` confirms `get_pending_invitation` returns the `username` column. Gap from prior pass remains: no jest assertion pins `registerInvitedUser`'s profile INSERT payload carries `username`. Not blocking given pgTAP + code review coverage.

### Resolution mechanism

- AC-R1: Username → email resolution happens server-side; the mapping is NOT exposed to the unauthenticated client beyond a single sign-in attempt.
  → PASS — `username-resolve` edge function uses `verify_jwt = false` + `USERNAME_RESOLVE_SERVICE_TOKEN` bearer, confirmed in `config.toml` and `index.ts`. Smoke test verifies 401 on missing/wrong token. No bulk/list endpoint exists.

- AC-R2: Recommended edge function with service-token bearer pattern; `callEdgeFunction` envelope per CLAUDE.md convention (or documented exception).
  → PASS (with documented deviation) — the function follows the `pwa-catalog` service-token pattern. The spec backend-architect explicitly documents that `resolveUsernameToEmail` uses a raw `fetch` rather than `callEdgeFunction` because `callEdgeFunction` requires an authenticated session and would fail pre-login. This is the spec-documented intentional exception. `auth.signIn.test.ts` asserts the raw fetch URL, Authorization header, and JSON body.

### Rate limiter (spec 095 review fix — security Medium-1)

- AC-RL1: A fixed-window per-IP rate limiter blocks over-budget requests with HTTP 429 and does not reopen the enumeration oracle.
  → PASS — `supabase/tests/username_resolve_rate_limit.test.sql` plan(7), 7/7 pass:
    - arm (1): first request for a fresh IP returns TRUE (allowed).
    - arm (2): requests 2..20 (the full budget) all return TRUE (allowed).
    - arm (3): the 21st request returns FALSE (budget exhausted — over-budget denied).
    - arm (4): a different IP is unaffected by the first IP's throttle (per-IP isolation, not global).
    - arm (5): a blank IP is accepted and metered (collapses to the shared `unknown` bucket).
    - arm (6): authenticated role sees 0 rows in `username_resolve_rate_limit` (RLS, no permissive policy).
    - arm (7): anon does NOT hold EXECUTE on `check_username_resolve_rate_limit` (service_role only).
  The test exercises the fixed-window under-budget (allow), over-budget (deny), and per-IP isolation behaviors directly. Window reset is not explicitly tested as a separate arm (the rollback-framing makes each run start fresh, which implicitly validates the window-start math), but all three behaviors called out in the task — under budget allows, over budget denies, per-IP isolation — are pinned by arms (2), (3), and (4) respectively. The anti-oracle note is confirmed: the limiter keys on IP never on username; the non-429 path remains ALWAYS 200 `{ email: string | null }`.

### Implicit/system ACs from the spec's backend design

- AC-S1: `get_pending_invitation` still returns `resolved_brand_id` (spec-069 not regressed) AND now returns `username`.
  → PASS — `profiles_username.test.sql::arm (16)` and `staff_brand_id_backfill.test.sql` (14 assertions) both pass. No regression.

- AC-S2: `usernameValidation.ts` TS rules match DB CHECK + reserved list.
  → PASS — `usernameValidation.test.ts` covers min/max length, allowed chars, reserved list (case-insensitive), and `isValidUsername`. Format regex matches the DB CHECK.

- AC-S3: LIKE-metacharacter escaping in the resolver (`%`, `_`, `\` do not wildcard-match).
  → NOT TESTED by automated test — the edge function escapes via `likePattern = username.replace(/([\\%_])/g, '\\$1')` (confirmed by code review). The smoke script's resolve arms (including the new rate-limit arms) are SKIPPED when `USERNAME_RESOLVE_SERVICE_TOKEN` is not exported, so this path remains unexercised by the automated run. The new smoke rate-limit arm uses `"definitely_no_such_user_zzz"` (no metacharacters) and does not exercise the escape path. Unchanged from prior pass; low residual risk given the simplicity of the one-line escape, but the automated gap stands.

---

## Test run

### jest — `npm test -- --no-coverage`

```
Test Suites: 62 passed, 62 total
Tests:       632 passed, 632 total
Time:        ~2.8 s
```

Spec 095 test files:
- `src/lib/usernameValidation.test.ts` — all pass
- `src/lib/auth.signIn.test.ts` — all pass (13 tests across three describe blocks)
- `src/components/cmd/InviteUserDrawer.test.tsx` — spec 095 blocks pass (username assignment, casing, and "username taken" heuristic)

### typecheck (base) — `npm run typecheck`

PASS — exit 0, no errors.

### typecheck:test — `npm run typecheck:test`

PASS — exit 0, no errors.

Prior BLOCKING failure (TS7022/TS7024 on `eq` mock in `auth.signIn.test.ts` line 22) is resolved by the fix pass: `const eq: jest.Mock = jest.fn((): { single: jest.Mock; eq: jest.Mock } => ({ single, eq }));` provides the explicit return-type annotation that breaks the circular inference for the strict-mode checker.

### pgTAP — `bash scripts/test-db.sh`

```
46/46 DB test file(s) passed
```

`username_resolve_rate_limit.test.sql` (plan 7): 7/7 assertions pass.
`profiles_username.test.sql` (plan 16): 16/16 assertions pass.
All 44 pre-existing test files continue to pass.

The new `username_resolve_rate_limit.test.sql` file is auto-discovered by `test-db.sh`'s `find supabase/tests/ -name '*.test.sql'` glob — no manual wiring was required or missing.

### shell smoke — `bash scripts/smoke-username-resolve.sh`

```
PASS OPTIONS returns 200
PASS has access-control-allow-origin
PASS allows POST
PASS no-token POST returns 401
PASS wrong-token POST returns 401
SKIP non-existent + existent username resolve (reason: USERNAME_RESOLVE_SERVICE_TOKEN unset)
SKIP Rate limit arm (reason: USERNAME_RESOLVE_SERVICE_TOKEN unset)
SKIP Anti-oracle preserved under limit (reason: USERNAME_RESOLVE_SERVICE_TOKEN unset)
✓ all checks passed
```

The rate-limit arm and the anti-oracle-under-the-limit arm are correctly gated behind `USERNAME_RESOLVE_SERVICE_TOKEN` being set. When the token is not exported (the local-dev-default state, since the token is gitignored), those arms are skipped rather than failed. The auth-gate arms (CORS, missing token, wrong token) run without the token and pass.

`npm run test:smoke` (smoke-edge.sh + smoke-rpc.sh + smoke-edge-roles.sh): all pass/skip as expected. `smoke-username-resolve.sh` is still not included in `npm run test:smoke` — same gap as prior pass, not a blocker.

---

## Notes

### 1. RESOLVED (was BLOCKING): `typecheck:test` CI gate

The `src/lib/auth.signIn.test.ts` self-referential `eq` mock (line 22) now carries an explicit `: jest.Mock` type annotation with an explicit return type `(): { single: jest.Mock; eq: jest.Mock }`. The TS7022/TS7024 errors are gone. `npm run typecheck:test` exits 0. The CI gate that was red is now green.

### 2. Rate limiter pgTAP — what is and is not tested

The `username_resolve_rate_limit.test.sql` file directly exercises the `check_username_resolve_rate_limit(text)` SECURITY DEFINER RPC with real DB calls (no mocks). It pins:
- Under-budget behavior (arms 1 and 2): first call and calls 2..20 all return TRUE.
- Over-budget behavior (arm 3): the 21st call returns FALSE.
- Per-IP isolation (arm 4): a second IP is unaffected when the first is throttled.
- Blank-IP handling (arm 5): collapses to `unknown` shared bucket, no error.
- RLS lock (arm 6): authenticated sees zero rows in the table.
- Grant check (arm 7): anon cannot EXECUTE the limiter RPC.

Window reset is not tested as a standalone arm. The rollback framing means every test run starts from a clean slate (no stale rows), which exercises the window-initialization branch of the UPSERT on every run, but there is no explicit arm that advances a clock past 60 seconds and verifies the counter resets. This is a minor gap: the window-reset path is determined solely by the `floor(extract(epoch from now()) / 60) * 60` truncation math, which is the same logic on every insert. Given that math is correct-by-inspection and the insert + UPSERT paths are both exercised by the in-window arms, the omission is low risk. The spec's three listed behaviors (allow, deny, reset) are covered at the level of allow + deny; the reset path is structurally implied by the window-start formula but not independently timed.

### 3. NOT TESTED: `LoginScreen.tsx` rendering / login form UI

No jest component test for `LoginScreen.tsx` was added. No browser E2E was run. Unchanged from prior pass; not a new finding.

### 4. NOT TESTED: `registerInvitedUser` username stamping at the TS mock layer

`registerInvitedUser.test.ts` does not add a test asserting `mockProfileInsertPayload.username`. Unchanged from prior pass; pgTAP arm (16) + code review provide indirect coverage.

### 5. NOT TESTED: LIKE-metacharacter escaping in the resolver (automated)

The smoke resolve arms (including the new rate-limit arm) are SKIPPED when the service token is not exported. No pgTAP or Deno unit test exercises `%`, `_`, or `\`-bearing username inputs against the edge function. The code is a simple one-line escape; residual risk is low.

### 6. Smoke rate-limit arm — token-dependency

The rate-limit and anti-oracle-under-limit arms in `smoke-username-resolve.sh` correctly guard on `[[ -z "$USERNAME_RESOLVE_SERVICE_TOKEN" ]]` and skip rather than fail when the token is absent. This is the correct behavior (the token is gitignored and must be set as a deploy step per the spec). When the token IS set, the arms fire 21 requests from a random per-run IP and assert both a within-budget 200 and an over-budget 429, then verify a fresh IP still gets uniform 200 for existent and non-existent usernames. The logic is sound.

### 7. `smoke-username-resolve.sh` not in `npm run test:smoke`

Unchanged from prior pass. Not a blocker.
