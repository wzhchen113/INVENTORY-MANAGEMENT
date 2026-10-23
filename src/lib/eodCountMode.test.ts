// src/lib/eodCountMode.test.ts — Spec 171 (AC-6, AC-7, AC-16 helper arms).
//
// Pure-helper coverage for src/lib/eodCountMode.ts. The surfaces (admin
// desktop/phone, staff) are covered by the frontend render arms; these pin the
// rules every surface delegates to.

import {
  DEFAULT_EOD_COUNT_MODE,
  EOD_COUNT_MODES,
  type EodCountMode,
  effectiveEodCountMode,
  eodBoxes,
  eodEntryValues,
  eodHasEntry,
  eodTotal,
  isEodCountMode,
  normalizeEodCountMode,
} from './eodCountMode';

describe('constants + guards', () => {
  it('EOD_COUNT_MODES lists the three DB literals in CHECK order', () => {
    expect(EOD_COUNT_MODES).toEqual(['cases_and_units', 'cases_only', 'units_only']);
  });

  it('DEFAULT_EOD_COUNT_MODE is cases_and_units (the column default)', () => {
    expect(DEFAULT_EOD_COUNT_MODE).toBe('cases_and_units');
  });

  it('isEodCountMode admits exactly the three literals', () => {
    for (const m of EOD_COUNT_MODES) expect(isEodCountMode(m)).toBe(true);
    for (const v of ['cases', '', 'CASES_ONLY', ' units_only', null, undefined, 0, {}, []]) {
      expect(isEodCountMode(v)).toBe(false);
    }
  });

  it('normalizeEodCountMode passes valid literals through; anything else → default', () => {
    for (const m of EOD_COUNT_MODES) expect(normalizeEodCountMode(m)).toBe(m);
    for (const v of ['bogus', '', null, undefined, 42]) {
      expect(normalizeEodCountMode(v)).toBe('cases_and_units');
    }
  });
});

describe('effectiveEodCountMode — AC-6 matrix', () => {
  const storedValues: Array<EodCountMode | undefined> = [
    'cases_and_units',
    'cases_only',
    'units_only',
    undefined,
  ];

  // {null, 0, 1} × every stored value → units_only regardless.
  for (const caseQty of [null, 0, 1] as const) {
    for (const stored of storedValues) {
      it(`caseQty=${String(caseQty)}, stored=${String(stored)} → units_only`, () => {
        expect(effectiveEodCountMode(caseQty, stored)).toBe('units_only');
      });
    }
  }

  // caseQty=24 → the stored mode; undefined → cases_and_units.
  const expected24: Record<string, EodCountMode> = {
    cases_and_units: 'cases_and_units',
    cases_only: 'cases_only',
    units_only: 'units_only',
    undefined: 'cases_and_units',
  };
  for (const stored of storedValues) {
    it(`caseQty=24, stored=${String(stored)} → ${expected24[String(stored)]}`, () => {
      expect(effectiveEodCountMode(24, stored)).toBe(expected24[String(stored)]);
    });
  }

  it('undefined caseQty → units_only regardless of stored', () => {
    expect(effectiveEodCountMode(undefined, 'cases_only')).toBe('units_only');
  });

  it('NaN / fractional ≤ 1 / negative caseQty → units_only', () => {
    expect(effectiveEodCountMode(NaN, 'cases_only')).toBe('units_only');
    expect(effectiveEodCountMode(0.5, 'cases_only')).toBe('units_only');
    expect(effectiveEodCountMode(-24, 'cases_only')).toBe('units_only');
  });

  it('unknown stored mode with caseQty > 1 → cases_and_units', () => {
    expect(effectiveEodCountMode(24, 'bogus')).toBe('cases_and_units');
    expect(effectiveEodCountMode(24, null)).toBe('cases_and_units');
    expect(effectiveEodCountMode(2, '')).toBe('cases_and_units');
  });

  it('one-arg form (legacy layout, design D7) = cases_and_units iff caseQty > 1', () => {
    expect(effectiveEodCountMode(24)).toBe('cases_and_units');
    expect(effectiveEodCountMode(2)).toBe('cases_and_units');
    expect(effectiveEodCountMode(1)).toBe('units_only');
    expect(effectiveEodCountMode(0)).toBe('units_only');
    expect(effectiveEodCountMode(null)).toBe('units_only');
    expect(effectiveEodCountMode(undefined)).toBe('units_only');
  });
});

describe('eodBoxes', () => {
  it('maps each mode to its enabled boxes', () => {
    expect(eodBoxes('cases_and_units')).toEqual({ cases: true, units: true });
    expect(eodBoxes('cases_only')).toEqual({ cases: true, units: false });
    expect(eodBoxes('units_only')).toEqual({ cases: false, units: true });
  });
});

describe('eodHasEntry — AC-7 counted predicate', () => {
  it('cases_and_units: either box non-blank counts (today\'s rule)', () => {
    expect(eodHasEntry('cases_and_units', '2', undefined)).toBe(true);
    expect(eodHasEntry('cases_and_units', undefined, '3')).toBe(true);
    expect(eodHasEntry('cases_and_units', '2', '3')).toBe(true);
    expect(eodHasEntry('cases_and_units', '', '')).toBe(false);
    expect(eodHasEntry('cases_and_units', '  ', ' ')).toBe(false);
    expect(eodHasEntry('cases_and_units', undefined, undefined)).toBe(false);
  });

  it('cases_only: only the cases box counts', () => {
    expect(eodHasEntry('cases_only', '2', undefined)).toBe(true);
    expect(eodHasEntry('cases_only', '0', undefined)).toBe(true);
    expect(eodHasEntry('cases_only', undefined, '3')).toBe(false);
    expect(eodHasEntry('cases_only', '', '3')).toBe(false);
  });

  it('units_only: only the units box counts', () => {
    expect(eodHasEntry('units_only', undefined, '3')).toBe(true);
    expect(eodHasEntry('units_only', '', '0')).toBe(true);
    expect(eodHasEntry('units_only', '2', undefined)).toBe(false);
    expect(eodHasEntry('units_only', '2', ' ')).toBe(false);
  });
});

describe('eodTotal — AC-7 totals', () => {
  it('cases_and_units = cases × caseQty + units (byte-identical to today)', () => {
    expect(eodTotal('cases_and_units', 24, '2', '5')).toBe(53);
    expect(eodTotal('cases_and_units', 24, '2', '')).toBe(48);
    expect(eodTotal('cases_and_units', 24, '', '5')).toBe(5);
    expect(eodTotal('cases_and_units', 24, '1.5', '0.5')).toBe(36.5);
    expect(eodTotal('cases_and_units', 24, 'abc', '5')).toBe(5);
    expect(eodTotal('cases_and_units', 24, undefined, undefined)).toBe(0);
  });

  it('cases_and_units treats a falsy caseQty as 1 (today\'s `caseQty || 1`)', () => {
    expect(eodTotal('cases_and_units', 0, '2', '5')).toBe(7);
    expect(eodTotal('cases_and_units', null, '2', '5')).toBe(7);
    expect(eodTotal('cases_and_units', undefined, '2', '5')).toBe(7);
  });

  it('cases_only = cases × caseQty, units map ignored', () => {
    expect(eodTotal('cases_only', 24, '2', '5')).toBe(48);
    expect(eodTotal('cases_only', 24, '', '5')).toBe(0);
    expect(eodTotal('cases_only', 24, 'abc', '5')).toBe(0);
  });

  it('units_only = units, cases map ignored', () => {
    expect(eodTotal('units_only', 24, '2', '5')).toBe(5);
    expect(eodTotal('units_only', 24, '2', '')).toBe(0);
    expect(eodTotal('units_only', 24, '2', 'abc')).toBe(0);
  });
});

describe('eodEntryValues — AC-7 entry values', () => {
  it('returns null when no enabled box has a value', () => {
    expect(eodEntryValues('cases_and_units', 24, '', '')).toBeNull();
    expect(eodEntryValues('cases_only', 24, '', '5')).toBeNull();
    expect(eodEntryValues('units_only', 24, '2', '')).toBeNull();
  });

  it('cases_and_units: both boxes carried; blank box → null (today)', () => {
    expect(eodEntryValues('cases_and_units', 24, '2', '5')).toEqual({ total: 53, cases: 2, units: 5 });
    expect(eodEntryValues('cases_and_units', 24, '2', '')).toEqual({ total: 48, cases: 2, units: null });
    expect(eodEntryValues('cases_and_units', 24, '', '5')).toEqual({ total: 5, cases: null, units: 5 });
  });

  it('cases_and_units: enabled-but-unparseable box → null, counts 0 in total', () => {
    expect(eodEntryValues('cases_and_units', 24, 'abc', '5')).toEqual({ total: 5, cases: null, units: 5 });
  });

  it('cases_only: units always null, total = cases × caseQty', () => {
    expect(eodEntryValues('cases_only', 24, '2', '5')).toEqual({ total: 48, cases: 2, units: null });
    expect(eodEntryValues('cases_only', 24, '0', undefined)).toEqual({ total: 0, cases: 0, units: null });
  });

  it('units_only: cases always null, total = units', () => {
    expect(eodEntryValues('units_only', 24, '2', '5')).toEqual({ total: 5, cases: null, units: 5 });
    expect(eodEntryValues('units_only', 1, undefined, '7')).toEqual({ total: 7, cases: null, units: 7 });
  });

  it('total always equals eodTotal for the same inputs', () => {
    const inputs: Array<[string | undefined, string | undefined]> = [
      ['2', '5'], ['2', ''], ['', '5'], ['abc', '5'], ['1.5', 'x'], [undefined, '3'],
    ];
    for (const mode of EOD_COUNT_MODES) {
      for (const [c, u] of inputs) {
        const v = eodEntryValues(mode, 24, c, u);
        if (v) expect(v.total).toBe(eodTotal(mode, 24, c, u));
      }
    }
  });
});

describe('AC-16 stale value in a now-disabled box', () => {
  it('cases "2" + blank units, mode flips to units_only → total 0, uncounted, omitted', () => {
    const mode = effectiveEodCountMode(24, 'units_only');
    expect(eodTotal(mode, 24, '2', '')).toBe(0);
    expect(eodHasEntry(mode, '2', '')).toBe(false);
    expect(eodEntryValues(mode, 24, '2', '')).toBeNull();
    expect(eodBoxes(mode).cases).toBe(false);
  });

  it('mirror: units "5" + blank cases, mode flips to cases_only → total 0, uncounted, omitted', () => {
    const mode = effectiveEodCountMode(24, 'cases_only');
    expect(eodTotal(mode, 24, '', '5')).toBe(0);
    expect(eodHasEntry(mode, '', '5')).toBe(false);
    expect(eodEntryValues(mode, 24, '', '5')).toBeNull();
    expect(eodBoxes(mode).units).toBe(false);
  });

  it('a stale disabled value never leaks into an emitted entry', () => {
    expect(eodEntryValues(effectiveEodCountMode(24, 'units_only'), 24, '2', '3')).toEqual({
      total: 3, cases: null, units: 3,
    });
    expect(eodEntryValues(effectiveEodCountMode(24, 'cases_only'), 24, '2', '3')).toEqual({
      total: 48, cases: 2, units: null,
    });
  });
});
