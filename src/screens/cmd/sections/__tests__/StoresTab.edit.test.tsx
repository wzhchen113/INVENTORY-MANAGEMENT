// src/screens/cmd/sections/__tests__/StoresTab.edit.test.tsx
//
// Spec 155 DG-2 (AC-2, AC-5, AC-7 / AC-22 jest track) — the EDIT affordance
// added to BrandsSection.StoresTab, which is the ONLY store-management surface
// in the app and, until this spec, offered exactly one action per row
// (ACTIVATE / DEACTIVATE). Without it there is no way to set
// `stores.postal_code` on a store that already exists.
//
// What is pinned here:
//   (a) every row renders `store-edit-<id>` with a per-row a11y label and a
//       hitSlop that lifts the affordance to a ≥44×44 effective target;
//   (b) pressing it opens the drawer in EDIT mode with THAT row's store — the
//       create drawer stays closed and keeps its own separate state;
//   (c) the drawer's `onSaved` patches the row in place (AC-5), and
//   (d) `refresh()` runs AFTER the resolved write — the deterministic sequence
//       the design substituted for the `[refresh, drawerOpen]` effect, whose
//       refetch would race the in-flight PATCH (the spec-094 race).
//
// The sibling StoresTab.toggle.test.tsx must stay green UNMODIFIED (AC-2); this
// file mirrors its boundary mocking, except that StoreFormDrawer is replaced by
// a LIGHT probe (rather than null-stubbed) so the props the tab hands it can be
// asserted and `onSaved` can be driven.

// ── Mocks (must precede any import of the component) ────────────────

jest.mock('../../../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#FFFFFF', panel: '#F4F4F4', panel2: '#EAEAEA', border: '#CCCCCC',
    borderStrong: '#888888', fg: '#000000', fg2: '#444444', fg3: '#888888',
    accent: '#185FA5', accentBg: '#E6F1FB', accentFg: '#FFFFFF',
    warn: '#854F0B', warnBg: '#FAEEDA', danger: '#791F1F', dangerBg: '#FCEBEB',
    ok: '#3B6D11', okBg: '#EAF3DE', info: '#185FA5', infoBg: '#E6F1FB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

jest.mock('../../../../hooks/useT', () => ({
  useT: () => (key: string) => key,
}));

jest.mock('../../../../utils/confirmAction', () => ({
  confirmAction: jest.fn(),
}));

const mockFetchStoresIncludingInactive = jest.fn(async () => [] as any[]);
jest.mock('../../../../lib/db', () => ({
  fetchStoresIncludingInactive: () => mockFetchStoresIncludingInactive(),
}));

const mockUpdateStore = jest.fn(async () => true);
jest.mock('../../../../store/useStore', () => {
  const state: any = { updateStore: (...a: any[]) => mockUpdateStore(...(a as [])) };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  return { useStore: fn };
});

// A LIGHT probe for the drawer: records the props it was handed and exposes
// the save/close callbacks so the test can drive the post-write sequence
// without mounting the real (auth/db-consuming) drawer.
const drawerProps: any[] = [];
jest.mock('../../../../components/cmd/StoreFormDrawer', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    StoreFormDrawer: (props: any) => {
      drawerProps.push(props);
      if (!props.visible) return null;
      return React.createElement(View, {
        testID: props.store ? `drawer-edit-${props.store.id}` : 'drawer-create',
      });
    },
  };
});

jest.mock('../../../../lib/supabase', () => ({
  supabase: { from: jest.fn(), auth: {}, rpc: jest.fn() },
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

// ── Imports (resolve mocks above) ───────────────────────────────────
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';
import { StoresTab } from '../BrandsSection';

const BRAND_ID = 'brand-1';

type StoreRow = {
  id: string;
  brandId: string;
  name: string;
  address: string;
  status: 'active' | 'inactive';
  postalCode?: string | null;
};

function row(over: Partial<StoreRow> = {}): StoreRow {
  return {
    id: over.id ?? 'store-1',
    brandId: over.brandId ?? BRAND_ID,
    name: over.name ?? 'Downtown',
    address: over.address ?? '123 Main St',
    status: over.status ?? 'active',
    postalCode: over.postalCode ?? null,
  };
}

async function renderTab(rows: StoreRow[]) {
  mockFetchStoresIncludingInactive.mockResolvedValue(rows);
  render(<StoresTab brandId={BRAND_ID} brandName="2AM" />);
  if (rows.length) await screen.findByText(rows[0].name);
  else await waitFor(() => expect(mockFetchStoresIncludingInactive).toHaveBeenCalled());
}

/** The most recent props the (mocked) drawer received in EDIT mode. */
const lastEditDrawer = () => drawerProps.filter((p) => p.store).slice(-1)[0];

beforeEach(() => {
  jest.clearAllMocks();
  drawerProps.length = 0;
  mockUpdateStore.mockResolvedValue(true);
  mockFetchStoresIncludingInactive.mockResolvedValue([]);
});

// ── AC-2 — the affordance ───────────────────────────────────────────

describe('StoresTab EDIT affordance (spec 155 AC-2)', () => {
  it('renders one EDIT control per row, with a per-row a11y label', async () => {
    await renderTab([
      row({ id: 'store-1', name: 'Downtown' }),
      row({ id: 'store-2', name: 'Uptown', status: 'inactive' }),
    ]);

    expect(screen.getByTestId('store-edit-store-1')).toBeTruthy();
    expect(screen.getByTestId('store-edit-store-2')).toBeTruthy();
    expect(screen.getByLabelText('Edit store Downtown')).toBeTruthy();
    expect(screen.getByLabelText('Edit store Uptown')).toBeTruthy();
  });

  it('carries a hitSlop that lifts the control to a ≥44×44 effective target', async () => {
    await renderTab([row({ id: 'store-1' })]);
    expect(screen.getByTestId('store-edit-store-1').props.hitSlop).toEqual({
      top: 11, bottom: 11, left: 8, right: 8,
    });
  });

  it('leaves the ACTIVATE/DEACTIVATE affordance and the row content alone (AC-REG)', async () => {
    await renderTab([row({ id: 'store-1', name: 'Downtown', status: 'active' })]);

    expect(screen.getByLabelText('Deactivate store Downtown')).toBeTruthy();
    expect(screen.getByText('ACTIVE')).toBeTruthy();
    expect(screen.getByText('123 Main St')).toBeTruthy();
  });
});

// ── AC-2 / AC-1 — opening the drawer for the right row ──────────────

describe('StoresTab EDIT → drawer wiring', () => {
  it('is closed until pressed, and the create drawer keeps its OWN state', async () => {
    await renderTab([row({ id: 'store-1' })]);

    // Both drawer instances mount; neither is visible.
    expect(screen.queryByTestId('drawer-create')).toBeNull();
    expect(screen.queryByTestId('drawer-edit-store-1')).toBeNull();

    fireEvent.press(screen.getByText('+ NEW STORE'));
    expect(screen.getByTestId('drawer-create')).toBeTruthy();
    // Opening CREATE never opens EDIT.
    expect(screen.queryByTestId('drawer-edit-store-1')).toBeNull();
  });

  it('opens the drawer in edit mode with THAT row\'s store', async () => {
    await renderTab([
      row({ id: 'store-1', name: 'Downtown', postalCode: null }),
      row({ id: 'store-2', name: 'Uptown', postalCode: '21701' }),
    ]);

    fireEvent.press(screen.getByTestId('store-edit-store-2'));

    expect(screen.getByTestId('drawer-edit-store-2')).toBeTruthy();
    const props = lastEditDrawer();
    expect(props.visible).toBe(true);
    expect(props.store).toMatchObject({ id: 'store-2', name: 'Uptown', postalCode: '21701' });
    expect(props.brandId).toBe(BRAND_ID);
    // The create drawer is untouched.
    expect(screen.queryByTestId('drawer-create')).toBeNull();
  });

  it('closing the edit drawer does NOT re-fetch (the create-drawer effect is not involved)', async () => {
    await renderTab([row({ id: 'store-1' })]);
    expect(mockFetchStoresIncludingInactive).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByTestId('store-edit-store-1'));
    await act(async () => { lastEditDrawer().onClose(); });

    // Cancelling an edit costs no round-trip — and, critically, cannot race an
    // in-flight PATCH the way a close-keyed refetch would (spec-094).
    expect(mockFetchStoresIncludingInactive).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('drawer-edit-store-1')).toBeNull();
  });
});

// ── AC-5 / AC-7 — the post-write sequence ───────────────────────────

describe('StoresTab EDIT → onSaved (spec 155 AC-5 / AC-7)', () => {
  it('patches the row in place and re-reads AFTER the resolved write', async () => {
    await renderTab([row({ id: 'store-1', name: 'Downtown', address: '123 Main St' })]);
    expect(mockFetchStoresIncludingInactive).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByTestId('store-edit-store-1'));

    // The reconciling re-read returns the server's view of the saved row.
    mockFetchStoresIncludingInactive.mockResolvedValueOnce([
      row({ id: 'store-1', name: 'Downtown HQ', address: '9 Elm', postalCode: '21204' }),
    ]);

    await act(async () => {
      lastEditDrawer().onSaved({
        id: 'store-1', name: 'Downtown HQ', address: '9 Elm', postalCode: '21204',
      });
    });

    // (c) the row shows the saved values with no manual reload …
    await waitFor(() => expect(screen.getByText('Downtown HQ')).toBeTruthy());
    expect(screen.getByText('9 Elm')).toBeTruthy();
    // … and (d) the authoritative re-read ran.
    expect(mockFetchStoresIncludingInactive).toHaveBeenCalledTimes(2);
  });

  it('an RLS 0-row no-op snaps the row back to the server value (no fake success)', async () => {
    await renderTab([row({ id: 'store-1', name: 'Downtown' })]);

    fireEvent.press(screen.getByTestId('store-edit-store-1'));
    // PostgREST returns 204 for a PATCH that matched nothing, so the re-read
    // still carries the PRE-edit name.
    mockFetchStoresIncludingInactive.mockResolvedValueOnce([row({ id: 'store-1', name: 'Downtown' })]);

    await act(async () => {
      lastEditDrawer().onSaved({
        id: 'store-1', name: 'Renamed', address: '123 Main St', postalCode: '21204',
      });
    });

    await waitFor(() => expect(screen.getByText('Downtown')).toBeTruthy());
    expect(screen.queryByText('Renamed')).toBeNull();
  });

  it('a failed re-read toasts instead of throwing', async () => {
    const Toast = require('react-native-toast-message').default;
    await renderTab([row({ id: 'store-1' })]);

    fireEvent.press(screen.getByTestId('store-edit-store-1'));
    mockFetchStoresIncludingInactive.mockRejectedValueOnce(new Error('network down'));

    await act(async () => {
      lastEditDrawer().onSaved({
        id: 'store-1', name: 'Downtown', address: '123 Main St', postalCode: null,
      });
    });

    await waitFor(() =>
      expect(Toast.show).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', text1: 'Could not load stores' }),
      ),
    );
  });
});
