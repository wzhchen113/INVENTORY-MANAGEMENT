# Spec 111: "Switching stores…" full-screen takeover on store/brand switch

Status: READY_FOR_REVIEW

> Owner ask, verbatim (with a screen recording of the admin Cmd UI mid-switch):
> "when switching stores or brand the entire screen should load like 'switching
> stores...'".
>
> Today, switching the active store (or, for a super-admin, the active brand) in
> the admin Cmd UI swaps `currentStore` synchronously and kicks off an async
> refetch — but the per-section data slices are deliberately NOT cleared, so for
> the load duration the operator sees the PREVIOUS store's inventory / recipes /
> counts sitting under the NEW store's name in the TitleBar. This spec puts a
> full-screen "Switching stores…" / "Switching brands…" takeover over the entire
> Cmd UI (TitleBar + sidebar + section body) for exactly the switch window, so the
> stale numbers are visually gated instead of flashed. It does NOT clear any
> slice (that would regress the in-memory cache and flash empty states); it gates
> the switch with an overlay.

## User story

As a **store manager (or super-admin) in the admin Cmd UI**, when I switch the
active store or brand, I want the whole screen to show a clear "Switching stores…"
state until the new store's data has loaded, so that I never see the previous
store's inventory, recipe, or count numbers sitting under the new store's name —
I trust that what's on screen belongs to the store I just selected.

## Problem / current state (verified in code)

- **`setCurrentStore`** (`src/store/useStore.ts:747-765`) sets `currentStore`
  synchronously, then fires `loadFromSupabase(store.id)`. The section slices
  (`inventory`, `recipes`, `prepRecipes`, `vendors`, `eodSubmissions`,
  `orderSubmissions`, `wasteLog`, `auditLog`, `orderSchedule`, …) are NOT cleared
  on switch — they hold the PREVIOUS store's data until the refetch resolves, so
  the operator sees stale numbers under the new store's name for the load duration.
  (Two slices ARE cleared on switch — `reorderPayload` and `menuCapacity`,
  `useStore.ts:674-688` / set inside `loadFromSupabase` at `useStore.ts:1175-1182`
  — because their sections would otherwise flash the previous store's cards/badges.
  Everything else stays for the in-memory cache.)
- **Spec 055's per-section `ListSkeleton`** gates render ONLY on
  `storeLoading && slice.length === 0` (e.g. `DashboardSection.tsx:361`,
  `RecipesSection.tsx:236`, `VendorsSection.tsx:93`, and ~9 more sections). On a
  SWITCH the slices are non-empty (they hold the prior store's data), so
  `slice.length === 0` is false and **no skeleton appears** — the spec-055
  skeletons only cover FIRST load into an empty cache, which is the intended
  division of labor (this spec does not touch them).
- **`storeLoading` already exists and is already toggled by the load.**
  `loadFromSupabase` sets `storeLoading: true` at `useStore.ts:1101` and resets it
  in a `finally` block at `useStore.ts:1212` (so both success and error paths clear
  it — an error cannot strand a flag keyed off `storeLoading`). It is the reliable
  "we are talking to the server about your data" signal.
- **Brand switching** (`setCurrentBrandId`, `useStore.ts:768-805`, spec 012b,
  super-admin only) re-derives a store for the new brand and rides the SAME
  `setCurrentStore` → `loadFromSupabase` path (`useStore.ts:791-793`). Two branches
  do NOT ride that path: (a) the **"All brands" (null) branch**
  (`useStore.ts:775-784`) clears `currentStore` to an empty-id placeholder WITHOUT
  a load and the consumer forces the section to "Brands"; (b) a **fresh brand with
  no stores** (`useStore.ts:794-804`) sets an empty-id placeholder WITHOUT a load.
  Any overlay must not stick in either no-load branch.
- **Shell topology** — the overlay's mount point. `ResponsiveCmdShell`
  (`src/screens/cmd/ResponsiveCmdShell.tsx`) has three breakpoint return branches
  (phone `:360`, tablet `:399`, desktop `:457`); ALL three share the same outer
  wrapper `<View testID="cmd-shell-root" style={{ flex: 1, backgroundColor: C.bg,
  overflow: 'hidden' }}>` that contains the TitleBar/MobileTopAppBar + the
  sidebar-and-body row. A single absolutely-positioned overlay child of that outer
  View covers the ENTIRE Cmd UI (title bar + sidebar + section) on every
  breakpoint with one insertion — matching the owner's "the entire screen."

> **Intentional design NOT to regress (read before filing a "why not just clear
> the slices" note).** Slices are deliberately kept on switch so the in-memory
> cache serves an instant re-render and empty states don't flash; only
> `reorderPayload` + `menuCapacity` are cleared (they'd otherwise flash the wrong
> store's cards). The fix here is a **visual gate** (a full-screen overlay for the
> switch window), NOT slice clearing. Do not add slice clears in this spec —
> that's an explicit non-goal (see Out of scope).

## Acceptance criteria

State + trigger (store):

- [ ] **AC-1.** A new admin-store field `switching: 'store' | 'brand' | null`
  (initial `null`) is added to the store. `setCurrentStore` sets `switching:
  'store'` **only when the target store id actually CHANGES and the previous
  `currentStore.id` is non-empty** — i.e. `store.id !== prev.id && prev.id !== ''`.
  A re-select of the already-active store (`store.id === prev.id`) does NOT set it
  (no overlay for a no-op switch). Initial login/boot (previous id empty) does NOT
  set it — the spec-055 skeletons own first load. The `__all__` redirect branch
  (`useStore.ts:752-762`) sets `switching: 'store'` under the same
  changed-and-prev-non-empty rule against the resolved `fallback` store before it
  calls `loadFromSupabase`.
- [ ] **AC-2 (trigger — brand).** `setCurrentBrandId` sets `switching: 'brand'` on
  the **brand-switch branch** (a non-null `brandId` that resolves to a store,
  `useStore.ts:786-793`) BEFORE it delegates to `setCurrentStore`. To keep the copy
  as "Switching brands…", the brand path must set `switching: 'brand'` in a way that
  is NOT overwritten to `'store'` by the `setCurrentStore` it calls (mechanism is
  the developer's — e.g. `setCurrentStore` only writes `switching: 'store'` when
  the current value is `null`, so a pre-set `'brand'` survives; or the brand path
  passes intent through). The observable: a brand switch shows the **brand** copy,
  not the store copy, for its whole window.

Clear (both paths, both outcomes):

- [ ] **AC-3.** `switching` is reset to `null` when `loadFromSupabase` completes,
  on BOTH the success and the error path (piggy-backing the existing `finally` at
  `useStore.ts:1212` that already resets `storeLoading`, or an equivalent
  single reset point that runs on every exit). An error during the switch load
  MUST NOT strand the overlay: `switching` returns to `null` exactly when
  `storeLoading` does. (Because it clears wherever `storeLoading` clears, no
  separate timeout is introduced — see AC-4.)
- [ ] **AC-4 (no permanent overlay / hang guard).** If `loadFromSupabase` is slow,
  the overlay persists only as long as the load — it is NOT permanent, because
  AC-3 ties the reset to the same exit point as `storeLoading`. **No standalone
  timeout is added** (a hung fetch is already bounded by the network layer and the
  `finally` reset; a bespoke timer would be new surface for negligible benefit).
  The two no-load brand branches (AC-5) prove the overlay cannot strand when there
  is no load to clear it.
- [ ] **AC-5 (no-load brand branches do not strand it).** The `setCurrentBrandId`
  **"All brands" (null) branch** (`useStore.ts:775-784`) and the **fresh-brand
  no-stores branch** (`useStore.ts:794-804`) do their work SYNCHRONOUSLY and do NOT
  call `loadFromSupabase`. These branches MUST leave `switching: null` (do not set
  it, or set-then-clear within the same synchronous action) so the overlay never
  sticks with no load to clear it. Recommended: simply do not set `switching` in
  either no-load branch (they complete synchronously; there is no stale-flash window
  to gate — the "All brands" branch immediately forces the Brands section, and the
  fresh-brand branch renders empty states for a store the operator is about to
  populate).

Overlay render (shell):

- [ ] **AC-6.** While `switching` is non-null, a **full-screen overlay** covers the
  ENTIRE Cmd UI content area — the TitleBar/MobileTopAppBar AND the sidebar AND the
  section body — on all three breakpoints (phone / tablet / desktop). It is an
  absolutely-positioned child of the shared outer `<View testID="cmd-shell-root">`
  in `ResponsiveCmdShell` (one insertion serves all three return branches). The
  overlay shows a spinner (`ActivityIndicator`) + centered localized copy. It sits
  above all Cmd UI chrome; the command palette (`CmdPaletteHost`, a sibling of the
  shell in `AuthedRoot`) is out of scope and need not be covered (it is dismissed /
  not open during a switch). Rendered when `switching !== null`; absent when
  `switching === null`.
- [ ] **AC-7 (copy variant per switch type).** The overlay copy is DISTINCT per
  switch type: `switching === 'store'` → "Switching stores…" (localized);
  `switching === 'brand'` → "Switching brands…" (localized). Both strings exist in
  all three admin locales (AC-9).
- [ ] **AC-8 (not on initial boot).** On first login / app boot (previous store id
  empty — the AC-1 guard is false), the overlay does NOT appear; the spec-055
  per-section skeletons handle first load into an empty cache unchanged. A jest
  test pins this (boot-with-empty-prev-id → `switching` stays `null` → no overlay).

i18n:

- [ ] **AC-9.** Two new strings — the store variant ("Switching stores…") and the
  brand variant ("Switching brands…") — exist in **all three admin locales**
  (`src/i18n/en.json`, `es.json`, `zh-CN.json`) under a sensible key (recommend the
  existing `common` block, e.g. `common.switchingStores` / `common.switchingBrands`
  — sibling to the existing `common.loading` at `en.json:85`), read via `useT`. No
  user-visible hardcoded English. es and zh-CN carry real translations (not English
  placeholders). **Admin catalog only** — the staff catalog
  (`src/screens/staff/i18n/*.json`) is NOT touched (staff switch stores via the
  StorePicker navigation screen, no stale-flash surface — see Out of scope).

Platform:

- [ ] **AC-10.** The overlay renders on react-native-web (Vercel) AND native (EAS)
  — it uses only cross-platform primitives (`View`, `ActivityIndicator`, `Text`,
  absolute positioning), no web-only CSS. Works at all three breakpoints.

## In scope

- A new admin-store field `switching: 'store' | 'brand' | null` on `AppState`
  (`src/types/index.ts`, sibling to `storeLoading`) + its initial value in the
  `useStore` initial-state literal (`useStore.ts:668` neighborhood).
- Setting `switching` in `setCurrentStore` (store variant, guarded per AC-1,
  including the `__all__` redirect branch) and in `setCurrentBrandId` (brand
  variant on the brand-switch branch per AC-2; NOT set in the two no-load branches
  per AC-5).
- Resetting `switching` to `null` at the single completion point of
  `loadFromSupabase` (the existing `finally`, alongside the `storeLoading` reset —
  AC-3), covering success and error.
- A full-screen overlay component (spinner + localized copy) mounted as an
  absolutely-positioned child of the shared outer `cmd-shell-root` View in
  `ResponsiveCmdShell`, gated on `switching !== null`, with per-type copy (AC-6/7).
- Two i18n strings ×3 admin locales (AC-9).
- Jest coverage on the matching track (named under Project-specific notes).

## Out of scope (explicitly)

- **Clearing any data slice on switch.** The slices intentionally persist across a
  switch (in-memory cache; only `reorderPayload` + `menuCapacity` are cleared,
  pre-existing). This spec adds a VISUAL GATE, not slice clearing — clearing would
  regress the cache and flash empty states, the exact behavior the overlay exists to
  avoid. Rationale: the owner asked to "load like 'switching stores…'," i.e. gate
  the view, not wipe state.
- **Changing `loadFromSupabase`'s fetch set / timing / the `storeLoading` toggle.**
  The load's behavior, the fields it fetches, the fire-and-forget `loadMenuCapacity`
  tail, and the `storeLoading` set/reset are untouched; `switching` piggy-backs the
  existing lifecycle. Rationale: minimal, additive change; no refetch churn.
- **A standalone overlay timeout / hang UI.** No bespoke timer; the overlay clears
  wherever `storeLoading` clears (AC-3/AC-4). Rationale: a hung fetch is already
  bounded by the network layer + the `finally` reset; a timer is new surface for
  negligible benefit. (If the owner later wants an explicit "still loading… retry"
  affordance for pathologically slow links, that is a separate spec.)
- **The staff app / StorePicker.** Staff switch stores via the StorePicker
  navigation screen (`src/screens/staff/screens/StorePicker.tsx`), which navigates
  to a fresh EOD screen rather than swapping data under a persistent chrome — there
  is no stale-flash surface, so no overlay is added there and the staff catalog is
  not touched. Rationale: the owner's recording and ask are the admin Cmd UI; the
  staff switch model has no stale window to gate.
- **Realtime changes.** Realtime-driven background reloads (the debounced
  `handleSync` in `CmdNavigator.tsx:62-68`) also call `loadFromSupabase` and DO
  toggle `storeLoading`, but they do NOT set `switching` (only the two switch
  entry points do). A background realtime refresh MUST NOT paint the overlay — it
  is not a store/brand switch. Rationale: the overlay is a switch affordance, not a
  general "data is loading" curtain; the spec-055 top-bar/skeletons already cover
  background loads. No `supabase_realtime` publication or channel change.
- **The command palette overlay / any modal stacking rework.** The palette is a
  sibling of the shell and is not open during a switch; z-order rework is not part
  of this. Rationale: scope containment.
- **The `app.json` slug, identity drift, and the repo-root spreadsheet** —
  untouched (CLAUDE.md load-bearing / DO-NOT-AUTO-FIX).

## Open questions resolved

The owner accepts recommended defaults unless flagged; this is a small, crisp ask,
so every question below is resolved with a default rather than blocking.

- **OQ-1 — Coverage: entire content area (sidebar + section) or just the section
  pane?** → **A: the ENTIRE content area** (TitleBar/MobileTopAppBar + sidebar +
  section body). The owner said "the entire screen." Mount as one absolutely-
  positioned child of the shared outer `cmd-shell-root` View so all three
  breakpoints get it from a single insertion (AC-6). Covering the sidebar too is
  correct: the sidebar's active-store affordances (and the TitleBar's store name)
  are part of what's mid-transition.
- **OQ-2 — Distinct copy for store vs brand switch?** → **A: yes, distinct.**
  "Switching stores…" vs "Switching brands…" keyed off `switching`'s value
  (AC-7). A brand switch that re-derives a store still shows the BRAND copy for its
  whole window (AC-2) — the operator initiated a brand change, so that's the
  accurate label.
- **OQ-3 — The "All brands" (null) branch and the fresh-brand no-stores branch:
  show the overlay or skip?** → **A: SKIP both.** Neither calls `loadFromSupabase`,
  so there is nothing to clear the overlay; they complete synchronously and have no
  stale-flash window to gate (the null branch immediately forces the Brands section;
  the fresh-brand branch shows empty states for a store the operator is about to
  populate). Do not set `switching` in either (AC-5).
- **OQ-4 — Hang/timeout guard?** → **A: no standalone timeout.** The overlay clears
  at the same `finally`-shaped exit point as `storeLoading` (success AND error), so
  a slow or failed load cannot strand it; a bespoke timer is unnecessary surface
  (AC-3/AC-4).
- **OQ-5 — Where does `switching` get reset — one point or per-branch?** → **A: one
  point**, the existing single completion point in `loadFromSupabase`
  (`useStore.ts:1212`, alongside the `storeLoading` reset). Every load path
  (store switch, brand switch, `__all__` redirect) funnels through it, so one reset
  covers all triggers and both outcomes. The two no-load brand branches are handled
  by simply never setting it (OQ-3).
- **OQ-6 — Does the brand path clobber its own `'brand'` value when it calls
  `setCurrentStore` (which would set `'store'`)?** → **A: the brand value must
  survive.** Mechanism is the developer's (recommend: `setCurrentStore` writes
  `switching: 'store'` only when the current value is `null`, so a pre-set `'brand'`
  is preserved; the `finally` reset zeroes it either way). Observable pinned in
  AC-2 (brand switch shows brand copy for its whole window).
- **OQ-7 — Backend surface?** → **A: NONE.** This is entirely a client-side store
  field + a shell overlay component + i18n. No migration, no RPC, no edge function,
  no RLS, no realtime publication change. The architect pass is expected to be a
  **fast contract ack** (confirm the store-lifecycle wiring, the single-reset-point
  invariant, and the no-strand branches — no data-model or API design needed). Per
  the house state machine the PM sets `READY_FOR_ARCH` (not straight to
  `READY_FOR_BUILD`); the architect confirms zero backend surface and hands to the
  frontend developer.

## Dependencies

- **Spec 055 (live)** — the per-section `ListSkeleton` first-load gates
  (`storeLoading && slice.length === 0`) that own FIRST load into an empty cache
  and that this overlay complements (the overlay owns the SWITCH window, where those
  skeletons don't fire because the slices are non-empty). No change to spec-055
  code; this spec relies on their division of labor and on the existing
  `storeLoading` field/lifecycle they use.
- **Spec 012b (live)** — the super-admin brand picker + `setCurrentBrandId`
  (`useStore.ts:768-805`) whose brand-switch branch this spec instruments (AC-2) and
  whose two no-load branches this spec must not strand (AC-5).
- **`src/store/useStore.ts`** — the `switching` field (initial literal near
  `:668`), the sets in `setCurrentStore` (`:747-765`, incl. the `__all__` branch)
  and `setCurrentBrandId` (`:768-805`), and the reset in `loadFromSupabase`'s
  `finally` (`:1212`). Reuses the existing `storeLoading` lifecycle verbatim.
- **`src/types/index.ts`** — add `switching: 'store' | 'brand' | null` to
  `AppState` (sibling to `storeLoading: boolean` at `:650`), so the setters/reset
  and the shell selector typecheck. (Same pattern as spec 024's `storeLoading`
  addition to `AppState`.)
- **`src/screens/cmd/ResponsiveCmdShell.tsx`** — the overlay mount as an
  absolutely-positioned child of the shared outer `cmd-shell-root` View (covers all
  three return branches, `:360` / `:399` / `:457`). Reads `switching` via a
  `useStore` selector and `useT` for copy.
- **A small overlay component** (spinner + centered localized text over a
  translucent scrim), cross-platform (`View` / `ActivityIndicator` / `Text` +
  absolute fill). May live inline in the shell or as a tiny component under
  `src/components/cmd/` — the frontend's call.
- **i18n catalogs** — `src/i18n/en.json` / `es.json` / `zh-CN.json` gain the two
  strings (recommend `common.switchingStores` / `common.switchingBrands`, sibling to
  `common.loading` at `en.json:85`). Read via `useT` (`src/hooks/useT.ts`), the
  admin catalog hook. Staff catalog NOT touched.

## Project-specific notes

- **Cmd UI section / legacy:** not a section at all — this is **shell-level chrome**
  in `ResponsiveCmdShell` (the Cmd UI wrapper that owns the TitleBar + sidebar +
  section body across breakpoints). No legacy admin surface (spec 025 deleted it).
- **Which app:** **admin Cmd UI only** — this repo's admin surface. The folded-in
  staff surface (`src/screens/staff/`, spec 063) is explicitly out of scope (staff
  switch via StorePicker navigation, no stale-flash window). No sibling-app (customer
  PWA) work.
- **Per-store or admin-global:** neither, really — this is a **client-only UI state
  field** (`switching`) driven by the store/brand switch actions. It reads no
  store-scoped data and touches no RLS. `auth_can_see_store()` is not involved.
- **Realtime channels touched:** **none — deliberate ABSENCE.** Realtime-driven
  background reloads (`handleSync`, `CmdNavigator.tsx:62-68`) share
  `loadFromSupabase` and toggle `storeLoading`, but they do NOT set `switching`, so
  the overlay never paints on a background refresh (Out of scope). No
  `supabase_realtime` publication change; the mid-session-publication `docker
  restart` gotcha does NOT apply. Flagged as an ABSENCE so the deploy checklist
  isn't padded.
- **Migrations needed:** **no.** Zero DB surface — client-only store field + shell
  overlay + i18n.
- **Edge functions touched:** **none.** No PostgREST/RPC/edge-function surface;
  purely frontend state + render.
- **Web/native scope:** **both.** Admin ships web (Vercel) + native (EAS); the
  overlay uses only cross-platform primitives (`View`, `ActivityIndicator`, `Text`,
  absolute positioning) — no web-only CSS or web-push surface. Renders at all three
  breakpoints from the single `cmd-shell-root` mount (AC-6/AC-10).
- **`app.json` slug:** untouched — this feature has no bearing on build identifiers;
  `slug` stays `towson-inventory` pending explicit approval.
- **No backend design expected (fast architect pass).** Per OQ-7 this is
  frontend-only (a store field + a shell-level overlay component + i18n). The
  architect pass should be a **fast contract ack** — confirm the store-lifecycle
  wiring (set on the two switch entry points, reset at the single
  `loadFromSupabase` completion point), the no-strand no-load brand branches, and
  the brand-copy-survives-setCurrentStore invariant (OQ-6) — with no data-model or
  API design. Following the house state machine, this spec is `READY_FOR_ARCH`
  (not `READY_FOR_BUILD`); the architect confirms zero backend surface and hands
  to the frontend developer.
- **Test tracks (spec 022):**
  - **jest** (the only track this feature needs): (a) the overlay renders while
    `switching !== null` and is absent when `switching === null` (AC-6); (b) the
    store-copy vs brand-copy variant keyed off `switching`'s value (AC-7); (c) NOT
    on initial boot — a switch where the previous store id is empty leaves
    `switching` null → no overlay (AC-1/AC-8); (d) clears on load completion,
    including the error path — `switching` returns to null wherever `storeLoading`
    does (AC-3); (e) the "All brands" null branch and the fresh-brand no-stores
    branch do not strand it (AC-5). Store-action tests (setters + reset transitions)
    can exercise `useStore` directly; the render tests mount the overlay (or the
    shell) with a mocked `switching` state, mirroring the spec-055 `VendorsSection`
    skeleton tests' `mockState`-mutation pattern.
  - **pgTAP:** none — zero DB surface.
  - **shell smoke:** none anticipated.

## Design note (architect — fast contract ack)

**Verdict:** frontend-only. Wiring points all verified in code. Zero backend
surface. Hand to `frontend-developer`.

### Backend surface — NONE (reviewer fan-out skips the DB tracks)

No migration, no RPC, no PostgREST view/table change, no edge function, no
`verify_jwt`/service-token change, no RLS policy (`auth_is_admin()` /
`auth_can_see_store()` untouched), no `supabase_realtime` publication or
channel change. The realtime-publication `docker restart` gotcha does **not**
apply. `switching` is a client-only Zustand UI field that reads no store-scoped
data. `src/lib/db.ts` is not touched (no helper added/changed). The
post-implementation reviewer set should skip pgTAP, migration-drift, and RLS
review entirely; this is a `code-reviewer` + `test-engineer` (+ optionally
`security-auditor` for the render path) review, not an architect post-impl pass.

### Wiring verification (against current code)

- `setCurrentStore` `:747-765` — verified: `set({ currentStore: store })` then
  `get().loadFromSupabase(store.id)` (`:763-764`); the `__all__` redirect
  (`:752-762`) resolves a `fallback`, `set({ currentStore: fallback })`, then
  loads. **Neither path reads `prev` today** — the AC-1 guard needs
  `const prev = get().currentStore;` captured at the top of the action, before
  the `__all__` branch, so both the normal set and the `__all__` set can compare
  against it.
- `setCurrentBrandId` `:768-805` — verified: brand-switch branch delegates via
  `get().setCurrentStore(newStore)` at `:793`; the two no-load branches are the
  null/"All brands" branch (`:775-784`) and the fresh-brand-no-stores branch
  (`:794-804`). Both `set(...)` synchronously and `return` without a load — they
  must not set `switching`.
- `loadFromSupabase` — `set({ storeLoading: true })` at `:1101`; single reset
  `finally { set({ storeLoading: false }) }` at `:1211-1213`. Confirmed the only
  reset point on both success and error. `switching: null` piggy-backs the same
  `set` — `set({ storeLoading: false, switching: null })`.
- `ResponsiveCmdShell` — verified three return branches (phone `:360`, tablet
  `:399`, desktop `:457`) each open with the identical
  `<View testID="cmd-shell-root" style={{ flex: 1, backgroundColor: C.bg, overflow: 'hidden' }}>`.
  One absolutely-positioned overlay child of that View, inserted once per
  branch, covers TitleBar/MobileTopAppBar + sidebar + body. (RN has no shared
  wrapper across the three `return`s, so the overlay element is added inside each
  of the three roots — three insertions of the same one-liner, not one. Call this
  out so the dev doesn't hunt for a single shared parent that doesn't exist.)
- i18n `common` block already carries `loading` (`en.json:85`), `saving`
  (`:86`) — the two new keys slot in as siblings.
- `src/components/cmd/` confirmed as the loading-affordance home (`ListSkeleton`,
  `GridSkeleton`, `LoadingBar` already live there) — overlay component belongs
  there.

Minor citation nits (non-blocking): the fresh-brand branch is `:794-804` (spec
body says `:794-804` in AC-5 — consistent); AC-2 cites the brand-switch branch
as `:786-793`, accurate for the delegation up to the `setCurrentStore` call.

### Contract decisions (locked)

1. **State field.** `switching: 'store' | 'brand' | null`, initial `null`.
   Add to `AppState` in `src/types/index.ts` as a sibling of
   `storeLoading: boolean` (`:650`); add the initial `switching: null` to the
   `useStore` initial-state literal next to `storeLoading: false` (`:668`).
   Keep the literal union (not a `boolean` + separate label) so the copy variant
   is derived from one field (AC-7).

2. **`setCurrentStore` transition — ESCALATE, never downgrade (OQ-6 invariant).**
   Capture `const prev = get().currentStore;` first. Compute
   `const isSwitch = store.id !== prev.id && prev.id !== '';` (for the `__all__`
   branch, compare `fallback.id` against `prev.id` the same way). Then the ONLY
   write to `switching` in this action is a guarded escalation:
   `if (isSwitch && get().switching === null) set({ switching: 'store' });`.
   The `=== null` guard is load-bearing — it is precisely the mechanism that lets
   a `'brand'` value pre-set by `setCurrentBrandId` survive the internal
   `setCurrentStore(newStore)` call. `setCurrentStore` may set `null → 'store'`
   but must NEVER write `'brand' → 'store'`. Do the `set({ switching })`
   **before** `loadFromSupabase(...)` so the overlay paints on the same tick as
   the fetch kickoff. (Do not fold `switching` into the existing
   `set({ currentStore })` unconditionally — that would set it on no-op
   re-selects and on boot, violating AC-1/AC-8.)

3. **`setCurrentBrandId` transition.** On the brand-switch branch only
   (`:786-793`, non-null `brandId` that resolves to `newStore`), set
   `switching: 'brand'` **before** the `get().setCurrentStore(newStore)` call.
   Because `setCurrentStore` only escalates from `null` (decision 2), the
   `'brand'` value is preserved through the delegation → overlay shows the brand
   copy for the whole window (AC-2/OQ-6). Do **not** set `switching` in the null
   branch (`:775-784`) or the fresh-brand-no-stores branch (`:794-804`) — they
   have no load to clear it (AC-5). Belt-and-suspenders is unnecessary: since
   neither branch sets it and it starts `null`, it stays `null`; do not add a
   redundant `set({ switching: null })` there.

4. **Reset — single point (OQ-5).** In `loadFromSupabase`'s `finally`
   (`:1211-1213`), change to `set({ storeLoading: false, switching: null })`.
   One reset covers store-switch, brand-switch, and `__all__`-redirect loads on
   both success and error (AC-3/AC-4). No standalone timer (AC-4/OQ-4).

5. **Overlay unmount condition.** Gate on **`switching !== null` ALONE**, not
   `switching && storeLoading`. Rationale: `switching` is only ever set on the
   two switch entry points and is only ever cleared in the same `set()` that
   clears `storeLoading`, so the two are cleared atomically — an
   `&& storeLoading` conjunction buys nothing but adds a way to desync (e.g. if a
   future refactor moves the `storeLoading` reset). It also keeps the overlay a
   pure switch affordance: a background realtime reload toggles `storeLoading`
   but never `switching`, so `switching !== null` correctly stays dark during
   realtime refreshes (Out-of-scope realtime rule) — whereas keying partly off
   `storeLoading` invites confusion about that boundary. Single-field gate,
   single-field reset.

6. **Overlay component — home + shape + testIDs.** New component
   `src/components/cmd/StoreSwitchOverlay.tsx` (peer to `ListSkeleton` /
   `LoadingBar`). Props: `{ mode: 'store' | 'brand' }` (the non-null narrowing of
   `switching`) — keep it dumb/presentational; the shell does the
   `switching !== null` gate and passes the narrowed value, so the component
   itself needs no store access (mirrors the presentational skeleton components
   and keeps it trivially unit-testable per the spec-055 pattern). Render:
   absolute-fill `View` (`StyleSheet.absoluteFillObject`) with a translucent
   scrim over `C.bg`, centered `ActivityIndicator` + `Text` (copy from
   `useT` — see §7; the shell may pass the resolved string OR the component may
   call `useT` itself, dev's call, but if the component reads `useT` the render
   test must wrap it in the i18n provider). `testID="store-switch-overlay"` on
   the root; `testID="store-switch-overlay-label"` on the `Text`. Mount as the
   last child inside each of the three `cmd-shell-root` Views (after the
   title-bar-and-body block) so it paints on top; z-order is document-order in
   RN, no `zIndex` needed, but an explicit `zIndex`/`elevation` is fine as
   defense.

7. **Copy (AC-7/AC-9).** Two keys in the `common` block, siblings of
   `common.loading`: `common.switchingStores` ("Switching stores…") and
   `common.switchingBrands` ("Switching brands…"), in all three admin catalogs
   (`en.json`, `es.json`, `zh-CN.json`) with real es/zh-CN translations (not
   English placeholders). Read via `useT`. Map `mode === 'store' →
   common.switchingStores`, `mode === 'brand' → common.switchingBrands`. Staff
   catalog untouched. Suggested translations (dev may refine with the project's
   existing tone): es `"Cambiando de tienda…"` / `"Cambiando de marca…"`;
   zh-CN `"正在切换门店…"` / `"正在切换品牌…"`.

8. **Accessibility (cheap, per the ask).** On the overlay root View, set
   `accessibilityRole="alert"` and `accessibilityLiveRegion="assertive"` (RN maps
   the latter to `aria-live="assertive"` on web; on iOS the `alert` role
   announces on mount) plus `accessibilityLabel={<resolved copy>}` so screen
   readers announce "Switching stores…/brands…" when the overlay appears. This is
   a two-prop addition on the already-required root View — no new surface, and it
   satisfies "announce via accessibilityRole/liveRegion cheaply." No focus-trap /
   modal-role work (out of scope; the palette stacking is untouched).

### Jest cases the FE dev must pin (the only test track — AC-9 test tracks)

Store-action tests exercise `useStore` directly; render tests mount
`StoreSwitchOverlay` (or the shell) with a mocked `switching`, mirroring the
spec-055 `VendorsSection` `mockState`-mutation pattern.

- **T1 — renders on store switch.** `setCurrentStore(storeB)` from a state where
  `currentStore.id = storeA` (non-empty) sets `switching === 'store'`; overlay
  (or a `switching !== null` selector) is truthy. Pins AC-1 + AC-6.
- **T2 — absent on boot.** `setCurrentStore(storeA)` from initial state where
  `currentStore.id === ''` (empty prev) leaves `switching === null`; overlay
  absent. Pins AC-1/AC-8 (the guard).
- **T3 — no overlay on no-op re-select.** `setCurrentStore(storeA)` when
  `currentStore.id === storeA.id` leaves `switching === null`. Pins the AC-1
  `store.id !== prev.id` clause.
- **T4 — clears on load completion (success).** Drive `loadFromSupabase` to
  resolve (mock `db.fetch*`); assert `switching` returns to `null` in the same
  `finally` that clears `storeLoading`. Pins AC-3.
- **T5 — clears on load ERROR.** Make a fetch in `loadFromSupabase` reject;
  assert `switching === null` after (error path must not strand). Pins
  AC-3/AC-4. (This is the case that guards against a hung overlay.)
- **T6 — brand copy variant + survives delegation.** `setCurrentBrandId(brandB)`
  where `brandB` resolves to a store sets `switching === 'brand'` and it STAYS
  `'brand'` after the internal `setCurrentStore` runs (assert the value is
  `'brand'`, not `'store'`) — the escalation-not-downgrade invariant. Then the
  overlay renders the brand copy (`common.switchingBrands`). Pins AC-2/AC-7/OQ-6.
- **T7 — escalation-not-downgrade unit.** Directly: set state `switching:
  'brand'`, call `setCurrentStore(storeB)` (a real switch), assert `switching`
  is still `'brand'` (the `=== null` guard held). Complements T6 at the setter
  level. Pins OQ-6.
- **T8 — no-load brand branches don't strand.** (a) `setCurrentBrandId(null)`
  ("All brands") and (b) `setCurrentBrandId(freshBrandWithNoStores)` each leave
  `switching === null` (never set → nothing to clear). Pins AC-5.
- **T9 — render gate is single-field.** Overlay present iff `switching !== null`
  regardless of `storeLoading` (mock `switching: 'store', storeLoading: false` →
  still rendered; `switching: null, storeLoading: true` → absent). Pins decision
  5 (unmount tied to `switching` alone) and the realtime-doesn't-paint boundary.
- **T10 — copy per mode (render).** `mode='store'` renders "Switching stores…"
  string; `mode='brand'` renders "Switching brands…". Pins AC-7 at the component.

Optional but cheap: a locale-parity assertion that both new keys exist in
`es.json` and `zh-CN.json` (if the repo has an existing i18n-parity test, extend
it; otherwise a small `toHaveProperty` check). Pins AC-9's "no English
placeholder" intent.

## Files changed

Implementation (frontend-only, per the Design note):

- `src/types/index.ts` — added `switching: 'store' | 'brand' | null` to
  `AppState` as a sibling of `storeLoading` (with a doc comment covering the
  escalate-not-downgrade + single-reset invariants). [AC-1 contract]
- `src/store/useStore.ts` —
  - initial-state literal: `switching: null` next to `storeLoading: false`.
  - `setCurrentStore`: captured `const prev = get().currentStore;` at the top;
    set `switching: 'store'` under the `store.id !== prev.id && prev.id !== ''
    && get().switching === null` guard in BOTH the `__all__` fallback branch
    (against `fallback.id`) and the normal branch (against `store.id`), before
    `loadFromSupabase`. [AC-1]
  - `setCurrentBrandId`: set `switching: 'brand'` in the brand-switch branch
    (resolved `newStore`) BEFORE delegating to `setCurrentStore`; the two
    no-load branches ("All brands" null + fresh-brand-no-stores) are left
    untouched so they never strand the overlay. [AC-2, AC-5]
  - `loadFromSupabase`: `finally` now `set({ storeLoading: false, switching:
    null })` — single reset point, success AND error. [AC-3, AC-4]
- `src/components/cmd/StoreSwitchOverlay.tsx` — NEW presentational overlay
  (peer to `ListSkeleton` / `LoadingBar`). Props `{ mode: 'store' | 'brand' }`;
  absolute-fill opaque `C.bg` cover with centered `ActivityIndicator` +
  localized `Text`; `testID="store-switch-overlay"` /
  `store-switch-overlay-label`; `accessibilityRole="alert"` +
  `accessibilityLiveRegion="assertive"` + resolved `accessibilityLabel`; theme
  via `useCmdColors` (`C.fg` text, `C.accent` spinner — no `#000`-on-accent);
  copy via `useT`. Cross-platform primitives only. [AC-6, AC-7, AC-8, AC-10]
- `src/screens/cmd/ResponsiveCmdShell.tsx` — read `switching` via a `useStore`
  selector; built `const switchOverlay = switching !== null ?
  <StoreSwitchOverlay mode={switching} /> : null` and inserted `{switchOverlay}`
  as the LAST child of all three `cmd-shell-root` Views (phone / tablet /
  desktop — three insertions, no shared parent). Single-field gate. [AC-6]
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — added
  `common.switchingStores` / `common.switchingBrands` (siblings of
  `common.saving`) with real translations: en "Switching stores…" / "Switching
  brands…"; es "Cambiando de tienda…" / "Cambiando de marca…"; zh-CN
  "正在切换门店…" / "正在切换品牌…". [AC-9]

Tests (jest — the only track this feature needs):

- `src/store/useStore.switching.test.ts` — NEW (node project). T1 (renders on
  store switch), T2 (absent on boot / empty prev), T3 + T3b (no-op re-select /
  `__all__` redirect), T4 (clears on load success), T5 (clears on load ERROR),
  T6 (brand copy survives the delegation), T7 (escalate-not-downgrade unit),
  T8a/T8b (no-load brand branches don't strand). 10 tests.
- `src/components/cmd/StoreSwitchOverlay.test.tsx` — NEW (jsdom project). T10
  (copy per mode, both directions), testID mount contract, a11y announce
  props, and T9 (single-field render gate — overlay iff `switching !== null`
  regardless of `storeLoading`). 6 tests.
- AC-9 locale parity ("no English placeholder" / keys exist in all three
  catalogs) is auto-covered by the pre-existing `src/i18n/i18n.test.ts`
  identical-key-set assertion (adding the two keys to all three catalogs makes
  it fail if any is missing) — no new parity test added.

## Verification

- `npx tsc --noEmit` → exit 0.
- `npx tsc -p tsconfig.test.json --noEmit` → exit 0.
- `npx jest` (full) → 87 suites / 966 tests passing (new suites: 16 tests — 10 store + 6 overlay; the original 20 claim was a miscount, corrected per the test-engineer review).
  The `[Supabase] loadFromSupabase failed: rls denied` console line in T5 is
  the intended error path under test (the load rejects; the `finally` still
  clears `switching`).
- Browser pass: NOT run by the implementing agent — no `preview_*` MCP tools
  were available in this environment. Main Claude should exercise a real store
  switch (and a super-admin brand switch) in the browser preview: confirm the
  full-screen "Switching stores…/brands…" takeover paints over TitleBar +
  sidebar + section for the load window and clears on completion, at the 1100px
  breakpoint boundary and in dark + light mode.
