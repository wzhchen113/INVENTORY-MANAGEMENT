// src/lib/eodNoNeed.ts — Spec 172.
//
// Pure, dependency-free rules for the EOD "NO NEED" mark ("we have more than
// enough; not counted numerically"). No React, no store, no `supabase` — a
// sibling of spec 171's `src/lib/eodCountMode.ts` (which is NOT edited) so the
// rules are a cheap jest unit surface.
//
// Every in-scope EOD surface (admin desktop row, admin phone row + keypad
// sheet, staff row + keypad sheet + entry builder) delegates its counted /
// entry-value / toggle decisions here, and every numeric consumer of
// `EODEntry.actualRemaining` (cmdSelectors, usageCalculations,
// ReconciliationSection) strips NO NEED entries through the guards at the
// bottom (AC-27). The staff subtree re-exports this module through
// `src/screens/staff/lib/eodNoNeed.ts`.

import { eodEntryValues, eodHasEntry, type EodCountMode } from './eodCountMode';
import type { EODEntry, EODSubmission } from '../types';

/**
 * N6: the stored English audit-log literal for a NO NEED entry. Not
 * localized. The SQL RPC `staff_submit_eod` hardcodes the same string
 * (migration 20261024000000_eod_entries_no_need.sql, hunk S4).
 */
export const EOD_NO_NEED_AUDIT_VALUE = 'NO NEED';

/** The reorder flag token emitted by `report_reorder_list` (hunk R4). */
export const REORDER_FLAG_NO_NEED = 'no_need';

/** AC-16 counted: `noNeed || eodHasEntry(mode, caseRaw, unitRaw)`. */
export function eodRowCounted(
  noNeed: boolean | undefined,
  mode: EodCountMode,
  caseRaw: string | undefined,
  unitRaw: string | undefined,
): boolean {
  return noNeed === true || eodHasEntry(mode, caseRaw, unitRaw);
}

/** AC-16 entry values — discriminated on `noNeed`. */
export type EodRowEntryValues =
  | { noNeed: true; total: null; cases: null; units: null }
  | { noNeed: false; total: number; cases: number | null; units: number | null };

/**
 * AC-16 entry values. NO NEED wins over any stale typed value and emits no
 * quantity; otherwise spec 171's `eodEntryValues` verbatim (`null` when the
 * row is uncounted, i.e. the item is omitted from the submission).
 */
export function eodRowEntryValues(
  noNeed: boolean | undefined,
  mode: EodCountMode,
  caseQty: number | null | undefined,
  caseRaw: string | undefined,
  unitRaw: string | undefined,
): EodRowEntryValues | null {
  if (noNeed === true) return { noNeed: true, total: null, cases: null, units: null };
  const v = eodEntryValues(mode, caseQty, caseRaw, unitRaw);
  if (v === null) return null;
  return { noNeed: false, total: v.total, cases: v.cases, units: v.units };
}

/**
 * One row's local EOD state. Invariant maintained by all three transitions
 * below: `noNeed ⇒ caseRaw === '' && unitRaw === ''`.
 */
export interface EodRowState {
  caseRaw: string;
  unitRaw: string;
  noNeed: boolean;
}

/**
 * Row button (AC-16 / AC-19): off → on, on → off. Both boxes are ALWAYS
 * cleared — including a stale value in a mode-disabled box (AC-35) — so the
 * invariant holds and a re-tap returns the row to uncounted with blank boxes.
 */
export function eodToggleNoNeed(row: EodRowState): EodRowState {
  return { caseRaw: '', unitRaw: '', noNeed: !row.noNeed };
}

/** Keypad-sheet button (AC-29): always set, idempotent. */
export function eodSetNoNeed(_row: EodRowState): EodRowState {
  return { caseRaw: '', unitRaw: '', noNeed: true };
}

/**
 * Any keystroke into a box, or any keypad key into a well (including
 * backspace — the caller computes the new text first, e.g. via
 * `appendKeypadDigit`), writes that field and clears NO NEED (AC-16/AC-19).
 */
export function eodTypeInto(
  row: EodRowState,
  field: 'cases' | 'units',
  text: string,
): EodRowState {
  return field === 'cases'
    ? { ...row, caseRaw: text, noNeed: false }
    : { ...row, unitRaw: text, noNeed: false };
}

// ─── AC-27 numeric guards ───────────────────────────────────────────────

/** An `EODEntry` that carries a real count. */
export type NumericEODEntry = EODEntry & { actualRemaining: number };

/** True iff the entry is a numeric count (not NO NEED, total is a number). */
export function isNumericEodEntry(e: EODEntry): e is NumericEODEntry {
  return e.noNeed !== true && typeof e.actualRemaining === 'number';
}

/** An `EODSubmission` whose `entries` are all numeric counts. */
export type NumericEODSubmission = Omit<EODSubmission, 'entries'> & {
  entries: NumericEODEntry[];
};

/**
 * Strips non-numeric (NO NEED) entries from every submission. Returns the
 * SAME submission object when it has none (no allocation; identity-stable
 * for memos) — so a NO-NEED-free history passes through untouched (AC-40).
 */
export function numericEodSubmissions(
  subs: ReadonlyArray<EODSubmission>,
): NumericEODSubmission[] {
  return subs.map((s) => {
    // Several consumers defensively read `sub.entries || []`; a legacy /
    // fixture submission without `entries` passes through untouched.
    const entries: EODEntry[] | undefined = s.entries;
    if (!entries || entries.every(isNumericEodEntry)) return s as NumericEODSubmission;
    return { ...s, entries: entries.filter(isNumericEodEntry) };
  });
}
