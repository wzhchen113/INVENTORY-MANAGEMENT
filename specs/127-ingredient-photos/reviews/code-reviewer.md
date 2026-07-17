# Code review for spec 127 (ingredient photos)

Scope: frontend-owned files from `## Files changed` (`src/utils/downscaleImage.ts` +
test, `src/components/cmd/IngredientPhotoControl.tsx` + test, `src/screens/staff/
components/IngredientThumb.tsx` + test, `IngredientForm.tsx`, `IngredientFormDrawer.tsx`,
`src/store/useStore.ts`, `EODCount.tsx`, `WeeklyCount.tsx`). Backend-owned files
(migration, `db.ts`, `ingredientImage.ts`, types, pgTAP) were read for context/
consistency but landed in a parallel pass and are consumed, not modified, here.

Overall: clean implementation, well-commented, consistent with existing patterns
(optimistic-then-revert, `useCmdColors()`/staff theme tokens, `Platform.OS === 'web'`
gating, snake_case↔camelCase projection discipline). No Critical findings.

### Critical
None.

### Should-fix
- `src/components/cmd/IngredientPhotoControl.test.tsx:4-6` and `:102` — the test file's
  header docstring and one `it()` description still say the store's
  `uploadIngredientImage` is called "with (catalogId, brandId, blob, previousPath)" /
  "passes previousPath on replace". That was the spec §7 sketch signature; the
  shipped, reviewed-and-accepted contract (per the spec's own "Note for reviewers")
  is `uploadIngredientImage(catalogId, brandId, blob)` with `previousPath` resolved
  internally in `db.ts`. The assertion at line 99 (and the inline comment right above
  it) already reflects the correct 3-arg shape, so the test itself is not wrong — but
  the docstring/description text is stale and will mislead the next reader into
  thinking a 4th arg is still part of the contract. Update the header comment (lines
  4-6) and the `it()` title (line 102) to match the actual signature, the same way
  the inline comment at line 98 already does.

### Nits
- `src/components/cmd/IngredientPhotoControl.tsx:139` — `color: '#000'` is an inline
  color literal instead of a `useCmdColors()` token (e.g. `C.accentFg`). Not flagging
  as Should-fix: this exact pattern (`'#000'` on an accent-colored button) already
  exists in 10 other `src/components/cmd/*` files and is a known, tracked cleanup
  item (the "'#000'-on-accent sweep (~35 left)" backlog). This file is consistent
  with the surrounding codebase, not a new deviation.
- `src/store/useStore.ts:1584-1606` — `uploadIngredientImage`'s store action does not
  set an optimistic `imagePath` before the async call resolves (only patches on
  success), which is a narrower application of the optimistic-then-revert convention
  than e.g. `removeIngredientImage` right below it (which does set-then-revert). The
  comment at 1584-1588 explains why: the real object path is server-generated
  (fresh uuid per upload), so there's nothing meaningful to set optimistically, and
  `IngredientPhotoControl` compensates with its own local `path` state mirror for
  immediate preview feedback. This is a reasoned, documented deviation rather than a
  missed pattern — flagging only so it's visibly assessed, not because it needs a
  change.
- `src/screens/staff/screens/EODCount.tsx:728-749` — the new `leadingText` wrapper
  `<View>` (added to hold the name/unit/total stack next to `IngredientThumb`) isn't
  indented one level relative to its children; the three `<Text>` blocks read as
  siblings of the `View` rather than children at a glance. Cosmetic only (JSX still
  nests correctly), but worth a quick reflow for readability given how dense this
  render function already is.
- `src/lib/db.ts:4837-4841` / `:4900` — `uploadIngredientImage`/`removeIngredientImage`
  have no defensive empty-`catalogId`/`brandId` early-return, unlike the sibling
  `updateCatalogIngredient` (`if (!catalogId || catalogId.length < 10) return;` at
  db.ts:4788). The store layer guards before calling (`useStore.ts:1590`,`:1612`), so
  this isn't reachable with an empty id today, but the asymmetry with the sibling
  helper is worth a one-line note if another caller is added later. Not blocking —
  informational only, backend-owned file.
- `src/components/cmd/IngredientPhotoControl.test.tsx` — only exercises the
  `Platform.OS === 'web'` branch; there's no test asserting the native view-only
  render (no picker, no Upload/Remove buttons) that spec §14(e) calls out
  ("the admin editor photo control is web-gated"). Likely a test-engineer item, not
  re-raising as a code-quality issue here — noting for completeness since the AC
  text mentions it.

### Assessment of the flagged focus areas
1. **`uploadIngredientImage` sequencing** (`db.ts:4837-4892`) — correct: read
   previous path → upload new object → update column (orphan-cleanup-then-rethrow
   on failure) → best-effort delete old object on success. Matches spec §4 exactly.
2. **Migration idempotency** (`20260721000000_ingredient_photos.sql`) — correct:
   `add column if not exists`, bucket `on conflict do update`, and
   `drop policy if exists` before every `create policy`. Safe for local+prod
   double-apply.
3. **`downscaleImage` correctness** (`src/utils/downscaleImage.ts`) — aspect
   preserved and never-upscale logic in `fitWithinMaxEdge` is correct and unit
   tested at the boundary (exactly-at-cap, portrait/landscape, sub-pixel rounding).
   Web-guarded (`Platform.OS !== 'web'` throws) and guards missing browser APIs.
   Canvas is never appended to the DOM so there's nothing to explicitly clean up
   beyond `bitmap.close?.()` in the `finally`, which is present.
4. **`IngredientThumb` placeholder** — fixed box via `styles.thumb` shared between
   the `<Image>` and placeholder `<View>` branches; test explicitly asserts equal
   width/height across both states. Correct.
5. **Photo control web-only + states** — `Platform.OS === 'web'` gates the entire
   picker/action row; native renders read-only text. Upload/Replace/Remove/error
   states are all handled with a single `status` state machine and inline error
   text. Correct, modulo the stale test docstring above.
6. **Store optimistic-then-revert** — `removeIngredientImage` follows the pattern
   exactly (optimistic null → call → revert both `catalogIngredients` and joined
   `inventory` rows + `notifyBackendError` on throw). `uploadIngredientImage`
   deviates (patch-on-success only) for the reasoned, documented reason above — no
   incorrect state results either way.
7. **`image_path`→`imagePath` projection** — verified consistent across
   `fetchInventory`/`mapItem` (`db.ts:242`,`:5269-5273`), `fetchCatalogIngredients`
   (`db.ts:4769-4771`), and both staff fetches (`EODCount.tsx:148,160,191`,
   `WeeklyCount.tsx:97,108,131`). No naming drift; all fall back to `null`, never
   `undefined`, matching the `i18nNames` precedent.

### Contract drift note (assessed)
The `## Files changed` section's "resolved contract drift" — `uploadIngredientImage`/
`removeIngredientImage` reading the previous/current path internally instead of
taking it as a param — is clean. It removes a class of bugs where the caller's
in-memory `previousPath` could be stale relative to the DB, at the cost of one extra
SELECT per call (acceptable for an admin-only, low-frequency write path). All
consumers (store, component, tests) were aligned to the shipped 3-arg/1-arg
signatures; the only loose end is the stale test docstring noted above.
