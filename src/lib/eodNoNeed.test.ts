// src/lib/eodNoNeed.test.ts — Spec 172 (AC-16, AC-27 guards, AC-35 helper arms).
//
// Pure-helper coverage for src/lib/eodNoNeed.ts. The surfaces (admin
// desktop/phone, staff) are covered by the frontend render arms; these pin
// the rules every surface delegates to, under each of spec 171's three
// effective modes.

import { EOD_COUNT_MODES, eodEntryValues, eodHasEntry, type EodCountMode } from './eodCountMode';
import {
  EOD_NO_NEED_AUDIT_VALUE,
  REORDER_FLAG_NO_NEED,
  type EodRowState,
  eodRowCounted,
  eodRowEntryValues,
  eodSetNoNeed,
  eodToggleNoNeed,
  eodTypeInto,
  isNumericEodEntry,
  numericEodSubmissions,
} from './eodNoNeed';
import type { EODEntry, EODSubmission } from '../types';

// [caseRaw, unitRaw] pairs covering blank, enabled-only, disabled-only, both.
const RAWS: Array<[string | undefined, string | undefined]> = [
  [undefined, undefined],
  ['', ''],
  ['  ', ''],
  ['2', ''],
  ['', '3'],
  ['2', '3'],
  ['abc', ''],
];

describe('constants', () => {
  it('audit literal is the stored English "NO NEED" (N6; the SQL RPC hardcodes the same)', () => {
    expect(EOD_NO_NEED_AUDIT_VALUE).toBe('NO NEED');
  });
  it('reorder flag token is "no_need" (R4)', () => {
    expect(REORDER_FLAG_NO_NEED).toBe('no_need');
  });
});

describe.each(EOD_COUNT_MODES.map((m) => [m]))('mode %s', (mode: EodCountMode) => {
  describe('eodRowCounted (AC-16 counted)', () => {
    it.each(RAWS)('noNeed=true is counted regardless of boxes (%p, %p)', (c, u) => {
      expect(eodRowCounted(true, mode, c, u)).toBe(true);
    });
    it.each(RAWS)('noNeed false/undefined → eodHasEntry verbatim (%p, %p)', (c, u) => {
      expect(eodRowCounted(false, mode, c, u)).toBe(eodHasEntry(mode, c, u));
      expect(eodRowCounted(undefined, mode, c, u)).toBe(eodHasEntry(mode, c, u));
    });
  });

  describe('eodRowEntryValues (AC-16 entry values)', () => {
    it.each(RAWS)('NO NEED emits no quantity and ignores stale typed values (%p, %p)', (c, u) => {
      expect(eodRowEntryValues(true, mode, 4, c, u)).toEqual({
        noNeed: true,
        total: null,
        cases: null,
        units: null,
      });
    });
    it.each(RAWS)('otherwise 171 eodEntryValues is unchanged (%p, %p)', (c, u) => {
      const base = eodEntryValues(mode, 4, c, u);
      const got = eodRowEntryValues(false, mode, 4, c, u);
      if (base === null) {
        expect(got).toBeNull();
      } else {
        expect(got).toEqual({ noNeed: false, ...base });
      }
      expect(eodRowEntryValues(undefined, mode, 4, c, u)).toEqual(got);
    });
  });
});

describe('toggle transitions (AC-16 / AC-19 / AC-29 / AC-35)', () => {
  const blank: EodRowState = { caseRaw: '', unitRaw: '', noNeed: false };
  const typed: EodRowState = { caseRaw: '2', unitRaw: '3', noNeed: false };
  const on: EodRowState = { caseRaw: '', unitRaw: '', noNeed: true };

  it('setting NO NEED via the row button clears both typed boxes', () => {
    expect(eodToggleNoNeed(typed)).toEqual(on);
    expect(eodToggleNoNeed(blank)).toEqual(on);
  });

  it('clears a stale value sitting in a mode-disabled box too (AC-35)', () => {
    // e.g. units_only with a leftover case value — both maps are cleared.
    expect(eodToggleNoNeed({ caseRaw: '5', unitRaw: '', noNeed: false })).toEqual(on);
    expect(eodToggleNoNeed({ caseRaw: '', unitRaw: '7', noNeed: false })).toEqual(on);
  });

  it('tapping NO NEED again clears it: uncounted with blank boxes', () => {
    const off = eodToggleNoNeed(on);
    expect(off).toEqual(blank);
    for (const mode of EOD_COUNT_MODES) {
      expect(eodRowCounted(off.noNeed, mode, off.caseRaw, off.unitRaw)).toBe(false);
    }
  });

  it('the sheet setter always sets (idempotent)', () => {
    expect(eodSetNoNeed(typed)).toEqual(on);
    expect(eodSetNoNeed(on)).toEqual(on);
    expect(eodSetNoNeed(blank)).toEqual(on);
  });

  it('typing any character into either box clears NO NEED and writes the text', () => {
    expect(eodTypeInto(on, 'cases', '1')).toEqual({ caseRaw: '1', unitRaw: '', noNeed: false });
    expect(eodTypeInto(on, 'units', '.')).toEqual({ caseRaw: '', unitRaw: '.', noNeed: false });
  });

  it('a keypad backspace (empty text) also clears NO NEED → uncounted, blank wells', () => {
    const after = eodTypeInto(on, 'units', '');
    expect(after).toEqual(blank);
  });

  it('typing into a numeric row leaves the other box intact', () => {
    expect(eodTypeInto(typed, 'units', '30')).toEqual({ caseRaw: '2', unitRaw: '30', noNeed: false });
  });

  it('invariant: noNeed ⇒ both raws blank after every transition', () => {
    const states: EodRowState[] = [blank, typed, on, { caseRaw: '9', unitRaw: '', noNeed: false }];
    for (const s of states) {
      for (const next of [eodToggleNoNeed(s), eodSetNoNeed(s), eodTypeInto(s, 'cases', 'x'), eodTypeInto(s, 'units', '')]) {
        if (next.noNeed) {
          expect(next.caseRaw).toBe('');
          expect(next.unitRaw).toBe('');
        }
      }
    }
  });
});

// ─── AC-27 numeric guards ─────────────────────────────────────────────

function entry(over: Partial<EODEntry>): EODEntry {
  return {
    id: 'e',
    itemId: 'i',
    itemName: 'Item',
    actualRemaining: 4,
    unit: 'each',
    submittedBy: 'Pat',
    submittedByUserId: 'u',
    timestamp: '2026-10-23T22:00:00Z',
    date: '2026-10-23',
    storeId: 's',
    notes: '',
    ...over,
  };
}

function sub(id: string, entries: EODEntry[]): EODSubmission {
  return {
    id,
    date: '2026-10-23',
    storeId: 's',
    storeName: 'S',
    vendorId: 'v',
    submittedBy: 'Pat',
    submittedByUserId: 'u',
    timestamp: '2026-10-23T22:00:00Z',
    itemCount: entries.length,
    status: 'submitted',
    entries,
  };
}

describe('isNumericEodEntry', () => {
  it('true for a numeric entry (including 0)', () => {
    expect(isNumericEodEntry(entry({ actualRemaining: 4 }))).toBe(true);
    expect(isNumericEodEntry(entry({ actualRemaining: 0 }))).toBe(true);
  });
  it('false for a NO NEED entry', () => {
    expect(isNumericEodEntry(entry({ actualRemaining: null, noNeed: true }))).toBe(false);
  });
  it('false for a null total even without the flag (defensive)', () => {
    expect(isNumericEodEntry(entry({ actualRemaining: null }))).toBe(false);
  });
});

describe('numericEodSubmissions', () => {
  it('returns the SAME submission object when it has no NO NEED entry (identity-stable)', () => {
    const a = sub('a', [entry({ itemId: 'x' }), entry({ itemId: 'y' })]);
    const b = sub('b', []);
    const out = numericEodSubmissions([a, b]);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });

  it('strips NO NEED entries into a new object, leaving the input untouched', () => {
    const nn = entry({ itemId: 'nn', actualRemaining: null, noNeed: true });
    const x = entry({ itemId: 'x' });
    const a = sub('a', [x, nn]);
    const [out] = numericEodSubmissions([a]);
    expect(out).not.toBe(a);
    expect(out.entries).toEqual([x]);
    expect(out.id).toBe('a');
    expect(out.itemCount).toBe(2); // metadata untouched; only entries are stripped
    expect(a.entries).toHaveLength(2);
  });

  it('passes through a legacy submission without entries untouched', () => {
    const legacy = { ...sub('l', []), entries: undefined } as unknown as EODSubmission;
    expect(numericEodSubmissions([legacy])[0]).toBe(legacy);
  });
});
