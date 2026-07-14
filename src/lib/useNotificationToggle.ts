// src/lib/useNotificationToggle.ts — shared behavior hook for the per-device
// Web Push toggle.
//
// Spec 118. Both surface components (staff NotificationSwitcher, admin
// NotificationToggle) were duplicating the SAME non-presentational logic —
// the view/busy/message state, the mount + visibilitychange re-probe effect,
// the enable/disable handlers, and the view→copy derivation. That is real
// branching logic, not presentation, so it lives here ONCE and each component
// is genuinely theme + i18n only. The pure reducer + code map stay in
// notificationState.ts; this hook is the impure orchestration around them.
//
// The hook is catalog-agnostic: the caller passes a `translate(key) => string`
// bound to its own catalog (staff `useI18n().t` or admin `useT()`), so the
// returned strings are already localized for the surface.

import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import {
  deriveNotificationState,
  probeNotificationState,
  subscribeCodeToMessageKey,
  type NotificationView,
} from './notificationState';
import { requestPermissionAndSubscribe, unsubscribeFromPush } from './webPush';

export interface NotificationToggleModel {
  view: NotificationView;
  busy: boolean;
  /** true iff the pill press does something (toggles / retries). false while
   *  busy, before the user id hydrates, or for the non-toggle views
   *  (`unsupported`, `needs-install`). */
  interactive: boolean;
  isOn: boolean;
  /** Localized "On"/"Off" text for the pill. */
  stateText: string;
  /** Localized toggle label ("Notifications"). */
  label: string;
  /** Localized body copy for the current view (or a transient post-action
   *  message), or null when there's nothing to say. */
  body: string | null;
  /** Localized iOS "Add to Home Screen" steps line — only non-null on the
   *  `needs-install` view. */
  iosSteps: string | null;
  /** true iff an explicit retry affordance should render (AC (c): retry
   *  offered on `denied` / `error`). */
  showRetry: boolean;
  retryLabel: string;
  /** Localized aria label for the pill. */
  aria: string;
  /** Pill press: toggle on↔off, or retry from a failed/blocked state. */
  onPress: () => void;
  /** Explicit retry affordance handler (same as attempting enable). */
  onRetry: () => void;
}

export function useNotificationToggle(
  userId: string | undefined,
  translate: (key: string) => string,
): NotificationToggleModel {
  const [view, setView] = useState<NotificationView>('off');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // `clearMessage` distinguishes an authoritative re-probe (mount /
  // visibilitychange — clears any stale transient message) from the re-probe
  // fired immediately after an action (which must PRESERVE the message the
  // action just set). Fix for the "stale message lingers across re-probes"
  // review finding.
  const refresh = useCallback(async (clearMessage: boolean) => {
    const input = await probeNotificationState();
    setView(deriveNotificationState(input));
    if (clearMessage) setMessage(null);
  }, []);

  useEffect(() => {
    void refresh(true);
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onVis = () => {
      if (document.visibilityState === 'visible') void refresh(true);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);

  const enable = useCallback(async () => {
    if (!userId) return;
    setBusy(true);
    setMessage(null);
    const res = await requestPermissionAndSubscribe(userId);
    if (!res.ok) {
      setMessage(translate(`chrome.notifications.msg.${subscribeCodeToMessageKey(res.code)}`));
    }
    await refresh(false); // preserve the just-set message
    setBusy(false);
  }, [userId, refresh, translate]);

  const disable = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    await unsubscribeFromPush();
    await refresh(false);
    setBusy(false);
  }, [refresh]);

  const isOn = view === 'on';
  // A missing userId disables the control (fix: silent no-op → visible
  // disabled state until auth hydrates).
  const interactive =
    !busy &&
    !!userId &&
    view !== 'unsupported' &&
    view !== 'needs-install';

  const onPress = useCallback(() => {
    if (!interactive) return;
    if (isOn) void disable();
    else void enable();
  }, [interactive, isOn, disable, enable]);

  const onRetry = useCallback(() => {
    if (busy || !userId) return;
    void enable();
  }, [busy, userId, enable]);

  const viewMessage =
    view === 'needs-install'
      ? translate('chrome.notifications.iosInstall.title')
      : view === 'denied'
        ? translate('chrome.notifications.msg.denied')
        : view === 'unsupported'
          ? translate('chrome.notifications.msg.unsupported')
          : view === 'error'
            ? translate('chrome.notifications.msg.generic')
            : null;

  return {
    view,
    busy,
    interactive,
    isOn,
    stateText: isOn
      ? translate('chrome.notifications.state.on')
      : translate('chrome.notifications.state.off'),
    label: translate('chrome.notifications.label'),
    body: message ?? viewMessage,
    iosSteps:
      view === 'needs-install'
        ? translate('chrome.notifications.iosInstall.steps')
        : null,
    showRetry: (view === 'denied' || view === 'error') && !busy && !!userId,
    retryLabel: translate('chrome.notifications.retry'),
    aria: translate('chrome.notifications.aria'),
    onPress,
    onRetry,
  };
}
