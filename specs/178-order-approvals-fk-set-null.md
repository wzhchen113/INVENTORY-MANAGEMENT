# Spec 178: Let order approvals survive deleting what they point at

Status: READY_FOR_REVIEW

## Problem

`order_approvals.approved_by` (→ `profiles`) and
`order_approvals.source_submission_id` (→ `eod_submissions`) are both
`ON DELETE SET NULL`. `tg_order_approvals_guard()` treated both columns as always
immutable. The foreign key's SET NULL is an ordinary UPDATE, so it fires the
guard, and the delete fails with `order approval is immutable`.

Spec 177 §11.8 first recorded this. Once an approval exists:

| Path | Before this fix | Who can reach it |
|---|---|---|
| Deleting a user who approved an order (`delete-user`) | Fails: the profile delete and `auth.admin.deleteUser` both hit the guard | Admins, through the app |
| Deleting a linked EOD submission | Fails | Server-side only: `eod_submissions` has no DELETE policy |
| Deleting a store | Works | Admins. The approval cascade is queued first, so no SET NULL reaches the guard. D4 pins this |

`cleanupOldRecords` and `db.deleteStore` also delete `eod_submissions`, but as an
API caller those deletes remove 0 rows with no error, so this bug doesn't affect
them. See "Not in this spec".

Prod had 0 approvals on 2026-11-08, so nothing has failed there yet.

## Change

`supabase/migrations/20261108000000_order_approvals_fk_set_null.sql` replaces
`tg_order_approvals_guard()`. Each of the two columns may now move from a value to
NULL when the row it references no longer exists. The foreign key action runs
after the parent row is deleted, so the guard can't see that row by then.

Every other change to either column is still refused, including NULLing it while
the referenced row exists, re-pointing it, and moving it from NULL to a value. The
rest of the function body is unchanged. There is no table, policy, grant or
publication change.

The approval row stays in every case except a store delete, which cascades as it
always has. The approver or source submission is lost from that row, which is what
the `ON DELETE SET NULL` foreign keys specified from the start (spec 149).

## Security

The existence checks must read as the function owner, so the function stays
SECURITY DEFINER. If it ran as the caller, a profile hidden by RLS would look
deleted, and a brand admin could erase a super_admin's name from an approval.
Arm G5 pins this. It fails when the function is switched to SECURITY INVOKER
(checked by hand on 2026-11-08).

A client can't clear a pointer with an UPDATE: while the referenced row exists the
guard refuses, and once it's gone the foreign key has already set the pointer to
NULL.

### Known gap: deleting a profile erases the approver

The guard used to block this by accident. Now a privileged caller who can delete
the approver's profile also clears `approved_by`, including on `ordered` rows, and
nothing else records who approved. The `Admins can delete profiles` policy lets any
admin in the brand do this. Security audit finding M1:

1. Admin B deletes admin A's profile through PostgREST. A's `auth.users` row stays.
   Run locally in a rolled-back transaction: `approved_by` went to NULL on an
   `ordered` row.
2. B invites A's email again and A calls `register_invited_profile`, which recreates
   the profile with A's original id. Read from the code, not run.

A is back with the same account and no name on their approvals. It needs a
privileged insider and gives no new access. The real fix is an immutable approver
snapshot on the row, which is a table change and out of scope here.

An approval whose approver was deleted can also still advance to `approved` and
`ordered` with `approved_by` NULL (audit finding L4).

Full findings: `specs/178-order-approvals-fk-set-null/reviews/security-auditor.md`.
Audit finding M2 (store deletes newly possible) did not hold up: D4 passes against
the old guard too.

## Acceptance criteria

All in `supabase/tests/order_approvals_fk_set_null.test.sql`:

- **D1–D4:** deleting a profile, an `auth.users` row, an EOD submission or a store
  succeeds, and the approval ends in the expected state.
- **G1–G4:** clearing or re-pointing either column by hand is still refused.
- **G5:** a brand admin whose RLS hides the approver's profile is still refused.
  G5a and G5b pin that setup.

## Prod apply

Apply before pushing, or `db-migrations-applied.yml` goes red:

1. Run the migration body through the Supabase MCP `execute_sql`.
2. Insert the exact version `20261108000000` into
   `supabase_migrations.schema_migrations`.
3. Confirm the function's normalized md5 matches local.
4. Confirm `prosecdef` is true, `proconfig` has `search_path=public` and the owner
   is `postgres`. The md5 covers only the body, and G5 doesn't run on prod.

Rollback: re-create the guard body from `20260801000100_order_approvals.sql`.

## Not in this spec

- **The 90-day EOD purge does nothing.** `eod_submissions` has no DELETE policy
  (confirmed on prod), so `cleanupOldRecords` removes 0 rows with no error. 66 EOD
  submissions were past 90 days on 2026-11-08. Don't fix it by adding a DELETE
  policy, because that would let an API caller clear `source_submission_id`.
- **An approver snapshot and an audit row for `delete-user`**, which would close
  the known gap above.
