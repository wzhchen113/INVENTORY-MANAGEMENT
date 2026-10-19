// src/screens/cmd/sections/__tests__/BrandsSection.members.spec165.test.tsx
//
// Spec 165 §D — the Brands members tab + delete-profile modal never render a
// username-only account's placeholder email. Placeholder rows (data layer
// already cleared `email`, `loginKind: 'username'`) show `@username` + the
// "username sign-in" marker and no "(email not loaded)"; the delete confirm
// uses the username. Real-email rows keep their email. useT is mocked to
// return the key, so the marker asserts as `section.users.usernameSignIn`
// (proves it is translated, not a hard-coded English literal).
//
// Boundary mocks follow StoresTab.toggle.test.tsx.

// ── Mocks (must precede any import of the component) ────────────────

jest.mock('../../../../theme/colors', () => ({
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

jest.mock('../../../../hooks/useT', () => ({
  useT: () => (key: string) => key,
}));

jest.mock('../../../../utils/confirmAction', () => ({
  confirmAction: jest.fn(),
}));

const mockFetchStoresIncludingInactive = jest.fn(async () => [
  { id: 'towson', brandId: 'brand-1', name: 'Towson', address: '', status: 'active' },
] as any[]);
jest.mock('../../../../lib/db', () => ({
  fetchStoresIncludingInactive: () => mockFetchStoresIncludingInactive(),
}));

jest.mock('../../../../store/useStore', () => {
  const state: any = { demoteProfileToUser: jest.fn(), deleteProfile: jest.fn() };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  return { useStore: fn };
});

jest.mock('../../../../components/cmd/StoreFormDrawer', () => ({
  StoreFormDrawer: () => null,
}));

jest.mock('../../../../lib/supabase', () => ({
  supabase: { from: jest.fn(), auth: {}, rpc: jest.fn() },
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

// ── Imports (resolve mocks above) ───────────────────────────────────
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { MembersTab, DeleteProfileModal } from '../BrandsSection';
import type { User } from '../../../../types';

const BRAND_ID = 'brand-1';

function member(over: Partial<User>): User {
  return {
    id: 'p-1', name: 'Someone', nickname: '', email: '', role: 'user',
    stores: ['towson'], status: 'active', initials: 'SO', color: '#378ADD',
    brandId: BRAND_ID, username: null, loginKind: 'email', ...over,
  };
}

const MARCUS = member({ id: 'p-marcus', name: 'Marcus Lee', username: 'marcus.l', loginKind: 'username' });
const EVE = member({ id: 'p-eve', name: 'Eve Admin', role: 'admin', email: 'eve@example.com', username: 'eve' });

async function renderMembers(admins: User[]) {
  render(
    <MembersTab
      admins={admins}
      loading={false}
      brandId={BRAND_ID}
      onInvite={() => {}}
      onDeleteProfile={() => {}}
      superAdminUserId="me"
    />,
  );
  // Store names load via the tab-local fetch.
  await screen.findAllByText(/Towson/);
}

describe('BrandsSection MembersTab — spec 165 username-only rows', () => {
  it('shows @username + the sign-in marker, never an email or "(email not loaded)"', async () => {
    await renderMembers([MARCUS]);
    expect(screen.getByText('@marcus.l · section.users.usernameSignIn · Towson')).toBeTruthy();
    expect(screen.queryByText(/email not loaded/)).toBeNull();
    expect(screen.queryByText(/no-email\.invalid/)).toBeNull();
  });

  it('real-email rows are unchanged', async () => {
    await renderMembers([EVE, member({ id: 'p-x', name: 'No Email', email: '' })]);
    expect(screen.getByText('eve@example.com · Towson')).toBeTruthy();
    expect(screen.getByText('(email not loaded) · Towson')).toBeTruthy();
  });
});

describe('BrandsSection DeleteProfileModal — spec 165 confirm text', () => {
  it('username-only target: confirm by username, description names @username, no email', () => {
    render(<DeleteProfileModal target={MARCUS} onClose={() => {}} />);
    expect(screen.getByText('type "marcus.l" to enable')).toBeTruthy();
    expect(screen.getByText(/\(@marcus\.l, section\.users\.usernameSignIn\)/)).toBeTruthy();
    expect(screen.queryByText(/no email/)).toBeNull();
  });

  it('real-email target: confirm text follows userConfirmText (email, then name)', () => {
    render(<DeleteProfileModal target={EVE} onClose={() => {}} />);
    expect(screen.getByText('type "eve@example.com" to enable')).toBeTruthy();
    expect(screen.getByText(/\(eve@example\.com\)/)).toBeTruthy();
  });
});
