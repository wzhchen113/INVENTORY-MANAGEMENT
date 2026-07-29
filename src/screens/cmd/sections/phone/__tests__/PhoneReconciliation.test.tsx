// src/screens/cmd/sections/phone/__tests__/PhoneReconciliation.test.tsx
//
// Spec 147 — the phone Reconciliation variance list + drill-in detail. Pins the
// pure `varianceTone` severity mapping (never-the-accent guarantee), the row
// render (pill + name + Δ$), the drill-in detail (expected/counted/Δ), the net
// footer, and both empty states.

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

import { PhoneReconciliation, varianceTone, type PhoneReconciliationModel } from '../PhoneReconciliation';

const rows = [
  { id: 'i1', name: 'Chicken Wings', category: 'Protein', unit: 'lbs', expected: 100, counted: 70, diff: -30, dollar: -114, pct: -30 },
  { id: 'i2', name: 'Fries', category: 'Sides', unit: 'lbs', expected: 50, counted: 44, diff: -6, dollar: -12, pct: -12 },
  { id: 'i3', name: 'Cola', category: 'Bev', unit: 'ea', expected: 40, counted: 41, diff: 1, dollar: 2, pct: 2 },
];

function model(over: Partial<PhoneReconciliationModel> = {}): PhoneReconciliationModel {
  return { latestDate: '2026-07-28', rows, netDollar: -124, netPctOfInv: -3.2, ...over };
}

describe('varianceTone (severity mapping — never the accent)', () => {
  it('maps |Δ%| ≥ 25 → danger, ≥ 10 → warn, favorable → ok, else neutral', () => {
    expect(varianceTone({ pct: -30, diff: -30 })).toBe('danger');
    expect(varianceTone({ pct: 27, diff: 5 })).toBe('danger');
    expect(varianceTone({ pct: -12, diff: -6 })).toBe('warn');
    expect(varianceTone({ pct: 2, diff: 1 })).toBe('ok');
    expect(varianceTone({ pct: -2, diff: -1 })).toBe('neutral');
  });
});

describe('PhoneReconciliation', () => {
  it('renders a variance row per line with name + Δ$', () => {
    const { getByTestId, getByText } = render(<PhoneReconciliation model={model()} />);
    expect(getByTestId('phone-recon-row-i1')).toBeTruthy();
    expect(getByText('Chicken Wings')).toBeTruthy();
    // Signed money uses the unicode minus.
    expect(getByText('−$114.00')).toBeTruthy();
  });

  it('opens the full-screen detail on tap with expected / counted values', () => {
    const { getByTestId, queryByTestId, getByText } = render(<PhoneReconciliation model={model()} />);
    expect(queryByTestId('phone-recon-detail-props')).toBeNull();
    fireEvent.press(getByTestId('phone-recon-row-i1'));
    expect(getByTestId('phone-recon-detail-props')).toBeTruthy();
    expect(getByText('100 lbs')).toBeTruthy(); // expected
    expect(getByText('70 lbs')).toBeTruthy(); // counted
  });

  it('renders the net footer', () => {
    const { getByText } = render(<PhoneReconciliation model={model()} />);
    expect(getByText('−$124.00')).toBeTruthy();
  });

  it('shows the no-variance empty state when rows empty but an EOD exists', () => {
    const { getByText } = render(<PhoneReconciliation model={model({ rows: [], netDollar: 0, netPctOfInv: 0 })} />);
    expect(getByText('No variances vs prior period.')).toBeTruthy();
  });

  it('shows the no-EOD empty state when there is no submission at all', () => {
    const { getByText } = render(
      <PhoneReconciliation model={model({ rows: [], latestDate: null, netDollar: 0, netPctOfInv: 0 })} />,
    );
    expect(getByText('No EOD submissions yet.')).toBeTruthy();
  });
});
