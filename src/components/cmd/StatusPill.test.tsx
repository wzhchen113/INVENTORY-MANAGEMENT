// src/components/cmd/StatusPill.test.tsx — Spec 022 Track 1 component example.
//
// Smoke test that the StatusPill component renders the expected label text
// for each `status` value (`ok` / `low` / `out` / `info`) and honours the
// `label` override prop. Asserts ONE component, asserts ONE thing at a time
// per the architect's design (spec 022 §9): does it render? Does the
// label override prop win over the default statusLabel()?
//
// Boundary mocking — `../../theme/colors` AND `../../hooks/useT`:
//
// `StatusPill` calls `useCmdColors()` which lives in `src/theme/colors.ts`.
// `useCmdColors` reads `darkMode` from the Zustand store at `src/store/useStore.ts`.
// `useStore` in turn imports `src/lib/db.ts` → `src/lib/supabase.ts`, which
// crashes at import time when `EXPO_PUBLIC_SUPABASE_*` env vars are unset
// (jest runs without an `.env`). Per CLAUDE.md the Zustand store is
// off-limits for tests, and per Spec 022 §11 the architect noted that a
// hook-with-store-side-effect can be stubbed at the test level rather than
// dragging the whole store import graph into the component-test runtime.
//
// Spec 039 (this) — `StatusPill` now also calls `useT()` (from
// `../../hooks/useT`) to resolve the default `enum.itemStatus.<s>` label.
// `useT` reads `locale` from the same Zustand store; mock it at the
// boundary too. The mock returns a deterministic dictionary so the test's
// existing `'OK' / 'LOW' / 'OUT' / 'INFO'` text-match assertions stay
// identical.

jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({
    ok: '#3B6D11',
    okBg: '#EAF3DE',
    warn: '#854F0B',
    warnBg: '#FAEEDA',
    danger: '#791F1F',
    dangerBg: '#FCEBEB',
    info: '#185FA5',
    infoBg: '#E6F1FB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

jest.mock('../../hooks/useT', () => ({
  useT: () => (key: string) => {
    const dict: Record<string, string> = {
      'enum.itemStatus.ok':   'OK',
      'enum.itemStatus.low':  'LOW',
      'enum.itemStatus.out':  'OUT',
      'enum.itemStatus.info': 'INFO',
    };
    return dict[key] ?? key;
  },
}));

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { StatusPill } from './StatusPill';

describe('StatusPill', () => {
  it('renders the default label for status="ok"', () => {
    render(<StatusPill status="ok" />);
    expect(screen.getByText('OK')).toBeTruthy();
  });

  it('renders the default label for status="low"', () => {
    render(<StatusPill status="low" />);
    expect(screen.getByText('LOW')).toBeTruthy();
  });

  it('renders the default label for status="out"', () => {
    render(<StatusPill status="out" />);
    expect(screen.getByText('OUT')).toBeTruthy();
  });

  it('renders the default label for status="info"', () => {
    render(<StatusPill status="info" />);
    expect(screen.getByText('INFO')).toBeTruthy();
  });

  it('renders the explicit `label` prop, overriding the statusLabel()', () => {
    render(<StatusPill status="ok" label="Custom" />);
    expect(screen.getByText('Custom')).toBeTruthy();
    // The default "OK" should NOT appear when an override is provided.
    expect(screen.queryByText('OK')).toBeNull();
  });
});
