# Backend-architect post-impl review — Spec 042 (round-4 final)

Reviewer: backend-architect (post-impl drift mode)
Date: 2026-05-17
Implementation under review:
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260517050000_rls_hardening_followups.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/rls_hardening_followups.test.sql`

Verdict: **NO DRIFT.** Implementation matches the round-4 §13
architect-approved design verbatim (modulo whitespace and comment
phrasing). The empirical evidence captured in the spec's "Files
changed" section corroborates the design's intended behavior — both
the trigger probe and the Row J manual attack produce the expected
SQLSTATE / message.

I had to walk through every checklist item the dispatch prompt
called out. None of them surfaced drift. Findings below are
mostly "no concern" annotations with a couple of Minor items that
can be folded into a future spec.

---

## Verification against the round-4 §13 design (checklist)

1. **Trigger function body matches the design verbatim (modulo
   whitespace)?**
   YES. Implementation lines 196-245 are character-for-character
   identical to spec §13 lines 1464-1514 in body shape:
   `tg_op = 'UPDATE'` guard, `not auth_is_super_admin()` outer
   gate, `old.id = auth.uid()` self-edit branch with the two Spec
   041 message strings preserved verbatim, `elsif current_user in
   ('authenticated', 'anon')` cross-user branch raising
   `'role changes require super_admin'`. The inline comment block
   matches the design copy exactly. `set search_path = public, auth`
   preserved.

2. **Security mode is SECURITY INVOKER (not DEFINER)?**
   YES. Line 199 reads `security invoker`. This is the single
   load-bearing change the round-4 ruling specified.

3. **Comments cite round-4 rationale?**
   YES. The header comment at lines 169-195 names round-3 as
   superseded and explains the SECURITY INVOKER swap. The inline
   block comment inside the cross-user branch (lines 220-236)
   names round-4 explicitly and credits the dev's row-2 probe.
   The captured probe NOTICE output at lines 184-191 is inlined
   in the migration body — the spec §14 step (5) ask
   ("capture the probe NOTICE output in the migration commit
   message... inlining in the migration SQL as a comment is also
   acceptable") is satisfied via the inline-comment path.

4. **Three policy tightenings match the design shape?**
   YES.
     - `"Admins can write order_schedule"` (lines 71-79) →
       `using` and `with check` both
       `public.auth_is_privileged() and public.auth_can_see_store(store_id)`,
       `for all`, with the round-4 `comment on policy`.
     - `"Admins can update any profile"` (lines 97-111) →
       OR-arm structure preserved
       (`(auth_is_privileged() and auth_can_see_brand(brand_id)) or (id = auth.uid())`),
       USING and WITH CHECK identical, `for update`, with comment.
     - `"Users can update own profile"` (lines 122-130) →
       `using (id = auth.uid())` AND
       `with check (id = auth.uid())`, `for update`, with comment.
   All three are `drop policy if exists` + `create policy` (idempotent
   per the spec's acceptance-criteria checkbox).

5. **Pre-flight DO block intact?**
   YES. Lines 50-59 are the design's pre-flight DO block verbatim
   — `if exists (select 1 from public.profiles where role in
   ('admin','master') and brand_id is null) then raise exception
   '042: pre-flight failed: …';`. Mirrors Spec 041's pattern as the
   design specified.

6. **`comment on function` updated to round-4 string?**
   YES. Lines 247-248 reproduce the round-4 design string verbatim
   from spec §13 lines 1516-1517. The doubled single-quote in
   `caller''s` is correctly SQL-escaped. The string names Round-3
   as superseded and links readers to §"Round-4 BLOCKER" + §13
   Round-4 revision for the empirical evidence.

7. **15-arm pgTAP plan matches the design coverage matrix?**
   YES. `select plan(15);` at line 57. Each of the 15 arms maps
   exactly to spec §9 Q5 row-by-row:
     - Arms 1-3: same-brand admin INSERT/UPDATE/DELETE admit.
     - Arms 4-6: cross-brand admin INSERT/UPDATE/DELETE reject.
     - Arm 7: super-admin cross-brand INSERT admit (short-circuit).
     - Arm 8: admin same-brand cross-user UPDATE admit.
     - Arm 9: admin cross-brand UPDATE 0 rows.
     - Arm 10: super-admin cross-brand UPDATE admit.
     - Arm 11: regular user self-UPDATE no-regression.
     - Arm 12: regular user row-key forgery rejected by WITH CHECK.
     - Arm 13: brand-A admin same-brand role-escalation rejected
       by trigger (the load-bearing round-4 arm).
     - Arm 14: brand-A admin cross-user brand_id transfer rejected
       by WITH CHECK.
     - Arm 15: super-admin same-brand role promotion admit
       (positive control).
   SQLSTATEs match: `42501` for RLS WITH CHECK violations
   (arms 4, 12, 14), `P0001` + `'role changes require super_admin'`
   for the trigger rejection (arm 13). Hermetic isolation pattern
   `begin; … rollback;` is in place (lines 54, 610). JWT
   impersonation pattern is copied from
   `auth_can_see_store_brand_scope.test.sql` as the design called
   for.

8. **No out-of-scope edits anywhere?**
   YES — confirmed via grep. The trigger function name
   `assert_brand_id_immutable_for_self` only appears in (i) the
   042 migration, (ii) the 042 spec, (iii) the 041 migration body,
   (iv) the 041 review files. The Spec 041 test file's expected
   message strings (`'brand_id is read-only for self-edits
   (super_admin only)'`, `'role is read-only for self-edits
   (super_admin only)'`) are preserved verbatim by the new trigger
   body's self-edit branch. No `src/`, `app.json`, or
   `package.json` changes ship. `supabase/config.toml` is
   untouched. No edge function changes. No realtime publication
   changes (no `docker restart supabase_realtime_imr-inventory`
   required, matching §6 of the design).

---

## Reflection on the multi-round architectural saga

The round-4 ruling (SECURITY INVOKER swap) is, in retrospect,
correct. The key insight the architect missed in round 3 was that
`SECURITY DEFINER` doesn't just elevate privileges for table
access — it also rewrites `current_user` to the function owner
for the duration of the body. The dev's empirical probe table
(round-4 BLOCKER section) was the decisive evidence; my round-3
mapping table at §13 simply got the postgres semantics wrong.

**Does `auth_is_super_admin()` still resolve correctly when
called from the INVOKER trigger?** Yes — verified by reading
`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:187-195`.
The helper is declared `language sql stable security definer set
search_path = public, auth`. When the INVOKER trigger calls it,
Postgres pushes a new security context for the DEFINER helper —
the helper runs as its owner (`postgres`), reads `profiles` under
that owner's identity (RLS bypassed for the table read since
`postgres` is BYPASSRLS-equivalent and the helper is DEFINER
anyway), and returns boolean. Inside that helper's body
`auth.uid()` resolves correctly because `auth.uid()` is itself a
`stable` function that reads `request.jwt.claims` (a per-statement
GUC, unaffected by SECURITY context). So the composition is
sound: outer INVOKER trigger sees `current_user = authenticated`,
calls inner DEFINER helper which sees `current_user = postgres`
but still pulls the correct caller UUID from JWT claims, returns
the right boolean, and the trigger's outer guard works as
designed.

**Was the design correct?** Yes. The probe NOTICE output captured
in the migration commentary (lines 184-191) matches the §13
expected output line-for-line. The Row J manual attack now
surfaces as `P0001` from the trigger (the intended defense), not
the round-3 incidental `23514` (the row CHECK catching the
malformed `role='super_admin' AND brand_id IS NOT NULL` only).
Both empirical artifacts confirm the design.

**Lingering concern (one — Minor below).** The 041 trigger
function was originally chosen to be DEFINER for "trigger fires
consistently regardless of caller's table-level GRANTs"
(per the round-4 BLOCKER section). The INVOKER swap shifts that
guarantee onto the implicit PUBLIC EXECUTE default for new
functions. The spec calls this out at Risk #9 (round-4 specific,
LOW) and documents the future-REVOKE invariant. That's an
acceptable trade-off, but I would prefer an explicit
`grant execute on function public.assert_brand_id_immutable_for_self() to authenticated, anon;`
in this migration as belt-and-suspenders. See Minor 1 below.

---

## Findings

### Critical
NONE.

### Should-fix
NONE.

### Minor

**Minor 1: explicit `grant execute on function ... to
authenticated, anon` would harden Risk #9.**

`supabase/migrations/20260517050000_rls_hardening_followups.sql`
relies on PostgreSQL's default `PUBLIC` EXECUTE grant for the
recreated function. The spec §13 Risk #9 (lines 1534-1544)
documents this as an invariant: "future migrations that REVOKE on
`public.assert_brand_id_immutable_for_self` must explicitly grant
back to `authenticated, anon`." An explicit `grant` statement in
the 042 migration would make the assumption load-bearing in the
migration itself rather than relying on tribal knowledge in the
spec body. Not critical — today no migration revokes the PUBLIC
default — but worth a one-line follow-up in a future spec.
Suggested placement: immediately after the `comment on function`
at line 248.

**Minor 2: function name vs broadened scope.**

The function name `assert_brand_id_immutable_for_self` now also
covers cross-user role changes. The spec §13 Risk #8 (lines
799-807) explicitly chose to keep the name for migration-history
continuity, and I concur with that decision. Flagging only because
a future reviewer scanning the codebase for cross-user role
checks won't find them by grepping for `role` in function names.
A future cleanup spec can rename
(`assert_profile_columns_locked()` was the §13 candidate).
Mitigated by the inline comment block (lines 217-236) and the
`comment on function` text — both name "role changes" explicitly,
so anyone hovering on the function in their IDE / running
`\df+ public.assert_brand_id_immutable_for_self` will see the
broader contract.

**Minor 3: arm-13 fixture uses a `brand_id != NULL` target.**

The round-4 BLOCKER analysis noted that "an attacker who picks a
target with `brand_id IS NULL` (a former super_admin demoted to
user but with brand_id retained NULL, or similar edge-state)
would bypass the [row-level] CHECK and complete the escalation"
under the broken round-3 trigger. The round-4 INVOKER trigger
catches the attack regardless of target `brand_id` state, but the
pgTAP arm 13 only exercises the `brand_id != NULL` case (target_a
is brand A with brand_id non-null). A defense-in-depth arm 16
covering the `brand_id IS NULL` target would prove the trigger
fires *before* the row-level CHECK regardless of target state. The
spec §"Round-4 BLOCKER" → "Asks for the architect" bullet 2
explicitly asked the architect to confirm whether arm 13 "may
need to gain an additional arm (16+) covering the `brand_id IS
NULL` edge case once the trigger is correctly wired." I did not
include this in the round-4 design (the keyword swap was the
load-bearing change and adding fixture surface would have
stretched the spec further). The manual Row J reproducer captured
in the spec's "Files changed" section gives us partial confidence
the trigger fires first; an explicit pgTAP arm would close the
loop. Track as a follow-up — not blocking for ship.

---

## Coverage note (informational, not a finding)

The spec's out-of-scope risks (Risk #3 "Admins can read all
profiles" still permissive; Risk #4 "Admins can delete profiles"
still permissive; Risk #5 self-INSERT admin arm permissive) all
remain open. The 042 spec was scoped to the three findings the
security-auditor flagged in Spec 041 round 4 (1 High, 2 Medium)
plus the trigger-broadening derived from Q1 row J. The follow-up
sweep of every WRITE policy on per-store and per-brand tables is
spec body §"Out of scope" bullet 3 — a separate spec should sweep
the rest. No drift here, just a reminder that 042 is not the end
of the RLS-hardening epic.

---

## Files referenced in this review

- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260517050000_rls_hardening_followups.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/rls_hardening_followups.test.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260509000000_multi_brand_schema_rls.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/auth_can_see_store_brand_scope.test.sql`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/042-rls-hardening-followups.md`

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix,
  3 Minor findings — all advisory follow-ups, none blocking ship.
  Implementation matches the round-4 §13 design verbatim.
  release-coordinator can synthesize once all reviewer files are
  present in specs/042-rls-hardening-followups/reviews/.
payload_paths:
  - specs/042-rls-hardening-followups/reviews/backend-architect.md
