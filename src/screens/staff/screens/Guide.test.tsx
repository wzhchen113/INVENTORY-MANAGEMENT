// src/screens/staff/screens/Guide.test.tsx — Spec 158, AC-12 + AC-15.
//
// The staff Guide screen: with a `topicId` route param it opens that topic's
// body; without one (or with an unknown one) it opens the 5-topic index. A
// back control returns to the index from a topic, and the header back calls
// `goBack()` so the hardware/browser back returns the user to the screen they
// came from.
//
// AC-15 in this file: NO admin topic is reachable — the screen passes the
// LITERAL 'staff' audience, so an admin section id lands on the index instead
// of an admin topic. (The catalog half of AC-15 is pinned in
// `src/lib/guide.i18n.test.ts`.)
//
// The staff catalog runs FOR REAL here (no `t()` mock) — that is what proves
// the screen renders real copy rather than a raw dot-path.

const mockGoBack = jest.fn();
let mockParams: { topicId?: string } | undefined;
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: jest.fn() }),
  useRoute: () => ({ key: 'Guide-1', name: 'Guide', params: mockParams }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
  };
});

import { fireEvent, render, screen } from '@testing-library/react-native';
import { Guide } from './Guide';
import staffEn from '../i18n/en.json';
import { guideTopics } from '../../../lib/guide';

beforeEach(() => {
  mockGoBack.mockReset();
  mockParams = undefined;
});

describe('staff Guide — AC-12 (index vs topic)', () => {
  test('no topicId → the 6-topic index (5 screens + the overview)', () => {
    render(<Guide />);
    expect(screen.getByTestId('staff-guide-screen')).toBeTruthy();
    expect(screen.getByTestId('staff-guide-index')).toBeTruthy();
    for (const topic of guideTopics('staff')) {
      expect(screen.getByTestId(`staff-guide-index-${topic.id}`)).toBeTruthy();
    }
    expect(guideTopics('staff')).toHaveLength(6);
    // OQ-1 reads first — the day-one audience is exactly this surface's users.
    expect(screen.getByTestId('staff-guide-index-Overview')).toBeTruthy();
  });

  test('a topicId → that topic body, with the declared number of action bullets', () => {
    mockParams = { topicId: 'WeeklyCount' };
    render(<Guide />);

    expect(screen.getByTestId('staff-guide-topic-WeeklyCount')).toBeTruthy();
    expect(screen.queryByTestId('staff-guide-index')).toBeNull();

    const declared = guideTopics('staff').find((t) => t.id === 'WeeklyCount')!.actions;
    for (let n = 1; n <= declared; n += 1) {
      expect(screen.getByTestId(`staff-guide-action-WeeklyCount-${n}`)).toBeTruthy();
    }
    expect(screen.queryByTestId(`staff-guide-action-WeeklyCount-${declared + 1}`)).toBeNull();
  });

  test('renders the REAL staff catalog copy, not a dot-path', () => {
    mockParams = { topicId: 'Reorder' };
    render(<Guide />);
    expect(screen.getByText(staffEn.guide.topics.reorder.title)).toBeTruthy();
    expect(screen.getByText(staffEn.guide.topics.reorder.purpose)).toBeTruthy();
    expect(screen.getByText(staffEn.guide.topics.reorder.actions['1'])).toBeTruthy();
    expect(screen.queryByText('guide.topics.reorder.title')).toBeNull();
  });

  test('an UNKNOWN topicId falls back to the index (route params are caller-controlled)', () => {
    mockParams = { topicId: 'NotAScreen' };
    render(<Guide />);
    expect(screen.getByTestId('staff-guide-index')).toBeTruthy();
  });

  test('back-to-index returns to the index from a topic', () => {
    mockParams = { topicId: 'Settings' };
    render(<Guide />);
    expect(screen.getByTestId('staff-guide-topic-Settings')).toBeTruthy();

    fireEvent.press(screen.getByTestId('staff-guide-see-all'));
    expect(screen.getByTestId('staff-guide-index')).toBeTruthy();
    expect(screen.queryByTestId('staff-guide-topic-Settings')).toBeNull();
  });

  test('an index row opens its topic in place', () => {
    render(<Guide />);
    fireEvent.press(screen.getByTestId('staff-guide-index-StorePicker'));
    expect(screen.getByTestId('staff-guide-topic-StorePicker')).toBeTruthy();
  });

  test('the header back returns to the screen the user came from', () => {
    mockParams = { topicId: 'EODCount' };
    render(<Guide />);
    fireEvent.press(screen.getByTestId('staff-guide-back'));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });
});

describe('staff Guide — AC-15 (no admin topic is reachable)', () => {
  test.each(['Inventory', 'Users', 'Brands', 'Reconciliation', 'Guide'])(
    'the admin section id %s falls back to the staff index',
    (adminId) => {
      mockParams = { topicId: adminId };
      render(<Guide />);
      expect(screen.getByTestId('staff-guide-index')).toBeTruthy();
      expect(screen.queryByTestId(`staff-guide-topic-${adminId}`)).toBeNull();
    },
  );

  test('the index lists exactly the staff topics and nothing else', () => {
    render(<Guide />);
    const staffIds = guideTopics('staff').map((t) => t.id);
    for (const adminTopic of guideTopics('admin')) {
      if (staffIds.includes(adminTopic.id)) continue;
      expect(screen.queryByTestId(`staff-guide-index-${adminTopic.id}`)).toBeNull();
    }
  });
});
