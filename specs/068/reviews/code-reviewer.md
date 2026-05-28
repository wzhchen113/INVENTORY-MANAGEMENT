# Code review — Spec 068 (Invite User brand-scoping)

Reviewer: code-reviewer
Date: 2026-05-28

> **Provenance note**: code-reviewer subagent confused itself about write permission again and emitted findings inline. Main Claude recovered the content verbatim.

## Critical

None.

## Should-fix

- `src/utils/userPermissions.test.ts:258` — The `user`-role test asserts on a specific order: `expect(result.map((s) => s.id)).toEqual(['reisters', 'towson'])`. The order is allStores-order (correct), but the assertion is fragile — it encodes that `Array.filter` preserves input-array order rather than the `user.stores` grant order. A reader editing `ALL_STORES` ordering would silently break the test. Fix: `expect(result.map((s) => s.id).sort()).toEqual(['reisters', 'towson'].sort())` or add a comment making the allStores-order dependency explicit.

- `src/components/cmd/InviteUserDrawer.tsx:403-404` — The stores counter `· {values.storeIds.length} of {brandStores.length} selected` renders even in the no-brand-notice path. The test at `InviteUserDrawer.test.tsx:198` asserts `'· 0 of 0 selected'` is present in the no-brand state — counter + no-brand notice render simultaneously. `0 of 0 selected` alongside the warning is uninformative noise. Fix: hide the counter when `!brandId`, or document why `0 of 0` in the no-brand path is intentional.

- `src/components/cmd/InviteUserDrawer.tsx:107` — The `eslint-disable-next-line react-hooks/exhaustive-deps` at line 107 correctly suppresses the missing `brandStores` dependency, justification sound. But the comment says "Keyed on brandId, not brandStores" without linking to the `useMemo` that guarantees `brandStores` identity changes exactly when `brandId` changes. If a future editor changes the `useMemo`, the prune fires on the wrong granularity. Fix: add cross-reference comment: `// brandStores identity changes only when brandId changes (useMemo above), so keying on brandId here is equivalent.`

## Nits

- `src/utils/userPermissions.test.ts:205-210` — describe-block header `'deriveAccessibleStores'` duplicates spec-number metadata in both block comment AND file header (line 1). Minor redundancy.

- `supabase/tests/user_stores_brand_match_null_brand.test.sql:63-68` — fixture UUID constants hardcoded (`2a000000-…`) rather than pinned to the seed via subquery. If the seed's brand-A id changes, the constant silently desyncs. Consistent with sibling `auth_can_see_store_brand_scope.test.sql` — not new. Follow-up candidate: pin fixture UUIDs to seed.

- `supabase/migrations/20260528010000_user_stores_brand_match_null_brand_guard.sql:95-101` — the conflict-detection uses `select ... limit 1; if found then`. The `EXISTS` form is marginally more idiomatic in PL/pgSQL. Code is correct + readable; an inline comment (`-- if found: user already holds a grant in a different brand`) would aid a future reader.

- `src/components/cmd/InviteUserDrawer.test.tsx:88-97` — `useStore` mock uses a mutable shared object mutated via `fn.__state`, same pattern as `CopyToBrandDialog.test.tsx`. Correctly reset in `beforeEach` + `jest.clearAllMocks()`. No bug.

## Handoff
next_agent: NONE
