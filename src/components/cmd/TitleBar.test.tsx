// src/components/cmd/TitleBar.test.tsx — Spec 055 SF-2 integration smoke.
//
// Verifies the LoadingBar is wired into TitleBar's mount point. Per spec §4,
// LoadingBar must be rendered as the FIRST child of the title bar's outer
// View so its absolute-positioned overlay sits over the 32px chrome edge.
//
// The LoadingBar component itself is exercised in LoadingBar.test.tsx — this
// test only verifies the integration:
//   - When `hasInflight` is true, the title-bar tree contains the LoadingBar's
//     accessibility label ("Loading"), proving it's mounted and visible.
//   - When `hasInflight` is false, the title-bar tree does NOT contain the
//     LoadingBar's label (component returns null).
//
// Mocking shape follows VendorsSection.test.tsx — mock everything below the
// theme + store boundary that would otherwise drag in the supabase client
// and crash at module-eval. The two stub modules `react-dom` and
// `theme/colors` cover the bulk of TitleBar's deps.

// Force web platform before any import — TitleBar bails on non-web.
jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

// Theme colors — exhaustive enough for both TitleBar and LoadingBar reads.
jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({
    bg:             '#FFFFFF',
    panel:          '#F4F4F4',
    panel2:         '#EAEAEA',
    border:         '#CCCCCC',
    borderStrong:   '#888888',
    fg:             '#000000',
    fg2:            '#444444',
    fg3:            '#888888',
    accent:         '#185FA5',
    accentBg:       '#E6F1FB',
    accentFg:       '#FFFFFF',
    warn:           '#854F0B',
    warnBg:         '#FAEEDA',
    danger:         '#791F1F',
    dangerBg:       '#FCEBEB',
    ok:             '#3B6D11',
    okBg:           '#EAF3DE',
    info:           '#185FA5',
    infoBg:         '#E6F1FB',
    loadingBar:     '#3F7C20',
    loadingBarSlow: '#854F0B',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

// useT — passthrough identity so labels stay readable.
jest.mock('../../hooks/useT', () => ({
  useT: () => (key: string) => key,
}));

// useConnectionStatus (spec 057) — TitleBar consumes the hook to drive
// its connection indicator. The hook itself is unit-tested in
// useConnectionStatus.test.ts; this test only needs a fixed return so
// the indicator branch is well-formed (no assertions on copy / color).
jest.mock('../../hooks/useConnectionStatus', () => ({
  __esModule: true,
  useConnectionStatus: () => true,
}));

// useStore — provide just the keys TitleBar selects. The store is a Zustand
// hook so the mock returns a function that pretends to be one.
jest.mock('../../store/useStore', () => {
  const state: any = {
    stores: [{ id: 'store-1', name: 'Frederick', brandId: 'brand-1' }],
    currentStore: { id: 'store-1', name: 'Frederick', brandId: 'brand-1' },
    currentUser: { id: 'user-1', role: 'admin', stores: ['store-1'] },
    currentBrandId: null,
    brand: { id: 'brand-1', name: '2AM PROJECT' },
    brandsList: [],
    setCurrentStore: jest.fn(),
    // Spec 120/121 — TitleBar mounts NotificationBell, which selects these.
    // The bell now derives `hasUnreadMissed` from the feed on every render, so
    // the fixture must supply the feed (an empty array here) or the memo throws.
    submissionNotifications: [],
    submissionUnreadCount: 0,
    markSubmissionNotificationRead: jest.fn(),
    markAllSubmissionNotificationsRead: jest.fn(),
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

// ThemeToggle pulls in its own store deps — stub it out, this test isn't
// about theme toggling.
jest.mock('./ThemeToggle', () => ({
  ThemeToggle: () => null,
}));

// react-dom's createPortal — render children inline so jsdom can find them.
// In production it portals the store-picker dropdown to document.body; the
// dropdown is closed in the default state of this test so the portal isn't
// invoked, but mocking it pre-empts any "createPortal is not a function"
// surprise.
jest.mock('react-dom', () => ({
  __esModule: true,
  createPortal: (children: any) => children,
}));

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { TitleBar } from './TitleBar';
import { useInflight } from '../../lib/inflight';
// Spec 150 — the REAL shared predicate (deliberately not mocked): the test
// asserts the rendered dropdown equals this function's output.
import { visibleStoresFor } from '../../lib/storeVisibility';

beforeEach(() => {
  useInflight.setState({
    hasInflight: false,
    hasSlow: false,
    _activeCount: 0,
    _slowCount: 0,
  });
});

describe('TitleBar — LoadingBar integration (Spec 055)', () => {
  test('does NOT render the LoadingBar when nothing is in flight', () => {
    render(<TitleBar storeName="Frederick" section="inventory" />);
    // LoadingBar returns null when hasInflight=false → no "Loading" label.
    expect(screen.queryByLabelText('Loading')).toBeNull();
  });

  test('renders the LoadingBar inside the chrome when hasInflight flips true', () => {
    act(() => {
      useInflight.setState({ hasInflight: true, _activeCount: 1 });
    });
    render(<TitleBar storeName="Frederick" section="inventory" />);
    // The LoadingBar's outer View carries accessibilityLabel="Loading";
    // finding it under TitleBar's tree proves the integration is wired.
    expect(screen.getByLabelText('Loading')).toBeTruthy();
  });

  test('LoadingBar follows hasSlow into the warn state inside TitleBar', () => {
    act(() => {
      useInflight.setState({
        hasInflight: true,
        hasSlow: true,
        _activeCount: 1,
        _slowCount: 1,
      });
    });
    render(<TitleBar storeName="Frederick" section="inventory" />);
    // Still rendered, still labelled "Loading" — the slow state is a
    // color shift only (verified in LoadingBar.test.tsx).
    expect(screen.getByLabelText('Loading')).toBeTruthy();
  });
});

// ── Spec 150 — shared store-visibility predicate ─────────────────────
// The desktop store dropdown and the phone PhoneStoreSwitch sheet used to
// carry byte-identical copies of the access filter. Both now render
// `visibleStoresFor(...)`. This case pins the desktop half against the SAME
// fixture the phone half is pinned against in
// src/screens/cmd/sections/phone/__tests__/PhoneStoreSwitch.test.tsx
// ("renders exactly the shared predicate's output"), so a divergence between
// the two surfaces fails one of the two suites.
describe('TitleBar — store switcher uses the shared predicate (Spec 150)', () => {
  const FIXTURE_STORES = [
    { id: 's1', brandId: 'b1', name: 'Frederick', address: '', status: 'active' as const },
    { id: 's2', brandId: 'b1', name: 'Towson', address: '', status: 'active' as const },
    { id: 's3', brandId: 'b2', name: 'Harbor', address: '', status: 'active' as const },
  ];

  const seed = (over: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../store/useStore') as { useStore: { __state: Record<string, unknown> } };
    Object.assign(mod.useStore.__state, over);
  };

  const openMenuAndReadRows = () => {
    // useT is mocked to identity, so the trigger's a11y label is the raw key.
    fireEvent.press(screen.getByLabelText('chrome.switchStoreAria'));
    // createPortal is mocked to render inline, so the rows are in-tree.
    return screen
      .getAllByText(/:\/\//)
      .map((n) => n.props.children.join(''))
      // Drop the breadcrumb trigger itself; keep the dropdown rows.
      .slice(1);
  };

  test.each([
    ['admin sees every store under "All brands"', 'admin', [], null],
    ['admin narrowed to a brand', 'admin', [], 'b1'],
    ['super-admin with no grants sees every store', 'super_admin', [], null],
    ['non-privileged user sees only grants', 'user', ['s2'], null],
    ['non-privileged user, brand with no granted store', 'user', ['s3'], 'b1'],
  ] as const)('%s', (_label, role, grants, brandId) => {
    const currentUser = { id: 'u1', role, stores: [...grants] };
    seed({
      stores: FIXTURE_STORES,
      currentUser,
      currentBrandId: brandId,
      currentStore: FIXTURE_STORES[0],
      brandsList: [{ id: 'b1', name: '2AM PROJECT' }, { id: 'b2', name: 'BALTIMORE SEAFOOD' }],
      brand: { id: 'b1', name: '2AM PROJECT' },
    });
    const expected = visibleStoresFor(FIXTURE_STORES, currentUser as any, brandId);

    render(<TitleBar storeName="Frederick" section="inventory" />);
    const rows = openMenuAndReadRows();

    expect(rows).toHaveLength(expected.length);
    for (const s of expected) {
      expect(rows.some((r) => r.endsWith(`://${s.name.toLowerCase()}`))).toBe(true);
    }
  });
});
