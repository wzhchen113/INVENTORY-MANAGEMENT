// Spec 165 — Users & access (desktop/tablet UserRow) for username-only store
// users: the "+ ADD USER" trigger sits beside "+ INVITE USER"; placeholder
// rows show `@username · shortId` + a "username sign-in" marker, never an
// email or "(email not loaded)"; RESET PW is hidden and SET PASSWORD shown;
// the delete confirm uses the username. Real-email rows are unchanged.
// Mocks mirror UsersSection.identityLine.spec163.test.tsx.

import React from 'react';
import { render, fireEvent, waitFor, within } from '@testing-library/react-native';

const mockUsers: any[] = [];
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));

jest.mock('../../../../lib/supabase', () => ({
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

// UsersSection fetches the user list on mount — stub the auth boundary so the
// mount is deterministic and does not hit the network.
jest.mock('../../../../lib/auth', () => ({
  __esModule: true,
  fetchAllUsers: jest.fn(() => Promise.resolve(mockUsers)),
  sendPasswordReset: jest.fn(() => Promise.resolve({ error: null })),
  inviteUser: jest.fn(() => Promise.resolve({ error: null })),
  // Spec 165 — Add-user drawer + SET PASSWORD modal wrappers.
  STORE_USER_PASSWORD_MIN_LENGTH: 8,
  createStoreUser: jest.fn(() => Promise.resolve({ data: null, error: null })),
  setStoreUserPassword: jest.fn(() => Promise.resolve({ error: null })),
}));

let mockTier: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../theme/breakpoints');
  return {
    ...actual,
    useIsPhone: () => mockTier === 'phone',
    useIsTablet: () => mockTier === 'tablet',
    useIsDesktop: () => mockTier === 'desktop',
    useIsCompact: () => mockTier !== 'desktop',
    useBreakpoint: () => mockTier,
  };
});

import UsersSection from '../UsersSection';
import { useStore } from '../../../../store/useStore';

const base = { role: 'user', stores: [], status: 'active', initials: 'XX', color: '#888', nickname: '' };

beforeEach(() => {
  jest.clearAllMocks();
  mockUsers.length = 0;
  mockUsers.push(
    // Username-only store user (data layer already cleared the placeholder).
    { ...base, id: 'aaaaaaaa-1111', name: 'Marcus Lee', username: 'marcus.l', email: '', loginKind: 'username' },
    // Real-email store user.
    { ...base, id: 'bbbbbbbb-2222', name: 'Towson Staff', username: 'towson', email: 'towson@2am.test', loginKind: 'email' },
  );
  useStore.setState({
    currentUser: { id: 'me', name: 'Admin', email: 'a@b.c', role: 'master' } as any,
    stores: [{ id: 'store-1', brandId: 'b', name: 'F' } as any],
    brand: { id: 'b', name: '2AM' } as any,
  });
  mockTier = 'desktop';
});

describe('UsersSection — spec 165 triggers', () => {
  it('renders + ADD USER next to the unchanged + INVITE USER trigger', async () => {
    const { findByTestId, getByTestId, getByText } = render(<UsersSection />);
    expect(await findByTestId('users-add-trigger')).toBeTruthy();
    expect(getByTestId('users-invite-trigger')).toBeTruthy();
    expect(getByText('+ ADD USER')).toBeTruthy();
    expect(getByText('+ INVITE USER')).toBeTruthy();
  });

  it('+ ADD USER opens the add-store-user drawer', async () => {
    const { findByTestId, queryByTestId, getByTestId } = render(<UsersSection />);
    fireEvent.press(await findByTestId('users-add-trigger'));
    await waitFor(() => expect(getByTestId('add-user-submit')).toBeTruthy());
    expect(queryByTestId('invite-submit')).toBeNull();
  });
});

describe('UsersSection — spec 165 username-only rows', () => {
  it('shows @username · shortId and the sign-in marker, never an email or "(email not loaded)"', async () => {
    const { findByText, getByTestId, queryByText } = render(<UsersSection />);
    expect(await findByText(/^@marcus\.l · aaaaaa$/)).toBeTruthy();
    expect(getByTestId('user-username-login-aaaaaaaa-1111')).toBeTruthy();
    expect(queryByText(/email not loaded/)).toBeNull();
    expect(queryByText(/no-email\.invalid/)).toBeNull();
  });

  it('hides RESET PW and shows SET PASSWORD for the username-only row', async () => {
    const { findByTestId, queryByTestId } = render(<UsersSection />);
    expect(await findByTestId('user-set-password-aaaaaaaa-1111')).toBeTruthy();
    expect(queryByTestId('user-reset-pw-aaaaaaaa-1111')).toBeNull();
  });

  it('SET PASSWORD opens the modal naming the target by @username', async () => {
    const { findByTestId, getByTestId, getAllByText } = render(<UsersSection />);
    fireEvent.press(await findByTestId('user-set-password-aaaaaaaa-1111'));
    expect(getByTestId('set-password-input')).toBeTruthy();
    expect(getAllByText(/Signs @marcus\.l out on every device/).length).toBe(1);
  });

  it('real-email rows are unchanged: email in the identity line, RESET PW, no SET PASSWORD, no marker', async () => {
    const { findByText, getByTestId, queryByTestId } = render(<UsersSection />);
    expect(await findByText(/^@towson · towson@2am\.test · /)).toBeTruthy();
    expect(getByTestId('user-reset-pw-bbbbbbbb-2222')).toBeTruthy();
    expect(queryByTestId('user-set-password-bbbbbbbb-2222')).toBeNull();
    expect(queryByTestId('user-username-login-bbbbbbbb-2222')).toBeNull();
  });

  it('renders the marker pill through i18n (en catalog text)', async () => {
    const { findByTestId } = render(<UsersSection />);
    const pill = await findByTestId('user-username-login-aaaaaaaa-1111');
    expect(within(pill).getByText('username sign-in')).toBeTruthy();
  });

  it("architect M7: no SET PASSWORD (and no RESET PW) on a username-only row whose role is not 'user'", async () => {
    mockUsers.push({ ...base, id: 'cccccccc-3333', role: 'admin', name: 'Odd Admin', username: 'odd.admin', email: '', loginKind: 'username' });
    const { findByTestId, queryByTestId } = render(<UsersSection />);
    expect(await findByTestId('user-row-cccccccc-3333')).toBeTruthy();
    expect(queryByTestId('user-set-password-cccccccc-3333')).toBeNull();
    expect(queryByTestId('user-reset-pw-cccccccc-3333')).toBeNull();
    // The role='user' username row still gets it.
    expect(queryByTestId('user-set-password-aaaaaaaa-1111')).toBeTruthy();
  });

  it('an admin (non-master) viewer also gets SET PASSWORD on a username-only user row', async () => {
    useStore.setState({ currentUser: { id: 'me', name: 'Admin', email: 'a@b.c', role: 'admin' } as any });
    const { findByTestId } = render(<UsersSection />);
    expect(await findByTestId('user-set-password-aaaaaaaa-1111')).toBeTruthy();
  });
});

// Added by test-engineer (spec 165 review): AC D "Delete confirm (desktop)"
// had no render-level test. The delete confirm for a username-only account
// must title/describe/require the name or username and never an email.
describe('UsersSection — spec 165 desktop delete confirm', () => {
  it('username-only account: confirm requires the username, description names @username, no placeholder/email', async () => {
    const { findByLabelText, getAllByText, queryByText } = render(<UsersSection />);
    fireEvent.press(await findByLabelText('Delete Marcus Lee'));
    expect(await findByLabelText('Cancel')).toBeTruthy();
    expect(getAllByText('marcus.l').length).toBeGreaterThan(0); // requiredText
    expect(getAllByText(/\(@marcus\.l\)/).length).toBeGreaterThan(0);
    expect(queryByText(/no-email\.invalid/)).toBeNull();
    expect(queryByText(/\(\)/)).toBeNull();
  });

  it('real-email account: confirm still requires the email', async () => {
    const { findByLabelText, getAllByText } = render(<UsersSection />);
    fireEvent.press(await findByLabelText('Delete Towson Staff'));
    expect(getAllByText('towson@2am.test').length).toBeGreaterThan(0);
  });
});
