# Security audit for spec 087 — Reorder calendar (go-back-in-time)

Reviewer: security-auditor
Date: 2026-06-01
Verdict: **PASS** (clean — no Critical, no High, no Medium; one Low + informational notes)

## Scope reviewed

Frontend-only change. Confirmed against `git diff HEAD` + untracked files:

- Modified: `src/screens/cmd/sections/ReorderSection.tsx`, `src/i18n/{en,es,zh-CN}.json`
- New (untracked): `src/utils/reorderDayFilter.ts`, `src/components/cmd/ReorderDatePicker.tsx`, plus three test files (`reorderDayFilter.test.ts`, `ReorderDatePicker.test.tsx`, `__tests__/ReorderSection.test.tsx`)
- **No** migration, RPC change, RLS change, edge function, `db.ts` change, or `package.json`/lockfile change (verified — `git diff HEAD --name-only | grep -i package` → NONE).

The architect's "FRONTEND-ONLY" verdict is accurate. My audit confirms it introduces no new data-exposure, injection, secret, or authorization surface.

---

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

- `src/components/cmd/ReorderDatePicker.tsx:51-55,198` — `formatDisplay` and the cell `dateStr` builder do **no validation** that `value`/`maxDate` are well-formed `YYYY-MM-DD`. This is not a security issue (these props are produced internally by `toISODate(new Date())` and the component's own `pad2` builder — never from network or user free-text; the date never reaches SQL as anything but a `::date`-cast bind parameter), but a malformed prop would render a cosmetically broken label rather than fail loudly. Informational only — no action required for ship. The pure-util counterpart `weekdayName` (`reorderDayFilter.ts:78-86`) already guards malformed input and returns `null`, which `ReorderSection` handles.

---

## Verification of the four focus areas

### 1. No new data exposure via the date param — CONFIRMED SAFE

The `as_of_date` flows only into the **existing** `report_reorder_list(p_store_id, p_params)` RPC, which is unchanged by this spec.

- **Store scoping is enforced server-side, before any read.** `supabase/migrations/20260514130000_report_reorder_list.sql:106` declares the function `security invoker`, and lines `119-122` make the auth gate the **first statement**: `if not public.auth_can_see_store(p_store_id) then raise exception ... errcode = '42501'`. The date is resolved *after* the gate (lines 128-133), so no value of `as_of_date` — past, far-past, or malformed — can bypass authorization.
- **The date cannot pivot to another store or brand.** `p_store_id` comes from `currentStore.id` (the already-authorized focal store); the calendar only changes `as_of_date`, never `p_store_id`. The no-focal-store guard (`ReorderSection.tsx:632-645`, the `currentStore.id === '' / '__all__'` early-return) blocks the all-brands case from ever calling the RPC with an empty/placeholder id. Confirmed the guard sits **after all hooks** (stable hook count) and renders `section.reorder.selectStore` instead of fetching.
- **Historical EOD counts surfaced for past dates are within existing access scope.** The RPC's on-hand resolution reads `eod_submissions`/`eod_entries`/`inventory_items` under `security invoker`, so each row is RLS-filtered by the same `auth_can_see_store()` boundary as the live view. Going back in time surfaces the caller's *own* store's history — not a new leak. No cross-store or cross-brand row is reachable by changing only the date.

### 2. Input safety / injection — CONFIRMED SAFE

- The date is passed as a **bound parameter** to a parameterized PostgREST RPC: `supabase.rpc('report_reorder_list', { p_store_id: storeId, p_params: params })` where `params.as_of_date = asOfDate` (`src/lib/db.ts:2710-2717`). No string concatenation into SQL anywhere on the FE path.
- Server-side, the date is consumed as `nullif(p_params->>'as_of_date','')::date` (RPC line ~129). A malformed/edge date produces a Postgres cast error surfaced by PostgREST as a clean error (caught into `reorderError` and rendered in the in-section error pane via `loadReorderSuggestions`' try/catch at `useStore.ts:2364-2378`) — it cannot break authorization (the auth gate already ran) and cannot disclose data.
- **No dynamic SQL on the date path.** I grepped the RPC for `EXECUTE`/`format(`/`||`: the only `||` matches are recursion-path array appends (lines 147/189) and jsonb/warning strings built from already-trusted **column** values (lines 462-469, 587-588) — none interpolate `p_params`. There is no `EXECUTE format(...)` SQLi vector.

### 3. No secrets / no new auth surface / client filter is not a security boundary — CONFIRMED

- Grepped both new files for `process.env` / `Deno.env` / `SUPABASE_SERVICE` / `service_role` / `apikey` / `secret` → zero matches. No secret material is present or reachable.
- The client-side order-out-day filter (`partitionReorderVendors` in `reorderDayFilter.ts:140-163`) is a **UI convenience over rows the RPC already returned and RLS already admitted** — it narrows the display set, it never widens it. It is correctly NOT relied upon for access control; the real boundary is `auth_can_see_store()` inside the RPC. Even if the filter were bypassed or buggy, the worst case is showing more of the *caller's own already-authorized* vendors — no cross-tenant exposure. This matches the threat model's "client filter is a UI convenience, not a security boundary" expectation.
- No new auth surface: no new RPC, no new edge function, no `verify_jwt` decision, no new grant. The RPC grant model (`revoke from public, anon; grant to authenticated`, lines 606-609) is untouched.
- No new code uses the placeholder client-side `useRole()` as a security boundary (the section gates on `currentStore.id`, not on a client role value).

### 4. XSS / log hygiene / dependencies — CONFIRMED

- No `dangerouslySetInnerHTML` / `innerHTML` / `eval` / `new Function` / `__html` in either new file (grep → no matches). The component renders only React Native `<Text>`/`<View>` primitives; i18n values flow through `T(...)` into `<Text>` children (RN escapes by default — not an HTML sink). The `{day}` interpolation in `noVendorsForDay` is a canonical English weekday label from `dayOfWeekLongLabel`, not user free-text.
- No new `console.*` or `notifyBackendError` calls added in the diff (grep of added lines → NONE_ADDED), so no tokens/PII/date-derived data leak to logs.
- All Cmd color tokens the component references (`accent`, `accentFg`, `info`, `borderStrong`, `border`, `panel`, `bg`, `fg`/`fg2`/`fg3`) exist in `src/theme/colors.ts` (cmd palette, lines ~184-199) — no broken-render path.

---

## Dependencies

No `package.json` or lockfile change in this spec — `npm audit` skipped (no new dependency surface to assess).

---

## Summary

Spec 087 is a clean PASS from a security standpoint. It is genuinely frontend-only: it wires a calendar's selected date through the **already-existing, already-RLS-scoped, already-date-parameterized** `report_reorder_list` RPC (which this spec does not modify) and adds a pure client-side display filter plus a Cmd-native calendar component. The `as_of_date` is a bound `::date` parameter that is resolved only *after* the RPC's first-statement `auth_can_see_store()` gate, so no date value (including malformed or far-past) can bypass authorization or read another store's or brand's data; going back in time surfaces only the caller's own RLS-admitted history. The client-side order-out-day filter narrows but never widens the returned set and is correctly not used as an access-control boundary. There are no secrets, no XSS sinks (RN `<Text>` only, no `dangerouslySetInnerHTML`), no new logging of sensitive data, no new auth surface, and no dependency changes. The single Low note (no defensive validation of the internally-produced date props in `ReorderDatePicker`) is cosmetic, not a vulnerability, and requires no action to ship. No findings block this spec.
