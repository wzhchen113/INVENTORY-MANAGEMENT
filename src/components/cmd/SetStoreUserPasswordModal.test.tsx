// src/components/cmd/SetStoreUserPasswordModal.test.tsx — Spec 165 §G (jest, jsdom).
//
// Pins the SET PASSWORD modal for username-only store users: it names the
// target by @username, shows the session sign-out note, gates on an 8-char
// password with a show/hide toggle, calls setStoreUserPassword(userId, pw),
// toasts "Password updated for @username" (never the password), maps errors,
// and clears the password from state on close.

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

const mockSetStoreUserPassword = jest.fn();
jest.mock('../../lib/auth', () => ({
  STORE_USER_PASSWORD_MIN_LENGTH: 8,
  setStoreUserPassword: (...args: unknown[]) => mockSetStoreUserPassword(...args),
}));

// ── Imports (resolve mocks above) ───────────────────────────────────
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';
import { SetStoreUserPasswordModal } from './SetStoreUserPasswordModal';
import type { User } from '../../types';

const toastShowMock = Toast.show as jest.Mock;
const PASSWORD = 'n3w-passw0rd';

const TARGET: User = {
  id: 'u-marcus', name: 'Marcus Lee', nickname: '', email: '', role: 'user',
  stores: ['towson'], status: 'active', initials: 'ML', color: '#378ADD',
  username: 'marcus.l', loginKind: 'username',
};

function submitDisabled(): boolean {
  return !!screen.getByTestId('set-password-submit').props.accessibilityState?.disabled;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSetStoreUserPassword.mockResolvedValue({ error: null });
});

afterEach(() => {
  for (const args of toastShowMock.mock.calls) {
    expect(JSON.stringify(args)).not.toContain(PASSWORD);
  }
});

describe('SetStoreUserPasswordModal', () => {
  it('renders nothing without a target', () => {
    render(<SetStoreUserPasswordModal target={null} onClose={() => {}} />);
    expect(screen.queryByTestId('set-password-input')).toBeNull();
  });

  it('names the target by @username and shows the session sign-out note', () => {
    render(<SetStoreUserPasswordModal target={TARGET} onClose={() => {}} />);
    expect(screen.getAllByText(/@marcus\.l/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('set-password-session-note')).toBeTruthy();
    expect(
      screen.getByText("Signs @marcus.l out on every device. A device that's open right now may keep working for up to an hour."),
    ).toBeTruthy();
  });

  it('gates submit on an 8-character password and toggles secure entry', () => {
    render(<SetStoreUserPasswordModal target={TARGET} onClose={() => {}} />);
    expect(submitDisabled()).toBe(true);
    fireEvent.changeText(screen.getByTestId('set-password-input'), 'short');
    expect(submitDisabled()).toBe(true);
    expect(screen.getByTestId('set-password-error')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('set-password-input'), PASSWORD);
    expect(submitDisabled()).toBe(false);

    expect(screen.getByTestId('set-password-input').props.secureTextEntry).toBe(true);
    fireEvent.press(screen.getByTestId('set-password-toggle'));
    expect(screen.getByTestId('set-password-input').props.secureTextEntry).toBe(false);
  });

  it('calls setStoreUserPassword, toasts success with @username, clears the password, closes', async () => {
    const onClose = jest.fn();
    render(<SetStoreUserPasswordModal target={TARGET} onClose={onClose} />);
    fireEvent.changeText(screen.getByTestId('set-password-input'), PASSWORD);
    fireEvent.press(screen.getByTestId('set-password-submit'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockSetStoreUserPassword).toHaveBeenCalledWith('u-marcus', PASSWORD);
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text1: 'Password updated for @marcus.l' }),
    );
    expect(screen.getByTestId('set-password-input').props.value).toBe('');
  });

  it('shows the server error string and stays open on failure', async () => {
    mockSetStoreUserPassword.mockResolvedValue({ error: 'account has an email; use password reset' });
    const onClose = jest.fn();
    render(<SetStoreUserPasswordModal target={TARGET} onClose={onClose} />);
    fireEvent.changeText(screen.getByTestId('set-password-input'), PASSWORD);
    fireEvent.press(screen.getByTestId('set-password-submit'));

    await waitFor(() =>
      expect(toastShowMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', text2: 'account has an email; use password reset' }),
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('maps forbidden* to the permission message', async () => {
    mockSetStoreUserPassword.mockResolvedValue({ error: 'forbidden: target is not a store user' });
    render(<SetStoreUserPasswordModal target={TARGET} onClose={() => {}} />);
    fireEvent.changeText(screen.getByTestId('set-password-input'), PASSWORD);
    fireEvent.press(screen.getByTestId('set-password-submit'));
    await waitFor(() =>
      expect(toastShowMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', text2: "You don't have permission to manage users in this brand." }),
      ),
    );
  });

  it('clears the password when closed and re-opened', () => {
    const { rerender } = render(<SetStoreUserPasswordModal target={TARGET} onClose={() => {}} />);
    fireEvent.changeText(screen.getByTestId('set-password-input'), PASSWORD);
    rerender(<SetStoreUserPasswordModal target={null} onClose={() => {}} />);
    rerender(<SetStoreUserPasswordModal target={TARGET} onClose={() => {}} />);
    expect(screen.getByTestId('set-password-input').props.value).toBe('');
  });
});

// Code-reviewer nit (spec 165 review): plain Enter submits ONLY from the
// password input (its onSubmitEditing); a plain Enter reaching the document
// (e.g. from a focused CANCEL) must not submit. Cmd/Ctrl+Enter still saves.
describe('SetStoreUserPasswordModal — keyboard submit', () => {
  const { Platform } = require('react-native');
  let restore: (() => void) | null = null;
  beforeEach(() => {
    const replaced = jest.replaceProperty(Platform, 'OS', 'web');
    restore = () => replaced.restore();
  });
  afterEach(() => { restore?.(); });

  const pressKey = (init: KeyboardEventInit) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, ...init }));
  };

  it('a plain Enter outside the password input does not submit', async () => {
    render(<SetStoreUserPasswordModal target={TARGET} onClose={() => {}} />);
    fireEvent.changeText(screen.getByTestId('set-password-input'), PASSWORD);
    pressKey({ key: 'Enter' });
    await Promise.resolve();
    expect(mockSetStoreUserPassword).not.toHaveBeenCalled();
  });

  it('Enter in the password input (onSubmitEditing) submits', async () => {
    const onClose = jest.fn();
    render(<SetStoreUserPasswordModal target={TARGET} onClose={onClose} />);
    const input = screen.getByTestId('set-password-input');
    fireEvent.changeText(input, PASSWORD);
    fireEvent(input, 'submitEditing');
    await waitFor(() => expect(mockSetStoreUserPassword).toHaveBeenCalledWith('u-marcus', PASSWORD));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('Enter in the input with a too-short password does not submit', async () => {
    render(<SetStoreUserPasswordModal target={TARGET} onClose={() => {}} />);
    const input = screen.getByTestId('set-password-input');
    fireEvent.changeText(input, 'short');
    fireEvent(input, 'submitEditing');
    await Promise.resolve();
    expect(mockSetStoreUserPassword).not.toHaveBeenCalled();
  });

  it('Cmd+Enter on the document still submits', async () => {
    render(<SetStoreUserPasswordModal target={TARGET} onClose={() => {}} />);
    fireEvent.changeText(screen.getByTestId('set-password-input'), PASSWORD);
    pressKey({ key: 'Enter', metaKey: true });
    await waitFor(() => expect(mockSetStoreUserPassword).toHaveBeenCalledWith('u-marcus', PASSWORD));
  });
});
