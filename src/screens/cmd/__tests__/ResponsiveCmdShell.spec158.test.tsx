// src/screens/cmd/__tests__/ResponsiveCmdShell.spec158.test.tsx — Spec 158.
//
// Mirrors the spec-153 shell suite. AC-7 / AC-8 are PLACEMENT claims across
// three breakpoint branches (RN has no shared parent across the shell's three
// `return`s), so a future edit that drops one insertion must fail the build
// rather than a review.
//
// Also pins:
//   • AC-10 — the phone drawer is closed IN THE SAME HANDLER before the sheet
//     opens (MobileNavDrawer is a Modal and ResponsiveSheet is another);
//   • AC-7 — opening the sheet does NOT change the active section;
//   • §0 C-2 — there is exactly ONE `cmd-guide-entry` in the tree at every
//     tier, including collapsed tablet (a rail twin would duplicate it,
//     because the tablet branch renders TitleBar in BOTH sub-states);
//   • AC-REG3 — the spec-153 install chip / rail twin are untouched.

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

let mockTier: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('../../../theme/breakpoints', () => ({
  useIsPhone: () => mockTier === 'phone',
  useIsTablet: () => mockTier === 'tablet',
  useIsDesktop: () => mockTier === 'desktop',
  DESKTOP_MIN_WIDTH: 1100,
}));

jest.mock('../../../lib/installGuide', () => ({
  detectStandalone: () => false,
}));
jest.mock('../../../components/cmd/InstallGuideSheet', () => ({
  InstallGuideSheet: () => null,
}));

// The sheet itself is covered by GuideSheet.test.tsx; here we only need to see
// WHETHER the shell mounted it, with what `visible`, and with which topicId.
jest.mock('../../../components/cmd/GuideSheet', () => {
  const { Text, View } = jest.requireActual('react-native');
  return {
    GuideSheet: ({ visible, topicId }: { visible: boolean; topicId: string | null }) => (
      <View testID="mock-guide-sheet">
        <Text>{visible ? 'open' : 'closed'}</Text>
        <Text testID="mock-guide-topic-id">{String(topicId)}</Text>
      </View>
    ),
  };
});

// ── Chrome children ──────────────────────────────────────────────────────
// TitleBar and MobileTopAppBar render their REAL guide affordance (that is the
// contract under test), so they are mocked only down to the prop they receive.
jest.mock('../../../components/cmd/TitleBar', () => {
  const { Text, TouchableOpacity } = jest.requireActual('react-native');
  return {
    TitleBar: ({ onHelpPress }: any) =>
      onHelpPress ? (
        <TouchableOpacity testID="cmd-guide-entry" onPress={onHelpPress}>
          <Text>?</Text>
        </TouchableOpacity>
      ) : null,
  };
});
jest.mock('../../../components/cmd/MobileTopAppBar', () => {
  const { Text, TouchableOpacity, View } = jest.requireActual('react-native');
  return {
    MobileTopAppBar: ({ onHamburgerPress, onTitlePress, trailing }: any) => (
      <View>
        <TouchableOpacity testID="mock-hamburger" onPress={onHamburgerPress} />
        {onTitlePress ? (
          <TouchableOpacity testID="cmd-guide-entry" onPress={onTitlePress}>
            <Text>?</Text>
          </TouchableOpacity>
        ) : null}
        <View testID="mock-trailing">{trailing}</View>
      </View>
    ),
  };
});

// The nav children render a press target per item so a test can drive the
// shell's `section` state (needed for the "Guide is active" suppression pins).
jest.mock('../../../components/cmd/Sidebar', () => {
  const { TouchableOpacity, View } = jest.requireActual('react-native');
  return {
    Sidebar: ({ footerLeft, footerRight, groups, onSelect }: any) => (
      <View testID="mock-sidebar">
        {(groups ?? []).flatMap((g: any) =>
          g.items.map((it: any) => (
            <TouchableOpacity
              key={it.id}
              testID={`mock-nav-${it.id}`}
              onPress={() => onSelect?.(it.id)}
            />
          )),
        )}
        {footerLeft}{footerRight}
      </View>
    ),
  };
});
jest.mock('../../../components/cmd/RailSidebar', () => {
  const { TouchableOpacity, View } = jest.requireActual('react-native');
  return {
    RailSidebar: ({ footerSlot, groups, onSelect }: any) => (
      <View testID="mock-rail">
        {(groups ?? []).flatMap((g: any) =>
          g.items.map((it: any) => (
            <TouchableOpacity
              key={it.id}
              testID={`mock-nav-${it.id}`}
              onPress={() => onSelect?.(it.id)}
            />
          )),
        )}
        {footerSlot}
      </View>
    ),
  };
});
jest.mock('../../../components/cmd/MobileNavDrawer', () => {
  const { TouchableOpacity, View } = jest.requireActual('react-native');
  return {
    MobileNavDrawer: ({ visible, footerLeft, groups, onSelect }: any) =>
      visible ? (
        <View testID="mock-drawer">
          {(groups ?? []).flatMap((g: any) =>
            g.items.map((it: any) => (
              <TouchableOpacity
                key={it.id}
                testID={`mock-nav-${it.id}`}
                onPress={() => onSelect?.(it.id)}
              />
            )),
          )}
          {footerLeft}
        </View>
      ) : null,
  };
});

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

// The body renders the active section id so AC-7's "without changing the
// active section" is observable.
jest.mock('../InventoryDesktopLayout', () => {
  const { Text, View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ section }: { section: string }) => (
      <View testID="mock-body">
        <Text testID="mock-body-section">{section}</Text>
      </View>
    ),
  };
});

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
  useDefaultSidebarGroups: () => [
    { label: 'OPERATIONS', items: [{ id: 'Dashboard', label: 'Dashboard' }] },
    { label: 'HELP', items: [{ id: 'Guide', label: 'Guide' }] },
  ],
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
jest.mock('../../../hooks/useRole', () => ({ useIsSuperAdmin: () => false }));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
}));

import { fireEvent, render, screen, within } from '@testing-library/react-native';
import ResponsiveCmdShell from '../ResponsiveCmdShell';

beforeEach(() => {
  jest.clearAllMocks();
  mockOS = 'web';
  mockTier = 'desktop';
  window.localStorage?.clear();
});

describe('AC-7 / AC-8 — the `?` entry exists at every tier, exactly once', () => {
  test('desktop TitleBar carries it and the sheet is mounted', () => {
    render(<ResponsiveCmdShell />);
    expect(screen.getAllByTestId('cmd-guide-entry')).toHaveLength(1);
    expect(screen.getByTestId('mock-guide-sheet')).toBeTruthy();
    expect(screen.getByText('closed')).toBeTruthy();
  });

  test('tablet (expanded sidebar) carries it', () => {
    mockTier = 'tablet';
    render(<ResponsiveCmdShell />);
    expect(screen.getByTestId('mock-sidebar')).toBeTruthy();
    expect(screen.getAllByTestId('cmd-guide-entry')).toHaveLength(1);
  });

  test('C-2: tablet COLLAPSED rail still has exactly ONE entry (no rail twin)', () => {
    // The tablet branch renders TitleBar in BOTH sub-states and only THEN forks
    // RailSidebar XOR Sidebar, so a spec-153-style rail twin would produce a
    // second live `?` and a duplicate testID that getByTestId throws on.
    window.localStorage.setItem('imr.cmd.sidebar.tabletCollapsed', '1');
    mockTier = 'tablet';
    render(<ResponsiveCmdShell />);
    expect(screen.getByTestId('mock-rail')).toBeTruthy();
    expect(screen.getAllByTestId('cmd-guide-entry')).toHaveLength(1);
  });

  test('AC-8: phone puts it on the app-bar TITLE, not in the trailing cluster', () => {
    mockTier = 'phone';
    render(<ResponsiveCmdShell />);
    expect(screen.getAllByTestId('cmd-guide-entry')).toHaveLength(1);
    // The trailing cluster gains NO new control — the guide entry is not
    // inside it (the mocked bar renders it as a sibling of `mock-trailing`).
    const trailing = screen.getByTestId('mock-trailing');
    expect(within(trailing).queryByTestId('cmd-guide-entry')).toBeNull();
  });

  test('off-web the phone entry still renders (the Guide is not web-only)', () => {
    // Unlike spec 153's install tutorial, the Guide ships on native too (OQ-6).
    mockOS = 'ios';
    mockTier = 'phone';
    render(<ResponsiveCmdShell />);
    expect(screen.getAllByTestId('cmd-guide-entry')).toHaveLength(1);
  });
});

describe('AC-7 — pressing `?` opens the sheet on the ACTIVE section', () => {
  test.each(['desktop', 'tablet', 'phone'] as const)('%s', (tier) => {
    mockTier = tier;
    render(<ResponsiveCmdShell />);
    expect(screen.getByText('closed')).toBeTruthy();

    fireEvent.press(screen.getByTestId('cmd-guide-entry'));

    expect(screen.getByText('open')).toBeTruthy();
    // The shell's initial section is `Inventory`.
    expect(screen.getByTestId('mock-guide-topic-id').props.children).toBe('Inventory');
  });

  test('opening the sheet does NOT change the active section', () => {
    render(<ResponsiveCmdShell />);
    expect(screen.getByTestId('mock-body-section').props.children).toBe('Inventory');
    fireEvent.press(screen.getByTestId('cmd-guide-entry'));
    expect(screen.getByTestId('mock-body-section').props.children).toBe('Inventory');
  });
});

describe('AC-10 — never two live Modals on phone', () => {
  test('the press closes the drawer BEFORE opening the sheet', () => {
    mockTier = 'phone';
    render(<ResponsiveCmdShell />);
    fireEvent.press(screen.getByTestId('mock-hamburger'));
    expect(screen.getByTestId('mock-drawer')).toBeTruthy();

    fireEvent.press(screen.getByTestId('cmd-guide-entry'));

    expect(screen.queryByTestId('mock-drawer')).toBeNull();
    expect(screen.getByText('open')).toBeTruthy();
  });
});

describe('AC-REG3 — spec-153 chrome is untouched', () => {
  test('the install chip still renders in the desktop sidebar footer', () => {
    render(<ResponsiveCmdShell />);
    expect(screen.getByTestId('cmd-install-guide-entry')).toBeTruthy();
  });

  test('the install rail twin still renders on collapsed tablet', () => {
    window.localStorage.setItem('imr.cmd.sidebar.tabletCollapsed', '1');
    mockTier = 'tablet';
    render(<ResponsiveCmdShell />);
    expect(screen.getAllByTestId('cmd-install-guide-entry')).toHaveLength(1);
  });
});

// ── Code-review fix: the `?` is suppressed on the Guide page itself ───────
//
// `Guide` is deliberately undocumented (`GuideExemptSectionId`), so an
// unsuppressed `?` would open GuideSheet in its INDEX fallback on top of
// GuideSection's own always-visible index — a redundant popup over the same
// content, and two live trees emitting the same `cmd-guide-index-<id>`
// testIDs. These pins cover every surface the entry renders on.
describe('the `?` entry is suppressed while Guide is the active section', () => {
  test.each(['desktop', 'tablet'] as const)('%s: selecting Guide removes the TitleBar `?`', (tier) => {
    mockTier = tier;
    render(<ResponsiveCmdShell />);
    expect(screen.getAllByTestId('cmd-guide-entry')).toHaveLength(1);

    fireEvent.press(screen.getByTestId('mock-nav-Guide'));

    expect(screen.queryByTestId('cmd-guide-entry')).toBeNull();
    // ...and it comes back on any other section.
    fireEvent.press(screen.getByTestId('mock-nav-Dashboard'));
    expect(screen.getAllByTestId('cmd-guide-entry')).toHaveLength(1);
  });

  test('tablet COLLAPSED rail: same suppression (the rail renders under the TitleBar)', () => {
    window.localStorage.setItem('imr.cmd.sidebar.tabletCollapsed', '1');
    mockTier = 'tablet';
    render(<ResponsiveCmdShell />);
    expect(screen.getByTestId('mock-rail')).toBeTruthy();
    expect(screen.getAllByTestId('cmd-guide-entry')).toHaveLength(1);

    fireEvent.press(screen.getByTestId('mock-nav-Guide'));
    expect(screen.queryByTestId('cmd-guide-entry')).toBeNull();
  });

  test('phone: selecting Guide from the drawer removes the pressable-title `?`', () => {
    mockTier = 'phone';
    render(<ResponsiveCmdShell />);
    expect(screen.getAllByTestId('cmd-guide-entry')).toHaveLength(1);

    fireEvent.press(screen.getByTestId('mock-hamburger'));
    fireEvent.press(screen.getByTestId('mock-nav-Guide'));

    // The drawer closed (existing onSelect behavior) and the title is plain.
    expect(screen.queryByTestId('mock-drawer')).toBeNull();
    expect(screen.queryByTestId('cmd-guide-entry')).toBeNull();
    expect(screen.getByTestId('mock-body-section').props.children).toBe('Guide');
  });

  test('the sheet can never be opened on Guide — there is no entry to press', () => {
    render(<ResponsiveCmdShell />);
    fireEvent.press(screen.getByTestId('mock-nav-Guide'));
    expect(screen.queryByTestId('cmd-guide-entry')).toBeNull();
    expect(screen.getByText('closed')).toBeTruthy();
  });

  test('an ALREADY-OPEN sheet closes when the section becomes Guide', () => {
    // Belt-and-braces half of the guard: suppression stops it being opened
    // FROM Guide; this closes it if the section changes underneath, so "never
    // two index trees at once" holds unconditionally.
    render(<ResponsiveCmdShell />);
    fireEvent.press(screen.getByTestId('cmd-guide-entry'));
    expect(screen.getByText('open')).toBeTruthy();

    fireEvent.press(screen.getByTestId('mock-nav-Guide'));
    expect(screen.getByText('closed')).toBeTruthy();
  });

  test('leaving Guide does NOT resurrect the previously-open sheet', () => {
    render(<ResponsiveCmdShell />);
    fireEvent.press(screen.getByTestId('cmd-guide-entry'));
    fireEvent.press(screen.getByTestId('mock-nav-Guide'));
    expect(screen.getByText('closed')).toBeTruthy();

    fireEvent.press(screen.getByTestId('mock-nav-Dashboard'));
    expect(screen.getByText('closed')).toBeTruthy();
  });
});
