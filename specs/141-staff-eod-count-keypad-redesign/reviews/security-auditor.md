# Security audit for spec 141 (staff EOD count — keypad-sheet redesign)

Scope: staff EOD count screen presentational redesign. Owner HARD guardrail =
"keep the current permissions staff have right now." This audit verifies the
redesign neither widens NOR narrows what a staff user can see or submit, plus
the usual secrets / input-validation / logging checks.

## Result: PASS — no findings at any severity.

The change is purely presentational and frontend-only. Every guardrail item in
the dispatch brief was checked against the actual diff and holds.

### Critical (BLOCKS merge)
None.

### High (must fix before deploy)
None.

### Medium
None.

### Low
None.

---

## Guardrail verification (evidence)

**(1) No auth / RoleRouter / RLS / RPC / edge-function / user_stores change.**
`git status --porcelain` shows exactly five touched files plus four new files,
ALL under `src/screens/staff/`:
- Modified: `EODCount.tsx`, `EODCount.test.tsx`, `i18n/{en,es,zh-CN}.json`
- New: `components/BottomSheet.tsx`, `lib/eodKeypad.ts`, `lib/eodKeypad.test.ts`,
  `screens/eod/StaffEodCountRow.tsx`, `screens/eod/StaffKeypadSheet.tsx` (+ tests)

Nothing under `supabase/`, no `src/lib/db.ts`, no auth file, no `RoleRouter`, no
`useStaffStore` slice, no edge function, no `config.toml`. AC-REG-8 holds. The
only `src/lib/` interaction is a read-only re-export barrel
(`src/screens/staff/lib/eodKeypad.ts:14-19`) over the framework-free
`src/lib/eodKeypad.ts` — sanctioned per OQ-C, mirroring the existing
`countOrder.ts` idiom; the shared file is not modified.

**(2) Submit path + payload shape unchanged; note field OMITTED, not added.**
The `onSubmit` `EodEntry` build (`EODCount.tsx:732-749`) is byte-unchanged and
outside the diff hunks: each entry is
`{ item_id, actual_remaining, actual_remaining_cases, actual_remaining_each }`
— no `note`/`notes` field. Submission still flows through the unchanged
`useEodSubmit`. `StaffKeypadSheet` renders NO note `TextInput` (verified
`StaffKeypadSheet.tsx` — only wells, running total, digit pad, footer), matching
the OQ-A decision. No new field reaches the RPC. Correct — adding a persisted
note would have been a capability/backend change and is correctly out of scope.

**(3) Today/Yesterday window NOT widened.** `dayOffset` remains `useState(0)`
(`EODCount.tsx:486`), the toggle still maps `[1, 0]` — exactly two states
(`EODCount.tsx:960`) — and the submit-time date capture
(`submitDate.setDate(... - dayOffset)`, line 767) is unchanged. The diff only
restyles the toggle to a 2-cell strip (`dateToggle`/`dateSegment` style deltas);
it does not add reachable dates. No capability change. AC-REG-5 holds.

**(4) Keypad input sanitized; writes stay in the acting vendor/store maps.**
Digit entry routes through the pure `appendKeypadDigit`
(`src/lib/eodKeypad.ts:29-43`): only `0-9` append, a single `.` allowed, `⌫`
drops the last char, hard 5-char clamp, everything else ignored. Output is a
count string used only for local `parseFloat` math — no SQL, no `EXECUTE`, no
HTML/URL sink, so no injection surface. `onKey` (`EODCount.tsx`) writes only to
`caseCounts[sheetItem.id]` / `unitCounts[sheetItem.id]`, where `sheetItem`
derives from `orderedForAdvance` (the current vendor's `items`/`orderedItems`).
No cross-store or cross-vendor write path exists; maps are re-seeded on
vendor/store change via the unchanged `seedFromExisting`. Locked rows are
double-gated: the well passes `disabled={locked}` (`StaffEodCountRow.tsx:63`)
AND `openSheet` early-returns when `inputsLocked` (`EODCount.tsx` openSheet),
preserving the spec-129 read-only lock (AC-REG-3).

**(5) No secrets, no PII in logs, no injection surface.** Grep across all
new/changed files for `console.*`, `localStorage`, `AsyncStorage`, `token`,
`secret`, `apikey`, `service_role`, `password`, `Deno.env`, `process.env`
returned only false positives (`useStaffTokens`, `touchTarget`, `useStaffColors`
imports). No logging added, no secret material, no client-reachable service key.

**(6) Offline queue carries no new sensitive data.** `useEodSubmit`/`eodQueue`/
`QueueIndicator` are untouched (not in the diff); the keypad only mutates local
`useState` maps, and the queued payload is the same note-free `EodEntry[]`.
AC-REG-4 holds.

**i18n:** the three catalog diffs are purely additive — 10 new keys each in
`es` and `zh-CN` (20 confirmed), matching `en`; no existing string mutated
beyond a trailing-comma reformat. No auth-relevant surface.

**Palette (OQ-B):** new components consume `useStaffColors()`/`useStaffTokens()`/
`useStaffElevation()` and never hardcode a palette — not a security concern,
noted only for completeness.

### Dependencies
No `package.json` change — `npm audit` skipped. New sheet is built on RN
`Modal` + `Animated` (no `@gorhom/bottom-sheet`, no Reanimated added), per spec.
