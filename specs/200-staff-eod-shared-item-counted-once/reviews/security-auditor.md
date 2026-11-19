## Security audit for spec 200

Scope: the staged diff for every file under `## Files changed`. I read each one with `git diff --cached -- <path>`. I also read the server path the payload reaches: `staff_submit_eod` (latest body `supabase/migrations/20261110130000_staff_eod_skip_unknown_items.sql`, spec 199) → `eod_write_submission` (latest body `supabase/migrations/20261109190000_staff_eod_date_bound.sql`). The EOD and vendors SELECT policies were checked against the full migration history.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- `src/screens/staff/screens/EODCount.tsx:1012-1024` (all-borrowed copy). The copies can silently undo an on-hand change made after the source count. This is a data-integrity issue. No privilege is gained.
  - **How it happens.** In the all-borrowed case, each copy is a numeric entry for an item linked to this vendor. So `eod_write_submission` (`20261109190000_staff_eod_date_bound.sql` L263-273, junction-membership predicate) sets `current_stock = <A's recorded actual_remaining>` again.
  - **What gets lost.** Any on-hand change between vendor A's submit and this vendor's submit is reverted. Sources include PO receiving (`po_loop`, `staff_receiving_price_gate`, `auto_receive_due_purchase_orders`), a manual adjustment in `db.ts:742`, or an admin EOD replace of A.
  - **Why this is wider than the documented risk.** The spec's Residual risk ("Stale copies in the all-borrowed case") covers only the source itself changing. This revert happens even when the source snapshot is fresh.
  - **How it differs from before.** Before spec 200, a second write came from a physical count. Now it can come from a number nobody re-counted, sent under a staffer who didn't count it.
  - **Mitigations within the "no server change" constraint**, either or both:
    - (a) Re-read `fetchBorrowSources` right before building the copies. If a source changed, refuse with a toast. This narrows the A-edit window only.
    - (b) Have the owner explicitly accept the receiving/adjustment revert case in Residual risk.
  - A cleaner fix needs a server-side "copy" marker so the writer skips the on-hand write. That is a server change and belongs in a follow-up spec.
  - Not a blocker.

### Low
- `src/screens/staff/screens/EODCount.tsx:1012-1024` combined with `20261109190000_staff_eod_date_bound.sql` L276-288: the audit trail doesn't show where a copied value came from.
  - Each copy produces a staff `'EOD entry'` audit row under `v_actor = auth.uid()` (the submitting staffer) with `vendor: <this vendor>`. The row says that staffer counted the value. In fact the value came from another submission (another staffer, an admin, or this user's own queued count).
  - The attribution of the *submit* is accurate, and the RPC accepts any payload from a store member, so nothing is forged that couldn't already be typed. Still, forensic review of a disputed on-hand can't tell "re-counted" from "copied".
  - Fix (follow-up, needs a server change): carry a provenance marker, for example a `notes` value such as `copied from submission <id>`, and add it to the audit `detail`. Today `entriesForRpc` (`src/screens/staff/hooks/useEodSubmit.ts:90-113`) doesn't forward `notes`, and the writer doesn't audit it. Alternatively, note the limitation in Residual risk.
- `src/screens/staff/screens/EODCount.tsx:774`: `notifyBackendError('fetchBorrowSources', err)` shows the internal function name as the toast title and up to 120 characters of the PostgREST message (`src/screens/staff/lib/notifyBackendError.ts:10-19`).
  - This is the existing staff pattern, used by `fetchSubmittedVendorIds` and others. PostgREST messages for this read contain no row data, SQL fragments or tokens, so no sensitive data leaks. Recorded for completeness; no action needed.

### Checks that passed (no finding)
- **No cross-store or cross-brand read.**
  - `fetchBorrowSources` (`src/screens/staff/lib/borrowSources.ts:74-83`) is a plain PostgREST select under the caller's JWT.
  - `eod_submissions` SELECT is `store_member_read_eod_submissions` = `auth_can_see_store(store_id)` (`20260504173035_per_store_rls_hardening.sql:66-68`).
  - `eod_entries` SELECT scopes through the parent's store (L87-95).
  - No later migration adds a permissive SELECT on either table. `20260514120030` only dropped or replaced UPDATE/DELETE. The original init-schema "Store access" FOR ALL policies were dropped in `20260502071736`.
  - `auth_can_see_store` is brand-scoped (`20260517040000`).
  - The `vendor:vendors(name)` embed runs under `brand_member_read_vendors` (`20260509000000_multi_brand_schema_rls.sql:575`). A vendor the caller can't see embeds as null, and the UI falls back to the generic "another vendor" label. No name leaks.
- **No reliance on client-side filtering for access control.**
  - The `storeId` argument comes from `activeStore`. Tampering with it returns 0 rows under RLS.
  - The store/date/status/vendor re-filters in `deriveBorrowedEntries` (`src/screens/staff/lib/borrowedEntries.ts:184-189`) are defence in depth only.
  - The "counted" gate (`isBlank = !isCounted`) is a UX gate, not a security boundary. The server never relied on it.
- **Minimal columns.** The select (`borrowSources.ts:77`) reads only ids, store, date, vendor, status, `submitted_at`, the vendor name and four entry quantity columns. It reads no `submitted_by`, no `notes` and no user identity, so the read adds no PII.
- **Queue sources are limited to the signed-in user.**
  - `deriveBorrowedEntries` requires `userId !== undefined` and `q.intent_user_id === userId` (`borrowedEntries.ts:160-165`). `userId` comes from `currentStaffUserId(s.authState)` (`EODCount.tsx:307`).
  - The drain re-read key uses the same filter (`EODCount.tsx:835-844`).
  - The queue is already device-local AsyncStorage data that the signed-in device can read. The filter controls which queued counts this session shows; it is not an access boundary, and nothing new reaches the server from other users' items.
- **The copied payload grants no new write capability.**
  - The copies are keyed by this vendor's own list (`borrowedEntryCopy(it.id, …)`, `EODCount.tsx:1018`). They carry only the four quantity fields plus `no_need: true` (`borrowedEntries.ts:63-79`), the same shape `entriesForRpc` already sends.
  - Server-side, `staff_submit_eod` still enforces `auth_can_see_store(p_store_id)` (`20261110130000…:178`), the spec 193 date window, and the spec 199 item-at-this-store filter (`…:263-277`).
  - The writer's on-hand UPDATE is still junction-membership scoped to `p_vendor_id` (`20261109190000…:263-273`). NO NEED copies satisfy `eod_entries_no_need_no_quantity_check` and skip on-hand.
  - A staffer could already send any such payload by typing the numbers, so the copy path adds no capability. Only the integrity and audit concerns above apply.
- **No secrets, `EXPO_PUBLIC_*` additions, edge functions, RPCs, migrations or policies** in this spec. `permissive_policy_lint` is unaffected.
- **XSS.** The vendor name is rendered through React Native `<Text>` (`StaffEodCountRow.tsx`, the `borrowedLabel` footer). No HTML sink, and the i18n interpolation is plain string substitution.
- **The pgTAP AC-16 test** (`supabase/tests/eod_cross_vendor_read_rls.test.sql`) is hermetic (`begin … rollback`, no `set role anon`).
  - It impersonates a `role = user` store member via `request.jwt.claims`.
  - It pins the same-store cross-vendor read (rows + entries + NO NEED) and 0 rows at a non-member store.
  - That is sufficient for the read this spec adds.

### Dependencies
No `package.json` changes (staged or unstaged), so `npm audit` was skipped.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 1 Medium, 2 Low.
payload_paths:
  - specs/200-staff-eod-shared-item-counted-once/reviews/security-auditor.md

## Fix round 1

Re-audited only the delta, using `git diff --cached` / the staged blobs: `src/screens/staff/lib/stockCheck.ts` (+ test), `stockMismatchIds` / `sameQuantity` in `src/screens/staff/lib/borrowedEntries.ts`, the `recountIds` wiring and the `onSubmit` stock check in `src/screens/staff/screens/EODCount.tsx`, the new staff i18n keys, and AC-20 plus the narrowed Residual risk in the spec.

### Status of the round-0 Medium (copies undo later on-hand changes): RESOLVED

Resolved within the "no server change" constraint. What remains is now Low; see the new finding below.

- **Store-scoped read under the caller's JWT.** `fetchCurrentStock` (`stockCheck.ts:23-38`) reads `inventory_items` with `.eq('store_id', storeId).in('id', …)`. RLS `store_member_read_inventory_items` = `auth_can_see_store(store_id)` (`20260504173035_per_store_rls_hardening.sql:47-48`). It selects only `id, current_stock`, so there's no new exposure: the same staffer can already read these rows.
- **The comparison fails closed.** `sameQuantity` (`borrowedEntries.ts:90-104`) treats null, blank and non-finite values on either side as not equal. `stockMismatchIds` (L111-122) treats an id missing from the read (not visible at this store, or deleted) as a mismatch. Rounding to 6 decimals is safe because `current_stock` is `numeric(10,3)` (`20260405000759_init_schema.sql:59`) and the copied `actual_remaining` is from the same 3-decimal domain. Rounding can't turn a real difference into a match.
- **A read failure fails closed.** The `catch` (`EODCount.tsx` staged L1058-1061) sets `mismatched = numericIds`, so no copies are sent.
- **Queued sources are blocked.** A queued source's count isn't on the server yet, so it mismatches the live stock unless the values happen to be equal. In that case the copy rewrites the same value, which is harmless.
- **NO NEED copies are rightly excluded.** They never write on-hand: the writer's `v_numeric` predicate, `20261109190000_staff_eod_date_bound.sql:255-256`.
- **Nothing is sent on a mismatch.** The whole submit returns before `submit`. No partial copy set goes out, and the flagged items need a real count through `recountIds`.
- **`recountIds` behaves correctly.**
  - `borrowableFor` (staged L491-494) feeds both `borrowedFor` and `isCounted`, so a flagged item drops out of the counted gate and the copy loop. It can't sneak back in through the label path.
  - The flags reset on a vendor/date/store load (staged L807). The check then re-runs on the next all-borrowed submit, so the reset doesn't bypass it.
- **The check is client-side, and that's acceptable for this threat.** The Medium was an integrity issue for honest users. It was never a privilege boundary: a staffer can already send any value by typing it, and the server gates (`auth_can_see_store`, date window, spec 199 item-at-store filter, junction-membership on-hand) are unchanged.
- **Error and log exposure.** `notifyBackendError('fetchCurrentStock', err)` follows the existing staff pattern (round-0 Low 2). The new toast/label strings interpolate only `{count}` and contain no data.

### New findings

#### Critical (BLOCKS merge)
- None.

#### High
- None.

#### Medium
- None.

#### Low
- **An offline fallback can stretch the "short window" into a long one.** This is in the all-borrowed submit path: `EODCount.tsx` staged L1052-1083, then `submit` → `src/screens/staff/hooks/useEodSubmit.ts:317-320, 344-346`.
  - The Residual risk says what remains is a change "in the short window between that read and the server write". But if the stock read succeeds and the RPC call then fails as offline or with a network error, `useEodSubmit` enqueues the verbatim copies. They drain whenever connectivity returns, possibly hours later, with no re-check.
  - A receiving or adjustment in that gap gets reverted on drain, which is exactly the Medium's scenario.
  - It's narrow: the network has to drop between two back-to-back requests. It's also the same class as any queued real count overwriting a later change on drain, which is pre-existing.
  - Fix, one of:
    - (a) for an all-borrowed submit, don't fall back to the queue: surface the network error and let the staffer retry, so the check re-runs;
    - (b) state in Residual risk that a queued all-borrowed submit can land well after the check.
  - Not a blocker.
- **The round-0 Low on audit provenance is unchanged.** It is now acknowledged in Residual risk as a server follow-up. No further action for this spec.

### Dependencies
No `package.json` change in the delta. `npm audit` was skipped.

### Fix round 1 tally
0 Critical, 0 High, 0 Medium, 3 Low (1 new: the queue fallback widens the check-to-write window; 2 carried from round 0: audit provenance, error toast label). The round-0 Medium is resolved.

## Handoff
next_agent: NONE
prompt: Security audit fix round 1 complete. Round-0 Medium resolved. 0 Critical, 0 High, 0 Medium, 3 Low (1 new).
payload_paths:
  - specs/200-staff-eod-shared-item-counted-once/reviews/security-auditor.md

## Fix round 2

Re-audited only the delta, using `git diff --cached` / the staged blobs: `src/screens/staff/hooks/useEodSubmit.ts` (+ test), `SubmitOptions` in `src/screens/staff/lib/types.ts`, the `allowQueue` call site and the `recountIds` reason map in `src/screens/staff/screens/EODCount.tsx`, the staff i18n keys, and AC-21 plus Residual risk in the spec.

### Status of the round-1 Low (the offline queue replays all-borrowed copies with no re-check): RESOLVED

- **Both enqueue sites in `submit` are gated.** These are the offline snapshot (`useEodSubmit.ts` staged L326-329) and the network-error catch (L353-356). With `allowQueue: false`, each returns `{ kind: 'failed', message: t('eod.toast.notSentOffline') }` before `enqueueEod`. The default (`options?.allowQueue !== false`) keeps every other caller byte-unchanged.
- **There is no other path that can enqueue copies.** I checked every queue writer in non-test code:
  - `enqueueEod` is called only at those two sites (`useEodSubmit.ts:328, 355`).
  - The drain loop only calls `dequeueEod` and `bumpEodAttempts` on items already queued. It never creates one.
  - `replaceQueue`, `hydrateQueueFromStorage` and `persistQueue` only rewrite or hydrate existing items. The `eodQueue.ts` helpers `pushQueueItem` and `drainQueue` have no callers outside that module.
  - `useEodSubmit` is used only by `EODCount.tsx:316`, and `submit` is called once (staged L1145-1147).
  - No retry or auto-resubmit path exists. A `failed` outcome only shows a toast (the final `else` branch). The screen stays unlocked, and the next Submit re-runs `onSubmit` from the top, which re-reads stock.
- **Pre-existing queued items.** No all-borrowed copy can be in a production queue, because spec 200 hasn't shipped. A queued own submission for this vendor makes the screen synthesize a `'(queued)'` `existing`, which seeds own entries, so that vendor can't be all-borrowed. The drain itself is unchanged and replays only what the user really counted, which is the intended behaviour.
- **Own and mixed submits still queue.** `allowQueue: false` is passed only when `allBorrowed` is true. That flag is set solely after the copies pass the AC-20 stock check. Every other submit calls `submit(payload)` with no options, and the hook test arm "network error with options omitted → still queued" pins it.
- **Read-failure wording.** The `recountIds` map now records `'changed' | 'unchecked'` and selects different strings. The behaviour is still fail-closed: every numeric copy is flagged and nothing is sent. The strings interpolate only `{count}` and contain no data.

### New findings

#### Critical (BLOCKS merge)
- None.

#### High
- None.

#### Medium
- None.

#### Low
- **A retry after an ambiguous network failure isn't deduplicated.** This is in `useEodSubmit.ts` staged L351-356, together with `EODCount.tsx` staged L1145-1147.
  - `isNetworkError` also matches `timeout` and `aborted`, where the RPC may already have committed on the server.
  - Before this round, that case queued the item with the same `client_uuid`, so `staff_submit_eod`'s idempotency check (`20261110130000…:191-203`) turned the replay into a no-op.
  - With `allowQueue: false`, the staffer sees "not sent" and presses Submit again. That call gets a new `client_uuid`, so the server treats it as an edit of the already-written submission.
  - Result: duplicate staff `'EOD entry'` audit rows, and possibly an `eod_update` admin notification (spec 180). The data stays safe: the retry re-runs the stock check, so if on-hand changed in between, the copy is refused.
  - This is audit noise only, with no data-integrity or privilege impact. Optional fix: keep the `client_uuid` from a failed all-borrowed attempt and reuse it on the next attempt if the payload is unchanged.
- **Round-0 Lows carried forward unchanged:** copy provenance in the audit trail (a server follow-up, now in Residual risk) and the error-toast label (existing pattern).

### Dependencies
No `package.json` change in the delta. `npm audit` was skipped.

### Fix round 2 tally
0 Critical, 0 High, 0 Medium, 3 Low (1 new: a retry after an ambiguous network failure isn't deduplicated; 2 carried from round 0). The round-1 Low is resolved. The round-0 Medium remains resolved. The only remaining stale-copy exposure is the sub-second gap between the stock read and the server write, as the spec's Residual risk states.

## Handoff
next_agent: NONE
prompt: Security audit fix round 2 complete. Round-1 Low resolved; no path can enqueue all-borrowed copies; own/mixed submits still queue. 0 Critical, 0 High, 0 Medium, 3 Low (1 new, audit-noise only).
payload_paths:
  - specs/200-staff-eod-shared-item-counted-once/reviews/security-auditor.md
