# Security audit for spec 112

Frontend-only Inventory table + detail-on-demand. Audit scope per the request:
verify zero backend surface (OQ-8), no data leakage, correct web-only Esc
listener lifecycle, no new dependency / dynamic code / HTML sink, and `npm audit`
only if `package.json` changed.

**Verdict: no Critical, no Should-fix. Two Nits (both informational).**
This is a pure client-side layout change over data already loaded by the
existing RLS-scoped path. No auth, authz, secrets, validation, or dependency
surface is touched.

## Critical (BLOCKS merge)

None.

## Should-fix (before deploy)

None.

## Nits

- `src/screens/cmd/InventoryDesktopLayout.tsx:188-196` — the web-only Esc
  listener is correct (added on `keydown`, removed in the effect cleanup, keyed
  on `[selectedName]`, gated by `Platform.OS !== 'web'` early-return so native
  never touches `window`/`KeyboardEvent`). Informational only: the effect
  re-subscribes on every `selectedName` change (open → row-swap → close), which
  is intentional and correct — it keeps the listener installed only while the
  pane is open. No leak; no action needed. Flagging solely because the audit
  request called out this listener as a thing to check, and it passes.
- The spec's ★ single-cost-definition rule is satisfied for the in-scope
  surface (`items.tsv` table cell + its `DetailPane` header both consume
  `itemMoney.ts` — see below). Pre-existing `currentStock * costPerUnit *
  subUnitSize` expressions survive in five OTHER files
  (`ReconciliationSection.tsx:271,356`, `RecipesSection.tsx:681`,
  `EODCountSection.tsx:1793`, `store/useStore.ts:2951`, and the orphaned dead
  `ItemDetailScreen.tsx:97`). None are touched by this diff and all are
  different surfaces outside spec 112's ★ scope (which binds only the
  `items.tsv` table + its detail header). Not a finding for this spec —
  noted so the reviewer knows the greps were run and the duplicates are
  pre-existing, not introduced here. (Also not my lane — this is a
  code-reviewer/architect de-dup observation, not a security issue.)

## Verification against the audit request

1. **No auth/RLS/data-access path touched.** `git status --porcelain` shows the
   only tracked changes are `src/i18n/{en,es,zh-CN}.json` and
   `src/screens/cmd/InventoryDesktopLayout.tsx`; new files are
   `src/screens/cmd/lib/itemMoney.ts`, `src/components/cmd/InventoryTable.tsx`,
   and three test files. `git status --porcelain -- src/lib/db.ts supabase/
   src/screens/staff/ package.json package-lock.json yarn.lock` returns **empty**
   — all untouched. No new `supabase` / `createClient` / `.rpc(` / `.from(` /
   `fetch(` import or call is introduced anywhere in the diff (grep of the `+`
   lines is clean; the only `supabase` string hits in new files are a comment
   "touches no Supabase" in `itemMoney.ts:21` and a test comment in
   `InventoryDesktopLayout.test.tsx:149` explaining why it mocks out `db.ts`).
   The table renders `items`/`vendors` already loaded into the Zustand store by
   the existing RLS-scoped `loadFromSupabase`; the `items.tsv` view is already
   filtered to `currentStore.id`. **OQ-8's zero-backend claim holds.**

2. **No data leakage.** The eight columns surface fields already present on the
   in-memory `inventory` slice (name, on-hand/par, status, `costPerUnit`,
   stock value, `vendorId`→name, category, `lastUpdatedAt`) — the same
   same-JWT, same-store rows the always-visible detail pane already displayed
   (cost, vendor, stock value were in the detail header at `:449`/`:456-459`
   pre-spec). The `stockValue` / `formatCostPerEach` / `costPerEachLabel`
   helpers in `itemMoney.ts` are pure functions over already-mapped fields;
   nothing new crosses a store or JWT boundary. No error message, log, or
   payload change — grep of the layout diff for `console.` / `notifyBackendError`
   / `token` / `secret` / `password` / `apikey` on `+` lines is clean.

3. **Web-only Esc listener — correct, no leak, native-safe.**
   `InventoryDesktopLayout.tsx:188-196`: `Platform.OS !== 'web'` early-return
   means the listener is never installed and `window`/`KeyboardEvent` are never
   referenced on native. `window.addEventListener('keydown', onKey)` is paired
   with `return () => window.removeEventListener('keydown', onKey)` in the same
   effect (cleanup on close/row-change/unmount). A full grep confirms
   `window`/`document`/`KeyboardEvent`/`localStorage`/`navigator` appear NOWHERE
   in the file outside this guarded effect (the only other hit, line 186, is a
   comment). No render-path web-API reference → no native-bundle leak.
   `InventoryTable.tsx` and `itemMoney.ts` reference no web API at all.

4. **No new dependency, no dynamic code, no HTML sink.** `git diff --stat --
   package.json package-lock.json` is empty — no dependency change. Imports
   added to the layout are all `react-native` core primitives (`Platform`,
   `useWindowDimensions`, `ScrollView`, `FlatList`) plus intra-repo modules
   (`InventoryTable`, `useIsDesktop`, `itemMoney`). Grep for
   `dangerouslySetInnerHTML` / `innerHTML` / `eval(` / `new Function` / `__html`
   across all new + changed files returns **none**. `InventoryTable` renders
   with RN `View` / `Text` / `TouchableOpacity` / `FlatList` only — no HTML sink,
   no interpolation into a markup string. i18n additions are five string keys
   per catalog under `section.inventory.*` (`nameCol`, `stockValueCol`,
   `categoryCol`, `lastCountedCol`, `closeDetailAria`) with real es/zh-CN
   translations — data only, no logic.

5. **★ single cost-definition (defense-in-depth check).** Both in-scope
   consumers — the `DetailPane` header (`InventoryDesktopLayout.tsx:613-617`,
   `:625`) and the table cells (`InventoryTable.tsx:172,175,185`) — call the
   `itemMoney.ts` helpers. Exactly one definition of the stock-value math
   (`currentStock * (costPerUnit || 0) * (subUnitSize || 1)`) and the cost
   string exists, in `itemMoney.ts`. No `.toFixed()` was added to the layout
   diff (the money strings moved INTO the helper). This is the architect's/
   code-reviewer's ★ invariant, not a security finding — noted only because a
   silent cost-basis drift is a data-integrity concern adjacent to my lane, and
   it is clean.

### Dependencies

No `package.json` / lockfile changes — `npm audit` skipped (correctly not run,
per the request's step 5).

## Resolution note (main Claude — 2026-07-04)

No security findings to action (0/0/2 informational). The post-review fixes
(store-switch effect scoping, chromeW clamp, added jest coverage) touch no
auth/data path. The observed pre-existing duplicate money-math in five
out-of-scope files is recorded on the cleanup backlog.
