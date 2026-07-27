// src/screens/cmd/sections/eod/__tests__/PhoneType.test.tsx — Spec 140 §6.
//
// The phone type ramp (AC-13): family/weight/size per the handoff table, the
// legibility floors (metaMono ≥ 10.5 / microCaption ≥ 8.5), and the additive
// contract — the existing `Type` map is byte-unchanged. `.test.tsx` so the
// jsdom `component` project picks it up (typography imports react-native).

import { PhoneType, Type, sans, mono } from '../../../../../theme/typography';

describe('PhoneType ramp (spec 140 AC-13)', () => {
  it('honors the legibility floors', () => {
    expect(PhoneType.metaMono.fontSize as number).toBeGreaterThanOrEqual(10.5);
    expect(PhoneType.microCaption.fontSize as number).toBeGreaterThanOrEqual(8.5);
  });

  it('matches the handoff family / weight / size table', () => {
    expect(PhoneType.screenTitle).toMatchObject({ fontFamily: sans(600), fontSize: 20, letterSpacing: -0.4 });
    expect(PhoneType.itemName).toMatchObject({ fontFamily: sans(600), fontSize: 15, letterSpacing: -0.1 });
    expect(PhoneType.body).toMatchObject({ fontFamily: sans(400), fontSize: 14 });
    expect(PhoneType.metaMono).toMatchObject({ fontFamily: mono(400), fontSize: 11 });
    expect(PhoneType.caption).toMatchObject({ fontFamily: mono(600), fontSize: 10.5, letterSpacing: 0.85, textTransform: 'uppercase' });
    expect(PhoneType.microCaption).toMatchObject({ fontFamily: mono(600), fontSize: 9, letterSpacing: 0.7, textTransform: 'uppercase' });
    expect(PhoneType.wellValue).toMatchObject({ fontFamily: mono(600), fontSize: 16 });
    expect(PhoneType.wellValueSheet).toMatchObject({ fontFamily: mono(600), fontSize: 20 });
    expect(PhoneType.kpiValue).toMatchObject({ fontFamily: mono(600), fontSize: 19, letterSpacing: -0.3 });
    expect(PhoneType.keypadKey).toMatchObject({ fontFamily: mono(500), fontSize: 18 });
    expect(PhoneType.tableNum).toMatchObject({ fontFamily: mono(600), fontSize: 14 });
  });

  it('tabular roles carry the tabular-nums fontVariant', () => {
    for (const role of ['metaMono', 'wellValue', 'wellValueSheet', 'kpiValue', 'tableNum']) {
      expect(PhoneType[role].fontVariant).toEqual(['tabular-nums']);
    }
  });

  it('leaves the existing Type map byte-unchanged (additive contract)', () => {
    expect(Type.body).toEqual({ fontFamily: sans(400), fontSize: 13 });
    expect(Type.h2).toEqual({ fontFamily: sans(600), fontSize: 14, letterSpacing: -0.1 });
    expect(Type.caption).toEqual({ fontFamily: mono(600), fontSize: 10, letterSpacing: 0.75, textTransform: 'uppercase' });
  });
});
