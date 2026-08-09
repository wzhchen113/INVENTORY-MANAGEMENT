// src/utils/postalCode.test.ts — Spec 155 AC-3 / AC-22 (jest track).
//
// The §5.1 truth table, pinned verbatim. This validator is the single gate in
// front of BOTH `StoreFormDrawer` paths, so a loosened regex here would let a
// value that the IDP retailers probe can never use reach `stores.postal_code`,
// and a tightened one would refuse a legitimate ZIP+4 (OQ-7 — accepted and
// stored verbatim).
//
// Pure module: no mocks, no boundary stubs.

import { parsePostalCode } from './postalCode';

describe('parsePostalCode — valid input (AC-3)', () => {
  it('accepts a bare 5-digit ZIP', () => {
    expect(parsePostalCode('21204')).toEqual({ ok: true, value: '21204' });
  });

  it('trims surrounding whitespace', () => {
    expect(parsePostalCode('  21204  ')).toEqual({ ok: true, value: '21204' });
  });

  it('accepts ZIP+4 and passes it through VERBATIM (OQ-7)', () => {
    expect(parsePostalCode('21204-1234')).toEqual({ ok: true, value: '21204-1234' });
  });
});

describe('parsePostalCode — the explicit clear (never an empty string)', () => {
  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['a tab', '\t'],
  ])('%s ⇒ ok/null', (_label, raw) => {
    expect(parsePostalCode(raw)).toEqual({ ok: true, value: null });
  });

  it('null and undefined also clear', () => {
    expect(parsePostalCode(null)).toEqual({ ok: true, value: null });
    expect(parsePostalCode(undefined)).toEqual({ ok: true, value: null });
  });

  it('never produces an empty string — null is the clear sentinel', () => {
    expect(parsePostalCode('  ').value).not.toBe('');
    expect(parsePostalCode('  ').value).toBeNull();
  });
});

describe('parsePostalCode — refusals (no write may be issued)', () => {
  it.each([
    ['too short', '2120'],
    ['too long', '212045'],
    ['letters', 'ABCDE'],
    ['space instead of the +4 hyphen', '21204 1234'],
    ['truncated +4', '21204-12'],
    ['over-long +4', '21204-12345'],
    ['leading letter', 'A1204'],
    ['hyphen with no +4', '21204-'],
  ])('%s ⇒ ok:false', (_label, raw) => {
    expect(parsePostalCode(raw)).toEqual({ ok: false, value: null });
  });
});
