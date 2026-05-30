# Spec 077 — housekeeping: stale test comments + spec-075 doc drift

Status: READY_FOR_REVIEW
Shape: housekeeping (zero behavioral change — comments, one type-correct
literal swap, and a spec-doc patch)
Pipeline note: PM/architect ceremony skipped — three reviewer-surfaced
1-line cleanups with no runtime surface. Reviewers + RC for the audit trail.

## Problem

Three deferred cleanups surfaced by reviewers across specs 075 + 076,
each explicitly logged as out-of-scope at the time:

1. **`src/lib/cmdSelectors.unconfirmedPoWindow.test.ts` top-comment is
   doubly stale** (spec 076 code-reviewer Nit #1). Lines 3-6 say the
   sibling rules "retain their pre-spec-074 windowing (see inline comment
   in cmdSelectors.ts above the unconfirmed_po block)." Both clauses are
   now false: spec 076 made `eod_missing` + `food_cost_streak` tz-aware
   (they no longer "retain pre-spec-074 windowing"), and the inline
   comment they point at was replaced by spec 076's ratification note. A
   reader following the pointer finds the opposite of what the comment
   claims. AC #9 of spec 076 held this file byte-untouched; spec 076 has
   shipped, so the hold is lifted.

2. **`'fine' as ItemStatus` in the same file** (spec 076 code-reviewer
   Nit #2). Line 53's `getItemStatus` stub returns `'fine' as ItemStatus`
   — `'fine'` is not in the `ItemStatus = 'ok' | 'low' | 'out'` union and
   is force-cast with `as`. The spec-076 sibling file
   (`cmdSelectors.eodAndStreak.test.ts`) uses the type-correct `'ok'`. The
   inconsistency between the two sibling files is now visible. Behavior is
   identical (`inventory` is `[]` in this test, so `getItemStatus` is
   never invoked; and `'ok'`/`'fine'` are both "not low, not out" so the
   `low_out_stock` rule stays silent either way).

3. **Spec 075 design block names `America/New_York`; the shipped
   migration uses `'UTC'`** (spec 075 backend-architect post-impl ADVISORY
   DRIFT items 7+8, + code-reviewer Should-fix #1). The
   `20260530000000_record_missed_orders_rpc.sql` cron body and 28-day
   backfill both use `((now() at time zone 'UTC') - interval '1 day')::date`
   / `((now() at time zone 'UTC')::date - N)`, but the spec doc's code
   blocks (lines ~537-556 + ~605-606) still show the NY-local form. The
   architect's post-impl recommendation was a **doc-only patch aligning
   the spec with the shipped UTC form** (functionally identical at the
   07:00 UTC schedule hour — the UTC→NY date rollover is at 19:00 UTC,
   nowhere near 07:00). This spec applies that patch.

## Fix

Pure edits — no runtime code path changes:

1. `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts` lines 3-6 — rewrite
   the top-comment to point at the spec-076 sibling test file and state
   that all three rules now use `getLocalDateISO`.
2. Same file, lines 51-53 — `() => 'fine' as ItemStatus` → `() => 'ok'`
   (drop the `as` cast; `'ok'` is a valid union member). Update the
   adjacent comment from `'fine'` to `'ok'`.
3. `specs/075-missed-order-audit-log-parity.md` — patch the cron-schedule
   code block + rationale prose + the 28-day backfill code block to the
   shipped `'UTC'` form, with a one-line note that this is the as-shipped
   decision (architect-approved, functionally equivalent at 07:00 UTC).

## Verification

- `npx tsc --noEmit -p tsconfig.json` → exit 0 (the `as` cast removal must
  still typecheck — `'ok'` is in the union).
- `npx tsc --noEmit -p tsconfig.test.json` → exit 0.
- `npx jest src/lib/cmdSelectors.unconfirmedPoWindow` → all arms still green
  (the `'fine'`→`'ok'` swap is behavior-preserving: empty `inventory` means
  `getItemStatus` is never called, and both values keep `low_out_stock`
  silent).
- No new tests — these are comment/literal/doc edits with no new behavior to
  pin. (Pinning that a comment says the right thing has no test surface.)

## Files changed

- `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts` — top-comment rewrite + `'fine' as ItemStatus` → `'ok'`.
- `specs/075-missed-order-audit-log-parity.md` — NY→UTC doc patch on the cron + backfill code blocks and rationale.

## Scope / non-changes

- `src/lib/cmdSelectors.ts` (the runtime selector) — untouched. The
  `'fine'`→`'ok'` change is in a TEST file's fixture stub only.
- The shipped migration `20260530000000_record_missed_orders_rpc.sql` —
  untouched (the spec doc is patched to match IT, not the reverse —
  per the architect's post-impl recommendation).
- No backend / RLS / RPC / migration / edge function / db.ts / realtime
  surface. Pure frontend test-fixture + markdown. Vercel deploys on push;
  NO prod migration.
