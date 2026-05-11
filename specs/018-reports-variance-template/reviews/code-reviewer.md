# Code review — Spec 018 (Reports Variance Template, REPORTS-3) — Round 2

## Round-1 finding verdicts

### C1 — CREATE disable (PASS)

`src/components/cmd/NewReportModal.tsx:560-571`. `disabled=` is gone from the
TouchableOpacity. The style object has no conditional opacity, no
`cursor: 'not-allowed'`, no color branch based on `varianceBlocked`. The text
at line 570 uses `C.accentFg` unconditionally. `onCreate` no longer early-returns
on `varianceBlocked` — the only guards are name-required, invalid date, from > to,
and from == to (which are all spec-correct).

The inline danger hint at lines 423-431 still renders when `varianceBlocked` is
true. `varianceBlocked` itself is still computed and used to gate that hint, which
is correct — the variable is not dead code.

C1: **PASS**.

### C2 — 0.01 noise filter KPI split (PASS)

`supabase/migrations/20260512120000_report_run_variance.sql`. The Option C split
is correctly implemented:

- `joined_with_dollar` (lines 489-494) computes `dollar_impact` once, pre-filter,
  from all intersected items.
- `filtered` (lines 500-503) reads from `joined_with_dollar` and drops
  `abs(delta) < 0.01` — rows only.
- `totals` (lines 512-518) reads from `joined_with_dollar` (not `filtered`):
  `sum(dollar_impact)`, `count(*) filter (where abs(delta) > 0)`, and
  `count(*) filter (where missing_cost)` all aggregate over the full pre-filter
  set.
- `rows_json` (lines 521-548) reads from `filtered` — rows table only.
- `v_truncated_recipe_count` is computed in the section-8 pre-walk (lines 239-258),
  independent of both `filtered` and `joined_with_dollar`, and is correct: it
  counts truncated recipes at the graph level, not at the row level, so the
  noise filter is irrelevant to it.
- The migration header (lines 78-95) documents the split contract clearly.

C2: **PASS**.

### S1 — empty-string fallback (PASS)

`src/components/cmd/NewReportModal.tsx:72-74`. The `< 2` branch now returns
`{ from: '', to: '', eodCount: Array.isArray(dates) ? dates.length : 0 }` and
the catch block returns `{ from: '', to: '', eodCount: 0 }`. No `computePreset`
call in the low-history path.

S1: **PASS**.

### S2 — `'#000'` on CREATE button text (PASS)

`src/components/cmd/NewReportModal.tsx:570`. `color: C.accentFg` unconditionally.

S2: **PASS**.

### S3 — stale forward-tense comment in `ReportsSection.tsx` (PASS)

`src/screens/cmd/sections/ReportsSection.tsx:20-24`. Comment is now past tense:
"REPORTS-2 flipped `cogs` to `'live'`, REPORTS-3 flipped `variance`".

S3: **PASS**.

### S4 — stale "premature shared module" comment + helper extraction (PASS)

`src/screens/cmd/sections/reports/ReportDetailFrame.tsx:26-34`. The stale
comment is gone. Both files import from `src/utils/reportDates.ts`. The
detail-frame extends the shared `PresetIdShared` with `'custom'` via a local
type alias at line 98 — clean augmentation, no narrowing awkwardness.

S4: **PASS**.

---

## New shared module `src/utils/reportDates.ts` — verification

- Exports `PresetId`, `toISODate`, `isISODate`, `computePreset` — correct scope.
- No `any` casts anywhere in the file.
- `isISODate` does date-rollover detection (lines 31-33) — correct.
- No duplication in consumer files: `NewReportModal.tsx` imports `PresetId`,
  `isISODate`, `computePreset`; `ReportDetailFrame.tsx` imports `PresetIdShared`,
  `isISODate`, `computePreset`. Neither file re-defines these helpers.
- The `PresetId = PresetIdShared | 'custom'` alias in `ReportDetailFrame.tsx:98`
  is clean.

New module: **PASS**.

---

## Round-2 regression scan

### Critical

None.

### Should-fix

**`src/components/cmd/NewReportModal.tsx:111-113`** — The state variable comment
still says "CREATE disabled state for variance" and "triggers the hint + CREATE
disabled". The CREATE button is no longer disabled — this comment directly
contradicts the current behaviour and will mislead the next developer touching
this state.

**Fix.** Update the comment to read something like: "Drives the inline danger
hint when the store has < 2 submitted EODs. Per spec AC line 265, the CREATE
button is NOT disabled — the user can still save the definition and discover the
`P0002` error on RUN via the standard toast."

### Nits

**`src/components/cmd/NewReportModal.tsx:290, 334, 341`** — Three `color: '#000'`
literals remain in the modal: the `NEW` badge text (line 290), the template-tile
icon when selected (line 334), and the `SELECTED` badge text (line 341). These
are all pre-existing from REPORTS-1/2; the S2 finding in round 1 was specifically
scoped to the CREATE button. Flagging as a nit for consistency — these should
eventually move to `C.accentFg` or a purpose-named token. Out of scope for this
PR.

**`supabase/migrations/20260512120000_report_run_variance.sql:614-617`** — The
index comment (N2 from round 1) still reads "covers the receiving / waste filter
shape" and conflates two tables. The comment was not updated. Low priority — the
index itself is correct and the body comment at lines 614-617 is the only
casualty.

---

## Block recommendation

No new Criticals. The two round-1 Criticals are fully resolved. **No block.**

The one Should-fix (stale comment on `eodCount`) is cosmetic but should land
before merge to avoid confusing the next developer. The nits are low priority
and can be addressed opportunistically.
