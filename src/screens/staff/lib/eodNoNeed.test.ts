// src/screens/staff/lib/eodNoNeed.test.ts — Spec 172 §5.
//
// The staff NO NEED rules are a THIN re-export barrel over the shared pure
// module `src/lib/eodNoNeed.ts` (exhaustively covered by
// src/lib/eodNoNeed.test.ts). This pins the barrel re-exports the SAME
// functions by identity (an accidental fork is caught) and smoke-checks the
// behaviour is reachable through the staff-local path the screens import.

import * as shared from '../../../lib/eodNoNeed';
import * as barrel from './eodNoNeed';

describe('staff eodNoNeed barrel', () => {
  it('re-exports the shared framework-free helpers by identity (no fork)', () => {
    expect(barrel.EOD_NO_NEED_AUDIT_VALUE).toBe(shared.EOD_NO_NEED_AUDIT_VALUE);
    expect(barrel.REORDER_FLAG_NO_NEED).toBe(shared.REORDER_FLAG_NO_NEED);
    expect(barrel.eodRowCounted).toBe(shared.eodRowCounted);
    expect(barrel.eodRowEntryValues).toBe(shared.eodRowEntryValues);
    expect(barrel.eodToggleNoNeed).toBe(shared.eodToggleNoNeed);
    expect(barrel.eodSetNoNeed).toBe(shared.eodSetNoNeed);
    expect(barrel.eodTypeInto).toBe(shared.eodTypeInto);
  });

  it('applies the NO NEED rules through the barrel', () => {
    expect(barrel.eodRowCounted(true, 'cases_and_units', '', '')).toBe(true);
    expect(barrel.eodRowCounted(false, 'units_only', '2', '')).toBe(false);
    expect(barrel.eodRowEntryValues(true, 'units_only', 1, '', '5')).toEqual({
      noNeed: true, total: null, cases: null, units: null,
    });
    expect(barrel.eodToggleNoNeed({ caseRaw: '1', unitRaw: '2', noNeed: false })).toEqual({
      caseRaw: '', unitRaw: '', noNeed: true,
    });
    expect(barrel.eodTypeInto({ caseRaw: '', unitRaw: '', noNeed: true }, 'units', '3')).toEqual({
      caseRaw: '', unitRaw: '3', noNeed: false,
    });
  });
});
