# Spec 014: Cmd UI — Fetch sales from Breadbot

Status: READY_FOR_REVIEW

## User story
As a store manager for a Breadbot-served store (Frederick, Charles, Towson),
I want to pull today's sales (or a recent date range) directly from the
Breadbot API from inside the new Cmd UI POS Imports section, so that I do not
have to drop back to the legacy admin screen to do a manual fetch / backfill
when I am running with `EXPO_PUBLIC_NEW_UI=true`.

## Acceptance criteria

### Visibility / placement
- [ ] In `src/screens/cmd/sections/POSImportsSection.tsx`, a third top-bar
  action button labelled `FETCH BREADBOT` appears alongside `UPLOAD CSV`
  and `RUN IMPORT` when `currentStore.name` is in the
  `BREADBOT_STORES` set (`{Frederick, Charles, Towson}`). The set must be
  defined in the Cmd-side file with a comment pointing at the edge function
  `STORE_MAP` as the source of truth (mirrors the legacy file's comment at
  `src/screens/POSImportScreen.tsx:22-25`).
- [ ] When `currentStore.name` is NOT in the set, the button is fully hidden
  (not just disabled). `UPLOAD CSV` and `RUN IMPORT` are unchanged.
- [ ] No additional role gate. Any user who already passes the per-store
  `auth_can_see_store()` RLS check sees the button — matches legacy.
- [ ] The empty-state copy in `imports.tsx` is updated for Breadbot stores so
  it mentions "or fetch from Breadbot" in addition to the existing
  Toast/Square/Clover CSV hint. Non-Breadbot stores see today's copy
  unchanged.
- [ ] `sources.tsx` is NOT touched. Its `NOT YET WIRED` placeholder for
  multi-connector roadmap stays as-is.

### Single-date fetch
- [ ] Clicking `FETCH BREADBOT` opens a Cmd-styled modal built on the same
  primitives `UploadCsvModal` / `RunImportModal` use (centered overlay,
  `useCmdColors()`, `Type.*`, `mono()` / `sans()`, `CmdRadius`,
  `react-native` `Modal`, Escape-to-close keyboard handler on web).
- [ ] Modal opens with a single/range tab strip (matches legacy
  `POSImportScreen.tsx:785-801`); single is the default.
- [ ] Single tab has a date input defaulting to today (`todayISO()` helper),
  a `FETCH` action, and lead text noting "today is usually incomplete until
  Breadbot's 4 AM rollover" (mirrors legacy comment at line 145).
- [ ] On `FETCH`, the modal calls `fetchBreadbotSales(currentStore.name,
  date)` from `src/lib/db.ts` (do not rewrite the helper).
- [ ] If the response has zero rows, an info toast fires (`No sales returned
  — Breadbot had nothing for {storeName} on {date}.`) and the modal stays
  open; no diff is staged.
- [ ] On non-zero rows, the rows are mapped to the existing
  `csvImport.computeDiff` input shape (the existing CSV pipeline already
  drives the diff → `RunImportModal` → `commitImport` flow). Filename is
  set to `Breadbot · {storeName} · {date}` (matches legacy).
- [ ] `setPendingDiff(diff)` and `setPendingFilename(filename)` are wired so
  that closing the fetch modal opens `RunImportModal` exactly the way the
  CSV path does today (`POSImportsSection.tsx:166-172`).
- [ ] On error, an error toast surfaces the upstream message via
  `e?.message` (matches legacy `POSImportScreen.tsx:226-232`). Modal stays
  open so the user can retry or cancel.
- [ ] While fetching, the `FETCH` button is disabled and shows a spinner /
  busy state in Cmd palette (no `ActivityIndicator` import unless required;
  reuse the `mono()`-styled "FETCHING…" treatment used elsewhere in the
  Cmd UI).

### Range backfill
- [ ] Range tab has start-date + end-date inputs. Defaults: start = today
  − 7 days, end = yesterday (matches legacy `POSImportScreen.tsx:146-155`).
- [ ] Range cap of 30 days enforced — re-export the legacy
  `BACKFILL_MAX_DAYS = 30` constant (or define in a shared util). Inputs
  outside this range trigger a Toast error matching the legacy copy
  (`Range too large (N days) — Max 30 days per backfill.`).
- [ ] Inverted range (start > end) produces an "Invalid range" toast and
  blocks submission.
- [ ] On `BACKFILL RANGE`, the section iterates days using the legacy
  `enumerateDates(start, end)` UTC helper. Throttle between days
  `BACKFILL_THROTTLE_MS = 200` ms (~5 req/s, well under Breadbot's 60/min
  cap). The constants are ported as-is from the legacy file (lines 47–63).
- [ ] Per-day flow inside the loop matches legacy
  `runBackfill` (`POSImportScreen.tsx:380-463`):
  1. `hasPOSImportForDate(storeId, date)` — if true, mark `skipped: already
     imported`.
  2. `fetchBreadbotSales(storeName, date)` — if zero rows, mark
     `skipped: no data`.
  3. Build `items` via `matchRecipe(rawItemName, recipes,
     posRecipeAliases)`. Match-against-raw, write-raw — do NOT swap to
     `canonical`.
  4. `savePOSImport(storeId, filename, userId, items, date)` — explicit
     `import_date` so dedup works across reloads.
  5. `importPOS({...})` — in-memory state + inventory deduction
     fire-and-forget.
  6. On thrown error: mark `failed: <e.message>`. Do NOT abort the loop —
     subsequent days still run.
- [ ] Progress indicator shows `current / total` and current status string
  (`Checking {date}…`, `Fetching {date}…`, `Importing {date} ({N}
  items)…`). Cmd-palette styling, not the legacy `ActivityIndicator`.
- [ ] On completion, the modal closes and a Cmd-styled summary card appears
  inline above the imports table (or as a dismissable banner — see "Open
  questions" #6) showing per-day outcomes (date · outcome · reason · item
  count) and totals (`Imported / Skipped / Failed`). Matches the data shape
  in legacy `BackfillResult[]` (`POSImportScreen.tsx:39-45`).
- [ ] After the backfill completes, the `posImports` table row in
  `imports.tsx` reflects every newly-imported day (it will, because
  `importPOS` updates `useStore`, which the table reads — but verify in
  the manual walkthrough).
- [ ] Pending CSV diff (if any) MUST be invalidated when the user opens
  the Breadbot modal, so a stale CSV preview cannot be confirmed against a
  Breadbot fetch. Mirrors legacy invalidate-on-source-change comment at
  `POSImportScreen.tsx:309`. Implementation: when the Breadbot modal opens,
  call `setPendingDiff(null)` / `setPendingFilename('')`.

### Realtime
- [ ] After backfill commits, the `store-{id}` realtime channel will fire
  for `pos_imports` inserts (existing publication). No new channel needed,
  but flag the realtime publication gotcha
  (`docker restart supabase_realtime_imr-inventory` after any pub change)
  in the design doc as a risk note for the architect.

### Verification (manual — no test framework)
- [ ] Walkthrough: with `EXPO_PUBLIC_NEW_UI=true` and `currentStore.name
  = 'Towson'`, navigate to POS imports → `FETCH BREADBOT` is visible →
  click → single tab with today preselected → fetch → preview → run
  import → row lands in `imports.tsx` table.
- [ ] Walkthrough: switch `currentStore` to a non-Breadbot store →
  `FETCH BREADBOT` is hidden.
- [ ] Walkthrough: range tab → 7-day backfill → progress ticks → summary
  shows N imported / 0 skipped / 0 failed. Re-run same range → all 7 days
  reported as `skipped: already imported`.
- [ ] Walkthrough: range tab → enter 35-day range → blocked with toast.
- [ ] Walkthrough: range tab → invert dates → blocked with toast.
- [ ] Walkthrough: open Breadbot modal while a CSV diff is pending →
  pending diff cleared (button reverts to disabled greyed `RUN IMPORT`).
- [ ] Edge function smoke: `scripts/smoke-edge.sh` covers
  `fetch-breadbot-sales` already; nothing new to add server-side.

## In scope
- Extend `src/screens/cmd/sections/POSImportsSection.tsx` with the
  `FETCH BREADBOT` button (Breadbot-store-only) and a new Cmd-styled
  fetch modal supporting single + range modes.
- Reuse `fetchBreadbotSales`, `hasPOSImportForDate`, `savePOSImport`,
  `importPOS`, `matchRecipe` exactly as the legacy screen does.
- Port the legacy `enumerateDates`, `BACKFILL_MAX_DAYS`,
  `BACKFILL_THROTTLE_MS`, `BackfillResult` constants/types into a shared
  location (architect to choose: extract to `src/lib/posBreadbot.ts` or
  inline — see Open questions #5).
- Update the `imports.tsx` empty-state copy for Breadbot stores.
- Inline post-backfill summary surface in the Cmd UI.

## Out of scope (explicitly)
- Toast / Square / Clover connector tiles in `sources.tsx`. These are a
  separate Tier-2 follow-up (architect note in
  `POSImportsSection.tsx:286-306`). Bundling them here violates the
  ask-don't-expand-scope policy.
- New backend endpoints. The edge functions
  (`fetch-breadbot-sales`, `breadbot-nightly-sync`) and the
  `pos_recipe_aliases` table are already shipped.
- New migrations. Reusing existing `pos_imports` and `pos_import_items`
  tables.
- Modifying the legacy `src/screens/POSImportScreen.tsx`. It continues to
  ship for users running with `EXPO_PUBLIC_NEW_UI=false` until the
  legacy admin screens are removed.
- Any change to `src/screens/AdminScreens.tsx` (frozen).
- Any change to `useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`,
  or `npm run db` (legacy data layer, frozen).
- Changing the `app.json` slug.
- Native (iOS/Android) UX polish beyond what falls out of using the same
  cross-platform `react-native` `Modal` and Cmd primitives the existing
  upload modal uses. Web is the primary target; native should at minimum
  not crash.
- Map-unmapped-rows surface (the legacy "Items needing mapping" card at
  `POSImportScreen.tsx:499-528`). That belongs on `mapping.tsx`, which
  already has a `UNMAPPED.LOG` panel — extending it is a separate spec.
- Per-day re-fetch override (force re-import a date even if dedup says it
  exists). Legacy doesn't have this either; defer.

## Open questions resolved (defaults chosen — flag for architect to confirm)
- Q: Where does Breadbot fetch live in the UX? → A: Top-bar action button
  `FETCH BREADBOT` (option b), Breadbot-stores only. `sources.tsx`
  untouched. `imports.tsx` empty-state copy gets a one-line addition.
- Q: Role gating? → A: None beyond per-store visibility. Matches legacy.
- Q: Range cap? → A: 30 days, ported from legacy `BACKFILL_MAX_DAYS`.
- Q: Single-only vs single + range? → A: Both. Single is the common
  case; range is the recovery path when the nightly cron has gaps.

## Open questions for architect
1. Should `enumerateDates` / `BACKFILL_MAX_DAYS` / `BACKFILL_THROTTLE_MS` /
   `BackfillResult` move into a new shared util (e.g.
   `src/lib/posBreadbot.ts`) so they are not duplicated between the legacy
   screen and the new Cmd section, or should the legacy screen keep its
   private copy and the Cmd section get its own copy until the legacy
   screen is deleted? Either is fine; pick the one that minimizes diff
   risk against the legacy file.
2. Backfill summary placement: inline card above the imports table inside
   `imports.tsx`, or a dismissable banner that floats over the section
   shell? Legacy uses inline card. Recommend inline card.
3. Should the Breadbot modal live in `src/components/cmd/` as a new
   `FetchBreadbotModal.tsx` (parallel to `UploadCsvModal.tsx`) or stay
   inline in `POSImportsSection.tsx`? Recommend extracting for parity
   with `UploadCsvModal`.
4. Date input primitive — Cmd UI does not currently have a stylized date
   picker (legacy uses `src/components/DatePicker`). Acceptable to use
   the legacy `DatePicker` component as-is, or do we need a Cmd-themed
   one? Recommend reusing legacy `DatePicker` and styling its container
   if needed; do not block on a new component.

## Backend design

This is a UI-only port. Backend, RLS, and edge functions are intact. The
architect-side contribution is module boundaries, store-slice scope, and
calling out one contract bug in the spec body that the developer must
honour.

### Data model changes

None. Reusing `pos_imports`, `pos_import_items`, `pos_recipe_aliases` as-is.
The Breadbot edge function and the nightly-sync cron are unchanged. No
migration filename to assign.

### RLS impact

None. Every read/write below already flows through helpers that respect
`auth_can_see_store(store_id)` (per-store RLS hardening
`20260504173035_per_store_rls_hardening.sql`):
- `hasPOSImportForDate(storeId, date)` → `pos_imports SELECT count`
- `savePOSImport(storeId, ...)` → `pos_imports INSERT` + `pos_import_items
  INSERT`
- `fetchBreadbotSales(storeName, date)` → edge function, JWT-protected
  (`verify_jwt = true`); the function performs its own per-store
  authorization via the caller's JWT.

### API contract (existing — do not redesign)

- `fetchBreadbotSales(storeName, date)` returns `{ rows:
  BreadbotSalesRow[], freshness, meta }` where `BreadbotSalesRow = {
  rawItemName, canonical, qtySold, revenue }`. Errors are re-thrown with
  the upstream message via the existing `ctx.error` unwrap at
  `src/lib/db.ts:907-921`. Do not wrap or rewrap.
- `hasPOSImportForDate(storeId, date)` returns `boolean`. Trusted as-is.
- `savePOSImport(storeId, filename, userId, items, importDate)` writes
  the DB row + items. **Note the explicit `importDate` argument** — this
  is the dedup key future calls to `hasPOSImportForDate` see. Backfill
  must pass it; single-fetch must pass it (use `breadbotDate`, not
  today's clock).
- `importPOS({...})` is the in-memory + inventory-deduction action on
  `useStore`. Fire-and-forget after `savePOSImport`. Already in legacy.

No new RPC, no new view, no PostgREST surface change.

### Edge function changes

None. `fetch-breadbot-sales` (`verify_jwt = true`) and
`breadbot-nightly-sync` (`verify_jwt = false`, service-token validation)
are reused unchanged. No `supabase/config.toml` edit.

### `src/lib/db.ts` surface

No new helpers. Reuse the four existing exports:
- `fetchBreadbotSales(storeName: string, date: string):
  Promise<BreadbotSalesResult>` — `src/lib/db.ts:907`
- `hasPOSImportForDate(storeId: string, date: string): Promise<boolean>`
  — `src/lib/db.ts:869`
- `savePOSImport(storeId: string, filename: string, userId: string,
  items: POSItem[], importDate?: string): Promise<void>` — already
  exported, used by legacy `runBackfill`
- (No change to `fetchUnmappedPosImports` — that powers the legacy
  unmapped review card, which this spec explicitly puts out of scope.)

snake_case → camelCase mapping is already handled inside these helpers.

### Realtime impact

`store-{currentStore.id}` channel — `pos_imports` is in the
`supabase_realtime` publication. After `savePOSImport()` succeeds, the
debounced 400 ms reload in `useRealtimeSync.ts` triggers and the
`imports.tsx` table reflects new rows automatically.

**Publication gotcha is not triggered by this spec** — we add zero rows
to the publication. But noting per spec request: if anyone *separately*
edits the publication mid-session, `docker restart
supabase_realtime_imr-inventory` is required after `npm run dev:db` to
re-snapshot the slot. This is a deploy/dev step, not a runtime concern,
and is unrelated to spec 014.

### Frontend module boundaries (resolves architect open questions)

**Q1 — shared util location.** Create
`src/lib/posBreadbot.ts` and export:

    export const BREADBOT_STORES = new Set(['Frederick', 'Charles', 'Towson']);
    // Comment in the file: "Mirror of STORE_MAP in
    // supabase/functions/fetch-breadbot-sales/index.ts. Edge function is
    // source of truth; this set is the UI guard."
    export const BACKFILL_MAX_DAYS = 30;
    export const BACKFILL_THROTTLE_MS = 200;
    export type BackfillResult = {
      date: string;
      outcome: 'imported' | 'skipped' | 'failed';
      reason?: string;
      itemCount?: number;
    };
    export function enumerateDates(start: string, end: string): string[];
    export function todayISO(): string;

Rationale: the legacy screen and the Cmd section will both reference
these for the next ~month until the legacy screen is deleted. A shared
file is cheaper than maintaining two divergent copies, and the diff to
the legacy file is mechanical (replace local declarations with imports
from the new module). The legacy file `src/screens/POSImportScreen.tsx`
is in scope to receive **import-only** changes — no behaviour change,
just point the local references at the shared module. This is the
minimum-risk move; if the developer hits any complication touching the
legacy file, fall back to a **duplicate in the Cmd section** and leave
legacy alone. Either is acceptable; pick the safer one at implementation
time.

**Q2 — backfill summary placement.** Inline card above the imports
table inside `imports.tsx`, dismissable via a close icon (matches legacy
`POSImportScreen.tsx:530-587`, which the Cmd port should mirror in
content with Cmd-palette styling). Do not float a banner over the
section shell; that breaks the section's scroll model and conflicts
with the existing TabStrip. PM's recommendation is endorsed.

**Q3 — modal extraction.** New file
`src/components/cmd/FetchBreadbotModal.tsx`. Mirrors the existing
`UploadCsvModal.tsx` / `RunImportModal.tsx` pattern (centered overlay,
`useCmdColors()`, `Type.*`, `mono()` / `sans()`, `CmdRadius`,
`react-native` `Modal`, web `Escape` keyboard handler). Keeping it
inline in `POSImportsSection.tsx` would push that file past 600 lines
with two distinct responsibilities (top-level section vs modal). PM's
recommendation is endorsed.

Proposed component contract:

    interface FetchBreadbotModalProps {
      visible: boolean;
      onClose: () => void;
      storeId: string;
      storeName: string;
      /** Called when single-fetch returns ≥1 row — section consumes
       *  ParsedRow[] and switches to its in-section preview surface
       *  (see "Single-fetch flow" below). */
      onSingleFetched: (filename: string, parsedRows: ParsedRow[],
                       importDate: string) => void;
      /** Called when range-backfill completes — section consumes the
       *  per-day outcomes and renders the summary card. */
      onBackfillComplete: (results: BackfillResult[]) => void;
    }

The modal owns: tab strip (single | range), date inputs, fetch button,
range-cap validation, `runBackfill` loop, in-flight progress overlay,
toasts. The section owns: the post-success preview and post-success
summary card.

**Q4 — date input primitive.** Reuse the existing
`src/components/DatePicker` component for now. It is theme-aware via
`useColors()` (legacy palette), but the Breadbot modal is a transient
overlay, not part of the section shell, so the slight palette
inconsistency is acceptable. A Cmd-themed picker primitive would be
nice-to-have, but is not on the critical path for this port and would
balloon scope. PM's recommendation is endorsed. If the picker looks
visually jarring inside the Cmd modal during the manual walkthrough,
wrap it in a Cmd-palette `View` background, not a fork of the
component.

### Frontend store impact (`src/store/useStore.ts`)

**No new store slice.** The Breadbot fetch flow stays screen-local in
`POSImportsSection.tsx`, mirroring the legacy `POSImportScreen.tsx`
which keeps `showBreadbotModal`, `breadbotMode`, `breadbotDate`,
`fetchingBreadbot`, `backfillStart`, `backfillEnd`, `backfillRunning`,
`backfillProgress`, `backfillResults` all as local React state.

Reasons:
1. The flow has no cross-screen state. Imports table re-derives from
   `useStore.posImports` after `importPOS()` mutates it; the modal's
   transient state never needs to outlive the modal.
2. Adding a slice for a flow with one consumer violates the "minimal
   surface area" pattern the rest of `useStore.ts` follows.
3. Optimistic-then-revert with `notifyBackendError` does not apply here
   — the fetch is a synchronous request/response with explicit progress
   UI, not a background mutation.

The existing `importPOS` action on `useStore` is reused for the
in-memory commit step (legacy parity).

### Single-fetch flow — contract correction

**Bug in spec body.** Lines 48–54 read:

> the rows are mapped to the existing `csvImport.computeDiff` input
> shape ... `setPendingDiff(diff)` and `setPendingFilename(filename)`
> are wired so that closing the fetch modal opens `RunImportModal`
> exactly the way the CSV path does today

This is **incorrect** and would silently break the import. `computeDiff`
in `src/lib/csvImport.ts` operates on **inventory item rows**
(create/update/archive ingredient ledger entries). It does not consume
POS sales rows. Routing Breadbot fetch output through
`computeDiff` → `RunImportModal` → `commitImport` would attempt to
create/update/archive *inventory items* using POS strings as ingredient
names — unrelated to recipe-driven sales depletion.

The legacy screen confirms: it does **not** call `computeDiff` for
Breadbot fetches. It uses its own preview surface (`step === 'preview'`
in `POSImportScreen.tsx:652-770`) which renders the parsed rows with
per-row recipe pills, then commits via `importPOS({...})` — entirely
separate from the CSV-import diff pipeline.

**Resolution for the developer.** The Cmd port must do the same:

1. Single-fetch returns `ParsedRow[]` (`menuItem`, `qtySold`, `revenue`,
   optional `canonical`).
2. `FetchBreadbotModal` calls `onSingleFetched(filename, parsedRows,
   date)` and closes itself.
3. `POSImportsSection` enters a new section-local **preview state**
   (Cmd-styled, no shared modal) showing rows + recipe pills + the
   "Import N items · {date}" confirm button. This is a port of the
   legacy preview, not the Run-Import flow.
4. Confirm calls `importPOS({filename, importedAt, importedBy, date,
   storeId, items})` and persists confirmed aliases via
   `upsertPosRecipeAliases` (legacy parity at
   `POSImportScreen.tsx:330-358`).
5. `RunImportModal` is **not** opened by the Breadbot flow.
   `setPendingDiff` / `setPendingFilename` are NOT involved in the
   Breadbot success path.

**However**, the spec's *invalidation* requirement at lines 103-107
remains correct and is honoured: when the user opens
`FetchBreadbotModal`, any pending CSV `computeDiff` from the
`UploadCsvModal` → `RunImportModal` flow must be cleared
(`setPendingDiff(null)` / `setPendingFilename('')`) so the user cannot
confirm a stale CSV diff against a Breadbot fetch context. That is
about clearing the *other* (CSV) flow's state when the user pivots to
Breadbot — not about routing Breadbot through the diff pipeline.

This correction does not change the user-visible AC list materially:
the user still sees a preview, still sees per-row recipe pills, still
clicks confirm, still sees the row land in `imports.tsx`. The change
is internal — the Cmd port adds a small in-section preview surface
parallel to the existing CSV preview-via-modal flow. The developer
should add a section-local `previewState: { filename, rows, date,
rowMatches } | null` and render it as a Cmd-styled `Card` above the
imports table when set, hiding the imports table while in preview
mode (matches legacy single-active-state UX).

### Backfill flow

Stays inside `FetchBreadbotModal`. Per-day loop matches legacy exactly
(`POSImportScreen.tsx:380-463`):

1. `hasPOSImportForDate` → on `true`, push `skipped: already imported`
2. `fetchBreadbotSales` → on zero rows, push `skipped: no data`
3. Build `items` via `matchRecipe(rawItemName, recipes,
   posRecipeAliases)`. Match-against-raw, write-raw — do not swap to
   `canonical`.
4. `savePOSImport(storeId, filename, userId, items, date)` — explicit
   `import_date` so dedup persists across reloads.
5. `importPOS({...})` for in-memory state + inventory deduction
6. On thrown error, push `failed: <e.message>` and continue the loop.
7. `BACKFILL_THROTTLE_MS` sleep between days.

After the loop, modal calls `onBackfillComplete(results)` and closes.
Section stores `results` in local state and renders the summary `Card`
above the imports table until dismissed.

### Files the developer will touch

**New:**
- `src/lib/posBreadbot.ts` (constants, types, helpers — see Q1 above)
- `src/components/cmd/FetchBreadbotModal.tsx` (modal — see Q3 above)

**Modified:**
- `src/screens/cmd/sections/POSImportsSection.tsx`
  - Add `FETCH BREADBOT` button to `rightSlot` (visible iff
    `BREADBOT_STORES.has(currentStore.name)`).
  - Add section-local preview state for the Breadbot single-fetch
    success path (see "Single-fetch flow" above).
  - Add backfill summary `Card` above the imports table (renders when
    `backfillResults != null`).
  - Update empty-state copy when store is in `BREADBOT_STORES`
    (current line 112: append "or fetch from Breadbot").
  - Wire pending-CSV-diff invalidation when modal opens
    (`setPendingDiff(null); setPendingFilename('')`).
- `src/screens/POSImportScreen.tsx` (legacy) — **import-only** change:
  replace local `BREADBOT_STORES`, `BACKFILL_MAX_DAYS`,
  `BACKFILL_THROTTLE_MS`, `enumerateDates`, `BackfillResult`, `todayISO`
  with imports from `src/lib/posBreadbot.ts`. **No behaviour change.**
  If this triggers any test/build friction, the developer may instead
  duplicate the constants in `posBreadbot.ts` and leave legacy alone —
  document the choice in the implementation summary.

**Out of scope (do not modify):**
- `src/screens/AdminScreens.tsx` (frozen)
- `src/store/useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`
  (legacy data layer, frozen)
- `app.json` slug
- Any edge function source
- Any migration

### Risks and tradeoffs

1. **Spec-body contract bug (high risk if missed).** Spec lines 48–54
   instruct the developer to feed Breadbot rows through
   `computeDiff` → `RunImportModal`. Doing that literally will corrupt
   the inventory ledger. The design above replaces that with the
   correct legacy-parity flow (in-section preview → `importPOS`). The
   developer must read the "Single-fetch flow — contract correction"
   block above and ignore the spec body's diff-pipeline language.
   Surface this in the implementation PR description.
2. **Legacy file edit risk.** Changing `POSImportScreen.tsx` imports is
   mechanical, but the file is 1247 lines and the developer is
   instructed not to touch it elsewhere. The fallback (duplicate
   constants in the new shared module, leave legacy alone) is
   explicitly allowed; pick at implementation time.
3. **Range cap UX.** The legacy modal allows the user to *enter* a
   range >30 days and shows a copy-side warning + greyed submit button
   (`POSImportScreen.tsx:838-879`). The spec also requires a Toast on
   submit attempt. Implement both: helper-text hint inside the modal
   when range is invalid, and a Toast if submit somehow gets through
   (defensive). Mirrors legacy.
4. **Breadbot rate limit.** 200 ms throttle ≈ 5 req/s, well under the
   60/min documented cap. No risk for ≤30-day windows. Edge function
   has no extra rate-limit logic; trust the throttle.
5. **No test runner.** Verification is the manual walkthrough listed in
   AC. Test-engineer reviewer will note this; release-coordinator will
   weigh it. Acceptable per project policy (no jest/vitest exists).
6. **Cold-start.** `fetch-breadbot-sales` is a Deno 2 edge function
   with the usual ~500ms cold start. The single-fetch UI shows a
   `FETCHING…` state, so no UX change needed beyond the `disabled +
   busy` button.
7. **Native parity.** Same `react-native` `Modal` + `DatePicker` the
   legacy screen uses cross-platform. Should not crash on iOS/Android.
   No native-specific date-input wiring required.
8. **Store name as the join key.** `BREADBOT_STORES` is a set of three
   exact strings (`Frederick`, `Charles`, `Towson`). If a store is
   renamed in `stores.name`, the Cmd UI guard silently hides the
   button. Same risk exists in legacy and in the edge function's
   `STORE_MAP`. Out of scope to fix here; flag if the user mentions
   a rename.

### Open questions for PM (none blocking)

The four architect-side open questions are resolved above. No new
questions surfaced. The contract-bug correction is internal to design
and does not change user-facing AC.

## Dependencies
- Existing edge function: `supabase/functions/fetch-breadbot-sales/index.ts`
  (no change).
- Existing edge function: `supabase/functions/breadbot-nightly-sync/index.ts`
  (no change — completely independent cron path).
- Existing helpers in `src/lib/db.ts`: `fetchBreadbotSales`,
  `hasPOSImportForDate`, `savePOSImport`, `fetchUnmappedPosImports`. Reuse,
  do NOT rewrite.
- Existing csvImport pipeline: `src/lib/csvImport.ts` (`computeDiff`,
  `commitImport`, `DiffSummary`, `ColumnMapping`). The Breadbot fetch
  feeds the same diff shape so the existing `RunImportModal` works
  unchanged.
- Existing store actions: `useStore.importPOS`, `useStore.posImports`.
- Existing matching helper: `src/utils/recipeMatch.ts` (`matchRecipe`).
- Existing Cmd primitives: `UploadCsvModal`, `RunImportModal`,
  `TabStrip`, `StatCard`, `StatusPill`, `SectionCaption`,
  `useCmdColors()`, `Type.*`, `mono()`, `sans()`, `CmdRadius`.
- Migration `20260425043301_pos_recipe_aliases.sql` (already applied).
- Per-store RLS hardening
  `20260504173035_per_store_rls_hardening.sql` (already applied).

## Project-specific notes
- Cmd UI section / legacy: **Cmd UI**. New code goes in
  `src/screens/cmd/sections/POSImportsSection.tsx` (and optionally a new
  `src/components/cmd/FetchBreadbotModal.tsx`).
  `src/screens/POSImportScreen.tsx` (legacy) is the port-from reference
  but is not modified.
- Per-store or admin-global: **Per-store**. Visibility gated by existing
  `auth_can_see_store()` RLS, plus client-side `BREADBOT_STORES` set
  filter on store name.
- Realtime channels touched: `store-{currentStore.id}` (existing
  `pos_imports` publication picks up new rows). Architect: please flag the
  realtime-publication gotcha as a risk in the design doc — if anyone
  edits the publication mid-session, a `docker restart
  supabase_realtime_imr-inventory` is required to re-snapshot the slot
  (per project memory `project_realtime_publication_gotcha.md`).
- Migrations needed: **No**.
- Edge functions touched: **None** (`fetch-breadbot-sales` and
  `breadbot-nightly-sync` already shipped).
- Web/native scope: **Web primary, native should not crash**. The legacy
  screen runs on both via `react-native` `Modal` + cross-platform
  `confirmAction`; the Cmd port should hold the same bar. Native UX polish
  is explicitly out of scope.
- Tests: **None** — project has no test runner. Verification is the
  manual walkthrough listed under Acceptance criteria. Test-engineer
  reviewer will note this as a coverage gap.
- `app.json` slug: **Not touched**. No build-identifier changes.

## Files changed

**New:**
- `src/lib/posBreadbot.ts` — shared constants + helpers
  (`BREADBOT_STORES`, `BACKFILL_MAX_DAYS`, `BACKFILL_THROTTLE_MS`,
  `BackfillResult`, `enumerateDates`, `todayISO`). Pure module — no
  React/Supabase imports.
- `src/components/cmd/FetchBreadbotModal.tsx` — Cmd-themed centered modal
  (single-day + range-backfill tabs). Mirrors `UploadCsvModal.tsx` /
  `RunImportModal.tsx` layout (header / body / footer slots, web
  Escape-to-close, busy-disable). Owns: tabs, date inputs, fetch
  button, range-cap validation, the per-day backfill loop, in-flight
  progress UI, toasts. Hands off to the section via `onSingleFetched`
  (rows + filename + date) and `onBackfillComplete` (results).

**Modified:**
- `src/screens/cmd/sections/POSImportsSection.tsx`
  - Added `FETCH BREADBOT` top-bar action button gated on
    `BREADBOT_STORES.has(currentStore.name)` (button is fully hidden for
    non-Breadbot stores, not just disabled).
  - Wired pending-CSV-diff invalidation when the Breadbot modal opens
    (`setPendingDiff(null); setPendingFilename('')`) — implements
    spec 014 lines 103-107 / architect's preserved invalidation
    requirement.
  - Added section-local `BreadbotPreview` state for the single-fetch
    success path. Renders an inline Cmd-styled preview card with recipe
    pills + IMPORT confirm button above the imports.log table. Confirm
    calls `savePOSImport` + `importPOS` + `upsertPosRecipeAliases`
    directly — does NOT route through `computeDiff` /
    `RunImportModal` (architect contract correction at design lines
    383-431).
  - Added `BackfillSummaryCard` inline above the imports.log table to
    surface per-day outcomes (imported/skipped/failed chips +
    date-keyed table), dismissable via close icon.
  - Updated empty-state copy: "upload a CSV from Toast / Square /
    Clover" gains ", or fetch from Breadbot" suffix only when
    `storeHasBreadbot`.

**Not modified (per architect's allowed fallback):**
- `src/screens/POSImportScreen.tsx` (legacy) — duplicate constants are
  acceptable per architect Q1 fallback. Touching the 1247-line legacy
  file for an import-only swap was traded for zero regression risk on
  the legacy code path. The legacy screen continues to ship for
  `EXPO_PUBLIC_NEW_UI=false` with its private constants intact and
  will be removed wholesale when the legacy admin screens are deleted
  next month.

**Not touched (out of scope per spec):**
- `src/lib/db.ts` (existing `fetchBreadbotSales` / `hasPOSImportForDate`
  / `savePOSImport` reused unchanged).
- `src/store/useStore.ts` (no new slice; `importPOS` /
  `upsertPosRecipeAliases` reused).
- `supabase/functions/fetch-breadbot-sales/` (edge function unchanged).
- Any migration / RLS.

## Browser verification status

The dev server is running and Metro returns HTTP 200 on the bundle
endpoint (12 MB compiled, contains all new symbols, zero
`UnableToResolveError` strings). TypeScript checks pass cleanly on the
three changed files. **However, the `preview_*` MCP tools required by
the project's verification workflow were not loaded as callable
functions in this implementation session.** Manual walkthrough by the
user (or by test-engineer with preview tools available) is therefore
required to confirm:
- `FETCH BREADBOT` visible on POS imports for `currentStore.name = 'Towson'` / `'Charles'` / `'Frederick'`.
- Button hidden for non-Breadbot stores.
- Single-day fetch → preview card → confirm → row in imports.log.
- Range backfill → progress UI → summary card → re-run → all days `skipped: already imported`.
- 35-day range blocked with toast.
- Inverted range blocked with toast.
- Pending CSV diff cleared when Breadbot modal opens.
- Existing UPLOAD CSV → RUN IMPORT path still functional.
