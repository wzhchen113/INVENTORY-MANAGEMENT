## Code review for spec 189

Scope read: `src/lib/eodChangeSet.ts`, the `submitEODCount` block in `src/lib/db.ts`, `useStore.submitEOD` (and its interface comment), the baseline / `buildSubmission` / `onSaveDraft` / `onSubmit` / `onEditCurrentVendor` parts of `EODCountSection.tsx`, migration `20261109120000_admin_eod_replace.sql`, and `reviews/manual-verification.md`. Nothing was run. No direct Supabase calls outside `db.ts`, no inline colors, no `confirmAction` bypass, and no legacy-file edits in the reviewed code.

### Critical
None.

### Should-fix

- `src/screens/cmd/sections/EODCountSection.tsx:1110` (baseline clear) with `:1111-1114` (map clear) and `:257` (ref) — **A stale baseline can delete a drafted count.** The input maps are keyed by vendor only, but the baseline is keyed by store, date and vendor. `finishSubmitted` clears the vendor's maps and deletes only the baseline for the date being submitted. Path:
  1. Monday: SAVE DRAFT for vendor V. This advances the baseline to the shipped rows and leaves the maps filled.
  2. Switch to Tuesday and SUBMIT V. The vendor's maps are wiped, which includes Monday's typed values. Monday's baseline survives.
  3. Return to Monday. The draft is unlocked and the inputs are blank, because drafts don't refill.
  4. Count a few items and SUBMIT. The completeness gate passes because drafted rows count as entries (N2).
  5. Every baseline row with a blank input now reads as "blanked" and goes in the removal list. The drafted counts are deleted and the user sees a success toast.

  This is the "draft, reload, count the rest" loss D-4 exists to prevent, reached without a reload. Rule B only stops the case where every row goes. Fix: when `finishSubmitted` clears a vendor's maps, also drop every baseline key ending in `|${vid}` (or the same for any code path that clears the maps), or key the maps by date. A jest arm for it belongs in `EODCountSection.resubmit.spec189.test.tsx`.

- `src/lib/eodChangeSet.ts:96-106` with `EODCountSection.tsx:915-926, 1138-1141` — **Note-only edit on a mode-disabled row is lost, and the screen reports success.** This is question 1. See the verdict below. Add a signal, such as a skipped-row list and a warning toast. As it stands the user gets a success toast, a relock and a jump to Ordering with the edit gone.

- `src/store/useStore.ts:3335-3347` — **The undo restores a stale snapshot, not "what the optimistic path changed".** It writes back the captured `existing` object and the captured on-hand values unconditionally. If a realtime reload lands while the RPC is in flight, or the RPC commits but the client sees an abort (design §8 "Abort after commit"), undo overwrites the fresher server data. In the new-row case it filters out the row by key, which can remove the real row a reload just inserted. Fix: undo each piece only if the current value is still the optimistic one, by reference. That means keeping the object the optimistic `set` wrote and comparing `sub === optimisticRow`, and doing the same per item for on-hand. Otherwise skip that piece and let the reload win. The sibling worry is that realtime's debounced reload is exactly what follows a failure, so the cheap alternative is to call the reload after undo.

### Nits

- `EODCountSection.tsx:645` — builds the baseline key inline (`${currentStore.id}|${selectedIso}|${vid}`) while `baselineKey` exists at `:258`. Two places must now agree for the key to match. Either use `baselineKey(vid)` (it closes over the same values, so add it to the deps) or hoist one pure `eodBaselineKey(storeId, iso, vendorId)`. This is the kind of duplication that causes the stale-baseline class above.

- `EODCountSection.tsx:977` — the "Defensive" empty check is unreachable. A `ship` plan always has entries or removals, and `entries` can only drop to 0 if an id fell out of `storeInventory`, in which case `removedItemIds` is also empty. Fine to keep, but the comment should say which case it guards.

- `supabase/migrations/20261109120000_admin_eod_replace.sql:331-335` — the copied step-(1.5) comment says service_role is revoked "in the GRANT block at the bottom". That block isn't in this file any more (the ACL carries over from `create or replace`). Reword to say the ACL is inherited from `20261024000000`. In the same function the step labels (1), (1.5), (3), (4) skip (2) and say "(5)-(7)", which now refers to the writer. A single line saying "numbering follows 20261024000000" fixes it.

- Migration `:380-390` and `:479-489` — the two writer calls pass `null, v_actor, null` and `null, v_removed, null, auth.uid()` positionally across nine parameters. Use named notation (`p_removed_item_ids => null`, `p_audit_actor => v_actor`) so a swapped argument can't compile silently. The types would catch some swaps, but not `null`/`null`.

- Migration `:97` — the pre-flight raises with `23505`. Reasonable, since it's what the index would have raised, but a comment saying that is deliberate would help whoever greps for the code.

- `src/lib/db.ts:1074` — `data as {...}` has no null guard. Safe today because the RPC always returns an object, but a one-line `if (!data) throw` would match the file's other RPC wrappers (out-of-scope pattern note only).

- `src/lib/eodChangeSet.ts:7-18` — header comment is good (why, not what). `EodSubmitPlan`'s table duplicates the one in the design doc and will drift. Keep the table, drop the design-doc section number references if the spec file is ever archived.

### Judgement calls asked for

**1. Frontend deviation from design §5 (removal only if the baseline row showed a count under the live mode).**
Keep it. The design table row says a saved value in a now-disabled box "stays", and the §5 rule list would have removed it as soon as the row was edited, which contradicts both that table row and D-4. The guard is consistent with the stated principle and is covered at `eodChangeSet.test.ts:166` and `:175`. The cost is the silent note loss. Dropping the guard would trade a lost note for a deleted count, which is worse. The fix is a signal, not a rule change. Recommended shape:
- `buildEodChangeSet` also returns `skippedItemIds`: rows that differ from baseline but are neither changed nor removed.
- `buildSubmission` passes them through. If any exist, show a warning toast (for example "N row(s) not saved: re-enter the count to change the note"). On the noop path, don't show the plain success toast.
- Amend design §5 and the spec so the code and the contract agree. Right now the spec text is stale against the code.

A UI signal is warranted: the screen currently says "Count submitted" for an edit that wasn't saved. It is a narrow case (mode changed after the count, then a note-only edit), so a toast is enough and no new input state is needed.

**2. Baseline ref.** Set points are right (EDIT from `sub.entries`; SAVE DRAFT advance of shipped rows and removal of removed rows). Clear point on SUBMIT is right for the submitted key only, which is the stale path above. Other paths checked:
- Store switch and date switch: the key includes both, so no removal can fire across them. Leftover entries accumulate for the life of the section, which is harmless.
- Realtime reload mid-EDIT: the baseline is deliberately not refreshed, so untouched rows are skipped. A colleague's newer value on a row this manager blanked loses, as the design accepts.
- Tab (vendor) switches: the baseline is keyed by vendor, so it stays correct.
- Undo / failed write: the baseline is left alone and the store is reverted, so a retry computes the same diff. Correct.
- SAVE DRAFT then EDIT: the draft is unlocked, so no EDIT. SAVE DRAFT on an EDITed submission leaves it in editing mode with the advanced baseline, which is right.
- Not covered: the Monday-draft / Tuesday-submit path above.

**3. Undo from `useStore.submitEOD`.** It restores exactly the fields the optimistic path changed, which is the existing row (or removes the new one) plus `currentStock`, `eodRemaining`, `lastUpdatedBy` and `lastUpdatedAt` for items the mirror touched. Audit rows and the bell are intentionally not undone (D-5). The one weakness is the unconditional restore noted above. Also fine: the first-write-wins snapshot map and the removal merge.

**4. Migration readability.** Good overall: the header lists the six parts, the order-is-load-bearing comments sit next to the code they protect, and the forward `comment on` corrections are accurate. I compared the `report_last_order_context` comment with `20260803000000:349-368`. The first part is a faithful re-statement and the Spec 189 addendum is appended. The `eod_entries` table comment states the "frontend never DELETEs" correction plainly. Remaining items are the nits above.

**5. Stale comments (AC-29).** All six table rows are done, plus the added ones:
- `db.ts` block (`:1013-1038`): rewritten with the code.
- `useStore.ts` "third copy" comments: rewritten as "TWO copies" and the `adjustItemStock` removal is explained.
- `eod_submissions_edit_flow.test.sql` header: corrected (service_role wording removed).
- `report_last_order_context.test.sql:335`: rewritten with the reason.
- `e2e/staff-reorder.spec.ts`: "no natural unique key" no longer appears.
- `EODCountSection.tsx` filteredItems comments (`:263`, `:694`, `:890-899`, `:1062`): updated.
- The 20260514120030 and `report_last_order_context` corrections went forward through `comment on`, as the design chose.

### Notes on the manual pass
`manual-verification.md` covers AC-28 steps 1 to 6 and marks step 7 (on-screen reorder quantity) as not checked, with a reason. That matches the spec's own list, so step 7 stays open for the owner. It doesn't exercise the note-only-edit case or the Monday-draft path.

### Out-of-scope
- (out-of-scope) The vendor-keyed input maps leaking across dates and stores (design §5 "Pre-existing bug", spec 192) is the root cause of the stale-baseline finding. Keying the maps by date would remove it, but that belongs to spec 192.

## Re-check (S1 fix)

Read only; nothing was run.

**Confirmed in `EODCountSection.tsx`**
- `finishSubmitted` (`:1122`) calls `dropVendorBaselines(baselineRef.current, vid)` at `:1135`, before the four map clears. The helper (`:192-196`) deletes every key ending in `|${vendorId}`, so it covers all dates and stores.
- Key construction: `eodBaselineKey` (`:183`) is module-level. Its only callers are `baselineKey` (`:279`) and the EDIT seed (`:666`). No inline `${...}|${...}|${...}` key remains. The vendor id is the last segment, which the suffix match needs. The inline-key nit is closed.
- Other paths that empty a vendor's maps: only `:1136-1139`. The rest are per-row edits (`commitRow`, `clearNoNeed`, the `setCaseCounts`/`setUnitCounts`/`setNotes` updaters), which are real user blanks. The seed overlay at `:681-683` merges and doesn't empty. No path empties the maps and leaves a baseline.
- Success and failure: `finishSubmitted` is reached from the noop branch (`:1163-1165`) and after `await submitEODCount` succeeds (`:1171`). The `catch` (`:1172-1178`) only calls `undo()` and shows the error toast, so baselines and typed values survive for a retry. SAVE DRAFT doesn't call it and advances the baseline instead (`:1058-1060`), which is correct.

**Test.** The last `describe` (`:441-496`) follows the Monday-draft, Tuesday-submit, Monday-submit path:
1. SAVE DRAFT p1 and p2 on day A.
2. SUBMIT on today, which empties the vendor's maps.
3. Back on day A, both inputs are blank and editable.
4. Type d1 and SUBMIT.

It asserts `removed` is `[]`, the shipped ids are `['d1']`, and the stored entries are `d1, p1, p2`. With the old single-key delete, day A's baseline (p1, p2) would survive step 2. Step 4 would then read both rows as blanked, and `removed` would be `['p1','p2']`. That fails the `removed` assertion, so the test does cover the bug. I traced this by reading and didn't execute it.

**Developer's reasoning.** Clear-on-map-clear is the right fix. The invariant is that a baseline must never describe values the maps no longer hold, so the drop belongs at the one place the maps are emptied. Drop-on-date-change would be the wrong trigger. It would discard a valid baseline when the user flips dates mid-EDIT and returns, which turns real blank-only corrections into silent no-ops. It would also protect nothing extra, because the maps are untouched on a date switch. The fix fails safe: with no baseline, `buildEodChangeSet` produces no removals, so the worst case is a missed removal and never a deleted count.

**Residual left to spec 192.** This is acceptable. The vendor-keyed maps still carry typed values across dates, so a value typed on Monday shows on Tuesday. If the user blanks it there, it counts as a blank only when that date has a baseline. Fixing this means keying the maps by date, which belongs in 192. S1 was about deleting drafted counts, and that path is closed. The carry-over only leaves a wrong-date value on screen. The step-2 comment in the test already documents it. Make sure spec 192 lists this behaviour and the note-loss signal (the second Should-fix above, still open).

**Verdict: S1 resolved.** The other two Should-fix items (the silent note-only loss and the stale-snapshot undo) were not part of this re-check and are unchanged.
