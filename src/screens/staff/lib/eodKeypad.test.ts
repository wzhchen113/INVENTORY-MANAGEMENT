// src/screens/staff/lib/eodKeypad.test.ts — Spec 141 §12(a).
//
// The staff keypad helpers are a THIN re-export barrel over the framework-free
// shared module `src/lib/eodKeypad.ts` (OQ-C — share, don't duplicate). The
// shared module already has exhaustive unit coverage (src/lib/eodKeypad.test.ts);
// this suite asserts the barrel re-exports the SAME functions by identity (so a
// future accidental fork is caught) and smoke-checks that the behavior is
// reachable through the staff-local path the screens import.

import * as shared from '../../../lib/eodKeypad';
import {
  appendKeypadDigit,
  activeFieldFor,
  advanceUncounted,
  KEYPAD_BACKSPACE,
} from './eodKeypad';

describe('staff eodKeypad barrel', () => {
  it('re-exports the shared framework-free helpers by identity (no fork)', () => {
    expect(appendKeypadDigit).toBe(shared.appendKeypadDigit);
    expect(activeFieldFor).toBe(shared.activeFieldFor);
    expect(advanceUncounted).toBe(shared.advanceUncounted);
    expect(KEYPAD_BACKSPACE).toBe(shared.KEYPAD_BACKSPACE);
  });

  it('appends digits, a single dot, and backspaces through the barrel', () => {
    expect(appendKeypadDigit('', '0')).toBe('0'); // '0' is a valid count
    expect(appendKeypadDigit('12', '.')).toBe('12.');
    expect(appendKeypadDigit('12.5', '.')).toBe('12.5'); // single dot
    expect(appendKeypadDigit('12345', '6')).toBe('12345'); // max-5 clamp
    expect(appendKeypadDigit('12', KEYPAD_BACKSPACE)).toBe('1');
  });

  it('resolves the default active field by pack size through the barrel', () => {
    expect(activeFieldFor(6)).toBe('cases');
    expect(activeFieldFor(1)).toBe('units');
    expect(activeFieldFor(null)).toBe('units');
  });

  it('advances to the next uncounted with wraparound / DONE through the barrel', () => {
    const list = ['a', 'b', 'c'];
    expect(advanceUncounted(list, 0, (x) => x === 'b')).toEqual({ item: 'c', index: 2 });
    expect(advanceUncounted(list, 2, () => false)).toEqual({ item: 'a', index: 0 }); // wrap
    expect(advanceUncounted(list, 0, () => true)).toBeNull(); // all counted → DONE
  });
});
