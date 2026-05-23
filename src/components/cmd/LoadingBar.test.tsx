// src/components/cmd/LoadingBar.test.tsx — Spec 055 Track 1 smoke test.
//
// Verifies:
//   - returns null when nothing is in flight
//   - renders the rail when hasInflight is true
//   - re-renders only on boolean flips (selector behavior)
//   - color shifts to the warn token when hasSlow is true
//
// The animation styling is exercised in the preview browser test, not the
// jsdom render here. The color shift IS testable here because react-native-web
// forwards `backgroundColor` to the rendered View style.
//
// Mocking strategy follows the StatusPill.test.tsx reference example in
// `tests/README.md` (Hybrid mocking — "transitive store-import gotcha").
// LoadingBar's only theme dependency is `useCmdColors`; mocking that boundary
// keeps the import chain (useStore → db.ts → supabase) from crashing at
// module-eval when EXPO_PUBLIC_SUPABASE_URL is unset. Do NOT mock
// `src/lib/supabase` directly — that's the layer the architect rejected
// for component tests.

// LoadingBar is web-only per Spec 055 §4 / A2 (TitleBar bails on native).
// Force Platform.OS = 'web' before importing the component so the smoke
// renders exercise the real branch jsdom users would see in the browser.
jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

// Mock useCmdColors at the theme boundary. Only the two tokens LoadingBar
// reads are needed — keep the stub minimal so the test stays focused.
jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({
    loadingBar:     '#3F7C20',
    loadingBarSlow: '#854F0B',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

import React from 'react';
import { act, render } from '@testing-library/react-native';
import { LoadingBar } from './LoadingBar';
import { useInflight } from '../../lib/inflight';

beforeEach(() => {
  useInflight.setState({
    hasInflight: false,
    hasSlow: false,
    _activeCount: 0,
    _slowCount: 0,
  });
});

// Recursively collect any `backgroundColor` style values from the rendered
// tree. The inner stripe View carries the color (the outer rail is the
// overflow-clipping wrapper). react-native-web flattens style props onto
// the rendered nodes so the JSON snapshot preserves them.
function collectBackgroundColors(node: any): string[] {
  if (!node) return [];
  const out: string[] = [];
  const style = node.props?.style;
  if (style) {
    const styles = Array.isArray(style) ? style : [style];
    for (const s of styles) {
      if (s && typeof s === 'object' && typeof s.backgroundColor === 'string') {
        out.push(s.backgroundColor);
      }
    }
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) out.push(...collectBackgroundColors(c));
  }
  return out;
}

describe('LoadingBar', () => {
  test('renders nothing when not in flight', () => {
    const { toJSON } = render(<LoadingBar />);
    expect(toJSON()).toBeNull();
  });

  test('renders the progress rail when hasInflight is true', () => {
    act(() => {
      useInflight.setState({ hasInflight: true, _activeCount: 1 });
    });
    const result = render(<LoadingBar />);
    // The component should render (non-null tree) when hasInflight is true.
    expect(result.toJSON()).not.toBeNull();
  });

  test('hides again when the boolean flips back to false', () => {
    act(() => {
      useInflight.setState({ hasInflight: true, _activeCount: 1 });
    });
    const { rerender, toJSON } = render(<LoadingBar />);
    expect(toJSON()).not.toBeNull();

    act(() => {
      useInflight.setState({ hasInflight: false, _activeCount: 0 });
    });
    rerender(<LoadingBar />);
    expect(toJSON()).toBeNull();
  });

  test('uses the normal loadingBar color when hasSlow is false', () => {
    act(() => {
      useInflight.setState({
        hasInflight: true,
        hasSlow: false,
        _activeCount: 1,
        _slowCount: 0,
      });
    });
    const { toJSON } = render(<LoadingBar />);
    const colors = collectBackgroundColors(toJSON());
    expect(colors).toContain('#3F7C20'); // C.loadingBar
    expect(colors).not.toContain('#854F0B');
  });

  test('shifts to the loadingBarSlow color when hasSlow flips true (AC13)', () => {
    act(() => {
      useInflight.setState({
        hasInflight: true,
        hasSlow: true,
        _activeCount: 1,
        _slowCount: 1,
      });
    });
    const { toJSON } = render(<LoadingBar />);
    const colors = collectBackgroundColors(toJSON());
    // The inner sweep View should now carry the warn token, not the idle one.
    expect(colors).toContain('#854F0B'); // C.loadingBarSlow
    expect(colors).not.toContain('#3F7C20');
  });
});
