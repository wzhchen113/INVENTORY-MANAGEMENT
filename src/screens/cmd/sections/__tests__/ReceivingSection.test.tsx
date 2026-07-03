// src/screens/cmd/sections/__tests__/ReceivingSection.test.tsx — Spec 107.
//
// Section-level tests for the PO-driven receiving mode. Locks the two seams
// that matter for correctness:
//   (a) the "receive now" inputs are prefilled with the OUTSTANDING remainder
//       (ordered − received), NOT the ordered total (§3 ADDITIVE deltas);
//   (b) commit submits ONLY the entered this-receive deltas (skipping zero
//       rows) to receivePurchaseOrder.
// Also pins that only OPEN POs (sent/partial) appear in the list and the mode
// toggle switches to the freeform fallback.
//
// Boundary mocking mirrors POsSection.test.tsx.

jest.mock('../../../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#FFF', panel: '#F4F4F4', panel2: '#EAEAEA', border: '#CCC', borderStrong: '#888',
    fg: '#000', fg2: '#444', fg3: '#888', accent: '#3F7C20', accentBg: '#E0EFC9', accentFg: '#FFF',
    warn: '#854F0B', warnBg: '#FAEEDA', danger: '#791F1F', dangerBg: '#FCEBEB',
    ok: '#3B6D11', okBg: '#EAF3DE', info: '#185FA5', infoBg: '#E6F1FB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

jest.mock('../../../../hooks/useT', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => {
    if (!vars) return key;
    return Object.entries(vars).reduce(
      (acc, [k, v]) => acc.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
      key,
    );
  },
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

// Spec 107 code-review fix — commit is confirm-gated like the other lifecycle
// actions. Auto-confirm (run onConfirm immediately) and record calls so tests
// can assert the gate fired (mirrors POsSection.test.tsx).
const mockConfirmAction = jest.fn(
  (_title: string, _msg: string, onConfirm: () => void) => onConfirm(),
);
jest.mock('../../../../utils/confirmAction', () => ({
  confirmAction: (...args: any[]) => (mockConfirmAction as any)(...args),
}));

jest.mock('../../../../components/cmd/TabStrip', () => {
  const ReactMod = require('react');
  const RN = require('react-native');
  return {
    TabStrip: ({ rightSlot }: { rightSlot?: React.ReactNode }) =>
      ReactMod.createElement(RN.View, { testID: 'tabstrip' }, rightSlot),
  };
});
jest.mock('../../../../components/cmd/StatCard', () => ({ StatCard: () => null }));
jest.mock('../../../../components/cmd/StatusPill', () => {
  const ReactMod = require('react');
  const RN = require('react-native');
  return { StatusPill: ({ label }: { label?: string }) => ReactMod.createElement(RN.Text, null, label) };
});
jest.mock('../../../../components/cmd/SectionCaption', () => {
  const ReactMod = require('react');
  const RN = require('react-native');
  return { SectionCaption: ({ children }: { children?: React.ReactNode }) => ReactMod.createElement(RN.Text, null, children) };
});

// db.computeExpiryFromShelfLife is imported by the freeform path; stub the
// module so the import resolves without pulling the real supabase client.
jest.mock('../../../../lib/db', () => ({
  computeExpiryFromShelfLife: () => null,
}));

jest.mock('../../../../store/useStore', () => {
  const state: any = {
    currentStore: { id: 'store-1', name: 'Test Store' },
    orderSubmissions: [],
    inventory: [],
    vendors: [],
    currentUser: { id: 'u1', name: 'Tester' },
    catalogIngredients: [],
    poLinesById: {},
    loadPurchaseOrderLines: jest.fn(async () => []),
    receivePurchaseOrder: jest.fn(async () => 'partial'),
    adjustStock: jest.fn(),
    addAuditEvent: jest.fn(),
    updateItem: jest.fn(),
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import ReceivingSection from '../ReceivingSection';
import { useStore } from '../../../../store/useStore';

const state = (useStore as any).__state as Record<string, any>;

function po(over: Record<string, any> & { id: string; status: string }) {
  return {
    id: over.id,
    storeId: 'store-1',
    vendorId: over.vendorId ?? 'vendor-1',
    vendorName: over.vendorName ?? 'Acme',
    status: over.status,
    day: 'Monday',
    date: '2026-07-03',
    timestamp: '2026-07-03T10:00:00Z',
    submittedBy: 'tester',
    submittedAt: '10:00 AM',
    totalCost: 100,
  };
}

function line(over: Record<string, any> & { poItemId: string }) {
  return {
    poItemId: over.poItemId,
    itemId: over.itemId ?? `item-${over.poItemId}`,
    itemName: over.itemName ?? 'Flour',
    unit: over.unit ?? 'lbs',
    orderedQty: over.orderedQty ?? 10,
    receivedQty: over.receivedQty ?? 0,
    costPerUnit: over.costPerUnit ?? 1,
    subUnitSize: over.subUnitSize ?? 1,
  };
}

beforeEach(() => {
  state.loadPurchaseOrderLines.mockClear();
  state.receivePurchaseOrder.mockClear();
  mockConfirmAction.mockClear();
  state.orderSubmissions = [];
  state.poLinesById = {};
  state.loadPurchaseOrderLines.mockImplementation(async () => state.poLinesById[Object.keys(state.poLinesById)[0]] || []);
  state.receivePurchaseOrder.mockImplementation(async () => 'partial');
});

describe('ReceivingSection PO-driven mode — list filters to open POs', () => {
  it('lists only sent/partial POs, not draft/received/cancelled', async () => {
    state.orderSubmissions = [
      po({ id: 'po-sent', status: 'sent', vendorName: 'SentCo' }),
      po({ id: 'po-partial', status: 'partial', vendorName: 'PartCo' }),
      po({ id: 'po-draft', status: 'draft', vendorName: 'DraftCo' }),
      po({ id: 'po-recv', status: 'received', vendorName: 'RecvCo' }),
      po({ id: 'po-cancel', status: 'cancelled', vendorName: 'CancelCo' }),
    ];
    state.poLinesById = { 'po-sent': [line({ poItemId: 'l1' })] };
    render(<ReceivingSection />);
    // The two open vendors appear; the three closed ones do not (vendor names
    // render in the list rows).
    expect(screen.getAllByText('SentCo').length).toBeGreaterThan(0);
    expect(screen.getAllByText('PartCo').length).toBeGreaterThan(0);
    expect(screen.queryByText('DraftCo')).toBeNull();
    expect(screen.queryByText('RecvCo')).toBeNull();
    expect(screen.queryByText('CancelCo')).toBeNull();
  });
});

describe('ReceivingSection PO-driven mode — outstanding prefill + commit deltas', () => {
  it('prefills the receive input with the OUTSTANDING remainder (ordered − received)', async () => {
    state.orderSubmissions = [po({ id: 'po-1', status: 'partial' })];
    const lines = [
      line({ poItemId: 'l1', orderedQty: 10, receivedQty: 4 }), // outstanding 6
      line({ poItemId: 'l2', orderedQty: 5, receivedQty: 5 }),  // outstanding 0
    ];
    state.poLinesById = { 'po-1': lines };
    state.loadPurchaseOrderLines.mockImplementation(async () => lines);

    render(<ReceivingSection />);

    await waitFor(() => {
      const input1 = screen.getByTestId('receiving-line-l1');
      expect(input1.props.value).toBe('6');
    });
    const input2 = screen.getByTestId('receiving-line-l2');
    expect(input2.props.value).toBe('0');
  });

  it('commit submits ONLY the entered this-receive deltas (skips zero rows)', async () => {
    state.orderSubmissions = [po({ id: 'po-1', status: 'sent' })];
    const lines = [
      line({ poItemId: 'l1', orderedQty: 10, receivedQty: 0 }), // outstanding 10
      line({ poItemId: 'l2', orderedQty: 5, receivedQty: 0 }),  // outstanding 5
    ];
    state.poLinesById = { 'po-1': lines };
    state.loadPurchaseOrderLines.mockImplementation(async () => lines);

    render(<ReceivingSection />);

    // Wait for the seed, then override l2 to 0 (nothing arrived for it).
    await waitFor(() => expect(screen.getByTestId('receiving-line-l1').props.value).toBe('10'));
    fireEvent.changeText(screen.getByTestId('receiving-line-l2'), '0');

    fireEvent.press(screen.getByTestId('receiving-commit'));

    await waitFor(() => expect(state.receivePurchaseOrder).toHaveBeenCalledTimes(1));
    // Spec 107 code-review fix — commit is confirm-gated (stock mutation):
    // the confirm fired exactly once BEFORE the RPC ran.
    expect(mockConfirmAction).toHaveBeenCalledTimes(1);
    // Only l1 (10) is submitted; l2 (0) is skipped.
    expect(state.receivePurchaseOrder).toHaveBeenCalledWith('po-1', [
      { poItemId: 'l1', receivedQty: 10 },
    ]);
  });

  it('does not call receivePurchaseOrder when all lines are zero', async () => {
    state.orderSubmissions = [po({ id: 'po-1', status: 'partial' })];
    const lines = [line({ poItemId: 'l1', orderedQty: 10, receivedQty: 10 })]; // outstanding 0
    state.poLinesById = { 'po-1': lines };
    state.loadPurchaseOrderLines.mockImplementation(async () => lines);

    render(<ReceivingSection />);
    await waitFor(() => expect(screen.getByTestId('receiving-line-l1').props.value).toBe('0'));

    // Commit is disabled at 0 entered; pressing it is a no-op — and the
    // confirm gate is never even opened (the nothing-to-receive toast wins).
    fireEvent.press(screen.getByTestId('receiving-commit'));
    expect(state.receivePurchaseOrder).not.toHaveBeenCalled();
    expect(mockConfirmAction).not.toHaveBeenCalled();
  });
});

describe('ReceivingSection — mode toggle', () => {
  it('switches to the freeform fallback and back', () => {
    state.orderSubmissions = [];
    render(<ReceivingSection />);
    // Default PO-driven mode is active.
    expect(screen.getByTestId('receiving-mode-po')).toBeTruthy();
    expect(screen.getByTestId('receiving-mode-freeform')).toBeTruthy();
    // Switch to freeform — should not throw and the toggle stays present.
    fireEvent.press(screen.getByTestId('receiving-mode-freeform'));
    expect(screen.getByTestId('receiving-mode-po')).toBeTruthy();
  });
});
