// src/screens/cmd/sections/phone/__tests__/PhoneAuditLog.test.tsx
//
// Spec 147 — the phone Audit-log day-grouped feed. Pins the day-grouped rows
// (full wrapping message + time·user meta), the bilingual text filter narrowing
// the feed, and the empty state. Audit is intentionally list-only (no drill-in)
// — the row shows the full message, so there is nothing more to detail.

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

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

import { PhoneAuditLog } from '../PhoneAuditLog';
import { useStore } from '../../../../../store/useStore';

const now = new Date().toISOString();
const events = [
  { id: 'e1', storeId: 'store-1', timestamp: now, action: 'Item added', userName: 'Alice', itemRef: 'Chicken Wings', value: '' },
  { id: 'e2', storeId: 'store-1', timestamp: now, action: 'Waste log', userName: 'Bob', itemRef: 'Fries', value: '2 lbs' },
  { id: 'e3', storeId: 'store-2', timestamp: now, action: 'Item added', userName: 'Zed', itemRef: 'Other Store Item', value: '' },
];

function seed() {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
    auditLog: events,
  } as any);
}

beforeEach(() => { jest.clearAllMocks(); seed(); });

describe('PhoneAuditLog', () => {
  it('renders one row per current-store event (other stores excluded)', () => {
    const { getByTestId, queryByTestId } = render(<PhoneAuditLog />);
    expect(getByTestId('phone-auditlog-row-e1')).toBeTruthy();
    expect(getByTestId('phone-auditlog-row-e2')).toBeTruthy();
    expect(queryByTestId('phone-auditlog-row-e3')).toBeNull(); // store-2 filtered out
  });

  it('shows the full message with the item reference', () => {
    const { getByText } = render(<PhoneAuditLog />);
    expect(getByText(/Chicken Wings/)).toBeTruthy();
  });

  it('the text filter narrows the feed by actor', () => {
    const { getByTestId, queryByTestId } = render(<PhoneAuditLog />);
    fireEvent.changeText(getByTestId('phone-auditlog-filter'), 'Alice');
    expect(getByTestId('phone-auditlog-row-e1')).toBeTruthy();
    expect(queryByTestId('phone-auditlog-row-e2')).toBeNull();
  });

  it('shows the empty state when the store has no events', () => {
    useStore.setState({ auditLog: [] } as any);
    const { getByText } = render(<PhoneAuditLog />);
    expect(getByText(/no events recorded/)).toBeTruthy();
  });
});
