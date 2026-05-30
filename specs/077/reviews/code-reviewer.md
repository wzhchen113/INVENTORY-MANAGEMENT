# Code review — spec 077 (housekeeping: stale comments + spec-075 doc drift)

Reviewer: code-reviewer
Scope: zero-runtime-change housekeeping. Two changes in a test file (`cmdSelectors.unconfirmedPoWindow.test.ts`) and one in a spec doc (`specs/075-missed-order-audit-log-parity.md`). No runtime code, no migrations, no store, no db.ts touched.

## Critical

None. Verified: `src/lib/cmdSelectors.ts` is unmodified (no runtime selector change), `supabase/migrations/20260530000000_record_missed_orders_rpc.sql` is unmodified (the spec doc was patched to match the migration, not the reverse), no legacy-file edits, no `app.json` slug change, no direct Supabase calls, no new test files outside the established tracks.

## Should-fix

- `specs/075-missed-order-audit-log-parity.md:540` and `:565` — The "as-shipped note" and the schedule-rationale bullet both state "the UTC→NY calendar-date rollover is at 19:00 UTC." This is incorrect. New York midnight falls at 05:00 UTC (EST, UTC-5) or 04:00 UTC (EDT, UTC-4), not 19:00 UTC. 19:00 UTC is mid-afternoon Eastern time (~3 PM ET). The underlying argument is valid — at 07:00 UTC both "yesterday in UTC" and "yesterday in NY" refer to the same calendar date because the NY date boundary is well before 07:00 UTC — but the specific clock value cited is wrong and will mislead a future reader who tries to verify the claim. Fix: replace "19:00 UTC" with "04:00–05:00 UTC" (or simply "around midnight Eastern / 04:00–05:00 UTC") in both instances.

## Nits

- `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts:7-8` — The comment says "ratified by the inline note above the unconfirmed_po block in cmdSelectors.ts." The note at `cmdSelectors.ts:866-870` is inside the unconfirmed_po section (below the `// ─── unconfirmed_po` header comment at line 853), not strictly above the block. The pointer is close enough that a reader will find it, but "within the unconfirmed_po block" would be more precise than "above."

## Resolution (post-review fix-pass — main Claude)

- **Should-fix (incorrect "19:00 UTC" rollover claim)**: **fixed.** The reviewer is right — NY midnight is at 04:00 UTC (EDT) / 05:00 UTC (EST), not 19:00 UTC (which is ~15:00 ET, mid-afternoon). The underlying argument was sound (NY's date boundary is BEFORE the 07:00 UTC fire, so both resolve "yesterday" identically) but the cited clock value was wrong and would mislead. Both occurrences in `specs/075-…md` (the "as-shipped note" callout + the schedule-rationale bullet) now read "NY midnight is 04:00–05:00 UTC, before the 07:00 fire time." Thanks for catching a factual error introduced in this very doc-patch.
- **Nit (`above` → `within` the unconfirmed_po block)**: **fixed.** The test-file top-comment now says "within the unconfirmed_po block in cmdSelectors.ts" — the inline note lives below the `// ─── unconfirmed_po` header, inside the block.

Re-verified: the corrections are comment/markdown-only — no test or typecheck impact (tsc was exit 0 + the affected jest file 9/9 green prior to these doc-string edits; comments don't affect either).
