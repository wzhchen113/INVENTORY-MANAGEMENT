// src/screens/staff/lib/borrowedEntries.test.ts — Spec 200 AC-1 (a)-(k),
// plus entrySeed parity with the pre-refactor seedFromExisting rule and the
// verbatim all-borrowed copy shape (design §3, §9).

import {
  borrowedEntryCopy,
  deriveBorrowedEntries,
  entrySeed,
  isBorrowable,
  parseTimestamp,
  sameQuantity,
  stockMismatchIds,
  type DeriveBorrowedArgs,
} from './borrowedEntries';
import type { EodEntry, QueuedSubmission, ServerEodSource } from './types';

const STORE = 'store-S';
const OTHER_STORE = 'store-T';
const DATE = '2026-11-18';
const OTHER_DATE = '2026-11-17';
const A = 'vendor-a';
const B = 'vendor-b'; // the selected vendor in every arm
const C = 'vendor-c';
const U = 'user-U';
const X = 'item-x';
const Y = 'item-y';

function units(itemId: string, n: number): EodEntry {
  return { item_id: itemId, actual_remaining: n, actual_remaining_cases: null, actual_remaining_each: n };
}

function noNeedEntry(itemId: string): EodEntry {
  return {
    item_id: itemId,
    actual_remaining: null,
    actual_remaining_cases: null,
    actual_remaining_each: null,
    no_need: true,
  };
}

function server(over: Partial<ServerEodSource> & { entries: EodEntry[] }): ServerEodSource {
  return {
    submissionId: '00000000-0000-0000-0000-00000000000a',
    storeId: STORE,
    date: DATE,
    vendorId: A,
    vendorName: 'Sysco',
    status: 'submitted',
    submittedAt: '2026-11-18T20:00:00+00:00',
    ...over,
  };
}

function queued(over: Partial<QueuedSubmission> & { entries: EodEntry[] }): QueuedSubmission {
  return {
    client_uuid: '11111111-1111-4111-8111-111111111111',
    store_id: STORE,
    date: DATE,
    vendor_id: A,
    status: 'submitted',
    queued_at: '2026-11-18T22:00:00.000Z',
    intent_user_id: U,
    attempts: 0,
    ...over,
  };
}

function derive(over: Partial<DeriveBorrowedArgs>) {
  return deriveBorrowedEntries({
    serverSources: [],
    queue: [],
    storeId: STORE,
    countIso: DATE,
    vendorId: B,
    userId: U,
    vendorNameById: { [A]: 'Sysco', [B]: 'US Foods', [C]: 'BJs' },
    ...over,
  });
}

describe('deriveBorrowedEntries — AC-1', () => {
  it('borrows another vendor\'s submitted entry with its vendor name (server)', () => {
    const out = derive({ serverSources: [server({ entries: [units(X, 5)] })] });
    expect(out.get(X)).toEqual({
      vendorId: A,
      vendorName: 'Sysco',
      entry: units(X, 5),
      source: 'server',
    });
    expect(out.has(Y)).toBe(false);
  });

  it('(a) excludes a different-date source (server and queued)', () => {
    const out = derive({
      serverSources: [server({ date: OTHER_DATE, entries: [units(X, 5)] })],
      queue: [queued({ date: OTHER_DATE, entries: [units(Y, 2)] })],
    });
    expect(out.size).toBe(0);
  });

  it('(b) excludes a different-store source (server and queued)', () => {
    const out = derive({
      serverSources: [server({ storeId: OTHER_STORE, entries: [units(X, 5)] })],
      queue: [queued({ store_id: OTHER_STORE, entries: [units(Y, 2)] })],
    });
    expect(out.size).toBe(0);
  });

  it('(c) excludes this vendor\'s own server and queued submissions', () => {
    const out = derive({
      serverSources: [server({ vendorId: B, vendorName: 'US Foods', entries: [units(X, 5)] })],
      queue: [queued({ vendor_id: B, entries: [units(Y, 2)] })],
    });
    expect(out.size).toBe(0);
  });

  it('(d) excludes a draft server source', () => {
    const out = derive({ serverSources: [server({ status: 'draft', entries: [units(X, 5)] })] });
    expect(out.size).toBe(0);
  });

  it('(e) excludes a queued item whose intent_user_id is not the signed-in user', () => {
    const out = derive({ queue: [queued({ intent_user_id: 'user-other', entries: [units(X, 8)] })] });
    expect(out.size).toBe(0);
    // ... and with no signed-in user, no queued item borrows at all.
    expect(derive({ userId: undefined, queue: [queued({ entries: [units(X, 8)] })] }).size).toBe(0);
  });

  it('(f) the latest submitted_at among other vendors wins (A 20:00 X=5, C 21:00 X=6 → 6 from C)', () => {
    const out = derive({
      serverSources: [
        server({ submissionId: 'aaaaaaaa-0000-0000-0000-000000000001', vendorId: A, vendorName: 'Sysco', submittedAt: '2026-11-18T20:00:00+00:00', entries: [units(X, 5)] }),
        server({ submissionId: 'aaaaaaaa-0000-0000-0000-000000000002', vendorId: C, vendorName: 'BJs', submittedAt: '2026-11-18T21:00:00+00:00', entries: [units(X, 6)] }),
      ],
    });
    expect(out.get(X)).toMatchObject({ vendorId: C, vendorName: 'BJs', entry: units(X, 6), source: 'server' });
  });

  it('(g) a queued source replaces its vendor\'s server source (A server 5 + A queued 8 → 8, queued)', () => {
    const out = derive({
      serverSources: [server({ vendorId: A, submittedAt: '2026-11-18T23:00:00+00:00', entries: [units(X, 5), units(Y, 1)] })],
      queue: [queued({ vendor_id: A, queued_at: '2026-11-18T20:00:00.000Z', entries: [units(X, 8)] })],
    });
    expect(out.get(X)).toMatchObject({ vendorId: A, vendorName: 'Sysco', entry: units(X, 8), source: 'queued' });
    // Replaced ENTIRELY — the server row's other entries no longer borrow.
    expect(out.has(Y)).toBe(false);
  });

  it('(h) a queued C at 22:00 beats a server A at 21:00', () => {
    const out = derive({
      serverSources: [server({ vendorId: A, submittedAt: '2026-11-18T21:00:00+00:00', entries: [units(X, 5)] })],
      queue: [queued({ vendor_id: C, queued_at: '2026-11-18T22:00:00.000Z', entries: [units(X, 9)] })],
    });
    expect(out.get(X)).toMatchObject({ vendorId: C, vendorName: 'BJs', entry: units(X, 9), source: 'queued' });
  });

  it('(h2) at the same millisecond, queued ranks before server', () => {
    const out = derive({
      serverSources: [server({ vendorId: A, submittedAt: '2026-11-18T21:00:00.000999+00:00', entries: [units(X, 5)] })],
      queue: [queued({ vendor_id: C, queued_at: '2026-11-18T21:00:00.000Z', entries: [units(X, 9)] })],
    });
    expect(out.get(X)?.source).toBe('queued');
  });

  it('(i) equal submitted_at → the higher submission id wins (id DESC)', () => {
    const ts = '2026-11-18T21:00:00.123456+00:00';
    const out = derive({
      serverSources: [
        server({ submissionId: '0fffffff-0000-0000-0000-000000000000', vendorId: A, vendorName: 'Sysco', submittedAt: ts, entries: [units(X, 5)] }),
        server({ submissionId: 'f0000000-0000-0000-0000-000000000000', vendorId: C, vendorName: 'BJs', submittedAt: ts, entries: [units(X, 6)] }),
      ],
    });
    expect(out.get(X)).toMatchObject({ vendorId: C, entry: units(X, 6) });
    // Input order does not matter.
    const rev = derive({
      serverSources: [
        server({ submissionId: 'f0000000-0000-0000-0000-000000000000', vendorId: C, vendorName: 'BJs', submittedAt: ts, entries: [units(X, 6)] }),
        server({ submissionId: '0fffffff-0000-0000-0000-000000000000', vendorId: A, vendorName: 'Sysco', submittedAt: ts, entries: [units(X, 5)] }),
      ],
    });
    expect(rev.get(X)).toMatchObject({ vendorId: C, entry: units(X, 6) });
  });

  it('(j) same millisecond, different microseconds → the later microsecond wins (not Date.parse alone)', () => {
    const out = derive({
      serverSources: [
        // Higher id but EARLIER microsecond — must lose.
        server({ submissionId: 'ffffffff-0000-0000-0000-000000000000', vendorId: A, vendorName: 'Sysco', submittedAt: '2026-11-18T21:00:00.123001+00:00', entries: [units(X, 5)] }),
        server({ submissionId: '00000000-0000-0000-0000-000000000001', vendorId: C, vendorName: 'BJs', submittedAt: '2026-11-18T21:00:00.123999+00:00', entries: [units(X, 6)] }),
      ],
    });
    expect(out.get(X)).toMatchObject({ vendorId: C, entry: units(X, 6) });
    // Trailing-zero-trimmed fractions compare correctly (.1234 = .123400).
    const trimmed = derive({
      serverSources: [
        server({ submissionId: 'ffffffff-0000-0000-0000-000000000000', vendorId: A, vendorName: 'Sysco', submittedAt: '2026-11-18T21:00:00.1234+00:00', entries: [units(X, 5)] }),
        server({ submissionId: '00000000-0000-0000-0000-000000000001', vendorId: C, vendorName: 'BJs', submittedAt: '2026-11-18T21:00:00.123401+00:00', entries: [units(X, 6)] }),
      ],
    });
    expect(trimmed.get(X)).toMatchObject({ vendorId: C });
  });

  it('(k) the latest source holds a blank legacy entry for X → X comes from the next source', () => {
    const blank: EodEntry = { item_id: X, actual_remaining: null, actual_remaining_cases: null, actual_remaining_each: null };
    const out = derive({
      serverSources: [
        server({ submissionId: 'aaaaaaaa-0000-0000-0000-000000000002', vendorId: C, vendorName: 'BJs', submittedAt: '2026-11-18T22:00:00+00:00', entries: [blank] }),
        server({ submissionId: 'aaaaaaaa-0000-0000-0000-000000000001', vendorId: A, vendorName: 'Sysco', submittedAt: '2026-11-18T20:00:00+00:00', entries: [units(X, 5)] }),
      ],
    });
    expect(out.get(X)).toMatchObject({ vendorId: A, entry: units(X, 5) });
  });

  it('a NO NEED entry is borrowable and wins when latest', () => {
    const out = derive({
      serverSources: [
        server({ submissionId: 'aaaaaaaa-0000-0000-0000-000000000002', vendorId: C, vendorName: 'BJs', submittedAt: '2026-11-18T22:00:00+00:00', entries: [noNeedEntry(X)] }),
        server({ submissionId: 'aaaaaaaa-0000-0000-0000-000000000001', vendorId: A, submittedAt: '2026-11-18T20:00:00+00:00', entries: [units(X, 5)] }),
      ],
    });
    expect(out.get(X)?.entry).toEqual(noNeedEntry(X));
  });

  it('a null submitted_at sorts last (NULLS LAST); a null vendor is kept with a null name', () => {
    const out = derive({
      serverSources: [
        server({ submissionId: 'ffffffff-0000-0000-0000-000000000000', vendorId: null, vendorName: null, submittedAt: null, entries: [units(X, 1), units(Y, 2)] }),
        server({ submissionId: '00000000-0000-0000-0000-000000000001', vendorId: A, submittedAt: '2026-11-18T08:00:00+00:00', entries: [units(X, 5)] }),
      ],
    });
    expect(out.get(X)).toMatchObject({ vendorId: A, entry: units(X, 5) });
    expect(out.get(Y)).toMatchObject({ vendorId: null, vendorName: null, entry: units(Y, 2) });
  });

  it('a queued vendor missing from the chip list → vendorName null (renderer falls back)', () => {
    const out = derive({
      vendorNameById: {},
      queue: [queued({ vendor_id: 'vendor-gone', entries: [units(X, 3)] })],
    });
    expect(out.get(X)).toMatchObject({ vendorId: 'vendor-gone', vendorName: null, source: 'queued' });
  });

  it('two queued items for one vendor: the later queued_at wins (it drains last)', () => {
    const out = derive({
      queue: [
        queued({ client_uuid: '22222222-2222-4222-8222-222222222222', queued_at: '2026-11-18T22:30:00.000Z', entries: [units(X, 4)] }),
        queued({ client_uuid: '33333333-3333-4333-8333-333333333333', queued_at: '2026-11-18T22:00:00.000Z', entries: [units(X, 3), units(Y, 1)] }),
      ],
    });
    expect(out.get(X)?.entry).toEqual(units(X, 4));
    expect(out.has(Y)).toBe(false);
  });
});

describe('parseTimestamp', () => {
  it('keeps the sub-millisecond digits and the ms epoch', () => {
    const p = parseTimestamp('2026-11-18T21:00:00.123456+00:00');
    expect(p.ms).toBe(Date.UTC(2026, 10, 18, 21, 0, 0, 123));
    expect(p.subMs).toBe(456);
  });
  it('null / unparseable → -Infinity', () => {
    expect(parseTimestamp(null).ms).toBe(-Infinity);
    expect(parseTimestamp('not a date').ms).toBe(-Infinity);
  });
  it('no fraction → subMs 0', () => {
    expect(parseTimestamp('2026-11-18T21:00:00+00:00')).toEqual({ ms: Date.UTC(2026, 10, 18, 21), subMs: 0 });
  });
});

describe('isBorrowable', () => {
  it('numeric or NO NEED only', () => {
    expect(isBorrowable(units(X, 0))).toBe(true);
    expect(isBorrowable(noNeedEntry(X))).toBe(true);
    expect(
      isBorrowable({ item_id: X, actual_remaining: null, actual_remaining_cases: 2, actual_remaining_each: null }),
    ).toBe(false);
  });
});

describe('entrySeed — parity with the pre-refactor seedFromExisting rule', () => {
  // The pre-spec-200 per-entry seed, copied verbatim from EODCount.tsx so the
  // extraction is pinned byte-for-byte (absent key ⇔ '').
  function legacySeed(e: EodEntry) {
    const out: { caseRaw?: string; unitRaw?: string; noNeed?: true } = {};
    if (e.no_need === true) out.noNeed = true;
    if (e.actual_remaining_cases != null) out.caseRaw = String(e.actual_remaining_cases);
    const u =
      e.actual_remaining_each != null
        ? e.actual_remaining_each
        : e.actual_remaining_cases == null
          ? e.actual_remaining
          : null;
    if (u != null) out.unitRaw = String(u);
    return { caseRaw: out.caseRaw ?? '', unitRaw: out.unitRaw ?? '', noNeed: out.noNeed === true };
  }

  const cases: Array<[string, EodEntry]> = [
    ['cases + units', { item_id: X, actual_remaining: 26, actual_remaining_cases: 2, actual_remaining_each: 2 }],
    ['units only', { item_id: X, actual_remaining: 7, actual_remaining_cases: null, actual_remaining_each: 7 }],
    ['legacy total only (spec 086 OQ-4)', { item_id: X, actual_remaining: 9, actual_remaining_cases: null, actual_remaining_each: null }],
    ['cases only (spec 171) — units blank, not the total', { item_id: X, actual_remaining: 24, actual_remaining_cases: 2, actual_remaining_each: null }],
    ['zero', { item_id: X, actual_remaining: 0, actual_remaining_cases: null, actual_remaining_each: 0 }],
    ['decimal', { item_id: X, actual_remaining: 1.5, actual_remaining_cases: null, actual_remaining_each: 1.5 }],
    ['NO NEED (spec 172)', noNeedEntry(X)],
    ['all null', { item_id: X, actual_remaining: null, actual_remaining_cases: null, actual_remaining_each: null }],
  ];
  it.each(cases)('%s', (_label, e) => {
    expect(entrySeed(e)).toEqual(legacySeed(e));
  });
  it('cases-only row leaves units blank', () => {
    expect(entrySeed(cases[3][1])).toEqual({ caseRaw: '2', unitRaw: '', noNeed: false });
  });
});

describe('borrowedEntryCopy — verbatim (design §9)', () => {
  it('numeric copy has the same three numbers and NO no_need key', () => {
    const e: EodEntry = { item_id: X, actual_remaining: 24, actual_remaining_cases: 2, actual_remaining_each: null };
    const copy = borrowedEntryCopy(X, e);
    expect(copy).toEqual(e);
    expect('no_need' in copy).toBe(false);
  });
  it('NO NEED copy keeps the §6.3 shape', () => {
    expect(borrowedEntryCopy(X, noNeedEntry(X))).toEqual(noNeedEntry(X));
  });
});

describe('AC-20 — sameQuantity / stockMismatchIds', () => {
  it('sameQuantity tolerates numeric/string formatting and float noise; null/blank never equal', () => {
    expect(sameQuantity('5.000', 5)).toBe(true);
    expect(sameQuantity(0.1 + 0.2, '0.300')).toBe(true);
    expect(sameQuantity(5, 5.001)).toBe(false);
    expect(sameQuantity(null, 5)).toBe(false);
    expect(sameQuantity(5, null)).toBe(false);
    expect(sameQuantity('', 0)).toBe(false);
    expect(sameQuantity('abc', 0)).toBe(false);
    expect(sameQuantity('0', 0)).toBe(true);
  });

  it('returns numeric copies whose count differs from current_stock, in copy order; NO NEED skipped; missing = mismatch', () => {
    const copies: EodEntry[] = [units('a', 5), noNeedEntry('nn'), units('b', 6), units('c', 7), units('d', 0)];
    const stock = new Map<string, number | string | null>([
      ['a', '5.000'], // match
      ['b', 9], // changed since the count
      ['d', null], // null stock → fail closed
      // 'c' missing (not readable at this store) → fail closed
    ]);
    expect(stockMismatchIds(copies, stock)).toEqual(['b', 'c', 'd']);
  });

  it('all match → []', () => {
    expect(stockMismatchIds([units('a', 5)], new Map([['a', 5]]))).toEqual([]);
  });
});

