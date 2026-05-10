# Code review — spec 015

Reviewer: code-reviewer
Status at review time: READY_FOR_REVIEW

## Critical

- **`src/screens/cmd/sections/POSImportsSection.tsx:18,848`** — Direct `fetchUnmappedPosImports` call from the screen, bypassing the store. CLAUDE.md says "All PostgREST/RPC traffic flows through `src/lib/db.ts`" — the function is in `db.ts` (correct), but the project's idiomatic pattern is store-mediated. The architect's §9 design explicitly called this from the component, so there may be an intentional decision. Recommend either a `loadUnmappedPosImports` store action that writes to a `serverUnmappedPosNames` slice, or document the exception in CLAUDE.md.

  _Reviewer caveat: a pre-existing `savePOSImport` direct call (spec 014) is the same shape. If the team accepts this as fetch-only-from-screen, neither is a bug._

## Should-fix

- **`src/screens/cmd/sections/POSImportsSection.tsx:920-943`** — `handlePickForUnmapped`'s `catch` branch is unreachable because `upsertPosRecipeAliases` (store action) swallows errors. The wrapping `try/catch` at line 922 always resolves; the "Mapping failed" toast (932-937) can never fire for upsert failures. Fix: either re-throw in the store action, or remove the wrapping try/catch and rely on the store's existing `console.warn`.

- **`src/screens/cmd/sections/POSImportsSection.tsx:969-977`** — `handleRemove` calls `removePosRecipeAlias(posName)` fire-and-forget without a `void` keyword. Add `void removePosRecipeAlias(posName)` to make intent explicit.

- **`src/store/useStore.ts:1501-1521`** — `removePosRecipeAlias` is `async`+`await` with `try/catch`, but the spec says it mirrors `removeOrderScheduleEntry` which is fire-and-forget `.catch()`. Functionally correct but structurally divergent. Fix: convert to `.catch()` pattern, or update the spec comment to "analogous to, but async".

- **`src/components/cmd/RecipePickerModal.tsx:128, 289`** — "esc" hint renders on native too (handler is web-gated, but the label isn't). Wrap in `Platform.OS === 'web' ? <Text>esc</Text> : null` and trim the suffix from CANCEL on non-web.

- **`src/screens/cmd/sections/POSImportsSection.tsx:78-91`** — Re-match `useEffect` lists `previewOverrides` as a dependency, causing N-row match re-runs on every override change. Structurally necessary, but warrants a comment so a future maintainer doesn't remove the dependency thinking it's redundant.

## Nits

- `src/components/cmd/RecipePickerModal.tsx:94` — `onPress={() => {}}` empty no-op for backdrop swallow; consistent with `RunImportModal`.
- `src/components/cmd/RecipePickerModal.tsx:105` — `boxShadow as any` web-only cast; matches `FetchBreadbotModal` precedent.
- `src/store/useStore.ts:1478` — `if (updated > 0)` guard correct; comment connecting to `posImports` not in `loadFromSupabase` would help.
- `src/screens/cmd/sections/POSImportsSection.tsx:1001` — `unmapped.slice(0, 50)` silently caps; consider "…and N more" footer or TODO comment.
- `src/screens/cmd/sections/POSImportsSection.tsx:1074` — `c.recipe_id.slice(0, 6)` should be `(c.recipe_id || '').slice(0, 6)`.
- `src/components/cmd/RecipePickerModal.tsx:78` — Early `if (!visible) return null` after hooks is fine but redundant with internal `!visible` checks.
- `src/screens/cmd/sections/POSImportsSection.tsx:858-863` — Three `useState` calls for picker state could collapse into one `pickerState: {...} | null`; React 18 batches anyway, so nit.
- (out-of-scope) Pre-existing `savePOSImport` direct call (spec 014 artifact); same convention question as the Critical.

## Handoff

next_agent: NONE
prompt: Code review complete. 1 Critical (debatable convention), 4 Should-fix, 7 Nits.
payload_paths:
  - specs/015-pos-mapping-pickers.md
  - src/components/cmd/RecipePickerModal.tsx
  - src/screens/cmd/sections/POSImportsSection.tsx
  - src/lib/db.ts
  - src/store/useStore.ts
