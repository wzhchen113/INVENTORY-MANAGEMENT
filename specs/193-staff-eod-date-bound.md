# Spec 193: Bound `p_date` on `staff_submit_eod` and audit staff-side erases

Status: READY_FOR_REVIEW

Numbering: drafted as 190 on 2026-11-09 and renumbered to 193 the same day, because three other sessions also took 190 (`190-po-number-sequence`, `190-kept-records-delete-hardening`, `190-user-stores-own-row-writes`). Content unchanged.

Origin: two findings.
- **The date bound.** Finding **M3** in [specs/186-retention-purge-server-job/reviews/security-auditor.md](186-retention-purge-server-job/reviews/security-auditor.md) (L51), and spec 189's §10 **O-2** ([specs/189-admin-eod-resubmit-replace.md](189-admin-eod-resubmit-replace.md) L583-589), which deferred the date bound to its own spec. The constraints below are carried from O-2 and were re-checked against the working tree on 2026-11-09.
- **The erase audit (added 2026-11-09, after the design below was written).** Finding **M1** in [specs/189-admin-eod-resubmit-replace/reviews/security-auditor.md](189-admin-eod-resubmit-replace/reviews/security-auditor.md) (L47-53), the auditor's fix 1: write a `Count cleared` audit row for every item a staff full-replace removes.

Line numbers are pointers, not contracts.

**Owner decisions:** the owner answered Q1 to Q6 on 2026-11-09, through a question dialog in the main session. The main session relayed Q7 (the erase audit) from the same dialog later that day, after the backend design below had been written. All seven are recorded under "Owner decisions" and "Open questions resolved" below. **Nothing in this spec should be built until spec 189 has landed.**

**Urgency:** latent hardening, not an incident. Abusing the date hole takes a direct API call (or a client bug), because the staff UI offers only today or yesterday. The erase audit fixes a trace gap, not a live exploit: a hostile, compromised or buggy client can already erase entries. Today that leaves no audit record, and after this spec it will.

## User story

As the brand owner, I want two things from `staff_submit_eod`:
- a store member can't replace an old, kept EOD count through it, so historical counts (and the reports built on them) can't be silently rewritten by a direct API call or a misbehaving client;
- every entry it erases leaves a `Count cleared` audit row, so a count that was hollowed out inside the window can be traced and re-entered.

## The problem

### The unbounded date (M3)

`public.staff_submit_eod` is `SECURITY DEFINER` and executable by `authenticated` ([supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql](../supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql) L221-222). Its only caller gate is `auth_can_see_store(p_store_id)` ([20261024000000_eod_entries_no_need.sql](../supabase/migrations/20261024000000_eod_entries_no_need.sql) L144-147). `p_date` has no bound. For an existing `(store_id, date, vendor_id)` the call upserts the parent and resets `submitted_at` to `now()` (L192-198). It then deletes every entry and inserts the payload (L201 onward). Spec 189 moves that body into a shared writer but keeps the staff path as a full replace (189 §2 L338, §4 L403).

The auditor measured it: a store member called the RPC for a 200-day-old submission. Its entries were replaced, and `submitted_at` moved to now (M3, L51). Neither table has a DELETE policy (`20260514120030_eod_submissions_consistency.sql` L183-195), so this RPC is the only way a store member can remove or replace a kept count's entries.

The staff UI can't produce such a call. `EODCount.tsx` L579-595 offers `dayOffset` 0 or 1 only, and keys the date in device-local time (`src/screens/staff/lib/date.ts` L12).

### The untraced erase (M1)

After spec 189, `staff_submit_eod` hands the write to the shared writer `public.eod_write_submission` (in 189's uncommitted [supabase/migrations/20261109120000_admin_eod_replace.sql](../supabase/migrations/20261109120000_admin_eod_replace.sql)). The staff wrapper passes `p_removed_item_ids = NULL`. In that branch (L167-169) the writer runs one bare `delete from public.eod_entries where submission_id = v_submission_id`, which writes no audit. The admin branch (L175-193) does the same kind of delete through a `delete … returning` CTE that inserts one `Count cleared` audit row per removed row.

So a store member who sends one entry over a submission holding many erases the rest without a trace. The 189 auditor measured it in probe P7: a role-`user` store member sent one valid entry on a submission holding two. One entry remained, and no audit row named the erased item. O-1 closes only the empty-payload form, and the date bound below only shrinks the window. Neither one makes the partial erase visible.

## Owner decisions (2026-11-09, main session, question dialog)

- **Window:** 35 days.
- **Anchor:** `A = (now() at time zone 'America/New_York')::date`. This is a fixed brand calendar, not session `current_date`.
- **Rule:** for a non-privileged caller, `staff_submit_eod` refuses any call with `p_date < A - 35` **or** `p_date > A + 1`. It's one stateless predicate. It applies whether or not a submission already exists at the triple, so it refuses first-time submits too. Both bounds use the same SQLSTATE and message.
- **Client:** no change. The hook is untouched. The unused "needs attention" UI stays a named follow-up.
- **Direct table writes:** out of scope, named follow-up.
- **Empty-payload refusal (189's O-1):** if spec 189 ships without O-1, this spec builds it (see R8 and AC-17 to AC-19). If 189 ships with O-1, this spec doesn't touch it.
- **Staff-side erase audit (Q7; relayed by the main session from its question dialog on 2026-11-09, after the design was written):** add a `Count cleared` audit row for each item a staff full-replace removes (189 security audit M1, fix 1). Items re-sent in the payload are replaced, not cleared, and get no such row. Staff behaviour is otherwise unchanged (see R9).

## Requirements

- **R1. Replay tolerance.** Queued offline items replay late. Queue GC is 30 days (`src/screens/staff/lib/eodQueue.ts` L43, `GC_MAX_AGE_MS`), and it runs only on hydrate (`hydrateQueue`, L101-142), so a tab that stays open never GCs. An item with an unparseable `queued_at` is kept forever (L129), and the count date can already be yesterday when the item is queued. So the window has to be at least about 32 days: 30 for GC, 1 for yesterday and 1 for time-zone slack. **The chosen 35 days clears that with 3 days spare.**
- **R2. The refusal must land in the drain's retry branch, not the dequeue branch.** `useEodSubmit.ts` `isForbidden` (L61-68) matches SQLSTATE `42501`, `status === 403`, **or a message containing the text `42501`**. A match dequeues the item (L176-179), and the staff member's count is lost. So:
  - the SQLSTATE must not be `42501`, and PostgREST must map it to a non-403 HTTP status. For example `P0001` or a `22xxx` code maps to 400; a `PT403`-style code doesn't qualify. The architect picks the code.
  - the message must not contain the text `42501`;
  - the message must also not contain any substring that `isNetworkError` (L46-59) matches: `network request failed`, `failed to fetch`, `aborted`, `timeout`. A match sends the item to the network branch, which **breaks the drain loop** (L189-196). The drain is FIFO by `queued_at` (L145-147), so the oldest item sits at the head, and it's the one most likely to be refused. A network-classified refusal would stop every later item from syncing on every drain.
  - In the "other error" branch (L197-204), `attempts` goes up, the item stays, and the drain moves on to the next item.
- **R3. Order inside the wrapper.** The check sits **after** the store-membership gate (step 1.5) and **after** the idempotency check (step 4, L169-180), and before the writer is called. So:
  - an out-of-membership caller still gets `42501`, whatever the date. Existing pgTAP arms pin this: `staff_role_eod_rls.test.sql` (5) and `staff_submit_eod_cases_each.test.sql` (6).
  - a replay of an already-processed `client_uuid` still returns `conflict: true` rather than an error.
  - The relative order of the date check and the empty-payload check (R8) doesn't matter. Both raise before the writer runs, and no test may depend on which fires first.
- **R4. Privileged callers are exempt.** `auth_is_privileged()` (`20260509000000_multi_brand_schema_rls.sql` L235-239) is true for admin or master by JWT claim, or super_admin by `profiles.role`. This matches 189 §3.4 (L385), which leaves the admin path unbounded on purpose. The exemption covers both bounds.
- **R5. A refused call writes nothing.** That means no parent upsert, no `submitted_at` change, no entry change, no on-hand change, no `audit_log` row (including no `Count cleared` row), no `notifications` row and no push enqueue. A raise before the writer rolls all of this back anyway. The ACs pin it.
- **R6. The anchor must not be caller-influenceable.** Plain `current_date` follows the session `TimeZone`, and PostgREST 12+ accepts a `Prefer: timezone=` request header that sets it. The architect should confirm this against the deployed PostgREST version. The decided anchor, `now() at time zone 'America/New_York'`, doesn't depend on the session time zone. Tests compute `A` with the same expression.
- **R7. Target the post-189 wrapper.** Spec 189 makes `staff_submit_eod` a thin wrapper (steps 1, 1.5, 3, 4) around `eod_write_submission` (189 §2 L316-338). The date check goes in the wrapper, not the writer, because the admin rule differs. The signature is unchanged, so the ACL carries over on `create or replace`.
- **R8. Empty-payload refusal, only if 189 shipped without O-1.** At build time, check whether the landed 189 wrapper already refuses an empty payload. If it doesn't, add 189 §10 O-1 as 189 costed it (L575-581). In the staff wrapper, after step 4 and before the writer, a NULL, non-array or empty `p_entries` raises `22023`. That satisfies R2 (not `42501`, and it maps to HTTP 400). If 189 already has it, skip R8 and AC-17 to AC-19.
- **R9. Audit every entry a full replace erases (Q7, 189 M1 fix 1).** This goes in the shared writer `public.eod_write_submission`, in its `p_removed_item_ids is null` branch, not in the staff wrapper.
  - **Which rows.** Write one `Count cleared` audit row for each existing `eod_entries` row the full-replace delete removes whose `item_id` is **not** among the `ingredient_id` values of `p_entries`. An item that is re-sent in the payload is replaced, not cleared. Its old row is deleted and re-inserted as today, it gets its normal per-entry audit row, and it gets **no** `Count cleared` row. A payload element with a NULL or missing `ingredient_id` matches no row (and fails in the writer anyway).
  - **Shape.** Use the same shape as the admin branch's `Count cleared` row in the landed 189 writer. At the time of writing (189 migration L181-193) that is: `store_id = p_store_id`; `user_id = auth.uid()`; `action = 'EOD entry'`; `detail = 'Count cleared · vendor: ' || coalesce(v_vendor_name, 'unknown')`; `item_ref` = the item's `catalog_ingredients.name` (left joins through `inventory_items.catalog_id`); and `value` = `'NO NEED'` for a NO NEED row, `''` for a NULL `actual_remaining`, otherwise `trim_scale(actual_remaining)::text || ' ' || coalesce(ci.unit, '')`. **The builder must re-read the landed 189 file and copy those column values and the wording from it,** not from this spec. If 189 changed the shape before landing, the landed shape wins, and the two branches must stay identical.
  - **Same transaction.** Write the rows in the same transaction as the delete. Following the admin branch, that means a data-modifying CTE in the same statement. Any raise anywhere in the call (the wrapper's refusals, or a writer error after the delete such as 23514, 42501 or 23505) rolls the rows back with everything else.
  - **Nothing else changes.** The entry set is still fully replaced. The envelope, the per-entry staff audit rows, the on-hand writes and `stock_updates` are byte-for-byte what they are today. A cleared item's `current_stock` and `eod_remaining` aren't touched, which matches today's staff path and 189's admin AC-4.
  - **Which callers.** Every caller of the NULL branch, which today is only `staff_submit_eod`. That includes privileged callers of `staff_submit_eod`, who are exempt from the date bound but not from the audit (for example, `eod_update_notifications.test.sql` re-sends through it under an admin JWT). `admin_submit_eod` never takes this branch, and its behaviour doesn't change.
  - **Already-landed check.** As with R8, if the landed 189 writer already audits the NULL branch this way (M1 fix 1 folded into 189 before landing), R9 is satisfied. Confirm it, say so under `## Files changed`, and keep only the R9 tests that 189 doesn't already have.

## Residual risk (state this plainly to the owner)

- **Inside the window, nothing is prevented.** Every count from the last 35 days can still be replaced by a store member through a direct API call. Without O-1 (from 189 or R8), it can also be emptied with `'[]'` (189 §10 L578). Even with O-1, a direct caller can send one entry and erase the rest (189 §10 L578). This spec shrinks the exposure from "all history" to "the last 35 days". It doesn't remove it.
- **An in-window erase is still possible, but it's now traceable (R9).** Each erased item leaves a `Count cleared` row naming the item, its removed value, the vendor and the caller's `user_id`. An admin can find it and re-enter the count through the admin EOD screen. The trace has limits:
  - It's only as durable as `audit_log` itself. Spec 186's nightly prune and the 90-day age gate on `admin_delete_audit_log` apply. The architect should state the effective retention for these rows.
  - A **re-sent** item's old value still isn't recorded. Its per-entry row shows only the new value, as today, so a store member who overwrites an item (instead of dropping it) leaves a record that the item was counted, not of what it was before.
  - Nothing alerts anyone. The rows sit in the audit log until someone looks.
- **Direct table writes stay open** (named follow-up). Store members can still `INSERT` into `eod_submissions` at any date, and `INSERT` extra `eod_entries` rows under any visible submission at any age (`20260504173035_per_store_rls_hardening.sql` L70-72, L97-105). That can't replace or delete a kept count, and after 189's unique index it can't repeat an item. But it can add items to an old count, and it can fabricate an old-dated count.
- **Privileged callers stay unbounded,** by design (189 §3.4).
- **Stale role claims:** an admin or master whose role was revoked stays exempt until their JWT refreshes. Every other `auth_is_admin()` gate has the same posture.
- **Stuck queued items.** A device whose queue outlived the GC (open tab, unparseable `queued_at`, wrong clock) hits the refusal. Its item retries at every drain and never syncs, so only an admin can enter that count. Staff see it only as the "N pending" pill (`QueueIndicator.tsx` L25-28). An online refusal shows the generic `eod.toast.failed` and isn't queued. A legitimate first-time submit older than 35 days is refused too. R1 makes that rare, but not impossible.
- **Wrong-clock devices** are now refused instead of silently writing a far-past or far-future count. That's intended, and the stuck-item risk above covers it.

## Acceptance criteria

`A = (now() at time zone 'America/New_York')::date`. "Store member" means an `authenticated` caller with JWT role `user`, `auth_can_see_store(store) = true` and `auth_is_privileged() = false`. "The refusal" means the SQLSTATE and message the architect picks under R2, used for both bounds. Every "unchanged" claim is read back as `postgres`. "A `Count cleared` row" means an `audit_log` row with `action = 'EOD entry'` and `detail like 'Count cleared%'`.

### Date bound

- [ ] **AC-1 (pgTAP):** a store member calling `staff_submit_eod` with `p_date = A - 36` and a new `client_uuid` raises the refusal.
- [ ] **AC-2 (pgTAP):** the same call with `p_date = A - 35` (the lower boundary, inclusive) succeeds and returns `conflict: false`.
- [ ] **AC-3 (pgTAP):** the AC-1 call, made over an existing submission at that triple seeded as `postgres`, raises the refusal. The parent's `submitted_at`, `status` and `client_uuid` are unchanged. Its `eod_entries` (ids and values) are unchanged, and so are `inventory_items.current_stock` / `eod_remaining` for the payload's items. It adds no `audit_log` rows for the store and no `notifications` rows for the submission.
- [ ] **AC-4 (pgTAP):** the refusal's SQLSTATE is **not** `42501`, and the message text contains neither `42501` nor any of `network request failed`, `failed to fetch`, `aborted`, `timeout` (case-insensitive). Assert the exact SQLSTATE and the exact message with `throws_ok`, so a later edit can't drift into the dequeue or network branch.
- [ ] **AC-5 (pgTAP):** the privileged exemption. The AC-1 call and the AC-14 `A + 2` call each succeed for JWT `admin`, JWT `master`, and `profiles.role = super_admin`.
- [ ] **AC-6 (pgTAP):** idempotent replay. A store member who replays a `client_uuid` already stored on a submission dated `A - 36` (seeded as `postgres`) gets `conflict: true` and the existing `submission_id`, and nothing changes.
- [ ] **AC-7 (pgTAP):** precedence. A store member calling for a store they can't see, with `p_date = A - 36`, gets `42501` (the store gate), not the refusal. The existing arms in `staff_role_eod_rls` (5) and `staff_submit_eod_cases_each` (6) still pass.
- [ ] **AC-8 (pgTAP):** `staff_submit_eod` keeps its signature, `prosecdef = true`, a pinned `search_path`, and EXECUTE for `authenticated` only (`anon` and `service_role` lack it). The existing arms in `eod_no_need` (11)-(13) and `staff_role_eod_rls` (10) still pass.
- [ ] **AC-13 (pgTAP):** a store member's **first-time** submit (no row at the triple) with `p_date = A - 36` raises the refusal, and no parent row exists at that triple afterwards.
- [ ] **AC-14 (pgTAP):** a store member with `p_date = A + 2` raises the refusal (same SQLSTATE and message as AC-4), and no parent row is created. The same call with `p_date = A + 1` (the upper boundary, inclusive) succeeds and returns `conflict: false`.

### Client classification (test-only; the hook isn't changed)

- [ ] **AC-9 (jest, `src/screens/staff/hooks/useEodSubmit.test.ts`):** in the drain loop, an RPC error shaped like PostgREST's response for the refusal's code and message calls `bumpEodAttempts` for that item and does **not** call `dequeueEod` for it. A second queued item after it in FIFO order is still submitted in the same drain, so the loop didn't `break`. Pattern: the existing "bumps attempts and continues" test (L256).
- [ ] **AC-10 (jest, same file):** an online `submit` that gets the same error returns `{ kind: 'failed' }`, not `'forbidden'` or `'queued'`.

### Smoke and gates

- [ ] **AC-11 (shell smoke, `scripts/smoke-staff-eod.sh`):** a new step makes a store member's out-of-window call (`A - 36`) over PostgREST and asserts HTTP **400** (not 403). This is the only track that proves the SQLSTATE-to-HTTP mapping R2 depends on. The script's existing steps pass after their dates are reworked (see Fixture blast radius), and the rework doesn't create a path that can replace a real prod count.
- [ ] **AC-12:** every pgTAP suite listed under Fixture blast radius passes (including the R9 audit-fixture list), the full `npx jest` passes, and both typecheck gates pass.

### Empty-payload refusal (only if 189 shipped without O-1, per R8)

- [ ] **AC-17 (pgTAP):** a store member calling `staff_submit_eod` with an in-window date and `p_entries` of `'[]'`, of NULL, and of a non-array JSON value each raises `22023`. Over an existing submission seeded as `postgres`, the parent and its entries are unchanged and no `audit_log` or `notifications` row is added.
- [ ] **AC-18 (pgTAP):** a store member replaying an already-processed `client_uuid` with `'[]'` still gets `conflict: true` and the existing `submission_id`.
- [ ] **AC-19 (pgTAP):** `eod_update_notifications.test.sql` is updated at its five `'[]'` call sites (189 §10 L580: L221, L234, L285, L305, L685; re-grep at build time) to send one Frederick item with no link to the test vendor, and the suite passes.

AC-15 and AC-16 numbers are retired (they belonged to options the owner didn't choose). AC-20 and AC-21 are the architect's additions in design §13.

### Staff-side erase audit (R9)

Fixture for AC-22 to AC-27 unless stated: as `postgres`, pre-delete and then seed a submission S at an in-window triple (store, `A - k`, vendor V). S holds two entries: I1 (numeric, with a unit) and I2 (numeric, with a unit), both linked to V. Snapshot the store's `Count cleared` row count and the two items' on-hand before each call. Counts are deltas against that snapshot, keyed to the item names, not raw per-store totals.

- [ ] **AC-22 (pgTAP, probe P7 re-run):** a store member calls `staff_submit_eod` over S with a new `client_uuid` and one entry, for I1 only. Afterwards:
  - S holds only I1, so the full-replace behaviour is unchanged.
  - **Exactly one** new `Count cleared` row exists. Its `store_id` is the store, its `user_id` is the caller's `auth.uid()`, its `detail` is `'Count cleared · vendor: ' || <V's name>`, its `item_ref` is I2's catalog name, and its `value` is I2's removed value in the admin branch's format (for example `'20 lbs'`).
  - **No** `Count cleared` row names I1.
  - I1 has exactly one new per-entry staff row with today's shape (`user_id` NULL, `detail` starting with the caller's uid, then `' · vendor: '`).
  - This is the AC that shows M1 is closed. Name it after P7 in the test description.
- [ ] **AC-23 (pgTAP, value shapes and on-hand):** over a submission holding a NO NEED entry and a non-NO-NEED entry with a NULL `actual_remaining` (seeded as `postgres`), a store member re-submit that sends neither of them writes one `Count cleared` row each. Their values are `'NO NEED'` and `''`. Each cleared item's `current_stock` and `eod_remaining` equal the snapshot.
- [ ] **AC-24 (pgTAP, first submit):** a store member's first-time submit at a triple with no prior row writes **zero** `Count cleared` rows. It writes its normal per-entry rows, one per entry.
- [ ] **AC-25 (pgTAP, replay and full re-send):**
  - A store member who replays S's stored `client_uuid` gets `conflict: true` and writes **zero** `audit_log` rows of any kind.
  - A store member who re-sends both I1 and I2 over S, with a new uuid and new values, writes **zero** `Count cleared` rows (re-sent items are replaced, not cleared) and one per-entry row each.
- [ ] **AC-26 (pgTAP, same transaction):** each of the following writes **zero** `Count cleared` rows and leaves S's entries (ids and values) unchanged:
  - the date refusal over a seeded out-of-window S (already covered by AC-3's "no audit_log rows"; re-assert the `Count cleared` delta explicitly);
  - the O-1 refusal over S;
  - a writer error **after** the delete. For example, a store member sends I1 plus a NO NEED element carrying a quantity, which raises `23514`, or sends I1 twice, which raises `23505`. Assert the SQLSTATE with `throws_ok`, then read back as `postgres`.
- [ ] **AC-27 (pgTAP, privileged caller of the staff RPC):** a JWT `admin` caller of `staff_submit_eod` that sends I1 only over S writes exactly one `Count cleared` row for I2, with the same shape as AC-22 and `user_id` = the admin's uid. This pins that the audit follows the NULL branch, not the caller's role.
- [ ] **AC-28 (pgTAP, admin path and writer catalog unchanged):**
  - Every existing `admin_submit_eod.test.sql` arm passes unchanged, in particular (22), (30) and (96).
  - `eod_write_submission` keeps its signature, `prosecdef = false`, `proconfig = {search_path=public}`, and **no** EXECUTE for `public`, `anon`, `authenticated` or `service_role` (189's existing catalog arms keep passing). A pgTAP structural arm checks that the writer's source contains `Count cleared` in both branches.

## Fixture blast radius (grep of `supabase/tests/` on 2026-11-09)

Nine files mention `staff_submit_eod`. Two of them only assert the catalog or ACL (`reports_anon_revoke`, and `eod_submissions_edit_flow`, which has comments only), so they're unaffected. These are the real calls, by caller, against today's working tree:

| File | Line | Caller | Date | Under the decided rule |
|---|---|---|---|---|
| `staff_submit_eod_cases_each.test.sql` | L140 | store member (`user`) | 1999-12-30 | **breaks** |
| same | L184 | store member | 1999-12-29 | **breaks** |
| same | L234 | store member, out-of-membership | 1999-12-28 | ok (42501 first) |
| `eod_no_need.test.sql` | L283 | store member | 1999-12-27 | **breaks** |
| same | L301 | store member, expects `23514` | 1999-12-26 | **breaks** (the refusal fires first) |
| `eod_update_notifications.test.sql` | L218 | store member | 1999-11-02 | **breaks**, and S1-S4 cascade from it |
| same | L231, L282, L682 | admin (exempt) | 1999-11-02 | ok |
| same | L302 | replay (conflict before the check) | 1999-11-02 | ok only if L218 still creates the row |
| `audit_log_rls_hardening.test.sql` | L442 (W-1) | store member | 1999-12-29 | **breaks** |
| `inventory_items_identity_lock.test.sql` | L455 (T22) | store member (claims set at L432) | 1999-12-20 | **breaks** |
| `eod_submissions_multi_vendor.test.sql` | L166 | store member | 1999-12-27 | **breaks** |
| `staff_role_eod_rls.test.sql` | L145 | store member | 1999-12-31 | **breaks**, and arms (2), (3), (4), (7), (11) depend on it |
| same | L230 | store member, out-of-membership | 2026-05-23 | ok (42501 first) |
| same | L347 | replay | 1999-12-31 | ok only if L145 still succeeds |

**Totals.** 9 call sites across 7 files need new dates, plus the arms that cascade from them. No fixture uses a future date, so the upper bound breaks none. If R8 applies, `eod_update_notifications.test.sql` also changes for AC-19.

**Fixture dates** must be relative to the anchor, for example `A - k` with `2 ≤ k < 35`. They should avoid today and yesterday, which the e2e test and real local use write to. Pinning a store member to old fixed dates no longer works. Because fixtures can't use unique far-past dates any more, the architect should check that two suites can't collide on the same `(store, date, vendor)` triple on a non-reset local database.

**Also affected:**
- `scripts/smoke-staff-eod.sh` uses dates 1,000 to 10,000 days ago, by design, so it never collides with real prod data when pointed at a remote URL (L145-161, L350-357). All four of its submit calls break. **Risk for the rework:** an in-window date pointed at prod could replace a real count, and the rework must not create that path. For example, it could refuse to run against a non-local URL, or use a vendor that has no real counts. The architect chooses.
- **Spec 189's `admin_submit_eod.test.sql`** now exists in the working tree (it didn't when this table was first drawn). Its ST block (L297) calls `staff_submit_eod` as a store member (`test.claims_user`) at `1999-12-03`, so it **breaks** under the date bound. Its replay at L430 depends on that row, and its O-1 refusal and empty-replay calls (L935-958) need re-checking. Re-grep at build time.
- **Any other spec 189 fixture** that calls `staff_submit_eod` as a store member at a fixed old date. Re-grep `supabase/tests/` at build time, against the post-189 tree.
- `e2e/eod.spec.ts` uses `todayIso()` (L275-282), so it's unaffected.

### Audit fixture impact (R9; grep of `supabase/tests/` on 2026-11-09)

R9 adds rows only when a full replace drops an item that existed before the call. None of today's suites does that and then asserts `audit_log`, so **no existing assertion is expected to change**. The risk is in how some of them read `audit_log`: `Count cleared` rows share `action = 'EOD entry'` and `item_ref` with the per-entry rows, so any leftover prior row at a reworked in-window triple could add one. The pre-delete in design §6.2 is what keeps these suites stable. Check each one at build time:

| File | Assertion | Why it's sensitive |
|---|---|---|
| `staff_role_eod_rls.test.sql` | (4), L211-219: `detail` of the **latest** `'EOD entry'` row for Frederick, `order by id desc limit 1`, must start with the manager uid | A `Count cleared` row for Frederick in the same transaction could be the one returned, and it starts with `Count cleared`. The suite does one first submit (L145), so it writes none today. |
| `eod_no_need.test.sql` | (25) L357-364 and (29) L388-395: **scalar** subqueries on `(store, 'EOD entry', item_ref)` | A second row for the same item (a `Count cleared` row) would raise "more than one row returned". One first submit (L283), so none today. |
| `audit_log_rls_hardening.test.sql` | W-1, L456-464: count of `'EOD entry'` rows for the item with `user_id is null` must be 1 | `Count cleared` rows carry `user_id = auth.uid()`, so the filter excludes them. One first submit, so it's safe either way. |
| `admin_submit_eod.test.sql` | (22) L348-355 counts per-entry rows by actor-prefixed `detail` and `user_id is null` (expects 4). (30) L411-419 reads the admin `Count cleared` row for C3. (96) L1148-1156 excludes `Count cleared` rows. The `snap` helper (L193) counts every `audit_log` row for store a1 around the refusal arms. | The ST call is a first submit and the replay is a conflict, so no new rows. Refusal arms still write none. Recheck (30) stays single-row if the ST date rework moves the triple. |
| `eod_update_notifications.test.sql` | No `audit_log` assertions | Its admin-JWT re-sends through `staff_submit_eod` (L245, L296, L696) send the same payload as the first submit, so they clear nothing. If R8 or the rework changes a payload so a later call drops an item, it starts writing `Count cleared` rows. The architect should also confirm that no trigger on `audit_log` insert emits `notifications`, since the suite counts those. |

The new R9 arms (AC-22 to AC-28) can go in the new `staff_submit_eod_date_bound.test.sql` or in a sibling file; the architect decides.

## In scope

- One migration on top of spec 189 holding:
  - `create or replace public.staff_submit_eod` with the date check per R2 to R7 (35-day window, `America/New_York` anchor, `A + 1` upper bound, privileged exemption). Its signature, ACL and envelope are unchanged.
  - **`create or replace public.eod_write_submission`** with the R9 audit in its `p_removed_item_ids is null` branch. Its signature, invoker posture, revoked ACL, envelope and every other behaviour are unchanged. This is new since the design was written, and the design's "the writer is unchanged" no longer holds (see "Design amendment needed" below).
- The empty-payload refusal in the same migration, only if 189 shipped without O-1 (R8).
- pgTAP arms for AC-1 to AC-8, AC-13, AC-14, AC-20, AC-21 and AC-22 to AC-28 (plus AC-17 to AC-19 if R8 applies), and reworking the fixtures listed under Fixture blast radius.
- Jest arms AC-9 and AC-10 in `useEodSubmit.test.ts`. These are test-only.
- `scripts/smoke-staff-eod.sh` date rework, plus the AC-11 step.
- Function comments recording the window, the anchor, the upper bound and the exemption (wrapper), and the NULL-branch `Count cleared` audit (writer).
- A prod apply note (below).

## Out of scope (explicitly)

- **Any client change.** `useEodSubmit`, `eodQueue` and the staff UI are untouched (owner decision Q4). Named follow-up: a staff-queue spec that (1) builds the `attempts >= 5` "needs attention" UI the queue comments promise (`eodQueue.ts` L16, L306; the unused `chrome.queue.needsAttention` string, `en.json` L372), showing each stuck item's date, vendor and `lastError`, and (2) decides whether to GC items whose `queued_at` can't be parsed (`eodQueue.ts` L129). Both are pre-existing gaps that this spec didn't create.
- **A refusal-specific toast or dequeue.** Dequeuing would lose a count that an admin could still enter.
- **Direct table insert paths** (owner decision Q5). Named follow-up: a `RESTRICTIVE` date predicate on the store-member INSERT policies of `eod_submissions` and `eod_entries`. It needs its own fixture sweep and a check of the old-client and spec 172 paths that 189 §9 keeps on purpose.
- **A date bound on `admin_submit_eod`.** 189 §3.4 rules it out, since the admin UI exists to correct past days.
- **A per-store time zone column.** It's a schema change, and a known separate follow-up. When it lands, this anchor literal is one more place to update.
- **Any change to `isForbidden` / `isNetworkError`.** R2 fits the server to the shipped client, so installed clients behave correctly without an update.
- **Preventing the partial-payload erase** (one entry sent, the rest removed) inside the window. R9 makes it traceable, but neither this spec nor O-1 blocks it. The owner asked for the audit, not a contract change (for example a removal list on the staff path).
- **Recording a re-sent item's old value.** It's the pre-existing per-entry audit shape and wasn't asked for.
- **Backfilling audit rows for past erases.** The removed values are gone, so there's nothing to reconstruct.
- **Surfacing `Count cleared` rows anywhere new**, such as an alert, a notification or an admin UI filter. They land in `audit_log` like the admin branch's rows do.
- **The other 189 security findings** (L1 empty-removal-list on the admin path, L2 staff `p_status` / vendor-brand checks, L3 stale claims). They're separate follow-ups.
- **Spec 189's file.** It isn't edited, and its wording stands.
- **Making a rejected attempt leave a trace,** for example an audit row of the refused call. A raise rolls back any same-transaction insert, so logging it would need a different mechanism, and nobody asked for one.

## Open questions resolved

Answered by the owner on 2026-11-09, through a question dialog in the main session.

- Q1: How long is the window? → A: **35 days.** That covers the 30-day queue GC, plus yesterday, plus time-zone slack, with 3 days spare.
- Q2: What does the bound refuse? → A: **(a) any non-privileged call with `p_date` older than the window**, whether or not a submission already exists at the triple, **and** any `p_date` later than `A + 1` (the owner accepted the optional future bound). The owner didn't choose the "replace only" or hybrid options.
- Q3: What is the window anchored on? → A: **The America/New_York brand calendar,** using a fixed `(now() at time zone 'America/New_York')::date` anchor, not session `current_date`.
- Q4: Is any client change in scope? → A: **No client change.** The unused "needs attention" UI stays a named follow-up.
- Q5: Should this spec also bound the direct table writes? → A: **No.** Old-dated direct-table inserts stay out of scope, as a named follow-up.
- Q6: What if spec 189 ships without O-1? → A: **Fold the empty-payload refusal into this spec** if 189 ships without O-1 (R8, AC-17 to AC-19).
- Q7 (relayed by the main session from its question dialog, 2026-11-09, after the design): Should spec 193 also close 189 security finding M1 (staff full-replace erases leave no audit)? → A: **Yes. Add a `Count cleared` audit row for each item a staff full-replace removes,** following the auditor's fix 1: the same returning-to-audit_log CTE as the admin branch, limited to items not present in `p_entries`. Staff behaviour is otherwise unchanged (R9, AC-22 to AC-28).

## Dependencies

- **Spec 189 must land first** (Status READY_FOR_BUILD, being built in another session). This spec targets two of its objects:
  - the wrapper shape (189 §2): the date check goes in `staff_submit_eod` after steps 1.5 and 4, and before `eod_write_submission`;
  - the writer `eod_write_submission`: the R9 audit goes in its `p_removed_item_ids is null` branch, copying the admin branch's `Count cleared` CTE.
  The migration must sort after 189's `20261109120000_admin_eod_replace.sql`, or whatever slot 189 finally takes. The prod pre-check md5s must compare against the **post-189** bodies of **both** functions.
- **Spec 189 O-1** decides whether R8 applies. Check the landed 189 wrapper at build time.
- **Spec 189 M1** decides whether R9 is already done. If 189 folds fix 1 in before landing, R9 reduces to confirming it and adding the missing tests.
- **Spec 185 (DRAFT)** also changes the staff wrapper (area-scoped replacement, `specs/185-front-back-inventories.md` L117, L219). If it narrows the full-replace delete to one area, it also changes which rows R9 audits, because the cleared set has to follow the delete's actual scope. Whichever of 185 and 193 lands second must carry the other's hunks in its `create or replace` of both functions. It's a sequencing risk, not a blocker.
- No library, edge function or realtime dependency.

## Project-specific notes

- **Cmd UI section:** none. This is DB hardening of the staff RPC and its shared writer. The admin surface doesn't call `staff_submit_eod` (only comments in `src/lib/db.ts`, `src/store/useStore.ts` and `src/types/index.ts` mention it). The new `Count cleared` rows show wherever the admin surface already shows `audit_log`, the same way the admin branch's rows do, with no UI change.
- **Which app:** the staff EOD surface in this repo ([src/screens/staff/](../src/screens/staff/), folded in by spec 063) and its RPC. No sibling repo.
- **Per-store or admin-global:** per-store. The existing `auth_can_see_store()` gate stays, and privileged callers are exempt from the date bound. Audit rows carry the submission's `store_id`.
- **Edge function or PostgREST:** PostgREST RPC. No edge function, so `verify_jwt` doesn't apply.
- **Realtime channels touched:** none. There's no publication change, so the realtime-slot restart gotcha doesn't apply.
- **Migrations needed:** yes, one. It does a `create or replace` of `staff_submit_eod` (same signature) **and** of `eod_write_submission` (same signature).
- **Edge functions touched:** none.
- **Web/native scope:** server-only. There's no client change, so web and native behave the same, and installed native or PWA builds need no update (R2).
- **`app.json` slug:** not touched.
- **Tests:** pgTAP (AC-1 to AC-8, AC-13, AC-14, AC-20, AC-21, AC-22 to AC-28, AC-17 to AC-19 if R8 applies, plus the fixture rework), jest (AC-9, AC-10), shell smoke (AC-11).

## Prod apply (owner, later; not part of this spec's done state)

Project `ebwnovzzkwhsdxkpyjka`, via MCP `execute_sql`. Apply only on the owner's go-ahead, and only **after** 189 is on prod.

**Order (fold-in a, 2026-11-10):** apply on prod via the Supabase MCP path (`execute_sql` plus an explicit insert of version `20261109190000` into `supabase_migrations.schema_migrations`), **not** `supabase db push`: the version sorts before other sessions' pending migrations, so it's out of order by design. Do it **BEFORE pushing to `main`**, or `db-migrations-applied.yml` goes red on `20261109190000` missing from prod. See §9 for the md5 baseline to re-check first.

1. **Pre-check:** the normalized md5s of prod's `staff_submit_eod` **and** `eod_write_submission` match the post-189 local bodies.
2. **Apply:** run the migration, and insert its exact version into `supabase_migrations.schema_migrations`.
3. **Verify:** check both functions.
   - The md5s match local.
   - `staff_submit_eod` has `prosecdef` true, `proconfig` pins `search_path`, and the ACL is `authenticated` plus the owner.
   - `eod_write_submission` has `prosecdef` false, `proconfig` pins `search_path`, and the ACL is the owner only.
4. **Gates:** push to `main` only after steps 2-3 are done on prod; then confirm `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` by hand.

At deploy, any queued item on a staff device whose date is already outside the window starts being refused. Its count stays queued and isn't lost. Nobody can see how many such items exist, because the queue is device-local. From deploy on, a staff re-submit that drops items writes `Count cleared` rows. Erases that happened before deploy can't be traced.

## Handoff (PM → architect; consumed. The current handoff is at the end of the file.)
next_agent: backend-architect
prompt: Design the contract for this spec. Read the acceptance criteria
  and any project-specific notes, then produce the design doc and set
  Status: READY_FOR_BUILD.
payload_paths:
  - specs/193-staff-eod-date-bound.md

## Design amendment needed (R9, added 2026-11-09 after the design below)

The backend design below was written before Q7. It's left in place as written, but it no longer covers the whole build:
- §0 ("one inserted block"), §2.2 ("one function plus one comment"), §2.3 and §2.4 (a byte-for-byte diff showing one added hunk in the **wrapper**) assume only `staff_submit_eod` changes. R9 changes the **shared writer** `eod_write_submission` too. That needs its own `create or replace` with `security invoker` and `set search_path = public` restated. It also needs an explicit decision on whether the `revoke all … from public, anon, authenticated, service_role` is re-issued (spec 097's default privileges apply at create, not at replace, but AC-28 pins the outcome either way), a re-issued comment, and a second body diff.
- §5 ("Surfaces with no change") and §6 need the R9 arms (AC-22 to AC-28) and the audit fixture checks above.
- §9 (prod apply) and §10 (rollback) must cover both functions' md5s, and the rollback must restore the landed 189 writer verbatim.
- §11's 185 overlap now covers both functions.
- The trailing `## Handoff` to backend-developer at the end of the design is stale until the architect amends the design and re-sets `Status: READY_FOR_BUILD`.

**Resolved 2026-11-09 (architect amendment).** The design below now covers R9 throughout: §0 and §1 (decisions and preconditions), §2.2 and §2.5 to §2.7 (the writer replace, its hunk, both body diffs), §5 (surfaces), §6.2 and §6.5 to §6.6 (fixture rework incl. `admin_submit_eod.test.sql`, the R9 arms, the audit-fixture checks), §9 and §10 (both functions' md5s, rollback), §11 (189 rollback, 185), §12 and §13. The trailing `## Handoff` is current.

## Backend design

Read from code on 2026-11-09. This pass had no shell or database access, so nothing below was run. The owner's decisions (35 days, both bounds, NY anchor, no client change, R8 only if 189 lacks O-1, and Q7's staff-side erase audit) are settled and not reopened here. Signatures and pseudocode are the contract. The developer writes the SQL, the tests and the script.

**Amended 2026-11-09 for R9 (Q7).** The first pass covered the date bound only and assumed the writer was untouched. It isn't: R9 replaces `public.eod_write_submission` too. The amendment is folded into the sections below rather than appended, so each section reads as the current contract. New sections: §2.5 to §2.7 (writer), §6.5 and §6.6 (R9 arms, audit-fixture checks). Re-read §0, §1, §2.2, §5, §6.2, §9 to §13 even if you read the first pass.

### 0. Decisions in one place

| Question | Decision |
|---|---|
| Where the date check goes | In the post-189 `staff_submit_eod` wrapper, **after** step (4) idempotency and after 189's O-1 block, immediately **before** the `return public.eod_write_submission(...)` call (§2.3) |
| SQLSTATE | **`22023`** (`invalid_parameter_value`). PostgREST maps it to HTTP **400** (§3.1) |
| Message | **`staff_submit_eod: p_date is outside the staff window (35 days back to 1 day ahead, America/New_York)`**. A constant: no interpolation, no DETAIL, no HINT (§3.2) |
| Predicate | `(p_date is null or p_date < A - 35 or p_date > A + 1) and not public.auth_is_privileged()`, with `A = (now() at time zone 'America/New_York')::date` written inline (§2.3) |
| Wrapper shape | A full `create or replace` of the landed 189 wrapper. It's byte-for-byte the same apart from **one inserted block**, with the same header clauses and a re-issued comment. No grant or revoke statements for the wrapper (§2.4) |
| Where the erase audit goes (R9) | In the **writer** `eod_write_submission`, `p_removed_item_ids is null` branch. The bare `delete` becomes a `delete … returning` CTE feeding one `insert into public.audit_log`, filtered with `NOT EXISTS` to items not in `p_entries`. The delete itself stays unconditional (§2.5) |
| Writer shape | A full `create or replace` of the landed 189 writer: `security invoker`, `set search_path = public`, same signature. Byte-for-byte the same apart from **one hunk** inside the NULL branch. Comment re-issued. The 189 `revoke all … from public, anon, authenticated, service_role` is **re-issued verbatim** (a no-op on a 189 database; fails closed otherwise) (§2.5, §2.6) |
| Pre-flight | A `do` block at the top of the migration refuses to run unless 189's writer exists and the live wrapper already calls it (§2.2) |
| Order in the migration | Pre-flight, then the writer (replace, comment, revoke), then the wrapper (replace, comment). One transaction |
| R8 / O-1 | **Expected not to apply.** The in-progress 189 migration already has O-1 (header L33-35, body L368-377, "owner approved 2026-11-09"). Confirm against the landed file (§1) |
| R9 already in 189? | **Not as of 2026-11-09.** The in-progress 189 NULL branch (L169-171) is a bare delete. Confirm against the landed file (§1) |
| Migration slot | `supabase/migrations/20261109190000_staff_eod_date_bound.sql`, provisional (§2.1). Still free on 2026-11-09 re-glob |
| New pgTAP file | `supabase/tests/staff_submit_eod_date_bound.test.sql`, holding both the date-bound arms (§6.1) and the R9 arms (§6.5). One file, because both test the same two functions and share the fixture |
| Smoke script | Local-only guard with no override, NY-anchored in-window dates picked from free triples, and best-effort cleanup (§8). No R9 smoke step (§8) |
| Client, `db.ts`, store, realtime, edge | None (§5) |

### 1. Preconditions at build time (do these first)

1. **Wait for 189 to settle.** Start once 189's migration is committed, or at least once 189 is at `READY_FOR_REVIEW` and no reviewer has asked for migration changes. If 189's wrapper **or writer** changes after you've written 193, re-sync 193 (steps 3 and 4 below) before review.
2. **Re-read the landed 189 migration in full.** Don't work from this design's line numbers or from `pg_get_functiondef` output. A function's source text, comments included, is what the normalized md5 covers, so copy **both** bodies (`staff_submit_eod` and `eod_write_submission`) from the migration file.
3. **Decide R8 from the landed wrapper.** If it contains the O-1 block (NULL, non-array or empty `p_entries` raises 22023 after step 4), skip R8 and AC-17 to AC-19, and say so under `## Files changed`. If it doesn't, insert the O-1 block first, in the shape of the in-progress 189 file L368-377, and then the date block. AC-17 to AC-19 then apply.
4. **Decide R9 from the landed writer.** If its `p_removed_item_ids is null` branch already audits the delete the §2.5 way (M1 fix 1 folded into 189), don't replace the writer: drop §2.5 to §2.7 from the migration, keep only the §6.5 arms 189's suite lacks, and say so under `## Files changed`. Otherwise, **copy the admin branch's `Count cleared` select list (the six audit_log column values, the joins and the `case` for `value`) from the landed file**, not from §2.5. If 189 changed that shape before landing, the landed shape wins, and the two branches must stay identical.
5. **Re-glob `supabase/migrations/`** for the slot (§2.1), and **re-grep `supabase/tests/` and `scripts/`** for `staff_submit_eod` against the post-189 tree (§6.3). That includes 189's `admin_submit_eod.test.sql` (§6.2 now lists its sites).

### 2. Migration

#### 2.1 Slot

`supabase/migrations/20261109190000_staff_eod_date_bound.sql`. Re-glob on 2026-11-09 (amendment pass): `20261109120000` (189), `…140000` (190 PO sequence), `…170000` (194), `…191000` (191 demote brand scope), `…195000` (190 user_stores). `…190000` is still free and sorts after 189. None of those siblings touches `staff_submit_eod`, `eod_write_submission`, `eod_entries`, `eod_submissions` or `audit_log` (grep on 2026-11-09), so sorting between them is harmless. Several sessions are still adding migrations, so **re-glob the folder at build time**. The file must sort after 189's **final** slot. If `20261109190000` is taken, or 189 moved past it, take the next free slot after both. The name stays `staff_eod_date_bound` even though it now also carries R9; the header says so.

#### 2.2 Contents

Mirror 189's framing: `begin;`, `set local lock_timeout = '5s';`, then, in this order:

0. **Pre-flight `do` block.** Raise (errcode `55000`, `object_not_in_prerequisite_state`; message naming spec 189) unless both hold:
   - `to_regprocedure('public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)') is not null`; and
   - the live `staff_submit_eod`'s `prosrc` contains `eod_write_submission(`, so it is the post-189 wrapper.

   Why: on a database without 189 (only possible on prod through a hand-applied, out-of-order `execute_sql`), `create or replace` of the writer would silently **create** it, with spec 097's default grants, and the wrapper replace would point staff writes at it without 189's unique index. Migration order makes this unreachable on a fresh or CI database. The block costs nothing and turns the out-of-order case into a clean failure. It isn't a substitute for the §9 md5 pre-check, which also catches a drifted 189 body.
1. **The writer** (§2.5): `create or replace function public.eod_write_submission(p_store_id uuid, p_date date, p_vendor_id uuid, p_status text, p_entries jsonb, p_client_uuid uuid, p_removed_item_ids uuid[], p_audit_actor text, p_on_hand_actor uuid) returns jsonb language plpgsql security invoker set search_path = public`. **Restate `security invoker` and `set search_path = public` exactly as 189 has them.** Leaving out `set search_path` would drop the pin (AC-28 catches it). Writing `security definer` by habit would turn an ungated writer into a store-wide write for anyone who can reach it, and the revoked ACL would then be its only defence. AC-28's `prosecdef = false` arm catches that.
2. `comment on function public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid) is` a new sentence starting `'spec 193: ...'`, followed by 189's comment text **verbatim**. The spec 193 sentence states: the `p_removed_item_ids` NULL branch (whole-set replace, staff) now writes one server `Count cleared` audit row, same shape as the targeted branch, for each deleted row whose `item_id` is not an `ingredient_id` in `p_entries`, in the same statement as the delete; re-sent items get only their per-entry row. Keep the 189 sentence "EXECUTE is revoked from public, anon, authenticated and service_role, and it must stay that way" (it's in the verbatim part).
3. `revoke all on function public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid) from public, anon, authenticated, service_role;`, **verbatim from 189 L296-297**, with a one-line comment: "No-op on a 189 database (create or replace keeps proacl). Re-issued so this file fails closed if it ever creates the function." See §2.6 for why the writer gets it and the wrapper doesn't.
4. **The wrapper:** `create or replace function public.staff_submit_eod(p_client_uuid uuid, p_store_id uuid, p_date date, p_submitted_by text, p_status text, p_entries jsonb, p_vendor_id uuid) returns jsonb language plpgsql security definer set search_path = public`. **Restate `security definer` and `set search_path = public` exactly as 189 has them.** `create or replace` resets any clause you leave out, so leaving one out would silently turn the wrapper into an invoker function. AC-8 catches that.
5. `comment on function public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid) is` a new sentence starting `'spec 193: ...'`, followed by 189's comment text **verbatim**. The spec 193 sentence states: non-privileged callers are refused when `p_date` is NULL, earlier than A - 35 or later than A + 1; A = `(now() at time zone 'America/New_York')::date`; SQLSTATE 22023 with the fixed message; privileged callers (`auth_is_privileged()`) are exempt; the check runs after the store gate and the idempotency check; a per-store time zone follow-up would need to change this literal; and a full replace that drops items now leaves `Count cleared` rows (via the writer).
6. `commit;`

No table, column, index, policy or publication change. Neither signature changes. The wrapper's ACL (`postgres` + `authenticated`) carries over; no grant or revoke for it.

The header comment block follows 189's shape. Include: what changed, for both functions; the R2 classification reasoning in two lines; the R9 audit rule in two lines (which rows, same-statement CTE, NOT EXISTS); the pre-flight; PROD-APPLY (§9); ROLLBACK (§10), **including the 189-rollback interaction (§11)**; the tests list; and "no publication change, so no `docker restart supabase_realtime_imr-inventory` step" (`audit_log` isn't in `supabase_realtime`, `20261022000000` L60).

#### 2.3 The inserted block (pseudocode, the contract)

The post-189 wrapper order is (1) vendor check, (1.5) `auth_can_see_store` gate (42501), (3) actor, (4) idempotency (`conflict: true` return), O-1 block (22023), then `return public.eod_write_submission(...)`. Insert **one** block between the end of the O-1 `if` and the `-- (5)-(7) Parent upsert ...` comment that precedes the `return`:

```
-- Spec 193: staff date window. <one-paragraph rationale: R1 replay, R2 code
-- choice, R6 anchor, R4 exemption>. After (1.5) so an outsider still gets
-- 42501; after (4) so a processed uuid still replays as conflict = true;
-- before the writer so a refusal writes nothing.
if (p_date is null
    or p_date < (now() at time zone 'America/New_York')::date - 35
    or p_date > (now() at time zone 'America/New_York')::date + 1)
   and not public.auth_is_privileged() then
  raise exception '<the §3.2 message, exactly>'
    using errcode = '22023';
end if;
```

Notes on that shape:

- **No new `declare` variable.** The anchor is written inline twice so the change is one contiguous inserted hunk. `now()` is the transaction start time, so both uses agree.
- **Date predicate first.** The common in-window staff call then usually skips `auth_is_privileged()`'s `profiles` lookup. Postgres doesn't promise left-to-right evaluation, so this is only a cost hint, not something correctness depends on.
- **`p_date is null` is in the predicate on purpose.** Without it the predicate is NULL, the `if` is skipped, and the call relies on `eod_submissions.date NOT NULL` (init schema L122) to fail later with 23502. Both outcomes are HTTP 400 with no write, so this changes only the code and message a store member sees for a NULL date. It closes the three-valued gap in the check itself instead of leaning on a constraint in another file. A privileged NULL still reaches the writer and gets 23502, the same as today.
- **Same place, R8 or not.** If R8 applies, the O-1 block goes first and this block follows it. Per R3, no test may depend on which of the two fires first.

#### 2.4 Byte-for-byte rule (wrapper)

The 193 wrapper body must equal the landed 189 wrapper body with exactly that block inserted. Before review, `diff` the two function bodies, taken from the two migration files, and paste the result under `## Files changed`. It should show one added hunk and nothing removed. The prod verify (§9) compares normalized md5s, so stray whitespace or comment edits inside `$$ ... $$` break it.

#### 2.5 The writer hunk (R9; pseudocode, the contract)

Only the `p_removed_item_ids is null` arm of step (2) changes. In the in-progress 189 file that arm is L169-171:

```
  if p_removed_item_ids is null then
    -- Staff: replace the whole set.
    delete from public.eod_entries where submission_id = v_submission_id;
  else
```

It becomes (keep the `-- Staff: replace the whole set.` line; the new comment lines follow it):

```
  if p_removed_item_ids is null then
    -- Staff: replace the whole set.
    -- Spec 193 (R9; 189 security M1): every deleted row whose item is not
    -- re-sent in p_entries gets one server audit row, same shape as the
    -- targeted branch. <rationale: the delete stays unconditional, the
    -- filter applies to the audit insert only; NOT EXISTS, not NOT IN;
    -- re-sent items are replaced, not cleared, and keep only their
    -- per-entry row from the loop below.>
    with cleared as (
      delete from public.eod_entries e
       where e.submission_id = v_submission_id
      returning e.item_id, e.actual_remaining, e.no_need
    )
    insert into public.audit_log (store_id, user_id, action, detail, item_ref, value)
    select
      <the six values, copied from the landed admin branch's select list>
    from cleared c
    left join public.inventory_items ii on ii.id = c.item_id
    left join public.catalog_ingredients ci on ci.id = ii.catalog_id
    where not exists (
      select 1
        from jsonb_to_recordset(coalesce(p_entries, '[]'::jsonb)) as x(ingredient_id uuid)
       where x.ingredient_id = c.item_id
    );
  else
```

In the in-progress 189 file, "the six values" are L185-192: `p_store_id`, `auth.uid()`, `'EOD entry'`, `'Count cleared · vendor: ' || coalesce(v_vendor_name, 'unknown')`, `ci.name`, and the three-way `case` (`'NO NEED'` / `''` / `trim_scale(c.actual_remaining)::text || ' ' || coalesce(ci.unit, '')`). Copy them, the CTE's `returning` list and both joins from the **landed** file character for character (§1 step 4). The only text the staff CTE adds over the admin one is the `where not exists (…)` clause, and the only text it drops is the admin delete's `and e.item_id = any (p_removed_item_ids)` line.

Why each piece is shaped this way:

- **The delete stays unconditional.** The `NOT EXISTS` sits on the outer `select`, never in the delete's `where`. A data-modifying CTE always runs to completion, whether or not the outer query reads all of its rows (Postgres docs, "Data-Modifying Statements in WITH"), so every row of the submission is still deleted, which is today's full-replace. A filter moved into the delete's `where` would leave re-sent items' old rows in place, and the loop's re-insert would then hit `eod_entries_submission_item_uidx` with 23505 on every ordinary re-submit.
- **The audit sees the old rows.** `returning` yields the rows as they were before the delete, so the logged `value` is what was removed. The two joins read `inventory_items` / `catalog_ingredients`, which the statement doesn't modify, so snapshot visibility doesn't matter for them.
- **The loop sees the delete.** The CTE is its own statement inside the plpgsql function. The loop's `insert`s in step (3) are later statements and take a fresh snapshot, so they see the deleted rows as gone. That's exactly today's ordering (the bare delete was also a separate statement before the loop), so re-sent items re-insert without a unique-index conflict and their per-entry audit rows (step 3) are written as today. Nothing in step (3) changes.
- **`NOT EXISTS`, never `NOT IN` or `<> all`.** With `c.item_id not in (select x.ingredient_id …)`, a single payload element whose `ingredient_id` is NULL or missing makes the predicate NULL for every row, and the call writes **zero** `Count cleared` rows. `NOT EXISTS` with `=` treats a NULL `ingredient_id` as matching nothing, which is what R9 asks. (Such a payload still fails later, at the loop's insert, through `eod_entries_check_store_trg`, so today it rolls back anyway. The CTE's correctness shouldn't lean on that.)
- **Duplicate ingredient ids.** `NOT EXISTS` is a semi-join, so a payload that names an item twice can't multiply audit rows the way a `join` would. The loop then raises 23505 on the second insert and the whole call rolls back, audit rows included (AC-26).
- **`coalesce(p_entries, '[]'::jsonb)`** mirrors the admin branch's second delete (189 L203). The staff wrapper's O-1 block guarantees a non-empty array before this point, so the coalesce only matters for a hypothetical future NULL-branch caller: a NULL payload then audits every deleted row, which is the right answer for a whole-set erase. A non-array payload would raise `jsonb_to_recordset`'s own 22023 here instead of in the loop; same code, same rollback.
- **A legacy row with `item_id` NULL** (the column is nullable, init L131) is deleted as today, and now also audited, with `item_ref` NULL from the left join. That's consistent with "one row per deleted entry not re-sent". The insert trigger makes such rows unreachable for new writes, so no arm pins it.
- **`user_id = auth.uid()`** is the caller: the store member, or the privileged caller of the staff RPC (AC-27). It differs from the per-entry staff row's legacy `user_id NULL` by design, because R9 asks for the admin shape. `audit_log.user_id` references `profiles(id)`. Store members always have a profile (`user_stores.user_id` references `profiles`, init L32). A JWT-only admin or master with no `profiles` row would now get 23503 on a re-submit that drops an item; the admin branch already has that posture, it's unreachable for real accounts, and no fixture does it (§6.6).
- **No RLS involvement.** The writer runs as the wrapper's owner (`postgres`), which owns `audit_log` and bypasses its RLS (no FORCE RLS; `20261022000000` L56, L129). The restrictive insert policies (actor-is-caller, server-only actions, `created_at = now()`) don't apply, exactly as for the admin branch. `created_at` takes its default `now()`.
- **Comment text inside the hunk must not contain the literal `'Count cleared · vendor: '` with its leading quote,** because AC-28's structural arm counts that token (§6.5).

#### 2.6 Writer ACL: re-issue the revoke (and why the wrapper doesn't get one)

- `create or replace` of an existing function keeps its `proacl`. Spec 097's `alter default privileges … grant all on functions to anon, authenticated, service_role` (`20260618000000`) applies only when a function is **created**. So on a 189 database the writer's ACL stays as 189 left it (owner only), with or without a revoke.
- **Decision: re-issue 189's revoke for the writer, verbatim.** The writer has no gate of its own; its revoked ACL is its boundary (189 comment: "it must stay that way"). If this file ever created the function instead of replacing it, the default privileges would hand EXECUTE to `anon`, `authenticated` and `service_role`. The pre-flight (§2.2 step 0) already makes that unreachable, so the revoke is defence in depth. It's a no-op on prod, and it doesn't touch `prosrc`, so the md5s are unaffected.
- **The wrapper keeps the first pass's "no grant or revoke".** It gates itself (store gate, 42501), so a default-privileges accident there is not a gateless write, and adding `revoke … grant … to authenticated` would only enlarge the diff. AC-8 pins its ACL.
- AC-28 pins the writer's outcome either way (§6.5). That arm must also assert `proacl is not null`: a NULL `proacl` means "default privileges", which for functions is EXECUTE to PUBLIC, and `aclexplode(NULL)` returns no rows, so a "no PUBLIC grantee" check alone would pass vacuously.

#### 2.7 Byte-for-byte rule (writer) and the combined diff

The 193 writer body must equal the landed 189 writer body with exactly the §2.5 change. Paste a second `diff` (189 writer body vs 193 writer body, both from the migration files) under `## Files changed`. It must show **one hunk** inside the `if p_removed_item_ids is null then` arm: the bare `delete from public.eod_entries where submission_id = v_submission_id;` line removed, the comment lines and the CTE added, nothing else. Also diff the two comment statements and say in one line that each is "spec 193 sentence + 189 text verbatim".

`admin_submit_eod` is **not** in this migration. State that under `## Files changed`; §9 checks its md5 is unchanged on prod.

### 3. The refusal contract (R2)

#### 3.1 SQLSTATE: `22023`

- **HTTP mapping.** PostgREST sends 42501 to 403 (or 401 for anon), `P0001` to 400, other `P0xxx` to 500, `PTxyz` to HTTP xyz, and most other codes, including class 22, to **400**. `22023` therefore gives the 400 that AC-11 asserts, and it isn't 42501 or a `PT403`-style code.
- **Why not `P0001`.** It would also give 400. `22023` is what this wrapper already raises for bad arguments (step 1's null vendor, O-1), and what `admin_submit_eod` uses for its argument refusals (189 §3.1). An out-of-window date is a bad argument. It also keeps the code out of the `P0` family, where a later "make it specific" edit to `P0xxx` would quietly turn it into a 500.
- **Why not `22007` / `22008`.** Postgres raises those itself for malformed or out-of-range date input, so they'd look like a parse error rather than a policy refusal.
- **Sharing 22023 with O-1 and the vendor check is fine.** The message tells them apart, and AC-4's `throws_ok` pins both code and message. A future "needs attention" UI that wants to key on this refusal should match the message prefix, or the follow-up spec can add a machine-readable HINT then. Nothing in this spec needs one.

#### 3.2 Message

Exactly: `staff_submit_eod: p_date is outside the staff window (35 days back to 1 day ahead, America/New_York)`

- Lower-cased, it contains none of `42501`, `network request failed`, `failed to fetch`, `aborted`, `timeout`. ("outside" isn't "timeout".) It also avoids the word `network`, so the `name === 'typeerror' && msg.includes('network')` arm can't match either.
- **Constant, with nothing interpolated.** Interpolating a uuid could put the five characters `42501` in the hex, which `isForbidden` L67 would match, and that would dequeue the item and lose the count. Interpolating a date depends on `DateStyle`. A constant can be asserted exactly by `throws_ok`, AC-9 and AC-11.
- The `staff_submit_eod:` prefix matches the wrapper's other messages.

#### 3.3 Trace through the shipped client

`supabase.rpc` returns a `PostgrestError`. In the installed `@supabase/postgrest-js` it extends `Error` with `code`, `details` and `hint`, and has **no `status`** field. `callStaffSubmitEod` throws it (L108).

- `isForbidden`: `code` is `'22023'`, not `'42501'`; `status` is undefined; the message has no `42501`. Result: **false**.
- `isNetworkError`: no matching message substring, and `name` is `PostgrestError`, not `aborterror` or `typeerror`. Result: **false**.
- So the drain takes the "other error" branch (L197-204): `bumpEodAttempts(uuid, err.message)`, the item stays, and the loop continues. An online `submit` returns `{ kind: 'failed', message: t('eod.toast.failed') }` (L302-305), and the item **isn't queued**. That's the posture the spec accepts.

### 4. Anchor (R6)

- `now()` is the transaction start as a `timestamptz`. `timestamptz AT TIME ZONE 'America/New_York'` converts using the named zone, so neither the session `TimeZone` nor PostgREST's `Prefer: timezone=` header can move it. Plain `current_date` would move with both. `p_date` is a `date`, which has no zone, and PostgREST's ISO-format JSON argument parses the same under any `DateStyle`.
- **The PostgREST version wasn't checked** (no shell here). The design doesn't depend on it: the anchor ignores session time zone whether or not the deployed PostgREST honours `Prefer: timezone`. AC-21 (§6.1) proves the independence at the database layer, because `set local timezone` is the same mechanism PostgREST uses.
- **Device time zones against the bounds.** Device-local "today" is at most 19 hours ahead of New York (UTC+14 against EST UTC-5), so it's never later than A + 1. It's at most about 8 hours behind (UTC-12 against EDT UTC-4), so it's never earlier than A - 1. "Yesterday" from any real device is therefore at least A - 2. The `A + 1` upper bound can't refuse a correctly clocked device anywhere. e2e's `todayIso()` on a UTC runner is A or A + 1.

### 5. Surfaces with no change

- **RLS:** none. No new table and no policy change. The direct-table INSERT paths stay open, as the named follow-up says. The new `Count cleared` rows are written by the owner and bypass `audit_log` RLS, exactly like the admin branch's (§2.5). Who can **read** them is unchanged: `store_member_read_audit_log` (store members of that store) and privileged callers. `audit_log_restrict_select_store_user_actions` doesn't hide them (it filters only the two store-user actions).
- **API contract:** the same PostgREST RPC `POST /rest/v1/rpc/staff_submit_eod`, with the same request and the same success envelopes (`{submission_id, conflict:false, entry_ids, stock_updates}` and `{submission_id, conflict:true, reason}`). R9 changes no envelope: the audit rows are a side effect, not a response field. One new error case: **HTTP 400, `{"code":"22023","message":"<§3.2>","details":null,"hint":null}`** for a non-privileged caller with `p_date` NULL, earlier than A - 35 or later than A + 1. Existing error cases are unchanged and still fire first: vendor NULL (22023), store gate (42501, HTTP 403), and a processed uuid (a 200 conflict, not an error). R9 adds no new error case for real accounts (§2.5 `user_id` bullet).
- **`admin_submit_eod`:** not replaced, not called differently. It never takes the NULL branch.
- **`audit_log` volume.** One row per dropped item per staff re-submit. The staff UI's completeness gate (`EODCount.tsx` L808-830) sends every listed item, so an ordinary re-submit drops nothing. Rows appear when the set at the triple holds items the current call doesn't send: an attack or buggy client (the M1 case), or **legitimate drift**, such as an admin-added off-vendor entry, or an item unlinked from the vendor between the first submit and the re-submit. In the drift case the staff path erased that entry before this spec too; now it says so. The owner should expect a few such rows; they aren't noise, but they aren't all hostile either.
- **Retention of the new rows** (asked under Residual risk): `audit_log` rows live **90 days, plus up to one day** for the nightly prune (`prune_audit_log_and_invitations`, `20261108120000` L46-47, cron `47 8 * * *` UTC). Nobody can delete one through the API before 90 days (`admin_delete_audit_log`, `20261022000000` L152-162). After 90 days the prune removes them, and the erased value with them. Store/brand deletion cascades them as for every audit row.
- **Notifications:** none. No trigger on `audit_log` writes `notifications` (or anything else). Migration grep on 2026-11-09: there's no trigger on `audit_log` at all. The notification triggers are on `eod_submissions` (`notify_eod_submission`, `notify_eod_resubmission`), `inventory_counts`, `waste_log` and `purchase_orders` (`20260715000000`, `20261027000000`). R9 doesn't change the parent upsert, so `eod`/`eod_update` firing is unchanged.
- **Edge functions:** none. `verify_jwt` doesn't apply.
- **`src/lib/db.ts`:** none. The admin surface doesn't call `staff_submit_eod`. The staff subtree calls it directly, inside the documented spec 063 carve-out, and isn't changed. The admin surface's existing audit-log reads show the new rows with no code change.
- **Realtime:** none. No publication change, so the `docker restart supabase_realtime_imr-inventory` step doesn't apply. `audit_log` isn't in `supabase_realtime` (`20261022000000` L60), so the new rows replay on no channel. A refused call writes nothing, so nothing replays on `store-{id}`.
- **Frontend store:** none. `useStore.ts` isn't touched, and `useStaffStore` / `useEodSubmit` aren't touched (owner decision Q4).

### 6. pgTAP

#### 6.1 New file: `supabase/tests/staff_submit_eod_date_bound.test.sql`

The suite runs inside `begin; ... rollback;` with `plan(N)`, where N is the final arm count across this section **and §6.5** (the R9 arms live in the same file, after the date-bound arms). In the fixture `do` block, as `postgres`:

- Compute `A` with the same expression and store it via `set_config('test.anchor', ...)`. The value is fixed for the whole transaction.
- Resolve: Frederick; the seed manager (`22222222-...`, JWT `user`, member of Frederick, as in `staff_role_eod_rls`); Charles (not a member); vendor V and a Frederick item linked to V through `item_vendors`, so the on-hand claims in AC-3 mean something; and a second vendor V2 at Frederick (or a second member store) for the first-time triples.
- **Pre-delete** every triple the suite touches: (Frederick, A-36, V), (Frederick, A-36, V2), (Frederick, A-35, V2), (Frederick, A+1, V2), (Frederick, A+2, V2). Section 6.2 explains why.
- **Seed S** as `postgres`: a submission at (Frederick, A-36, V) with a known `client_uuid` X and two entries. Snapshot S's parent columns, its entries (ids and values), the linked item's `current_stock` / `eod_remaining`, the `audit_log` count for Frederick and the `notifications` count for S into temp tables, for the "unchanged" reads.

Arms, as the store member unless stated. Read "unchanged" and "no row" claims back as `postgres` (`reset role`, check, then re-set the role and claims):

| Arm | Covers |
|---|---|
| First-time (Frederick, A-36, V2), new uuid: `throws_ok(..., '22023', '<§3.2>')`; then no parent at that triple | AC-1, AC-13, AC-4 |
| (Frederick, A-35, V2): succeeds, `conflict = false` | AC-2 |
| (Frederick, A+2, V2): `throws_ok` with the same code and message; no parent at that triple | AC-14 |
| (Frederick, A+1, V2): succeeds, `conflict = false` | AC-14 |
| Over S, new uuid: `throws_ok`; then S's `submitted_at`, `status`, `client_uuid`, entries, on-hand, the Frederick `audit_log` count and the `notifications` count for S all equal the snapshot | AC-3, R5 |
| Lint arm: catch the AC-1 call in a `do` block into `SQLSTATE` / `SQLERRM`; `ok(sqlstate <> '42501' and sqlerrm !~* '42501\|network request failed\|failed to fetch\|aborted\|timeout')` | AC-4 |
| Replay X at A-36: `conflict = true`, `submission_id = S.id`; S still equals the snapshot | AC-6 |
| Charles at A-36: `throws_ok(..., '42501')` | AC-7 |
| `p_date` NULL: `throws_ok(..., '22023', '<§3.2>')` | AC-20 (new) |
| Under `set local timezone = 'Etc/GMT-14'`: A-36 and A+2 refuse, A-35 and A+1 succeed. Repeat under `'Etc/GMT+12'`. Then `reset timezone` | AC-21 (new), R6 |
| JWT `admin` (profile in Frederick's brand), JWT `master` (same), and a JWT `user` whose `profiles.role = 'super_admin'` (set as `postgres` in the transaction): each succeeds at (Frederick, A-36, V2) and at (Frederick, A+2, V2) | AC-5 (6 arms). Run these **after** the "no row" arms, because they create rows |
| Catalog: signature exists; `prosecdef`; `proconfig` contains `search_path=public`; `authenticated` has EXECUTE, `anon` and `service_role` don't | AC-8 |
| Structural pin: `prosrc` contains `America/New_York` and doesn't contain `current_date` | R6 regression guard |

Why AC-21 uses two zones: under a `current_date` implementation, `Etc/GMT-14` shifts the date only when New York's clock reads 05:00 or later, and `Etc/GMT+12` only before 07:00. Between them every time of day is covered, so the arm catches a regression whenever CI runs.

For the super_admin arm, mind spec 164/163's `profiles` guards and the `profiles_sync_role_to_jwt` trigger when you update the role inside the transaction. Use a dedicated profile, not the store member's, so later member arms stay non-privileged. Seed any existing super_admin the same way if that's simpler.

#### 6.2 Fixture rework (the 9 sites in 7 suites, plus 189's `admin_submit_eod`)

Fixtures must use dates relative to the anchor, `A - k` with `2 ≤ k ≤ 34`, never today or yesterday. Each suite gets its own `k`, which makes greps unambiguous, though the runner is serial and every suite rolls back, so suites can't collide with each other. In each suite's fixture block, as `postgres`, compute the date into a `test.*` setting, and replace the literal **everywhere that triple's date appears in the file**: calls, read-backs and replays.

| File | Sites (pre-189 line numbers; re-grep) | New date |
|---|---|---|
| `staff_submit_eod_cases_each` | L143 (client_a) | A - 10 |
| same | L187 (client_c) | A - 11 |
| same | L237, out-of-membership | **keep `1999-12-28`**. It now also checks that 42501 beats the bound |
| `eod_no_need` | L286 | A - 12 |
| same | L302 **and the L408 read-back** | A - 13 |
| `eod_update_notifications` | **every** `date '1999-11-02'`: the staff call, the admin calls, the replay and the L258 read-back. They're one triple chain and must move together | A - 14 |
| same | `1999-11-01`, `1999-11-03`, `1999-11-04` (direct `postgres` inserts) | keep, since direct inserts aren't bounded |
| `audit_log_rls_hardening` | W-1, L445 | A - 15. W-3's `1999-12-27` stays (`record_missed_orders_for_day`, not this RPC) |
| `inventory_items_identity_lock` | T22, L455 (inside `format(...)`: pass the date as `%L`) | A - 16 |
| `eod_submissions_multi_vendor` | L169 | A - 17 |
| `staff_role_eod_rls` | L148 call **and the L180, L199, L280 read-backs and the L350 replay** | A - 18 |
| same | L233 `2026-05-23`, out-of-membership | keep |
| `admin_submit_eod` (189) | ST block D3 = `date '1999-12-03'`: the store-member call (L303), `sub_of` (L315), the admin call over it (L380), the replay (L436), the three O-1 refusal arms (77)-(79) (L940, L948, L956) and the empty replay (L963). **Every** `1999-12-03` in the file moves together; they're one triple chain | A - 19 |
| same | Every other date: `1999-11-16` (direct postgres insert), `1999-12-01`/`02`/`04`/`05`/`06`/`07`/`09`/`10` (admin calls, exempt), `current_date - 200` (AC-33, seeded through `admin_submit_eod` under the admin JWT at L856, exempt), and the L746 store-member call (it's `admin_submit_eod`, refused 42501 by its own gate) | keep |

Notes on the `admin_submit_eod` rework:

- **Why the O-1 arms move too.** At `1999-12-03` they'd still pass, because the O-1 block sits before the date block. But that makes them depend on which of the two fires first, which R3 forbids. Moved to A - 19 they test O-1 alone.
- **No pre-delete needed there.** Store `a1` and vendor `f1` are created inside the transaction with fixed `18900000-…` ids (file L56-58), so `(a1, A - 19, f1)` can't pre-exist. If it somehow did, the fixture insert of `a1` would already have failed.
- **Collisions inside the file.** A - 19 can't equal any kept date for `(a1, f1)`: the 1999 dates are far outside, and `current_date - 200` is ≥ 199 days back.
- **Readers.** The file's reader arms (RD, (86)-(96)) run on stores `a3`/`a4` only, so moving a1's D3 into the window changes no reader result.
- **R9 effect: none.** The ST call is a first submit (no prior rows, so the CTE deletes nothing), the replay is a conflict, and the O-1 arms raise before the writer. So (22) still counts 4, (30) still finds exactly one `Count cleared` row for C3 (the admin's), and the `snap`/`state_of` audit counts around the refusal arms are unchanged. (96) filters stores `a3`/`a4`, which only ever see admin calls.
- Update the header comment at L56-58: D3 is anchor-relative because spec 193 bounds store-member dates.

**Pre-delete, where a triple can pre-exist.** The old 1999 dates couldn't collide with anything. In-window dates can: rows from admin UI use, manual testing or the reworked smoke script (§8) on a non-reset local stack can sit at the same triple. A leftover row turns the suite's first call from an INSERT into an UPDATE. 189's upsert keeps the old `client_uuid`, so lookups by uuid fail, and in `eod_update_notifications` the notification type flips from `eod` to `eod_update`. **With R9 it also turns a first submit into a full replace that drops the leftover row's other items, writing `Count cleared` rows the suite never expected** (§6.6). So in each fixture block, as `postgres`, `delete from public.eod_submissions where store_id = … and date = … and vendor_id = …` for each triple the suite writes through the RPC **whose store and vendor both persist outside the transaction** (seed rows). `eod_entries` cascades (init L130), `order_approvals.source_submission_id` is `on delete set null` (spec 178), there are no delete triggers on either table (the only `eod_entries` trigger is BEFORE INSERT OR UPDATE, `20260514120030` L137), and the transaction rolls it all back. A triple built on an in-transaction vendor or store can't pre-exist and needs no pre-delete; one is harmless if the builder prefers uniformity. Known cases: `staff_role_eod_rls` uses a seed vendor (`select id from public.vendors limit 1`, L72) at seed Frederick, so it **needs** the pre-delete; `eod_no_need` uses its in-transaction `SPEC172-V3-<tag>` vendor and `admin_submit_eod` its in-transaction `a1`/`f1`, so they don't. Check the rest at build time. Also check that each suite's `audit_log` / `notifications` assertions are deltas or keyed to the new submission id, not raw per-store counts that leftover rows could inflate.

Rewrite the header comments that justify the `1999-*` dates ("avoids smoke residue"). They become: "anchor-relative because spec 193 bounds store-member dates; leftover rows handled by the pre-delete."

**Readers.** If any reworked suite also asserts a "latest submission" reader (last counted, reorder, variance) in the same transaction, an in-window date could now be the latest. Re-check each of the 7 files. None of them looked like they did when this design was written.

#### 6.3 Other suites to re-grep at build time

- **189's `admin_submit_eod.test.sql`.** Now covered in §6.2 (the ST/O1 D3 chain). Its AC-33 200-day-old submission is seeded through `admin_submit_eod` under the admin JWT (L856), so it's unaffected. Re-check the landed file: if 189 changed how it seeds that row (e.g. through `staff_submit_eod` as a store member), seed it with a direct insert as `postgres` or under an admin JWT, keeping the 200-day age.
- **`eod_update_notifications`.** If R8 applies, AC-19's five `'[]'` payloads change too. In the working tree they've already been swapped for `test.payload` by 189's O-1 build.
- **Anything else** that calls `staff_submit_eod` as a non-privileged caller at a date outside `[A-35, A+1]`.

#### 6.4 AC-12 gates

All suites in §6.1 to §6.3 and §6.5 to §6.6, the full `npx jest`, `typecheck` and `typecheck:test`. The jest arms below compile under the test graph, which is a CI gate jest doesn't run. Run the **whole** pgTAP runner (`scripts/test-db.sh`), not a subset: R9 changes a function every staff suite calls.

#### 6.5 R9 arms (AC-22 to AC-28), same file

**Fixture (add to the §6.1 `do` block, as `postgres`).** Use in-transaction rows, the `eod_no_need.test.sql` L62-133 pattern, so every R9 triple is fresh by construction and every name and value is exact:

- `test.tag` = 8 chars of a random uuid. Vendor `VR` = `'SPEC193-VR-<tag>'` in Frederick's brand.
- Catalog rows `C1`..`C4` = `'SPEC193-C<n>-<tag>'`, unit `'lbs'`. Inventory items `I1`..`I4` at Frederick on those catalog rows, `current_stock = eod_remaining = 42`, each with an `item_vendors` link to `VR`.
- Seed submissions **as `postgres`** (direct inserts into `eod_submissions` and `eod_entries`, `status 'submitted'`, a fixed literal `submitted_at`, a known `client_uuid` each), on distinct in-window dates for `(Frederick, ·, VR)`:

| Name | Date | Entries | Used by |
|---|---|---|---|
| `S_a` | A - 20 | I1 = 10, I2 = 20 | AC-22 |
| `S_b` | A - 21 | I1 = 10, I3 NO NEED (`no_need = true`, numerics NULL), I4 numeric-NULL (`no_need = false`, `actual_remaining` NULL) | AC-23 |
| `S_c` | A - 22 | I1 = 10, I2 = 20; `client_uuid` = `Xc` | AC-25 |
| `S_d` | A - 23 | I1 = 10, I2 = 20 | AC-26 (O-1, 23514, 23505) |
| `S_e` | A - 24 | I1 = 10, I2 = 20 | AC-27 |
| (none) | A - 25 | (first submit) | AC-24 |
| `S_f` | A - 36 | I1 = 10, I2 = 20 | AC-26 (date refusal) |

The seeded on-hand (42) differs from every seeded entry value on purpose, so "on-hand unchanged" can fail.

**Helpers** (pg_temp functions, as in `admin_submit_eod.test.sql`): `cc(p_item_ref)` = count of `Count cleared` rows (`action = 'EOD entry' and detail like 'Count cleared%'`) for Frederick with that `item_ref`; `cc_all()` = the same for `item_ref like 'SPEC193-%-' || tag`; `pe(p_item_ref)` = count of per-entry staff rows (`user_id is null and detail not like 'Count cleared%'`) for Frederick with that `item_ref`; `entries_of(sub)` = the `item:value` string the 189 helper builds, ids included. Snapshot before each call, assert deltas after, read back as `postgres`.

| Arm | Covers |
|---|---|
| Store member over `S_a`, new uuid, payload `[I1 = 11, unit 'lbs']`. `entries_of(S_a)` holds only I1 = 11 | AC-22 (full replace unchanged) |
| `cc_all()` delta = 1. The new row's `format('%s|%s|%s|%s|%s', store_id, user_id, detail, item_ref, value)` = `Frederick|<manager uid>|Count cleared · vendor: SPEC193-VR-<tag>|SPEC193-C2-<tag>|20 lbs`. Description: **"(…) AC-22 probe P7 re-run: a staff full replace that drops I2 writes one Count cleared row for it (189 M1)"** | AC-22 |
| `cc('SPEC193-C1-<tag>')` delta = 0 | AC-22 |
| `pe('SPEC193-C1-<tag>')` delta = 1, and that row's `detail` = `<manager uid> · vendor: SPEC193-VR-<tag>` | AC-22 |
| Store member over `S_b`, payload `[I1 = 12]`. `Count cleared` values for C3 and C4 = `'NO NEED'` and `''` (one arm each, or one `string_agg` arm) | AC-23 |
| I3 and I4 `current_stock`/`eod_remaining` = 42/42 | AC-23 |
| First submit at `(Frederick, A - 25, VR)`, payload `[I1, I2]`: `cc_all()` delta = 0; `pe` delta = 1 for each | AC-24 |
| Replay `Xc` over `S_c` (payload `[I1]`, which would have cleared I2): `conflict = true`, `submission_id = S_c`; Frederick's total `audit_log` count delta = 0 | AC-25 |
| Store member over `S_c`, new uuid, payload `[I1 = 13, I2 = 23]`: `cc_all()` delta = 0; `pe` delta = 1 each | AC-25 |
| Over `S_f` (A - 36), payload `[I1]`: `throws_ok(…, '22023', <§3.2>)`; then `cc_all()` delta = 0 and `entries_of(S_f)` unchanged | AC-26, AC-3 |
| Over `S_d`, payload `'[]'`: `throws_ok(…, '22023', 'staff_submit_eod: p_entries must be a non-empty array')` (the landed O-1 text); then delta 0, `entries_of(S_d)` unchanged | AC-26 |
| Over `S_d`, payload `[I1 = 14, {ingredient_id: I3, no_need: true, actual_remaining: 1}]`: `throws_ok(…, '23514')`; delta 0, `entries_of(S_d)` unchanged. The CTE would have audited I2 before the loop failed; the arm proves the rollback took it | AC-26 |
| Over `S_d`, payload `[I1 = 14, I1 = 15]`: `throws_ok(…, '23505')`; delta 0, `entries_of(S_d)` unchanged | AC-26 |
| JWT `admin` (seed admin `1111…`, which has a profile; confirm `auth_can_see_store(Frederick)` for it in the fixture) over `S_e`, payload `[I1]`: `cc('SPEC193-C2-<tag>')` delta = 1, and that row's `user_id` = the admin uid with the AC-22 detail/value shape (`|20 lbs`) | AC-27 |
| Writer catalog: `prosecdef = false`; `proconfig = array['search_path=public']`; `proacl is not null`; no `aclexplode(proacl)` row with `grantee = 0` (PUBLIC); `has_function_privilege` false for `anon`, `authenticated`, `service_role` | AC-28 |
| Writer structural: the number of occurrences of the literal `'Count cleared · vendor: '` (with its leading single quote) in `prosrc` = **2** (one per branch). Compute it as `(length(prosrc) - length(replace(prosrc, tok, ''))) / length(tok)` | AC-28 |
| Writer structural: `prosrc` contains `not exists` | AC-28 / §2.5 NOT-IN regression guard |

Notes:

- **Order.** Put the 23514 and 23505 arms after the O-1 arm on `S_d`; each leaves `S_d` unchanged, so they can share it. Put AC-27 last among the R9 behaviour arms, since it switches claims. All claims switches follow the §6.1 rule (`reset role`, check as `postgres`, re-set role and claims).
- **Why AC-26 needs the writer-error arms.** They're the only arms where audit rows are actually inserted and then rolled back. Without them, a regression that moved the audit into a separate, autonomous path (e.g. a `dblink` or a deferred job) would pass every other arm.
- **AC-28's "admin path unchanged"** is the existing `admin_submit_eod.test.sql` suite, run unmodified apart from the §6.2 D3 date move. Its (3), (4), (8)-(10) arms also re-check the writer's posture.
- **`'20 lbs'`** follows from `trim_scale(20.000)` and the catalog unit. If the landed 189 `value` expression differs, the expected strings follow the landed expression.

#### 6.6 Audit-fixture checks (the PM's R9 table, resolved)

| File | Assertion | Verdict |
|---|---|---|
| `staff_role_eod_rls` | (4) L211-219, latest `'EOD entry'` row by `order by id desc` | **Covered by the pre-delete; no assertion change.** The suite's only writing call (L145) is a first submit once its seed-vendor triple is pre-deleted (§6.2), so R9 writes nothing. Note: `audit_log.id` is a random `uuid_generate_v4()` (init L197), so "`order by id desc limit 1`" isn't time order; it's stable only because the transaction writes one `'EOD entry'` row for Frederick. That's pre-existing and out of scope. Don't "fix" it here; the pre-delete is what keeps the row count at one. |
| `eod_no_need` | (25) L357-364 and (29) L388-395, scalar subqueries per `item_ref` | **No change needed, no pre-delete needed.** Its triples use the in-transaction vendor `SPEC172-V3-<tag>` and tagged item names, so the L283 call is always a first submit and no other row can carry those `item_ref`s. The 23514 call (L301) rolls back. |
| `audit_log_rls_hardening` | W-1 L456-464, `user_id is null` count = 1 | **No change.** `Count cleared` rows carry `user_id = auth.uid()`, so the filter excludes them; and with the pre-delete the call is a first submit anyway. |
| `admin_submit_eod` | (22), (30), (96), `snap`/`state_of` | **No change** beyond the D3 date move (§6.2 notes). |
| `eod_update_notifications` | No `audit_log` assertions; counts `notifications` | **No change.** Every re-send (`L245`, `L296`, `L696` in the post-189 tree) uses the same one-item `test.payload` (L105-108) as the first submit, so nothing is cleared. Even if something were, no trigger on `audit_log` writes `notifications` (§5). Its vendor `f2` is an in-transaction fixed id, so no pre-delete is needed. |
| `staff_submit_eod_cases_each`, `inventory_items_identity_lock`, `eod_submissions_multi_vendor` | No `audit_log` assertions (grep on 2026-11-09) | **No change.** R9 rows can't break them. The only new failure mode would be a 23503 on `audit_log.user_id` for a caller without a profile, and all three call as the seed manager (`22222222-…`), who has one. |

### 7. Jest (AC-9, AC-10), test-only, `src/screens/staff/hooks/useEodSubmit.test.ts`

Feasible. Both follow existing tests.

- **Error fixture.** Build it as the real shape, an `Error` with `name: 'PostgrestError'`, `code: '22023'`, `message: <§3.2 exact>`, and `details` / `hint` null. Use `new PostgrestError({...})` if it imports cleanly under jest, otherwise `Object.assign(new Error(MSG), {...})`. The existing plain-object fixtures (`{ message, code }`) never reach the `err instanceof Error ? err.message : 'unknown'` branch, and this one should. Declare `MSG` once in the test, with a comment naming the migration it mirrors, since nothing ties the two together except review.
- **AC-9.** Copy the L256 shape: two queued items, `q-old` first in FIFO, then `q-good`. The first `mockRpc` call resolves with the refusal error, the second succeeds. Assert: `mockRpc` called twice (the loop didn't `break`); `q-old` still queued with `attempts === 1` and `lastError === MSG` (or a `bumpEodAttempts` spy called with `('q-old', MSG)`); `q-good` dequeued; and no `syncErrorBanner` toast (which the dequeue branch would show).
- **AC-10.** Copy the L167 shape: an online `submit` gets the refusal and returns `{ kind: 'failed', message: t('eod.toast.failed') }`, and `eodQueue` stays empty (not `'queued'`, not `'forbidden'`).

### 8. Smoke: `scripts/smoke-staff-eod.sh`

**Prod safety, decided: the script becomes local-only, with no override.** Even today it isn't prod-safe. Step 8b primes a real linked item's `current_stock` to 7, and the on-hand write isn't gated by date. In-window dates would add a path that replaces a real count. So:

1. **Guard, before login.** Pull the host out of `SUPABASE_URL`. Unless it's `127.0.0.1` or `localhost`, print why and `exit 2`, so no token is ever fetched. **No env flag to override it**, because one would bring the prod path back. Remove the `SUPABASE_URL=https://... # remote override` usage line, and replace the "no collision with real prod data" rationale in the comments.
2. **Anchor.** `A_NY=$(TZ=America/New_York date +%Y-%m-%d)`. Compute offsets from New York's today: BSD `TZ=America/New_York date -v-${k}d +%F`, GNU `TZ=America/New_York date -d "${k} days ago" +%F`. Keep the existing BSD/GNU split.
3. **Pick free in-window dates for steps 5 to 7 and 8b.** Use candidates `k ∈ [3, 33]` in a uuid-seeded order (like today's `DAY_OFFSET`). Take the first `D` where the store member's `GET /rest/v1/eod_submissions?store_id=eq.S&vendor_id=eq.V&date=eq.D&select=id` returns `[]`. Do it separately for (Frederick, `VENDOR_ID`) and (Frederick, `NN_VENDOR_ID`). If none is free, fail with "no free in-window date; run `npx supabase db reset`". A fresh triple matters: step 6 looks up by `client_uuid` and step 7's replay needs that uuid stored, but 189's `coalesce` keeps an older uuid on an existing row. `k ≥ 3` and `≤ 33` keep clear of today, yesterday and both bounds, so a run that crosses New York midnight can't flip an outcome.
4. **Step 8, out-of-membership.** Use the step-5 date, which is in the window, so the step still tests the store gate rather than the bound.
5. **New step (AC-11).** As the store member, Frederick, `VENDOR_ID`, `p_date = A - 36`, a fresh uuid, one entry. Assert HTTP **400** (fail on 403 and on 200), body `.code == "22023"` and `.message ==` the §3.2 text exactly, and that `GET eod_submissions?client_uuid=eq.<that uuid>` returns `[]`. Don't assert "no row at the triple", because real local data at A - 36 can exist. A script that computes A before the call can never see a server A earlier than its own (same clock), so A - 36 stays out of the window even across midnight.
6. **Cleanup, best effort.** Add a `trap ... EXIT` that runs `docker exec "${CONTAINER:-supabase_db_imr-inventory}" psql -U postgres -d postgres -c "delete from public.eod_submissions where client_uuid in (...)"` for `CLIENT_UUID` and `PRIME_UUID`. Step 8b's stored uuid is `PRIME_UUID`, since `coalesce` keeps it. On failure, print a warning and don't fail. That stops smoke rows from using up the 31 free dates. It's local by construction, matching `scripts/test-db.sh`'s container default. `audit_log` / `notifications` rows and step 8b's on-hand of 7 remain as local residue, as they do today.

The existing step 9 (410 stubs) is unchanged.

**No R9 smoke step.** R9 has no HTTP-visible effect (no envelope or status change), so the smoke would only repeat pgTAP. The script's existing re-submit steps send the same payload as the first submit, so they write no `Count cleared` rows. If a step's payload is changed in the rework so a later call drops an item, it starts writing them; that's harmless local residue.

### 9. Prod apply (owner, later; not part of this build)

Project `ebwnovzzkwhsdxkpyjka`, via MCP `execute_sql`, only on the owner's go-ahead, and **only after 189's migration is on prod and verified** (189 §14).

**Order and path (fold-in a, 2026-11-10; architect S1 + N1):** apply via the Supabase MCP path (`execute_sql` of the migration body, then an explicit `insert into supabase_migrations.schema_migrations` of version `20261109190000`), **not** `supabase db push`. The version sorts before other sessions' pending migrations (`…191000`, `…195000`, `…200000`, `…230000`, `20261110120000`), so it's an out-of-order version by design and `db push` would need `--include-all`. Apply **BEFORE pushing this commit to `main`** (or hold the push until the owner applies it): pushing first turns `db-migrations-applied.yml` red on `20261109190000` missing from prod (the 2026-06-28 failure mode).

**Prod baseline md5s (recorded after spec 189's prod apply).** Normalizer: `md5(lower(regexp_replace(regexp_replace(pg_get_functiondef(oid), '--[^\n]*','','g'),'\s+',' ','g')))`.

| Function | Prod normalized md5 after 189 |
|---|---|
| `eod_write_submission` | `610bd4b0fca6aeeb9181fbf9bc8190aa` |
| `staff_submit_eod` | `1e86fe304c78a7971850bbe9b92388a6` |
| `admin_submit_eod` | `27e88465eeb798aa751e485d9416fc2c` (must be **unchanged** after 193) |

Re-check all three on prod right before applying. If `eod_write_submission` or `staff_submit_eod` differs from this table, prod isn't running the body this migration edits: stop and ask the owner. After the apply, `eod_write_submission` and `staff_submit_eod` move (to the local 193 bodies' normalized md5s); `admin_submit_eod` must still read `27e88465eeb798aa751e485d9416fc2c`.

1. **Pre-checks (read-only; stop and ask the owner on anything unexpected):**
   - 189's final version is in `supabase_migrations.schema_migrations`.
   - The normalized md5 of prod's `staff_submit_eod` matches the **landed 189** wrapper body, **and** the normalized md5 of prod's `eod_write_submission` matches the **landed 189** writer body. A mismatch on either means prod isn't running the body this migration edits; stop.
   - Record prod's `admin_submit_eod` normalized md5 too (it must not move; step 3).
   - *Optional, informational, not a gate:* how many recent writes would have been refused. `select count(*) from public.eod_submissions where submitted_at > now() - interval '90 days' and date < (submitted_at at time zone 'America/New_York')::date - 35;` This counts admin writes too, so it's an upper bound.
2. **Apply:** run the migration body (its pre-flight `do` block re-checks 189's presence), then insert the exact final version into `schema_migrations`.
3. **Verify, per function:**
   - `staff_submit_eod`: normalized md5 = the local 193 wrapper body; `prosecdef = true`; `proconfig = {search_path=public}`; `proacl` = owner plus `authenticated=X` only; comment starts with `spec 193:`.
   - `eod_write_submission`: normalized md5 = the local 193 writer body; `prosecdef = false`; `proconfig = {search_path=public}`; `proacl` = owner only (not NULL, no PUBLIC/`anon`/`authenticated`/`service_role` entry); comment starts with `spec 193:`; `prosrc` holds the literal `'Count cleared · vendor: '` twice.
   - `admin_submit_eod`: md5 unchanged from step 1.
4. *Optional behaviour probe (date bound only):* in one `execute_sql` call, `begin; set local role authenticated; set local request.jwt.claims = '<a real store member, role user>'; select public.staff_submit_eod(<new uuid>, <their store>, <A - 36>, ...); rollback;`. Expect 22023 with the §3.2 message. It raises before any write, and the `rollback` covers it anyway. Owner's choice. **No prod behaviour probe for R9:** it would have to perform a real full replace on a real submission (writes, then a rollback) and fire the notification triggers inside the transaction. The md5 match plus the local §6.5 arms are the evidence.
5. **Gates:** push to `main` only after steps 2-3 are done on prod; then confirm `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` by hand.

### 10. Rollback

A forward migration with its own new version (never edit `20261109190000`), applied on prod through MCP plus its exact `schema_migrations` insert, as in §9.

- **Full rollback:** restore **both** landed 189 bodies verbatim, with their 189 comments: `create or replace` the writer (`security invoker`, `set search_path = public`) and re-issue 189's `revoke all … from public, anon, authenticated, service_role`; then `create or replace` the wrapper (`security definer`, `set search_path = public`). Verify both md5s against the landed 189 bodies.
- **Partial rollback is possible.** The two changes are independent: restoring only the 189 wrapper removes the date bound and keeps R9; restoring only the 189 writer removes R9 and keeps the date bound. The owner picks.
- **Data:** the date check writes nothing. R9's `Count cleared` rows already written stay; they're true records of real erases and age out with the 90-day prune. Don't delete them.
- **Order with the web deploy doesn't matter,** because there's no client change.
- **The rollback migration's pgTAP obligations:** delete or adjust `staff_submit_eod_date_bound.test.sql` arms for whichever half is rolled back, in the same PR, or `test.yml` goes red. The §6.2 fixture moves can stay; in-window dates still pass without the bound.

### 11. Overlaps

- **Spec 189.** This is a hard dependency (§1), now for **both** functions. 189's rollback (189 §13, amended 2026-11-09) restores the **pre-189** wrapper body from `20261024000000` and **drops** `eod_write_submission`. Its §13(b) already covers 193's date bound: by default it folds 193's check into the restored body, or else 193 is rolled back first. **It doesn't cover R9.** The pre-189 body has its own inline bare delete (`20261024000000`, from L201) with no audit, so a 189 rollback silently drops R9 even when it folds the date check. Whoever writes a 189 rollback after 193 has landed must therefore either:
  - **fold R9 too**: give the restored body's delete the same `delete … returning` → `audit_log` CTE with the `NOT EXISTS` filter (the pre-189 body has `v_vendor_name` from its step 2, so the shape carries over), and verify md5 against the rollback's own body; or
  - **roll 193 back first** (§10), accepting the loss of both behaviours. That's an owner decision.

  Record this in the 193 migration header's ROLLBACK paragraph. 189's file isn't edited by this spec; main Claude should relay "189 §13(b) needs an R9 line" to the 189 session (§12).
- **Spec 185 (DRAFT).** It also rewrites the staff wrapper (area-scoped replace), and, if it narrows the full-replace delete to one area, the **writer's NULL branch** too. Whichever lands second carries the other's hunks in its `create or replace` of **both** functions, and its prod pre-check md5s target the other's landed bodies.
  - **Where 185's area scope must go:** inside the CTE's `delete … where`, never in a second delete and never in the audit's `NOT EXISTS`. The audit reads the delete's `returning`, so it follows the delete's actual scope automatically: rows outside the area aren't deleted and aren't audited, and the `NOT EXISTS` filter stays as is.
  - **Signature caveat:** if 185 adds a parameter (for example `p_area`) to either function, Postgres creates a **new overload** rather than replacing it. The 193 check (wrapper) or the R9 CTE (writer) then has to be in the new function, and the old signature dropped (or kept with the change). A **new writer overload** gets spec 097's default grants on creation, so it needs 189's `revoke all … from public, anon, authenticated, service_role` re-issued against the new signature; a new wrapper overload needs `revoke … from public, anon, service_role` / `grant … to authenticated`. The AC-28 structural and catalog arms name the 9-argument signature and must move with it. Flag this in 185's design.
- **Spec 192 (EOD date-scoped drafts)**, the sibling 190 specs, 191 (`…191000`, profiles/invitations policies) and 194 (`…170000`, PO/waste/POS locks): no shared database objects seen (grep on 2026-11-09). Re-check at build time. 191's `profiles` guards matter only for §6.1's super_admin fixture, which already says to mind them.
- **Working tree:** many files carry other sessions' edits, including the 189 test changes in `eod_update_notifications`. Stage by hunk, and don't overwrite.

### 12. Risks and tradeoffs

- **Building on an unfinished 189.** This design reads an untracked, in-progress migration, and now copies **two** of its bodies. Mitigation: the §1 wait-and-re-read, the §2.4 and §2.7 diffs, the §2.2 pre-flight, and the §9 md5 pre-checks.
- **A copy error in either body.** One stray character fails prod verify, or worse, changes behaviour. The writer is the riskier copy: every staff and admin EOD write runs through it. The §2.4/§2.7 diffs, the full pgTAP run (every staff suite plus `admin_submit_eod`), and the smoke run cover it.
- **Clause reset on `create or replace`.** Leaving out `security definer` would make the wrapper an invoker. Its writes would then hit the caller's RLS and the 189 invoker writer's revoked grant. AC-8's `prosecdef` arm catches it. On the writer, the opposite slip (`security definer`) would make it an ungated definer; AC-28's `prosecdef = false` arm catches it, and the re-issued revoke keeps it unreachable meanwhile.
- **The R9 delete filter in the wrong place.** Putting the `NOT EXISTS` in the delete instead of the audit insert would leave re-sent rows behind and 23505 every ordinary staff re-submit. Every existing re-send arm (`eod_update_notifications`, `admin_submit_eod` ST) and AC-25's full re-send catch it.
- **`NOT IN` instead of `NOT EXISTS`.** Silent: zero audit rows whenever a payload carries a NULL id. Unobservable today because such a payload fails later anyway, so it's guarded structurally (§6.5 `not exists` arm) and at code review, not behaviourally.
- **R9 rollback leakage through 189.** A 189 rollback written from 189 §13 as it stands drops R9 silently (§11). Mitigation: the 193 header's ROLLBACK paragraph, and main Claude relaying the gap to the 189 session. This spec doesn't edit 189's file.
- **A new 23503 path.** `Count cleared` rows reference `profiles(id)`, so a JWT-privileged caller with no profile row now fails a re-submit that drops an item. Not reachable for real accounts; same posture as the admin branch. Accepted.
- **Forgeable look-alikes.** A store member can still insert their own `audit_log` rows through PostgREST (`store_member_insert_audit_log`, restricted to `user_id = auth.uid()`), including one whose `detail` reads `Count cleared · vendor: …`. It can only be attributed to themselves, so it can't frame anyone or hide an erase. Out of scope; noted so a future reader doesn't treat `detail` text as proof of a server write.
- **Stuck queued items** (spec residual). Accepted. There's no client signal beyond the pending pill until the "needs attention" follow-up.
- **Fixture flakiness.** None from time: `now()` is fixed per transaction, so A doesn't move mid-suite, and CI's clock is irrelevant. Local leftover rows are handled by the pre-delete.
- **Performance.** The date check is a constant-time comparison per call, plus one `profiles` primary-key lookup only on out-of-window calls. R9 adds, per staff write, one anti-join of the deleted rows (tens per submission) against the payload array (tens of elements) and two primary-key joins per deleted row. The delete and the audit insert are one statement, so there's no extra round trip. It inserts audit rows only for dropped items, so an ordinary re-submit inserts none. Negligible against the 286 KB seed and prod volumes. No edge function, so no cold start.
- **Shared 22023.** A future client that wants to tell this refusal apart from O-1 has to match on the message. That's acceptable for now, and §3.1 notes the HINT option for that follow-up.
- **Smoke script loses remote mode.** No CI or doc references it in remote mode (grep on 2026-11-09). Anyone who used it against a remote stack loses that, on purpose.

### 13. AC wording (apply when testing; the PM's text above is left as written)

| Item | Change |
|---|---|
| AC-4 | The exact SQLSTATE is `22023` and the exact message is §3.2's text |
| AC-11 | Also assert body `.code == "22023"` and the exact `.message`, and check "no row" by the call's `client_uuid`, not by triple. The script refuses non-loopback URLs (§8.1) |
| AC-17 to AC-19 | Expected **not to apply**: the in-progress 189 includes O-1. Confirm on the landed body (§1.3) |
| **New AC-20 (pgTAP)** | A store member with `p_date` NULL gets the refusal (22023, §3.2 message), and nothing is written |
| **New AC-21 (pgTAP)** | Under `set local timezone` of `Etc/GMT-14` and of `Etc/GMT+12`, A-36 and A+2 still refuse and A-35 and A+1 still succeed. `prosrc` contains `America/New_York` and not `current_date` |
| AC-22 | The expected `value` for I2 is `'20 lbs'` under the §6.5 fixture (seeded 20, unit `lbs`). "Exactly one new row" is a delta over `item_ref like 'SPEC193-%-<tag>'` |
| AC-23 | The submission also holds a re-sent I1, because O-1 forbids an empty payload; "sends neither of them" means the payload is `[I1]` |
| AC-26 | The O-1 arm asserts the landed O-1 text (`staff_submit_eod: p_entries must be a non-empty array` in the in-progress 189). The writer-error arms are both required: 23514 (NO NEED with a quantity) **and** 23505 (an item twice), not "for example" one of them |
| AC-28 | "No EXECUTE for `public`" is checked as `proacl is not null` plus no `aclexplode(proacl)` grantee `0`. "Contains `Count cleared` in both branches" is checked as exactly 2 occurrences of the literal `'Count cleared · vendor: '` in `prosrc`, plus `prosrc` containing `not exists` |

## Builder checklist (single list; every item points at its section)

1. §1: wait for 189; re-read the landed 189 migration; decide **R8** (wrapper O-1) and **R9** (writer NULL branch) from it; re-glob the slot; re-grep tests and scripts.
2. §2.2: migration skeleton in order: pre-flight `do` block → writer `create or replace` (invoker, search_path) → writer comment → writer revoke (verbatim 189) → wrapper `create or replace` (definer, search_path) → wrapper comment. Header with ROLLBACK incl. the 189-rollback/R9 note (§11).
3. §2.3: the date block in the wrapper. §2.5: the CTE in the writer's NULL branch, select list copied from the landed admin branch, `NOT EXISTS` on the insert, delete unconditional.
4. §2.4 and §2.7: two body diffs (one hunk each) plus the two comment diffs, pasted under `## Files changed`; state that `admin_submit_eod` is untouched.
5. §6.1 and §6.5: `supabase/tests/staff_submit_eod_date_bound.test.sql`, date-bound arms then R9 arms, one `plan(N)`.
6. §6.2: anchor-relative dates in the 7 staff suites **and** `admin_submit_eod.test.sql`'s D3 chain (A - 19); pre-delete only where store and vendor both persist (at least `staff_role_eod_rls`).
7. §6.6: confirm each audit-sensitive suite passes unmodified apart from its date move.
8. §7: jest AC-9, AC-10 (test-only). §8: smoke rework, local-only, AC-11 step.
9. §6.4: full pgTAP run, full `npx jest`, `typecheck`, `typecheck:test`.
10. `## Files changed`: files, both diffs, the R8 and R9 decisions. Set `Status: READY_FOR_REVIEW`. No prod apply (§9 is the owner's).

## Handoff (architect → backend-developer; consumed. The current handoff is at the end of the file.)
next_agent: backend-developer
prompt: Implement against the "## Backend design" section of specs/193-staff-eod-date-bound.md, following its "Builder checklist" in order. The design was amended for R9 (owner Q7): the migration now replaces BOTH staff_submit_eod (date block, §2.3) and the shared writer eod_write_submission (a delete…returning→audit_log CTE in the p_removed_item_ids-is-null branch with a NOT EXISTS filter on the insert, §2.5), with a pre-flight block, the writer's 189 revoke re-issued, and both clause sets restated (§2.2, §2.6). Do §1 first: wait for spec 189's migration to settle, re-read the landed 20261109120000 (or final-slot) file in full, decide R8 and R9 from it, and copy the admin branch's Count cleared select list from the landed file, not from this spec. Then the migration with two one-hunk body diffs (§2.4, §2.7), the new pgTAP suite with the date-bound and R9 arms (§6.1, §6.5), the fixture rework including admin_submit_eod.test.sql's D3 chain (§6.2), the audit-fixture checks (§6.6), the test-only jest arms (§7), and the local-only smoke rework (§8). No client, db.ts, store, realtime or edge changes. No prod apply. Only touch the files this spec names; stage by hunk around other sessions' edits. After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed, including both body diffs and the R8/R9 decisions.
payload_paths:
  - specs/193-staff-eod-date-bound.md
  - specs/189-admin-eod-resubmit-replace.md
  - specs/189-admin-eod-resubmit-replace/reviews/security-auditor.md
  - supabase/migrations/20261109120000_admin_eod_replace.sql

## Files changed

Built 2026-11-10 by backend-developer against the committed spec 189 migration (`git show HEAD:supabase/migrations/20261109120000_admin_eod_replace.sql`, commit 97f0f17; working tree identical to HEAD).

### §1 decisions

- **R8 (empty-payload refusal): does NOT apply.** The landed 189 wrapper already has O-1 (L368-377: NULL, non-array or empty `p_entries` raises 22023 `staff_submit_eod: p_entries must be a non-empty array`, after step 4). Skipped R8; AC-17 to AC-19 don't apply. `eod_update_notifications.test.sql` already sends `test.payload` (189's O-1 build).
- **R9 (staff-branch `Count cleared`): applies.** The landed 189 writer's `p_removed_item_ids is null` arm (L169-171) is a bare `delete`. The writer is replaced with the §2.5 CTE. The six audit values, the `returning` list and both joins were copied from the landed admin branch (L177-195); a scripted diff confirms the staff CTE equals the admin CTE apart from the dropped `and e.item_id = any (p_removed_item_ids)` line and the added `where not exists (…)` clause.
- **Slot:** `20261109190000` is free and sorts after every committed migration (latest committed: `20261109170000`, spec 194). It sorts before other sessions' uncommitted files (`…191000`, `…195000`, `…200000`, `…230000`, `20261110120000`); none of them, nor 190 (`…140000`) or 194 (`…170000`), mentions `staff_submit_eod` or `eod_write_submission` (grep). Because the local DB had already applied those later versions, the migration was applied locally with `psql -f` plus an `insert into supabase_migrations.schema_migrations (version, name) values ('20261109190000', 'staff_eod_date_bound')` (`supabase migration up` would need `--include-all` for an out-of-order file). A fresh `db reset` / CI applies it in filename order.
- **`admin_submit_eod` is not in this migration.** Its local md5(prosrc) is unchanged (`3dc3f5ab3693b03079743c062d49df59`).

### Migrations

- `supabase/migrations/20261109190000_staff_eod_date_bound.sql` (new): pre-flight `do` block (55000 unless 189's writer exists and the live wrapper calls it) → writer `create or replace` (security invoker, `set search_path = public`) → writer comment → writer revoke (189's, verbatim) → wrapper `create or replace` (security definer, `set search_path = public`) → wrapper comment. One transaction, `lock_timeout = '5s'`. Header covers both changes, R2 reasoning, R9 rule, pre-flight, PROD-APPLY, ROLLBACK incl. the 189-rollback/R9 interaction (§11), tests, and "no publication change".
  - Local md5(prosrc) before → after: `staff_submit_eod` `b7e9d13a1f4098ad9970edca01c90c82` → `dfe77d71693bfb720ff8b85e3a44fa09`; `eod_write_submission` `424c525b48c4201b986a42f6bf1a5a02` → `08d250d953d86042c18e2467174f7a97` (raw `md5(prosrc)`, not the prod-normalized form).
  - Catalog after apply: writer `prosecdef = f`, `proconfig = {search_path=public}`, `proacl = {postgres=X/postgres}`; wrapper `prosecdef = t`, `proconfig = {search_path=public}`, `proacl = {postgres=X/postgres,authenticated=X/postgres}`.

#### Wrapper body diff (§2.4): one added hunk, nothing removed

```diff
--- 189 wrapper (20261109120000 L303-394)
+++ 193 wrapper (20261109190000)
@@ -74,6 +74,25 @@
       using errcode = '22023';
   end if;
 
+  -- Spec 193: staff date window. Queued offline items replay late (queue GC
+  -- 30 days, plus yesterday and zone slack), so the window is 35 days back to
+  -- 1 day ahead. SQLSTATE 22023 maps to HTTP 400 and the message is constant,
+  -- so the shipped drain keeps and retries a refused item instead of
+  -- dequeuing it (forbidden) or breaking the loop (network). The anchor is
+  -- the America/New_York brand calendar taken from now(), so neither the
+  -- session TimeZone nor a Prefer: timezone header moves it. Privileged
+  -- callers are exempt (admins correct past days). After (1.5) so an
+  -- outsider still gets the store gate's code; after (4) so a processed uuid
+  -- still replays as conflict = true; before the writer so a refusal writes
+  -- nothing.
+  if (p_date is null
+      or p_date < (now() at time zone 'America/New_York')::date - 35
+      or p_date > (now() at time zone 'America/New_York')::date + 1)
+     and not public.auth_is_privileged() then
+    raise exception 'staff_submit_eod: p_date is outside the staff window (35 days back to 1 day ahead, America/New_York)'
+      using errcode = '22023';
+  end if;
+
   -- (5)-(7) Parent upsert, full replace of the entries, on-hand, per-entry
   -- audit. p_removed_item_ids NULL = replace the whole set; the audit actor
   -- is v_actor; last_updated_by is left alone (p_on_hand_actor NULL).
```

#### Writer body diff (§2.7): one hunk inside the NULL arm

```diff
--- 189 writer (20261109120000 L126-289)
+++ 193 writer (20261109190000)
@@ -43,7 +43,37 @@
   -- (2) Remove rows.
   if p_removed_item_ids is null then
     -- Staff: replace the whole set.
-    delete from public.eod_entries where submission_id = v_submission_id;
+    -- Spec 193 (R9; 189 security M1): every deleted row whose item is not
+    -- re-sent in p_entries gets one server audit row, same shape as the
+    -- targeted branch below, inside this transaction. The delete stays
+    -- unconditional (a data-modifying CTE always runs to completion); the
+    -- filter applies to the audit insert only. NOT EXISTS, never NOT IN: a
+    -- NULL ingredient_id in the payload must match nothing, not suppress
+    -- every row. Re-sent items are replaced, not cleared, and keep only their
+    -- per-entry row from the loop below.
+    with cleared as (
+      delete from public.eod_entries e
+       where e.submission_id = v_submission_id
+      returning e.item_id, e.actual_remaining, e.no_need
+    )
+    insert into public.audit_log (store_id, user_id, action, detail, item_ref, value)
+    select
+      p_store_id,
+      auth.uid(),
+      'EOD entry',
+      'Count cleared · vendor: ' || coalesce(v_vendor_name, 'unknown'),
+      ci.name,
+      case when c.no_need then 'NO NEED'
+           when c.actual_remaining is null then ''
+           else trim_scale(c.actual_remaining)::text || ' ' || coalesce(ci.unit, '') end
+    from cleared c
+    left join public.inventory_items ii on ii.id = c.item_id
+    left join public.catalog_ingredients ci on ci.id = ii.catalog_id
+    where not exists (
+      select 1
+        from jsonb_to_recordset(coalesce(p_entries, '[]'::jsonb)) as x(ingredient_id uuid)
+       where x.ingredient_id = c.item_id
+    );
   else
     -- Admin: only rows named by the call. A cleared row gets one server audit
     -- row (the delete's only trace), inside this transaction. The value is
```

#### Comment diffs

- `comment on function public.eod_write_submission(...)`: the spec 193 sentence + 189 text verbatim (scripted check: the text after `spec 189:` is byte-identical to the landed comment).
- `comment on function public.staff_submit_eod(...)`: the spec 193 sentence + 189 text verbatim (same check).

### pgTAP

- `supabase/tests/staff_submit_eod_date_bound.test.sql` (new, plan 69): date-bound arms (1)-(36) covering AC-1 to AC-8, AC-13, AC-14, AC-20, AC-21 and the R6 structural pins; R9 arms (37)-(60) covering AC-22 to AC-27 (arm (39) is the probe P7 re-run); writer catalog/structure arms (61)-(69) for AC-28. Mutation check: run against the restored 189 bodies, 23 of 69 arms fail (every date-bound refusal arm, the R6 pin, and every R9 arm that expects a `Count cleared` row or the CTE structure); with the 193 bodies all 69 pass.
  - Fixture choice: vendors V, V2 and VR (and the four items) are all created in the transaction (`SPEC193-*-<tag>`), not resolved from the seed, so every triple is fresh by construction and the §6.1 pre-deletes aren't needed (§6.2's rule for in-transaction vendors). The super_admin arms promote the seed master (3333) profile to `super_admin` as postgres after the JWT-master arms, then call with JWT role `user`.
- Fixture rework (§6.2), anchor-relative dates via a `test.*` setting computed from `(now() at time zone 'America/New_York')::date`:
  - `supabase/tests/staff_submit_eod_cases_each.test.sql`: A - 10 / A - 11, pre-delete (seed Frederick + seed vendor). Out-of-membership arm keeps `1999-12-28` (now also pins 42501 before the bound).
  - `supabase/tests/eod_no_need.test.sql`: A - 12 (call) and A - 13 (23514 call + its read-back). In-transaction vendor V3, no pre-delete.
  - `supabase/tests/eod_update_notifications.test.sql`: every `date '1999-11-02'` (6 sites: staff call, admin calls, replay, read-back) → A - 14. Direct-insert `1999-11-01/03/04` kept. In-transaction vendor f2, no pre-delete.
  - `supabase/tests/audit_log_rls_hardening.test.sql`: W-1 → A - 15, pre-delete (seed S1 + seed BJs). W-3's `1999-12-27` kept. Another session's uncommitted spec 187 hunks in this file are left intact.
  - `supabase/tests/inventory_items_identity_lock.test.sql`: T22 → A - 16 (passed as `%L`). In-transaction vendor, no pre-delete.
  - `supabase/tests/eod_submissions_multi_vendor.test.sql`: A - 17, pre-delete (seed Frederick + seed vendor).
  - `supabase/tests/staff_role_eod_rls.test.sql`: call, three read-backs and the replay → A - 18. Pre-delete covers **every Frederick row at A - 18** (all vendors), not just the vendor's triple, because arm (7) counts per (store, date). Out-of-membership `2026-05-23` kept.
  - `supabase/tests/admin_submit_eod.test.sql`: D3 chain (8 code sites: ST call, `sub_of`, the admin call over it, the replay, O-1 arms (77)-(79), the empty replay) → A - 19; header and ST banner updated. Every other date kept.
- §6.6 audit-fixture checks: every listed suite passes with only its date move; no assertion changed.

### Jest (test-only; the hook is unchanged)

- `src/screens/staff/hooks/useEodSubmit.test.ts`: new `describe('useEodSubmit — spec 193 date-window refusal')` with AC-9 (drain: refused item keeps `attempts = 1` and `lastError = MSG`, the second item is still submitted and dequeued, no error toast) and AC-10 (online submit returns `{ kind: 'failed', message: t('eod.toast.failed') }`, nothing queued). Error fixture is `Object.assign(new Error(MSG), { name: 'PostgrestError', code: '22023', details: null, hint: null })`. Added imports for `Toast` (already mocked in the file) and `t`. *(Superseded by fold-in e below: the fixture is now a plain object and AC-9 asserts `lastError = 'unknown'`.)*

### Smoke

- `scripts/smoke-staff-eod.sh`: local-only guard before login (host must be `127.0.0.1` or `localhost`, `exit 2` otherwise, no override; remote usage line removed; *now a whole-URL allowlist, fold-in d below*); NY-anchored `ny_days_ago` helper; `pick_free_date` picks the first free `A - k`, `k ∈ [3, 33]`, in a uuid-seeded order, for (Frederick, `VENDOR_ID`) and (Frederick, `NN_VENDOR_ID`); step 8 reuses the in-window step-5 date; new step 8c (AC-11) asserts HTTP 400, `.code == "22023"`, the exact message, and no row for the call's `client_uuid`; `trap cleanup EXIT` deletes the run's rows by `CLIENT_UUID` / `PRIME_UUID` via `docker exec … psql` (warns, never fails).

### Verification (local, 2026-11-10)

- Full pgTAP (`bash scripts/test-db.sh`): **106/106 files pass** (includes the new suite at 69/69). Baseline before this build was 5 failing files (`consume_invitation_sets_profile_id`, `invitations_super_admin_rls`, `profiles_insert_hardening`, `profiles_username`, `staff_brand_id_backfill`) from another session's in-progress invitations work; they pass in the final run.
- Full `npx jest`: 307 suites / 3948 tests pass.
- `npm run typecheck` and `npm run typecheck:test`: no errors except TS2688 "Cannot find type definition file for '<pkg> 2'" from stray duplicate `node_modules/@types/* 2` directories on this machine (environmental, not from this change; a clean install has none). One `typecheck:test` run also reported TS6053 for another session's temp file `Head192tmp.test.tsx`, which was gone on re-run.
- `bash scripts/smoke-staff-eod.sh`: all checks pass, including step 8c (400 + 22023); cleanup removed the run's rows. With `SUPABASE_URL=https://example.supabase.co` (and `http://localhost.evil.com`, `http://127.0.0.1@evil.com/`) it refuses with exit 2 before login.

No client, `db.ts`, store, realtime or edge-function changes. No prod apply (§9 is the owner's). Nothing staged or committed.

### Review fold-ins (owner-approved 2026-11-10; release-proposal items a-e)

No function body changed. The two `as $$ … $$;` bodies in the migration were extracted before and after the edit: md5 `08d250d953d86042c18e2467174f7a97` (writer) and `dfe77d71693bfb720ff8b85e3a44fa09` (wrapper) both times, equal to the live local `md5(prosrc)`. Everything from the first `$$` to EOF is byte-identical; the only diff is six added header comment lines.

- **a. Prod-before-push note** (architect S1 + N1).
  - `supabase/migrations/20261109190000_staff_eod_date_bound.sql`: an `ORDER:` paragraph added to the header's PROD-APPLY block (comment only). It says: apply via MCP `execute_sql` plus the explicit version insert, not `db push` (out-of-order version by design), and do it BEFORE pushing to `main`.
  - This spec: the same note in `## Prod apply` and §9, and both "Gates" steps now say push only after the prod apply. §9 also records the prod baseline normalized md5s after 189 (`eod_write_submission` `610bd4b0…`, `staff_submit_eod` `1e86fe30…`, `admin_submit_eod` `27e88465…`, which must not change), with the normalizer and a re-check-before-apply instruction.
  - Local normalized md5s after the re-apply, for the §9 step-3 comparison: `eod_write_submission` `f3ba9ae8b66a80d8940f1ce39ea12ce2`, `staff_submit_eod` `a32251ebea0e6e7bc920ecc19667fafe`. Local `admin_submit_eod` normalizes to `27e88465eeb798aa751e485d9416fc2c`, the same as the prod baseline.
- **b. Smoke cleanup tracks `OOW_UUID`** (code-reviewer should-fix 1). In `scripts/smoke-staff-eod.sh`, `OOW_UUID=""` is declared next to the other cleanup variables and added to the `cleanup()` loop.
- **c. Smoke stops when step 8b finds no free date** (code-reviewer should-fix 2 / architect N2). In `scripts/smoke-staff-eod.sh`, the `fail` is now followed by `✗ … failed at date selection (step 8b)` and `exit 1`, mirroring step 4. The EXIT trap still cleans up.
- **d. Smoke whole-URL allowlist** (security L2). In `scripts/smoke-staff-eod.sh`, the sed host extraction is replaced by `[[ "$SUPABASE_URL" =~ ^https?://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?/?$ ]]` under `shopt -s nocasematch` (restored right after). Refusal is still `exit 2` before login. The header and usage text were updated to match.
- **e. Jest error shape** (security L3). In `src/screens/staff/hooks/useEodSubmit.test.ts`:
  - `windowRefusal()` now returns the plain `{ code: '22023', message: MSG, details: null, hint: null }` that postgrest-js 2.101.1 resolves with (`PostgrestBuilder` `error = JSON.parse(body)`).
  - AC-9 now asserts `lastError === 'unknown'`, which is what the hook stores (`err instanceof Error ? err.message : 'unknown'`).
  - The stale file header (old path, "all 4 outcomes" only) was fixed.

Re-verification (local, 2026-11-10; stack not restarted):
- Migration re-applied with `psql -f` (comment-only change). Live `md5(prosrc)` and normalized md5s of all three functions were unchanged before and after. The catalog is unchanged: writer `f` / `{search_path=public}` / `{postgres=X/postgres}`; wrapper `t` / `{search_path=public}` / `{postgres=X/postgres,authenticated=X/postgres}`.
- `bash scripts/test-db.sh supabase/tests/staff_submit_eod_date_bound.test.sql`: 69/69.
- `bash scripts/smoke-staff-eod.sh`: all checks pass (run twice). Afterwards no `eod_submissions` row was left from the run.
- Guard negatives were run with `curl` and `docker` shimmed on PATH to log any call. Each of the following exits 2 with 0 external calls: `http://evil.invalid#@127.0.0.1`, `http://evil.invalid?@localhost`, `…#@127.0.0.1:54321`, `https://example.supabase.co`, `http://localhost.evil.com`, `http://127.0.0.1@evil.com/`, `http://user@127.0.0.1:54321`, `…:54321/rest`, `…:54321?x`, `ftp://127.0.0.1`, `http://127.0.0.1.nip.io`, a leading space, a trailing newline, and an embedded-newline second URL.
- Allowed shapes reach the (shimmed) login: `http://127.0.0.1:54321`, `http://LOCALHOST:54321/`, `https://localhost`, `http://[::1]:54321`.
- Step 8b bail-out: a scratch copy with `NN_DATE=""` forced stops at `failed at date selection (step 8b)` with exit 1. Neither the prime nor the NO NEED call is sent, and the trap cleaned up the step-5 row.
- `npx jest src/screens/staff/hooks/useEodSubmit.test.ts`: 13/13 right after the edit. Later 26/26: during this pass another session (spec 199) added its own hunks to this file and to `useEodSubmit.ts` (narrowed `isForbidden`, a skipped-items notice). With those hunks in place, AC-9/AC-10 still pass because the "other error" branch and its `'unknown'` are unchanged. **This file now holds spec 199 hunks too, so stage it by hunk.**
- Full `npx jest` never produced a clean single run, because other sessions' jest runs were competing for the machine. Two full runs:
  - **First:** 27 failed suites / 120 failed tests, in 1184 s.
  - **Second:** 21 / 60. In that run, 17 suites failed on timeouts and 3 on element-not-found under load. The 21st was `useEodSubmit.test.ts` itself: its 42501 `forbidden` arm failed while spec 199's hook change was on disk but its fixture update was not yet.
  - **Isolated re-runs:** all 20 other suites passed (318/318), and `useEodSubmit.test.ts` passed 26/26.
  - None of the failing suites was a spec 193 arm.
- `npm run typecheck`: exit 2, and all 24 errors are TS2688 "Cannot find type definition file for '<pkg> 2'". These come from stray `node_modules/@types/* 2` folders and are environmental. There are no other errors.
- `npm run typecheck:test`: exit 0, no errors.

## Handoff
next_agent: code-reviewer, security-auditor, test-engineer, backend-architect
prompt: Review the implementation of this spec. Each reviewer writes its
  findings to specs/193-staff-eod-date-bound/reviews/<your-name>.md. The
  backend-architect runs in post-impl drift-review mode.
payload_paths:
  - specs/193-staff-eod-date-bound.md
  - supabase/migrations/20261109190000_staff_eod_date_bound.sql
  - supabase/tests/staff_submit_eod_date_bound.test.sql
  - supabase/tests/staff_submit_eod_cases_each.test.sql
  - supabase/tests/eod_no_need.test.sql
  - supabase/tests/eod_update_notifications.test.sql
  - supabase/tests/audit_log_rls_hardening.test.sql
  - supabase/tests/inventory_items_identity_lock.test.sql
  - supabase/tests/eod_submissions_multi_vendor.test.sql
  - supabase/tests/staff_role_eod_rls.test.sql
  - supabase/tests/admin_submit_eod.test.sql
  - src/screens/staff/hooks/useEodSubmit.test.ts
  - scripts/smoke-staff-eod.sh
