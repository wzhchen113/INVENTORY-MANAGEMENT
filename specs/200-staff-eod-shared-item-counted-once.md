# Spec 200: Staff EOD counts a shared item once across vendors

Status: READY_FOR_REVIEW

Numbering: 200 was free on 2026-11-18 (`specs/` held up to 199). The sibling spec 201 ([specs/201-reorder-shared-item-primary-vendor-wins.md](201-reorder-shared-item-primary-vendor-wins.md)) is on disk at `DRAFT` and will be amended for this spec (see Dependencies).

Origin: a gap left by spec 102 ([specs/102-multi-vendor-ingredients.md](102-multi-vendor-ingredients.md)). Its AC-E asked for "the same … shared-on-hand behavior as AC-D, on the staff surface". AC-D's "counted in every tab once counted anywhere" rule was built for the admin Cmd EOD only. Code facts below were read from the working tree on 2026-11-18. Line numbers are pointers, not contracts.

## User story

As a **staff member doing the nightly EOD count**, I want an item I already counted under one vendor tonight to show up as counted, with its value, when I switch to another vendor that also supplies it. Then I don't count the same shelf twice and the second vendor's count can't overwrite the first by accident.

## The problem

- **Shared items.** An ingredient can be linked to several vendors through `public.item_vendors` (spec 102). On-hand (`inventory_items.current_stock`) and par are per item, so they're shared across those vendors.
- **Admin already does this.** The admin Cmd EOD treats a shared item as "counted once globally". `deriveCountedItemIds` ([EODCountSection.tsx](../src/screens/cmd/sections/EODCountSection.tsx) L75-163) returns every item counted anywhere for the selected (store, date). It counts three things:
  - (a) a local value in any vendor tab's slot;
  - (b) an entry in **any persisted submission** for that (store, date). This includes `status = 'draft'` rows (L145-152);
  - (c) a local NO NEED mark in any tab.

  `hasEntry = localHasEntry || countedItemIds.has(id)` (L825-830) drives the gate, the "X of N" label and the row styling. The admin row for an item counted under another tab stays **blank** but isn't a gap.
- **Staff doesn't.** In [src/screens/staff/screens/EODCount.tsx](../src/screens/staff/screens/EODCount.tsx):
  - `fetchExistingSubmission(store, date, vendorId)` (L219-279) reads only the **selected vendor's** submission. The load effect (L664-709) seeds from that alone (`seedFromExisting`, L538-564).
  - `isCounted` (L415-418) only looks at this vendor's local `caseCounts` / `unitCounts` / `noNeed`. That one predicate drives the row indicator, `countedNum` (the "X of N" label, L421), `isDone`, NEXT / SKIP advance (L502, L525) and the submit gate (L808-830).
  - So a shared item counted and submitted under vendor A shows up uncounted under vendor B, and the gate makes staff count it again.
- **Effect of the second count.** It goes through `staff_submit_eod` → `eod_write_submission` ([20261109190000_staff_eod_date_bound.sql](../supabase/migrations/20261109190000_staff_eod_date_bound.sql) L263-273). That writer sets `current_stock` for every numeric entry whose item is linked to the submitting vendor. So the second count **overwrites** the first, and the last write wins.

## Owner direction

- On the staff count screen, a shared item already counted under **another vendor's submitted submission** for the same (store, count date) is **pre-filled with that count** and labelled, for example "Counted under Sysco".
- It counts as done for:
  - the "X of N counted" label;
  - the count-everything gate;
  - the row indicator;
  - NEXT / SKIP advance and DONE.
- Staff **may still edit it**. An edit is this vendor's own count. It's submitted under this vendor and updates the shared on-hand as today.
- Staff are **never forced** to count it a second time.
- NO NEED (spec 172) and count modes (spec 171) behave consistently with the admin rule.
- The date scoping principle of spec 192 applies.
- Staff subtree conventions apply: direct `supabase` calls are allowed in `src/screens/staff/`, and strings go in the staff i18n catalog.
- Scope is the staff app only. Admin EOD doesn't change. Reorder changes belong to spec 201.
- **The open questions were answered on 2026-11-18 with "Use recommendations".** See "Open questions resolved".

## Terms

- **Count date:** the staff screen's selected date (`countIso`): today, or yesterday when the late toggle is on.
- **This vendor:** the selected vendor chip (`selectedVendorId`).
- **Other vendor:** any vendor other than this vendor.
- **Source:** an R1-qualifying submission of an other vendor. It is either a **server source** (an `eod_submissions` row) or a **queued source** (a `QueuedSubmission` in this device's staff queue).
- **Borrowed entry:** for an item on this vendor's list, the entry R1 and R2 pick from the sources. A row showing one is a **borrowed row**.
- **Own entry:** an entry for the item in this vendor's own submission (server or the synthesized `existing`), or a non-blank local value or NO NEED mark typed under this vendor this session.
- **All-borrowed vendor:** this vendor's list is non-empty, **every** item on it is a borrowed row, and none has an own entry. So under the omit rule its payload would be empty.

## Requirements

- **R1. Qualifying sources.**
  - **A server source** is an `eod_submissions` row that meets all of these:
    - its `store_id` is the active store;
    - its `date` is the count date;
    - its `vendor_id` is not this vendor;
    - its `status = 'submitted'`. **Admin-saved `'draft'` rows don't qualify** (OQ-2). This is a known, accepted difference from admin `deriveCountedItemIds` arm (b), which counts drafts. The admin rule isn't changed.
  - **A queued source** is a `QueuedSubmission` in `useStaffStore.eodQueue` ([types.ts](../src/screens/staff/lib/types.ts) L100-111) that meets all of these (OQ-3):
    - its `store_id` is the active store;
    - its `date` is the count date;
    - its `vendor_id` is not this vendor;
    - its `intent_user_id` is the signed-in user. This is the PM's reading of "this device's queued counts": other users' items on a shared device don't drain under this session, so they aren't treated as this staffer's counts.
  - **A different date or store never qualifies.** This is the spec 192 principle. Spec 192 itself was admin-only, and the staff EOD screen has no slot-keyed state.
  - **Unsent, unqueued counts on any device never qualify.** The staff EOD screen saves no draft (WeeklyCount's `countDrafts.ts` isn't used by EOD), so the values exist only in that device's React state.
- **R2. Choosing among sources (OQ-4).**
  - **Same vendor:** a queued source replaces that vendor's server source, because it will overwrite it on drain.
  - **Different vendors:** across the remaining sources that hold an entry for the item, the one with the **latest timestamp** wins: `submitted_at` for a server source, `queued_at` for a queued source. Its vendor is named in the label.
  - **This vendor's own entry always wins in this vendor's tab**, whether locked or editable. A row shows a borrowed entry only when it has no own entry.
  - **No "differs from" hint** is shown when an own entry and a source disagree.
- **R3. Counted.** A borrowed row counts as counted wherever `isCounted` is used today:
  - the row indicator;
  - `countedNum` / "X of N counted";
  - `isDone`;
  - NEXT / SKIP / DONE advance (`advanceUncounted`, `firstUncounted`);
  - the submit gate and its jump-to-first-uncounted target.

  Any other row is counted under exactly today's rules.
- **R4. Display.** A borrowed row shows the borrowed entry's recorded value and a visible label naming its vendor, for example "Counted under {vendor}".
  - **Values** follow `seedFromExisting`'s rules (spec 086 OQ-4 legacy fallback; spec 171 OQ-A cases-only rows leave units blank). Use one shared helper so the two can't drift.
  - **A borrowed NO NEED entry** shows as NO NEED with the label.
  - **Vendor name for a server source:** take it from the submission's vendor (for example an embed of `vendors(name)`). Don't take it from today's `vendors` chip list, because the vendor may not be scheduled on the count date.
  - **Vendor name for a queued source:** take it from the chip list. If the vendor isn't found there, the architect picks a generic fallback label, for example "Counted under another vendor". Never show a blank name.
- **R5. Editing a borrowed row.** Staff can open the keypad sheet on a borrowed row whenever this vendor's inputs are editable (UNSUBMITTED or EDITING, spec 129).
  - The sheet opens with the borrowed values filled in.
  - A borrowed row becomes an **own entry** once a digit change or a NO NEED toggle **is committed** on it. From then on:
    - the label is gone;
    - it's in this vendor's payload, built by today's `eodRowEntryValues`;
    - it updates the shared on-hand through the existing writer.
  - Opening and closing the sheet with no change, or NEXT / SKIP past the row, leaves it borrowed.
  - If staff clear an own value so the row is blank again, the row goes back to showing the borrowed entry. This matches the admin's `localHasEntry || countedItemIds` rule.
  - **EDIT → Cancel** (`onCancelEdit`) brings back this vendor's submitted values **and** the borrowed overlay.
- **R6. NO NEED (spec 172).**
  - A borrowed NO NEED entry counts the item. This mirrors admin arm (b): a persisted NO NEED entry is an entry.
  - Admin arm (c) also counts a local NO NEED mark in another tab. Staff has only one vendor in memory at a time, so the queued-source rule (R1) is its only equivalent.
- **R7. Count modes (spec 171).**
  - Whether a borrowed row counts doesn't depend on the item's live count mode. A persisted entry is a recorded count (admin arm (b), spec 171 §10).
  - A borrowed value sitting in a box the live mode now disables still counts the item. It's displayed as recorded, with the locked-row legacy layout as the model, and never re-derived through the live mode.
- **R8. Payload (OQ-1, OQ-1a).**
  - **Default: omit.** An untouched borrowed row is **not** sent in this vendor's `staff_submit_eod` payload. Only own entries are sent, built exactly as today. So an untouched borrowed row causes no on-hand write, no `stock_updates` element and no staff `'EOD entry'` audit row under this vendor.
  - **Exception: an all-borrowed vendor.** On submit, **every** borrowed row is sent as a **verbatim copy** of its borrowed entry: the same `actual_remaining`, `actual_remaining_cases`, `actual_remaining_each` and `no_need`. They aren't rebuilt through the live-mode `eodRowEntryValues` (R7). NO NEED copies keep the §6.3 shape. This applies only in this case, so the vendor gets a submission and its chip and the yesterday reminder clear.
  - **Mixed lists use the default.** As soon as at least one own entry exists, borrowed rows are omitted.
  - **No server change.** `staff_submit_eod`, `eod_write_submission`, `admin_submit_eod`, O-1 and every envelope stay as they are.
- **R9. When the borrowed set is fetched.**
  - **Server sources** are a snapshot. They're read with the existing load effect: on a vendor switch, a count-date toggle or a store switch. They're read again after a successful or replayed submit (`enterLockedAfterWrite`).
  - **Queued sources** come from the store and follow the queue as it changes. A source that drains and is dequeued is replaced by its server row at the next server read. Between the dequeue and that read, the item may briefly show as uncounted. That's acceptable; the architect may close the gap, for example by re-reading after a drain.
  - **No realtime.** The staff stack has none in v1 (specs 062/063).
  - **If the server-source read fails,** the screen behaves as if there were no server sources. It stays usable, any queued sources still apply, and the error goes through the staff `notifyBackendError`. The count list is never blocked. This is the same best-effort posture as `fetchSubmittedVendorIds` and `fetchUpdatedItemIds`.
- **R10. Locked view.** In SUBMITTED_LOCKED (server-confirmed, or the synthesized `'(local)'` / `'(queued)'` `existing`), a row that's missing from this vendor's own entries but has a borrowed entry shows the borrowed value and label read-only, and it counts.
- **R11. i18n.** The label, and the fallback name if one is used, go in `src/screens/staff/i18n/` (en, es, zh-CN) with identical `{tokens}`. Exact wording is the frontend's call. The label must fit the row at phone width.
- **R12. RLS (checked against the tree, no change needed).**
  - The SELECT policies are store-scoped, not vendor-scoped. `store_member_read_eod_submissions` uses `auth_can_see_store(store_id)`, and `store_member_read_eod_entries` scopes through the parent's store ([20260504173035_per_store_rls_hardening.sql](../supabase/migrations/20260504173035_per_store_rls_hardening.sql) L66-95). Later migrations dropped only the UPDATE and DELETE policies (`20260514120030`).
  - The staff app already reads every vendor's submissions for the store in `fetchSubmittedVendorIds` ([submittedStatus.ts](../src/screens/staff/lib/submittedStatus.ts) L27-48).

## Acceptance criteria

These terms are used throughout:
- **Fixture:** store S, signed-in user U; vendors A, B and C all scheduled on the count date; item X linked to A, B and C (shared); item Y linked to B only.
- **Snapshot:** A's server submission at (S, count date), `status = 'submitted'`, holds X = 5 units (or NO NEED, where stated).
- **Tests:** jest unless stated. Screen tests go in `src/screens/staff/screens/EODCount*.test.tsx`. Pure-helper tests sit next to the helper.

- [ ] **AC-1 (pure derivation).** A pure, exported helper takes:
  - the server sources;
  - the queued items;
  - the active store, count date, selected vendor and user id.

  It returns `itemId → { vendorId, vendorName | null, entry, source: 'server' | 'queued' }`. Unit tests cover:
  - (a) a different-date source is excluded;
  - (b) a different-store source is excluded;
  - (c) this vendor's own server or queued submission is excluded;
  - (d) a server source with `status = 'draft'` is excluded;
  - (e) a queued item whose `intent_user_id` isn't U is excluded;
  - (f) A at `submitted_at` 20:00 with X = 5 and C at 21:00 with X = 6 → X = 6 from C;
  - (g) A's server source with X = 5 plus A's queued source with X = 8 → X = 8 from A (`source: 'queued'`);
  - (h) a queued C at `queued_at` 22:00 beats a server A at 21:00.
- [ ] **AC-2 (prefill + label).** With the snapshot, opening B shows X pre-filled with 5 units and the label naming A. Y is blank. "X of N" reads `1 of 2 counted`.
- [ ] **AC-3 (gate).** Under B, with Y counted and X untouched, pressing Submit isn't blocked by the count-everything gate and calls `submit`. With Y blank, the gate blocks, the toast reports `1` remaining, and the sheet opens on Y, not X.
- [ ] **AC-4 (advance).** Under B, NEXT from the row before X skips X. DONE shows once Y is counted.
- [ ] **AC-5 (no borrow when no source).** X behaves exactly as today (blank and uncounted) in each of these cases:
  - there's no A submission, or A's doesn't contain X;
  - A's submission is dated another day (the count date toggled to yesterday with A only on today);
  - A's submission is at another store;
  - A's only submission at (S, count date) has `status = 'draft'` (OQ-2).
- [ ] **AC-6 (edit becomes own).** Under B, the staffer changes X to 7 in the keypad. The label goes, and X stays counted. The submitted payload contains X as `{actual_remaining: 7, …}` built by `eodRowEntryValues`. Opening and closing the sheet on X with no change leaves the label in place.
- [ ] **AC-7 (clear falls back).** After AC-6, the staffer clears X to blank. X shows A's 5 and the label again, and stays counted.
- [ ] **AC-8 (omit by default).** After AC-3's submit, the `entries` passed to `submit` contain Y and **not** X.
- [ ] **AC-9 (all-borrowed vendor).** Fixture variant: B's list is only X (and X2, also borrowed from A).
  - Submit isn't blocked by the gate or by the `eod.toast.noCountsEntered` path.
  - `entries` holds exactly X and X2, each identical to A's entry for its four fields.
  - On success, B's chip turns green (B is in `submittedVendorIds`), and the screen enters SUBMITTED_LOCKED.
  - Mixed variant: once the staffer edits X2, the payload is only X2. X is omitted under R8's default.
- [ ] **AC-10 (NO NEED).** A's entry for X is NO NEED.
  - X shows under B as NO NEED with the label and counts.
  - In the mixed case (AC-8), X is omitted.
  - In the all-borrowed case (AC-9), X ships with `no_need: true` and null quantities.
- [ ] **AC-11 (count mode).** X's live mode is `units_only`, but A's entry has only `actual_remaining_cases` set.
  - X still counts under B and shows A's recorded cases value.
  - In the all-borrowed case it's copied verbatim, not nulled by the live-mode builder.
- [ ] **AC-12 (own wins).** B has its own submission with X = 3, and A's has X = 5. In B's SUBMITTED_LOCKED and EDITING states, X shows 3 with no label and no "differs" indicator.
- [ ] **AC-13 (locked view).** After AC-8's submit, B's SUBMITTED_LOCKED view shows X read-only with A's value and the label, and "X of N" counts it. EDIT → Cancel brings back the same view. The same holds after a queued (offline) submit under B.
- [ ] **AC-14 (queued source).** Offline, U submits A with X = 5 (queued, not on the server). Switching to B shows X borrowed from A with the label, and X counts. A queued item for A whose `intent_user_id` isn't U does not borrow.
- [ ] **AC-15 (refresh + failure).**
  - After a successful submit under B, the server-source read runs again.
  - If the server-source read rejects, the screen renders with no server-borrowed rows and calls `notifyBackendError`. The item list still loads, and queued sources still apply.
- [ ] **AC-16 (RLS, pgTAP).** A `user`-role store member of S can `select` A's `eod_submissions` row and its `eod_entries` at S. A member of a different store gets 0 rows for both. Reuse an existing suite if it already pins this; otherwise add one arm. No policy change.
- [ ] **AC-17 (i18n).** The new key(s) exist in en, es and zh-CN with identical tokens, and `src/screens/staff/i18n/i18n.test.ts` passes.
- [ ] **AC-18 (gates).** The full `npx jest`, both typechecks (base and `typecheck:test`) and the full pgTAP run pass. Existing EODCount tests that pin the vendor-only `fetchExistingSubmission` mock shape are updated, not deleted (re-grep `src/screens/staff/screens/EODCount*.test.tsx`).
- [ ] **AC-19 (UI check).** In a phone-width web preview on the local stack, two vendors with a shared item show the label without truncation or overlap. Run the AC-2 and AC-9 flows through the real screen.
- [ ] **AC-20 (stock check before all-borrowed copies; added 2026-11-19, owner decision on the security-auditor Medium).** Right before an all-borrowed submit (R8 exception), the client reads `inventory_items.current_stock` for the copied numeric items at the active store. It compares each with the copied `actual_remaining` as a number: string/numeric formatting is tolerated and the comparison is at 6 decimals, so float noise can't cause a mismatch.
  - **Match:** the verbatim copies are sent as in AC-9.
  - **Mismatch** (stock changed since that count, for example a received delivery; or the source is a queued count not yet on the server): no copies are sent. Those items stop being borrowed for this (store, date, vendor) until the next vendor, date or store load. They show blank and uncounted, the toast reads "Stock changed since this was counted / Please count it again (N)", and the keypad opens on the first one in on-screen order. Each such row also shows a footer line, "Stock changed since this count — count it again" (`eod-recount-<id>`), until it is counted, because the toast can sit under the keypad sheet. Matching items stay borrowed. Once a recounted item is entered, the list is mixed, so the R8 default applies and untouched borrowed rows are omitted.
  - **NO NEED copies** never write on-hand and are not checked.
  - **Read failure:** fails closed. No copies are sent, every numeric copied item needs a count, and the error goes through the staff `notifyBackendError`. Since fix round 2 the wording is distinct: the toast reads "Couldn't check stock / Please count these items (N)" and the row line reads "Couldn't check stock — please count it". The mismatch case keeps the "Stock changed" text.
  - **Tests (jest):** match → copies sent, and the read is store-scoped to the numeric ids; mismatch → recount required, no copies, then only the recounted item is sent; queued source mismatch; read failure → fail closed; NO NEED excluded; a vendor switch clears the recount flags; the recount row line shows and then clears once the row is counted; plus pure `sameQuantity` / `stockMismatchIds` and `fetchCurrentStock` unit arms; the read-failure wording (round 2).
- [ ] **AC-21 (all-borrowed copies never go to the offline queue; added 2026-11-19, fix round 2, owner-approved, security-auditor round-1 Low).**
  - **The rule.** An all-borrowed submit (one that sends the copies) calls `submit(payload, { allowQueue: false })`. If the device is offline at submit time, or the RPC fails with a network error, `useEodSubmit` returns `failed` with "No connection — not sent. Try again." Nothing is enqueued.
  - **The screen stays retryable.** It stays UNSUBMITTED: Submit (not Edit), the borrowed rows unchanged, and the chip red. The next Submit re-runs the AC-20 stock check before sending.
  - **Other submits are unchanged.** Own-count and mixed submits call `submit(payload)` with no options and still queue on a network failure.
  - **Already-queued items.** A submission queued before this change drains exactly as before, because the drain is untouched. The queue holds no all-borrowed marker, so such an item can't be told apart; this is noted, not changed.
  - **Tests.**
    - Hook (jest): offline + `allowQueue: false` → `failed`, nothing enqueued, no RPC; network error + `allowQueue: false` → `failed`, not queued; network error with no options → queued; `allowQueue: false` leaves a successful submit unchanged.
    - Screen (jest): all-borrowed → submit called with `{ allowQueue: false }`; a network failure shows the error and stays unlocked, and the retry re-reads stock; mixed → submit called with no options.

## In scope

- Staff EOD screen ([EODCount.tsx](../src/screens/staff/screens/EODCount.tsx)), plus any staff-local helper or lib file it needs, for example a server-source read next to `fetchExistingSubmission` and the pure derivation helper.
- The row label in [StaffEodCountRow.tsx](../src/screens/staff/screens/eod/StaffEodCountRow.tsx), and in the keypad sheet if the architect wants it there.
- Staff i18n strings.
- Jest arms; one pgTAP RLS arm if not already covered.

## Out of scope (explicitly)

- **Admin Cmd EOD** (`EODCountSection`, `deriveCountedItemIds`, the phone tier). Owner direction. Admin's draft-counting arm (b) and its blank-row display stay as they are; R1's difference is documented, not reconciled.
- **The reorder list and `report_reorder_list`.** The change it needs belongs to spec 201 (see Dependencies). This spec ships no migration.
- **Any server change** to `staff_submit_eod`, `eod_write_submission`, O-1 or the on-hand predicate.
- **Realtime on the staff stack.** v1 has none (specs 062/063).
- **A "differs from {vendor}" indicator** (OQ-4: none).
- **Other users' queued items on a shared device** as sources (R1).
- **WeeklyCount, Receiving and the staff Reorder screen.** They're separate staff surfaces, and this request names only EOD.
- **A server-side "count once" guarantee**, for example refusing a second vendor's count of a shared item. That would change the spec 102 AC-F reconciliation and wasn't asked for.

## Open questions resolved

- Q (OQ-1): Should an untouched pre-filled row go into this vendor's payload? → A: **Omit it** (R8, AC-8). Spec 201 will be amended so reorder treats a shared item counted under any vendor's submitted submission as EOD-sourced (Dependencies).
- Q (OQ-1a): What about a vendor whose every row is pre-filled? → A: **Include verbatim copies in that case only,** so the vendor gets a submission and its chip and the reminder clear (R8, AC-9).
- Q (OQ-2): Do admin-saved `'draft'` submissions count as sources? → A: **No. Submitted only.** It's a documented difference from admin `deriveCountedItemIds` arm (b) (R1, AC-1 d, AC-5).
- Q (OQ-3): Do this device's queued offline counts for another vendor count? → A: **Yes** (R1, AC-14). PM reading: only items queued by the signed-in user.
- Q (OQ-4): Which count wins when they disagree? → A: **The latest timestamp among other vendors wins.** This vendor's own entry always wins in its own tab, and there's no "differs" hint (R2, AC-1 f-h, AC-12).
- Q: Can staff read other vendors' submissions for their store under RLS? → A: **Yes, with no change** (R12; AC-16 pins it).
- Q: What if the other vendor's count exists only as an unsent local value on another device? → A: **It never counts.** The server can't see it (R1).
- Q: Does spec 192 apply to the staff screen? → A: **Only as its principle:** sources are scoped to the exact (store, count date) (R1, AC-5).

## Dependencies

- **Spec 201 (cross-spec, sequencing matters).**
  - [specs/201-reorder-shared-item-primary-vendor-wins.md](201-reorder-shared-item-primary-vendor-wins.md) is on disk at `DRAFT`. It will be amended so that `report_reorder_list` treats a shared item counted under **any** vendor's submitted submission at (store, date) as **EOD-sourced**, not `eod_missing_for_item`.
  - **The reorder body baseline is [20261024000000_eod_entries_no_need.sql](../supabase/migrations/20261024000000_eod_entries_no_need.sql)** (`latest_eod_per_vendor` L447-455, `no_need_items` L461-467, `item_on_hand` L492-528), not the older `report_reorder_list` migrations. Spec 201 already builds from this body.
  - **Why the amendment is needed:**
    - Under R8's omit default, vendor B has a submission without numeric item X.
    - Against today's body, B's row for X is case B: `on_hand = current_stock` (the right number, since A's count wrote it), but `item_on_hand_source = 'stock'` and `eod_missing_for_item = true`.
    - An omitted **NO NEED** row is already handled by the item-wide `no_need_items` set and isn't flagged.
  - **Sequencing:** the amended spec 201 migration should reach prod **before or in the same release as** this spec's client change. If this spec ships first, reorder shows a false "EOD missing" flag and `stock` source on the omitting vendor's shared rows until 201 lands. The suggested quantities are unaffected, because `on_hand` is still the shared `current_stock`.
  - This spec has no migration, so there are no hunks to merge with 201.
- **Spec 102** (`item_vendors`, the shared on-hand, the admin rule this mirrors).
- **Specs 129, 171, 172 and 199** are on `main`. 199's skipped-items toast sits in the same success branch (EODCount L921-935), so build on top of it.
- No library, edge function or realtime dependency.

## Project-specific notes

- **Cmd UI section:** none. This is the staff surface ([src/screens/staff/](../src/screens/staff/)), which is a documented direct-`supabase` carve-out.
- **Which app:** the staff EOD app in this repo (spec 063 fold-in).
- **Per-store or admin-global:** per-store. Server reads are scoped to the active store through `auth_can_see_store()` RLS; queued sources are filtered by store in R1.
- **Edge function or PostgREST:** PostgREST table reads only. No new RPC.
- **Realtime channels touched:** none.
- **Migrations needed:** no (the reorder migration belongs to spec 201).
- **Edge functions touched:** none.
- **Web/native scope:** web and native. The staff screen ships on both, and the change is plain React Native. Web gets it at the next Vercel deploy, native at the next EAS build.
- **`app.json` slug:** not touched.
- **Tests:** jest (AC-1 to AC-15, AC-17, AC-18) and pgTAP (AC-16). No shell smoke. AC-19 is a manual preview check.

## Residual risk

- **Snapshot staleness.** With no staff realtime, a server source submitted from another device after this screen loaded isn't borrowed until the next reload, so staff may count the item again. That's today's behaviour.
- **Stale copies in the all-borrowed case: narrowed by AC-20.** A copy is sent only if its count still equals the item's live `current_stock`, read right before the submit. So a change to on-hand after the source count (receiving, the auto-receive cron, an adjustment, an admin edit of A that rewrote on-hand) blocks the copy and asks for a real count. Since fix round 2 (AC-21), an all-borrowed submit never falls back to the offline queue, so the copies can't drain hours later without a re-check. That closes the offline case. **What remains** is a change landing in the short window between that read and the server write. In that case the copy writes the earlier value back (last write wins). A server-side guard, such as a "copy" marker so the writer skips on-hand, would close it and needs a follow-up spec. The copies still add staff `'EOD entry'` audit rows under this vendor with no provenance marker (security-auditor Low; server follow-up).
- **The drain gap** (R9): a queued source dequeued before the next server read can briefly read as uncounted.
- **Last write wins on on-hand is unchanged** whenever staff deliberately edit a borrowed row (owner direction).

## Backend design

Backend architect, 2026-11-18. Designed in the same pass as spec 201 ([its design](201-reorder-shared-item-primary-vendor-wins.md#backend-design)) so the two borrow sources are one contract.

### 0. Decisions at a glance

| # | Decision |
|---|---|
| D1 | **No server change.** No migration, RPC, policy or edge function. Confirmed: this spec carries no hunk for `report_reorder_list` or the EOD tables, so spec 201 merges none. |
| D2 | **The server sources are exactly the cross-spec contract in §1**, word for word with spec 201 §2. The tiebreak is `submitted_at DESC NULLS LAST, id DESC`, at microsecond precision. |
| D3 | **One staff-local PostgREST read, `fetchBorrowSources(storeId, countIso)`.** It is independent of the selected vendor, and it never coerces a null `actual_remaining` to 0. |
| D4 | **One pure helper, `deriveBorrowedEntries`, decides everything** (AC-1). The screen only derives "own" vs "borrowed" from it. |
| D5 | **"Own" ≡ "would be in this vendor's payload today".** That's `eodRowCounted(noNeed, modeFor(it), case, unit)`, unchanged. A row is borrowed iff it isn't own and the helper has an entry for it. |
| D6 | **Deploy gate.** Spec 201 migration `20261118120000` must be on prod before, or with, this client. |

### 1. Cross-spec contract: the borrow source (identical text in specs 200 and 201)

Fixed by the architect on 2026-11-18. Spec 201 R8 (reorder) and spec 200 R1/R2 server sources (staff EOD) use the **same candidate set and the same order**. Changing one means changing both.

1. **Candidates.** `public.eod_submissions` rows where:
   - `store_id` = the store;
   - `date` = the date (reorder: as-of date; staff: count date);
   - `status = 'submitted'`.

   Any `vendor_id` qualifies, including a vendor not linked to the item and, defensively, a legacy null vendor. Drafts, other dates and other stores never qualify.
2. **Order.** `submitted_at DESC NULLS LAST`, then `eod_submissions.id DESC`. The id is the deterministic tiebreak for equal timestamps.
   - Timestamps compare at full microsecond precision.
   - `id` compares as `uuid` in SQL. On the client, the lowercase canonical uuid string orders identically, because it is fixed-width hex with hyphens in fixed positions and PostgREST emits lowercase.
3. **Per item, the first candidate in that order holding a borrowable entry for the item wins.** There is at most one entry per (submission, item) (`eod_entries_submission_item_uidx`, spec 189).
4. **Borrowable entry:**
   - **Reorder (201):** `actual_remaining IS NOT NULL`, numeric only. A NO NEED entry is never a numeric source. NO NEED is applied separately by spec 172's unchanged item-wide `no_need_items` override (201 R11).
   - **Staff (200):** `actual_remaining IS NOT NULL` **or** `no_need = true`. A legacy blank entry (neither) is skipped and the next candidate is tried, exactly as reorder skips it.
5. **The own entry always wins on both surfaces:** reorder R9 step 1 (own case A), and staff R2 (this vendor's own submission is excluded from the candidates).
6. **Staff-only overlay.** Queued sources (this device, signed-in user) sit on top of the server candidates (spec 200 R1/R2). Reorder can't see them. Once drained, a queued submission is an ordinary server candidate with `submitted_at` = drain time, so the two surfaces converge on the next server read.

**Equivalence.** For any item whose candidate entries are all numeric, both surfaces name the same submission and the same value. The only differences involve NO NEED. Both are spec 172's existing item-wide semantics, which 201 R11 keeps unchanged:
- **The latest borrowable entry is NO NEED** and an older numeric one exists. Staff shows NO NEED. Reorder shows the older number as `on_hand` but zeroes the suggestion with the `no_need` flag. The outcome is the same: don't order.
- **The latest borrowable entry is numeric** and an older one is NO NEED. Staff shows the number. Reorder still zeroes the suggestion on every row that isn't own case A. This is spec 172 AC-12 behaviour today; it is documented, not reconciled.

**NO NEED interaction on this screen (spec 172).**
- A borrowed NO NEED entry counts the item (R6) and is shown as NO NEED with the label.
- In the all-borrowed case it ships verbatim as the §6.3 shape: `actual_remaining`, `actual_remaining_cases` and `actual_remaining_each` all null, plus `no_need: true`. That satisfies `eod_entries_no_need_no_quantity_check`, so the existing writer skips the on-hand write and `stock_updates` for it (172 S3/S5).
- In the mixed (omit) case, reorder still sees the item's NO NEED through the item-wide `no_need_items` set, because the source vendor's submission holds it. Omitting it changes nothing.

### 2. Data model, RLS and API

- **Data model:** none.
- **RLS (R12 confirmed against the tree).** No change. `permissive_policy_lint` is unaffected.
  - `store_member_read_eod_submissions` reads `auth_can_see_store(store_id)`, and `store_member_read_eod_entries` scopes through the parent ([20260504173035](../supabase/migrations/20260504173035_per_store_rls_hardening.sql) L66-95). Neither has changed since. [20260514120030](../supabase/migrations/20260514120030_eod_submissions_consistency.sql) dropped only the store-member UPDATE/DELETE policies.
  - Current `auth_can_see_store` ([20260517040000](../supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql)) admits super_admin, brand-scoped admins and `user_stores` members. So a `role = user` staffer reads every vendor's submissions and entries at their store.
  - The `vendors(name)` embed is already used by staff (`fetchVendorsForToday`, EODCount L123-127).
- **API: a PostgREST table read** (staff carve-out; not in `db.ts`). It lives in the new module `src/screens/staff/lib/borrowSources.ts`, a separate module for a clean jest mock seam like `submittedStatus.ts`:
  ```
  export async function fetchBorrowSources(storeId: string, countIso: string): Promise<ServerEodSource[]>
    supabase.from('eod_submissions')
      .select('id, store_id, date, vendor_id, status, submitted_at, vendor:vendors(name), eod_entries(item_id, actual_remaining, actual_remaining_cases, actual_remaining_each, no_need)')
      .eq('store_id', storeId).eq('date', countIso).eq('status', 'submitted')
      .order('submitted_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
  ```
  - **Don't filter by vendor server-side.** `.neq('vendor_id', x)` would also drop null-vendor rows and diverge from contract rule 1; the helper excludes this vendor.
  - **Mapping:**
    - **Don't** coerce a null `actual_remaining` to 0. `fetchExistingSubmission` does that at L263-267, which is why it can't be reused here.
    - NO NEED → three null numerics plus `no_need: true`.
    - Numeric → no `no_need` key (byte-identical §6.3 shape).
    - `submitted_at` → the **raw ISO string**, so microsecond precision survives. `vendor` is object-or-array normalized, as `fetchVendorsForToday` does.
  - **Errors:** it throws on error. The **screen** catches, calls `notifyBackendError('fetchBorrowSources', err)` and uses `[]` (R9, AC-15).
- **Types** (staff [types.ts](../src/screens/staff/lib/types.ts) or the new module):
  ```
  export type ServerEodSource = {
    submissionId: string; storeId: string; date: string; vendorId: string | null;
    vendorName: string | null; status: string; submittedAt: string | null; entries: EodEntry[];
  };
  export type BorrowedEntry = {
    vendorId: string | null; vendorName: string | null; entry: EodEntry; source: 'server' | 'queued';
  };
  ```

### 3. Pure helpers (`src/screens/staff/lib/borrowedEntries.ts`)

- **`deriveBorrowedEntries`** (AC-1):
  ```
  deriveBorrowedEntries(args: {
    serverSources: ServerEodSource[]; queue: QueuedSubmission[];
    storeId: string; countIso: string; vendorId: string; userId: string | undefined;
    vendorNameById: Record<string, string>;     // from the chip list, for queued sources (R4)
  }): Map<string, BorrowedEntry>               // keyed by item id
  ```
  1. **Server candidates.** Keep those with `storeId`, `date === countIso`, `status === 'submitted'` and `vendorId !== args.vendorId`. Null-vendor rows are kept, per contract rule 1. These filters repeat the read's (AC-1 a/b/d), as defence in depth.
  2. **Queued candidates.** Keep those with `store_id`, `date === countIso`, `vendor_id !== args.vendorId`, `userId` defined and `intent_user_id === userId` (AC-1 c/e). Per vendor, keep only the latest `queued_at` (ties: `client_uuid` desc), since it drains last and wins.
  3. **Replacement (R2).** Drop every server candidate whose `vendorId` has a queued candidate (AC-1 g). A queued submission replaces its vendor's server one **entirely**, because `staff_submit_eod` deletes and re-inserts that submission's entries on drain.
  4. **Rank** with one transitive composite key, descending:
     - `epochMs` (`Date.parse` of `submittedAt` / `queued_at`; a null `submittedAt` → −∞, last);
     - then, on equal ms, queued before server (AC-1 h);
     - then, for server vs server, the sub-millisecond microsecond digits of `submittedAt`, then `submissionId` (string compare);
     - then, for queued vs queued, `client_uuid`.

     Server vs server therefore reduces exactly to contract rule 2.
  5. **Walk the ranked candidates.** For each entry with `isBorrowable(entry)` (`entry.no_need === true || entry.actual_remaining != null`), set `out[item_id]` if it's absent. A blank legacy entry is skipped (contract rule 4).
  6. **Vendor name.** For a server source: `vendorName` (the embed). For a queued source: `vendorNameById[vendor_id] ?? null`. The renderer substitutes the fallback key for null (R4: never blank).
- **`entrySeed(entry: EodEntry): { caseRaw: string; unitRaw: string; noNeed: boolean }`.** This is `seedFromExisting`'s per-entry rule (EODCount L543-558), extracted **verbatim**: the spec 086 OQ-4 legacy fallback, spec 171 cases-only rows leaving units blank, and spec 172 NO NEED. `seedFromExisting` is refactored to call it, with byte-identical behaviour, and the borrowed display uses it (R4: "one shared helper").
- **AC-1 additions** (pin the shared contract): (i) equal `submittedAt` → the higher `submissionId` wins; (j) two server sources in the same millisecond but different microseconds → the later microsecond wins; (k) the latest server source holds a blank legacy entry for X → X comes from the next source.

### 4. Screen wiring ([EODCount.tsx](../src/screens/staff/screens/EODCount.tsx))

- **State.**
  - `serverSources: ServerEodSource[]`, loaded in the vendor/date/store load effect (L664-709) **in parallel with, and never blocking**, the item load. Use a request token or `cancelled` flag; the current effect has none, and a fast vendor switch must not land stale sources.
  - Re-read in `enterLockedAfterWrite` (L894-919) for AC-15.
  - `eodQueue` via `useStaffStore((s) => s.eodQueue)`.
  - `borrowed = useMemo(() => deriveBorrowedEntries({...}))`, with `vendorNameById` built from `vendors`.
- **Predicates.**
  - `ownCounted(it)` = today's `isCounted` body (L415-418).
  - `borrowedFor(it) = ownCounted(it) ? null : borrowed.get(it.id) ?? null`.
  - New `isCounted(it) = ownCounted(it) || borrowedFor(it) !== null`. It feeds the row indicator, `countedNum`, `isDone`, `advance`, `onSheetNoNeed`'s advance, and the gate's `isBlank` (L808-809) and its jump target (R3, AC-3, AC-4).
  - R7: a borrowed row counts regardless of the live count mode.
- **Display (R4, R7, R10).** For a borrowed row:
  - `caseValue`, `unitValue` and `noNeed` come from `entrySeed(entry)`;
  - `countMode` is the **legacy** layout `effectiveEodCountMode(item.caseQty)` (the locked-row model);
  - total = `entry.actual_remaining ?? 0`, display only;
  - `borrowedLabel` = `t('eod.borrowed.countedUnder', { vendor })`, or `t('eod.borrowed.countedUnderOther')` when the name is null.

  The same applies in SUBMITTED_LOCKED, including the synthesized `'(local)'` / `'(queued)'` `existing`, because the overlay is derived from own state, not stored.
- **Keypad and edit (R5).** The sheet opens on a borrowed row whenever inputs are editable, and shows the borrowed values: pass the display values to `StaffKeypadSheet`'s `caseValue` / `unitValue` / `noNeed` (L1526-1529).
  - **First committed key on a borrowed row** (recommended rule; the frontend owns the final UX): own state = `entrySeed(borrowed)`, with the **seated** field replaced by `appendKeypadDigit('', key)`. Typing `7` on a borrowed `5` gives own `7` (AC-6). A first backspace leaves the seated field blank; if the other field is also blank, the row is still borrowed.
  - **NO NEED** (row toggle or sheet) on a borrowed row starts from blank own state, giving own NO NEED; the label disappears.
  - Open/close with no key, and NEXT/SKIP, change nothing, so the row stays borrowed (AC-6).
  - Clearing an own value back to blank re-exposes the borrowed overlay (AC-7).
  - `onCancelEdit` needs no change: it re-seeds own state, and the overlay re-derives (R5, AC-13).
- **Payload (R8).**
  - The entries builder (L837-857) is **unchanged**. It reads only own maps, so borrowed rows are omitted by construction (AC-8).
  - **All-borrowed case.** If the built `entries` is empty, `items.length > 0` and `items.every((it) => borrowedFor(it) !== null)`, then `entries = items.map((it) => copy(borrowedFor(it).entry))`.
    - The copy is verbatim: the same four fields, with `no_need: true` only on NO NEED copies. It is never rebuilt through `eodRowEntryValues` (R7, AC-9, AC-10, AC-11).
    - Otherwise today's `eod.toast.noCountsEntered` path is unchanged.
    - After an all-borrowed submit, the copies are this vendor's **own** entries, so its locked view shows them with no label (own wins). AC-13's label assertion is for the mixed case.
- **Drain gap (R9; recommended, cheap).** Track the `client_uuid`s of the queued candidates for (store, `countIso`). When one disappears from `eodQueue`, re-run `fetchBorrowSources`. That closes the dequeue-to-next-read window.
- **Row component ([StaffEodCountRow.tsx](../src/screens/staff/screens/eod/StaffEodCountRow.tsx)).** Add an optional prop `borrowedLabel?: string | null`. Render it as one line under the name with `numberOfLines={1}`, tail ellipsis and testID `eod-borrowed-${item.id}` (R11 phone width, AC-19). Showing the same label in the sheet header is optional.

### 5. i18n (R11, AC-17)

`src/screens/staff/i18n/{en,es,zh-CN}.json`, under `eod`, with identical tokens:
- `eod.borrowed.countedUnder`: "Counted under {vendor}"
- `eod.borrowed.countedUnderOther`: "Counted under another vendor"

The frontend owns the final es/zh-CN wording. `i18n.test.ts` must pass.

### 6. Store impact, realtime and edge functions

- **Admin `useStore`:** untouched. **`db.ts`:** untouched (staff carve-out, CLAUDE.md). **`useStaffStore`:** unchanged; there's only a new read-only selector on `eodQueue`. `notifyBackendError` is the staff one.
- **Realtime:** none (specs 062/063). No publication change, so the restart gotcha doesn't apply.
- **Edge functions:** none.

### 7. Tests

- **Jest** (AC-1 to AC-15, AC-17, AC-18):
  - pure-helper tests next to `borrowedEntries.ts` (AC-1 a-h plus i-k above), plus an `entrySeed` parity test against the pre-refactor `seedFromExisting` cases;
  - screen tests in `src/screens/staff/screens/EODCount*.test.tsx` that mock `borrowSources.ts` as a module (AC-15 rejects it);
  - existing EODCount tests that pin the vendor-only `fetchExistingSubmission` mock shape are updated, not deleted (AC-18).
- **pgTAP, AC-16:** a new `supabase/tests/eod_cross_vendor_read_rls.test.sql`.
  - No existing suite pins a cross-**vendor** member read: `staff_role_eod_rls.test.sql` uses one vendor.
  - Use the 2222 `role = user` principal (Towson + Frederick, as in `eod_no_need.test.sql`). Seed vendor A's submitted row and entries at Frederick and at Charles, as postgres, on a synthetic date.
  - Assert the Frederick row and entries are visible (count 1 / n), and the Charles ones read 0 rows.
  - Hermetic: `begin; … rollback;`, no `set role anon`.
- **AC-19:** a manual phone-width preview on the local stack.

### 8. Risks and tradeoffs

- **Deploy ordering is the main risk.** If this client ships before spec 201 migration `20261118120000`, reorder shows `'stock'` and a false "EOD missing" on omitted shared rows. The quantities stay right. Vercel deploys on push to `main`, so **don't push this spec's client until the 201 migration is on prod**, or push it in the same window right after the prod apply. The EAS build follows the same rule.
- **Queued vs server timestamps (R2, AC-1 h).** A queued source's `queued_at` can be earlier than a server source's `submitted_at`, yet after it drains its server `submitted_at` is the drain time, so it becomes the latest. Before the drain the staff screen may show the other vendor's value; afterwards both surfaces show the drained one. This is the owner-chosen rule, and reorder never sees the pre-drain state.
- **Microsecond precision.** `Date.parse` truncates to milliseconds. The composite key in §3 keeps server-vs-server ordering identical to SQL; don't "simplify" it to `Date.parse` alone.
- **Extra read per vendor switch.** It's one scoped select of today's submissions for the store, which is small. On the 286 KB seed there are at most tens of submissions per (store, date).
- **Stale snapshot and stale all-borrowed copies:** see Residual risk. These are unchanged.

### 9. AC clarifications (architect; these change no behaviour)

- **AC-1:** add arms (i), (j) and (k) (§3) to pin the shared contract.
- **AC-9 / AC-10 / AC-11:** a "verbatim copy" carries `no_need` **only** when true. Numeric copies have no `no_need` key, matching the §6.3 / builder shape.
- **AC-12:** "own" means "would be in this vendor's payload" (D5). A stale value only in a box the live mode disables is not own, so that row shows the borrowed overlay if one exists.

### Files expected to change (for post-implementation review)

- **frontend-developer:**
  - `src/screens/staff/lib/borrowSources.ts` (new)
  - `src/screens/staff/lib/borrowedEntries.ts` and its test (new)
  - `src/screens/staff/lib/types.ts`
  - `src/screens/staff/screens/EODCount.tsx`
  - `src/screens/staff/screens/eod/StaffEodCountRow.tsx` (and optionally `StaffKeypadSheet.tsx`)
  - `src/screens/staff/i18n/{en,es,zh-CN}.json`
  - `src/screens/staff/screens/EODCount*.test.tsx`
  - `supabase/tests/eod_cross_vendor_read_rls.test.sql` (new, test-only)
- **No backend-developer work.**

## Handoff
next_agent: frontend-developer
prompt: Implement spec 200 against the "## Backend design" section. It is staff client only plus one test-only pgTAP file; there is no migration.
  - The borrow-source contract in §1 is shared with spec 201 §2 and must not be changed unilaterally.
  - This pass edits the same staff i18n JSON files as spec 201's frontend pass. Run it after that pass completes, or have one frontend-developer do both.
  - Do NOT push this client to main before spec 201 migration 20261118120000 is applied to prod.
  - After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/200-staff-eod-shared-item-counted-once.md
  - specs/201-reorder-shared-item-primary-vendor-wins.md

## Implementation notes (frontend-developer, 2026-11-18)

- **Borrow rule checked against spec 201.** `deriveBorrowedEntries` uses the candidate set and order of `eod_borrow_source` in `20261118120000_reorder_primary_wins_borrowed_count.sql`: `(store, date, 'submitted')`, any vendor including null, `submitted_at DESC NULLS LAST, id DESC`. Staff's borrowable rule also takes `no_need = true`, as §1 rule 4 says. Timestamps are compared to the microsecond: the fraction is trimmed to 3 digits for `Date.parse`, and the digits below the millisecond are a separate key. Arms (i)-(k) pin this.
- **Change from §4 (label placement, to meet AC-19).** At 390 px the leading column under the item name is only about 86 px wide, so `"Counted under <vendor>"` was cut off even for short vendor names. The label now sits on its own full-width line at the bottom of the row card. To do that, `ListRow` (`src/screens/staff/components/ListRow.tsx`) gained an optional `footer` slot. When `footer` is absent, the layout is unchanged. It is still `numberOfLines={1}` with a tail ellipsis and testID `eod-borrowed-<id>`. In the browser at 390 px the label measured scrollWidth = clientWidth = 364 px, so it is not cut off.
- **All-borrowed submit (§4 "copies are own").** After a confirmed or queued write that sent the verbatim copies, the screen seeds the own maps from those copies through `seedFromExisting`. The locked view then shows them as own entries with no label, matching what a reload shows. Mixed submits keep the typed inputs as before (spec 129).
- **Drain gap closed (R9).** The screen tracks the `client_uuid`s of this user's queued submissions for (store, `countIso`). When one leaves the queue, `fetchBorrowSources` runs again. A request token drops any stale read.
- **First committed key on a borrowed row** follows §4's recommended rule. The own state becomes `entrySeed(borrowed)` with the seated field replaced by the key.
- **Browser check (AC-19), local stack, 390x844.** Logged in as manager@local.test at Frederick, with three throwaway vendors scheduled today and item X linked to all three:
  - Vendor A was submitted with X = 5.
  - Under vendor B, X showed 5 with "Counted under …", the counter read `1 of 2 counted`, and the gate jumped to Y. B's `staff_submit_eod` `p_entries` held only Y (X omitted).
  - Under vendor C (all borrowed), the payload was the verbatim copy of X, the chip turned green, and the locked view showed no label.
  - The DB matched these results. All fixture rows (vendors, catalog, items, links, schedule, submissions and entries, audit rows) were deleted afterwards.
- **Gates.**
  - Full `npx jest`: 318 suites / 4067 tests passed.
  - `npm run typecheck:test`: clean.
  - Full pgTAP: 112/112 files passed, including the new `eod_cross_vendor_read_rls.test.sql` (7 assertions).
  - `npm run typecheck` (base) shows only the 24 known TS2688 errors from the Finder-duplicate `node_modules/@types/* 2` folders. There are no other errors.
- **Deploy gate (D6) still applies.** Don't push this client before spec 201 migration `20261118120000` is on prod.
- **Fix round 1 (2026-11-19, AC-20; owner chose "Add a stock check now" for the security-auditor Medium).**
  - **Where the check sits.** In `onSubmit`, only on the all-borrowed path and right before the copies are built. `fetchCurrentStock` (new `src/screens/staff/lib/stockCheck.ts`, a store-scoped `inventory_items` `id, current_stock` read) loads the copied numeric items. The pure `stockMismatchIds` / `sameQuantity` in `borrowedEntries.ts` compare the values.
  - **On a mismatch or a failed read.** The items go into a per-load `recountIds` set, so `borrowedFor` / `isCounted` treat them as not borrowed. Then the toast shows, the keypad jumps to the first such item, and the row shows a warning footer. The set is cleared on the next vendor, date or store load.
  - **Queued sources** go through the same check and are not exempt.
  - **New staff i18n keys:** `eod.toast.stockChangedTitle`, `eod.toast.stockChangedRemaining`, `eod.borrowed.stockChanged`.
  - **Browser check on the local stack (port 8085, 390x844, manager@local.test at Frederick)**, with three throwaway vendors scheduled today:
    - Sysco counted X = 5, X2 = 6 and Z = 1. Then a delivery was simulated by setting X's `current_stock` to 17 in the DB.
    - Under BJs (X and X2 both borrowed), Submit sent no `staff_submit_eod`. It ran one stock read, showed the toast, and opened the keypad on X. X showed the "Stock changed" line; X2 stayed "Counted under". After X was counted as 17, the payload was only X = 17.
    - Under Costco (X2 only, stock unchanged), the copy X2 = 6 was sent.
    - Final on-hand was X = 17 and X2 = 6, so the delivery was not reverted. The label lines measured 364/364 px with no truncation.
    - All fixture rows were deleted afterwards.
  - **Gates after this round:**
    - full `npx jest`: 320 suites / 4084 tests passed;
    - `npm run typecheck:test`: clean;
    - full pgTAP: 112/112.
- **Fix round 2 (2026-11-19; owner approved "Yes, fix both first").**
  - **Offline rule (AC-21).** `useEodSubmit.submit` takes optional `SubmitOptions { allowQueue?: boolean }`. With `allowQueue: false`, both the offline-snapshot path and the network-error path return `failed` with `eod.toast.notSentOffline` and enqueue nothing. `EODCount` passes it only for an all-borrowed copy submit, so every other caller is byte-unchanged.
  - **Read-failure wording.** `recountIds` is now a map from item id to `'changed' | 'unchecked'`. A failed read uses `eod.toast.stockUncheckedTitle` / `eod.toast.stockUncheckedRemaining` and the row line `eod.borrowed.stockUnchecked`.
  - **Code-review nits.** The footer style is renamed `borrowedLabel` → `footerLabel`, and a comment now explains the `setSubmitting` double-tap guard around the stock read.
  - **Browser check** on the local stack (port 8085, 390x844, manager@local.test at Frederick), with three throwaway vendors scheduled today. Sysco counted X = 5, X2 = 6 and Z = 1.
    - **Stock read blocked** (Playwright `route.abort` on the `inventory_items … current_stock` read) under Costco (X2 only, all-borrowed): no RPC was sent. The toast read "Couldn't check stock / Please count these items (1)" and the row line read "Couldn't check stock — please count it".
    - **RPC blocked** (`staff_submit_eod` aborted as `internetdisconnected`) after a vendor switch reset the flags: there was one RPC attempt after one stock read. The toast read "No connection — not sent. Try again." The button stayed Submit, X2 stayed "Counted under", and the localStorage queue held 0 items.
    - **Retry with the RPC unblocked:** a second stock read ran, then the submit succeeded (Edit, chip green, queue 0).
    - **Mixed submit** (BJs: own X plus borrowed X2) with the RPC blocked: the toast read "Queued — will sync when online", the queue held 1 item, and no stock read ran. That queued item was removed from localStorage before closing, so it never drained.
    - All fixture rows were deleted afterwards.
  - **Gates:**
    - full `npx jest`: 320 suites / 4090 tests passed;
    - `npm run typecheck:test`: clean;
    - full pgTAP: 112/112.

## Files changed

- `src/screens/staff/lib/borrowSources.ts` (new): `fetchBorrowSources`
- `src/screens/staff/lib/borrowSources.test.ts` (new)
- `src/screens/staff/lib/borrowedEntries.ts` (new): `deriveBorrowedEntries`, `entrySeed`, `borrowedEntryCopy`, `isBorrowable`, `parseTimestamp`
- `src/screens/staff/lib/borrowedEntries.test.ts` (new): AC-1 (a)-(k), `entrySeed` parity, copy shape
- `src/screens/staff/lib/types.ts`: `ServerEodSource`, `BorrowedEntry`
- `src/screens/staff/screens/EODCount.tsx`
- `src/screens/staff/screens/eod/StaffEodCountRow.tsx`: `borrowedLabel` prop
- `src/screens/staff/components/ListRow.tsx`: optional `footer` slot (see the implementation notes)
- `src/screens/staff/i18n/en.json`, `es.json`, `zh-CN.json`: `eod.borrowed.countedUnder`, `eod.borrowed.countedUnderOther`
- `src/screens/staff/screens/EODCount.borrowed.spec200.test.tsx` (new): AC-2 to AC-15
- `src/screens/staff/screens/EODCount.test.tsx`: `borrowSources` module mock added (AC-18)
- `src/screens/staff/screens/EODCount.noNeed.spec172.test.tsx`: `borrowSources` module mock added (AC-18)
- `supabase/tests/eod_cross_vendor_read_rls.test.sql` (new, test-only): AC-16
- `specs/200-staff-eod-shared-item-counted-once.md`: status and this list

### Fix round 1 (2026-11-19, AC-20)

- `src/screens/staff/lib/stockCheck.ts` (new): `fetchCurrentStock`
- `src/screens/staff/lib/stockCheck.test.ts` (new)
- `src/screens/staff/lib/borrowedEntries.ts`: `sameQuantity`, `stockMismatchIds`
- `src/screens/staff/lib/borrowedEntries.test.ts`: AC-20 pure arms
- `src/screens/staff/screens/EODCount.tsx`: pre-submit stock check, `recountIds`, recount row line
- `src/screens/staff/screens/eod/StaffEodCountRow.tsx`: `recountLabel` prop
- `src/screens/staff/i18n/en.json`, `es.json`, `zh-CN.json`: `eod.toast.stockChangedTitle`, `eod.toast.stockChangedRemaining`, `eod.borrowed.stockChanged`
- `src/screens/staff/screens/EODCount.borrowed.spec200.test.tsx`: AC-20 screen arms; existing all-borrowed arms now set the mocked stock
- `specs/200-staff-eod-shared-item-counted-once.md`: AC-20, Residual risk, implementation notes, this list

### Fix round 2 (2026-11-19, AC-21 and the read-failure wording)

- `src/screens/staff/hooks/useEodSubmit.ts`: `submit(payload, options?)`, `allowQueue: false` → `failed` instead of queueing
- `src/screens/staff/hooks/useEodSubmit.test.ts`: AC-21 hook arms
- `src/screens/staff/lib/types.ts`: `SubmitOptions`
- `src/screens/staff/screens/EODCount.tsx`: `allowQueue: false` for all-borrowed submits; `recountIds` reason map; distinct read-failure wording; double-tap guard comment
- `src/screens/staff/screens/eod/StaffEodCountRow.tsx`: style renamed to `footerLabel`
- `src/screens/staff/i18n/en.json`, `es.json`, `zh-CN.json`: `eod.toast.stockUncheckedTitle`, `eod.toast.stockUncheckedRemaining`, `eod.toast.notSentOffline`, `eod.borrowed.stockUnchecked`
- `src/screens/staff/screens/EODCount.borrowed.spec200.test.tsx`: AC-21 screen arms; read-failure wording arm
- `specs/200-staff-eod-shared-item-counted-once.md`: AC-20 wording, AC-21, Residual risk, notes, this list

