// src/lib/eodDraftSlot.test.ts — Spec 192 (design §2).
//
// The slot key is spec 189's baseline key, so its format is pinned byte for
// byte; the day filter must not leak across dates or across store ids that
// share a prefix.

import { eodDayKey, eodSlotKey, isEodSlotOfDay } from './eodDraftSlot';

describe('eodDraftSlot — spec 192 slot / day keys', () => {
  it("eodSlotKey is spec 189's baseline format `${storeId}|${dateIso}|${vendorId}`", () => {
    expect(eodSlotKey('s1', '2026-11-09', 'v1')).toBe('s1|2026-11-09|v1');
  });

  it('eodDayKey is `${storeId}|${dateIso}`, and a slot key is its day key plus `|${vendorId}`', () => {
    expect(eodDayKey('s1', '2026-11-09')).toBe('s1|2026-11-09');
    expect(eodSlotKey('s1', '2026-11-09', 'v1')).toBe(`${eodDayKey('s1', '2026-11-09')}|v1`);
  });

  it('isEodSlotOfDay is true for a slot of its own day, any vendor', () => {
    expect(isEodSlotOfDay(eodSlotKey('s1', '2026-11-09', 'v1'), 's1', '2026-11-09')).toBe(true);
    expect(isEodSlotOfDay(eodSlotKey('s1', '2026-11-09', 'v2'), 's1', '2026-11-09')).toBe(true);
  });

  it('isEodSlotOfDay is false for another date', () => {
    expect(isEodSlotOfDay(eodSlotKey('s1', '2026-11-08', 'v1'), 's1', '2026-11-09')).toBe(false);
  });

  it('isEodSlotOfDay is false for another store', () => {
    expect(isEodSlotOfDay(eodSlotKey('s2', '2026-11-09', 'v1'), 's1', '2026-11-09')).toBe(false);
  });

  it('isEodSlotOfDay is false for a store id that this one is a prefix of (s1 vs s10)', () => {
    expect(isEodSlotOfDay(eodSlotKey('s10', '2026-11-09', 'v1'), 's1', '2026-11-09')).toBe(false);
    expect(isEodSlotOfDay(eodSlotKey('s1', '2026-11-09', 'v1'), 's10', '2026-11-09')).toBe(false);
  });

  it('isEodSlotOfDay is false for a bare day key (no vendor segment)', () => {
    expect(isEodSlotOfDay(eodDayKey('s1', '2026-11-09'), 's1', '2026-11-09')).toBe(false);
  });
});
