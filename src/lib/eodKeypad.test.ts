// src/lib/eodKeypad.test.ts — Spec 140 §6 (jest unit track).
//
// Pure-module coverage for the phone keypad helpers: digit-append edge cases,
// active-field selection, and next-uncounted advance with wraparound / DONE.

import {
  appendKeypadDigit,
  activeFieldFor,
  advanceUncounted,
  clampActiveField,
  eodBoxesFor,
  KEYPAD_BACKSPACE,
} from './eodKeypad';

describe('appendKeypadDigit', () => {
  it('appends a digit to an empty field', () => {
    expect(appendKeypadDigit('', '4')).toBe('4');
  });

  it("treats '0' from empty as a valid '0' (AC-9)", () => {
    expect(appendKeypadDigit('', '0')).toBe('0');
  });

  it('appends multiple digits in order', () => {
    let v = '';
    for (const k of ['1', '2', '3']) v = appendKeypadDigit(v, k);
    expect(v).toBe('123');
  });

  it('allows a single decimal point', () => {
    expect(appendKeypadDigit('12', '.')).toBe('12.');
  });

  it('refuses a second decimal point', () => {
    expect(appendKeypadDigit('12.5', '.')).toBe('12.5');
  });

  it('clamps at 5 characters by default (digits)', () => {
    expect(appendKeypadDigit('12345', '6')).toBe('12345');
  });

  it('clamps the decimal point at the max length too', () => {
    expect(appendKeypadDigit('12345', '.')).toBe('12345');
  });

  it('allows a decimal inside the 5-char budget ("100.5")', () => {
    expect(appendKeypadDigit('100.', '5')).toBe('100.5');
    expect(appendKeypadDigit('100.5', '9')).toBe('100.5'); // now full
  });

  it('respects a custom maxLen', () => {
    expect(appendKeypadDigit('12', '3', 2)).toBe('12');
  });

  it('drops the last character on backspace', () => {
    expect(appendKeypadDigit('123', KEYPAD_BACKSPACE)).toBe('12');
  });

  it('backspace on an empty field is a no-op', () => {
    expect(appendKeypadDigit('', KEYPAD_BACKSPACE)).toBe('');
  });

  it('ignores non-digit / non-dot / non-backspace keys', () => {
    expect(appendKeypadDigit('12', 'x')).toBe('12');
    expect(appendKeypadDigit('12', '12')).toBe('12'); // multi-char key
  });
});

describe('activeFieldFor', () => {
  it("returns 'cases' when caseQty > 1", () => {
    expect(activeFieldFor(25)).toBe('cases');
    expect(activeFieldFor(2)).toBe('cases');
  });

  it("returns 'units' when caseQty is 1, 0, undefined or null", () => {
    expect(activeFieldFor(1)).toBe('units');
    expect(activeFieldFor(0)).toBe('units');
    expect(activeFieldFor(undefined)).toBe('units');
    expect(activeFieldFor(null)).toBe('units');
  });
});

describe('advanceUncounted', () => {
  const list = ['a', 'b', 'c', 'd'];

  it('finds the next uncounted forward', () => {
    const counted = new Set(['b']);
    const res = advanceUncounted(list, 0, (i) => counted.has(i));
    expect(res).toEqual({ item: 'c', index: 2 });
  });

  it('skips counted items', () => {
    const counted = new Set(['b', 'c']);
    const res = advanceUncounted(list, 0, (i) => counted.has(i));
    expect(res).toEqual({ item: 'd', index: 3 });
  });

  it('wraps around to the start', () => {
    const counted = new Set(['d']);
    const res = advanceUncounted(list, 3, (i) => counted.has(i));
    expect(res).toEqual({ item: 'a', index: 0 });
  });

  it('returns the current item when it is the only uncounted one', () => {
    const counted = new Set(['a', 'b', 'd']);
    const res = advanceUncounted(list, 2, (i) => counted.has(i));
    expect(res).toEqual({ item: 'c', index: 2 });
  });

  it('returns null when every item is counted (→ DONE)', () => {
    const counted = new Set(list);
    expect(advanceUncounted(list, 0, (i) => counted.has(i))).toBeNull();
  });

  it('returns null on an empty list', () => {
    expect(advanceUncounted([], 0, () => false)).toBeNull();
  });

  it('normalizes a negative fromIndex', () => {
    const counted = new Set<string>();
    const res = advanceUncounted(list, -1, (i) => counted.has(i));
    expect(res).toEqual({ item: 'a', index: 0 });
  });
});

// Spec 171 (AC-8 / AC-9) — the optional 2nd arg seats the ENABLED box under the
// effective count mode. The one-arg assertions above are untouched (AC-9).
describe('activeFieldFor — spec 171 count-mode arg', () => {
  it("seats 'cases' for cases_only and 'units' for units_only when caseQty > 1", () => {
    expect(activeFieldFor(24, 'cases_only')).toBe('cases');
    expect(activeFieldFor(24, 'units_only')).toBe('units');
    expect(activeFieldFor(24, 'cases_and_units')).toBe('cases');
  });

  it('omitting / nulling the mode reproduces the one-arg output for every caseQty', () => {
    for (const q of [undefined, null, 0, 1, 2, 24]) {
      expect(activeFieldFor(q, undefined)).toBe(activeFieldFor(q));
      expect(activeFieldFor(q, null)).toBe(activeFieldFor(q));
    }
  });

  it("caseQty <= 1 is always 'units' regardless of the stored mode (mode is inert)", () => {
    for (const q of [undefined, null, 0, 1]) {
      expect(activeFieldFor(q, 'cases_only')).toBe('units');
      expect(activeFieldFor(q, 'cases_and_units')).toBe('units');
      expect(activeFieldFor(q, 'units_only')).toBe('units');
    }
  });

  // Spec 171 review-fix — the shared box-resolution + seated-field clamp.
  describe('eodBoxesFor', () => {
    it('resolves the boxes under the effective mode when caseQty > 1', () => {
      expect(eodBoxesFor(24, 'cases_and_units')).toEqual({ cases: true, units: true });
      expect(eodBoxesFor(24, 'cases_only')).toEqual({ cases: true, units: false });
      expect(eodBoxesFor(24, 'units_only')).toEqual({ cases: false, units: true });
    });

    it('omitted / null stored mode → legacy layout (both iff caseQty > 1)', () => {
      expect(eodBoxesFor(24)).toEqual({ cases: true, units: true });
      expect(eodBoxesFor(24, null)).toEqual({ cases: true, units: true });
      for (const q of [undefined, null, 0, 1]) {
        expect(eodBoxesFor(q)).toEqual({ cases: false, units: true });
      }
    });

    it('caseQty <= 1 → units only regardless of the stored mode', () => {
      for (const q of [undefined, null, 0, 1]) {
        expect(eodBoxesFor(q, 'cases_only')).toEqual({ cases: false, units: true });
      }
    });
  });

  describe('clampActiveField', () => {
    it('keeps an active field whose box is enabled', () => {
      expect(clampActiveField('cases', 24, 'cases_and_units')).toBe('cases');
      expect(clampActiveField('units', 24, 'cases_and_units')).toBe('units');
      expect(clampActiveField('cases', 24, 'cases_only')).toBe('cases');
      expect(clampActiveField('units', 24, 'units_only')).toBe('units');
    });

    it("re-seats a stale field onto the mode's enabled box", () => {
      expect(clampActiveField('cases', 24, 'units_only')).toBe('units');
      expect(clampActiveField('units', 24, 'cases_only')).toBe('cases');
      expect(clampActiveField('cases', 1, 'cases_only')).toBe('units');
      expect(clampActiveField('cases', undefined)).toBe('units');
    });

    it('legacy layout (no stored mode) never moves a field for caseQty > 1', () => {
      expect(clampActiveField('cases', 24)).toBe('cases');
      expect(clampActiveField('units', 24)).toBe('units');
    });
  });
});
