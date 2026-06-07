// src/screens/cmd/sections/__tests__/StoresTab.toggle.test.tsx
//
// Spec 094 (store-deactivation-toggle) — CRITICAL 1 of the FIXES_NEEDED
// proposal: jest coverage for the inline status toggle wired into
// BrandsSection.StoresTab (toggle wiring ~lines 1097-1113, rows ~1176-1227).
//
// Covers AC1's "reflected on the row" clause and all of AC2:
//   (a) DEACTIVATE routes through confirmAction and, on confirm, calls
//       updateStore(id, { status: 'inactive' }).
//   (b) ACTIVATE does NOT call confirmAction and calls
//       updateStore(id, { status: 'active' }).
//   (c) The row's ACTIVE/INACTIVE StatusPill reflects the optimistic flip.
//
// Boundary mocking follows the sibling section test
// (VendorsSection.test.tsx): theme/useT stubbed to identity-ish values,
// the heavy StoreFormDrawer child nulled, and the data/db/util seams
// (confirmAction, db.fetchStoresIncludingInactive, useStore.updateStore)
// mocked so we exercise ONLY the toggle wiring. StatusPill is left REAL so
// assertion (c) reads the literal ACTIVE / INACTIVE label it renders.

// ── Mocks (must precede any import of the component) ────────────────

jest.mock('../../../../theme/colors', () => ({
  useCmdColors: () => ({
    bg:           '#FFFFFF',
    panel:        '#F4F4F4',
    panel2:       '#EAEAEA',
    border:       '#CCCCCC',
    borderStrong: '#888888',
    fg:           '#000000',
    fg2:          '#444444',
    fg3:          '#888888',
    accent:       '#185FA5',
    accentBg:     '#E6F1FB',
    accentFg:     '#FFFFFF',
    warn:         '#854F0B',
    warnBg:       '#FAEEDA',
    danger:       '#791F1F',
    dangerBg:     '#FCEBEB',
    ok:           '#3B6D11',
    okBg:         '#EAF3DE',
    info:         '#185FA5',
    infoBg:       '#E6F1FB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

jest.mock('../../../../hooks/useT', () => ({
  useT: () => (key: string) => key,
}));

// confirmAction is the gate under test for the deactivate direction. It is a
// fire-and-call helper: it invokes onConfirm synchronously when "confirmed".
// The default implementation here mimics a user clicking the confirm button
// so the optimistic flip + updateStore delegation both fire; individual tests
// override it (e.g. to simulate the user cancelling).
const mockConfirmAction = jest.fn(
  (_title: string, _message: string, onConfirm: () => void, _confirmLabel?: string) => {
    onConfirm();
  },
);
jest.mock('../../../../utils/confirmAction', () => ({
  confirmAction: (...args: any[]) => (mockConfirmAction as any)(...args),
}));

// db.fetchStoresIncludingInactive feeds the tab-local list. Each test seeds
// the rows it wants via mockResolvedValueOnce; default = empty.
const mockFetchStoresIncludingInactive = jest.fn(async () => [] as any[]);
jest.mock('../../../../lib/db', () => ({
  fetchStoresIncludingInactive: () => mockFetchStoresIncludingInactive(),
}));

// useStore — only `updateStore` is consumed by StoresTab. The component reads
// it via `useStore((s) => s.updateStore)`, so the mock honours the selector.
const mockUpdateStore = jest.fn();
jest.mock('../../../../store/useStore', () => {
  const state: any = { updateStore: (...a: any[]) => mockUpdateStore(...a) };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  return { useStore: fn };
});

// StoreFormDrawer is a heavy child (auth/db consumers) and irrelevant to the
// toggle — null-stub it like the sibling section test does for its drawers.
jest.mock('../../../../components/cmd/StoreFormDrawer', () => ({
  StoreFormDrawer: () => null,
}));

// BrandsSection transitively imports InviteAdminDrawer → lib/auth →
// lib/supabase, whose module-load createClient() throws "supabaseUrl is
// required" with no env in jest. Stub the supabase client at the boundary
// (same seam db.ts component tests use) so the import chain resolves; the
// toggle path never touches the real client (db is mocked above).
jest.mock('../../../../lib/supabase', () => ({
  supabase: { from: jest.fn(), auth: {}, rpc: jest.fn() },
}));

// react-native-toast-message — the tab-local fetch error path calls Toast.show;
// stub so a seeded reject doesn't blow up.
jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

// ── Imports (resolve mocks above) ───────────────────────────────────
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { StoresTab } from '../BrandsSection';

const BRAND_ID = 'brand-1';

type StoreRow = {
  id: string;
  brandId: string;
  name: string;
  address: string;
  status: 'active' | 'inactive';
};

function row(over: Partial<StoreRow> = {}): StoreRow {
  return {
    id:      over.id      ?? 'store-1',
    brandId: over.brandId ?? BRAND_ID,
    name:    over.name    ?? 'Downtown',
    address: over.address ?? '123 Main St',
    status:  over.status  ?? 'active',
  };
}

async function renderTab(rows: StoreRow[]) {
  mockFetchStoresIncludingInactive.mockResolvedValueOnce(rows);
  render(<StoresTab brandId={BRAND_ID} brandName="2AM" />);
  // The first row name appears once the mount-effect fetch resolves.
  if (rows.length) {
    await screen.findByText(rows[0].name);
  } else {
    await waitFor(() =>
      expect(mockFetchStoresIncludingInactive).toHaveBeenCalled(),
    );
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmAction.mockImplementation(
    (_t: string, _m: string, onConfirm: () => void) => onConfirm(),
  );
  mockFetchStoresIncludingInactive.mockResolvedValue([]);
});

// ── Tests ───────────────────────────────────────────────────────────

describe('StoresTab inline status toggle (spec 094 AC1 + AC2)', () => {
  it('loads the include-inactive list and renders the ACTIVE pill for an active store', async () => {
    await renderTab([row({ status: 'active' })]);

    expect(mockFetchStoresIncludingInactive).toHaveBeenCalledTimes(1);
    expect(screen.getByText('ACTIVE')).toBeTruthy();
    // Active rows offer a DEACTIVATE affordance.
    expect(screen.getByLabelText('Deactivate store Downtown')).toBeTruthy();
  });

  it('DEACTIVATE: confirms via confirmAction, then calls updateStore({status:inactive}) and flips the pill', async () => {
    await renderTab([row({ id: 'store-1', name: 'Downtown', status: 'active' })]);

    fireEvent.press(screen.getByLabelText('Deactivate store Downtown'));

    // (a) confirmAction was invoked for the consequential direction, with the
    //     deactivate title + a 'Deactivate' confirm label.
    expect(mockConfirmAction).toHaveBeenCalledTimes(1);
    const [title, message, , confirmLabel] = mockConfirmAction.mock.calls[0];
    expect(title).toBe('Deactivate store?');
    expect(message).toContain('Downtown');
    expect(confirmLabel).toBe('Deactivate');

    // On confirm → updateStore with the flipped status.
    expect(mockUpdateStore).toHaveBeenCalledTimes(1);
    expect(mockUpdateStore).toHaveBeenCalledWith('store-1', { status: 'inactive' });

    // (c) The optimistic local flip is reflected on the row: pill now INACTIVE
    //     and the affordance label flips to "Activate store …".
    await waitFor(() => expect(screen.getByText('INACTIVE')).toBeTruthy());
    expect(screen.queryByText('ACTIVE')).toBeNull();
    expect(screen.getByLabelText('Activate store Downtown')).toBeTruthy();
  });

  it('DEACTIVATE cancelled: does NOT call updateStore and the pill stays ACTIVE', async () => {
    // Simulate the user dismissing the confirm dialog (onConfirm never runs).
    mockConfirmAction.mockImplementation(() => {});

    await renderTab([row({ id: 'store-1', name: 'Downtown', status: 'active' })]);

    fireEvent.press(screen.getByLabelText('Deactivate store Downtown'));

    expect(mockConfirmAction).toHaveBeenCalledTimes(1);
    expect(mockUpdateStore).not.toHaveBeenCalled();
    expect(screen.getByText('ACTIVE')).toBeTruthy();
    expect(screen.queryByText('INACTIVE')).toBeNull();
  });

  it('ACTIVATE: does NOT confirm, calls updateStore({status:active}) and flips the pill', async () => {
    await renderTab([row({ id: 'store-2', name: 'Uptown', status: 'inactive' })]);

    // Inactive row → INACTIVE pill + an "Activate" affordance.
    expect(screen.getByText('INACTIVE')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Activate store Uptown'));

    // (b) re-activation is non-destructive — no confirm dialog.
    expect(mockConfirmAction).not.toHaveBeenCalled();
    expect(mockUpdateStore).toHaveBeenCalledTimes(1);
    expect(mockUpdateStore).toHaveBeenCalledWith('store-2', { status: 'active' });

    // Optimistic flip back to ACTIVE.
    await waitFor(() => expect(screen.getByText('ACTIVE')).toBeTruthy());
    expect(screen.queryByText('INACTIVE')).toBeNull();
    expect(screen.getByLabelText('Deactivate store Uptown')).toBeTruthy();
  });
});
