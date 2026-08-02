// src/components/cmd/VendorFormDrawer.test.tsx — Spec 115 (W-2, AC-10) render smoke.
//
// Feature-level verification (not just typecheck) of the vendor order-unit control:
//   1. a NEW vendor's order-unit control renders both options and DEFAULTS to
//      Cases (R-2 — the safe default).
//   2. toggling to "Counted units" and saving threads `orderUnit: 'unit'` through
//      the store's `addVendor` call.
//   3. EDIT mode prefills the saved `orderUnit` and reopening shows it.
//
// Boundary mocking mirrors InviteUserDrawer.test.tsx: theme/colors + breakpoints
// pinned, ResponsiveSheet bypassed to render the body inline, useStore a mutable
// snapshot exposing add/updateVendor spies. `useT` is NOT mocked — the real i18n
// catalog resolves the control labels (AC-20 coverage as a bonus).

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
  const addVendor = jest.fn();
  const updateVendor = jest.fn();
  const state: any = { addVendor, updateVendor };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { VendorFormDrawer } from './VendorFormDrawer';
import type { Vendor } from '../../types';

const mod = jest.requireMock('../../store/useStore');
const addVendorMock = mod.useStore.__state.addVendor as jest.Mock;
const updateVendorMock = mod.useStore.__state.updateVendor as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('VendorFormDrawer — order-unit control (spec 115 W-2)', () => {
  it('a NEW vendor renders both order-unit options and defaults to Cases', () => {
    render(<VendorFormDrawer visible mode="new" onClose={() => {}} />);
    // Both segment options present (real i18n labels).
    expect(screen.getByTestId('vendor-order-unit-case')).toBeTruthy();
    expect(screen.getByTestId('vendor-order-unit-unit')).toBeTruthy();
    expect(screen.getByText('Cases')).toBeTruthy();
    expect(screen.getByText('Counted units')).toBeTruthy();
    // Default is 'case' — the Cases segment reports selected.
    expect(screen.getByTestId('vendor-order-unit-case').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('vendor-order-unit-unit').props.accessibilityState).toEqual({ selected: false });
  });

  it('a NEW vendor saved with the default passes orderUnit:"case" through addVendor', () => {
    render(<VendorFormDrawer visible mode="new" onClose={() => {}} />);
    fireEvent.changeText(screen.getByPlaceholderText('BJs Wholesale'), 'Acme Foods');
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    expect(addVendorMock).toHaveBeenCalledTimes(1);
    expect(addVendorMock.mock.calls[0][0]).toMatchObject({ name: 'Acme Foods', orderUnit: 'case' });
  });

  it('toggling to Counted units and saving threads orderUnit:"unit" through addVendor', () => {
    render(<VendorFormDrawer visible mode="new" onClose={() => {}} />);
    fireEvent.changeText(screen.getByPlaceholderText('BJs Wholesale'), 'Unit Vendor');
    fireEvent.press(screen.getByTestId('vendor-order-unit-unit'));
    // The unit segment now reports selected.
    expect(screen.getByTestId('vendor-order-unit-unit').props.accessibilityState).toEqual({ selected: true });
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    expect(addVendorMock.mock.calls[0][0]).toMatchObject({ name: 'Unit Vendor', orderUnit: 'unit' });
  });

  it('EDIT mode prefills the saved orderUnit ("unit") and saves it back through updateVendor', () => {
    const vendor: Vendor = {
      id: 'v1', brandId: 'b1', name: 'Existing', contactName: '', phone: '', email: '',
      accountNumber: '', leadTimeDays: 1, deliveryDays: [], categories: [], orderUnit: 'unit',
      extensionOrdering: false, orderPageUrl: null,
    };
    render(<VendorFormDrawer visible mode="edit" vendor={vendor} onClose={() => {}} />);
    // Prefilled to 'unit'.
    expect(screen.getByTestId('vendor-order-unit-unit').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('vendor-order-unit-case').props.accessibilityState).toEqual({ selected: false });
    // Flip back to Cases and save.
    fireEvent.press(screen.getByTestId('vendor-order-unit-case'));
    fireEvent.press(screen.getByText('SAVE  ⌘S'));
    expect(updateVendorMock).toHaveBeenCalledTimes(1);
    expect(updateVendorMock.mock.calls[0][1]).toMatchObject({ orderUnit: 'case' });
  });
});

describe('VendorFormDrawer — extension-ordering opt-in + order page URL (spec 131)', () => {
  it('a NEW vendor defaults the extension-ordering toggle OFF and hides the URL field', () => {
    render(<VendorFormDrawer visible mode="new" onClose={() => {}} />);
    // Toggle present and OFF by default (opt-in is OFF per blank()).
    const toggle = screen.getByTestId('vendor-extension-ordering-toggle');
    expect(toggle.props.accessibilityState).toEqual({ checked: false });
    // The URL field is gated behind the toggle → not rendered while OFF.
    expect(screen.queryByPlaceholderText('https://www.samsclub.com/orders')).toBeNull();
  });

  it('toggling extension-ordering ON reveals the URL field and threads both through addVendor', () => {
    render(<VendorFormDrawer visible mode="new" onClose={() => {}} />);
    fireEvent.changeText(screen.getByPlaceholderText('BJs Wholesale'), 'Sams Vendor');
    fireEvent.press(screen.getByTestId('vendor-extension-ordering-toggle'));
    expect(screen.getByTestId('vendor-extension-ordering-toggle').props.accessibilityState).toEqual({ checked: true });
    // URL field now present; fill it and save.
    fireEvent.changeText(screen.getByPlaceholderText('https://www.samsclub.com/orders'), 'https://www.samsclub.com/orders');
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    expect(addVendorMock.mock.calls[0][0]).toMatchObject({
      name: 'Sams Vendor',
      extensionOrdering: true,
      orderPageUrl: 'https://www.samsclub.com/orders',
    });
  });

  it('EDIT mode prefills the toggle ON and the saved order page URL (round-trip)', () => {
    const vendor: Vendor = {
      id: 'v2', brandId: 'b1', name: 'Existing Sams', contactName: '', phone: '', email: '',
      accountNumber: '', leadTimeDays: 1, deliveryDays: [], categories: [], orderUnit: 'case',
      extensionOrdering: true, orderPageUrl: 'https://www.samsclub.com/orders',
    };
    render(<VendorFormDrawer visible mode="edit" vendor={vendor} onClose={() => {}} />);
    // Toggle prefilled ON.
    expect(screen.getByTestId('vendor-extension-ordering-toggle').props.accessibilityState).toEqual({ checked: true });
    // The URL field is visible (toggle ON) and shows the saved value.
    expect(screen.getByDisplayValue('https://www.samsclub.com/orders')).toBeTruthy();
    // Saving without touching anything writes both values back unchanged.
    fireEvent.press(screen.getByText('SAVE  ⌘S'));
    expect(updateVendorMock).toHaveBeenCalledTimes(1);
    expect(updateVendorMock.mock.calls[0][1]).toMatchObject({
      extensionOrdering: true,
      orderPageUrl: 'https://www.samsclub.com/orders',
    });
  });

  it('EDIT mode with the toggle OFF hides the URL field even when a URL is stored', () => {
    const vendor: Vendor = {
      id: 'v3', brandId: 'b1', name: 'Opted Out', contactName: '', phone: '', email: '',
      accountNumber: '', leadTimeDays: 1, deliveryDays: [], categories: [], orderUnit: 'case',
      extensionOrdering: false, orderPageUrl: 'https://www.samsclub.com/orders',
    };
    render(<VendorFormDrawer visible mode="edit" vendor={vendor} onClose={() => {}} />);
    expect(screen.getByTestId('vendor-extension-ordering-toggle').props.accessibilityState).toEqual({ checked: false });
    // URL field hidden while OFF, even though the stored value is non-empty.
    expect(screen.queryByPlaceholderText('https://www.samsclub.com/orders')).toBeNull();
  });
});

// ─── Spec 149 (§7.6 / AC-14) — ORDER CHANNEL + INSTACART RETAILER KEY ────────
//
// Added in the spec-149 review round (test-engineer Should-fix 2): the drawer is
// the ONLY surface an operator has to set the two columns AC-14's server-side
// resolution reads, so a field-wiring typo (wrong key in `toUpdates`, wrong
// prefill in `fromVendor`) would ship silently. These pin the wiring in both
// directions, plus the R-3 safe default.
describe('VendorFormDrawer — order channel + Instacart retailer key (spec 149)', () => {
  it('a NEW vendor renders all five channel options and defaults to auto (R-3 safe default)', () => {
    render(<VendorFormDrawer visible mode="new" onClose={() => {}} />);
    // Its own testID prefix — must NOT collide with the order-unit / import-format segments.
    expect(screen.getByTestId('vendor-order-channel-').props.accessibilityState).toEqual({ selected: true });
    for (const v of ['instacart', 'webstaurant', 'extension', 'manual']) {
      expect(screen.getByTestId(`vendor-order-channel-${v}`).props.accessibilityState).toEqual({ selected: false });
    }
    // The retailer key field is Instacart-only → hidden while unset.
    expect(screen.queryByPlaceholderText('sams_club')).toBeNull();
  });

  it('a NEW vendor saved on auto passes orderChannel:null through addVendor (clears the column)', () => {
    render(<VendorFormDrawer visible mode="new" onClose={() => {}} />);
    fireEvent.changeText(screen.getByPlaceholderText('BJs Wholesale'), 'Auto Vendor');
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    expect(addVendorMock.mock.calls[0][0]).toMatchObject({
      name: 'Auto Vendor',
      orderChannel: null,
      instacartRetailerKey: '',
    });
  });

  it('choosing Instacart reveals the retailer key field and threads both through addVendor (trimmed)', () => {
    render(<VendorFormDrawer visible mode="new" onClose={() => {}} />);
    fireEvent.changeText(screen.getByPlaceholderText('BJs Wholesale'), 'Instacart Vendor');
    fireEvent.press(screen.getByTestId('vendor-order-channel-instacart'));
    expect(screen.getByTestId('vendor-order-channel-instacart').props.accessibilityState).toEqual({ selected: true });
    // Field revealed only now.
    fireEvent.changeText(screen.getByPlaceholderText('sams_club'), '  sams_club  ');
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    expect(addVendorMock.mock.calls[0][0]).toMatchObject({
      name: 'Instacart Vendor',
      orderChannel: 'instacart',
      instacartRetailerKey: 'sams_club',
    });
  });

  it('a non-Instacart channel keeps the retailer key field hidden and still persists the channel', () => {
    render(<VendorFormDrawer visible mode="new" onClose={() => {}} />);
    fireEvent.changeText(screen.getByPlaceholderText('BJs Wholesale'), 'Webstaurant Vendor');
    fireEvent.press(screen.getByTestId('vendor-order-channel-webstaurant'));
    expect(screen.queryByPlaceholderText('sams_club')).toBeNull();
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    expect(addVendorMock.mock.calls[0][0]).toMatchObject({ orderChannel: 'webstaurant' });
  });

  it('EDIT mode prefills a stored instacart channel + key and round-trips them through updateVendor', () => {
    const vendor: Vendor = {
      id: 'v4', brandId: 'b1', name: 'Stored Instacart', contactName: '', phone: '', email: '',
      accountNumber: '', leadTimeDays: 1, deliveryDays: [], categories: [], orderUnit: 'case',
      extensionOrdering: false, orderPageUrl: null,
      orderChannel: 'instacart', instacartRetailerKey: 'sams_club',
    };
    render(<VendorFormDrawer visible mode="edit" vendor={vendor} onClose={() => {}} />);
    expect(screen.getByTestId('vendor-order-channel-instacart').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByDisplayValue('sams_club')).toBeTruthy();
    fireEvent.press(screen.getByText('SAVE  ⌘S'));
    expect(updateVendorMock.mock.calls[0][1]).toMatchObject({
      orderChannel: 'instacart',
      instacartRetailerKey: 'sams_club',
    });
  });

  it('EDIT mode: switching back to auto clears the channel to null and hides the key field', () => {
    const vendor: Vendor = {
      id: 'v5', brandId: 'b1', name: 'Stored Instacart', contactName: '', phone: '', email: '',
      accountNumber: '', leadTimeDays: 1, deliveryDays: [], categories: [], orderUnit: 'case',
      extensionOrdering: false, orderPageUrl: null,
      orderChannel: 'instacart', instacartRetailerKey: 'sams_club',
    };
    render(<VendorFormDrawer visible mode="edit" vendor={vendor} onClose={() => {}} />);
    fireEvent.press(screen.getByTestId('vendor-order-channel-'));
    expect(screen.queryByPlaceholderText('sams_club')).toBeNull();
    fireEvent.press(screen.getByText('SAVE  ⌘S'));
    // '' → null: db.ts writes NULL, returning the vendor to extension-flag resolution.
    expect(updateVendorMock.mock.calls[0][1]).toMatchObject({ orderChannel: null });
  });

  it('EDIT mode falls back to auto for an unrecognized stored channel literal', () => {
    const vendor = {
      id: 'v6', brandId: 'b1', name: 'Bogus', contactName: '', phone: '', email: '',
      accountNumber: '', leadTimeDays: 1, deliveryDays: [], categories: [], orderUnit: 'case',
      extensionOrdering: false, orderPageUrl: null,
      orderChannel: 'carrier_pigeon',
    } as unknown as Vendor;
    render(<VendorFormDrawer visible mode="edit" vendor={vendor} onClose={() => {}} />);
    expect(screen.getByTestId('vendor-order-channel-').props.accessibilityState).toEqual({ selected: true });
  });
});
