// src/utils/timezone.ts
//
// Shared list of supported time zones + a helper to get "now" in a given
// IANA zone. Hoisted out of OrdersScreen so the TimezoneBar component (and
// any other screen that needs to format a date in the store's TZ) can pull
// from one place.

export const TIMEZONES = [
  { label: 'Eastern (New York)', value: 'America/New_York' },
  { label: 'Central (Chicago)',  value: 'America/Chicago' },
  { label: 'Mountain (Denver)',  value: 'America/Denver' },
  { label: 'Pacific (Seattle)',  value: 'America/Los_Angeles' },
  { label: 'Alaska (Anchorage)', value: 'America/Anchorage' },
  { label: 'Hawaii (Honolulu)',  value: 'Pacific/Honolulu' },
];

/**
 * Returns a Date whose calendar fields (when read with non-TZ getters)
 * reflect "now" in the given IANA timezone. Useful for formatting only —
 * the underlying epoch is offset, so don't pass this to anything that
 * expects an accurate UTC instant.
 */
export function getNowInTZ(tz: string): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
}
