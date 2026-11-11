// Spec 198 §8.3 / B11 — source probe for the send-invite-email edge function.
//
// The edge function is a Deno bundle that jest cannot import, so (like the
// authEmailHook source probes) this reads its source text and pins the
// spec 198 contract:
//   - the email link is built from the fixed APP_URL as
//     `${APP_URL}/?register=true&invite=${inviteCode}` (AD-5 / AD-7),
//   - every interpolation of it into the HTML body goes through the inline
//     escapeHtml() (CLAUDE.md HTML-email rule),
//   - the inviteCode format check is the literal ^[0-9a-f]{32}$, identical to
//     the client's INVITE_CODE_RE (parity),
//   - the inviteUserByEmail fallback's redirectTo does not use inviteUrl
//     (the fallback is unchanged by spec 198),
//   - the new 400 comes AFTER the existing "email and name required" check, so
//     scripts/smoke-edge-roles.sh's `{}` arms still see that message first.
import * as fs from 'fs';
import * as path from 'path';
import { INVITE_CODE_RE } from './inviteLink';

const SRC = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'supabase', 'functions', 'send-invite-email', 'index.ts'),
  'utf8',
);

describe('send-invite-email source (spec 198)', () => {
  it('builds inviteUrl from APP_URL with register=true&invite=<code>', () => {
    expect(SRC).toContain('const inviteUrl = `${APP_URL}/?register=true&invite=${inviteCode}`;');
  });

  it('interpolates inviteUrl into the HTML only through escapeHtml()', () => {
    expect(SRC).toContain('href="${escapeHtml(inviteUrl)}"');
    const raw = SRC.match(/\$\{\s*inviteUrl\s*\}/g) ?? [];
    expect(raw).toHaveLength(0);
    const escaped = SRC.match(/\$\{escapeHtml\(inviteUrl\)\}/g) ?? [];
    // the button href and the plain-text fallback line
    expect(escaped).toHaveLength(2);
  });

  it('validates inviteCode with the same pattern as the client INVITE_CODE_RE', () => {
    expect(SRC).toContain('/^[0-9a-f]{32}$/.test(inviteCode)');
    expect(INVITE_CODE_RE.source).toBe('^[0-9a-f]{32}$');
    expect(INVITE_CODE_RE.flags).toBe('');
    expect(SRC).toContain('JSON.stringify({ error: "inviteCode required" })');
  });

  it('checks email/name before inviteCode', () => {
    const emailCheck = SRC.indexOf('"email and name required"');
    const codeCheck = SRC.indexOf('"inviteCode required"');
    expect(emailCheck).toBeGreaterThan(-1);
    expect(codeCheck).toBeGreaterThan(emailCheck);
  });

  it('leaves the inviteUserByEmail fallback redirectTo on the legacy URL', () => {
    const fallback = SRC.slice(SRC.indexOf('inviteUserByEmail('));
    const redirect = fallback.match(/redirectTo:\s*([A-Za-z_]+)/);
    expect(redirect?.[1]).toBe('registerUrl');
    expect(SRC).toContain('const registerUrl = `${APP_URL}?register=true`;');
  });
});
