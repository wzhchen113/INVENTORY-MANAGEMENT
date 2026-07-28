// src/screens/cmd/sections/phone/__tests__/PhoneDrillScaffold.test.tsx
//
// Spec 142 §6.2 (AC-D2/D3/D4) — the shared phone drill-in scaffold:
//   - nothing is selected by default (no detail overlay, Hard Rule 7);
//   - tapping a row opens a full-screen detail with a 52px header + 44px ← +
//     mono parent caption;
//   - pressing ← returns to the list;
//   - the list is NEVER unmounted (back restores scroll) — asserted via a
//     mount-count probe that stays at 1 across open → close.
//
// supabase is stubbed because useCmdColors → useStore imports it at module load.

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';

jest.mock('../../../../../lib/supabase', () => ({
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

import { PhoneDrillScaffold } from '../PhoneDrillScaffold';
import { usePhoneDrill } from '../usePhoneDrill';

// A mount-count probe embedded in the list. If the scaffold ever unmounted the
// list to show the detail (the Brands defect this scaffold fixes), this count
// would climb on the return trip. It must stay 1.
let listMountCount = 0;
function ListProbe() {
  React.useEffect(() => {
    listMountCount += 1;
  }, []);
  return <View testID="list-probe" />;
}

interface Item {
  id: string;
  name: string;
}

function Harness() {
  const drill = usePhoneDrill<Item>();
  return (
    <PhoneDrillScaffold
      testID="scaffold"
      parentCaption="INVENTORY"
      onBack={drill.close}
      list={
        <View testID="the-list">
          <ListProbe />
          <Pressable testID="row-1" onPress={() => drill.open({ id: '1', name: 'Row One' })}>
            <Text>Row One</Text>
          </Pressable>
        </View>
      }
      detail={
        drill.selected ? <Text testID="detail-body">Detail for {drill.selected.name}</Text> : null
      }
    />
  );
}

beforeEach(() => {
  listMountCount = 0;
});

function flat(style: unknown): Record<string, unknown> {
  return Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity)) : (style as any);
}

describe('PhoneDrillScaffold — spec 142 shared drill-in', () => {
  it('shows the list only by default — no detail overlay is selected', () => {
    const { queryByTestId } = render(<Harness />);
    expect(queryByTestId('the-list')).toBeTruthy();
    expect(queryByTestId('phone-drill-detail')).toBeNull();
    expect(queryByTestId('phone-detail-header')).toBeNull();
    expect(listMountCount).toBe(1);
  });

  it('opens a full-screen detail with a 52px header, 44px ← and mono parent caption', () => {
    const { getByTestId, getByLabelText, getByText } = render(<Harness />);
    fireEvent.press(getByTestId('row-1'));

    // Full-screen detail overlay is up.
    expect(getByTestId('phone-drill-detail')).toBeTruthy();
    expect(getByTestId('detail-body')).toBeTruthy();

    // 52px header + 44px back + parent caption (AC-D3).
    expect(flat(getByTestId('phone-detail-header').props.style).height).toBe(52);
    expect(flat(getByLabelText('Back').props.style).width).toBe(44);
    expect(getByText('INVENTORY')).toBeTruthy();

    // The list is still mounted underneath (not remounted) — back restores scroll.
    expect(getByTestId('the-list')).toBeTruthy();
    expect(listMountCount).toBe(1);
  });

  it('returns to the list on ← and never remounts it', () => {
    const { getByTestId, getByLabelText, queryByTestId } = render(<Harness />);
    fireEvent.press(getByTestId('row-1'));
    expect(getByTestId('phone-drill-detail')).toBeTruthy();

    fireEvent.press(getByLabelText('Back'));
    expect(queryByTestId('phone-drill-detail')).toBeNull();
    expect(getByTestId('the-list')).toBeTruthy();
    // Mounted exactly once the whole time → scroll position is preserved.
    expect(listMountCount).toBe(1);
  });
});
