// src/lib/eodPopup.ts — Spec 180 §7.2.
//
// Pure decision module for the admin "EOD count submitted / updated" pop-up.
// No React, no store, no supabase — same posture as storeVisibility.ts — so the
// show / suppress / group rules are unit-testable in the node-env jest project.
//
// The hook (src/hooks/useEodSubmitPopup.ts) owns the ephemeral state (groups,
// seen ids, the toast queue) in refs and feeds it through `decideEodPopup` on
// every realtime notifications INSERT. Nothing here touches the bell feed: the
// pop-up is a display-only layer on top of the spec-120 notification rows.
//
// The recipient filter is a CLIENT-SIDE display filter, not an authorization
// boundary (design §2): RLS already lets a brand admin read every one of these
// rows in the bell.

import type { AdminNotification, SubmissionNotificationType, User } from '../types';

/** The notification types that pop up (AC-6b). Every other type is bell-only. */
export const EOD_POPUP_TYPES: ReadonlySet<SubmissionNotificationType> = new Set<SubmissionNotificationType>([
  'eod',
  'order_ready',
  'eod_update',
]);

/** The custom react-native-toast-message type the pop-up renders with
 *  (registered in App.tsx via `eodPopupToastConfig`). A 2-line title + body
 *  with auto height, so a grouped title's "(N updated)" marker (AC-4) is not
 *  truncated away by the library's fixed 340x60 one-line default. */
export const EOD_POPUP_TOAST_TYPE = 'eodPopup';

/** AC-4 — same-store events within this many ms of the PREVIOUS event in the
 *  group merge into one pop-up (sliding window). */
export const EOD_POPUP_WINDOW_MS = 60_000;

export type PopupViewer = {
  userId: string;
  role: User['role'];
  /** currentUser.stores — the viewer's `user_stores` rows, loaded at login. */
  assignedStoreIds: readonly string[];
  /** The brand ids the notification channels are subscribed to. */
  subscribedBrandIds: readonly string[];
};

export type PopupGroup = {
  storeId: string;
  storeName: string | null;
  brandId: string;
  /** Every notification id in the group, arrival order. */
  ids: string[];
  /** Distinct non-null actor names, arrival order. */
  actorNames: string[];
  /** eod + order_ready rows. */
  submitCount: number;
  /** eod_update rows. */
  updateCount: number;
  /** order_ready rows, for copy + deep link. */
  orderReady: AdminNotification[];
  latest: AdminNotification;
  /** Client receipt time (ms) of the latest event — the sliding-window anchor. */
  lastAt: number;
};

export type PopupSuppressReason =
  | 'type'
  | 'self'
  | 'notAssigned'
  | 'brandOutOfScope'
  | 'role'
  | 'duplicate';

export type PopupDecision =
  | { kind: 'suppress'; reason: PopupSuppressReason }
  | { kind: 'show'; group: PopupGroup }
  | { kind: 'group'; group: PopupGroup };

function suppress(
  reason: PopupSuppressReason,
  groups: Readonly<Record<string, PopupGroup>>,
): { decision: PopupDecision; groups: Record<string, PopupGroup> } {
  return { decision: { kind: 'suppress', reason }, groups: { ...groups } };
}

function isUpdate(n: AdminNotification): boolean {
  return n.type === 'eod_update';
}

function newGroup(n: AdminNotification, nowMs: number): PopupGroup {
  return {
    storeId: n.storeId,
    storeName: n.storeName,
    brandId: n.brandId,
    ids: [n.id],
    actorNames: n.actorName ? [n.actorName] : [],
    submitCount: isUpdate(n) ? 0 : 1,
    updateCount: isUpdate(n) ? 1 : 0,
    orderReady: n.type === 'order_ready' ? [n] : [],
    latest: n,
    lastAt: nowMs,
  };
}

function mergeGroup(g: PopupGroup, n: AdminNotification, nowMs: number): PopupGroup {
  return {
    ...g,
    storeName: n.storeName ?? g.storeName,
    ids: [...g.ids, n.id],
    actorNames:
      n.actorName && !g.actorNames.includes(n.actorName)
        ? [...g.actorNames, n.actorName]
        : g.actorNames,
    submitCount: g.submitCount + (isUpdate(n) ? 0 : 1),
    updateCount: g.updateCount + (isUpdate(n) ? 1 : 0),
    orderReady: n.type === 'order_ready' ? [...g.orderReady, n] : g.orderReady,
    latest: n,
    lastAt: nowMs,
  };
}

/**
 * Decide what one incoming notification does to the pop-up. Rules, in order:
 *   1. duplicate — id already seen (StrictMode double-subscribe, re-subscribe).
 *   2. type (AC-6b) — not an EOD-family type.
 *   3. self (AC-3) — the viewer made the submit / edit.
 *   4. role (AC-2) — super_admin: brand must be subscribed; admin/master: store
 *      must be one of their user_stores rows; anything else: suppressed.
 *   5. grouping (AC-4) — keyed by store; merge when within the sliding 60 s
 *      window of the previous event, else start a fresh group.
 *
 * Pure: returns a NEW groups record; never mutates the inputs. The caller is
 * responsible for adding `n.id` to its seen set.
 */
export function decideEodPopup(
  n: AdminNotification,
  viewer: PopupViewer,
  groups: Readonly<Record<string, PopupGroup>>,
  seenIds: ReadonlySet<string>,
  nowMs: number,
): { decision: PopupDecision; groups: Record<string, PopupGroup> } {
  if (seenIds.has(n.id)) return suppress('duplicate', groups);
  if (!EOD_POPUP_TYPES.has(n.type)) return suppress('type', groups);
  if (n.actorUserId != null && n.actorUserId === viewer.userId) return suppress('self', groups);

  if (viewer.role === 'super_admin') {
    if (!viewer.subscribedBrandIds.includes(n.brandId)) return suppress('brandOutOfScope', groups);
  } else if (viewer.role === 'admin' || viewer.role === 'master') {
    if (!viewer.assignedStoreIds.includes(n.storeId)) return suppress('notAssigned', groups);
  } else {
    return suppress('role', groups);
  }

  const prev = groups[n.storeId];
  if (prev && nowMs - prev.lastAt <= EOD_POPUP_WINDOW_MS) {
    const group = mergeGroup(prev, n, nowMs);
    return { decision: { kind: 'group', group }, groups: { ...groups, [n.storeId]: group } };
  }
  const group = newGroup(n, nowMs);
  return { decision: { kind: 'show', group }, groups: { ...groups, [n.storeId]: group } };
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Toast copy for a group (§7.2). All strings come from `chrome.eodPopup.*`. */
export function eodPopupCopy(g: PopupGroup, tr: Translate): { text1: string; text2: string } {
  const n = g.ids.length;
  const u = g.updateCount;
  const store = g.storeName ?? tr('chrome.eodPopup.unknownStore');

  let text1: string;
  if (n === 1) {
    text1 = tr(`chrome.eodPopup.title.single.${g.latest.type}`, { store });
  } else if (u === 0) {
    text1 = tr('chrome.eodPopup.title.group.submitted', { store, n });
  } else if (u === n) {
    text1 = tr('chrome.eodPopup.title.group.updated', { store, n });
  } else {
    text1 = tr('chrome.eodPopup.title.group.mixed', { store, n, u });
  }

  const actor = g.actorNames[0] ?? tr('chrome.submissionBell.unknownActor');
  let text2: string;
  if (g.actorNames.length > 1) {
    text2 = tr('chrome.eodPopup.body.byMany', { actor, k: g.actorNames.length - 1 });
  } else if (n === 1 && g.latest.body) {
    text2 = tr('chrome.eodPopup.body.vendorBy', { vendor: g.latest.body, actor });
  } else {
    text2 = tr('chrome.eodPopup.body.by', { actor });
  }
  if (n > 1 && g.orderReady.length > 0) {
    text2 += tr('chrome.eodPopup.body.readySuffix', { k: g.orderReady.length });
  }
  return { text1, text2 };
}

/**
 * AC-5 — where tapping the pop-up goes. Identical to the phone bell's
 * `onRowPress`: an `order_ready` row in the group wins (the LATEST one), and
 * carries the Approve Order payload; otherwise the latest row's section.
 */
export function eodPopupTarget(
  g: PopupGroup,
  sectionFor: (t: SubmissionNotificationType) => string | null,
): { section: string | null; orderApproval?: { submissionId: string; storeId: string } } {
  const ready = g.orderReady[g.orderReady.length - 1];
  if (ready) {
    return {
      section: sectionFor('order_ready'),
      orderApproval: { submissionId: ready.sourceId, storeId: ready.storeId },
    };
  }
  return { section: sectionFor(g.latest.type) };
}
