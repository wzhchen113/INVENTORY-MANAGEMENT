# Spec 199: Staff EOD submit skips unknown or cross-store items instead of losing the count

Status: READY_FOR_REVIEW

Numbering: 199 was free on 2026-11-10 (`specs/` holds 190 to 198; no other `199-*` file).

Origin: a pre-existing bug seen during spec 193's security audit, probe P5. See [specs/193-staff-eod-date-bound/reviews/security-auditor.md](193-staff-eod-date-bound/reviews/security-auditor.md) (L78-82) and the out-of-scope list in [specs/193-staff-eod-date-bound/reviews/release-proposal.md](193-staff-eod-date-bound/reviews/release-proposal.md) (L83). Line numbers are pointers, not contracts.

**Hard dependency:** spec 193 must land first. This spec builds on 193's `staff_submit_eod` body, and 193 is uncommitted at `READY_FOR_REVIEW` (see Dependencies).

**Urgency:** a real data-loss path, but a narrow one. It needs a manager to hard-delete an item while a staff count that includes it is queued offline or still on screen.

## User story

As a staff member counting end-of-day stock, I want my count saved even if a manager deleted one of the items while I was offline or mid-count. The deleted item should be dropped, not my whole count, and I should be told it was dropped so I know why that item isn't on the saved count.

## The problem

- **The trigger.** `public.eod_entries_check_store()` is the BEFORE INSERT OR UPDATE trigger `eod_entries_check_store_trg` on `eod_entries` ([20260514120030_eod_submissions_consistency.sql](../supabase/migrations/20260514120030_eod_submissions_consistency.sql) L104-138). It raises SQLSTATE **42501** `'eod_entries: item store mismatch with parent submission'` when an entry's item is missing from `inventory_items`, has a NULL `store_id`, or belongs to a different store than the parent submission.
- **The RPC.** `staff_submit_eod` doesn't check items before it writes. After spec 193 it is a thin wrapper around `public.eod_write_submission` ([20261109190000_staff_eod_date_bound.sql](../supabase/migrations/20261109190000_staff_eod_date_bound.sql) L320-430). The writer inserts element by element (L228-249), so one bad element raises 42501 and rolls back the whole call.
- **The client.** `isForbidden` in [src/screens/staff/hooks/useEodSubmit.ts](../src/screens/staff/hooks/useEodSubmit.ts) (L61-68) treats any `code === '42501'`, any `status === 403`, or any message containing `42501` as forbidden. That causes two failures:
  - In the drain (L176-188), a forbidden item is **dequeued** with the "your access … changed" toast, so the staff member's whole queued count is lost.
  - In the online `submit` (L292-296), the call returns `kind: 'forbidden'`. EODCount then shows the "your access has changed, sign out" state (`EODCount.tsx` L935), which is misleading.
- **How it happens in practice:**
  - A manager hard-deletes an inventory item (`deleteInventoryItem`, [src/lib/db.ts](../src/lib/db.ts) L3018). Only items with no history can be deleted, because `eod_entries.item_id` references `inventory_items(id)` with no ON DELETE clause ([init schema](../supabase/migrations/20260405000759_init_schema.sql) L131, so NO ACTION).
  - Moving an item to another store isn't a path, because spec 179 made `store_id` immutable.
  - A cross-store item otherwise only arrives from a buggy or hostile client.

## Owner decisions (2026-11-10, main session, question dialog; not reopened here)

1. **Server: skip and report.** `staff_submit_eod` checks each payload item up front.
   - It drops any entry whose `ingredient_id` is missing from `inventory_items` or belongs to a store other than `p_store_id`, and saves the valid entries as it does today.
   - The response envelope gains the skipped item ids. The architect picks the key, for example `skipped_item_ids`.
   - If **no** valid entries remain, the call is refused with SQLSTATE **22023** and a constant message. The message must not contain `42501` or any network-like words, so the shipped client keeps the item queued and retries it (the same reasoning as spec 193's date bound).
   - The trigger `eod_entries_check_store` is **unchanged**. It still guards admin writes and direct inserts.
   - The fix is server-side so that clients already installed stop losing counts.
2. **Client: narrow `isForbidden`.**
   - Only the real store-access refusal dequeues: the RPC's store gate (`'staff_submit_eod: caller cannot see store …'`, raised as 42501 at step 1.5), or an HTTP 403. Any other 42501 keeps the item queued and bumps its attempts.
   - The staff app shows a notice when a submit or drain response reports skipped items, for example "N items no longer in your catalog were skipped". It needs en, es and zh-CN strings in `src/screens/staff/i18n/`.

## Requirements

- **R1. Where the check runs.** The check goes in the `staff_submit_eod` wrapper, on top of spec 193's landed body.
  - `admin_submit_eod` behaviour must not change. Every existing `admin_submit_eod.test.sql` arm passes untouched.
  - The architect decides whether the writer `eod_write_submission` changes at all. If it does, its signature, `security invoker`, `search_path` pin and revoked ACL stay exactly as spec 193 left them.
- **R2. The skip predicate is the exact complement of the trigger's item check.** An element is **valid** iff an `inventory_items` row with `id = ingredient_id` and `store_id = p_store_id` exists. Every other element with a non-NULL `ingredient_id` is **skipped**. That covers a missing item, an item at another store, and an item with a NULL `store_id`.
  - So a valid element can't fail `eod_entries_check_store_trg` on store grounds, except in the race described in R10.
  - A skipped element is never inserted. Its other properties are therefore never evaluated. For example, a NO NEED element carrying a quantity, which would normally raise 23514, raises nothing if it is skipped.
- **R3. NULL or missing `ingredient_id`: refuse, don't skip.** If any element has a NULL or absent `ingredient_id`, the whole call is refused with SQLSTATE **22023** and a constant message. Today the trigger refuses this case with 42501, so the only change is the code. The message follows the R5 rules and differs from R4's message.
  - Rationale: the shipped client never sends this (`entriesForRpc` maps a typed `item_id`). A NULL is a malformed payload, not a stale catalog. Skipping it would hide a client bug, and there's no id to report.
  - A non-uuid string already fails earlier with 22P02 in `jsonb_to_recordset`. That stays unchanged.
- **R4. All skipped means refused.** If every element is skipped, the call raises SQLSTATE **22023** with a constant message and writes nothing (R7).
  - O-1 (the empty-payload check) still runs on the **raw** payload, with its message unchanged. A non-empty payload made up entirely of stale items passes O-1 and then hits R4.
- **R5. Classification rules for the R3 and R4 messages** (the same rules as spec 193's R2):
  - the SQLSTATE is not 42501, and PostgREST maps it to HTTP 400;
  - the message contains no `42501`;
  - the message contains none of `network request failed`, `failed to fetch`, `aborted`, `timeout` (case-insensitive);
  - there is no interpolation, DETAIL or HINT.
- **R6. Order of checks.** Every existing gate keeps its code, message and relative order:
  1. vendor NULL check (22023);
  2. store gate, step 1.5 (42501, `'staff_submit_eod: caller cannot see store %'`);
  3. idempotency replay (`conflict: true`, envelope unchanged, **without** the new key);
  4. O-1 (22023);
  5. spec 193 date window (22023).

  The new R3, R2 and R4 steps run **after** the date window and **before** the writer. Concretely:
  - an outsider gets 42501 even if the payload is all stale;
  - a processed `client_uuid` replays as `conflict: true` even if the payload is all stale;
  - an out-of-window, all-stale call gets the date-window refusal.
- **R7. Refusals write nothing.** An R3 or R4 refusal leaves all of the following untouched:
  - no parent upsert and no `submitted_at` change;
  - an existing submission's entries are not deleted (the full-replace delete must not run);
  - no on-hand change, no `audit_log` row (including no `Count cleared` row), and no `notifications` row.
- **R8. A partial skip.** The valid elements are written exactly as today: parent upsert, full replace, the per-entry staff audit row, the on-hand write and `stock_updates`.
  - `entry_ids` and `stock_updates` cover only written entries.
  - A skipped item gets no per-entry audit row and no on-hand write. A cross-store item's `current_stock` and `eod_remaining` at its own store stay untouched.
  - The success envelope keeps `submission_id`, `conflict: false`, `entry_ids` and `stock_updates`, and adds the new key. The new key is **always present**: the distinct skipped ids, or `[]` when nothing was skipped. Order isn't part of the contract.
  - Duplicates:
    - A valid item repeated in the payload still raises 23505 (unchanged).
    - A skipped item repeated in the payload appears once in the list and raises nothing.
- **R9. Interaction with spec 193's R9 `Count cleared` audit.** The full replace still deletes every existing entry of the submission. A `Count cleared` row must be written for every deleted row that isn't re-inserted. So the "re-sent" test is made against the entries **actually written**, not the raw payload.
  - **A missing item can't have a prior row.** Because the FK is NO ACTION, any `eod_entries` row blocks deleting the item.
  - **A cross-store item can't have a prior row either**, with one theoretical exception. The trigger has refused such rows since 2026-05-14, and spec 179 made `store_id` immutable. The exception is legacy rows inserted before the trigger existed.
  - If such a legacy row exists and its item is skipped, the row is removed and gets a truthful `Count cleared` row. It must never be removed silently.
  - A skipped item with no prior row gets **no** `Count cleared` row.
- **R10. Race.** An item can be hard-deleted after the skip check and before the insert. The trigger would then raise 42501 for the whole call. With R12 the new client keeps the item and retries it, and the retry skips the deleted item.
  - **Recommendation (the architect may adopt it):** lock the checked `inventory_items` rows in the skip step, for example with `FOR KEY SHARE`, so a concurrent delete waits for the submit.
  - Either way, document the remaining window in the migration header.
- **R11. Privileged callers** of `staff_submit_eod` (`auth_is_privileged()`) get the same skip, refuse and report behaviour. There's no exemption.
- **R12. Client: narrow `isForbidden`** (decision 2). An error counts as forbidden only if one of these holds:
  - (a) its `code` is `'42501'` **and** its message contains the store gate's fixed text `caller cannot see store`. The gate interpolates the store id, so match a substring, not the whole message.
  - (b) its `status` is 403 **and** it doesn't carry a `42501` code with a non-store-gate message.

  The SQLSTATE and message are the more specific signal, so they win over a status.

  The bare "message contains `42501`" fallback no longer dequeues on its own.

  Any other 42501 has three effects:
  - in the drain, it bumps attempts, keeps the item and continues to the next item;
  - online, it returns `kind: 'failed'` (the generic `eod.toast.failed`), not `'forbidden'` and not `'queued'`;
  - `isNetworkError` and the network branch are unchanged.

  Note: supabase-js's `PostgrestError` carries `code`, `message`, `details` and `hint` but no `status`, so (b) never fires for this RPC today. It's kept for other error shapes. A side effect is that an anon-session `42501 permission denied for function staff_submit_eod` (see spec 152) now keeps the count instead of dropping it. That's intended.
- **R13. The store-gate message becomes a client contract.** A pgTAP arm pins the step 1.5 message prefix (`staff_submit_eod: caller cannot see store`) as well as its code, so a server edit can't silently turn every store-gate refusal into a retry-forever.
- **R14. The skipped-items notice.** When a submit or a drained item gets a success response whose new key is non-empty, the staff member sees a notice with the count N, for example "N items no longer in your catalog were skipped".
  - en, es and zh-CN strings go in `src/screens/staff/i18n/`, with matching interpolation tokens. The existing parity and token tests in `i18n.test.ts` enforce that.
  - The notice must actually stay visible:
    - **Online:** EODCount's own `eod.toast.submitted` toast (L921-927) must not overwrite it.
    - **Drain:** the debounced `eod.toast.allSynced` toast (L209-222) must not overwrite it.
    - If several drained items report skips in one pass, the staff member sees **one** notice with the total.
  - The architect picks the mechanism, for example a skipped count on the `success` outcome or a combined toast.
  - Without the key (replay, or an older server), the client treats the count as zero.
- **R15. Audit of skipped ids: recommendation only, not blocking.** The default is **no** `audit_log` row for skips. The response reports them, a missing item has no catalog name to record, and a cross-store id only comes from a buggy or hostile client.
  - If the architect adds one, it must be:
    - written in the same transaction;
    - never written on a refusal;
    - one row per call, not per item;
    - using an `action` other than `'EOD entry'`, so the scalar `(store, 'EOD entry', item_ref)` subqueries in the existing suites (spec 193 audit-fixture table) don't change.

## Acceptance criteria

These terms are used throughout:
- **Store member:** a caller with JWT role `user`, `auth_can_see_store(store) = true` and `auth_is_privileged() = false`.
- **Dates:** in-window per spec 193.
- **D:** a random uuid with no `inventory_items` row.
- **X:** an item at another store.
- **S:** a submission seeded as `postgres` holding I1 and I2, both valid items of the store.
- **"Unchanged":** read back as `postgres`.
- **"The new key":** the key the architect picks.

### Server (pgTAP)

- [ ] **AC-1 (partial skip, deleted item):** a store member's first submit with `[I1, D]` succeeds with `conflict: false`, and the new key is `[D]`.
  - Exactly one `eod_entries` row exists, for I1.
  - `entry_ids` has length 1, and `stock_updates` names only I1 (when I1 is numeric and vendor-linked).
  - There's exactly one per-entry `'EOD entry'` row, for I1, and none for D.
- [ ] **AC-2 (partial skip, cross-store item):** `[I1, X]` succeeds, and the new key is `[X]`. X's `current_stock`, `eod_remaining` and `updated_at` are unchanged. No `audit_log` row for the calling store names X.
- [ ] **AC-3 (valid payload envelope):** a payload with no stale items returns `submission_id`, `conflict: false`, `entry_ids` and `stock_updates` exactly as before, plus the new key with value `[]`. There are no other keys.
- [ ] **AC-4 (all skipped, first submit):** `[D, X]` raises SQLSTATE 22023 with the exact R4 message (checked with `throws_ok`). No parent row exists at the triple afterwards.
- [ ] **AC-5 (all skipped over S):** `[D]` over S raises the R4 refusal. Afterwards:
  - S's `submitted_at`, `status` and `client_uuid` are unchanged.
  - Its entries (ids and values) are unchanged.
  - I1 and I2's on-hand is unchanged.
  - No `audit_log` row (including `Count cleared`) and no `notifications` row has been added.
- [ ] **AC-6 (message rules):** the R3 and R4 messages, case-insensitive, contain neither `42501` nor any of `network request failed`, `failed to fetch`, `aborted`, `timeout`, and their SQLSTATE is 22023.
- [ ] **AC-7 (NULL id):** a payload of `[I1, {ingredient_id: null}]` and a payload of `[I1, {}]` (key absent) each raise the R3 refusal, with 22023 and its exact message. Over S, nothing changes (the same read-backs as AC-5).
- [ ] **AC-8 (Count cleared interaction):** a store member sends `[I1, D]` over S. Afterwards:
  - S holds only I1.
  - Exactly one new `Count cleared` row exists, for I2.
  - No `Count cleared` row names I1, and none is written for D.
  - The new key is `[D]`.
- [ ] **AC-9 (gate order):** each existing gate wins over the new steps with its code and message unchanged:
  - **Store gate:** an outsider sending `[D]` gets 42501, and the message starts with `staff_submit_eod: caller cannot see store` (R13).
  - **Replay:** replaying S's stored `client_uuid` with `[D]` returns `conflict: true` and S's id, the envelope has **no** new key, and nothing changes.
  - **O-1:** `'[]'` raises O-1's 22023 message.
  - **Date window:** `p_date = A - 36` with `[D]` raises the spec 193 date message.
  - **Vendor:** a NULL vendor raises the vendor 22023 message.
- [ ] **AC-10 (duplicates):** `[I1, I1]` raises 23505 (unchanged), and S is unchanged when it's sent over S. `[I1, D, D]` succeeds, and the new key is `[D]` (D appears once).
- [ ] **AC-11 (privileged caller):** a JWT `admin` caller of `staff_submit_eod` gets the AC-1 result and the AC-4 refusal.
- [ ] **AC-12 (unchanged surfaces):**
  - `staff_submit_eod` keeps its signature, `prosecdef = true`, the pinned `search_path`, and EXECUTE for `authenticated` only.
  - If the writer was replaced, it keeps spec 193's catalog posture.
  - `eod_entries_check_store_trg` still exists. A store member's direct `INSERT` into `eod_entries` of X under one of their own submissions still raises 42501.
  - Every existing suite that calls `staff_submit_eod` or `admin_submit_eod` passes, including `staff_submit_eod_date_bound.test.sql` from spec 193.

### Client (jest, `src/screens/staff/hooks/useEodSubmit.test.ts` unless stated)

- [ ] **AC-13 (drain, store gate):** an error `{code: '42501', message: 'staff_submit_eod: caller cannot see store <uuid>'}` dequeues the item and shows `chrome.queue.syncErrorBanner`.
- [ ] **AC-14 (drain, trigger-style 42501):** an error `{code: '42501', message: 'eod_entries: item store mismatch with parent submission'}` calls `bumpEodAttempts` for that item and **doesn't** call `dequeueEod` for it. A second queued item after it in FIFO order is still submitted in the same pass. The same holds for `{code: '42501', message: 'permission denied for function staff_submit_eod'}`, and for the trigger-style error with `status: 403` attached (R12 b).
- [ ] **AC-15 (drain, 403):** an error `{status: 403}` with no code dequeues the item.
- [ ] **AC-16 (online):** a store-gate error returns `kind: 'forbidden'`. A trigger-style 42501 returns `kind: 'failed'` (not `'forbidden'`, not `'queued'`), and nothing is enqueued.
- [ ] **AC-17 (online notice):** an online submit whose response carries 2 skipped ids keeps the success flow and leaves the skipped notice with N = 2 as the last toast shown. The success flow is `kind: 'success'`, and the screen enters its locked state as today. Put this in a hook-level or screen-level test, wherever the architect puts the mechanism.
- [ ] **AC-18 (drain notice):** two queued items drain in one pass. Their responses report 1 and 2 skipped ids, and the queue empties. After timers run, the last toast shown is one skipped notice with N = 3, and `eod.toast.allSynced` doesn't overwrite it. A drain with no skips still shows `allSynced` exactly as today.
- [ ] **AC-19 (no key):** a success response without the new key (replay, or an older server) shows no notice, and its outcome is unchanged.
- [ ] **AC-20 (i18n):** the new string or strings exist in en, es and zh-CN with identical tokens, and `src/screens/staff/i18n/i18n.test.ts` passes.
- [ ] **AC-21 (gates):** the full `npx jest`, both typecheck gates (base plus `typecheck:test`) and the full pgTAP run pass.
  - The existing test at `useEodSubmit.test.ts` L115-125 uses the message `'cannot see store'`. Under R12 that no longer counts as forbidden, so update it to the real store-gate message. Don't delete it.
  - Re-grep the staff tests for other 42501 or 403 fixtures that pinned the old wide behaviour.

No shell smoke is required. Spec 193's AC-11 already proves that 22023 maps to HTTP 400 over PostgREST. The architect may add a step if they want one.

## In scope

- One migration, sorted after `20261110120000_invitations_hardening.sql` (the latest on 2026-11-10; re-glob at build time). It does a `create or replace` of `public.staff_submit_eod` (same signature), and of `eod_write_submission` only if the architect's design needs it. It includes function comments and a header covering prod apply and rollback.
- New pgTAP arms for AC-1 to AC-12, in a new suite file (the architect names it).
- The `isForbidden` narrowing, the skipped-notice mechanism, the optional new key on the `StaffSubmitEodResponse` type ([src/screens/staff/lib/types.ts](../src/screens/staff/lib/types.ts) L144), and the i18n strings.
- Jest arms for AC-13 to AC-20, plus the AC-21 fixture update.

## Out of scope (explicitly)

- **`admin_submit_eod`.** It doesn't go through the staff client, and the admin UI builds its payload from the live catalog.
- **Changing or dropping `eod_entries_check_store_trg`** (owner decision 1). It still guards admin writes and direct inserts.
- **Soft-delete or archive for inventory items.** That would remove the trigger condition at its source, but it's a schema and product change nobody asked for.
- **Dequeuing or "needs attention" UI for an item refused under R4,** which retries forever. It belongs to spec 193's named staff-queue follow-up (the `attempts >= 5` UI).
- **Showing which items were skipped by name.** The ids may no longer resolve to a name, and the owner asked for a count.
- **Changing `isNetworkError`,** the other-error branch, or queue GC.
- **Any change to the replay envelope.** Replays return before the check.
- **Spec 193's direct-table-insert and erase follow-ups.**

## Open questions resolved

- Q: Should the server skip bad items or keep refusing? → A: **Skip and report.** If nothing valid remains, refuse with 22023 and a constant message (decision 1).
- Q: How narrow is the client's forbidden test? → A: **Only the store gate's 42501 or an HTTP 403 dequeues.** The staff app shows a skipped-items notice in en, es and zh-CN (decision 2).
- Q (PM, applying decision 2): what about a 42501 with a non-store-gate message that also carries status 403? → A: **Keep the item.** The SQLSTATE and message are more specific than the status, and the owner's intent is that only a real access refusal drops a count (R12 b). It can't happen today, because PostgrestError has no `status`.
- Q (PM): a NULL or missing `ingredient_id`: skip or refuse? → A: **Refuse with 22023** (R3). It's a malformed payload, not a stale catalog.
- Q (PM): privileged callers? → A: **Same behaviour** (R11).
- Q (PM): audit skipped ids? → A: **Recommended: no.** The architect may adopt it under R15's constraints.

## Dependencies

- **Spec 193 (hard dependency; uncommitted, `READY_FOR_REVIEW`).**
  - This spec's `create or replace` must start from 193's landed `staff_submit_eod` body ([20261109190000_staff_eod_date_bound.sql](../supabase/migrations/20261109190000_staff_eod_date_bound.sql) L320-430), and from its writer too if the writer changes.
  - It must not land before 193.
  - 193 also edits `useEodSubmit.test.ts` (its AC-9 and AC-10). Build on top of those edits.
  - If 193's body changes in review, re-sync before building.
- **Spec 185 (DRAFT, area-scoped staff replace)** also rewrites the staff wrapper. Whichever spec lands second carries the other's hunks. This is a sequencing risk, not a blocker.
- Spec 179 (`store_id` immutable) and the NO ACTION FK on `eod_entries.item_id` underpin R9's "a prior row is impossible" argument. The architect should confirm both against the tree.
- No library, edge function or realtime dependency.

## Project-specific notes

- **Cmd UI section:** none. This is the staff surface ([src/screens/staff/](../src/screens/staff/)) and its RPC. The admin Cmd UI doesn't call `staff_submit_eod`.
- **Which app:** the staff EOD app in this repo (spec 063 fold-in).
- **Per-store or admin-global:** per-store. The validity test is "item belongs to `p_store_id`", and the `auth_can_see_store()` gate is unchanged.
- **Edge function or PostgREST:** PostgREST RPC. No edge function.
- **Realtime channels touched:** none. There's no publication change (`audit_log` and `eod_*` publication membership is unchanged), so the realtime-slot restart gotcha doesn't apply.
- **Migrations needed:** yes, one (see In scope).
- **Edge functions touched:** none.
- **Web/native scope:**
  - The server fix protects every installed client at once. A count that hits a deleted item is now saved, minus that item, and dequeued normally.
  - The narrowed `isForbidden` and the notice reach web at the next Vercel deploy and native at the next EAS build. Until then, installed builds lose only R10's race case and show no notice.
- **`app.json` slug:** not touched.
- **Tests:** pgTAP (AC-1 to AC-12) and jest (AC-13 to AC-21). No shell smoke.

## Residual risk

- **R4 refusals retry forever.** A queued count whose every item was deleted stays at the head of the queue and is retried at every drain. Only the "N pending" pill shows it. This is the same posture as spec 193's stuck items, and the needs-attention follow-up covers it.
- **Old installed clients show no notice.** Skips are silent there until the client update ships.
- **R10's race.** If the architect doesn't adopt the lock, a delete that commits between the check and the insert still yields 42501. The new client retries it; installed clients still dequeue it.

## Prod apply and commit (owner, later; not part of this spec's done state)

- **Commit:** don't commit without the owner's explicit go-ahead.
- **Prod apply** (project `ebwnovzzkwhsdxkpyjka`, via the Supabase MCP): only on the owner's explicit go-ahead, and only **after** spec 193 is on prod. Run `execute_sql`, then insert the exact version into `supabase_migrations.schema_migrations`.
- **md5 checks:**
  - **Pre-check:** the normalized md5 of prod's `staff_submit_eod` (and of `eod_write_submission`, if it's replaced) matches 193's local bodies.
  - **Post-check:** the md5s match this migration's bodies, and `prosecdef`, `proconfig` and the ACL are as in AC-12.
- **Gates:** apply on prod before pushing to `main`. Then confirm that `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` by hand.

## Handoff
next_agent: backend-architect
prompt: Design the contract for this spec. Read the acceptance criteria
  and any project-specific notes, then produce the design doc and set
  Status: READY_FOR_BUILD.
payload_paths:
  - specs/199-staff-eod-skip-unknown-items.md

---

## Backend design

Architect, 2026-11-10. Built on spec 193's **uncommitted** bodies in `supabase/migrations/20261109190000_staff_eod_date_bound.sql` (writer L114-307, wrapper L320-430, as read on 2026-11-10). If 193's wrapper changes in review, re-sync §2.3 before building. The design changes **only the staff wrapper**. `eod_write_submission` and `admin_submit_eod` are not in the migration, so their bodies stay byte-identical.

### 0. Decisions at a glance

| # | Decision | Choice |
|---|---|---|
| D-1 | Where the check runs | The `staff_submit_eod` wrapper only. It filters `p_entries` and passes the filtered array to the writer in place of `p_entries`. The writer is untouched. |
| D-2 | Envelope key | **`skipped_item_ids`**: a JSON array of uuid strings, distinct, order not part of the contract. Present on every non-replay success; `[]` when nothing was skipped. Absent on the replay envelope. |
| D-3 | R3 message (NULL or absent id) | `'staff_submit_eod: every p_entries element needs an ingredient_id'`, SQLSTATE 22023 |
| D-4 | R4 message (all skipped) | `'staff_submit_eod: no p_entries element names an item of this store'`, SQLSTATE 22023 |
| D-5 | R10 lock | **Adopted.** One locking statement (`FOR KEY SHARE`) defines the valid set. This closes the delete-between-check-and-insert race (§2.4). |
| D-6 | R15 skip audit | **Not adopted.** No `audit_log` row for skips (§2.6). |
| D-7 | R9 `Count cleared` | No writer change needed. The writer's NULL-branch `NOT EXISTS` filter already reads the array it was given. Once that array is the filtered list, the re-sent test runs against the entries actually written (§2.5). |
| D-8 | Client notice | `Outcome.success` gains an optional `skipped_count`. EODCount folds the notice into its single success toast. The drain sums skips in a ref and replaces its debounced `allSynced` toast with one combined notice (§5). |
| D-9 | `isForbidden` | `code === '42501'` → forbidden only if the message contains `'staff_submit_eod: caller cannot see store'`. With no 42501 code, `status === 403` → forbidden. The bare "message contains 42501" fallback is removed (§5.2). |
| SR-1 | Spec reconciliation (needs main-session ack, see §9) | `admin_submit_eod.test.sql` arm (16) pins the **staff** envelope's key set and has to gain `'skipped_item_ids'`. All of its admin-path arms stay untouched. |

### 1. Data model changes

- **None.** No table, column, index, constraint, trigger, policy, grant or publication change.
- **One migration (additive, behaviour-only):** `supabase/migrations/20261110130000_staff_eod_skip_unknown_items.sql`. Re-glob `supabase/migrations/` at build time. If another session has taken a version at or after `20261110130000`, take the next free slot after the current latest.
- **Rollout safety.**
  - `create or replace` with the same signature, so the ACL (postgres + authenticated) carries over and in-flight clients see no signature break.
  - The success envelope gains a key. Installed clients cast `data as StaffSubmitEodResponse` and read only `submission_id` and `conflict`, so the extra key is ignored.
- **Underpinnings confirmed against the tree:**
  - `eod_entries.item_id` references `inventory_items(id)` with no ON DELETE clause, so NO ACTION ([init schema](../supabase/migrations/20260405000759_init_schema.sql) L131).
  - Spec 179's `inventory_items_identity_lock_trg` makes `id` and `store_id` immutable on UPDATE ([20261026100000_inventory_items_identity_lock.sql](../supabase/migrations/20261026100000_inventory_items_identity_lock.sql) L93-128).
  - `eod_entries_check_store_trg` is BEFORE INSERT OR UPDATE ([20260514120030](../supabase/migrations/20260514120030_eod_submissions_consistency.sql) L104-138), so it fires before the FK's RI check. That is why the race surfaces as 42501 rather than 23503.
  - R9's "no prior row" argument holds.

### 2. The migration, `20261110130000_staff_eod_skip_unknown_items.sql`

Shape mirrors 193's file: `begin;` → `set local lock_timeout = '5s';` → pre-flight → `create or replace function public.staff_submit_eod` → `comment on function` → `commit;`. **Nothing else.** In particular, the file must not contain the text `create or replace function public.eod_write_submission` or anything touching `admin_submit_eod`.

#### 2.1 Header comment (required content)

- What changes: the wrapper filters `p_entries`, refuses on R3 and R4, locks the checked items, and adds `skipped_item_ids` to the success envelope. The writer, `admin_submit_eod` and the trigger are unchanged.
- The R10 residual (§2.4), stated verbatim enough that a reader understands the lock's guarantee and the 40P01 caveat.
- The PROD-APPLY and ROLLBACK paragraphs from §7 and §8.
- The spec 185 sequencing note: 185 also rewrites this wrapper, so whichever spec lands second carries the other's hunks.
- No realtime restart step, since there is no publication change.
- The test file list from §6.

#### 2.2 Pre-flight (0)

This refuses an out-of-order hand apply, which matters because prod must have 193 first. It is a `do $$ … $$` block that raises SQLSTATE `55000` with a message naming spec 193 (`'spec 199 pre-flight: spec 193 (20261109190000_staff_eod_date_bound) is not applied …'`) unless **all three** of these hold:

- `to_regprocedure('public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)')` is not null;
- the live `staff_submit_eod` `prosrc` contains `eod_write_submission(` **and** `America/New_York` (193's date window);
- the live writer's `prosrc` contains `not exists` (193's R9 filter, the same marker arm (69) of the 193 suite pins).

#### 2.3 New `staff_submit_eod` body

Start from 193's L320-430 **verbatim**. Keep:

- every existing comment and step, in order: vendor NULL → (1.5) store gate → (3) actor → (4) idempotency replay → O-1 → date window;
- `security definer` and `set search_path = public`, both restated;
- the `America/New_York` literal, with no `current_date`. 193's arms (35) and (36) pin these.

**Insert** one block between the date-window `end if;` and the writer call, and change **only** the writer call's 5th argument and its return. Pseudocode (the developer authors the SQL):

```
declare (add):
  v_ids        uuid[];            -- distinct payload ids
  v_valid_ids  uuid[];            -- ids that exist at p_store_id, locked
  v_skipped    uuid[];            -- v_ids minus v_valid_ids
  v_entries    jsonb;             -- p_entries filtered, original element order
  v_result     jsonb;

-- Spec 199 (R3). After the date window. A NULL or absent ingredient_id
-- (or a non-object element, whose ->> is NULL too) refuses the whole call.
if exists (select 1 from jsonb_array_elements(p_entries) as e(elem)
            where e.elem ->> 'ingredient_id' is null) then
  raise exception 'staff_submit_eod: every p_entries element needs an ingredient_id'
    using errcode = '22023';
end if;

-- Spec 199 (R2). Distinct payload ids. A non-uuid string raises 22P02 here,
-- as it did in the writer's jsonb_to_recordset before (same SQLSTATE).
v_ids := array(select distinct (e.elem ->> 'ingredient_id')::uuid
                 from jsonb_array_elements(p_entries) as e(elem));

-- Spec 199 (R10). ONE locking statement defines the valid set. FOR KEY SHARE
-- blocks a concurrent DELETE (and key UPDATE) of these rows until commit,
-- and is compatible with the writer's own current_stock UPDATE (FOR NO KEY
-- UPDATE). In READ COMMITTED a row deleted by a transaction that commits
-- while we wait on its lock is dropped from the result, so it is skipped,
-- not inserted. The locking clause sits in a FROM sub-select because
-- FOR KEY SHARE is not allowed alongside an aggregate. ORDER BY id gives
-- a deterministic lock order.
select coalesce(array_agg(s.id), '{}'::uuid[]) into v_valid_ids
  from (select ii.id
          from public.inventory_items ii
         where ii.id = any (v_ids)
           and ii.store_id = p_store_id
         order by ii.id
           for key share of ii) s;

v_skipped := array(select x from unnest(v_ids) as x where x <> all (v_valid_ids));

-- Spec 199 (R4). Nothing valid left: refuse before any write.
if cardinality(v_valid_ids) = 0 then
  raise exception 'staff_submit_eod: no p_entries element names an item of this store'
    using errcode = '22023';
end if;

-- Filtered payload: original elements byte-for-byte (every key kept) in
-- original order. Duplicates of a valid id stay, so the writer still
-- raises 23505 for them (AC-10).
select jsonb_agg(e.elem order by e.ord) into v_entries
  from jsonb_array_elements(p_entries) with ordinality as e(elem, ord)
 where (e.elem ->> 'ingredient_id')::uuid = any (v_valid_ids);

v_result := public.eod_write_submission(
  p_store_id, p_date, p_vendor_id, p_status,
  v_entries,                 -- was p_entries
  p_client_uuid, null, v_actor, null);

return v_result || jsonb_build_object('skipped_item_ids', to_jsonb(v_skipped));
```

Notes for the developer:

- **Check order is exactly R6 + R3 → R2 → R4.** An outsider gets 42501, a processed uuid replays (no new key), `'[]'` gets O-1, out-of-window gets the date refusal, and only then R3, R2 and R4 run.
- **R2 predicate.** Valid iff `id = ingredient_id AND store_id = p_store_id`. A NULL `store_id` item fails `=`, so it is skipped. That is the exact complement of the trigger's check (`v_item_store_id is null or is distinct from submission store`), because the wrapper's parent `store_id` is `p_store_id`.
- **R11 (privileged callers).** There is no `auth_is_privileged()` branch in the new block. A privileged caller gets the same skip, refuse and report behaviour.
- **R7 (refusals write nothing).** R3 and R4 raise before the writer, so there is no parent upsert, no delete, no `Count cleared` row, no on-hand change and no notification. The KEY SHARE locks are released by the rollback.
- **Definer context.** The wrapper is `SECURITY DEFINER` owned by `postgres`, so the `inventory_items` read bypasses RLS. That is intended: a cross-store id must be *seen* in order to be classified. Its existence leaks nothing, because the response only echoes ids the caller sent. The locking clause requires UPDATE privilege on `inventory_items`, which the owner has.
- **R5 and R13 message rules.** Neither the R3 nor the R4 message contains `42501`, `network`, `failed to fetch`, `aborted`, `timeout` **or `caller cannot see store`**. The last matters because the client's forbidden match is a substring (§5.2). There is no interpolation, DETAIL or HINT.
- **Non-object elements.** An element such as `[1]` or `["x"]` now gets the R3 refusal (22023). Before, it got `jsonb_to_recordset`'s own 22023. The SQLSTATE is the same and the shipped client classifies it the same way.

#### 2.4 R10: the race, with the lock adopted

- **Closed.** A DELETE committed *before* the locking SELECT's snapshot is invisible, so the item is skipped. A DELETE that holds the row lock while we wait is re-checked after it commits (EvalPlanQual) and dropped from the result, so the item is skipped. A DELETE that starts *after* we hold KEY SHARE waits for our commit. Its NO ACTION RI check then sees the new `eod_entries` row and fails with 23503. That is the correct outcome, because the item now has history. The trigger can't see a vanished item between the check and the insert.
- **Residuals (document in the header):**
  - (a) A deadlock against a multi-row DELETE that locks the same items in another order can abort the submit with `40P01`. `deleteInventoryItem` ([src/lib/db.ts](../src/lib/db.ts) L3018) deletes one row, so this needs a bulk or cascade delete. `40P01` is neither forbidden nor network, so the new client and installed clients both keep the item and retry it.
  - (b) A long-running DELETE that holds the row makes the submit wait, bounded by PostgREST's statement timeout. If that timeout fires, the shipped client's "other" branch keeps the item.
  - (c) KEY SHARE also blocks an UPDATE of a unique-indexed column on these rows for the length of the submit, which is milliseconds.
- **Two staff submits** for the same items both take KEY SHARE, which is compatible. Their later `current_stock` UPDATEs take NO KEY UPDATE, which is also compatible with KEY SHARE. Any deadlock between two submits' UPDATEs predates this spec.

#### 2.5 R9: `Count cleared` interaction (no writer change)

- In 193's writer NULL branch, `delete … returning` deletes every row of the submission. The audit insert's `NOT EXISTS (… jsonb_to_recordset(coalesce(p_entries,'[]')) …)` then reads the writer's `p_entries` argument, which is now `v_entries`, the filtered list. So:
  - **AC-8:** S holds I1 and I2, and `[I1, D]` filters to `[I1]`. I1 and I2 are deleted. I2 is not in `[I1]`, so it gets one `Count cleared` row. I1 is re-inserted and gets only its per-entry row. D never had a row, so it gets nothing.
  - **Legacy cross-store row** (pre-2026-05-14): X is skipped, so it isn't in `v_entries`. Its old row is deleted and gets a truthful `Count cleared` row whose `item_ref` is X's catalog name (the writer's left joins). It is never removed silently.
  - A skipped item with no prior row deletes nothing, so it gets no `Count cleared` row.
- No change to `eod_write_submission`'s signature, `security invoker`, `search_path`, comment or revoked ACL. AC-12's "if the writer was replaced" clause doesn't apply.

#### 2.6 R15: why no skip audit

The response already carries the ids to the only party who can act on them. A deleted item has no catalog name to record. A cross-store id only comes from a buggy or hostile client, and auditing it under the *calling* store would put a foreign item's name into that store's audit feed (the AC-2 constraint). Not adopting it also keeps the `(store, 'EOD entry', item_ref)` scalar subqueries in the existing suites stable.

#### 2.7 Function comment

Re-issue `comment on function public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)`. The value is a new leading spec 199 sentence followed by 193's comment text **verbatim**. The spec 199 sentence covers:

- the R3, R2 and R4 order after the date window;
- both constant messages;
- the `FOR KEY SHARE` lock;
- the `skipped_item_ids` key (always present on a non-replay success, absent on replay);
- the fact that the writer receives the filtered list, so `Count cleared` is judged against the written entries.

There is no grant or revoke. The signature is unchanged, so the ACL carries over.

### 3. RLS impact

- **No policy changes.** The wrapper stays `SECURITY DEFINER` and keeps its explicit `auth_can_see_store(p_store_id)` gate at step 1.5 (unchanged code, unchanged message).
- The writer stays `SECURITY INVOKER` with EXECUTE revoked from `public`, `anon`, `authenticated` and `service_role`.
- `eod_entries_check_store_trg` is unchanged and still guards `admin_submit_eod`, direct inserts and any future writer.
- There are no new tables, so there is no permissive-policy lint exposure.

### 4. API contract (PostgREST RPC, `POST /rest/v1/rpc/staff_submit_eod`)

**Signature (unchanged):**

`public.staff_submit_eod(p_client_uuid uuid, p_store_id uuid, p_date date, p_submitted_by text, p_status text, p_entries jsonb, p_vendor_id uuid) returns jsonb`

The function is `SECURITY DEFINER` with `search_path = public`, and EXECUTE is granted to `authenticated` only.

**Request:** unchanged. `p_entries` is a non-empty array of objects carrying `ingredient_id` (uuid, required), plus the optional `actual_remaining`, `actual_remaining_cases`, `actual_remaining_each`, `unit`, `notes` and `no_need`.

**Responses:**

| Case | HTTP | Body / error |
|---|---|---|
| Fresh write (any skips or none) | 200 | `{submission_id, conflict:false, entry_ids:[…written only], stock_updates:[…written numeric+linked only], skipped_item_ids:[…distinct, or []]}`. Exactly these 5 keys. |
| Replay of processed `client_uuid` | 200 | `{submission_id, conflict:true, reason:'client_uuid already processed'}`. Unchanged, **no** `skipped_item_ids`. |
| `p_vendor_id` NULL | 400 | 22023 `'staff_submit_eod: vendor_id is required as of spec 020'` (unchanged) |
| Caller can't see store | 403 | 42501 `'staff_submit_eod: caller cannot see store <uuid>'` (unchanged; the prefix is now a client contract, R13) |
| Empty/NULL/non-array `p_entries` | 400 | 22023 O-1 message (unchanged; judged on the **raw** payload) |
| Out of date window (non-privileged) | 400 | 22023 spec 193 message (unchanged) |
| Any element with NULL/absent `ingredient_id` (R3) | 400 | 22023 `'staff_submit_eod: every p_entries element needs an ingredient_id'` |
| Non-uuid `ingredient_id` string | 400 | 22P02 (unchanged SQLSTATE; now raised in the wrapper) |
| Every element skipped (R4) | 400 | 22023 `'staff_submit_eod: no p_entries element names an item of this store'` |
| Valid item repeated | 409 | 23505 (unchanged) |
| NO NEED + quantity on a **valid** element | 400 | 23514 (unchanged; a skipped element is never evaluated) |
| Delete/lock deadlock (§2.4 a) | 4xx/5xx | 40P01 (rare; the client keeps the item and retries it) |

### 5. Client contract (frontend-developer)

The staff subtree is a documented `db.ts` carve-out (CLAUDE.md, spec 063). Everything stays inside `src/screens/staff/`.

#### 5.1 Types, [src/screens/staff/lib/types.ts](../src/screens/staff/lib/types.ts) (L143-157)

```ts
export type StaffSubmitEodResponse = {
  submission_id: string;
  conflict: boolean;
  reason?: string;
  /** Spec 199 — ids the server dropped (missing, or not at this store).
   *  On every non-replay success from a spec-199 server ([] when none);
   *  absent on a replay and on older servers → treat as 0. */
  skipped_item_ids?: string[];
};

export type Outcome =
  | { kind: 'success'; submission_id: string; skipped_count?: number } // present only when > 0
  | { kind: 'success-replay'; submission_id: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'queued'; client_uuid: string }
  | { kind: 'failed'; message: string };
```

`skipped_count` is **omitted** when the count is 0. That keeps the existing `toEqual({ kind: 'success', submission_id: 'sub-1' })` arms and AC-19's "outcome unchanged" true. There is no snake→camel mapping layer: the staff subtree reads the RPC body as-is, and `skipped_count` is a client-side field.

#### 5.2 `isForbidden`, [src/screens/staff/hooks/useEodSubmit.ts](../src/screens/staff/hooks/useEodSubmit.ts) L61-68

```ts
const STORE_GATE_TEXT = 'staff_submit_eod: caller cannot see store'; // pinned server-side by pgTAP (R13)

function isForbidden(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: string; message?: string; status?: number };
  const msg = typeof e.message === 'string' ? e.message : '';
  if (e.code === '42501') return msg.includes(STORE_GATE_TEXT); // SQLSTATE+message beat status (R12)
  return e.status === 403;                                     // R12 (b)
}
```

- The bare "message contains `42501`" fallback is **deleted**.
- `isNetworkError` and the order of branches (forbidden → network → other) are unchanged.
- A trigger-style 42501, an anon-session `permission denied for function staff_submit_eod`, and `42501` + `status: 403` with a non-gate message all fall to the "other" branch. In the drain that branch bumps attempts and continues. Online it returns `{ kind: 'failed', message: t('eod.toast.failed') }` (R12).
- Add a header comment above the constant that cross-references the pgTAP pin from §6 by file name.

#### 5.3 Skip count helper (same file, module-private)

`function skippedCount(res: StaffSubmitEodResponse): number` returns `Array.isArray(res.skipped_item_ids) ? res.skipped_item_ids.length : 0`. Only use it when `res.conflict !== true`.

#### 5.4 Online notice (R14, AC-17)

- **Hook (`submit`, L282-290).** On a fresh success, `const n = skippedCount(res)`. Return `{ kind: 'success', submission_id }`, or that plus `skipped_count: n` when `n > 0`. The hook shows **no** toast on the online path; the screen owns the toast, as it does today.
- **Screen ([src/screens/staff/screens/EODCount.tsx](../src/screens/staff/screens/EODCount.tsx) L921-927).** Keep the **single** success toast and add the notice to it:
  `Toast.show({ type: 'success', text1: t('eod.toast.submitted'), position: 'bottom', ...(outcome.skipped_count ? { text2: t('eod.toast.skippedItems', { count: outcome.skipped_count }), visibilityTime: 6000 } : {}) })`.
  - The toast library shows one toast at a time, and this is the only toast in the success branch (`enterLockedAfterWrite` shows none). The notice is therefore the last toast shown, and nothing in the flow overwrites it.
  - With no skips, the call is byte-identical to today's.
  - `enterLockedAfterWrite()` and the locked state are unchanged.

#### 5.5 Drain notice (R14, AC-18)

- Add `const skippedPendingRef = useRef(0);` next to `allSyncedTimerRef`. In the success branch of the drain loop (L157-174), when `!res.conflict`, do `skippedPendingRef.current += skippedCount(res)`.
- Replace the post-loop block (L207-222) with these semantics:
  - `const showAllSynced = drainedAny && pendingCountForUser(me) === 0;`
  - If `showAllSynced || skippedPendingRef.current > 0`: clear any pending `allSyncedTimerRef` timer and schedule **one** timer (`DRAIN_TOAST_DEBOUNCE_MS`). Its callback first reads and resets the ref: `const n = skippedPendingRef.current; skippedPendingRef.current = 0;`. Then:
    - if `n > 0`: `Toast.show({ type: 'info', text1: t('eod.toast.skippedItems', { count: n }), ...(showAllSynced ? { text2: t('eod.toast.allSynced') } : {}), position: 'bottom', visibilityTime: 6000 })`;
    - else: the **existing** allSynced toast, byte-identical (`type: 'success'`, `text1: t('eod.toast.allSynced')`, `position: 'bottom'`, `visibilityTime: 2500`).
  - Otherwise, schedule nothing and **don't** clear a timer from an earlier pass.
- Why a ref and not a local total:
  - It carries skips across back-to-back passes (for example the mount drain followed by a connectivity-flip drain inside 400 ms). A later pass's `clearTimeout` can't silently drop an earlier pass's skip count; the count rolls into the rescheduled toast. The staff member gets **one** notice with the total.
  - The total also reaches the staff member when the queue isn't empty after the pass (another item is stuck), which the old `allSynced` condition would have hidden.
- Capture `showAllSynced` in the closure at scheduling time, as today. Don't re-read the store in the callback.

#### 5.6 i18n: one new key, `eod.toast.skippedItems`, in all three catalogs

The key is number-agnostic, because the staff `t()` does `{var}` substitution only with no plural rules. Keep each string short: it renders in a default single-line toast field (text2 online).

| Locale | Value |
|---|---|
| en | `"{count} skipped: no longer in your catalog"` |
| es | `"{count} omitidos: ya no están en el catálogo"` |
| zh-CN | `"已跳过 {count} 项：已不在目录中"` |

- The exact wording is the frontend developer's call within these constraints: one token `{count}`, identical across locales, and no plural forms.
- Verify the rendered text isn't truncated on a phone-width web preview (memory: verify UI with preview tools).
- The existing parity and token tests in `src/screens/staff/i18n/i18n.test.ts` cover AC-20 with no edit.

#### 5.7 Not changed

- `isNetworkError`, the queue GC and `eodQueue.ts` stay as they are. The `drainQueue` helper and its `DrainOutcome` are unused by the hook and are out of scope.
- The forbidden-dequeue toast (`chrome.queue.syncErrorBanner`) is unchanged.
- The replay toast is unchanged.
- **Pre-existing:** a same-pass debounced toast can replace an earlier immediate error toast. `allSynced` already does this today; it is not introduced here.

### 6. Tests

#### 6.1 pgTAP, new suite `supabase/tests/staff_submit_eod_skip_unknown.test.sql` (backend-developer)

Follow 193's suite posture:

- `begin; … rollback;`;
- fixtures created in-transaction with a `SPEC199-*-<tag>` naming;
- seed manager `2222` (member of Frederick, not Charles) and seed admin `1111`;
- anchor-relative in-window dates (for example `A - 2`, `A - 3`, a fresh triple per arm, using a fresh vendor per arm where a fresh parent is needed);
- every "unchanged" read is done as `postgres`;
- no `set role anon`.

Fixtures:

- **I1 and I2:** Frederick items, numeric, linked via `item_vendors` to the arm's vendor.
- **X:** a Charles item with a known `current_stock`, `eod_remaining` and `updated_at`.
- **D:** `gen_random_uuid()`.
- **S:** seeded as `postgres` through `staff_submit_eod`'s writer path, or via direct inserts, holding I1 and I2.

| Arms | AC | What |
|---|---|---|
| SK1 | AC-1 | `[I1, D]` → `conflict:false`, `skipped_item_ids = [D]`, one entry (I1), `entry_ids` length 1, `stock_updates` names only I1, one `'EOD entry'` per-entry row for I1, none for D |
| SK2 | AC-2 | `[I1, X]` → `[X]`; X's `current_stock`/`eod_remaining`/`updated_at` unchanged; no Frederick `audit_log` row with X's catalog name |
| SK3 | AC-3 | valid-only payload → key set exactly `{conflict, entry_ids, skipped_item_ids, stock_updates, submission_id}` and `skipped_item_ids = '[]'::jsonb` |
| SK4 | AC-4 | `[D, X]` first submit → `throws_ok(…, '22023', <R4 msg>)`; no parent at the triple |
| SK5 | AC-5 | `[D]` over S → R4; S's `submitted_at`/`status`/`client_uuid`, entry ids+values, I1/I2 on-hand, store `audit_log` count (incl. Count cleared) and `notifications` count unchanged (snapshot-then-compare like 193's `state_of`) |
| SK6 | AC-6 | Capture SQLSTATE and SQLERRM for R3 and R4 in a `do` block (193 DL pattern). State is `22023`, and the message `!~*` `'42501\|network request failed\|failed to fetch\|aborted\|timeout\|network\|caller cannot see store'` |
| SK7 | AC-7 | `[I1, {"ingredient_id":null}]` and `[I1, {}]` → each `throws_ok '22023', <R3 msg>`; over S both leave AC-5's read-backs unchanged |
| SK8 | AC-8 | `[I1, D]` over S → S holds only I1; exactly one new `Count cleared` row and it names I2; none names I1; `skipped_item_ids = [D]` |
| SK9 | AC-9 / R13 | Store gate: outsider on Charles with `[D]` → SQLSTATE 42501 **and** `SQLERRM like 'staff_submit_eod: caller cannot see store%'` (captured in a `do` block; this is the R13 pin, and its description names `useEodSubmit.ts STORE_GATE_TEXT`). Replay of S's `client_uuid` with `[D]` → key set exactly `{conflict, reason, submission_id}`, `conflict:true`, S's id, nothing changed. O-1 `'[]'`, date `A - 36` + `[D]`, and vendor NULL + `[D]` → each raises its unchanged code and message |
| SK10 | AC-10 | `[I1, I1]` → 23505 and S unchanged when sent over S. `[I1, D, D]` → success, `skipped_item_ids = [D]` (length 1) |
| SK11 | AC-11 | JWT `admin` caller: AC-1 result and AC-4 refusal |
| SK12 | AC-12 | `staff_submit_eod`: `prosecdef = true`, `proconfig = {search_path=public}`, EXECUTE for `authenticated` only (not `anon`, not `service_role`). `has_trigger('public','eod_entries','eod_entries_check_store_trg')`. A store member's direct `INSERT` into `eod_entries` of X under their own Frederick submission → 42501. Writer: `prosecdef = false`, `proconfig = {search_path=public}`, no `authenticated` EXECUTE (unchanged posture) |
| SK13 | R10 structural | `prosrc` of `staff_submit_eod` `ilike '%for key share%'`. A pin, not a concurrency test, because pgTAP can't run two sessions |

**Existing suites:**

- **`supabase/tests/admin_submit_eod.test.sql` arm (16), L325-328 (SR-1).** The expected array becomes `array['conflict', 'entry_ids', 'skipped_item_ids', 'stock_updates', 'submission_id']`. Update the description to say "plus spec 199's skipped_item_ids". This is the only edit to that file. Every admin-path arm, including (56)'s admin cross-store 42501, stays byte-identical.
- **Every other suite that calls `staff_submit_eod`** (identity_lock T22, date_bound, cases_each, eod_no_need, eod_update_notifications, multi_vendor, staff_role_eod_rls, edit_flow, audit_log_rls_hardening, reports_anon_revoke) was checked by grep. None sends a missing or cross-store item expecting 42501, and none pins the staff envelope's key set. They should pass untouched.
- The developer must still run the **full** pgTAP set (`scripts/test-db.sh`) and fix, not delete, any arm that pinned the old wide behaviour.

#### 6.2 Jest (frontend-developer)

**[src/screens/staff/hooks/useEodSubmit.test.ts](../src/screens/staff/hooks/useEodSubmit.test.ts):**

- **AC-21 migration.** Update the L115-128 arm's message to `'staff_submit_eod: caller cannot see store 00000000-0000-0000-0000-000000000001'`. Keep the test; don't delete it.
- **AC-13.** Drain + store-gate error → `dequeueEod`, and an error toast with `text1: t('chrome.queue.syncErrorBanner', …)`.
- **AC-14.** Drain + `{code:'42501', message:'eod_entries: item store mismatch with parent submission'}`:
  - attempts are bumped and the item is kept;
  - the next FIFO item is still submitted in the same pass;
  - repeat with `permission denied for function staff_submit_eod`, and with the trigger message plus `status: 403`. `it.each` is fine.
- **AC-15.** Drain + `{status: 403}` → dequeued.
- **AC-16.** Online store gate → `forbidden`. Online trigger-style 42501 → `{ kind:'failed', message: t('eod.toast.failed') }`, and the queue stays empty.
- **AC-17 (hook half).** A response with 2 skipped ids → `toEqual({ kind:'success', submission_id:'sub-1', skipped_count: 2 })`, and `Toast.show` is not called by the hook.
- **AC-18.**
  - Two queued items, responses with 1 and then 2 skipped ids → the queue empties.
  - After the debounce, the **last** `Toast.show` call is `{type:'info', text1: t('eod.toast.skippedItems',{count:3}), text2: t('eod.toast.allSynced'), …}`, and `allSynced` is not shown as a separate later toast. Use real timers + `waitFor(…, {timeout: 1500})`, or fake timers.
  - A no-skip drain → the last call equals today's allSynced toast exactly.
- **AC-19.** A success without the key → outcome `toEqual({kind:'success', submission_id})` with no `skipped_count` property (assert `'skipped_count' in outcome === false`). In the drain, no skipped toast.

**[src/screens/staff/screens/EODCount.test.tsx](../src/screens/staff/screens/EODCount.test.tsx) (AC-17, screen half):**

- `mockSubmit` resolves `{kind:'success', submission_id:'sub-1', skipped_count: 2}`. After submit, the last `Toast.show` call has `text1: t('eod.toast.submitted')` and `text2: t('eod.toast.skippedItems',{count:2})`, and the screen is in its locked state (reuse the existing success arm's lock assertion).
- No-skip success still shows the plain submitted toast **without** a `text2` key.

**Re-grep (AC-21):**

- staff tests with `42501` or `403` fixtures that feed `useEodSubmit`. Only L115-128 was found. The `receiving` and `fetchReorder` 42501 fixtures belong to other hooks and are unaffected.
- `e2e/eod.spec.ts` drains a queued item. A spec-199 server returns `skipped_item_ids: []`, so there's no notice and its assertions hold.

Gates: full `npx jest`, `npm run typecheck` plus `typecheck:test`, and full pgTAP.

**No shell smoke.** `scripts/smoke-staff-eod.sh` has uncommitted edits from another session; don't touch it.

### 7. Prod-apply plan (owner's go-ahead only; after spec 193 is on prod)

Project `ebwnovzzkwhsdxkpyjka`, via the Supabase MCP. Don't use `supabase db push`: this version can sort before or after other sessions' pending versions.

1. **Pre-check.**
   - `select version from supabase_migrations.schema_migrations where version in ('20261109120000','20261109190000')` returns both rows. 193 must be on prod.
   - Record the **normalized md5** of `prosrc` for `staff_submit_eod`, `eod_write_submission` and `admin_submit_eod` on prod, using the same normalization as earlier applies.
   - `staff_submit_eod` and `eod_write_submission` must equal the local spec 193 bodies. Record `admin_submit_eod`'s value. Stop on any mismatch.
   - Count legacy cross-store entry rows (read-only; security-auditor Low 1). These predate the 2026-05-14 trigger; a skipped item that still has one gets a `Count cleared` audit row naming another store's item in the calling store's feed. Record the number (0 locally) and show the owner any rows before applying:
     `select count(*) from public.eod_entries e join public.eod_submissions s on s.id = e.submission_id join public.inventory_items ii on ii.id = e.item_id where ii.store_id is distinct from s.store_id;`
2. **Apply.** `execute_sql` with the migration file's full text (its `begin … commit` and pre-flight included). A 55000 pre-flight failure means 193 isn't really there; stop.
3. **Record.** `insert into supabase_migrations.schema_migrations (version, name) values ('20261110130000', 'staff_eod_skip_unknown_items')`. Use the exact version from the filename the developer lands, and the same column set prior MCP applies used.
4. **Post-check.**
   - `staff_submit_eod`'s normalized md5 equals the local spec 199 body.
   - `eod_write_submission`'s and `admin_submit_eod`'s md5 are **unchanged** from step 1.
   - `staff_submit_eod`: `prosecdef = true`, `proconfig = {search_path=public}`, `proacl` lists only the owner and `authenticated`.
   - The writer's `proacl` is owner-only, not NULL.
   - The `pg_description` comment starts with `spec 199`.
5. **Push and gates.** Push to `main` only after step 3. Then confirm the latest `test.yml` **and** `db-migrations-applied.yml` runs on `main` are green, and check `e2e.yml` by hand.

### 8. Rollback

- **Server.** A forward migration with its own new version that re-creates `staff_submit_eod` from spec 193's body **verbatim**, with 193's comment, `security definer` and `search_path` restated. No grant change.
  - The writer and `admin_submit_eod` don't need touching.
  - Delete or adjust `staff_submit_eod_skip_unknown.test.sql` and revert arm (16) of `admin_submit_eod.test.sql` in the same PR.
  - Data written under 199 (partial counts, `Count cleared` rows) is kept.
- **Client after a server rollback.**
  - With the key absent, the client treats the skip count as 0, which is safe.
  - The narrowed `isForbidden` stays correct for the store gate. A deleted item on a rolled-back server raises the trigger's 42501, which the new client **retries forever** instead of dequeuing. The count isn't lost; it is stuck behind the "N pending" pill.
  - Prefer rolling the client back together with the server, unless the owner accepts that stuck state.
- **Interaction with a 193 rollback (193 §10, §11).** Rolling back 193's wrapper after 199 would silently drop 199's filter. A 193 rollback written after 199 must restore 199's body, minus the date block, or roll 199 back first.

### 9. Risks, tradeoffs and items needing acknowledgement

- **SR-1 (spec contradiction, resolved by the architect, needs main-session ack).**
  - R1 says "every existing `admin_submit_eod.test.sql` arm passes untouched". But arm (16) of that suite asserts the **staff** envelope's exact key set. R8/AC-3 require the new key to be **always present**, so the two can't both hold without editing arm (16).
  - The design edits arm (16) by adding `'skipped_item_ids'` to its expected array. It is a staff-path pin that sits inside the admin suite. Every admin-path arm stays untouched, which matches R1's stated intent ("`admin_submit_eod` behaviour must not change").
  - The alternative is to make the key present only when non-empty. That breaks R8 and AC-3 and wasn't chosen. If the owner prefers it, the change is local: `v_result` is returned unchanged when `v_skipped` is empty, and AC-3 and AC-19 flip.
- **Hard dependency on spec 193 (uncommitted).** The migration's pre-flight refuses without 193. Build and apply order: 193 is committed and on prod, then 199. If 193's wrapper changes in review, re-base §2.3 on it.
- **Spec 185 (DRAFT)** also rewrites this wrapper. Whichever spec lands second carries the other's hunks. 185's area-scoped replace would also need to filter its own payload through the same skip block.
- **The R4 retry-forever** is an accepted residual. It is the same posture as 193's stuck items and the `attempts >= 5` follow-up.
- **Installed clients** get the server fix at once: a deleted item no longer costs the whole count. They show no notice. They still dequeue on a 42501, but with the lock in place the only 42501 left on this RPC is the real store gate, plus the anon-session case from spec 152.
- **Performance.** A payload is tens of items. The new statements are one PK `= any()` lookup with a row lock and two passes over a small jsonb array. The 286 KB seed is irrelevant. There's no edge function, so no cold start.
- **Realtime.** There's no channel or publication change, so no `docker restart supabase_realtime_imr-inventory` step. `eod_*` writes replay on `store-{id}` as today. The staff stack has no realtime.
- **Edge functions:** none. **`src/lib/db.ts`:** none (the staff subtree is a carve-out). **`src/store/useStore.ts`:** none. The admin Cmd UI doesn't call this RPC. **`app.json` slug:** not touched.

### 10. Work split (no file overlap)

**backend-developer:**

- `supabase/migrations/20261110130000_staff_eod_skip_unknown_items.sql` (new; re-glob the version)
- `supabase/tests/staff_submit_eod_skip_unknown.test.sql` (new)
- `supabase/tests/admin_submit_eod.test.sql` (arm (16) only, SR-1)
- any other `supabase/tests/*.test.sql` that the full pgTAP run shows pinned the old behaviour (none expected)

**frontend-developer:**

- `src/screens/staff/lib/types.ts`
- `src/screens/staff/hooks/useEodSubmit.ts`
- `src/screens/staff/hooks/useEodSubmit.test.ts`
- `src/screens/staff/screens/EODCount.tsx`
- `src/screens/staff/screens/EODCount.test.tsx`
- `src/screens/staff/i18n/en.json`, `es.json` and `zh-CN.json`

The two halves can run in parallel. The client contract only depends on the response shape in §4 and the `STORE_GATE_TEXT` constant, which already exists server-side. Each developer lists their files under `## Files changed`. Whichever finishes last sets `Status: READY_FOR_REVIEW`.

Other sessions share this working tree. Stage and touch only the files listed above. `scripts/smoke-staff-eod.sh`, `src/lib/db.ts` and the 193 migration have other sessions' uncommitted edits and are **not** part of this spec.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the "## Backend design" section of this spec (backend-developer: §2, §6.1, §10 backend files; frontend-developer: §5, §6.2, §10 frontend files; no file overlap). Spec 193 is a hard dependency — build on its uncommitted bodies in 20261109190000_staff_eod_date_bound.sql and do not edit that file. Before building, confirm with the main session that SR-1 (§9: adding 'skipped_item_ids' to admin_submit_eod.test.sql arm (16)'s expected key array) is acknowledged. Touch only the listed files; other sessions share the tree. After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/199-staff-eod-skip-unknown-items.md

## Files changed

**frontend-developer (2026-11-10):**
- `src/screens/staff/lib/types.ts`: `StaffSubmitEodResponse.skipped_item_ids?`; `Outcome.success.skipped_count?` (§5.1)
- `src/screens/staff/hooks/useEodSubmit.ts`: `STORE_GATE_TEXT` + narrowed `isForbidden` (§5.2); `skippedCount` (§5.3); online `skipped_count` (§5.4); drain `skippedPendingRef` + combined debounced notice (§5.5)
- `src/screens/staff/hooks/useEodSubmit.test.ts`: AC-21 fixture moved to the real store-gate message; new `spec 199` describe for AC-13 to AC-19, placed after spec 193's arms, which are untouched
- `src/screens/staff/screens/EODCount.tsx`: the single success toast carries `text2: eod.toast.skippedItems` when `skipped_count > 0` (§5.4)
- `src/screens/staff/screens/EODCount.test.tsx`: `t` import; `spec 199` describe (AC-17 screen half, plus the no-skip toast with no `text2` key)
- `src/screens/staff/i18n/en.json`, `src/screens/staff/i18n/es.json`, `src/screens/staff/i18n/zh-CN.json`: `eod.toast.skippedItems` (AC-20)

**backend-developer (2026-11-10):**
- Migrations
  - `supabase/migrations/20261110130000_staff_eod_skip_unknown_items.sql` (new): pre-flight (55000 unless spec 193 is applied), `create or replace` of `public.staff_submit_eod` only (193 body plus the §2.3 R3 → R2 (`FOR KEY SHARE`) → R4 block, filtered `v_entries` to the writer, `skipped_item_ids` on the success envelope), and the re-issued comment (spec 199 sentence + 193 text verbatim). It does not touch `eod_write_submission`, `admin_submit_eod` or the trigger. No grants or publication changes.
- pgTAP
  - `supabase/tests/staff_submit_eod_skip_unknown.test.sql` (new, plan 57): SK1 to SK13 per §6.1, plus two §4 edge arms (non-uuid id still 22P02; a skipped NO NEED + quantity element raises nothing). Arm (30) is the R13 pin for `STORE_GATE_TEXT`.
  - `supabase/tests/admin_submit_eod.test.sql`: only the expected key array and description of arm (16) changed (SR-1). Every other line, including spec 193's uncommitted edits, is untouched.
- Local verification (normalized md5 = `md5(lower(regexp_replace(regexp_replace(pg_get_functiondef(oid), '--[^\n]*','','g'),'\s+',' ','g')))`):
  - Before the apply, the local DB bodies of `staff_submit_eod` and `eod_write_submission` were byte-equal to the 193 file.
  - `eod_write_submission` `f3ba9ae8b66a80d8940f1ce39ea12ce2`, `admin_submit_eod` `27e88465eeb798aa751e485d9416fc2c`, `eod_entries_check_store` `22b4d30dd670b6fdc831e3ceafd90117`: unchanged before and after the apply.
  - `staff_submit_eod`: `a32251ebea0e6e7bc920ecc19667fafe` (spec 193) → **`dce41928eeea865f5c10ea34297a9b68`** (spec 199, for the §7 post-check). After the apply: `prosecdef = t`, `proconfig = {search_path=public}`, `proacl = {postgres=X/postgres,authenticated=X/postgres}`.
  - Before the apply, the new suite failed on the trigger's 42501, which reproduces the bug. After the apply it passes 57/57. The full `scripts/test-db.sh` run passes 107/107 files.
