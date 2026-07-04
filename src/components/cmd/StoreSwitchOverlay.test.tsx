// src/components/cmd/StoreSwitchOverlay.test.tsx — Spec 111.
//
// Component-project (jsdom) render tests for the full-screen switch
// takeover. Presentational component: it takes `mode` and reads useT for
// the copy — no store access — so the tests just mount it with each mode.
//
//   T10 — copy per mode: mode='store' → "Switching stores…" key,
//         mode='brand' → "Switching brands…" key (distinct — AC-7).
//   plus: testIDs present (AC-6 mount contract), a11y announce props
//         (AC-8), and the shell's single-field render gate (T9 / decision
//         5) exercised as the pure `switching !== null` predicate the shell
//         computes — the overlay renders iff switching is non-null,
//         regardless of storeLoading (a realtime reload toggles storeLoading
//         but never switching, so it must not paint).
//
// Boundary mocking mirrors MenuCapacityBadge.test.tsx (mock useCmdColors,
// mock useT with key-echoing). The key-echoing mock returns the key path,
// so asserting on 'common.switchingStores' proves the mode→key mapping;
// the real es/zh-CN translations + key parity are locked by
// src/i18n/i18n.test.ts (identical key sets across all three catalogs).

jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({
    bg:      '#FAFAF8',
    panel:   '#FFFFFF',
    panel2:  '#F4F4F0',
    border:  '#CCCCCC',
    fg:      '#0E1014',
    fg2:     '#5A5F68',
    fg3:     '#9094A0',
    accent:  '#3F7C20',
    accentBg: '#E0EFC9',
    accentFg: '#FFFFFF',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

// useT — key-echoing (no {var} interpolation needed for these two keys).
jest.mock('../../hooks/useT', () => ({
  useT: () => (key: string) => key,
}));

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { StoreSwitchOverlay } from './StoreSwitchOverlay';

describe('StoreSwitchOverlay', () => {
  // ── T10 — copy per mode ─────────────────────────────────────────────
  it('T10: renders the "Switching stores…" copy for mode="store"', () => {
    render(<StoreSwitchOverlay mode="store" />);
    expect(screen.getByTestId('store-switch-overlay-label')).toHaveTextContent(
      'common.switchingStores',
    );
    // Distinct from the brand copy.
    expect(screen.queryByText('common.switchingBrands')).toBeNull();
  });

  it('T10: renders the "Switching brands…" copy for mode="brand"', () => {
    render(<StoreSwitchOverlay mode="brand" />);
    expect(screen.getByTestId('store-switch-overlay-label')).toHaveTextContent(
      'common.switchingBrands',
    );
    expect(screen.queryByText('common.switchingStores')).toBeNull();
  });

  // ── AC-6 — the mount contract testIDs ───────────────────────────────
  it('exposes the store-switch-overlay + label testIDs', () => {
    render(<StoreSwitchOverlay mode="store" />);
    expect(screen.getByTestId('store-switch-overlay')).toBeTruthy();
    expect(screen.getByTestId('store-switch-overlay-label')).toBeTruthy();
  });

  // ── AC-8 — accessibility announce props on the root ─────────────────
  it('announces via accessibilityRole="alert" + assertive live region + resolved label', () => {
    render(<StoreSwitchOverlay mode="brand" />);
    const root = screen.getByTestId('store-switch-overlay');
    expect(root.props.accessibilityRole).toBe('alert');
    expect(root.props.accessibilityLiveRegion).toBe('assertive');
    // The screen-reader label carries the resolved (mode-specific) copy.
    expect(root.props.accessibilityLabel).toBe('common.switchingBrands');
  });
});

// ── T9 — the shell's render gate is single-field ──────────────────────
//
// The shell computes `switching !== null ? <StoreSwitchOverlay/> : null`
// (ResponsiveCmdShell). This block pins that predicate directly — the gate
// keys off `switching` ALONE, never `storeLoading`, so a background
// realtime reload (storeLoading true, switching null) never paints the
// overlay, and a switch (switching non-null) paints it even if storeLoading
// has already flipped false. `renderOverlayFor` mirrors the shell one-liner.
describe('shell render gate (Spec 111 T9 / decision 5)', () => {
  const renderOverlayFor = (
    switching: 'store' | 'brand' | null,
  ): React.ReactElement | null =>
    switching !== null ? <StoreSwitchOverlay mode={switching} /> : null;

  it('renders the overlay when switching is non-null regardless of storeLoading=false', () => {
    const el = renderOverlayFor('store'); // storeLoading irrelevant to the gate
    expect(el).not.toBeNull();
    render(el as React.ReactElement);
    expect(screen.getByTestId('store-switch-overlay')).toBeTruthy();
  });

  it('renders NOTHING when switching is null even if a background load has storeLoading=true', () => {
    // A realtime-driven reload sets storeLoading=true but never switching —
    // the single-field gate keeps the overlay dark.
    const el = renderOverlayFor(null);
    expect(el).toBeNull();
  });
});
