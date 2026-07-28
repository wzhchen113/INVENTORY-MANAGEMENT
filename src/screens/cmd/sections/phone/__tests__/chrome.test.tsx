// src/screens/cmd/sections/phone/__tests__/chrome.test.tsx
//
// Spec 142 §6.1 (AC-C1/C2/C3) — the global phone chrome:
//   - MobileTopAppBar is a fixed 52px row on phone (44px hamburger hit floor);
//   - NotificationToggle variant="bar" renders the bell but NOT the blocked copy;
//   - NotificationBlockedBanner renders the blocked copy below the bar and
//     disappears on ✕ dismiss;
//   - CmdStatusBar (synced · ⌘K palette) is absent when isPhone true, present
//     when false.
//
// The notification hook is mocked so we control the blocked/needs-attention
// state without a live push probe. supabase + db.ts are stubbed inert because
// the shell host imports the store (and every section) at module load.

// Force web so LoadingBar / RefreshButton render (they bail on non-web).
jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));

jest.mock('../../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      single: jest.fn(() => Promise.resolve({ data: null, error: null })),
      maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })),
    })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

jest.mock('../../../../../lib/db', () =>
  new Proxy(
    { __esModule: true },
    {
      get: (target: Record<string, unknown>, prop: string) => {
        if (prop in target) return (target as any)[prop];
        return jest.fn(() => Promise.resolve(null));
      },
    },
  ),
);

// Controllable tier for the CmdStatusBar suppression assertion.
let mockIsPhone = false;
jest.mock('../../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../../theme/breakpoints');
  return {
    ...actual,
    useIsPhone: () => mockIsPhone,
    useIsDesktop: () => !mockIsPhone,
    useBreakpoint: () => (mockIsPhone ? 'phone' : 'desktop'),
  };
});

// Controllable notification model — the bell + banner read the same hook.
type NotifModel = ReturnType<typeof buildModel>;
function buildModel(over: Partial<ReturnType<typeof baseModel>> = {}) {
  return { ...baseModel(), ...over };
}
function baseModel() {
  return {
    view: 'off' as const,
    busy: false,
    interactive: true,
    isOn: false,
    stateText: 'Off',
    label: 'Notifications',
    body: null as string | null,
    iosSteps: null as string | null,
    showRetry: false,
    retryLabel: 'Retry',
    aria: 'Notifications',
    onPress: jest.fn(),
    onRetry: jest.fn(),
  };
}
let mockNotifModel: NotifModel = baseModel();
jest.mock('../../../../../lib/useNotificationToggle', () => ({
  useNotificationToggle: () => mockNotifModel,
}));

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { MobileTopAppBar } from '../../../../../components/cmd/MobileTopAppBar';
import { NotificationToggle } from '../../../../../components/cmd/NotificationToggle';
import { NotificationBlockedBanner } from '../../../../../components/cmd/NotificationBlockedBanner';
import { ThemeToggle } from '../../../../../components/cmd/ThemeToggle';
import { RefreshButton } from '../../../../../components/cmd/RefreshButton';
import { PhoneType } from '../../../../../theme/typography';
import InventoryDesktopLayout from '../../../InventoryDesktopLayout';
import { useStore } from '../../../../../store/useStore';

function flat(style: unknown): Record<string, unknown> {
  return Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity)) : (style as any);
}

function seedStore() {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'brand-1', name: 'Frederick', address: '', status: 'active' } as any,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    inventory: [],
    vendors: [],
    auditLog: [],
    storeLoading: false,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsPhone = false;
  mockNotifModel = baseModel();
  seedStore();
});

describe('MobileTopAppBar height (AC-C1)', () => {
  it('is a fixed 52px row with a 44×44 hamburger on phone', () => {
    const { getByTestId, getByLabelText } = render(
      <MobileTopAppBar onHamburgerPress={() => {}} title="Inventory" height={52} titleType={PhoneType.screenTitle} />,
    );
    expect(flat(getByTestId('mobile-top-app-bar-row').props.style).height).toBe(52);
    expect(flat(getByLabelText('Open menu').props.style).width).toBe(44);
  });

  it('defaults to the historical 44px / 32px hamburger when no height is passed', () => {
    const { getByTestId, getByLabelText } = render(
      <MobileTopAppBar onHamburgerPress={() => {}} title="Inventory" />,
    );
    expect(flat(getByTestId('mobile-top-app-bar-row').props.style).height).toBe(44);
    expect(flat(getByLabelText('Open menu').props.style).width).toBe(32);
  });
});

describe('ThemeToggle / RefreshButton variant="bar" (AC-C1 hit floor)', () => {
  it('ThemeToggle bar renders the ◐ glyph in a 44×44 hit target', () => {
    const { getByText, getByRole } = render(<ThemeToggle variant="bar" />);
    expect(getByText('◐')).toBeTruthy();
    const style = flat(getByRole('button').props.style);
    expect(style.width).toBe(44);
    expect(style.height).toBe(44);
  });

  it('RefreshButton bar renders the ↻ glyph in a 44×44 hit target', () => {
    const { getByText, getByTestId } = render(<RefreshButton variant="bar" />);
    expect(getByText('↻')).toBeTruthy();
    const style = flat(getByTestId('chrome-refresh-app').props.style);
    expect(style.width).toBe(44);
    expect(style.height).toBe(44);
  });

  it('default (full) variants keep their text-pill label — no icon glyph', () => {
    const theme = render(<ThemeToggle />);
    expect(theme.queryByText('◐')).toBeNull();
    const refresh = render(<RefreshButton />);
    expect(refresh.queryByText('↻')).toBeNull();
  });
});

describe('NotificationToggle variant="bar" (AC-C2)', () => {
  it('renders the bell glyph but NOT the blocked copy', () => {
    mockNotifModel = buildModel({ body: 'PUSH BLOCKED — enable in settings' });
    const { getByText, queryByText } = render(<NotificationToggle variant="bar" />);
    expect(getByText('◔')).toBeTruthy();
    expect(queryByText('PUSH BLOCKED — enable in settings')).toBeNull();
  });
});

describe('NotificationBlockedBanner (AC-C2)', () => {
  it('renders the blocked copy below the bar and dismisses on ✕', () => {
    mockNotifModel = buildModel({ body: 'PUSH BLOCKED — enable in settings' });
    const { getByTestId, getByText, queryByTestId } = render(<NotificationBlockedBanner />);
    expect(getByTestId('notification-blocked-banner')).toBeTruthy();
    expect(getByText('PUSH BLOCKED — enable in settings')).toBeTruthy();

    fireEvent.press(getByText('✕'));
    expect(queryByTestId('notification-blocked-banner')).toBeNull();
  });

  it('renders nothing when there is no blocked copy', () => {
    mockNotifModel = baseModel();
    const { queryByTestId } = render(<NotificationBlockedBanner />);
    expect(queryByTestId('notification-blocked-banner')).toBeNull();
  });
});

describe('CmdStatusBar suppression on phone (AC-C3)', () => {
  it('renders the status footer (synced · ⌘K palette) on desktop', () => {
    mockIsPhone = false;
    const { getByText } = render(
      <InventoryDesktopLayout section="DBInspector" setSection={() => {}} onPaletteOpen={() => {}} />,
    );
    expect(getByText('synced')).toBeTruthy();
    expect(getByText('⌘K palette')).toBeTruthy();
  });

  it('suppresses the status footer and the ⌘K hint on phone', () => {
    mockIsPhone = true;
    const { queryByText } = render(
      <InventoryDesktopLayout section="DBInspector" setSection={() => {}} onPaletteOpen={() => {}} />,
    );
    expect(queryByText('synced')).toBeNull();
    expect(queryByText('⌘K palette')).toBeNull();
  });
});
