// Spec 165 §3.2 / §10 — the placeholder-email predicate.
import { isPlaceholderEmail, PLACEHOLDER_EMAIL_RE } from './placeholderEmail';

const HEX32 = '3f2a9c0d1e2b4a5f8c7d6e5f4a3b2c1d';

describe('isPlaceholderEmail — positive', () => {
  it('matches the generator shape', () => {
    expect(isPlaceholderEmail(`u-${HEX32}@no-email.invalid`)).toBe(true);
  });

  it('matches a freshly generated randomUUID-derived address', () => {
    // Mirrors the server generator: "u-" + randomUUID() without dashes.
    const uuid = '9a39cbe9-f96b-4673-8496-e0dc8d6408dd';
    expect(isPlaceholderEmail(`u-${uuid.replace(/-/g, '')}@no-email.invalid`)).toBe(true);
  });

  it('is case-insensitive (GoTrue may return mixed case)', () => {
    expect(isPlaceholderEmail(`U-${HEX32.toUpperCase()}@No-Email.INVALID`)).toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isPlaceholderEmail(`  u-${HEX32}@no-email.invalid \n`)).toBe(true);
  });
});

describe('isPlaceholderEmail — negative', () => {
  it.each([
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['object', { email: `u-${HEX32}@no-email.invalid` }],
    ['real email', 'marcus@example.com'],
    ['seed local admin', 'admin@local.test'],
    ['seed local manager', 'manager@local.test'],
    ['other local-part on the placeholder domain', 'x@no-email.invalid'],
    ['31 hex', `u-${HEX32.slice(1)}@no-email.invalid`],
    ['33 hex', `u-${HEX32}a@no-email.invalid`],
    ['non-hex char', `u-${HEX32.slice(1)}g@no-email.invalid`],
    ['dashed uuid', 'u-9a39cbe9-f96b-4673-8496-e0dc8d6408dd@no-email.invalid'],
    ['missing u- prefix', `${HEX32}@no-email.invalid`],
    ['other .invalid domain', `u-${HEX32}@example.invalid`],
    ['subdomain of placeholder domain', `u-${HEX32}@x.no-email.invalid`],
    ['placeholder domain on a real TLD', `u-${HEX32}@no-email.com`],
    ['uppercase domain variant that is not the shape', `u-${HEX32}@NO_EMAIL.INVALID`],
    ['trailing garbage', `u-${HEX32}@no-email.invalid.com`],
    ['leading garbage', `xu-${HEX32}@no-email.invalid`],
    ['interior whitespace', `u-${HEX32} @no-email.invalid`],
  ])('rejects %s', (_label, value) => {
    expect(isPlaceholderEmail(value)).toBe(false);
  });
});

describe('PLACEHOLDER_EMAIL_RE', () => {
  it('is anchored and lowercase-only (callers must normalize)', () => {
    expect(PLACEHOLDER_EMAIL_RE.test(`u-${HEX32}@no-email.invalid`)).toBe(true);
    expect(PLACEHOLDER_EMAIL_RE.test(`U-${HEX32}@no-email.invalid`)).toBe(false);
    expect(PLACEHOLDER_EMAIL_RE.source.startsWith('^')).toBe(true);
    expect(PLACEHOLDER_EMAIL_RE.source.endsWith('$')).toBe(true);
  });
});
