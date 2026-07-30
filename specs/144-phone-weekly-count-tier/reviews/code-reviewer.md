## Code review for spec 144 (Phone tier — Weekly / Inventory count)

Reviewed: `src/screens/cmd/sections/phone/PhoneWeeklyCount.tsx`,
`phone/weeklyVariance.ts`, the `InventoryCountSection.tsx` guard + model lift,
`phone/__tests__/PhoneWeeklyCount.test.tsx` / `.acReg.test.tsx`, and the three
i18n catalogs.

### Critical
None found.

### Should-fix
None found. The guard (`InventoryCountSection.tsx:1316`) sits after all hooks
and before the desktop no-store guard; `weeklyVariance.ts` is a clean, pure,
dependency-free classifier that matches the desktop `toneFor`-equivalent
thresholds; the keypad contract (`PhoneKeypadSheet` + `eodKeypad` helpers) is
reused verbatim with a genuinely separate entry keyspace
(`caseCounts`/`unitCounts`/`itemNotes` local to `InventoryCountSection`, never
touching the EOD maps).

### Nits
- `src/screens/cmd/sections/InventoryCountSection.tsx:153-157` — `wkNum` is
  computed once via `React.useMemo(() => {...}, [])` off `new Date()` at first
  render, so a session left open across a Sunday-midnight week boundary shows
  a stale "WK n" badge until remount. Very low-impact (matches the same
  computed-once idiom the EOD day strip presumably uses), but worth a `[]` →
  time-bucketed dependency if this pattern is ever revisited.
- The vestigial `isPhone ? … : …` squeeze ternaries still present in the
  desktop/tablet render path below the phone guard (e.g.
  `InventoryCountSection.tsx:1590-1592`) are dead code post-early-return (same
  situation the spec-140 release-proposal already flagged and asked reviewers
  not to re-file) — noting only for completeness, not counted as a finding.
- `src/screens/cmd/sections/phone/PhoneWeeklyCount.tsx:207-214` — the export
  chip row hardcodes `↓`/`◎`/`▾` glyphs inline per-call rather than sharing a
  small glyph constant with `PhoneOrdering`'s equivalent overflow-sheet icons;
  a minor duplication, not worth a hoist on its own but flagged since the
  cross-cutting review asked about duplication across the eleven components.

Overall: no direct Supabase calls, no hardcoded hex, no `Alert.alert` /
`window.confirm`, and the `PhoneWeeklyCount ↔ InventoryCountSection` circular
import is a clean type-only/render-time cycle (mirrors the established
PhoneEodCount pattern from spec 140).

## Handoff
next_agent: NONE
prompt: Code review complete for spec 144. 0 Critical, 0 Should-fix, 3 Nits.
payload_paths:
  - specs/144-phone-weekly-count-tier/reviews/code-reviewer.md
