// src/lib/usernameValidation.test.ts — Spec 095 Track 1 jest coverage.
//
// Unit tests for the shared client-side username validator (the TS mirror of
// the DB format CHECK + the reserved-name list). Pure TS → fast node-env
// project.

import {
  validateUsername,
  isValidUsername,
  RESERVED_USERNAMES,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
} from './usernameValidation';

describe('validateUsername — length', () => {
  it('rejects empty / whitespace-only', () => {
    expect(validateUsername('')).toMatchObject({ ok: false });
    expect(validateUsername('   ')).toMatchObject({ ok: false });
  });

  it(`rejects shorter than ${USERNAME_MIN_LENGTH} chars`, () => {
    expect(validateUsername('ab')).toMatchObject({ ok: false });
    expect(validateUsername('a')).toMatchObject({ ok: false });
  });

  it(`rejects longer than ${USERNAME_MAX_LENGTH} chars`, () => {
    expect(validateUsername('a'.repeat(USERNAME_MAX_LENGTH + 1))).toMatchObject({ ok: false });
  });

  it('accepts the boundary lengths (3 and 20)', () => {
    expect(validateUsername('abc')).toEqual({ ok: true });
    expect(validateUsername('a'.repeat(USERNAME_MAX_LENGTH))).toEqual({ ok: true });
  });
});

describe('validateUsername — charset', () => {
  it('accepts letters, numbers, underscore, and dot', () => {
    expect(validateUsername('bob_b.99')).toEqual({ ok: true });
    expect(validateUsername('Bob_B')).toEqual({ ok: true });
    expect(validateUsername('a.b.c')).toEqual({ ok: true });
  });

  it('rejects disallowed characters', () => {
    expect(validateUsername('bob b')).toMatchObject({ ok: false }); // space
    expect(validateUsername('bob-b')).toMatchObject({ ok: false }); // hyphen
    expect(validateUsername('bob@b')).toMatchObject({ ok: false }); // at-sign
    expect(validateUsername('bob+b')).toMatchObject({ ok: false }); // plus
    expect(validateUsername('café_x')).toMatchObject({ ok: false }); // accented
  });
});

describe('validateUsername — reserved names', () => {
  it('rejects every reserved name (case-insensitively)', () => {
    for (const reserved of RESERVED_USERNAMES) {
      // Some reserved entries are < 3 chars (e.g. "me"); pad-test would be
      // wrong — instead assert the literal reserved value is rejected,
      // skipping length-failing ones which already fail for a different
      // reason. Both outcomes are { ok: false }, which is the contract.
      expect(validateUsername(reserved)).toMatchObject({ ok: false });
      expect(validateUsername(reserved.toUpperCase())).toMatchObject({ ok: false });
    }
  });

  it('surfaces the reserved error specifically (not the format error) for a valid-shape reserved name', () => {
    const result = validateUsername('admin');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/reserved/i);
  });

  it('allows a non-reserved name that merely contains a reserved substring', () => {
    expect(validateUsername('administrator9')).toEqual({ ok: true });
    expect(validateUsername('rooter')).toEqual({ ok: true });
  });
});

describe('validateUsername — trimming', () => {
  it('trims surrounding whitespace before validating', () => {
    expect(validateUsername('  bobby  ')).toEqual({ ok: true });
  });
});

describe('isValidUsername', () => {
  it('mirrors validateUsername as a boolean', () => {
    expect(isValidUsername('bobby_b')).toBe(true);
    expect(isValidUsername('admin')).toBe(false);
    expect(isValidUsername('ab')).toBe(false);
  });
});
