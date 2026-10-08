# Spec 164: backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode)
Design reviewed against: `specs/164-profiles-insert-hardening.md` "## Backend design" §0–§11
Date: 2026-10-08

## Verdict

**No contract drift.** The implementation matches every decision in D1–D11:
- policy names and predicates
- the guard trigger shape, its refusal string, and SQLSTATE
- the RPC signature, algorithm order, and all six byte-for-byte refusal strings
- grants and owner
- the P_INV predicate (with `invitations.` qualification and text comparison)
- the client rewrite, confined to `registerInvitedUser`
- the lint `\y` fix plus arm (5)
- the `'manager'` → `'user'` fixture change

RLS landed as designed. Nothing bypasses `src/lib/db.ts` outside the documented `src/lib/auth.ts` carve-out.

Counts: **Critical 0, Should-fix 1, Minor 5.**

## Verified points (no action)

- **Migration** `supabase/migrations/20261007000000_profiles_insert_hardening.sql`
  - The version sorts between `20260829000100` and spec 163's `20261008000000` (D1).
  - The profiles INSERT policy at :55-60 is exactly `public.auth_is_privileged() and public.auth_can_see_brand(brand_id)`, `to authenticated`, with no self-arm (D2).
  - The fail-closed DO assertion at :69-82 counts permissive INSERT/ALL on `profiles` regardless of roles, which is correct.
  - The guard at :95-121 is `security invoker`, pins `search_path = public, auth`, and checks `current_user in ('authenticated','anon')` and `is distinct from 'user'` and `not auth_is_super_admin()`. Message: `non-user role inserts require super_admin` (D3).
  - The RPC at :132-261 is `returns uuid`, `security definer`, pins `search_path = public`, and schema-qualifies every relation, including `auth.users` and `public.invitations%rowtype`. Because every relation is qualified, the usual "append `pg_temp` to a definer search_path" concern does not apply: pg_temp is never searched for functions or operators.
  - RPC step order matches §3: R1 → R2 → email → count (R3/R4) → `FOR UPDATE` re-select (R3 on lost race) → R5 → R6 → brand → initials → profile → `user_stores` (`distinct`, null-filtered) → invitation → return.
  - The developer's two fail-closed additions are inside the design's wording and are improvements:
    - an explicit empty-email check (:159)
    - `role is null or …` (:191)
  - The brand-resolution expression is the spec 069 `resolved_brand_id` expression verbatim.
  - Grants (:260-261): `revoke all … from public, anon` plus `grant execute … to authenticated` (D4).
  - P_INV (:275-321) is identical in INSERT WITH CHECK, UPDATE USING, and UPDATE WITH CHECK. Columns are `invitations.`-qualified, and store ids are compared as text (`s.id::text = lower(sid.store_id)`) (D5).
  - The policy roles changed from `public` to `authenticated`. This is called out in the implementation notes and has no behavior change, because anon can never satisfy `auth_is_privileged()`.
  - The file is ASCII-only, as required by §1.
- **P_INV admits the real invite flow.**
  - Brand-A admins see brand-A stores through the spec 041 `auth_can_see_store` admin arm ([20260517040000_auth_can_see_store_brand_scope.sql:93-101](../../../supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql)), so the `stores` left-join inside P_INV resolves for own-brand stores the admin is not personally linked to.
  - `inviteUser` ([src/lib/auth.ts:385-469](../../../src/lib/auth.ts)) only does INSERT, SELECT, and DELETE on `invitations`. `resendInvite` only SELECTs. There is still no client UPDATE caller, so the §2.3 USING tightening has no consumer to break.
- **No other INSERT path into `profiles`.**
  - `src/` has no `from('profiles').insert/upsert`.
  - No edge function inserts into `profiles`.
  - The only migration inserts are the 012a bootstrap (as postgres) and the new RPC.
- **pgTAP** `supabase/tests/profiles_insert_hardening.test.sql`, `plan(71)`:
  - Arm-for-arm coverage of §8.1: K-1..K-13, A-1..A-17, B-1/B-2, C-1..C-18 (21 assertions), and D-1..D-18. The total is 71.
  - K-7 additionally pins `proowner = postgres`, which mitigates risk R4.
  - A-3 disables and re-enables the guard as postgres inside the rolled-back transaction, which is correct.
  - D-12 uses a data-modifying CTE to show that USING hides the brand-B row.
  - C-17 and C-18 together prove atomicity. The developer's caveat that pgTAP `throws_*` uses a subtransaction is accurate. It does not weaken the proof: a plpgsql function cannot commit partway through, so the savepoint rollback is the whole function's writes.
- **Lint** `supabase/tests/permissive_policy_lint.test.sql`:
  - All eight regex literals use `\y`.
  - Arm (5) uses the INSERT/WITH CHECK side with the exact pre-164 shape and the drop-then-assert pattern.
  - `plan(5)`.
  - The arm (4) comment states that the trailing anchor, not the lookahead, does the work (§8.2 reviewer note).
  - There are no allowlist additions.
  - A grep of `supabase/tests/` finds no remaining `\b`.
- **Client** `src/lib/auth.ts:472-535`:
  - The signature and `AuthResult` shape are unchanged.
  - `signUp` `options.data` is `{ name }` only.
  - There is exactly one `supabase.rpc('register_invited_profile')` call, with no args.
  - The error string is the design's `Account created but profile setup failed: ${regError.message}`.
  - The welcome email fires only on success.
  - The two pre-signUp error strings are byte-identical.
  - The spec 163 region (`fetchAllUsers`, now ~561+) was not touched.
- **jest** `src/lib/registerInvitedUser.test.ts` covers all five §8.4 cases, including:
  - an invocation-order check that the RPC runs after `signUp`
  - `from` spy assertions for `profiles` and `user_stores`
  - the `getSession` proxy for "the welcome email was attempted"

## Should-fix

### S1. Missing fail-closed assertion on `invitations` write-policy membership

[supabase/migrations/20261007000000_profiles_insert_hardening.sql:275-321](../../../supabase/migrations/20261007000000_profiles_insert_hardening.sql)

**This is a gap in my design, not developer drift.**

After this migration, the invitation row is the trust anchor for `register_invited_profile()`. Suppose prod carried an extra permissive INSERT, UPDATE, or ALL policy on `public.invitations`, for example from dashboard drift that `db pull` would not have shown. That policy would OR P_INV back open. The attack would then be:
1. A fresh anon-key signup inserts an invitation for its own email with `role='admin', brand_id=<any>`.
2. It calls the RPC and becomes an admin of that brand.

R5 still blocks `super_admin` and `master`, but not cross-brand `admin`. Prod pre-check P-5 (§9.2) covers this only as a manual eyeball step.

**Recommendation (before the prod apply; the migration is not yet in prod, so this is cheap):**
- Add a DO block mirroring the profiles one at :69-82.
- After the two `create policy` statements, assert that `count(*) = 1` for `pg_policies where schemaname='public' and tablename='invitations' and permissive='PERMISSIVE' and cmd in ('INSERT','ALL')`.
- Assert the same for `cmd in ('UPDATE','ALL')`.
- Raise with a `164:`-prefixed message, like the existing assertion.
- Optionally add matching K-arms (counts = 1) to the pgTAP file and bump `plan`.

No function bodies change, so the local normalized-md5 reference values from §9.3 step 3 stay valid.

## Minor

### M1. `invitations_super_admin_rls.test.sql` arm (iii) still inserts `role='manager'`, so its 42501 is over-determined

[supabase/tests/invitations_super_admin_rls.test.sql:139](../../../supabase/tests/invitations_super_admin_rls.test.sql)

My §8.3 said "Arm (iii) is unchanged", and the developer followed it. Under P_INV, though, `'manager'` fails both the privilege arm and the role whitelist. Arm (iii) therefore no longer isolates the "non-privileged caller is refused" property its comment (:121-125) describes.

Profiles-insert-hardening D-18 does cover a `user`-role caller inserting a valid `'user'` invite, so there is no coverage hole. Changing the literal to `'user'` would restore the arm's original meaning.

### M2. The `order_approvals.test.sql` L1 lint regex is a looser variant of the canonical detector

[supabase/tests/order_approvals.test.sql:416,418](../../../supabase/tests/order_approvals.test.sql)

The `\y` fix landed as designed. This copy of the OR-tail regex, however, lacks the canonical `(?!\s+and\y)` lookahead and the `\s*($|\s+or\y)` trailing anchor from `permissive_policy_lint.test.sql:132-133`. It was inert before the fix. Now it is live, and it would false-positive on a legitimate AND-guarded OR-arm if one is ever added to `order_approvals`.

There is no impact today, because the arm passes. Possible follow-up: align it with the canonical regex, or delete it in favor of the global lint, which already covers `order_approvals`.

### M3. Stale comments describing client-side profile stamping

These are comment-only. The developer already flagged most of them.
- [src/lib/auth.ts:357, 379-380, 441-442, 450](../../../src/lib/auth.ts): "registerInvitedUser writes/stamps profiles…"
- [src/lib/auth.ts:488-493](../../../src/lib/auth.ts): the spec 012b pre-check comment says "the profile INSERT below would fail the profiles_role_brand_consistent CHECK". The server now refuses first with R6 `admin invitation requires a brand`. My §5 item 6 said to keep this comment, but one clause is now inaccurate. Suggested rewording: "…would be refused server-side (R6) after signUp, leaving an orphan auth user".
- [src/lib/inviteUser.test.ts:23](../../../src/lib/inviteUser.test.ts) points to `registerInvitedUser.test.ts (spec 069)` for brand-stamp coverage that now lives in pgTAP C-2/C-6.
- `src/lib/db.ts:5485` (`consume_invitation`). Leave it per §5.

### M4. The `permissive_policy_lint.test.sql` header "Known limitation" block is stale

[supabase/tests/permissive_policy_lint.test.sql:79-87](../../../supabase/tests/permissive_policy_lint.test.sql)

It still says `db-migrations-applied.yml` is "not yet landed". Spec 064 landed it, although that gate checks migration-version drift, not policy text, so the limitation itself still stands. This is pre-existing and out of 164's scope. Note it only because the file was touched in this PR. Optional.

### M5. Old-client stranding runbook should be in the release notes, not only in §10 R1

This is not a code finding. The `delete-user` cleanup runbook for invitees caught between prod apply and Vercel deploy is in §10 R1 only. `release-coordinator` should carry it into the release proposal next to the §9.5 commit-topology decision, so the owner has it at deploy time.

## Contract checklist

| Design item | Status |
|-------------|--------|
| D1 migration filename and ordering | Match |
| D2 profiles INSERT policy + assertion | Match |
| D3 guard trigger, INVOKER, string, P0001 | Match |
| D4 RPC signature, DEFINER, search_path, grants, owner | Match |
| D5 P_INV on INSERT, UPDATE USING, and UPDATE WITH CHECK; SELECT/DELETE untouched | Match (see S1 for hardening) |
| D6 P0001-before-42501 testing contract, A-3 layered proof | Match |
| D7 identity via `auth.users.email` | Match |
| D8 R4 `multiple pending invitations` | Match |
| D9 client: no role in signUp, single RPC, no direct writes | Match |
| D10 lint `\y`, arm (5), plan(5) | Match |
| D11 `'manager'` → `'user'` in arms (i)/(ii) | Match (see M1 for arm iii) |
| §4 no edge function change; §6 no realtime change; §7 no store change | Match |
| No `db.ts` bypass (auth.ts carve-out only) | Match |

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 6 findings by severity: 0 Critical, 1 Should-fix (S1: add a fail-closed in-migration assertion on invitations permissive INSERT/UPDATE policy count before the prod apply), 5 Minor (arm iii over-determined, order_approvals regex variant, stale comments, stale lint header, runbook placement).
payload_paths:
  - specs/164-profiles-insert-hardening/reviews/backend-architect.md
