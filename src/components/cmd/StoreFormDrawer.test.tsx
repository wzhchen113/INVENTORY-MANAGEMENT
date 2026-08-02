// src/components/cmd/StoreFormDrawer.test.tsx — spec 149 review round
// (test-engineer Should-fix 2). First test file for this drawer.
//
// The new-store drawer is the ONLY surface that sets `stores.postal_code`, the
// ZIP the `instacart-cart-link` edge function uses server-side for the IDP
// retailer-availability lookup (§7.6 / R-4). A wiring typo here (wrong key in
// the `addStore` payload, or a blank string reaching the column instead of
// NULL) would silently leave the Instacart channel dark with no visible
// symptom, so both directions are pinned:
//   • blank ⇒ `postalCode: null` (explicit clear, NOT '')
//   • filled ⇒ trimmed value
//   • the field is optional: it never gates the CREATE button
//   • it resets between opens, like name/address
//
// Boundary mocking mirrors VendorFormDrawer.test.tsx: theme/colors +
// breakpoints pinned, ResponsiveSheet bypassed to render the body inline,
// useStore a mutable snapshot exposing an addStore spy. Toast is mocked
// globally in tests/jest.setup.ts.

jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#FFFFFF', panel: '#F4F4F4', panel2: '#EAEAEA', border: '#CCCCCC',
    borderStrong: '#888888', fg: '#000000', fg2: '#444444', fg3: '#888888',
    accent: '#185FA5', accentBg: '#E6F1FB', accentFg: '#FFFFFF',
    warn: '#854F0B', warnBg: '#FAEEDA', danger: '#791F1F', dangerBg: '#FCEBEB',
    ok: '#3B6D11', okBg: '#EAF3DE', info: '#185FA5', infoBg: '#E6F1FB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

jest.mock('../../theme/breakpoints', () => ({
  useIsPhone: () => false,
  useIsCompact: () => false,
  useBreakpoint: () => 'desktop' as const,
}));

jest.mock('./ResponsiveSheet', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    ResponsiveSheet: ({ visible, header, footer, children }: any) => {
      if (!visible) return null;
      return React.createElement(View, { testID: 'responsive-sheet' }, header, children, footer);
    },
  };
});

jest.mock('../../store/useStore', () => {
  const addStore = jest.fn();
  const state: any = { addStore };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { StoreFormDrawer } from './StoreFormDrawer';

const mod = jest.requireMock('../../store/useStore');
const addStoreMock = mod.useStore.__state.addStore as jest.Mock;

beforeEach(() => jest.clearAllMocks());

const open = () =>
  render(<StoreFormDrawer visible brandId="b1" brandName="2AM PROJECT" onClose={() => {}} />);

describe('StoreFormDrawer — postal code (spec 149 §7.6)', () => {
  it('renders the optional postal-code field, empty by default', () => {
    open();
    const input = screen.getByTestId('store-postal-code');
    expect(input.props.value).toBe('');
    expect(screen.getByText('Postal code (optional)')).toBeTruthy();
  });

  it('a filled postal code reaches addStore trimmed', () => {
    open();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Towson'), 'Frederick');
    fireEvent.changeText(screen.getByTestId('store-postal-code'), '  21701  ');
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));

    expect(addStoreMock).toHaveBeenCalledTimes(1);
    expect(addStoreMock.mock.calls[0][0]).toEqual({
      name: 'Frederick',
      address: '',
      postalCode: '21701',
      brandId: 'b1',
      status: 'active',
    });
  });

  it('a blank postal code is persisted as NULL, not an empty string (R-4 safe default)', () => {
    open();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Towson'), 'Towson');
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));

    expect(addStoreMock.mock.calls[0][0]).toMatchObject({ name: 'Towson', postalCode: null });
  });

  it('whitespace-only input also clears to NULL', () => {
    open();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Towson'), 'Towson');
    fireEvent.changeText(screen.getByTestId('store-postal-code'), '   ');
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));

    expect(addStoreMock.mock.calls[0][0]).toMatchObject({ postalCode: null });
  });

  it('the postal code is OPTIONAL — it never satisfies or blocks the required-field gate', () => {
    open();
    // Only the ZIP filled: name is still the single required field.
    fireEvent.changeText(screen.getByTestId('store-postal-code'), '21701');
    expect(screen.getByText('0/1 required valid')).toBeTruthy();
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    expect(addStoreMock).not.toHaveBeenCalled();

    fireEvent.changeText(screen.getByPlaceholderText('e.g. Towson'), 'Frederick');
    expect(screen.getByText('1/1 required valid')).toBeTruthy();
  });

  it('reopening the drawer resets the postal code along with the other fields', () => {
    const { rerender } = render(
      <StoreFormDrawer visible brandId="b1" onClose={() => {}} />,
    );
    fireEvent.changeText(screen.getByTestId('store-postal-code'), '21701');
    expect(screen.getByTestId('store-postal-code').props.value).toBe('21701');

    rerender(<StoreFormDrawer visible={false} brandId="b1" onClose={() => {}} />);
    rerender(<StoreFormDrawer visible brandId="b1" onClose={() => {}} />);

    expect(screen.getByTestId('store-postal-code').props.value).toBe('');
  });

  it('the address field is NOT parsed for the ZIP — the two are independent', () => {
    open();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Towson'), 'Towson');
    fireEvent.changeText(
      screen.getByPlaceholderText('e.g. 1234 York Rd, Towson MD 21204'),
      '1234 York Rd, Towson MD 21204',
    );
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));

    expect(addStoreMock.mock.calls[0][0]).toMatchObject({
      address: '1234 York Rd, Towson MD 21204',
      postalCode: null,
    });
  });
});
