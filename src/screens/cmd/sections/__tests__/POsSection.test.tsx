// src/screens/cmd/sections/__tests__/POsSection.test.tsx — Spec 107.
//
// Section-level tests for the PO lifecycle rework. Locks the seams that pure
// tests can't reach: which lifecycle action buttons render per status, that
// "send to vendor" only appears when the vendor has an email (and otherwise the
// no-email hint + manual mark-as-sent show), and that each action is
// confirm-gated before it calls the store.
//
// Boundary mocking mirrors StoresTab.toggle.test.tsx: mock useCmdColors, useT
// (key-echoing), confirmAction (auto-confirm), react-native-toast-message, and
// useStore (configurable snapshot with per-action spies). TabStrip is stubbed to
// render its rightSlot so the action buttons are reachable.

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

// Spec 108 — locale + localized-name resolver are exercised in POsSection.onShare.
jest.mock('../../../../hooks/useLocale', () => ({ useLocale: () => 'en' }));
jest.mock('../../../../i18n/localizedName', () => ({
  // Echo the canonical name (the resolver-uses-getLocalizedName path is unit
  // tested in poShareText.test.ts; here we only need onShare to build text).
  getLocalizedName: (row: { name?: string }) => row?.name ?? '',
}));

// Spec 108 — the impure share orchestrator. Configurable per test (default:
// completed share, no preview → the mobile-web/native happy path). Typed to
// the real result shape so `previewText` can be a string or null per test.
type SharePoResult = { shared: boolean; previewText: string | null };
const mockSharePurchaseOrder = jest.fn<Promise<SharePoResult>, [string, unknown]>(
  async () => ({ shared: true, previewText: null }),
);
jest.mock('../../lib/sharePo', () => ({
  sharePurchaseOrder: (...args: any[]) => (mockSharePurchaseOrder as any)(...args),
}));

const mockConfirmAction = jest.fn(
  (_t: string, _m: string, onConfirm: () => void) => { onConfirm(); },
);
jest.mock('../../../../utils/confirmAction', () => ({
  confirmAction: (...args: any[]) => (mockConfirmAction as any)(...args),
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

// TabStrip — render the rightSlot so the action buttons are reachable.
jest.mock('../../../../components/cmd/TabStrip', () => {
  const ReactMod = require('react');
  const RN = require('react-native');
  return {
    TabStrip: ({ rightSlot }: { rightSlot?: React.ReactNode }) =>
      ReactMod.createElement(RN.View, { testID: 'tabstrip' }, rightSlot),
  };
});
jest.mock('../../../../components/cmd/StatCard', () => ({ StatCard: () => null }));

// StatusPill — render its label as text so status chips are queryable.
jest.mock('../../../../components/cmd/StatusPill', () => {
  const ReactMod = require('react');
  const RN = require('react-native');
  return {
    StatusPill: ({ label }: { label?: string }) =>
      ReactMod.createElement(RN.Text, null, label),
  };
});
jest.mock('../../../../components/cmd/SectionCaption', () => ({
  SectionCaption: ({ children }: { children?: React.ReactNode }) => {
    const RN = require('react-native');
    const ReactMod = require('react');
    return ReactMod.createElement(RN.Text, null, children);
  },
}));

jest.mock('../../../../store/useStore', () => {
  const state: any = {
    currentStore: { id: 'store-1', name: 'Test Store' },
    orderSubmissions: [],
    vendors: [],
    inventory: [],
    poLinesById: {},
    loadPurchaseOrderLines: jest.fn(async () => []),
    updatePoLineQty: jest.fn(),
    removePoLine: jest.fn(),
    sendPurchaseOrderEmail: jest.fn(async () => true),
    markPurchaseOrderSentManually: jest.fn(async () => true),
    cancelPurchaseOrder: jest.fn(async () => 'cancelled'),
    closeShortPurchaseOrder: jest.fn(async () => 'received'),
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';
import POsSection from '../POsSection';
import { useStore } from '../../../../store/useStore';

const state = (useStore as any).__state as Record<string, any>;
const spies = {
  loadPurchaseOrderLines: state.loadPurchaseOrderLines as jest.Mock,
  sendPurchaseOrderEmail: state.sendPurchaseOrderEmail as jest.Mock,
  markPurchaseOrderSentManually: state.markPurchaseOrderSentManually as jest.Mock,
  cancelPurchaseOrder: state.cancelPurchaseOrder as jest.Mock,
  closeShortPurchaseOrder: state.closeShortPurchaseOrder as jest.Mock,
};

function po(over: Record<string, any> & { id: string; status: string }) {
  return {
    id: over.id,
    storeId: 'store-1',
    vendorId: over.vendorId ?? 'vendor-1',
    vendorName: over.vendorName ?? 'Acme',
    status: over.status,
    day: 'Monday',
    date: over.date ?? '2026-07-03',
    timestamp: over.timestamp ?? '2026-07-03T10:00:00Z',
    submittedBy: 'tester',
    submittedAt: '10:00 AM',
    totalCost: 100,
  };
}

beforeEach(() => {
  mockConfirmAction.mockClear();
  mockSharePurchaseOrder.mockClear();
  (Toast.show as jest.Mock).mockClear();
  Object.values(spies).forEach((s) => s.mockClear());
  state.orderSubmissions = [];
  state.vendors = [];
  state.inventory = [];
  state.poLinesById = {};
  spies.loadPurchaseOrderLines.mockImplementation(async () => []);
  spies.sendPurchaseOrderEmail.mockImplementation(async () => true);
  spies.markPurchaseOrderSentManually.mockImplementation(async () => true);
  spies.cancelPurchaseOrder.mockImplementation(async () => 'cancelled');
  spies.closeShortPurchaseOrder.mockImplementation(async () => 'received');
  mockSharePurchaseOrder.mockImplementation(async () => ({ shared: true, previewText: null }));
  mockConfirmAction.mockImplementation((_t: string, _m: string, onConfirm: () => void) => { onConfirm(); });
});

describe('POsSection — action gating by status', () => {
  it('DRAFT + vendor email: shows send, mark-sent, cancel; NOT close-short', () => {
    state.orderSubmissions = [po({ id: 'po-1', status: 'draft' })];
    state.vendors = [{ id: 'vendor-1', name: 'Acme', email: 'orders@acme.test' }];
    render(<POsSection />);
    expect(screen.getByTestId('po-action-send')).toBeTruthy();
    expect(screen.getByTestId('po-action-mark-sent')).toBeTruthy();
    expect(screen.getByTestId('po-action-cancel')).toBeTruthy();
    expect(screen.queryByTestId('po-action-close-short')).toBeNull();
  });

  it('DRAFT + NO vendor email: hides send, shows mark-sent + the no-email hint', () => {
    state.orderSubmissions = [po({ id: 'po-1', status: 'draft' })];
    state.vendors = [{ id: 'vendor-1', name: 'Acme', email: '' }];
    render(<POsSection />);
    expect(screen.queryByTestId('po-action-send')).toBeNull();
    expect(screen.getByTestId('po-action-mark-sent')).toBeTruthy();
    expect(screen.getByTestId('po-no-email-hint')).toBeTruthy();
  });

  it('SENT: hides send/mark-sent; shows cancel; NOT close-short', () => {
    state.orderSubmissions = [po({ id: 'po-1', status: 'sent' })];
    state.vendors = [{ id: 'vendor-1', name: 'Acme', email: 'orders@acme.test' }];
    render(<POsSection />);
    expect(screen.queryByTestId('po-action-send')).toBeNull();
    expect(screen.queryByTestId('po-action-mark-sent')).toBeNull();
    expect(screen.getByTestId('po-action-cancel')).toBeTruthy();
    expect(screen.queryByTestId('po-action-close-short')).toBeNull();
  });

  it('PARTIAL: shows cancel AND close-short', () => {
    state.orderSubmissions = [po({ id: 'po-1', status: 'partial' })];
    state.vendors = [{ id: 'vendor-1', name: 'Acme', email: 'orders@acme.test' }];
    render(<POsSection />);
    expect(screen.getByTestId('po-action-close-short')).toBeTruthy();
    expect(screen.getByTestId('po-action-cancel')).toBeTruthy();
  });

  it('RECEIVED: no lifecycle actions (terminal state)', () => {
    state.orderSubmissions = [po({ id: 'po-1', status: 'received' })];
    state.vendors = [{ id: 'vendor-1', name: 'Acme', email: 'orders@acme.test' }];
    render(<POsSection />);
    expect(screen.queryByTestId('po-action-send')).toBeNull();
    expect(screen.queryByTestId('po-action-mark-sent')).toBeNull();
    expect(screen.queryByTestId('po-action-cancel')).toBeNull();
    expect(screen.queryByTestId('po-action-close-short')).toBeNull();
  });

  it('CANCELLED: no lifecycle actions (terminal state)', () => {
    state.orderSubmissions = [po({ id: 'po-1', status: 'cancelled' })];
    state.vendors = [{ id: 'vendor-1', name: 'Acme', email: 'orders@acme.test' }];
    render(<POsSection />);
    expect(screen.queryByTestId('po-action-cancel')).toBeNull();
    expect(screen.queryByTestId('po-action-close-short')).toBeNull();
  });
});

describe('POsSection — actions are confirm-gated', () => {
  beforeEach(() => {
    state.vendors = [{ id: 'vendor-1', name: 'Acme', email: 'orders@acme.test' }];
  });

  it('SEND goes through confirmAction then calls sendPurchaseOrderEmail', async () => {
    state.orderSubmissions = [po({ id: 'po-1', status: 'draft' })];
    render(<POsSection />);
    fireEvent.press(screen.getByTestId('po-action-send'));
    expect(mockConfirmAction).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(spies.sendPurchaseOrderEmail).toHaveBeenCalledWith('po-1'));
  });

  it('MARK-SENT goes through confirmAction then calls markPurchaseOrderSentManually', async () => {
    state.orderSubmissions = [po({ id: 'po-1', status: 'draft' })];
    render(<POsSection />);
    fireEvent.press(screen.getByTestId('po-action-mark-sent'));
    expect(mockConfirmAction).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(spies.markPurchaseOrderSentManually).toHaveBeenCalledWith('po-1'));
  });

  it('CANCEL goes through confirmAction then calls cancelPurchaseOrder', async () => {
    state.orderSubmissions = [po({ id: 'po-1', status: 'sent' })];
    render(<POsSection />);
    fireEvent.press(screen.getByTestId('po-action-cancel'));
    expect(mockConfirmAction).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(spies.cancelPurchaseOrder).toHaveBeenCalledWith('po-1'));
  });

  it('CLOSE-SHORT goes through confirmAction then calls closeShortPurchaseOrder', async () => {
    state.orderSubmissions = [po({ id: 'po-1', status: 'partial' })];
    render(<POsSection />);
    fireEvent.press(screen.getByTestId('po-action-close-short'));
    expect(mockConfirmAction).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(spies.closeShortPurchaseOrder).toHaveBeenCalledWith('po-1'));
  });

  it('does NOT call the store action when the user cancels the confirm', () => {
    mockConfirmAction.mockImplementationOnce(() => { /* user cancels — no onConfirm */ });
    state.orderSubmissions = [po({ id: 'po-1', status: 'sent' })];
    render(<POsSection />);
    fireEvent.press(screen.getByTestId('po-action-cancel'));
    expect(mockConfirmAction).toHaveBeenCalledTimes(1);
    expect(spies.cancelPurchaseOrder).not.toHaveBeenCalled();
  });
});

describe('POsSection — loads real po_items lines on select', () => {
  it('calls loadPurchaseOrderLines for the selected PO', async () => {
    state.orderSubmissions = [po({ id: 'po-1', status: 'sent' })];
    state.vendors = [{ id: 'vendor-1', name: 'Acme', email: 'orders@acme.test' }];
    render(<POsSection />);
    await waitFor(() => expect(spies.loadPurchaseOrderLines).toHaveBeenCalledWith('po-1'));
  });
});

// ─── Spec 108 — Share PO ───────────────────────────────────────────────
describe('POsSection — Share visibility by status', () => {
  beforeEach(() => {
    state.vendors = [{ id: 'vendor-1', name: 'Acme', email: 'orders@acme.test' }];
  });

  it.each(['draft', 'sent', 'partial'])('Share IS shown on %s', (status) => {
    state.orderSubmissions = [po({ id: 'po-1', status })];
    render(<POsSection />);
    expect(screen.getByTestId('po-action-share')).toBeTruthy();
  });

  it.each(['received', 'cancelled'])('Share is HIDDEN on %s', (status) => {
    state.orderSubmissions = [po({ id: 'po-1', status })];
    render(<POsSection />);
    expect(screen.queryByTestId('po-action-share')).toBeNull();
  });
});

describe('POsSection — Share is primary; email demoted to secondary', () => {
  it('DRAFT + vendor email: Share renders BEFORE the email send button', () => {
    state.orderSubmissions = [po({ id: 'po-1', status: 'draft' })];
    state.vendors = [{ id: 'vendor-1', name: 'Acme', email: 'orders@acme.test' }];
    render(<POsSection />);
    const share = screen.getByTestId('po-action-share');
    const send = screen.getByTestId('po-action-send');
    expect(share).toBeTruthy();
    expect(send).toBeTruthy();
    // Share (accent, primary) uses the C.accentFg theme token ('#FFF' in the
    // mocked palette — code-review fix: was a hardcoded '#000' contrast bug);
    // email demotes to the outlined secondary treatment, not the accent fg.
    const shareColor = share.findByType(require('react-native').Text).props.style.color;
    const sendColor = send.findByType(require('react-native').Text).props.style.color;
    expect(shareColor).toBe('#FFF');
    expect(sendColor).not.toBe('#FFF');
  });
});

describe('POsSection — draft share triggers the mark-as-sent prompt', () => {
  beforeEach(() => {
    state.vendors = [{ id: 'vendor-1', name: 'Acme', email: '' }];
    state.poLinesById = { 'po-1': [{ poItemId: 'pi-1', itemId: 'inv-1', itemName: 'Chicken', unit: 'case', orderedQty: 3, receivedQty: 0, costPerUnit: 10, subUnitSize: 1 }] };
    state.inventory = [{ id: 'inv-1', name: 'Chicken', i18nNames: {} }];
  });

  it('DRAFT: completed share → confirmAction prompt → markPurchaseOrderSentManually', async () => {
    state.orderSubmissions = [po({ id: 'po-1', status: 'draft' })];
    render(<POsSection />);
    fireEvent.press(screen.getByTestId('po-action-share'));
    await waitFor(() => expect(mockSharePurchaseOrder).toHaveBeenCalledTimes(1));
    // The honest question is a QUESTION title (didYouSendTitle key echoed).
    await waitFor(() => expect(mockConfirmAction).toHaveBeenCalledTimes(1));
    expect(mockConfirmAction.mock.calls[0][0]).toBe('section.purchaseOrders.didYouSendTitle');
    await waitFor(() => expect(spies.markPurchaseOrderSentManually).toHaveBeenCalledWith('po-1'));
  });

  it('DRAFT: declining the prompt is a no-op (status stays draft)', async () => {
    mockConfirmAction.mockImplementationOnce(() => { /* user declines — no onConfirm */ });
    state.orderSubmissions = [po({ id: 'po-1', status: 'draft' })];
    render(<POsSection />);
    fireEvent.press(screen.getByTestId('po-action-share'));
    await waitFor(() => expect(mockConfirmAction).toHaveBeenCalledTimes(1));
    expect(spies.markPurchaseOrderSentManually).not.toHaveBeenCalled();
  });

  it('DRAFT: dismissed share (shared:false) → NO prompt', async () => {
    mockSharePurchaseOrder.mockImplementationOnce(async () => ({ shared: false, previewText: null }));
    state.orderSubmissions = [po({ id: 'po-1', status: 'draft' })];
    render(<POsSection />);
    fireEvent.press(screen.getByTestId('po-action-share'));
    await waitFor(() => expect(mockSharePurchaseOrder).toHaveBeenCalledTimes(1));
    expect(mockConfirmAction).not.toHaveBeenCalled();
    expect(spies.markPurchaseOrderSentManually).not.toHaveBeenCalled();
  });
});

describe('POsSection — sent/partial re-share suppresses the prompt', () => {
  beforeEach(() => {
    state.vendors = [{ id: 'vendor-1', name: 'Acme', email: 'orders@acme.test' }];
    state.poLinesById = { 'po-1': [{ poItemId: 'pi-1', itemId: 'inv-1', itemName: 'Chicken', unit: 'case', orderedQty: 3, receivedQty: 0, costPerUnit: 10, subUnitSize: 1 }] };
    state.inventory = [{ id: 'inv-1', name: 'Chicken', i18nNames: {} }];
  });

  it.each(['sent', 'partial'])('%s: completed share does NOT prompt / mark sent', async (status) => {
    state.orderSubmissions = [po({ id: 'po-1', status })];
    render(<POsSection />);
    fireEvent.press(screen.getByTestId('po-action-share'));
    await waitFor(() => expect(mockSharePurchaseOrder).toHaveBeenCalledTimes(1));
    expect(mockConfirmAction).not.toHaveBeenCalled();
    expect(spies.markPurchaseOrderSentManually).not.toHaveBeenCalled();
  });
});

describe('POsSection — desktop-web clipboard fallback preview', () => {
  beforeEach(() => {
    state.vendors = [{ id: 'vendor-1', name: 'Acme', email: 'orders@acme.test' }];
    state.poLinesById = { 'po-1': [{ poItemId: 'pi-1', itemId: 'inv-1', itemName: 'Chicken', unit: 'case', orderedQty: 3, receivedQty: 0, costPerUnit: 10, subUnitSize: 1 }] };
    state.inventory = [{ id: 'inv-1', name: 'Chicken', i18nNames: {} }];
  });

  it('renders the preview pane when the orchestrator returns previewText', async () => {
    mockSharePurchaseOrder.mockImplementationOnce(async () => ({ shared: true, previewText: 'PREVIEW BODY TEXT' }));
    state.orderSubmissions = [po({ id: 'po-1', status: 'sent' })];
    render(<POsSection />);
    expect(screen.queryByTestId('po-share-preview')).toBeNull();
    fireEvent.press(screen.getByTestId('po-action-share'));
    await waitFor(() => expect(screen.getByTestId('po-share-preview')).toBeTruthy());
    expect(screen.getByText('PREVIEW BODY TEXT')).toBeTruthy();
  });

  it('does NOT render the preview pane on the native/mobile-web path (previewText null)', async () => {
    mockSharePurchaseOrder.mockImplementationOnce(async () => ({ shared: true, previewText: null }));
    state.orderSubmissions = [po({ id: 'po-1', status: 'sent' })];
    render(<POsSection />);
    fireEvent.press(screen.getByTestId('po-action-share'));
    await waitFor(() => expect(mockSharePurchaseOrder).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('po-share-preview')).toBeNull();
  });

  it('clears the preview when switching to another PO', async () => {
    mockSharePurchaseOrder.mockImplementationOnce(async () => ({ shared: true, previewText: 'PREVIEW BODY TEXT' }));
    // Distinct timestamps so po-1 (later) deterministically sorts first and is
    // the initial selection; pressing po-2 is a genuine PO switch.
    state.orderSubmissions = [
      po({ id: 'po-1', status: 'sent', timestamp: '2026-07-03T12:00:00Z' }),
      po({ id: 'po-2', status: 'sent', vendorName: 'Beta', timestamp: '2026-07-02T09:00:00Z' }),
    ];
    render(<POsSection />);
    fireEvent.press(screen.getByTestId('po-action-share'));
    await waitFor(() => expect(screen.getByTestId('po-share-preview')).toBeTruthy());
    // Switch PO via the list row → the selectedId-change effect clears preview.
    fireEvent.press(screen.getByTestId('po-list-po-2'));
    await waitFor(() => expect(screen.queryByTestId('po-share-preview')).toBeNull());
  });
});
