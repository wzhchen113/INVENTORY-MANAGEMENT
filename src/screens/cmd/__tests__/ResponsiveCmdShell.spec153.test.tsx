// src/screens/cmd/__tests__/ResponsiveCmdShell.spec153.test.tsx — Spec 153.
//
// AC-2 is a placement claim across THREE breakpoint branches (RN has no shared
// parent across the shell's three `return`s), plus a rail twin the tablet
// collapsed branch needs. The architect's fallback was "read the three
// branches at review time"; this suite pins them instead, so a future edit that
// drops one insertion fails the build rather than a review.
//
// Everything below the shell's own logic is stubbed to pass-through renderers:
// the chrome children are mocked to render the footer SLOTS they receive (that
// is the whole contract under test) and the body is mocked to null. The shell's
// own state, gates, and per-branch mounting run for real.
//
// Also pins the phone nested-Modal rule (§3): the chip's onPress must close the
// MobileNavDrawer (itself a Modal) before opening the sheet (another Modal).

jest.mock('../../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#FFFFFF', panel: '#F4F4F4', panel2: '#EAEAEA',
    border: '#CCCCCC', borderStrong: '#888888',
    fg: '#000000', fg2: '#444444', fg3: '#888888',
    accent: '#3F7C20', accentBg: '#E0EFC9', accentFg: '#FFFFFF',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6, pill: 999 },
}));

jest.mock('../../../hooks/useT', () => ({
  useT: () => (key: string) => key,
}));

let mockOS: 'ios' | 'web' = 'web';
jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: {
    get OS() {
      return mockOS;
    },
    select: (obj: any) => (mockOS in obj ? obj[mockOS] : obj.default),
  },
  get OS() {
    return mockOS;
  },
}));

// Breakpoint branch selector.
let mockTier: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('../../../theme/breakpoints', () => ({
  useIsPhone: () => mockTier === 'phone',
  useIsTablet: () => mockTier === 'tablet',
  useIsDesktop: () => mockTier === 'desktop',
  DESKTOP_MIN_WIDTH: 1100,
}));

// Install-guide probes — the shell's gate (AC-7 / AC-8) reads detectStandalone.
let mockStandalone = false;
jest.mock('../../../lib/installGuide', () => ({
  detectStandalone: () => mockStandalone,
}));

// The sheet itself is covered by InstallGuideSheet.test.tsx; here we only need
// to see WHETHER the shell mounted it and with what `visible`.
jest.mock('../../../components/cmd/InstallGuideSheet', () => {
  const { Text, View } = jest.requireActual('react-native');
  return {
    InstallGuideSheet: ({ visible }: { visible: boolean }) => (
      <View testID="mock-install-sheet">
        <Text>{visible ? 'open' : 'closed'}</Text>
      </View>
    ),
  };
});

// ── Chrome children → footer-slot pass-throughs ──────────────────────────
jest.mock('../../../components/cmd/Sidebar', () => {
  const { View } = jest.requireActual('react-native');
  return {
    Sidebar: ({ footerLeft, footerRight }: any) => (
      <View testID="mock-sidebar">{footerLeft}{footerRight}</View>
    ),
  };
});
jest.mock('../../../components/cmd/RailSidebar', () => {
  const { View } = jest.requireActual('react-native');
  return {
    RailSidebar: ({ footerSlot }: any) => <View testID="mock-rail">{footerSlot}</View>,
  };
});
jest.mock('../../../components/cmd/MobileNavDrawer', () => {
  const { View } = jest.requireActual('react-native');
  return {
    MobileNavDrawer: ({ visible, footerLeft }: any) =>
      visible ? <View testID="mock-drawer">{footerLeft}</View> : null,
  };
});
jest.mock('../../../components/cmd/MobileTopAppBar', () => {
  const { TouchableOpacity } = jest.requireActual('react-native');
  return {
    MobileTopAppBar: ({ onHamburgerPress }: any) => (
      <TouchableOpacity testID="mock-hamburger" onPress={onHamburgerPress} />
    ),
  };
});

// The remaining chrome children carry no slot this suite asserts on.
jest.mock('../../../components/cmd/TitleBar', () => ({ TitleBar: () => null }));
jest.mock('../../../components/cmd/RefreshButton', () => ({ RefreshButton: () => null }));
jest.mock('../../../components/cmd/StoreSwitchOverlay', () => ({ StoreSwitchOverlay: () => null }));
jest.mock('../../../components/cmd/ThemeToggle', () => ({ ThemeToggle: () => null }));
jest.mock('../../../components/cmd/LocaleSwitcher', () => ({ LocaleSwitcher: () => null }));
jest.mock('../../../components/cmd/NotificationToggle', () => ({ NotificationToggle: () => null }));
jest.mock('../../../components/cmd/NotificationBlockedBanner', () => ({ NotificationBlockedBanner: () => null }));
jest.mock('../../../components/cmd/SessionLostBanner', () => ({ SessionLostBanner: () => null }));
jest.mock('../../../components/cmd/BrandPicker', () => ({ BrandPicker: () => null }));
jest.mock('../sections/phone/PhoneNotifications', () => ({ PhoneNotifications: () => null }));
jest.mock('../sections/phone/PhoneStoreSwitch', () => ({ PhoneStoreSwitch: () => null }));
jest.mock('../InventoryDesktopLayout', () => ({ __esModule: true, default: () => null }));

// ── Store + selectors ────────────────────────────────────────────────────
const mockState: any = {
  currentUser: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
  logout: jest.fn(),
  currentStore: { id: 's1', name: 'Towson' },
  switching: null,
  eodSubmissions: [],
  stores: [],
  sidebarLayoutOverride: null,
  setSidebarLayoutOverride: jest.fn(),
};
jest.mock('../../../store/useStore', () => ({
  useStore: (selector: (s: any) => any) => selector(mockState),
}));
jest.mock('../../../lib/cmdSelectors', () => ({
  useCommandPaletteIndex: () => [],
  useDefaultSidebarGroups: () => [],
}));
jest.mock('../../../lib/sidebarLayout', () => ({
  applySidebarOverride: (groups: unknown) => groups,
  produceOverride: () => null,
  remapLegacySidebarOverrideIds: (v: unknown) => v ?? null,
}));
jest.mock('../../../lib/paletteAction', () => ({
  usePaletteAction: Object.assign(
    (selector: (s: any) => any) => selector({ pending: null }),
    { getState: () => ({ request: jest.fn() }) },
  ),
}));
// Spec 158 — the shell now also mounts GuideSheet, which reads useIsMaster.
// Stubbed to null here (its own suite covers it) so this file keeps testing
// only the spec-153 install entry.
jest.mock('../../../components/cmd/GuideSheet', () => ({ GuideSheet: () => null }));
jest.mock('../../../hooks/useRole', () => ({
  useIsSuperAdmin: () => false,
  useIsMaster: () => false,
}));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
}));

import { fireEvent, render, screen } from '@testing-library/react-native';
import ResponsiveCmdShell from '../ResponsiveCmdShell';

beforeEach(() => {
  jest.clearAllMocks();
  mockOS = 'web';
  mockTier = 'desktop';
  mockStandalone = false;
  window.localStorage?.clear();
});

describe('ResponsiveCmdShell — install entry placement (AC-2)', () => {
  test('desktop sidebar footer carries the entry and mounts the sheet', () => {
    render(<ResponsiveCmdShell />);
    expect(screen.getByTestId('cmd-install-guide-entry')).toBeTruthy();
    expect(screen.getByTestId('mock-install-sheet')).toBeTruthy();
  });

  test('tablet sidebar footer carries the entry', () => {
    mockTier = 'tablet';
    render(<ResponsiveCmdShell />);
    expect(screen.getByTestId('cmd-install-guide-entry')).toBeTruthy();
    expect(screen.getByTestId('mock-install-sheet')).toBeTruthy();
  });

  test('tablet COLLAPSED rail carries the glyph twin under the same testID', () => {
    // The rail never receives sidebarFooterLeft, so without the twin AC-2 fails
    // at tabletCollapsed === true. The pref is read from localStorage on mount.
    window.localStorage.setItem('imr.cmd.sidebar.tabletCollapsed', '1');
    mockTier = 'tablet';
    render(<ResponsiveCmdShell />);

    expect(screen.getByTestId('mock-rail')).toBeTruthy();
    expect(screen.getByTestId('cmd-install-guide-entry')).toBeTruthy();
    // Exactly one node — the rail and the sidebar are mutually exclusive, so
    // the shared testID never collides in a single tree.
    expect(screen.getAllByTestId('cmd-install-guide-entry')).toHaveLength(1);
  });

  test('phone drawer footer carries the entry once the drawer is open', () => {
    mockTier = 'phone';
    render(<ResponsiveCmdShell />);
    // Closed drawer → no footer rendered at all.
    expect(screen.queryByTestId('cmd-install-guide-entry')).toBeNull();

    fireEvent.press(screen.getByTestId('mock-hamburger'));
    expect(screen.getByTestId('cmd-install-guide-entry')).toBeTruthy();
  });
});

describe('ResponsiveCmdShell — install entry behavior', () => {
  test('pressing the entry opens the sheet', () => {
    render(<ResponsiveCmdShell />);
    expect(screen.getByText('closed')).toBeTruthy();

    fireEvent.press(screen.getByTestId('cmd-install-guide-entry'));
    expect(screen.getByText('open')).toBeTruthy();
  });

  test('phone: the press CLOSES the drawer before opening the sheet (no nested Modals)', () => {
    mockTier = 'phone';
    render(<ResponsiveCmdShell />);
    fireEvent.press(screen.getByTestId('mock-hamburger'));
    expect(screen.getByTestId('mock-drawer')).toBeTruthy();

    fireEvent.press(screen.getByTestId('cmd-install-guide-entry'));

    expect(screen.queryByTestId('mock-drawer')).toBeNull();
    expect(screen.getByText('open')).toBeTruthy();
  });

  test('AC-7: already installed → no entry at any tier (sheet stays mounted, closed)', () => {
    mockStandalone = true;
    for (const tier of ['desktop', 'tablet'] as const) {
      mockTier = tier;
      const view = render(<ResponsiveCmdShell />);
      expect(view.queryByTestId('cmd-install-guide-entry')).toBeNull();
      view.unmount();
    }
  });

  test('AC-8: off-web → no entry', () => {
    mockOS = 'ios';
    render(<ResponsiveCmdShell />);
    expect(screen.queryByTestId('cmd-install-guide-entry')).toBeNull();
  });
});
