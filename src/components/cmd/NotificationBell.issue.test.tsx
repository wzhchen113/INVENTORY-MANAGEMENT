// src/components/cmd/NotificationBell.issue.test.tsx — spec 126.
//
// Renders the FULL bell (unlike NotificationBell.test.tsx, which exercises
// only the pure color helpers) to prove an `issue` row surfaces the reported
// message (`body`) + a category badge to the recipient — not a bare
// placeholder. Boundary-mocks the store / theme / i18n / react-dom the same
// way the sibling test documents, but drives the store selector against a
// hand-built feed so the component actually renders rows.

const mockState = {
  submissionNotifications: [
    {
      id: 'n1',
      brandId: 'b1',
      storeId: 's1',
      actorUserId: 'u1',
      actorName: 'Maria',
      storeName: 'Downtown',
      type: 'issue' as const,
      sourceId: 'r1',
      createdAt: new Date().toISOString(),
      read: false,
      body: 'Walk-in freezer is warm',
      category: 'equipment',
    },
  ],
  submissionUnreadCount: 1,
  markSubmissionNotificationRead: jest.fn(),
  markAllSubmissionNotificationsRead: jest.fn(),
};

jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({
    fg: 'FG',
    fg2: 'FG2',
    fg3: 'FG3',
    accent: 'ACCENT',
    accentBg: 'ACCENT_BG',
    accentFg: 'ACCENT_FG',
    danger: 'DANGER',
    panel: 'PANEL',
    panel2: 'PANEL2',
    border: 'BORDER',
    borderStrong: 'BORDER_STRONG',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));
jest.mock('../../theme/typography', () => ({ mono: () => 'mono' }));
jest.mock('../../store/useStore', () => ({
  useStore: (sel: (s: unknown) => unknown) => sel(mockState),
}));
jest.mock('../../hooks/useT', () => ({ useT: () => (key: string) => key }));
jest.mock('react-dom', () => ({ createPortal: (node: unknown) => node }));

import { fireEvent, render } from '@testing-library/react-native';
import { NotificationBell } from './NotificationBell';

describe('NotificationBell — issue row (spec 126)', () => {
  it('renders the reported message and a category badge', () => {
    const { getByLabelText, getByText } = render(<NotificationBell />);
    // Open the panel (portal is a passthrough under the react-dom mock).
    fireEvent.press(getByLabelText('chrome.submissionBell.aria'));

    // The free-text message is readable in the bell.
    expect(getByText('Walk-in freezer is warm')).toBeTruthy();
    // The category badge is derived from the row's `category` token.
    expect(getByText('chrome.submissionBell.issueCategory.equipment')).toBeTruthy();
    // Store + reporter appear on the secondary line.
    expect(getByText(/Downtown/)).toBeTruthy();
    expect(getByText(/Maria/)).toBeTruthy();
  });
});
