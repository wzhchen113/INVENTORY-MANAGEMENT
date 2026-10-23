## Code review for spec 172

Scope: the staged 172 changes only (spec 171 is already on main). I read the helper, the migration hunks, `db.ts`, `useStore.submitEOD`, every `actualRemaining` consumer, the admin desktop/phone/staff UI, the reorder/export/lastOrderContext display edits, the queue validator, and `entriesForRpc`.

Result: 0 Critical, 4 Should-fix, 8 Nits. No project-policy violations found. No direct Supabase calls outside the documented carve-outs, no inline color literals, no web-only API leaks, no legacy-file edits, no `app.json` change, and test files follow the established jest/pgTAP/shell tracks.

### Focus items from the request

- **PhoneWeeklyCount is unaffected.**
  - `PhoneWeeklyCount.tsx:336` passes neither `noNeed` nor `onNoNeed`.
  - `PhoneKeypadSheet.tsx:250` renders the button only when `onNoNeed` is set.
  - `PhoneKeypadSheet.tsx:243-247` falls through to the original `runningTotal` string when `noNeed` is falsy.
  - The only visible delta on the weekly screen is a new `testID="eod-sheet-total"` on the total `Text`. It is inert.
  - The jest arm at `EODCountSection.noNeed.spec172.test.tsx:478` covers the sheet without `onNoNeed`.
- **Every consumer of `EODEntry.actualRemaining` handles NO NEED.** I grepped all non-test `actualRemaining` / `actual_remaining` / `.entries` reads in `src/`.
  - Stripped via `numericEodSubmissions`:
    - `cmdSelectors.ts:32, 364, 473, 521, 622, 1036`
    - `usageCalculations.ts:186` (opening-stock lookup included)
  - Guarded with `isNumericEodEntry`:
    - `ReconciliationSection.tsx:287, 378`
    - `useStore.ts:3007`
  - Already null-safe: `EODCountSection.tsx:2220` (VarianceLog sum) and `unitsDisplayFor` (`:162`).
  - Correctly left alone, since they intentionally count NO NEED as counted: `DashboardSection.tsx:457`, `eodStatus.ts:43`, and the `itemCount` / `entries.length` displays.
  - I found no consumer that reads a NO NEED entry as 0.
- **Admin vs staff duplication.** See Should-fix 1 and 2. The pure rules are correctly shared through `src/lib/eodNoNeed.ts`. The duplication is in the state write-back and the sheet advance glue.

### Critical
- None.

### Should-fix

1. `src/screens/cmd/sections/EODCountSection.tsx:277-314` and `src/screens/staff/screens/EODCount.tsx:452-457, 469-487` — the same row write-back is hand-copied on both surfaces.
   - Duplicated pieces: `rowStateOf`, `commitRow` ("write a map key only when its value changes"), and a clear-only variant (`clearNoNeed` / the inline `setNoNeed` delete in `onKey`).
   - The "only write on change" rule is a subtle contract. It keeps untouched boxes absent, so pre-172 `toEqual` fixtures hold. Two copies can drift.
   - The clear-only variant is a third and fourth copy of the "delete key" branch inside `commitRow`.
   - Fix: add one pure `patchRecord(map, id, value)` or `applyEodRowState` to `src/lib/eodNoNeed.ts`, re-exported by the staff barrel. Call it from both `commitRow`s. Express the clear-only path as `eodTypeInto` or `commitRow` rather than a separate delete.

2. `src/screens/cmd/sections/eod/PhoneEodCount.tsx:195-209` and `src/screens/staff/screens/EODCount.tsx:520-532` — "mark NO NEED then advance" is duplicated.
   - It carries a load-bearing trick: the just-marked id must be in the predicate (`i.id === id || …`), or the wraparound re-seats the same item. The comment explaining it is also copied twice.
   - The admin copy also repeats the `allCounted` toast from `onNext` (`PhoneEodCount.tsx:183` vs `:204`).
   - Fix: add `advanceUncountedAfterMark(ordered, markedId, isCounted)` next to `advanceUncounted` in `lib/eodKeypad.ts`. That module is already shared through the staff barrel. Lift the toast into a small `finishIfDone` local in `PhoneEodCount`.

3. `src/lib/db.ts:1078` and `src/store/useStore.ts:3064` — inconsistent NO NEED predicates across what the spec calls the "three on-hand writers".
   - `useStore.ts:3007` gates the on-hand mirror on `isNumericEodEntry(entry)`.
   - `db.ts:1078` gates on `entry.noNeed`, and `useStore.ts:3064` (audit value) on `entry.noNeed`.
   - Because `actualRemaining` is now `number | null`, a non-NO-NEED entry with a null total would pass the db.ts guard and write `current_stock = NULL`. The audit line would read `"null <unit>"`. No current client builds that shape, but the type allows it, and the whole point of the guards is to make the type the safety net.
   - Fix: use `if (!isNumericEodEntry(entry)) continue;` in the `db.ts` loop. Compute the audit value from the same `numeric` flag in `useStore.ts`. This also narrows `entry.actualRemaining` to `number` at the two write sites, with no cast.

4. `src/screens/cmd/sections/ReconciliationSection.tsx:157` — the identical `latest?.entries?.filter(isNumericEodEntry).length ?? 0` expression is computed twice in one template string (`N / N`).
   - Fix: hoist `const reconciled = latest?.entries?.filter(isNumericEodEntry).length ?? 0;` and render `` `${reconciled} / ${reconciled}` ``.

### Nits

- `src/lib/eodNoNeed.ts:128` — `return s as NumericEODSubmission` is an assertion. It covers the "submission with `entries` undefined" fixture case, which `NumericEODSubmission` does not allow. It is justified by the comment, but the type lies for that one input. Consider `{ ...s, entries: [] }` for a missing array, which is also identity-unstable and so not worth it. At minimum keep the comment.
- `src/screens/cmd/sections/EODCountSection.tsx:629-640` — `onEditCurrentVendor` decides "user-typed wins" from the render-time `caseCountsByVendor` / `unitCountsByVendor` closure, while the sibling `setCaseCountsByVendor` / `setUnitCountsByVendor` updaters use the functional `p`.
  - It also adds both maps to the `useCallback` deps, so the callback changes identity on every keystroke. Previously it was stable.
  - Harmless today, since nothing memoizes on it. The mixed snapshot sources are easy to trip over later.
- `src/screens/cmd/sections/eod/PhoneEodCount.tsx:509` vs `:578` — the sheet button is gated on `model.setNoNeed` and the row control on `model.toggleNoNeed`. They are separate optional fields for one feature. Gate both on one flag, or document why they differ.
- `src/screens/cmd/sections/ReorderSection.tsx:242` — the chip label is hardcoded English `'NO NEED'`, while `BreakdownLine` (`:170`) on the same row uses the localized `section.reorder.noNeed`. An es / zh-CN user sees mixed languages on one row. AC-36 and the existing chip convention mandate the English chip, so this is not a violation. Worth a follow-up to localize the chip with the existing key.
- `src/screens/staff/screens/Reorder.tsx:117` and `:267` — the `(item.flags || []).includes(REORDER_FLAG_NO_NEED)` check is written twice in one file. The admin twin (`ReorderSection.tsx:162`) uses unguarded `item.flags.includes`, though `ReorderItem.flags` is non-optional `string[]` (`types/index.ts:1031`). Extract one local `isNoNeedRow(item)` and drop the redundant `|| []`. Same for `lastOrderContext.ts:141`.
- Test file naming is inconsistent. The repo precedent is `<subject>.<topic>.spec<NNN>.test.*`.
  - Frontend files follow it, e.g. `EODCountSection.noNeed.spec172.test.tsx`.
  - Backend-half files omit the spec tag: `db.eodNoNeed.test.ts`, `cmdSelectors.eodNoNeed.test.ts`, `usageCalculations.eodNoNeed.test.ts`, `eodNoNeed.test.ts` (shared and staff barrel).
  - `ReconciliationSection.eodNoNeed.spec172.test.tsx` uses a third shape.
  - They all sit on the jest track, so this is not a policy finding. It only makes `spec172` greppable inconsistently.
- `src/screens/cmd/sections/eod/PhoneKeypadSheet.tsx:243` — the new `testID="eod-sheet-total"` lives on a sheet shared with `PhoneWeeklyCount`. It is harmless, but it means the weekly screen now exposes an `eod-*` id. Fine to keep, since it matches the staff sheet.
- `specs/172-eod-no-need.md:842-847` — the stale `## Handoff` block still says `next_agent: backend-developer, frontend-developer`. (out-of-scope: spec bookkeeping)

### Verified clean (no action)

- `staff_submit_eod` hunks S1-S5 and `report_reorder_list` hunks R1-R4 in the migration are minimal and commented.
  - `no_need` is sent on every row in `submitEODCount` (`db.ts:1015-1023`), and the numerics are forced to null for NO NEED.
  - The migration is idempotent, uses `lock_timeout`, and emits no grants or policies.
- `isValidEodEntry` (`eodQueue.ts:57-74`) accepts exactly the two intended shapes, and rejects `no_need: true` with any number.
- `entriesForRpc` forwards `no_need` only when true, so numeric payloads are byte-identical.
- All new i18n keys are present in all six catalogs.
- Active styles use `C.ok` / `C.okBg` and `success` / `successBg` tokens. There are no color literals.
- No `any` casts, no `Alert.alert` / `window.confirm`, and no web-only APIs were added.
