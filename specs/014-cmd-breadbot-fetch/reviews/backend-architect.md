# Backend architect — drift review (spec 014, post-impl)

Reviewed: `src/lib/posBreadbot.ts`, `src/components/cmd/FetchBreadbotModal.tsx`,
`src/screens/cmd/sections/POSImportsSection.tsx`, against the design at
`specs/014-cmd-breadbot-fetch.md` lines 203-543.

Verdict: **No critical drift.** The five mandated checks are all honoured.
Two minor architectural notes and one tradeoff observation below.

---

## Critical findings

None.

The implementation matches every load-bearing element of the design:

1. **Contract correction honoured.** Breadbot single-fetch does NOT route
   through `computeDiff` → `RunImportModal`. Confirmed by reading
   `POSImportsSection.tsx:181-242` — the section's `onConfirm` handler
   calls `savePOSImport` (line 199) + `importPOS` (line 207) +
   `upsertPosRecipeAliases` (line 222) directly, exactly as the legacy
   `handleImport` at `POSImportScreen.tsx:330-358` does. `computeDiff` is
   imported (`POSImportsSection.tsx:15`) but only ever invoked in the CSV
   path at line 324 (`onContinue` of `UploadCsvModal`). The Breadbot
   `onSingleFetched` callback at line 343-352 sets `breadbotPreview` and
   never touches `pendingDiff` / `pendingFilename`.

2. **Pending CSV diff invalidation on modal open** (spec lines 103-107).
   `POSImportsSection.tsx:111-115` clears `setPendingDiff(null)` and
   `setPendingFilename('')` inside the `FETCH BREADBOT` button's `onPress`
   before flipping `setBreadbotOpen(true)`. The invalidation is at the
   correct moment (modal-open intent, not modal-close), matches design
   line 480 verbatim. The spec wording at line 106 says "when the user
   opens the modal" — this implementation does it on the click that opens
   the modal, which is functionally identical and slightly safer (no
   render-cycle race).

3. **Section-local fetch state, no new useStore slice.** `FetchBreadbotModal`
   uses local `React.useState` for `mode`, `singleDate`, `rangeStart`,
   `rangeEnd`, `fetching`, `backfillRunning`, `backfillProgress`
   (`FetchBreadbotModal.tsx:66-87`). `POSImportsSection` uses local state
   for `breadbotOpen`, `breadbotPreview`, `previewMatches`,
   `committingPreview`, `backfillResults` (`POSImportsSection.tsx:59-63`).
   No new slice in `useStore.ts`. Reuses existing `importPOS`,
   `upsertPosRecipeAliases`, `recipes`, `posRecipeAliases`, `currentUser`
   selectors. Exactly per design line 362-381.

4. **Range backfill loop matches the design.** `FetchBreadbotModal.tsx:184-269`
   implements the legacy-parity per-day flow:
   - Step 1 `hasPOSImportForDate` → `skipped: already imported` at line
     215-218.
   - Step 2 `fetchBreadbotSales` → `skipped: no data` at line 222-225.
   - Step 3 `matchRecipe(row.rawItemName, ...)` at line 237 — match-against-raw,
     write-raw — does not swap to `canonical`. Verified `menuItem:
     row.rawItemName` at line 239 not `row.canonical`.
   - Step 4 `savePOSImport(storeId, dayFilename, currentUser?.id || '',
     items, date)` at line 248 — explicit `date` argument so future
     `hasPOSImportForDate` calls dedup correctly across reloads.
   - Step 5 `importPOS({...})` at line 250 — fire-and-forget, in-memory
     state + inventory deduction.
   - Step 6 `BACKFILL_THROTTLE_MS` sleep at line 263 — only between days,
     not after the last (good).
   - Step 7 thrown error → `failed: <e.message>` at line 260 with
     `continue`-style behaviour by virtue of being inside the for loop's
     try/catch — subsequent days still run.

   The order, arguments, and dedup semantics all match legacy
   `runBackfill` at `POSImportScreen.tsx:380-463` byte-for-byte.

5. **Legacy fallback chosen — duplicate constants over import-only edit.**
   `src/screens/POSImportScreen.tsx` is unchanged: lines 25, 40-45, 47-48,
   52-63, 90-93 still hold private copies of `BREADBOT_STORES`,
   `BackfillResult`, `BACKFILL_MAX_DAYS`, `BACKFILL_THROTTLE_MS`,
   `enumerateDates`, `todayISO`. The Cmd path imports from
   `src/lib/posBreadbot.ts` instead. This is the design's allowed Q1
   fallback (design lines 308-311, 511) and the developer correctly
   documented the choice in spec lines 631-637. Acceptable per "minimum
   risk to legacy" framing.

---

## Should-fix

None.

---

## Minor

### M1 — `ParsedRow` is duplicated between modal and section

`FetchBreadbotModal.tsx:26-33` exports a `ParsedRow` type. It is imported
into `POSImportsSection.tsx:13` and consumed there. This is fine and matches
the design's component contract at design line 343 (`onSingleFetched: ...
parsedRows: ParsedRow[]`).

However the legacy screen also has its own private `ParsedRow` type at
`POSImportScreen.tsx:27-37` with an identical shape. Per the same fallback
logic that applied to the constants (Q1), leaving the legacy copy alone is
fine; just noting the type duplication exists alongside the constant
duplication. Not actionable now — bundles cleanly with the legacy-screen
deletion next month.

### M2 — `recipes`/`posRecipeAliases` selected twice

`POSImportsSection.tsx:41-44` selects `recipes` and `posRecipeAliases` from
`useStore` for the section-level matcher effect (line 73-78). The
`FetchBreadbotModal` also selects `recipes` and `posRecipeAliases` for its
backfill loop's `matchRecipe` call (`FetchBreadbotModal.tsx:61-63`). This
is fine — both are subscribed to the same store, so they re-render on the
same updates — but it's a small duplication. The alternative would be for
the section to compute the matches and hand `items: POSItem[]` (already-
matched) into the modal, but that breaks the modal's owned-loop
encapsulation, which the design explicitly endorses (design line 348-349:
"The modal owns: tab strip, date inputs, fetch button, range-cap
validation, runBackfill loop, in-flight progress overlay, toasts").

Net: keep as-is. Just noting that the modal could equally well live with
no `useStore` subscription and accept everything via props if a future
refactor wants stricter component layering.

### M3 — Reset effect ordering on close

`FetchBreadbotModal.tsx:90-107` resets all transient state when `visible`
flips to `false`. The comment at line 101-103 acknowledges that
`backfillRunning` is reset there but the loop's own `setBackfillRunning(false)`
at line 267 also fires before `onBackfillComplete` triggers the
section's `setBreadbotOpen(false)`. So the ordering is:

1. Loop completes → `setBackfillRunning(false)` (line 267)
2. `onBackfillComplete(results)` (line 268)
3. Section's `onBackfillComplete` callback fires → `setBreadbotOpen(false)`
   (line 356)
4. Modal `visible` prop becomes `false`
5. Modal effect at line 90 fires → resets state (idempotent, safe)

The double-reset of `backfillRunning` is harmless. Just a note that the
state machine is slightly redundant; not a bug.

---

## Tradeoff observations (informational, not findings)

### O1 — The modal does its own backfill loop; section does its own preview commit

The architecture deliberately splits responsibility:

- `FetchBreadbotModal` owns: range backfill loop (calls `savePOSImport` +
  `importPOS` directly inside the loop), single-fetch network call.
- `POSImportsSection` owns: post-single-fetch preview render +
  `savePOSImport` + `importPOS` + `upsertPosRecipeAliases` confirm
  commit.

This means `savePOSImport` is called from two distinct surfaces with the
same signature. The design explicitly endorsed this split (design line
347-349, 444-461). Both call sites pass an explicit `importDate` so dedup
works (verified above). No drift, but worth flagging that the dedup
correctness depends on both call sites passing the date — a future refactor
that consolidates the commit into `useStore.importPOS` (e.g., making
`importPOS` itself responsible for the `pos_imports` insert, removing the
two-step pattern legacy used) would simplify the surface but is out of
scope for spec 014.

### O2 — Section-local preview vs. modal preview

The legacy screen's preview is full-screen (replaces upload step).
The Cmd port renders the preview as an inline card *above* the imports.log
table while the table remains visible below it (POSImportsSection.tsx
comments at lines 168-171 explicitly call this out: "imports.log itself
remains visible below as a read-only history"). This is a UX departure
from legacy but aligns with Cmd UI's stack-layout convention and was
explicitly endorsed by the design (design line 437-441 mentions "render it
as a Cmd-styled `Card` above the imports table when set, hiding the imports
table while in preview mode" — the implementation chose NOT to hide,
which is a small UX deviation).

This is a UX choice, not a backend/architecture concern. Test-engineer or
release-coordinator may want to flag it as a copy/UX deviation if they
care; from a backend-architect lens it's irrelevant to data integrity,
RLS, or the contract.

### O3 — Realtime gotcha correctly flagged in design, not triggered by impl

The implementation does not edit any publication membership. Design line
275-279 correctly noted this is a non-issue for spec 014. Nothing to flag.

### O4 — `currentUser?.id || ''` empty-string fallback

`POSImportsSection.tsx:202` and `FetchBreadbotModal.tsx:248` both pass
`currentUser?.id || ''` to `savePOSImport`. The legacy screen does the
same at `POSImportScreen.tsx:438`, so this is parity, not new drift. The
backend `pos_imports.imported_by` column is a UUID FK to `auth.users` and
will reject an empty string with a foreign-key violation if `currentUser`
is somehow null. But this state is unreachable in practice — the user
must be authenticated to reach the Cmd UI section at all. Fine as-is,
just noting the same shape exists in legacy and is presumably acceptable.

---

## Summary

5 of 5 mandated checks pass. 0 critical findings, 0 should-fix, 3 minor
notes that are all "as designed" or "ports of legacy patterns we don't
own". The implementation is faithful to the design, including the
spec-body contract correction (single-fetch does NOT go through
`computeDiff` → `RunImportModal`). The chosen Q1 fallback (duplicate
constants in `posBreadbot.ts`, leave legacy untouched) is documented and
within design tolerance.

Recommend: **proceed**. No architectural rework required.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 critical, 0 should-fix, 3
  minor notes. Implementation matches design including the contract
  correction. Recommend proceed.
payload_paths:
  - specs/014-cmd-breadbot-fetch/reviews/backend-architect.md
