// src/utils/countAge.ts — Spec 160.
//
// The ONE definition of "how stale is this item's last physical count".
// Pure: no React, no react-native, no store imports — jest targets it directly
// and both the Inventory cell tone AND the `counted:` filter matcher consume it
// so the thresholds can never be duplicated (AC-17).
//
// TIMEZONE — the important distinction, stated once here so it isn't
// re-litigated at each call site:
//   * `countAgeTone` takes NO timezone and must not. "7 days" is 7 × 86 400 000
//     ms of ELAPSED time, which is timezone- and DST-invariant. This is
//     deliberately unlike the Dashboard's Monday-reset rule
//     (`src/utils/weekWindow.ts`), which anchors on a CALENDAR boundary and
//     therefore does need `useStore.timezone`. Duration thresholds don't.
//   * The absolute-date STRING does need the timezone: a count submitted at
//     2026-08-15T02:00Z is *August 14* in America/New_York, and rendering
//     "Aug 15" would disagree with the store's own operating day and with the
//     EOD screens. `formatLastCounted` therefore formats via `Intl` with an
//     explicit `timeZone`.
//   * Do NOT reach for `getNowInTZ()` (src/utils/timezone.ts) for the age math —
//     its own docstring warns the underlying epoch is offset. It is a
//     formatting-only helper.

import { relativeTime } from './relativeTime';

/** Counted at least this many days ago → `stale`. */
export const COUNT_STALE_DAYS = 7;
/** Counted at least this many days ago → `cold`. */
export const COUNT_COLD_DAYS = 30;

const DAY_MS = 86_400_000;

export type CountAgeTone = 'fresh' | 'stale' | 'cold' | 'never';

/**
 * AC-8. `now` is injected so tests pin the boundaries without fake timers
 * (same convention as the cmdSelectors week helpers).
 *
 * Boundaries are ELAPSED-DURATION, `<` on the low side and `>=` on the high:
 *   6d23h → fresh · 7d00m00s → stale · 29d23h → stale · 30d00m00s → cold.
 *
 * Degenerate inputs:
 *   - null / undefined / '' → `never` (there is no count).
 *   - unparseable timestamp → `never`. Over-reporting staleness is the safe
 *     direction for a trust signal: the operator goes and counts the item,
 *     which is harmless. Defaulting to `fresh` would launder corrupt data into
 *     "this number is trustworthy" — the exact bug this spec exists to fix.
 *   - negative age (future timestamp / clock skew) → `fresh`. Not worth
 *     surfacing as an error.
 */
export function countAgeTone(
  lastCountedAt: string | null | undefined,
  now: Date,
): CountAgeTone {
  if (!lastCountedAt) return 'never';
  const then = Date.parse(lastCountedAt);
  if (Number.isNaN(then)) return 'never';
  const ageMs = now.getTime() - then;
  if (ageMs >= COUNT_COLD_DAYS * DAY_MS) return 'cold';
  if (ageMs >= COUNT_STALE_DAYS * DAY_MS) return 'stale';
  return 'fresh';
}

export interface CountAgeFormatOpts {
  /** Anchor for the same-year test. Age itself comes from `relativeTime`. */
  now: Date;
  /** `useLocale()` — drives the month spelling. */
  locale: string;
  /** `useStore(s => s.timezone)` — the app/brand operating zone. */
  timeZone: string;
  /** `T('section.inventory.neverCounted')` — returned verbatim for null. */
  neverLabel: string;
  /** 'short' = the 124px table cell · 'long' = detail panes + a11y. */
  style: 'short' | 'long';
}

/** Year of `d` AS OBSERVED IN `timeZone` (not the runner's local zone). */
function yearIn(d: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(d);
  } catch {
    // Unknown IANA zone (or an ICU-less runtime) — fall back to local.
    return String(d.getFullYear());
  }
}

function formatDatePart(d: Date, opts: CountAgeFormatOpts): string {
  const sameYear = yearIn(d, opts.timeZone) === yearIn(opts.now, opts.timeZone);
  const dtf: Intl.DateTimeFormatOptions = opts.style === 'long'
    ? { timeZone: opts.timeZone, year: 'numeric', month: 'long', day: 'numeric' }
    : sameYear
      ? { timeZone: opts.timeZone, month: 'short', day: 'numeric' }
      : { timeZone: opts.timeZone, month: 'short', day: 'numeric', year: '2-digit' };
  try {
    return new Intl.DateTimeFormat(opts.locale, dtf).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...dtf, timeZone: undefined }).format(d);
  }
}

/**
 * The composed display string — absolute date AND relative age together
 * (`Aug 14 · 3d`, `August 14, 2026 · 3d`). The user decision in spec 160 §0.1
 * supersedes the spec's original relative-only position.
 *
 * `null` / unparseable input returns `neverLabel` verbatim for BOTH styles.
 * The age fragment always comes from the existing `relativeTime()` so the
 * terse `3h` / `2d` / `2mo` form is never re-derived here.
 */
export function formatLastCounted(
  lastCountedAt: string | null | undefined,
  opts: CountAgeFormatOpts,
): string {
  if (!lastCountedAt) return opts.neverLabel;
  const ms = Date.parse(lastCountedAt);
  if (Number.isNaN(ms)) return opts.neverLabel;
  const d = new Date(ms);
  const age = relativeTime(lastCountedAt);
  const date = formatDatePart(d, opts);
  return age ? `${date} · ${age}` : date;
}
