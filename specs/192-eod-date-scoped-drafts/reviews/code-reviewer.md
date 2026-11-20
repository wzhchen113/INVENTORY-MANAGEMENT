## Code review for spec 192

Read: `eodDraftSlot.ts` and its test, the whole state, handler and reader surface of `EODCountSection.tsx` (current file; I had no git access, so I read the working tree, not the diff), the new `dateScoped.spec192` suite, the edited S1 arm in `resubmit.spec189`, and 189's `reviews/code-reviewer.md` S1. Nothing was run. The four mechanically edited suites (countedOnce, customOrder, 171, 172) were checked only by a repo-wide grep for stale `ByVendor`, `editingVendorIds`, `dropVendorBaselines` and `eodBaselineKey`. That grep is clean, apart from `savedIdsByVendor`, which is intentionally vendor-keyed, and two comments.

### Critical
None.

### Should-fix
- `src/screens/cmd/sections/eod/__tests__/EODCountSection.resubmit.spec189.test.tsx:447-505` — **The edited S1 arm no longer guards the thing S1 was about, and the narrowing of `dropVendorBaselines` has no dedicated guard in it.** I traced the new steps against the section. It passes, but it would also pass if `finishSubmitted` dropped *every* baseline for the vendor, or none. Steps 4-5 never blank a day-A row. Day A's `p1`/`p2` stay typed as 5/6, so with the baseline gone they'd ship as ordinary values and `removed` would still be `[]`. The arm is now a "day B's SUBMIT doesn't disturb day A's typed values" check. That's worth keeping, but it is a different claim from S1's "a stale baseline turns a blank into a removal". The narrowing is covered elsewhere: AC-19 (`dateScoped.spec192.test.tsx:780-800`) requires D-1's EDIT baseline to survive a D-2 SUBMIT, because it expects the removal of `a` afterwards. That is the real guard. Suggested fix: add one step to the S1 arm, between steps 3 and 4. Blank `p1` on day A, then SUBMIT with `d1` counted, and assert `removed` equals `['p1']`. That pins the narrowing here too, next to the "no removal of the drafted rows" assertion, and makes the arm test both halves. Also reword the header comment so it doesn't say "Steps 4 and 5 — the point of the arm — are unchanged". The point of the arm moved.

### Judgement calls

1. **Is 189's S1 class still closed? Yes. AC-24 holds.** I read every site that touches the baseline or the maps.
   - Baseline writers:
     - EDIT (`:692`) sets `baselineRef.current[slot]`.
     - SAVE DRAFT success (`:1090-1092`) advances the baseline at `submittedSlot`.
     - SUBMIT success, including the no-op route, deletes `baselineRef.current[submittedSlot]` (`:1177`).
   - Baseline reader: `buildSubmission` (`:967`) reads `slotKeyFor(selectedVendorId)`, the same slot as the maps it is paired with.
   - Map writers:
     - The setters (`:307-318`), `commitRow`/`clearNoNeed` (`:330-362`) and EDIT seed (`:707-725`) all write `[slot]`.
     - The success clear (`:1178-1181`) writes `[submittedSlot]`.
   - The invariant "a slot's baseline lives and dies with that slot's maps" holds on every path.
     - The only way for a baseline to outlive its maps was 189's vendor-wide map clear. That is now gone.
     - The only way for a baseline to be missing while maps are present is a successful SUBMIT, which clears both together.
   - Under the old `dropVendorBaselines`, other dates' maps survived with their baselines gone. A later blank of a saved row there would read as "never touched" and keep the count. The narrowing is therefore required, not just allowed.
   - The AC-24 arms cover both seed paths (SAVE DRAFT and EDIT). The cross-date blank never touches D0's slot or baseline.
   - Residual, not new and not in scope: a baseline or EDIT flag can outlive a server-side change to the submission, for example another device or a realtime reload. This is the design's stated "one limit".

2. **Steps 2-3 edit: justified, but see the Should-fix above.** Both edits follow from the spec's own premise. Step 2 counted only `d1` because day A's values leaked onto day B. Step 3 expected blank because day B's SUBMIT wiped the vendor-keyed maps. Neither could survive R1/R2. The reason is stated in the arm's header and under AC-22, as P9 asked. The arm is cut down to a weaker test, not a wrong one.

3. **D-192-1 `liveDayKeyRef`: correct as built.** It is read only after the await, compared against the captured `submittedDay`, and compares by day, so a same-date vendor-tab switch still jumps. The ref is updated in an effect, not during render, which is the safer React pattern. Both polarities are tested (`:515-537`, plus AC-8's `pending` is null). The ref update lags a commit by one effect, but the only reader is a promise continuation that runs after commits. Not a practical gap.

4. **In-flight capture: correct.** `onSubmit` captures `dateIso`, `submittedSlot` and `submittedDay` synchronously before the `await` (`:1158-1160`). `onSaveDraft` captures `submittedSlot` from `built.submission.vendorId` (`:1083`). Nothing after the await reads `slot`, `selectedIso`, `currentStore.id` or `selectedVendorId`.
   - Every post-await write is a functional updater keyed by the captured slot.
   - The failure arms touch no slot state.
   - `showDraftSaved` reads `filteredItems.length` from the press-time closure. That is the press-time snapshot, which is fine.
   - `submitting` stays one global flag, as designed.

### Nits
- `src/screens/cmd/sections/EODCountSection.tsx:293-296` — the comment says submission "covers the vendor's whole input maps". It is now the slot's maps. Reword to "the slot's".
- `src/screens/cmd/sections/EODCountSection.tsx:1165` — "per code-reviewer S1" now sits beside the 189 S1 discussion in the same comment block (`:1170-1176`). They are different reviews (spec 020's S1 versus spec 189's S1), so the label is ambiguous. Give the first a spec number.
- `src/screens/cmd/sections/EODCountSection.tsx:1170-1176` — the comment names `dropVendorBaselines`, a function that no longer exists, plus "P10". The rationale (why the baseline is dropped for the slot only) is good. The design-doc ids (P10, §7.3 and similar) belong in the spec, not in code that outlives it. Consider keeping the "why" and dropping the ids.
- `src/screens/cmd/sections/EODCountSection.tsx:1178-1181` — the success clear writes `{}` per map, leaving empty slot entries in the state forever. The design allows it, and it is harmless at this size. `delete` would keep the maps tidy, but this is a preference.
- `src/screens/cmd/sections/EODCountSection.tsx:726` — `onEditCurrentVendor`'s dependency list carries all three maps, so the callback is rebuilt on every keystroke. It was already like this at 189's commit, and the map names changed here but the shape didn't. Out-of-scope.
- `src/screens/cmd/sections/EODCountSection.tsx:2271` — `AddCountModal.onAdd` closes over the render's `dayKey`. That is right as long as the modal can't stay open across a date change. It can't today (it's a modal), so this is fine. It is noted only so nobody reuses the pattern for a non-modal.
- `src/lib/eodDraftSlot.ts:8` — the header says "its `eodBaselineKey`, moved here and renamed". Fine as history, but it is the only remaining mention of the old name.

### Project-convention checks
- No new `supabase` calls: `db.ts`, `useStore.ts` and `PhoneEodCount.tsx` are untouched. The submit path goes through `submitEOD` and `submitEODCount` as before.
- No inline color literals, `window.confirm` or `Alert.alert` added in the reviewed hunks.
- No web-only API added. The header uses `toLocaleDateString`, which is safe on native.
- New test files are on the jest track and follow the existing harness (`*.spec192.test.tsx`). `eodDraftSlot.test.ts` sits beside its module, matching `eodChangeSet`/`eodNoNeed`.
- `as any` in the new suite is limited to store and harness fixtures (`:57, 139, 187-198, 622-662`), the same as the 172/189 suites. No `any` or `as` suppression in production code.
- The state rename (design §3) is complete: no `*ByVendor` or `editingVendorIds` reader survives apart from the intentionally vendor-keyed `savedIdsByVendor`.
