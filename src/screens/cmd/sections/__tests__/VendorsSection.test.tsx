// src/screens/cmd/sections/__tests__/VendorsSection.test.tsx
//
// Spec 049 — Cross-brand catalog copy negative-gate coverage (item 2 of
// the FIXES_NEEDED proposal), mirror of InventoryCatalogMode.test.tsx
// for the Inventory > Vendors section.
//
// AC-N1 / AC-F3 require that admin / master / user roles do NOT see the
// cross-brand copy affordances:
//   - the leftmost per-row checkbox column,
//   - the per-row "COPY" pill,
//   - the top-bar bulk "Copy N to brand…" pill.
//
// The gate at the JSX level is `useIsSuperAdmin()` ([src/hooks/useRole.ts]).
//
// Boundary mocking matches InventoryCatalogMode.test.tsx — keep the same
// shape so reviewers don't have to context-switch between the two files.

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
  useT: () => (key: string, vars?: Record<string, string | number>) => {
    if (!vars) return key;
    return Object.entries(vars).reduce(
      (acc, [k, v]) => acc.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
      key,
    );
  },
}));

// useIsSuperAdmin is the gate under test. Hook returns a jest.fn() that
// each test can override via mockReturnValue. Default = false (gated off).
const mockUseIsSuperAdmin = jest.fn(() => false);
jest.mock('../../../../hooks/useRole', () => ({
  useIsSuperAdmin: () => mockUseIsSuperAdmin(),
  useIsMaster: () => false,
  useRole: () => 'admin' as const,
}));

// useStore — fixed snapshot. Empty vendors so the list pane renders no
// rows by default; tests that need a row seed it explicitly via
// `seedVendors`. brand has a non-empty id so `sourceBrandId` is truthy
// (the per-row canCopy guard checks `!!sourceBrandId`).
//
// Spec 055 — `storeLoading` is included so the first-mount skeleton
// branch (`storeLoading && vendors.length === 0`) is reachable in tests.
// Default false (after first fetch) so the existing copy-affordance tests
// continue to exercise the populated list path.
jest.mock('../../../../store/useStore', () => {
  const state: any = {
    vendors: [],
    inventory: [],
    currentStore: { id: 'store-1' },
    currentUser: { id: 'user-1', role: 'admin' },
    brand: { id: 'brand-source' },
    storeLoading: false,
    deleteVendor: jest.fn(),
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

// Heavy child components → null stubs. The list pane is what we exercise;
// the detail pane mounts conditionally on a selected vendor and pulls in
// VendorFormDrawer / POHistoryTab / etc. — we don't want any of that.
jest.mock('../../../../components/cmd/VendorFormDrawer', () => ({
  VendorFormDrawer: () => null,
}));
jest.mock('../../../../components/cmd/CopyToBrandDialog', () => ({
  CopyToBrandDialog: () => null,
}));
jest.mock('../../../../components/cmd/TabStrip', () => ({
  TabStrip: () => null,
}));
jest.mock('../../../../components/cmd/StatCard', () => ({
  StatCard: () => null,
}));
jest.mock('../../../../components/cmd/StatusPill', () => ({
  StatusPill: () => null,
}));
jest.mock('../../../../components/cmd/PropertiesJson', () => ({
  PropertiesJson: () => null,
}));
// POHistoryTab is exported by POsSection — replace the whole module so
// we don't drag in another store consumer.
jest.mock('../POsSection', () => ({
  __esModule: true,
  default: () => null,
  POHistoryTab: () => null,
}));

// ── Imports (resolve mocks above) ───────────────────────────────────
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import VendorsSection from '../VendorsSection';
import { useStore } from '../../../../store/useStore';

const mockState = (useStore as any).__state as Record<string, any>;

function seedVendors(rows: Array<Partial<any>> = []) {
  mockState.vendors = rows.map((r, i) => ({
    id:               r.id               ?? `vendor-${i}`,
    name:             r.name             ?? `Vendor ${i}`,
    categories:       r.categories       ?? [],
    leadTimeDays:     r.leadTimeDays     ?? 0,
    orderCutoffTime:  r.orderCutoffTime  ?? '',
    contactName:      r.contactName      ?? '',
    phone:            r.phone            ?? '',
    email:            r.email            ?? '',
    accountNumber:    r.accountNumber    ?? '',
    deliveryDays:     r.deliveryDays     ?? [],
    eodDeadlineTime:  r.eodDeadlineTime  ?? '',
    ...r,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseIsSuperAdmin.mockReturnValue(false);
  seedVendors([]);
  // Spec 055 — reset storeLoading between tests so the skeleton branch
  // doesn't bleed across the copy-affordance describe blocks.
  mockState.storeLoading = false;
});

// ── Tests ───────────────────────────────────────────────────────────

describe('VendorsSection — cross-brand copy affordances gate (Spec 049)', () => {
  describe('when useIsSuperAdmin() returns false (admin / master / user)', () => {
    it('does NOT render the per-row checkbox or per-row COPY pill', () => {
      seedVendors([{ id: 'vendor-1', name: 'Sysco' }]);

      render(<VendorsSection />);

      // The vendor name renders (in both the list row and the auto-
      // selected detail-pane header — at least one is present).
      expect(screen.getAllByText('Sysco').length).toBeGreaterThan(0);
      // The checkbox accessibility label is absent (gate hides the
      // entire checkbox subtree).
      expect(
        screen.queryByLabelText('dialog.copyToBrand.selectRowAria'),
      ).toBeNull();
      // Per-row "COPY" pill literal text is absent.
      expect(screen.queryByText('COPY')).toBeNull();
      // Per-row "Copy to brand…" accessibility label is absent.
      expect(
        screen.queryByLabelText('dialog.copyToBrand.rowActionLabel'),
      ).toBeNull();
    });

    it('does NOT render the top-bar bulk pill', () => {
      seedVendors([{ id: 'vendor-1', name: 'Sysco' }]);

      render(<VendorsSection />);

      // The bulk pill's accessibility label echoes
      // `dialog.copyToBrand.bulkPillVendors`; without the gate it never
      // renders even if a selection set somehow became non-empty.
      expect(
        screen.queryByText(/dialog\.copyToBrand\.bulkPillVendors/),
      ).toBeNull();
    });
  });

  describe('when useIsSuperAdmin() returns true (positive control)', () => {
    it('DOES render the per-row checkbox and per-row COPY pill', () => {
      mockUseIsSuperAdmin.mockReturnValue(true);
      seedVendors([{ id: 'vendor-1', name: 'Sysco' }]);

      render(<VendorsSection />);

      // The vendor name appears (list row + auto-selected detail header).
      expect(screen.getAllByText('Sysco').length).toBeGreaterThan(0);
      // The leftmost checkbox renders.
      expect(
        screen.getByLabelText('dialog.copyToBrand.selectRowAria'),
      ).toBeTruthy();
      // The per-row COPY pill renders.
      expect(screen.getByText('COPY')).toBeTruthy();
      // The per-row affordance accessibility label resolves.
      expect(
        screen.getByLabelText('dialog.copyToBrand.rowActionLabel'),
      ).toBeTruthy();
    });

    it('DOES render the top-bar bulk pill once the user picks a row', () => {
      mockUseIsSuperAdmin.mockReturnValue(true);
      seedVendors([{ id: 'vendor-1', name: 'Sysco' }]);

      render(<VendorsSection />);

      // Initially no selection → no bulk pill.
      expect(
        screen.queryByText(/dialog\.copyToBrand\.bulkPillVendors/),
      ).toBeNull();

      // Click the row checkbox. Pass a fake event object — the row
      // handler calls `e.stopPropagation?.()` so we need a non-undefined
      // arg.
      fireEvent.press(
        screen.getByLabelText('dialog.copyToBrand.selectRowAria'),
        { stopPropagation: () => {} },
      );

      // Pill text appears.
      expect(
        screen.getByText(/dialog\.copyToBrand\.bulkPillVendors/),
      ).toBeTruthy();
    });
  });
});

// ── Spec 055 — first-mount skeleton coverage (AC8 + AC9) ───────────────
//
// VendorsSection's only data slice is `vendors`, making it the cleanest
// representative for the spec-mandated `storeLoading && slice.length === 0`
// predicate. The same predicate appears in all 10 sections per the
// architect's cheat-sheet (spec §5) — proving the predicate fires correctly
// here gives us confidence in the structural pattern.
//
// AC8 (positive): skeleton renders when the first fetch hasn't returned.
// AC9 (negative): skeleton does NOT render when the slice already has rows,
//                 even if `storeLoading` flips true again (this is the
//                 regression guard that prevents skeleton-flash on every
//                 realtime-driven background refresh).

describe('VendorsSection — first-mount skeleton (Spec 055 AC8 / AC9)', () => {
  it('AC8: renders the ListSkeleton when storeLoading is true AND vendors is empty', () => {
    mockState.storeLoading = true;
    seedVendors([]); // empty slice — first-mount-with-no-cache

    render(<VendorsSection />);

    // The ListSkeleton renders a View with accessibilityRole="progressbar"
    // and accessibilityLabel="Loading". Asserting on the label is the most
    // direct check that the skeleton (and not the populated list pane)
    // rendered.
    expect(screen.getByLabelText('Loading')).toBeTruthy();

    // Confirm no list-pane chrome rendered alongside the skeleton.
    // The list pane has no "Loading" label, so finding it here means we
    // landed in the skeleton branch.
    expect(screen.queryAllByLabelText('Loading').length).toBe(1);
  });

  it('AC9: does NOT render the skeleton when vendors has rows, even if storeLoading is true', () => {
    // This is the predicate that prevents skeleton-flash on every realtime
    // tick: background refreshes set storeLoading=true briefly, but the
    // slice already has cached data, so the skeleton must stay hidden.
    mockState.storeLoading = true;
    seedVendors([{ id: 'vendor-1', name: 'Sysco' }]);

    render(<VendorsSection />);

    // No skeleton label.
    expect(screen.queryByLabelText('Loading')).toBeNull();
    // The vendor row IS rendered — proves we fell through to the list pane.
    expect(screen.getAllByText('Sysco').length).toBeGreaterThan(0);
  });

  it('AC9 (sanity): does NOT render the skeleton when storeLoading is false', () => {
    // After the first fetch resolves (storeLoading=false), even an empty
    // slice should not render the skeleton — the section's own empty-state
    // chrome takes over. Without this check, AC8's positive assertion could
    // be passing for the wrong reason (e.g. an unconditional skeleton).
    mockState.storeLoading = false;
    seedVendors([]);

    render(<VendorsSection />);

    expect(screen.queryByLabelText('Loading')).toBeNull();
  });
});
