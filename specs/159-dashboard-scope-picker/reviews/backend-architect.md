# Spec 159 — architectural drift review (backend-architect, post-impl)

Reviewer: `backend-architect` (author of the `## Backend design` section of this spec).
Date: 2026-08-16. Mode: post-implementation drift review. `Status:` not modified.

Files read: `src/lib/db.ts` (§ waste-log block + the four sibling cross-store reads),
`src/lib/cmdSelectors.ts:985-1174`, `src/lib/storeVisibility.ts`,
`src/screens/cmd/sections/DashboardSection.tsx` (full),
`src/components/cmd/TabStrip.tsx`, `src/i18n/{en,es,zh-CN}.json`,
`e2e/dashboard-window.spec.ts`, `src/lib/db.crossStoreLoaders.test.ts`,
`src/lib/cmdSelectors.scopedRollups.test.ts`, `src/lib/storeVisibility.test.ts`,
`src/screens/cmd/sections/__tests__/DashboardSection.scopePicker.spec159.test.tsx`,
`src/screens/cmd/sections/phone/__tests__/PhoneDashboard.acReg.test.tsx`,
`src/store/useStore.ts:1425-1520`, `supabase/migrations/` (index), `.gitignore`.

**Verdict: no Critical findings. The implementation matches the design contract on every
load-bearing point I specified.** Two Should-fix items (one test-coverage gap, one
unverified native surface) and five Minor items follow.

---

## 1. Contract conformance — point by point

### 1.1 `fetchWasteLogForStores` (§3 / §5.1) — MATCHES

`src/lib/db.ts:843-875`, docblock `:804-842`.

| Design requirement | Landed | Where |
|---|---|---|
| Signature `(storeIds: string[], sinceISO: string) => Promise<WasteEntry[]>` | yes | `db.ts:843-846` |
| PostgREST read, not an RPC (so AC-T4's pgTAP condition does not fire) | yes | `db.ts:849-855` |
| Empty-input short-circuit **before** any network call | yes | `db.ts:847` — outside `track`, same as `fetchEodSubmissionsForStores:1180` |
| `useInflight.getState().track(..., { kind: 'read' })` + `.abortSignal(signal)` | yes | `db.ts:848`, `:855`, `:874` |
| Narrow column list, **no** `profiles` / `inventory_items→catalog_ingredients` embeds | yes | `db.ts:851` — exactly the §3 column list |
| `.in('store_id', …)` + `.gte('logged_at', sinceISO)` + `order desc` | yes | `db.ts:852-854` |
| No server-side pre-filter of `storeIds` (RLS is the boundary) | yes | asserted in docblock `:828-833` and proven live in the spec's verification note |
| Degrade, don't throw: `console.warn` + `[]`, **no** `notifyBackendError` toast | yes | `db.ts:856-859` — byte-shape of `fetchEodSubmissionsForStores:1192-1195` |
| Spec 104 R1: `cost_per_unit` UNBRIDGED | yes | `db.ts:866`, pinned by `db.crossStoreLoaders.test.ts:294-307` |
| Sparse `itemName` / `loggedBy` = `''` | yes | `db.ts:863,868`, pinned `:309-326` |
| `sinceISO` param name carries the timestamptz-vs-date difference | yes | `db.ts:845`; caller passes an ISO instant at `DashboardSection.tsx:290` while the four siblings keep the date-only `since` at `:286` |
| Nothing else in `db.ts` changes | yes | only two spec-159 markers in the file (`db.ts:805`, `:817`); `fetchWasteLog:773-802` is untouched, `toLocaleString()` still at `:797` |

**R-A containment: correct and complete as specified.** Cross-store rows carry raw ISO
(`db.ts:870`), `fetchWasteLog` is untouched, the asymmetry + the reason + the consumer
obligation are in the docblock (`db.ts:817-826`), the consumer carries the
`Number.isFinite(Date.parse(...))` guard (`DashboardSection.tsx:407`, `:450`), and the
mapper invariant is pinned by a test that explicitly asserts the timestamp is *not* the
`toLocaleString()` form (`db.crossStoreLoaders.test.ts:285-289`). See Minor M-1 for the
one residual behavior this containment leaves in place.

### 1.2 Decision D-A — four pure functions, two hook deletions — MATCHES

`src/lib/cmdSelectors.ts:1018-1154`; tombstone + house rule at `:1156-1174`.

Deletions verified independently: `useCogsForCurrentStore` / `useTopVarianceItems` now
appear **only** in comments and test prose across `src/`, `e2e/`, `tests/`, `scripts/`.
No orphan import, no shim left behind. The house rule ("cross-store callers use the pure
functions") was kept and extended to name `fetchWasteLogForStores` — that is the drift
guard D-A existed for.

**Single-element `storeIds` identity — the property AC-S4/S6/S7 rest on — holds:**

- `computeScopedFoodCostSeries` (`:1055-1057`) short-circuits to
  `computeStoreFoodCostSeries` for `length === 1`. Literal identity, no sum/count float
  path. Pinned `cmdSelectors.scopedRollups.test.ts:162-165`.
- `computeScopedTopVarianceItems` (`:1146-1153`) with one store is a stable no-op re-sort
  of an already-sorted list, then `slice(0, limit)` on a list of `≤ limit`. Identity.
  Pinned `:330-333`.
- `computeScopedCogs` (`:1106-1116`) sums one already-2dp value, and `+x.toFixed(2)`
  round-trips a 2dp value unchanged, so `theoretical` / `actual` / `pct` are identical to
  the deleted hook. `delta` gained a `.toFixed(2)` the design didn't specify — see Minor
  M-2; it is render-invisible (`CogsCard` does `Math.round(delta)`,
  `DashboardSection.tsx:1087`).

The `stores` argument stays the **raw** slice at every `compute*` call site
(`DashboardSection.tsx:561`, `:601`) with the reason inline — that was the one place I
expected a developer to over-narrow and blank a store name. It didn't happen.

PM-4's soundness argument, the rounding-drift acceptance, and the tie-break determinism
rule all made it into the docblocks (`:1119-1136`) and are exercised by
`cmdSelectors.scopedRollups.test.ts:354-363` (both `[A,B]` and `[B,A]` orderings).

### 1.3 Decision D-B — section-local `ScopePicker`, `TabStrip` unedited — MATCHES, with one unverified surface

`DashboardSection.tsx:871-990` (component), `:688-708` (mount + stacking wrapper).

- `SelectField` correctly avoided; the three reasons I gave are restated at `:872-878`.
- `TabStrip.tsx` is **byte-unchanged** (no spec-159 marker; `rightSlot` still the generic
  `React.ReactNode` at `:19,76`). AC-R2's spirit held.
- AC-P6 test hooks all present: `dashboard-scope-picker` (`:934`),
  `dashboard-scope-option-all` (`:974`), `dashboard-scope-option-{storeId}` (`:980`).
- AC-P7 satisfied structurally, not defensively — the aggregate option renders outside the
  `stores.map` (`:974-985`), so a 0- or 1-store visible set can never produce an empty
  panel.
- AC-P1 ordering (aggregate first, then `visibleStores` order) is correct, and
  `period: today` is preserved verbatim (`:702-704`).

**The `zIndex: 50` wrapper is sound on web, and is the right shape.** I asked for exactly
this fallback ("wrap the strip in a `zIndex`-raised `View` inside `DashboardSection`
rather than editing `TabStrip`"), and the mechanism is correct rather than lucky:
react-native-web gives every `View` `position: relative; zIndex: 0`
(`node_modules/react-native-web/dist/exports/View/index.js:122-134`) and does **not** set
`overflow: hidden`, so a later sibling (the `ScrollView`) normally wins the paint; the
wrapper at `zIndex: 50` reverses that for the whole strip subtree, and nothing in
`TabStrip` clips. The developer's live check at 1000px + dark mode confirms it. Not a
fragile workaround on web. The native half is unverified — see Should-fix S-2.

### 1.4 §9.1 / §9.2 label resolver + OQ-2 fallback — MATCHES

`DashboardSection.tsx:619-649`; `brandNameFor` at `storeVisibility.ts:78-86`.

- One resolver (`aggregateLabelFor`) feeds hero, trigger and aggregate option, which is
  what makes the three impossible to desync — the property §9.1 was designed around.
  Hero and strip differ **only** in the `fallbackKey` argument (`:639`, `:649`), exactly
  as the §9.1 table specified.
- OQ-2 fallback chain is right: distinct brandId over the scoped list → not exactly 1 →
  `null` → generic label; else `brandNameFor(...)` → `null` (unhydrated / unknown) →
  generic label; else `scopeAllBrand` / `scopeAllBrandOne` (`:621-632`). Singular/plural
  split landed as specified.
- `brandNameFor` is in `storeVisibility.ts` as the §13 backend-lane item, is pure, returns
  `null` (never a placeholder) on all five degenerate paths, prefers `brand` over
  `brandsList`, and its docblock records the remaining `TitleBar` near-duplication as a
  follow-up without doing the refactor. `TitleBar.tsx` untouched. 6 unit cases at
  `storeVisibility.test.ts:102-133`.
- §9.2 catalog diff landed exactly: `heroTitle` deleted from all three catalogs (zero
  matches repo-wide), 6 new keys present in `en`/`es`/`zh-CN` at `:378-383` of each with
  real translations, and the still-used keys (`storeSelector`, `allStores`, `period`,
  `periodToday`, `greetingLine`) untouched.

One deviation, small: see Minor M-3 (`.filter(Boolean)` on the brand-id set).

### 1.5 OQ-1 phone pinning — MATCHES, one line, as designed

`DashboardSection.tsx:220`: `if (isPhone) return { mode: 'store', storeId: currentStore.id };`
— first branch of `effectiveScope`, before the AC-P5 fallback, with the resize-carryover
rationale inline. The phone cushion (`:233-236`, `picked.length === 0 && isPhone →
[currentStore]`) is the §6.1 note, implemented.

`PhoneDashboard.tsx` is not edited, and the model literal (`:665-676`) passes the same
identifiers, now derived from `scopedInventory` / `allWaste`. `PhoneDashboard.acReg.test.tsx`
is not edited, and it is green for the reason §12.5 predicted, not by accident — it seeds
`stores: []`, `inventory: []`, `wasteLog: []` (`:57-64`). The OQ-1 regression guard exists
as a component case (`DashboardSection.scopePicker.spec159.test.tsx:237-242`), asserting
`$1,000.00` rather than the cross-store total.

### 1.6 Out-of-contract list — HELD, verified independently

| Claim | Verification |
|---|---|
| No migration | newest migration is `20260809000000_super_admin_policy_parity.sql`; no 2026-08-1x file exists |
| No RPC / no new policy | no SQL touched at all; `waste_log`'s `store_member_read_waste_log` (`20260504173035:137-139`) is the unchanged gate |
| No edge function, no `config.toml` | no spec-159 marker anywhere under `supabase/`; the three `159` hits in `supabase/functions/` are Breadbot's "159 aliases" prose, pre-existing |
| No `supabase_realtime` publication statement | no publication migration added; **the `docker restart supabase_realtime_imr-inventory` step correctly does NOT apply to this spec** |
| No `src/store/useStore.ts` change | zero spec-159 markers; `setCurrentStore` + the `'__all__'` redirect at `:1406-1440` untouched (AC-R1) |
| No `TabStrip` / `TitleBar` / `PhoneDashboard` edit | confirmed above |
| Backend lane didn't touch frontend files (and vice versa) | the two "Not touched" lists in the spec are consistent with what's on disk |

`.claude/settings.local.json` accumulated tool-permission entries during the build, but it
is gitignored (`.gitignore:17`), so it is not in the staged diff. No finding.

### 1.7 §6 consumer re-keying — MATCHES the AC table row for row

Spot-checked every row of my §6.4 table against the file. All 20 landed, including the
three I expected to be missed:

- `focalInventory` deliberately **not** re-keyed (`:367-372`) — `eodRows` stays focal.
- `queueByStore` iterates `scopedStores` while passing the raw `stores` array in
  (`:588`, `:601`).
- all five `synthSeries` seeds moved to `scopeKey` (`:517-518`, `:735`, `:751`, `:761`,
  `:769`), and the `SYNTHETIC_KPI_SERIES` comment block was updated to say the mock is now
  scope-seeded and aggregated (`:56-60`) — R-C's easy-to-forget item, done.

R-D honored: **one** `scopedInventory` memo (`:376-379`) feeds five consumers, and the
memo chain is string-keyed (`scopeIdsKey` → `scopeStoreIds` → `scopeIdSet`, `:245-250`) so
a rotating `stores` array identity doesn't re-run the filters.

AC-P4 landed as the render-phase adjustment (`:199-203`), not a `useEffect` — the design's
one-frame-of-stale-scope argument was respected. AC-V2's dep-list change to
`visibleStoreIdsKey` landed (`:282`, `:328`) with the `storeIds.length === 0` early return
that also covers R-E.

### 1.8 e2e (AC-R4 / AC-T3) — MATCHES, preferred variant chosen

`e2e/dashboard-window.spec.ts:240-241` drives the picker to
`dashboard-scope-option-${SEED.e2eWindowStoreId}` — the one-card variant I recommended
over `option-all`, which keeps the card-scoped `toHaveCount(0)` assertions
(`:254`) maximally strong. The frozen selector-contract header was extended with the two
new testIDs (`:53-61`) rather than silently diverging. No assertion weakened.
`e2e/dashboard.spec.ts` correctly untouched.

---

## 2. Findings

### Critical

None.

### Should-fix

**S-1 — The waste reducer, the sole consumer of this spec's entire backend surface, has no
test at any level.**
`src/screens/cmd/sections/DashboardSection.tsx:393-411` (`wasteWeek`) and `:446-453`
(`wasteEventCount`) carry four load-bearing rules: the `scopeIdSet` filter, the 7-day
cutoff, the R-A `Number.isFinite(Date.parse(...))` guard, and the **UNBRIDGED**
`quantity * costPerUnit` multiply (spec 104 R1). None of them is exercised:
`DashboardSection.scopePicker.spec159.test.tsx` seeds `wasteLog: []` (`:127`) and mocks
`fetchWasteLogForStores` to `[]` (`:59`), and no other jest suite under
`src/screens/cmd/sections/__tests__/` mentions waste. `db.crossStoreLoaders.test.ts`
pins the *fetch mapper*, not the reducer.

Concretely: someone "fixing" the waste dollars by adding `× (subUnitSize || 1)` — the
exact mistake spec 104 R1 exists to prevent, and one that looks correct next to
`totalInvValue` two memos above — would pass the full 2383-test suite and both e2e
projects. Likewise a regression that drops the `isFinite` guard.

AC-T1 asked for the waste sum (and the EOD `x/N` and alert counts) as tested reducers with
≥2-store fixtures; the CoGS / food-cost / top-variance thirds landed thoroughly
(`cmdSelectors.scopedRollups.test.ts`, 24 cases) and the inventory-value third is covered
transitively by the component test's `$1.0k / $2.0k / $3.0k` assertions, but the waste
third is uncovered. My §10 said extracting `wasteWeek`'s reducer was "optional" — that
was conditioned on AC-T2 reaching it, which it does not.

Cheapest fix consistent with the design: extract
`sumScopedWaste(entries: WasteEntry[], scopeIds: Set<string>, nowMs: number): { dollars: number; events: number }`
into `cmdSelectors.ts` next to the other scoped rollups and add ~4 cases (two stores; an
out-of-window row; an unparseable focal `timestamp`; a `subUnitSize`-bearing row proving
no bridge). Alternative without extraction: one component case seeding a two-store
`crossStoreWaste` via the db mock plus a locale-string focal row.

**S-2 — D-B's native-tablet stacking is still unverified; only the web half was checked.**
`DashboardSection.tsx:688` (`zIndex: 50` wrapper) + `:956-971` (absolute panel,
`top: 24`). The design (§6.5) asked specifically: *"Verify on native tablet that the
absolute panel is not clipped by the strip's sibling `ScrollView`."* The verification note
records 1000px web + dark mode only.

The panel overflows the `TabStrip` row's bounds by design (a ~28px strip hosting a
≥48px panel). On web that is fine (RNW `View` has no default `overflow: hidden`, confirmed
above). On native it is the classic RN failure mode: Android clips children that overflow
a parent's bounds, and iOS renders them but does **not** deliver touches outside the
parent's frame. The spec's web/native scope explicitly includes the native tablet Cmd
surface, so this is in scope, and if it fails the remedy is a design change (portal /
`Modal`-hosted panel), not a style tweak.

Ask: run the picker once on a native tablet build, or record an explicit accepted
limitation ("desktop-web verified; native tablet unverified") in the spec so it isn't
discovered by a user.

### Minor

**M-1 — R-A's residual: in all-stores mode the focal store is the one that can silently
drop out.** `allWaste` (`DashboardSection.tsx:353-356`) replaces the ISO-carrying focal
rows from `crossStoreWaste` with the locale-string rows from the `wasteLog` slice, to keep
the focal store realtime-fresh (correct, and what I specified). Consequence: under a
runtime locale whose `toLocaleString()` output `Date.parse` rejects, WASTE/WK in
all-stores mode now reads *"every store except the focal one"* rather than the pre-159
`$0`. Both are wrong; the new one is less obviously wrong. This is inside the pre-existing
R-A bug, not a new one, and it is documented in three places. I am **re-affirming the
follow-up recommendation**: make `WasteEntry.timestamp` ISO end-to-end and format at the
renderer — it touches `WasteLogSection.tsx:218` and `:608`, which is why it is its own
spec. Do not "fix" it by dropping the focal-last merge; that trades a locale bug for a
staleness bug.

**M-2 — `computeScopedCogs` rounds `delta` beyond the specified expression.**
`cmdSelectors.ts:1114` computes `delta = +(actual - theoretical).toFixed(2)`; §5.3 and
AC-B6 both say `delta = Σactual − Σtheoretical`. Render-invisible (`Math.round(delta)` at
`DashboardSection.tsx:1087`), and it is a strict improvement (it clears binary-float dust
like `19.900000000000002`), so AC-S6's "equals today's output" holds at the rendered
level. Recording it only so nobody later reads the docblock's "same expressions" claim as
literal. No change requested.

**M-3 — `aggregateLabelFor`'s `.filter(Boolean)` makes the brand label slightly more
confident than §9.1 specified.** `DashboardSection.tsx:621`:
`Array.from(new Set(list.map((s) => s.brandId).filter(Boolean)))`. My §9.1 said "distinct
`brandId` over `scopedStores`; if not exactly 1 → `null`". Dropping falsy ids means a
scope of `[store with null brandId, store in brand A]` resolves to **one** distinct id and
prints `"2AM PROJECT · 2 stores"` over a set that includes a brand-less store.
`stores.brand_id` is nullable in the schema (`20260509000000_multi_brand_schema_rls.sql`
guards `s.brand_id is not null` at `:266`), so this state is representable. One-line fix:
map to `s.brandId ?? null` and keep nulls in the set, so a mixed set falls through to the
generic label. Low impact — reachable only for a super-admin on "All brands" with legacy
brand-less stores — but it is the R-B mitigation's own tripwire, so I'd rather it stay
strict.

**M-4 — `scopeStoreIds` is reconstructed by splitting a joined string.**
`DashboardSection.tsx:245-249`: `scopeIdsKey = ids.join(',')` then
`scopeStoreIds = scopeIdsKey.split(',')`. The intent (a membership-stable array identity
for the memo chain, R-D) is right and I endorse the outcome, but the round-trip silently
assumes no store id ever contains a comma. True for uuids; invisible if that ever changes.
Prefer deriving both from one `useMemo` returning `{ ids, key }`, or add a one-line comment
naming the uuid assumption.

**M-5 — the picker panel has no outside-press dismissal.** `ScopePicker`
(`DashboardSection.tsx:931-989`) closes on trigger toggle or option select only; clicking
elsewhere on the Dashboard leaves it open over the KPI row. Not in the contract (I didn't
specify it either), and no correctness impact. Flagging as UX polish for whoever touches
this next; a backdrop `Pressable` is the usual shape and would also help the S-2 native
case.

---

## 3. Status of the six §12 pushbacks

| # | §12 pushback | Outcome |
|---|---|---|
| 1 | AC-I1's key names superseded by the OQ-2 resolution (§9.2 is the grading target) | **Resolved.** `heroTitleScope` + the 5 companions landed in all three catalogs; `heroTitle` deleted with its call site. Reviewers should grade against §9.2, not AC-I1's table. |
| 2 | AC-P1's option label becomes brand-named with the §9.1 fallback | **Resolved.** One resolver feeds picker + hero (`DashboardSection.tsx:619-649`); they cannot disagree. See M-3 for the one edge that is looser than specified. |
| 3 | AC-B6 is silent on the cross-brand `recipes` gap — requested a PM amendment | **Resolved in substance; see the process note below.** |
| 4 | AC-T4's pgTAP condition does not fire (no RPC) | **Resolved / confirmed.** The read landed as PostgREST (`db.ts:849-855`). The absence of a pgTAP file is correct, not an omission. |
| 5 | AC-R5 is satisfiable without editing `PhoneDashboard.acReg.test.tsx` | **Resolved, and for the predicted reason.** That test is unedited and its `stores: []` / `inventory: []` seed (`:57-58`) is why. §12.5's tripwire ("if you're editing that test, something drifted") never fired. |
| 6 | Agreement with the rest of the AC set, incl. AC-B1 as a cross-brand leak fix | **Inherited and delivered.** AC-B1's exclusion of non-visible stores from the headline is implemented (`scopedInventory`, `:376-379`) and pinned by the component test's `$3.0k`-not-`$12.0k` assertion (`:170-172`). |

**On #3 (AC-B6) — do I still want the PM amendment?** No, and the documentation is in the
right places. The limitation is now recorded in three layers, with the durable one being
the code:

1. `cmdSelectors.ts:1086-1095` — a DOCUMENTED LIMITATION block in the `computeScopedCogs`
   docblock, which is where a future reader who is about to reuse this function will
   actually be looking.
2. `cmdSelectors.scopedRollups.test.ts:284-294` — a test that pins the *known-incomplete*
   behavior (`theoretical: 0`, `actual: 105`) with a comment saying the expectation is
   meant to change when the OQ-4 cross-brand recipe fetch lands. That is the strongest
   form of this documentation: it fails loudly if someone fixes the gap without revisiting
   the note.
3. `DashboardSection.tsx:540-544` at the call site.

A spec-file paragraph alone would have rotted; these won't. **Two process notes for the
release coordinator, neither blocking:** (a) the AC-B6 text in the spec body was amended by
the implementer rather than the PM — the wording is faithful to what §12.3 asked for and
is explicitly labeled "(architect R-B, recorded at build time)", but an acceptance
criterion edited by the implementer to describe the shipped behavior is a pattern worth
naming out loud; (b) the R-B label mitigation covers the multi-brand case only — a
single-brand scope whose brand's recipes aren't the loaded ones still labels confidently.
That path is currently unreachable (a brand switch re-derives `currentStore` and reloads
`recipes`, `useStore.ts:1497-1516`; "All brands" clears `currentStore` and the shell
forces the Brands section), so it is a note for the OQ-4 spec, not a finding here.

---

## 4. Things I checked that could have gone wrong and didn't

- No call site bypassed `src/lib/db.ts` — the fifth cross-store read goes through the same
  `db.*` namespace import as the other four (`DashboardSection.tsx:315`); no
  `supabase.from` / `supabase.rpc` appeared outside `db.ts` and the documented carve-outs.
- No permissive-policy work, so the spec-053 pgTAP lint surface is untouched.
- No migration → the `db-migrations-applied.yml` gate is a genuine no-op for this spec;
  `test.yml` gains three suites and `typecheck:test` was run (per the verification note).
- The `stores`-vs-`scopedStores` conflation I called out in §5.3 did not happen anywhere.
- `visibleStoresFor`'s fail-closed-`[]` first paint (R-E) is handled by the effect's
  `length === 0` early return plus the phone cushion; no double-fetch loop.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 2 Should-fix, 5 Minor findings.
payload_paths:
  - specs/159-dashboard-scope-picker/reviews/backend-architect.md
