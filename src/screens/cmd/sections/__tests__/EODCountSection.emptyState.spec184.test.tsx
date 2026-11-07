// src/screens/cmd/sections/__tests__/EODCountSection.emptyState.spec184.test.tsx
//
// Spec 184: AC-22, AC-23, AC-24, N5, N6 on the desktop branch. The derivation itself
// is pinned row by row in src/lib/eodEmptyState.test.ts; this proves the screen
// shows the right message and controls for it, including the trap where
// `showUnscheduled` was never reset and left `+ vendor` stuck disabled.

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

jest.mock('../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      single: jest.fn(() => Promise.resolve({ data: null, error: null })),
      maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })),
    })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

jest.mock('../../../../lib/db', () =>
  new Proxy(
    { __esModule: true },
    {
      get: (target: Record<string, unknown>, prop: string) => {
        if (prop in target) return (target as any)[prop];
        return jest.fn(() => Promise.resolve(null));
      },
    },
  ),
);

let mockIsPhone = false;
jest.mock('../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../theme/breakpoints');
  return {
    ...actual,
    useIsPhone: () => mockIsPhone,
    useBreakpoint: () => (mockIsPhone ? 'phone' : 'desktop'),
  };
});

import EODCountSection from '../EODCountSection';
import { useStore } from '../../../../store/useStore';

const STOCKED = { id: 'store-stocked', brandId: 'b1', name: 'Towson', address: '', status: 'active' };
const EMPTY = { id: 'store-empty', brandId: 'b1', name: 'Kenyon', address: '', status: 'active' };
const VENDOR = { id: 'v1', brandId: 'b1', name: 'Sysco' };
const OTHER_VENDOR = { id: 'v2', brandId: 'b1', name: 'BJ' };

const ALL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const today = ALL_DAYS[new Date().getDay()];
const otherDay = ALL_DAYS[(new Date().getDay() + 1) % 7];

const item = (over: Record<string, unknown> = {}) => ({
  id: 'i1', name: 'Apple', storeId: STOCKED.id, category: 'Produce', unit: 'ea', caseQty: 1,
  parLevel: 0, currentStock: 0, vendorId: 'v1', vendorIds: ['v1'], ...over,
});

function seed(over: Record<string, unknown> = {}) {
  useStore.setState({
    currentStore: STOCKED as any,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    inventory: [],
    vendors: [VENDOR, OTHER_VENDOR] as any,
    eodSubmissions: [],
    orderSchedule: {},
    storeLoading: false,
    inventoryLoadStatus: 'loaded',
    ...over,
  } as any);
}

const message = () => screen.queryByTestId('eod-empty-message')?.props.children ?? null;
const toggle = () => screen.queryByTestId('eod-show-unscheduled');
const addVendorDisabled = () => {
  const b = screen.getByTestId('eod-add-vendor');
  return b.props.accessibilityState?.disabled === true;
};
const noFilterText = () => screen.queryByText('no items in this filter');
const pill = (name: string, count: number) => screen.queryByText(`${name} (${count})`);

async function mount() {
  render(<EODCountSection />);
  await act(async () => {});
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsPhone = false;
});

describe('AC-22 — exactly one reason, and the toggle only where it can help', () => {
  it('S1: no items says so, with no toggle, even with a schedule configured', async () => {
    seed({ orderSchedule: { [otherDay]: [{ vendorId: 'v1' }] } });
    await mount();
    expect(message()).toBe('this store has no items yet, so there is nothing to count');
    expect(toggle()).toBeNull();
    expect(addVendorDisabled()).toBe(false);
  });

  it('S1 with no schedule at all', async () => {
    seed();
    await mount();
    expect(message()).toBe('this store has no items yet, so there is nothing to count');
    expect(toggle()).toBeNull();
  });

  it('S2: items, none linked, says so, with no toggle', async () => {
    seed({
      inventory: [item({ vendorId: '', vendorIds: [] })],
      orderSchedule: { [today]: [{ vendorId: 'v1' }] },
    });
    await mount();
    expect(message()).toBe("items at this store have no vendor linked, so they can't be counted here");
    expect(toggle()).toBeNull();
  });

  it('S3: nothing scheduled that day keeps the existing message, and the toggle shows the tabs', async () => {
    seed({ inventory: [item()], orderSchedule: { [otherDay]: [{ vendorId: 'v1' }] } });
    await mount();
    expect(message()).toBe(`no vendors scheduled for ${today.toLowerCase()}`);
    expect(pill('SYSCO', 1)).toBeNull();

    fireEvent.press(toggle()!);
    await act(async () => {});
    expect(message()).toBeNull();
    expect(pill('SYSCO', 1)).toBeTruthy();
  });

  it('S4: scheduled vendors with no items here, and the toggle shows the tabs', async () => {
    seed({ inventory: [item()], orderSchedule: { [today]: [{ vendorId: 'v2' }] } });
    await mount();
    expect(message()).toBe(`vendors scheduled for ${today.toLowerCase()} have no items at this store`);
    expect(pill('SYSCO', 1)).toBeNull();

    fireEvent.press(toggle()!);
    await act(async () => {});
    expect(message()).toBeNull();
    expect(pill('SYSCO', 1)).toBeTruthy();
  });

  it('with tabs there is no message', async () => {
    seed({ inventory: [item()], orderSchedule: { [today]: [{ vendorId: 'v1' }] } });
    await mount();
    expect(message()).toBeNull();
    expect(pill('SYSCO', 1)).toBeTruthy();
    expect(toggle()).toBeTruthy();
  });

  it('linked items with an empty vendors slice do not read as "no vendor linked" (F-9)', async () => {
    seed({ inventory: [item()], vendors: [] });
    await mount();
    expect(message()).toBe('no vendors with items at this store');
    expect(toggle()).toBeNull();
  });
});

describe('AC-23 — some unlinked items is the prod norm, not S2', () => {
  it('shows the linked items in their tab with no message', async () => {
    seed({
      inventory: [
        item(),
        item({ id: 'i2', name: 'Unlinked', vendorId: '', vendorIds: [] }),
      ],
    });
    await mount();
    expect(message()).toBeNull();
    expect(pill('SYSCO', 1)).toBeTruthy();
    expect(screen.queryByText('Unlinked')).toBeNull();
  });
});

describe('N5 — a failed load never reads as "no items"', () => {
  it('failed: says the items could not load, not that there are none', async () => {
    seed({ inventoryLoadStatus: 'failed' });
    await mount();
    expect(message()).toBe('items for this store could not be loaded; reload to try again');
    expect(screen.queryByText('this store has no items yet, so there is nothing to count')).toBeNull();
    expect(toggle()).toBeNull();
  });

  it('unknown: no message at all', async () => {
    seed({ inventoryLoadStatus: 'unknown' });
    await mount();
    expect(message()).toBeNull();
  });

  it('reloading an empty store: no message at all', async () => {
    seed({ storeLoading: true, eodSubmissions: [{ id: 'x', storeId: 'elsewhere', date: '2020-01-01' }] });
    await mount();
    expect(message()).toBeNull();
  });
});

// Spec 184 OD-3 — the desktop button. The phone button is pinned in
// PhoneEodCount.test.tsx; both share the parent's onSubmit.
describe('OD-3 — SUBMIT COUNT is disabled when there is nothing to count', () => {
  const submitDisabled = () => screen.getByTestId('eod-submit-desktop').props.accessibilityState?.disabled === true;

  it('S1: no items', async () => {
    seed({ currentStore: EMPTY, orderSchedule: { [today]: [{ vendorId: 'v1' }] } });
    await mount();
    expect(submitDisabled()).toBe(true);
  });

  it('S2: items, none linked', async () => {
    seed({ inventory: [item({ vendorId: null, vendorIds: [] })] });
    await mount();
    expect(submitDisabled()).toBe(true);
  });

  it('a failed load', async () => {
    seed({ inventoryLoadStatus: 'failed' });
    await mount();
    expect(submitDisabled()).toBe(true);
  });

  it('stays enabled at a stocked store with tabs', async () => {
    seed({ inventory: [item()] });
    await mount();
    expect(submitDisabled()).toBe(false);
  });

  it('stays enabled when the day just has nothing scheduled (S3)', async () => {
    seed({ inventory: [item()], orderSchedule: { [otherDay]: [{ vendorId: 'v1' }] } });
    await mount();
    expect(message()).not.toBeNull();
    expect(submitDisabled()).toBe(false);
  });
});

describe('N6 — no conflicting second message', () => {
  it.each([
    ['S1', {}],
    ['S2', { inventory: [item({ vendorId: '', vendorIds: [] })] }],
    ['S3', { inventory: [item()], orderSchedule: { [otherDay]: [{ vendorId: 'v1' }] } }],
    ['S4', { inventory: [item()], orderSchedule: { [today]: [{ vendorId: 'v2' }] } }],
    ['failed', { inventoryLoadStatus: 'failed' }],
    ['vendors unresolved', { inventory: [item()], vendors: [] }],
  ])('%s: neither the column header nor "no items in this filter"', async (_label, over) => {
    seed(over);
    await mount();
    expect(noFilterText()).toBeNull();
    expect(screen.queryByText('item · pack')).toBeNull();
  });

  it('a search that hides every row at a stocked store still reads "no items in this filter"', async () => {
    seed({ inventory: [item()] });
    await mount();
    expect(screen.getByText('item · pack')).toBeTruthy();
    expect(screen.getByText('Apple')).toBeTruthy();
    expect(noFilterText()).toBeNull();

    fireEvent.changeText(screen.getByPlaceholderText('ingredient name…'), 'zzz');
    await act(async () => {});
    expect(screen.queryByText('Apple')).toBeNull();
    expect(noFilterText()).toBeTruthy();
    expect(screen.getByText('item · pack')).toBeTruthy();
    expect(message()).toBeNull();
  });
});

describe('AC-24 — the toggle cannot strand + vendor', () => {
  const stockedThenEmpty = {
    inventory: [item()],
    orderSchedule: { [otherDay]: [{ vendorId: 'v1' }] },
  };

  it('toggle on, then a store with no items: + vendor enabled, toggle hidden, S1 shown', async () => {
    seed(stockedThenEmpty);
    await mount();
    fireEvent.press(toggle()!);
    await act(async () => {});
    expect(addVendorDisabled()).toBe(true);

    await act(async () => { useStore.setState({ currentStore: EMPTY as any }); });
    expect(addVendorDisabled()).toBe(false);
    expect(toggle()).toBeNull();
    expect(message()).toBe('this store has no items yet, so there is nothing to count');
  });

  it('toggle on, then a store in S2: + vendor enabled, toggle hidden', async () => {
    seed({
      ...stockedThenEmpty,
      inventory: [item(), item({ id: 'i2', storeId: EMPTY.id, vendorId: '', vendorIds: [] })],
    });
    await mount();
    fireEvent.press(toggle()!);
    await act(async () => {});

    await act(async () => { useStore.setState({ currentStore: EMPTY as any }); });
    expect(addVendorDisabled()).toBe(false);
    expect(toggle()).toBeNull();
    expect(message()).toBe("items at this store have no vendor linked, so they can't be counted here");
  });

  it('coming back to the stocked store finds the toggle reset to off', async () => {
    seed(stockedThenEmpty);
    await mount();
    fireEvent.press(toggle()!);
    await act(async () => {});

    await act(async () => { useStore.setState({ currentStore: EMPTY as any }); });
    await act(async () => { useStore.setState({ currentStore: STOCKED as any }); });

    expect(toggle()!.props.accessibilityState.selected).toBe(false);
    expect(addVendorDisabled()).toBe(false);
    expect(message()).toBe(`no vendors scheduled for ${today.toLowerCase()}`);
    expect(pill('SYSCO', 1)).toBeNull();
  });

  it('a same-store change that removes every item cannot strand it either', async () => {
    seed(stockedThenEmpty);
    await mount();
    fireEvent.press(toggle()!);
    await act(async () => {});
    expect(addVendorDisabled()).toBe(true);

    await act(async () => { useStore.setState({ inventory: [] }); });
    expect(addVendorDisabled()).toBe(false);
    expect(toggle()).toBeNull();
    expect(message()).toBe('this store has no items yet, so there is nothing to count');
  });
});

// The leaf is covered in PhoneEodCount.test.tsx. This proves the section passes the
// state down, since `eodEmptyState` is optional and typecheck wouldn't catch a miss.
describe('AC-26 — the section hands the state to the phone branch', () => {
  beforeEach(() => { mockIsPhone = true; });

  it('S1', async () => {
    seed();
    await mount();
    expect(message()).toBe('this store has no items yet, so there is nothing to count');
  });

  it('S2', async () => {
    seed({ inventory: [item({ vendorId: '', vendorIds: [] })] });
    await mount();
    expect(message()).toBe("items at this store have no vendor linked, so they can't be counted here");
  });

  it('a failed load', async () => {
    seed({ inventoryLoadStatus: 'failed' });
    await mount();
    expect(message()).toBe('items for this store could not be loaded; reload to try again');
  });
});
