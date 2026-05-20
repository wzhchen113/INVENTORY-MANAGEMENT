# Security audit for spec 050

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

- `supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql:124` — Refusal message drift from the design. The spec/architect referenced `'profile not found'` for the P0002 not-found arm, but the deployed string is `'target profile not found'`. Not a security concern (no information leak — the target's existence is observable via `profiles` SELECT under RLS for privileged callers anyway), but worth aligning so a future smoke arm doesn't pin against the wrong string. Pure-text, no behavior change.

## Dependencies

`package.json` unchanged in this spec — `npm audit` skipped.

## Probe results (per assigned checks)

1. **Self-delete bypass via SQLi / null target** — Not exploitable. `target_user_id` is typed `uuid` so PostgREST parses/casts before invocation; non-UUID strings are rejected with PostgREST 22P02 before the function body runs. Passing `null` for `target_user_id` makes the equality predicate at [supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql:98](supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql) evaluate `null = v_caller_id` which is `NULL` (not true), then the UPDATE at line 114 finds zero rows (`null = id` always evaluates `NULL`), `not found` fires, and the function raises `P0002 'target profile not found'`. Result: null target refuses with a structured error, never reaches a UPDATE side-effect.

2. **SECURITY DEFINER privilege escalation** — Not exploitable. The `auth_is_privileged()` gate at line 89 short-circuits non-admin callers with `42501 'forbidden'` before the UPDATE can fire. pgTAP Arm (iii) at [supabase/tests/demote_self_guard.test.sql:157-165](supabase/tests/demote_self_guard.test.sql) exercises a `role='user'` caller against a non-self target and confirms refusal at the role gate. A non-privileged caller cannot demote anyone, self or otherwise.

3. **Refusal-string stability** — `'cannot demote self'` (P0001) is byte-for-byte stable across the RPC body (lines 81, 101), the pgTAP `throws_ok` matcher, and the smoke Arm 7 `grep -qE '"message":"cannot demote self"'` ([scripts/smoke-edge-roles.sh:447](scripts/smoke-edge-roles.sh)). The unified self-vs-null string is the safer surface (avoids leaking auth-state to a probing caller, per the migration comment at lines 73-77 and pgTAP Arm (iv) at line 167). See Low #1 for the P0002 drift — that arm's message is `'target profile not found'`, not security-load-bearing.

4. **Search-path injection** — `set search_path = public, auth` at line 61 is correct and matches the architect's recommendation. `public` first means unqualified function calls resolve against the project's schema first (where `auth_is_privileged` lives), then `auth` (where `auth.uid()` is resolved via explicit qualification at line 64). The function body explicitly qualifies `auth.uid()`, `public.auth_is_privileged()`, and `public.profiles`, so search-path order is defense-in-depth rather than load-bearing. Identical shape to `auth_is_super_admin()` and `auth_is_privileged()` themselves in [supabase/migrations/20260509000000_multi_brand_schema_rls.sql](supabase/migrations/20260509000000_multi_brand_schema_rls.sql). No injection surface.

5. **Grants** — Verified at [supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql:141-142](supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql). Explicit `revoke execute ... from public, anon;` followed by `grant execute ... to authenticated;`. Tighter than `assert_not_last_of_role` (read-only, broader grant). Anon callers cannot invoke; service_role bearers produce `auth.uid() = null` and would refuse at gate (1) even if they bypassed the grant via PostgREST machinery (they don't reach this RPC in normal paths). Correct surface.

6. **CLAUDE.md / security-auditor.md additions** — Strictly additive. Verified via `git diff`. CLAUDE.md adds one new bullet to the "Conventions" block (server-side `caller.id != target.id` guard convention) after the spec-031 last-of-role bullet; no existing bullets reworded. `.claude/agents/security-auditor.md` adds one new bullet to the "Edge functions" project-specific checks block; no existing bullets reworded. No scope creep, no softening of existing rules.

## Ordering verification

- **RPC**: Gates fire in the right order — (1) null-caller at line 78 → (2) role gate at line 89 → (3) self-check at line 98 → (4) UPDATE at line 114 → (5) not-found at line 121. Self-check is BEFORE the UPDATE, so a `caller==target` refusal is atomic with no side-effect (smoke Arm 7's pre/post `role`/`brand_id` snapshot at lines 423-470 enforces this contractually).
- **`delete-user`**: Self-check at [supabase/functions/delete-user/index.ts:168-173](supabase/functions/delete-user/index.ts) fires FIRST after `requireAdminCaller`, BEFORE brand-match (`requireSameBrandOrSuperAdmin` at line 189) and BEFORE last-of-role (line 202+). Correct.

## Audit trail

- pgTAP at [supabase/tests/demote_self_guard.test.sql](supabase/tests/demote_self_guard.test.sql) calls the deployed function path (`select public.demote_profile_to_user(...)`) directly via `throws_ok`/`lives_ok`. Not a SQL-inlined fake — same RPC entry point as the client wrapper.
- Smoke Arm 7 at [scripts/smoke-edge-roles.sh:403-472](scripts/smoke-edge-roles.sh) is a real HTTP roundtrip via `curl -sS -X POST ${SUPABASE_URL}/rest/v1/rpc/demote_profile_to_user` with the admin bearer. Asserts on HTTP 400, the exact refusal string, AND a pre/post DB snapshot showing the admin row was not mutated.
- Client wrapper at [src/lib/db.ts:2761-2766](src/lib/db.ts) passes only `target_user_id` to `supabase.rpc(...)` — no `caller_id` from the client. Forgery vector closed.
