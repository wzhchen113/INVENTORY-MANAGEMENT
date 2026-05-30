// src/lib/cmdSelectors.unconfirmedPoWindow.test.ts — Spec 074 Track 1.
//
// Locks the Monday-reset behavior of `computeAttentionQueue`'s
// `unconfirmed_po` rule. Other rules in the function are deliberately
// NOT exercised here — they retain their pre-spec-074 windowing (see
// inline comment in cmdSelectors.ts above the unconfirmed_po block).
//
// Every test pins `now: Date` and `timezone: string` explicitly via the
// selector args — never call without injection or assertions go flaky
// on a wall-clock day boundary.

// Stub `./supabase` because `cmdSelectors.ts` transitively imports
// `useStore` → `db.ts` → `supabase.ts`, which calls `createClient()`
// at module-load time and crashes without `EXPO_PUBLIC_SUPABASE_URL`.
// `computeAttentionQueue` itself is pure — the import chain is the
// only thing that touches Supabase. Mirrors `src/lib/translate.test.ts`.
jest.mock('./supabase', () => ({
  supabase: {
    auth: { getSession: jest.fn() },
    channel: jest.fn(() => ({
      on: jest.fn().mockReturnThis(),
      subscribe: jest.fn(),
    })),
    removeChannel: jest.fn(),
    from: jest.fn(),
    rpc: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

import { computeAttentionQueue } from './cmdSelectors';
import type {
  InventoryItem, EODSubmission, POSImport, OrderSubmission,
  OrderSchedule, Store, ItemStatus,
} from '../types';

// ── Fixture helpers ────────────────────────────────────────────
const STORE_ID = 'store-1';
const TZ = 'America/New_York';

const stores: Store[] = [{
  id: STORE_ID,
  brandId: 'brand-1',
  name: 'Test Store',
  address: '',
  status: 'active',
} as Store];

const inventory: InventoryItem[] = [];

// `getItemStatus` always returns 'fine' so the low_out_stock rule
// stays silent and we can isolate unconfirmed_po assertions.
const getItemStatus: (i: InventoryItem) => ItemStatus = () => 'fine' as ItemStatus;

// Vendor V scheduled Mon..Fri. The acceptance criteria's "Wed 'today',
// Mon/Tue past, Thu/Fri future" arrangement runs through this map.
const VENDOR_V: { vendorId: string; vendorName: string; deliveryDay: string } = {
  vendorId: 'vendor-v',
  vendorName: 'Vendor V',
  deliveryDay: 'next-day',
};

const orderSchedule: OrderSchedule = {
  Monday:    [VENDOR_V],
  Tuesday:   [VENDOR_V],
  Wednesday: [VENDOR_V],
  Thursday:  [VENDOR_V],
  Friday:    [VENDOR_V],
};

const tuesdaySubmission: OrderSubmission = {
  id: 'sub-tue',
  storeId: STORE_ID,
  day: 'Tuesday',
  date: '2026-05-26',  // Tue 2026-05-26 NY
  vendorName: 'Vendor V',
  submittedBy: 'user-1',
  submittedAt: '2026-05-26T15:00:00Z',
};

const orderSubmissions: OrderSubmission[] = [tuesdaySubmission];
const eodSubmissions: EODSubmission[] = [];
const posImports: POSImport[] = [];

function runQueue(now: Date, tz: string = TZ) {
  return computeAttentionQueue(
    STORE_ID, inventory, eodSubmissions, posImports,
    orderSubmissions, orderSchedule, stores,
    getItemStatus, tz, now,
  );
}

function poItemsOnly(items: ReturnType<typeof runQueue>) {
  return items.filter((i) => i.rule === 'unconfirmed_po');
}

// ── Acceptance criteria ────────────────────────────────────────
describe('computeAttentionQueue.unconfirmed_po — Monday-reset window', () => {
  it('Monday morning at 00:01 local — empty (window contains only today)', () => {
    // 2026-05-25T04:01:00Z = 2026-05-25 00:01 EDT (Monday)
    const items = poItemsOnly(runQueue(new Date('2026-05-25T04:01:00Z')));
    expect(items).toHaveLength(0);
  });

  it('Wednesday afternoon — only Monday miss included (Tue matched; Wed=today; Thu/Fri future)', () => {
    // 2026-05-27T14:00:00Z = 2026-05-27 10:00 EDT (Wednesday)
    const items = poItemsOnly(runQueue(new Date('2026-05-27T14:00:00Z')));
    expect(items).toHaveLength(1);
    expect(items[0].text).toContain('2026-05-25');
    expect(items[0].text).toContain('Vendor V');
    expect(items[0].id).toBe(`${STORE_ID}:po:vendor-v:2026-05-25`);
  });

  it('Tuesday afternoon — only Monday miss; Sunday-and-earlier excluded', () => {
    // 2026-05-26T18:00:00Z = 2026-05-26 14:00 EDT (Tuesday)
    const items = poItemsOnly(runQueue(new Date('2026-05-26T18:00:00Z')));
    expect(items).toHaveLength(1);
    expect(items[0].text).toContain('2026-05-25');
  });

  it('Sunday night just before midnight — full Mon..Sat past days (Tue matched)', () => {
    // The spec AC reads "now = 2026-05-31T23:00:00 (a Sunday)" — that is
    // LOCAL EDT time. Converted to UTC: 2026-06-01T03:59:00Z = 2026-05-31
    // 23:59 EDT (Sunday — still in current work-week). The Z-suffix in
    // the fixture is UTC, not local; the times match the spec AC after
    // the +4 EDT-to-UTC offset.
    const items = poItemsOnly(runQueue(new Date('2026-06-01T03:59:00Z')));
    // Mon, Wed, Thu, Fri = 4 misses. Tue matched. Sat is not scheduled
    // (no vendor on Saturday in the fixture). Today (Sunday) excluded.
    expect(items).toHaveLength(4);
    const dates = items.map((i) => i.id);
    expect(dates).toEqual(expect.arrayContaining([
      `${STORE_ID}:po:vendor-v:2026-05-25`,
      `${STORE_ID}:po:vendor-v:2026-05-27`,
      `${STORE_ID}:po:vendor-v:2026-05-28`,
      `${STORE_ID}:po:vendor-v:2026-05-29`,
    ]));
  });

  it('Edge case: clock right at Monday 00:00 — previous week items immediately drop', () => {
    // Sunday 2026-05-31 23:59:59 EDT — last second of the OLD week.
    // 2026-06-01T03:59:59Z
    const lateSunday = poItemsOnly(runQueue(new Date('2026-06-01T03:59:59Z')));
    expect(lateSunday.length).toBeGreaterThan(0);

    // Monday 2026-06-01 00:00:00 EDT — first second of the NEW week.
    // 2026-06-01T04:00:00Z
    const monday = poItemsOnly(runQueue(new Date('2026-06-01T04:00:00Z')));
    expect(monday).toHaveLength(0);
  });
});

describe('computeAttentionQueue.unconfirmed_po — in/out of window', () => {
  it('A missed-order row INSIDE the window is included', () => {
    // Same fixture: Wed afternoon. Mon 2026-05-25 has no submission →
    // INSIDE the [Mon 2026-05-25, today 2026-05-27) window → included.
    const items = poItemsOnly(runQueue(new Date('2026-05-27T14:00:00Z')));
    expect(items.map((i) => i.id)).toContain(`${STORE_ID}:po:vendor-v:2026-05-25`);
  });

  it('A missed-order row OUTSIDE the window is excluded — structural invariant', () => {
    // PRIOR week: Wed 2026-05-20 has no submission. Window for
    // now=2026-05-27 = [Mon 2026-05-25, Mon 2026-06-01).
    //
    // Refactored from a literal-id assertion (which was vacuously true —
    // `isoDateRange(mondayStart, nextMondayStart)` can never emit a date
    // outside the window by construction, so `not.toContain(prior_date)`
    // would have passed regardless of the filter). The structural
    // assertion below — "no emitted id has an ISO date earlier than
    // weekStart" — would FAIL if a future refactor accidentally widened
    // `pastISOsInWindow` to include prior-week dates.
    const items = poItemsOnly(runQueue(new Date('2026-05-27T14:00:00Z')));
    const weekStartISO = '2026-05-25';
    for (const item of items) {
      // id shape: `${STORE_ID}:po:vendor-v:${ISO_DATE}`
      const date = item.id.split(':').slice(-1)[0];
      expect(date >= weekStartISO).toBe(true);
    }
    // Plus the original literal check as a quick belt-and-suspenders.
    expect(items.map((i) => i.id)).not.toContain(`${STORE_ID}:po:vendor-v:2026-05-20`);
  });

  it('"Today" is excluded from the window even though it is in the current week (spec 074 today-exclusion)', () => {
    // Wednesday 2026-05-27 is TODAY. Vendor V is scheduled on Wednesday
    // and has no submission on that date. Despite being within the
    // Mon-Sun week window, today MUST NOT appear — a vendor order for
    // today may still be placed before EOD. This assertion would FAIL if
    // the `< todayISOInTz` filter in cmdSelectors.ts were removed.
    const items = poItemsOnly(runQueue(new Date('2026-05-27T14:00:00Z')));
    expect(items.map((i) => i.id)).not.toContain(`${STORE_ID}:po:vendor-v:2026-05-27`);
  });
});

describe('computeAttentionQueue.unconfirmed_po — timezone correctness', () => {
  it('UTC late-night Monday in NY still treats this week as starting on the NY Monday', () => {
    // 2026-05-26T03:00:00Z = 2026-05-25 23:00 EDT (Monday in NY)
    // For NY tz, weekStart = 2026-05-25, today = 2026-05-25 → no
    // past dates in window → 0 unconfirmed_po rows.
    const items = poItemsOnly(runQueue(new Date('2026-05-26T03:00:00Z'), 'America/New_York'));
    expect(items).toHaveLength(0);
  });
});
