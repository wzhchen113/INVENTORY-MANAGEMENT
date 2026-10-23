// Spec 166 §11 — unit tests for the auth-email-hook core block. The block in
// src/lib/authEmailHook.ts ships byte-identical inside
// supabase/functions/auth-email-hook/index.ts (authEmailHook.parity.test.ts),
// so these tests cover the shipped routing / drop / render / transport logic.
// This file is also the prod-transport (Resend) proof — spec 166 D10.
import {
  RESEND_API_URL,
  buildTransportRequest,
  classifyDelivery,
  isLocalDevSecret,
  isTransportSuccess,
  logAction,
  parseHookSecrets,
  parsePayload,
  planMails,
  recoveryLink,
  renderBody,
  resolveLinkAndCode,
  resolveRedirect,
  resolveTransport,
  routeLegs,
  subjectFor,
  verifyBase,
  verifyLink,
} from './authEmailHook';
import type { HookPayload, Leg, PlannedMail, TransportConfig } from './authEmailHook';

const PH_A = `u-${'a'.repeat(32)}@no-email.invalid`;
const PH_B = `u-${'0123456789abcdef'.repeat(2)}@no-email.invalid`;
const REAL = 'manager@example.com';
const REAL_NEW = 'new.manager@example.com';
const SUPABASE_URL = 'http://kong:8000';
const API_SITE = 'https://abc.supabase.co/auth/v1';
const REDIRECT = 'http://localhost:8081/reset-password';
const LOCAL_SECRET = 'v1,whsec_LOCAL/DEV/ONLY/imr/SendEmailHook/NotForProd/0000';
const PROD_LIKE_SECRET = 'v1,whsec_' + 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODkw'; // 44 chars

function payload(action: string, over: { user?: Partial<HookPayload['user']>; data?: Record<string, string> } = {}): HookPayload {
  const raw = {
    user: { email: REAL, new_email: '', ...(over.user ?? {}) },
    email_data: {
      token: '123456',
      token_hash: 'hash-main',
      redirect_to: REDIRECT,
      email_action_type: action,
      site_url: API_SITE,
      token_new: '',
      token_hash_new: '',
      old_email: '',
      ...(over.data ?? {}),
    },
  };
  const p = parsePayload(raw);
  if (p === null) throw new Error('fixture failed parsePayload');
  return p;
}

function plan(p: HookPayload) {
  const r = planMails(p, SUPABASE_URL);
  if (!r.ok) throw new Error(`plan failed: ${r.reason}`);
  return r;
}

const NOTIFICATIONS = [
  'password_changed_notification',
  'email_changed_notification',
  'phone_changed_notification',
  'identity_linked_notification',
  'identity_unlinked_notification',
  'mfa_factor_enrolled_notification',
  'mfa_factor_unenrolled_notification',
];

describe('parsePayload', () => {
  it('rejects non-objects and missing user / email_data', () => {
    expect(parsePayload(null)).toBeNull();
    expect(parsePayload('x')).toBeNull();
    expect(parsePayload([])).toBeNull();
    expect(parsePayload({})).toBeNull();
    expect(parsePayload({ user: {}, email_data: null })).toBeNull();
    expect(parsePayload({ user: [], email_data: { email_action_type: 'recovery' } })).toBeNull();
  });

  it('requires a non-empty string email_action_type', () => {
    expect(parsePayload({ user: {}, email_data: {} })).toBeNull();
    expect(parsePayload({ user: {}, email_data: { email_action_type: '' } })).toBeNull();
    expect(parsePayload({ user: {}, email_data: { email_action_type: 7 } })).toBeNull();
  });

  it('rejects non-string fields, defaults missing / null ones to ""', () => {
    expect(parsePayload({ user: { email: 5 }, email_data: { email_action_type: 'recovery' } })).toBeNull();
    expect(parsePayload({ user: { email: REAL }, email_data: { email_action_type: 'recovery', token_hash: {} } })).toBeNull();
    const p = parsePayload({ user: { email: REAL, new_email: null }, email_data: { email_action_type: 'recovery' } });
    expect(p).toEqual({
      user: { email: REAL, new_email: '' },
      email_data: {
        token: '', token_hash: '', redirect_to: '', email_action_type: 'recovery',
        site_url: '', token_new: '', token_hash_new: '', old_email: '',
      },
    });
  });
});

describe('routeLegs (§3.2)', () => {
  it.each(['recovery', 'signup', 'invite', 'magiclink', 'email', 'reauthentication', 'zz_future_type'])(
    '%s → user.email with token_hash + token',
    (action) => {
      expect(routeLegs(payload(action))).toEqual([{ to: REAL, hash: 'hash-main', code: '123456' }]);
    },
  );

  it.each(NOTIFICATIONS.filter((n) => n !== 'email_changed_notification'))('%s → user.email, no hash/code', (action) => {
    expect(routeLegs(payload(action))).toEqual([{ to: REAL, hash: '', code: '' }]);
  });

  it('email_changed_notification → old_email, falling back to user.email', () => {
    expect(routeLegs(payload('email_changed_notification', { data: { old_email: 'old@example.com' } }))).toEqual([
      { to: 'old@example.com', hash: '', code: '' },
    ]);
    expect(routeLegs(payload('email_changed_notification'))).toEqual([{ to: REAL, hash: '', code: '' }]);
  });

  it('email_change secure: the swapped-hash pairing', () => {
    const p = payload('email_change', {
      user: { new_email: REAL_NEW },
      data: { token: '111111', token_hash: 'hash-for-new', token_new: '222222', token_hash_new: 'hash-for-current' },
    });
    expect(routeLegs(p)).toEqual([
      { to: REAL, hash: 'hash-for-current', code: '111111' },
      { to: REAL_NEW, hash: 'hash-for-new', code: '222222' },
    ]);
  });

  it('email_change single pair (secure change off) → new_email only', () => {
    const p = payload('email_change', { user: { new_email: REAL_NEW }, data: { token: '333333', token_hash: 'h-single' } });
    expect(routeLegs(p)).toEqual([{ to: REAL_NEW, hash: 'h-single', code: '333333' }]);
    const p2 = payload('email_change', { user: { new_email: REAL_NEW }, data: { token_new: '444444', token_hash: 'h2' } });
    expect(routeLegs(p2)).toEqual([{ to: REAL_NEW, hash: 'h2', code: '444444' }]);
  });

  it('email_change without new_email, or a leg with no recipient → null (invalid_payload)', () => {
    expect(routeLegs(payload('email_change', { data: { token_hash_new: 'x' } }))).toBeNull();
    expect(routeLegs(payload('recovery', { user: { email: '' } }))).toBeNull();
    expect(planMails(payload('recovery', { user: { email: '  ' } }), SUPABASE_URL)).toEqual({ ok: false, reason: 'invalid_payload' });
  });
});

describe('placeholder drop before render', () => {
  it('an all-placeholder payload renders nothing and counts the drops', () => {
    for (const action of ['recovery', 'signup', 'invite', 'magiclink', 'email', 'reauthentication', 'zz_future_type', ...NOTIFICATIONS]) {
      const r = plan(payload(action, { user: { email: PH_A } }));
      expect(r.mails).toEqual([]);
      expect(r.dropped).toBe(1);
    }
    const both = plan(payload('email_change', { user: { email: PH_A, new_email: PH_B }, data: { token_hash_new: 'x' } }));
    expect(both).toMatchObject({ mails: [], dropped: 2 });
    const oldPh = plan(payload('email_changed_notification', { data: { old_email: PH_B } }));
    expect(oldPh).toMatchObject({ mails: [], dropped: 1 });
  });

  it('the predicate is applied trimmed + case-insensitively (spec 165)', () => {
    expect(plan(payload('recovery', { user: { email: `  ${PH_A.toUpperCase()} ` } })).mails).toEqual([]);
  });

  it('a placeholder leg is dropped even when the payload is otherwise unlinkable', () => {
    expect(plan(payload('recovery', { user: { email: PH_A }, data: { redirect_to: '', site_url: '' } }))).toMatchObject({
      mails: [],
      dropped: 1,
    });
  });

  it('email_change placeholder-current + real-new → only the new leg', () => {
    const r = plan(payload('email_change', {
      user: { email: PH_A, new_email: REAL_NEW },
      data: { token_hash: 'hash-for-new', token_hash_new: 'hash-for-current', token_new: '222222' },
    }));
    expect(r.dropped).toBe(1);
    expect(r.mails.map((m) => m.to)).toEqual([REAL_NEW]);
    expect(r.mails[0].text).toContain('token=hash-for-new');
    expect(r.mails[0].text).not.toContain('hash-for-current');
  });

  it('email_change real-current + placeholder-new → only the current leg', () => {
    const r = plan(payload('email_change', {
      user: { email: REAL, new_email: PH_B },
      data: { token_hash: 'hash-for-new', token_hash_new: 'hash-for-current' },
    }));
    expect(r.dropped).toBe(1);
    expect(r.mails.map((m) => m.to)).toEqual([REAL]);
    expect(r.mails[0].text).toContain('token=hash-for-current');
  });
});

describe('recovery link (spec 085 parity)', () => {
  it('is exactly <redirect_to>?token_hash=<hash>&type=recovery', () => {
    expect(recoveryLink(REDIRECT, API_SITE, 'abc123')).toBe(`${REDIRECT}?token_hash=abc123&type=recovery`);
    const r = plan(payload('recovery', { data: { token_hash: 'abc123' } }));
    expect(r.mails[0].subject).toBe('Reset your password');
    expect(r.mails[0].text).toContain(`${REDIRECT}?token_hash=abc123&type=recovery`);
    expect(r.mails[0].html).toContain(`${REDIRECT}?token_hash=abc123&amp;type=recovery`);
  });

  it('uses & when redirect_to already has a query string; encodes the hash (pkce_ included)', () => {
    expect(recoveryLink('https://app.example.com/r?x=1', '', 'pkce_a/b+c=')).toBe(
      'https://app.example.com/r?x=1&token_hash=pkce_a%2Fb%2Bc%3D&type=recovery',
    );
  });

  it('falls back to site_url; unusable both → null → unlinkable', () => {
    expect(recoveryLink('', 'https://site.example.com', 'h')).toBe('https://site.example.com?token_hash=h&type=recovery');
    expect(recoveryLink('not a url', '', 'h')).toBeNull();
    expect(planMails(payload('recovery', { data: { redirect_to: '', site_url: '' } }), SUPABASE_URL)).toEqual({
      ok: false,
      reason: 'unlinkable',
    });
  });

  it('rejects javascript:/data:/vbscript:/file: redirects, allows a native scheme', () => {
    expect(recoveryLink('javascript:alert(1)', '', 'h')).toBeNull();
    expect(recoveryLink('data:text/html,hi', '', 'h')).toBeNull();
    expect(recoveryLink('vbscript:x', '', 'h')).toBeNull();
    expect(recoveryLink('file:///etc/passwd', '', 'h')).toBeNull();
    expect(recoveryLink('javascript:alert(1)', 'https://site.example.com', 'h')).toBe(
      'https://site.example.com?token_hash=h&type=recovery',
    );
    expect(recoveryLink('imr://reset-password', '', 'h')).toBe('imr://reset-password?token_hash=h&type=recovery');
  });

  it('an empty hash is unlinkable', () => {
    expect(recoveryLink(REDIRECT, '', '')).toBeNull();
  });
});

describe('verify link (D11)', () => {
  it('verifyBase: API-shaped site_url wins, else SUPABASE_URL + /auth/v1', () => {
    expect(verifyBase(API_SITE, SUPABASE_URL)).toBe(API_SITE);
    expect(verifyBase(API_SITE + '/', SUPABASE_URL)).toBe(API_SITE);
    expect(verifyBase('http://127.0.0.1:54321', SUPABASE_URL)).toBe('http://kong:8000/auth/v1');
    expect(verifyBase('', 'https://abc.supabase.co/')).toBe('https://abc.supabase.co/auth/v1');
    expect(verifyBase('javascript:x/auth/v1', '')).toBeNull();
  });

  it('verifyLink encodes hash, type and redirect_to', () => {
    expect(verifyLink(API_SITE, 'pkce_a+b', 'signup', 'http://localhost:8081/register?x=1')).toBe(
      `${API_SITE}/verify?token=pkce_a%2Bb&type=signup&redirect_to=http%3A%2F%2Flocalhost%3A8081%2Fregister%3Fx%3D1`,
    );
  });

  it.each(['signup', 'invite', 'magiclink', 'email', 'zz_future_type'])('%s renders a /verify link with its own type', (action) => {
    const r = plan(payload(action));
    expect(r.mails[0].text).toContain(`${API_SITE}/verify?token=hash-main&type=${action}&redirect_to=${encodeURIComponent(REDIRECT)}`);
  });

  it('invite carries send-invite-email redirectTo through', () => {
    const r = plan(payload('invite', { data: { redirect_to: 'https://hopeful-lewin.vercel.app?register=true' } }));
    expect(r.mails[0].text).toContain('redirect_to=https%3A%2F%2Fhopeful-lewin.vercel.app%3Fregister%3Dtrue');
  });

  it('signup / invite without a hash, or with no usable base, are unlinkable', () => {
    expect(planMails(payload('signup', { data: { token_hash: '' } }), SUPABASE_URL)).toEqual({ ok: false, reason: 'unlinkable' });
    expect(planMails(payload('invite', { data: { site_url: '' } }), '')).toEqual({ ok: false, reason: 'unlinkable' });
    expect(planMails(payload('magiclink', { data: { redirect_to: '', site_url: '' } }), SUPABASE_URL)).toEqual({
      ok: false,
      reason: 'unlinkable',
    });
  });
});

describe('content', () => {
  it('subject table, including the unknown fallback', () => {
    expect(subjectFor('recovery')).toBe('Reset your password');
    expect(subjectFor('signup')).toBe('Confirm your email');
    expect(subjectFor('invite')).toBe('You have been invited to I.M.R');
    expect(subjectFor('magiclink')).toBe('Your sign-in link');
    expect(subjectFor('email')).toBe('Your sign-in code');
    expect(subjectFor('email_change')).toBe('Confirm your email change');
    expect(subjectFor('reauthentication')).toBe('Your verification code');
    expect(subjectFor('password_changed_notification')).toBe('Your password was changed');
    expect(subjectFor('email_changed_notification')).toBe('Your email address was changed');
    expect(subjectFor('phone_changed_notification')).toBe('Your phone number was changed');
    expect(subjectFor('identity_linked_notification')).toBe('A sign-in method was linked to your account');
    expect(subjectFor('identity_unlinked_notification')).toBe('A sign-in method was removed from your account');
    expect(subjectFor('mfa_factor_enrolled_notification')).toBe('A verification method was added to your account');
    expect(subjectFor('mfa_factor_unenrolled_notification')).toBe('A verification method was removed from your account');
    expect(subjectFor('zz_future_type')).toBe('Account notification');
  });

  it('an unknown type gets a link with a hash, a code with a token, and is never dropped', () => {
    const r = plan(payload('zz_future_type'));
    expect(r.mails).toHaveLength(1);
    expect(r.mails[0].text).toContain('/verify?token=hash-main');
    expect(r.mails[0].text).toContain('123456');
    const bare = plan(payload('zz_preflight_probe', { data: { token: '', token_hash: '' } }));
    expect(bare.mails).toHaveLength(1);
    expect(bare.mails[0].subject).toBe('Account notification');
    expect(bare.mails[0].text).not.toContain('http');
  });

  it('magiclink / email / email_change also show the code; signup / invite do not', () => {
    for (const action of ['magiclink', 'email']) expect(plan(payload(action)).mails[0].text).toContain('Your code: 123456');
    const ec = plan(payload('email_change', { user: { new_email: REAL_NEW }, data: { token: '999000' } }));
    expect(ec.mails[0].text).toContain('Your code: 999000');
    for (const action of ['signup', 'invite']) expect(plan(payload(action)).mails[0].text).not.toContain('123456');
  });

  it('reauthentication: code, no link', () => {
    const m = plan(payload('reauthentication')).mails[0];
    expect(m.text).toContain('123456');
    expect(m.html).toContain('123456');
    expect(m.text).not.toContain('/verify');
    expect(m.html).not.toContain('/verify');
    expect(m.text).not.toContain('hash-main');
  });

  it.each(NOTIFICATIONS)('%s: no http, no token, no hash', (action) => {
    const m = plan(payload(action)).mails[0];
    for (const part of [m.text, m.html]) {
      expect(part).not.toContain('http');
      expect(part).not.toContain('123456');
      expect(part).not.toContain('hash-main');
    }
    expect(m.subject).toBe(subjectFor(action));
  });

  it('escapes interpolated values in HTML, leaves Text raw', () => {
    const evil = '"><script>alert(1)</script>@example.com';
    const r = plan(payload('email_change', { user: { new_email: evil }, data: { token_hash: 'h', token: '1' } }));
    const m = r.mails[0];
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&quot;&gt;&lt;script&gt;');
    expect(m.text).toContain(evil);

    const r2 = plan(payload('recovery', { data: { redirect_to: 'https://x.example.com/"><script>' } }));
    expect(r2.mails[0].html).not.toContain('"><script>');
    expect(r2.mails[0].html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('trims the recipient address', () => {
    expect(plan(payload('recovery', { user: { email: `  ${REAL} ` } })).mails[0].to).toBe(REAL);
  });
});

describe('hook secrets', () => {
  it('parses a valid secret and strips the prefix', () => {
    expect(parseHookSecrets(PROD_LIKE_SECRET)).toEqual([PROD_LIKE_SECRET.slice('v1,whsec_'.length)]);
  });

  it('accepts the committed D7 local literal', () => {
    expect(parseHookSecrets(LOCAL_SECRET)).toEqual(['LOCAL/DEV/ONLY/imr/SendEmailHook/NotForProd/0000']);
  });

  it('supports | rotation; any malformed part fails the whole value', () => {
    expect(parseHookSecrets(`${PROD_LIKE_SECRET}|${LOCAL_SECRET}`)).toHaveLength(2);
    expect(parseHookSecrets(`${PROD_LIKE_SECRET}|nope`)).toBeNull();
  });

  it('rejects unset, missing prefix, wrong length and illegal characters', () => {
    expect(parseHookSecrets(undefined)).toBeNull();
    expect(parseHookSecrets('')).toBeNull();
    expect(parseHookSecrets('whsec_' + 'A'.repeat(40))).toBeNull();
    expect(parseHookSecrets('v1,whsec_' + 'A'.repeat(31))).toBeNull();
    expect(parseHookSecrets('v1,whsec_' + 'A'.repeat(32))).not.toBeNull();
    expect(parseHookSecrets('v1,whsec_' + 'A'.repeat(88))).not.toBeNull();
    expect(parseHookSecrets('v1,whsec_' + 'A'.repeat(89))).toBeNull();
    expect(parseHookSecrets('v1,whsec_' + 'A'.repeat(39) + '-')).toBeNull();
    expect(parseHookSecrets(' ' + PROD_LIKE_SECRET)).toBeNull();
  });

  // Release-proposal fix 1 (code-reviewer SF1 / security L4): a value that
  // passes the shape regex but is not strict padded base64 must be rejected
  // here (→ 500 "hook misconfigured"), not surface later as a 401.
  it('rejects a body that is not strict padded base64 (length % 4, misplaced =)', () => {
    expect(parseHookSecrets('v1,whsec_' + 'A'.repeat(43))).toBeNull();
    expect(parseHookSecrets(PROD_LIKE_SECRET.slice(0, -1))).toBeNull(); // one char short (mis-paste)
    expect(parseHookSecrets('v1,whsec_' + 'A'.repeat(20) + '=' + 'A'.repeat(23))).toBeNull(); // mid-string =
    expect(parseHookSecrets('v1,whsec_' + 'A'.repeat(29) + '===')).toBeNull();
    expect(parseHookSecrets(`${PROD_LIKE_SECRET}|v1,whsec_${'A'.repeat(43)}`)).toBeNull(); // bad rotation slot
  });

  it('still accepts the D7 literal and a 44-char `openssl rand -base64 32` value', () => {
    expect(parseHookSecrets(LOCAL_SECRET)).toEqual(['LOCAL/DEV/ONLY/imr/SendEmailHook/NotForProd/0000']);
    const opensslLike = '7eHvtN71UzZxML0GM4xisYpyjd/oeBCVaepUh0CMyQ8=';
    expect(opensslLike).toHaveLength(44);
    expect(parseHookSecrets(`v1,whsec_${opensslLike}`)).toEqual([opensslLike]);
    expect(parseHookSecrets('v1,whsec_' + 'A'.repeat(42) + '==')).not.toBeNull();
  });

  it('isLocalDevSecret flags the committed literal only', () => {
    expect(isLocalDevSecret(LOCAL_SECRET)).toBe(true);
    expect(isLocalDevSecret(PROD_LIKE_SECRET)).toBe(false);
  });
});

describe('resolveTransport', () => {
  const MAILPIT = { transport: 'mailpit', from: 'no-reply@imr.local.test', fromName: 'I.M.R (local)', mailpitUrl: 'http://mailpit:8025/api/v1/send' };
  const RESEND = { transport: 'resend', from: 'no-reply@mail.example.com', fromName: 'I.M.R', resendApiKey: 're_test_key', hookSecretRaw: PROD_LIKE_SECRET };

  it('resolves mailpit and resend', () => {
    expect(resolveTransport(MAILPIT)).toEqual({ kind: 'mailpit', url: MAILPIT.mailpitUrl, from: MAILPIT.from, fromName: MAILPIT.fromName });
    expect(resolveTransport(RESEND)).toEqual({ kind: 'resend', apiKey: 're_test_key', from: RESEND.from, fromName: 'I.M.R' });
    expect(resolveTransport({ ...RESEND, fromName: undefined })).toMatchObject({ fromName: '' });
  });

  it('unknown or unset transport → null', () => {
    expect(resolveTransport({ ...MAILPIT, transport: undefined })).toBeNull();
    expect(resolveTransport({ ...MAILPIT, transport: 'smtp' })).toBeNull();
  });

  it('bad From / From name → null', () => {
    expect(resolveTransport({ ...MAILPIT, from: undefined })).toBeNull();
    expect(resolveTransport({ ...MAILPIT, from: 'no at sign' })).toBeNull();
    expect(resolveTransport({ ...MAILPIT, from: 'Name <a@b.c>' })).toBeNull();
    expect(resolveTransport({ ...MAILPIT, fromName: 'Evil <x>' })).toBeNull();
    expect(resolveTransport({ ...MAILPIT, fromName: 'a"b' })).toBeNull();
    expect(resolveTransport({ ...MAILPIT, fromName: 'a\r\nBcc: x@y.z' })).toBeNull();
  });

  it('mailpit needs an http(s) URL', () => {
    expect(resolveTransport({ ...MAILPIT, mailpitUrl: undefined })).toBeNull();
    expect(resolveTransport({ ...MAILPIT, mailpitUrl: 'ftp://x/y' })).toBeNull();
  });

  it('resend: needs a key, refuses @resend.dev, trips on the local dev secret (D7)', () => {
    expect(resolveTransport({ ...RESEND, resendApiKey: '' })).toBeNull();
    expect(resolveTransport({ ...RESEND, from: 'onboarding@resend.dev' })).toBeNull();
    expect(resolveTransport({ ...RESEND, from: 'onboarding@RESEND.DEV' })).toBeNull();
    expect(resolveTransport({ ...RESEND, hookSecretRaw: LOCAL_SECRET })).toBeNull();
    expect(resolveTransport({ ...RESEND, hookSecretRaw: `${PROD_LIKE_SECRET}|${LOCAL_SECRET}` })).toBeNull();
  });
});

describe('buildTransportRequest (prod-transport proof, D10)', () => {
  const mail: PlannedMail = plan(payload('recovery', { data: { token_hash: 'hh1' } })).mails[0];

  it('Resend: URL, auth, idempotency key, from with name, to, subject, link in html + text', () => {
    const cfg: TransportConfig = { kind: 'resend', apiKey: 're_secret', from: 'no-reply@mail.example.com', fromName: 'I.M.R' };
    const r = buildTransportRequest(cfg, mail, 'msg_abc:0');
    expect(r.url).toBe(RESEND_API_URL);
    expect(r.url).toBe('https://api.resend.com/emails');
    expect(r.headers).toEqual({
      Authorization: 'Bearer re_secret',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'msg_abc:0',
    });
    const body = JSON.parse(r.body);
    expect(body.from).toBe('I.M.R <no-reply@mail.example.com>');
    expect(body.to).toEqual([REAL]);
    expect(body.subject).toBe('Reset your password');
    expect(body.text).toContain(`${REDIRECT}?token_hash=hh1&type=recovery`);
    expect(body.html).toContain(`${REDIRECT}?token_hash=hh1&amp;type=recovery`);
  });

  it('Resend: bare from when no name', () => {
    const cfg: TransportConfig = { kind: 'resend', apiKey: 'k', from: 'no-reply@mail.example.com', fromName: '' };
    expect(JSON.parse(buildTransportRequest(cfg, mail, 'x').body).from).toBe('no-reply@mail.example.com');
  });

  it('Mailpit: send-API body shape, no auth header', () => {
    const cfg: TransportConfig = { kind: 'mailpit', url: 'http://mailpit:8025/api/v1/send', from: 'no-reply@imr.local.test', fromName: 'I.M.R (local)' };
    const r = buildTransportRequest(cfg, mail, 'ignored');
    expect(r.url).toBe('http://mailpit:8025/api/v1/send');
    expect(r.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(r.body)).toEqual({
      From: { Email: 'no-reply@imr.local.test', Name: 'I.M.R (local)' },
      To: [{ Email: REAL }],
      Subject: 'Reset your password',
      HTML: mail.html,
      Text: mail.text,
    });
    expect(JSON.parse(buildTransportRequest({ ...cfg, fromName: '' }, mail, 'x').body).From).toEqual({ Email: 'no-reply@imr.local.test' });
  });

  it('isTransportSuccess boundaries', () => {
    expect(isTransportSuccess(199)).toBe(false);
    expect(isTransportSuccess(200)).toBe(true);
    expect(isTransportSuccess(299)).toBe(true);
    expect(isTransportSuccess(300)).toBe(false);
    expect(isTransportSuccess(429)).toBe(false);
    expect(isTransportSuccess(500)).toBe(false);
  });
});

describe('logAction', () => {
  it('passes [a-z_]{1,64} through, everything else becomes "unknown"', () => {
    expect(logAction('recovery')).toBe('recovery');
    expect(logAction('zz_future_type')).toBe('zz_future_type');
    expect(logAction('Recovery')).toBe('unknown');
    expect(logAction('a@b.c')).toBe('unknown');
    expect(logAction('x'.repeat(65))).toBe('unknown');
    expect(logAction('')).toBe('unknown');
    expect(logAction(42)).toBe('unknown');
    expect(logAction(undefined)).toBe('unknown');
  });
});

// Spec 168 §1.6 — the renderMail split, covered directly.
describe('resolveRedirect (spec 168)', () => {
  it('returns a usable redirect_to raw, else a usable site_url, else null', () => {
    expect(resolveRedirect(REDIRECT, API_SITE)).toBe(REDIRECT);
    expect(resolveRedirect('', 'https://site.example.com')).toBe('https://site.example.com');
    expect(resolveRedirect('javascript:alert(1)', 'https://site.example.com')).toBe('https://site.example.com');
    expect(resolveRedirect('', '')).toBeNull();
    expect(resolveRedirect('javascript:alert(1)', 'not a url')).toBeNull();
    expect(resolveRedirect('imr://reset-password', '')).toBe('imr://reset-password');
  });
});

describe('resolveLinkAndCode (spec 168)', () => {
  const leg = (over: Partial<Leg> = {}): Leg => ({ to: REAL, hash: 'hash-main', code: '123456', ...over });
  const data = (over: Record<string, string> = {}) => payload('magiclink', { data: over }).email_data;
  const verify = (action: string) =>
    `${API_SITE}/verify?token=hash-main&type=${action}&redirect_to=${encodeURIComponent(REDIRECT)}`;

  it('a notification has no link and no code, even with a non-empty leg hash and code', () => {
    expect(resolveLinkAndCode('password_changed_notification', leg(), data(), SUPABASE_URL)).toStrictEqual({ link: '', code: '' });
  });

  it('reauthentication is code only', () => {
    expect(resolveLinkAndCode('reauthentication', leg(), data(), SUPABASE_URL)).toStrictEqual({ link: '', code: '123456' });
  });

  it('recovery is the spec 085 link with no code; an empty hash is unlinkable', () => {
    expect(resolveLinkAndCode('recovery', leg(), data(), SUPABASE_URL)).toStrictEqual({
      link: `${REDIRECT}?token_hash=hash-main&type=recovery`,
      code: '',
    });
    expect(resolveLinkAndCode('recovery', leg({ hash: '' }), data(), SUPABASE_URL)).toBeNull();
  });

  it('signup / invite are link-only; an empty hash is unlinkable', () => {
    expect(resolveLinkAndCode('signup', leg({ hash: '' }), data(), SUPABASE_URL)).toBeNull();
    expect(resolveLinkAndCode('invite', leg({ hash: '' }), data(), SUPABASE_URL)).toBeNull();
    expect(resolveLinkAndCode('signup', leg(), data(), SUPABASE_URL)).toStrictEqual({ link: verify('signup'), code: '' });
  });

  it('magiclink with an empty hash shows the code with no link', () => {
    expect(resolveLinkAndCode('magiclink', leg({ hash: '' }), data(), SUPABASE_URL)).toStrictEqual({ link: '', code: '123456' });
  });

  it('a link type with no usable redirect base, or no usable verify base, is unlinkable', () => {
    expect(resolveLinkAndCode('magiclink', leg(), data({ redirect_to: '', site_url: '' }), SUPABASE_URL)).toBeNull();
    expect(resolveLinkAndCode('magiclink', leg(), data({ site_url: 'http://127.0.0.1:3000' }), '')).toBeNull();
  });

  it('an unknown type with a hash and a token gets both', () => {
    expect(resolveLinkAndCode('zz_future_type', leg(), data(), SUPABASE_URL)).toStrictEqual({
      link: verify('zz_future_type'),
      code: '123456',
    });
  });
});

describe('renderBody (spec 168)', () => {
  it('a notification omits the ignore line; an empty link renders no anchor', () => {
    const b = renderBody('password_changed_notification', '', '', '');
    expect(b.subject).toBe('Your password was changed');
    for (const part of [b.html, b.text]) expect(part).not.toContain('If you did not request this');
    expect(b.html).not.toContain('<a href');
    const withCode = renderBody('magiclink', '', '', '123456');
    expect(withCode.html).not.toContain('<a href');
    expect(withCode.text).toContain('If you did not request this');
    expect(withCode.text).toContain('Your code: 123456');
  });
});

describe('classifyDelivery (spec 168 item 2)', () => {
  it('a timeout / abort throw is "timeout" with no status', () => {
    expect(classifyDelivery({ kind: 'threw', errorName: 'TimeoutError' })).toStrictEqual({ ok: false, reason: 'timeout' });
    expect(classifyDelivery({ kind: 'threw', errorName: 'AbortError' })).toStrictEqual({ ok: false, reason: 'timeout' });
  });

  it('any other throw is "transport" with no status', () => {
    expect(classifyDelivery({ kind: 'threw', errorName: 'TypeError' })).toStrictEqual({ ok: false, reason: 'transport' });
    expect(classifyDelivery({ kind: 'threw', errorName: '' })).toStrictEqual({ ok: false, reason: 'transport' });
  });

  it.each([199, 300, 500])('status %i is "transport" with that status', (status) => {
    expect(classifyDelivery({ kind: 'status', status })).toStrictEqual({ ok: false, reason: 'transport', status });
  });

  it.each([200, 299])('status %i is ok', (status) => {
    expect(classifyDelivery({ kind: 'status', status })).toStrictEqual({ ok: true });
  });
});
