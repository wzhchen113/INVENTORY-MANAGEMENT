// src/lib/cmdSelectors.eodAndStreak.test.ts — Spec 076.
//
// Locks the tz-aware derivation of `todayISO` / `yesterdayISO` (eod_missing
// rule) and `startSevenISO` (food_cost_streak rule) in
// `computeAttentionQueue`. Sibling file to
// `cmdSelectors.unconfirmedPoWindow.test.ts` (spec 074) which is
// intentionally byte-untouched per spec 076 AC #9.
//
// Canonical regression instant: `new Date('2026-05-26T03:00:00Z')` =
// Mon 2026-05-25 23:00 EDT (NY) / Tue 2026-05-26 03:00 UTC. At this
// instant pre-fix derives `todayISO = '2026-05-26'` (UTC date) and
// post-fix derives `todayISO = '2026-05-25'` (NY-local date). Every
// non-baseline test below would have failed pre-fix.
//
// Every test pins `now: Date` and `timezone: string` explicitly via the
// selector args — no `Date.now()` dependency, no `jest.useFakeTimers()`.

// Stub `./supabase` because `cmdSelectors.ts` transitively imports
// `useStore` → `db.ts` → `supabase.ts`, which calls `createClient()`
// at module-load time and crashes without `EXPO_PUBLIC_SUPABASE_URL`.
// Mirrors the spec 074 sibling file (`cmdSelectors.unconfirmedPoWindow.test.ts`).
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
  InventoryItem, EODSubmission, EODEntry, POSImport, OrderSubmission,
  OrderSchedule, Store, ItemStatus,
} from '../types';

// ── Fixture helpers ────────────────────────────────────────────
const STORE_ID = 'store-1';
const TZ = 'America/New_York';

const baseStore: Store = {
  id: STORE_ID,
  brandId: 'brand-1',
  name: 'Test Store',
  address: '',
  status: 'active',
};

// `getItemStatus` always returns 'ok' so the low_out_stock rule stays
// silent and we can isolate eod_missing / food_cost_streak assertions.
const getItemStatus: (i: InventoryItem) => ItemStatus = () => 'ok';

// Empty schedules / submissions so `unconfirmed_po` doesn't fire and
// pollute the assertions.
const orderSchedule: OrderSchedule = {};
const orderSubmissions: OrderSubmission[] = [];

// Helper for fixturing EOD submissions. The shape mirrors what
// `loadFromSupabase` produces — entries[] populated, vendor partition
// per spec 020. `vendorId` is required on EODSubmission; the rule
// doesn't read it so any string works.
function makeEodSubmission(
  date: string,
  entries: Partial<EODEntry>[] = [],
): EODSubmission {
  return {
    id: `eod-${date}`,
    date,
    storeId: STORE_ID,
    storeName: 'Test Store',
    vendorId: 'vendor-x',
    submittedBy: 'user-1',
    submittedByUserId: 'user-1',
    timestamp: `${date}T20:00:00Z`,
    itemCount: entries.length,
    status: 'submitted',
    entries: entries.map((e, i) => ({
      id: `entry-${date}-${i}`,
      itemId: e.itemId ?? `item-${i}`,
      itemName: e.itemName ?? `Item ${i}`,
      actualRemaining: e.actualRemaining ?? 0,
      unit: e.unit ?? 'unit',
      submittedBy: 'user-1',
      submittedByUserId: 'user-1',
      timestamp: `${date}T20:00:00Z`,
      date,
      storeId: STORE_ID,
      notes: '',
    })),
  };
}

function runQueue(
  now: Date,
  opts: {
    eodSubmissions?: EODSubmission[];
    inventory?: InventoryItem[];
    posImports?: POSImport[];
    stores?: Store[];
    tz?: string;
  } = {},
) {
  return computeAttentionQueue(
    STORE_ID,
    opts.inventory ?? [],
    opts.eodSubmissions ?? [],
    opts.posImports ?? [],
    orderSubmissions,
    orderSchedule,
    opts.stores ?? [baseStore],
    getItemStatus,
    opts.tz ?? TZ,
    now,
  );
}

function eodItem(items: ReturnType<typeof runQueue>) {
  return items.find((i) => i.rule === 'eod_missing');
}

function fcStreakItem(items: ReturnType<typeof runQueue>) {
  return items.find((i) => i.rule === 'food_cost_streak');
}

// ── Test 1: agreement-day baseline ─────────────────────────────
describe('computeAttentionQueue.eod_missing — tz-aware (spec 076)', () => {
  it('agreement-day baseline: UTC and NY agree at 04:00 UTC on Tuesday', () => {
    // 2026-05-26T04:00:00Z = 2026-05-26 00:00 EDT. Both UTC and NY say
    // Tuesday 2026-05-26. Pre-fix and post-fix produce the same answer
    // — acts as a sanity floor: a passing assertion here proves the
    // post-fix derivation is no-op-equivalent when UTC and tz agree.
    const now = new Date('2026-05-26T04:00:00Z');
    // EOD submitted for '2026-05-25' (Mon) but NOT '2026-05-26' (Tue).
    const items = runQueue(now, {
      eodSubmissions: [makeEodSubmission('2026-05-25')],
    });
    const eod = eodItem(items);
    expect(eod).toBeDefined();
    expect(eod!.id).toBe(`${STORE_ID}:eod:2026-05-26`);
  });

  // ── Test 2: cross-boundary divergence — canonical regression ──
  it('canonical regression: at Mon 23:00 ET (Tue 03:00 UTC), todayISO resolves to NY Monday', () => {
    // 2026-05-26T03:00:00Z = 2026-05-25 23:00 EDT — Monday night NY,
    // already Tuesday UTC. Pre-fix: todayISO = '2026-05-26',
    // yesterdayISO = '2026-05-25' (UTC-driven). Post-fix: todayISO =
    // '2026-05-25', yesterdayISO = '2026-05-24' (tz-driven).
    //
    // Fixture: EOD submitted for '2026-05-24' (Sun ET) but NOT
    // '2026-05-25' (Mon ET). Post-fix sees no submission for the
    // resolved today ('2026-05-25') AND a submission for the resolved
    // yesterday ('2026-05-24'), so it emits 'EOD not yet submitted
    // today' with id ':eod:2026-05-25'. Pre-fix would have asked
    // about '2026-05-26' / '2026-05-25' (the wrong dates for the
    // operator's wall clock).
    const now = new Date('2026-05-26T03:00:00Z');
    const items = runQueue(now, {
      eodSubmissions: [makeEodSubmission('2026-05-24')],
    });
    const eod = eodItem(items);
    expect(eod).toBeDefined();
    expect(eod!.id).toBe(`${STORE_ID}:eod:2026-05-25`);
    // Severity is 'med' here because no eodDeadlineTime is set on the
    // store fixture (isPastDeadline short-circuits to false).
    expect(eod!.sev).toBe('med');
    expect(eod!.text).toBe('EOD not yet submitted today');
  });

  // ── Test 3: yesterday-fallback "2 days running" copy ──────────
  it('"2 days running" copy uses NY yesterday at the UTC-skew instant', () => {
    // Same instant: 2026-05-26T03:00:00Z = Mon 23:00 EDT.
    // Fixture: NO EOD submissions for either '2026-05-24' (Sun ET) or
    // '2026-05-25' (Mon ET).
    // Pre-fix: looks at '2026-05-26' (missing) and '2026-05-25'
    // (missing) — emits "EOD missing 2 days running" with id
    // ':eod:2026-05-26'.
    // Post-fix: looks at '2026-05-25' (missing) and '2026-05-24'
    // (missing) — emits same copy with id ':eod:2026-05-25'.
    // The text is identical; the id and the internally-queried
    // dates differ.
    const now = new Date('2026-05-26T03:00:00Z');
    const items = runQueue(now, {
      eodSubmissions: [],
    });
    const eod = eodItem(items);
    expect(eod).toBeDefined();
    expect(eod!.id).toBe(`${STORE_ID}:eod:2026-05-25`);
    expect(eod!.sev).toBe('low');
    expect(eod!.text).toBe('EOD missing 2 days running');
  });
});

// ── Test 4: food_cost_streak rolling-7d window ────────────────
describe('computeAttentionQueue.food_cost_streak — tz-aware (spec 076)', () => {
  it('7d window ends on NY "today" at the UTC-skew instant', () => {
    // Instant: 2026-05-26T03:00:00Z = Mon 23:00 EDT. Post-fix window
    // should be [2026-05-19, 2026-05-25] (Tue→Mon, 7 days inclusive).
    // Pre-fix would be [2026-05-20, 2026-05-26].
    //
    // To assert the window deterministically without re-implementing
    // computeStoreFoodCostVariancePp here, we exploit its public
    // contract: it returns one number per day in [startDate, endDate]
    // inclusive, walking dates UTC-internally. We seed an inventory +
    // EOD pair such that variance pp >= 1 for the five NY-local days
    // [2026-05-21..2026-05-25] and exits the streak (< 1) for
    // 2026-05-20 and earlier. The streak walks backward from end-of-
    // window: post-fix end = 2026-05-25 → walks 5/25, 5/24, 5/23,
    // 5/22, 5/21 = 5 days, then breaks at 5/20. Streak === 5 → 'high'.
    //
    // The streak-shape fixture mirrors the spec 076 design §5 Test 4
    // outline. Inventory item with $1/unit cost; daily revenue $100;
    // daily depletion of $40/unit (one each per matching priors).
    // Day's actualPct = (40 / 100) * 100 = 40%. Target = 30%. variance
    // pp = 10. Far above >= 1.
    //
    // Days outside the streak: no prior submission → no depletion
    // → cogs = 0 → variance pp = -30 (way below 1). Streak breaks.
    const inventory: InventoryItem[] = [{
      id: 'item-1',
      catalogId: 'cat-1',
      name: 'Cheese',
      category: 'Dairy',
      unit: 'kg',
      costPerUnit: 1,
      currentStock: 1000,
      parLevel: 0,
      averageDailyUsage: 0,
      safetyStock: 0,
      vendorId: 'vendor-x',
      vendorName: 'Vendor X',
      usagePerPortion: 0,
      lastUpdatedBy: 'user-1',
      lastUpdatedAt: '2026-05-25T20:00:00Z',
      eodRemaining: 0,
      storeId: STORE_ID,
      casePrice: 0,
      caseQty: 0,
      subUnitSize: 0,
      subUnitUnit: '',
    }];
    // Build EOD subs for 2026-05-20..2026-05-25 with a strict 40-unit
    // depletion per day. Prior day's actualRemaining starts at 1000;
    // day N's actualRemaining = 1000 - 40 * (N - 20). That gives a
    // 40-unit depletion vs prior, every day. The streak should pick
    // up 5/21..5/25 (5 days where there's a prior). 5/20 has no prior
    // submission → variance pp = -30 → streak breaks.
    const dailyEod = (date: string, remaining: number) =>
      makeEodSubmission(date, [{
        itemId: 'item-1',
        itemName: 'Cheese',
        actualRemaining: remaining,
        unit: 'kg',
      }]);
    const eodSubmissions: EODSubmission[] = [
      dailyEod('2026-05-20', 1000),
      dailyEod('2026-05-21',  960),
      dailyEod('2026-05-22',  920),
      dailyEod('2026-05-23',  880),
      dailyEod('2026-05-24',  840),
      dailyEod('2026-05-25',  800),
    ];
    // POS revenue: $100/day from 2026-05-20..2026-05-25.
    const posImports: POSImport[] = ['2026-05-20', '2026-05-21', '2026-05-22',
                                     '2026-05-23', '2026-05-24', '2026-05-25']
      .map((date) => ({
        id: `pos-${date}`,
        filename: `pos-${date}.csv`,
        importedAt: `${date}T22:00:00Z`,
        importedBy: 'user-1',
        date,
        storeId: STORE_ID,
        items: [{
          menuItem: 'Burger',
          qtySold: 1,
          revenue: 100,
          recipeMapped: false,
        }],
      }));
    const now = new Date('2026-05-26T03:00:00Z');
    const items = runQueue(now, { inventory, eodSubmissions, posImports });
    const streak = fcStreakItem(items);
    expect(streak).toBeDefined();
    expect(streak!.sev).toBe('high');
    expect(streak!.text).toBe('Food cost over target 5 days running');
    expect(streak!.id).toBe(`${STORE_ID}:fc_streak:5`);
  });
});

// ── Test 5: cross-rule structural anchor agreement ────────────
describe('computeAttentionQueue — all three rules anchor on the same local-tz date', () => {
  it('canonical instant: eod_missing anchors on the NY-local Monday calendar date', () => {
    // Structural assertion: at the canonical regression instant, the
    // rule that emits a date in its ID must align with the NY-local
    // Monday calendar date '2026-05-25', NOT the UTC '2026-05-26'.
    //
    // Scope note (post-review fix-pass): an earlier draft of this test
    // also asserted `unconfirmed_po.length === 0`, but that assertion
    // was vacuous — the fixture's `orderSchedule` is empty (line 61),
    // so `unconfirmed_po` would have produced 0 rows regardless of
    // whether the tz window was empty. Dropped per the code-reviewer's
    // recommendation: `unconfirmed_po`'s tz-aware behavior is covered
    // by the spec-074 sibling file `cmdSelectors.unconfirmedPoWindow.
    // test.ts` (byte-untouched per AC #9), which carries the
    // schedule-driven fixture. Keep this test focused on eod_missing's
    // anchor — that IS load-bearing here (pre-fix UTC code produces
    // ':eod:2026-05-26' and fails the assertion).
    const now = new Date('2026-05-26T03:00:00Z');
    const items = runQueue(now, { eodSubmissions: [] });
    const eod = eodItem(items);
    expect(eod).toBeDefined();
    expect(eod!.id).toBe(`${STORE_ID}:eod:2026-05-25`);
  });
});

// ── Test 6 (architect-optional): isPastDeadline receives raw `now` ───
describe('computeAttentionQueue.eod_missing — isPastDeadline invariant (spec 076 §3)', () => {
  it('receives the raw `now: Date`, not a tz-shifted Date', () => {
    // Canonical instant: 2026-05-26T03:00:00Z. In CI process tz (UTC),
    // `now.getHours() === 3`. With a deadline of '02:00', `setHours(2, 0)`
    // produces `2026-05-26T02:00:00Z`. Compare 03:00 > 02:00 → past
    // deadline → 'high' severity branch fires.
    //
    // If a future refactor accidentally tz-shifts the Date passed to
    // isPastDeadline (e.g. anchored to the local ISO date via
    // `new Date(getLocalDateISO(tz, now))`), the shifted Date would
    // be `2026-05-25T00:00:00Z` (UTC midnight). `setHours(2, 0)` →
    // `2026-05-25T02:00:00Z`. Compare 00:00 vs 02:00 → not past →
    // 'med' branch fires. This test would then fail loudly because
    // the assertions below pin 'high' + deadline-text.
    //
    // Note: deadline value chosen so the boolean output discriminates
    // under the CI process tz (UTC). The architect's spec §5 example
    // used '22:00' assuming process-local NY tz; for tz-independent
    // determinism we pick '02:00' here.
    const storeWithDeadline: Store = { ...baseStore, eodDeadlineTime: '02:00' };
    const now = new Date('2026-05-26T03:00:00Z');
    // Fixture: yesterdaySub ('2026-05-24') exists; todaySub
    // ('2026-05-25') missing. Path falls through to the
    // `isPastDeadline(now, ...)` check.
    const items = runQueue(now, {
      eodSubmissions: [makeEodSubmission('2026-05-24')],
      stores: [storeWithDeadline],
    });
    const eod = eodItem(items);
    expect(eod).toBeDefined();
    expect(eod!.sev).toBe('high');
    expect(eod!.text).toBe('EOD missing past 02:00 deadline');
    expect(eod!.id).toBe(`${STORE_ID}:eod:2026-05-25`);
  });
});
