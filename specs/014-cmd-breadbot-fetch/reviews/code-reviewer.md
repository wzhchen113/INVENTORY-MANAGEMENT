# Code review — spec 014

Reviewer: code-reviewer
Status at review time: READY_FOR_REVIEW

## Critical

None.

The architect's contract correction is correctly implemented: `FetchBreadbotModal.tsx:159` calls `onSingleFetched(filename, parsed, singleDate)`; `POSImportsSection.tsx:343-351` handles by setting `breadbotPreview` state and closing the modal; `POSImportsSection.tsx:181-243` confirms via `savePOSImport` + `importPOS` directly. `computeDiff` and `RunImportModal` are unreachable from the Breadbot path.

No direct Supabase calls outside `src/lib/db.ts`. No edits to frozen files (`AdminScreens.tsx`, `useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`, `POSImportScreen.tsx`). No `app.json` slug change. No new realtime channels. `posBreadbot.ts` has zero React or Supabase imports.

## Should-fix

- **`src/components/cmd/FetchBreadbotModal.tsx:70-78` (and reset useEffect at lines 94-99)** — Range-default initializers use `.toISOString().split('T')[0]` (UTC) instead of local-time math. For a user in UTC-5, after midnight UTC but before midnight local time, the reset produces "yesterday" as `rangeEnd` when the user expects today. Drift propagates to `rangeStart` too. `posBreadbot.ts` already establishes local-time convention with `todayISO()`. Fix: extract `yesterdayISO()` / `daysAgoISO(n)` helpers in `src/lib/posBreadbot.ts` mirroring `todayISO`'s local-component arithmetic, use them here and in the reset effect.

- **`src/screens/cmd/sections/POSImportsSection.tsx:184-193`** — `onConfirm` builds `items` from `breadbotPreview.rows` and `previewMatches` but does not guard against `previewMatches` being shorter than `rows`. If `matchRecipe` hasn't completed (recipes / aliases loaded mid-render), `previewMatches[idx]` is `undefined`; the optional chain (`m?.recipeId`) silently produces `recipeMapped: false`. Fix: disable the IMPORT button until matches catch up — `disabled={committing || previewMatches.length !== preview.rows.length}` on the confirm `TouchableOpacity`.

- **`src/screens/cmd/sections/POSImportsSection.tsx:564`** — `BreadbotPreviewCard` calls `useStore((s) => s.recipes)` directly. Parent `POSImportsSection` already subscribes at line 41. Duplicate subscription causes an extra re-render on every recipe change. Fix: thread `recipes` as a prop (consistent with how `BackfillSummaryCard` consumes only props).

## Nits

- `src/lib/posBreadbot.ts:54-64` — `enumerateDates` ported verbatim from legacy `POSImportScreen.tsx:52-63`. Comment correct.
- `src/components/cmd/FetchBreadbotModal.tsx:164` — `catch (e: any)` cast unavoidable; consistent with legacy.
- `src/components/cmd/FetchBreadbotModal.tsx:287-288` — empty `onPress={() => {}}` click-stopper on inner box matches `UploadCsvModal.tsx:88`. A short comment would help future readers: `{/* stops backdrop press event propagating to the outer dismiss handler */}`.
- `src/screens/cmd/sections/POSImportsSection.tsx:81-84` — `.slice().reverse()` could use a one-line `// slice() before reverse() — store array is frozen in place` comment.
- `src/screens/cmd/sections/POSImportsSection.tsx:890-901` — `SectionPanel` `style?: any` prop is pre-existing, not introduced by 014. Out of scope.
- `src/components/cmd/FetchBreadbotModal.tsx:511` — progress bar `width: ${...}%` template-literal percentage string is valid in RN 0.81 / RN-Web; container has `overflow: 'hidden'`. Just noting the pattern.

## Handoff

next_agent: NONE
prompt: Code review complete. 0 Critical, 3 Should-fix, 5 Nits. The architect's contract correction is correctly honored.
payload_paths:
  - src/lib/posBreadbot.ts
  - src/components/cmd/FetchBreadbotModal.tsx
  - src/screens/cmd/sections/POSImportsSection.tsx
  - specs/014-cmd-breadbot-fetch.md
