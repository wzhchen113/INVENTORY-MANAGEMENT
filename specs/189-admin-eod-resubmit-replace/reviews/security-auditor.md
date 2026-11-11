## Security audit for spec 189

Scope: `supabase/migrations/20261109120000_admin_eod_replace.sql`, the new `supabase/tests/admin_submit_eod.test.sql`, the spec 189 hunks in `report_last_order_context.test.sql`, `eod_update_notifications.test.sql` and `eod_submissions_edit_flow.test.sql` (the last is comments only, confirmed by diff), and the `submitEODCount` block in `src/lib/db.ts`. Other sessions' hunks in the same files (for example the spec 187 comment in `db.ts` around L2616) were not reviewed.

Method: I read the code and checked the catalog on the local `supabase_db_imr-inventory`. I ran all four pgTAP files: 96/96, 42/42, 33/33 and 4/4 passed. I also ran my own probes (P1 to P12 below) in a single `begin … rollback` transaction, with `savepoint` around each refusal. Nothing persisted and I had no prod access.

### Summary

No Critical and no High findings. The new privileged path doesn't let any caller delete or write what they couldn't already write through `admin_update_eod_*`, and it now records an audit row for each row it deletes. All the trust boundaries the brief listed hold. There are two Lows on the new path, one of them informational, plus some carried-over gaps in the staff wrapper. The Medium is the M3 residual from spec 186, which spec 189 narrows but doesn't close, as design §10 says.

### Checked, no finding

| Check | Result | Evidence |
|---|---|---|
| `admin_submit_eod` definer + pinned `search_path` | `prosecdef = t`, `proconfig = {search_path=public}`, owner `postgres` | Catalog |
| `eod_write_submission` invoker + pinned `search_path` | `prosecdef = f`, `proconfig = {search_path=public}` | Catalog |
| Spec 097 default privileges actually revoked | `has_function_privilege`: `eod_write_submission` is **f** for anon, authenticated and service_role. `admin_submit_eod` is f for anon and service_role, t for authenticated. `staff_submit_eod` is unchanged (f, t, f). The ACLs are `{postgres=X}` for the writer and `{postgres=X, authenticated=X}` for both wrappers. No overloads exist | Catalog, migration L294-295, L509-512 |
| Direct call of the writer | A store member and a brand admin both get `permission denied for function eod_write_submission` (P6, P6b) | Probe |
| `search_path = public` without an explicit `pg_temp` | Every relation in all three bodies is schema-qualified, and the triggers fired (`eod_entries_check_store`, `eod_submissions_set_submitted_by`, `tg_notify_*`, `enqueue_submission_push`, `emit_eod_update`, `eod_vendor_has_below_par`) all pin their own `search_path`. PostgREST callers can't create temp objects. Not exploitable | Catalog `proconfig`, body read |
| No DELETE or ALL policy on `eod_entries` or `eod_submissions` (spec 186 AC-8) | `pg_policies` shows only SELECT, INSERT and UPDATE on both tables | Catalog |
| Removal list can't reach another store or submission | Both deletes are scoped by `submission_id = v_submission_id`, which comes from the upsert on the gated `p_store_id`. P3: an S1 call naming S2's item left the S2 entry in place (1 row) | Migration L175-178, L197-202, P3 |
| `Count cleared` audit row | Written in the same statement as the delete (data-modifying CTE), with `user_id = auth.uid()` and the removed value (P4: `20 lbs`). A removal that hits no row writes nothing, which is correct. `eod_entries_item_id_fkey` is NO ACTION, so the item join can't come back empty | Migration L175-193, P4 |
| Refusals before any side-effect (admin) | Gate, vendor/status, vendor-brand, rule A and overlap all run before `eod_write_submission` (L427-474). Rule B raises after the writer, and because the call is one transaction the parent upsert, `submitted_at`, notifications and queued push all roll back (pgTAP arms 70-76) | Body, pgTAP |
| Rule A bypass with JSON `null`, `{}`, a scalar or SQL NULL | All four refused with 22023 (P1). `coalesce` only applies to SQL NULL, and `jsonb_typeof` catches JSON null, objects and scalars | P1 |
| Arrays of non-objects (`[null]`, `[1]`, `[{}]`) | Admin: `jsonb_to_recordset` errors in the overlap check (L467) before any write. `[{}]` reaches the writer and raises 42501 from `eod_entries_check_store_trg` (NULL item), and everything rolls back | P1 |
| O-1 (staff) | NULL, JSON null, `{}` and `"x"` raise 22023 at L370-375, after the idempotency block and before the writer. `[null]`, `[1]` and `[{}]` get past O-1 but fail inside the writer (an error, or 42501) and roll back, so no state persists | P5, body |
| Replay still short-circuits before O-1 | Step (4) at L353-364 returns `conflict: true` before the O-1 check at L370. Covered by pgTAP arms 80-81 and `eod_update_notifications` S3 | Body, pgTAP |
| `staff_submit_eod` gates unchanged | Steps 1, 1.5, 3 and 4 match `20261024000000` L125-176 word for word. `create or replace` keeps the ACL | Diffed by reading |
| `submitted_by` forced | `eod_submissions_set_submitted_by_trg` (BEFORE INSERT OR UPDATE) sets `new.submitted_by := auth.uid()`. `auth.uid()` reads the request claims inside definer code. P12: a staff `p_submitted_by` naming the admin was recorded as the staff user. The admin RPC has no such parameter | Catalog, P12 |
| `last_updated_by` | Comes from `auth.uid()` in the wrapper (L488), never from the client. `db.ts` no longer sends `submitted_by` or `last_updated_by` | Body, `db.ts` diff |
| Cross-store item under the definer | `eod_entries_check_store_trg` still raises 42501 (P11), and the on-hand update sits after the insert, so it never runs for a foreign item. A NULL item and a mismatched item produce the same error text, so the error doesn't reveal whether an item exists | P11, body |
| Escalation into the admin gate | `auth_is_admin()` reads only `app_metadata.role`. A `user_metadata.role = admin` claim is ignored (P10). A self role edit on `profiles` is blocked by `assert_brand_id_immutable_for_self` ('role is read-only for self-edits'), checked in a rolled-back probe, so `profiles_sync_role_to_jwt` can't be used to mint an admin claim | P10, probe |
| `db.ts` `submitEODCount` | Sends only parameters the server validates or scopes. `console.warn` logs the PostgREST error object, which holds no token or PII. No secrets | Diff read |
| Realtime | No publication change. `eod_entries` isn't published | Migration header, body |
| Destructive migration? | No. Additive unique index plus function swaps. The pre-flight aborts the transaction instead of deduping. The index takes a brief SHARE lock on `eod_entries` (`lock_timeout 5s`). Prod rollback is documented in §13 | Migration L80-103 |

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

- **M1. `supabase/migrations/20261109120000_admin_eod_replace.sql:167-169, 380-390`: the spec 186 M3 erase is narrowed, not closed. `staff_submit_eod` can still erase every entry but one on any submission in the member's store, at any age, and no audit row records the erased rows.**
  - P7: a role-`user` store member called it with one valid entry on a backdated submission holding two. One entry remained, and there were 0 audit rows naming the erased item. The whole-set delete (L169) has no `Count cleared` CTE. That CTE exists only on the admin branch (L175-193).
  - O-1 closes the empty-payload form only. Design §10 says so ("a direct API caller can send one entry and erase the rest"), so this is a known limit, not a regression, and the refactor doesn't widen it.
  - *Impact:* EOD records are the oldest and largest kept set (spec 186). A hostile or compromised staff account, or a buggy sibling client hitting the same backend, can hollow out historical counts, and the audit log won't show the loss. The design's only trace for a deleted row is the `Count cleared` row, and the staff branch doesn't write one.
  - *Fix (follow-up, owner decision):*
    1. Cheapest: in the `p_removed_item_ids is null` branch, give the delete the same `returning … insert into audit_log` CTE, limited to items not present in `p_entries`. That makes every erase traceable without changing staff behaviour.
    2. Separately: the deferred O-2 date bound for non-privileged callers.

### Low

- **L1. `supabase/migrations/20261109120000_admin_eod_replace.sql:455-464, 491-499`: rule A can be met by a removal list that removes nothing, so an "empty" call still resets `submitted_at`, changes `status` and fires a notification.**
  - `p_entries = '[]'` with `p_removed_item_ids = '{NULL}'`, or with a uuid that has no row, passes rule A because `cardinality = 1`. It also passes rule B because the existing entries stay.
  - P2: a submitted parent flipped to `draft` and `submitted_at` moved to `now()`, with no entry change and no audit row.
  - P2b: with `status = 'submitted'`, one extra `eod_update` notification row (and its queued push) was written.
  - *Impact:* no new power. The same principals (`auth_is_privileged() and auth_can_see_store()`) can already PATCH `status` and `submitted_at` through `admin_update_eod_submissions`. But AC-33 and §3.4's "Nothing changes, including `submitted_at`" are stronger than what the code guarantees, and a scripted caller can trigger push notifications at will.
  - *Fix:*
    1. Reject NULL elements, for example `if array_position(v_removed, null) is not null then raise … 22023`.
    2. Then either accept this as documented, or count rule A's removals as rows actually present in the submission before calling the writer.
    3. Add a pgTAP arm for `'{NULL}'`.

- **L2. `supabase/migrations/20261109120000_admin_eod_replace.sql:301-391` (staff wrapper): the staff path still lacks the parameter checks the admin wrapper gained. Both gaps predate this spec and the refactor carried them over unchanged.**
  - **`p_status` isn't validated.** `eod_submissions` has no CHECK on `status`. P8: a store member wrote `status = 'bogus'` over a submitted parent. The member can likewise flip a submitted count to `draft`, and readers that filter on `status = 'submitted'` would then stop seeing it. Compare admin L437-440.
  - **No vendor-brand check.** Compare admin L444-453. This was spec 180 review Low 3.
  - *Fix (follow-up):*
    1. Copy the two admin checks into the staff wrapper after step (1.5).
    2. Consider `check (status in ('draft','submitted'))` on `eod_submissions`, after a prod read-only check for other values.

- **L3 (informational, no action for this spec). `supabase/migrations/20261109120000_admin_eod_replace.sql:427`: the admin/master half of the gate reads the JWT, so a demoted admin keeps admin access until the access token expires.**
  - P9: a role-`user` profile carrying a stale `app_metadata.role = admin` claim passed the gate on store S2, where it has no `user_stores` row, through `auth_can_see_store`'s brand branch. It was stopped only by rule B.
  - The window is bounded by `jwt_expiry` (3600 s in `supabase/config.toml:171`; prod should be confirmed). This is the same class as every existing `auth_is_admin()` surface, including `admin_update_eod_*`, which this gate deliberately mirrors.
  - I found no escalation route (see the table). `super_admin` is read live from `profiles`.
  - *Fix:* none here. If faster revocation is wanted, the demote and delete paths should revoke sessions; that belongs in a follow-up spec.

### Dependencies

No dependency changes from spec 189, so `npm audit` was skipped. The working-tree `package.json` diff belongs to another session: it only adds `smoke-delete-user.sh` to `test:smoke`, with no dependency changes.

## Re-check (L1 fix)

**Verdict: L1 is resolved.** Nothing new is Critical, High, Medium or Low. M1, L2 and L3 are unchanged.

Scope: the in-place edit to `admin_submit_eod` rule A (`supabase/migrations/20261109120000_admin_eod_replace.sql:456-496`) and arms (96)-(101) in `supabase/tests/admin_submit_eod.test.sql`.

Method:
- The live `prosrc` on `supabase_db_imr-inventory` matches the file body line for line, ignoring blank lines.
- The pgTAP file passes 101/101.
- I ran my own probes in a single `begin … rollback`, reusing the file's fixtures. Parent P was `submitted` with a literal `submitted_at` and held items 101 and 103. Submission Q held item 102.
- After each call I compared `state_of(P)` (entries with ids, status, `submitted_at`, `submitted_by`, S1 on-hand, P's notifications, S1 audit count), Q's entries, the total `notifications` count, and the `pg_stat_xact_user_tables` insert, update and delete counters for `eod_submissions`, `eod_entries` and `notifications`.
- The cross-session lock check used two short sessions, each `begin … rollback`, on one seed row.

**1. The probes are refused, and nothing changes.**

Every refused call left the whole snapshot equal to the baseline.

| Call (`p_entries = '[]'` unless noted) | Result |
|---|---|
| `'{NULL}'`, with `p_status` `draft` and again with `submitted` (the notification path) | 22023 `p_removed_item_ids must not contain NULL` |
| `{NULL, 101}`, and `{NULL}` with a non-empty `p_entries` | 22023, same message. The NULL check doesn't depend on `p_entries` being empty |
| Absent id, with `draft` and with `submitted` | 22023 `nothing to write (no entries, and no removal names a row in this submission)` |
| An item whose row is in Q; an S2 item | 22023, same message |
| No parent at that `(store, date, vendor)` | 22023, same message |
| `p_entries` NULL with an absent id | 22023, same message |
| `'{}'` or NULL removal list | 22023 `nothing to write (no entries and no removals)` |
| Multi-dimensional `'{{NULL}}'` or `'{{101}}'` | 0A000 from `array_position`. Still a refusal before any write |
| Control: remove 103 | Succeeded with `entry_count` 1. The counters moved (`eod_submissions` +1 update, `eod_entries` +1 delete), so the snapshot would have caught a write |

**2. Every refusal runs before any write.**
- By reading the body: the NULL check (L469-472) and the parent lookup (L479-495) sit after the gate, parameter and vendor-brand checks, and before the overlap check and `eod_write_submission` (L511).
- By counters: `pg_stat_xact_*` keeps counting work from aborted subtransactions, and it showed zero updates, inserts or deletes for every refused call. So nothing was written and then rolled back. No write was attempted at all.
- The row lock from `for update` is not a data write, and it is released when the call's subtransaction aborts.
- A non-privileged caller is stopped by the gate (L430) before reaching the lock.

**3. Lock safety.**
- **No deadlock with the writer's upsert or with `staff_submit_eod`.**
  - The `for update` (L486) is the first row lock this call takes. Steps 1-3 are plain reads.
  - The writer's upsert and `staff_submit_eod` also take P as their first row lock: `staff_submit_eod` only reads before the writer, including the idempotency `select` at L353-356.
  - So all three take their locks in the same order and serialize. They can't form a cycle.
  - The call's own upsert then re-locks a row it already holds, which works (control probe).
- **The lock is stronger than the upsert's, but a store member can't use that to block admins.**
  - Because `eod_submissions_client_uuid_idx` is partial, the upsert takes FOR NO KEY UPDATE. I confirmed this: while the upsert was held, another session could take FOR KEY SHARE with `nowait` but not FOR NO KEY UPDATE. While FOR UPDATE was held, both were refused.
  - So the new lock also conflicts with foreign-key checks from inserts that reference P. A store member can cause those through `store_member_insert_eod_entries`.
  - That lock lasts from the end of one PostgREST statement to its commit, which is microseconds, and is capped by `statement_timeout = 8s`.
  - A member could already hold P for longer through `staff_submit_eod`, which the old upsert also waited on.
  - The admin's wait is capped by the authenticator role's `lock_timeout = 8s`. The call then fails cleanly and can be retried.
  - The lock is only taken on the removal-only path, and that path never inserts into `eod_entries` or `order_approvals`. Its delete touches only committed rows, so it never waits on a member's uncommitted insert. No cycle can form with member inserts.
- **Residuals (not findings, privileged callers only, timing-dependent).**
  - A concurrent admin PATCH that moves one entry into P and also locks a target row in P, in one statement, could deadlock with this call. Postgres resolves that within `deadlock_timeout = 1s` by aborting one side.
  - A concurrent admin PATCH of the target row's `item_id` or `submission_id` between the check and the delete leaves the delete with nothing to remove. That is the L1 residual again, reachable only by the same principals who can already PATCH `submitted_at` through `admin_update_eod_submissions`.

**4. Catalog unchanged.**

| Check | Result |
|---|---|
| `proacl` | `{postgres=X/postgres,authenticated=X/postgres}` |
| `has_function_privilege` for anon / authenticated / service_role | f / t / f |
| `prosecdef` | t |
| `proconfig` | `{search_path=public}` |
| Owner | `postgres` |
| Overloads | One |

The revoke and grant at L541-544 are as before.

Dependencies: no `package.json` change for this edit, so `npm audit` was skipped.
