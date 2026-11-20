# Spec 202: Server-side "copied count" marker and idempotent retry for staff EOD submissions

Status: READY_FOR_ARCH
Owner to confirm open questions Q-1 to Q-11 before the architect runs.

Numbering: 202 was free on 2026-11-19 (`specs/` held up to 201).

Origin: a follow-up the owner accepted when shipping spec 200 ([specs/200-staff-eod-shared-item-counted-once.md](200-staff-eod-shared-item-counted-once.md); commits d8b9a01, 4a2587f, b0ec41c, 2026-11-19). It closes three items left open there:
- spec 200 `## Residual risk`, "Stale copies in the all-borrowed case": the short window between the AC-20 stock read and the server write, where a copy can still write an older value back to on-hand;
- the security-auditor round-0 Low (carried through rounds 1 and 2): a copy's `'EOD entry'` audit row doesn't say where the value came from;
- the security-auditor fix-round-2 Low: a retry after an uncertain network failure gets a new `client_uuid`, so it becomes an edit instead of an idempotent replay.

See [specs/200-staff-eod-shared-item-counted-once/reviews/security-auditor.md](200-staff-eod-shared-item-counted-once/reviews/security-auditor.md). Code facts below were read from the working tree on 2026-11-19. Line numbers are pointers, not contracts.

## User story

As a **staff member submitting a vendor whose every item was already counted under another vendor tonight**, I want the app to send those counts as marked copies and to retry safely after a dropped connection. A copy then can't undo a delivery that landed while I was submitting, the audit trail shows the value was copied and from where, and pressing Submit again after a timeout doesn't record my count twice or alert managers to an "edit" I never made.

## The problem

- **Copies still write on-hand.** In spec 200's all-borrowed case (R8 exception), the staff app sends verbatim copies of another vendor's entries ([EODCount.tsx](../src/screens/staff/screens/EODCount.tsx) L1045-1111, `borrowedEntryCopy` in [borrowedEntries.ts](../src/screens/staff/lib/borrowedEntries.ts) L63). The server can't tell them from a real count. `eod_write_submission` ([20261109190000_staff_eod_date_bound.sql](../supabase/migrations/20261109190000_staff_eod_date_bound.sql) L252-273) sets `current_stock` and `eod_remaining` for every numeric entry whose item is linked to the submitting vendor.
  - AC-20 (client stock check) only sends a copy whose value still equals live `current_stock`, read just before the submit. A receipt, auto-receive, adjustment or admin edit that commits **between that read and the server write** is overwritten by the copy (last write wins).
  - A client-side check can't close that window. Only the server can.
- **No provenance.** Each copy writes a staff `'EOD entry'` audit row (L275-290) with `detail = '<actor> · vendor: <this vendor>'`. It reads as if this staffer counted the value. `entriesForRpc` ([useEodSubmit.ts](../src/screens/staff/hooks/useEodSubmit.ts) L91-114) forwards only the four quantity fields and `no_need`, and the writer audits nothing else.
- **Retry isn't deduplicated.** `submit` mints `uuidv4()` on every call (L295). For an all-borrowed submit (`allowQueue: false`, spec 200 AC-21), a network-classified failure returns `failed` and nothing is queued. `isNetworkError` (L47-60) also matches `timeout` and `aborted`, where the RPC may already have committed.
  - The next Submit sends a new `client_uuid`. `staff_submit_eod`'s idempotency check ([20261110130000_staff_eod_skip_unknown_items.sql](../supabase/migrations/20261110130000_staff_eod_skip_unknown_items.sql) L191-206) misses it, so the call is a full-replace **edit** of the submission that just landed.
  - Effect: duplicate `'EOD entry'` audit rows, and `notify_eod_resubmission` (spec 180, [20261027000000_eod_update_notifications.sql](../supabase/migrations/20261027000000_eod_update_notifications.sql) L326-381) fires an `eod_update` notification for an edit nobody made.
  - Own and mixed submits don't have this problem: on a network failure they queue with the same `client_uuid`, and the drain replays it.

## Terms

- **Copy:** an entry the staff app sends verbatim from a borrowed entry in the all-borrowed case (spec 200 R8 exception). Mixed submits send no copies.
- **Marked copy:** a copy whose `p_entries` element carries the new marker key, named here `copied_from_submission_id` (uuid). The architect may rename it.
- **Source submission:** the `eod_submissions` row the marker names.
- **Valid marker:** a marker that passes R3.
- **Server source / queued source:** as in spec 200 R1.
- **Remembered uuid:** the `client_uuid` the hook keeps from a failed attempt so the next identical attempt can reuse it (R10).

## Requirements

### Part 1: the copied-count marker

- **R1. The client marks server-source copies.**
  - In the all-borrowed case, each copy whose borrowed entry came from a **server source** carries `copied_from_submission_id` = that source's `eod_submissions.id`. That includes NO NEED copies (Q-6).
  - A copy from a **queued source** carries no marker (Q-7). It has no server id yet.
  - Own entries and mixed submits never carry a marker. That's spec 200 R8 unchanged: only the all-borrowed case sends copies.
  - `BorrowedEntry` ([types.ts](../src/screens/staff/lib/types.ts) L268-273) has no submission id today. The server source's `submissionId` (already on `ServerEodSource`) must reach the copy builder.
  - `entriesForRpc` forwards the marker **only when present**. Every payload without one stays byte-identical to today.
- **R2. Where the server checks it.** The check sits in `staff_submit_eod`, after spec 199's filter (R4 refusal) and before the writer. So the full order is: vendor NULL → store gate (1.5) → idempotency replay → O-1 → date window → 199 R3 → 199 R2 filter → 199 R4 → **marker check** → writer.
  - An outsider still gets 42501, and a processed `client_uuid` still replays as `conflict: true` with no marker check. That second point is what makes R10's retry idempotent even if the source changed in between.
  - Only elements that survive spec 199's filter are checked. A skipped (unknown or cross-store) element is never evaluated, including its marker.
- **R3. A marker is valid only if all of these hold** (Q-1, Q-8):
  - the source submission exists;
  - its `store_id` = `p_store_id`;
  - its `date` = `p_date`;
  - its `status = 'submitted'`;
  - its `vendor_id IS DISTINCT FROM p_vendor_id` (it isn't this vendor's own submission; unique `(store_id, date, vendor_id)` makes this equivalent to "not the target submission"; a legacy null-vendor source qualifies, as in the spec 200 / 201 borrow contract rule 1);
  - it holds an `eod_entries` row for the same item that is **borrowable** (`no_need = true` or `actual_remaining IS NOT NULL`);
  - that row equals the copy on all four values, compared as SQL `numeric` / `boolean` with `IS NOT DISTINCT FROM`: `actual_remaining`, `actual_remaining_cases`, `actual_remaining_each`, and `coalesce(no_need, false)`. So `5` and `5.000` are equal.

  The source does **not** have to be the latest candidate under the borrow-source contract (Q-8). The contract (spec 200 §1 = spec 201 §2) is unchanged.
- **R4. An invalid marker refuses the whole call** (Q-1, recommended).
  - SQLSTATE **22023**, one constant message for every failure reason, for example `'staff_submit_eod: a copied entry does not match its source submission'`. The architect fixes the exact text.
  - The message follows spec 199 R5 and the R13 contract: no `42501`, none of `network request failed` / `failed to fetch` / `aborted` / `timeout` (case-insensitive), no `caller cannot see store`, and no interpolation, DETAIL or HINT. One message for all reasons means the refusal doesn't reveal whether a submission id exists at another store (the wrapper is `SECURITY DEFINER`, so its read bypasses RLS).
  - Nothing is written, as in spec 199 R7: no parent upsert, no `submitted_at` change, no full-replace delete, no `Count cleared` row, no entries, no on-hand change, no audit row, no notification.
- **R5. A valid marked copy is stored but doesn't move on-hand.**
  - The entry is inserted exactly as today, with the copied values (and `no_need`).
  - **No** `current_stock` / `eod_remaining` / `updated_at` / `last_updated_by` write for it, whatever its `item_vendors` link.
  - It is omitted from `stock_updates`, the way a NO NEED entry is.
  - Unmarked entries in the same call behave exactly as today.
- **R6. Provenance.**
  - **Audit (always).** The copy's per-entry `'EOD entry'` row records the source submission id. The existing `<actor> · vendor: <name>` text stays as it is, byte for byte. The architect chooses where the provenance segment goes (for example a trailing ` · copied from: <submission uuid>`) and checks in-repo readers of `audit_log.detail`. The source vendor's name may be added too; that's optional. `item_ref` and `value` are unchanged.
  - **Persisted column (Q-2, recommended).** `public.eod_entries` gains a nullable `copied_from_submission_id uuid`, set only for a valid marked copy. The FK posture is Q-3.
    - Any later re-insert of that row without a marker clears it, because it's then a real count. That covers a staff full replace of this vendor and an admin targeted edit of the row (spec 189).
    - No RLS change: the existing store-scoped `eod_entries` SELECT policy covers the column. `permissive_policy_lint` is unaffected.
- **R7. NO NEED copies** carry the marker (Q-6). They're checked under R3 (the source row must be NO NEED) and get the R6 provenance. On-hand is already skipped for NO NEED (spec 172), so R5 changes nothing for them.
- **R8. The admin path refuses the marker** (Q-5, recommended).
  - `admin_submit_eod` refuses any `p_entries` element that carries the marker key: SQLSTATE 22023, a constant message, before any write. The admin client never sends it.
  - The writer `eod_write_submission` is shared with `admin_submit_eod` (spec 189) and has no gate of its own. It must never act on the marker for a caller that hasn't run R3. The architect chooses the mechanism, for example the admin wrapper's refusal plus the writer reading the key, or a new writer parameter carrying the validated set.
  - Every existing `admin_submit_eod.test.sql` arm passes untouched.
- **R9. Client handling of an R4 refusal.**
  - Online (`allowQueue: false`, so never queued), the hook returns `failed` with a distinct, recognisable reason. The architect picks the mechanism, for example matching the constant message.
  - The screen then shows a specific toast in en, es and zh-CN, for example "Counts changed under another vendor / Check and submit again", and re-reads the borrow sources (`fetchBorrowSources`) so the overlay shows the current values. It stays UNSUBMITTED and retryable, like AC-21's failed state.
  - The next Submit runs the full spec 200 path again: overlay, AC-20 stock check, copies.

### Part 2: idempotent retry

- **R10. Reuse the `client_uuid` after an uncertain failure** (Q-9).
  - **Scope:** only `submit(payload, { allowQueue: false })`, the all-borrowed path. Other submits already queue with their uuid on a network failure, and the drain replays it.
  - **Remember:** when that call returns `failed` from the **network branch** (timeout, abort, network error), keep `{ payload key, client_uuid }`. The **offline snapshot** branch (nothing was sent) may remember too; it's harmless and keeps the rule simple.
  - **Reuse:** the next `allowQueue: false` call whose payload is **unchanged** sends the remembered uuid instead of minting one.
    - **Unchanged** means `store_id`, `date` (the submit-time date, so crossing midnight changes it), `vendor_id`, and `entries` are deep-equal. Entries are compared per item regardless of order, on every field: the four values, `no_need` and the marker.
    - Any difference mints a new uuid and replaces what's remembered.
  - **Forget** on any other outcome: `success`, `success-replay`, `forbidden`, `failed` from the non-network branch (including R9's refusal) and `queued`.
  - **Lifetime:** in memory only (for example a ref in `useEodSubmit`). It doesn't survive a reload or unmount. After a reload the load effect re-reads this vendor's submission. If the lost attempt committed, the vendor shows as submitted and locked, so there's nothing to retry. If it didn't commit, a fresh uuid is correct.
  - The drain, the queue shape and own/mixed submits don't change.
- **R11. A replayed retry counts as a success on screen.**
  - `success-replay` already enters SUBMITTED_LOCKED through `enterLockedAfterWrite`, including `seedOwnFromCopies` (EODCount L1149-1215). The requirement is to keep that working and pin it for the retry flow:
    - the chip turns green;
    - the copies are seeded as own entries, so there's no "Counted under" label;
    - Edit is shown;
    - the server-source read runs again (spec 200 AC-15).
  - Toast: the existing `eod.toast.alreadySubmitted` (Q-11).
- **R12. The server isn't changed for Part 2.** The idempotency check already returns `conflict: true` with no writes, no audit and no notification for a processed `client_uuid`. pgTAP pins that for a marked-copy payload (AC-12).
- **R13. Known limit, the edit case** (Q-10). The writer's upsert keeps the **first** `client_uuid` on a conflict (`client_uuid = coalesce(existing, excluded)`, L148-154). So when an all-borrowed submit is an **edit** of an existing staff submission for this vendor (the staffer is in EDIT and cleared every own value, so every row reads as borrowed again), the new uuid is never stored. A retry with it is still an edit. Recommended: accept it and document it in Residual risk. A first submit, or an edit of an admin draft with a null `client_uuid`, stores the uuid and is covered.

### Part 3: what stays

- **R14. Spec 200 AC-20 and AC-21 stay as they are** (Q-4, recommended), as defence in depth:
  - AC-20 still runs before every all-borrowed submit. It now guards freshness, not on-hand: a copy is only sent when it still equals live on-hand at check time. It also keeps a new client safe against a server without this spec, since the marker would be ignored there.
  - AC-21 still keeps copies out of the offline queue. A queued marked copy could hit an R4 refusal at drain time, and a 22023 in the drain is retried forever (spec 199 posture).
  - Trade-off, accepted: with R5, a copy's `actual_remaining` can lag live on-hand by whatever committed in the read-to-write window. The EOD record then holds the copied count, not live stock. That's the stance spec 201 already takes for borrowed and own counts in reorder ([spec 201](201-reorder-shared-item-primary-vendor-wins.md) L294).
- **R15. Compatibility.**
  - **New client, old server:** `jsonb_to_recordset` ignores unknown keys, so the marker is dropped silently and the copy writes on-hand, as spec 200 does today. AC-20 still limits it to the read-to-write window. **Gate:** the migration is on prod before the client is pushed to `main` (Vercel deploys on push) and before any EAS build that carries it.
  - **Old client, new server:** no marker is sent, so behaviour is unchanged.
  - **Items already queued** by older clients carry no marker and drain exactly as today.
  - **Envelopes:** the success, replay and spec 199 envelopes keep their key sets. No new key is recommended. If the architect adds one, the suites that pin key sets (`staff_submit_eod_skip_unknown` AC-3, `admin_submit_eod` arm 16) change in the same PR.
  - **Queue storage shape:** `EodEntry` may gain an optional marker field. Marked copies never queue (R14), so the persisted queue shape needs no storage-key bump. The architect confirms.

## Acceptance criteria

These terms are used throughout:
- **Fixture:** store S, count date D (in the spec 193 window); vendors A and B; item X linked to A and B; item X2 linked to A and B; a `role = user` store member U of S.
- **Source:** A's `eod_submissions` row at (S, D), `status = 'submitted'`, holding X = 5 (cases 0, each 5) and X2 = NO NEED. Seeded as `postgres`.
- **Live stock:** X's `current_stock` = 17 (a delivery landed after A's count). Spec 200 AC-20 would normally block the copy at 17, so the pgTAP arms call the RPC directly to simulate the read-to-write window.
- **Unchanged:** read back as `postgres`.
- pgTAP suites run via `scripts/test-db.sh`. Suggested new suite: `supabase/tests/staff_submit_eod_copied_marker.test.sql`, hermetic (`begin; … rollback;`).

### Server (pgTAP)

- [ ] **AC-1 (marker skips on-hand).** U calls `staff_submit_eod` for B with X as a marked copy of A (5 / 0 / 5, marker = A's id). It succeeds with `conflict: false`.
  - B's entry for X holds 5 / 0 / 5.
  - X's `current_stock` (17), `eod_remaining`, `updated_at` and `last_updated_by` are unchanged.
  - `stock_updates` doesn't name X.
- [ ] **AC-2 (audit provenance).** After AC-1, there's exactly one new `'EOD entry'` row for X at S.
  - Its `detail` starts with the unchanged `<actor> · vendor: <B name>` text and contains A's submission id.
  - `value` keeps today's format (`'5 <unit>'`).
- [ ] **AC-3 (persisted provenance; if Q-2 is confirmed).** After AC-1, B's `eod_entries` row for X has `copied_from_submission_id` = A's id. Every unmarked entry written by any path has it NULL.
- [ ] **AC-4 (NO NEED copy).** A marked NO NEED copy of X2 succeeds. B's row is `no_need = true` with null quantities (and the column is set, if Q-2). Its audit row has `value = 'NO NEED'` and the provenance. On-hand is unchanged (as today).
- [ ] **AC-5 (invalid marker refused).** Each of these, sent by U for B, raises SQLSTATE 22023 with the **same** exact constant message (`throws_ok`):
  - (a) the marker is a random uuid;
  - (b) the marker is a submitted A row at **another store**;
  - (c) … at another **date**;
  - (d) … with `status = 'draft'`;
  - (e) the marker is **B's own** submission at (S, D);
  - (f) the source has **no entry** for X;
  - (g) the source's entry differs on `actual_remaining`, on `actual_remaining_cases`, on `actual_remaining_each`, or on `no_need` (one arm each);
  - (h) the source's entry for X is a blank legacy entry (null total, `no_need = false`), and the copy is blank too.
- [ ] **AC-6 (refusal writes nothing).** A refusal from AC-5 sent over an existing B submission leaves B's `submitted_at`, `status`, `client_uuid`, entry ids and values unchanged. It also adds no on-hand change, no `audit_log` row (including `Count cleared`) and no `notifications` row. A refusal on a first submit leaves no B parent row.
- [ ] **AC-7 (message rules).** The R4 message (and R8's admin message), case-insensitive, contains none of `42501`, `network request failed`, `failed to fetch`, `aborted`, `timeout`, `caller cannot see store`.
- [ ] **AC-8 (equality is numeric).** A marked copy that sends `5` where the source stores `5.000` (and the same for cases and each) is valid.
- [ ] **AC-9 (unmarked entries unchanged).**
  - A payload with no markers writes on-hand, `stock_updates`, audit and entries exactly as before. Existing suites pass untouched, among them `staff_submit_eod_skip_unknown`, `staff_submit_eod_date_bound`, `eod_no_need`, `eod_update_notifications`, `eod_submissions_multi_vendor`, `staff_role_eod_rls` and `eod_cross_vendor_read_rls`.
  - In a mixed call (X marked, a third linked item Z unmarked), Z's on-hand is written and named in `stock_updates`, and X's isn't.
- [ ] **AC-10 (gate order).**
  - An outsider sending a bad marker gets 42501 with the store-gate prefix.
  - Replaying a processed `client_uuid` with a payload whose marker is now invalid returns `conflict: true` and writes nothing.
  - The date-window and O-1 refusals win over a bad marker.
  - An element skipped by spec 199 (unknown item) that carries a bad marker doesn't trigger R4. The call succeeds for the other elements, with `skipped_item_ids` naming it.
- [ ] **AC-11 (re-insert clears provenance; if Q-2).**
  - A later staff full replace of B that sends X unmarked (a real count, X = 6) leaves the column NULL and writes on-hand = 6.
  - An `admin_submit_eod` edit of B's X does the same, with on-hand per spec 189.
- [ ] **AC-12 (idempotent replay).** U sends a marked-copy payload with `client_uuid` K and it succeeds. U sends the identical call with K again. The second call:
  - returns `conflict: true` and the same `submission_id`;
  - leaves the `audit_log` row count for S, the `notifications` row count, B's `submitted_at` and B's entry ids all unchanged.
- [ ] **AC-13 (admin path).** `admin_submit_eod` with any element carrying the marker key raises the R8 22023 message and writes nothing. Every existing `admin_submit_eod.test.sql` arm passes untouched.
- [ ] **AC-14 (catalog posture).**
  - `staff_submit_eod`, `admin_submit_eod` and `eod_write_submission` keep their signatures, `prosecdef`, `search_path` pins and ACLs. The writer's EXECUTE stays revoked from `public`, `anon`, `authenticated` and `service_role`.
  - If Q-2 is confirmed, the column's FK posture matches Q-3, and `permissive_policy_lint` passes.

### Client (jest)

Hook tests go in `src/screens/staff/hooks/useEodSubmit.test.ts`. Screen tests go in `src/screens/staff/screens/EODCount*.test.tsx`. Pure-helper tests sit next to the helper.

- [ ] **AC-15 (marker forwarding).** `entriesForRpc` sends `copied_from_submission_id` only for entries that carry it. A numeric or NO NEED entry without it produces exactly today's element.
- [ ] **AC-16 (uuid reuse).**
  - `submit(P, { allowQueue: false })` rejects with a `timeout` error, then the second `submit(P, { allowQueue: false })` sends the **same** `p_client_uuid`. The same holds for an `aborted` error and for the offline snapshot.
  - The second call's RPC returns `conflict: true`, so its outcome is `success-replay`.
- [ ] **AC-17 (no reuse when it doesn't apply).** Each of these mints a new uuid:
  - the payload differs in one entry value, in the marker, in vendor, in date or in store;
  - the previous outcome was `success`, `success-replay`, `forbidden` or a non-network `failed`;
  - calls without `allowQueue: false`: two own submits that both fail online with a non-network error get different uuids, and network failures still queue with their own uuid as today.
- [ ] **AC-18 (copy refusal).** An RPC error carrying the R4 code and message returns `failed` with the distinct reason. It isn't `forbidden` or `queued`, and the remembered uuid is forgotten.
- [ ] **AC-19 (screen marks copies).** All-borrowed under B, with X from server source A and X2 a NO NEED copy from A: `submit` receives both entries with `copied_from_submission_id` = A's id. A copy from a queued source carries none. A mixed submit carries none on any entry.
- [ ] **AC-20 (screen retry → replay).** All-borrowed under B. The first `submit` resolves `failed` ("not sent"); the screen stays unlocked, as in spec 200 AC-21. Submit is pressed again: the AC-20 stock check re-runs, `submit` receives a payload deep-equal to the first, and it resolves `success-replay`. Then:
  - the screen is SUBMITTED_LOCKED with Edit shown;
  - B is in `submittedVendorIds`;
  - X shows as own with no `eod-borrowed-<id>` label;
  - `fetchBorrowSources` runs again;
  - the toast is `eod.toast.alreadySubmitted`.
- [ ] **AC-21 (screen refusal).** `submit` resolves the AC-18 refusal. The R9 toast shows, the screen stays UNSUBMITTED, and `fetchBorrowSources` is called again.
- [ ] **AC-22 (helper carries the id).** `deriveBorrowedEntries` returns the source submission id for a server-sourced entry and none for a queued one. Add this as one more arm to the existing AC-1 suite in `borrowedEntries.test.ts`.
- [ ] **AC-23 (i18n).** The R9 strings exist in en, es and zh-CN with identical tokens, and `src/screens/staff/i18n/i18n.test.ts` passes.

### Gates

- [ ] **AC-24.**
  - Full `npx jest`, `npm run typecheck`, `npm run typecheck:test` and the full pgTAP run (`scripts/test-db.sh`) pass.
  - Existing tests that pin the copy shape, the `submit` call arguments or the per-call uuid are updated, not deleted. Re-grep `EODCount.borrowed.spec200.test.tsx` and `useEodSubmit.test.ts`.
  - After the push to `main`, `test.yml` and `db-migrations-applied.yml` are green, and `e2e.yml` is checked by hand.
- [ ] **AC-25 (manual).** Run on the local stack at phone width, then exercise the flows below with the RPC call recorded in the network log. Clean up the fixtures afterwards.
  - All-borrowed submit: the marker is present, and on-hand is unchanged after a DB-side stock change made between the stock read and the RPC (for example a breakpoint, or a direct RPC call).
  - A blocked (`timeout`) RPC followed by a retry: the second call reuses the uuid and the audit shows no duplicate.

No shell smoke is required: spec 193 AC-11 already proves 22023 maps to HTTP 400 over PostgREST. The architect may add a `scripts/smoke-rpc.sh` step.

## In scope

- One migration, sorted after the latest on disk (`20261118120100_set_item_primary_vendor.sql` on 2026-11-19; re-glob at build time). It contains:
  - a pre-flight that refuses unless spec 199 is present (the live wrapper contains `skipped_item_ids`);
  - `create or replace` of `staff_submit_eod` (R2-R4), `eod_write_submission` (R5, R6) and `admin_submit_eod` (R8). Each starts from its latest body, keeps its signature, and restates its posture;
  - the `eod_entries.copied_from_submission_id` column, if Q-2 is confirmed;
  - comments, plus a header with prod-apply and rollback notes.
- The new pgTAP suite. If Q-2 adds the column, add an arm to any suite that pins `eod_entries` columns.
- Staff client changes:
  - [EODCount.tsx](../src/screens/staff/screens/EODCount.tsx): marking copies, R9 handling, AC-20 retry test wiring;
  - [borrowedEntries.ts](../src/screens/staff/lib/borrowedEntries.ts) and [types.ts](../src/screens/staff/lib/types.ts): the source id;
  - [useEodSubmit.ts](../src/screens/staff/hooks/useEodSubmit.ts): marker forwarding, uuid reuse, refusal classification;
  - staff i18n for R9.
- Jest arms AC-15 to AC-23.

## Out of scope (explicitly)

- **Mixed submits sending copies.** Only the all-borrowed case sends copies (spec 200 R8). The server's per-element rule would accept a valid marker in any payload, but the client never sends one in that case.
- **Changing the borrow-source contract** (spec 200 §1 = spec 201 §2). R3 checks that the value is a faithful copy; it doesn't check that the source is the latest candidate.
- **Staff realtime / snapshot staleness** (spec 200 Residual risk). v1 has no staff realtime.
- **The drain gap** (spec 200 R9).
- **Last-write-wins on deliberate edits** of a borrowed row. Owner direction in spec 200.
- **The error-toast label Low** (`notifyBackendError` showing the function name). It's the existing staff pattern.
- **Relaxing AC-20 or AC-21** (Q-4). That's a possible follow-up once this has run in prod.
- **A server-side record of every attempted `client_uuid`** to dedupe the edit case (R13, Q-10). It's a larger idempotency change.
- **An admin UI "copied" badge**, or reorder reading the provenance column. Possible follow-ups; R6's column makes them cheap.
- **Backfilling provenance** for copies written by spec 200 before this ships. They can't be told apart reliably.
- **Admin Cmd EOD** behaviour, apart from R8's refusal.
- **`app.json`** (slug untouched).

## Open questions

Each has a recommended default. The architect proceeds on the defaults unless the owner overrides.

- **Q-1. What happens when a marker fails validation?** → **Recommended: refuse the whole call with 22023 and one constant message (R4).** The other option, silently treating it as a normal count, would write on-hand from a value that failed the check, and a failed check means the source changed: that's exactly the stale write this spec closes.
- **Q-2. Where does provenance live?** → **Recommended: the audit `detail` and a nullable `eod_entries.copied_from_submission_id` column.** Spec 186 prunes `audit_log` after 90 days but keeps EOD rows forever, so audit-only provenance would vanish while the copied entry stays.
- **Q-3. FK posture for the column (if Q-2).** → **Recommended: `references public.eod_submissions(id)` with the default NO ACTION.** That matches the `eod_entries.item_id` precedent and the spec 186 keep-records stance. No client path deletes EOD submissions, and a hand delete of a cited source should fail loudly, not null the provenance.
- **Q-4. Keep spec 200 AC-20 (stock check) and AC-21 (no queue) now that the server skips on-hand?** → **Recommended: keep both, unchanged.** AC-20 still protects against a server without this spec and keeps copies fresh. AC-21 avoids a queued marked copy hitting an R4 refusal at drain, which would retry forever.
- **Q-5. `admin_submit_eod` and the marker: accept, ignore or refuse?** → **Recommended: refuse with 22023.** Admins edit A's own count and never copy. Refusing keeps one validated entry point, and silently ignoring the key would hide a client bug.
- **Q-6. Do NO NEED copies carry the marker?** → **Recommended: yes.** On-hand is already skipped for them, but provenance and validation should hold for every copy, so the audit reads the same for both kinds.
- **Q-7. Copies from a queued source (no server id yet)?** → **Recommended: send them unmarked, still behind the AC-20 stock check.** They only pass when the value already equals live on-hand, so writing it is harmless. Inventing a server id for an undrained count isn't possible.
- **Q-8. Must the source be the latest candidate under the borrow contract?** → **Recommended: no. Any qualifying submitted source holding equal values is enough (R3).** Requiring "latest" would couple the server check to the shared contract, and on-hand isn't written for a copy anyway.
- **Q-9. Retry uuid scope and lifetime?** → **Recommended (R10): only `allowQueue: false`; remember after a network-branch or offline `failed`; reuse only on a deep-equal payload (store, vendor, submit-time date, entries per item including markers); forget on any other outcome or any payload change; in memory only, not across reloads.** Own and mixed submits already reuse their uuid through the queue, and after a reload the screen re-reads whether the lost attempt committed.
- **Q-10. The edit case, where the server keeps the first `client_uuid` so a retried edit can't replay (R13)?** → **Recommended: accept it and document it in Residual risk.** It needs a staffer in EDIT who cleared every own value and then hit a timeout. Fixing it needs a server-side attempt ledger, which is out of scope.
- **Q-11. Toast when a retry comes back as a replay?** → **Recommended: keep the existing `eod.toast.alreadySubmitted`.** It's true (the first attempt landed), it needs no new string, and the locked state matches a fresh success.

## Dependencies

- **Spec 200** (on `main`): the all-borrowed copy path, AC-20, AC-21, `fetchBorrowSources`, `deriveBorrowedEntries`.
- **Spec 199** (on prod): this spec's `staff_submit_eod` starts from [20261110130000_staff_eod_skip_unknown_items.sql](../supabase/migrations/20261110130000_staff_eod_skip_unknown_items.sql). The pre-flight checks for it.
- **Spec 193 / 189:** the writer body baseline is [20261109190000_staff_eod_date_bound.sql](../supabase/migrations/20261109190000_staff_eod_date_bound.sql) L114-307. The `admin_submit_eod` baseline is [20261109120000_admin_eod_replace.sql](../supabase/migrations/20261109120000_admin_eod_replace.sql) L410-536. Re-check that no later migration replaced either.
- **Spec 180:** `notify_eod_resubmission` (AC-12 pins that a replay fires nothing).
- **Spec 186:** keep-records posture; the 90-day `audit_log` prune motivates Q-2.
- **Spec 185** (DRAFT, area-scoped staff replace) also rewrites the staff wrapper. Whichever lands second carries the other's hunks.
- No library or edge-function dependency.

## Project-specific notes

- **Cmd UI section:** none. This is the staff surface ([src/screens/staff/](../src/screens/staff/), the direct-`supabase` carve-out) plus the RPCs. The only admin change is R8's server-side refusal.
- **Which app:** the staff EOD app in this repo (spec 063 fold-in).
- **Per-store or admin-global:** per-store. R3 requires the source at `p_store_id`, and the `auth_can_see_store()` gate is unchanged.
- **Edge function or PostgREST:** PostgREST RPCs (`staff_submit_eod`, `admin_submit_eod`). No edge function.
- **Realtime channels touched:** none on the staff side. If Q-2 adds a column to `eod_entries` (which the admin realtime watches through `store-{id}`), restart realtime locally after the migration (`docker restart supabase_realtime_imr-inventory`) and check that admin EOD updates still arrive. Publication membership doesn't change.
- **Migrations needed:** yes, one (see In scope).
- **Edge functions touched:** none.
- **Web/native scope:** both. The server part protects every client version on the day it's applied. The client part reaches web at the next Vercel deploy and native at the next EAS build.
- **`app.json` slug:** not touched.
- **Tests:** pgTAP (AC-1 to AC-14), jest (AC-15 to AC-23), gates (AC-24), manual preview (AC-25). No shell smoke.

## Residual risk

- **The edit case (R13, Q-10).** A retried all-borrowed edit of an existing staff submission is still an edit: duplicate audit rows and an `eod_update`.
- **Copy freshness.** A marked copy records the source's value even if on-hand moved in the read-to-write window. On-hand is no longer reverted, but the EOD record can be one change behind live stock (R14 trade-off).
- **Queued-source copies** (Q-7) are unmarked, so they have no provenance. They can only be sent when they equal live on-hand.
- **Old servers.** Until the migration is on prod, a new client's marker is ignored (R15). The deploy gate covers this.
- **Concurrent source edit.** If A is edited after R3 passes but before B commits, B's copy cites A's earlier value. The value was true at check time, and on-hand isn't written. The architect may lock the source row (for example `FOR SHARE`) if the cost is negligible.

## Prod apply and commit (owner, later; not part of this spec's done state)

- **Commit:** don't commit without the owner's explicit go-ahead.
- **Prod apply** (project `ebwnovzzkwhsdxkpyjka`, through the Supabase MCP): only on the owner's go-ahead.
  1. Run `execute_sql` with the migration's full text.
  2. Insert the exact version into `supabase_migrations.schema_migrations`.
  3. Not `supabase db push`.
- **md5 checks.**
  - **Pre-check:** the normalized md5 of prod's `staff_submit_eod`, `eod_write_submission` and `admin_submit_eod` matches the local baselines.
  - **Post-check:** they match this migration's bodies. `prosecdef`, `proconfig` and the ACLs are as in AC-14, and the column exists (if Q-2).
- **Order:** apply on prod **before** pushing the client to `main` (R15). Then confirm that `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` by hand.
- **Rollback:** a forward migration that restores the spec 199 wrapper, the spec 193 writer and the spec 189 `admin_submit_eod` bodies verbatim. Keep the column and its data (spec 186). Roll the client back with it, or accept that markers are ignored. AC-20 still limits the exposure.

## Handoff
next_agent: backend-architect
prompt: Owner must first confirm (or override) open questions Q-1 to Q-11; the defaults are recommended. Then design the contract for this spec: read the requirements, acceptance criteria and project-specific notes, produce the design doc, and set Status: READY_FOR_BUILD. Don't change the spec 200 / 201 borrow-source contract.
payload_paths:
  - specs/202-staff-eod-copied-count-marker.md
  - specs/200-staff-eod-shared-item-counted-once.md
  - specs/200-staff-eod-shared-item-counted-once/reviews/security-auditor.md
