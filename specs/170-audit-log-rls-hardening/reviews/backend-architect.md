# Spec 170 — backend-architect post-implementation review

Reviewer: backend-architect (drift review against `## Backend design` in [specs/170-audit-log-rls-hardening.md](../../170-audit-log-rls-hardening.md)).
Date: 2026-10-22.

Files reviewed:
- `supabase/migrations/20261022000000_audit_log_rls_hardening.sql`
- `supabase/tests/audit_log_rls_hardening.test.sql`
- `supabase/tests/super_admin_policy_parity.test.sql`
- `src/lib/db.ts` (`deleteStore`, lines 178-189)

## Verdict

The contract matches the design. The policy DDL, names, kinds, `to` clause (none), the four `comment on policy` texts, the `begin/commit` wrapper, idempotency, the header, and the rollback block (it matches `20260809000000:199-216` verbatim) all match §1. The two spec-157 permissive policies are untouched. `deleteStore` matches §6. The parity-file amendment matches §10b. The new pgTAP file implements all 45 arms in §10a in the prescribed order.

There are no Critical findings. There is one Should-fix, and it is a gap in **my design** rather than developer drift: D-4 cannot tell the new DELETE scope clause apart from the pre-existing SELECT policy. There are also three Minor items.

| Severity | Count |
|---|---|
| Critical | 0 |
| Should-fix | 1 |
| Minor | 3 |

---

## Critical

None.

---

## Should-fix

### SF-1. D-4 (AC-14) does not prove the DELETE policy's brand scope. It is masked by the SELECT policy. Design gap, not drift.

**Where:** `supabase/tests/audit_log_rls_hardening.test.sql:528` (the attempt) and `:686-691` (the read-back).

**The developer's observation is correct.** The attempt is `delete from public.audit_log where id = '…0023'`. Its WHERE clause references a column, so Postgres also applies the **SELECT** policies' USING clause to the target rows. Per the CREATE POLICY docs, the DELETE row of "Policies Applied by Command Type" checks SELECT USING "if read access is required … e.g. a WHERE or RETURNING clause that refers to columns". For a store-scoped row, `store_member_read_audit_log` is `store_id is not null and auth_can_see_store(store_id)`. That is the same predicate as the new DELETE scope arm. The brand-A admin therefore never sees the brand-B row, and the delete affects 0 rows under:
- the spec 170 policy;
- the spec 157 unscoped `using (auth_is_privileged())`;
- a hypothetical `admin_delete_audit_log` with the `auth_can_see_store(store_id)` arm deleted outright.

So D-4 meets AC-14 **literally** (the row survives), but it is not a regression guard for the clause it is named after. Only S-5's `qual like '%auth_can_see_store(store_id)%'` text check pins that clause, and it is static.

**Did the design intend something stronger? Yes.** §10a held every other arm to an "only the predicate under test can refuse" standard: I-4..I-7 put `store_id = S1, user_id = staff` so that only (b) can refuse, W-2/W-3 call the RPCs from an RLS-subject role so the owner bypass is what admits them, and the read-back rule removes vacuous survival checks. I applied that standard to the read-back, but I did not apply it to the **attempt**: I did not account for SELECT policies joining a column-filtered DELETE. D-4 is the only arm affected:
- D-1, D-2, D-5, U-1 and U-2 target rows the caller *can* SELECT, so they are sharp. Under spec 157, D-5's store-less row is visible to admin through `store_id is null and auth_is_privileged()`, and the old DELETE would have removed it.
- D-7 (staff) was refused under spec 157 as well, but AC-16 is a no-regression arm, so that is acceptable.

**Why the clause still matters (so it is worth pinning behaviorally).** The scope arm is load-bearing whenever the DELETE does not need read access:
- A column-free delete (`delete from public.audit_log`, or `… where true`) from any non-PostgREST path, or from a future SECURITY INVOKER RPC. Under spec 157 such a statement run by a brand-A admin erased **every brand's** audit rows. Spec 170 is the first state where it cannot.
- A future widening of a SELECT policy on audit_log, such as a new permissive SELECT for a reporting role. The DELETE scope would then be the only thing standing.

PostgREST filters always reference a column, so through the API today the SELECT mask also applies. The clause is defense in depth there, and the primary control for the paths listed above.

**Recommended fix (developer, small):** add one arm, **D-10**, and bump `plan(45)` to `plan(46)`. Note the bump in the file header as §10a allows. Shape:
1. Fixture (as postgres, with the others): one more 91-day S1 control row, id `a5000170-…-000000000027`, action `__test_spec170_d10_control__`. Brand-B row `…0023` is reused as the target.
2. Place the attempt **after** every existing read-back assert and immediately before `finish()`. It removes all brand-A rows older than 90 days, including seed rows and `…0026`, so it must not precede D-7's read-back. Re-enter `set local role authenticated` with the admin JWT and run `delete from public.audit_log where true;`. Use `where true`, not a bare `DELETE`. It references no column, so SELECT policies are not applied, and it also survives `pg-safeupdate` if that is ever loaded. Then `reset role`.
3. Assert as postgres with one `ok()`: `exists(…0023)` (brand-B 91-day row survives) **and** `not exists(…0027)` (the in-scope control is gone). The control proves the statement executed and the DELETE policy admitted in-scope rows. Without it, a no-op delete would pass vacuously.
4. **Negative control, run once locally and not committed:** temporarily recreate the spec 157 `admin_delete_audit_log` (`using (public.auth_is_privileged())`) and confirm D-10 fails, because `…0023` is erased. Record "verified against a spec 157 negative control" in the arm comment. Spec 157's IC-3 documents the same practice in `super_admin_policy_parity.test.sql:186-191`.

Keep D-4 as is. It is still the correct AC-14 arm for the PostgREST-shaped (column-filtered) delete. Amend its message or comment to say that it passes under the SELECT mask and that D-10 is the clause-isolating arm.

**Severity rationale:** this is Should-fix, not Critical. The policy is correct, AC-14 as written is satisfied, and S-5 statically pins the predicate text. The gap is a weaker regression guard than the design's own standard on the arm that pins the core FUTURE-1 fix. Not blocking for SHIP_READY in my judgment, but cheap to close in this PR.

---

## Minor

### M-1. S-7's `count(*) = 5` hard-fails if any of the five writers gains an overload.

`audit_log_rls_hardening.test.sql:265-272`. A future overload of, say, `staff_submit_eod` would make the count 6 and turn S-7 red, even though owner bypass still holds. That is arguably the desired loud failure, because the new overload must also be postgres-owned. It is noted only so the next person reads the failure correctly. No change is required.

### M-2. The D-4 assertion message overstates what it proves.

`audit_log_rls_hardening.test.sql:690`. "admin (brand A) DELETE of a 91-day brand-B row affects 0 rows" is true, but a reader will assume it exercises `admin_delete_audit_log`'s scope. Fold the wording fix into SF-1. If SF-1 is deferred, at minimum add a comment above line 686 that says it is SELECT-masked.

### M-3. AL-6 / AL-10 keep the parity intent. Confirm the spec 170 cross-reference holds.

`super_admin_policy_parity.test.sql:127-145, 234-245, 407-417`. Both aged fixtures are on Towson, which super_admin and the master-as-super_admin can SELECT, so the count-0 read-backs are not vacuous. The header's "Spec 170 amendment" paragraph (`:35-47`) correctly points fresh-row refusal at D-1/D-2. No change; recorded as verified.

---

## Contract conformance checklist

| Design item | Result |
|---|---|
| §1 filename `20261022000000_audit_log_rls_hardening.sql`, single newest migration | Matches. It is the only `2026102*` file. |
| §1 `begin; … commit;`, `drop policy if exists` before each create, re-runnable | Matches (`:88-156`). Developer reports two re-runs as a no-op. |
| §1 (a)/(b)/(c) RESTRICTIVE, no `to` clause, predicates verbatim | Matches (`:93-130`). |
| §1 (d) `admin_update_audit_log` dropped, no replacement, no comment | Matches (`:136`). |
| §1 (e) same name, PERMISSIVE, scoped + 90-day predicate, no WITH CHECK | Matches (`:141-151`). |
| §1 four `spec 170: ` comments, required content | Matches verbatim (`:102-103, 117-118, 132-133, 153-154`). |
| §1 header: rationale, first-RESTRICTIVE note, FORCE-RLS rationale, realtime note, rollback | Matches (`:1-86`). The rollback is byte-identical to `20260809000000:199-216`. |
| `store_member_read/insert_audit_log` untouched | Matches. S-3/S-4 pin the literals captured before the migration. |
| No `auth_is_admin()` in new predicates (LINT-1) | Matches. |
| No grant / publication / table change (§7, §8) | Matches. |
| §6 `deleteStore`: only the audit_log line removed, the other six awaits in order, optional comment | Matches (`src/lib/db.ts:181-187`). The comment was added. |
| §6 `cleanupOldRecords`, `addAuditEvent`, `fetchAuditLog` unchanged | Not modified per the spec's Files changed list. No other `db.ts` hunk relates to spec 170. |
| §10a 45 arms, ordering, read-back rule, in-txn grants for W-2/W-3, D-8 + D-9 | Matches. See SF-1 for D-4 sharpness. |
| §10b AL-5/AL-9 flipped, AL-6/AL-10 aged, `plan(20)` unchanged, header amended | Matches. |
| Nothing bypasses `src/lib/db.ts` | Confirmed. No new client DB access. |

## Follow-ups (unchanged from design, restated for the release-coordinator)

F-170-1 (`created_at = now()` restrictive INSERT check), F-170-2 (dead `deleteStore`), F-170-3 (PO RPC audit writes behind a DEFINER helper), F-170-4 (brand-scope the privileged on-behalf `user_id`). None are blocking.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 1 Should-fix (SF-1: D-4 is SELECT-masked and does not isolate the DELETE scope clause; add a column-free-delete arm D-10 with an in-scope control and a one-time spec-157 negative control), 3 Minor.
payload_paths:
  - specs/170-audit-log-rls-hardening/reviews/backend-architect.md

---

## Delta re-review (fix pass)

Date: 2026-10-22. Reviewer: backend-architect (post-impl, delta only). Status not changed.

Files re-read:
- `supabase/migrations/20261022000000_audit_log_rls_hardening.sql` (all lines)
- `supabase/tests/audit_log_rls_hardening.test.sql` (all lines)
- `supabase/tests/super_admin_policy_parity.test.sql` (`:20-235`, `:300-360`)
- `src/lib/db.ts:178-189` and `:2836-2847`
- `specs/170-audit-log-rls-hardening.md`: AC-22/23, decision 9, §1, §4, §10a, §10b, §11, §12, §13, follow-ups, Files changed

### Verdict

**SF-1 is closed.** The fix-pass code matches decision 9 and the updated spec contract. There are no new Critical or Should-fix findings. The spec text has a few stale counts in prose that the fix pass did not reach (DM-1). They are Minor and do not affect the contract, the policy count, or the comment count.

| Severity | Count (delta) |
|---|---|
| Critical | 0 |
| Should-fix | 0 (SF-1 closed) |
| Minor | 2 new (DM-1, DM-2); prior M-2 closed, M-1 unchanged, M-3 strengthened |

### SF-1: closed (the developer's mechanism differs from mine and is better)

D-10 does not use the `delete … where true` shape I recommended. It removes the SELECT mask directly instead (`audit_log_rls_hardening.test.sql:620-641`, read-back `:834-844`):
1. As postgres, it adds an in-txn permissive `probe_wide_select … using (true)`.
2. As the admin JWT, it records that the new brand-B 91-day fixture `…0027` is visible (`test.d10_visible`). Then it deletes `…0027` by id.
3. It drops the probe at once and asserts as postgres:
   - the precondition was `'1'`;
   - the row survives;
   - the probe is gone.

Why this closes the gap:
- **The clause is isolated.** With the probe, SELECT USING is true for the admin. The restrictive (a) admits it because the action is not a store-user action. `admin_delete_audit_log` evaluates privileged = true and aged = true, so only `auth_can_see_store(store_id)` can refuse. The arm comment (`:626-628`) records a negative control against spec 157's `using (auth_is_privileged())` and against the mutant `auth_can_see_store(store_id) or true`. That meets the standard I asked for.
- **The vacuous-pass guard is stronger than my control-row idea.** The visibility precondition fails the arm if the probe ever stops unmasking. D-3 already proves that the DELETE policy admits in-scope aged rows, so no separate in-scope control is needed.
- **There is no collateral.** My `where true` shape would have purged every brand-A aged row, seed rows included, and forced D-10 to run last. The by-id delete affects only `…0027`. It is a dedicated fixture (`:152-154`), not a reuse of D-4's `…0023`, which keeps the one-fixture-per-(caller, arm) read-back rule.
- **Probe hygiene is correct.** It is created and dropped inside the admin block, so no later arm (super_admin, service_role, read-back) runs with it. It rolls back with the txn either way. `permissive_policy_lint.test.sql` runs in its own txn and cannot see it. The read-back also asserts that the probe is absent.

Prior M-2 is closed. D-4's comment (`:795-798`) and message (`:802`) now say "SELECT-masked; D-10 isolates the DELETE scope".

### Decision 9 / policy (f): conforms

- **Migration `:167-179`.** The policy is RESTRICTIVE INSERT with no `to` clause and uses `with check (created_at = now())`. It has `drop policy if exists` before `create` and sits inside the existing `begin/commit`. Name and predicate match spec §1 `:241-249` and decision 9 verbatim.
- **Header `:29-38`.** It documents (f), the default-before-WITH-CHECK semantics, and the choice not to add `NOT NULL`. The restrictive note (`:45-48`) now lists (a)/(b)/(c)/(f). The rollback (`:71-74`) gains the fourth `drop policy if exists`, and the rest is still the spec 157 text.
- **Semantics.** I checked these independently:
  - `audit_log.created_at` is `timestamptz default now()` (`init_schema.sql:204`), not a `timezone('utc', now())` default, so default and check compare the same type and the same transaction clock.
  - NULL gives `NULL = now()`, which is NULL, so the row is rejected (fail-closed).
  - **No RLS-subject writer sets `created_at`:**
    - `addAuditEvent` (`db.ts:2838-2845`) inserts six columns, without `created_at`.
    - A multiline grep of `insert into [public.]audit_log (… created_at` over `supabase/migrations/` finds nothing.
    - `src/screens/staff/` has no `audit_log` reference.
    - `scripts/` only reads or deletes as psql, and the only `manage-store-user` insert is service_role.
- **C-7 (admin, `now() - 91 days`, `:595-601`) matters.** Without (f), an admin could insert a pre-aged row and then delete it at once under (e). C-7 pins that this compose-attack is closed.
- **C-1..C-8 isolation.** Every C arm uses store S1, `user_id` = the caller, and a non-server-only action, so only (f) can refuse. C-4 and C-8 prove the omitted-column path. This matches AC-22/AC-23 and the §10a rows `:410-413`.

### Counts: spec text matches code

| Check | Code | Spec |
|---|---|---|
| Policies on `public.audit_log` | 7: 2 untouched permissive + (a), (b), (c), (e), (f). S-1 string `:224-230`; the sort order is correct (`admin_` < `audit_`; `actor` < `created` < `server`) | §10a S-1 `:375` = seven, listed; §12 post-check `:466` = seven |
| `spec 170:` comments | 5: (a) `:113`, (b) `:128`, (c) `:143`, (e) `:164`, (f) `:178`. S-6 `:282` = 5 | §1 `:265` "Exactly five"; §10a S-6 `:380` = 5; §12 `:466` = 5 |
| UPDATE policies | 0 (S-2) | AC-1, §1 (d) |
| `plan()` | 54 = 45 + 8 C + 1 D-10 | §10a heading `:349` = 54 |
| Parity file `plan()` | 20, unchanged | §10b `:421` |

### Parity file: AL-8 re-aged correctly (strengthens prior M-3)

The fixture `…0004` is now `now() - interval '91 days'` (`super_admin_policy_parity.test.sql:155-157`). The plain user holds a `user_stores` grant on Towson, so `auth_can_see_store` and the age gate both admit. Only `auth_is_privileged()` in (e) can refuse. The read-back runs as the plain user, who can still SELECT the row (ordinary action, own store), so it is not vacuous: a wrongful delete makes `detail` NULL and fails the arm. The developer reports a mutation check (removing `auth_is_privileged()` fails AL-8). The header (`:30-32`, `:50-58`), the fixture note (`:85-89`) and the arm comment (`:348-349`) all match. AL-1's store-less super_admin insert omits `created_at` and still passes (f).

### `src/lib/db.ts:179`

This is a comment-only change. The `deleteStore` body is unchanged since the first review: six awaits in order, and the audit_log line replaced by the `:185` comment. There is no other spec-170 hunk.

### New Minor findings

**DM-1. Stale counts in spec prose that the fix pass did not update.** None of them change the contract. All are in `specs/170-audit-log-rls-hardening.md`:
- `:186` §1 header requirement says the rollback has "three `drop policy if exists` statements for the restrictive policies". The code has four (`migration:71-74`).
- `:256` "three rows added" should be four (restrictive (a)/(b)/(c)/(f)).
- `:258` "Two INSERT restrictive policies, not one combined" should be three. The rationale (one cause per 42501) applies to (f) unchanged.
- `:371` §10a "**Arm map (45):**" should be 54. The heading at `:349` is already right.
- `:417` "Keep the plan count at 45". The ordering sentence also omits where the new arms sit: C-1..C-4 in the staff block after I-7, C-5..C-8 in the admin block after I-16, the D-10 attempt in the admin block after the D-9 store delete, and the D-10 read-back last.
- `:423` §10b fixture bullet still names only `…0002`/`…0006` as aged. `…0004` is also aged now; the review-fix note at `:430` says so, but the bullet contradicts it.
- `:445` §11 "(new, `plan(45)`)". This is historical design text and could stay, but should read 54 or carry "(54 after the fix pass)".
- `:481` §13 "cannot bypass (a) / (b) / (c)" should include (f). The migration header `:48` already does.

Fix: a docs-only touch-up in the spec. No code change.

**DM-2. The migration header at `:57` overstates (f)'s FORCE-RLS effect.** It says "FORCE RLS would make (b)/(c)/(f) refuse those writers". The DEFINER writers omit `created_at`, so (f) would admit them even under FORCE RLS. Only (b) (server-only actions) and (c) (NULL `user_id`) would refuse. The conclusion (do not FORCE RLS) is still correct. Cosmetic: change it to "(b)/(c)", or leave it.

### Prior findings status

| ID | Status |
|---|---|
| SF-1 | **Closed** (D-10 with a wide-SELECT probe, visibility precondition, dedicated fixture, and a recorded negative control) |
| M-1 | Unchanged (S-7 `count(*) = 5` overload sensitivity; no change required) |
| M-2 | **Closed** (D-4 comment and message) |
| M-3 | Verified, and strengthened by the AL-8 re-age |

### Handoff (fix pass)
next_agent: NONE
prompt: Architectural delta re-review complete. SF-1 closed. 0 Critical, 0 Should-fix, 2 new Minor (DM-1 stale counts in spec prose at :186/:256/:258/:371/:417/:423/:445/:481; DM-2 the migration header :57 lists (f) among the policies FORCE RLS would make refuse). Policy count 7 and comment count 5 match between spec and code.
payload_paths:
  - specs/170-audit-log-rls-hardening/reviews/backend-architect.md
