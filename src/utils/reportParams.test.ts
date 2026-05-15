// src/utils/reportParams.test.ts — Spec 037 C3 pure-helper coverage.
//
// Carved out of `NewReportModal.tsx`'s isCustom branching so the
// load-bearing logic (saving custom-SQL params vs date-range params,
// and the SAVE-button disabled gate) gets explicit unit coverage.
// Component-level smoke is still required for the textarea / date
// picker render branches per spec 037 VG6; this file covers the pure
// logic the architect §15 jest section asked for.
//
// Mirrors the spec 033 `userPermissions.test.ts` precedent: small
// pure helpers in `src/utils/*`, no React, no Zustand, no theme.

import { buildReportParams, isReportSaveDisabled } from './reportParams';

describe('buildReportParams', () => {
  const range = { range: 'last_30d', from: '2026-04-15', to: '2026-05-15' };

  it("returns { sql } for templateId='custom' (trimmed)", () => {
    const out = buildReportParams({
      templateId: 'custom',
      sql: '  SELECT 1 AS one  ',
      dateRange: range,
      by: 'category',
    });
    expect(out).toEqual({ sql: 'SELECT 1 AS one' });
  });

  it("returns { from, to } for templateId='variance' (no by-axis)", () => {
    const out = buildReportParams({
      templateId: 'variance',
      sql: '',
      dateRange: range,
      by: 'item',
    });
    expect(out).toEqual({ from: '2026-04-15', to: '2026-05-15' });
  });

  it("returns { range, from, to, by } for templateId='cogs'", () => {
    const out = buildReportParams({
      templateId: 'cogs',
      sql: 'SELECT pg_sleep(99)',
      dateRange: range,
      by: 'item',
    });
    expect(out).toEqual({
      range: 'last_30d',
      from: '2026-04-15',
      to: '2026-05-15',
      by: 'item',
    });
  });

  it("returns { range, from, to, by } for templateId='waste' with by='reason'", () => {
    const out = buildReportParams({
      templateId: 'waste',
      sql: '',
      dateRange: range,
      by: 'reason',
    });
    expect(out).toEqual({
      range: 'last_30d',
      from: '2026-04-15',
      to: '2026-05-15',
      by: 'reason',
    });
  });

  it("collapses whitespace-only sql to empty string under templateId='custom'", () => {
    const out = buildReportParams({
      templateId: 'custom',
      sql: '   \n\t  ',
      dateRange: range,
      by: 'category',
    });
    // Matches the runner's `coalesce(nullif(trim(p_params->>'sql'), ''), null)`
    // contract — empty-after-trim must surface as the empty string at this
    // layer so the migration's 22023 gate fires consistently.
    expect(out).toEqual({ sql: '' });
  });
});

describe('isReportSaveDisabled', () => {
  it('disables save when name is empty regardless of template', () => {
    expect(
      isReportSaveDisabled({ templateId: 'custom', name: '', sql: 'SELECT 1' }),
    ).toBe(true);
    expect(
      isReportSaveDisabled({ templateId: 'cogs', name: '', sql: '' }),
    ).toBe(true);
  });

  it("disables save when templateId='custom' and sql is whitespace-only", () => {
    expect(
      isReportSaveDisabled({ templateId: 'custom', name: 'X', sql: '   ' }),
    ).toBe(true);
  });

  it("enables save when templateId='custom' and sql is non-empty", () => {
    expect(
      isReportSaveDisabled({ templateId: 'custom', name: 'X', sql: 'SELECT 1' }),
    ).toBe(false);
  });

  it("enables save for non-custom templates regardless of sql contents", () => {
    expect(
      isReportSaveDisabled({ templateId: 'cogs', name: 'X', sql: '' }),
    ).toBe(false);
    expect(
      isReportSaveDisabled({ templateId: 'waste', name: 'X', sql: 'DROP TABLE x' }),
    ).toBe(false);
  });
});
