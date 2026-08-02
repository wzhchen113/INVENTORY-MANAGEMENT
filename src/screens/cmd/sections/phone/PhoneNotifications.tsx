// src/screens/cmd/sections/phone/PhoneNotifications.tsx — Spec 148.
//
// Phone-tier notifications surface (README §20). The phone top-app-bar bell (◔)
// opens a ResponsiveSheet (phone bottom-sheet) listing the submission feed:
// header MARK ALL READ + ✕; rows with an unread dot (danger = missed_eod,
// accent = every other type), title + meta + relative time; footer PUSH
// NOTIFICATIONS toggle. Tapping a row marks it read AND deep-links to the
// owning section (missed/eod → EOD count, weekly → weekly count, waste →
// Waste log, po/receiving → Ordering) via the usePaletteAction bridge.
//
// The bell BADGE follows the spec-121 rule verbatim: the count chip is danger
// red ONLY while an unread missed-count alert exists, else the neutral accent.
// The color derivation reuses the pure helpers already exported from
// NotificationBell so the two bells stay byte-identical — no forked scheme.
//
// Feed data + the mark-read actions are read directly from the store (the same
// slice NotificationBell reads); the PUSH toggle reuses the shared
// useNotificationToggle enable/disable logic verbatim. Frontend-only; no db.ts
// contract change.

import React from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useStore } from '../../../../store/useStore';
import { useT } from '../../../../hooks/useT';
import { useNotificationToggle } from '../../../../lib/useNotificationToggle';
import { usePaletteAction } from '../../../../lib/paletteAction';
import { ResponsiveSheet } from '../../../../components/cmd/ResponsiveSheet';
import {
  feedHasUnreadMissed,
  badgeBackgroundColor,
  badgeTextColor,
  rowDotColor,
} from '../../../../components/cmd/NotificationBell';
import type { AdminNotification, SubmissionNotificationType } from '../../../../types';

// ── Deep-link mapping ────────────────────────────────────────────────────────
// Pure map from a notification type to the section id the tap should open
// (null = no navigable admin surface, e.g. a staff `issue` report — mark-read
// only). Exposed so the routing is unit-testable without the store + palette
// bridge. Section ids mirror InventoryDesktopLayout's dispatch keys.
export function sectionForNotification(type: SubmissionNotificationType): string | null {
  switch (type) {
    case 'missed_eod':
    case 'eod':
      return 'EODCount';
    case 'weekly':
      return 'InventoryCount';
    case 'waste':
      return 'WasteLog';
    case 'po':
    case 'receiving':
    // Spec 149 (AC-6) — an `order_ready` row opens the Ordering section, where
    // ReorderSection's phone fork swaps in the Approve Order screen because the
    // tap ALSO carries an `orderApproval` payload (see onRowPress). Desktop
    // never imports this map, so the desktop bell is untouched.
    case 'order_ready':
      return 'Ordering';
    case 'issue':
    default:
      return null;
  }
}

// Relative-time → { key, vars }. Same coarse buckets as NotificationBell's
// local helper (kept in-file so this component needs no cross-import of a
// private symbol).
function relativeTime(iso: string): { key: string; vars?: Record<string, number> } {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return { key: 'chrome.submissionBell.time.now' };
  const min = Math.floor(sec / 60);
  if (min < 60) return { key: 'chrome.submissionBell.time.minutes', vars: { n: min } };
  const hr = Math.floor(min / 60);
  if (hr < 24) return { key: 'chrome.submissionBell.time.hours', vars: { n: hr } };
  const day = Math.floor(hr / 24);
  return { key: 'chrome.submissionBell.time.days', vars: { n: day } };
}

// ── Push toggle (sheet footer) ───────────────────────────────────────────────
// 44×26 pill + 20px knob, accent track when on. Reuses the shared
// useNotificationToggle enable/disable model (isOn / onPress / interactive).
const PushToggleRow: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  const userId = useStore((s) => s.currentUser?.id);
  const m = useNotificationToggle(userId, T);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderTopWidth: 1,
        borderTopColor: C.border,
        backgroundColor: C.panel,
      }}
    >
      <Text style={[PhoneType.caption, { color: C.fg2 }]}>
        {T('chrome.phone.notifications.push')}
      </Text>
      <TouchableOpacity
        testID="phone-notif-push-toggle"
        onPress={m.onPress}
        disabled={!m.interactive}
        activeOpacity={0.85}
        accessibilityRole="switch"
        accessibilityState={{ checked: m.isOn, disabled: !m.interactive }}
        accessibilityLabel={m.aria}
        style={{
          width: 44,
          height: 26,
          borderRadius: CmdRadius.pill,
          padding: 3,
          backgroundColor: m.isOn ? C.accent : C.panel2,
          borderWidth: 1,
          borderColor: m.isOn ? C.accent : C.borderStrong,
          alignItems: m.isOn ? 'flex-end' : 'flex-start',
          justifyContent: 'center',
          opacity: m.interactive ? 1 : 0.55,
        }}
      >
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: CmdRadius.pill,
            backgroundColor: m.isOn ? C.accentFg : C.fg3,
          }}
        />
      </TouchableOpacity>
    </View>
  );
};

export const PhoneNotifications: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  const notifications = useStore((s) => s.submissionNotifications);
  const unread = useStore((s) => s.submissionUnreadCount);
  const markRead = useStore((s) => s.markSubmissionNotificationRead);
  const markAllRead = useStore((s) => s.markAllSubmissionNotificationsRead);
  const [open, setOpen] = React.useState(false);

  const hasUnreadMissed = React.useMemo(
    () => feedHasUnreadMissed(notifications),
    [notifications],
  );
  const badge = unread > 9 ? '9+' : String(unread);

  const typeLabel = React.useCallback(
    (t: AdminNotification['type']) => T(`chrome.submissionBell.type.${t}`),
    [T],
  );

  const onRowPress = React.useCallback(
    (n: AdminNotification) => {
      markRead(n.id);
      const section = sectionForNotification(n.type);
      if (section) {
        usePaletteAction.getState().request({
          section,
          selectedName: null,
          // Spec 149 (AC-6) — scope the Ordering deep link to THIS vendor +
          // business date rather than dropping the admin on the vendor list.
          // `sourceId` is the eod_submissions id; PhoneApproveOrder resolves the
          // vendor + date from it with one RLS-clipped read (design §3.4).
          ...(n.type === 'order_ready'
            ? { orderApproval: { submissionId: n.sourceId, storeId: n.storeId } }
            : {}),
        });
      }
      setOpen(false);
    },
    [markRead],
  );

  return (
    <>
      {/* Bar bell trigger — ◔ + spec-121 count chip. */}
      <TouchableOpacity
        testID="phone-notif-bell"
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={T('chrome.phone.notifications.aria')}
        style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        <Text style={{ fontFamily: mono(400), fontSize: 18, color: unread > 0 ? C.fg : C.fg2 }}>
          ◔
        </Text>
        {unread > 0 ? (
          <View
            testID="phone-notif-badge"
            style={{
              position: 'absolute',
              top: 6,
              right: 6,
              minWidth: 16,
              height: 16,
              paddingHorizontal: 4,
              borderRadius: 8,
              backgroundColor: badgeBackgroundColor(C, hasUnreadMissed),
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontFamily: mono(600), fontSize: 9, color: badgeTextColor(C, hasUnreadMissed) }}>
              {badge}
            </Text>
          </View>
        ) : null}
      </TouchableOpacity>

      <ResponsiveSheet
        visible={open}
        onClose={() => setOpen(false)}
        presentation={{ phone: 'bottom-sheet' }}
        tabletSheetHeight={0.7}
        accessibilityLabel={T('chrome.submissionBell.title')}
        header={
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderBottomWidth: 1,
              borderBottomColor: C.border,
            }}
          >
            {notifications.some((n) => !n.read) ? (
              <TouchableOpacity
                testID="phone-notif-mark-all"
                onPress={() => markAllRead()}
                accessibilityRole="button"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={{ fontFamily: mono(600), fontSize: 11, color: C.accent, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  {T('chrome.submissionBell.markAll')}
                </Text>
              </TouchableOpacity>
            ) : (
              <Text style={{ fontFamily: mono(600), fontSize: 11, color: C.fg, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {T('chrome.submissionBell.title')}
              </Text>
            )}
            <TouchableOpacity
              testID="phone-notif-close"
              onPress={() => setOpen(false)}
              accessibilityRole="button"
              accessibilityLabel={T('common.closeAria')}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={{ width: 44, height: 44, alignItems: 'flex-end', justifyContent: 'center' }}
            >
              <Text style={{ fontFamily: mono(400), fontSize: 18, color: C.fg2 }}>✕</Text>
            </TouchableOpacity>
          </View>
        }
        footer={<PushToggleRow />}
      >
        {notifications.length === 0 ? (
          <View style={{ padding: 28, alignItems: 'center' }}>
            <Text style={[PhoneType.body, { color: C.fg3, textAlign: 'center' }]}>
              {T('chrome.submissionBell.empty')}
            </Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ paddingBottom: 8 }}>
            {notifications.map((n) => {
              const rt = relativeTime(n.createdAt);
              const title =
                n.type === 'issue'
                  ? (n.body ?? typeLabel('issue'))
                  : `${typeLabel(n.type)}${n.storeName ? ` · ${n.storeName}` : ''}`;
              return (
                <TouchableOpacity
                  key={n.id}
                  testID={`phone-notif-row-${n.id}`}
                  onPress={() => onRowPress(n)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'flex-start',
                    gap: 10,
                    minHeight: 56,
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    backgroundColor: n.read ? 'transparent' : C.accentBg,
                    borderBottomWidth: 1,
                    borderBottomColor: C.border,
                  }}
                >
                  <View
                    testID={`phone-notif-dot-${n.id}`}
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: CmdRadius.pill,
                      marginTop: 5,
                      backgroundColor: rowDotColor(C, n),
                    }}
                  />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text
                      numberOfLines={2}
                      style={{ fontFamily: mono(n.read ? 400 : 600), fontSize: 12, color: C.fg }}
                    >
                      {title}
                    </Text>
                    <Text numberOfLines={1} style={[PhoneType.metaMono, { color: C.fg2 }]}>
                      {/* Spec 149 (AC-5) — an `order_ready` row's secondary line
                          names the VENDOR (carried in `body`, the spec-126
                          general-purpose free-text column) instead of the
                          submitter; every other type is unchanged. */}
                      {n.type === 'order_ready'
                        ? (n.body || T('chrome.submissionBell.unknownActor'))
                        : (n.actorName ?? T('chrome.submissionBell.unknownActor'))}
                      {' · '}
                      {T(rt.key, rt.vars)}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}
      </ResponsiveSheet>
    </>
  );
};
