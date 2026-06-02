## Code review for spec 087

### Critical

None.

---

### Should-fix

- `src/components/cmd/ReorderDatePicker.tsx:73-74` — `viewYear`/`viewMonth` are initialized from `selected` at mount, but `selected` is computed on every render without memoization. A stale `Date` object is used on the very first mount render only (since `useState` ignores later initial values), which is correct. However, `selected` is re-derived on every render (`const selected = value ? new Date(...) : new Date()`) even though it's only actually read by `openModal`. Extract it inside `openModal` — or `useMemo`-ize it — to avoid the silent "computed but not used in render" confusion and to match the local-midnight parse guarantee explicitly at the one call site that uses it. This is low-impact but the mismatch between "used once on mount" intent and "computed every render" code is a readability trap for future maintainers.

- `src/components/cmd/ReorderDatePicker.tsx:289` — `boxShadow` is applied unconditionally inside `StyleSheet.create` via `...({ boxShadow: '...' } as object)`, without a `Platform.OS === 'web'` guard. The majority of Cmd-family modals in this directory do guard it: `NewReportModal.tsx:364`, `AddCountModal.tsx:87`, `RecipeFormDrawer.tsx:341`, `ResponsiveSheet.tsx:139`, etc. all use `...(Platform.OS === 'web' ? ({ boxShadow: ... } as any) : {})`. The shared `DatePicker.tsx` uses the same unguarded pattern (establishing the precedent the developer followed), but the Cmd component family's convention is the guarded form. On native this produces a harmless runtime warning (RN ignores unknown style props) rather than a crash, so this is Should-fix rather than Critical — but it diverges from the established `cmd/` pattern and should be made consistent.

- `src/screens/cmd/sections/ReorderSection.tsx:595-600` — The store-switch reset effect uses a `prevStoreIdRef` to skip the initial mount. This is correct intent. However, the fetch effect (line 607-610) runs on `[currentStore.id, selectedDate, loadReorderSuggestions]`. When the store changes, both effects fire in the same commit: the reset effect enqueues `setSelectedDate(today)` and the fetch effect immediately fires with the OLD `selectedDate` + the NEW `currentStore.id`. This produces a transient fetch with the previous store's selected date applied to the new store — a stale-as-of fetch on every store switch. The architect acknowledged "a single redundant fetch is harmless; a stale as-of fetch is not." The safest fix is to merge both into a single `[currentStore.id]` effect that first sets `selectedDate` state via a ref, uses that ref value for the initial fetch, and then a second effect on `[selectedDate]` re-fetches only when the date changes. Alternatively, use a `useEffect` on `[currentStore.id]` that resets state AND calls `loadReorderSuggestions(toISODate(new Date()))` directly, bypassing the state update cycle. As-written, the stale fetch resolves correctly because the `[selectedDate]` sub-firing immediately overwrites it with today's result, so there is no durable data error — but the extra round-trip and the "wrong date on new store" flash during the first fetch are a quality concern.

---

### Nits

- `src/components/cmd/ReorderDatePicker.tsx:118-124` — `openModal` has `if (selected) { ... }` but `selected` is `value ? new Date(...) : new Date()`, which is always a truthy `Date` object. The `if` guard is dead code. Remove it or replace with a comment explaining the sync-on-open intent.

- `src/components/cmd/ReorderDatePicker.tsx:37` — `DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']` — the spec explicitly called out "short labels are more legible than the S/M/T/W/T/F/S ambiguity" and noted that `enum.dayOfWeek.short` could be used instead. The developer chose the single-letter form. This is within-spec but the ambiguity (T = Tuesday or Thursday, S = Saturday or Sunday) makes the UI less clear than the short labels ("Mon", "Tue", etc.) already in the i18n catalog. Worth changing if the UX pass recommends it; not blocking.

- `src/utils/reorderDayFilter.ts:84` — `Number.isNaN(idx)` is correct (`Date.getDay()` returns `NaN` for an invalid `Date`), but `Number.isNaN(d.getDay())` could be expressed more readably as checking whether `d` is an invalid Date first: `if (isNaN(d.getTime())) return null`. Both are equivalent; the current form is non-idiomatic for a Date-validity guard and may surprise readers who are unfamiliar with `getDay()` returning `NaN`.

- `src/screens/cmd/sections/ReorderSection.tsx:385-387` — `todayLocalIso()` uses `new Date().toISOString().slice(0, 10)` which is UTC-based and thus misnamed ("local" is incorrect). This is pre-existing code not changed by spec 087, but since spec 087 imports and uses `toISODate` (the correct local-time variant) directly above, the dead fallback function is now more obviously misnamed. (Out-of-scope cleanup — flag only.)

- `src/screens/cmd/sections/__tests__/ReorderSection.test.tsx:127` — The re-fetch wiring test asserts `mockState.loadReorderSuggestions` was called exactly once (`toHaveBeenCalledTimes(1)`) after the date change. Because React effects run asynchronously relative to `fireEvent` in RNTL and the mock does not trigger a re-render or state flush, this relies on the effect running synchronously within the same `act()` that wraps the press. This works in practice with `@testing-library/react-native` v12+, but is fragile if the testing-library version changes. Wrapping the assertions in `await act(async () => {})` after the final press would make the flush explicit. Not a current failure but a maintenance nit.

- `src/components/cmd/ReorderDatePicker.test.tsx:11` — The `jest.mock` call for `'../../theme/colors'` is placed before the imports, which is required by jest's hoisting mechanism. The comment at line 6-7 notes "useT is NOT imported by this component" — accurate and useful. Consider a brief note that `mono` / `typography.ts` is not mocked because it returns plain string constants (no native modules), which is less obvious to a future contributor adding to this component.

---

### Summary

This is a well-crafted FRONTEND-ONLY change. The two correctness traps the architect flagged are both handled correctly: `weekdayName` uses the fixed index array (not `toLocaleString`) and parses at local midnight (appending `T00:00:00`), and the tests explicitly pin both. The filter/partition/KPI recompute logic in `reorderDayFilter.ts` is clean and pure. The component respects `useCmdColors()` throughout, makes no direct Supabase calls, touches no legacy files, adds no realtime channels, and the three test files land in the correct jest environments. The i18n keys are present and parity-checked across all three locales. The Should-fix items are the unguarded `boxShadow` (diverges from the `cmd/` family convention) and the double-fetch-on-store-switch (stale-as-of transient fetch, benign but not invisible).

---

## Resolution (post-review fix-pass — main Claude)

All 3 Should-fixes folded in; the 6 Nits deferred (cosmetic).

- **S1 (`ReorderDatePicker` `selected` computed-every-render + dead `if` guard)** — **fixed.** Replaced the per-render `const selected` with a `parseLocalDate(v)` helper used by lazy `useState(() => …)` initializers (parse runs once on mount) and by `openModal` (which now re-derives fresh from the current `value`, dropping the always-truthy dead `if`). Removes the readability trap; preserves the local-midnight parse.
- **S2 (`ReorderDatePicker:289` unguarded `boxShadow`)** — **fixed.** Now `...(Platform.OS === 'web' ? ({ boxShadow: … } as object) : {})`, matching the `cmd/` family convention (`NewReportModal`/`AddCountModal`/etc.). Added `Platform` to the `react-native` import.
- **S3 (`ReorderSection` store-switch double-fetch / stale-as-of flash)** — **fixed.** Merged the two effects into one store-switch-aware effect: on a store switch it resets the calendar to today AND fetches as-of **today directly** (not the `selectedDate` carried from the prior store), eliminating the transient stale-as-of fetch; mount and same-store date changes fetch as-of `selectedDate` as before.
- **Nits (6)** — deferred (cosmetic): single-letter `DAY_LABELS`, the `Number.isNaN(getDay())` idiom, the pre-existing misnamed `todayLocalIso`, the `toHaveBeenCalledTimes` flush note, and two test-comment notes. None affect correctness.

Re-verified post-fix-pass: full `npx jest` 50 suites / 493 tests green; base + test-graph typechecks exit 0. **Plus a live browser golden-path pass** (preview on the local stack, signed in as admin): the calendar button renders top-right, opens the modal (June 2026 grid, today ringed, prev/next nav, single TODAY footer), the default "vendors I order today" filter shows the correct Monday empty-state, the "NO ORDER SCHEDULE" secondary group renders, and KPIs reflect the filtered set — closing the in-browser verification the frontend-developer's tool set couldn't perform.
