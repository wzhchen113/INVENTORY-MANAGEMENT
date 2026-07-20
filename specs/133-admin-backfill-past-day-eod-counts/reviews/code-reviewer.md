## Code review for spec 133

Scope reviewed: `src/lib/eodDayStatus.ts` (new), `src/lib/__tests__/eodDayStatus.test.ts` (new),
`src/screens/cmd/sections/EODCountSection.tsx` (week memo rewiring + `dayPillFor`), and
`src/i18n/{en,es,zh-CN}.json`.

Overall: this is a clean, tightly-scoped implementation. The extraction mirrors
`countOrder.ts` conventions (pure, dependency-free, header comment explaining the
"why", exported types), `deriveDayStatus`'s branch ordering matches the design's
state machine exactly, the `isRestWeekday` predicate matches the documented
`eod-reminder-cron` Track-1 mirror, `isRestDay`/all disable expressions are
genuinely untouched (OQ-2 honored — `showUnscheduled` is not wired into
`isRestDay`), the violet token reuse matches spec 130 parity, and all three i18n
catalogs got the key in the same location. The `week` memo's dependency array
correctly adds `orderSchedule`. No direct `supabase.from/rpc` calls introduced,
no `useStore.ts` mutation added (none needed), no stale test pinning the old
"past uncounted → rest" behavior existed to update.

### Critical

None.

### Should-fix

None.

### Nits

- `src/screens/cmd/sections/EODCountSection.tsx:291-293` vs `src/lib/eodDayStatus.ts:43-48` — the component's inline `scheduleConfigured` `useMemo` duplicates the logic now exported (and exercised by 2 jest pins) as `scheduleConfigured` from the new module. The design explicitly left this as implementer's choice ("stay inline OR be folded... keep the line-292 memo as a thin wrapper"), so this isn't a defect, but since the pure export already exists and is unit-tested, wrapping `useMemo(() => scheduleConfigured(orderSchedule), [orderSchedule])` would remove the duplicate implementation and let one jest-pinned function back both call sites. Low priority — out-of-scope enough to defer, flagging for a future pass.
- `src/screens/cmd/sections/EODCountSection.tsx:965-969` (out-of-scope) — the week-sidebar dot-color ternary (`today`→accent, `submitted`→ok, `late`→warn, else→`C.fg3`) wasn't updated for the new `'uncounted'` status, so the small status dot for an uncounted day renders the same neutral grey as `'draft'`/`'rest'`, while the pill next to it is violet. This is a pre-existing two-tier indicator (dot + pill) that the design's OQ-1 ruling didn't mention extending, and the pill alone already carries the distinct signal the AC asks for, so this is cosmetic only — not a spec violation.
- `src/lib/eodDayStatus.ts:75-77` — `isRestWeekday`'s doc comment says "byte-for-byte semantically" mirrors the cron, but the cron's `storesScheduledToday` counts a schedule row present for the weekday regardless of `vendor_id` nullness, while this module (matching the section's pre-existing `dayScheduledVendorIds` filter) only counts rows with a non-null `vendorId`. This is inherited from existing component behavior (not a regression introduced by 133) and is explicitly commented as covering "legacy pre-vendor_id rows," so no action needed here — noting only because the doc comment's "byte-for-byte" claim is slightly stronger than what's literally true against the cron for that one edge case.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 0 Should-fix, 3 Nits (all low-priority/out-of-scope observations, none blocking).
payload_paths:
  - specs/133-admin-backfill-past-day-eod-counts/reviews/code-reviewer.md
