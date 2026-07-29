// src/screens/cmd/sections/phone/__tests__/PhoneReports.test.tsx
//
// Spec 147 — the phone Reports saved-report list + drill-in detail. Pins the
// pure `reportPillState` mapping (READY/RUNNING/QUEUED/FAILED — never the
// accent), the row render, the drill-in detail (loadLatestRun on open + KPIs +
// RUN REPORT calling runReport), and the honest NEW REPORT toast.

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';

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

import { PhoneReports, reportPillState } from '../PhoneReports';
import { useStore } from '../../../../../store/useStore';

const runReport = jest.fn();
const loadLatestRun = jest.fn(() => Promise.resolve());

const defs = [
  { id: 'd1', storeId: 'store-1', templateId: 'variance', name: 'Weekly Variance', scope: 'this_store', createdAt: new Date().toISOString() },
  { id: 'd2', storeId: 'store-1', templateId: 'cogs', name: 'CoGS Month', scope: 'this_store', createdAt: new Date().toISOString() },
];

function seed() {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
    savedReports: defs,
    reportRuns: {
      d1: {
        id: 'run-1', definitionId: 'd1', templateId: 'variance', storeId: 'store-1', params: {},
        output: { kpis: [{ label: 'Net Δ$', value: '−124.00', tone: 'danger' }], columns: [], rows: [], series: null },
        status: 'ok', errorMessage: null, ranAt: new Date().toISOString(), ranBy: 'u',
      },
    },
    runReport,
    loadLatestRun,
  } as any);
}

beforeEach(() => { jest.clearAllMocks(); seed(); });

describe('reportPillState (status mapping — never the accent)', () => {
  it('maps no-run → queued, pending → running, ok → ready, error → failed', () => {
    expect(reportPillState(undefined)).toBe('queued');
    expect(reportPillState({ status: 'pending' } as any)).toBe('running');
    expect(reportPillState({ status: 'ok' } as any)).toBe('ready');
    expect(reportPillState({ status: 'error' } as any)).toBe('failed');
  });
});

describe('PhoneReports', () => {
  it('renders a row per saved report', () => {
    const { getByTestId, getByText } = render(<PhoneReports />);
    expect(getByTestId('phone-report-row-d1')).toBeTruthy();
    expect(getByText('Weekly Variance')).toBeTruthy();
  });

  it('opens the detail (loadLatestRun) and RUN REPORT calls runReport', () => {
    const { getByTestId, queryByTestId } = render(<PhoneReports />);
    expect(queryByTestId('phone-report-run')).toBeNull();
    fireEvent.press(getByTestId('phone-report-row-d1'));
    expect(loadLatestRun).toHaveBeenCalledWith('d1');
    // KPIs from the run output render as phone-safe label/value pairs.
    expect(getByTestId('phone-report-kpis')).toBeTruthy();
    fireEvent.press(getByTestId('phone-report-run'));
    expect(runReport).toHaveBeenCalledWith('d1');
  });

  it('NEW REPORT fires an honest toast (desktop-only builder)', () => {
    const { getByTestId } = render(<PhoneReports />);
    fireEvent.press(getByTestId('phone-report-new'));
    expect(Toast.show as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', text1: 'Edit on desktop' }),
    );
    expect(runReport).not.toHaveBeenCalled();
  });

  it('shows the empty state when no saved reports for the store', () => {
    useStore.setState({ savedReports: [] } as any);
    const { getByText } = render(<PhoneReports />);
    expect(getByText(/No saved reports/)).toBeTruthy();
  });
});
