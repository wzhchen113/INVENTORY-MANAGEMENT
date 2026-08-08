// src/components/cmd/InstallGuideSheet.test.tsx — Spec 153.
//
// Covers the admin view's render gates: AC-2 (the sheet renders), AC-4 (the
// default tab comes from the probe and manual switching swaps the step list
// without remounting the sheet), AC-7 (standalone → "already added", no tabs),
// AC-8 (off-web → nothing, no throw), AC-9 (the install button's TWO gates).
//
// The pure model is exercised for real (no `installSteps` mock) — only the
// impure probes and the capture store are stubbed, since those read browser
// globals. Theme + useT are identity-stubbed the way SessionLostBanner's suite
// does, so nothing drags the supabase client in at module-eval.

jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#FFFFFF',
    panel: '#F7F7F5',
    panel2: '#EAEAEA',
    border: '#CCCCCC',
    borderStrong: '#888888',
    accent: '#3F7C20',
    // Spec 154 — the step illustrations map `accentBg` into their highlight
    // fill, so the stub needs it too.
    accentBg: '#E0EFC9',
    accentFg: '#FFFFFF',
    fg: '#000000',
    fg2: '#444444',
    fg3: '#888888',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6, pill: 999 },
}));

jest.mock('../../hooks/useT', () => ({
  useT: () => (key: string) => key,
}));

// Platform is per-test mutable; everything else in react-native stays real.
// Mocking the Platform MODULE (rather than spreading the whole `react-native`
// barrel, which eagerly evaluates its lazy getters and blows up on DevMenu) is
// the shape AppReloadButton.test.tsx already uses.
let mockOS: 'ios' | 'android' | 'web' = 'web';
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

// Impure probes + capture store — the component's only browser boundary.
let mockPlatform: 'ios' | 'android' | 'desktop' = 'android';
let mockStandalone = false;
let mockPromptAvailable = false;
const mockPromptInstall = jest.fn();
jest.mock('../../lib/installGuide', () => {
  const actual = jest.requireActual('../../lib/installGuide');
  return {
    ...actual,
    detectInstallPlatform: () => mockPlatform,
    detectStandalone: () => mockStandalone,
    useInstallPrompt: () => ({
      available: mockPromptAvailable,
      promptInstall: mockPromptInstall,
    }),
  };
});

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { InstallGuideSheet } from './InstallGuideSheet';

beforeEach(() => {
  jest.clearAllMocks();
  mockOS = 'web';
  mockPlatform = 'android';
  mockStandalone = false;
  mockPromptAvailable = false;
});

function renderSheet(visible = true) {
  return render(<InstallGuideSheet visible={visible} onClose={jest.fn()} />);
}

describe('InstallGuideSheet — render gates', () => {
  test('AC-2: renders the sheet body with the three platform tabs', () => {
    renderSheet();
    expect(screen.getByTestId('install-guide-sheet')).toBeTruthy();
    expect(screen.getByTestId('install-guide-tab-ios')).toBeTruthy();
    expect(screen.getByTestId('install-guide-tab-android')).toBeTruthy();
    expect(screen.getByTestId('install-guide-tab-desktop')).toBeTruthy();
  });

  test('renders nothing while closed', () => {
    renderSheet(false);
    expect(screen.queryByTestId('install-guide-sheet')).toBeNull();
  });

  test('AC-8: off-web renders nothing and does not throw', () => {
    mockOS = 'ios';
    expect(() => renderSheet()).not.toThrow();
    expect(screen.queryByTestId('install-guide-sheet')).toBeNull();
  });

  test('AC-7: already installed → the confirmation body, no tabs, no steps', () => {
    mockStandalone = true;
    renderSheet();
    expect(screen.getByTestId('install-guide-installed')).toBeTruthy();
    expect(screen.queryByTestId('install-guide-tab-ios')).toBeNull();
    expect(screen.queryByTestId('install-guide-step-android.step1')).toBeNull();
  });

  test('the header close button carries the shared close aria key', () => {
    const onClose = jest.fn();
    render(<InstallGuideSheet visible onClose={onClose} />);
    fireEvent.press(screen.getByTestId('install-guide-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('InstallGuideSheet — platform tabs (AC-4)', () => {
  test('defaults to the detected platform', () => {
    mockPlatform = 'ios';
    renderSheet();
    // iOS ships 4 steps; the first and last are present.
    expect(screen.getByTestId('install-guide-step-ios.step1')).toBeTruthy();
    expect(screen.getByTestId('install-guide-step-ios.step4')).toBeTruthy();
    expect(screen.queryByTestId('install-guide-step-android.step1')).toBeNull();
  });

  test('a manual tab press swaps the step list WITHOUT remounting the sheet', () => {
    mockPlatform = 'ios';
    renderSheet();
    const rootBefore = screen.getByTestId('install-guide-sheet');

    fireEvent.press(screen.getByTestId('install-guide-tab-desktop'));

    expect(screen.getByTestId('install-guide-step-desktop.step1')).toBeTruthy();
    expect(screen.getByTestId('install-guide-step-desktop.step2')).toBeTruthy();
    expect(screen.queryByTestId('install-guide-step-ios.step1')).toBeNull();
    // Same host node instance → the body was re-rendered, not remounted.
    expect(screen.getByTestId('install-guide-sheet')).toBe(rootBefore);
  });

  test('every step renders its catalog key and its literal glyph', () => {
    mockPlatform = 'android';
    renderSheet();
    // useT is identity-mocked, so the key IS the rendered string.
    expect(screen.getByText('chrome.installGuide.steps.android.step1')).toBeTruthy();
    expect(screen.getByText('⋮')).toBeTruthy();
  });
});

// ── Spec 154 ────────────────────────────────────────────────────────
describe('InstallGuideSheet — step illustrations (spec 154 AC-3)', () => {
  // The pictures are aria-hidden by design, so RNTL needs telling.
  const HIDDEN = { includeHiddenElements: true } as const;

  test('every step of the active tab renders its own picture', () => {
    mockPlatform = 'ios';
    renderSheet();
    for (const key of ['ios.step1', 'ios.step2', 'ios.step3', 'ios.step4']) {
      expect(screen.getByTestId(`install-guide-art-${key}`, HIDDEN)).toBeTruthy();
    }
    expect(screen.queryByTestId('install-guide-art-android.step1', HIDDEN)).toBeNull();
  });

  test('switching tabs swaps the whole illustration set', () => {
    mockPlatform = 'ios';
    renderSheet();
    fireEvent.press(screen.getByTestId('install-guide-tab-desktop'));

    expect(screen.getByTestId('install-guide-art-desktop.step1', HIDDEN)).toBeTruthy();
    expect(screen.getByTestId('install-guide-art-desktop.step2', HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId('install-guide-art-ios.step1', HIDDEN)).toBeNull();
  });

  test('the pictures carry the localized OS labels (useT is identity-mocked)', () => {
    mockPlatform = 'android';
    renderSheet();
    // Drawn inside android.step2's menu picture.
    expect(screen.getByText('chrome.installGuide.art.installApp', HIDDEN)).toBeTruthy();
    // Drawn inside android.step3's confirm dialog.
    expect(screen.getByText('chrome.installGuide.art.install', HIDDEN)).toBeTruthy();
  });

  test('the "already added" state renders no pictures at all', () => {
    mockStandalone = true;
    mockPlatform = 'ios';
    renderSheet();
    expect(screen.queryByTestId('install-guide-art-ios.step1', HIDDEN)).toBeNull();
  });
});

describe('InstallGuideSheet — one-tap install button (AC-9)', () => {
  test('absent when no beforeinstallprompt was captured', () => {
    mockPromptAvailable = false;
    renderSheet();
    expect(screen.queryByTestId('install-guide-install-button')).toBeNull();
  });

  test('present on the android tab once captured, and one press fires one prompt', () => {
    mockPlatform = 'android';
    mockPromptAvailable = true;
    renderSheet();

    fireEvent.press(screen.getByTestId('install-guide-install-button'));
    expect(mockPromptInstall).toHaveBeenCalledTimes(1);
  });

  test('present on the desktop tab once captured', () => {
    mockPlatform = 'desktop';
    mockPromptAvailable = true;
    renderSheet();
    expect(screen.getByTestId('install-guide-install-button')).toBeTruthy();
  });

  test('NEVER renders on the ios tab, even with a captured event', () => {
    mockPlatform = 'ios';
    mockPromptAvailable = true;
    renderSheet();
    expect(screen.queryByTestId('install-guide-install-button')).toBeNull();

    // ...and switching to the ios tab from a tab that HAD the button hides it.
    fireEvent.press(screen.getByTestId('install-guide-tab-android'));
    expect(screen.getByTestId('install-guide-install-button')).toBeTruthy();
    fireEvent.press(screen.getByTestId('install-guide-tab-ios'));
    expect(screen.queryByTestId('install-guide-install-button')).toBeNull();
  });
});
