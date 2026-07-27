// src/screens/staff/lib/eodKeypad.ts — Spec 141 §5 / OQ-C.
//
// Staff-local barrel: re-export the framework-free keypad helpers from the
// shared pure module (`src/lib/eodKeypad.ts`) so the staff EOD screens import
// the keypad surface from ONE staff-local path — mirroring the
// `src/screens/staff/lib/countOrder.ts` re-export-of-pure idiom.
//
// There is NO supabase carve-out to honour here: the shared module is
// dependency-free (no React, no store, no `supabase`, no theme — verified),
// exactly like `applyCountOrder`/`firstUncounted` which the staff subtree
// already re-exports from `src/lib/countOrder.ts`. This is a READ-ONLY import;
// nothing under `src/lib/` is modified (AC-REG-8 holds).

export {
  appendKeypadDigit,
  activeFieldFor,
  advanceUncounted,
  KEYPAD_BACKSPACE,
} from '../../../lib/eodKeypad';
