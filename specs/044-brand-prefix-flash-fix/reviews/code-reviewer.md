# Code review for Spec 044 (brand-prefix flash fix)

## Critical
None.

## Should-fix

### S1 — Test `(3)` idempotent claim not backed by assertion

`src/store/useStore.test.ts:238,266` — The describe-block header documents
case `(3)` as "idempotent — calling twice with the same value is a no-op",
but the third test body calls `hydrateBrand` only once. Either:
- Update the describe comment to remove the idempotency claim, OR
- Add a second `hydrateBrand({...})` call after the first and assert state
  is unchanged.

### S2 — "No db.* mock should fire" comment lacks assertion

`src/store/useStore.test.ts:271-272` — Comment promises no db mock fires
but no `expect(...).not.toHaveBeenCalled()` assertion backs it. Add e.g.
`expect(require('../lib/db').fetchStores).not.toHaveBeenCalled()` to make
the claim enforceable.

## Nits

- `src/lib/auth.ts:134` — `(profile as any).brands` cast needs a one-line
  comment explaining why (supabase-js doesn't type PostgREST embeds on
  freeform selects).
- `src/store/useStore.ts:368` — `hydrateBrand` param type is structurally
  a subtype of `Brand | null`; consider typing as `Brand | null` for
  surface consistency with `AppState.brand`.
- `src/lib/auth.ts:135` — empty-array sub-case in `embedded[0]` handled
  correctly via `&&` falsy check; brief comment would prevent future
  doubt.
- `App.tsx:210` — `result.brand ?? null` correctly coerces `undefined`;
  brief comment "// undefined when signed out; null for super_admin /
  soft-deleted" would make it less mysterious.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 2 Should-fix, 4 Nits.
