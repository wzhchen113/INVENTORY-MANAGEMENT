// Spec 168 §1G — golden equivalence check for the auth-email-hook core.
//
// planMails() output (ok, action, dropped, reason, and every mail's to /
// subject / html / text) for the matrix below must stay byte-identical to the
// output captured from the unmodified 227436c baseline, committed as
// src/lib/authEmailHook.golden.json. The spec 168 renderMail split is a pure
// refactor; this suite is the proof.
//
// A JSON fixture rather than a jest snapshot: a local `npx jest` silently
// WRITES a missing snapshot and `jest -u` silently rewrites one. jest never
// writes this fixture; only the guarded capture mode below can.
//
// Verify (default; the only mode in CI):
//   npx jest src/lib/authEmailHook.golden.test.ts
// Capture (never in CI; only against the 227436c core block; never overwrites):
//   AUTH_EMAIL_HOOK_GOLDEN=capture npx jest src/lib/authEmailHook.golden.test.ts
// To recapture, delete the fixture deliberately (the deletion shows in git
// status). Capture refuses unless the working-tree core block hashes to the
// 227436c block, so a post-refactor capture is mechanically impossible.
//
// The matrix lives in THIS file (not a shared .ts module) because the spec 165
// lint scans non-test src/**/*.ts for the placeholder domain. This file
// imports only parsePayload / planMails / Plan, so it runs unchanged against
// the baseline.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { parsePayload, planMails } from './authEmailHook';
import type { Plan } from './authEmailHook';

const ROOT = path.resolve(__dirname, '..', '..');
const GOLDEN = path.join(__dirname, 'authEmailHook.golden.json');
const CANONICAL = path.join(__dirname, 'authEmailHook.ts');
const BASELINE = '227436c';
// sha256 of the lines strictly between the BEGIN/END markers of
// `git show 227436c:src/lib/authEmailHook.ts`, joined with "\n".
const BASELINE_227436C_BLOCK_SHA256 = '8a27aa0f7612d4191a4aa1da457d998fbf6e0e5e59860c87ce7cf4e6c8e414ec';
const CAPTURE = process.env.AUTH_EMAIL_HOOK_GOLDEN === 'capture';

type RawPayload = {
  user: { id?: string; email: string; new_email: string };
  email_data: Record<string, string>;
};
type GoldenCase = { name: string; supabaseUrl: string; input: RawPayload };
type GoldenFile = {
  baseline: string;
  baselineBlockSha256: string;
  cases: { name: string; supabaseUrl: string; input: RawPayload; output: Plan }[];
};

const PH_A = `u-${'a'.repeat(32)}@no-email.invalid`;
const PH_B = `u-${'0123456789abcdef'.repeat(2)}@no-email.invalid`;
const REAL = 'manager@example.com';
const REAL_NEW = 'new.manager@example.com';
const KONG = 'http://kong:8000';
const API_SITE = 'https://abc.supabase.co/auth/v1';
const APP_SITE = 'http://127.0.0.1:3000';
const REDIRECT = 'http://localhost:8081/reset-password';
const NOTIFICATIONS = [
  'password_changed_notification',
  'email_changed_notification',
  'phone_changed_notification',
  'identity_linked_notification',
  'identity_unlinked_notification',
  'mfa_factor_enrolled_notification',
  'mfa_factor_unenrolled_notification',
];

function raw(
  action: string,
  over: { user?: Partial<RawPayload['user']>; data?: Record<string, string> } = {},
): RawPayload {
  return {
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
}

function c(name: string, input: RawPayload, supabaseUrl: string = KONG): GoldenCase {
  return { name, supabaseUrl, input };
}

const SECURE_CHANGE = { token: '111111', token_hash: 'hash-for-new', token_new: '222222', token_hash_new: 'hash-for-current' };
const EMPTY_DATA = {
  token: '',
  token_hash: '',
  redirect_to: '',
  site_url: '',
  token_new: '',
  token_hash_new: '',
  old_email: '',
};

const MATRIX: GoldenCase[] = [
  // A. Every spec 166 §3.3 type plus an unknown one, default inputs.
  c('A.recovery', raw('recovery')),
  c('A.signup', raw('signup')),
  c('A.invite', raw('invite')),
  c('A.magiclink', raw('magiclink')),
  c('A.email', raw('email')),
  c('A.reauthentication', raw('reauthentication')),
  ...NOTIFICATIONS.map((n) => c(`A.${n}`, raw(n))),
  c('A.zz_future_type', raw('zz_future_type')),

  // B. email_change.
  c('B.secure_both_real', raw('email_change', { user: { new_email: REAL_NEW }, data: SECURE_CHANGE })),
  c(
    'B.single_pair_token',
    raw('email_change', { user: { new_email: REAL_NEW }, data: { token: '111111', token_hash: 'hash-for-new' } }),
  ),
  c(
    'B.single_pair_token_new',
    raw('email_change', { user: { new_email: REAL_NEW }, data: { token: '', token_hash: 'hash-for-new', token_new: '222222' } }),
  ),
  c('B.placeholder_current_real_new', raw('email_change', { user: { email: PH_A, new_email: REAL_NEW }, data: SECURE_CHANGE })),
  c('B.real_current_placeholder_new', raw('email_change', { user: { email: REAL, new_email: PH_B }, data: SECURE_CHANGE })),
  c('B.both_placeholder', raw('email_change', { user: { email: PH_A, new_email: PH_B }, data: SECURE_CHANGE })),
  c('B.no_new_email', raw('email_change', { user: { new_email: '' }, data: SECURE_CHANGE })),

  // C. Recovery.
  c('C.recovery_redirect_no_query', raw('recovery')),
  c('C.recovery_redirect_with_query', raw('recovery', { data: { redirect_to: 'https://app.example.com/r?x=1' } })),
  c('C.recovery_pkce_hash', raw('recovery', { data: { token_hash: 'pkce_a/b+c=' } })),
  c(
    'C.recovery_javascript_redirect_site_fallback',
    raw('recovery', { data: { redirect_to: 'javascript:alert(1)', site_url: 'https://site.example.com' } }),
  ),
  c(
    'C.recovery_not_a_url_redirect_site_fallback',
    raw('recovery', { data: { redirect_to: 'not a url', site_url: 'https://site.example.com' } }),
  ),
  c('C.recovery_both_unusable', raw('recovery', { data: { redirect_to: '', site_url: '' } })),
  c('C.recovery_native_scheme', raw('recovery', { data: { redirect_to: 'imr://reset-password' } })),

  // D. signup / invite with an empty token_hash → unlinkable.
  c('D.signup_empty_hash', raw('signup', { data: { token_hash: '' } })),
  c('D.invite_empty_hash', raw('invite', { data: { token_hash: '' } })),

  // E. Unlinkable link types.
  c('E.magiclink_redirect_and_site_empty', raw('magiclink', { data: { redirect_to: '', site_url: '' } })),
  c('E.invite_site_and_supabase_url_empty', raw('invite', { data: { site_url: '' } }), ''),

  // F. verifyBase branches.
  c('F.magiclink_api_site', raw('magiclink', { data: { site_url: API_SITE } })),
  c('F.signup_api_site', raw('signup', { data: { site_url: API_SITE } })),
  c('F.magiclink_api_site_trailing_slash', raw('magiclink', { data: { site_url: API_SITE + '/' } })),
  c('F.signup_api_site_trailing_slash', raw('signup', { data: { site_url: API_SITE + '/' } })),
  c('F.magiclink_app_site', raw('magiclink', { data: { site_url: APP_SITE } })),
  c('F.signup_app_site', raw('signup', { data: { site_url: APP_SITE } })),
  c('F.magiclink_app_site_supabase_url_slash', raw('magiclink', { data: { site_url: APP_SITE } }), 'https://abc.supabase.co/'),
  c('F.signup_app_site_supabase_url_slash', raw('signup', { data: { site_url: APP_SITE } }), 'https://abc.supabase.co/'),

  // G. Escaping.
  c(
    'G.email_change_script_new_email',
    raw('email_change', { user: { new_email: '"><script>alert(1)</script>@example.com' }, data: SECURE_CHANGE }),
  ),
  c('G.recovery_script_redirect', raw('recovery', { data: { redirect_to: 'https://x.example.com/"><script>' } })),

  // H. email_changed_notification.
  c('H.email_changed_notification_old_email', raw('email_changed_notification', { data: { old_email: 'old@example.com' } })),
  c('H.email_changed_notification_no_old_email', raw('email_changed_notification', { data: { old_email: '' } })),
  c('H.email_changed_notification_placeholder_old_email', raw('email_changed_notification', { data: { old_email: PH_A } })),

  // I. Other.
  c('I.recovery_all_placeholder', raw('recovery', { user: { email: PH_A } })),
  c('I.recovery_trimmed_recipient', raw('recovery', { user: { email: '  manager@example.com ' } })),
  c('I.reauthentication_empty_token', raw('reauthentication', { data: { token: '' } })),
  c('I.magiclink_empty_hash_with_token', raw('magiclink', { data: { token_hash: '' } })),
  c('I.unknown_type_token_no_hash', raw('zz_future_type', { data: { token_hash: '' } })),
  c(
    'I.zz_preflight_probe_all_empty',
    {
      user: { id: '00000000-0000-0000-0000-000000000000', email: REAL, new_email: '' },
      email_data: { ...EMPTY_DATA, email_action_type: 'zz_preflight_probe' },
    },
  ),
  c('I.recovery_blank_user_email', raw('recovery', { user: { email: '   ' } })),
];

/** Same extraction rule as authEmailHook.parity.test.ts. */
function canonicalBlockSha256(): string {
  const begin = '// BEGIN auth-email-hook-core (spec 166)';
  const end = '// END auth-email-hook-core (spec 166)';
  const lines = fs.readFileSync(CANONICAL, 'utf8').split('\n');
  const b = lines.map((l, i) => (l.trim() === begin ? i : -1)).filter((i) => i >= 0);
  const e = lines.map((l, i) => (l.trim() === end ? i : -1)).filter((i) => i >= 0);
  if (b.length !== 1 || e.length !== 1 || e[0] <= b[0] + 1) throw new Error('canonical core block not found exactly once');
  return crypto.createHash('sha256').update(lines.slice(b[0] + 1, e[0]).join('\n')).digest('hex');
}

function run(gc: GoldenCase): Plan {
  const p = parsePayload(gc.input);
  if (p === null) throw new Error(`${gc.name}: matrix input failed parsePayload`);
  return planMails(p, gc.supabaseUrl);
}

if (CAPTURE) {
  describe('auth-email-hook golden (CAPTURE mode, spec 168 §1G)', () => {
    it('captures the 227436c baseline output', () => {
      if (process.env.CI) throw new Error('golden capture refused: CI is set');
      if (fs.existsSync(GOLDEN)) {
        throw new Error(`golden capture refused: ${path.relative(ROOT, GOLDEN)} exists; delete it deliberately to recapture`);
      }
      const sha = canonicalBlockSha256();
      if (sha !== BASELINE_227436C_BLOCK_SHA256) {
        throw new Error(`golden capture refused: the working-tree core block (${sha}) is not the ${BASELINE} block`);
      }
      const file: GoldenFile = {
        baseline: BASELINE,
        baselineBlockSha256: sha,
        cases: MATRIX.map((gc) => ({ name: gc.name, supabaseUrl: gc.supabaseUrl, input: gc.input, output: run(gc) })),
      };
      fs.writeFileSync(GOLDEN, JSON.stringify(file, null, 2) + '\n', 'utf8');
      throw new Error('golden written — re-run without AUTH_EMAIL_HOOK_GOLDEN to verify');
    });
  });
} else {
  const golden: GoldenFile | null = fs.existsSync(GOLDEN)
    ? (JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as GoldenFile)
    : null;
  const MISSING = `golden fixture ${path.relative(ROOT, GOLDEN)} is missing; it is never written by verify mode — see the capture procedure in this file's header`;

  describe('auth-email-hook golden equivalence (spec 168 §1G)', () => {
    it('the golden fixture exists and was captured from the 227436c block', () => {
      if (golden === null) throw new Error(MISSING);
      expect(golden.baseline).toBe(BASELINE);
      expect(golden.baselineBlockSha256).toBe(BASELINE_227436C_BLOCK_SHA256);
    });

    it('the golden case names equal the matrix names, in order', () => {
      if (golden === null) throw new Error(MISSING);
      expect(golden.cases.map((gc) => gc.name)).toEqual(MATRIX.map((gc) => gc.name));
    });

    it.each(MATRIX.map((gc, i) => [gc.name, i] as const))('%s', (name, i) => {
      if (golden === null) throw new Error(MISSING);
      const gc = MATRIX[i];
      const g = golden.cases[i];
      expect(g).toBeDefined();
      expect(g.name).toBe(name);
      expect(g.input).toStrictEqual(gc.input);
      expect(g.supabaseUrl).toBe(gc.supabaseUrl);
      expect(parsePayload(gc.input)).not.toBeNull();
      expect(run(gc)).toStrictEqual(g.output);
    });
  });
}
