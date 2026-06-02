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
      // Spec 089 — staff Reorder screen + tab labels.
      'reorder.title',
      'reorder.tabLabel',
      'reorder.refresh',
      'reorder.loading',
      'reorder.loadingBody',
      'reorder.kpi.vendors',
      'reorder.kpi.vendorsSub',
      'reorder.kpi.items',
      'reorder.kpi.itemsSub',
      'reorder.kpi.estTotal',
      'reorder.kpi.estTotalSub',
      'reorder.kpi.source',
      'reorder.kpi.sourceValue',
      'reorder.kpi.sourceSub',
      'reorder.source.stockFallback',
      'reorder.delivery.today',
      'reorder.delivery.tomorrow',
      'reorder.delivery.inDays',
      'reorder.vendor.unnamed',
      'reorder.vendor.nextDelivery',
      'reorder.vendor.subtotal',
      'reorder.item.breakdown',
      'reorder.item.order',
      'reorder.export.label',
      'reorder.export.csv',
      'reorder.export.text',
      'reorder.export.pdf',
      'reorder.export.csvAria',
      'reorder.export.textAria',
      'reorder.export.pdfAria',
      'reorder.empty.title',
      'reorder.empty.body',
      'reorder.nothingToday.title',
      'reorder.nothingToday.body',
      'reorder.error.title',
      'reorder.error.generic',
      'reorder.error.retry',
      'reorder.noSchedule.title',
      'reorder.noSchedule.hint',
      // Spec 091 B1 — exhaustive: weekdayLabel() in Reorder.tsx can emit any
      // of the 7 `reorder.weekday.*` keys, so the parity gate covers all 7
      // (was only monday + sunday).
      'reorder.weekday.sunday',
      'reorder.weekday.monday',
      'reorder.weekday.tuesday',
      'reorder.weekday.wednesday',
      'reorder.weekday.thursday',
      'reorder.weekday.friday',
      'reorder.weekday.saturday',
      'eodTab.label',
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
