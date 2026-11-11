// src/lib/inviteLink.test.ts — Spec 198 §8.3 (jest, unit project).
//
// Pure helpers: no mocks. Pins the link shape (AD-5, `invite` not `code`), the
// paste-a-full-link normalization the register screen relies on, and the
// per-platform base the invite drawers build the link from.

import {
  INVITE_CODE_RE,
  INVITE_URL_PARAM,
  buildInviteLink,
  formatInviteExpiry,
  inviteLinkBase,
  isInviteCode,
  normalizeInviteCode,
} from './inviteLink';

const CODE = '0123456789abcdef0123456789abcdef';

describe('normalizeInviteCode', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeInviteCode(`   ${CODE}\n`)).toBe(CODE);
  });

  it('lowercases an upper-case code', () => {
    expect(normalizeInviteCode(CODE.toUpperCase())).toBe(CODE);
  });

  it('extracts the code from a pasted full link', () => {
    expect(normalizeInviteCode(`https://app.example.com/?register=true&invite=${CODE}`)).toBe(CODE);
  });

  it('extracts the code from a link with extra params and a fragment', () => {
    expect(
      normalizeInviteCode(`https://app.example.com/?invite=${CODE.toUpperCase()}&register=true&utm=x#top`),
    ).toBe(CODE);
  });

  it('does not treat `code=` as the invite param (AD-5)', () => {
    // A recovery-style link must not be mistaken for an invite link; the whole
    // string survives and fails isInviteCode.
    const out = normalizeInviteCode(`https://app.example.com/?code=${CODE}`);
    expect(out).not.toBe(CODE);
    expect(isInviteCode(out)).toBe(false);
  });

  it('returns "" for junk with nothing in it', () => {
    expect(normalizeInviteCode(null)).toBe('');
    expect(normalizeInviteCode(undefined)).toBe('');
    expect(normalizeInviteCode('')).toBe('');
    expect(normalizeInviteCode('   ')).toBe('');
    expect(normalizeInviteCode('https://app.example.com/?register=true&invite=')).toBe('');
  });

  it('leaves non-code text as-is (lowercased) for isInviteCode to reject', () => {
    expect(normalizeInviteCode('Not-A-Code')).toBe('not-a-code');
  });
});

describe('isInviteCode', () => {
  it('accepts exactly 32 lowercase hex', () => {
    expect(isInviteCode(CODE)).toBe(true);
  });

  it('rejects upper case, wrong length, non-hex and empty', () => {
    expect(isInviteCode(CODE.toUpperCase())).toBe(false);
    expect(isInviteCode(CODE.slice(1))).toBe(false);
    expect(isInviteCode(`${CODE}0`)).toBe(false);
    expect(isInviteCode(`${CODE.slice(1)}g`)).toBe(false);
    expect(isInviteCode('')).toBe(false);
  });

  it('INVITE_CODE_RE is the literal the edge function mirrors', () => {
    expect(INVITE_CODE_RE.source).toBe('^[0-9a-f]{32}$');
    expect(INVITE_URL_PARAM).toBe('invite');
  });
});

describe('buildInviteLink', () => {
  it('builds `<base>/?register=true&invite=<code>`', () => {
    expect(buildInviteLink('https://app.example.com', CODE)).toBe(
      `https://app.example.com/?register=true&invite=${CODE}`,
    );
  });

  it('collapses a trailing slash on the base', () => {
    expect(buildInviteLink('https://app.example.com/', CODE)).toBe(
      `https://app.example.com/?register=true&invite=${CODE}`,
    );
    expect(buildInviteLink('http://localhost:8081//', CODE)).toBe(
      `http://localhost:8081/?register=true&invite=${CODE}`,
    );
  });

  it('round-trips through normalizeInviteCode', () => {
    expect(normalizeInviteCode(buildInviteLink('https://a.example', CODE))).toBe(CODE);
  });
});

describe('inviteLinkBase', () => {
  it('web: the running origin', () => {
    expect(inviteLinkBase('web', 'http://localhost:8081', 'https://prod.example.com/reset-password')).toBe(
      'http://localhost:8081',
    );
  });

  it('web: null when no origin is available', () => {
    expect(inviteLinkBase('web', null, 'https://prod.example.com')).toBeNull();
    expect(inviteLinkBase('web', undefined, undefined)).toBeNull();
  });

  it('native with a configured web URL: its scheme + host', () => {
    expect(inviteLinkBase('ios', null, 'https://prod.example.com')).toBe('https://prod.example.com');
  });

  it('native with a configured web URL that has a path: path dropped', () => {
    expect(inviteLinkBase('android', null, 'https://prod.example.com:8443/reset-password?x=1')).toBe(
      'https://prod.example.com:8443',
    );
  });

  it('native with nothing configured: null', () => {
    expect(inviteLinkBase('ios', null, undefined)).toBeNull();
    expect(inviteLinkBase('ios', null, '')).toBeNull();
    expect(inviteLinkBase('ios', null, 'not a url')).toBeNull();
  });
});

// Review CR-2 — the invite panel renders the server-issued expiry, not a
// hard-coded "48 hours". Expected values are built from the same instant with
// local Date getters, so the assertions hold in any TZ.
describe('formatInviteExpiry', () => {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const local = (ms: number) => {
    const t = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${MON[t.getMonth()]} ${t.getDate()}, ${t.getFullYear()}, ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  };

  it('formats a Postgres jsonb timestamptz (microseconds, +00:00) in local time', () => {
    expect(formatInviteExpiry('2026-11-12T15:04:05.123456+00:00')).toBe(local(Date.UTC(2026, 10, 12, 15, 4, 5)));
  });

  it('honours a non-UTC offset and a Z suffix', () => {
    expect(formatInviteExpiry('2026-11-12T10:04:00-05:00')).toBe(local(Date.UTC(2026, 10, 12, 15, 4, 0)));
    expect(formatInviteExpiry('2026-11-12T12:00:00Z')).toBe(local(Date.UTC(2026, 10, 12, 12, 0, 0)));
  });

  it('returns null for anything that is not a timestamp', () => {
    expect(formatInviteExpiry('')).toBeNull();
    expect(formatInviteExpiry('soon')).toBeNull();
    expect(formatInviteExpiry(null)).toBeNull();
    expect(formatInviteExpiry(undefined)).toBeNull();
  });
});
