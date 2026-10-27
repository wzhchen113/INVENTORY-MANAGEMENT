// src/hooks/useEodSubmitPopup.ts — Spec 180 §7.3.
//
// The admin "EOD count submitted / updated" pop-up. Composed INSIDE
// useSubmissionNotifications so it rides that hook's existing per-brand
// `notifications-{brandId}` channels (no second set of subscriptions): the
// channel's INSERT handler calls `onInsert(payload.new)`.
//
// AC-6 is structural: the pop-up is reachable ONLY from the realtime INSERT
// handler. `loadSubmissionNotifications` (initial load, brand switch,
// re-subscribe) never calls in here, and realtime does not replay events from
// before the channel subscribed.
//
// State (groups, seen ids, the display queue, the visible group) is ephemeral
// UI state and lives in refs — deliberately NOT in Zustand.
//
// react-native-toast-message has ONE slot and `Toast.show` replaces whatever is
// on screen without firing the old toast's onHide. So to keep different stores
// as separate pop-ups (AC-4) we queue them: a merge into the visible group
// re-shows in place, another store queues until the visible toast hides. A
// fallback timer frees the slot if a foreign toast (notifyBackendError) replaced
// ours and our onHide therefore never fires.

import { useCallback, useEffect, useRef } from 'react';
import Toast from 'react-native-toast-message';
import { useStore } from '../store/useStore';
import { mapNotificationRow } from '../lib/db';
import { t } from '../i18n';
import { useIsPhone } from '../theme/breakpoints';
import { usePaletteAction } from '../lib/paletteAction';
import { sectionForNotification } from '../screens/cmd/sections/phone/PhoneNotifications';
import {
  EOD_POPUP_TOAST_TYPE,
  decideEodPopup,
  eodPopupCopy,
  eodPopupTarget,
  type PopupGroup,
  type PopupViewer,
} from '../lib/eodPopup';

/** How long one pop-up stays up (each re-show restarts the library timer). */
export const EOD_POPUP_VISIBILITY_MS = 8000;
/** Grace past the visibility time before the fallback timer frees the slot. */
const SLOT_FALLBACK_SLACK_MS = 1000;
/** Bound on the seen-id set; a busy night is dozens of rows, not thousands. */
const SEEN_CAP = 500;

export function useEodSubmitPopup(brandKey: string): { onInsert: (raw: unknown) => void } {
  const isPhone = useIsPhone();
  const isPhoneRef = useRef(isPhone);
  isPhoneRef.current = isPhone;
  const brandKeyRef = useRef(brandKey);
  brandKeyRef.current = brandKey;

  const groupsRef = useRef<Record<string, PopupGroup>>({});
  const seenRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<string[]>([]);
  const visibleKeyRef = useRef<string | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearFallback = () => {
    if (fallbackTimerRef.current != null) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  };

  // Indirection so present/onHide/onPress can reference each other while the
  // exported `onInsert` stays referentially stable.
  const presentRef = useRef<(key: string) => void>(() => {});

  const showNext = () => {
    clearFallback();
    visibleKeyRef.current = null;
    while (queueRef.current.length > 0) {
      const next = queueRef.current.shift() as string;
      if (groupsRef.current[next]) {
        presentRef.current(next);
        return;
      }
    }
  };

  const onPress = (key: string) => {
    const g = groupsRef.current[key];
    if (g) {
      useStore.getState().markSubmissionNotificationsRead(g.ids);
      // Desktop/tablet bell rows only mark read (NotificationBell), so the
      // pop-up does the same there; the phone bell deep-links.
      if (isPhoneRef.current) {
        const target = eodPopupTarget(g, sectionForNotification);
        if (target.section) {
          usePaletteAction.getState().request({
            section: target.section,
            selectedName: null,
            ...(target.orderApproval ? { orderApproval: target.orderApproval } : {}),
          });
        }
      }
    }
    Toast.hide();
  };

  presentRef.current = (key: string) => {
    const g = groupsRef.current[key];
    if (!g) return;
    const locale = useStore.getState().locale;
    const { text1, text2 } = eodPopupCopy(g, (k, vars) => t(locale, k, vars));
    visibleKeyRef.current = key;
    clearFallback();
    fallbackTimerRef.current = setTimeout(() => {
      fallbackTimerRef.current = null;
      if (visibleKeyRef.current === key) showNext();
    }, EOD_POPUP_VISIBILITY_MS + SLOT_FALLBACK_SLACK_MS);
    Toast.show({
      // Spec 180 — the 2-line, auto-height type registered in App.tsx (the
      // default `info` truncated the grouped "(N updated)" marker).
      type: EOD_POPUP_TOAST_TYPE,
      text1,
      text2,
      visibilityTime: EOD_POPUP_VISIBILITY_MS,
      onPress: () => onPress(key),
      onHide: () => {
        if (visibleKeyRef.current === key) showNext();
      },
    });
  };

  // A super_admin brand switch must not merge into stale groups (§7.3). Also
  // free the slot: a toast still on screen from the old scope has no group to
  // act on any more, so the next event must be able to replace it rather than
  // queue behind it.
  useEffect(() => {
    groupsRef.current = {};
    queueRef.current = [];
    visibleKeyRef.current = null;
    clearFallback();
  }, [brandKey]);

  useEffect(() => () => clearFallback(), []);

  const onInsert = useCallback((raw: unknown) => {
    if (!raw) return;
    const n = mapNotificationRow(raw);
    if (!n.id) return;
    const s = useStore.getState();
    const user = s.currentUser;
    if (!user) return;
    const viewer: PopupViewer = {
      userId: user.id,
      role: user.role,
      assignedStoreIds: user.stores ?? [],
      subscribedBrandIds: brandKeyRef.current ? brandKeyRef.current.split(',') : [],
    };
    const { decision, groups } = decideEodPopup(
      n,
      viewer,
      groupsRef.current,
      seenRef.current,
      Date.now(),
    );
    seenRef.current.add(n.id);
    if (seenRef.current.size > SEEN_CAP) {
      const oldest = seenRef.current.values().next().value;
      if (oldest !== undefined) seenRef.current.delete(oldest);
    }
    groupsRef.current = groups;
    if (decision.kind === 'suppress') return;

    const key = decision.group.storeId;
    if (visibleKeyRef.current === key || visibleKeyRef.current === null) {
      // Same group on screen → replace in place with the new count; empty
      // slot → show now.
      presentRef.current(key);
    } else if (!queueRef.current.includes(key)) {
      // Another store is on screen → wait its turn. A later merge just
      // updates groupsRef, which the queued key reads when it surfaces.
      queueRef.current.push(key);
    }
  }, []);

  return { onInsert };
}
