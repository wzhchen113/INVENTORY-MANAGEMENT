## Code review for spec 095 (re-review, post-fix-passes)

Reviewer: code-reviewer
Date: 2026-06-07
Pass: 2 (re-review of fix passes — rate limiter + typecheck:test fix)

Prior findings (original pass): no prior file existed; this is the first written
review. The release-proposal reconstructed three Should-fix items from second-hand
dispatch notes; all three were addressed by the fix passes and are confirmed closed
below.

---

### Critical

None.

---

### Should-fix

- `supabase/migrations/20260607130000_username_resolve_rate_limit.sql:143` — The
  comment says "The RPC writes the table as its owner; service_role also needs
  direct table grants are NOT required" — this sentence is syntactically broken
  mid-thought (looks like "grants are NOT required" was grafted into the wrong
  clause). It currently reads ambiguously: a casual reader could conclude no table
  grants are needed, when in fact the `GRANT select, insert, update` below IS
  intentional for defense-in-depth. The grant itself is correct; the comment is
  misleading. Suggested: "The SECURITY DEFINER RPC runs as its owner (postgres) and
  can write the table without a separate table grant, but grant DML to service_role
  for defense-in-depth parity with the function's blast radius."

- `supabase/functions/username-resolve/index.ts:95` — `createClient` is called
  inside `Deno.serve` (inside the request handler), meaning a new service-role
  client is instantiated on every request. The `pwa-catalog` reference shape and
  the Supabase edge-function best-practice both hoist the client to module scope so
  it is created once at cold-start and reused across hot invocations. The comment
  at line 95 says "the service-role client is hoisted above the rate-limit check so
  it is reused for the username lookup" — but that describes the intent in the spec
  note, not what the code actually does: the `admin` client is created AFTER the
  `checkAuth` call but still inside the handler (line 95 is inside `Deno.serve`).
  Move `const admin = createClient(...)` to module scope (alongside the
  `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` reads) to match the spec's stated
  rationale and the `pwa-catalog` pattern.

---

### Nits

- `supabase/migrations/20260607130000_username_resolve_rate_limit.sql:144` —
  `grant select, insert, update` on the counter table to `service_role` is
  intentionally defense-in-depth; consider also granting `delete` for symmetry
  with `prune_username_resolve_rate_limit`, which does a DELETE. The prune function
  runs as its `SECURITY DEFINER` owner (postgres) so the grant is not strictly
  required for the prune path — just noting the asymmetry.

- `supabase/tests/username_resolve_rate_limit.test.sql:86-92` — Arm (6) uses `set
  local role authenticated` to test RLS but does not subsequently also test `anon`.
  The migration comment says "anon/authenticated are blocked." Arm (7) tests EXECUTE
  for `anon` but arm (6) only confirms `authenticated` sees 0 rows. Minor gap — at
  this point the posture is adequately covered and it is consistent with the pattern
  of other pgTAP tests in this codebase.

- `supabase/functions/username-resolve/index.ts:138` — `username.replace(/([\\%_])/g, "\\$1")`
  escapes `\`, `%`, and `_` for safe `ilike` use. The comment explains this well.
  One edge case worth a future comment: `[` and `]` are NOT standard LIKE
  metacharacters in Postgres (unlike SQL Server), so no escaping is needed for
  them, but that could surprise a reader who comes from another DB background. The
  escaping as implemented is correct for Postgres.

- `src/lib/auth.signIn.test.ts:26` — The explicit return-type annotation
  `jest.fn((): { single: jest.Mock; eq: jest.Mock } => ...)` is the correct fix for
  the TS7022/TS7024 self-referential inference. The inline comment at lines 23-25
  explains the why clearly. No issue; calling it out to confirm it is closed.

- `scripts/smoke-username-resolve.sh:165,197` — The random IP ranges for the
  rate-limit arms (`198.51.100.1–200` for `RL_IP`, `198.51.100.201–250` for
  `RL_IP2`) are non-overlapping by construction, which prevents RL_IP2 from already
  being throttled by RL_IP. Good. One nit: within a given 60-second window, two
  consecutive `bash scripts/smoke-username-resolve.sh` runs from the same CI job
  could have `RL_IP` collide across runs (RANDOM is seeded per-process in bash).
  In practice, the rollback in `username_resolve_rate_limit.test.sql` cleans up DB
  rows, but the smoke test runs against the live local DB (no rollback). If CI runs
  the smoke twice in rapid succession with the same random value, the second run
  could enter with a partially-consumed budget. This is an accepted operational
  limitation of per-IP limiters on smoke tests; it's consistent with the NOTE in
  the script at lines 163-164 ("re-runs within the same minute may already be over
  budget"). No action required — flagging for awareness.

- `src/lib/usernameValidation.ts:84` — `RESERVED_USERNAMES.has(value.toLowerCase())`
  correctly does case-insensitive reserved-name checking. The `validateUsername`
  validator accepts `[A-Za-z0-9_.]` (mixed case) but writers lowercase on write
  (`inviteUser` calls `.trim().toLowerCase()`). The InviteUserDrawer now also
  lowercases on input (`v.toLowerCase()`), so by the time the trimmed value reaches
  `validateUsername`, it is already lowercase. The mixed-case acceptance in
  `USERNAME_FORMAT_RE` is therefore harmless (the `.toLowerCase()` at line 84 is
  still the right safety net). No change needed; confirming the release-proposal
  step 5 ("Reconcile validateUsername charset vs. lowercase-on-write casing") is
  consistent and intentional: the validator accepts mixed case for the format check
  so it works for any call site, then the reserved-name check folds correctly.

- `src/components/cmd/InviteUserDrawer.tsx:368` — The comment reference to
  "AdminScreens.tsx:1604" is a dead reference — `AdminScreens.tsx` was deleted in
  spec 025. The comment is informational (explaining why non-master admins are
  locked to `role='user'`) and the behavior is correct. The stale file reference
  should be updated to reference the actual current gate mechanism (likely
  `useIsMaster`), but this is minor and predates spec 095.

---

### Confirmed closed (items from release-proposal FIXES_NEEDED)

1. **[CRITICAL — CI] typecheck:test failure in `src/lib/auth.signIn.test.ts:22`.**
   Confirmed fixed. The explicit `jest.Mock` return-type annotation at line 26
   resolves TS7022/TS7024. All 632 jest tests pass and `typecheck:test` exits 0.

2. **[security Medium-1] Rate limit on `username-resolve`.** Confirmed built.
   DB-backed fixed-window limiter (20 req/min/IP) in
   `20260607130000_username_resolve_rate_limit.sql` with the SECURITY DEFINER RPC
   called from `username-resolve/index.ts`. pgTAP plan(7) covers budget, per-IP
   isolation, blank-IP bucket, RLS lock, and EXECUTE grant. Smoke test extended
   with rate-limit and anti-oracle-under-limit arms.

3. **[Should-fix] Narrow the InviteUserDrawer 23505 heuristic.** Confirmed fixed.
   `InviteUserDrawer.tsx:196` now matches `/profiles_username_lower_key/i` only.
   Two new test arms in `InviteUserDrawer.test.tsx` (index-name match and unrelated
   23505) pin the behavior.

4. **[Should-fix] Document `USERNAME_RESOLVE_SERVICE_TOKEN` in
   `supabase/functions/.env.local.example`.** Confirmed done. The secret block with
   rotation guidance and the warning that username login is broken without it is
   present at lines 25-33 of `.env.local.example`.

5. **[Should-fix — casing] Lowercase on input in InviteUserDrawer.** Confirmed
   done. `onChange={(v) => set('username')(v.toLowerCase())}` at
   `InviteUserDrawer.tsx:352`. Pinned by the new casing test in
   `InviteUserDrawer.test.tsx:308-323`.
