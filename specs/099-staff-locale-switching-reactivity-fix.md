# Spec 099: Staff locale switching reactivity fix

Status: READY_FOR_REVIEW

## Bug

Staff-app language switching (shipped in commit 1496558 "Staff app: language
switching (EN / ES / zh-CN)") was broken: switching the locale updated some UI
but not the rest ("some parts change, some don't").

## Root cause

`src/screens/staff/i18n/index.ts` exposed a bare `t(key)` that resolves the
active locale via a module-level snapshot getter (`_getActiveLocale`), and
`useI18n()` returned that same bare `t` WITHOUT subscribing to the store's
`locale`. Every staff component imported the bare `t` and called it in render;
none subscribed to `useStaffStore(s => s.locale)`. So when `LocaleSwitcher` set
the locale, only components that happened to re-render for some other reason
picked up the new strings. The bare `t` is a snapshot — it is not reactive.

## The fix

1. `useI18n()` is now REACTIVE. It subscribes to the store's `locale` via a
   store-registered hook (`_setActiveLocaleHook`, mirroring the existing
   `_setActiveLocaleGetter` bootstrap to avoid the i18n→store circular import),
   and returns a `t` bound to the subscribed locale. The returned `{ t }` is
   memoized on `locale` (`useMemo`) so `t` has a STABLE identity until the
   locale actually changes — this keeps it safe to place in
   `useCallback`/`useMemo`/effect dependency arrays without spinning a render
   loop.
2. The bare `t(key, vars)` snapshot export is KEPT for imperative call sites
   (event handlers, `Toast.show` in `onSubmit`, the `useEodSubmit` hook) where
   the live locale at call time is what's wanted.
3. Every render-path bare-`t` usage was swept to `const { t } = useI18n();`:
   - `StaffStack.tsx` (`StaffTabs`) so React Navigation recomputes tab labels.
   - `EODCount.tsx`, `WeeklyCount.tsx`, `StorePicker.tsx`, `Reorder.tsx`
     (including `VendorCard`, and the `weekdayLabel` / `todayHeaderLabel`
     module helpers refactored to take a `t` argument so the reactive `t` flows
     through). Imperative handlers that close over `t` now list `t` in their
     dependency arrays so the closure refreshes on a locale change.
   - `LocaleSwitcher.tsx`, `QueueIndicator.tsx`, `WeeklyDueBanner.tsx`.
4. `LocaleSwitcher` already read `useStaffStore(s => s.locale)` for its active
   highlight (verified reactive).
5. `ErrorBoundary.tsx` intentionally stays on the bare snapshot `t` (its
   `ErrorFallback` only renders after a render crash; live-switching the crash
   screen is out of scope) — documented with an inline comment.

`Input.tsx` and `ReorderDatePicker.tsx` were listed as candidates but render NO
translated text (hardcoded English / no i18n import) — left unchanged.

## Tests

- `src/screens/staff/i18n/i18n.test.ts` — existing catalog parity / translate /
  bare-`t` tests kept; a note points at the new render test for the reactive
  hook.
- `src/screens/staff/i18n/useI18n.reactivity.test.tsx` (NEW, component/jsdom
  project) — renders a `useI18n()` consumer, flips `useStaffStore.setLocale` to
  `es` then `zh-CN`, and asserts the rendered string updates (Submit → Enviar →
  提交) in place without a remount.

## Verification

- `npx tsc --noEmit` — clean.
- `npx jest` — 678 passed / 66 suites. Staff suites + i18n all green.
- Browser preview tools were unavailable in this environment; verification was
  done via tsc + jest + the new reactivity render test, per task instruction.

## Files changed

- src/screens/staff/i18n/index.ts
- src/screens/staff/store/useStaffStore.ts
- src/screens/staff/navigation/StaffStack.tsx
- src/screens/staff/components/LocaleSwitcher.tsx
- src/screens/staff/components/QueueIndicator.tsx
- src/screens/staff/components/WeeklyDueBanner.tsx
- src/screens/staff/components/ErrorBoundary.tsx
- src/screens/staff/screens/EODCount.tsx
- src/screens/staff/screens/WeeklyCount.tsx
- src/screens/staff/screens/StorePicker.tsx
- src/screens/staff/screens/Reorder.tsx
- src/screens/staff/i18n/i18n.test.ts
- src/screens/staff/i18n/useI18n.reactivity.test.tsx (new)

## Follow-up (post-099): switcher coverage + localized reorder warning

Status: READY_FOR_REVIEW

Two small frontend-only follow-ups to the staff language feature, layered on
top of the 099 reactivity fix:

1. **LocaleSwitcher on Weekly + Reorder headers.** The switcher previously
   appeared only on the EOD (Count) screen and StorePicker. Added it to
   `WeeklyCount.tsx` and `Reorder.tsx`, mirroring `EODCount.tsx`'s
   `headerSwitcherRow` placement so all three count/reorder screens are
   consistent. (EODCount's header has no inter-row `gap` and uses
   `marginTop: spacing.sm`; Reorder's header already has `gap: spacing.md`, so
   its switcher row omits the marginTop; WeeklyCount's header has a tight
   `gap: 2`, so its switcher row keeps the `marginTop: spacing.sm`.)

2. **Localized `schedule_unknown` reorder warning.** The "no order schedule —
   using 7-day buffer" warning is built server-side in English by
   `report_reorder_list`. It now re-localizes on the frontend:
   - `fetchReorder.ts` parses the vendor name out of the stable SQL message
     (text inside the first double-quote pair) when `code ===
     'schedule_unknown'` and exposes it as an optional `vendor` field on the
     warning. The parse is commented as keyed to the SQL message format in
     `supabase/migrations/20260602000000_reorder_suggested_cases.sql`.
   - `Reorder.tsx` renders `schedule_unknown` warnings via
     `t('reorder.warning.scheduleUnknown', { vendor })`, falling back to the
     raw message/code for any other warning code. Multi-warning join preserved.
   - New key `reorder.warning.scheduleUnknown` (with `{vendor}` placeholder)
     added to all three catalogs (en/es/zh-CN); i18n parity + placeholder-parity
     tests pass.
   - The optional `vendor?: string` field was added to the SHARED
     `ReorderPayload.warnings` type in `src/types/index.ts` (backward-compatible;
     the admin `db.ts` mapper does not set it).

Verified via `npx tsc --noEmit` (clean) and `npx jest` (full suite: 682 passed,
66 suites). Browser preview of the staff surface was not available in this
environment (role-routed staff shell needs a signed-in staff session against
the local Supabase stack), so verification was tsc + jest per the task.

### Files changed (follow-up)
- src/types/index.ts
- src/screens/staff/lib/fetchReorder.ts
- src/screens/staff/lib/fetchReorder.test.ts
- src/screens/staff/screens/Reorder.tsx
- src/screens/staff/screens/Reorder.test.tsx
- src/screens/staff/screens/WeeklyCount.tsx
- src/screens/staff/i18n/en.json
- src/screens/staff/i18n/es.json
- src/screens/staff/i18n/zh-CN.json
