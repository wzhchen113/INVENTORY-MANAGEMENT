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
