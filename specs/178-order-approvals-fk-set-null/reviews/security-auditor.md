## Security audit for spec 178

Auditor: security-auditor, 2026-11-08. Read-only review of the working tree.

**How this was checked:** by reading the code plus read-only catalog queries on the LOCAL stack (`supabase_db_imr-inventory`). No writes were run, not even rolled-back probes, because a pgTAP run may be in progress. Prod was not touched. So:
- The exploit chains below are traced step by step through the live policy and function text, but **not executed**.
- Parent-table policies were read locally. Prod's were not compared.
- The test file was read, not run.

**Bottom line:** the guard does what it says. No API caller can clear or change either pointer with an UPDATE while the referenced row exists. The relaxation does open a different route: a privileged caller can delete the parent row, and nothing blocks that any more. No Critical or High findings.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium

**M1. An admin can erase their own name from their approvals and keep their account, using a second admin login.**
- **Where:**
  - `supabase/migrations/20261108000000_order_approvals_fk_set_null.sql:56-61` (what now lets it through)
  - `supabase/migrations/20260517060000_profiles_rls_sweep.sql:127` (`Admins can delete profiles`)
  - `supabase/migrations/20261007000000_profiles_insert_hardening.sql:133` (`register_invited_profile`) and `:277` (`Admins can insert invitations`)
  - `specs/178-order-approvals-fk-set-null.md:47-49` (the Security claim)
- **The chain.** A is the approver and B is another admin in the same brand.
  1. B calls `DELETE /rest/v1/profiles?id=eq.<A>`. The policy allows it (privileged, same brand). `profiles_self_delete_lock` only stops self-deletes. This goes straight to PostgREST, so it skips `delete-user` and leaves A's `auth.users` row in place. The foreign key nulls `approved_by`, and the guard now allows that.
  2. B inserts an invitation: A's email, `role='admin'`, `brand_id` = the brand.
  3. A signs in, since the login still exists, and calls `rpc/register_invited_profile`. No profile exists, the email matches, so it inserts a profile with A's **original UUID** and `role='admin'`. `profiles_sync_role_to_jwt` restores the JWT role.
- **Result:** A is back with the same id, email and role, and `approved_by` is NULL on all of A's approvals, including frozen `ordered` rows.
- **One person is enough.** Brand admins can invite `role='admin'`, so A can create B from an email address A controls, then remove B with `delete-user` afterwards. `delete-user` writes no `audit_log` row.
- **What was stopping this:** only the old guard, by accident. Before this migration, step 1 failed for anyone who had approved an order.
- **What is left afterwards:**
  - `updated_at` on the approval rows gives the time of the erasure, not the actor.
  - `profiles.created_at` is reset.
  - The used invitation row remains, but any privileged caller can delete invitations (the policy has no brand scope).
  - I found no second record of the approver: the approve flow in `useStore` writes no audit row, and `audit_log.user_id` and `vendor_order_attempts.attempted_by` are also `SET NULL`.
- **Plain deletion also erases.** Any same-brand admin can do it through `delete-user` or PostgREST, without the restore. A super_admin can also delete their own profile directly: `assert_profile_self_delete_blocked` exempts them, and the direct path skips the edge function's self-guard and last-of-role guard. The bypass itself is older than this spec, but it now also erases approver names.
- **Who cannot do this:** staff (`user` role) and anon. Both the profile and store DELETE policies require `auth_is_privileged()`.
- **Why Medium and not High:**
  - It needs a privileged insider and grants no new access or cross-brand reach.
  - Prod has 0 approvals, so nothing is exposed today.
  - An insider planning fraud could already approve under a throwaway invited admin. What is new is erasing after the fact.
  - If approvals are relied on for financial accountability, treat this as High. That is the owner's call.
- **Fix:**
  - **(a) Correct the spec.** Lines 47-49 are true for UPDATE but read as if no client can clear a pointer. State the delete route and accept it explicitly.
  - **(b) Keep the attribution.** Add an immutable `approved_by_name`/`approved_by_email` snapshot, set on INSERT and covered by the guard. This is the real fix, because attribution then survives every path. It is a table change, so it needs its own spec or a scope change here.
  - **(c) Close the restore path.** Drop the direct `Admins can delete profiles` policy so deletion only goes through `delete-user`, which also removes `auth.users`. No `from('profiles').delete()` exists in `src/`. Spec 043 and its tests refer to this policy, so check them first.
  - **(d)** Have `delete-user` write an audit row naming caller and target.

**M2. A single brand admin can now delete a store and with it every approval row. This was blocked before for approvals linked to a submission.**
- **Where:**
  - `supabase/migrations/20261108000000_order_approvals_fk_set_null.sql:63-68`
  - `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:638` (`privileged_delete_stores`)
  - `specs/178-order-approvals-fk-set-null.md:35`
- **Why it changed:**
  - Before: `DELETE /rest/v1/stores?id=eq.<id>` cascaded to `eod_submissions`, then tried to null `source_submission_id`, and the guard refused. The whole delete failed for any store with a linked approval, which is the normal case (`src/store/useStore.ts:4407` always passes the submission id). Local RI trigger names put the `eod_submissions` cascade first.
  - After: the delete succeeds and removes the approval rows, along with the store's `audit_log`, `notifications` and `vendor_order_attempts` rows.
- **Spec wording:** line 35 says the approval is lost in a store delete, which "cascades as it always has". The cascade always existed, but it could not complete for these rows.
- **Severity:**
  - One call, one actor, and the whole row goes, not just a pointer. Nothing records the deletion: `stores` has no triggers, and `brand_deletion_log` covers brands only.
  - It is also loud (the store disappears) and self-defeating as a way to hide one order.
  - Stores with no linked approvals could already be deleted this way, so only the linked case is new.
  - `hard_delete_brand` (super_admin only) gets the same unblocking and is not listed in the spec.
- **Fix:** record the decision in the spec. If approvals must outlive a store, the options are to soft-delete stores that have approvals or to write a deletion record outside the cascade. That is a follow-up, not part of this migration.

### Low

**L1. The spec's purge and store-delete paths don't happen for API callers, which also answers the open question at the end of the spec.**
- **Where:** `specs/178-order-approvals-fk-set-null.md:18-19,74-76`; `src/lib/db.ts:187,6243`; `supabase/migrations/20260514120030_eod_submissions_consistency.sql:192`
- **Detail:**
  - `eod_submissions` has **no DELETE policy**. It was dropped deliberately in the migration above.
  - `cleanupOldRecords` and `db.deleteStore` use the caller's token, so their `eod_submissions` deletes match 0 rows and return no error. The purge never reaches the guard and logs no warning.
  - This very likely explains the 66 unpurged submissions past 90 days on prod. I confirmed the missing policy locally only.
  - The real failing store path was the `stores` cascade in M2.
- **Upside:** an API caller cannot erase `source_submission_id` except by deleting the store. M1 has no equivalent for submissions.
- **Warning:** if someone "fixes" the purge by re-adding a DELETE policy, store-scoped callers could erase that pointer and the EOD record. Run the purge server-side instead.
- **Fix:** correct the table rows and the closing note.

**L2. Three test assertions pass whether or not the behaviour they claim happened.** `supabase/tests/order_approvals_fk_set_null.test.sql`
- **D2b (L230-235) and D3b (L243-248):** both claim "the row survives", but `is((select approved_by ... ), null::uuid)` also passes when the row is gone, because the scalar subquery returns NULL. If `source_submission_id` were changed to `ON DELETE CASCADE`, D3b would still pass. Add an `exists` or count check.
- **D1b (L216-222):** claims `approved_by` is nulled on "both" approvals. For `oa4`, `source_submission_id` is NULL, so the expression is `false` whatever `approved_by` holds. Only `oa1` is really checked. Select `approved_by is null` alone.

**L3. Test coverage gaps.** Same file.
- **The real store-delete path is untested.** D4 (L251-255) deletes `eod_submissions` first, as postgres. For an API caller that statement deletes nothing (L1), so the path that matters is a `stores` delete alone, which chains cascade, SET NULL and guard. From reading it, it should pass in either RI trigger order. Add an arm.
- **D3 is labelled "90-day purge" (L247)** but runs as postgres, which the purge never does. It does test the FK path correctly, so only the label is wrong.
- **Every D arm runs as postgres.** No arm shows what a brand admin can or cannot delete, so M1's step 1 and the staff refusal are unpinned.
- **Untested move types:** `approved_by` NULL to value, `source_submission_id` value to another value, and G5's hidden-row case for a submission. The code is symmetric, so these only guard against regressions.

G1-G4 and G5 are sound. G5's shape fails safely: an RLS-filtered zero-row update records `update allowed` and fails the arm, and G5a/G5b pin the setup. Under SECURITY INVOKER the hidden profile would look deleted and G5 would fail, which matches the spec's hand check. I did not repeat that flip.

**L4. An approval with no approver can keep advancing.** `supabase/migrations/20261108000000_order_approvals_fk_set_null.sql:73-79`, `supabase/migrations/20260801000100_order_approvals.sql:435-443`
- This is a newly reachable state. After a pending row's approver is deleted, any other admin can rewrite its lines through the retry path and move it to `approved` and `ordered`, leaving `approved_by` NULL.
- Related older behaviour: the retry path never re-stamps `approved_by`, so a second admin's lines already appear under the first admin's name.
- Nothing crashes, since `mapOrderApproval` handles NULL (`src/lib/db.ts:2682`). If M1(b) goes ahead, decide whether leaving `pending` should require a non-NULL approver.

**L5. The prod-apply check doesn't cover the property the spec calls load-bearing.** `specs/178-order-approvals-fk-set-null.md:65-68`
- Normalized md5 compares the function body. `prosecdef`, `proconfig` and the owner are not part of it, and G5 doesn't run on prod.
- Add a check after applying: `select prosecdef, proconfig, proowner::regrole, proacl from pg_proc where proname = 'tg_order_approvals_guard'`. Local returns `t`, `{search_path=public}`, `postgres`, `{postgres=X/postgres,service_role=X/postgres}`.

**L6. Older than this spec: `source_submission_id` isn't checked against the approval's store.** `supabase/migrations/20260801000100_order_approvals.sql:248-252,400-405`
- Neither `create_order_approval` nor the INSERT policy checks that the submission belongs to `p_store_id`. An admin can point at another brand's submission UUID, and the FK check runs as owner, so success or failure reveals whether that UUID exists. UUIDs are unguessable, so the risk is small.
- This spec removes one side effect: such a pointer could previously block the other brand's store delete. `report_last_order_context` already filters by store.
- Fix in a later spec by rejecting a submission from another store.

### Checked and found clean
| Question | Result |
|---|---|
| Direct UPDATE to NULL while the parent exists | Refused. `new is null and not exists(...)` is false, and neither term can evaluate to NULL |
| NULL to value, or re-pointing | Refused, because a non-NULL `new` always fails the exception clause |
| Uncommitted delete by another transaction | Other sessions still see the parent, so the guard refuses (fails closed). A rollback changes nothing |
| Delete racing an UPDATE | The parent delete and the SET NULL commit atomically, so no session can see "parent gone, pointer still set". A waiting UPDATE re-reads the latest row, so `old` is already NULL and its change is a no-op |
| Multi-statement tricks | PostgREST gives a client no open transaction. I found no public function that deletes these parents except `hard_delete_brand` (super_admin only) |
| Dangling pointers | Both FKs are validated (`convalidated = t`) and not deferrable |
| Re-keying the parent (`UPDATE ... SET id`) | Blocked. Both FKs are `ON UPDATE NO ACTION`, so the update fails while referenced |
| RLS inside the trigger | `prosecdef = t`, owner `postgres`, which owns all three tables and has BYPASSRLS, with no FORCE RLS. Hidden rows are still seen |
| `search_path` | `public` only, unchanged. Both new reads are schema-qualified, `pg_catalog` is searched first, and `anon`/`authenticated` have no CREATE on `public` |
| Existence oracle | None. The same error is returned, and a non-NULL pointer's parent always exists |
| Migration vs old function | Diffed. Only the two removed lines in (a), the new (a2) block and the comment differ. The locally deployed body matches the migration file, and the function ACL carried over |
| Other guard sections during an FK update | No conflict. The `lines` trigger is `UPDATE OF lines`, so it doesn't fire. The frozen-row checks pass because nothing else changes |
| Trigger execution | Not callable by clients (`authenticated` has no EXECUTE), and the cost is only two index lookups when a pointer changes |

`anon` and `authenticated` hold TRUNCATE on `order_approvals`, `eod_submissions` and `stores`. This is an older grant, and RLS doesn't cover TRUNCATE. No API route reaches it: PostgREST can't issue TRUNCATE, and no public function contains a TRUNCATE statement.

### Dependencies
No `package.json` changes. `npm audit` skipped.
