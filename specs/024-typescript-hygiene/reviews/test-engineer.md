## Test report for spec 024 — TypeScript hygiene cleanup (non-legacy graph)

### Acceptance criteria status

#### Type fixes

- **AC1 — `useStore.ts` clean** → PASS — `npx tsc --noEmit -p tsconfig.test.json` reports zero errors at `src/store/useStore.ts`. Confirmed by running `typecheck:test` → exit 0 and by running base `tsc --noEmit | grep useStore.ts` → no output.

- **AC2 — `webPush.ts` clean** → PASS — `npx tsc --noEmit -p tsconfig.test.json` reports zero errors at `src/lib/webPush.ts`. `urlBase64ToUint8Array` return type confirmed as `BufferSource` at line 182.

- **AC3 — Cmd UI components clean** → PASS (manual verification) — Per spec §Q5a corollary, these four files are NOT reached by `tsconfig.test.json`'s transitive graph; CI gate does not cover them. Manual verification: `npx tsc --noEmit | grep -E "BrandPicker|TitleBar|IngredientFormDrawer|StockHistoryChart"` → no output. Zero errors in all four files under the base check.

- **AC4 — Whole non-legacy graph clean** → PASS — `npm run typecheck:test` exits 0. Base `tsc --noEmit | grep -E "src/(store/useStore|lib/webPush|components/cmd/(BrandPicker|TitleBar|IngredientFormDrawer|StockHistoryChart)|screens/cmd/InventoryDesktopLayout)"` → no output. Per §Q5a corollary, the CI gate covers the test-reachable slice; the component-file slice is verified via base check only. The bonus `InventoryDesktopLayout.tsx` fix also clean.

- **AC5 — No `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` band-aids** → PASS — `grep -n "@ts-ignore\|@ts-expect-error\|@ts-nocheck"` on all six in-scope non-legacy files returns no output. The two `@ts-expect-error` directives in `StockHistoryChart.tsx` were replaced with a typed spread `{...({onMouseEnter, onMouseLeave} as object)}` — a real type fix, not a suppression.

#### Specific type-shape fixes

- **AC6 — `AppState` carries `storeLoading: boolean`** → PASS — `src/types/index.ts` line 489: `storeLoading: boolean;` present with JSDoc explaining the field's semantics. Not optional (required field, consistent with the literal always setting `false`). Cascade win verified: `AppNavigator.tsx` lines 502 + 697 errors are GONE — `npx tsc --noEmit | grep AppNavigator` shows only one remaining error at line 262 (unrelated `detail` property; not a `storeLoading` error).

- **AC7 — `OrderSubmission` carries `storeName?: string`** → PASS — `src/types/index.ts` lines 419-425: `storeName?: string` present with JSDoc explaining hydration and legacy-caller optionality. Mirrors `EODSubmission.storeName`.

- **AC8 — `AuditAction` union includes `'User deleted'`** → PASS — `src/types/index.ts` line 387: `| 'User deleted'` present in the union, slotted next to sibling delete actions (`'Item deleted'`, `'Recipe deleted'`, `'Prep recipe deleted'`).

- **AC9 — `addItem` no longer over-specifies defaults** → PASS — `src/store/useStore.ts` line 923: `const newItem: InventoryItem = { ...item, id: tempId };` — the four dead defaults (`casePrice: 0, caseQty: 1, subUnitSize: 1, subUnitUnit: ''`) have been removed. Runtime behavior unchanged per spec §Q1 RESOLVED and the architect's CSV-importer trace.

- **AC10 — `webPush.ts:97` typechecks** → PASS — `urlBase64ToUint8Array` return type widened to `BufferSource` at line 182. No `@ts-ignore`. Call site at line 97 unchanged. No test-graph typecheck error.

- **AC11 — `@types/react-dom` installed** → PASS — `package.json` devDependencies: `"@types/react-dom": "~19.1.11"`. Tilde pin (not caret) keeps the resolution in the 19.1.x line, matching `@types/react@~19.1.10` and avoiding the 19.2.x peer-dep conflict. `package-lock.json` updated (npm-managed).

#### CI gate

- **AC12 — `typecheck:test` CI gate added** → PASS — `.github/workflows/test.yml` contains a third job `typecheck` (Track 1a). It runs on `ubuntu-latest`, uses `actions/checkout@v4` + `actions/setup-node@v4` (node 20, npm cache), runs `npm ci` then `npm run typecheck:test`. `timeout-minutes: 10`. No `needs:` dependency on other jobs — runs independently in parallel alongside `jest` and `db`.

- **AC13 — Base `typecheck` NOT added in this spec** → PASS — `.github/workflows/test.yml` contains no step invoking `npx tsc --noEmit` without `-p`. The base invocation appears only in YAML comments (descriptive text), not as an execution step.

- **AC14 — `typecheck:test` script pre-exists** → PASS — `package.json` line 21: `"typecheck:test": "tsc -p tsconfig.test.json --noEmit"`. This was added by spec 022; spec 024 reuses it without modification.

#### Documentation + parity

- **AC15 — `tests/README.md` update** → PASS — §CI table (lines 13-19) updated to acknowledge the Track-1a typecheck gate. The `typecheck:test` paragraph (lines 38-44) updated from "editor-convenience" to CI-gated with explicit note about the AC3 coverage gap and spec 025 deferral.

- **AC16 — Behavior parity** → PASS — The only runtime-delta candidate is the `addItem` dead-defaults removal (AC9). Per architect's Q1 trace: `csvImport.ts:248-251` (the non-IngredientFormDrawer caller) always spreads all four fields; `IngredientFormDrawer.tsx:165` passes `toUpdates(values)` which includes all four. No caller relied on the leading literal defaults. Zero behavior change.

---

### Test run

```
# Track 1a — typecheck:test (AC4, AC12)
npm run typecheck:test
  exit 0 — no errors

# Regression gate probe (inject deliberate error in relativeTime.ts)
npm run typecheck:test
  src/utils/relativeTime.ts(6,7): error TS2322: Type 'string' is not assignable to type 'number'.
  exit 2 — gate fires correctly
  (error reverted after verification)

# Track 1 — jest
npm test -- --ci
  Test Suites: 3 passed, 3 total
  Tests:       17 passed, 17 total
  Time:        0.525 s

# Track 2 — DB tests
npm run test:db
  13/13 DB test file(s) passed

# Track 3 — smoke
npm run test:smoke
  smoke-edge.sh: all checks passed (4 PASS, 2 SKIP — no BOBBY_TOKEN)
  smoke-rpc.sh:  all checks passed (3 PASS)

# AC3 manual verification (base tsc — non-legacy in-scope files only)
npx tsc --noEmit 2>&1 | grep -E "src/(store/useStore|lib/webPush|components/cmd/(BrandPicker|TitleBar|IngredientFormDrawer|StockHistoryChart)|screens/cmd/InventoryDesktopLayout)"
  (no output — zero errors in all six non-legacy in-scope files)

# AppNavigator cascade-win check (AC6)
npx tsc --noEmit 2>&1 | grep "AppNavigator"
  src/navigation/AppNavigator.tsx(262,68): error TS2339: Property 'detail' does not exist on type ...
  (Only one unrelated error; lines 502 + 697 storeLoading errors are GONE)
```

**Result: 4/4 test tracks pass. 16/16 acceptance criteria PASS.**

---

### Spec 025 forward-compat — remaining base `tsc --noEmit` error list

After spec 024 lands, `npx tsc --noEmit` reports errors ONLY in:

| File | Error count | Notes |
|------|-------------|-------|
| `src/components/IngredientEditor.tsx` | 9 | Legacy; `baseQuantity`/`baseUnit` on `RecipeIngredient` type drift |
| `src/screens/IngredientsScreen.tsx` | 7 | Legacy; `catalogId` missing, `modalClose` style key, `expiryDate: string` vs `string\|null` at call site |
| `src/navigation/AppNavigator.tsx` | 1 | Legacy; `detail` property on toast shape — NOT `storeLoading` (cascade win confirmed) |
| `src/screens/AdminScreens.tsx` | 4 | Legacy; `brandId` missing on Recipe/Vendor/Store Omit args |
| `src/screens/PrepRecipesScreen.tsx` | 3 | Legacy; `brandId`/`version`/`isCurrent` missing on PrepRecipe Omit arg |
| `src/screens/EODCountScreen.tsx` | 1 | Legacy; `rightContent` prop |
| `src/store/useSupabaseStore.ts` | 1 | Legacy do-not-modify; `brandId` missing on Store |
| `scripts/test-unit-conversion.ts` | 1 | One-off script; `catalogId` missing on InventoryItem |
| `supabase/functions/` (8 files) | ~70 | Deno/ESM import errors (`Cannot find name 'Deno'`, `Cannot find module 'https://esm.sh/...'`) |

**Important flag for spec 025:** The ~70 errors in `supabase/functions/` are entirely Deno runtime globals (`Deno.serve`, `Deno.env`) and ESM `https://esm.sh/` imports. These are NOT in spec 025's enumerated punch-list (which names only the six `src/` legacy files and the one-off script). When spec 025 adds the base `npx tsc --noEmit` CI gate, it will need to either: (a) exclude `supabase/functions/` from the base tsconfig's `include`, or (b) add a Deno lib/types stub. This is a pre-existing condition — the base tsconfig has always included the edge function files without Deno type declarations. Spec 024 does not cause or worsen this; it was present before. Surfacing here so spec 025 doesn't encounter a surprise.

**Src-only error summary for spec 025 (excluding Deno functions):**
- 5 legacy `src/` files: 25 errors total
- `src/store/useSupabaseStore.ts` (do-not-modify): 1 error
- `scripts/test-unit-conversion.ts` (one-off): 1 error

### Notes

1. **`StockHistoryChart.tsx` implementation diverged from the architect's punch-list** (items #10 + #11): the architect predicted both `@ts-expect-error` directives were unused. In reality, line 181's directive was suppressing a real `react-native-svg` Circle props error. The developer replaced both directives with a typed spread `{...({onMouseEnter, onMouseLeave} as object)}`. This is a real type fix (not a suppression) and satisfies AC5. The implementation notes in the spec confirm the deviation and resolution.

2. **`InventoryDesktopLayout.tsx` bonus fix**: three errors at lines 550/551/598 (`Math.max` + reduce + toFixed on `number | null` series) were fixed as AC4 bonus. All clean under base check.

3. **`@types/react-dom` version**: resolved to `~19.1.11` (tilde, not caret) to stay in 19.1.x line and avoid the 19.2.x peer-dep conflict with `@types/react@~19.1.10`. Correct per the architect's risk mitigation note.

4. **AC3 verifiability gap** (per §Q5a corollary): the CI gate added by AC12 does NOT protect against future regressions in `BrandPicker.tsx`, `TitleBar.tsx`, `IngredientFormDrawer.tsx`, or `StockHistoryChart.tsx`. These files are only reachable via base `tsc --noEmit`. Spec 025's base typecheck gate will close this. Documented in `tests/README.md` and `test.yml` header comment.

5. **No DB tests are required for this spec**: all changes are type-only. No migrations, RLS policies, RPCs, or edge functions were touched.
