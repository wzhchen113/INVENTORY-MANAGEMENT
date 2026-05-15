# Security audit for spec 031

## Scope

Reviewed every file in `## Files changed`:

- `supabase/migrations/20260514160000_assert_not_last_of_role.sql` (new)
- `supabase/tests/delete_last_privileged_guard.test.sql` (new)
- `supabase/functions/delete-user/index.ts` (modified — guard insertion at lines 68-103)
- `src/screens/cmd/sections/UsersSection.tsx` (modified — `lastOfRole` derivation + `canDelete` extension)
- `scripts/smoke-edge-roles.sh` (modified — Arm 6 appended)
- `CLAUDE.md` (modified — additive convention bullet)
- `.claude/agents/security-auditor.md` (modified — additive audit-rule bullet)

Threat model focus:

1. SECURITY DEFINER helper hygiene (search_path lock, grant tightness, side effects).
2. TOCTOU / race between count and the subsequent DELETEs.
3. Bypass surface (direct DELETE on `auth.users`, role demotion via UPDATE, service-role key exposure).
4. Edge function ordering (refusal before any side-effect deletes; RLS-bypassing role lookup).
5. Smoke Arm 6 assertion strength.
6. Convention-doc additions: do they weaken existing security framing?

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `supabase/functions/delete-user/index.ts:78-103` — TOCTOU window between the
  count and the actual deletes. The role lookup, the `assert_not_last_of_role`
  RPC, the cleanup `from(...).delete()` sweep, and the final
  `auth.admin.deleteUser()` are four independent statements in the edge
  function — they are NOT wrapped in a single SQL transaction. Two concurrent
  `delete-user` invocations targeting different rows of the same role (e.g.
  the only two remaining super_admins) could each observe count=2 inside the
  helper, both pass the guard, and both proceed to delete — leaving zero rows.
  **Impact:** the foot-gun the spec exists to close (post-delete recovery
  requires direct psql) is reintroduced in a narrow concurrent-call window.
  **Realistic exploitability:** very low. The window is bounded by the
  network latency between the helper's RPC and the subsequent
  `auth.admin.deleteUser` call (tens of ms inside one edge-function
  invocation). The caller surface is limited to authenticated admin / master
  / super_admin operators (per `requireAdminCaller()`, line 21), who are
  trusted. To weaponize, two privileged operators would have to fire
  near-simultaneous deletes against different last-of-role targets, which is
  not a realistic adversarial scenario. The spec's §14 risk table calls this
  out and rates it Negligible; I concur but note it explicitly. **Fix
  (optional, defer-able):** wrap the count + delete in a single
  transaction-scoped RPC that combines `assert_not_last_of_role` and the
  `profiles` row delete with `FOR UPDATE` row-locking. Out of scope for v1.

- `scripts/smoke-edge-roles.sh:359-364` — Arm 6's primary refusal assertion
  matches **either** `"cannot delete self"` OR `"cannot delete the last
  super_admin"`. Per the design ordering (delete-user/index.ts:59 self-delete
  fires before line 92 guard), the self-delete refusal always wins in
  practice. This means Arm 6 never exercises the new last-of-role string
  end-to-end through the edge function. **Impact:** if a future dev silently
  breaks the `assert_not_last_of_role` RPC dispatch (e.g. typo in the RPC
  name, wrong arg names), Arm 6 still passes because the self-delete check
  short-circuits first. The state-mutation invariant at lines 370-378 (count
  still 1 post-call) is the load-bearing check that catches partial
  deletion, but it does not prove the helper RPC fired. **The spec
  explicitly accepts this trade-off** ("the assertion is 'the function
  refused with a structured error,' not 'the function refused with *this
  specific* error.'"). Defense-in-depth coverage of the actual helper path is
  carried by the pgTAP test, which exercises the SQL function directly.
  Acceptable v1.

- `supabase/migrations/20260514160000_assert_not_last_of_role.sql:80` — the
  helper is granted to `authenticated`, allowing any authenticated user
  (not just admins) to call `select public.assert_not_last_of_role(<some_uuid>,
  'super_admin')` via PostgREST RPC. The function returns void on success
  and raises P0001 on the "last" condition, so an authenticated caller can
  probe global role counts ("is this user the last super_admin?") without
  needing to read the `profiles` table directly. **Impact:** information
  leak is binary (yes/no on last-of-role) and the same answer is derivable
  from the caller's own visible `profiles` rows for a non-brand-scoped role
  like `super_admin` (which has `brand_id IS NULL` and is therefore
  brand-invisible to brand-scoped admins anyway). A brand-scoped admin
  cannot count super_admins globally via SELECT (RLS hides them), but CAN
  via this RPC. Not a meaningful escalation — the count being "1" is not a
  secret — but the spec's §14 risk table acknowledges this and rates it
  Low. I concur. **Fix (optional):** restrict grant to `service_role` only
  and add a wrapper RPC at admin-only privilege. Adds complexity; not
  recommended for v1.

### Notes (informational, not findings)

- **SECURITY DEFINER hygiene — clean.** The helper at
  `supabase/migrations/20260514160000_assert_not_last_of_role.sql:39-78`
  matches the existing pattern in `20260509000000_multi_brand_schema_rls.sql`
  for `auth_is_super_admin()` / `auth_can_see_brand()` / `auth_is_privileged()`
  (lines 187-239). Typed args (`uuid, text`) — no SQL injection surface
  even though the function builds `v_message` from `target_role`, because
  `target_role` is only ever used in the `case` block as a literal-string
  comparator and never interpolated into dynamic SQL. `set search_path =
  public, auth` locks resolution. `stable` declares it read-only. Pure
  count + raise — no DML, no side effects. Idempotent via `CREATE OR
  REPLACE`. Rollback is `drop function`.

- **Grant tightness — correctly defense-in-depth.** Existing helpers
  (`auth_is_super_admin`, etc.) grant to `authenticated, anon` because RLS
  policies reference them and anon reads must short-circuit cleanly. The
  new helper grants only to `authenticated, service_role` (NOT `anon`,
  NOT `public`) — appropriate because it is invoked only via RPC from a
  privileged caller path. Tighter than necessary; flagged as Low above
  only because `authenticated` is broader than strictly needed for the
  caller (the edge function uses service-role).

- **Edge function ordering — correct.** New guard at
  `supabase/functions/delete-user/index.ts:68-103` sits AFTER self-delete
  refusal (lines 59-64) and BEFORE the `user_stores` / `profiles` /
  `invitations` deletes (lines 105-107) and the final
  `auth.admin.deleteUser` (line 109). Refusal is atomic — no partial
  cleanup occurs before refusal. Role lookup at lines 78-82 uses the
  service-role client constructed at line 66, so it is RLS-bypassing and
  sees the target's profile regardless of caller's `auth_can_see_brand`
  scope. `.maybeSingle()` correctly handles the auth-only-user case
  (target has no profiles row → `data = null, error = null` → guard
  no-ops, existing delete sequence proceeds).

- **Bypass surface — bounded.** Direct DELETE on `auth.users` would
  require the service-role key, which lives only in the edge function's
  `Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` (line 5) — no client path
  reaches it. Role demotion via UPDATE on `profiles.role` is a different
  surface (out of scope per spec §"Out of scope"); the foot-gun via
  demotion is acknowledged in the spec's deferral list. Not a finding for
  this spec, but does mean a future spec should land the symmetric guard
  on the role-edit code path.

- **Smoke Arm 6 state-mutation invariant — load-bearing and correct.**
  `scripts/smoke-edge-roles.sh:370-378` re-queries the super_admin count
  AFTER the refused delete and FAILs if it changed. This is the regression
  detector that catches the worst failure mode (function partial-deletes
  before refusing). Even though the primary refusal-string match accepts
  either error string, this post-condition check fires unconditionally and
  catches the spec's most-feared regression.

- **Client-side `canDelete` extension — explicit "UX hint, not security".**
  `src/screens/cmd/sections/UsersSection.tsx:283-288` correctly comments
  that the server is authoritative and the client check is a UX hint. The
  brand-filtered-subset edge case (rawUsers contains zero super_admins for
  a brand-scoped admin → `0 <= 1` is true → predicate is structurally
  "true" but unreachable because `visibleUsers` strips super_admin rows
  for non-master admins per line 80-82) is harmless. No security-boundary
  reliance on `useRole()` placeholder behavior.

- **Convention-doc additions — strictly additive and correctly framed.**
  - `CLAUDE.md:63` (new bullet) — strictly additive (no existing bullet
    reworded or reordered, per `git diff`). References the SQL helper as
    single source of truth and pins the pgTAP cross-test. Forward-looking
    clause about future privileged roles (e.g. `billing_admin`) is correct
    guidance — does not weaken any existing convention.
  - `.claude/agents/security-auditor.md:51` (new bullet) — strictly
    additive. Correctly classifies omission as **High** (operator footgun,
    NOT privilege escalation). Wording matches the spec-028 escapeHtml
    bullet shape (severity, reference shape, impact framing). No existing
    audit rule weakened.

- **`delete-user` config.toml status — unchanged, correctly inherits
  default `verify_jwt = true`.** No `[functions.delete-user]` entry exists
  in `supabase/config.toml` (verified via `grep -n "^\[functions\." supabase/config.toml`
  — only `pwa-catalog`, `staff-catalog`, `staff-eod-submit`,
  `staff-waste-log` appear). The function is gateway-JWT-protected AND
  performs its own `requireAdminCaller()` role check (line 21). No new
  function added in this spec, so no new config entry needed. Correct.

- **No realtime publication change.** Migration adds a function, not a
  table. No `docker restart supabase_realtime_imr-inventory` ritual
  needed. Confirmed.

- **No new env vars, no new imports, no new dependencies.** The edge
  function reuses the existing `@supabase/supabase-js@2` import (line 2)
  and the service-role client at line 66. No `Deno.env.get` additions.

- **No console / log leakage.** `grep -n "console\." supabase/functions/delete-user/index.ts scripts/smoke-edge-roles.sh` returned no matches. The smoke script's `printf` of `${BODY:0:200}` truncates response bodies; no token, key, or PII appears in any log path. Edge function returns the helper's `error.message` verbatim (the stable identifier `'cannot delete the last super_admin'`), which is non-sensitive by design.

### Dependencies

No `package.json` changes — `npm audit` skipped per policy.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 3 Low (all spec-acknowledged trade-offs; none block release).
payload_paths:
  - specs/031-last-super-admin-guard/reviews/security-auditor.md
