# Backend Architect — Post-impl drift review

Spec: 024-typescript-hygiene
Mode: post-implementation review (read-only, no Status mutation)
Date: 2026-05-13

## TL;DR

Implementation faithful to the design with three justified deviations and
one omitted-file catch by the developer. No `@ts-ignore` band-aids
introduced. The CI gate lands per the §CI workflow shape design. AC1-AC11
+ AC15 met; AC12 met. AC3/AC13 retain the documented coverage gap that
spec 025 closes.

## Drift inventory

| # | Deviation                                              | Verdict          |
| - | ------------------------------------------------------ | ---------------- |
| 1 | `@types/react-dom` tilde-pinned `~19.1.11`             | Approved Drift   |
| 2 | `StockHistoryChart.tsx` typed-spread cast (not delete) | Approved Drift   |
| 3 | `InventoryDesktopLayout.tsx` 3 bonus errors fixed      | Approved Drift   |
| 4 | `storeLoading` cascade-win                             | Faithful         |
| 5 | Q5a respected (no over-engineered config)              | Faithful         |
| 6 | Punch-list items 1-11 covered                          | Faithful         |
| 7 | CI workflow shape (`typecheck` between `jest` + `db`)  | Faithful         |

### 1. `@types/react-dom@~19.1.11` (tilde, not caret) — Approved Drift

Architect designed `^19.1.0`. Dev pinned `~19.1.11`. Verified at
`package.json:68` and `node_modules/@types/react-dom/package.json:3`.
The installed package's `peerDependencies` ([package.json:124](
/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/node_modules/@types/react-dom/package.json))
declares `@types/react@^19.0.0` which is satisfied by the locked
`@types/react@~19.1.10`. Tilde is the right call: the caret would have
allowed npm to resolve into the `19.2.x` line where the peer-dep
constraint tightens to `^19.2.0` and conflicts with our `@types/react`
floor.

Architect did flag this risk in §Risks #3 ("Mitigation: pin via caret to
^19.1.0; dev verifies the resolved version is also in the 19.1.x line").
The mitigation note told the dev to fall back to a stricter pin if
resolution drifted — which is exactly what happened. **Approved
Drift, no pushback.** The architect's only miss is that the design line
"caret to ^19.1.0" was prescriptive when "tilde or caret, whichever
holds 19.1.x" would have been more accurate.

### 2. `StockHistoryChart.tsx` typed-spread cast — Approved Drift

Architect's punch-list (items #10 + #11) said "delete the two
`@ts-expect-error` comments at lines 181 + 183". Dev found that only
line 183's bare directive was unused; line 181's directive was
suppressing a real `react-native-svg` `Circle` props error
(`onMouseEnter`/`onMouseLeave` not on the typed interface). Deleting it
verbatim would have surfaced a real error.

Resolution at
[`src/components/cmd/StockHistoryChart.tsx:186-190`](
/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/components/cmd/StockHistoryChart.tsx):

```tsx
{...({
  onMouseEnter: () => setHoveredIdx(i),
  onMouseLeave: () =>
    setHoveredIdx((h) => (h === i ? null : h)),
} as object)}
```

This is a real type fix, not a directive suppression. The cast widens
the spread's element-type from a specific event-handler shape to
`object`, letting JSX's prop-shape check accept it. Runtime behavior is
unchanged — the branch is still gated by `Platform.OS === 'web'` and
`react-native-svg-web` still forwards DOM events on web (this is the
exact reason the original `@ts-expect-error` was placed there in spec
002 era).

Borderline: a cast to `object` is permissive (anything is an `object`).
A tighter cast — `as React.HTMLAttributes<SVGCircleElement>` — would be
stricter and document intent better. Not a blocker; the dev's choice
satisfies AC5 ("no `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`
band-aids") and the runtime is unchanged. **Approved Drift.** Surface
the tighter-cast option as a one-line follow-up if the team wants the
extra rigor.

### 3. `InventoryDesktopLayout.tsx` 3 bonus errors fixed — Approved Drift

Architect's punch-list did not enumerate `InventoryDesktopLayout.tsx`
explicitly. The file appeared only in the Q5a corollary table at spec
line 457 as an importer of `IngredientFormDrawer.tsx`, not as a target
of fixes. The dev caught three errors at
[`src/screens/cmd/InventoryDesktopLayout.tsx:554-557`](
/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/InventoryDesktopLayout.tsx):

- `Math.max(...series)` — element type `number | null` rejected.
- `series.slice(-4).reduce((s, v) => s + (v ?? 0), 0)` — accumulator
  inferred as `number | null` without an explicit generic.
- `sum28d.toFixed(1)` — `sum28d` may have been null.

Fix shape:
- `.map((v) => v ?? 0)` before `Math.max` — coerces nulls to 0.
- Explicit `<number>` generic on `.reduce<number>(...)` — pins the
  accumulator type. The `<number>` form was not the architect's design
  but is the canonical fix for this exact diagnostic.

Verified that the dev's fix matches the existing `v ?? 0` pattern at
the same reducer (line 557 reads `s + (v ?? 0)`), so behavior is
consistent. No runtime delta.

**This was a real architect miss.** Two contributing factors:

1. `tsconfig.test.json` doesn't reach `InventoryDesktopLayout.tsx`
   (Q5a corollary). The architect's "design-time error enumeration"
   relied on `tsc --noEmit -p tsconfig.test.json` empirical capture
   from the test-engineer's 2026-05-13 pass — which would NOT have
   surfaced these three errors.
2. The errors were a downstream consequence of `StockHistoryChart`'s
   `data: Array<number | null>` (line 9 of StockHistoryChart.tsx). The
   architect verified imports OF `StockHistoryChart` (Q5a corollary)
   but didn't grep the type widening's propagation through its
   call sites.

Surface as a forward-compat lesson for the design phase of spec 025:
when widening a public component prop, grep the call sites for type-
narrowing assumptions even when the call site isn't in the architect's
explicit error list. **Approved Drift** because the AC4 ("Whole non-
legacy graph clean") frames this exactly as "additional non-legacy
errors fall under AC4 and the spec adds an in-line note rather than a
new AC" — the dev's bonus fix is in-scope per that AC's wording.

### 4. `storeLoading` cascade-win — Faithful

Architect predicted (§AC6, §Risks #5) that adding `storeLoading: boolean`
to `AppState` would resolve `AppNavigator.tsx`'s two `s.storeLoading`
reads transitively. Verified at
[`src/types/index.ts:489`](
/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/types/index.ts) +
[`src/navigation/AppNavigator.tsx:502, 697`](
/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/navigation/AppNavigator.tsx).

The two `useStore((s) => s.storeLoading)` selectors at 502 + 697 access
the field via `FullStore` (= `AppState & StoreActions`,
`useStore.ts:366`). The new field on `AppState` cascades through the
intersection. No manual edit to `AppNavigator.tsx`. CLAUDE.md
"agents must not modify legacy files" rule respected.

### 5. Q5a respected — Faithful

Architect's Q5a verdict was "no narrowing needed for
`tsconfig.test.json`". The dev did NOT add a `tsconfig.ci.json`, did
NOT add `exclude` entries to `tsconfig.test.json`, did NOT
file-narrow the `tsc` invocation. The single `npm run typecheck:test`
script (which spec 022 placed at `package.json:21`) is what the new
CI job runs. The four Cmd UI component files outside the test-
reachable graph are documented as a known-limitation in
[`tests/README.md:16-19`](
/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/tests/README.md) and
deferred to spec 025 per AC13.

**No over-engineering of the CI to catch what spec 025 will close.**
The dev held the scope.

### 6. Punch-list coverage — Faithful, with one nuance

All 11 architect-enumerated edit locations addressed. Verified per
file:

| # | Punch-list item                                       | Status / location verified                                     |
| - | ----------------------------------------------------- | -------------------------------------------------------------- |
| 1 | `webPush.ts:97` BufferSource                          | `src/lib/webPush.ts:182` — return type widened to `BufferSource` |
| 2 | `useStore.ts:821` storeLoading set call               | `src/store/useStore.ts:821` (now compiles via AC6)             |
| 3 | `useStore.ts:916` storeLoading finally set            | `src/store/useStore.ts:916` (cascade via AC6)                  |
| 4 | `useStore.ts:923` duplicate-key (4 cols)              | `src/store/useStore.ts:923` — collapsed to `{...item, id: tempId}` |
| 5 | `useStore.ts:1746` 'User deleted' AuditAction         | Resolved via `types/index.ts:387` union extension              |
| 6 | `useStore.ts:1847` OrderSubmission.storeName          | Resolved via `types/index.ts:425` `storeName?: string`         |
| 7 | `BrandPicker.tsx:240` createPortal                    | Resolved via `@types/react-dom` install (no source edit)       |
| 8 | `TitleBar.tsx:3` react-dom static import              | Resolved via `@types/react-dom` install (no source edit)       |
| 9 | `IngredientFormDrawer.tsx:67` expiryDate null         | Resolved via `types/index.ts:88` widening to `string \| null`  |
| 10 | `StockHistoryChart.tsx:181` ts-expect-error           | Real fix via typed spread (Approved Drift above)               |
| 11 | `StockHistoryChart.tsx:183` ts-expect-error           | Deleted (the actually-unused one)                              |

No `@ts-ignore` / `@ts-nocheck` introduced. Existing pre-spec
`@ts-ignore` comments at
[`src/screens/cmd/sections/InventoryCountSection.tsx:507`,
`src/screens/cmd/sections/BrandsSection.tsx:749, 782`](
/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src) are out of
scope and untouched.

**Nuance:** the architect's punch-list listed items #10 and #11 as
"delete both directives". The actual state was "delete one, replace
the other with a real type fix". The architect's prediction was
incorrect in shape (assumed both unused), but the dev correctly
discriminated and applied the right treatment to each. Recorded as
Approved Drift in #2 above; the punch-list coverage line is Faithful
modulo that nuance.

### 7. CI workflow shape — Faithful

Verified at
[`.github/workflows/test.yml:59-78`](
/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/.github/workflows/test.yml).

- Job ordering: `jest` → `typecheck` → `db`. Matches the architect's
  design "slot it between jest and db so the lightest gate fails
  fastest".
- `permissions:` not redeclared at job level. The file-level
  `permissions: contents: read` (line 33-34) inherits. Matches design
  note "No `permissions:` override at job level. The file-level
  permissions already applies. Closes the spec-022 security-auditor
  finding M1 by inheritance."
- `timeout-minutes: 10` matches the design. Comment at line 62-63
  ("Cold-start is faster than jest's; 10 minutes is generous") is
  consistent with the architect's "typecheck is faster than jest cold
  start, so 10 minutes is generous" note.
- Script alias `npm run typecheck:test` is used, not inline
  `npx tsc -p tsconfig.test.json --noEmit`. Matches the design note
  "Script alias preferred over inline `npx tsc -p ...`".
- File header comment (lines 1-23) cross-references spec 024 and the
  Q5a corollary gap. Bonus rigor not strictly required by the
  architect but consistent with the spec's intent.

## Acceptance criteria coverage

| AC  | Status | Notes                                                                                   |
| --- | ------ | --------------------------------------------------------------------------------------- |
| AC1 | met    | `useStore.ts` clean per `tsc -p tsconfig.test.json`.                                    |
| AC2 | met    | `webPush.ts` clean.                                                                     |
| AC3 | partial-met by-design | Cmd UI component fixes landed but verifiability is by base `tsc --noEmit` (manual at PR time), per spec 024 §Q5a corollary. Spec 025 closes the gap. |
| AC4 | met    | Test-reachable subset clean; bonus `InventoryDesktopLayout.tsx` errors also fixed under "additional non-legacy errors fall under AC4" framing. |
| AC5 | met    | No new `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`. The typed-spread cast in StockHistoryChart is a real type narrowing, not a suppression. |
| AC6 | met    | `storeLoading: boolean` on `AppState`; cascade win to AppNavigator.tsx confirmed.       |
| AC7 | met    | `storeName?: string` on `OrderSubmission`.                                              |
| AC8 | met    | `'User deleted'` in `AuditAction` union at `types/index.ts:387`.                        |
| AC9 | met    | 4 dead defaults removed at `useStore.ts:923`. Runtime parity verified by inspection (csvImport.ts spreads all four; IngredientFormDrawer.toUpdates returns all four). |
| AC10 | met   | `urlBase64ToUint8Array` return type widened to `BufferSource`.                          |
| AC11 | met   | `@types/react-dom@~19.1.11` in devDependencies (tilde pin, see Approved Drift #1).      |
| AC12 | met   | `typecheck` job in `test.yml`. Required-status flag is a repo-settings concern outside the workflow file. |
| AC13 | met   | Base `npx tsc --noEmit` NOT added in this spec. Deferred to 025.                        |
| AC14 | met   | Existing `typecheck:test` script reused; no new script.                                 |
| AC15 | met   | `tests/README.md` updated at lines 13-20 and 38-44.                                     |
| AC16 | met   | Behavior parity verified: AC9 dead-defaults trace and the typed-spread cast both preserve runtime semantics. |

## Forward-compat note for spec 025

Three workstreams remain for spec 025:

1. **Legacy file TS sweep.** Files with expected residual errors after
   spec 024's cascade wins:
   - `src/screens/AdminScreens.tsx` (largest residual surface, 104 KB).
   - `src/screens/EODCountScreen.tsx`, `IngredientsScreen.tsx`,
     `PrepRecipesScreen.tsx`, `IngredientEditor.tsx`.
   - `src/navigation/AppNavigator.tsx` — Spec 024 §AC6 cascade win
     resolved the two `s.storeLoading` reads (verified above). Net
     zero edits expected unless other independent errors lurk; spec
     025 should run base `tsc --noEmit` first to enumerate.
   - `scripts/test-unit-conversion.ts` — one-off.

2. **Base `typecheck-base` CI gate.** Add a fourth job running
   `npx tsc --noEmit` (no `-p`). This is the gate spec 024 §AC13
   explicitly deferred. The gate will catch regressions in:
   - The four Cmd UI component files (`BrandPicker.tsx`,
     `TitleBar.tsx`, `IngredientFormDrawer.tsx`,
     `StockHistoryChart.tsx`) — currently outside the test-reachable
     subset.
   - `InventoryDesktopLayout.tsx` — the file the dev caught in this
     pass, also outside the test-reachable subset; a future widening
     of `StockHistoryChart.data` shape would re-introduce the same
     class of errors.

3. **Collapse of the two `tsc` invocations.** If spec 025 deletes the
   legacy graph in-place rather than fixes it, the test config and
   base config converge to the same set of files and the two CI jobs
   collapse to one. Surface this option to PM at the design phase of
   025.

**Architect-side lesson absorbed for 025:** when designing a type
widening that crosses a component-API boundary (as the
`StockHistoryChart.data: Array<number | null>` widening did), grep
all call sites for type-narrowing assumptions, not just imports. The
`InventoryDesktopLayout.tsx` miss was a small but real design gap.

## Files reviewed

Files cited inline above (absolute paths):

- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/024-typescript-hygiene/spec.md`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/types/index.ts`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/store/useStore.ts`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/lib/webPush.ts`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/components/cmd/StockHistoryChart.tsx`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/components/cmd/IngredientFormDrawer.tsx`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/components/cmd/BrandPicker.tsx`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/InventoryDesktopLayout.tsx`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/navigation/AppNavigator.tsx`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/.github/workflows/test.yml`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/package.json`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/node_modules/@types/react-dom/package.json`
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/tests/README.md`

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix,
  1 Minor (StockHistoryChart's typed-spread `as object` cast could be
  tightened to `as React.HTMLAttributes<SVGCircleElement>` for stricter
  intent documentation — non-blocking). Three deviations classified as
  Approved Drift, four items Faithful. Forward-compat note for spec
  025 absorbed (grep call sites when widening component prop shapes).
payload_paths:
  - specs/024-typescript-hygiene/reviews/backend-architect.md
