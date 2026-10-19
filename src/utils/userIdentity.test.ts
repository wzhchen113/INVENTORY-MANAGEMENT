// src/utils/userIdentity.test.ts — Spec 165 §7 (jest, node env).
//
// Pins the display helpers that keep screens from hand-rolling the
// username-only rule: isUsernameLogin (undefined → email), userConfirmText
// (username accounts never yield an email), and storeUserErrorText (the
// §4.6 error-string → toast-copy mapping shared by the drawer + modal).

import { isUsernameLogin, userConfirmText, storeUserErrorText, userIdentityLine } from './userIdentity';

describe('isUsernameLogin', () => {
  it("is true only for loginKind 'username'", () => {
    expect(isUsernameLogin({ loginKind: 'username' })).toBe(true);
    expect(isUsernameLogin({ loginKind: 'email' })).toBe(false);
  });
  it('treats an undefined loginKind (older fixtures) as email', () => {
    expect(isUsernameLogin({})).toBe(false);
  });
});

describe('userIdentityLine', () => {
  const MARK = 'username sign-in';
  it('username account: @username · marker, never the email', () => {
    expect(userIdentityLine({ loginKind: 'username', username: 'marcus.l', email: 'leak@x.co' }, MARK)).toBe('@marcus.l · username sign-in');
  });
  it('username account without a username: marker only', () => {
    expect(userIdentityLine({ loginKind: 'username', username: null, email: '' }, MARK)).toBe('username sign-in');
  });
  it('honours a custom separator', () => {
    expect(userIdentityLine({ loginKind: 'username', username: 'marcus.l' }, MARK, { separator: ', ' })).toBe('@marcus.l, username sign-in');
  });
  it('email account: the email, else the fallback (default empty)', () => {
    expect(userIdentityLine({ loginKind: 'email', username: 'bob', email: 'bob@x.co' }, MARK)).toBe('bob@x.co');
    expect(userIdentityLine({ loginKind: 'email', email: null }, MARK, { emailFallback: '(no email)' })).toBe('(no email)');
    expect(userIdentityLine({ email: '' }, MARK)).toBe('');
  });
});

describe('userConfirmText', () => {
  it('username account → username, never the email', () => {
    expect(
      userConfirmText({ loginKind: 'username', username: 'marcus.l', name: 'Marcus Lee', email: 'leak@x.co' }),
    ).toBe('marcus.l');
  });
  it('username account without a username → name', () => {
    expect(userConfirmText({ loginKind: 'username', username: null, name: 'Marcus Lee', email: '' })).toBe('Marcus Lee');
  });
  it('email account → email, then name', () => {
    expect(userConfirmText({ loginKind: 'email', username: 'bob', name: 'Bob', email: 'bob@x.co' })).toBe('bob@x.co');
    expect(userConfirmText({ loginKind: 'email', username: 'bob', name: 'Bob', email: '' })).toBe('Bob');
  });
  it("undefined loginKind behaves like 'email' (spec 163 behavior unchanged)", () => {
    expect(userConfirmText({ username: null, name: 'Eve', email: 'eve@x.co' })).toBe('eve@x.co');
  });
  it("returns '' when nothing is available", () => {
    expect(userConfirmText({ loginKind: 'username', username: null, name: '', email: '' })).toBe('');
  });
});

describe('storeUserErrorText', () => {
  it("maps 'username taken' to the named message", () => {
    expect(storeUserErrorText('username taken', 'marcus.l')).toBe('Username "marcus.l" is already taken');
  });
  it("maps 'username taken' without a username to a generic message", () => {
    expect(storeUserErrorText('username taken')).toBe('That username is already taken');
  });
  it('maps every forbidden* string to the permission message', () => {
    for (const e of [
      'forbidden',
      'forbidden: target is in a different brand',
      'forbidden: caller has no brand scope',
      'forbidden: target is not a store user',
    ]) {
      expect(storeUserErrorText(e)).toBe("You don't have permission to manage users in this brand.");
    }
  });
  it('passes any other server string through verbatim', () => {
    expect(storeUserErrorText('stores must belong to one brand')).toBe('stores must belong to one brand');
    expect(storeUserErrorText('password must be at least 8 characters')).toBe('password must be at least 8 characters');
    expect(storeUserErrorText('account has an email; use password reset')).toBe('account has an email; use password reset');
  });
});
