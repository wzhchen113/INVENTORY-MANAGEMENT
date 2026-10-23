// src/screens/staff/lib/eodCountMode.ts — Spec 171 §5.
//
// Staff-local barrel: re-export the framework-free EOD count-mode helpers from
// the shared pure module (`src/lib/eodCountMode.ts`) so the staff EOD screens
// import the count-mode surface from ONE staff-local path — the same
// re-export-of-pure idiom as `./eodKeypad.ts` and `./countOrder.ts`. The shared
// module is dependency-free (no React, no store, no `supabase`), so there is no
// carve-out concern. READ-ONLY import; nothing under `src/lib/` is forked.

export {
  EOD_COUNT_MODES,
  DEFAULT_EOD_COUNT_MODE,
  isEodCountMode,
  normalizeEodCountMode,
  effectiveEodCountMode,
  eodBoxes,
  eodHasEntry,
  eodTotal,
  eodEntryValues,
} from '../../../lib/eodCountMode';
export type { EodCountMode } from '../../../lib/eodCountMode';
