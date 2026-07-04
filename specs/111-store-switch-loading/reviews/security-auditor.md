# Security audit for spec 111

Full-screen "Switching stores…/brands…" overlay on store/brand switch in the admin
Cmd UI. Frontend-only per the spec's Design note (OQ-7). I verified that claim
against the actual diff surface rather than taking it on faith.

## Verdict

Clean. **0 Critical, 0 Should-fix.** The spec's "ZERO backend surface" claim holds
under inspection: this touches no auth, RLS, data-access, secret, dependency, or
platform-native path. Nothing here BLOCKS.

## Diff surface (what I inspected)

Working-tree diff vs `HEAD` (spec is `READY_FOR_REVIEW`, changes unstaged):

- `src/types/index.ts` — adds `switching: 'store' | 'brand' | null` to `AppState` (+ doc comment).
- `src/store/useStore.ts` — initial `switching: null`; guarded sets in `setCurrentStore`
  (normal + `__all__` branch) and `setCurrentBrandId` (brand-switch branch only); reset
  folded into `loadFromSupabase`'s existing `finally`.
- `src/components/cmd/StoreSwitchOverlay.tsx` — NEW presentational overlay.
- `src/screens/cmd/ResponsiveCmdShell.tsx` — reads `switching` selector; mounts overlay
  as last child of the three `cmd-shell-root` Views.
- `src/i18n/{en,es,zh-CN}.json` — two `common.*` string keys each.
- `src/store/useStore.switching.test.ts`, `src/components/cmd/StoreSwitchOverlay.test.tsx` — NEW tests.

## Claim-by-claim verification (the five asks)

### 1. No auth/RLS/data-access path touched — VERIFIED

- `git diff --stat HEAD -- src/lib/db.ts` → **empty** (untouched). No helper added/changed.
- `git diff --stat HEAD -- src/screens/staff/` → **empty** (staff subtree untouched).
- `git diff --stat HEAD -- supabase/` → **empty** (no migration, RPC, edge function,
  `config.toml`/`verify_jwt`, RLS policy, or `supabase_realtime` publication change).
- `setCurrentStore`/`setCurrentBrandId` still call the identical
  `get().loadFromSupabase(store.id)` with the same per-store `store.id` scoping
  (`useStore.ts` diff, hunks at the `:749`/`:766`/`:810` neighborhoods). The only
  additions are guarded `set({ switching: ... })` calls on a client-only Zustand field
  — no change to the fetch set, the store id passed, or the load lifecycle. The refetch's
  rows remain RLS-scoped **server-side** by `auth_can_see_store()`, entirely unaffected.
- Grep of added (`+`) lines across `useStore.ts` + `ResponsiveCmdShell.tsx` for
  `supabase|fetch(|.rpc(|.from(|http|require(|process.env|EXPO_PUBLIC|Deno.env`: the only
  hits are three **comment** lines containing the prose word "loadFromSupabase" — zero new
  calls, zero new env/secret reads.

### 2. No data-leakage vector — VERIFIED

- `StoreSwitchOverlay.tsx:39` renders `label`, sourced solely from `useT('common.switchingStores'|'.switchingBrands')`
  — a localized **static** string. No store data, inventory rows, count numbers, user
  identity, or any interpolated caller/store content reaches the overlay. The component
  takes one prop (`mode: 'store' | 'brand'`) which selects between two constant keys.
- Output sink is React Native `<Text>` (`:67-72`) and `accessibilityLabel` (`:64`) — not an
  HTML sink. `escapeHtml`/XSS concerns are N/A on native primitives, and even so there is
  no dynamic content to escape. (The spec's edge-function `escapeHtml`/Resend rule does not
  apply — no HTML-serving surface here.)
- The overlay's job is to **hide** the (already-in-memory, same-JWT-fetched) prior store's
  data during the switch window. It reveals nothing; it only draws an opaque `C.bg` fill
  over the existing chrome. No exfiltration path.

### 3. Switch guard is not an authorization bypass — VERIFIED

- `switching` is never read as a security boundary. It gates exactly one thing: whether an
  opaque cosmetic `<View>` is mounted (`ResponsiveCmdShell.tsx` `switchOverlay = switching !== null ? … : null`).
  No branch keys data access, role, store visibility, or navigation off it.
- Switching stores still funnels through `loadFromSupabase`, whose PostgREST/RPC reads are
  RLS-scoped server-side. A client that forced `switching` to any value (or suppressed the
  overlay entirely) gains nothing — the server still returns only rows the JWT may see. The
  overlay is purely presentational; defeating it degrades UX (stale-flash returns), not authz.
- This is not the client-side `useRole()` anti-pattern the threat model warns about — no
  security decision is derived from client state here.

### 4. No new dependency / dynamic code / web-only-on-native — VERIFIED

- `git diff --stat HEAD -- package.json package-lock.json` → **empty**. No dependency added.
- `StoreSwitchOverlay.tsx` imports only: `react`, four `react-native` primitives
  (`View`, `ActivityIndicator`, `Text`, `StyleSheet`), and two **pre-existing** local modules
  (`../../theme/colors` → `useCmdColors`, `../../theme/typography` → `Type`, `../../hooks/useT`).
  `git diff --stat` on those three module files → empty (untouched, not newly created).
- No dynamic code: no `eval`, `new Function`, or new `import()`/`require()` in the overlay or
  the diffed store code (the only `import()` in `useStore.ts` is the pre-existing webPush
  lazy-import at `:751`, outside this diff's additions).
- No web-only API leaking to native: grep of the overlay for
  `Platform|window.|document.|localStorage|navigator|className|Dimensions|useWindowDimensions`
  → **none**. Cross-platform primitives + `StyleSheet.absoluteFillObject` only (AC-10 holds).

### 5. npm audit — SKIPPED (no package.json change)

`package.json` and `package-lock.json` are both untouched (stat empty). No dependency
surface changed, so `npm audit` is not warranted.

## Test files — no security regression

Both new test files use `jest.mock('../lib/db', …)` and `jest.mock('../lib/supabase', …)`
with `jest.fn()` stubs (`useStore.switching.test.ts:20-73`) — no real network IO, no live
Supabase client, no secret/env reads (`process.env`/`EXPO_PUBLIC`/`Deno` grep → none). The
error-path test (T5) deliberately rejects a mocked fetch to prove the `finally` clears
`switching`; the resulting `[Supabase] loadFromSupabase failed` console line is the
intended assertion target, not a leak — it logs `e?.message`, no row data.

## Findings

### Critical (BLOCKS merge)
None.

### Should-fix
None.

### Nits
- None security-relevant. (The overlay is opaque `C.bg` rather than a translucent scrim
  described in some spec prose — this is a UX/visual-parity note for the code-reviewer, not
  a security concern; opaque is arguably *stronger* for the stale-data-hiding goal.)

### Dependencies
No package.json changes — `npm audit` skipped.
