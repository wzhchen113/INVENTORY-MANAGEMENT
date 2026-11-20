## Security audit for spec 192

Scope: the uncommitted working-tree diff against `97f0f17` for the files in the spec's `## Files changed`, mainly `src/lib/eodDraftSlot.ts` (new) and `src/screens/cmd/sections/EODCountSection.tsx`. Other sessions' uncommitted edits (`src/lib/db.ts`, `src/lib/auth.ts`, invite files, the `test:smoke` line in `package.json`) are outside this spec and weren't reviewed. Nothing changes on the server: no migration, RLS, RPC, edge function, `db.ts` or `useStore.ts` change. So the review covers client-side data integrity: can one (store, date, vendor) slot's values or removals reach another slot's write?

**Result: none found.** Every write path below is bound to the slot it started from.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- None.

### Low
- `supabase/migrations/20261109120000_admin_eod_replace.sql:430`: `admin_submit_eod` checks `auth_is_privileged() AND auth_can_see_store(p_store_id)` but puts no bound on `p_date`. That means the client is still the only thing keeping an admin's counts on the intended date. This spec closes the known client leak. A future client regression in this area would get no server backstop, whereas the staff path is getting one in spec 193. This isn't an authorization gap (the caller is a privileged member of the store) and isn't introduced here; spec 189 O-2 and this spec's Out of scope both defer it. Recorded so the deferral stays visible. Possible fix later: a date window on `admin_submit_eod` that matches spec 193's staff bound, with an explicit allowance for back-dated admin corrections.
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.dateScoped.spec192.test.tsx:398-540`: test gap. The in-flight arms (AC-8, AC-9, SAVE DRAFT) change only the **date** while the write is pending. No arm switches the **store** mid-flight. The code is safe by construction: `submittedSlot` includes `currentStore.id`, captured before the `await` (`EODCountSection.tsx:1159`, `:1083`), and the payload's `storeId` is fixed in `buildSubmission` in the same tick. But nothing pins that, so a refactor that re-reads `currentStore.id` after the `await` would pass the suite. Suggested fix: one arm that holds `submitEODCount` pending, runs `useStore.setState({ currentStore: S2 })`, then resolves, and asserts that only the S1 slot is cleared and S2 is untouched. This is advisory (test-engineer's call).

### Paths checked, no finding

1. **SUBMIT / UPDATE COUNT** (`EODCountSection.tsx:1109-1233`)
   - `buildSubmission` (`:962-1052`) reads only the current slot's accessors (`caseCounts` / `unitCounts` / `notes` / `noNeed`, derived from `slot` at `:303-306`) and `baselineRef.current[slotKeyFor(selectedVendorId)]`.
   - It stamps `date: selectedIso` and `storeId: currentStore.id` from the same render.
   - `dateIso`, `submittedSlot` and `submittedDay` are captured synchronously after `buildSubmission` and before `setSubmitting` and the `await`.
   - `finishSubmitted` (`:1161-1210`) uses only the captured values: it deletes the baseline, clears the four maps and removes the EDIT flag at `submittedSlot`.
   - The failure path (`:1223-1229`) touches no slot state.
   - Both handlers are plain per-render closures bound to the button. React flushes a discrete date-cell click before the next click is handled, so SUBMIT can't run with the previous date's closure.
2. **SAVE DRAFT** (`:1054-1104`): `submittedSlot` is captured at `:1083` before the `await`, and the baseline advances only at that key (`:1090-1092`). The no-op route is synchronous.
3. **Concurrent writes.** `submitting` is one global flag. It disables SAVE DRAFT and SUBMIT on desktop (`:1756`, `:1769`) and on phone (`PhoneEodCount.tsx:481`), so a second slot can't start a write while one is pending. `onSubmit` and `onSaveDraft` have no other callers (no keyboard shortcut).
4. **EDIT seed** (`:670-733`)
   - `currentVendorSubmission` is filtered by store, date and vendor (`:649-657`).
   - The baseline, EDIT flag, overlay and NO NEED seed all write to the one key `k = slot`.
   - The "typed" check reads the same slot's maps. A D0 value can't beat D-1's seed, and D-1's baseline can't land on D0.
5. **Completeness gate.**
   - `deriveCountedItemIds` (`:114-162`) filters arms (a) and (c) through `isEodSlotOfDay`.
   - The prefix test includes the trailing `|` (`src/lib/eodDraftSlot.ts:37`). Store and vendor ids are uuids and the date is fixed-width, so `s1` vs `s10` and same-store-other-date can't collide. `eodDraftSlot.test.ts` pins this.
   - Arm (b) is unchanged.
   - The gate only blocks or allows a submit, never adds rows to the payload. A gate leak couldn't put values into a submission anyway.
6. **Export** (`buildExportGroups`, `:862-886`): each vendor tab reads `eodSlotKey(currentStore.id, selectedIso, v.id)`, and the rows come from `storeInventory` (current store only). `currentStore.id` and `selectedIso` are in the dependency list. The export holds only data the admin can already see, at their current store.
7. **Store switch (vendors brand-wide, item ids per store)**
   - Every key starts with `currentStore.id`. After a switch, the accessors, gate, export and `buildSubmission` read S2's slots only. `buildEodChangeSet` also skips any id missing from the current store's items (`src/lib/eodChangeSet.ts:94-95`), a second filter.
   - EDIT flags are per slot, so S1's EDIT can't unlock S2's locked submission.
   - S1 drafts stay in component memory while S2 is shown. Same user, same session, and no exposure: a submit for S1 is only possible while S1 is selected, and the server re-checks `auth_can_see_store` on every write.
8. **Phone.**
   - The `model` literal (`:1480-1524`) passes only slot-derived fields. No `*BySlot` map reaches `PhoneEodCount`.
   - Keypad digits write straight through the slot setter, with no buffered commit (`PhoneEodCount.tsx:159-166`).
   - The sheet is an RN `Modal` over the day strip. Even if focus escaped it, the sheet shows and writes the same slot, so a write would be visible, never hidden.
9. **+ COUNT rows** (`:381-393`, `:408`, `:2271`): keyed by day and used only for `filteredItems` and the gate. They never add values to the payload.
10. **Narrowing spec 189's `dropVendorBaselines` to the submitted slot (`:1177`)**
    - **Removal rule.** `buildEodChangeSet` (`src/lib/eodChangeSet.ts:96-106`) emits a removal only when the **same slot** has a baseline row, the current row is blank and not NO NEED, and the baseline row showed a count under the live mode.
    - **Who writes the maps.** The only writers are user input through the slot-bound setters and `commitRow` / `clearNoNeed` (`:303-363`), the EDIT overlay (non-blank-wins, so it never blanks a saved value), and `finishSubmitted`.
    - **Who writes the baseline.** Only EDIT (`:692`), SAVE DRAFT success (`:1092`) and SUBMIT success (`:1177`).
    - **Why the old rule was needed.** Spec 189 dropped baselines across dates because its vendor-keyed maps were wiped across dates, and that left blank maps under live baselines.
    - **Why it's safe now.** Maps and baselines are now created and destroyed together per slot. A SUBMIT on (S, D1, V) leaves (S, D0, V)'s maps and baseline intact and consistent. So a blank row under a baseline can only come from the manager blanking that row in that slot.
    - **Edge cases checked.**
      - The same-slot in-flight SAVE DRAFT followed by a blank: that's an intentional blank.
      - The server submission changing under a live baseline: an unchanged row is skipped by `sameEodRow`, so no removal.
      - Mode changes: pre-existing spec 189 / 171 behaviour, guarded by `eodRowCounted`.
    - **Tests.** AC-19, both AC-24 arms and spec 189's edited S1 arm (steps 4-5) pin the "no removal for an un-blanked count" outcome.
    - **Server side.** Removals are scoped to the (store, date, vendor) parent: `e.submission_id = v_submission_id AND e.item_id = any(...)` (`20261109120000_admin_eod_replace.sql:179-180`, `:491`). A client bug can't delete another slot's rows on the server.
11. **Header** (`:1701`): `selectedIso` comes from `localDayIso` (no user input) and is rendered through RN `Text`. `appLocale` is the typed app-locale value. No injection surface.
12. **Secrets, PII, logging.** No new `console.*`, toasts or error payloads. The existing `console.warn` lines log only `e?.message`.

### Dependencies
`package.json` differs from `97f0f17` only in a `test:smoke` script line from another session's uncommitted change, not part of this spec. No dependency or lockfile change. `npm audit --audit-level=high` was run anyway for the record: 46 existing advisories (1 critical `shell-quote`, 17 high including `ws`), all in the existing dependency tree and none added by this spec. That backlog belongs to a separate dependency-hygiene pass and doesn't block this spec.
