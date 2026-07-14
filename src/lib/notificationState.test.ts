// src/lib/notificationState.test.ts — Spec 118 Track 1 unit test.
//
// Exercises the PURE reducer `deriveNotificationState` across all six
// precedence branches (the jest target per spec §Tests), plus the pure
// `subscribeCodeToMessageKey` map for every SubscribeResult code. The impure
// `probeNotificationState` / `detectIos` collectors are intentionally NOT
// unit-tested here — they read live browser globals; the reducer they feed
// is what carries the branching logic.

import {
  deriveNotificationState,
  subscribeCodeToMessageKey,
  type DeriveInput,
} from './notificationState';

// A fully-capable, granted, subscribed non-iOS baseline. Each test overrides
// only the fields it cares about.
const base: DeriveInput = {
  capable: true,
  permission: 'granted',
  hasSubscription: true,
  isIos: false,
  isStandalone: false,
};

describe('deriveNotificationState — six-branch precedence', () => {
  it('(1) probeError wins over everything', () => {
    expect(
      deriveNotificationState({ ...base, probeError: true }),
    ).toBe('error');
    // Even when other fields would otherwise resolve to needs-install.
    expect(
      deriveNotificationState({
        ...base,
        probeError: true,
        isIos: true,
        isStandalone: false,
        capable: false,
      }),
    ).toBe('error');
  });

  it('(2) iOS Safari tab → needs-install, ahead of unsupported', () => {
    // On an iOS Safari tab PushManager is absent, so capable is false. The
    // needs-install branch MUST beat the unsupported branch.
    expect(
      deriveNotificationState({
        ...base,
        isIos: true,
        isStandalone: false,
        capable: false,
        permission: 'unsupported',
      }),
    ).toBe('needs-install');
  });

  it('(2b) installed iOS PWA does NOT get needs-install (falls through)', () => {
    expect(
      deriveNotificationState({
        ...base,
        isIos: true,
        isStandalone: true,
      }),
    ).toBe('on');
  });

  it('(3) not capable (non-iOS) → unsupported', () => {
    expect(
      deriveNotificationState({
        ...base,
        capable: false,
        permission: 'unsupported',
        hasSubscription: false,
      }),
    ).toBe('unsupported');
  });

  it('(4) permission denied → denied', () => {
    expect(
      deriveNotificationState({ ...base, permission: 'denied', hasSubscription: false }),
    ).toBe('denied');
  });

  it('(5) granted + subscription → on', () => {
    expect(deriveNotificationState(base)).toBe('on');
  });

  it('(6) granted but no subscription → off', () => {
    expect(
      deriveNotificationState({ ...base, hasSubscription: false }),
    ).toBe('off');
  });

  it('(6) permission default → off', () => {
    expect(
      deriveNotificationState({ ...base, permission: 'default', hasSubscription: false }),
    ).toBe('off');
  });
});

describe('subscribeCodeToMessageKey', () => {
  it('maps each SubscribeResult code to its message suffix', () => {
    expect(subscribeCodeToMessageKey('unsupported')).toBe('unsupported');
    expect(subscribeCodeToMessageKey('no-vapid')).toBe('misconfigured');
    expect(subscribeCodeToMessageKey('permission-denied')).toBe('denied');
    expect(subscribeCodeToMessageKey('permission-default')).toBe('dismissed');
    expect(subscribeCodeToMessageKey('no-user')).toBe('generic');
    expect(subscribeCodeToMessageKey('sw-register-failed')).toBe('generic');
    expect(subscribeCodeToMessageKey('subscribe-failed')).toBe('generic');
    expect(subscribeCodeToMessageKey('subscription-incomplete')).toBe('generic');
    expect(subscribeCodeToMessageKey('save-failed')).toBe('generic');
  });
});
