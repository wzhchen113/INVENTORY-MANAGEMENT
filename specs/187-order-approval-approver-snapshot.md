# Spec 187: Keep the approver's name on an order approval after their profile is deleted

Status: READY_FOR_REVIEW

## User story

As the owner of a 2AM PROJECT brand, I want every order approval to keep the name, email and id of the person who approved it, and every deletion of a user who has store links or approvals to record who deleted whom, so that deleting a profile can't erase who is accountable for an order.

(Wording adjusted 2026-11-09, audit L3. A target with no store links and no approvals gets a console line only, because a NULL-store audit row would be readable by every brand's admins. Store links can be removed before the delete, so this is not "every user deletion".)

## Problem

This closes the "Known gap: deleting a profile erases the approver" section of `specs/178-order-approvals-fk-set-null.md`, and audit findings M1 and L4 in `specs/178-order-approvals-fk-set-null/reviews/security-auditor.md`.

Run locally on 2026-11-08 in a rolled-back transaction, as API-shaped callers:

- **The erase-and-return chain works.** Admin B `DELETE`s admin A's profile through the `Admins can delete profiles` policy, and `approved_by` goes NULL, including on an `ordered` row. B inserts an invitation for A's email. A calls `register_invited_profile` and comes back with the same id, role, brand and JWT role. No audit row is written. The audit left out that `invitations.profile_id` is NOT NULL, but any uuid passes, so the chain holds.
- **A row with no approver can still advance.** Another admin moved a NULL `approved_by` row from pending to approved to ordered (L4).
- **`create_order_approval` is not the only insert path,** whatever its comment says. A direct INSERT succeeds under `privileged_store_insert_order_approvals` with `approved_by = auth.uid()`.

From the code:

- A retry of `create_order_approval` on a pending row refreshes the lines but not the approver, so a second admin's lines appear under the first admin's name. Its race handler does the same.
- `delete-user` writes no audit row. `removeUser` in `useStore` would write one, but it has no callers.

Prod, read-only on 2026-11-08: 0 approvals, 2 privileged profiles (both with `user_stores` rows), 0 `User deleted` audit rows, 0 NULL-store audit rows, spec 178 applied, policy present. No backfill is needed if this ships before approvals are in use.

## Decisions

### D1. The snapshot is set by a SECURITY DEFINER trigger

New nullable columns `approved_by_name` and `approved_by_email` on `order_approvals`. A BEFORE INSERT trigger always overwrites any client-supplied value with `profiles.name` and `auth.users.email` for `new.approved_by`. `tg_order_approvals_guard()` covers both columns on UPDATE.

- The original idea was to set it in `create_order_approval`, but that RPC is SECURITY INVOKER and can't read `auth.users`, and the direct INSERT path would allow a forged or empty snapshot.
- Both columns are nullable because owner-level inserts with NULL `approved_by` exist (`supabase/tests/report_last_order_context.test.sql:355`).
- **Amended 2026-11-09 (audit 187-M1):** a third column, `approved_by_id uuid` with no foreign key, holds the approver's id and survives the profile delete. The name is stored as `nullif(btrim(name), '')` and falls back to the email. See "Backend design amendment", A2.
- **Amended 2026-11-09 (re-audit M-R1, owner decision):** for an API caller (non-NULL `auth.uid()`), the same trigger also refuses the INSERT unless the row is `pending` and the caller's `profiles.role` is `admin`, `master` or `super_admin`. Both checks run before the snapshot reads. See "Re-proposal build (2026-11-09)".

**Rejected: RPC only, and drop the direct INSERT policy.** The RPC is INVOKER and inserts through that same policy, so it would have to become SECURITY DEFINER with its RLS clipping rebuilt by hand, and the direct-INSERT arms in `supabase/tests/cross_store_item_rejection.test.sql` would change.

### D2. The `Admins can delete profiles` policy is dropped

Profiles are deleted only through `delete-user`. No client path uses the policy. All of `src/` goes through `delete-user`. Besides closing M1's restore path, dropping it closes:

- the last-of-role and self-delete bypasses (`assert_profile_self_delete_blocked` exempts super_admin, and the direct path skips `delete-user`'s guards)
- the `eod_update` notification fan-out and the re-attribution of `submitted_by` to the deleter (`specs/180-eod-submit-admin-popup/reviews/security-auditor.md`, Low)
- the orphaned-login route (`specs/167-store-user-audit-trail/reviews/security-auditor.md`)

Cost: spec 043's ACs for this policy and these test arms change.

| File | Arms | Change |
|---|---|---|
| `supabase/tests/profiles_rls_sweep.test.sql` | 7, 9, 10 | Flip to "0 rows, no error" |
| `supabase/tests/profiles_rls_sweep.test.sql` | 8 | Still passes, but no longer proves brand scope |
| `supabase/tests/auth_can_see_store_brand_scope.test.sql` | 11, 13 | Flip to "0 rows, no error" |
| `supabase/tests/auth_can_see_store_brand_scope.test.sql` | 12 | Unaffected, runs as postgres |

`profiles_self_delete_lock` stays as a backstop, pinned by an arm running as postgres with claims. `delete-user`'s brand gate (spec 043) replaces RLS brand scoping on the delete path.

**Rejected: keep the policy and accept the restore path.** The snapshot would preserve attribution either way, but the bypasses above would stay open.

### D3. A row with no approver can't be approved, and the approver follows the lines while pending

The two transitions are split:

- `pending → approved` with NULL `approved_by` is refused (P0001, HTTP 400). Nobody accountable has approved these lines.
- `approved → ordered` stays allowed. The approval already happened and the snapshot names the approver. Refusing could strand a row whose order was already placed.

Refusing alone would wedge the row: the unique key is (store, vendor, business date) and there is no DELETE policy. The recovery path is option (a):

Every `create_order_approval` retry on a pending row stamps the caller as `approved_by` with a fresh snapshot, in both the retry and race branches. The guard lets `approved_by` change only to `auth.uid()` and only while pending. Once the row leaves pending it is frozen, except for the FK's SET NULL. This also fixes the older false attribution, which an immutable snapshot would otherwise make permanent. The guard's "always immutable" wording for `approved_by` changes, the same way `lines` already works.

**Rejected:**

- **(b) Re-stamp only when `approved_by` is NULL.** Narrower, but B's lines stay under a live A's permanent name.
- **(c) No refusal at all.** Smallest, but B's lines and B's advance are recorded under A's snapshot.

`approved_at` is a design call. Expected: it moves with the approver, because "B approved at A's time" is false. It's safe to move: nothing reads it except the `mapOrderApproval` field, which no screen displays, and an index.

**Amended 2026-11-09 (audit 187-H1, and the in-spec part of 187-H2).** As built, "the approver follows the lines" held only through the RPC: a direct PATCH could change a colleague's pending lines, or approve the row, and leave it under the colleague's name. Now, for an API caller, only the row's approver may change a pending row, and the approver (or a caller re-stamping) must have a privileged `profiles.role`, not just a privileged JWT claim. Writes by anyone else are refused, not auto re-stamped. See "Backend design amendment", A1.

### D4. `delete-user` writes an audit row in spec 167's shape

It follows the writer in `supabase/functions/manage-store-user/index.ts`: service-role, never throws, best-effort, one bulk insert, no NULL-store rows.

| Field | Value |
|---|---|
| `action` | `User deleted` |
| Rows | One per store in the union of the target's `user_stores` and the stores of approvals the target approved, read BEFORE the cleanup deletes |
| `user_id` | The caller. Goes NULL if the caller is later deleted, which is why `detail` carries the id too |
| `detail` | JSON: caller id, target id, target role, brand, approval count, and whether the auth user was deleted |
| `item_ref` | Target's name (final choice left to the design) |
| `value` | Target's email (final choice left to the design), or empty for a placeholder account. Spec 167 bars the placeholder from every column |

- **Zero stores:** a target with no stores in that union has no approvals by definition. Write a console line only (spec 167 AC-3 parity). A NULL-store row would be readable by every brand's admins.
- **Partial failure:** write the row whenever the profile was removed, even if `auth.admin.deleteUser` then fails.
- **Policies:** add `User deleted` to spec 170's two restrictive `audit_log` policies. INSERT blocks forgery. SELECT hides it from non-privileged callers, because the row now carries an email. This is safe because `removeUser` has no callers.
- **`inferKind`:** not changed. See "In scope".

**Rejected:** no email on the row, which would leave only the name. No audit row at all, which would leave no record of who deleted whom.

## Change

**Approver snapshot.** As in D1. The two columns are set from the database on INSERT and when the approver changes, never from client input.

The re-stamp in D3 can't be written by the invoker RPC, because it can't read the email. The guard, or a trigger that also fires on UPDATE, must set the snapshot when `approved_by` changes to the caller. The RPC only sets `approved_by = auth.uid()`.

**Guard.** Four rules change or are added:

- `approved_by` may also move to `auth.uid()` while pending.
- The `pending → approved` refusal in D3 is new. Proposed message: `order approval has no approver`.
- Both snapshot columns are immutable, except for the re-stamp. The FK's SET NULL leaves them untouched.
- A client can never change `approved_at` through an UPDATE. If it moves, the server sets it. (Corrected 2026-11-09, audit L4: this holds for UPDATE only. A direct INSERT can still set `approved_at`, along with `status`, `channel`, `created_at`, `updated_at`, `ordered_at`, `line_count`, `est_total_cost`, `external_ref`, `external_ref_expires_at` and `source_submission_id` (last three added 2026-11-09, re-audit 2 L-R3). See Out of scope. Updated 2026-11-09, re-audit M-R1: an API caller's INSERT must now be `pending`, so `status` comes off that list for API callers. The rest of the list stands.)
- **Added 2026-11-09:** on a pending row, an API caller may change the listed columns, or re-stamp, only as the row's approver and only with a privileged `profiles.role`. The approver id joins the snapshot. See "Backend design amendment".

Everything else in the guard stays as spec 178 left it.

**`create_order_approval`.** Both pending branches also stamp the caller. Approved and ordered rows are still returned with no write (R-6).

**Direct profile deletes.** `Admins can delete profiles` is dropped. Table grants stay as they are (spec 097), so a direct delete removes 0 rows with no error.

**`delete-user`.** Writes the row in D4. The refusals, guards and response bodies don't change. Its ignored cleanup errors stay ignored, with one exception: the function must read the result of the `profiles` delete to know whether the profile was removed. That result decides the audit row and nothing else.

## Acceptance criteria

### pgTAP: new `supabase/tests/order_approvals_approver_snapshot.test.sql`

**Snapshot**

Amended 2026-11-09: "the snapshot" below means all three columns, `approved_by_name`, `approved_by_email` and `approved_by_id`.

- [ ] **AC-1** `create_order_approval` run as an API caller stores the caller's `profiles.name`, `auth.users.email` and id.
- [ ] **AC-2** A direct INSERT as an API caller that supplies a forged or empty name, email and `approved_by_id` stores the caller's real values and id.
- [ ] **AC-2d** (2026-11-09) A caller whose `profiles.name` is empty or only whitespace gets their email as the snapshot name, on INSERT (RPC or direct) and on a re-stamp. A non-blank name is stored trimmed, on INSERT (AC-35f) and on a re-stamp (AC-8c, added 2026-11-09, test-engineer N1).
- [ ] **AC-3** An owner-level INSERT with NULL `approved_by` stores NULL in all three columns, even if values are supplied. The `report_last_order_context.test.sql` fixtures pass unchanged.
- [ ] **AC-4** Updating any of the three snapshot columns by hand, including to NULL, raises P0001 `order approval is immutable` at every status.
- [ ] **AC-5** Deleting the approver's profile sets `approved_by` to NULL and leaves all three snapshot columns unchanged on `pending`, `approved` and `ordered` rows, so `approved_by_id` still holds the deleted id. The same holds when deleting the `auth.users` row.
- [ ] **AC-6** Renaming the approver's profile doesn't change the snapshot on their existing rows.
- [ ] **AC-7** Every function that writes the snapshot has `prosecdef = true`, a pinned `search_path` and owner `postgres`. `anon` and `authenticated` have no EXECUTE on the trigger functions. (2026-11-09) `approved_by_id` is a nullable `uuid` with no foreign key.

**Re-stamp**

- [ ] **AC-8** Admin B calling `create_order_approval` on admin A's pending row leaves `approved_by`, both snapshot columns and the lines all B's, and `approved_at` moved.
- [ ] **AC-9** AC-8 also holds through the race branch, using the `t149_race_hide_once` pattern from `order_approvals.test.sql` arm C7.
- [ ] **AC-10** Setting `approved_by` to anyone other than the caller is refused while pending. Setting it to the caller is refused once the row has left pending.
- [ ] **AC-11** A direct update of `approved_at` is refused at every status.
- [ ] **AC-12** Calling `create_order_approval` on an `approved` or `ordered` row as a different admin returns the row with no change to approver, snapshot or `approved_at`.

**A row with no approver**

- [ ] **AC-13** `pending → approved` with NULL `approved_by`, run with an admin's JWT, raises P0001 and the row is unchanged.
- [ ] **AC-14** `approved → ordered` with NULL `approved_by` succeeds and sets `ordered_at`. An `approved → approved` no-op that writes a new `external_ref` also succeeds (the Instacart re-mint write).
- [ ] **AC-15** Recovery: `create_order_approval` by admin B on a pending row with NULL `approved_by` stamps B, and the row can then move to `approved`.

**Direct profile deletes**

- [ ] **AC-16** `pg_policies` returns 0 rows for `public.profiles` with `cmd` in (`DELETE`, `ALL`).
- [ ] **AC-17** Run as `authenticated`, these all remove 0 rows with no error and the target row stays: a brand admin deleting a same-brand profile, a super_admin deleting a cross-brand profile, and a super_admin deleting their own. `approved_by` on the target's approvals is unchanged.
- [ ] **AC-18** Run as postgres with an admin's claims, a self-delete still raises `profile self-delete is not permitted (use admin delete flow)`.
- [ ] **AC-19** The arms in D2 are updated as listed and both files pass.

**Who may change a pending row (added 2026-11-09, audit 187-H1 and 187-H2)**

"The listed columns" are `status`, `lines`, `line_count`, `est_total_cost`, `channel`, `external_ref`, `external_ref_expires_at` and `ordered_at`. An "API caller" has a non-NULL `auth.uid()`.

- [ ] **AC-32** An API caller changing any listed column on a pending row whose approver is someone else gets P0001 `order approval belongs to another approver`, and the row is unchanged.
- [ ] **AC-33** The same change on a pending row with no approver gets P0001 `order approval has no approver`, and AC-13's message is unchanged.
- [ ] **AC-34** These still pass: the approver's own channel fallback, advance with `external_ref` and Instacart-shaped write-back on their pending row; a different admin's re-mint (`status='approved'` plus a new `external_ref`) on an approved row; and listed-column changes on a pending row by postgres and by `service_role` with no claims.
- [ ] **AC-35** A caller whose JWT says `admin` but whose `profiles.role` is `user` gets P0001 `order approval caller is not an admin` when they try to re-stamp (through the RPC or a PATCH), approve their own pending row, or change lines on someone else's pending row. Test both a same-brand profile and a NULL-brand profile linked to the store. A `master` profile and a `super_admin` profile can each create and approve their own pending row.
  - (2026-11-09, test-engineer S1) Every route runs for both profile shapes: RPC re-stamp (AC-35a, AC-35j), PATCH re-stamp (AC-35h, AC-35c), lines on someone else's row (AC-35i, AC-35d) and approving their own row (AC-35b, AC-35e). One route doesn't reach the guard: the NULL-brand profile can't read the brand's vendor, so its RPC call is refused earlier with P0002 `vendor … not found`. AC-35j pins that refusal and the unchanged row.
  - (2026-11-09, re-audit M-R1) The same-brand profile's own pending row for AC-35b is now a fixture inserted as postgres, because that profile can no longer insert one (AC-37a).
- [ ] **AC-36** After admin B's `create_order_approval` re-stamps admin A's pending row, A's Instacart-shaped write-back is refused with AC-32's message, and the row stays pending under B with B's lines.
- [ ] **AC-37** (Rewritten 2026-11-09, re-audit M-R1 and architect SF-R1.)
  - **AC-37a** is now a refusal. A caller with a stale `admin` claim calling `create_order_approval` for a new row gets P0001 `order approval caller is not an admin`, and no row is created.
  - **AC-37b** stays a known gap: that caller can still move an approved row to `ordered`. It is accepted until the `auth_is_admin()` / `auth_is_privileged()` convergence follow-up (named in spec 191, not yet filed) ships. Spec 191 doesn't touch `auth_is_privileged()`, so it won't flip this arm. The convergence spec flips it.

**Who may insert (added 2026-11-09, re-audit M-R1)**

- [ ] **AC-38** For an API caller, an INSERT must be `pending` and the caller's `profiles.role` must be privileged.
  - **AC-38a, AC-38b:** a caller with a stale `admin` claim, as a same-brand profile and as a NULL-brand profile linked to the store, gets P0001 `order approval caller is not an admin` on a direct INSERT at `pending`, and P0001 `order approval must be inserted as pending` at `approved` and at `ordered`. No row is created.
  - **AC-38c:** a real admin's direct INSERT at `approved` and at `ordered` gets P0001 `order approval must be inserted as pending`. No row is created.
  - **AC-38d:** postgres and `service_role` with no claims can still insert `approved` and `ordered` rows, and the stamp still fills the snapshot.
  - The status check runs first, then the role check, both before the snapshot reads.

### pgTAP: `supabase/tests/audit_log_rls_hardening.test.sql`

- [ ] **AC-20** Staff, admin and super_admin INSERTs of `User deleted` are each rejected with 42501. A `service_role` INSERT succeeds.
- [ ] **AC-21** Staff on a store see 0 `User deleted` rows. An admin who can see that store sees them.
- [ ] **AC-22** Arms S-1 and S-6 still pass. S-1 pins the policy names, and S-6 counts comments starting `spec 170: `. So keep both, or update those arms in the same PR.

### Shell smoke: `delete-user`

Add to `scripts/smoke-edge-roles.sh` or a new `scripts/smoke-delete-user.sh`, as a design call. A new script must be added to `npm run test:smoke`. Arm 8 of `smoke-edge-roles.sh` must stay last. Smokes are not in CI, so this one is run by hand before ship.

- [ ] **AC-23** Deleting a target with `user_stores` rows and approvals returns the existing `{ success: true }` and writes one `User deleted` row per store in the union, including a store where the target approved an order but has no `user_stores` row. `user_id`, `item_ref`, `value` and `detail` match D4, and the approval count is the number from before the deletes.
- [ ] **AC-24** After that delete, the target's approvals have NULL `approved_by` and an intact snapshot: the name and email from before the delete, and `approved_by_id` equal to the target's id and to the row's `detail.target_id`. (Amended 2026-11-09.)
- [ ] **AC-25** A target with no stores in the union writes 0 rows, logs one console line and still returns 200. No NULL-store row is ever written.
- [ ] **AC-26** A placeholder-email target's rows have an empty `value`, and `no-email.invalid` appears in no column.
- [ ] **AC-27** Requests refused as self-delete, cross-brand or last-of-role write 0 rows.
- [ ] **AC-28** When the profile is removed and `auth.admin.deleteUser` fails, the function returns the same 500 as today and writes the rows, with `detail` showing the auth user wasn't deleted. Suggested way to force it: a throwaway table with an FK to `auth.users`. If that can't be made reliable, the design says so and this becomes a review check.
- [ ] **AC-29** No new console line contains an email, a name, or an error message. Only caller id, target id, action and error code or class name, as in spec 167.

### Jest and full suite

- [ ] **AC-30** `delete-user` is added to `COPIES` in `src/lib/placeholderEmail.parity.test.ts`, because spec 165 requires placeholder checks to use the marked block.
- [ ] **AC-31** Full `npx jest`, both typechecks and the full pgTAP suite pass. That includes `order_approvals.test.sql`, `order_approvals_fk_set_null.test.sql` (G1 to G5 unchanged) and `cross_store_item_rejection.test.sql`.

## In scope

- Two snapshot columns, the trigger, and the guard and RPC changes above
- (2026-11-09) The `approved_by_id` column, the blank-name fallback, and the guard's pending-row authority rule (A1 and A2 of the amendment)
- (2026-11-09, re-audit M-R1) The stamp trigger's INSERT check for API callers: status `pending` and a privileged `profiles.role`
- Dropping `Admins can delete profiles`
- The `delete-user` audit row, and adding `User deleted` to spec 170's two restrictive policies
- The test changes listed above

No screen code changes. `inferKind` stays as it is. It only drives the desktop kind filter, and the phone audit log doesn't use it (`PhoneAuditLog.tsx` has only text search), so the phone needs nothing.

The new rows do appear in the existing audit feed on both surfaces, as `Name · email` with the existing `userDeleted` label and the default muted tone. On desktop they sit under the "other" kind filter. `detail` isn't rendered on either surface.

## Out of scope (explicitly)

- **Showing the approver in any UI.** SQL only for now.
- **Recording who advanced a row to `ordered`.**
- **Stores being deleted along with their approvals.** No change. (Corrected 2026-11-09, audit 187-M2: spec 178's note was about whether the delete was newly possible, not whether it is possible. It is. One brand admin can delete a store through `privileged_delete_stores`, and the cascade removes its approvals, their snapshots, and its `audit_log` rows, including `User deleted` rows. A super_admin's direct `brands` delete does the same. The owner accepted this on 2026-11-09. A refusal, or a record outside the cascade, would be a separate spec.)
- **`source_submission_id` store check (L6).**
- **The 90-day EOD purge.** Handled by `specs/186-retention-purge-server-job.md`.
- **Moving `User invite` server-side.**
- **`delete-user`'s ignored cleanup errors,** apart from reading the `profiles` delete result as above.
- **Limiting what a direct INSERT can set for `status`, `channel`, `approved_at`, `created_at`, `updated_at`, `ordered_at`, `line_count`, `est_total_cost`, `external_ref`, `external_ref_expires_at` and `source_submission_id`** (column list completed 2026-11-09, audit L4 and re-audit 2 L-R3; a real admin can plant an `external_ref` on insert, which `instacart-cart-link` hands back as a live cart link, though they can already PATCH it on their own pending row). The guard covers UPDATE only. The approver and snapshot are still correct on those rows, so attribution holds. Only D1's rejected alternative would have closed this. (Updated 2026-11-09, re-audit M-R1: `status` is now closed for API callers, because the stamp trigger requires `pending`. The other columns are still open, in Follow-ups.)
- **`removeUser` and its dead audit call.** Left alone, recorded as a follow-up.
- **`inferKind` and `ACTION_TONE` entries for `User deleted`.** Cosmetic follow-up.

## Open questions resolved

Answered by the owner on 2026-11-08 ("Accept all four"), relayed by the main session.

- Q: D1. How does the snapshot get set? → A: A SECURITY DEFINER trigger that overwrites client-supplied values, with the guard covering both columns on UPDATE.
- Q: D2. Does the `Admins can delete profiles` policy stay? → A: No, drop it. Profiles are deleted only through `delete-user`.
- Q: D3. Can a row with no approver advance? → A: `pending → approved` is refused and `approved → ordered` stays allowed. Recovery is option (a): every `create_order_approval` retry on a pending row re-stamps the caller.
- Q: D4. What audit row does `delete-user` write? → A: Spec 167's writer shape, with action `User deleted`, one row per store in the union, no NULL-store rows, and `User deleted` added to spec 170's two restrictive policies.

Answered by the owner on 2026-11-09 ("Apply all fixes"), relayed by the main session, on `specs/187-order-approval-approver-snapshot/reviews/release-proposal.md` (verdict FIXES_NEEDED).

- Q: Apply fixes 1 to 7 of the release proposal? → A: Yes, all of them, including 187-M1's new no-FK approver id column and the blank-name fallback.
- Q: Does 187-H2 block this spec? → A: No. Its root causes are being specced in the same session: spec 195 for `user_stores` own-row writes, and spec 191 for `demote_profile_to_user` brand scope and the last-of-role guard. The owner accepts the remaining exposure until those ship (listed in amendment A1). The in-spec part of 187-H2, the `profiles.role` check in the guard, ships here.
  - (Corrected 2026-11-09, architect SF-R1, acknowledged by the owner in the next round.) Neither spec ends that exposure. Spec 191 doesn't change `auth_is_privileged()`, and spec 195 removes only the cross-brand self-link. It ends only when the `auth_is_admin()` / `auth_is_privileged()` convergence follow-up (named in spec 191, not yet filed) ships.

Answered by the owner on 2026-11-09 ("Apply all three (Recommended)"), relayed by the main session, on the "Re-proposal 2026-11-09" section of `specs/187-order-approval-approver-snapshot/reviews/release-proposal.md` (verdict FIXES_NEEDED).

- Q: M-R1, a stale `admin` claim can INSERT a row that is already `approved` or `ordered`. Code fix or wider acceptance? → A: Code fix. In `tg_order_approvals_stamp_approver()`, for a caller with a non-NULL `auth.uid()`, require the row to be inserted as `pending` and the caller's `profiles.role` to be `admin`, `master` or `super_admin`. Both checks go before the email read. `channel` and the timestamps are left alone, as the L4 follow-up. AC-37a becomes a refusal and AC-35b gets a postgres fixture row. Every pgTAP file is run, because fixtures that insert non-pending rows as postgres must not trip the check through leftover claims.
- Q: Test-engineer S1, N1 and N3? → A: Apply them. S1: every AC-35 route for both profile shapes. N1: a re-stamp with a padded name (AC-8c). N3: a direct-INSERT arm, which is now a refusal (AC-38).
- Q: L-R1, the blank-name test trims only ASCII whitespace? → A: Accept, with a Known limits line. The Unicode-aware check is a follow-up.
- Q: L-R2, `ordered_at` can be rewritten on approved and ordered rows? → A: Record it as a follow-up.
- Q: SF-R1, SF-R3 and the text nits? → A: Apply them. The stale-claim exposure ends only with the not-yet-filed `auth_is_admin()` convergence spec, not with spec 191 or 195.
- Q: The draft PR for a fresh build? → A: Dropped. The A7 fresh build covered it.
- Q: 187-M2, a store delete erases approvals and `User deleted` rows? → A: Accepted. The "durable record" wording is corrected.
- Q: L1, a brand admin can read a super_admin approver's email; L6, a snapshot email can't be erased without disabling the trigger? → A: Both accepted.
- Q: L3, a target with no store and no approvals gets a console line only? → A: Accepted. The user story wording is adjusted.
- Q: The CLAUDE.md bullet "profiles are deleted only through `delete-user`"? → A: Accepted. Main Claude adds it at landing. This spec doesn't edit CLAUDE.md.

## Known limits

- **`audit_log` isn't the durable record.** Rows last about 90 days and cascade on store delete. Today `cleanupOldRecords` and `admin_delete_audit_log` do the pruning. Spec 186 moves it to a nightly job with the same 90 days, and that job will also prune `User deleted` rows. The snapshot is the more durable record: it survives the profile delete and the 90-day prune. The audit row only says who deleted whom. (Corrected 2026-11-09: spec 186 is now READY_FOR_REVIEW with migration `20261108120000` on disk. The "today" pruners are current only until it ships.)
- **The snapshot is not durable against a store delete** (added 2026-11-09, audit 187-M2, accepted by the owner). Deleting a store cascades to its approvals, with their snapshots, and to its `audit_log` rows, including `User deleted` rows. One brand admin can do this through the API.
- **The snapshot records the name and email as they were at the stamp** (added 2026-11-09, audit 187-M1). An approver, or another admin, can rename the approver before the approval, and an email change before it is captured too. `approved_by_id` ties every row back to the account and to `detail.target_id` on the `User deleted` row, so a forged name can be traced. Auditing privileged renames and email changes is a follow-up.
- **An audit write can fail.** It is best-effort. If the pre-delete read or the insert fails, the delete still goes ahead and only a console line remains.
- **A caller with no profile row.** `audit_log.user_id` references `profiles`, and a super_admin passing on JWT role alone may have no profile, in which case the FK would fail the whole insert. Design call: write `user_id` as NULL for that caller, since `detail` has the id.
- **A partial `delete-user` failure still leaves an orphan login.** If the auth delete fails, the login survives and the restore chain is possible. The audit row and the snapshot both remain.
- **"Blank" means ASCII whitespace only** (added 2026-11-09, re-audit L-R1, accepted by the owner). `btrim` strips spaces only, so a name made of a tab, U+00A0 or U+200B is stored as the snapshot name instead of falling back to the email. The row still carries the real email and `approved_by_id`, so it isn't anonymous. A Unicode-aware check is a follow-up.
- **Spec 186 status, 2026-11-09** (architect Nit 8). Spec 186 is committed (`15aefc4`) and on prod, with the gates green. Where this spec still calls it READY_FOR_REVIEW or "until it ships", read that as done: the nightly job now does the 90-day pruning.

## Security notes

Flagged for the security-auditor:

- **Email exposure is wider than today (Low).** `approved_by_email` becomes readable by any privileged caller who can see the store, including a brand admin whose RLS hides a super_admin approver's profile (spec 178's G5 fixture). `get_profile_emails` (spec 163) deliberately doesn't show that email to that caller. The `User deleted` row has the same reach: a super_admin target's email can appear in any store they approved in, across brands. It also reaches privileged clients through `select('*')` and the RPC's return, though `mapOrderApproval` drops it. Audit L1 confirmed this, and the owner accepted it on 2026-11-09. With the blank-name fallback (amendment A2), the email can also appear in `approved_by_name`, with the same reach.
- **A snapshot email can't be erased** (added 2026-11-09, audit L6, accepted by the owner). The guard refuses edits even as postgres, and `order_approvals` isn't pruned. Removing a deleted person's email on request would mean disabling the guard for that statement.
- **Trigger posture.** The trigger must stay SECURITY DEFINER with a fixed `search_path`, and its reads must be schema-qualified.
- **Taking over a pending row.** Re-stamping lets an admin take over a pending row only in their own name, and nothing has been ordered at that point. Through the RPC, A's name and A's lines leave the row together. (2026-11-09) Since amendment A1, only the row's approver may change its lines or status while pending, so B's lines can no longer sit under A's name. B can still re-stamp with a bare PATCH of `approved_by` and keep A's lines under B's own name, which is accepted: B claims them in their own name before anything is ordered.
- **Placeholder accounts.** No client code path promotes them (spec 165), and the trigger has no placeholder check. (Corrected 2026-11-09, audit L5: a super_admin PATCH of `profiles.role = 'admin'` does promote one, and that account's approval then stores its `@no-email.invalid` address in `approved_by_email`, and also in `approved_by_name` if its name is blank. Note only, no code change. A future promotion spec must add the check, alongside the skip spec 165 already asks for.)

## Dependencies

- Spec 178 (landed in c630c7f), for the guard this extends
- Spec 043, for the policy dropped here and the `delete-user` brand gate that replaces it. Its ACs for this policy are superseded.
- Spec 149, for `order_approvals`, the guard and the RPC
- Spec 167, for the audit writer shape and log hygiene
- Spec 170, for the restrictive `audit_log` policies
- Spec 186 (`READY_FOR_ARCH`, not built), which overlaps here: it may change `admin_delete_audit_log`, and both specs edit `supabase/tests/audit_log_rls_hardening.test.sql` (S-1 and S-6). Whichever builds second rebases its arms and its migration version on the first. **Superseded 2026-11-09:** see "Correction about spec 186" under Implementation notes. Only spec 187 edits that test file, and no rebase is owed.
- Migration version left to the build. It must sort after `20261108000000` and not clash with spec 186's. **Settled:** `20261108130000`. Spec 186's is `20261108120000`.
- Specs 195 and 191 (being specced 2026-11-09), for the root causes of 187-H2. Not blocking: the owner accepted the remaining exposure until they ship. (Corrected 2026-11-09, architect SF-R1: spec 195 removes the cross-brand self-link, but neither spec ends the exposure. Spec 191 leaves `auth_is_privileged()` alone. The exposure ends with the `auth_is_admin()` / `auth_is_privileged()` convergence follow-up (named in spec 191, not yet filed).)
- The `auth_is_admin()` / `auth_is_privileged()` convergence follow-up (named in spec 191, not yet filed). Not blocking, accepted by the owner on 2026-11-09. Until it ships, AC-37b stays a known gap.

## Project-specific notes

- **Cmd UI section / legacy:** none. No screen changes.
- **Per-store or admin-global:** per-store. Approvals are store-scoped and every audit row has a non-NULL `store_id`. Deletion is brand-gated in `delete-user`.
- **Realtime channels touched:** none. `order_approvals` and `audit_log` aren't in the publication, so there's no realtime restart.
- **Migrations needed:** yes, one.
- **Edge functions touched:** `delete-user` only. `instacart-cart-link` isn't changed. If an approver is deleted between the RPC and its write-back, the write is refused, it returns its existing 500 `writeback_failed`, the row stays pending, and a retry re-stamps.
- **Web/native scope:** both unaffected. No client code changes.
- **Tests:** pgTAP, shell smoke, and one jest parity entry (AC-30).
- **`app.json` slug:** not touched.

## Prod apply

Only with the owner's go-ahead, for both the commit and the prod changes.

0. (Added 2026-11-09, architect SF-R3.) List the repo migrations whose version sorts after `20261108130000`. Grep them for `tg_order_approvals_guard`, `tg_order_approvals_stamp_approver`, `create_order_approval`, `order_approvals_stamp_approver_trg`, `audit_log_restrict_select_store_user_actions`, `audit_log_restrict_insert_server_only_actions`, and any `for delete` or `for all` policy `on public.profiles`. If any match, stop: that spec must be rebased on spec 187's bodies, and spec 187 must apply first. On 2026-11-09 the later files were `20261109120000`, `20261109140000`, `20261109170000`, `20261109191000`, `20261109195000` and `20261109200000`, and none matched. `20261109191000` touches only the profiles INSERT policy.
1. Re-check `select count(*) from public.order_approvals`. If it isn't 0, stop and ask: existing rows would have NULL snapshots, and the guard would refuse a plain backfill UPDATE.
2. Run the migration body through the Supabase MCP `execute_sql`.
3. Insert version `'20261108130000'` (name `order_approval_approver_snapshot`) into `supabase_migrations.schema_migrations`. **Not `20261108120000`**, which is spec 186's: inserting that would make spec 186 look applied when it may not be, and the drift gate compares sets of versions. (Corrected 2026-11-09, architect SF-1.)
4. Verify the functions. Normalized md5 matches local for the guard, the RPC and the new trigger function. Recapture the local references on the day of the apply rather than reusing the recorded ones (architect SF-R3). `prosecdef`, `proconfig` and owner also match for each (audit L5), because the md5 covers only the body. Compare `proacl` for the two trigger functions.
5. Verify the rest: all three snapshot columns exist, the trigger is enabled, `profiles` has no DELETE policy, and both restrictive `audit_log` policies list `User deleted`. (Added 2026-11-09.) Compare `col_description('public.order_approvals'::regclass, attnum)` for `approved_by_name`, `approved_by_email` and `approved_by_id` between local and prod (architect Nit 4). `prosrc` of `tg_order_approvals_stamp_approver` contains `order approval must be inserted as pending` and `order approval caller is not an admin` (re-audit M-R1).
6. Deploy `delete-user`, only after step 2 and only after `deno check` passes (amendment A8). Use a CLI pinned to CI's version, for example `npx supabase@2.106.0 functions deploy delete-user --project-ref <prod ref>`, or the Supabase MCP deploy. Bare `npx supabase` resolves to CLI 3.0.0 here, which refuses this repo's `config.toml`. Deletes between steps 2 and 6 work as they do today and write no audit row.
7. Push after step 3, or `db-migrations-applied.yml` goes red. If the push also carries spec 186's migration `20261108120000`, that version must be on prod before the push too. (2026-11-09: moot, spec 186's version is on prod. The same rule applies to any other version the push carries, for example spec 190's `20261109140000` if it is still in the index.) Then confirm `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` by hand (it is not yet in the CLAUDE.md gate list).

## Rollback

Ship as a new forward migration, so the drift gate stays green:

- Restore the guard from `20261108000000_order_approvals_fk_set_null.sql`. This also removes the pending-row authority rule from amendment A1.
- Restore `create_order_approval` from `20260801000100_order_approvals.sql`.
- Drop the new trigger and its function. That also removes the INSERT check from the re-proposal (status `pending` and a privileged `profiles.role` for API callers).
- Re-create `Admins can delete profiles` with its comment from `20260517060000_profiles_rls_sweep.sql:127-134`.
- Drop the three snapshot columns (`approved_by_name`, `approved_by_email`, `approved_by_id`) if no approvals exist. Otherwise keep them, because they hold the only copy of those names and ids, and tell the owner they're no longer guarded.
- Leave the two `audit_log` policies as they are. Restoring the old SELECT policy would show staff any `User deleted` rows already written, and nothing else writes that action.

Redeploy the previous `delete-user`. Rows it already wrote stay. Rolling back reopens M1 and L4.

**Repo changes in the same commit as the rollback migration** (added 2026-11-09, architect SF-2). Without them, `test.yml` goes red:

| File | Change |
|---|---|
| `supabase/tests/order_approvals_approver_snapshot.test.sql` | Remove it. The columns, trigger, re-stamp, authority rule and AC-16 are gone |
| `supabase/tests/profiles_rls_sweep.test.sql` arms 7, 9, 10 | Restore the old expectations. The re-created policy admits these deletes, and arm 10 raises from the self-delete lock |
| `supabase/tests/auth_can_see_store_brand_scope.test.sql` arms 11, 13 | Restore `throws_ok`, for the same reason |
| `supabase/functions/delete-user/index.ts` | Revert the file as well as redeploying it, or the next deploy brings the new code back |
| `src/lib/placeholderEmail.parity.test.ts`, and the header in `src/lib/placeholderEmail.ts` | Remove the `delete-user` `COPIES` entry and go back to "five". Without the marked block, the parity test throws |
| `scripts/smoke-delete-user.sh`, `package.json` | Remove the script and its `test:smoke` entry, because its arms would fail |
| `supabase/tests/audit_log_rls_hardening.test.sql` | No change. The rollback keeps both policies, so the UD arms still pass |
| `CLAUDE.md` (added 2026-11-09, architect Nit 5) | If main Claude has added the "profiles are deleted only through `delete-user`" bullet, remove or reword it. Re-creating `Admins can delete profiles` makes it false |

## To do at build (not now)

- Point spec 178's Known gap section at this spec, in one line.
- Propose this CLAUDE.md convention bullet for the owner's approval: "Profile rows are deleted only through the `delete-user` edge function. `public.profiles` has no DELETE policy, so a PostgREST delete removes 0 rows with no error. The one other service-role delete is `manage-store-user`'s compensation of an account it just created."
- Note in spec 043 that this spec supersedes its ACs for the policy.
- Correct stale comments:
  - "the ONLY INSERT path" on `create_order_approval`
  - the guard's "always immutable" comment
  - `delete-user/index.ts:56-64`, which cites the SQL policy
  - `auth_can_see_store_brand_scope.test.sql:421`
- Record the follow-ups: `removeUser`'s dead audit call, and the `inferKind` and `ACTION_TONE` entries.

## Backend design

Designed on 2026-11-08 from the migrations and code on disk, with no database access. "Confirm first" below lists what the developer checks against the running stack before building.

### Open calls settled

**1. Where the re-stamp snapshot is written: in the guard.** INSERT gets a separate BEFORE INSERT trigger. There is no trigger that fires on both events.

- The guard decides whether a move is legitimate, so it also writes the result. Nothing depends on trigger order.
- In the re-stamp branch the guard overwrites both columns and `approved_at`. In every other branch it refuses any change to them. A client-supplied value in the same UPDATE is overwritten or refused, so it never wins.
- Rejected: one trigger on `INSERT OR UPDATE OF approved_by`.
  - Named before the guard, the guard can't tell its values from a client's.
  - Named after the guard, the guard has to let client values through and rely on a later trigger to replace them.
  - Either way, `cross_store_item_rejection.test.sql` T54 breaks, because it pins the exact list of BEFORE UPDATE triggers. With this design T54 stays as it is.
- Firing order:
  - UPDATE is unchanged: `order_approvals_guard`, then `order_approvals_lines_check_store_trg`.
  - INSERT: `order_approvals_lines_check_store_trg`, then the new `order_approvals_stamp_approver_trg`. The two are independent, because neither reads what the other writes.

**2. `approved_at` does not move on a retry by the same approver.** It moves only when `approved_by` actually changes.

- A same-approver retry leaves `approved_at` and both snapshot columns untouched. The guard can't see that retry as distinct from any other write, and the same person is still named.
- The guard uses `now()`, matching `updated_at := now()`.
- AC-8 stays testable by backdating. The fixture row is inserted as postgres with `approved_at = now() - interval '1 hour'`, which the guard doesn't cover because it is UPDATE-only. The arm then asserts `approved_at = now()`. AC-8a (below) asserts the backdated value survives a same-approver retry.

**3. What counts as a re-stamp:**

```
v_restamp := old.status = 'pending'
         and new.approved_by is not null
         and new.approved_by is distinct from old.approved_by
         and new.approved_by is not distinct from auth.uid();
```

- This expression is never NULL. Do not write `new.approved_by = auth.uid()`: with a NULL `auth.uid()` that gives NULL, `not NULL` is NULL, and the refusal is skipped.
- postgres and service_role have a NULL `auth.uid()`, so `v_restamp` is false and they stay refused. G1 to G4 run as postgres with no claims, and G5 moves to NULL. All of G1 to G5 pass unchanged.
- The FK's SET NULL has `new.approved_by` NULL, so it is never a re-stamp, even if a caller's claims are set. It passes the existing "referenced row is gone" branch. The RI update sets only `approved_by`, so the snapshot and `approved_at` compare equal and pass.
- `auth.uid()` still returns the caller inside SECURITY DEFINER, because it reads the request GUC. `assert_profile_self_delete_blocked` relies on the same behaviour.

**4. `item_ref` and `value`:**

- `item_ref` is `profiles.name` as read before the delete. It is NULL when the target has no profile, or if the name itself matches `isPlaceholderEmail`. `profiles.name` is NOT NULL, so no username fallback is needed.
- `value` is the raw `auth.users.email`. It is `""` when the email is missing, the read failed, or `isPlaceholderEmail(email)` is true.
- Both surfaces render `value` only when it is truthy, so a placeholder target shows the name with no ` · `.

**5. `user_id` for a caller with no profile row: NULL.** `detail.caller_id` still carries the id. The pre-delete read decides this. Only a super_admin on JWT role alone can reach this case, because `requireSameBrandOrSuperAdmin` already returns 403 for an admin or master with no profile. If the read fails, `user_id` is also NULL, since that value can't fail the FK. The row then shows a blank actor in the feed, as `fetchAuditLog` already does for a NULL actor.

**6. When `delete-user` writes the row.** The pre-delete read runs after the last-of-role guard and immediately before `user_stores` is deleted (`index.ts:266`), so refused requests do no extra I/O (AC-27). The write runs after `auth.admin.deleteUser` returns, before either response.

| `profiles` delete | Auth delete | Rows written | `detail.auth_user_deleted` | Response |
|---|---|---|---|---|
| Returned the row | OK | Yes | `true` | 200, as today |
| Returned the row | Failed | Yes | `false` | Same 500, as today |
| Error or 0 rows | OK | Yes | `true` | 200, as today |
| Error or 0 rows | Failed | No, console line only | n/a | Same 500, as today |

- The third row is deliberate. An errored profile delete rolled back, but the auth delete then cascades to `profiles`, so the profile is gone anyway. It also covers an auth-only target. This widens D4's "whenever the profile was removed" to "whenever the profile or the login was removed".
- The email comes from service-role `auth.admin.getUserById`, the same call `manage-store-user` uses at step 5. PostgREST doesn't expose `auth.users`, and a new DEFINER RPC would add another way to read emails.
- The placeholder check is the marked block from `src/lib/placeholderEmail.ts`, lines 26 to 31 including both markers, copied byte-identically.

**7. The smoke arm lives in a new `scripts/smoke-delete-user.sh`,** appended to the end of `test:smoke`. `smoke-edge-roles.sh` is left alone, so its Arm 8 stays last.

AC-28 stays a smoke arm. The script creates `public.zz_s187_block_auth_delete (user_id uuid not null references auth.users(id))` with one row for the target. That row has no cascade, so GoTrue's delete should fail with a 500 after the profile is gone. Drop the table in the EXIT trap and list it in the header's recovery block, as the `zz_s165` and `zz_s167` fixtures do. I couldn't run this. If it proves unreliable, the developer records that in the spec and AC-28 becomes a review check.

**8. Migration version and order against spec 186.** *(Superseded 2026-11-09: the version is `20261108130000`, per the implementation notes. `20261108120000` is spec 186's. Do not use it anywhere for this spec.)* Use `supabase/migrations/20261108120000_order_approval_approver_snapshot.sql`. If a version at or after that exists at build time, take the next free one after the newest.

On disk today, the newest migration is `20261108000000`. Specs 186 and 188 are both READY_FOR_ARCH with no design and no migration, so there is no clash yet. The two specs can build in either order, because they change different objects: this spec alters only the two restrictive policies, and spec 186 only decides `admin_delete_audit_log`. If they compete for time, spec 186 goes first because of its 2026-11-20 deadline.

Exact changes to `supabase/tests/audit_log_rls_hardening.test.sql`:

| Part of the file | Change |
|---|---|
| S-1 to S-7, F-1, and the R, I, W, U, C and D arms | None. Policy names and all five `spec 170: ` comment prefixes are kept, so S-1 and S-6 pass untouched |
| `plan(54)` | `plan(61)` |
| Header arm map | One added line for UD-1 to UD-7, and the total goes from 54 to 61 |
| Audit fixture insert | One added row, `a5000170-0000-0000-0000-000000000005`, action `User deleted`, on S1 |
| New arms | UD-1 to UD-7 (below) |

Whichever spec builds second adds its arm count to the other's `plan()` and header. Nothing else conflicts, unless spec 186 drops `admin_delete_audit_log`, in which case it edits S-1 and S-6 itself.

### Data model

One transactional migration with `set local lock_timeout = '5s'`. It is additive except for the one policy drop. The new columns are nullable with no default, so adding them needs no table rewrite. No backfill: prod has 0 approvals and `seed.sql` has none.

```
alter table public.order_approvals
  add column approved_by_name  text,
  add column approved_by_email text;
```

Add a comment on each column saying it is written only by the server and stays after the profile is deleted.

**Insert trigger:**

```
public.tg_order_approvals_stamp_approver() returns trigger
  language plpgsql  security definer  set search_path = public
body:
  new.approved_by_name  := (select p.name  from public.profiles p where p.id = new.approved_by);
  new.approved_by_email := (select u.email from auth.users u      where u.id = new.approved_by);
  return new;

revoke execute on it from public, anon, authenticated;

create trigger order_approvals_stamp_approver_trg
  before insert on public.order_approvals
  for each row execute function public.tg_order_approvals_stamp_approver();
```

- Scalar subqueries always overwrite. A NULL `approved_by` or a missing row gives NULL (AC-3), and a client value never survives.
- The REVOKE is required because `20260618000000` line 205 grants ALL on future functions by default. The spec 097 lint covers tables only (`public_grants_explicit.test.sql:53`), so this doesn't trip it. Table grants don't change.
- An API INSERT naming someone else as `approved_by` reads their email into NEW, then fails `privileged_store_insert_order_approvals` with 42501. Postgres checks RLS WITH CHECK before constraints and that error carries no row data, so nothing leaks. Flagged for the security-auditor.

**Guard: `create or replace public.tg_order_approvals_guard()`.** The current body is in `20261108000000`, and everything not shown stays as it is. Declare `v_restamp boolean`, then:

```
v_restamp := <open call 3>;

(a)  refuse 'order approval is immutable' if id, store_id, vendor_id,
     business_date or created_at changed.
     -- approved_at leaves this list.

(a1) if v_restamp then
       new.approved_by_name  := (select p.name  from public.profiles p where p.id = new.approved_by);
       new.approved_by_email := (select u.email from auth.users u      where u.id = new.approved_by);
       new.approved_at       := now();
     elsif approved_at, approved_by_name or approved_by_email changed then
       raise 'order approval is immutable' P0001;
     end if;

(a2) if new.approved_by is distinct from old.approved_by
        and not v_restamp
        and not (new.approved_by is null
                 and not exists (select 1 from public.profiles p where p.id = old.approved_by)) then
       raise 'order approval is immutable' P0001;
     end if;

     source_submission_id block: unchanged.

(b)  existing transition check, then:
     if old.status = 'pending' and new.status = 'approved' and new.approved_by is null then
       raise 'order approval has no approver' P0001;
     end if;

(c), (c2), (d), (e): unchanged.
```

- Keep the comment saying not to change this function to invoker, and extend it: the `auth.users` read needs definer too.
- Update `comment on function`.
- `create or replace` keeps the guard's existing REVOKE.
- A direct PATCH of `approved_at` with no approver change is refused at every status (AC-11). In the same UPDATE as a re-stamp it is overwritten instead.

**RPC: `create or replace public.create_order_approval(...)`.** Copy the full body from `20260801000100`, its only definition. The signature, return type, INVOKER posture and grants stay the same.

- Both pending updates, the race handler (around line 424) and the retry branch (around line 437), gain `approved_by = auth.uid(),` as the first SET entry.
- The insert is unchanged, because the trigger stamps it.
- The approved and ordered path still does no write (R-6).
- Correct the "ONLY INSERT path" wording in the function comment and at `src/lib/db.ts:2701` (comment only).

### Checked, not assumed

- **Three write sites:** the insert, the retry and the race handler. The insert is covered by the trigger and the other two by the guard.
- **INVOKER update:** `privileged_store_update_order_approvals` doesn't mention `approved_by` in USING or WITH CHECK, so `approved_by = auth.uid()` passes for a caller who already passed the RPC's gates. The INSERT policy's `approved_by = auth.uid()` still holds, because no trigger changes `approved_by`.
- **`order_approvals_lines_check_store()`:** `BEFORE INSERT OR UPDATE OF lines`, SECURITY INVOKER. It reads only `lines` and `store_id`, so it doesn't interact. A re-stamp through the RPC fires it under B's RLS, so B must be able to see the store's items. The RPC's store gate already requires that.
- **Column and function pins:** `columns_are` exists only for `inventory_items` and `item_vendors`. There is no md5 or `pg_get_functiondef` pin on any `order_approvals` function. The only pin on this table's trigger list is T54, covered above.
- **`Admins can delete profiles`:**
  - Tests delete `profiles` as `authenticated` only in the arms the spec lists.
  - `order_approvals_fk_set_null.test.sql` D1 runs as postgres.
  - `profiles_insert_hardening.test.sql` K-1 counts `INSERT` and `ALL` only, so it isn't affected.
  - No function, script or `src/` path deletes through the policy. The only deletes are service-role, in `delete-user` and `manage-store-user`.
- **Other DELETE or ALL policies on `profiles`:** the migrations show none besides this one, since `Own profile` was dropped in `20260502071736`. AC-16 confirms it against the real catalog.
- **Rowtype and `select *`:**
  - `instacart-cart-link` is the only edge function using the table, and it selects named columns.
  - `report_last_order_context` uses named columns.
  - `create_order_approval` is the only function with the rowtype, and it is replaced in this migration.
  - Tests read rowtype fields by name.
- **Test fixtures that advance a row:** only `order_approvals`, `cross_store_item_rejection` and `order_approvals_fk_set_null` tests UPDATE this table, and the `pending → approved` moves among them use RPC-created rows with an approver. `report_last_order_context` has NULL-approver fixtures but no UPDATE on them.
- **Lint:** `permissive_policy_lint.test.sql` scans permissive policies. This migration adds none and removes one, so no allowlist row.

### RLS impact

**`order_approvals`:** no policy changes.

**`profiles`:** `drop policy "Admins can delete profiles" on public.profiles;`. Table grants stay. A direct delete removes 0 rows with no error and doesn't fire `profiles_self_delete_lock`. The lock stays as a backstop, pinned by AC-18.

**`audit_log`:** use `alter policy`, not drop and create. It keeps the name, the comment object and `as restrictive`, so a slip can't turn a restrictive policy permissive.

```
alter policy "audit_log_restrict_select_store_user_actions" on public.audit_log
  using (action not in ('Store user created', 'Store user password set', 'User deleted')
         or public.auth_is_privileged());

alter policy "audit_log_restrict_insert_server_only_actions" on public.audit_log
  with check (action not in ('Store user created', 'Store user password set',
                             'Order missed', 'catalog_copy', 'User deleted'));
```

Rewrite both comments, keeping the exact `spec 170: ` prefix. "These four actions" becomes five, the writers include `delete-user`, and the SELECT comment says the row carries an email. The other five `audit_log` policies are untouched.

### API contract

Unchanged signatures, with PostgREST and the existing RPC. The RPC, `fetchOrderApproval` and `advanceOrderApproval` now return the two extra fields to privileged callers.

| Case | Error |
|---|---|
| `pending → approved` with no approver | P0001 `order approval has no approver`, HTTP 400 |
| Any disallowed change to `approved_by`, the snapshot or `approved_at` | P0001 `order approval is immutable`, HTTP 400 |
| (2026-11-09) An API caller changing a listed column on someone else's pending row | P0001 `order approval belongs to another approver`, HTTP 400 |
| (2026-11-09) A re-stamp, or a listed-column change on a pending row, by a caller whose `profiles.role` isn't privileged | P0001 `order approval caller is not an admin`, HTTP 400 |
| (2026-11-09, re-proposal build) A direct INSERT by an API caller with a `status` other than `pending` | P0001 `order approval must be inserted as pending`, HTTP 400. Checked first, before the role check |
| (2026-11-09, re-proposal build) A direct INSERT by an API caller whose `profiles.role` isn't privileged | P0001 `order approval caller is not an admin`, HTTP 400. The stamp trigger runs before the row-level security check, so this replaces the 42501 / HTTP 403 such a caller used to get, including ordinary staff and an `admin` claim with no profile row. No client makes direct INSERTs and no test pinned the old 42501 |
| Caller with no profile row | *(Corrected 2026-11-09, audit L7. This row used to say 23503.)* The caller can't reach the row. An `admin` claim with no profile can't see the store, so the RPC raises 42501 `not authorized for this store` and a PATCH updates 0 rows. A JWT-only `super_admin` isn't privileged in the database, because `auth_is_super_admin()` reads `profiles`. Amendment A1's role check refuses this caller too. *(2026-11-09, re-proposal build)* A direct INSERT by this caller now gets the stamp trigger's P0001 `order approval caller is not an admin` instead of 42501 |

### Edge function: `delete-user`

`verify_jwt` stays at the default (true), and `config.toml` doesn't change. The refusals, guards and response bodies don't change. Mirror spec 167's writer shape, with lines prefixed `[delete-user]`.

Add:

- The placeholder block, copied byte-identically.
- `AUDIT_TIMEOUT_MS = 3000`.
- `readDeleteAuditContext(service, callerId, targetId)`. It never throws, and it runs these reads in parallel, each with its own catch and log line:

  | Read | Used for | On failure |
  |---|---|---|
  | `profiles.select("id, name, role, brand_id").in("id", [targetId, callerId])` | Target's name, role and brand; whether the caller has a profile | Log; item_ref, role and brand NULL; `user_id` NULL |
  | `auth.admin.getUserById(targetId)` wrapped in `Promise.race` with the timeout | Email | Log; `value` is `""` |
  | `user_stores.select("store_id").eq("user_id", targetId)` | Union | Log; no rows are written |
  | `order_approvals.select("id", { count: "exact", head: true }).eq("approved_by", targetId)` | `approval_count` | Log; no rows are written |
  | `stores.select("id, order_approvals!inner(id)").eq("order_approvals.approved_by", targetId).limit(1, { referencedTable: "order_approvals" })` | Union | Log; no rows are written |

  The last query is deliberate. `max_rows = 1000` (`config.toml:18`), and a plain `order_approvals.select("store_id")` would silently drop stores for a target with more than 1,000 approvals, which is reachable in months at one row per store, vendor and day.

- `buildUserDeletedRows` (pure), one row per store in the union:

  ```
  { store_id,
    user_id: callerHasProfile ? callerId : null,
    action: "User deleted",
    item_ref,
    value,
    detail: JSON.stringify({ caller_id, target_id, target_role, brand_id,
                             approval_count, auth_user_deleted }) }
  ```

- `writeDeleteAudit`. It never throws, does one bulk insert with `.abortSignal(AbortSignal.timeout(AUDIT_TIMEOUT_MS))`, and with zero rows logs `audit skipped: target has no stores`.

Flow, replacing `index.ts:266-277`:

```
const ctx = await readDeleteAuditContext(...);
await supabase.from("user_stores").delete().eq("user_id", userId);
const { data: removed } = await supabase.from("profiles").delete().eq("id", userId).select("id");
const profileRemoved = (removed?.length ?? 0) > 0;
await supabase.from("invitations").delete().eq("profile_id", userId);

let error = null, thrown = undefined;
try { ({ error } = await supabase.auth.admin.deleteUser(userId)); } catch (e) { thrown = e; }
const authDeleted = !error && thrown === undefined;

if (profileRemoved || authDeleted) await writeDeleteAudit(...);   // never throws
else console.warn("[delete-user] audit skipped: nothing removed", callerId, targetId, action);

if (thrown !== undefined) throw thrown;                           // existing outer catch, same 500
if (error) return <the existing 500>;
return <the existing 200>;
```

Log lines carry only static text, caller id, target id, action, and an error code or class name (AC-29). The other cleanup errors stay ignored. Correct the comment at `index.ts:56-64`. Log and response behaviour for the existing refusals doesn't change.

### `src/lib/db.ts` surface

No new helpers, and the `OrderApproval` type doesn't change. `mapOrderApproval` picks named fields, so the new columns are dropped on the client. No snake_case to camelCase mapping is added, because no UI reads them (out of scope). One comment correction, above.

### Realtime impact

None. `order_approvals` and `audit_log` aren't in `supabase_realtime`, and publication membership doesn't change, so no `docker restart supabase_realtime_imr-inventory`.

### Frontend store impact

None. No `useStore` slice changes, so optimistic-then-revert doesn't apply. `db.createOrderApproval` runs before the status advance in the approve flow, so `order approval has no approver` should only surface if the approver is deleted between the two calls. It then appears through the existing `notifyBackendError` path. No `frontend-developer` work.

### Test changes

**New `supabase/tests/order_approvals_approver_snapshot.test.sql`.** Hermetic, with its own brand, store, two admins (A, B), a super_admin and a staff user, and `auth.users` rows with known emails. Backdate fixtures as described in open call 2. Read outcomes back as postgres by fixture id, not as a caller who might not see the row.

AC-1 to AC-19 stand, with these additions:

| Arm | Requirement |
|---|---|
| AC-4 | Run as an admin JWT at each status and once as postgres. Include a row with NULL `approved_by` |
| AC-5 | Also assert `approved_at` is unchanged. Run one delete as postgres with B's claims set, proving a SET NULL isn't taken for a re-stamp |
| AC-7 | Also assert `(tgtype::int & 127) = 7` and `tgenabled = 'O'` for the new trigger, and the T50 `proacl` check (no PUBLIC EXECUTE) for both trigger functions |
| AC-8 and AC-9 | Fixture row is A's, inserted as postgres with a backdated `approved_at`. AC-9 uses a `_t187` copy of the hide-once function and policy and asserts the `<consumed>` marker, so it can't quietly become a plain replay |
| **AC-8a (new)** | A retry by the same approver refreshes the lines and leaves `approved_at` and the snapshot as they were, even after a rename |
| **AC-10a (new)** | As B on A's pending row: `approved_by = B` with a forged name, email and `approved_at` in the same UPDATE stores B's real values and `now()` |
| **AC-10b (new)** | On a pending row, re-pointing `approved_by` at another profile is refused as postgres with no claims and as `service_role` with no claims. G3 can't prove this, because its row is `approved` |

**Flips in existing files.** Plan counts stay the same, and each flip becomes a delete, then `reset role`, then a count as postgres:

| File | Arm | New expectation |
|---|---|---|
| `profiles_rls_sweep.test.sql` | 7, 9 | Count 1 |
| `profiles_rls_sweep.test.sql` | 10 | Replace `throws_ok` with count 1 |
| `profiles_rls_sweep.test.sql` | 8 | Passes, but reword it: there is no longer a policy that scopes by brand |
| `auth_can_see_store_brand_scope.test.sql` | 11, 13 | Replace `throws_ok` with count 1 |
| `auth_can_see_store_brand_scope.test.sql` | 12 | Unchanged, but correct the comment at line 421 |

Later arms already re-impersonate, or reset the role, so the flips don't leak state. Update both headers.

**`audit_log_rls_hardening.test.sql`:**

| Arm | Runs as | Assertion |
|---|---|---|
| UD-1 | Staff block, `user_id` = staff | INSERT `User deleted` raises 42501 |
| UD-2 | Admin block, `user_id` = admin | Same |
| UD-3 | super_admin block, `user_id` = super | Same |
| UD-4 | Staff block | Count of the fixture row is 0 |
| UD-5 | Admin block | Count of the fixture row is 1 |
| UD-6 | `set local role service_role` | `lives_ok` on an INSERT, then reset the role |
| UD-7 | Final postgres block | UD-6's row exists |

In UD-1 to UD-3 the store is visible and the actor matches, so only the restrictive INSERT policy can refuse. Omit `created_at`.

**`scripts/smoke-delete-user.sh`.** Local-only refusal, `set -u`, the pass/fail/skip helpers, and an EXIT trap, as in `smoke-store-user.sh`. Fixtures are prefixed `zz_s187`: disposable targets through the auth admin API, one disposable brand-A store and vendor. Approvals are inserted with psql with `lines = '[]'` at `pending`, `approved` and `ordered`.

AC-23 to AC-29 stand, with these details:

- **AC-23:** the target has a `user_stores` row on one store and approvals on the other, with no `user_stores` row there.
- **AC-25a (new):** a caller with `app_metadata.role = super_admin` and no profile writes rows with NULL `user_id` and the right `detail.caller_id`.
- **AC-27, last-of-role arm:** the target is a disposable master, with other masters temporarily set to `admin` and restored in the trap. That way a regressed guard can't delete a seed user.
- **AC-29:** scan `docker logs --since` the script's start for the target's email, name and `no-email.invalid`, using the same leak-scan shape as `smoke-store-user.sh` (around line 587).

**Jest.** Add `delete-user` to `COPIES`. Update "five" to "six" in the `placeholderEmail.ts` header and the parity test comment.

**Proof the tests can fail.** Try these by hand and record the results, as specs 170 and 178 did:

| Temporary change | Must fail |
|---|---|
| Guard doesn't set `approved_at` | AC-8 |
| Drop `old.status = 'pending'` from `v_restamp` | AC-10 |
| Drop the overwrite of the snapshot | AC-8, AC-10a |
| Use `new.approved_by = auth.uid()` in a non-NULL-safe form | AC-10b |
| Leave the RPC's race branch without the stamp | AC-9 |

### Prod-apply additions

These add to "Prod apply" above and don't replace it:

- Step 1: if the count isn't 0, stop before running anything. A backfill would need a separate owner decision and would have to disable the guard.
- Step 4: the normalized md5 list is the guard, `create_order_approval` and `tg_order_approvals_stamp_approver`.
- Step 5: `order_approvals_stamp_approver_trg` has `tgenabled = 'O'` and `(tgtype::int & 127) = 7`. Both `audit_log` policies are still RESTRICTIVE, their definitions list `User deleted`, and five `spec 170: ` comments remain.
- Step 6 must follow the migration. A new `delete-user` running first would write email-bearing rows that staff could read. After deploying, confirm `verify_jwt` is still true.
- Before any of this: run `scripts/smoke-delete-user.sh` locally, since no CI runs it.
- (2026-11-09) Also before any of this, beside the smoke: `deno check` on `supabase/functions/delete-user/index.ts`, through Docker because Deno isn't installed here. No type checker has seen this file, and a type error would pass every smoke arm. Command shape in amendment A8.
- (2026-11-09) The checks for `approved_by_id` and the authority rule are in amendment A8.

### Risks and tradeoffs

- **Email on the wire.** The RPC's rowtype and `fetchOrderApproval`'s `select('*')` now carry `approved_by_email` to privileged clients even though no screen shows it. This falls within the spec's Low note, but that note only mentions SQL readability. Flagged for the security-auditor. Narrowing the select wouldn't help, because the RPC's return type is the whole row.
- **Direct PATCH takeover keeps A's lines.** The security note says A's lines leave with A's name. That is true through the RPC, but a direct PATCH of `approved_by` to the caller leaves the lines in place under the caller's name. It is still accepted: the caller is claiming them in their own name on a row that hasn't been approved. The guard can't tell the two paths apart. Flagged for the security-auditor. (2026-11-09: the reverse case, B's lines or approval left under A's name, was audit 187-H1 and is closed by amendment A1.)
- **JWT-only caller with no profile.** *(Corrected 2026-11-09, audit L7.)* This caller can't reach an approval at all: an `admin` claim with no profile can't see the store (42501 from the RPC, 0 rows from a PATCH), and a `super_admin` claim with no profile isn't privileged in the database. The 23503 path this note described doesn't occur. Prod's two privileged profiles both have rows. Accepted.
- **Retrying after a partial failure.** The first attempt's row says `auth_user_deleted: false`. A retry succeeds, but by then the union is empty, so it logs a console line and writes no second row. The audit row stays stale on that one field. Accepted, as a best-effort record.
- **Race window.** A row approved between the RPC's read and its update now raises `order approval is immutable` when the approver differs, rather than `...snapshot is immutable once approved`. Both are P0001, and nothing in `src/` matches on either message.
- **Rollout ordering.** Everything is in one transaction. The window between migration and deploy behaves like today with no audit row, as the spec says.
- **Performance.** Each insert or re-stamp does two primary-key reads. `approved_by` has no index, so the FK's SET NULL and the audit reads scan the table. That is negligible at 0 prod rows and none in the seed, so no index is added. `delete-user` gains about four round trips, capped at about 3 seconds for the reads and 3 for the write. Cold start doesn't change materially, and no dependency is added.

### Corrections to the spec

The design takes precedence over these sections:

1. **D3, "a fresh snapshot" on every retry:** only when the approver changes. A same-approver retry keeps the existing snapshot and `approved_at` (AC-8a).
2. **D4, "write the row whenever the profile was removed":** also when the login was removed and the profile delete errored or matched nothing (open call 6).
3. **Known limits, "if the pre-delete read ... fails, only a console line remains":** that applies only to the store and approval-count reads. If the profile or email read fails, rows are still written with those fields blank.
4. **AC-5:** also pins `approved_at`.
5. **New arms:** AC-8a, AC-10a, AC-10b, AC-25a.
6. **AC-22:** needs no edit to S-1 or S-6.
7. **Change section, "the guard, or a trigger that also fires on UPDATE":** it is the guard.

### Confirm first

I couldn't verify these without a database. Check them before building, and stop and report if any differs:

1. `pg_trigger` on `order_approvals` lists only `order_approvals_guard` and `order_approvals_lines_check_store_trg`, besides FK internals. `proowner` of the guard is `postgres`.
2. `pg_policies` for `profiles` has exactly one row with `cmd` in (`DELETE`, `ALL`).
3. The embedded `stores` query and `{ referencedTable }` work with the version `esm.sh/@supabase/supabase-js@2` currently resolves to. AC-23 proves it. If they don't, page through `order_approvals` with `.range()` until a short page.
4. `.delete().eq(...).select("id")` returns the deleted row for service_role.
5. The AC-28 fixture makes GoTrue return a 500, and `psql -U postgres` can create an FK to `auth.users`.
6. Run the mount sanity check from CLAUDE.md before any local edge debugging.

### Files the build changes

- `supabase/migrations/20261108120000_order_approval_approver_snapshot.sql` (new) *(superseded 2026-11-09: the file is `20261108130000_order_approval_approver_snapshot.sql`)*
- `supabase/functions/delete-user/index.ts`
- `supabase/tests/order_approvals_approver_snapshot.test.sql` (new)
- `supabase/tests/audit_log_rls_hardening.test.sql`
- `supabase/tests/profiles_rls_sweep.test.sql`
- `supabase/tests/auth_can_see_store_brand_scope.test.sql`
- `scripts/smoke-delete-user.sh` (new)
- `package.json` (`test:smoke`)
- `src/lib/placeholderEmail.parity.test.ts`
- `src/lib/placeholderEmail.ts` (comment)
- `src/lib/db.ts` (comment)
- The items under "To do at build"

## Backend design amendment (2026-11-09)

Amends the design above for fixes 1 to 7 of `specs/187-order-approval-approver-snapshot/reviews/release-proposal.md` (verdict FIXES_NEEDED), as the owner decided on 2026-11-09 ("Apply all fixes"). Where this section and the design above differ, this section wins. Designed from the files on disk, with no database access. Nothing in it has been run.

The migration `20261108130000_order_approval_approver_snapshot.sql` is applied on the shared local stack only, and isn't on prod, so it is **edited in place**. No new migration file.

### A1. Who may change a pending row (187-H1), and the stale-claim check (in-spec part of 187-H2)

**The rule.** It applies only when the caller has a non-NULL `auth.uid()`, the row's `old.status` is `pending`, and the UPDATE either re-stamps (`v_restamp`) or changes a column in the pending-edit list. Then, in this order:

1. `new.approved_by` must not be NULL. Otherwise P0001 `order approval has no approver`, the existing message, so AC-13 is unchanged.
2. The caller's own `profiles.role` must be `admin`, `master` or `super_admin`, read as the function owner. Otherwise P0001 `order approval caller is not an admin`.
3. `new.approved_by` must be the caller. Otherwise P0001 `order approval belongs to another approver`.

A re-stamp always passes check 3, so for a re-stamp only checks 1 and 2 bite.

**The pending-edit list:** `status`, `lines`, `line_count`, `est_total_cost`, `channel`, `external_ref`, `external_ref_expires_at`, `ordered_at`. This is every client-writable column that isn't already covered by another block.

| Not in the list | Why |
|---|---|
| `approved_by` | Its only legal moves are the re-stamp, which A1 does check, and the FK's SET NULL, which must not trip A1 (AC-5c). That is why A1 fires on `v_restamp or v_pending_edit`, not on any change to `approved_by` |
| `approved_at` and the three snapshot columns | Block (a1) already refuses them for everyone except the re-stamp, with the existing message (AC-4, AC-11) |
| `source_submission_id` | Its own block. Its SET NULL fires from an `eod_submissions` delete with the deleting caller's claims set, which includes spec 189's replace path |
| `id`, `store_id`, `vendor_id`, `business_date`, `created_at` | Block (a), always immutable |
| `updated_at` | Block (e) overwrites it |

**Ruling on `external_ref` and `external_ref_expires_at`: they join the list, for pending rows only.**

- **No app write is lost.** On a pending row, every app write of `external_ref` arrives together with `status = 'approved'`, from the caller who just ran `createOrderApproval`: the Instacart write-back (`supabase/functions/instacart-cart-link/index.ts:674-681`), Webstaurant (`src/store/useStore.ts:4316-4317`) and the extension (`src/store/useStore.ts:4331-4332`). The status change alone already puts those writes under the rule.
- **A lone write is an attack.** A lone `external_ref` write on someone else's pending Instacart row plants a URL. `instacart-cart-link` returns a live `external_ref` as `reused: true` with no upstream call (`index.ts:413-427`), the client opens it (`useStore.ts:4252`), and the reuse path writes nothing, so the row stays pending under the victim's name.
- **Approved rows are unchanged.** A1 never fires on an approved row, so AC-14b keeps working. That covers a re-mint after the link expires by any privileged admin who can see the row, including someone other than the approver and a row whose approver was deleted.
- **What stays open.** A privileged same-brand caller can still plant a URL on an approved Instacart row. That is older than this spec (spec 149) and isn't widened here. It's recorded as a follow-up.

`ordered_at` joins too. No app path writes it on a pending row. It is in the list so that the list covers every client-writable column.

**Refuse, don't auto re-stamp.** If the guard re-stamped the caller on any write, a late Instacart write-back from A would silently claim lines that B had just written. A refusal leaves the row as B left it.

**NULL safety.** Every comparison in the rule uses `is distinct from` or `is null`, and the role read is `exists (...)`, so no condition can be NULL and skip a refusal. With a NULL `auth.uid()`, the whole block is skipped. That covers postgres, `service_role` with no `sub`, the owner-level fixes through MCP and the fixture SQL in the smokes. So:

- `order_approvals_fk_set_null.test.sql` G1 to G4 are unaffected, because they run as postgres with no claims.
- G5 sets claims but changes only `approved_by`, so A1 doesn't fire.
- AC-5c's SET NULL runs with B's claims and changes only `approved_by`, so A1 doesn't fire.

**Role check posture.** The read is `exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('admin', 'master', 'super_admin'))`. It runs as the definer, past the caller's RLS, which is the guard's existing posture. The set mirrors `ADMIN_ROLES` in the edge functions and `auth_is_privileged()`. Don't replace it with `auth_is_privileged()` or `auth_is_admin()`, because those read the JWT claim, which is the stale part. Keep it inline in the guard. Spec 191 may change how role staleness is handled in general, and it can replace this check if so. (Corrected 2026-11-09, architect SF-R1: spec 191 says not to switch this check to its helper. Only the unfiled convergence follow-up would replace it. The stamp trigger's INSERT check from the re-proposal uses the same inline read.) The read runs only inside the outer `if`, so ordinary updates don't pay for it.

**Guard pseudocode, in the order the checks run.** This replaces the body of `tg_order_approvals_guard()` in `20261108130000`. "Unchanged" means as the file has it today.

```
declare
  v_uid          uuid := auth.uid();
  v_restamp      boolean;
  v_pending_edit boolean;
begin
  -- Unchanged expression, now read from v_uid. Never NULL.
  v_restamp := old.status = 'pending'
           and new.approved_by is not null
           and new.approved_by is distinct from old.approved_by
           and new.approved_by is not distinct from v_uid;

  -- Never NULL: every operand is IS DISTINCT FROM.
  v_pending_edit := new.status                  is distinct from old.status
                 or new.lines                   is distinct from old.lines
                 or new.line_count              is distinct from old.line_count
                 or new.est_total_cost          is distinct from old.est_total_cost
                 or new.channel                 is distinct from old.channel
                 or new.external_ref            is distinct from old.external_ref
                 or new.external_ref_expires_at is distinct from old.external_ref_expires_at
                 or new.ordered_at              is distinct from old.ordered_at;

  (a)  identity columns: unchanged ('order approval is immutable').
       Stays first, so G6's message is unchanged.

  (a0) NEW. Spec 187 H1 and H2: who may change a pending row.
       if old.status = 'pending' and v_uid is not null
          and (v_restamp or v_pending_edit) then
         if new.approved_by is null then
           raise 'order approval has no approver' P0001;
         end if;
         if not exists (select 1 from public.profiles p
                         where p.id = v_uid
                           and p.role in ('admin', 'master', 'super_admin')) then
           raise 'order approval caller is not an admin' P0001;
         end if;
         if new.approved_by is distinct from v_uid then
           raise 'order approval belongs to another approver' P0001;
         end if;
       end if;

  (a1) unchanged, except approved_by_id (A2):
       if v_restamp then
         <the A2 snapshot block>
         new.approved_at := now();
       elsif approved_at, approved_by_name, approved_by_email or approved_by_id changed then
         raise 'order approval is immutable' P0001;
       end if;

  (a2) approved_by pointer: unchanged.
       source_submission_id block: unchanged.
  (b)  status transitions: unchanged, including the existing no-approver refusal,
       which still covers callers with a NULL auth.uid().
  (c), (c2), (d), (e): unchanged.
```

(a0) runs before (a1), so a refused re-stamp never reads `auth.users`. Update the guard's comments:

- The "don't change this to invoker" comment: the role read also needs definer.
- `comment on function`: add the rule, and the fact that `external_ref` is approver-only while pending.
- The header block of the migration: describe the rule and the new column.

**The app's writes, checked by reading** (`src/store/useStore.ts:4230-4440`, `supabase/functions/instacart-cart-link/index.ts:668-681`). Every pending-row write in the approve flow runs after `db.createOrderApproval` (`useStore.ts:4401`) in the same action. That call either inserts the row as the caller or re-stamps it to the caller, so the caller is the approver when the write lands.

| Write | Where | Row | A1 result |
|---|---|---|---|
| OQ-2 channel fallback | `useStore.ts:4286-4291` | Pending, caller is approver | Passes. (c2) still applies |
| Webstaurant advance with `external_ref` | `useStore.ts:4316-4321` | Same | Passes |
| Extension advance with `external_ref` | `useStore.ts:4331-4336` | Same | Passes |
| Manual advance | `useStore.ts:4379-4384` | Same | Passes |
| Instacart write-back | `instacart-cart-link/index.ts:674-681` | Pending, caller is approver | Passes |
| Instacart re-mint | Same | Approved | A1 skipped. Passes for any privileged caller who can see the row (AC-14b) |
| Mark ordered | `useStore.ts:4437` | Approved → ordered | A1 skipped |
| RPC retry and race branches | Migration | Re-stamp, or a same-approver retry | Passes if the caller's profile role is privileged |

The existing test files were also checked by reading:

- `order_approvals.test.sql`: G1, G2, G6 to G9, and the unwrapped updates at lines 296 and 306 all run as the seed admin, whose profile role is `admin`, on rows that admin created through the RPC. G1 still raises P0001 from (b). G6 is (a). G7 is (c2).
- `cross_store_item_rejection.test.sql`: T30, T34, T35 and T37 run as the admin who made the row. T30 still gets 42501 from the lines trigger, because (a0) passes.
- `order_approvals_approver_snapshot.test.sql`: AC-4, AC-10 and AC-11 change only `approved_by`, `approved_at` or snapshot columns, so their messages are unchanged. AC-13 keeps its message. AC-14 runs on approved rows. AC-15 is B re-stamping and then approving their own row.

None of this has been run. Run every file.

**New user-visible behaviour when another admin re-stamps mid-flow.** Suppose admin B calls `create_order_approval` for the same store, vendor and day while admin A's Approve & order flow is between its `createOrderApproval` and its advance. A's next write is then refused with P0001 `order approval belongs to another approver`, and A sees the raw message in the existing `notifyBackendError` toast:

| A's channel | What has already happened when the refusal lands |
|---|---|
| Instacart | The link was minted upstream, but the write-back is refused. The function returns its existing 500 `writeback_failed`, and the client doesn't open the link, because it opens only on `ok` |
| Webstaurant | The order page has already opened |
| Extension | `fillCartForVendor` has already created the draft PO and handed the cart to the extension. The draft PO stays |
| Manual | The quick-order text has already been shared or copied |
| OQ-2 fallback | The channel PATCH is refused with a toast. `runChannel` then carries on with the fallback channel locally (`useStore.ts:4292`, `updated ?? { ...row, channel: fallback }`), and that channel's advance is refused too, so A sees two toasts |

In every case the row stays pending under B, with B's lines. If A retries, A re-stamps the row with A's lines. While the row is pending, the last writer wins, and only the person whose lines are on the row can approve it. `markOrderApprovalOrdered` is unaffected. No screen changes in this spec. A friendlier message is a follow-up.

**What 187-H2 still leaves open.** The owner accepted these on 2026-11-09 until specs 195 and 191 ship. Each needs a stale `admin` claim plus a self-linked store:

- reading approver emails and `User deleted` rows in a self-linked store
- inserting new pending rows in the caller's own true name, because the guard is UPDATE-only, though the stamp records them honestly (pinned by AC-37)
- advancing an already-approved row to `ordered` (pinned by AC-37)
- re-minting `external_ref` on an approved row

**Corrected 2026-11-09 (re-audit M-R1, architect SF-R1, owner decision).** The second bullet was understated: the claim could insert a row at any status, with any channel and timestamps. The stamp trigger now refuses every INSERT by a caller whose `profiles.role` isn't privileged, and any API caller's INSERT that isn't `pending` (AC-37a, AC-38). So the second bullet is closed. The other three stay open. They need a stale claim plus a store link: a self-link until spec 195, and after that the links a demoted admin keeps in their own brand. Each case lasts at most `jwt_expiry` after a demotion (3600 s locally; prod's value hasn't been checked). They end only when the `auth_is_admin()` / `auth_is_privileged()` convergence follow-up (named in spec 191, not yet filed) ships. Spec 191 doesn't end them.

### A2. The approver id, and refusing a blank name (187-M1)

**Column:** `approved_by_id uuid`.

- Nullable, with no default, no foreign key and no index.
- No FK on purpose. An FK would either block the profile delete or be SET NULL by it, and either defeats the point.
- No index, because prod has 0 rows. Lookups by a live approver use `approved_by`.
- Add it in the same `alter table` as the other two. Comment it as: written only by the server, the id of `approved_by` at the stamp, no FK so it survives the profile delete, and it matches `detail.target_id` on the `User deleted` row.

**Snapshot block.** Use the same text in `tg_order_approvals_stamp_approver()` and in the guard's re-stamp branch, and keep the two textually identical. AC-2d pins the INSERT copy and AC-8b pins the re-stamp copy.

```
v_name  := (select p.name  from public.profiles p where p.id = new.approved_by);
v_email := (select u.email from auth.users u      where u.id = new.approved_by);
new.approved_by_id    := new.approved_by;
new.approved_by_email := nullif(btrim(v_email), '');
new.approved_by_name  := coalesce(nullif(btrim(v_name), ''), new.approved_by_email);
```

- **NULL `approved_by`:** all three columns are NULL (AC-3).
- **Client values:** a client value never survives, because all three columns are assigned on every path.
- **On UPDATE:** `approved_by_id` changes only in the re-stamp branch. Block (a1) refuses it otherwise.
- **FK SET NULL:** the RI action changes `approved_by` only, so `approved_by_id` compares equal and keeps the deleted id (AC-5).
- **No email either:** if the name is blank and there is no email, the name is NULL. GoTrue email logins always have an email.
- **Declarations:** declare `v_name` and `v_email` as `text` in both functions.

### A3. One line each for the developer (fixes 4, 5 and 7)

- **Fix 4, `delete-user` `thrown` flag** (`supabase/functions/delete-user/index.ts`, around 513-546). Replace the `thrown !== undefined` sentinel with a separate `let authDeleteThrew = false` (plus the caught value), or a single `authDeleteFailed` boolean. `authUserDeleted` comes from that flag. Behaviour, responses and logs stay as they are.
- **Fix 5, type names** (same file). Rename `DeleteAuditCtx` to `DeleteAuditIds` (locals `ids`) and `DeleteAuditContext` to `DeleteAuditSnapshot` (locals `snapshot`). Renaming `readDeleteAuditContext` to `readDeleteAuditSnapshot` is optional.
- **Fix 7, nits:**
  - `drop policy if exists "Admins can delete profiles"`.
  - In the RPC's header comment, trim "Re-approval is REFUSED, not overwritten — that is what keeps the row genuinely append-only" to say only that approved and ordered rows are returned with no write.
  - Reflow the comment at `src/lib/db.ts:2703-2706`. It is the only spec 187 hunk in that file, so stage it by hunk, or drop it if the index can't be cleared.
  - Add one comment line at the `Promise.race`: it abandons the `getUserById` call, it doesn't cancel it.
  - Add the t2, t5 and t6 targets' names and emails, and the no-profile super_admin's, to the AC-29 leak scan in `scripts/smoke-delete-user.sh`.
  - Optional: a null-means-failed note on `approvalCount`, a comment on `SMOKE_T0` granularity, and a trusted-test-values comment on `new_target`.

### A4. pgTAP arms (`supabase/tests/order_approvals_approver_snapshot.test.sql`)

**Fixture additions:**

- `b0`: role `master`, brand 1.
- `b1`: role `admin`, brand 1, with `profiles.name = '   '`.
- `a4`: role `user`, brand NULL, with a `user_stores` row on the test store. This is the demoted shape. Insert it as postgres.
- New pending rows on unused days, owned by A, plus one owned by `a4`. Insert them as postgres with a backdated `approved_at`, as the file already does.
- Extend `_t187_view` with the approver id's two-hex-digit tag, so every existing arm also pins `approved_by_id`. Add `approved_by_id` (a forged uuid, and NULL) to `_t187_edit_snapshot`.
- Add a helper like `_t187_edit_snapshot` that tries each listed column separately and returns the distinct outcomes.
- Keep the file's existing pattern: run as the caller, record into a setting, assert as postgres.

**Existing arms whose expectations change:** every `_t187_view` string, because of the id tag, plus these:

- AC-1, AC-2a and AC-2b now pin the id. AC-2 also supplies a forged `approved_by_id`.
- AC-3: NULL id.
- AC-4: covers `approved_by_id`.
- AC-5a to AC-5c: the id is kept.
- AC-8, AC-9, AC-10a, AC-15b: B's id.

**New arms:**

| Arm | Runs as | Does | Expects |
|---|---|---|---|
| AC-32a | B, on A's pending row | Each listed column changed separately: `status='approved'`, `lines`, `line_count`, `est_total_cost`, `channel='extension'`, `external_ref`, `external_ref_expires_at`, `ordered_at` | One distinct outcome, `P0001: order approval belongs to another approver` |
| AC-32b | postgres | Reads that row back | Unchanged, including `external_ref`, `channel` and `ordered_at` |
| AC-33 | A, on a pending row with no approver | Changes `lines`, then `channel` | `P0001: order approval has no approver` |
| AC-34a | A, on A's own pending row | `channel='extension'`, then `status='approved'` with `external_ref` and `external_ref_expires_at` | `ok:1` twice, row approved under A |
| AC-34b | postgres, then `service_role`, both with no claims, on A's pending row | Changes `lines`, then `status='approved'` | `ok:1` for each |
| AC-34c | B, on A's approved row | `status='approved'` with a new `external_ref` and expiry (the re-mint shape) | `ok:1` |
| AC-36 | B through the RPC on A's pending row, then A | A writes `external_ref`, `external_ref_expires_at` and `status='approved'` | A's write gets the AC-32 message. Row is `B id\|B name\|pending` with B's lines |
| AC-35a | `a1` (staff, brand 1, store-linked) with an `admin` claim | RPC on A's pending row | `P0001: order approval caller is not an admin`. Row unchanged |
| AC-35b | Same | Sets `status='approved'` on its own pending row, from AC-37a | `P0001: order approval caller is not an admin` |
| AC-35c | `a4` (NULL brand, store-linked) with an `admin` claim | PATCH `approved_by = auth.uid()` on A's pending row | `P0001: order approval caller is not an admin` |
| AC-35d | Same | PATCH `lines` on A's pending row | `P0001: order approval caller is not an admin` |
| AC-35e | Same | Sets `status='approved'` on a4's own pending row | `P0001: order approval caller is not an admin` |
| AC-35f | `b0` (master) | RPC on a fresh day, then `status='approved'` | `ok:1` twice |
| AC-35g | `a0` (super_admin) | Same | `ok:1` twice |
| AC-37a | `a1` with an `admin` claim | RPC on a fresh day | `ok:1`. Row stamped with a1's real name, email and id. Known gap |
| AC-37b | `a4` with an `admin` claim | `status='ordered'` on A's approved row | `ok:1`. Known gap |
| AC-2d | `b1` | Direct INSERT, then the RPC on a fresh day | Name is `oa187-b1@local.test` both times |
| AC-8b | `b1` | RPC on A's pending row (re-stamp) | Name is `oa187-b1@local.test`, id is b1's, and `approved_at` is now |
| AC-7g | postgres | Catalog read | `approved_by_id` is `uuid`, nullable, and appears in no `contype = 'f'` constraint's `conkey` on `order_approvals` |

That is 19 new arms. The plan goes from 49 to 68 if each row is one assertion. Set `plan()` to the real count and update the header map.

### A5. Proof the new rules can fail

Each mutation runs in the same transaction as the test file, as the implementation notes describe, so the file's own `rollback` removes it.

| Temporary change | Must go red |
|---|---|
| Drop check 3 (approver match) from (a0) | AC-32a, AC-36 |
| Drop any one column from `v_pending_edit` (try each) | AC-32a, whose outcome gains an `ok:1` |
| Drop `old.status = 'pending'` from (a0) | AC-34c, AC-14b |
| Drop `v_uid is not null` from (a0) | AC-34b |
| Fire (a0) on any `approved_by` change, not on `v_restamp or v_pending_edit` | AC-5c |
| Move the NULL check after check 3 | AC-13, AC-33 |
| Drop the role check | AC-35a to AC-35e |
| Role check uses `auth_is_privileged()` instead of `profiles` | AC-35a to AC-35e |
| Role set without `master` | AC-35f |
| Role set without `super_admin` | AC-35g |
| `external_ref` and its expiry out of the list | AC-32a |
| Stamp trigger doesn't set `approved_by_id` | AC-1, AC-2a, AC-2b |
| Re-stamp doesn't set `approved_by_id` | AC-8, AC-9, AC-15b, AC-8b |
| `approved_by_id` missing from (a1)'s refusal | AC-4a to AC-4e |
| `approved_by_id` given an FK with `on delete set null` | AC-5a to AC-5c, AC-7g |
| Stamp trigger stores the raw `p.name` | AC-2d |
| Re-stamp stores the raw `p.name` | AC-8b |

Record the results under the implementation notes, as before.

### A6. Re-applying on the shared local stack

Editing the file doesn't change the shared database, and the file can't be re-run, because of `add column` and `create trigger`. Don't run `supabase db reset` while other sessions use the stack. Instead:

1. In one `psql` transaction, run only the delta:
   - the `add column approved_by_id` and its comment
   - `create or replace` of both trigger functions, copied from the edited file
   - the edited `comment on function` text
   - nothing else

   `create or replace` keeps each function's existing ACL. The policy drop and the two `alter policy` statements are already applied.
2. Confirm the live `prosrc` of the guard, the stamp trigger and `create_order_approval` matches the edited file, then recapture the normalized md5 references for the prod check.
3. Local rows created before the delta have a NULL `approved_by_id`. That is local only. Prod has none.

### A7. A fresh-build check with no PR, leaving the shared stack alone (SF-3)

This builds a second, throwaway Supabase stack from a scratch worktree, using CI's pinned CLI version. The shared stack's containers, volumes and network are named after `project_id` and the scratch stack's aren't, so nothing shared is touched. A draft PR remains the alternative, and still needs the owner's go-ahead.

1. **Worktree.** Run `git worktree add --detach <scratch>/imr-fresh187 HEAD`, with `<scratch>` outside the repo and outside `.claude/worktrees/`. Copy in exactly spec 187's files from the staging table (release proposal step 10, "Stage whole"), and none of spec 186's. Don't use `git stash`.
2. **Config, in the worktree only, never committed.** In `supabase/config.toml`, set `project_id = "imr-fresh187"` and move every host port off the shared stack's:
   - `api` 54421, `db` 54422, `shadow_port` 54420, `db.pooler` 54429
   - `studio` 54423, `inbucket` 54424, `analytics` 54427
   - `edge_runtime.inspector_port` 8183

   Check the ports are free first.
3. **Boot.** From the worktree, run `npx supabase@2.106.0 start`. That pins CI's version. Bare `npx supabase` is 3.0.0 and refuses this config. You may exclude UI and log services with `-x`, after checking their names in `--help`. Keep every service that owns a schema. Before going on, confirm with `docker ps` that the new containers end in `_imr-fresh187`.
4. **Test.** Run `CONTAINER=supabase_db_imr-fresh187 bash <scratch>/imr-fresh187/scripts/test-db.sh`. That runs every pgTAP file in the worktree against a database built from scratch. This proves spec 187 alone (SF-4).
5. **Optional: both specs together.** Copy in spec 186's migration and test, run `npx supabase@2.106.0 db reset` from the worktree, and repeat step 4. The reset hits only the scratch stack, but re-check `docker ps` first.
6. **Tear down.** From the worktree, run `npx supabase@2.106.0 stop --no-backup`, then `git worktree remove --force <scratch>/imr-fresh187`. Then confirm that `docker ps` shows the shared `_imr-inventory` stack exactly as before.

If any step can't be done safely, for example a port clash or not enough memory for a second stack, stop and record it. The fallback is the draft PR, with the owner's go-ahead, or the accepted risk of watching the first `test.yml` run on `main`.

### A8. Prod-apply additions for this amendment

These add to "Prod apply" and "Prod-apply additions" above.

- **Before anything,** run `deno check` through Docker, for example `docker run --rm -v <repo>/supabase/functions:/fns -w /fns denoland/deno:<2.x tag> deno check delete-user/index.ts`. It needs network access for the `esm.sh` imports. Use a writable mount, or add `--no-lock` if a lockfile write fails. It must pass before step 6.
- **Also before anything,** run the smokes: `scripts/smoke-delete-user.sh`, with AC-24 now checking `approved_by_id`. Run `smoke-edge-roles.sh` once at a quiet time, because its Arm 4 promotes `admin@local.test`.
- **Step 4:** the normalized md5 list is still the guard, `create_order_approval` and `tg_order_approvals_stamp_approver`. Recapture the local references after A6.
- **Step 5:** `approved_by_id` exists as a nullable `uuid` with its comment, and no foreign key covers it (no `contype = 'f'` row in `pg_constraint` whose `conkey` includes its attnum). `prosrc` of the guard contains `order approval belongs to another approver` and `order approval caller is not an admin`. That is a quick check beside the md5.
- **Read-only, record the result:** prod's email-confirmation setting. 187-M1's email half was simulated. The id column doesn't depend on the answer.

### A9. Files this amendment changes

- `supabase/migrations/20261108130000_order_approval_approver_snapshot.sql`: the column, both trigger functions, comments, header, and the fix 7 SQL nits
- `supabase/tests/order_approvals_approver_snapshot.test.sql`: the A4 arms and the plan count
- `supabase/functions/delete-user/index.ts`: fixes 4, 5 and the `Promise.race` comment
- `scripts/smoke-delete-user.sh`: the AC-24 id check and the AC-29 scan list
- `src/lib/db.ts`: the comment reflow only, staged by hunk
- `specs/187-order-approval-approver-snapshot.md`: the implementation notes, the mutation results and the files-changed list

No change to `src/store/useStore.ts`, `instacart-cart-link`, `config.toml` (outside the throwaway worktree in A7), RLS policies or realtime. Only the backend developer has work.

## Implementation notes

Built 2026-11-08. Local stack only: nothing committed, nothing on prod, `delete-user` not deployed. The migration was applied locally with psql and its version inserted into local `supabase_migrations.schema_migrations`.

**Departure from the design's file list:** the migration is `20261108130000`, not `20261108120000`. Spec 186 took that slot while this was being built, so open call 8's "next free one after the newest" applied. The two migrations change different objects and can be applied in either order. The drift gate needs each one on prod before the push that commits it.

**"Confirm first" results, all as the design assumed:**

| # | Check | Result |
|---|---|---|
| 1 | Triggers and owner | Only `order_approvals_guard` and `order_approvals_lines_check_store_trg` besides FK internals. Guard owner `postgres` |
| 2 | `profiles` DELETE or ALL policies | Exactly one, `Admins can delete profiles` |
| 3 | Embedded `stores` query and `{ referencedTable }` | Work on supabase-js 2.119.0, the version `esm.sh/@supabase/supabase-js@2` resolved to. Proven by AC-23 |
| 4 | `.delete().eq().select("id")` as service_role | Returns the deleted row, and `[]` on a repeat |
| 5 | AC-28 fixture | `psql -U postgres` can create the FK, and GoTrue returns 500 with 23503 |
| 6 | Mount check | `supabase/functions` is mounted from the repo root |

**AC-28 stayed a smoke arm.** It passed on all three smoke runs, so it did not become a review check.

**Added beyond the listed arms:**

- pgTAP: AC-2c (naming someone else as approver is 42501, and the error carries no email) and S-1, S-2 (a store-linked staff user can't read the snapshot or use the RPC). The new file has 49 arms.
- Smoke: AC-23b (a store in both halves of the union gets one row), the AC-28 retry, AF (a forced `audit_log` failure leaves the 200 and logs only the code), and a tally of rows per run.

**Smoke on a shared stack.** AC-29 scans the whole edge log for strings unique to the run, and scans only `[delete-user]` lines for `no-email.invalid`, because another session's function may legitimately log that domain. The last-of-role arm sets the seed master to `admin` for one request, as the design says, so another session using that login sees it for about a second.

**Not run:** `smoke-edge-roles.sh` and the rest of `test:smoke`. Arm 4 of `smoke-edge-roles.sh` promotes `admin@local.test` to super_admin, which would disturb other sessions on this stack. Its `delete-user` arms refuse before any line this spec changed, and AC-27 covers the plain self-delete refusal. `deno check` was also not run, because Deno isn't installed here. The function ran for real in the edge runtime, but its types haven't been checked by anything.

**Proof the tests can fail.** Each mutation ran in the same transaction as the test file, so the file's own `rollback` removed it and no other session on the database saw it. Afterwards the live `prosrc` of all three functions matched the migration file byte for byte.

| Temporary change | Arms that went red |
|---|---|
| Guard doesn't set `approved_at` | AC-8, AC-9, AC-10a, AC-15b |
| Drop `old.status = 'pending'` from `v_restamp` | AC-10c, AC-10d, AC-11b, AC-11c |
| Guard drops the snapshot overwrite | AC-8, AC-9, AC-10a, AC-15b |
| `new.approved_by = auth.uid()`, not NULL-safe | AC-10b, AC-10b3 |
| RPC race branch without the stamp | AC-9 |
| RPC retry branch without the stamp | AC-8, AC-15b |
| INSERT trigger keeps a client value (`coalesce`) | AC-2a, AC-2b, AC-3 |
| Guard's snapshot and `approved_at` refusal removed | AC-4a to AC-4f, AC-11a to AC-11c |
| No-approver refusal removed | AC-13 |
| Drop `new.approved_by is not null` from `v_restamp` | AC-5a, AC-5b |
| Any move with claims set counts as a re-stamp | AC-5c, AC-10a2, AC-10b2 |
| `Admins can delete profiles` re-created | AC-16, AC-17a to AC-17d, sweep arms 7 and 9 and then arm 10 raises, brand-scope arm 11 raises |
| Restrictive INSERT policy omits `User deleted` | UD-1, UD-2, UD-3 |
| Restrictive SELECT policy omits `User deleted` | UD-4 |
| EXECUTE granted to `authenticated` on the trigger function | AC-7c |
| `profiles_self_delete_lock` dropped | AC-18 |

The smoke script was not mutation-tested. Its row checks compare exact values, and its AF arm shows it detects a missing row.

**Base typecheck.** `npm run typecheck` exits 2 here, with 24 errors of the form `Cannot find type definition file for 'yargs 2'`. All 24 come from empty `node_modules/@types/* 2` folders dated Oct 26, in a gitignored directory this spec didn't touch. `npx tsc --noEmit --types node,jest` exits 0 with 0 errors, and `npm run typecheck:test` exits 0. They were left in place.

**Unrecorded addition, accepted by the architect review (Nit 1), recorded 2026-11-09.** `delete-user` puts `.abortSignal(AbortSignal.timeout(AUDIT_TIMEOUT_MS))` on the four PostgREST reads as well, not only on the email read and the write as the design said. That is what makes the design's "about 3 seconds for the reads" true.

**File coupling for staging (added 2026-11-09, architect SF-4).** Every local test ran on a database holding both specs' migrations, so a green local run says nothing about a partial commit. These must be committed together:

- The migration, with `audit_log_rls_hardening.test.sql`, `profiles_rls_sweep.test.sql`, `auth_can_see_store_brand_scope.test.sql` and `order_approvals_approver_snapshot.test.sql`. Without the migration, UD-1 to UD-4 fail, sweep arms 7 and 9 fail and arm 10 raises, brand-scope arm 11 raises, and the new file fails at its fixtures. Without the test edits, the migration turns the same arms red.
- `supabase/functions/delete-user/index.ts`, with `src/lib/placeholderEmail.parity.test.ts` and the `placeholderEmail.ts` header.

`audit_log_rls_hardening.test.sql` holds no spec 186 hunks, so stage it whole. `src/lib/db.ts` is the file to stage by hunk: spec 187 owns only the comment near L2703. Amendment A7 proves spec 187 alone on a fresh database.

**Correction about spec 186 (2026-11-09, architect SF-5).** Several lines above were written when spec 186 had no design. As of 2026-11-09, spec 186 is READY_FOR_REVIEW, with migration `supabase/migrations/20261108120000_retention_prune_job.sql` and test `supabase/tests/retention_prune_job.test.sql` on disk. So:

| Where | Said | Now |
|---|---|---|
| Known limits, first bullet | "Today `cleanupOldRecords` and `admin_delete_audit_log` do the pruning" | True only until spec 186 ships. The 90-day point stands |
| Dependencies, spec 186 | READY_FOR_ARCH, not built. Both specs edit `audit_log_rls_hardening.test.sql`, and the second rebases | Built. Only spec 187 edits that file. No rebase is owed |
| Dependencies, migration version | Left to the build | `20261108130000`. Spec 186 is `20261108120000` |
| Design, open call 8 | Specs 186 and 188 have no design or migration, and spec 186 "only decides `admin_delete_audit_log`" | Spec 186 also adds three restrictive DELETE policies (`purchase_orders`, `waste_log`, `pos_imports`), a `stores` trigger and a cron job. The objects are still disjoint from spec 187's, so either landing order works |
| Design, after the `audit_log_rls_hardening` table | The second spec adds its arm count, or edits S-1 and S-6 if the policy is dropped | The policy stayed and spec 186 used its own test file. Nothing is owed |

### Amendment build (2026-11-09)

Amendment A1 to A9 built on 2026-11-09. Same limits as before: nothing committed, staged or pushed, nothing on prod, `delete-user` not deployed, no `supabase db reset` or `stop` on the shared stack. The migration was edited in place.

**What changed:**

- **Migration.** `approved_by_id uuid` added to the same `alter table`, with its comment. The A2 snapshot block is textually identical in the stamp trigger and the guard's re-stamp branch. The guard gains `v_uid`, `v_pending_edit` and block (a0), in A1's order, and (a1)'s refusal covers `approved_by_id`. Comments updated: the header, the "don't change to invoker" note, and `comment on function` for both trigger functions. The fix 7 nits: `drop policy if exists`, and the trimmed "append-only" sentence in the RPC's header comment, which is outside the function body. The body of `create_order_approval` is unchanged: its live raw `prosrc` md5 is the same before and after the delta.
- **One addition beyond the letter of A2:** the `approved_by_name` and `approved_by_email` column comments now say "trimmed" and "falls back to the email", because the old wording no longer described what is stored. A9 lists "comments" as migration work, so both statements went into the A6 delta. They're idempotent `comment on column` statements.
- **`delete-user`.** Fix 4: `authDeleteThrew` and `authDeleteThrown` replace the `thrown !== undefined` sentinel. Fix 5: `DeleteAuditIds` (locals `ids`), `DeleteAuditSnapshot` (locals `snapshot`), and the optional `readDeleteAuditSnapshot`. The handler's locals are `auditIds` and `auditSnapshot`. Also the `Promise.race` comment and a null-means-failed note on `approvalCount`. No response, log line or I/O changed.
- **Smoke.** AC-24 also requires `approved_by_id = target`, and that each approval's `approved_by_id` appears as `detail.target_id` on every `User deleted` row for the target (3 approvals × 2 rows = 6 pairs, text match, no jsonb cast). The AC-29 scan adds t2's, t5's and t6's names and emails, and the no-profile super_admin's email (it has no name). Optional comments added: `SMOKE_T0` granularity and `new_target`'s trusted values.
- **`src/lib/db.ts`.** The comment reflow only. Spec 186 was committed in `15aefc4` while this was being built, and `db.ts` now carries other sessions' hunks besides this one (the `@@ -2699` hunk). Stage it by hunk.

**pgTAP file (68 arms).** As A4 lists, with these choices:

- `_t187_view` is `approver tag | approved_by_id tag | name | email | approved_at | status | lines`.
- The three AC-5 deletes now record their outcome through `_t187_try` and assert `ok:1`, so a guard that refuses the SET NULL turns AC-5 red instead of aborting the file. Without this, the "fire on any `approved_by` change" and FK mutations would have aborted rather than failed.
- `b0`'s name is padded (`'  Person b0 (t187)  '`), so AC-35f also pins that a non-blank name is stored trimmed (AC-2d's second sentence).
- `_t187_view_full` adds `channel`, the zero line count and total, `external_ref`, its expiry and `ordered_at`, for AC-32b, AC-33 and AC-36.
- All of A1's "checked by reading" claims held when run: `order_approvals`, `order_approvals_fk_set_null` (G1 to G5), `cross_store_item_rejection` and the existing AC arms pass unchanged.

**A6 on the shared stack.** Before anything was applied, every pgTAP file was run with the delta injected after its own `begin;`, so the new guard existed only inside each file's rolled-back transaction: 99/99 green. Then the delta was applied in one `psql` transaction: `add column approved_by_id`, the three column comments, `create or replace` of both trigger functions, and both `comment on function`. Afterwards the live `prosrc` of `tg_order_approvals_guard`, `tg_order_approvals_stamp_approver` and `create_order_approval` matched the file byte for byte, read straight from the file, and `proacl` was unchanged. Re-checked after the mutation runs and again at the end. Pre-delta local rows have a NULL `approved_by_id` (local count was 0).

**Prod-check references (A8 step 4), recaptured after A6.** (Superseded 2026-11-09 for `tg_order_approvals_stamp_approver`, see "Re-proposal build". The guard's and the RPC's values are unchanged.) Normalized md5 is `md5(lower(regexp_replace(regexp_replace(pg_get_functiondef(oid), '--[^\n]*', '', 'g'), '\s+', ' ', 'g')))`:

| Function | Normalized md5 | Raw `prosrc` md5 | `prosecdef` | `proconfig` | Owner | `proacl` |
|---|---|---|---|---|---|---|
| `tg_order_approvals_guard` | `733e4f3e79339b74bb48b134f37fc933` | `c89df6a4534d07f2e4cf11b7157e25e7` | t | `search_path=public` | postgres | `postgres=X/postgres,service_role=X/postgres` |
| `tg_order_approvals_stamp_approver` | `0f7d51f45f500535df5ed6d9215f83d9` | `89ebf13f0e0343ea6eb3eb860c2f6fe8` | t | `search_path=public` | postgres | `postgres=X/postgres,service_role=X/postgres` |
| `create_order_approval` | `3dd805dc599294de818a46d32883861f` | `a544d68df89bd258216dfd11b1af8de1` | f | `search_path=public` | postgres | `postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres` |

Local A8 step 5: `approved_by_id` is a nullable `uuid` with a comment, and 0 `contype = 'f'` constraints cover its attnum.

**A5, proof the new rules can fail.** Each mutation re-created the function inside the test file's own transaction (or added the FK there), so the file's `rollback` removed it. A control run that re-created the unmutated functions was 68/68. No run aborted.

| Temporary change | Arms that went red (A5's required arms in bold) |
|---|---|
| Drop check 3 from (a0) | **AC-32a**, AC-32b, **AC-36** |
| Drop `status` from `v_pending_edit` | **AC-32a**, AC-32b, AC-35b, AC-35e, AC-37a |
| Drop `lines` | **AC-32a**, AC-32b, AC-33, AC-35d |
| Drop `line_count` | **AC-32a**, AC-32b |
| Drop `est_total_cost` | **AC-32a**, AC-32b |
| Drop `channel` | **AC-32a**, AC-32b, AC-33 |
| Drop `external_ref` | **AC-32a**, AC-32b |
| Drop `external_ref_expires_at` | **AC-32a**, AC-32b |
| Drop `ordered_at` | **AC-32a**, AC-32b |
| Drop `old.status = 'pending'` from (a0) | AC-14a, **AC-14b**, **AC-34c**, AC-37b |
| Drop `v_uid is not null` from (a0) | **AC-34b** |
| Fire (a0) on any `approved_by` change | **AC-5c**, AC-10a2, AC-10b2 |
| NULL check moved after check 3 | **AC-13**, **AC-33** |
| Drop the role check | **AC-35a to AC-35e**, AC-37a |
| Role check via `auth_is_privileged()` | **AC-35a to AC-35e**, AC-37a |
| Role set without `master` | **AC-35f** |
| Role set without `super_admin` | **AC-35g** |
| `external_ref` and its expiry out of the list | **AC-32a**, AC-32b |
| Stamp trigger doesn't set `approved_by_id` | **AC-1, AC-2a, AC-2b**, and 26 more arms through the id tag |
| Re-stamp doesn't set `approved_by_id` | **AC-8**, **AC-8b**, AC-10a, **AC-9**, **AC-15b**, AC-36 |
| `approved_by_id` missing from (a1)'s refusal | **AC-4a to AC-4e**, AC-4f |
| FK on `approved_by_id` with `on delete set null` | **AC-5a to AC-5c**, **AC-7g** |
| Stamp trigger stores the raw `p.name` | **AC-2d**, AC-35f |
| Re-stamp stores the raw `p.name` | **AC-8b** |

**Runs (2026-11-09, shared stack after A6):**

| Check | Result |
|---|---|
| New pgTAP file | 68/68 |
| `npm run test:db` | 99/99 files |
| `npx jest` | 299 suites, 3,826 tests, all passed |
| `npm run typecheck:test` | exit 0 |
| `npx tsc --noEmit --types node,jest` | exit 0, 0 errors |
| `npm run typecheck` | exit 2, the same 24 `@types/* 2` errors and no others. Left in place |
| `scripts/smoke-delete-user.sh` | ALL ARMS PASSED, including both AC-24 checks and the wider AC-29 scan. Cleanup ran. Mount check pointed at the repo root, and the edge runtime is `per_worker` (hot reload), so it served the edited file |
| `deno check delete-user/index.ts` | `docker run --rm -v <repo>/supabase/functions:/fns:ro -w /fns denoland/deno:2.1.4 deno check delete-user/index.ts` exits 0 with no type errors. 2.1.4 is the edge runtime's own Deno. It needed network access (126 `jsr:`, `esm.sh` and npm downloads). There is no `deno.json` or lockfile under `supabase/functions`, so the read-only mount was fine |

The "`deno check` was also not run" line in the first build's notes is superseded by this run.

**A7, fresh build without touching the shared stack.** Scratch worktree at `c630c7f` (`git worktree add --detach`) under the session scratch directory, outside the repo and `.claude/worktrees/`. Copied in spec 187's "Stage whole" files only. Worktree-only `config.toml` edits: `project_id = "imr-fresh187"` and every A7 port. Two more settings pointed at the shared stack and were repointed too: the `[auth.hook.send_email]` URI (shared API port 54321, now 54421) and the `MAILPIT_SEND_URL` secret (shared inbucket container name). All ports were free first. Docker has 7.75 GB, and the shared stack used about 3 GB.

- `npx supabase@2.106.0 start -x studio,inbucket,vector,analytics`. 2.106.0 still started analytics and inbucket, on the shifted ports (54427, 54424). Every new container ended `_imr-fresh187`. All migrations through `20261108130000`, then the seed, applied.
- **Spec 187 alone:** `CONTAINER=supabase_db_imr-fresh187 bash <worktree>/scripts/test-db.sh` gave 96/96 files. The 96 are the 99 local files minus spec 186's and 189's new ones.
- **Step 5, specs 186 and 187 together:** copied in `20261108120000_retention_prune_job.sql` and `retention_prune_job.test.sql`, ran `npx supabase@2.106.0 db reset` from the worktree (scratch project only), and got 97/97.
- **Teardown:** `npx supabase@2.106.0 stop --no-backup` from the worktree, which left 0 `fresh187` containers, volumes or networks. Then `git worktree remove --force`, which removed the directory and its `git worktree list` entry.
- **Shared stack:** `docker inspect` of the 12 `_imr-inventory` containers (id, `StartedAt`, `RestartCount`) was identical at session start, before boot, after boot, after the reset and after teardown. All 12 were started 2026-10-19 or 2026-10-23, with 0 restarts. Its 3 volumes and 1 network are unchanged.

**Spec numbers (for A1, Dependencies and Follow-ups).** Since the amendment was written, the `user_stores` own-row-writes spec was filed as **spec 195** (`specs/195-user-stores-own-row-writes.md`). Spec 190 is `po-number-sequence`. Spec 191 is the demote spec, as written. Where this spec says "spec 190" for `user_stores`, read spec 195. The test file and migration name only spec 191 (AC-37), which is correct. (Superseded 2026-11-09 by architect SF-R1: spec 191 doesn't close AC-37's gaps. The test file now names the convergence follow-up, and AC-37a is a refusal. See "Re-proposal build".)

**Not run:** `smoke-edge-roles.sh`, as before. Its Arm 4 promotes `admin@local.test`, and other sessions use the stack. Also not done: A8's read-only check of prod's email-confirmation setting, which belongs to the prod apply.

### Re-proposal build (2026-11-09)

Built from the "Re-proposal 2026-11-09" section of `specs/187-order-approval-approver-snapshot/reviews/release-proposal.md` (items 1 to 7) and the owner's decisions recorded under "Open questions resolved". The proposal routed item 1 through a short architect amendment (A10) first. The owner asked for the fix directly, so there is no A10 section. The design source is proposal item 1 plus the owner's wording, and the backend-architect's post-impl review should check the build against those. Same limits as before: nothing committed, staged or pushed, nothing on prod, `delete-user` not deployed or changed, no `supabase db reset` or `stop` on the shared stack. The migration was edited in place.

**What changed:**

- **Migration, `tg_order_approvals_stamp_approver()`.** It declares `v_uid uuid := auth.uid()`. When `v_uid` isn't NULL, two refusals run before the snapshot reads, in this order:
  1. `new.status is distinct from 'pending'`: P0001 `order approval must be inserted as pending`. The proposal left the message open, so this one was chosen to match the existing `order approval …` messages.
  2. `not exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('admin', 'master', 'super_admin'))`: P0001 `order approval caller is not an admin`. This is the same inline read and message as the guard's block (a0). It isn't `auth_is_privileged()`.

  `channel`, the timestamps, `line_count` and `est_total_cost` are untouched (L4 follow-up). The guard body and `create_order_approval` are unchanged. Comments changed: the comment block above the function, its `comment on function`, header item (1), and the guard's `comment on function` (architect Nit 2, "the line snapshot" now starts with a capital).
- **Trigger order on INSERT is unchanged.** `order_approvals_lines_check_store_trg` fires before `order_approvals_stamp_approver_trg`, so the `cross_store_item_rejection` T arms still fail on lines first. RLS `WITH CHECK` runs after both, so AC-2c (naming someone else as approver, 42501, no email in the error) is unchanged.
- **pgTAP, `order_approvals_approver_snapshot.test.sql`, 68 → 76 arms.**
  - New helpers: `_t187_ins` (direct INSERT at a status, as the current role) and `_t187_count` (rows in a day range, read as postgres).
  - New fixtures, inserted as postgres: day 99 is now an `a1` pending row for AC-35b. Days 110, 111 and 112 are A's pending rows for AC-35h and AC-35i, AC-35j, and AC-8c.
  - **AC-37a** flipped to a refusal: `a1`'s RPC on fresh day 109 gives `P0001: order approval caller is not an admin`, and no row exists.
  - **AC-35b** now approves the day-99 fixture. The expected row is `a1|a1|…|backdated|pending|0`.
  - **S1:** AC-35h (`a1` PATCH re-stamp), AC-35i (`a1` lines on A's row, row unchanged), and AC-35j (`a4` RPC re-stamp). AC-35j returns `P0002: vendor … not found`, not the guard's message, because a NULL-brand profile can't read the brand's vendor. That matches what the auditor saw for `D`. The arm pins that refusal and the unchanged row, and AC-35's text says so. The PATCH route (AC-35c) is the one that reaches the guard's role check for that shape.
  - **N1:** AC-8c. `b0` (master, padded name) re-stamps A's pending row through the RPC, and the name is stored trimmed. AC-35f still pins the INSERT half.
  - **N3, now refusals:** AC-38a (`a1`) and AC-38b (`a4`), direct INSERT at `pending`, `approved` and `ordered`. AC-38c, A at `approved` and `ordered`. AC-38d, postgres and then `service_role`, both with no claims, insert `approved` and `ordered` rows naming A, and the stamp fills A's snapshot.
  - AC-37b's description names the convergence follow-up instead of spec 191 (SF-R1). The header map is updated.
- **Spec text.** Open questions resolved. AC-2d, AC-35, AC-37 and the new AC-38. D1. The Change and Out of scope notes on direct INSERTs. Known limits (L-R1, and the spec 186 line for Nit 8). Dependencies, A1's open list and Follow-ups (SF-R1, L-R2, L4 widened, L-R1, Nit 1). Prod apply step 0 (SF-R3), step 4's recapture, step 5's `col_description` comparison (Nit 4) and the new messages, step 7's spec 186 clause. The Rollback table's CLAUDE.md row (Nit 5).
- **Not changed:** `supabase/functions/delete-user/index.ts`, so `deno check` wasn't re-run. `src/lib/db.ts`, whose comment still holds. `scripts/smoke-delete-user.sh`, which inserts its approvals as postgres with no claims. Every other test file.

**Every pgTAP file, run first with the delta injected.** Before the shared stack was touched, every file under `supabase/tests/` was run with the new stamp function injected after its own first `begin;`, so it existed only inside that file's rolled-back transaction. The test file was still at its 68-arm version. Result: 102 of 103 files green. The one red file was spec 187's own, on exactly the two expected arms, AC-35b and AC-37a (`have: NULL`). No other file's fixtures trip the check, including the ones that insert `ordered` rows as postgres: `retention_prune_job`, `order_approvals_fk_set_null`, `report_last_order_context` and `admin_submit_eod`.

**Shared-stack delta.** One `psql` transaction with `lock_timeout = '5s'`: `create or replace` of `tg_order_approvals_stamp_approver`, its `comment on function`, and the guard's `comment on function`. Nothing else. `create or replace` kept the ACL. Afterwards the live raw `prosrc` md5 of all three functions equals the md5 of the matching body in the file, read straight from the file: stamp `45f14d61d6a8e7b83c15887ae58e0f06`, guard `c89df6a4534d07f2e4cf11b7157e25e7`, RPC `a544d68df89bd258216dfd11b1af8de1`. The guard and the RPC are unchanged from the earlier table. Re-checked after the mutation runs: same values, 0 `order_approvals` rows, 0 leftover `_t187_*` functions.

**Prod-check references (step 4), recaptured 2026-11-09 after this delta.** Same normalized-md5 expression as before. Recapture again on the day of the apply (SF-R3).

| Function | Normalized md5 | Raw `prosrc` md5 | `prosecdef` | `proconfig` | Owner | `proacl` |
|---|---|---|---|---|---|---|
| `tg_order_approvals_guard` | `733e4f3e79339b74bb48b134f37fc933` | `c89df6a4534d07f2e4cf11b7157e25e7` | t | `search_path=public` | postgres | `postgres=X/postgres,service_role=X/postgres` |
| `tg_order_approvals_stamp_approver` | `cdc1877726c2bfc0a9f113abeb92241a` | `45f14d61d6a8e7b83c15887ae58e0f06` | t | `search_path=public` | postgres | `postgres=X/postgres,service_role=X/postgres` |
| `create_order_approval` | `3dd805dc599294de818a46d32883861f` | `a544d68df89bd258216dfd11b1af8de1` | f | `search_path=public` | postgres | `postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres` |

**A5 additions: proof the new checks can fail.** Each mutation re-created the function inside the test file's own transaction, so the file's `rollback` removed it. Control run with the unmutated stamp function: 76/76.

| Temporary change | Arms that went red |
|---|---|
| Stamp trigger: drop the status check | AC-38a, AC-38b, AC-38c |
| Stamp trigger: drop the role check | AC-37a, AC-38a, AC-38b |
| Stamp trigger: role check through `auth_is_privileged()` (the JWT claim) | AC-37a, AC-38a, AC-38b |
| Stamp trigger: status check without the `v_uid is not null` gate | The file aborts at its own fixture INSERT (`ERROR: order approval must be inserted as pending`, psql exit 3), because owner-level fixtures insert approved and ordered rows. That is the case AC-38d pins |
| Guard (a0): drop the role check (re-run with the new arms) | AC-35a, AC-35b, AC-35c, AC-35d, AC-35e, AC-35h, AC-35i |
| Guard re-stamp branch: keep the blank fallback but store the untrimmed name | AC-8c only (N1) |
| Stamp trigger: the same untrimmed-name change | AC-35f only |

In the earlier A5 table, the rows "Drop the role check" and "Role check via `auth_is_privileged()`" listed AC-37a as red. That was the guard's check. AC-37a is now refused by the stamp trigger instead, so the guard mutation no longer reaches it, as the re-run above shows. AC-35j isn't red under the guard mutation, because its refusal comes from the vendor read.

**Runs (2026-11-09, shared stack after the delta):**

| Check | Result |
|---|---|
| `bash scripts/test-db.sh supabase/tests/order_approvals_approver_snapshot.test.sql` | PASS, 76 assertions |
| The other spec 187 files, each alone | `audit_log_rls_hardening` 61, `profiles_rls_sweep` 12, `auth_can_see_store_brand_scope` 14, all PASS |
| Neighbouring `order_approvals` files, each alone | `order_approvals` 24, `order_approvals_fk_set_null` 15, `cross_store_item_rejection` 54, `report_last_order_context` 42, `retention_prune_job` 70, `admin_submit_eod` 101, all PASS |
| `npm run test:db` | `✓ 103/103 DB test file(s) passed`. That includes `legacy_permissive_policy_dropout.test.sql`, which spec 195 has since updated |
| `npx jest` | 301 suites, 3,836 tests, 17 snapshots, all passed |
| `npm run typecheck:test` | exit 0 |
| `npx tsc --noEmit --types node,jest` | exit 0, 0 errors |
| `bash scripts/smoke-delete-user.sh` | exit 0, `ALL ARMS PASSED`, 0 FAIL lines. Both AC-24 checks passed (`approved_by_id = target`, and 3 approvals × 2 audit rows matching `detail.target_id`). TALLY 6 rows, and cleanup ran. The edge-runtime mount points at the repo root |
| `deno check` | Not run. `delete-user` didn't change |
| `npm run typecheck` | Not run. Known red locally from the 24 empty `node_modules/@types/* 2` folders |

**Review notes carried into this build:**

- **S2.** The test-engineer didn't reproduce the A5 mutation results in either A5 table. They are the developer's alone.
- **Nit 6.** A7's fresh build ran on `c630c7f` plus a pre-commit copy of spec 186's migration. It wasn't repeated for this delta, because the change is a function body inside an existing `create or replace`. The first `test.yml` run on `main` after the push covers it.
- **Nit 7.** The spec 187 hunk in `src/lib/db.ts` is the `createOrderApproval` doc comment. On 2026-11-09 it sits at working-copy L2639-2646, in hunk `@@ -2637,12 +2637,13 @@` against the index, because other sessions' staged hunks moved it again. Stage it by hunk, or leave it out (release proposal item 9).
- **Draft PR:** dropped by the owner. A7 covered the fresh build.

**Not run:** `smoke-edge-roles.sh`, as before, because its Arm 4 promotes `admin@local.test`. Still owed once, at a quiet time, before the deploy.

## Follow-ups

- `removeUser` in `useStore` has no callers and carries a dead audit call. Remove it, or say why it stays. Its `User deleted` insert would now also be refused with 42501 by the restrictive INSERT policy if anyone gave it a caller, which is a stronger reason to remove it. (Reason added 2026-11-09.)
- `inferKind` and `ACTION_TONE` in `src/screens/cmd/sections/AuditLogSection.tsx` have no entry for `User deleted`. Cosmetic: the rows sit under "other" with the muted tone.
- **CLAUDE.md bullet (architect SF-6).** The owner accepted it on 2026-11-09, and main Claude adds it at landing: "Profile rows are deleted only through the `delete-user` edge function. `public.profiles` has no DELETE policy, so a PostgREST delete removes 0 rows with no error. The one other service-role delete is `manage-store-user`'s compensation of an account it just created." This spec doesn't edit CLAUDE.md.
- **Spec 195:** `user_stores` own-row writes (164-H1), the cross-brand root cause of 187-H2. Being specced 2026-11-09.
- **Spec 191:** `demote_profile_to_user` brand scope and last-of-role guard (164-H2, paired with 164-M2). Being specced 2026-11-09. (Corrected 2026-11-09, architect SF-R1: spec 191 leaves `auth_is_privileged()` and `auth_is_admin()` alone and says not to switch spec 187's inline check to its helper, so it flips no AC-37 arm.)
- **The `auth_is_admin()` / `auth_is_privileged()` convergence spec** (added 2026-11-09, architect SF-R1). Named in spec 191 as "a separate, later spec", not yet filed. It would read the role from `profiles` instead of the JWT. It ends the accepted stale-claim exposure in amendment A1's open list, and it flips AC-37b. The owner may file it now to give that acceptance a fixed end.
- Look-alike audit actions such as `'User deleted '` (audit L2). Replace the exact-match block list with an allowlist of the actions clients may write.
- Audit privileged renames and email changes (from 187-M1).
- `delete-user` trusts `app_metadata.role`, and nothing clears it after a partial failure (audit L7). It also returns raw `error.message` to admin callers, which is older than this spec.
- Limit what a direct INSERT or a re-stamping PATCH can set (audit L4; "or a re-stamping PATCH" added 2026-11-09, re-audit). `status` is closed for API-caller INSERTs since the re-proposal (M-R1). Still open: `channel` (the INSERT side of (c2)'s escalation guard), `approved_at`, `created_at`, `updated_at`, `ordered_at`, `line_count` and `est_total_cost`. A takeover PATCH also skips the RPC's line validation and cost recompute. Suggested fix: `channel := vendor_order_channel(new.vendor_id)` and server-set timestamps in the stamp trigger.
- `ordered_at` can be rewritten on approved and ordered rows (re-audit L-R2, owner decision 2026-11-09: follow-up). It dates from spec 149, and the app never writes it. Suggested fix: in the guard's block (e), set `ordered_at := now()` on the transition with no `coalesce`, and refuse any other change.
- A Unicode-aware blank-name check (re-audit L-R1, owner decision 2026-11-09: accepted, see Known limits). Test blankness after stripping whitespace and format characters such as U+00A0 and U+200B, still store `btrim(name)`, and keep the stamp trigger's and the guard's copies identical.
- A thrown `undefined` in `delete-user`'s auth delete loses the JSON 500 shape (architect Nit 1). Still never a 200. Suggested fix: `(e as Error)?.message ?? "internal error"` in the outer catch. Left alone here because any `delete-user` edit means re-running `deno check` and the smoke.
- An `external_ref` URL can still be planted on an approved Instacart row by a privileged same-brand caller (amendment A1). This is older than this spec. Pin the host in the guard, or have the client refuse hosts other than Instacart's.
- A friendlier toast for `order approval belongs to another approver` (amendment A1, user-visible behaviour).

## Files changed

"(amended)" marks a file the 2026-11-09 amendment build changed again. "(re-proposal)" marks a file the 2026-11-09 re-proposal build changed.

**Migrations**
- `supabase/migrations/20261108130000_order_approval_approver_snapshot.sql` (new; amended in place: `approved_by_id`, the A2 snapshot block in both trigger functions, guard block (a0), comments, `drop policy if exists`; re-proposal, still in place: the stamp trigger's status and `profiles.role` checks for API callers, its comments, header item (1), the guard's `comment on function` capital)

**Edge functions**
- `supabase/functions/delete-user/index.ts` (amended: the `authDeleteThrew` flag, the `DeleteAuditIds` / `DeleteAuditSnapshot` / `readDeleteAuditSnapshot` renames, the `Promise.race` and `approvalCount` comments)

**pgTAP**
- `supabase/tests/order_approvals_approver_snapshot.test.sql` (new; amended: 49 → 68 arms; re-proposal: 68 → 76 arms, AC-37a flipped to a refusal, AC-35b fixture, AC-35h to AC-35j, AC-8c, AC-38a to AC-38d)
- `supabase/tests/audit_log_rls_hardening.test.sql`
- `supabase/tests/profiles_rls_sweep.test.sql`
- `supabase/tests/auth_can_see_store_brand_scope.test.sql`

**Smoke**
- `scripts/smoke-delete-user.sh` (new; amended: the AC-24 id checks, the AC-29 scan list, two comments)
- `package.json` (`test:smoke`)

**`src/`, comments and the jest parity list only**
- `src/lib/db.ts` (one comment, reflowed in the amendment. This file also has other sessions' uncommitted hunks, so stage only the `create_order_approval` comment hunk)
- `src/lib/placeholderEmail.ts`
- `src/lib/placeholderEmail.parity.test.ts`

**Specs**
- `specs/187-order-approval-approver-snapshot.md` (amended: status, the amendment build notes, this list; re-proposal: the owner's decisions, AC-35/37/38, SF-R1 and SF-R3 text, Known limits, Follow-ups, Rollback, the re-proposal build notes)
- `specs/178-order-approvals-fk-set-null.md` (pointer to this spec)
- `specs/043-profiles-rls-sweep.md` (supersede note)

**Local database only (not a file):** the A6 delta was applied to the shared `supabase_db_imr-inventory` with psql. See "Amendment build". The re-proposal delta (the stamp function and two function comments) was applied the same way. See "Re-proposal build".

Unchanged by the re-proposal: `supabase/functions/delete-user/index.ts`, `scripts/smoke-delete-user.sh`, `package.json`, `src/lib/db.ts`, `src/lib/placeholderEmail.ts`, `src/lib/placeholderEmail.parity.test.ts`, and the three other pgTAP files.
