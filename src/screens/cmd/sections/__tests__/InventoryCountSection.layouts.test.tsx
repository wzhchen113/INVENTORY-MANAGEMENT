// src/screens/cmd/sections/__tests__/InventoryCountSection.layouts.test.tsx
//
// Spec 110 — the admin Weekly-count section is the layout-AUTHORING surface.
// A full render of the section with the db.ts layout boundary mocked (same
// boundary + shape as the sibling draft/parStatus tests) so the test drives the
// pill row + Save/rename/delete + name-modal wiring deterministically.
//
// What this pins (the ACs the ruling adds on the FE side):
//   - the pill row renders Default + one pill per named layout (AC-8);
//   - Save with NO layout selected opens the name modal → creates a layout
//     (AC-4/AC-9); Save WITH a layout selected overwrites it WITHOUT a name
//     prompt (AC-5);
//   - the 3-layout cap is enforced CLIENT-SIDE: with 3 layouts, "Save layout"
//     refuses a 4th create (toast, no modal) before the server backstop (AC-9);
//   - rename opens the modal prefilled + calls the rename action (AC-6);
//   - delete is confirm-gated and calls the delete action (AC-6);
//   - the Save-LAYOUT affordance is distinct from the spec-106 Save-DRAFT button.
//
// `.test.tsx` so the jsdom `component` project picks it up. The boundary mock is
// the same shape the draft test uses (importing the section reaches
// ../../../lib/supabase, which crashes at module load when EXPO_PUBLIC_SUPABASE_*
// is unset).

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';

jest.mock('../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(() => Promise.resolve({ data: null, error: null })),
    })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

// db.ts — the layout list/save/rename/delete boundary (the store actions call
// these). Bare jest.fn() (permissive signature) so the `(...a) => mockFn(...a)`
// re-forwarding type-checks under tsconfig.test.json; each test sets the resolved
// value. The list mock is the AUTHORITATIVE list the section refetches after a
// save (AC-4), so a create test can advance it to reflect the new row.
const mockListLayouts = jest.fn();
const mockSaveLayout = jest.fn();
const mockRenameLayout = jest.fn();
const mockDeleteLayout = jest.fn();
jest.mock('../../../../lib/db', () => ({
  __esModule: true,
  fetchStoreCountLayouts: (...a: unknown[]) => mockListLayouts(...a),
  saveStoreCountLayout: (...a: unknown[]) => mockSaveLayout(...a),
  renameStoreCountLayout: (...a: unknown[]) => mockRenameLayout(...a),
  deleteStoreCountLayout: (...a: unknown[]) => mockDeleteLayout(...a),
  // Inert stubs for the rest of the section's db.ts surface.
  fetchRecentInventoryCounts: jest.fn(() => Promise.resolve([])),
  fetchInventoryCount: jest.fn(() => Promise.resolve(null)),
  fetchReorderForCountedOnHand: jest.fn(() => Promise.resolve({})),
  fetchCountDraft: jest.fn(() => Promise.resolve(null)),
  saveCountDraft: jest.fn(() => Promise.resolve()),
  deleteCountDraft: jest.fn(() => Promise.resolve()),
}));

// device-local draft trio — inert (no draft in these tests).
jest.mock('../../../../lib/countDraftLocal', () => ({
  __esModule: true,
  readLocalCountDraft: jest.fn(() => null),
  writeLocalCountDraft: jest.fn(),
  clearLocalCountDraft: jest.fn(),
}));

jest.mock('../../../../hooks/useConnectionStatus', () => ({
  useConnectionStatus: () => true,
}));

// confirmAction — auto-confirm so the Delete post-confirm behavior is
// deterministic. `mockConfirm` lets a test assert the confirm fired first.
const mockConfirm = jest.fn(
  (_title: string, _message: string, onConfirm: () => void) => onConfirm(),
);
jest.mock('../../../../utils/confirmAction', () => ({
  confirmAction: (...args: unknown[]) =>
    (mockConfirm as unknown as (...a: unknown[]) => void)(...args),
}));

import InventoryCountSection from '../InventoryCountSection';
import { useStore } from '../../../../store/useStore';

type LayoutRow = { id: string; name: string; itemIds: string[]; position: number; updatedAt: string };

function layout(id: string, name: string, position: number, itemIds: string[] = ['item-1']): LayoutRow {
  return { id, name, itemIds, position, updatedAt: '2026-07-04T00:00:00Z' };
}

function seedStore() {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'brand-1', name: 'Frederick', address: '', status: 'active' } as any,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    inventory: [
      { id: 'item-1', storeId: 'store-1', name: 'Flour', category: 'Dry Goods', unit: 'lb', caseQty: 12, parLevel: 0 } as any,
      { id: 'item-2', storeId: 'store-1', name: 'Salt', category: 'Dry Goods', unit: 'oz', caseQty: 1, parLevel: 0 } as any,
    ],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListLayouts.mockResolvedValue([]);
  mockSaveLayout.mockResolvedValue('layout-new');
  mockRenameLayout.mockResolvedValue('layout-1');
  mockDeleteLayout.mockResolvedValue('layout-1');
  seedStore();
});

describe('InventoryCountSection — spec 110 layout authoring', () => {
  it('AC-1: the section header renders the renamed "Weekly count" title (not "Inventory count")', async () => {
    mockListLayouts.mockResolvedValue([]);
    const { getByText, queryByText } = render(<InventoryCountSection />);
    // The count.tsx tab header title reads the renamed value.
    await waitFor(() => expect(getByText('Weekly count')).toBeTruthy());
    // The old admin label is gone.
    expect(queryByText('Inventory count')).toBeNull();
  });

  it('renders the pill row: Default + one pill per named layout, distinct from the Save-DRAFT button', async () => {
    mockListLayouts.mockResolvedValue([layout('layout-1', 'Walk A', 1), layout('layout-2', 'Walk B', 2)]);
    const { getByTestId } = render(<InventoryCountSection />);
    await waitFor(() => expect(getByTestId('inv-layout-pill-layout-1')).toBeTruthy());
    expect(getByTestId('inv-layout-default')).toBeTruthy();
    expect(getByTestId('inv-layout-pill-layout-2')).toBeTruthy();
    // Default selected on open.
    expect(getByTestId('inv-layout-default').props.accessibilityState?.selected).toBe(true);
    // The Save-LAYOUT control and the spec-106 Save-DRAFT button coexist and are
    // distinct testIDs (visually/verbally distinct per the spec-106 flag).
    expect(getByTestId('inv-layout-save')).toBeTruthy();
    expect(getByTestId('inv-save-draft')).toBeTruthy();
  });

  it('AC-9: Save with NO layout selected opens the name modal, then creates the layout (AC-4)', async () => {
    mockListLayouts.mockResolvedValue([]); // start with zero layouts
    const { getByTestId, queryByTestId } = render(<InventoryCountSection />);
    await waitFor(() => expect(getByTestId('inv-layout-default')).toBeTruthy());
    // No modal yet.
    expect(queryByTestId('layout-name-input')).toBeNull();
    // Save (Default selected) → the name modal opens (a name is required for a
    // NEW layout — no silent nameless save).
    fireEvent.press(getByTestId('inv-layout-save'));
    await waitFor(() => expect(getByTestId('layout-name-input')).toBeTruthy());
    // The refetch after a successful create returns the new row.
    mockListLayouts.mockResolvedValue([layout('layout-new', 'Fridge walk', 1)]);
    fireEvent.changeText(getByTestId('layout-name-input'), 'Fridge walk');
    fireEvent.press(getByTestId('layout-name-save'));
    // The create RPC was called with the entered name + a null layoutId (create).
    await waitFor(() => expect(mockSaveLayout).toHaveBeenCalled());
    const call = mockSaveLayout.mock.calls[0];
    expect(call[0]).toBe('store-1'); // storeId
    expect(call[1]).toBe('Fridge walk'); // name
    expect(call[3] ?? null).toBeNull(); // layoutId null → create
    // The modal closes after submit.
    await waitFor(() => expect(queryByTestId('layout-name-input')).toBeNull());
  });

  it('AC-5: Save WITH a layout selected overwrites it WITHOUT a name prompt', async () => {
    mockListLayouts.mockResolvedValue([layout('layout-1', 'Walk A', 1, ['item-1', 'item-2'])]);
    const { getByTestId, queryByTestId } = render(<InventoryCountSection />);
    await waitFor(() => expect(getByTestId('inv-layout-pill-layout-1')).toBeTruthy());
    // Pick the layout, then Save → overwrite (no modal).
    fireEvent.press(getByTestId('inv-layout-pill-layout-1'));
    await waitFor(() =>
      expect(getByTestId('inv-layout-pill-layout-1').props.accessibilityState?.selected).toBe(true),
    );
    fireEvent.press(getByTestId('inv-layout-save'));
    await waitFor(() => expect(mockSaveLayout).toHaveBeenCalled());
    // Overwrite passes the selected layout's id + keeps its name (AC-5).
    const call = mockSaveLayout.mock.calls[0];
    expect(call[1]).toBe('Walk A'); // name preserved
    expect(call[3]).toBe('layout-1'); // layoutId set → overwrite
    // No name modal was shown for an overwrite.
    expect(queryByTestId('layout-name-input')).toBeNull();
  });

  it('AC-9: with 3 layouts, "Save layout" (create path) is refused CLIENT-SIDE with the cap toast, no modal, no RPC', async () => {
    mockListLayouts.mockResolvedValue([
      layout('layout-1', 'A', 1),
      layout('layout-2', 'B', 2),
      layout('layout-3', 'C', 3),
    ]);
    const { getByTestId, queryByTestId } = render(<InventoryCountSection />);
    await waitFor(() => expect(getByTestId('inv-layout-pill-layout-3')).toBeTruthy());
    // Default selected (a NEW-layout create) with 3 already existing → blocked.
    fireEvent.press(getByTestId('inv-layout-save'));
    // The cap toast fired…
    await waitFor(() => {
      const call = (Toast.show as jest.Mock).mock.calls.find(
        (c) => c[0]?.text1 === '3 layouts max — overwrite or delete one first',
      );
      expect(call).toBeTruthy();
    });
    // …the name modal never opened and the save RPC was never called.
    expect(queryByTestId('layout-name-input')).toBeNull();
    expect(mockSaveLayout).not.toHaveBeenCalled();
  });

  it('AC-6: Rename opens the modal prefilled with the layout name and calls the rename action', async () => {
    mockListLayouts.mockResolvedValue([layout('layout-1', 'Walk A', 1)]);
    const { getByTestId } = render(<InventoryCountSection />);
    await waitFor(() => expect(getByTestId('inv-layout-pill-layout-1')).toBeTruthy());
    fireEvent.press(getByTestId('inv-layout-pill-layout-1'));
    await waitFor(() => expect(getByTestId('inv-layout-rename')).toBeTruthy());
    fireEvent.press(getByTestId('inv-layout-rename'));
    // The modal opens prefilled with the current name.
    await waitFor(() => expect(getByTestId('layout-name-input').props.value).toBe('Walk A'));
    fireEvent.changeText(getByTestId('layout-name-input'), 'Cooler walk');
    fireEvent.press(getByTestId('layout-name-save'));
    await waitFor(() => expect(mockRenameLayout).toHaveBeenCalledWith('layout-1', 'Cooler walk'));
  });

  it('AC-6: Delete is confirm-gated and calls the delete action, returning to Default', async () => {
    mockListLayouts.mockResolvedValue([layout('layout-1', 'Walk A', 1)]);
    const { getByTestId } = render(<InventoryCountSection />);
    await waitFor(() => expect(getByTestId('inv-layout-pill-layout-1')).toBeTruthy());
    fireEvent.press(getByTestId('inv-layout-pill-layout-1'));
    await waitFor(() => expect(getByTestId('inv-layout-delete')).toBeTruthy());
    fireEvent.press(getByTestId('inv-layout-delete'));
    // The confirm fired BEFORE the delete side-effect…
    expect(mockConfirm).toHaveBeenCalled();
    // …and the delete action ran (auto-confirmed).
    await waitFor(() => expect(mockDeleteLayout).toHaveBeenCalledWith('layout-1'));
    // After delete the screen returns to Default (the pill is optimistically
    // removed; Default is re-selected).
    await waitFor(() =>
      expect(getByTestId('inv-layout-default').props.accessibilityState?.selected).toBe(true),
    );
  });

  it('"Save as new" creates a fresh layout (layoutId null) even while another layout is selected', async () => {
    mockListLayouts.mockResolvedValue([layout('layout-1', 'Walk A', 1)]);
    const { getByTestId } = render(<InventoryCountSection />);
    await waitFor(() => expect(getByTestId('inv-layout-pill-layout-1')).toBeTruthy());
    fireEvent.press(getByTestId('inv-layout-pill-layout-1'));
    await waitFor(() => expect(getByTestId('inv-layout-save-as-new')).toBeTruthy());
    fireEvent.press(getByTestId('inv-layout-save-as-new'));
    // The name modal opens EMPTY (a new layout, not a rename of the selection).
    await waitFor(() => expect(getByTestId('layout-name-input').props.value ?? '').toBe(''));
    mockListLayouts.mockResolvedValue([
      layout('layout-1', 'Walk A', 1),
      layout('layout-new', 'Walk B', 2),
    ]);
    fireEvent.changeText(getByTestId('layout-name-input'), 'Walk B');
    fireEvent.press(getByTestId('layout-name-save'));
    await waitFor(() => expect(mockSaveLayout).toHaveBeenCalled());
    const call = mockSaveLayout.mock.calls[0];
    expect(call[1]).toBe('Walk B');
    expect(call[3] ?? null).toBeNull(); // create — NOT an overwrite of layout-1
  });

  // Spec 110 code-review SF-1 — dragging while a category chip narrows the list
  // would persist ONLY the visible subset into the store-shared layout, so the
  // drag list must disable itself for category filters exactly as it already
  // does for search. The ▲/▼ movers ("Move up") are the drag list's marker.
  it('SF-1: the drag list disables while a category chip is active (rows render static), and returns on All', async () => {
    mockListLayouts.mockResolvedValue([layout('layout-1', 'Walk A', 1, ['item-1', 'item-2'])]);
    const { getByTestId, getByLabelText, queryAllByLabelText } = render(<InventoryCountSection />);
    await waitFor(() => expect(getByTestId('inv-layout-pill-layout-1')).toBeTruthy());
    // Enter Custom view via the pill — the drag list renders (movers present).
    fireEvent.press(getByTestId('inv-layout-pill-layout-1'));
    await waitFor(() => expect(queryAllByLabelText('Move up').length).toBeGreaterThan(0));
    // Narrow with a category chip → static rows, NO movers (a drag here would
    // wholesale-replace the ranking with the category subset).
    fireEvent.press(getByLabelText('Dry Goods (2)'));
    await waitFor(() => expect(queryAllByLabelText('Move up').length).toBe(0));
    // Back to All → the drag list returns.
    fireEvent.press(getByLabelText('All (2)'));
    await waitFor(() => expect(queryAllByLabelText('Move up').length).toBeGreaterThan(0));
  });

  it('cancelling the name modal does not call the save RPC', async () => {
    mockListLayouts.mockResolvedValue([]);
    const { getByTestId, queryByTestId } = render(<InventoryCountSection />);
    await waitFor(() => expect(getByTestId('inv-layout-default')).toBeTruthy());
    fireEvent.press(getByTestId('inv-layout-save'));
    await waitFor(() => expect(getByTestId('layout-name-input')).toBeTruthy());
    fireEvent.press(getByTestId('layout-name-cancel'));
    await waitFor(() => expect(queryByTestId('layout-name-input')).toBeNull());
    expect(mockSaveLayout).not.toHaveBeenCalled();
  });
});
