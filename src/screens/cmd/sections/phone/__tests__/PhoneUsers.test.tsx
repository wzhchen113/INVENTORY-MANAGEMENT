// src/screens/cmd/sections/phone/__tests__/PhoneUsers.test.tsx — Spec 146.
//
// Pins the phone Users tier: the role-pill semantic-token mapping (incl. the
// never-the-accent guarantee), the two-line rows (INVITED pill for pending), the
// drill-in detail + reused delete modal, and the reused InviteUserDrawer send
// path (fill → SEND → inviteUser + onInvited) with super-admin role-chip gating.
//
// InviteUserDrawer is REAL (reuse mandate) so supabase + safe-area are stubbed
// and inviteUser is mocked; the store is seeded so the drawer's requiredValid
// (email + name) can be satisfied.

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

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
    from: jest.fn(() => ({ select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), order: jest.fn().mockReturnThis(), single: jest.fn(() => Promise.resolve({ data: null, error: null })), maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })) })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

const mockInviteUser = jest.fn(() => Promise.resolve({ error: null }));
jest.mock('../../../../../lib/auth', () => ({
  __esModule: true,
  inviteUser: (...args: unknown[]) => (mockInviteUser as (...a: unknown[]) => Promise<{ error: null }>)(...args),
}));

import { PhoneUsers, rolePillTone, type PhoneUsersModel } from '../PhoneUsers';
import { useStore } from '../../../../../store/useStore';
import { LightCmd } from '../../../../../theme/colors';
import type { User } from '../../../../../types';

function mkUser(over: Partial<User> = {}): User {
  return {
    id: 'u1', name: 'Bobby Bobson', nickname: '', email: 'bobby@example.com',
    role: 'admin', stores: ['store-1'], status: 'active', initials: 'BB', color: '#333',
    brandId: 'b', ...over,
  } as User;
}

function seedStore(role: User['role'] = 'master') {
  useStore.setState({
    currentUser: { id: 'me', name: 'Me', email: 'me@x.co', role } as any,
    stores: [{ id: 'store-1', brandId: 'b', name: 'Fells Point', address: '', status: 'active' } as any],
    brand: { id: 'b', name: '2AM PROJECT' } as any,
  });
}

function baseModel(over: Partial<PhoneUsersModel> = {}): PhoneUsersModel {
  return {
    loading: false,
    visibleUsers: [mkUser()],
    isMaster: true,
    currentUserId: 'me',
    stores: [{ id: 'store-1', brandId: 'b', name: 'Fells Point', address: '', status: 'active' } as any],
    lastOfRole: { super_admin: false, master: false },
    inviteOpen: false,
    setInviteOpen: jest.fn(),
    deleteTarget: null,
    setDeleteTarget: jest.fn(),
    onConfirmDelete: jest.fn(),
    onResetPassword: jest.fn(),
    onInvited: jest.fn(),
    ...over,
  };
}

// A stateful wrapper so pressing "+ INVITE" / DELETE actually toggles the
// host-owned overlay state (mirrors UsersSection's model wiring).
function Harness({ model }: { model?: Partial<PhoneUsersModel> }) {
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<User | null>(null);
  const m = baseModel({ ...model, inviteOpen, setInviteOpen, deleteTarget, setDeleteTarget });
  return <PhoneUsers model={m} />;
}

beforeEach(() => {
  jest.clearAllMocks();
  seedStore('master');
});

describe('rolePillTone — semantic mapping, never the accent', () => {
  it('maps each stored role to a semantic tone (never accent)', () => {
    expect(rolePillTone('admin')).toBe('info');
    expect(rolePillTone('super_admin')).toBe('info');
    expect(rolePillTone('master')).toBe('ok');
    expect(rolePillTone('user')).toBe('neutral');
    // The three tones resolve to info / ok / fg2 — none is the accent token.
    for (const t of ['info', 'ok', 'neutral'] as const) {
      expect(t).not.toBe('accent');
    }
  });

  it('renders the admin role pill in the info token, distinct from the accent', () => {
    const { getByText } = render(<Harness />);
    const pill = getByText('Admin');
    const flat = Object.assign({}, ...[].concat(pill.props.style));
    expect(flat.color).toBe(LightCmd.info);
    expect(flat.color).not.toBe(LightCmd.accent);
  });
});

describe('PhoneUsers — list rows', () => {
  it('renders a row with the role pill + email meta', () => {
    const { getByTestId, getByText } = render(<Harness />);
    expect(getByTestId('phone-user-row-u1')).toBeTruthy();
    expect(getByText('Admin')).toBeTruthy();
    expect(getByText('bobby@example.com')).toBeTruthy();
  });

  it('shows an INVITED pill for a pending user', () => {
    const { getByText } = render(<Harness model={{ visibleUsers: [mkUser({ status: 'pending' })] }} />);
    expect(getByText('INVITED')).toBeTruthy();
  });
});

describe('PhoneUsers — drill-in detail + reused delete modal', () => {
  it('opens the full-screen detail and DELETE arms the type-to-confirm modal', () => {
    const { getByTestId, getByText, queryByText } = render(
      <Harness model={{ visibleUsers: [mkUser({ id: 'u1', role: 'admin' })] }} />,
    );
    fireEvent.press(getByTestId('phone-user-row-u1'));
    expect(getByTestId('phone-user-properties')).toBeTruthy();
    // master viewer can delete a non-self admin → DELETE affordance present.
    fireEvent.press(getByTestId('phone-user-delete'));
    // TypeToConfirmModal renders its destructive label once armed.
    expect(queryByText(/permanently delete/i)).toBeTruthy();
  });
});

describe('PhoneUsers — reused InviteUserDrawer send path', () => {
  it('open → fill email + name → SEND calls inviteUser and onInvited', async () => {
    const onInvited = jest.fn();
    const { getByTestId } = render(<Harness model={{ onInvited }} />);
    fireEvent.press(getByTestId('phone-users-invite'));
    fireEvent.changeText(getByTestId('invite-email'), 'new@example.com');
    fireEvent.changeText(getByTestId('invite-name'), 'New Person');
    fireEvent.press(getByTestId('invite-submit'));
    await waitFor(() => expect(mockInviteUser).toHaveBeenCalledTimes(1));
    expect(mockInviteUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'new@example.com', name: 'New Person' }));
    await waitFor(() => expect(onInvited).toHaveBeenCalled());
  });

  it('gates the role chips: master sees them, a plain admin does not', () => {
    seedStore('master');
    const a = render(<Harness />);
    fireEvent.press(a.getByTestId('phone-users-invite'));
    expect(a.queryByTestId('invite-role-admin')).toBeTruthy();
    a.unmount();

    seedStore('admin');
    const b = render(<Harness />);
    fireEvent.press(b.getByTestId('phone-users-invite'));
    expect(b.queryByTestId('invite-role-admin')).toBeNull();
  });
});
