// src/screens/staff/lib/eodNoNeed.ts — Spec 172 §5.
//
// Staff-local barrel: re-export the framework-free EOD "NO NEED" rules from
// the shared pure module (`src/lib/eodNoNeed.ts`) so the staff EOD screens
// import them from ONE staff-local path — the same re-export-of-pure idiom as
// `./eodCountMode.ts` and `./eodKeypad.ts`. The shared module is
// dependency-free (no React, no store, no `supabase`), so there is no
// carve-out concern. READ-ONLY import; nothing under `src/lib/` is forked.

export {
  EOD_NO_NEED_AUDIT_VALUE,
  REORDER_FLAG_NO_NEED,
  isReorderNoNeed,
  eodRowCounted,
  eodRowEntryValues,
  eodToggleNoNeed,
  eodSetNoNeed,
  eodTypeInto,
} from '../../../lib/eodNoNeed';
export type { EodRowEntryValues, EodRowState } from '../../../lib/eodNoNeed';
