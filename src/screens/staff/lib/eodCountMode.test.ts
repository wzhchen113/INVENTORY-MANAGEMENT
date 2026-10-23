// src/screens/staff/lib/eodCountMode.test.ts — Spec 171 §5 / §11.
//
// The staff count-mode helpers are a THIN re-export barrel over the shared pure
// module `src/lib/eodCountMode.ts` (exhaustively covered by
// src/lib/eodCountMode.test.ts). This pins the barrel re-exports the SAME
// functions by identity (an accidental fork is caught) and smoke-checks the
// behaviour is reachable through the staff-local path the screens import.

import * as shared from '../../../lib/eodCountMode';
import * as barrel from './eodCountMode';

describe('staff eodCountMode barrel', () => {
  it('re-exports the shared framework-free helpers by identity (no fork)', () => {
    expect(barrel.EOD_COUNT_MODES).toBe(shared.EOD_COUNT_MODES);
    expect(barrel.DEFAULT_EOD_COUNT_MODE).toBe(shared.DEFAULT_EOD_COUNT_MODE);
    expect(barrel.isEodCountMode).toBe(shared.isEodCountMode);
    expect(barrel.normalizeEodCountMode).toBe(shared.normalizeEodCountMode);
    expect(barrel.effectiveEodCountMode).toBe(shared.effectiveEodCountMode);
    expect(barrel.eodBoxes).toBe(shared.eodBoxes);
    expect(barrel.eodHasEntry).toBe(shared.eodHasEntry);
    expect(barrel.eodTotal).toBe(shared.eodTotal);
    expect(barrel.eodEntryValues).toBe(shared.eodEntryValues);
  });

  it('resolves the effective mode + totals through the barrel', () => {
    expect(barrel.effectiveEodCountMode(24, 'cases_only')).toBe('cases_only');
    expect(barrel.effectiveEodCountMode(1, 'cases_only')).toBe('units_only');
    expect(barrel.eodTotal('cases_only', 24, '2', '5')).toBe(48);
    expect(barrel.eodHasEntry('units_only', '2', '')).toBe(false);
  });
});
