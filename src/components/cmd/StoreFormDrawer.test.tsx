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
  // Spec 155 — the EDIT path delegates to useStore.updateStore, which now
  // resolves true/false and NEVER rejects.
  const updateStore = jest.fn().mockResolvedValue(true);
  const state: any = { addStore, updateStore };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

import React from 'react';
import Toast from 'react-native-toast-message';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { StoreFormDrawer } from './StoreFormDrawer';
import type { Store } from '../../types';

const mod = jest.requireMock('../../store/useStore');
const addStoreMock = mod.useStore.__state.addStore as jest.Mock;
const updateStoreMock = mod.useStore.__state.updateStore as jest.Mock;
const toastShowMock = (Toast as any).show as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  updateStoreMock.mockResolvedValue(true);
});

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

// ── Spec 155 — the shared ZIP validator, on BOTH paths (AC-3) ───────────────
//
// DELIBERATE, spec-authorized delta on the create path (§5.1): create used to
// accept any text, so 'ABCDE' would have been stored and the IDP retailers
// probe could never use it. The validator now gates both modes. It is
// deliberately NOT folded into the `n/1 required valid` counter — that string
// is asserted verbatim above and stays byte-identical.

describe('StoreFormDrawer — shared ZIP validation (spec 155 AC-3)', () => {
  it('an invalid ZIP refuses the CREATE with an inline error and issues NO write', () => {
    open();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Towson'), 'Towson');
    fireEvent.changeText(screen.getByTestId('store-postal-code'), 'ABCDE');
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));

    expect(addStoreMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('store-postal-code-error')).toBeTruthy();
    // The required-field counter is untouched by ZIP validity.
    expect(screen.getByText('1/1 required valid')).toBeTruthy();
  });

  it('editing the ZIP clears the inline error, and a corrected value saves', () => {
    open();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Towson'), 'Towson');
    fireEvent.changeText(screen.getByTestId('store-postal-code'), '2120');
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    expect(screen.getByTestId('store-postal-code-error')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('store-postal-code'), '21204');
    expect(screen.queryByTestId('store-postal-code-error')).toBeNull();

    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    expect(addStoreMock).toHaveBeenCalledTimes(1);
    expect(addStoreMock.mock.calls[0][0]).toMatchObject({ postalCode: '21204' });
  });

  it('ZIP+4 is accepted on the create path and stored verbatim (OQ-7)', () => {
    open();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Towson'), 'Towson');
    fireEvent.changeText(screen.getByTestId('store-postal-code'), '21204-1234');
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));

    expect(addStoreMock.mock.calls[0][0]).toMatchObject({ postalCode: '21204-1234' });
  });
});

// ── Spec 155 — EDIT mode (AC-1, AC-4, AC-6) ─────────────────────────────────
//
// Until this spec there was NO way to set stores.postal_code on an existing
// store, so every store in prod has a null ZIP. The ★ hazard the design calls
// out: a save that updates local Zustand state but never reaches PostgREST is
// a silent fake success with no visible symptom, which is why the write is
// asserted on the action seam here AND on db.updateStore in the store suite.

const EXISTING: Store = {
  id: 'store-7',
  brandId: 'b1',
  name: 'Towson',
  address: '1234 York Rd',
  status: 'active',
  postalCode: '21204',
};

const openEdit = (over: Partial<Store> = {}, onSaved?: jest.Mock, onClose?: jest.Mock) =>
  render(
    <StoreFormDrawer
      visible
      brandId="b1"
      brandName="2AM PROJECT"
      store={{ ...EXISTING, ...over }}
      onSaved={onSaved}
      onClose={onClose ?? (() => {})}
    />,
  );

describe('StoreFormDrawer — edit mode (spec 155 AC-1)', () => {
  it('prefills name / address / postal code from the supplied store', () => {
    openEdit();
    expect(screen.getByPlaceholderText('e.g. Towson').props.value).toBe('Towson');
    expect(screen.getByPlaceholderText('e.g. 1234 York Rd, Towson MD 21204').props.value).toBe(
      '1234 York Rd',
    );
    expect(screen.getByTestId('store-postal-code').props.value).toBe('21204');
  });

  it('renders the EDIT badge, the store name, and a SAVE primary', () => {
    openEdit();
    expect(screen.getByText('EDIT')).toBeTruthy();
    expect(screen.queryByText('NEW')).toBeNull();
    expect(screen.getByText('Towson')).toBeTruthy();
    expect(screen.getByText('SAVE  ⌘⏎')).toBeTruthy();
    expect(screen.queryByText('CREATE  ⌘⏎')).toBeNull();
  });

  it('a store with no ZIP yet renders an empty field (the prod state DG-2 exists for)', () => {
    openEdit({ postalCode: null });
    expect(screen.getByTestId('store-postal-code').props.value).toBe('');
  });

  it('re-opening on a DIFFERENT row re-seeds the fields', () => {
    const { rerender } = openEdit();
    expect(screen.getByTestId('store-postal-code').props.value).toBe('21204');

    rerender(
      <StoreFormDrawer
        visible
        brandId="b1"
        store={{ ...EXISTING, id: 'store-8', name: 'Frederick', postalCode: '21701' }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByPlaceholderText('e.g. Towson').props.value).toBe('Frederick');
    expect(screen.getByTestId('store-postal-code').props.value).toBe('21701');
  });
});

describe('StoreFormDrawer — edit save (spec 155 AC-4 / AC-6)', () => {
  it('★ saves through useStore.updateStore EXACTLY ONCE with the ZIP (AC-4)', async () => {
    const onSaved = jest.fn();
    const onClose = jest.fn();
    openEdit({ postalCode: null }, onSaved, onClose);

    fireEvent.changeText(screen.getByTestId('store-postal-code'), '  21204  ');
    fireEvent.press(screen.getByText('SAVE  ⌘⏎'));

    await waitFor(() => expect(updateStoreMock).toHaveBeenCalledTimes(1));
    expect(updateStoreMock).toHaveBeenCalledWith('store-7', {
      name: 'Towson',
      address: '1234 York Rd',
      postalCode: '21204',
    });
    // addStore is NEVER touched in edit mode.
    expect(addStoreMock).not.toHaveBeenCalled();

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledWith({
      id: 'store-7',
      name: 'Towson',
      address: '1234 York Rd',
      postalCode: '21204',
    });
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text1: 'Saved store' }),
    );
  });

  it('clearing the ZIP writes NULL, not an empty string', async () => {
    openEdit();
    fireEvent.changeText(screen.getByTestId('store-postal-code'), '   ');
    fireEvent.press(screen.getByText('SAVE  ⌘⏎'));

    await waitFor(() => expect(updateStoreMock).toHaveBeenCalledTimes(1));
    expect(updateStoreMock.mock.calls[0][1]).toMatchObject({ postalCode: null });
  });

  it('an invalid ZIP refuses the save: inline error, ZERO updateStore calls', () => {
    openEdit();
    fireEvent.changeText(screen.getByTestId('store-postal-code'), '21204 1234');
    fireEvent.press(screen.getByText('SAVE  ⌘⏎'));

    expect(updateStoreMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('store-postal-code-error')).toBeTruthy();
  });

  it('a REFUSED write keeps the drawer open with the input intact and does not toast success (AC-6)', async () => {
    const onSaved = jest.fn();
    const onClose = jest.fn();
    // updateStore resolves FALSE after its own revert + notifyBackendError.
    updateStoreMock.mockResolvedValue(false);
    openEdit({}, onSaved, onClose);

    fireEvent.changeText(screen.getByTestId('store-postal-code'), '21701');
    fireEvent.press(screen.getByText('SAVE  ⌘⏎'));

    await waitFor(() => expect(updateStoreMock).toHaveBeenCalledTimes(1));
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(toastShowMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ text1: 'Saved store' }),
    );
    // The operator's input survives so they can retry.
    expect(screen.getByTestId('store-postal-code').props.value).toBe('21701');
  });
});
