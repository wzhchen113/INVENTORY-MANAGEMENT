# Spec 044: Brand-prefix `inv://` flash fix (hydrate brand slice from auth envelope)

Status: READY_FOR_REVIEW

## User story

As a store manager (or admin/master) reloading the Cmd UI, I want the
TitleBar's store-switcher prefix to render my brand's initials (e.g.
`2P://towson`) on the very first paint, so I don't see a momentary
`inv://towson` flash before the brand slice finishes loading.

## Acceptance criteria

- [ ] On page reload as a brand-scoped user (admin, master, or regular),
      `src/components/cmd/TitleBar.tsx` renders the correct brand initials
      (e.g. `2P://<slug>`) from the first paint after `getSession()` resolves
      — no `inv://<slug>` intermediate frame.
- [ ] `src/lib/auth.ts`'s `fetchProfile()` returns an additional optional
      field `brand?: { id: string; name: string } | null` on `AuthResult`,
      populated via a JOIN to `brands(id, name)` against the user's
      `brand_id`. The JOIN runs under existing RLS — no policy changes.
- [ ] `src/store/useStore.ts` exposes a no-persist `hydrateBrand(brand: { id;
      name } | null)` action that mirrors `hydrateLocale` in shape (sync,
      idempotent, sets `brand` slice only).
- [ ] `App.tsx` calls `hydrateBrand(result.brand)` synchronously after
      `getSession()` resolves, alongside the existing
      `hydrateLocale` / `hydrateSidebarLayoutOverride` calls (~line 218).
- [ ] super_admin reload behavior is unchanged: their profile has no
      `brand_id` → `result.brand` is `null` → prefix falls back to `inv://`
      until they pick a brand. (Existing intended behavior.)
- [ ] No regression on dark-mode / locale / sidebar-override hydration paths.
- [ ] `npm run typecheck` exits 0.
- [ ] Existing jest + pgTAP suites stay green.

## In scope

- `src/lib/auth.ts`: extend `fetchProfile()` SELECT to join
  `brands(id, name)`; extend `AuthResult` with `brand?: { id; name } | null`.
- `src/store/useStore.ts`: add `hydrateBrand(brand)` action (no-persist,
  sync).
- `App.tsx`: call `hydrateBrand(result.brand)` in the session-restore path.

## Out of scope (explicitly)

- **Soft-deleted brand edge case** — if the user's brand is in trash, the
  RLS-aware JOIN returns null and the prefix falls back to `inv://`. The
  architect noted this is legitimate "weird state" signaling and we are
  leaving it.
- DB migration — none needed; uses existing `brands` SELECT policy.
- Edge function changes — none.
- Brand-list hydration for super-admins — `brandsList` already populates
  via existing flow; this spec only addresses the single-brand fast path.
- Any TitleBar refactor; `brandPrefix()` callback at
  `src/components/cmd/TitleBar.tsx:59` stays as-is. The fix is purely a
  hydration-timing fix.

## Open questions (for architect)

1. **`brands` RLS walk-through.** The `brand_member_read_brands` policy
   requires `auth_can_see_brand(id)` AND `(deleted_at is null OR
   super_admin)`. Confirm the embedded SELECT
   `from profiles select ..., brands(id, name)` doesn't introduce a
   regression for any edge case (e.g. brand soft-deleted mid-session,
   user with no `brand_id`, super_admin with no brand). Walk the policy
   carefully and confirm the embed silently returns null on RLS denial
   (PostgREST default) rather than failing the whole request.

2. **`AuthResult` callers.** `brand?: …` is a new optional field. Search
   the codebase for callers of `signIn` / `getSession` /
   `fetchProfile` / any function returning `AuthResult` and confirm
   none pattern-match on the full shape in a way that would regress.
   `App.tsx` is the known caller; verify no others.

3. **Test coverage.** Does a jest test verify the `AuthResult` shape
   today? Should `hydrateBrand` get its own unit test, or is it covered
   transitively by existing auth tests? If new test, name the track
   (jest — this is pure TS).

4. **`App.tsx` ordering.** `hydrateBrand` should run synchronously
   alongside `hydrateLocale` and `hydrateSidebarLayoutOverride`. Confirm
   no specific ordering matters (e.g. brand must land before
   `setCurrentStore`'s async `fetchBrandForStore` fires, otherwise the
   async fetch could clobber the hydrated value with a stale read).

5. **Soft-deleted brand UX.** Confirm the "fall back to `inv://` for a
   soft-deleted brand" decision is intentional, or design something
   cleaner (e.g. `xx://<store>` sentinel or empty prefix). Architect's
   call.

## Dependencies

- Existing `brands` SELECT policy (`brand_member_read_brands`).
- Existing `brand` slice in `src/store/useStore.ts` (no schema change).
- Existing `hydrateLocale` / `hydrateSidebarLayoutOverride` patterns as
  the template for the new `hydrateBrand` action.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only. `src/components/cmd/TitleBar.tsx`
  is rendered by `CmdNavigator`. No legacy surface.
- **Per-store or admin-global:** Per-brand (one level up from per-store);
  reads through existing `auth_can_see_brand()` policy.
- **Realtime channels touched:** None. Pure session-restore path.
- **Migrations needed:** No.
- **Edge functions touched:** None.
- **Web/native scope:** Both. The `inv://` flash is observable on web
  (page reload) and, in principle, on native cold start; the fix is in
  shared TS so both platforms benefit.
- **Tests track:** jest (pure TS, no DB or shell). Architect to confirm
  whether new test is needed or transitive coverage is enough.
- **`app.json` slug:** Not touched.

## Backend / architecture design

The three-file shape PM proposed is correct and minimal. Walk-through below
confirms each open question and pins the contract.

### Data model changes

None. No migration, no RLS change. The fix piggybacks on the existing
`brand_member_read_brands` SELECT policy
([supabase/migrations/20260509000000_multi_brand_schema_rls.sql:422-427](supabase/migrations/20260509000000_multi_brand_schema_rls.sql)):

```sql
using ( public.auth_can_see_brand(id)
        and (deleted_at is null or public.auth_is_super_admin()) )
```

### RLS impact

None new. The PostgREST embed `from profiles select '*, brands(id, name)'`
fires the `brands` SELECT policy per row on the embedded read. PostgREST
behavior on embed RLS denial: the embedded relation silently returns
`null`, not an error — the parent row still comes back. Confirmed against
the policy:

- **brand-admin / master (deleted_at IS NULL):** `auth_can_see_brand(id)`
  returns true (their brand_id matches), deleted clause passes → embed
  returns `{ id, name }`. **Fix works.**
- **super_admin (no brand_id):** profile.brand_id is NULL → no FK to walk
  → embed returns `null`. `hydrateBrand(null)` is a no-op. **Existing
  super-admin "All brands" behavior preserved** (per AC line 28-30).
- **Soft-deleted brand, brand-admin:** `auth_can_see_brand(id)` true but
  `deleted_at is null` clause false (and user is not super_admin) →
  embed returns `null` → prefix falls back to `inv://`. **Accepted as
  designed** (Q5 below).
- **Soft-deleted brand, super_admin viewing as super_admin:** doesn't
  apply — they have no brand_id.

No new policy, no edit to existing policy.

### API contract

PostgREST embed, not RPC. In `fetchProfile()`:

- Replace the existing `.select('*')` on `profiles` with
  `.select('*, brands(id, name)')`.
- PostgREST detects the FK `profiles.brand_id → brands.id` and embeds.
- Extract `profile.brands` (singular, not array — `brand_id` is many-to-one)
  into the new `AuthResult.brand` field.
- Defensive: treat anything other than `{ id: string, name: string }` as
  `null` (e.g. RLS-denied embed returns `null`; never throw).

Response shape (additive):

```ts
export interface AuthResult {
  // ...existing fields unchanged
  /** Spec 044: brand-prefix fast-path. Populated via PostgREST embed
   *  against profiles.brand_id → brands(id, name). `null` when the user
   *  has no brand (super_admin), when the brand is soft-deleted, or when
   *  RLS denies the embedded read. */
  brand?: { id: string; name: string } | null;
}
```

### Edge function changes

None. No `verify_jwt` flag touched.

### `src/lib/db.ts` surface

None. The auth path lives in [src/lib/auth.ts](src/lib/auth.ts), not db.ts —
no new helper. `fetchProfile`'s embed is a one-line modification at
[src/lib/auth.ts:82](src/lib/auth.ts), plus a couple of lines to coerce
`profile.brands` into the typed `brand` field. No snake_case → camelCase
mapping needed (the embedded columns are already lower-case `id` and `name`).

### Realtime impact

None. This is a session-restore code path; no channel writes, no publication
change. No `docker restart supabase_realtime_imr-inventory` needed.

### Frontend store impact

One new no-persist hydrator next to `hydrateLocale` /
`hydrateSidebarLayoutOverride` at [src/store/useStore.ts:2117-2131](src/store/useStore.ts):

```ts
// Spec 044 — no-persist hydrator. Mirrors hydrateLocale /
// hydrateSidebarLayoutOverride. Used by App.tsx after getSession()
// returns to seed the `brand` slice synchronously so the TitleBar
// prefix renders the right initials on first paint instead of flashing
// `inv://`.
hydrateBrand: (brand: { id: string; name: string } | null) => void;
```

Implementation: `set({ brand })`. No optimistic-then-revert (this is a
local-only hydrator; nothing to persist back). Slice type already permits
the shape — `AppState.brand: Brand | null` at
[src/types/index.ts:499](src/types/index.ts), and existing call sites at
useStore.ts:628 already set `{ id, name }` shape into it.

### App.tsx wiring

Single call inserted at [App.tsx:201](App.tsx), BEFORE `login(result.user)`:

```ts
hydrateBrand(result.brand ?? null);
login(result.user);
```

Ordering rationale (Q4): `login()` calls `setCurrentStore(userStore)` which
triggers `loadFromSupabase(storeId)` which eventually does
`set({ brand: data.brand })` at [useStore.ts:964](src/store/useStore.ts) —
the async refresh ~50-200ms later overwrites with the SAME value (db.ts
fetches the same brand row via `fetchAllForStore`). Visually a no-op;
correctness-wise the synchronous hydrate buys us the first-paint frame.
This is exactly the model PM described in the dispatch prompt and matches
the dark-mode/locale pattern.

Hydrator destructure is added to the existing useStore selector block at
[App.tsx:151](App.tsx):

```ts
const hydrateBrand = useStore((s) => s.hydrateBrand);
```

### Native (AsyncStorage) path

Q4 confirmed: the session-restore effect at [App.tsx:179-228](App.tsx) runs
identically on web + native. `hydrateBrand` is sync `set()` — no platform
fork needed. The synchronous hydrate fires before any AsyncStorage await
because it lives inside the same IIFE after `getSession()` resolves.

### Risks and tradeoffs

- **PostgREST embed RLS-denial silence (Critical-to-flag, not Critical):**
  PostgREST returns `null` for embedded relations the caller can't see, not
  an error. That's the desired behavior here (super_admin, soft-deleted
  brand fallback to `inv://`), but it means a future regression in
  `brand_member_read_brands` would silently break the fast-path with no
  surfaced error. Mitigation: spec 044's AC line 14-17 doubles as the
  regression test (acceptance test reload as brand-admin and assert
  `2P://` not `inv://`).
- **AuthResult shape additive only (Q2):** grepped for callers of
  `signIn` / `getSession` / `fetchProfile` / `AuthResult` consumers — only
  callers are [App.tsx:191](App.tsx) and
  [src/screens/LoginScreen.tsx:43](src/screens/LoginScreen.tsx). LoginScreen
  pattern-matches on `result.error` only and routes through `login(user)`.
  Neither destructures the full shape. Adding optional `brand?` is safe.
- **Soft-deleted brand UX (Q5):** Architect's call — keep the `inv://`
  fallback. Reasoning: (a) it's a strict edge case (a brand-admin whose
  brand is in trash should be locked out at a higher layer, not made
  legible by a sentinel prefix); (b) introducing `xx://` or empty-prefix
  divergent UI invites the next bug. The `inv://` fallback is honest:
  "your brand context is undefined."
- **Test coverage (Q3):** No existing jest test asserts `AuthResult` shape
  (grepped `src/lib/auth.test.ts` — no `brand|sidebarLayout|locale`
  matches). Recommend a tiny unit test for `hydrateBrand` (set / null /
  idempotent) in `src/store/useStore.test.ts` and a jest mock-supabase
  test in `src/lib/auth.test.ts` asserting `getSession()` returns
  `brand: { id, name }` when the embed yields a row, `null` otherwise.
  Jest track — pure TS. Not blocking ship.
- **Performance:** Embed adds one JOIN on a single-row read keyed by PK.
  286 KB seed dataset is irrelevant here — this is a single profile
  lookup. Negligible.

### Open questions resolved

1. **Q1 brands RLS embed:** confirmed silent-null on denial; behavior is
   desired across all four user-class cases. No policy change.
2. **Q2 AuthResult callers:** App.tsx + LoginScreen only; neither
   pattern-matches the full shape. Additive optional field is safe.
3. **Q3 test coverage:** no existing shape test; recommend two small jest
   tests (one for hydrator, one for `getSession()` embed) — not blocking.
4. **Q4 ordering:** hydrate BEFORE `login()`, async refresh later is a
   visual no-op. Matches dark-mode/locale precedent.
5. **Q5 soft-deleted brand UX:** keep `inv://` fallback. Documented as
   intentional "weird state" signaling.

## Handoff

next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec. Three files only —
  `src/lib/auth.ts` (extend `fetchProfile` SELECT + `AuthResult.brand`),
  `src/store/useStore.ts` (add `hydrateBrand` no-persist action next to
  `hydrateLocale`), and `App.tsx` (call `hydrateBrand(result.brand)`
  BEFORE `login(result.user)` at the session-restore effect ~line 201).
  Optional jest coverage for the hydrator and the auth shape per Q3 —
  small, recommended, not blocking. After implementation, set
  Status: READY_FOR_REVIEW and list files changed under
  ## Files changed.
payload_paths:
  - specs/044-brand-prefix-flash-fix.md

## Files changed

- `src/lib/auth.ts` — Added `brand?: { id: string; name: string } | null`
  field to `AuthResult`. Extended `fetchProfile()`'s SELECT from
  `select('*')` to `select('*, brands(id, name)')` to embed the brand row
  via PostgREST FK detection on `profiles.brand_id → brands.id`. Defensive
  normalization of the embedded relation: array → first element, object →
  `{ id, name }` (when both fields are strings), anything else → `null`.
  Returns the normalized `brand` in the AuthResult envelope.
- `src/store/useStore.ts` — Added `hydrateBrand(brand: { id; name } | null)`
  to the `AppState` interface (next to `hydrateLocale`) and the action body
  (`set({ brand })`) next to the existing `hydrateLocale` implementation.
  No persistence, no DB write, no toast — mirrors `hydrateLocale` in shape.
- `App.tsx` — Added `const hydrateBrand = useStore((s) => s.hydrateBrand);`
  selector next to the existing hydrate selectors. In the session-restore
  `useEffect`, calls `hydrateBrand(result.brand ?? null)` synchronously
  BEFORE `login(result.user)` so the synchronous seed lands before
  login()'s downstream `setCurrentStore` → `loadFromSupabase` async
  refresh fires. Per architect's Q4 ordering rationale: visually a no-op
  for the eventual async refresh, but buys the first-paint frame.
- `src/store/useStore.test.ts` — Added a `describe('hydrateBrand (spec
  044)')` block with three small jest tests (seed / null clear /
  no-side-effects). Mirrors the existing `deleteProfile` describe block's
  setup pattern. Architect's Q3 optional coverage — recommended, not
  blocking. (No new auth.test.ts assertion: that file is scoped narrowly
  to `callEdgeFunction` via `deleteUser` and exercising `fetchProfile`
  would require new mock plumbing the architect didn't request.)

### Round 2 — code-reviewer Should-fix + Nits

- `src/store/useStore.test.ts` — **S1**: backed the "idempotent" claim
  in the describe header with a real fourth test that calls
  `hydrateBrand` twice with the same value and asserts the slice is
  unchanged across calls. **S2**: backed the "no db.* mock should fire"
  comment in test (3) with explicit
  `expect(db.fetchStores).not.toHaveBeenCalled()` and
  `expect(db.fetchAllForStore).not.toHaveBeenCalled()` assertions; the
  comment is now enforceable. Updated the describe header from "Three
  cases" to "Four cases" to keep the doc in sync. Net: 7 tests in the
  file (was 6); full suite 142/142 (was 141/141).
- `src/lib/auth.ts` — **N-1**: added a one-line comment above the
  `(profile as any).brands` cast explaining the supabase-js typing gap
  on freeform PostgREST embeds. **N-3**: added a brief comment above
  the `Array.isArray(embedded) ? embedded[0] : embedded` line noting
  that the empty-array sub-case falls through to `null` via the
  downstream falsy check.
- `App.tsx` — **N-4**: added a one-line comment above
  `hydrateBrand(result.brand ?? null)` clarifying that `undefined` is
  the signed-out case and `null` is super_admin / soft-deleted brand /
  RLS-denied embed.
