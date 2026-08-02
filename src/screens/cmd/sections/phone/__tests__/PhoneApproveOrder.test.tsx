// src/screens/cmd/sections/phone/__tests__/PhoneApproveOrder.test.tsx
//
// Spec 149 (AC-28, jest track) — the phone Approve Order review screen:
//   • renders the SERVER-computed lines from `report_reorder_list` (AC-8) with
//     the reused spec-143 case stepper writing BASE units through
//     `setReorderEditQty`, clamped ≥ 0 (AC-9);
//   • the per-channel fee/markup disclosure copy (AC-10) as a first-class block
//     above the ONE primary button (AC-11);
//   • the stale / empty / already-approved / already-ordered states (AC-13),
//     each with a distinct banner and a disabled-or-relabeled primary;
//   • the cross-store interstitial (§8 / risk 9);
//   • dismiss → consume() → the phone returns to PhoneOrdering.
//
// Uses the REAL store slices + the REAL reorder helpers so the derived
// quantities match production; only `db` is stubbed.

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

jest.mock('../../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({ select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), order: jest.fn().mockReturnThis(), single: jest.fn(() => Promise.resolve({ data: null, error: null })), maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })) })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

jest.mock('../../../../../lib/db', () =>
  new Proxy({ __esModule: true }, { get: (t: Record<string, unknown>, p: string) => (p in t ? (t as any)[p] : jest.fn(() => Promise.resolve(null))) }),
);

jest.mock('../../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../../theme/breakpoints');
  return { ...actual, useIsPhone: () => true, useIsTablet: () => false, useIsDesktop: () => false, useIsCompact: () => true, useBreakpoint: () => 'phone' };
});

import {
  PhoneApproveOrder,
  approveOrderState,
  disclosureKeyForChannel,
} from '../PhoneApproveOrder';
import { useStore } from '../../../../../store/useStore';
import { usePaletteAction } from '../../../../../lib/paletteAction';

const REQUEST = { submissionId: 'sub-1', storeId: 'store-1' };
const DATE = '2026-08-01';

function item(over: Record<string, any> = {}): any {
  return {
    itemId: 'a1', itemName: 'French Fries', unit: 'lbs',
    onHand: 0, pendingPoQty: 0, parLevel: 100, usageForecasted: 0, parReplacement: 0,
    suggestedQty: 20, costPerUnit: 3, estimatedCost: 60, caseQty: 5,
    suggestedCases: 4, suggestedUnits: 20, flags: [], ...over,
  };
}

function vendorRow(over: Record<string, any> = {}): any {
  return {
    vendorId: 'v-a', vendorName: 'Counted Co', scheduleKnown: true,
    nextDeliveryDate: DATE, daysUntilNextDelivery: 1, onHandSource: 'eod',
    eodSubmittedAt: `${DATE}T18:00:00Z`, items: [item()], vendorTotalCost: 60, ...over,
  };
}

function seed(over: Record<string, any> = {}) {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'Frederick', address: '', status: 'active' } as any,
    stores: [
      { id: 'store-1', name: 'Frederick' } as any,
      { id: 'store-2', name: 'Towson' } as any,
    ],
    reorderPayload: {
      asOfDate: DATE,
      vendors: [vendorRow()],
      kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 60, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    } as any,
    reorderLoading: false,
    reorderError: null,
    reorderEdits: {},
    inventory: [{ id: 'a1', subUnitSize: 1 } as any],
    vendors: [{ id: 'v-a', extensionOrdering: true, orderUnit: 'case' } as any],
    submissionNotifications: [
      { id: 'n1', brandId: 'b', storeId: 'store-1', actorUserId: null, actorName: 'Cook', storeName: 'Frederick', type: 'order_ready', sourceId: 'sub-1', body: 'Counted Co', createdAt: `${DATE}T19:00:00Z`, read: false } as any,
    ],
    // The deep link is pre-resolved (loadOrderApproval is exercised in the
    // store suite); this screen suite drives the RENDER off the resolved slice.
    approvalContext: { submissionId: 'sub-1', storeId: 'store-1', vendorId: 'v-a', businessDate: DATE },
    approval: null,
    approvalLoading: false,
    approvalError: null,
    approvalBusy: false,
    loadOrderApproval: (async () => {}) as any,
    loadReorderSuggestions: (async () => {}) as any,
    approveAndOrder: (async () => null) as any,
    markOrderApprovalOrdered: (async () => {}) as any,
    ...over,
  } as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  usePaletteAction.setState({ pending: null });
  seed();
});

// ── Pure helpers ────────────────────────────────────────────────────────────
describe('approveOrderState — AC-13 stale/empty/actioned precedence', () => {
  const base = {
    hasOrderableLines: true,
    approvalStatus: null,
    eodSubmittedAt: null,
    notificationCreatedAt: null,
  } as const;

  it('ready when there are lines and nothing is actioned', () => {
    expect(approveOrderState({ ...base })).toBe('ready');
  });

  it('ordered and approved are the most terminal states', () => {
    expect(approveOrderState({ ...base, approvalStatus: 'ordered' })).toBe('ordered');
    expect(approveOrderState({ ...base, approvalStatus: 'approved' })).toBe('approved');
    // Terminal even when the suggestion set went empty underneath.
    expect(approveOrderState({ ...base, hasOrderableLines: false, approvalStatus: 'ordered' })).toBe('ordered');
  });

  it('empty when the vendor carries no orderable line', () => {
    expect(approveOrderState({ ...base, hasOrderableLines: false })).toBe('empty');
  });

  it('countChanged when the count was re-submitted AFTER the notification', () => {
    expect(
      approveOrderState({
        ...base,
        eodSubmittedAt: '2026-08-01T20:00:00Z',
        notificationCreatedAt: '2026-08-01T19:00:00Z',
      }),
    ).toBe('countChanged');
  });

  it('stays ready when the count predates the notification', () => {
    expect(
      approveOrderState({
        ...base,
        eodSubmittedAt: '2026-08-01T18:00:00Z',
        notificationCreatedAt: '2026-08-01T19:00:00Z',
      }),
    ).toBe('ready');
  });
});

describe('disclosureKeyForChannel — AC-10', () => {
  it('only the instacart channel gets the markup + fees copy', () => {
    expect(disclosureKeyForChannel('instacart')).toBe('section.approveOrder.disclosureInstacart');
    for (const c of ['webstaurant', 'extension', 'manual'] as const) {
      expect(disclosureKeyForChannel(c)).toBe('section.approveOrder.disclosureCatalog');
    }
  });
});

// ── Screen ──────────────────────────────────────────────────────────────────
describe('PhoneApproveOrder — render + primary action', () => {
  it('renders the vendor, the server line, and the totals line', () => {
    const { getByTestId, getByText } = render(<PhoneApproveOrder request={REQUEST} />);
    expect(getByTestId('phone-approve-order')).toBeTruthy();
    expect(getByText('Counted Co')).toBeTruthy();
    expect(getByText('French Fries')).toBeTruthy();
    // 20 base units / caseQty 5 = 4 CS; est $60.
    // The totals line also names the destination channel (here: the cart-filler).
    expect(getByTestId('phone-approve-totals')).toHaveTextContent(
      '1 LINES · 4 CS · EST $60.00  ·  orders via Cart-filler',
    );
    expect(getByTestId('phone-approve-subtitle')).toHaveTextContent(`Counted Co · ${DATE}`);
  });

  it('reuses the spec-143 stepper: writes BASE units, clamped ≥ 0 (AC-9)', () => {
    const { getByTestId } = render(<PhoneApproveOrder request={REQUEST} />);
    fireEvent.press(getByTestId('phone-order-step-a1-inc'));
    expect(useStore.getState().reorderEdits['v-a']?.a1).toBe(25);
    for (let i = 0; i < 6; i++) fireEvent.press(getByTestId('phone-order-step-a1-dec'));
    expect(useStore.getState().reorderEdits['v-a']?.a1).toBe(0);
  });

  it('renders exactly ONE primary button and no FILL CART competitor (AC-11)', () => {
    const { getByTestId, queryByTestId } = render(<PhoneApproveOrder request={REQUEST} />);
    expect(getByTestId('phone-approve-primary')).toHaveTextContent('APPROVE & ORDER');
    // footer='none' suppresses PhoneOrdering's own primary + overflow.
    expect(queryByTestId('phone-order-fill-cart-v-a')).toBeNull();
    expect(queryByTestId('phone-order-more-v-a')).toBeNull();
  });

  it('shows the CATALOG-cost disclosure for a cart-filler vendor (AC-10)', () => {
    const { getByTestId } = render(<PhoneApproveOrder request={REQUEST} />);
    expect(getByTestId('phone-approve-disclosure')).toHaveTextContent(
      'Estimate is your catalog cost.',
    );
  });

  it('shows the Instacart markup + fees disclosure for an instacart vendor (AC-10)', () => {
    seed({
      vendors: [
        { id: 'v-a', extensionOrdering: false, orderUnit: 'case', orderChannel: 'instacart', instacartRetailerKey: 'sams_club' } as any,
      ],
    });
    const { getByTestId } = render(<PhoneApproveOrder request={REQUEST} />);
    expect(getByTestId('phone-approve-disclosure')).toHaveTextContent(
      'Estimate is your catalog cost — not the Instacart price. Instacart pricing ' +
        'can exceed in-club pricing, and delivery/service fees apply.',
    );
  });

  it('an instacart-flagged vendor with NO retailer key still discloses catalog cost (R-3)', () => {
    // Same precedence as resolveOrderChannel: it actually orders via the
    // cart-filler, so the Instacart fee copy would be a lie.
    seed({
      vendors: [
        { id: 'v-a', extensionOrdering: true, orderUnit: 'case', orderChannel: 'instacart', instacartRetailerKey: null } as any,
      ],
    });
    const { getByTestId } = render(<PhoneApproveOrder request={REQUEST} />);
    expect(getByTestId('phone-approve-disclosure')).toHaveTextContent('Estimate is your catalog cost.');
  });

  it('APPROVE & ORDER calls the store action with the overlaid vendor', () => {
    const approve = jest.fn(async (_v: any) => ({ channel: 'extension' as const }));
    seed({ approveAndOrder: approve });
    const { getByTestId } = render(<PhoneApproveOrder request={REQUEST} />);
    fireEvent.press(getByTestId('phone-approve-primary'));
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0][0]).toMatchObject({ vendorId: 'v-a' });
  });

  it('dismiss consumes the palette action so the phone returns to Ordering', () => {
    usePaletteAction.getState().request({
      section: 'Ordering', selectedName: null, orderApproval: REQUEST,
    });
    const { getByTestId } = render(<PhoneApproveOrder request={REQUEST} />);
    fireEvent.press(getByTestId('phone-approve-dismiss'));
    expect(usePaletteAction.getState().pending).toBeNull();
  });
});

describe('PhoneApproveOrder — AC-13 states', () => {
  it('EMPTY: says so and disables the primary', () => {
    seed({
      reorderPayload: {
        asOfDate: DATE,
        vendors: [vendorRow({ items: [item({ suggestedUnits: 0, estimatedCost: 0 })] })],
        kpis: {} as any,
        warnings: [],
      } as any,
    });
    const { getByTestId } = render(<PhoneApproveOrder request={REQUEST} />);
    expect(getByTestId('phone-approve-empty')).toBeTruthy();
    expect(getByTestId('phone-approve-primary').props.accessibilityState.disabled).toBe(true);
  });

  it('VENDOR ABSENT from the payload also reads as empty', () => {
    seed({ reorderPayload: { asOfDate: DATE, vendors: [], kpis: {} as any, warnings: [] } as any });
    const { getByTestId } = render(<PhoneApproveOrder request={REQUEST} />);
    expect(getByTestId('phone-approve-empty')).toBeTruthy();
  });

  it('COUNT CHANGED: warns and disables the primary rather than approving stale lines', () => {
    seed({
      reorderPayload: {
        asOfDate: DATE,
        vendors: [vendorRow({ eodSubmittedAt: `${DATE}T21:00:00Z` })], // after the 19:00 ping
        kpis: {} as any,
        warnings: [],
      } as any,
    });
    const { getByTestId } = render(<PhoneApproveOrder request={REQUEST} />);
    expect(getByTestId('phone-approve-count-changed')).toBeTruthy();
    expect(getByTestId('phone-approve-primary').props.accessibilityState.disabled).toBe(true);
  });

  it('ALREADY APPROVED: primary becomes MARK ORDERED and RE-OPEN LINK appears', () => {
    const markOrdered = jest.fn(async () => {});
    seed({
      approval: {
        id: 'ap-1', storeId: 'store-1', vendorId: 'v-a', businessDate: DATE,
        approvedBy: 'u', approvedAt: 'x', channel: 'instacart', status: 'approved',
        lines: [], lineCount: 1, estTotalCost: 60,
        externalRef: 'https://instacart.example/c/1', externalRefExpiresAt: null,
        orderedAt: null, sourceSubmissionId: 'sub-1',
      } as any,
      markOrderApprovalOrdered: markOrdered,
    });
    const { getByTestId } = render(<PhoneApproveOrder request={REQUEST} />);
    expect(getByTestId('phone-approve-already-approved')).toBeTruthy();
    expect(getByTestId('phone-approve-primary')).toHaveTextContent('MARK ORDERED');
    expect(getByTestId('phone-approve-reopen-link')).toBeTruthy();
    fireEvent.press(getByTestId('phone-approve-primary'));
    expect(markOrdered).toHaveBeenCalledTimes(1);
  });

  it('ALREADY ORDERED: no primary at all — it never silently re-approves', () => {
    seed({
      approval: {
        id: 'ap-1', storeId: 'store-1', vendorId: 'v-a', businessDate: DATE,
        approvedBy: 'u', approvedAt: 'x', channel: 'extension', status: 'ordered',
        lines: [], lineCount: 1, estTotalCost: 60, externalRef: null,
        externalRefExpiresAt: null, orderedAt: 'y', sourceSubmissionId: 'sub-1',
      } as any,
    });
    const { getByTestId, queryByTestId } = render(<PhoneApproveOrder request={REQUEST} />);
    expect(getByTestId('phone-approve-already-ordered')).toBeTruthy();
    expect(queryByTestId('phone-approve-primary')).toBeNull();
    expect(getByTestId('phone-approve-dismiss')).toBeTruthy();
  });

  it('CROSS-STORE: renders the switch interstitial instead of another store data', () => {
    seed({
      approvalContext: { submissionId: 'sub-1', storeId: 'store-2', vendorId: 'v-a', businessDate: DATE },
    });
    const { getByTestId, queryByTestId } = render(<PhoneApproveOrder request={REQUEST} />);
    expect(getByTestId('phone-approve-switch-store')).toBeTruthy();
    expect(getByTestId('phone-approve-switch-store-cta')).toHaveTextContent('SWITCH TO Towson');
    // No approve affordance while the wrong store is focused.
    expect(queryByTestId('phone-approve-primary')).toBeNull();
  });

  it('LOAD ERROR renders an in-screen pane, not a silent blank', () => {
    seed({ approvalError: 'permission denied', approvalContext: null });
    const { getByTestId } = render(<PhoneApproveOrder request={REQUEST} />);
    expect(getByTestId('phone-approve-error')).toBeTruthy();
  });
});
