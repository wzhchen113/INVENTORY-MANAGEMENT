// src/lib/eodKeypad.ts — Spec 140.
//
// Pure, dependency-free helpers for the phone-tier EOD keypad sheet. No React,
// no store, no `supabase` — the whole point is a cheap jest unit surface (§6)
// that pins the keypad's append rules and the SKIP / NEXT-ITEM advance logic
// without rendering the heavy section. Consumed by
// `src/screens/cmd/sections/eod/PhoneKeypadSheet.tsx`.

import { effectiveEodCountMode, eodBoxes, type EodCountMode } from './eodCountMode';

/**
 * The backspace glyph the digit pad renders. Exported so the sheet and the
 * tests refer to the same literal rather than stringly-typing it twice.
 */
export const KEYPAD_BACKSPACE = '⌫';

/**
 * Append (or delete) one keypad key to the current field text and return the
 * new value. Pure + total.
 *
 * Rules (AC-7):
 *   - digits `0`–`9` append, up to `maxLen` characters (default 5);
 *   - `.` appends only when there isn't one already AND we're under `maxLen`;
 *   - the backspace glyph (`⌫`) drops the last character;
 *   - anything else is ignored (returns `current` unchanged).
 *
 * `'0'` from an empty field yields `'0'` — a valid count (AC-9). The clamp is a
 * character clamp (not a numeric one) so "100.5" (5 chars) is allowed but a 6th
 * character is refused.
 */
export function appendKeypadDigit(current: string, key: string, maxLen = 5): string {
  if (key === KEYPAD_BACKSPACE) {
    return current.slice(0, -1);
  }
  if (key === '.') {
    if (current.includes('.')) return current;
    if (current.length >= maxLen) return current;
    return current + '.';
  }
  if (key >= '0' && key <= '9' && key.length === 1) {
    if (current.length >= maxLen) return current;
    return current + key;
  }
  // Unknown key — no-op.
  return current;
}

/**
 * Which field the keypad seats as active when a row's sheet opens (AC-7).
 * `caseQty > 1` → the CS well ('cases'); otherwise (undefined / 0 / 1) the unit
 * well ('units'). Pure + total.
 *
 * Spec 171 (AC-8 / AC-9) — optional 2nd arg: the item's STORED EOD count mode.
 * The seated field is the enabled box under the EFFECTIVE mode
 * (`effectiveEodCountMode`): `'units_only'` → 'units', `'cases_only'` /
 * `'cases_and_units'` → 'cases'. Omitting `mode` reproduces the pre-spec-171
 * output for every input (the one-arg effective mode is `'cases_and_units'`
 * iff `caseQty > 1`), so `PhoneWeeklyCount` is unchanged.
 */
export function activeFieldFor(
  caseQty: number | undefined | null,
  mode?: EodCountMode | null,
): 'cases' | 'units' {
  return effectiveEodCountMode(caseQty, mode) === 'units_only' ? 'units' : 'cases';
}

/**
 * Spec 171 (review-fix) — which keypad wells / input boxes are enabled for an
 * item: `eodBoxes(effectiveEodCountMode(caseQty, stored))` in one place. Omit
 * `stored` for the LEGACY layout (both boxes iff `caseQty > 1`, else units
 * only) — the layout `PhoneWeeklyCount` and locked rows use. Pure + total.
 */
export function eodBoxesFor(
  caseQty: number | undefined | null,
  stored?: EodCountMode | null,
): { cases: boolean; units: boolean } {
  return eodBoxes(effectiveEodCountMode(caseQty, stored));
}

/**
 * Spec 171 §9 (review-fix) — clamp the keypad's seated field to an ENABLED box.
 * Returns `active` unchanged when its box is enabled under the item's
 * effective mode; otherwise the mode's seat (`activeFieldFor(caseQty, stored)`).
 * Guards against a stale `activeField` (e.g. the item's mode flipped via
 * realtime while the sheet was open) writing into a hidden count map. With
 * `stored` omitted the legacy layout applies, under which the seat is always
 * enabled. Pure + total.
 */
export function clampActiveField(
  active: 'cases' | 'units',
  caseQty: number | undefined | null,
  stored?: EodCountMode | null,
): 'cases' | 'units' {
  return eodBoxesFor(caseQty, stored)[active] ? active : activeFieldFor(caseQty, stored);
}

/**
 * Advance to the next uncounted item with wraparound (AC-8), searching forward
 * from `fromIndex + 1` and wrapping to the start. Returns the found item and
 * its index, or `null` when nothing uncounted remains anywhere in the list.
 *
 * The search covers all `n` positions once (including `fromIndex` itself, which
 * is reached last on wrap) so a list whose ONLY uncounted row is the current one
 * still resolves to it. Pair with `firstUncounted(...) === null` from
 * `src/lib/countOrder.ts` to relabel NEXT ITEM → DONE ✓. Pure + total.
 */
export function advanceUncounted<T>(
  ordered: readonly T[],
  fromIndex: number,
  isCounted: (item: T) => boolean,
): { item: T; index: number } | null {
  const n = ordered.length;
  if (n === 0) return null;
  for (let step = 1; step <= n; step++) {
    const idx = ((fromIndex + step) % n + n) % n; // normalize negative fromIndex too
    if (!isCounted(ordered[idx])) return { item: ordered[idx], index: idx };
  }
  return null;
}
