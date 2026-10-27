// src/lib/eodPopup.test.ts — Spec 180 AC-13.
//
// Table-driven over the pure pop-up decision (`decideEodPopup`), the copy
// builder (`eodPopupCopy`) and the deep-link target (`eodPopupTarget`). Covers
// AC-2 (recipient filter), AC-3 (self), AC-4 (sliding 60 s per-store grouping),
// AC-6b (EOD types only), the duplicate guard, and the update marker.

import {
  decideEodPopup,
  eodPopupCopy,
  eodPopupTarget,
  EOD_POPUP_TYPES,
  EOD_POPUP_WINDOW_MS,
  type PopupGroup,
  type PopupViewer,
} from './eodPopup';
import { t } from '../i18n';
import type { AdminNotification, SubmissionNotificationType } from '../types';

const BRAND = 'brand-a';
const STORE = 'store-towson';
const STORE2 = 'store-frederick';

let seq = 0;
function notif(over: Partial<AdminNotification> = {}): AdminNotification {
  seq += 1;
  return {
    id: `n-${seq}`,
    brandId: BRAND,
    storeId: STORE,
    actorUserId: 'staff-1',
    actorName: 'Cook',
    storeName: 'Towson',
    type: 'eod',
    sourceId: `sub-${seq}`,
    createdAt: '2026-10-26T22:00:00.000Z',
    read: false,
    ...over,
  };
}

function viewer(over: Partial<PopupViewer> = {}): PopupViewer {
  return {
    userId: 'admin-1',
    role: 'admin',
    assignedStoreIds: [STORE, STORE2],
    subscribedBrandIds: [BRAND],
    ...over,
  };
}

const NONE: Record<string, PopupGroup> = {};
const EMPTY_SEEN: ReadonlySet<string> = new Set();
const en = (key: string, vars?: Record<string, string | number>) => t('en', key, vars);

/** Feed a sequence of (notification, atMs) through the decision, threading
 *  groups + seen ids the way the hook does. */
function run(events: Array<[AdminNotification, number]>, v: PopupViewer = viewer()) {
  let groups: Record<string, PopupGroup> = {};
  const seen = new Set<string>();
  const decisions = events.map(([n, at]) => {
    const r = decideEodPopup(n, v, groups, seen, at);
    seen.add(n.id);
    groups = r.groups;
    return r.decision;
  });
  return { decisions, groups };
}

describe('decideEodPopup — recipient filter (AC-2)', () => {
  it('admin with the store assigned → show', () => {
    const { decision } = decideEodPopup(notif(), viewer(), NONE, EMPTY_SEEN, 0);
    expect(decision.kind).toBe('show');
  });

  it('admin without the store assigned → notAssigned', () => {
    const { decision } = decideEodPopup(
      notif({ storeId: 'other-store' }), viewer(), NONE, EMPTY_SEEN, 0,
    );
    expect(decision).toEqual({ kind: 'suppress', reason: 'notAssigned' });
  });

  it('admin with ZERO user_stores rows → never pops up', () => {
    const { decision } = decideEodPopup(
      notif(), viewer({ assignedStoreIds: [] }), NONE, EMPTY_SEEN, 0,
    );
    expect(decision).toEqual({ kind: 'suppress', reason: 'notAssigned' });
  });

  it('master is filtered by user_stores exactly like admin (not by brand)', () => {
    const master = viewer({ role: 'master', assignedStoreIds: [STORE2], subscribedBrandIds: [BRAND] });
    expect(decideEodPopup(notif(), master, NONE, EMPTY_SEEN, 0).decision)
      .toEqual({ kind: 'suppress', reason: 'notAssigned' });
    expect(decideEodPopup(notif({ storeId: STORE2 }), master, NONE, EMPTY_SEEN, 0).decision.kind)
      .toBe('show');
  });

  it('super_admin: every store of a subscribed brand, regardless of user_stores', () => {
    const sa = viewer({ role: 'super_admin', assignedStoreIds: [] });
    expect(decideEodPopup(notif({ storeId: 'any-store' }), sa, NONE, EMPTY_SEEN, 0).decision.kind)
      .toBe('show');
  });

  it('super_admin: brand not subscribed → brandOutOfScope', () => {
    const sa = viewer({ role: 'super_admin', subscribedBrandIds: ['brand-b'] });
    expect(decideEodPopup(notif(), sa, NONE, EMPTY_SEEN, 0).decision)
      .toEqual({ kind: 'suppress', reason: 'brandOutOfScope' });
  });

  it('a plain user role → role', () => {
    expect(decideEodPopup(notif(), viewer({ role: 'user' }), NONE, EMPTY_SEEN, 0).decision)
      .toEqual({ kind: 'suppress', reason: 'role' });
  });
});

describe('decideEodPopup — self, type, duplicate', () => {
  it('AC-3: the viewer\'s own submit / edit never pops up', () => {
    for (const type of ['eod', 'order_ready', 'eod_update'] as const) {
      const { decision } = decideEodPopup(
        notif({ type, actorUserId: 'admin-1' }), viewer(), NONE, EMPTY_SEEN, 0,
      );
      expect(decision).toEqual({ kind: 'suppress', reason: 'self' });
    }
  });

  it('AC-6b: only eod / order_ready / eod_update pop up', () => {
    expect([...EOD_POPUP_TYPES].sort()).toEqual(['eod', 'eod_update', 'order_ready']);
  });

  const NON_EOD: SubmissionNotificationType[] = [
    'weekly', 'waste', 'receiving', 'po', 'missed_eod', 'issue', 'order_failed',
  ];
  it.each(NON_EOD)('AC-6b: %s is suppressed by type', (type) => {
    const { decision } = decideEodPopup(notif({ type }), viewer(), NONE, EMPTY_SEEN, 0);
    expect(decision).toEqual({ kind: 'suppress', reason: 'type' });
  });

  it('a duplicate id (re-subscribe / StrictMode) is suppressed', () => {
    const n = notif();
    const { decision } = decideEodPopup(n, viewer(), NONE, new Set([n.id]), 0);
    expect(decision).toEqual({ kind: 'suppress', reason: 'duplicate' });
  });

  it('a suppression leaves the groups untouched', () => {
    const first = decideEodPopup(notif(), viewer(), NONE, EMPTY_SEEN, 0);
    const r = decideEodPopup(notif({ type: 'waste' }), viewer(), first.groups, EMPTY_SEEN, 10);
    expect(r.groups).toEqual(first.groups);
  });

  it('is pure — never mutates the incoming groups record', () => {
    const groups = Object.freeze({}) as Record<string, PopupGroup>;
    expect(() => decideEodPopup(notif(), viewer(), groups, EMPTY_SEEN, 0)).not.toThrow();
    expect(Object.keys(groups)).toHaveLength(0);
  });
});

describe('decideEodPopup — grouping (AC-4)', () => {
  it('same store at +59 s → group', () => {
    const { decisions } = run([[notif(), 0], [notif(), 59_000]]);
    expect(decisions.map((d) => d.kind)).toEqual(['show', 'group']);
  });

  it('same store at +61 s → a fresh show', () => {
    const { decisions, groups } = run([[notif(), 0], [notif(), 61_000]]);
    expect(decisions.map((d) => d.kind)).toEqual(['show', 'show']);
    expect(groups[STORE].ids).toHaveLength(1);
  });

  it('the window slides: 0, 50, 100 s collapse into one group', () => {
    expect(EOD_POPUP_WINDOW_MS).toBe(60_000);
    const { decisions, groups } = run([[notif(), 0], [notif(), 50_000], [notif(), 100_000]]);
    expect(decisions.map((d) => d.kind)).toEqual(['show', 'group', 'group']);
    expect(groups[STORE].ids).toHaveLength(3);
  });

  it('two stores → two independent shows', () => {
    const { decisions, groups } = run([[notif(), 0], [notif({ storeId: STORE2, storeName: 'Frederick' }), 1000]]);
    expect(decisions.map((d) => d.kind)).toEqual(['show', 'show']);
    expect(Object.keys(groups).sort()).toEqual([STORE2, STORE].sort());
  });

  it('a group tracks counts, distinct actors, order_ready rows and the latest row', () => {
    const a = notif({ type: 'eod', actorName: 'Cook' });
    const b = notif({ type: 'order_ready', actorName: 'Cook' });
    const c = notif({ type: 'eod_update', actorName: 'Manager' });
    const { groups } = run([[a, 0], [b, 10], [c, 20]]);
    const g = groups[STORE];
    expect(g.ids).toEqual([a.id, b.id, c.id]);
    expect(g.submitCount).toBe(2);
    expect(g.updateCount).toBe(1);
    expect(g.actorNames).toEqual(['Cook', 'Manager']);
    expect(g.orderReady).toEqual([b]);
    expect(g.latest).toBe(c);
    expect(g.lastAt).toBe(20);
  });
});

describe('eodPopupCopy', () => {
  function groupOf(events: AdminNotification[]): PopupGroup {
    return run(events.map((n, i) => [n, i * 1000] as [AdminNotification, number])).groups[events[0].storeId];
  }

  it('single eod → "EOD count submitted" with vendor · actor when body is set', () => {
    const copy = eodPopupCopy(groupOf([notif({ body: 'Sysco' })]), en);
    expect(copy).toEqual({ text1: 'Towson: EOD count submitted', text2: 'Sysco · by Cook' });
  });

  it('single eod without a vendor body → "by <actor>"', () => {
    expect(eodPopupCopy(groupOf([notif()]), en).text2).toBe('by Cook');
  });

  it('single order_ready reuses the existing "Order ready to approve" wording', () => {
    const copy = eodPopupCopy(groupOf([notif({ type: 'order_ready', body: 'BJs' })]), en);
    expect(copy.text1).toBe(`Towson: ${t('en', 'chrome.submissionBell.type.order_ready')}`);
    expect(copy.text2).toBe('BJs · by Cook');
  });

  it('single eod_update is marked as an update', () => {
    const copy = eodPopupCopy(groupOf([notif({ type: 'eod_update', actorName: 'Manager' })]), en);
    expect(copy.text1).toBe('Towson: EOD count updated');
    expect(copy.text2).toBe('by Manager');
  });

  it('all-submits group → title.group.submitted', () => {
    expect(eodPopupCopy(groupOf([notif(), notif(), notif(), notif()]), en).text1)
      .toBe('Towson: 4 vendor counts submitted');
  });

  it('all-updates group → title.group.updated', () => {
    expect(eodPopupCopy(groupOf([notif({ type: 'eod_update' }), notif({ type: 'eod_update' })]), en).text1)
      .toBe('Towson: 2 vendor counts updated');
  });

  it('mixed group still says it contains updates → title.group.mixed', () => {
    const g = groupOf([notif(), notif({ type: 'eod_update' }), notif()]);
    expect(eodPopupCopy(g, en).text1).toBe('Towson: 3 vendor counts submitted (1 updated)');
  });

  it('multi-actor → body.byMany', () => {
    const g = groupOf([notif({ actorName: 'Cook' }), notif({ actorName: 'Prep' }), notif({ actorName: 'Lead' })]);
    expect(eodPopupCopy(g, en).text2).toBe('by Cook and 2 more');
  });

  it('a group with order_ready rows appends the ready suffix', () => {
    const g = groupOf([notif({ type: 'order_ready' }), notif(), notif({ type: 'order_ready' })]);
    expect(eodPopupCopy(g, en).text2).toBe('by Cook · 2 ready to approve');
  });

  it('null actor / null store fall back to the catalog strings', () => {
    const g = groupOf([notif({ actorName: null, storeName: null })]);
    expect(eodPopupCopy(g, en)).toEqual({ text1: 'A store: EOD count submitted', text2: 'by Someone' });
  });

  // Release-proposal M-5 — es used "({u} actualizados)", which read
  // "(1 actualizados)" for a single update. The es wording is now number-
  // agnostic ("actualizados: {u}", "listos para aprobar: {k}").
  it('es mixed title and ready suffix agree for a count of 1', () => {
    const g = groupOf([notif({ type: 'order_ready' }), notif({ type: 'eod_update' }), notif()]);
    const copy = eodPopupCopy(g, (k, v) => t('es', k, v));
    expect(copy.text1).toBe('Towson: 3 conteos por proveedor enviados (actualizados: 1)');
    expect(copy.text2).toBe('por Cook · listos para aprobar: 1');
    expect(copy.text1).not.toMatch(/1 actualizados/);
  });

  it('zh-CN mixed title keeps the update marker', () => {
    const g = groupOf([notif(), notif({ type: 'eod_update' })]);
    expect(eodPopupCopy(g, (k, v) => t('zh-CN', k, v)).text1)
      .toBe('Towson：已提交 2 个供应商盘点（其中 1 个为更新）');
  });

  it('every copy key resolves in es and zh-CN (no raw keys leak)', () => {
    const g = groupOf([notif(), notif({ type: 'eod_update', actorName: 'X' }), notif({ type: 'order_ready' })]);
    for (const loc of ['es', 'zh-CN'] as const) {
      const copy = eodPopupCopy(g, (k, v) => t(loc, k, v));
      expect(copy.text1).not.toMatch(/chrome\.|\{/);
      expect(copy.text2).not.toMatch(/chrome\.|\{/);
    }
  });
});

describe('eodPopupTarget (AC-5)', () => {
  const sectionFor = (type: SubmissionNotificationType) =>
    type === 'order_ready' ? 'Ordering' : type === 'eod' || type === 'eod_update' ? 'EODCount' : null;

  it('a group with order_ready rows targets the LATEST one with an orderApproval payload', () => {
    const r1 = notif({ type: 'order_ready', sourceId: 'sub-old' });
    const r2 = notif({ type: 'order_ready', sourceId: 'sub-new' });
    const g = run([[r1, 0], [r2, 1], [notif({ type: 'eod_update' }), 2]]).groups[STORE];
    expect(eodPopupTarget(g, sectionFor)).toEqual({
      section: 'Ordering',
      orderApproval: { submissionId: 'sub-new', storeId: STORE },
    });
  });

  it('otherwise the latest row\'s section, no orderApproval', () => {
    const g = run([[notif(), 0], [notif({ type: 'eod_update' }), 1]]).groups[STORE];
    expect(eodPopupTarget(g, sectionFor)).toEqual({ section: 'EODCount' });
  });
});
