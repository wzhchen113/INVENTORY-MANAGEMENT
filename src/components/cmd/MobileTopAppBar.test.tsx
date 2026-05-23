// src/components/cmd/MobileTopAppBar.test.tsx — Spec 056 integration smoke.
//
// Verifies the LoadingBar is wired into MobileTopAppBar's mount point. Per
// spec 056 §"Mount-site contract", LoadingBar must be rendered as the FIRST
// child of the bar's outer View so its absolute-positioned overlay sits over
// the 44px chrome edge of the phone-tier shell.
//
// The LoadingBar component itself is exercised in LoadingBar.test.tsx — this
// test only verifies the integration:
//   - When `hasInflight` is true, the bar tree contains the LoadingBar's
//     accessibility label ("Loading"), proving it's mounted and visible.
//   - When `hasInflight` is false, the bar tree does NOT contain the
//     LoadingBar's label (component returns null).
//
// Mocking shape mirrors TitleBar.test.tsx — same Platform stub, same theme
// color stub, same useInflight reset in `beforeEach`. MobileTopAppBar has a
// much smaller dependency surface (no useStore, no supabase, no useT, no
// react-dom portal), so the mock count is correspondingly smaller.
//
// jsdom gotcha (per spec 056 §"Risks and tradeoffs"): jsdom does not compute
// layout, so this test cannot assert `position: 'relative'` on the outer
// wrapper. That key must be eyeballed in the diff at review time.

// Force web platform before any import — LoadingBar bails on non-web.
jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

// Theme colors — exhaustive enough for both MobileTopAppBar and LoadingBar reads.
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

// react-native-safe-area-context — MobileTopAppBar reads `insets.top` for
// the native top-pad. Stub a zeroed-out inset so the wrapper's paddingTop
// resolves cleanly. Required even though web sets `topPad = 0`, because
// the hook is still called before the Platform branch.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));

import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { MobileTopAppBar } from './MobileTopAppBar';
import { useInflight } from '../../lib/inflight';

beforeEach(() => {
  useInflight.setState({
    hasInflight: false,
    hasSlow: false,
    _activeCount: 0,
    _slowCount: 0,
  });
});

describe('MobileTopAppBar — LoadingBar integration (Spec 056)', () => {
  test('does NOT render the LoadingBar when nothing is in flight', () => {
    render(<MobileTopAppBar onHamburgerPress={() => {}} title="inventory" />);
    // LoadingBar returns null when hasInflight=false → no "Loading" label.
    expect(screen.queryByLabelText('Loading')).toBeNull();
  });

  test('renders the LoadingBar inside the chrome when hasInflight flips true', () => {
    act(() => {
      useInflight.setState({ hasInflight: true, _activeCount: 1 });
    });
    render(<MobileTopAppBar onHamburgerPress={() => {}} title="inventory" />);
    // The LoadingBar's outer View carries accessibilityLabel="Loading";
    // finding it under MobileTopAppBar's tree proves the integration is wired.
    expect(screen.getByLabelText('Loading')).toBeTruthy();
  });

  test('LoadingBar follows hasSlow into the warn state inside MobileTopAppBar', () => {
    act(() => {
      useInflight.setState({
        hasInflight: true,
        hasSlow: true,
        _activeCount: 1,
        _slowCount: 1,
      });
    });
    render(<MobileTopAppBar onHamburgerPress={() => {}} title="inventory" />);
    // Still rendered, still labelled "Loading" — the slow state is a
    // color shift only (verified in LoadingBar.test.tsx).
    expect(screen.getByLabelText('Loading')).toBeTruthy();
  });
});
