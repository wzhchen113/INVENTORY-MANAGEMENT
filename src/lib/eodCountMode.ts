// src/lib/eodCountMode.ts — Spec 171.
//
// Pure, dependency-free helpers for the per-ingredient EOD count mode
// (`catalog_ingredients.eod_count_mode`). No React, no store, no `supabase` —
// mirrors `src/lib/eodKeypad.ts` so the rules are a cheap jest unit surface.
//
// Every in-scope EOD surface (admin desktop row, admin phone row + keypad
// sheet, staff row + keypad sheet + entry builder) resolves the EFFECTIVE mode
// once per item via `effectiveEodCountMode` and passes it into the
// total / counted / entry helpers below (AC-6). The STORED mode stays separate
// from the effective mode (spec N2): it is inert when `caseQty <= 1`, and is
// never normalized on save.

/** The three DB literals admitted by `catalog_ingredients_eod_count_mode_check`. */
export type EodCountMode = 'cases_and_units' | 'cases_only' | 'units_only';

/** The three literals, in the DB CHECK's order. */
export const EOD_COUNT_MODES: readonly EodCountMode[] = Object.freeze([
  'cases_and_units',
  'cases_only',
  'units_only',
] as const);

/** The column default and the fallback for unknown / missing values. */
export const DEFAULT_EOD_COUNT_MODE: EodCountMode = 'cases_and_units';

export function isEodCountMode(v: unknown): v is EodCountMode {
  return typeof v === 'string' && (EOD_COUNT_MODES as readonly string[]).includes(v);
}

/** Unknown / missing → `DEFAULT_EOD_COUNT_MODE`. */
export function normalizeEodCountMode(v: unknown): EodCountMode {
  return isEodCountMode(v) ? v : DEFAULT_EOD_COUNT_MODE;
}

/**
 * AC-6. A `caseQty` that is not a number > 1 (null / undefined / 0 / 1 / NaN /
 * anything < 1) → `'units_only'` regardless of the stored mode, because only
 * units are countable without a case. Otherwise the normalized stored mode
 * (missing / unknown → `'cases_and_units'`).
 *
 * Called with ONE argument it yields `'cases_and_units'` iff `caseQty > 1` —
 * the legacy (pre-spec-171) layout used for locked/read-only rows (design D7).
 */
export function effectiveEodCountMode(
  caseQty: number | null | undefined,
  stored?: unknown,
): EodCountMode {
  if (!(typeof caseQty === 'number' && caseQty > 1)) return 'units_only';
  return normalizeEodCountMode(stored);
}

/** Which input boxes / keypad wells are enabled under a mode. */
export function eodBoxes(mode: EodCountMode): { cases: boolean; units: boolean } {
  switch (mode) {
    case 'cases_only':
      return { cases: true, units: false };
    case 'units_only':
      return { cases: false, units: true };
    case 'cases_and_units':
    default:
      return { cases: true, units: true };
  }
}

function isNonBlank(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim() !== '';
}

/**
 * AC-7 counted predicate: true iff an ENABLED box is non-blank (after trim).
 * A value sitting in a disabled box is ignored (AC-16).
 */
export function eodHasEntry(
  mode: EodCountMode,
  caseRaw: string | undefined,
  unitRaw: string | undefined,
): boolean {
  const box = eodBoxes(mode);
  return (box.cases && isNonBlank(caseRaw)) || (box.units && isNonBlank(unitRaw));
}

/** parseFloat with NaN → 0 (today's per-box rule). */
function num(raw: string | undefined): number {
  const n = parseFloat(raw ?? '');
  return Number.isNaN(n) ? 0 : n;
}

/**
 * AC-7 total, per enabled box (parseFloat, NaN → 0):
 *   cases_and_units = c * (caseQty || 1) + u   (byte-identical to today)
 *   cases_only      = c * (caseQty || 1)
 *   units_only      = u
 */
export function eodTotal(
  mode: EodCountMode,
  caseQty: number | null | undefined,
  caseRaw: string | undefined,
  unitRaw: string | undefined,
): number {
  const box = eodBoxes(mode);
  const perCase = caseQty || 1;
  const c = box.cases ? num(caseRaw) : 0;
  const u = box.units ? num(unitRaw) : 0;
  if (box.cases && box.units) return c * perCase + u;
  if (box.cases) return c * perCase;
  return u;
}

/** Enabled-and-parseable → the number; disabled, blank or unparseable → null. */
function boxValue(enabled: boolean, raw: string | undefined): number | null {
  if (!enabled || !isNonBlank(raw)) return null;
  const n = parseFloat(raw as string);
  return Number.isNaN(n) ? null : n;
}

/**
 * AC-7 entry values for a submission. `null` when `!eodHasEntry(...)` (the
 * item is omitted). A disabled box → `null`; an enabled-but-unparseable (or
 * blank) box → `null` (today's NaN rule). `total === eodTotal(...)`.
 */
export function eodEntryValues(
  mode: EodCountMode,
  caseQty: number | null | undefined,
  caseRaw: string | undefined,
  unitRaw: string | undefined,
): { total: number; cases: number | null; units: number | null } | null {
  if (!eodHasEntry(mode, caseRaw, unitRaw)) return null;
  const box = eodBoxes(mode);
  return {
    total: eodTotal(mode, caseQty, caseRaw, unitRaw),
    cases: boxValue(box.cases, caseRaw),
    units: boxValue(box.units, unitRaw),
  };
}
