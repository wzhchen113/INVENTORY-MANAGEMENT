// src/utils/reportParams.ts — Spec 037 pure-helper extraction.
//
// Carved out of `NewReportModal.tsx` so the modal's load-bearing
// branching (custom-template vs date-range templates) is unit-testable
// without mounting React Native + Zustand + the theme chain. Mirrors
// the spec 033 `userPermissions.ts` precedent: pure logic → its own
// module → jest covers every branch.
//
// Two responsibilities:
//
//   1. `buildReportParams(args)` — derives the `params` jsonb payload
//      saved into `report_definitions.params`. For `'custom'`, returns
//      `{ sql }`; for everything else, returns `{ from, to, by }`.
//
//   2. `isReportSaveDisabled(args)` — derives the SAVE-button
//      disabled state. For `'custom'`, blocks save when SQL is empty
//      (whitespace-only counts as empty per the runner's trim
//      contract); for everything else, blocks when name is empty.
//
// The helpers preserve the inline-branching semantics in
// NewReportModal.tsx:317-318 and :291 byte-for-byte (modulo the
// `trim()` location — the helpers trim once at the boundary so the
// caller doesn't have to).

export interface BuildReportParamsArgs {
  /**
   * templateId — drives which branch fires:
   *   - 'custom'   → { sql }
   *   - 'variance' → { from, to } (no by, no range — variance is inherently
   *                                  per-item)
   *   - everything else → { range, from, to, by } (cogs/waste/vendor/velocity
   *                                  precedent)
   */
  templateId: string;
  /** Raw SQL string from the textarea. Only consumed for 'custom'. */
  sql: string;
  /** Date range — consumed for non-custom templates. */
  dateRange: { range: string; from: string; to: string };
  /** by-mode — consumed for non-custom, non-variance templates. */
  by: string;
}

/**
 * Spec 037 — pure derivation of `report_definitions.params` payload.
 *
 * Three branches:
 *   - 'custom'   → `{ sql: <trimmed sql> }`.
 *   - 'variance' → `{ from, to }` (spec 018 — variance has no by-axis).
 *   - default    → `{ range, from, to, by }` (spec 017 COGS shape inherited
 *                  by waste / vendor / velocity).
 *
 * The trim is at the boundary so the runner's "sql parameter required"
 * gate fires cleanly on whitespace-only inputs (matches the migration's
 * `coalesce(nullif(trim(p_params->>'sql'), ''), null)` extraction).
 */
export function buildReportParams(args: BuildReportParamsArgs): Record<string, unknown> {
  const { templateId, sql, dateRange, by } = args;
  if (templateId === 'custom') {
    return { sql: sql.trim() };
  }
  if (templateId === 'variance') {
    return { from: dateRange.from, to: dateRange.to };
  }
  return {
    range: dateRange.range,
    from: dateRange.from,
    to: dateRange.to,
    by,
  };
}

export interface IsReportSaveDisabledArgs {
  /** templateId — drives which validation rule applies. */
  templateId: string;
  /** Report name. Required for all templates. */
  name: string;
  /** Raw SQL string. Only validated for 'custom'. */
  sql: string;
}

/**
 * Spec 037 — pure derivation of SAVE-button disabled state.
 *
 * For `'custom'`: requires non-empty NAME AND non-whitespace SQL.
 * For everything else: requires non-empty NAME only (the date-range
 * has a default preset that's always populated, so it can't be empty).
 *
 * Returns `true` when the button should be DISABLED.
 */
export function isReportSaveDisabled(args: IsReportSaveDisabledArgs): boolean {
  const { templateId, name, sql } = args;
  if (name.trim() === '') return true;
  if (templateId === 'custom' && sql.trim() === '') return true;
  return false;
}
