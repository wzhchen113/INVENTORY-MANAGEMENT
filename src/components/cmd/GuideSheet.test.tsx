// src/components/cmd/GuideSheet.test.tsx — Spec 158.
//
// AC-7 (the sheet shows the topic for the id it was handed), AC-9 ("See all
// pages" switches to the index and index rows open topics IN PLACE), plus the
// §10 re-seed rule: the sheet re-reads `topicId` on every closed→open
// transition, so reopening it on a different section never shows the previous
// section's topic.
//
// `ResponsiveSheet` renders for real (it is the component whose Modal + tier
// behavior the sheet depends on); only the theme, catalog, breakpoint and role
// boundaries are mocked.

jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#FFFFFF', panel: '#F4F4F4', panel2: '#EAEAEA',
    border: '#CCCCCC', borderStrong: '#888888',
    fg: '#000000', fg2: '#444444', fg3: '#888888',
    accent: '#3F7C20', accentBg: '#E0EFC9', accentFg: '#FFFFFF',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6, pill: 999 },
}));

jest.mock('../../hooks/useT', () => ({
  useT: () => (key: string) => key,
}));

let mockTier: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('../../theme/breakpoints', () => ({
  useBreakpoint: () => mockTier,
  useIsPhone: () => mockTier === 'phone',
  useIsTablet: () => mockTier === 'tablet',
  useIsDesktop: () => mockTier === 'desktop',
  DESKTOP_MIN_WIDTH: 1100,
}));

let mockIsMaster = false;
let mockIsSuperAdmin = false;
jest.mock('../../hooks/useRole', () => ({
  useIsMaster: () => mockIsMaster,
  useIsSuperAdmin: () => mockIsSuperAdmin,
}));

import { fireEvent, render, screen } from '@testing-library/react-native';
import { GuideSheet } from './GuideSheet';
import { findGuideTopic } from '../../lib/guide';

beforeEach(() => {
  mockTier = 'desktop';
  mockIsMaster = false;
  mockIsSuperAdmin = false;
});

describe('GuideSheet — AC-7 (topic resolved from the active section id)', () => {
  test('mounts nothing while closed', () => {
    render(<GuideSheet visible={false} onClose={jest.fn()} topicId="Inventory" />);
    expect(screen.queryByTestId('cmd-guide-sheet')).toBeNull();
  });

  test('open on a section id shows that section\'s topic', () => {
    render(<GuideSheet visible onClose={jest.fn()} topicId="Reports" />);
    expect(screen.getByTestId('cmd-guide-sheet')).toBeTruthy();
    expect(screen.getByTestId('cmd-guide-topic-Reports')).toBeTruthy();

    const declared = findGuideTopic('admin', 'Reports')!.actions;
    expect(screen.getByTestId(`cmd-guide-action-Reports-${declared}`)).toBeTruthy();
    expect(screen.queryByTestId(`cmd-guide-action-Reports-${declared + 1}`)).toBeNull();
  });

  test('an UNKNOWN or null topic id falls back to the index (never throws)', () => {
    render(<GuideSheet visible onClose={jest.fn()} topicId="NotASection" />);
    expect(screen.getByTestId('cmd-guide-sheet-index')).toBeTruthy();

    screen.unmount();
    render(<GuideSheet visible onClose={jest.fn()} topicId={null} />);
    expect(screen.getByTestId('cmd-guide-sheet-index')).toBeTruthy();
  });

  test('the `Guide` section itself falls back to the index (it has no topic)', () => {
    render(<GuideSheet visible onClose={jest.fn()} topicId="Guide" />);
    expect(screen.getByTestId('cmd-guide-sheet-index')).toBeTruthy();
  });

  test('the SEED path is role-gated, exactly like the index view', () => {
    // Security review, Low #1 — defense in depth. `section` is fed only by the
    // role-filtered sidebar, so a plain admin cannot actually reach `Users`;
    // this pins that the seed and the index share ONE gate regardless.
    render(<GuideSheet visible onClose={jest.fn()} topicId="Users" />);
    expect(screen.getByTestId('cmd-guide-sheet-index')).toBeTruthy();
    expect(screen.queryByTestId('cmd-guide-topic-Users')).toBeNull();
    screen.unmount();

    mockIsMaster = true;
    render(<GuideSheet visible onClose={jest.fn()} topicId="Users" />);
    expect(screen.getByTestId('cmd-guide-topic-Users')).toBeTruthy();
  });

  test('the super-admin-gated topic seeds only for a super-admin', () => {
    mockIsMaster = true;
    render(<GuideSheet visible onClose={jest.fn()} topicId="Brands" />);
    expect(screen.getByTestId('cmd-guide-sheet-index')).toBeTruthy();
    screen.unmount();

    mockIsSuperAdmin = true;
    render(<GuideSheet visible onClose={jest.fn()} topicId="Brands" />);
    expect(screen.getByTestId('cmd-guide-topic-Brands')).toBeTruthy();
  });

  test('the close control calls onClose', () => {
    const onClose = jest.fn();
    render(<GuideSheet visible onClose={onClose} topicId="Inventory" />);
    fireEvent.press(screen.getByTestId('cmd-guide-sheet-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('GuideSheet — AC-9 (index round-trip inside the sheet)', () => {
  test('"See all pages" switches to the index, and an index row opens a topic', () => {
    render(<GuideSheet visible onClose={jest.fn()} topicId="Vendors" />);
    expect(screen.getByTestId('cmd-guide-topic-Vendors')).toBeTruthy();

    fireEvent.press(screen.getByTestId('cmd-guide-sheet-see-all'));
    expect(screen.getByTestId('cmd-guide-sheet-index')).toBeTruthy();
    expect(screen.queryByTestId('cmd-guide-topic-Vendors')).toBeNull();

    fireEvent.press(screen.getByTestId('cmd-guide-index-AuditLog'));
    expect(screen.getByTestId('cmd-guide-topic-AuditLog')).toBeTruthy();
    expect(screen.queryByTestId('cmd-guide-sheet-index')).toBeNull();
  });

  test('the index is role-filtered like the sidebar', () => {
    render(<GuideSheet visible onClose={jest.fn()} topicId={null} />);
    expect(screen.queryByTestId('cmd-guide-index-Users')).toBeNull();
    expect(screen.queryByTestId('cmd-guide-index-Brands')).toBeNull();
    screen.unmount();

    mockIsMaster = true;
    mockIsSuperAdmin = true;
    render(<GuideSheet visible onClose={jest.fn()} topicId={null} />);
    expect(screen.getByTestId('cmd-guide-index-Users')).toBeTruthy();
    expect(screen.getByTestId('cmd-guide-index-Brands')).toBeTruthy();
  });
});

describe('GuideSheet — §10 re-seed on every closed→open transition', () => {
  test('reopening on a different section shows the NEW topic, not the previous one', () => {
    const view = render(<GuideSheet visible onClose={jest.fn()} topicId="Inventory" />);
    expect(screen.getByTestId('cmd-guide-topic-Inventory')).toBeTruthy();

    // Close, then reopen on another section — the component is NOT remounted.
    view.rerender(<GuideSheet visible={false} onClose={jest.fn()} topicId="Inventory" />);
    view.rerender(<GuideSheet visible onClose={jest.fn()} topicId="WasteLog" />);

    expect(screen.getByTestId('cmd-guide-topic-WasteLog')).toBeTruthy();
    expect(screen.queryByTestId('cmd-guide-topic-Inventory')).toBeNull();
  });

  test('re-seeding does NOT fight the user navigating inside an open sheet', () => {
    const view = render(<GuideSheet visible onClose={jest.fn()} topicId="Inventory" />);
    fireEvent.press(screen.getByTestId('cmd-guide-sheet-see-all'));
    fireEvent.press(screen.getByTestId('cmd-guide-index-Dashboard'));
    expect(screen.getByTestId('cmd-guide-topic-Dashboard')).toBeTruthy();

    // A re-render while still open must not snap back to the prop's topic.
    view.rerender(<GuideSheet visible onClose={jest.fn()} topicId="Inventory" />);
    expect(screen.getByTestId('cmd-guide-topic-Dashboard')).toBeTruthy();
  });
});

describe('GuideSheet — tiers', () => {
  test.each(['phone', 'tablet', 'desktop'] as const)('renders on %s', (tier) => {
    mockTier = tier;
    render(<GuideSheet visible onClose={jest.fn()} topicId="Ordering" />);
    expect(screen.getByTestId('cmd-guide-sheet')).toBeTruthy();
    expect(screen.getByTestId('cmd-guide-topic-Ordering')).toBeTruthy();
  });
});
