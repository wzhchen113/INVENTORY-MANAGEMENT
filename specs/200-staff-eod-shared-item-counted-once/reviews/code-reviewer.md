## Code review for spec 200

Scope: borrowSources.ts, borrowedEntries.ts, types.ts, EODCount.tsx, StaffEodCountRow.tsx, ListRow.tsx, staff i18n (spec 201's `reorder.item.yieldedFrom` ignored), the jest/pgTAP files, and the two documented deviations.

### Critical
- None.

### Should-fix
- None.

### Nits
- `src/screens/staff/screens/EODCount.tsx:577-580` — the first committed key on a borrowed row writes `[id]: ''` into the untouched case or unit map. `commitRow` (L595-596) deliberately writes a key only when its value changes, to keep today's "absent key" shape. Harmless, because `eodRowCounted` and the builder treat `''` as blank. Writing only the seated field and the non-blank seed fields would keep one shape.
- `src/screens/staff/screens/EODCount.tsx:773-776` — a failed post-submit refresh (`enterLockedAfterWrite`, L1087) replaces previously good server sources with `[]`. The locked view's label and the "X of N" count then drop until the next read. This matches AC-15's "behave as if no sources", but keeping the last good snapshot on a refresh failure would be friendlier. Optional.
- `src/screens/staff/screens/EODCount.tsx:488-490` — `isCounted` tests `borrowed.has(it.id)`, while the display uses `borrowedFor`. The two agree because own is checked first. A one-line comment saying so would help the next reader.
- `src/screens/staff/components/ListRow.tsx:119-127` — the `flexWrap` plus a 100%-basis `footer` is only verified in the web preview (AC-19). React Native Yoga handles `flex: 1` (basis 0) children in wrapped rows, but confirm once on a native build. The header comment of this file is still `src/components/ListRow.tsx` (stale, pre-existing, out-of-scope).
- (out-of-scope) `supabase/migrations/20261118120000_reorder_primary_wins_borrowed_count.sql:229` — the CTE name `latest_eod_per_vendor` is misleading. It selects every submitted row and is not deduplicated per vendor. Not part of this spec.

### Verified (no finding)
- **Borrow-source ordering matches `eod_borrow_source`.** The candidate set is `(store, date, 'submitted')`, any vendor including null vendor (`borrowedEntries.ts:184-189`). The client sort is epoch ms desc with null `submittedAt` as -Infinity (NULLS LAST), then sub-millisecond microsecond digits desc, then lowercase submission id desc. For server vs server this reduces to `submitted_at DESC NULLS LAST, id DESC` at microsecond precision. `parseTimestamp` pads or truncates the fraction to 6 digits and keeps the digits below the millisecond separately. A blank legacy entry is skipped by `isBorrowable`, as in the SQL's `actual_remaining is not null`. The staff-only widening to `no_need = true` is the documented rule. The queued-before-server tie at equal ms is the documented staff overlay, not a divergence from SQL.
- **Deviation 1 (ListRow `footer`).** It is additive and optional, and layout is unchanged when `footer` is absent (`rowWithFooter` applies only when the prop is set). The label is `numberOfLines={1}` with tail ellipsis, uses the `c.info` token and has no color literals. Accepted.
- **Deviation 2 (seed own maps after an all-borrowed submit).** It is gated on `allBorrowed`, so mixed submits keep typed inputs. It runs in both the confirmed and queued branches through the shared `seedFromExisting`. It matches a reload, so the locked view drops the label as design §4 says. Accepted.
- **Pure and shared helpers.** `entrySeed` is extracted verbatim and `seedFromExisting` now calls it. `borrowedEntryCopy` carries `no_need` only when true. `fetchBorrowSources` never coerces a null numeric to 0 and keeps the raw `submitted_at` string.
- **Request token and drain gap.** The token drops stale reads, and the drain-gap effect is scoped by (store, date, user).
- **Convention checks.**
  - Direct `supabase` use is inside the staff carve-out.
  - `notifyBackendError` is the staff one.
  - No `window` or `Alert` use, no color literals, no `as any`.
  - i18n tokens are identical across en, es and zh-CN.
  - The pgTAP file is hermetic (begin/rollback, no `set role anon`), and its plan(7) matches the 7 assertions.
  - Test files follow the jest and pgTAP tracks.

## Fix round 1

Delta reviewed: the AC-20 stock check before all-borrowed copies.

### Critical
- None.

### Should-fix
- None.

### Nits
- `src/screens/staff/screens/EODCount.tsx:1058-1061` — the read-failure path (fail closed) reuses the "Stock changed since this was counted" toast and the amber row line. A network or offline failure therefore tells staff stock changed when the check could not run. Failing closed is the right call. A distinct, honest toast for the catch path, such as "Couldn't verify stock — count these items", would avoid the misleading wording. It could reuse the same row line. Optional. (Addressed in round 2.)
- `src/screens/staff/screens/eod/StaffEodCountRow.tsx:146-154` — the recount line reuses `styles.borrowedLabel`. The style is shared, which is fine, but the name is now misleading. A rename to something like `footerLabel` is optional. (Addressed in round 2.)
- `src/screens/staff/screens/EODCount.tsx:1055-1063` — `setSubmitting(true)` and `false` wrap only the stock read, and the later `setSubmitting(true)` follows at the submit. This is correct, since `finally` runs before the early `return` or the continue. A one-line comment on why `submitting` is toggled here (double-tap guard during the read) would help. (Addressed in round 2.)

### Verified (no finding)
- **`sameQuantity` / `stockMismatchIds`.** Both are pure and fail closed on null, blank or non-finite input. Comparison at 6 decimals tolerates the string-vs-number numerics PostgREST returns. NO NEED copies are skipped, and an item missing from the stock map counts as a mismatch. The module split matches the `borrowSources.ts` pattern, and `fetchCurrentStock` throws so the screen owns the catch.
- **`fetchCurrentStock`.** It is a staff-carve-out direct read, scoped by `store_id` and `in('id', …)`. It returns early on an empty list, and the doc comment explains why it exists.
- **`recountIds` wiring.** The set is reset in the vendor/date/store load effect (L808). `borrowableFor` is the single seam feeding `borrowedFor` and `isCounted`, so the gate, "X of N", NEXT/SKIP and the display all treat a flagged item as uncounted consistently. The recount label shows only while the row isn't own-counted, and the jump target and toast follow the same pattern as the count-all gate (clear search, custom-order target).
- **The unrequested amber row line: accepted.** The reason is sound: the toast can sit under the keypad sheet, so the row needs a persistent cue. It uses the `c.warning` theme token (no literal), sits in the existing `footer` slot, is mutually exclusive with the borrowed label, and is i18n'd in all three locales. It is small and consistent with the label it sits beside.
- **Mixed submits.** The check runs only on the all-borrowed path. Once any flagged item is counted by the staffer, the payload is a normal own-only submit and no further read happens.
- **Convention checks.** `notifyBackendError` is the staff one, there are no color literals or `as any`, i18n keys exist in en, es and zh-CN, and tests follow the jest track.

## Fix round 2

Delta reviewed: the `allowQueue: false` submit option (AC-21), the recount reason map, the `footerLabel` rename and the new wording.

### Critical
- None.

### Should-fix
- None.

### Nits
- `src/screens/staff/screens/EODCount.tsx:1145-1147` — the `allBorrowed ? submit(payload, { allowQueue: false }) : submit(payload)` ternary duplicates the call. It is presumably there so existing tests that assert `toHaveBeenCalledWith(payload)` keep passing. `submit(payload, allBorrowed ? { allowQueue: false } : undefined)` would be one call, but would change the recorded arguments, so leave it if the tests pin the single-argument shape.
- `src/screens/staff/hooks/useEodSubmit.ts:327,354` — both `allowQueue === false` early returns repeat the same `failed` literal. A tiny local constant would tidy it. Optional.

### Verified (no finding)
- **`useEodSubmit`.** The option is optional and defaults to the old behaviour (`options?.allowQueue !== false`), so every other caller queues exactly as before. The drain is unchanged, and items already in the queue are untouched. Both enqueue sites (offline snapshot and network-error catch) are guarded, and the outcome is `failed` with an i18n'd `eod.toast.notSentOffline` message that the screen already surfaces. Forbidden and other-error paths are unchanged. `SubmitOptions` is a small, documented type in `types.ts`.
- **Reason map.** `recountIds` is now a `Map<id, 'changed' | 'unchecked'>`, reset on the same load effect. The label and the toast pick `stockUnchecked*` vs `stockChanged*` from the reason. A later flag simply overwrites an earlier one for the same id, which is correct. The catch path now says "Couldn't check stock", so round 1's misleading-wording nit is resolved.
- **Double-tap guard comment** (L1065-1068) is accurate: `finally` resets before the early return, and `submitting` is set again before the submit.
- **`footerLabel` rename** is applied to both the borrowed and recount lines, with no leftover `borrowedLabel` style. The label prop's documentation is consistent.
- **i18n.** `stockUnchecked`, `stockUncheckedTitle`, `stockUncheckedRemaining` and `notSentOffline` exist in en, es and zh-CN with matching `{count}` tokens.
- **Convention checks.** No color literals, no `as any`, and the staff `notifyBackendError` is still used.
