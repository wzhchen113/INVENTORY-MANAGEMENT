# Spec 041 — backend-architect post-impl review (round 2)

Mode: architectural drift review against the design in
`specs/041-brand-scoped-store-visibility.md` §0-§12, AFTER the
review-round 1 fix pass. Round 1 review at this same path on the
prior pass identified 0 Critical, 1 Should-fix (`raise warning` vs
`raise exception`), 3 Minor. The fix pass landed:

1. Should-fix S1 resolved: `raise warning` → `raise exception`.
2. NEW: `assert_brand_id_immutable_for_self()` function +
   `profiles_self_brand_lock` BEFORE-UPDATE trigger on
   `public.profiles`. Locks `brand_id` AND `role` self-edits for
   non-super_admin callers. Not in the original §1-§12 design —
   added by the developer per security-auditor Critical finding,
   with release-coordinator's blessing.
3. pgTAP plan: 6 → 10. Four new arms (7-10).
4. New spec body section "Profile column-write lockdown" at
   `specs/041-brand-scoped-store-visibility.md:739-880`.

Files re-reviewed (both at HEAD, working tree clean per
`git status` at conversation start):

- `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql`
  (203 lines, was 95)
- `supabase/tests/auth_can_see_store_brand_scope.test.sql`
  (362 lines, was 207)
- `specs/041-brand-scoped-store-visibility.md` §0-§12 + new
  "Profile column-write lockdown" §739-880 + amended "Files
  changed" §1014-1052

Grep verification:

- `grep create or replace function public.auth_can_see_store
  supabase/migrations/` → 3 hits (012a `:216`, init via
  `per_store_rls_hardening:31`, new 040000). Helper redefinition
  chain is intact.
- `grep assert_brand_id_immutable_for_self|profiles_self_brand_lock`
  → 3 hits, all in spec 041's own files (spec body + migration +
  test). The trigger name and function name do not collide with
  any prior migration. No accidental cross-spec wiring.

Findings ranked Critical → Should-fix → Minor.

---

## Critical

None.

The helper redefinition is unchanged from round 1 (still correct).
The new trigger function and trigger ship as documented; the
pgTAP arms (7), (8), (9), (10) exercise the four meaningful paths
(self-write of brand_id rejected, self-write of role rejected,
super_admin cross-user write permitted, end-to-end attack still
denied after trigger fires). No critical drift introduced by the
expanded scope.

---

## Should-fix

### S1 (from round 1) — RESOLVED.

`raise exception` shipped at
`supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql:75-84`.
The `v_bad_count` variable is removed and the block uses the
canonical `if exists (...) then raise exception` idiom. The
misleading "Same idiom as 012a:327-331" comment is gone; the new
comment block at `:68-74` documents the exception semantics and
cross-references spec §0 Q4. This is exactly what the round 1
review asked for. Closed.

---

## Round-2 architectural review of the new trigger

The trigger was NOT in the original §1-§12 design. The architect's
round-1 review and design doc both ended at helper redefinition +
pgTAP. Reviewing it now as a structural addition:

### A1. Trigger pattern mirrors `user_stores_brand_match` (012a). Idiomatic.

Confirmed by reading
`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:357-386`:

- Both functions: `language plpgsql security definer set
  search_path = public[, auth]`.
- Both wired via `drop trigger if exists` + `create trigger …
  before {insert,update} on …`.
- Both raise an exception with a stable message on invariant
  violation.
- Both treat `NULL auth.uid()` (the postgres superuser path used
  by migrations/seed) as the bypass case — `user_stores_brand_match`
  bypasses on `v_user_brand IS NULL`, the new trigger bypasses on
  `old.id = auth.uid()` being NULL-comparison-false.

The new trigger goes slightly further by adding `auth` to
`search_path` (sibling has `public` only). That's correct because
the trigger body calls `auth.uid()` — same shape as
`auth_can_see_store` and `auth_is_super_admin` from 012a, which
both include `auth` in their search_path. Approved.

### A2. SECURITY DEFINER on the trigger function — correct.

Necessary. The trigger function calls `public.auth_is_super_admin()`,
which queries `public.profiles` (a table the caller may not have
full row-read access to under the "Users can read own profile"
policy at `supabase/migrations/20260502071736_remote_schema.sql:408-413`).
Running the trigger under the invoker's privileges would either
fail to find the super_admin row (false negative — would
reject super_admin's own writes) or require relaxing the
profiles SELECT policy (out of scope and dangerous).

The sibling `user_stores_brand_match` is also SECURITY DEFINER
for the same reason — it joins `profiles` and `stores` from
inside the trigger. Established precedent in this codebase.
Approved.

Note on SECURITY DEFINER ownership: the migration's `create or
replace function` runs as whoever applies the migration (postgres
in dev, supabase_admin or postgres in prod). The function then
runs with that owner's privileges. The owner can read all
profile rows. No ownership clause is needed because the default
is correct here, same as sibling functions. Approved.

### A3. Trigger over RLS WITH CHECK — appropriate choice.

The spec body at `:819-823` claims a trigger is preferred because
RLS WITH CHECK on "Users can update own profile" would require
dropping and recreating that policy (which is outside spec 041
scope). Verified: the policy at
`20260502071736_remote_schema.sql:417-422` has NO `with check`
clause today, so to add one the developer would need a
`drop policy if exists "Users can update own profile" on
public.profiles; create policy … with check (…);` pair —
invasive, and worse, the policy is shared with the "Admins can
update any profile" path which has the same row predicate. A
trigger fires for ALL update paths regardless of which policy
admitted the row, so it catches both:

1. brand-admin self-PATCH via "Users can update own profile";
2. brand-admin self-PATCH via "Admins can update any profile"
   (since the `id = auth.uid()` predicate appears in both
   policies' USING clauses).

A WITH CHECK on policy (1) only would still leak via policy (2).
The trigger is the structurally correct choice for cross-policy
invariants. This matches the established codebase pattern —
`user_stores_brand_match` exists for the same reason (catches
cross-brand inserts regardless of which RLS policy admitted the
row). Approved.

### A4. Role-lock as defense-in-depth — appropriate scope expansion.

The original spec body's §0 Q4 and §1-§9 only addressed brand
visibility. The role-lock arm of the new trigger (`old.role IS
DISTINCT FROM new.role` at migration `:186-189`) is technically
beyond the spec's stated scope (the spec was about brand
visibility, not role escalation). However:

1. The pre-existing privilege-escalation vector (a brand-admin
   self-promoting to `super_admin` via PATCH /rest/v1/profiles
   with `{"role": "super_admin"}`) was already in the codebase
   BEFORE spec 041, gated only by the same wide-open "Users can
   update own profile" policy.
2. Spec 041 makes the brand_id security-load-bearing for the
   first time, which gave the brand-admin a reason to attack
   the column. Closing brand_id without also closing role would
   be inconsistent: the attacker pivots to the role column
   (one PATCH away from super_admin, which short-circuits
   everything via the first arm of the helper).
3. The fix is two `if old.X is distinct from new.X` clauses in
   the same trigger. Splitting them across two specs would
   double the deploy surface for zero structural gain.

The spec body at `:810-818` documents the rationale (defense-
in-depth, propagation through `profiles_sync_role`). The "Known
follow-up work" section at `:861-880` correctly carves out the
two remaining cross-brand write loopholes (`order_schedule`
WRITE, "Admins can update any profile") as future specs. The
role-lock is the smallest scope expansion that closes the
chain without leaving a trivially-exploitable variant. Approved
as a scoped, justified expansion — NOT scope creep.

Flag for the record: spec discipline would normally prefer
"one spec, one invariant" — but the security-auditor's Critical
finding made the brand_id lockdown a release-blocker, and
splitting the trigger would have left an obvious adjacent
attack with the same shape unaddressed. Release-coordinator's
call to bundle was correct under the project's "fail-closed
on security boundary" convention.

### A5. NULL `auth.uid()` handling.

Migration lines `:179-181`:

```
if tg_op = 'UPDATE'
   and old.id = auth.uid()
   and not public.auth_is_super_admin() then
```

When the postgres superuser runs an UPDATE (migrations, seed,
ops backfill), `auth.uid()` returns NULL. The expression
`old.id = NULL` evaluates to NULL (never true), so the lockdown
branch is bypassed and the UPDATE proceeds. This is the same
pattern `user_stores_brand_match` uses at
`20260509000000:372-374`, where `v_user_brand IS NULL` (super-
admin and pre-multi-brand legacy rows) bypasses the check.
Verified by reading both functions side-by-side. Spec body at
`:828-831` documents this correctly. Approved.

### A6. Trigger does not loop or self-cascade.

The trigger fires `before update on public.profiles for each
row`. The trigger body does not perform any UPDATE on
`public.profiles`. The `super_admin_manage_profiles` policy and
the existing `profiles_sync_role` AFTER UPDATE trigger
(`20260424211732_recover_undeclared_tables.sql:134-137`) operate
on different timings (BEFORE vs AFTER) and don't reissue UPDATEs
through this trigger. No infinite-loop risk. Approved.

### A7. Stable error messages — testable.

Migration `:183-184` and `:187-188` use string literals that the
test file's `throws_ok` calls verify at `:257-260` and `:282-285`.
Any future refactor that changes the message text will break the
pgTAP test, surfacing the change at CI rather than silently
masking the security boundary. Stable-message-as-contract is the
right pattern here, same as `assert_not_last_of_role` (spec 031)
which uses `'cannot delete the last super_admin'` as a stable
contract. Approved.

---

## Spec body documentation accuracy (round-2 ask)

The new "Profile column-write lockdown" section at spec lines
`739-880` covers:

- the privilege-escalation chain (`:746-757`) — accurate;
- the chained "brand-bounce" variant (`:752-757`) — accurate
  and important to call out, the chain via `user_stores`
  permanence is the reason a session-time fix is insufficient;
- trigger design with the full function/trigger body
  (`:768-797`) — byte-identical to what shipped at migration
  `:168-199`, modulo whitespace;
- rationale (`:799-831`) — covers self-edit detection,
  super_admin bypass, role lockdown, trigger-over-WITH-CHECK,
  search_path, NULL handling. All correct;
- pre-flight DO block change (`:833-859`) — accurately
  reflects the S1 resolution;
- known follow-up work (`:861-880`) — `order_schedule` WRITE
  and "Admins can update any profile" cross-brand admin write.
  Both are real and explicitly out of scope. Carved correctly.

What the spec body does NOT mention but the code does:

- The trigger function has a `comment on function …` at
  migration `:201-202` pinning it to "spec 041 (review-round 1
  fix)". Spec body doesn't enumerate the comment. Non-issue —
  comments are documentation, not contract.

What the spec body documents that COULD be tightened:

- §12 "Files changed" at `:983-984` describes the trigger as
  living in the same migration file. Accurate. The amended
  `## Files changed` block at `:1014-1052` is also accurate
  and lists the four new test arms with the right names and
  assertion strings.

No drift between what shipped and what the spec body claims
shipped. Documentation is accurate. Approved.

---

## Minor (carried forward from round 1)

### M1. Super-admin arm tests only the foreign-brand store, not both. CARRIED FORWARD.

File: `supabase/tests/auth_can_see_store_brand_scope.test.sql:144-148`.

The new test file still only asserts `super_admin sees brand B
store` and drops the design's `super_admin sees brand A store`
positive control. The plan bump from 6→10 added four NEW arms
(7-10) but did not address M1.

Practical impact: trivially unchanged from round 1. If
super_admin sees the foreign store via the short-circuit, they
trivially see the brand-A store via the same short-circuit (the
helper's first OR-arm doesn't consult brand_id at all). M1 was
explicitly Minor in round 1 and remains Minor. No new severity
weight from the trigger work.

Recommendation: same as round 1 — add a second `is()` and bump
to `plan(11)`, or wrap into a single
`ok(public.auth_can_see_store(a) and public.auth_can_see_store(b), …)`
to keep `plan(10)`. The design's option-b. Current behavior is
correct; the test name is just slightly misleading about which
half of arm 3 it covers.

### M2. Helper body uses inline `auth_can_see_brand(s.brand_id)` instead of a direct profiles join — non-issue, carried forward unchanged.

File: `supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql:88-108`.

The helper body is byte-identical to round 1 (no change in the
fix pass — the round 2 deltas are only the pre-flight semantics
and the new trigger). Composition-over-denormalization, matches
the sibling helpers' style. Not a drift. Carried forward as
"approved, calling it out for the record."

### M3. Arm (3) JWT sets `app_metadata.role = 'super_admin'` — purely cosmetic.

File: `supabase/tests/auth_can_see_store_brand_scope.test.sql:139`.

Test arm 3 JWT impersonation is unchanged from round 1. The JWT
value `'super_admin'` is cosmetic because `auth_is_super_admin()`
reads `profiles.role`, not the JWT. Carried forward as
"approved, cosmetic."

---

## New Minor (round 2 only)

### M4. Arm (9) leaves the seed manager's `brand_id` in a non-seed state for arm (10).

File: `supabase/tests/auth_can_see_store_brand_scope.test.sql:311-313`.

Arm 9 issues
`update public.profiles set brand_id = brand_b where id =
manager_id` under super_admin's JWT, then arm 10 starts with a
`reset role` + a defensive re-affirmation of the SEED ADMIN's
brand_id (not the manager's). The manager's brand_id remains
`brand_b` from arm 9 onward (until the file's final `rollback`).

This is fine in isolation — arm 10 impersonates the admin
(brand A), not the manager, so the manager's mid-transaction
brand_id state doesn't affect arm 10's outcome. But arm 9's side
effect leaks across arm boundaries in a way that's subtly
order-dependent: if a future arm (11) is added that impersonates
the manager, the dev will need to remember that the manager's
brand_id was mutated by arm 9.

Test file commentary at `:331-335` explicitly acknowledges this
("we set brand_id back to brand A before the impersonation
because arm (9) just moved the seed manager (NOT the seed
admin)"). The acknowledgement is correct; it just means the test
file has a hidden state dependency.

Practical impact: zero today (the rollback at `:361` resets
everything). Severity Minor because it's a maintenance hazard,
not a correctness issue.

Recommendation: optional. Either (a) wrap arm 9 in its own
nested savepoint and roll that back after the assertion, so each
arm is independently undoable; or (b) leave as-is and the file's
comment at `:331-335` is the audit trail. Both acceptable. Spec
041 ships clean either way.

### M5. Spec body §9 (lines 661-714) is now stale relative to the test file.

File: `specs/041-brand-scoped-store-visibility.md:660-714`.

The original design §9 documents a 6-arm plan. The shipped test
file has 10 arms. The spec body's §9 was NOT updated to reflect
the new arms 7-10; instead, the new arms are documented in §12
"Files changed" (`:1024-1034`) and the rationale lives in the
new "Profile column-write lockdown" section (`:739-880`).

This is split documentation: the canonical pgTAP plan now lives
across §9 (arms 1-6, unchanged), the "Profile column-write
lockdown" section (rationale for arms 7-10), and §12 (the
explicit "arm N: blurb" list). A future reader looking at §9
will conclude `plan(6)` is the contract, miss the four added
arms unless they read §12.

Practical impact: low — the spec is internally consistent if you
read the WHOLE file, and the migration + test files are the
canonical contract. But §9 is now drift-prone documentation:
the next architect re-deriving the pgTAP plan from §9 would
under-plan.

Recommendation: optional follow-up to either (a) extend §9 to
list arms 7-10 inline with arms 1-6, or (b) add a brief
forward-reference at the head of §9 ("note: arms 7-10 added per
review-round 1, documented at line 739 / line 1024"). Severity
Minor because the contract IS captured elsewhere in the file —
just not in the section labeled "pgTAP test plan."

---

## What drifted and IS better than the design

### B1. (carried forward) Comment-on-function present on `auth_can_see_store`.

Migration `:122-123`. Optional per design §0 Q6; dev included it.
Approved.

### B2. (carried forward) Helper file header documentation block.

Migration `:1-52`. Substantive explanation of the three-arm
semantics, the cascade mechanism, and cross-references to spec
sections. Round 1 approved this; round 2 also adds a "Profile
column-write lockdown" subsection to the same block at `:31-51`,
which is the right place for it. Approved.

### B3. (carried forward) Test fixture uses `set_config` constants stash.

Test file `:45-64`. Pattern matches
`delete_last_privileged_guard.test.sql`. Approved.

### B4. (NEW round 2) `comment on function` on the lockdown helper.

Migration `:201-202`:

```
'spec 041 (review-round 1 fix): rejects self-UPDATE of
 profiles.brand_id or profiles.role for non-super_admin
 callers. Closes a privilege-escalation chain where a brand-
 admin could PATCH their own brand_id to gain cross-brand
 visibility via the tightened auth_can_see_store helper.'
```

This wasn't requested anywhere — the dev added it as a parallel
to the `auth_can_see_store` comment. Same audit-trail benefit:
the next architect sees the spec linkage and the chain rationale
without re-deriving from migration history. Approved.

### B5. (NEW round 2) End-to-end arm (10) is the right test to ship.

Test file `:323-357`. Arms (7) and (8) prove the trigger fires;
arm (10) proves that even AFTER the trigger fires and rejects
the UPDATE, the brand-admin CANNOT see the foreign store via
the helper. This is the "chain closes at step 1" invariant —
the round 1 review wouldn't have asked for arm (10) (it wasn't
in scope), but the developer included it as a regression
test for the entire security chain rather than just the trigger.
Future regressions on the helper, the trigger, OR the policy
that admits the UPDATE all surface via arm (10). Approved.

---

## No drift on the cascade scope

Re-verified by `grep create or replace function public.auth_can_see_store
supabase/migrations/` — 3 hits, same as round 1 (init via
`per_store_rls_hardening:31`, 012a `:216`, new 040000 `:88`).

`grep grant execute on function public.auth_can_see_store` —
only the new 040000 migration grants explicitly. 012a chain
relied on the implicit PUBLIC default.

Working tree at conversation start: clean. No additional
migrations beyond the two declared in `## Files changed`. The
trigger function and its trigger DDL are inside the single
spec-041 migration; no separate migration was added.

---

## No drift on out-of-scope

Confirmed:

- `src/components/cmd/TitleBar.tsx` — unchanged (still has the
  `accessibleStores` filter; spec body line 99 explicitly says
  this is correct-by-construction).
- `src/lib/db.ts`, `src/store/useStore.ts` — not in `## Files
  changed`, no edits.
- `supabase/functions/*` — not in `## Files changed`, no edits.
- `supabase/config.toml` — no `verify_jwt` toggle, no edits.
- `app.json` — spec line 111 explicit; not touched.
- `supabase/seed.sql` — spec line 1050 explicit; not touched.
  The foreign brand + foreign store rows are inserted INSIDE
  the test's begin/rollback (`:70-83`), so the seed bytes on
  disk are unchanged.
- Existing pgTAP files under `supabase/tests/*.test.sql` —
  unchanged. The new test file is additive.
- "Users can update own profile" policy at
  `20260502071736_remote_schema.sql:417-422` — unchanged (the
  trigger is additive, the policy itself stays as-is).
- "Admins can update any profile" policy at `:390-395` —
  unchanged. Correctly carved out as follow-up at spec `:872-878`.
- `order_schedule` WRITE policy at
  `20260510020000_order_schedule_super_admin_rls.sql:28-31` —
  unchanged. Correctly carved out as follow-up at spec `:867-871`.

No scope creep beyond the trigger lockdown (which IS justified
per A4 above).

---

## Summary

- 0 Critical (unchanged from round 1).
- 0 Should-fix (S1 resolved).
- 5 Minor:
  - M1 (super_admin arm coverage) carried forward unchanged.
  - M2 (helper composition style) carried forward unchanged.
  - M3 (cosmetic JWT in arm 3) carried forward unchanged.
  - M4 (NEW) arm 9 leaves mid-txn brand_id state for arm 10.
  - M5 (NEW) spec §9 is stale relative to the shipped 10-arm plan.
- 5 design-exceeding callouts (B1, B2, B3 carried forward; B4
  trigger comment-on-function and B5 end-to-end arm 10 are new).

**Round-2-specific verdict on the trigger expansion:** The
addition is well-conceived, structurally aligned with the
sibling `user_stores_brand_match` trigger, and correctly scoped.
SECURITY DEFINER is justified. The role-lock arm is appropriate
defense-in-depth rather than scope creep, given that brand_id
becoming a security boundary in spec 041 gave the attacker a
trivial pivot to the role column. Spec body documentation
accurately reflects what shipped, modulo the §9 staleness flagged
as M5. No architectural concerns block release.

**Recommendation to release-coordinator:** SHIP. The 5 Minors
are all optional polish (3 carried forward from round 1, 2 new
and bounded). None block the security fix.

## Handoff
next_agent: NONE
prompt: Architectural drift re-review (round 2) complete after
  the security-auditor-driven fix pass. 0 Critical, 0 Should-fix,
  5 Minor (3 carried forward from round 1, 2 new). The trigger
  expansion is well-conceived and correctly scoped; the
  pre-flight raise-exception fix matches design intent. Spec
  body documentation matches what shipped. Release-coordinator
  should proceed with SHIP_READY if other reviewer files
  (security-auditor, code-reviewer, test-engineer) also clear.
payload_paths:
  - specs/041-brand-scoped-store-visibility/reviews/backend-architect.md
