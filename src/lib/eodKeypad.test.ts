// src/lib/eodKeypad.test.ts — Spec 140 §6 (jest unit track).
//
// Pure-module coverage for the phone keypad helpers: digit-append edge cases,
// active-field selection, and next-uncounted advance with wraparound / DONE.

import {
  appendKeypadDigit,
  activeFieldFor,
  advanceUncounted,
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
