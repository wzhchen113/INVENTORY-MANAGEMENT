// src/components/cmd/InviteUserDrawer.test.tsx — Spec 068 §12.1 coverage.
//
// The bug: the STORES multi-select rendered the entire global
// `useStore.stores` cache regardless of the active brand, so an operator
// inviting into 2AM PROJECT saw all 5 stores across both brands
// ("0 of 5 selected"). The fix brand-scopes the options to
// `stores.filter((s) => s.brandId === brand?.id)`, fixes the counter,
// adds a no-brand notice, and prunes stale selections on a brand switch.
//
// What this file pins:
//   1. options filtered to the active brand + counter `M` = filtered count.
//   2. a different brand context → only that brand's stores.
//   3. brand === null (super-admin "All brands") → brand-required notice,
//      NO store checkboxes, distinct from the "No stores visible yet" copy.
//   4. regressions: role==='admin' && !brand warning still renders; the
//      brand-set-but-no-stores empty-state keeps its original copy; submit
//      stays disabled until email + name are filled.
//   5. brand-switch prunes a stale storeIds entry so the counter stays
//      honest and a cross-brand store can't be carried in form state.
//
// Boundary mocking mirrors CopyToBrandDialog.test.tsx:
//   - react-native-toast-message (global jest.setup.ts) — Toast.show fn.
//   - ../../theme/colors — deterministic palette (no Zustand import chain).
//   - ../../theme/breakpoints — useIsPhone pinned false (desktop path).
//   - ./ResponsiveSheet — bypass the Modal/safe-area wrapper, render inline.
//   - ../../store/useStore — mutable snapshot exposing `stores` + `brand`.
//   - ../../lib/auth — inviteUser jest.fn().
//   - ../../hooks/useRole — useIsMaster pinned (per-test) so the role
//     picker + admin brand-warning path can be exercised.
//
// Component-project (jsdom) because this file imports a `.tsx`.

// ── Mocks (must precede any import of the component) ────────────────

jest.mock('../../theme/colors', () => ({
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

jest.mock('../../theme/breakpoints', () => ({
  useIsPhone: () => false,
  useIsCompact: () => false,
  useBreakpoint: () => 'desktop' as const,
}));

// Bypass the ResponsiveSheet Modal/safe-area wrapper — render header +
// children + footer inline so assertions hit the drawer body directly.
// Same rationale as CopyToBrandDialog.test.tsx.
jest.mock('./ResponsiveSheet', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    ResponsiveSheet: ({ visible, header, footer, children }: any) => {
      if (!visible) return null;
      return React.createElement(
        View,
        { testID: 'responsive-sheet' },
        header,
        children,
        footer,
      );
    },
  };
});

// useStore — mutable snapshot. Tests mutate `state.stores` / `state.brand`
// then re-render to exercise the brand-scope filter and the prune effect.
jest.mock('../../store/useStore', () => {
  const state: any = {
    stores: [],
    brand: null,
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

// inviteUser — default resolves success; tests assert call args.
jest.mock('../../lib/auth', () => ({
  inviteUser: jest.fn().mockResolvedValue({ error: null }),
}));

// useIsMaster — pinned per test (default true so the role picker renders).
jest.mock('../../hooks/useRole', () => ({
  useIsMaster: jest.fn(() => true),
}));

// ── Imports (resolve mocks above) ───────────────────────────────────
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';
import { InviteUserDrawer } from './InviteUserDrawer';
import { useIsMaster } from '../../hooks/useRole';

const toastShowMock = Toast.show as jest.Mock;

const useStoreModule = jest.requireMock('../../store/useStore');
const useIsMasterMock = useIsMaster as jest.Mock;

// Prod-shaped fixture (spec 068 problem statement): 2AM PROJECT has 4
// stores, Baltimore Seafood has 1. The global cache holds all 5.
const BRAND_2AM = { id: '2a', name: '2AM PROJECT' };
const BRAND_BSF = { id: 'e1', name: 'Baltimore Seafood' };
const STORES_ALL = [
  { id: 'charles',   brandId: '2a', name: 'Charles',   address: '' },
  { id: 'frederick', brandId: '2a', name: 'Frederick', address: '' },
  { id: 'reisters',  brandId: '2a', name: 'Reisters',  address: '' },
  { id: 'towson',    brandId: '2a', name: 'Towson',    address: '' },
  { id: 'baltimore', brandId: 'e1', name: 'Baltimore Seafood', address: '' },
];

function setStoreState(next: { stores?: any[]; brand?: any }) {
  if (next.stores !== undefined) useStoreModule.useStore.__state.stores = next.stores;
  if (next.brand !== undefined) useStoreModule.useStore.__state.brand = next.brand;
}

beforeEach(() => {
  jest.clearAllMocks();
  useIsMasterMock.mockReturnValue(true);
  // Reset the shared mutable snapshot between tests.
  useStoreModule.useStore.__state.stores = [];
  useStoreModule.useStore.__state.brand = null;
});

describe('InviteUserDrawer — store options brand scope', () => {
  it('renders only the active brand stores; counter M = filtered count', () => {
    setStoreState({ stores: STORES_ALL, brand: BRAND_2AM });
    render(<InviteUserDrawer visible onClose={() => {}} />);

    // Exactly the 4 2AM stores render as checkbox rows.
    expect(screen.getByText('Charles')).toBeTruthy();
    expect(screen.getByText('Frederick')).toBeTruthy();
    expect(screen.getByText('Reisters')).toBeTruthy();
    expect(screen.getByText('Towson')).toBeTruthy();
    // The Baltimore Seafood store (other brand) must NOT render.
    expect(screen.queryByText('Baltimore Seafood')).toBeNull();

    // Counter denominator is the filtered count (4), not the global 5.
    expect(screen.getByText('· 0 of 4 selected')).toBeTruthy();
  });

  it('updates the counter as stores in the active brand are toggled', () => {
    setStoreState({ stores: STORES_ALL, brand: BRAND_2AM });
    render(<InviteUserDrawer visible onClose={() => {}} />);

    fireEvent.press(screen.getByText('Charles'));
    expect(screen.getByText('· 1 of 4 selected')).toBeTruthy();
    fireEvent.press(screen.getByText('Towson'));
    expect(screen.getByText('· 2 of 4 selected')).toBeTruthy();
  });

  it('renders only the one Baltimore store in the Baltimore Seafood context', () => {
    setStoreState({ stores: STORES_ALL, brand: BRAND_BSF });
    render(<InviteUserDrawer visible onClose={() => {}} />);

    expect(screen.getByText('Baltimore Seafood')).toBeTruthy();
    expect(screen.queryByText('Charles')).toBeNull();
    expect(screen.queryByText('Towson')).toBeNull();
    expect(screen.getByText('· 0 of 1 selected')).toBeTruthy();
  });
});

describe('InviteUserDrawer — no-brand notice', () => {
  it('shows the brand-required notice and NO store checkboxes when brand is null', () => {
    // Super-admin "All brands" view: stores loaded across brands but no
    // active brand selected.
    setStoreState({ stores: STORES_ALL, brand: null });
    render(<InviteUserDrawer visible onClose={() => {}} />);

    // The new no-brand notice copy renders…
    expect(screen.getByText('Switch into a brand first to assign stores')).toBeTruthy();
    // …and it is DISTINCT from the brand-set-but-empty "No stores
    // visible yet" copy (which must NOT render here).
    expect(screen.queryByText('No stores visible yet')).toBeNull();

    // No store checkbox rows render despite a populated global cache.
    expect(screen.queryByText('Charles')).toBeNull();
    expect(screen.queryByText('Baltimore Seafood')).toBeNull();
    // The "M of N selected" counter is hidden in the no-brand view —
    // "0 of 0" would be noise alongside the notice. Assert its absence.
    expect(screen.queryByText(/of \d+ selected/)).toBeNull();
  });
});

describe('InviteUserDrawer — regressions', () => {
  it('keeps the role==="admin" brand-required warning when an admin invite has no brand', () => {
    setStoreState({ stores: STORES_ALL, brand: null });
    render(<InviteUserDrawer visible onClose={() => {}} />);

    // Switch the role picker to admin (master sees the picker).
    fireEvent.press(screen.getByText('admin'));
    expect(screen.getByText('Switch into a brand before inviting an admin')).toBeTruthy();
  });

  it('keeps the original "No stores visible yet" copy when a brand is set but has no stores', () => {
    // Brand active, but the cache holds zero stores for it.
    setStoreState({ stores: [], brand: BRAND_2AM });
    render(<InviteUserDrawer visible onClose={() => {}} />);

    expect(screen.getByText('No stores visible yet')).toBeTruthy();
    // NOT the no-brand notice — a brand IS active.
    expect(screen.queryByText('Switch into a brand first to assign stores')).toBeNull();
  });

  it('keeps the send button disabled until email + name are filled', () => {
    setStoreState({ stores: STORES_ALL, brand: BRAND_2AM });
    render(<InviteUserDrawer visible onClose={() => {}} />);

    // Footer status hint reflects the unmet required fields.
    expect(screen.getByText('fill in email + name')).toBeTruthy();
    expect(screen.queryByText('ready to send')).toBeNull();
  });
});

describe('InviteUserDrawer — username assignment (spec 095)', () => {
  const fillRequired = () => {
    fireEvent.changeText(screen.getByTestId('invite-email'), 'bob@example.com');
    fireEvent.changeText(screen.getByTestId('invite-name'), 'Bob');
  };

  it('renders an optional username field with the helper hint', () => {
    setStoreState({ stores: STORES_ALL, brand: BRAND_2AM });
    render(<InviteUserDrawer visible onClose={() => {}} />);
    expect(screen.getByTestId('invite-username')).toBeTruthy();
    expect(
      screen.getByText('3–20 characters · letters, numbers, _ and . · leave blank to use email only'),
    ).toBeTruthy();
  });

  it('stays ready-to-send when username is left BLANK (optional)', () => {
    setStoreState({ stores: STORES_ALL, brand: BRAND_2AM });
    render(<InviteUserDrawer visible onClose={() => {}} />);
    fillRequired();
    expect(screen.getByText('ready to send')).toBeTruthy();
  });

  it('shows an inline error and blocks send for an invalid username', () => {
    setStoreState({ stores: STORES_ALL, brand: BRAND_2AM });
    render(<InviteUserDrawer visible onClose={() => {}} />);
    fillRequired();
    fireEvent.changeText(screen.getByTestId('invite-username'), 'ab'); // too short
    expect(screen.getByTestId('invite-username-error')).toBeTruthy();
    // Footer reverts to the unmet-requirement hint → send is gated.
    expect(screen.queryByText('ready to send')).toBeNull();
  });

  it('blocks a reserved username with the reserved error', () => {
    setStoreState({ stores: STORES_ALL, brand: BRAND_2AM });
    render(<InviteUserDrawer visible onClose={() => {}} />);
    fillRequired();
    fireEvent.changeText(screen.getByTestId('invite-username'), 'admin');
    const err = screen.getByTestId('invite-username-error');
    expect(err.props.children).toMatch(/reserved/i);
    expect(screen.queryByText('ready to send')).toBeNull();
  });

  it('passes the trimmed username through to inviteUser when valid', async () => {
    const { inviteUser } = jest.requireMock('../../lib/auth');
    setStoreState({ stores: STORES_ALL, brand: BRAND_2AM });
    render(<InviteUserDrawer visible onClose={() => {}} />);
    fillRequired();
    fireEvent.changeText(screen.getByTestId('invite-username'), '  bobby_b  ');
    await act(async () => {
      fireEvent.press(screen.getByTestId('invite-submit'));
    });
    expect(inviteUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'bobby_b' }),
    );
  });

  it('sends username: null when the field is left blank', async () => {
    const { inviteUser } = jest.requireMock('../../lib/auth');
    setStoreState({ stores: STORES_ALL, brand: BRAND_2AM });
    render(<InviteUserDrawer visible onClose={() => {}} />);
    fillRequired();
    await act(async () => {
      fireEvent.press(screen.getByTestId('invite-submit'));
    });
    expect(inviteUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: null }),
    );
  });

  // Spec 095 / code-reviewer #3 — usernames are stored case-folded. The drawer
  // lowercases as the admin types so the displayed value matches what is
  // stored (no silent "Bobby_B" → "bobby_b" surprise).
  it('lowercases a mixed-case username in the field AND passes the folded value through', async () => {
    const { inviteUser } = jest.requireMock('../../lib/auth');
    setStoreState({ stores: STORES_ALL, brand: BRAND_2AM });
    render(<InviteUserDrawer visible onClose={() => {}} />);
    fillRequired();
    const field = screen.getByTestId('invite-username');
    fireEvent.changeText(field, 'Bobby_B');
    // The displayed value is folded, so the admin sees the stored form.
    expect(field.props.value).toBe('bobby_b');
    await act(async () => {
      fireEvent.press(screen.getByTestId('invite-submit'));
    });
    expect(inviteUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'bobby_b' }),
    );
  });
});

describe('InviteUserDrawer — "username taken" error heuristic (spec 095)', () => {
  const fillRequired = () => {
    fireEvent.changeText(screen.getByTestId('invite-email'), 'bob@example.com');
    fireEvent.changeText(screen.getByTestId('invite-name'), 'Bob');
  };

  it('labels a username unique-violation by the index name as "username taken"', async () => {
    const { inviteUser } = jest.requireMock('../../lib/auth');
    inviteUser.mockResolvedValueOnce({
      error:
        'duplicate key value violates unique constraint "profiles_username_lower_key"',
    });
    setStoreState({ stores: STORES_ALL, brand: BRAND_2AM });
    render(<InviteUserDrawer visible onClose={() => {}} />);
    fillRequired();
    fireEvent.changeText(screen.getByTestId('invite-username'), 'bobby_b');
    await act(async () => {
      fireEvent.press(screen.getByTestId('invite-submit'));
    });
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text2: 'Username "bobby_b" is already taken',
      }),
    );
  });

  it('does NOT mislabel an unrelated 23505 (different index) as "username taken"', async () => {
    const { inviteUser } = jest.requireMock('../../lib/auth');
    // An unrelated unique violation (e.g. a duplicate-email invitation). The
    // old broad regex (/23505|duplicate key|already exists|username/i) would
    // have mislabeled this as a username collision.
    const otherError =
      'duplicate key value violates unique constraint "invitations_email_key" (23505)';
    inviteUser.mockResolvedValueOnce({ error: otherError });
    setStoreState({ stores: STORES_ALL, brand: BRAND_2AM });
    render(<InviteUserDrawer visible onClose={() => {}} />);
    fillRequired();
    fireEvent.changeText(screen.getByTestId('invite-username'), 'bobby_b');
    await act(async () => {
      fireEvent.press(screen.getByTestId('invite-submit'));
    });
    // Surfaces the raw error verbatim, NOT the username-taken message.
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ text2: otherError }),
    );
  });
});

describe('InviteUserDrawer — stale-selection prune on brand switch', () => {
  it('drops a selection that is not in the new brand after a header brand switch', () => {
    // Start in 2AM, select Charles (a 2AM store).
    setStoreState({ stores: STORES_ALL, brand: BRAND_2AM });
    const { rerender } = render(<InviteUserDrawer visible onClose={() => {}} />);
    fireEvent.press(screen.getByText('Charles'));
    expect(screen.getByText('· 1 of 4 selected')).toBeTruthy();

    // Operator switches the header brand picker to Baltimore Seafood
    // while the drawer is open. Mutate the shared snapshot and re-render
    // to fire the brand-keyed prune effect.
    act(() => {
      setStoreState({ brand: BRAND_BSF });
      rerender(<InviteUserDrawer visible onClose={() => {}} />);
    });

    // Charles is no longer an option (other brand) and the stale
    // selection was pruned — counter resets to 0 of 1, not 1 of 1.
    expect(screen.queryByText('Charles')).toBeNull();
    expect(screen.getByText('· 0 of 1 selected')).toBeTruthy();
  });
});
