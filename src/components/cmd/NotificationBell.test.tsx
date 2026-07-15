// src/components/cmd/NotificationBell.test.tsx — Spec 121 color derivation.
//
// Closes the "no bell test" gap the spec-120 reviewers flagged. Exercises the
// pure color-derivation helpers the bell memoizes over (spec 121 §10), NOT the
// full component: the visible component portals to document.body via
// react-dom's `createPortal` and reads the Zustand store, whose import graph
// crashes under jest (no Supabase env) — the same boundary the StatusPill test
// documents. The helpers are pure `(colors, feed) → color`, so a tiny palette
// stub + hand-built feed rows are all the fixtures needed.
//
// Owner decision (Q1): RESERVE RED FOR MISSES. The routine submission-unread
// badge moves OFF red onto the neutral accent; red is used ONLY when there's
// an unread `missed_eod`.

// Boundary mocks — importing NotificationBell pulls in `../../theme/colors`,
// `../../store/useStore`, `../../hooks/useT`, and `react-dom`, whose transitive
// `src/lib/supabase.ts` crashes at import time under jest (no Supabase env),
// exactly as the StatusPill test documents. The helpers under test are pure and
// touch none of these at runtime; the stubs only satisfy the module graph.
jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({ danger: 'DANGER', accent: 'ACCENT', accentFg: 'ACCENT_FG' }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));
jest.mock('../../store/useStore', () => ({ useStore: () => undefined }));
jest.mock('../../hooks/useT', () => ({ useT: () => (key: string) => key }));
jest.mock('react-dom', () => ({ createPortal: (node: unknown) => node }));

import {
  feedHasUnreadMissed,
  badgeBackgroundColor,
  badgeTextColor,
  rowDotColor,
} from './NotificationBell';
import type { AdminNotification } from '../../types';

// Minimal Cmd-palette stub — distinct sentinels so an assertion can only pass
// if the branch picked the intended token.
const C = { danger: 'DANGER', accent: 'ACCENT', accentFg: 'ACCENT_FG' };

// Build an AdminNotification row with only the fields the helpers read.
function row(
  type: AdminNotification['type'],
  read: boolean,
  id = `${type}-${read}`,
): AdminNotification {
  return {
    id,
    brandId: 'b1',
    storeId: 's1',
    actorUserId: null,
    actorName: 'Coca-Cola',
    storeName: 'Downtown',
    type,
    sourceId: 'src',
    createdAt: new Date().toISOString(),
    read,
  };
}

describe('feedHasUnreadMissed', () => {
  it('is true when the feed has an unread missed_eod row', () => {
    expect(feedHasUnreadMissed([row('eod', true), row('missed_eod', false)])).toBe(true);
  });

  it('is false when every missed_eod row is already read', () => {
    expect(feedHasUnreadMissed([row('missed_eod', true), row('eod', false)])).toBe(false);
  });

  it('is false for a submission-only unread feed', () => {
    expect(feedHasUnreadMissed([row('eod', false), row('waste', false)])).toBe(false);
  });

  it('is false for an empty feed', () => {
    expect(feedHasUnreadMissed([])).toBe(false);
  });
});

describe('badge color fork', () => {
  it('is danger (red) when an unread miss exists', () => {
    expect(badgeBackgroundColor(C, true)).toBe('DANGER');
    expect(badgeTextColor(C, true)).toBe('#FFFFFF');
  });

  it('is accent (with accentFg text) when the unread set is submission-only', () => {
    expect(badgeBackgroundColor(C, false)).toBe('ACCENT');
    expect(badgeTextColor(C, false)).toBe('ACCENT_FG');
  });
});

describe('rowDotColor', () => {
  it('renders a danger (red) dot for an unread missed_eod row', () => {
    expect(rowDotColor(C, row('missed_eod', false))).toBe('DANGER');
  });

  it('renders an accent dot for an unread submission row', () => {
    expect(rowDotColor(C, row('eod', false))).toBe('ACCENT');
    expect(rowDotColor(C, row('waste', false))).toBe('ACCENT');
  });

  it('renders transparent once a row is read, regardless of type', () => {
    expect(rowDotColor(C, row('missed_eod', true))).toBe('transparent');
    expect(rowDotColor(C, row('eod', true))).toBe('transparent');
  });
});
