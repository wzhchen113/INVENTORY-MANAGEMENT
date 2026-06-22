# Code review for spec 098

## Critical

No Critical findings.

---

## Should-fix

### `supabase/functions/weekly-reminder-cron/index.ts:277` — Cron window boundary is not half-open; leaves a sub-millisecond gap at end of due day

The comment on line 272 says the check uses a "half-open [windowStart, windowEnd+1) range", but the implementation uses `.lt('counted_at', `${windowEnd}T23:59:59.999`)`. Any count timestamped between `23:59:59.999` and `23:59:59.9999...` on the due day is missed. The correct half-open bound is `${windowEnd}T00:00:00` shifted by one day (i.e. `${windowEndPlusOne}T00:00:00`), matching what the spec design §3 specifies: `counted_at < (window_end + 1)::timestamptz`. The SQL RPC correctly uses `BETWEEN window_start AND window_end` on the result of `(c.counted_at at time zone tz.zone)::date`, which naturally covers the full calendar day. Fix: use `${windowEndPlusOne}T00:00:00` where `windowEndPlusOne` is derived from `end + 86_400_000 ms`, or set the upper bound to the start of the next day.

### `src/lib/db.ts:981-1017` — Body of `fetchRecentInventoryCounts` is not indented inside the `track` callback

Lines 982-1016 (`let query = supabase...` through `return (data || []).map(...)`) are at the same indentation level as the enclosing function, not indented inside the `track` async callback. This makes the closure boundary visually ambiguous: a reader scanning the function cannot quickly identify where the callback body starts and ends. Every other `track` call in this file (e.g. `fetchStores` at line 46, `fetchWeeklyCountStatus` at line 1035) indents the callback body consistently. This was introduced by spec 098's edit to add the `kind` parameter to an existing function.

### `src/screens/staff/screens/WeeklyCount.tsx:66-67` — Redundant `.order('id', { ascending: true })` immediately overridden by JS sort

`fetchAllItemsForStore` issues `.order('id', { ascending: true })` to Postgres (line 67), but then unconditionally re-sorts the results by `a.name.localeCompare(b.name)` in JS (line 90). The SQL ordering is dead work on the DB side — the JS sort overwrites it completely. Remove the `.order()` clause or, better, order by the catalog name on the DB side and drop the JS sort. Minor, but adding an ORDER BY that the next line silently discards is confusing to anyone reading the data-fetch code.

### `src/screens/staff/screens/WeeklyCount.tsx:217` — `useStaffStore.getState()` called inside an async submit handler; should use the snapshot captured before the await

At line 217 (`const ws = useStaffStore.getState().weeklyStatus`), the code accesses the store AFTER the `await submitWeeklyCount(...)` call resolves. `submitWeeklyCount` already mutates `weeklyStatus` to `'completed'` on the optimistic path; this `getState()` call therefore reads the post-mutation value, which is what `completedFor` needs. However, if the optimistic update had a different shape in a future change, reading state after an async boundary can be surprising. The cleaner pattern used elsewhere is to capture the needed value before the awaited call (e.g. snapshot `weeklyStatus` before `submitWeeklyCount`, not after). Consider: `const prevWs = useStaffStore.getState().weeklyStatus` before `setSubmitting(true)`, then use `prevWs?.windowStart` for `completedFor`. This also avoids an extra `getState()` call after the state has already been mutated.

### `supabase/migrations/20260622090000_weekly_count_kind_and_cadence.sql` — Missing explicit `REVOKE` and `GRANT` on the two RPCs within the `DO $$` block vs. the function-level grants

The migration body grants execute on `submit_weekly_count` (lines 198-199) and on `weekly_count_status` (lines 312-313) via explicit `REVOKE`/`GRANT` statements. This is correct. However, the `DO $$` at lines 35-50 runs unconditionally and drops+recreates the kind CHECK constraint; if the constraint doesn't exist (e.g. on a fresh `db reset`), the `if v_conname is not null` guard prevents the drop, so the recreate at line 53 runs against no prior constraint — correct. No issue here beyond the self-documenting concern. Actually this is fine. Withdrawing.

---

## Nits

- `supabase/functions/weekly-reminder-cron/index.ts:92` — `sendPushAll` accepts `sb: any` and `wp: any`. The `eod-reminder-cron` reference has the same shape, but narrowing these to `ReturnType<typeof createClient>` and the `webpush` module type would remove two `any` parameters that suppress type errors on the `.from(...)` call inside at line 104. Low priority since the edge function's type coverage is already sparse.

- `supabase/functions/weekly-reminder-cron/index.ts:256` — `const summary: any = { weekly: [] }` gives up all type safety on the summary object returned in the envelope. A lightweight `type Summary = { weekly: Array<Record<string, unknown>> }` would cost one line and make the return type checkable.

- `src/screens/cmd/sections/InventoryCountSection.tsx:386-390` / `413-416` — Tab IDs and labels are duplicated verbatim in two separate `TabStrip` renders (the all-stores guard branch and the normal render path). A small constant `const TABS = [...]` at the top of the component would DRY this; as written, adding a fourth tab requires touching two places.

- `src/screens/staff/screens/WeeklyCount.tsx:43-49` — `todayIso` is defined identically in `WeeklyCount.tsx` (staff) and `InventoryCountSection.tsx` (admin side, lines 63-66). Both are also near-identical to the `EODCount.tsx` definition. These cannot be shared across the staff/admin boundary without a careful import audit, but within the staff subtree itself a `lib/utils.ts` could consolidate the three staff-local copies. Out-of-scope for this spec; flagged for follow-up.

- `supabase/functions/weekly-reminder-cron/index.ts:225-227` — Admin recipients are fetched with `role IN ('admin', 'master')`, omitting `super_admin`. This matches the `eod-reminder-cron` reference implementation exactly, so it is not a regression introduced by this spec, but it means super_admin users do not receive weekly reminders. Deferred to a follow-up for consistency with the three-role `auth_is_privileged()` set.

- `src/screens/staff/screens/WeeklyCount.tsx:191-195` — When `submitWeeklyCount` returns `null` (error path), the code sets `forbidden = true` and returns. The comment says "A 42501 (access changed) surfaces the forbidden banner", but `null` is returned for ANY error (not just 42501). A 500 from the DB would also show the "Forbidden" banner, which is misleading. The existing EOD screen has a similar pattern; this is pre-existing shape, not a regression — flagging as a nit rather than a Should-fix.

- `src/screens/cmd/sections/InventoryCountSection.tsx:249` — `loadWeeklyCountStatus` is listed in the `useEffect` dependency array but `tabId` is used as the gate condition. If `loadWeeklyCountStatus` reference changes (unlikely with Zustand stable refs but worth noting) this would reload unnecessarily. Not a bug; just worth knowing.
