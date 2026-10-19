// Added by test-engineer (spec 165 review). AC D: CascadePreviewModal never
// renders a placeholder email. The data layer (mapCascadePreview) nulls the
// email and sets loginKind 'username'; this pins the render side: the blocking
// profile row shows the sign-in marker instead of an email or "(no email)".

import React from 'react';
import { render, waitFor, act } from '@testing-library/react-native';

jest.mock('../../theme/breakpoints', () => ({
  useIsPhone: () => false,
}));
jest.mock('./ResponsiveSheet', () => ({
  ResponsiveSheet: ({ children, footer }: any) => {
    const { View } = require('react-native');
    return <View>{children}{footer}</View>;
  },
}));
jest.mock('./TypeToConfirmModal', () => ({ TypeToConfirmModal: () => null }));

const mockPreview = jest.fn();
// Stable selector result: the component's fetch effect depends on it.
const mockPreviewFn = (...a: any[]) => mockPreview(...a);
jest.mock('../../store/useStore', () => ({
  useStore: (sel: (s: any) => any) => sel({ previewBrandCascade: mockPreviewFn }),
}));

import { CascadePreviewModal } from './CascadePreviewModal';

const profile = (over: any) => ({
  profileId: 'p1', name: 'Marcus Lee', email: null, role: 'user', loginKind: 'email', ...over,
});

const renderModal = async () => {
  const r = render(
    <CascadePreviewModal
      visible
      brandId="b1"
      brandName="Brand"
      onClose={() => {}}
      onPurgeConfirmed={() => {}}
      onManageMembers={() => {}}
    />,
  );
  await act(async () => {});
  return r;
};

describe('CascadePreviewModal — spec 165 username-only blocking profiles', () => {
  it('shows "username sign-in" and never an email for a username-only profile', async () => {
    mockPreview.mockResolvedValue({
      counts: {},
      blockingProfiles: [profile({ loginKind: 'username', email: null })],
    });
    const { findByText, queryByText } = await renderModal();
    expect(await findByText(/username sign-in · user/)).toBeTruthy();
    await waitFor(() => expect(queryByText(/loading cascade/)).toBeNull());
    expect(queryByText(/\(no email\)/)).toBeNull();
    expect(queryByText(/no-email\.invalid/)).toBeNull();
  });

  it('real-email profile is unchanged', async () => {
    mockPreview.mockResolvedValue({
      counts: {},
      blockingProfiles: [profile({ profileId: 'p2', name: 'Real', email: 'real@x.test' })],
    });
    const { findByText, queryByText } = await renderModal();
    expect(await findByText(/real@x\.test · user/)).toBeTruthy();
    await waitFor(() => expect(queryByText(/loading cascade/)).toBeNull());
    expect(queryByText(/username sign-in/)).toBeNull();
  });
});
