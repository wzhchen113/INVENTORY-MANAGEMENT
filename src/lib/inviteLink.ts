// src/lib/inviteLink.ts — Spec 198 §5.1.
//
// Pure helpers for the one-time invite code and the register link that carries
// it. No supabase and no react-native imports, so the jest suite needs no mocks
// and the drawers / RegisterScreen / LoginScreen can share one definition.
//
// Link shape (AD-5): `<web origin>/?register=true&invite=<32 hex>`. The param is
// `invite`, NOT `code`: `?code=` is already claimed by the spec 085 recovery boot
// gate (src/lib/recoveryUrl.ts) and by supabase-js's PKCE callback on web.

/** The URL query parameter that carries the invite code (AD-5). */
export const INVITE_URL_PARAM = 'invite';

/** 16 CSPRNG bytes as 32 lowercase hex (AD-1). Parity with the literal in
 *  supabase/functions/send-invite-email/index.ts (pinned by
 *  src/lib/sendInviteEmail.source.test.ts). */
export const INVITE_CODE_RE = /^[0-9a-f]{32}$/;

// Matches `invite=<value>` at the start of the input or after `?`, `&` or `#`,
// so a pasted full link (with or without extra params) yields just the code.
const INVITE_PARAM_RE = new RegExp(`(?:^|[?&#])${INVITE_URL_PARAM}=([^&#\\s]*)`, 'i');

/**
 * Normalize whatever the invitee typed, pasted or arrived with into a bare code
 * candidate: trim; if the input contains `invite=`, take that query value (a
 * pasted full link); lowercase. Returns '' when there is nothing to use.
 * Format is NOT enforced here; callers check `isInviteCode` on the result.
 */
export function normalizeInviteCode(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  let value = raw.trim();
  if (value.length === 0) return '';
  const fromLink = INVITE_PARAM_RE.exec(value);
  if (fromLink) value = fromLink[1];
  return value.trim().toLowerCase();
}

/** True when `value` is exactly a 32-lowercase-hex invite code. */
export function isInviteCode(value: string): boolean {
  return INVITE_CODE_RE.test(value);
}

/** `<base>/?register=true&invite=<code>`, tolerating a trailing slash on base. */
export function buildInviteLink(base: string, code: string): string {
  return `${base.replace(/\/+$/, '')}/?register=true&${INVITE_URL_PARAM}=${code}`;
}

// ISO-8601 timestamp as Postgres/PostgREST renders a timestamptz in jsonb
// (e.g. `2026-11-12T15:04:05.123456+00:00`), or with `Z`. Parsed by hand
// rather than `new Date(iso)`, whose handling of >3 fractional digits varies by
// JS engine (Hermes on native).
const ISO_TS_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Review CR-2 — the invitation's server-issued `expires_at` as a short local
 * date/time ("Nov 12, 2026, 15:04"), so the invite panel shows the real expiry
 * instead of a second copy of the server's 48-hour constant. Returns null for
 * anything that isn't a parseable timestamp (the panel then omits the time).
 */
export function formatInviteExpiry(iso: string | null | undefined): string | null {
  if (typeof iso !== 'string') return null;
  const m = ISO_TS_RE.exec(iso.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, tz] = m;
  let offsetMin = 0;
  if (tz && tz.toUpperCase() !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    offsetMin = sign * (parseInt(digits.slice(0, 2), 10) * 60 + parseInt(digits.slice(2, 4) || '0', 10));
  }
  const utcMs =
    Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0) - offsetMin * 60000;
  const t = new Date(utcMs);
  if (Number.isNaN(t.getTime())) return null;
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  return `${MONTHS[t.getMonth()]} ${t.getDate()}, ${t.getFullYear()}, ${hh}:${mm}`;
}

// scheme + host (+ port) of an absolute http(s) URL. Deliberately a regex, not
// `new URL().origin`: React Native's URL polyfill is partial.
const ORIGIN_RE = /^(https?:\/\/[^/?#]+)/i;

/**
 * The base the drawer builds the invite link on.
 *   - web: the running app's origin (`window.location.origin`), else null.
 *   - native: the scheme+host of the configured web URL
 *     (`EXPO_PUBLIC_WEB_RECOVERY_URL`), else null. When null the drawer shows
 *     the bare code instead of a link (spec 198 §6).
 */
export function inviteLinkBase(
  platformOS: string,
  webOrigin: string | null | undefined,
  configuredWebUrl: string | null | undefined,
): string | null {
  if (platformOS === 'web') return webOrigin ? webOrigin : null;
  if (!configuredWebUrl) return null;
  const m = ORIGIN_RE.exec(configuredWebUrl.trim());
  return m ? m[1] : null;
}
