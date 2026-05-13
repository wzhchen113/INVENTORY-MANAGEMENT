# Code review for Spec 021 — Reorder / delivery list

## Critical

- `supabase/migrations/20260514130000_report_reorder_list.sql:354–378` —
  **Multi-delivery-day vendors get the wrong `days_until_next_delivery`.**
  The lateral subquery computes `MIN(DOW_number)` across all of a vendor's
  delivery days. The outer CASE expression then checks whether that
  minimum equals today's DOW and applies the cutoff-time adjustment, or
  otherwise converts it to an offset. Because `MIN` picks the
  numerically-smallest day (e.g. Sunday=0 beats Saturday=6), it does
  **not** return the nearest upcoming delivery day — it returns the
  delivery day with the smallest calendar-week position.

  Concrete failure: vendor delivers Wednesday (DOW 3) and Friday (DOW 5).
  Today is Thursday (DOW 4). Lateral returns `MIN(3,5) = 3`. Outer CASE:
  `3 ≠ 4`, so `offset = (3–4+7)%7 = 6`. The section shows "in 6 days"
  but the correct answer is Friday (1 day away).

  Fix: move the distance computation inside the lateral so the MIN
  operates on offsets rather than raw DOW numbers:

  ```sql
  select min(
    ((case lower(os2.delivery_day)
        when 'sunday'    then 0
        when 'monday'    then 1
        when 'tuesday'   then 2
        when 'wednesday' then 3
        when 'thursday'  then 4
        when 'friday'    then 5
        when 'saturday'  then 6
        else null end
     ) - v_today_dow_num + 7) % 7
  ) as min_days_offset
  from public.order_schedule os2
  where ...
  ```

  Then compare `min_days_offset = 0` (today) for the cutoff check instead
  of comparing against raw DOW numbers. The vendor-level cutoff-time push
  to 7 must be applied after the MIN, not inside the min() argument, because
  cutoff-time only matters when the nearest delivery is today.

## Should-fix

- `supabase/migrations/20260514130000_report_reorder_list.sql:541–543` —
  **Warnings step 5 comment claims it filters to vendors that appear in
  the main payload, but the implementation does not.** The comment reads
  "Computed off the post-filter `vendors_with_items` set so the warnings
  reflect what the user actually sees." However, the second `WITH`
  statement (step 5) is a separate CTE scope — `vendors_with_items` is
  not accessible there. The query scans all vendors that have any inventory
  items in the store, regardless of whether those vendors produced
  suggestions (and therefore appear in the returned payload). A vendor
  with no items above par and no usage forecast will be filtered out of
  `vendors` in the JSON envelope but will still generate a
  `schedule_unknown` warning. The manager sees a warning for a vendor card
  that is invisible in the UI, which is confusing. Fix: either (a) cross-
  join the second CTE against the first CTE's vendor set by passing a JSON
  list of vendor IDs into the step-5 query (the two CTE scopes can't share
  CTEs), or (b) accept the over-warning and correct the comment to read
  "vendors with any inventory items in this store" so the discrepancy is
  documented.

- `src/store/useStore.ts:417–419` — **The comment "Cleared (not refreshed)
  when the store changes" is incorrect.** `loadFromSupabase` (called by
  `setCurrentStore`) does not include `reorderPayload: null` in its `set()`
  calls, so when a user switches stores the previous store's vendor cards
  remain visible until the section's `useEffect` fires and the new RPC
  call completes. Typical delay: one render cycle + RPC round-trip (~200–
  400 ms). Fix: add `reorderPayload: null, reorderError: null` to the
  `set(...)` call in `loadFromSupabase` (the same place `orderSchedule` is
  reset) so the stale data disappears immediately on store switch. Also
  correct the comment.

- `src/screens/cmd/sections/ReorderSection.tsx:185–189` — **`SCHEDULE
  UNKNOWN` badge completely masks the EOD source badge.** When
  `scheduleKnown=false`, `sourceBadge` is set to `SCHEDULE UNKNOWN` and
  the `EOD` / `STOCK FALLBACK` badge is never rendered. A vendor that had
  a fresh EOD count but no order schedule shows only "SCHEDULE UNKNOWN",
  hiding the fact that its on-hand data is authoritative. The spec's A5
  decision says "show with a badge" — it doesn't say the EOD badge should
  be suppressed. Fix: render both badges independently so schedule status
  and data-freshness status are orthogonal. E.g.:

  ```tsx
  const scheduleBadge = !vendor.scheduleKnown
    ? <Badge label="SCHEDULE UNKNOWN" tone="warn" />
    : null;
  const sourceBadgeEl = vendor.onHandSource === 'eod'
    ? <Badge label="EOD" tone="accent" />
    : <Badge label="STOCK FALLBACK" tone="warn" />;
  ```

  The `7-DAY DEFAULT` badge at line 224–226 is already shown independently;
  the source badge should follow the same pattern.

## Nits

- `supabase/migrations/20260514130000_report_reorder_list.sql:162–164` —
  The depth-cap pre-walk at step (3) runs a separate recursive CTE that
  duplicates the same recursion in the main CTE (step 4b). The count it
  produces (`v_truncated_recipe_count`) is only used to emit a `RAISE
  NOTICE` and is otherwise not consumed. The `truncated` flag for per-item
  rows is independently derived in the main CTE chain (step 4c). The
  pre-walk is dead-computation — its notice is not visible in the client
  (it would only appear in the Postgres server log). Consider removing
  steps (3) and the associated `v_truncated_recipe_count` variable to keep
  the function lean. The per-item `'truncated'` flag already surfaces this
  signal to the UI where it matters.

- `src/screens/cmd/sections/ReorderSection.tsx:363` and `:391` — The
  single-tab `TabStrip` with `id: 'reorder.tsx'` / `label: 'reorder.tsx'`
  follows the `DashboardSection`→`overview.tsx` IDE-aesthetic convention,
  so this is intentional. However the `tabId` state variable and
  `setTabId` callback serve no runtime purpose when there is exactly one
  tab — the active tab can never change. Consider omitting the `useState`
  and hardcoding `activeId="reorder.tsx"` directly, or adding a second tab
  (e.g. "history") that justifies the stateful setup.

- `src/screens/cmd/sections/ReorderSection.tsx:27–28` — `shortId` renders
  the first 6 chars of the vendor UUID in the card header. This is useful
  during development but leaks an internal identifier into the manager UI.
  The vendor name is already shown alongside it; the ID fragment adds no
  manager-visible value. Consider removing it or moving it behind a dev-
  mode feature flag.

- `src/lib/db.ts:2018–2020` — Comment says "Errors bubble up; callers
  wrap with `notifyBackendError`" but the actual caller (`loadReorder-
  Suggestions` in `useStore.ts`) explicitly does NOT use `notifyBackendError`
  — it writes `reorderError` in-state instead. The comment is left over from
  a draft and is now misleading. Suggest updating to "Errors surface to
  `reorderError` for the section's error pane (not toast)."

- `supabase/migrations/20260514130000_report_reorder_list.sql:445` —
  The `no_usage_rate` flag fires when `qty_per_day = 0` (no recent POS
  imports) in addition to when `usage_per_portion IS NULL`. A manager
  seeing `NO USAGE` on an item could reasonably assume the item has no
  usage rate configured, when the real cause might be absent POS data for
  the last 7 days. The flag label is correct per the RPC contract (and the
  `types/index.ts` doc says the same), but a future iteration could
  differentiate `'no_usage_rate'` (missing config) from
  `'no_recent_pos'` (config present, data absent). Not a v1 blocker;
  noting for the v2 pass.
