// src/lib/recoveryUrl.test.ts — Spec 085 Track 1 (jest, unit project).
//
// Table-driven coverage of the pure recovery-URL parser. No supabase / React /
// expo-linking mock is needed because recoveryUrl.ts imports nothing — it is a
// dependency-free string parser (spec 085 §3, criteria test #1).

import {
  parseRecoveryFromWebLocation,
  parseRecoveryFromUrl,
  type RecoveryParse,
} from './recoveryUrl';

describe('parseRecoveryFromWebLocation', () => {
  it('parses the CHOSEN token_hash flow (?token_hash=..&type=recovery)', () => {
    const r = parseRecoveryFromWebLocation('?token_hash=hash-xyz&type=recovery', '');
    expect(r).toEqual<RecoveryParse>({ kind: 'recovery-token-hash', tokenHash: 'hash-xyz' });
  });

  it('does NOT treat token_hash of a non-recovery type as recovery', () => {
    const r = parseRecoveryFromWebLocation('?token_hash=hash-xyz&type=signup', '');
    expect(r).toEqual<RecoveryParse>({ kind: 'none' });
  });

  it('token_hash wins over a defensive ?code= when both are present', () => {
    const r = parseRecoveryFromWebLocation(
      '?token_hash=hash-xyz&type=recovery&code=abc123',
      '',
    );
    expect(r).toEqual<RecoveryParse>({ kind: 'recovery-token-hash', tokenHash: 'hash-xyz' });
  });

  it('parses a defensive PKCE ?code= query as a recovery (fallback)', () => {
    const r = parseRecoveryFromWebLocation('?code=abc123', '');
    expect(r).toEqual<RecoveryParse>({ kind: 'recovery', code: 'abc123' });
  });

  it('parses an otp_expired error fragment as an error', () => {
    const r = parseRecoveryFromWebLocation(
      '',
      '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
    );
    expect(r).toEqual<RecoveryParse>({
      kind: 'error',
      code: 'otp_expired',
      description: 'Email link is invalid or has expired',
    });
  });

  it('parses an error carried in the QUERY (PKCE error shape) as an error', () => {
    const r = parseRecoveryFromWebLocation(
      '?error=access_denied&error_code=otp_expired',
      '',
    );
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.code).toBe('otp_expired');
  });

  it('returns none when there are no recovery params', () => {
    expect(parseRecoveryFromWebLocation('', '')).toEqual<RecoveryParse>({ kind: 'none' });
    expect(parseRecoveryFromWebLocation('?foo=bar', '#baz=qux')).toEqual<RecoveryParse>({
      kind: 'none',
    });
  });

  it('error wins over a code when both are present', () => {
    const r = parseRecoveryFromWebLocation(
      '?code=abc123',
      '#error_code=otp_expired',
    );
    expect(r.kind).toBe('error');
  });

  it('error wins over token_hash when both are present', () => {
    const r = parseRecoveryFromWebLocation(
      '?token_hash=hash-xyz&type=recovery',
      '#error_code=otp_expired',
    );
    expect(r.kind).toBe('error');
  });

  it('parses a defensive implicit #access_token&type=recovery fragment', () => {
    const r = parseRecoveryFromWebLocation(
      '',
      '#access_token=tok-xyz&type=recovery&expires_in=3600',
    );
    expect(r).toEqual<RecoveryParse>({ kind: 'recovery-implicit', accessToken: 'tok-xyz' });
  });

  it('does NOT treat an access_token of a non-recovery type as recovery', () => {
    const r = parseRecoveryFromWebLocation('', '#access_token=tok-xyz&type=signup');
    expect(r).toEqual<RecoveryParse>({ kind: 'none' });
  });

  it('tolerates search/hash passed without the leading ?/#', () => {
    expect(parseRecoveryFromWebLocation('code=abc123', '')).toEqual<RecoveryParse>({
      kind: 'recovery',
      code: 'abc123',
    });
  });
});

describe('parseRecoveryFromUrl (native deep link)', () => {
  it('parses a scheme URL with the token_hash flow as recovery-token-hash', () => {
    const r = parseRecoveryFromUrl(
      'imrinventory://reset-password?token_hash=hash-xyz&type=recovery',
    );
    expect(r).toEqual<RecoveryParse>({ kind: 'recovery-token-hash', tokenHash: 'hash-xyz' });
  });

  it('parses a scheme URL with a ?code= query as a (fallback) recovery', () => {
    const r = parseRecoveryFromUrl('imrinventory://reset-password?code=abc123');
    expect(r).toEqual<RecoveryParse>({ kind: 'recovery', code: 'abc123' });
  });

  it('parses a scheme URL with an error fragment as an error', () => {
    const r = parseRecoveryFromUrl(
      'imrinventory://reset-password#error=access_denied&error_code=otp_expired',
    );
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.code).toBe('otp_expired');
  });

  it('returns none for a non-recovery deep link', () => {
    expect(parseRecoveryFromUrl('imrinventory://some/other/path')).toEqual<RecoveryParse>({
      kind: 'none',
    });
  });

  it('returns none for an empty url', () => {
    expect(parseRecoveryFromUrl('')).toEqual<RecoveryParse>({ kind: 'none' });
  });

  it('error wins over code in a deep link carrying both', () => {
    const r = parseRecoveryFromUrl(
      'imrinventory://reset-password?code=abc123#error_code=otp_expired',
    );
    expect(r.kind).toBe('error');
  });
});
