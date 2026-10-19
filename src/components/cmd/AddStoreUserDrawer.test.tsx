// src/components/cmd/AddStoreUserDrawer.test.tsx — Spec 165 §F (jest, jsdom).
//
// Pins the "+ ADD USER" drawer: submit gating (name + valid username +
// 8-char password + >=1 store) with a footer hint naming what's missing,
// username lowercased as typed + inline validation, the spec 068 brand filter
// and no-brand / no-stores notices, the createStoreUser payload, the
// taken-username / forbidden toast mapping (drawer stays open, input kept),
// and that the password is cleared on close + success and never toasted.
//
// Boundary mocks mirror InviteUserDrawer.test.tsx (colors, breakpoints,
// ResponsiveSheet inline, mutable useStore snapshot); lib/auth is mocked.

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

const mockCreateStoreUser = jest.fn();
jest.mock('../../lib/auth', () => ({
  STORE_USER_PASSWORD_MIN_LENGTH: 8,
  createStoreUser: (...args: unknown[]) => mockCreateStoreUser(...args),
}));

// ── Imports (resolve mocks above) ───────────────────────────────────
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';
import { AddStoreUserDrawer } from './AddStoreUserDrawer';

const toastShowMock = Toast.show as jest.Mock;
const useStoreModule = jest.requireMock('../../store/useStore');

const BRAND_2AM = { id: '2a', name: '2AM PROJECT' };
const STORES_ALL = [
  { id: 'charles', brandId: '2a', name: 'Charles', address: '' },
  { id: 'towson',  brandId: '2a', name: 'Towson',  address: '' },
  { id: 'baltimore', brandId: 'e1', name: 'Baltimore Seafood', address: '' },
];
const PASSWORD = 'hunter22pw';

function setStoreState(next: { stores?: any[]; brand?: any }) {
  if (next.stores !== undefined) useStoreModule.useStore.__state.stores = next.stores;
  if (next.brand !== undefined) useStoreModule.useStore.__state.brand = next.brand;
}

function submitDisabled(): boolean {
  return !!screen.getByTestId('add-user-submit').props.accessibilityState?.disabled;
}

function fillValid() {
  fireEvent.changeText(screen.getByTestId('add-user-name'), 'Marcus Lee');
  fireEvent.changeText(screen.getByTestId('add-user-username'), 'marcus.l');
  fireEvent.changeText(screen.getByTestId('add-user-password'), PASSWORD);
  fireEvent.press(screen.getByTestId('add-user-store-towson'));
}

function assertNoPasswordInToasts() {
  for (const args of toastShowMock.mock.calls) {
    expect(JSON.stringify(args)).not.toContain(PASSWORD);
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateStoreUser.mockResolvedValue({ data: { id: 'new-id', username: 'marcus.l' }, error: null });
  setStoreState({ stores: STORES_ALL, brand: BRAND_2AM });
});

describe('AddStoreUserDrawer — gating + validation', () => {
  it('renders nothing when not visible', () => {
    render(<AddStoreUserDrawer visible={false} onClose={() => {}} />);
    expect(screen.queryByTestId('add-user-submit')).toBeNull();
  });

  it('has no role picker or email field and explains the account type', () => {
    render(<AddStoreUserDrawer visible onClose={() => {}} />);
    expect(screen.queryByTestId('invite-role-admin')).toBeNull();
    expect(screen.queryByTestId('invite-email')).toBeNull();
    expect(screen.getByText(/signs in to the staff app with this username and password/)).toBeTruthy();
  });

  it('keeps submit disabled until name, username, password (8+) and a store are present; hint names the gaps', () => {
    render(<AddStoreUserDrawer visible onClose={() => {}} />);
    expect(submitDisabled()).toBe(true);
    expect(screen.getByTestId('add-user-hint').props.children).toBe('needs name, username, password (8+), a store');

    fireEvent.changeText(screen.getByTestId('add-user-name'), 'Marcus Lee');
    fireEvent.changeText(screen.getByTestId('add-user-username'), 'marcus.l');
    fireEvent.changeText(screen.getByTestId('add-user-password'), 'short');
    expect(submitDisabled()).toBe(true);
    expect(screen.getByTestId('add-user-hint').props.children).toBe('needs password (8+), a store');
    expect(screen.getByTestId('add-user-password-error')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('add-user-password'), PASSWORD);
    // Store still required.
    expect(submitDisabled()).toBe(true);
    expect(screen.getByTestId('add-user-hint').props.children).toBe('needs a store');

    fireEvent.press(screen.getByTestId('add-user-store-towson'));
    expect(submitDisabled()).toBe(false);
    expect(screen.getByTestId('add-user-hint').props.children).toBe('ready to create');
  });

  it('lowercases the username as typed and shows the validator error inline', () => {
    render(<AddStoreUserDrawer visible onClose={() => {}} />);
    fireEvent.changeText(screen.getByTestId('add-user-username'), 'Marcus.L');
    expect(screen.getByTestId('add-user-username').props.value).toBe('marcus.l');
    expect(screen.queryByTestId('add-user-username-error')).toBeNull();

    fireEvent.changeText(screen.getByTestId('add-user-username'), 'a!');
    expect(screen.getByTestId('add-user-username-error')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('add-user-username'), 'admin');
    expect(screen.getByTestId('add-user-username-error')).toBeTruthy();
  });

  it('show/hide toggles secure entry on the password field', () => {
    render(<AddStoreUserDrawer visible onClose={() => {}} />);
    expect(screen.getByTestId('add-user-password').props.secureTextEntry).toBe(true);
    fireEvent.press(screen.getByTestId('add-user-password-toggle'));
    expect(screen.getByTestId('add-user-password').props.secureTextEntry).toBe(false);
  });

  it('only lists the active brand stores (spec 068 filter)', () => {
    render(<AddStoreUserDrawer visible onClose={() => {}} />);
    expect(screen.getByText('Charles')).toBeTruthy();
    expect(screen.getByText('Towson')).toBeTruthy();
    expect(screen.queryByText('Baltimore Seafood')).toBeNull();
  });

  it('no-brand view shows the switch-brand notice and keeps submit disabled', () => {
    setStoreState({ brand: null });
    render(<AddStoreUserDrawer visible onClose={() => {}} />);
    expect(screen.getByTestId('add-user-no-brand')).toBeTruthy();
    expect(screen.getByText('Switch into a brand first to assign stores')).toBeTruthy();
    expect(screen.queryByText('Charles')).toBeNull();
    fireEvent.changeText(screen.getByTestId('add-user-name'), 'Marcus Lee');
    fireEvent.changeText(screen.getByTestId('add-user-username'), 'marcus.l');
    fireEvent.changeText(screen.getByTestId('add-user-password'), PASSWORD);
    expect(submitDisabled()).toBe(true);
  });

  it('a brand with zero stores shows a notice and keeps submit disabled', () => {
    setStoreState({ stores: [], brand: BRAND_2AM });
    render(<AddStoreUserDrawer visible onClose={() => {}} />);
    expect(screen.getByTestId('add-user-no-stores')).toBeTruthy();
    expect(submitDisabled()).toBe(true);
  });
});

describe('AddStoreUserDrawer — submit', () => {
  it('sends the four fields, toasts @username (never the password), clears the password, refreshes + closes', async () => {
    const onClose = jest.fn();
    const onCreated = jest.fn();
    render(<AddStoreUserDrawer visible onClose={onClose} onCreated={onCreated} />);
    fillValid();
    fireEvent.press(screen.getByTestId('add-user-submit'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockCreateStoreUser).toHaveBeenCalledWith({
      name: 'Marcus Lee',
      username: 'marcus.l',
      password: PASSWORD,
      storeIds: ['towson'],
    });
    expect(onCreated).toHaveBeenCalled();
    expect(toastShowMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', text2: '@marcus.l' }));
    // Still mounted (host never flipped visible) — the password is gone.
    expect(screen.getByTestId('add-user-password').props.value).toBe('');
    assertNoPasswordInToasts();
  });

  it('maps "username taken" to the named message and keeps the drawer open with input kept', async () => {
    mockCreateStoreUser.mockResolvedValue({ data: null, error: 'username taken' });
    const onClose = jest.fn();
    render(<AddStoreUserDrawer visible onClose={onClose} />);
    fillValid();
    fireEvent.press(screen.getByTestId('add-user-submit'));

    await waitFor(() => expect(toastShowMock).toHaveBeenCalled());
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', text2: 'Username "marcus.l" is already taken' }),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('add-user-username').props.value).toBe('marcus.l');
    expect(screen.getByTestId('add-user-password').props.value).toBe(PASSWORD);
    assertNoPasswordInToasts();
  });

  it('maps forbidden* to the permission message', async () => {
    mockCreateStoreUser.mockResolvedValue({ data: null, error: 'forbidden: target is in a different brand' });
    render(<AddStoreUserDrawer visible onClose={() => {}} />);
    fillValid();
    fireEvent.press(screen.getByTestId('add-user-submit'));
    await waitFor(() =>
      expect(toastShowMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', text2: "You don't have permission to manage users in this brand." }),
      ),
    );
  });

  it('passes any other server string through verbatim', async () => {
    mockCreateStoreUser.mockResolvedValue({ data: null, error: 'stores must belong to one brand' });
    render(<AddStoreUserDrawer visible onClose={() => {}} />);
    fillValid();
    fireEvent.press(screen.getByTestId('add-user-submit'));
    await waitFor(() =>
      expect(toastShowMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', text2: 'stores must belong to one brand' }),
      ),
    );
  });

  it('clears the password when the drawer is closed and re-opened', () => {
    const { rerender } = render(<AddStoreUserDrawer visible onClose={() => {}} />);
    fireEvent.changeText(screen.getByTestId('add-user-password'), PASSWORD);
    expect(screen.getByTestId('add-user-password').props.value).toBe(PASSWORD);
    rerender(<AddStoreUserDrawer visible={false} onClose={() => {}} />);
    rerender(<AddStoreUserDrawer visible onClose={() => {}} />);
    expect(screen.getByTestId('add-user-password').props.value).toBe('');
  });
});
