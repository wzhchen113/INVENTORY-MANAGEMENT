// src/screens/cmd/sections/phone/__tests__/PhonePOSImports.test.tsx
//
// Spec 147 — the phone POS-imports list + drill-in detail. Pins the row render
// (state pill + matched/total), the drill-in detail (stats + unmatched list),
// the honest UPLOAD CSV toast (desktop-only flow), and the empty state.

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

import { PhonePOSImports } from '../PhonePOSImports';
import { useStore } from '../../../../../store/useStore';

function seed(imports: any[]) {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
    posImports: imports,
    recipes: [],
  } as any);
}

const importFixture = {
  id: 'imp-1',
  filename: 'toast-2026-07-28.csv',
  importedAt: new Date().toISOString(),
  importedBy: 'Admin',
  date: '2026-07-28',
  storeId: 'store-1',
  items: [
    { menuItem: 'Wings', qtySold: 12, revenue: 100, recipeMapped: true },
    { menuItem: 'Mystery Combo', qtySold: 3, revenue: 30, recipeMapped: false },
  ],
};

beforeEach(() => { jest.clearAllMocks(); });

describe('PhonePOSImports', () => {
  it('renders an import row with matched/total', () => {
    seed([importFixture]);
    const { getByTestId, getByText } = render(<PhonePOSImports />);
    expect(getByTestId('phone-posimport-row-imp-1')).toBeTruthy();
    expect(getByText('toast-2026-07-28.csv')).toBeTruthy();
    expect(getByText('1/2')).toBeTruthy(); // 1 matched of 2 rows
  });

  it('opens the detail with stats + the unmatched-item list', () => {
    seed([importFixture]);
    const { getByTestId, queryByTestId, getByText } = render(<PhonePOSImports />);
    expect(queryByTestId('phone-posimport-statpanel')).toBeNull();
    fireEvent.press(getByTestId('phone-posimport-row-imp-1'));
    expect(getByTestId('phone-posimport-statpanel')).toBeTruthy();
    expect(getByText('Mystery Combo')).toBeTruthy(); // the unmatched row
  });

  it('UPLOAD CSV fires an honest toast (desktop-only flow)', () => {
    seed([importFixture]);
    const { getByTestId } = render(<PhonePOSImports />);
    fireEvent.press(getByTestId('phone-posimport-upload'));
    expect(Toast.show as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', text1: 'Edit on desktop' }),
    );
  });

  it('shows the empty state when there are no imports for the store', () => {
    seed([]);
    const { getByText } = render(<PhonePOSImports />);
    expect(getByText(/No POS imports for F/)).toBeTruthy();
  });
});
