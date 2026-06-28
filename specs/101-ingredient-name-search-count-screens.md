# Spec 101: Ingredient-name search across the four count screens

Status: DRAFT

> Retrospective spec. The feature was implemented directly on `main` (staged,
> uncommitted) without a prior spec. This document reconstructs the intent,
> pins acceptance criteria, grades the existing implementation against them,
> and surfaces open questions. The DRAFT status is intentional: AC-7
> (localized-name matching) is a genuine product decision the user must make
> before this is "done" — see Open questions Q1.

## User story
As a store manager or counting staffer, I want to type part of an
ingredient's name and have the count worksheet narrow to matching rows, so
that I can find one ingredient in a long per-store list without scrolling —
**without** that filter ever changing what my count actually submits.

## Acceptance criteria

Each criterion is graded against the staged code. Legend: PASS / FAIL /
PARTIAL / OPEN (needs a product decision before it can be graded).

- [x] **AC-1 (PASS) — A name-search box exists on all four count screens.**
  Admin EOD (`EODCountSection.tsx:1006`), admin Inventory
  (`InventoryCountSection.tsx:632`), staff EOD (`EODCount.tsx:619`), staff
  Weekly (`WeeklyCount.tsx:396`).
- [x] **AC-2 (PASS) — Match is case-insensitive substring.** All four lower
  the query and the candidate and use `.includes()`
  (`EODCountSection.tsx:386-387`, `InventoryCountSection.tsx:156-157`,
  `EODCount.tsx:246-248`, `WeeklyCount.tsx:218-219`).
- [x] **AC-3 (PASS) — A search that hides a row with an entered count must
  NOT drop that count on submit.** Verified per screen:
  - Admin EOD: submission builds from `filteredItems`
    (`buildSubmission` → `filteredItems.filter(hasEntry)`,
    `EODCountSection.tsx:426`); the search is applied only inside the
    render-only `grouped` memo (`EODCountSection.tsx:385-395`). The list
    renders from `grouped` (`EODCountSection.tsx:1130`). Counts survive.
  - Admin Inventory: submission iterates `storeInventory`
    (`InventoryCountSection.tsx:315`), which is unfiltered by search; search
    lives in `filteredItems` (`:152-159`) which feeds `grouped`/render only.
    Counts survive. (This is the existing C-FE-1 guard from spec 019.)
  - Staff EOD: submission iterates the full `items` array
    (`EODCount.tsx:377`); search produces a render-only `visibleItems`
    (`:245-248`) used only as the FlatList `data` (`:649`). Counts survive.
  - Staff Weekly: submission iterates the full `items` array
    (`WeeklyCount.tsx:253`); search is applied inside the render-only
    `sections` memo (`:217-219`). Counts survive.
- [x] **AC-4 (PASS) — Counters and totals reflect the count scope, not the
  search scope.** Admin EOD `countedNum`/`total`/`estValue`/`variance` all
  derive from `filteredItems` (`EODCountSection.tsx:409-418`), unaffected by
  search. Admin Inventory `nonBlankCount`/`totalItems`/`hasNegative` derive
  from `storeInventory` (`:191-206`). Staff Weekly `nonBlankCount` derives
  from `items` (`:200-208`). Consequence (acceptable, but call it out):
  the "X/Y counted" footer can read higher than the number of visible rows
  while a search is active — correct behavior, since the count is real, but
  may momentarily surprise a user. See Open questions Q4.
- [x] **AC-5 (PASS) — Search composes with the screen's existing filters.**
  Admin EOD composes search over (vendor tab → category chip → +COUNT
  extras) because `grouped` filters `filteredItems`, which already applied
  vendor+category (`EODCountSection.tsx:377-395`). Admin Inventory composes
  search with the category chip inside one memo (`:152-159`). Staff Weekly
  composes search with category grouping inside `sections`. Staff EOD is a
  flat vendor-scoped list (no other filter to compose with) — correct.
- [x] **AC-6 (PASS) — Placeholder text is localized in all three locales on
  both surfaces.** Admin keys `section.eod.searchPlaceholder` /
  `section.inventoryCount.searchPlaceholder` present in en/es/zh-CN
  (`src/i18n/{en,es,zh-CN}.json:338,446`). Staff keys
  `eod.list.searchPlaceholder` / `weekly.list.searchPlaceholder` present in
  en/es/zh-CN (`src/screens/staff/i18n/{en,es,zh-CN}.json:35,191`).
- [ ] **AC-7 (FAIL / OPEN) — Search matches the name the user can actually
  see.** All four screens match `item.name` — the raw **English** canonical
  — only. But staff EOD/Weekly render `getLocalizedName(...)`
  (`EODCount.tsx:680`, `WeeklyCount.tsx:455`) and so does the admin (admin
  inventory rows render `it.name`, which today is English, but the localized
  rendering pattern exists elsewhere). In Spanish or Chinese a staffer sees a
  localized label and types it, and the search returns zero rows even though
  the item is present. The established in-repo pattern for translated search
  is `matchesQuery(query, [localizedName, englishCanonical])` with diacritic
  folding (`RecipesSection.tsx:109`, `src/i18n/matchesQuery.ts`). The four
  count screens do NOT use it. Graded FAIL against the literal criterion;
  flagged OPEN because the user may consciously accept English-only matching
  (see Q1). This is the single most important finding.
- [ ] **AC-8 (FAIL) — On zero matches, the user gets a "no matches" signal
  rather than a blank gap.** Split by surface:
  - Admin EOD: PASS-ish — when `grouped.length === 0` it renders
    `section.eod.noItemsInFilter` (`EODCountSection.tsx:1125-1128`). The
    message is shared with the empty-category case, so it reads "no items in
    this filter" rather than "no matches for <query>", but it is non-blank.
  - Admin Inventory: PASS-ish — same shape, renders "no items in this
    filter" when `grouped.length === 0` (`:696-707`).
  - Staff EOD: FAIL — the empty/loading branches gate on `items.length`
    (the full array, `:640`), so when a search empties `visibleItems` the
    populated branch still renders and the FlatList shows nothing. No
    "no matches" row.
  - Staff Weekly: FAIL — same; the empty branch gates on `items.length`
    (`:411`), so an empty `sections` renders a blank SectionList.
- [ ] **AC-9 (FAIL) — A one-tap clear/reset (×) affordance.** None of the
  four screens offers a clear button. The admin `FilterInput` has no clear
  affordance; the staff `Input` is a bare pill. User must select-all-delete
  to reset. Minor, but listed because the request named it.
- [x] **AC-10 (PASS) — Search state is local and resets on the natural
  boundary.** Each screen holds `search` in component state. Admin EOD's
  search is NOT keyed by vendor, so switching vendor tabs preserves the typed
  query across the new (narrower) item set — defensible, arguably a feature.
  Staff EOD reloads items on vendor change but keeps `search`; the new list
  is re-filtered live. No stale-filter data-loss risk because AC-3 holds.
- [x] **AC-11 (PASS) — Typecheck + existing tests stay green.** Reported:
  tsc clean, all six i18n JSON valid, 43 staff jest tests pass. (Confirmed
  by inspection: no type holes in the added memos; keys resolve.)

## In scope
- A render-only, case-insensitive substring name filter on each of the four
  count worksheets (admin EOD, admin Inventory, staff EOD, staff Weekly).
- Localized placeholder strings for the box in en/es/zh-CN on both surfaces.
- A hard guarantee that the filter is view-only and cannot drop entered
  counts or distort the submit payload / counters (AC-3, AC-4).

## Out of scope (explicitly)
- **Fuzzy / token / typo-tolerant search.** Substring only. Rationale: the
  in-repo precedent (`matchesQuery`) is substring + diacritic folding; no
  request for fuzzy.
- **Searching by vendor, category, unit, par, SKU, or any field other than
  name.** Rationale: the user asked for "ingredient name" specifically. The
  admin already has structured `status:` / `cat:` filters elsewhere; not
  extending them here.
- **Persisting the query across navigation, sign-out, or app restart.**
  Session-local state only.
- **Backend / RPC / migration changes.** This is a pure client-side render
  filter over data already in the store / already fetched. No `db.ts`
  signature change, no edge function, no SQL.
- **Realtime.** No data is written; nothing to publish.
- **Changing the admin `FilterInput`'s hardcoded "filter:" prefix or the
  staff `Input` styling to make the two surfaces match.** Flagged as Open
  question Q3, not silently changed.

## Open questions resolved
This feature was built without a pre-spec, so the questions below were NOT
asked before implementation. They are recorded here for the user to resolve.
Until Q1 is answered the spec stays DRAFT.

- **Q1 (BLOCKING) — Localized-name matching.** Should the four count screens
  match the localized display name (the string a Spanish/Chinese user
  actually sees and would type), not just the raw English `name`? The repo
  already has the exact tool: `matchesQuery(query, [localizedName,
  englishCanonical])` (`src/i18n/matchesQuery.ts`, used by
  `RecipesSection.tsx:109`). Options:
  - (a) Adopt `matchesQuery` on all four screens — match localized + English,
    with diacritic folding. Consistent with Recipes; best UX for the
    multilingual staff portal that is the whole reason this was extended to
    staff. Recommended.
  - (b) Keep English-only. Acceptable only if staff in practice search in
    English. Leaves a real "type what you see, get nothing" trap in es/zh-CN.
  → A: __unanswered — user must choose.__
- **Q2 — Empty-state message.** When a search matches nothing, do we want a
  dedicated "no matches for '<query>'" row (ideally with the query echoed),
  and specifically on the two staff screens where today it renders blank?
  Recommended: yes, add a localized "no matches" row to staff EOD + staff
  Weekly; optionally specialize the admin message to distinguish "no items"
  from "no search matches."
  → A: __unanswered.__
- **Q3 — Cross-surface wording/affordance consistency.** Admin reuses
  `FilterInput`, which renders a literal "filter:" prefix and a (hidden) ⌘K
  hint; staff uses its local `Input` pill with a "search ingredient…"
  placeholder. The two surfaces read and look different for the same action.
  Do we (a) leave as-is (each surface follows its own design language), or
  (b) align wording (e.g. a "search:" prefix / magnifier on both)?
  → A: __unanswered.__
- **Q4 — Counter vs. visible-rows divergence.** With a search active, the
  footer "X/Y counted" counts entries across the full (count) scope, which
  can exceed the visible row count. This is correct (counts are real) but can
  surprise. Accept as-is, or add a subtle "(filtered)" hint to the counter
  while a query is non-empty?
  → A: __unanswered.__
- **Q5 — Clear (×) button.** Add a one-tap reset to the search box? (Cheap;
  the request named it.)
  → A: __unanswered.__

## Dependencies
- None new. Relies on:
  - `src/components/cmd/FilterInput.tsx` (existing) — admin box.
  - `src/screens/staff/components/Input.tsx` (existing) — staff box.
  - `src/i18n/matchesQuery.ts` + `src/i18n/localizedName.ts` (existing) —
    **only if Q1 resolves to (a).**
  - The per-store inventory data already in `useStore` (admin) and the
    per-vendor / per-store fetches already in the staff screens.

## Project-specific notes
- **Cmd UI section / legacy:** Admin side lands in two existing
  `src/screens/cmd/sections/` files (EODCountSection, InventoryCountSection).
  No legacy surface involved.
- **Which app:** This repo only. Admin Cmd UI + the folded-in staff surface
  (`src/screens/staff/`, spec 063). No sibling-app (customer PWA) work.
- **Per-store or admin-global:** Per-store. Every screen is already scoped to
  the active store (admin `currentStore.id`; staff `activeStore.id`); the
  search filters within that scope. No RLS surface touched — pure client
  render filter over already-authorized rows.
- **Edge function or PostgREST:** Neither. No backend logic. The staff
  screens read via the documented `src/screens/staff/` direct-`supabase`
  carve-out (spec 063); this feature adds no new query.
- **Realtime channels touched:** None.
- **Migrations needed:** No.
- **Edge functions touched:** None.
- **Web/native scope:** Both. The admin `FilterInput` and staff `Input` are
  cross-platform RN components; no web-only or native-only code added.
- **Tests (spec 022 tracks):** jest only. If Q1 → (a), add a jest unit test
  asserting localized + English substring matching on a representative count
  list (the staff suite is the natural home; admin memos are also unit-
  testable). pgTAP and shell-smoke tracks are not applicable (no DB / no
  endpoint). Existing 43 staff jest tests already pass and should be kept
  green.
- **app.json slug:** Not touched. (No build-identifier surface here.)

## Summary for the user
The view-only guarantee (the thing that could have silently eaten counts) is
implemented correctly on all four screens — that is the most important
property and it holds. The notable gaps are product decisions, not bugs:
1. **English-only matching (AC-7 / Q1)** — top priority. In a Spanish/Chinese
   staff portal a user types the localized name they see and gets nothing.
   The fix is a one-line swap to the existing `matchesQuery` helper per
   screen. Needs your call.
2. **Blank zero-match state on the two staff screens (AC-8 / Q2)** —
   the empty guard checks the full list, so a no-match search renders an
   empty list with no message. Admin screens already show a message.
3. **No clear button (AC-9 / Q5)** and **cross-surface wording drift
   (Q3)** — minor polish.
