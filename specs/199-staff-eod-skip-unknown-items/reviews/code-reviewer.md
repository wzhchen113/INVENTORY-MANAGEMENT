## Code review for spec 199

Scope: spec 199's hunks only. Spec 193's uncommitted edits in `useEodSubmit.test.ts` and `admin_submit_eod.test.sql` were not reviewed. The migration is read against the design in the spec (section 2.3). I read the migration, the new pgTAP suite, `useEodSubmit.ts`, the `EODCount.tsx` toast hunk and the i18n and types grep hits. I only grepped the two jest files for spec 199 content and did not read them line by line.

### Critical
None. No direct Supabase call was added outside the staff carve-out. No legacy file was touched, and `app.json` was not changed. The migration touches only `staff_submit_eod`, with no grants and no custom `current_setting('jwt…')` SQL.

### Should-fix
None.

The migration matches the design block for block:
- The order of checks is vendor, store gate, replay, O-1, date window, then the new R3, R2 and R4 steps, then the writer.
- Both new messages are constant and free of the forbidden substrings.
- `security definer` and `search_path` are restated.
- The comment is re-issued with the 193 text kept.
- The filtered array goes to the writer.
- `skipped_item_ids` is returned as an always-present key, on the non-replay path only.

The client matches the design too:
- `isForbidden` has no bare `42501` fallback.
- The `skippedCount` helper is used only on the non-replay branches.
- The online path leaves `skipped_count` off when it is 0, so existing `toEqual` arms stay true.
- The drain has one debounced toast.
- Skipped notice text and `allSynced` live in the same toast.

### Nits
- `src/screens/staff/hooks/useEodSubmit.ts:241-263` — `skippedPendingRef` is not reset, and `allSyncedTimerRef` is not cleared, on unmount. If the screen unmounts inside the 400 ms debounce, the skipped notice is silently lost. `allSynced` already had this gap, so it is pre-existing, but the notice is now the only signal for a dropped item. Consider clearing the timer in an unmount effect only if you want to tighten it. No change is needed for merge.
- `src/screens/staff/hooks/useEodSubmit.ts:252` and `src/screens/staff/screens/EODCount.tsx:932` — the `6000` visibility time is a repeated literal. It also matches the `syncErrorBanner` toast at `useEodSubmit.ts:214`. A named constant such as `NOTICE_TOAST_MS` would help. Preference only.
- `src/screens/staff/hooks/useEodSubmit.ts:1-8` — the file header still says "one of four outcomes" while listing five (pre-existing). It is also not updated to mention `skipped_count`. (out-of-scope)
- `supabase/tests/staff_submit_eod_skip_unknown.test.sql:689-695` — arm (51) borrows `test.r1`'s submission id from SK1, so it is coupled to an earlier arm's success. A failure in arm (1) cascades here as a confusing error. Seeding its own submission would make it self-contained. Low priority.
- `supabase/tests/staff_submit_eod_skip_unknown.test.sql:117-125` — the `kind` to setting-name mapping builds names from `lower(right(kind,1))` (`i1`, `i2`, `ix`, `n1`, `n2`, `nx`). This is correct but cryptic. A one-line comment already names the settings, so this is fine as is.
- `supabase/migrations/20261110130000_staff_eod_skip_unknown_items.sql:1-105` — the header is about 100 lines and repeats the spec's design sections (the prod-apply and rollback prose). It is accurate and matches 193's style, so no action. Keeping the rollback text in the spec alone would keep the migration shorter.
- `supabase/migrations/20261110130000_staff_eod_skip_unknown_items.sql:119` — the pre-flight uses `like '%eod_write_submission(%'`. The `_` in the pattern is a LIKE wildcard. It is harmless here, but it is not an exact match.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 0 Should-fix, 7 Nit.
payload_paths:
  - specs/199-staff-eod-skip-unknown-items/reviews/code-reviewer.md
