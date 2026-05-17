# Backend-architect drift review — Spec 043

Reviewer: backend-architect (post-impl mode)
Scope: drift between the `## Backend / architecture design` section of
`specs/043-profiles-rls-sweep.md` and the four files listed under
`## Files changed`.

Read-only review. No code mutated.

## Verdict

Critical: 0
Should-fix: 0
Minor: 2

No drift. The implementation matches the design contract on every load-bearing
dimension that was checked against the prompt. The two Minor items are
cosmetic/wording — they do not affect correctness, runtime behaviour, or the
acceptance criteria.

---

## Checklist of design-vs-impl points

### 1. Migration matches design

`/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260517060000_profiles_rls_sweep.sql`

- Pre-flight `do $$` block — present at lines 63-72. Raises
  `'043: pre-flight failed: admin/master profile(s) with NULL brand_id exist; resolve before applying'`
  — matches design §"Pre-flight `do $$` block" verbatim.
- SELECT policy drop+recreate — lines 94-104. USING clause is
  `(public.auth_is_privileged() and public.auth_can_see_brand(brand_id)) or id = auth.uid()`
  — matches design §"Policy 1 — SELECT tightening" verbatim.
- DELETE policy drop+recreate — lines 125-134. USING clause is
  `public.auth_is_privileged() and public.auth_can_see_brand(brand_id)` —
  matches design §"Policy 2 — DELETE tightening" verbatim.
- No self-arm on DELETE — matches design rationale ("Self-DELETE is
  independently blocked by the Spec 041 `profiles_self_delete_lock` BEFORE-DELETE
  trigger").
- `comment on policy` set for both new policies (lines 103-104, 133-134)
  referencing spec 043 — defense-in-depth documentation, not strictly required
  by the design but consistent with Spec 042's pattern.
- Migration timestamp `20260517060000` > `20260517050000` (Spec 042) >
  `20260517040000` (Spec 041) — apply ordering preserved.
- No other policies on `public.profiles` mutated. Verified by grepping the
  migration body — only the two named drops and two named creates appear.

### 2. `delete-user` edge function

`/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions/delete-user/index.ts`

- `requireAdminCaller` envelope extended to return `appRole` (design §4).
  Verified at line 30 (JWT path: `appRole` from `app_metadata.role`) and
  line 39 (fallback path: `appRole: profile.role`). Both branches return
  the role string. Matches design verbatim.
- Inline `requireSameBrandOrSuperAdmin` helper — present at lines 62-110.
  Signature `(serviceClient, callerId, callerAppRole, targetUserId)`
  matches design §4. Returns `{ status: 200 } | { error, status: 403 }`.
  Inline, not in `_shared/` — respects CLAUDE.md "inline-not-shared" rule.
- Helper decision shape matches design §4:
  - super_admin short-circuit (line 68) → allow.
  - Non-admin/master defense-in-depth (lines 69-73) → 403 `'forbidden'`.
  - Target lookup (lines 75-79). Auth-only target (no profiles row)
    pass-through (line 88) — preserves prior cleanup behaviour as designed.
  - Caller lookup (lines 90-94). Missing caller profile → 403
    `'forbidden: caller profile not found'` (lines 98-103). Design did not
    explicitly enumerate this case but it is the correct fail-closed path
    when an admin/master JWT carries a role but no profile row exists.
    Sensible defense-in-depth addition; non-drift.
  - Brand mismatch (line 105) → 403
    `'forbidden: target is in a different brand'` — exact string from
    design §4.
- Wire-in order in `Deno.serve` (lines 112-221) matches design:
  `requireAdminCaller` (line 117) → parse `userId` (line 126) →
  self-delete short-circuit (line 135) → service-role client (line 142) →
  **NEW brand gate** (lines 149-160) → existing target.role lookup +
  `assert_not_last_of_role` (lines 172-197) → existing cascade deletes
  (lines 199-201) → `auth.admin.deleteUser` (line 203).
  Brand gate runs **before** last-of-role guard — matches the acceptance
  criterion's ordering requirement (brand-A admin attempting to delete
  brand-B super_admin gets 403, not the misleading 400).
- `verify_jwt` setting unchanged — `delete-user` does not appear in
  `supabase/config.toml`, so it defaults to `true`. Matches design §4.

### 3. pgTAP arms match design §8 plan

`/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/profiles_rls_sweep.test.sql`

Design §8 specified "11 (or 12 with the optional TRUNCATE arm)". Implementation
ships **12 arms** (`select plan(12);` at line 59). All 12 arms map
1:1 to the design's arms table:

| Arm | Design intent | Impl location | Match |
|---|---|---|---|
| 1 | admin SELECT own profile → admit | lines 144-166 | YES |
| 2 | admin SELECT same-brand peer → admit | lines 169-178 | YES |
| 3 | admin SELECT cross-brand → 0 rows | lines 181-191 | YES |
| 4 | super_admin SELECT cross-brand → admit | lines 194-228 | YES |
| 5 | regular user SELECT own → admit | lines 231-252 | YES |
| 6 | regular user SELECT another → 0 rows | lines 255-266 | YES |
| 7 | admin DELETE same-brand → admit | lines 273-300 | YES |
| 8 | admin DELETE cross-brand → 0 rows affected | lines 303-331 | YES |
| 9 | super_admin DELETE cross-brand → admit | lines 334-361 | YES |
| 10 | authenticated self-DELETE → reject (Spec 041) | lines 368-395 | YES |
| 11 | `assert_not_last_of_role` SECURITY DEFINER bypass | lines 398-437 | YES |
| 12 | TRUNCATE rejected with 42501 (Spec 041 round-3) | lines 440-465 | YES |

Fixture pattern matches design §8 verbatim (mirrors Spec 042
`rls_hardening_followups.test.sql`):
- Seed admin/manager/master in brand A (test.admin_id, test.manager_id,
  test.master_id stashed via `set_config`).
- Synthetic foreign brand `b2000000-0000-0000-0000-000000000043` (lines 88-90).
- Synthetic auth.users rows for target_a and target_b (lines 96-123) with
  the full NOT NULL column set matching seed.sql shape.
- Synthetic profiles for target_a (brand A) and target_b (brand B), both
  role='user' (lines 129-137).
- Hermetic `begin; … rollback;` wrap (lines 56, 469).
- `set local role authenticated` + JWT impersonation idiom on every arm.
- `reset role + clear claims` pattern before verification SELECTs in DELETE
  arms 7-9 (lines 293-294, 324-325, 354-355) and before fixture mutation in
  arm 4 (lines 202-203) — exactly the design's prescribed pattern.

Arm 11's last-of-role assertion uses the exact form quoted in design §8:
`select throws_ok(format($q$select public.assert_not_last_of_role(%L::uuid, 'super_admin')$q$, …), 'P0001', 'cannot delete the last super_admin', …)` — lines 429-437.

### 4. Arm-9 patch in `rls_hardening_followups.test.sql`

`/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/rls_hardening_followups.test.sql`

Patch is at lines 433-434:

```
reset role;
select set_config('request.jwt.claims', '', true);
```

inserted before the existing `select is(...)` at lines 435-440 (arm 9
verification SELECT). This matches the design diagnosis under
§"Pre-existing pgTAP test interaction (Open question 1)" exactly:

> insert: `reset role; select set_config('request.jwt.claims', '', true);`

A header-comment block at lines 418-428 documents the Spec 043 fixture
patch rationale (pre-043 brand-blind admin SELECT admitted the cross-brand
row; post-043 the tightened policy returns 0 rows, so the verification
SELECT must drop the JWT context to bypass RLS). Documentation matches the
design's diagnosis.

No other arms in `rls_hardening_followups.test.sql` modified. Verified by
reading the file's plan count (`plan(15)` unchanged), the arm 8 admin-UPDATE
SELECT (lines 404-409 unchanged), and the arm 10 super_admin verification
(line 447 onwards unchanged). The patch is surgical: 2 statements added,
no deletions, no other arm bodies touched.

### 5. Out-of-scope edits

None.

- No `src/` changes. Grep for `Spec 043|spec 043|043` in `src/` returned
  no files.
- No other migration files in the `20260517*` series modified — only the
  new `20260517060000_profiles_rls_sweep.sql` added.
- No `supabase/config.toml` change — `verify_jwt` for `delete-user`
  remains default `true`.
- No `send-invite-email/index.ts` change — design §4 confirmed this
  function was reviewed but not modified; implementation respects that.
- No changes to `assert_not_last_of_role` SQL helper, no changes to the
  `profiles_self_delete_lock` trigger, no changes to the
  `profiles_self_brand_lock` trigger — all confirmed unchanged.
- No other policy on `public.profiles` mutated (verified earlier).

### 6. `requireAdminCaller` envelope extension

Verified above (§2). Both return paths carry `appRole`. Callsite at line
152 reads `gate.appRole!` and passes through to the new brand helper. No
re-fetch of the caller's profile inside `requireSameBrandOrSuperAdmin` for
role determination — it trusts the `appRole` value handed in, which is
the design's intended optimization to avoid duplicate profile reads.

---

## Findings

### Critical: none

### Should-fix: none

### Minor

**M1. Design wording says "three-line insertion" but the actual patch is
2 lines.**

Design §"Pre-existing pgTAP test interaction" line 998 says:
> One in-place patch to `rls_hardening_followups.test.sql` arm (9) (3 lines
> added: `reset role; select set_config('request.jwt.claims', '', true);`).

The quoted body is two SQL statements (`reset role;` and the `select
set_config(...)` call). The implementation inserts exactly those two
statements (lines 433-434). The patched file at
`supabase/tests/rls_hardening_followups.test.sql:433-434` matches the
quoted body verbatim — the design's own count was inconsistent with its
own quote. Implementation followed the quote, not the count. No
correction needed in the code; if the design is reused as a template,
fix the wording.

**M2. `requireSameBrandOrSuperAdmin` returns a 403 for missing-caller-profile
that the design didn't explicitly enumerate.**

Design §4 enumerated three decision branches: super_admin pass-through,
admin/master brand-compare with auth-only-target pass-through, and the
defense-in-depth else branch for unknown roles. The implementation adds a
fourth case at `delete-user/index.ts:98-103`: if the caller's
`app_metadata.role` is admin/master but the caller has no `profiles`
row, return 403 `'forbidden: caller profile not found'`. This is correct
fail-closed behaviour (an admin without a brand_id cannot make a brand
decision) and is consistent with the design's intent, but the new error
string is not enumerated in the spec's acceptance criteria. Recommend the
test-engineer adds an arm or the design appendix names this case if the
next spec touches the same surface; non-blocking for the current spec.

---

## Cross-spec composability check

Spec 041 (self-DELETE trigger, self-edit triggers) and Spec 042 (UPDATE
tightening + trigger broadening) remain intact:

- `profiles_self_delete_lock` trigger still fires for self-DELETE arm 10
  with the exact spec 041 message string `'profile self-delete is not
  permitted (use admin delete flow)'`. Verified at
  `profiles_rls_sweep.test.sql:393`.
- `profiles_self_brand_lock` (Spec 041 + Spec 042 round-4 SECURITY INVOKER
  form) is untouched.
- `assert_not_last_of_role` (Spec 031 SECURITY DEFINER) still bypasses
  the new DELETE policy and continues to fire from authenticated
  context — verified by arm 11.
- The Spec 042 `"Admins can update any profile"` and `"Users can update
  own profile"` policies are unchanged. The new SELECT and DELETE
  policies do not collide.
- The Spec 042 fixture patch to `rls_hardening_followups.test.sql` arm
  (9) is the architect-flagged fixture interaction. It is correctly
  patched as designed.

Spec 028 (escapeHtml) is not touched. `delete-user/index.ts` does not
emit HTML; no overlap.

Spec 031 (assert_not_last_of_role) is preserved unchanged. The
edge-function ordering puts the brand gate before the last-of-role guard
per the spec acceptance criterion.

Spec 027 (broadened edge-function role gates) — `ADMIN_ROLES` at
`delete-user/index.ts:19` still mirrors `public.auth_is_privileged()`
membership (admin, master, super_admin). No regression.

Spec 032 (`callEdgeFunction` envelope) — the new 403 error string flows
through the existing `callEdgeFunction` path unchanged. Frontend toast
surface is unaffected, as the design predicted.

---

## Composability with `supabase_realtime` publication

Design §"Realtime impact" stated "None. `profiles` is not in the
`supabase_realtime` publication." The migration is RLS + policy churn
only — does not touch `alter publication supabase_realtime`. Local
container does not need a restart. No `docker restart
supabase_realtime_imr-inventory` step required. Confirmed.

---

## Files reviewed

- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260517060000_profiles_rls_sweep.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions/delete-user/index.ts`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/profiles_rls_sweep.test.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/rls_hardening_followups.test.sql` (arm-9 patch context, lines 412-440)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/config.toml` (delete-user verify_jwt — defaults to true, no entry)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/043-profiles-rls-sweep.md` (design + acceptance criteria)

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix,
  2 Minor findings. Implementation matches the design contract on every
  load-bearing dimension. The two Minor items are cosmetic (a wording
  discrepancy in the design's own arm-9 patch line-count, and an
  unenumerated-but-correct fail-closed branch in the new edge-function
  helper).
payload_paths:
  - specs/043-profiles-rls-sweep/reviews/backend-architect.md
