// src/screens/cmd/sections/phone/__tests__/PhoneShellWiring.test.tsx
//
// Spec 148 wiring pins (test-engineer follow-up). Full-shell mounting of
// ResponsiveCmdShell needs the navigation container + section registry and is
// deliberately NOT reproduced here; instead each half of the wiring is pinned
// at its own seam, per the reviewer-sanctioned fallback:
//   - the bell → sheet behavior is pinned in PhoneNotifications.test.tsx
//     ("opens on the bell and lists rows") — the component owns its sheet.
//   - THIS file pins the drawer side: MobileNavDrawer renders whatever the
//     shell passes into its `storeChip` slot in the header, which is the sole
//     mount point PhoneStoreSwitch relies on at phone tier.

import React from 'react';
import { Text } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';

jest.mock('../../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

jest.mock('../../../../../theme/breakpoints', () => ({
  __esModule: true,
  useIsPhone: () => true,
  useIsTablet: () => false,
  useIsDesktop: () => false,
}));

import { MobileNavDrawer } from '../../../../../components/cmd/MobileNavDrawer';

describe('PhoneStoreSwitch drawer wiring (spec 148)', () => {
  it('MobileNavDrawer renders the storeChip slot content in its header', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <MobileNavDrawer
        visible
        onClose={jest.fn()}
        groups={[]}
        selectedId="Inventory"
        onSelect={jest.fn()}
        paletteQuery=""
        onPaletteChange={jest.fn()}
        storeChip={<Text testID="wiring-store-chip" onPress={onPress}>Reisters ▾</Text>}
      />,
    );
    const chip = getByTestId('wiring-store-chip');
    expect(chip).toBeTruthy();
    fireEvent.press(chip);
    expect(onPress).toHaveBeenCalled();
  });

  it('omitting storeChip renders no slot container (slot is optional)', () => {
    const { queryByTestId } = render(
      <MobileNavDrawer
        visible
        onClose={jest.fn()}
        groups={[]}
        selectedId="Inventory"
        onSelect={jest.fn()}
        paletteQuery=""
        onPaletteChange={jest.fn()}
      />,
    );
    expect(queryByTestId('wiring-store-chip')).toBeNull();
  });
});
