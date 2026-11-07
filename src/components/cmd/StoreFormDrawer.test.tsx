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
  // Spec 184 D-10 — resolves the real id, or null on failure. Never rejects.
  const addStore = jest.fn().mockResolvedValue('new-id');
  // Spec 155 — the EDIT path delegates to useStore.updateStore, which now
  // resolves true/false and NEVER rejects.
  const updateStore = jest.fn().mockResolvedValue(true);
  // Spec 184 — the create-mode preview. No sources by default, so the `n/2` strings
  // below stay byte-identical.
  const loadStoreStockPreview = jest.fn().mockResolvedValue({ sources: [], uncarried: [] });
  const stockStoreFromStore = jest.fn().mockResolvedValue(null);
  const state: any = { addStore, updateStore, loadStoreStockPreview, stockStoreFromStore };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

import React from 'react';
import Toast from 'react-native-toast-message';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';
import { StoreFormDrawer } from './StoreFormDrawer';
import type { Store } from '../../types';

const mod = jest.requireMock('../../store/useStore');
const addStoreMock = mod.useStore.__state.addStore as jest.Mock;
const updateStoreMock = mod.useStore.__state.updateStore as jest.Mock;
const previewMock = mod.useStore.__state.loadStoreStockPreview as jest.Mock;
const stockMock = mod.useStore.__state.stockStoreFromStore as jest.Mock;
const toastShowMock = (Toast as any).show as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  updateStoreMock.mockResolvedValue(true);
  addStoreMock.mockResolvedValue('new-id');
  previewMock.mockResolvedValue({ sources: [], uncarried: [] });
  stockMock.mockResolvedValue(null);
});

// Lets the preview, and anything a press awaited, settle.
const settle = () => act(async () => {});

// Spec 184 — CREATE stays disabled until the preview settles, so `open` waits for it.
const open = async () => {
  const utils = render(<StoreFormDrawer visible brandId="b1" brandName="2AM PROJECT" onClose={() => {}} />);
  await settle();
  return utils;
};

// Spec 162 (rev 2) — the ADDRESS joined the name as a required field, because
// it is the shipping address the cart-filler's auto-place picker offers. Tests
// below that only care about the ZIP fill both, so a required-field change
// can't masquerade as a ZIP regression.
const fillRequired = (name = 'Towson', address = '1234 York Rd, Towson MD 21204') => {
  fireEvent.changeText(screen.getByPlaceholderText('e.g. Towson'), name);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 1234 York Rd, Towson MD 21204'), address);
};

describe('StoreFormDrawer — postal code (spec 149 §7.6)', () => {
  it('renders the optional postal-code field, empty by default', async () => {
    await open();
    const input = screen.getByTestId('store-postal-code');
    expect(input.props.value).toBe('');
    expect(screen.getByText('Postal code (optional)')).toBeTruthy();
  });

  it('a filled postal code reaches addStore trimmed', async () => {
    await open();
    fillRequired('Frederick', '2339 Frederick Ave, Baltimore MD 21223');
    fireEvent.changeText(screen.getByTestId('store-postal-code'), '  21701  ');
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));

    expect(addStoreMock).toHaveBeenCalledTimes(1);
    expect(addStoreMock.mock.calls[0][0]).toEqual({
      name: 'Frederick',
      address: '2339 Frederick Ave, Baltimore MD 21223',
      postalCode: '21701',
      brandId: 'b1',
      status: 'active',
    });
  });

  it('a blank postal code is persisted as NULL, not an empty string (R-4 safe default)', async () => {
    await open();
    fillRequired();
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));

    expect(addStoreMock.mock.calls[0][0]).toMatchObject({ name: 'Towson', postalCode: null });
  });

  it('whitespace-only input also clears to NULL', async () => {
    await open();
    fillRequired();
    fireEvent.changeText(screen.getByTestId('store-postal-code'), '   ');
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));

    expect(addStoreMock.mock.calls[0][0]).toMatchObject({ postalCode: null });
  });

  it('the postal code is OPTIONAL — it never satisfies or blocks the required-field gate', async () => {
    await open();
    // Only the ZIP filled: it satisfies neither required field.
    fireEvent.changeText(screen.getByTestId('store-postal-code'), '21701');
    expect(screen.getByText('0/2 required valid')).toBeTruthy();
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    expect(addStoreMock).not.toHaveBeenCalled();

    // Spec 162 (rev 2) — the name alone no longer opens the gate; the address
    // is the second required field, and the ZIP is still not either of them.
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Towson'), 'Frederick');
    expect(screen.getByText('1/2 required valid')).toBeTruthy();
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    expect(addStoreMock).not.toHaveBeenCalled();

    fireEvent.changeText(
      screen.getByPlaceholderText('e.g. 1234 York Rd, Towson MD 21204'),
      '2339 Frederick Ave, Baltimore MD 21223',
    );
    expect(screen.getByText('2/2 required valid')).toBeTruthy();
  });

  it('reopening the drawer resets the postal code along with the other fields', async () => {
    const { rerender } = render(
      <StoreFormDrawer visible brandId="b1" onClose={() => {}} />,
    );
    await settle();
    fireEvent.changeText(screen.getByTestId('store-postal-code'), '21701');
    expect(screen.getByTestId('store-postal-code').props.value).toBe('21701');

    rerender(<StoreFormDrawer visible={false} brandId="b1" onClose={() => {}} />);
    rerender(<StoreFormDrawer visible brandId="b1" onClose={() => {}} />);
    await settle();

    expect(screen.getByTestId('store-postal-code').props.value).toBe('');
  });

  it('the address field is NOT parsed for the ZIP — the two are independent', async () => {
    await open();
    fillRequired();
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));

    expect(addStoreMock.mock.calls[0][0]).toMatchObject({
      address: '1234 York Rd, Towson MD 21204',
      postalCode: null,
    });
  });
});

// ── Spec 162 (rev 2) — the address is REQUIRED ─────────────────────────────
//
// It stopped being decoration the moment the cart-filler extension started
// offering store addresses as the shipping target for an auto-placed BJ's
// order: a blank address means that store simply cannot be ordered for. The DB
// constraint (`stores_address_present`, NOT VALID) is the backstop; this gate
// is what the operator actually sees, and it matters most on the EDIT path,
// where a grandfathered addressless store would otherwise hit an opaque
// constraint error on a save that only touched the name.

describe('StoreFormDrawer — the address is required (spec 162 rev 2)', () => {
  it('refuses a CREATE with a name but no address', async () => {
    await open();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Towson'), 'Towson');
    expect(screen.getByText('1/2 required valid')).toBeTruthy();
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    expect(addStoreMock).not.toHaveBeenCalled();
  });

  it('refuses a whitespace-only address — blank is blank', async () => {
    await open();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Towson'), 'Towson');
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 1234 York Rd, Towson MD 21204'), '   ');
    expect(screen.getByText('1/2 required valid')).toBeTruthy();
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    expect(addStoreMock).not.toHaveBeenCalled();
  });

  it('drops the "(optional)" from the field label', async () => {
    await open();
    expect(screen.queryByText('Address (optional)')).toBeNull();
    expect(screen.getByText('Address')).toBeTruthy();
  });

  it('blocks SAVE on a grandfathered store whose address is blank until one is typed', () => {
    // The prod state the DB constraint grandfathers: a store that predates the
    // requirement. The drawer must force the fix rather than let the write hit
    // the constraint.
    render(
      <StoreFormDrawer
        visible
        brandId="b1"
        onClose={() => {}}
        store={{ id: 's9', name: 'Legacy', address: '', status: 'active', brandId: 'b1' } as Store}
      />,
    );
    expect(screen.getByText('1/2 required valid')).toBeTruthy();
    fireEvent.press(screen.getByText('SAVE  ⌘⏎'));
    expect(updateStoreMock).not.toHaveBeenCalled();

    fireEvent.changeText(
      screen.getByPlaceholderText('e.g. 1234 York Rd, Towson MD 21204'),
      '7000 Reisterstown, Baltimore MD 21215',
    );
    expect(screen.getByText('2/2 required valid')).toBeTruthy();
  });
});

// ── Spec 155 — the shared ZIP validator, on BOTH paths (AC-3) ───────────────
//
// DELIBERATE, spec-authorized delta on the create path (§5.1): create used to
// accept any text, so 'ABCDE' would have been stored and the IDP retailers
// probe could never use it. The validator now gates both modes. It is
// deliberately NOT folded into the `n/2 required valid` counter — that string
// is asserted verbatim above and stays byte-identical.

describe('StoreFormDrawer — shared ZIP validation (spec 155 AC-3)', () => {
  it('an invalid ZIP refuses the CREATE with an inline error and issues NO write', async () => {
    await open();
    fillRequired();
    fireEvent.changeText(screen.getByTestId('store-postal-code'), 'ABCDE');
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));

    expect(addStoreMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('store-postal-code-error')).toBeTruthy();
    // The required-field counter is untouched by ZIP validity.
    expect(screen.getByText('2/2 required valid')).toBeTruthy();
  });

  it('editing the ZIP clears the inline error, and a corrected value saves', async () => {
    await open();
    fillRequired();
    fireEvent.changeText(screen.getByTestId('store-postal-code'), '2120');
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    expect(screen.getByTestId('store-postal-code-error')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('store-postal-code'), '21204');
    expect(screen.queryByTestId('store-postal-code-error')).toBeNull();

    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    expect(addStoreMock).toHaveBeenCalledTimes(1);
    expect(addStoreMock.mock.calls[0][0]).toMatchObject({ postalCode: '21204' });
  });

  it('ZIP+4 is accepted on the create path and stored verbatim (OQ-7)', async () => {
    await open();
    fillRequired();
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

// ── Spec 184 — "Stock from" in create mode (AC-38 to AC-43) ────────────────

const source = (over: Record<string, unknown> = {}) => ({
  storeId: 's-towson',
  name: 'Towson',
  status: 'active',
  itemCount: 149,
  itemsToAdd: 149,
  itemsAlreadyAtTarget: 0,
  itemsNoVendorLink: 2,
  carriedElsewhereCount: 1,
  ...over,
});
const STOCK_RESULT = {
  itemsCopied: 149,
  itemsSkipped: 0,
  linksAdded: 150,
  linksSkippedCrossBrand: 0,
  extrasAdded: 0,
  extrasSkipped: 0,
  itemsNoVendorLink: 2,
  targetHasOrderSchedule: false,
  uncarriedRemaining: 4,
};

const openCreate = async (over: { onClose?: jest.Mock; onCreated?: jest.Mock } = {}) => {
  render(
    <StoreFormDrawer
      visible
      brandId="b1"
      brandName="2AM PROJECT"
      onClose={over.onClose ?? (() => {})}
      onCreated={over.onCreated}
    />,
  );
  await settle();
};

const withSources = (uncarried: unknown[] = []) =>
  previewMock.mockResolvedValue({
    sources: [source(), source({ storeId: 's-charles', name: 'Charles', itemCount: 1 })],
    uncarried,
  });

describe('StoreFormDrawer — Stock from (spec 184 AC-38)', () => {
  it('lists the brand stores with their item counts, plus "Don\'t stock yet", with nothing preselected', async () => {
    withSources();
    await openCreate();

    expect(previewMock).toHaveBeenCalledWith('b1');
    expect(screen.getByText('Towson')).toBeTruthy();
    expect(screen.getByText('149 items')).toBeTruthy();
    expect(screen.getByText('1 item')).toBeTruthy();
    expect(screen.getByText('Don’t stock yet')).toBeTruthy();
    for (const id of ['s-towson', 's-charles', 'none']) {
      expect(screen.getByTestId(`store-stock-from-${id}`).props.accessibilityState.selected).toBe(false);
    }
  });

  it('marks an inactive source INACTIVE, like the STOCK dialog does', async () => {
    previewMock.mockResolvedValue({
      sources: [source(), source({ storeId: 's-old', name: 'Old Store', status: 'inactive' })],
      uncarried: [],
    });
    await openCreate();
    expect(screen.getByTestId('store-stock-from-s-old-inactive')).toBeTruthy();
    expect(screen.queryByTestId('store-stock-from-s-towson-inactive')).toBeNull();
    expect(screen.getByTestId('store-stock-from-s-old').props.accessibilityLabel).toBe(
      'Old Store, inactive, 149 items',
    );
  });

  it('counts the choice in the footer, and keeps CREATE disabled until it is made', async () => {
    withSources();
    await openCreate();
    fillRequired();
    expect(screen.getByText('2/3 required valid')).toBeTruthy();

    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    await settle();
    expect(addStoreMock).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('store-stock-from-none'));
    expect(screen.getByText('3/3 required valid')).toBeTruthy();
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    await settle();
    expect(addStoreMock).toHaveBeenCalledTimes(1);
  });

  it('hides the field and stays at n/2 when the brand has no store with items', async () => {
    await openCreate();
    expect(screen.queryByTestId('store-stock-from')).toBeNull();
    fillRequired();
    expect(screen.getByText('2/2 required valid')).toBeTruthy();
  });

  it('keeps CREATE disabled at n/2 while the preview is pending, so a press cannot race the list', async () => {
    let resolve: (v: unknown) => void = () => {};
    previewMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    await openCreate();
    fillRequired();
    expect(screen.getByText('2/2 required valid')).toBeTruthy();
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    await settle();
    expect(addStoreMock).not.toHaveBeenCalled();

    await act(async () => { resolve({ sources: [source()], uncarried: [] }); });
    expect(screen.getByText('2/3 required valid')).toBeTruthy();
  });

  it('a failed preview hides the field, says to use STOCK afterward, and does not block CREATE', async () => {
    previewMock.mockResolvedValue(null);
    await openCreate();
    expect(screen.queryByTestId('store-stock-from')).toBeNull();
    expect(screen.getByTestId('store-stock-preview-failed')).toBeTruthy();
    fillRequired();
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    await settle();
    expect(addStoreMock).toHaveBeenCalledTimes(1);
    expect(stockMock).not.toHaveBeenCalled();
  });

  it('edit mode is unchanged: no preview read and no field', async () => {
    withSources();
    openEdit();
    await settle();
    expect(previewMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('store-stock-from')).toBeNull();
    expect(screen.getByText('2/2 required valid')).toBeTruthy();
  });

  it('copy does not imply the full catalog', async () => {
    withSources();
    await openCreate();
    const texts = screen.UNSAFE_root.findAllByType(require('react-native').Text)
      .map((t: any) => [].concat(t.props.children).join(''));
    expect(texts.join(' ')).not.toMatch(/\b(full|whole|entire|complete|fully|everything)\b/i);
  });
});

describe('StoreFormDrawer — create sequencing (spec 184 AC-39 to AC-43)', () => {
  it('AC-40: a failed insert keeps the drawer open with input intact, no toast, and no stock call', async () => {
    withSources();
    addStoreMock.mockResolvedValue(null);
    const onClose = jest.fn();
    const onCreated = jest.fn();
    await openCreate({ onClose, onCreated });
    fillRequired('Canton');
    fireEvent.press(screen.getByTestId('store-stock-from-s-towson'));
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    await settle();

    expect(stockMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(toastShowMock).not.toHaveBeenCalledWith(expect.objectContaining({ text1: 'Created store' }));
    expect(screen.getByPlaceholderText('e.g. Towson').props.value).toBe('Canton');
  });

  it('AC-40: the success toast waits for the insert to resolve', async () => {
    let resolve: (v: string) => void = () => {};
    addStoreMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    await openCreate();
    fillRequired('Canton');
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    await settle();
    expect(toastShowMock).not.toHaveBeenCalled();

    await act(async () => { resolve('new-id'); });
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text1: 'Created store', text2: 'Canton' }),
    );
  });

  it('AC-42: stocks with the REAL id and reports the result', async () => {
    withSources();
    stockMock.mockResolvedValue(STOCK_RESULT);
    const onClose = jest.fn();
    const onCreated = jest.fn();
    await openCreate({ onClose, onCreated });
    fillRequired('Canton');
    fireEvent.press(screen.getByTestId('store-stock-from-s-towson'));
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    await settle();

    expect(stockMock).toHaveBeenCalledTimes(1);
    expect(stockMock).toHaveBeenCalledWith('new-id', 's-towson');
    expect(onCreated).toHaveBeenCalledWith({
      storeId: 'new-id',
      storeName: 'Canton',
      sourceName: 'Towson',
      result: STOCK_RESULT,
      stockFailed: false,
      canStockLater: true,
      uncarriedCount: 4,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('AC-41: created but not stocked closes the drawer and reports the failure', async () => {
    withSources();
    stockMock.mockResolvedValue(null);
    const onClose = jest.fn();
    const onCreated = jest.fn();
    await openCreate({ onClose, onCreated });
    fillRequired('Canton');
    fireEvent.press(screen.getByTestId('store-stock-from-s-towson'));
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    await settle();

    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: 'new-id', result: null, stockFailed: true }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('AC-39: "Don\'t stock yet" reports the preview\'s uncarried count and runs no stock', async () => {
    withSources([{ catalogId: 'c1' }, { catalogId: 'c2' }]);
    const onCreated = jest.fn();
    await openCreate({ onCreated });
    fillRequired('Canton');
    fireEvent.press(screen.getByTestId('store-stock-from-none'));
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    await settle();

    expect(stockMock).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ sourceName: null, result: null, stockFailed: false, uncarriedCount: 2 }),
    );
    // AC-39 — the list itself is not in the drawer.
    expect(screen.queryByTestId('stock-uncarried')).toBeNull();
  });

  it('a brand with no store to copy from reports canStockLater false', async () => {
    previewMock.mockResolvedValue({ sources: [], uncarried: [{ catalogId: 'c1' }] });
    const onCreated = jest.fn();
    await openCreate({ onCreated });
    fillRequired('Canton');
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    await settle();
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ canStockLater: false }));
  });

  it('AC-43: CANCEL is inert while the create is in flight, and a second press sends nothing', async () => {
    let resolve: (v: string) => void = () => {};
    addStoreMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    const onClose = jest.fn();
    await openCreate({ onClose });
    fillRequired('Canton');
    fireEvent.press(screen.getByText('CREATE  ⌘⏎'));
    await settle();

    fireEvent.press(screen.getByText('CANCEL'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText('SAVING…'));
    expect(addStoreMock).toHaveBeenCalledTimes(1);

    await act(async () => { resolve('new-id'); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
