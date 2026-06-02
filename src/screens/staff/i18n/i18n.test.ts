// src/i18n/i18n.test.ts — key-existence + interpolation tests.

import { t, _resetWarnCache } from './index';

describe('i18n.t()', () => {
  beforeEach(() => {
    _resetWarnCache();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the English string for a known key', () => {
    expect(t('eod.submit')).toBe('Submit');
  });

  it('substitutes {var} placeholders', () => {
    expect(t('store.picker.subtitle', { count: 3 })).toBe('You have access to 3 stores');
  });

  it('leaves the literal {var} when no matching var is provided', () => {
    expect(t('store.picker.subtitle')).toBe('You have access to {count} stores');
  });

  it('returns the raw key + warns once for a missing key', () => {
    const warnSpy = jest.spyOn(console, 'warn');
    expect(t('does.not.exist')).toBe('does.not.exist');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(t('does.not.exist')).toBe('does.not.exist');
    // Still 1 call — _warned dedupes.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('handles every key referenced in the queue UX', () => {
    const requiredKeys = [
      'auth.signIn.title',
      'auth.signIn.subtitle',
      'auth.signIn.email',
      'auth.signIn.password',
      'auth.signIn.submit',
      'auth.signIn.submitting',
      'auth.error.invalidCreds',
      'auth.error.notStaff',
      'auth.error.noStores',
      'auth.error.generic',
      'store.picker.title',
      'store.picker.subtitle',
      'eod.header.today',
      'eod.vendor.label',
      'eod.col.cases',
      'eod.col.units',
      'eod.col.casesAria',
      'eod.col.unitsAria',
      'eod.row.caseOf',
      'eod.row.total',
      'eod.submit',
      'eod.submitting',
      'eod.banner.lastSubmitted',
      'eod.banner.alreadySubmitted',
      'eod.toast.submitted',
      'eod.toast.alreadySubmitted',
      'eod.toast.failed',
      'eod.toast.noCountsEntered',
      'eod.toast.queued',
      'eod.toast.allSynced',
      'eod.error.forbidden',
      'chrome.queue.pending',
      'chrome.queue.draining',
      'chrome.queue.needsAttention',
      'chrome.queue.syncErrorBanner',
      'chrome.switchStore',
      'chrome.signOut.label',
      'chrome.signOut.confirmTitle',
      'chrome.signOut.confirmMessage',
      'chrome.signedOut',
      'chrome.errorBoundary.title',
      'chrome.errorBoundary.message',
    ];
    const warnSpy = jest.spyOn(console, 'warn');
    for (const k of requiredKeys) {
      const v = t(k);
      // For each key, value should NOT equal the key itself (missing).
      // The exception is keys that may legitimately contain dots in their
      // value — but none of ours do. If a key is missing, console.warn
      // would have fired; check that no warnings happened.
      expect(v).not.toBe(k);
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
