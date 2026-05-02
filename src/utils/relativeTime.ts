import { formatDistanceToNowStrict } from 'date-fns';

// "1h", "2d", "12m" — used in activity rows + item detail meta lines.
// Strict variant rounds without "almost" / "over" qualifiers; formats it
// terse so the unit suffix becomes a single character (m/h/d/M/y).
const SUFFIX: Record<string, string> = {
  second: 's',
  minute: 'm',
  hour:   'h',
  day:    'd',
  month:  'mo',
  year:   'y',
};

export function relativeTime(input: string | Date | number | null | undefined): string {
  if (!input) return '';
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  const raw = formatDistanceToNowStrict(d);            // e.g. "1 hour", "12 minutes"
  const m = /^(\d+)\s+(second|minute|hour|day|month|year)s?$/.exec(raw);
  if (!m) return raw;
  return `${m[1]}${SUFFIX[m[2]] ?? m[2][0]}`;
}
