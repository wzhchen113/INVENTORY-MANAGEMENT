# Code review for spec 128

Scope: `supabase/migrations/20260722000000_ingredient_changed_badge.sql`,
`supabase/tests/ingredient_changed_badge.test.sql`,
`src/screens/staff/lib/types.ts`, `src/screens/staff/lib/itemsUpdated.ts`
(+ test), `src/screens/staff/components/UpdatedBadge.tsx` (+ test),
`src/screens/staff/screens/EODCount.tsx` / `WeeklyCount.tsx` (+ tests),
staff i18n catalogs.

Overall this is a clean, well-documented implementation that matches the
architect's design doc closely: additive/idempotent migration, correct
`greatest()`/`IS DISTINCT FROM` semantics, a single-source-of-truth
`security invoker` RPC that avoids row fanout via aggregated lateral
subqueries, a best-effort client fetch that degrades to an empty `Set`
without ever throwing, and a badge that composes cleanly next to the
spec-127 thumbnail using theme tokens (no inline colors). No Critical
findings.

### Critical
None.

### Should-fix

- `supabase/migrations/20260722000000_ingredient_changed_badge.sql:101-104` —
  the trigger comment claims it's "bypass-proof" because it catches
  "`updateInventoryItem`'s per-store `vendor_id` write, the spec-119
  `apply_item_vendors_to_brand` scalar mirror, **the spec-122 scalar
  fan-out**, `uploadIngredientImage`/`removeIngredientImage`, and any
  future/direct-SQL path." I checked
  `supabase/migrations/20260717000000_apply_item_scalars_to_brand.sql:117-123`
  (spec 122's `apply_item_scalars_to_brand`) — its `UPDATE` only ever sets
  `par_level`, `cost_per_unit`, `case_price`, `updated_at`. It never touches
  `vendor_id` at all, so the trigger doesn't (and structurally can't) "catch"
  anything from that RPC today. The spec doc itself hedges this correctly
  ("the spec-122 scalar fan-out **if and only if** it changes the primary
  `vendor_id`" — spec 128 §4), but the migration comment drops that
  qualifier and states it as settled fact. Fix: either drop the spec-122
  mention from the "catches" list, or restate it as "would also catch a
  future spec-122 extension that writes `vendor_id`, which it does not
  today" so a reader doesn't go looking for (or rely on) coverage that
  doesn't exist.

- `supabase/tests/ingredient_changed_badge.test.sql:24-25` — the file's own
  header docstring lists `greatest()` "photo-only / vendor-only / both" as
  covered scenarios, but scanning the fixtures: item 1 (Photo Item) only
  ever gets `image_changed_at` stamped, item 2 (Vendor Item) only ever gets
  `vendor_changed_at` stamped, item 3 gets neither. There is no fixture
  where a single item has **both** columns non-null (e.g. photo changed 2
  days ago AND vendor changed 1 day ago) to assert `staff_items_updated`
  returns the correct (later) `changed_at` via `greatest()` rather than,
  say, always preferring one column over the other. Given the design doc
  flags "`greatest()` NULL semantics are load-bearing" (§10) as the single
  riskiest part of the RPC, either add the "both" fixture or trim the
  docstring so it doesn't claim coverage that isn't there.

### Nits

- `src/screens/staff/screens/WeeklyCount.tsx:293` — wraps
  `fetchUpdatedItemIds(activeStore.id)` in an extra
  `.catch(() => new Set<string>())`, even though `itemsUpdated.ts:28-45`
  documents and tests (`itemsUpdated.test.ts`) that the function itself
  never rejects (all failure paths already resolve to an empty `Set`). The
  EOD call site (`EODCount.tsx:428`) correctly omits the redundant catch.
  Harmless belt-and-suspenders, but the two call sites are inconsistent
  with each other for no functional reason — pick one convention.

- `supabase/migrations/20260722000000_ingredient_changed_badge.sql:137-161` —
  both triggers guard via `IS DISTINCT FROM` inside the PL/pgSQL body
  rather than a trigger-level `WHEN` clause (the form the spec's own open
  question sketched: `BEFORE UPDATE ... WHEN (old.x IS DISTINCT FROM
  new.x)`). Functionally identical (confirmed by the pgTAP no-op-write
  assertions), but a `WHEN` clause would skip the function call entirely on
  every no-op `UPDATE` rather than invoking it and short-circuiting inside.
  Not required — noted as a style alternative, not a defect.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 2 Should-fix, 2 Nits — all Should-fix items are documentation/comment-accuracy issues (a migration comment overclaims spec-122 trigger coverage that doesn't exist, and the pgTAP file's docstring claims a "both changed" greatest() fixture that isn't actually present), not functional bugs. No direct-Supabase-outside-db.ts violations, no missing revert/toast pattern issues, no inline colors, no legacy-file edits, no app.json touch, and the migration is correctly idempotent for local+prod double-apply.
payload_paths:
  - specs/128-ingredient-changed-badge/reviews/code-reviewer.md
