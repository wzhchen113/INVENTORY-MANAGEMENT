// src/components/cmd/InviteAdminDrawer.test.tsx — Spec 198 AD-10 (jest).
//
// InviteAdminDrawer (BrandsSection members tab, super_admin) is the second
// invite surface. Since spec 198 a claim needs the one-time invite code, so an
// invitation sent from here is useless unless this drawer shows the link too.
// Pins: after a successful invite the drawer stays open and renders the shared
// InviteLinkPanel (`invite-link`), DONE closes it, the stores refresh that
// re-runs the form-reset effect does NOT wipe the link, and Cmd+Enter does
// not re-submit. Review CR-2: the panel renders the server-issued expiresAt.
//
// Boundary mocks mirror InviteUserDrawer.test.tsx (colors, breakpoints,
// ResponsiveSheet inline, mutable useStore snapshot, inviteUser jest.fn).

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

jest.mock('./ResponsiveSheet', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    ResponsiveSheet: ({ visible, header, footer, children }: any) => {
      if (!visible) return null;
      return React.createElement(View, { testID: 'responsive-sheet' }, header, children, footer);
    },
  };
});

jest.mock('../../store/useStore', () => {
  const state: any = { stores: [] };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

// Literal inlined: the hoisted factory runs before module-level consts exist.
jest.mock('../../lib/auth', () => ({
  inviteUser: jest.fn().mockResolvedValue({
    error: null,
    inviteCode: 'abcdefabcdefabcdefabcdefabcdef01',
    expiresAt: '2026-11-12T12:00:00Z',
  }),
}));

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';
import { InviteAdminDrawer } from './InviteAdminDrawer';

const CODE = 'abcdefabcdefabcdefabcdefabcdef01';
const BRAND = { id: '2a000000-0000-0000-0000-000000000001', name: '2AM PROJECT' };
const STORES = [
  { id: 'towson', brandId: BRAND.id, name: 'Towson', address: '' },
  { id: 'charles', brandId: BRAND.id, name: 'Charles', address: '' },
];

const useStoreModule = jest.requireMock('../../store/useStore');
const { inviteUser } = jest.requireMock('../../lib/auth');
const toastShowMock = Toast.show as jest.Mock;
const { Platform } = require('react-native');

let restoreOS: (() => void) | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  useStoreModule.useStore.__state.stores = STORES;
  const replaced = jest.replaceProperty(Platform, 'OS', 'web');
  restoreOS = () => replaced.restore();
});

afterEach(() => {
  restoreOS?.();
  restoreOS = null;
});

const renderDrawer = (props: Partial<React.ComponentProps<typeof InviteAdminDrawer>> = {}) =>
  render(
    <InviteAdminDrawer
      visible
      brandId={BRAND.id}
      brandName={BRAND.name}
      onClose={() => {}}
      {...props}
    />,
  );

const submit = async () => {
  fireEvent.changeText(screen.getByPlaceholderText('bobby@example.com'), 'newadmin@example.com');
  fireEvent.changeText(screen.getByPlaceholderText('Bobby Bobson'), 'New Admin');
  await act(async () => {
    fireEvent.press(screen.getByText('SEND  ⌘⏎'));
  });
};

describe('InviteAdminDrawer — invite link (spec 198 AD-10)', () => {
  it('shows the shared link panel after a successful invite and stays open', async () => {
    const onClose = jest.fn();
    const onInvited = jest.fn();
    renderDrawer({ onClose, onInvited });
    await submit();

    expect(inviteUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'newadmin@example.com', role: 'admin', brandId: BRAND.id }),
    );
    expect(screen.getByTestId('invite-link').props.children).toBe(
      `${window.location.origin}/?register=true&invite=${CODE}`,
    );
    expect(screen.getByTestId('invite-link-copy')).toBeTruthy();
    expect(onInvited).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('SEND  ⌘⏎')).toBeNull();
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text1: 'Invitation created' }),
    );
  });

  it('renders the server-issued expiry, not a hard-coded "48 hours" (review CR-2)', async () => {
    renderDrawer();
    await submit();

    const { formatInviteExpiry } = jest.requireActual('../../lib/inviteLink');
    const label = formatInviteExpiry('2026-11-12T12:00:00Z');
    expect(label).not.toBeNull();
    expect(
      screen.getByText(`Send this link to newadmin@example.com. It works once and expires ${label}.`),
    ).toBeTruthy();
    expect(screen.queryByText(/48 hours/)).toBeNull();
  });

  it('an unparseable expiresAt drops the time instead of guessing', async () => {
    inviteUser.mockResolvedValueOnce({ error: null, inviteCode: CODE, expiresAt: '' });
    renderDrawer();
    await submit();

    expect(screen.getByText('Send this link to newadmin@example.com. It works once.')).toBeTruthy();
  });

  it('invite-done closes the drawer', async () => {
    const onClose = jest.fn();
    renderDrawer({ onClose });
    await submit();

    fireEvent.press(screen.getByTestId('invite-done'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a stores refresh while the link is showing does not wipe it', async () => {
    const { rerender } = renderDrawer();
    await submit();
    expect(screen.getByTestId('invite-link')).toBeTruthy();

    // A new `stores` array identity re-runs the form-reset effect.
    act(() => {
      useStoreModule.useStore.__state.stores = [...STORES];
      rerender(<InviteAdminDrawer visible brandId={BRAND.id} brandName={BRAND.name} onClose={() => {}} />);
    });
    expect(screen.getByTestId('invite-link').props.children).toContain(CODE);
  });

  it('re-opening the drawer returns to the form', async () => {
    const { rerender } = renderDrawer();
    await submit();
    rerender(<InviteAdminDrawer visible={false} brandId={BRAND.id} brandName={BRAND.name} onClose={() => {}} />);
    rerender(<InviteAdminDrawer visible brandId={BRAND.id} brandName={BRAND.name} onClose={() => {}} />);

    expect(screen.queryByTestId('invite-link')).toBeNull();
    expect(screen.getByPlaceholderText('bobby@example.com')).toBeTruthy();
  });

  it('an error keeps the form and shows no link', async () => {
    inviteUser.mockResolvedValueOnce({ error: 'admin invitation requires a brand' });
    renderDrawer();
    await submit();

    expect(screen.queryByTestId('invite-link')).toBeNull();
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', text2: 'admin invitation requires a brand' }),
    );
  });

  it('Cmd+Enter while the link is showing does not re-submit', async () => {
    renderDrawer();
    await submit();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, cancelable: true }));
    });
    expect(inviteUser).toHaveBeenCalledTimes(1);
  });
});
