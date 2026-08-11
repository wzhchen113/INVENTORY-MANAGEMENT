// src/screens/cmd/sections/GuideSection.test.tsx — Spec 158.
//
// AC-4 (the section renders under testID `cmd-guide-section`), AC-5 (grouped
// index rows + a topic body whose bullet count equals the topic's declared
// `actions`), AC-6 (the phone tier is a PhoneDrillScaffold list → detail), and
// the role filtering.
//
// The catalog is mocked to the identity function (`T(key) === key`), so the
// assertions below pin STRUCTURE, not English copy — the copy itself is pinned
// by `src/lib/guide.i18n.test.ts` against the real catalogs.

jest.mock('../../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#FFFFFF', panel: '#F4F4F4', panel2: '#EAEAEA',
    border: '#CCCCCC', borderStrong: '#888888',
    fg: '#000000', fg2: '#444444', fg3: '#888888',
    accent: '#3F7C20', accentBg: '#E0EFC9', accentFg: '#FFFFFF',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6, pill: 999 },
}));

jest.mock('../../../hooks/useT', () => ({
  useT: () => (key: string) => key,
}));

let mockTier: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('../../../theme/breakpoints', () => ({
  // `useBreakpoint` is ResponsiveSheet's tier source — needed by the co-mount
  // test at the bottom of this file, which renders GuideSheet alongside.
  useBreakpoint: () => mockTier,
  useIsPhone: () => mockTier === 'phone',
  useIsTablet: () => mockTier === 'tablet',
  useIsDesktop: () => mockTier === 'desktop',
  DESKTOP_MIN_WIDTH: 1100,
}));

let mockIsMaster = false;
let mockIsSuperAdmin = false;
jest.mock('../../../hooks/useRole', () => ({
  useIsMaster: () => mockIsMaster,
  useIsSuperAdmin: () => mockIsSuperAdmin,
}));

import { fireEvent, render, screen } from '@testing-library/react-native';
import GuideSection from './GuideSection';
import { GuideSheet } from '../../../components/cmd/GuideSheet';
import { findGuideTopic, guideTopics } from '../../../lib/guide';

beforeEach(() => {
  mockTier = 'desktop';
  mockIsMaster = false;
  mockIsSuperAdmin = false;
});

describe('GuideSection — AC-4 / AC-5 (desktop two-pane)', () => {
  test('renders under cmd-guide-section with a row per visible topic', () => {
    render(<GuideSection />);
    expect(screen.getByTestId('cmd-guide-section')).toBeTruthy();
    for (const topic of guideTopics('admin')) {
      const row = screen.queryByTestId(`cmd-guide-index-${topic.id}`);
      // A plain admin sees neither Users nor Brands.
      if (topic.gate === null) expect(row).toBeTruthy();
      else expect(row).toBeNull();
    }
  });

  test('rows render in sidebar order', () => {
    const tree = JSON.stringify(render(<GuideSection />).toJSON());
    const positions = guideTopics('admin')
      .filter((t) => t.gate === null)
      .map((t) => tree.indexOf(`cmd-guide-index-${t.id}`));
    expect(positions.every((p) => p > -1)).toBe(true);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  test('preselects the first topic (the OQ-1 overview) so the right pane is never empty', () => {
    render(<GuideSection />);
    expect(screen.getByTestId('cmd-guide-topic-Overview')).toBeTruthy();
    // Prominence: the overview is also the first index row.
    expect(screen.getByTestId('cmd-guide-index-Overview')).toBeTruthy();
  });

  test('selecting a row swaps the topic body, and the bullet count equals `actions`', () => {
    render(<GuideSection />);
    fireEvent.press(screen.getByTestId('cmd-guide-index-Reconciliation'));

    expect(screen.getByTestId('cmd-guide-topic-Reconciliation')).toBeTruthy();
    expect(screen.queryByTestId('cmd-guide-topic-Inventory')).toBeNull();

    const declared = findGuideTopic('admin', 'Reconciliation')!.actions;
    for (let n = 1; n <= declared; n += 1) {
      expect(screen.getByTestId(`cmd-guide-action-Reconciliation-${n}`)).toBeTruthy();
    }
    expect(screen.queryByTestId(`cmd-guide-action-Reconciliation-${declared + 1}`)).toBeNull();
  });

  test('the body renders the title, purpose and the numbered action strings', () => {
    render(<GuideSection />);
    fireEvent.press(screen.getByTestId('cmd-guide-index-Inventory'));
    // T is the identity, so the catalog PATHS are what render.
    // Twice: once as the index row's label, once as the topic body's heading.
    expect(screen.getAllByText('guide.topics.inventory.title')).toHaveLength(2);
    expect(screen.getAllByText('guide.topics.inventory.purpose').length).toBeGreaterThan(0);
    expect(screen.getByText('guide.topics.inventory.actions.3')).toBeTruthy();
  });

  test('the overview topic renders under its own OVERVIEW group caption', () => {
    render(<GuideSection />);
    // Twice: the index group caption and the topic body's own group caption
    // (the overview is preselected, so its body is on screen).
    expect(screen.getAllByText('guide.groups.overview')).toHaveLength(2);
    expect(screen.getByText('guide.topics.overview.actions.4')).toBeTruthy();
  });
});

describe('GuideSection — role filtering (mirrors the sidebar gates)', () => {
  test('a master gains Users but not Brands', () => {
    mockIsMaster = true;
    render(<GuideSection />);
    expect(screen.getByTestId('cmd-guide-index-Users')).toBeTruthy();
    expect(screen.queryByTestId('cmd-guide-index-Brands')).toBeNull();
  });

  test('a super-admin sees every topic, overview included', () => {
    mockIsMaster = true;
    mockIsSuperAdmin = true;
    render(<GuideSection />);
    for (const topic of guideTopics('admin')) {
      expect(screen.getByTestId(`cmd-guide-index-${topic.id}`)).toBeTruthy();
    }
  });

  test('the Guide topic itself is not listed (deliberately undocumented)', () => {
    mockIsMaster = true;
    mockIsSuperAdmin = true;
    render(<GuideSection />);
    expect(screen.queryByTestId('cmd-guide-index-Guide')).toBeNull();
  });
});

describe('GuideSection — AC-6 (phone drill-in)', () => {
  test('opens as a list with NO detail, then drills in on tap', () => {
    mockTier = 'phone';
    render(<GuideSection />);

    expect(screen.getByTestId('cmd-guide-phone')).toBeTruthy();
    // Nothing is preselected on phone (spec 142 Hard Rule 7) — the drill
    // overlay only exists after a tap.
    expect(screen.queryByTestId('phone-drill-detail')).toBeNull();
    expect(screen.queryByTestId('cmd-guide-topic-Inventory')).toBeNull();

    fireEvent.press(screen.getByTestId('cmd-guide-index-WasteLog'));
    expect(screen.getByTestId('phone-drill-detail')).toBeTruthy();
    expect(screen.getByTestId('cmd-guide-topic-WasteLog')).toBeTruthy();
  });

  test('the list stays MOUNTED under the detail, so back restores its scroll', () => {
    mockTier = 'phone';
    render(<GuideSection />);
    fireEvent.press(screen.getByTestId('cmd-guide-index-WasteLog'));

    // The row is still in the tree while the detail is open — that is the
    // scaffold's scroll-survival contract (AC-D4 / AC-6).
    expect(screen.getByTestId('cmd-guide-index-WasteLog')).toBeTruthy();
  });

  test('back returns to the list', () => {
    mockTier = 'phone';
    render(<GuideSection />);
    fireEvent.press(screen.getByTestId('cmd-guide-index-Ordering'));
    expect(screen.getByTestId('cmd-guide-topic-Ordering')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('guide.backToIndex'));
    expect(screen.queryByTestId('phone-drill-detail')).toBeNull();
    expect(screen.queryByTestId('cmd-guide-topic-Ordering')).toBeNull();
  });
});

// ── Code-review fix: GuideSection + GuideSheet must never both show an index ──
//
// `cmd-guide-index-<id>` is emitted by BOTH this section's index pane and the
// sheet's index view. The shell guarantees they are never live together by
// suppressing the `?` while `Guide` is the active section (and closing an
// already-open sheet if the section changes underneath) — pinned across all
// three tiers in `ResponsiveCmdShell.spec158.test.tsx`. These two tests pin the
// invariant from the component side.
describe('index testID uniqueness (the state the shell guard protects)', () => {
  test('with the guard honored (sheet closed on Guide), each index testID is unique', () => {
    render(
      <>
        <GuideSection />
        <GuideSheet visible={false} onClose={jest.fn()} topicId="Guide" />
      </>,
    );
    for (const topic of guideTopics('admin').filter((t) => t.gate === null)) {
      expect(screen.getAllByTestId(`cmd-guide-index-${topic.id}`)).toHaveLength(1);
    }
  });

  test('WITHOUT the guard, the two index trees collide — this is what it prevents', () => {
    // Documents the hazard rather than asserting a product behavior: an open
    // sheet on the Guide page falls back to its index (correct per the
    // null-safety contract) on top of the section's own always-visible index,
    // so `getByTestId` would throw on the duplicate. If a future refactor
    // removes the collision by other means, delete this test.
    render(
      <>
        <GuideSection />
        <GuideSheet visible onClose={jest.fn()} topicId="Guide" />
      </>,
    );
    expect(screen.getAllByTestId('cmd-guide-index-Inventory').length).toBeGreaterThan(1);
  });
});
