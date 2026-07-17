import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { createPortal } from 'react-dom';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { useT } from '../../hooks/useT';
import type { AdminNotification } from '../../types';

// Spec 120 — brand-scoped submission notification bell for the Cmd UI
// TitleBar. Reads the feed + unread count from the store (the load +
// realtime subscription live in useSubmissionNotifications, wired from the
// Cmd shell). Panel is portaled to document.body like the store switcher so
// the TitleBar's clipping ancestors don't trap it. Web-only: the parent
// TitleBar already bails on native, and react-dom's createPortal is only
// reached on web.

// Relative-time → { key, vars }. Coarse buckets (now / minutes / hours /
// days); anything older than the 30-day feed window won't appear anyway.
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

// Spec 121 — color derivation, extracted as pure functions so the badge /
// row-dot recolor is unit-testable without dragging the store + react-dom
// portal into the test runtime (mirrors the StatusPill test's boundary
// approach). The component memoizes over these; jest exercises them directly.
// Structural color type — the minimal Cmd-palette subset these branches read.
type BellColors = { danger: string; accent: string; accentFg: string };

/** True iff there is ≥1 UNREAD `missed_eod` row in the feed. Drives the red
 *  badge fork — red is reserved for misses (spec 121 Q1). */
export function feedHasUnreadMissed(notifications: AdminNotification[]): boolean {
  return notifications.some((n) => n.type === 'missed_eod' && !n.read);
}

/** Unread-count badge background: red when an unread miss exists, else the
 *  neutral accent (recolors the routine spec-120 submission badge off red). */
export function badgeBackgroundColor(C: BellColors, hasUnreadMissed: boolean): string {
  return hasUnreadMissed ? C.danger : C.accent;
}

/** Badge text color — white on the danger-red badge (legible in both
 *  palettes); accentFg on the accent badge (white on light, near-black on
 *  dark accent), so the count stays readable in both palettes. */
export function badgeTextColor(C: BellColors, hasUnreadMissed: boolean): string {
  return hasUnreadMissed ? '#FFFFFF' : C.accentFg;
}

/** Leading unread dot: transparent when read; red for a `missed_eod` row;
 *  accent for every other (submission) type. */
export function rowDotColor(C: BellColors, n: AdminNotification): string {
  if (n.read) return 'transparent';
  return n.type === 'missed_eod' ? C.danger : C.accent;
}

export const NotificationBell: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  const notifications = useStore((s) => s.submissionNotifications);
  const unread = useStore((s) => s.submissionUnreadCount);
  const markRead = useStore((s) => s.markSubmissionNotificationRead);
  const markAllRead = useStore((s) => s.markAllSubmissionNotificationsRead);
  const [open, setOpen] = React.useState(false);

  // Spec 121 — reserve red for misses: the badge forks red only when there's
  // an unread `missed_eod` in the feed; otherwise it uses the neutral accent.
  const hasUnreadMissed = React.useMemo(
    () => feedHasUnreadMissed(notifications),
    [notifications],
  );

  const typeLabel = React.useCallback(
    (t: AdminNotification['type']) => T(`chrome.submissionBell.type.${t}`),
    [T],
  );

  const badge = unread > 9 ? '9+' : String(unread);

  return (
    <>
      <TouchableOpacity
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={T('chrome.submissionBell.aria')}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          paddingHorizontal: 6,
          paddingVertical: 2,
          borderRadius: CmdRadius.sm,
          borderWidth: 1,
          borderColor: C.borderStrong,
          backgroundColor: open ? C.panel2 : 'transparent',
        }}
      >
        <Text style={{ fontFamily: mono(400), fontSize: 12, color: unread > 0 ? C.fg : C.fg3 }}>
          {'◔'}
        </Text>
        {unread > 0 ? (
          <View
            style={{
              minWidth: 16,
              height: 16,
              paddingHorizontal: 4,
              borderRadius: 8,
              backgroundColor: badgeBackgroundColor(C, hasUnreadMissed),
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {/* Spec 121 — red badge means specifically "a count was missed":
                white on the danger-red badge reads cleanly in both light
                (#791F1F) and dark (#D84B4B) palettes, and accentFg keeps the
                count legible on the accent badge (white on light accent,
                near-black on dark accent) when the unread set is
                submission-only. */}
            <Text
              style={{ fontFamily: mono(600), fontSize: 9, color: badgeTextColor(C, hasUnreadMissed) }}
            >
              {badge}
            </Text>
          </View>
        ) : null}
      </TouchableOpacity>

      {open
        ? createPortal(
            <>
              {/* Backdrop — click outside to close */}
              <div
                onClick={() => setOpen(false)}
                style={{
                  position: 'fixed',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  zIndex: 999,
                  background: 'transparent',
                }}
              />
              <div
                style={{
                  position: 'fixed',
                  top: 36,
                  right: 12,
                  width: 340,
                  maxHeight: '70vh',
                  overflowY: 'auto',
                  backgroundColor: C.panel,
                  border: `1px solid ${C.border}`,
                  borderRadius: CmdRadius.sm,
                  paddingTop: 4,
                  paddingBottom: 4,
                  zIndex: 1000,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
                }}
              >
                {/* Header — title + mark-all-read */}
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderBottomWidth: 1,
                    borderBottomColor: C.border,
                  }}
                >
                  <Text style={{ fontFamily: mono(600), fontSize: 11, color: C.fg }}>
                    {T('chrome.submissionBell.title')}
                  </Text>
                  {notifications.some((n) => !n.read) ? (
                    <TouchableOpacity onPress={() => markAllRead()} accessibilityRole="button">
                      <Text style={{ fontFamily: mono(500), fontSize: 10, color: C.accent }}>
                        {T('chrome.submissionBell.markAll')}
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>

                {notifications.length === 0 ? (
                  <Text
                    style={{
                      fontFamily: mono(400),
                      fontSize: 11,
                      color: C.fg3,
                      paddingHorizontal: 12,
                      paddingVertical: 16,
                      textAlign: 'center',
                    }}
                  >
                    {T('chrome.submissionBell.empty')}
                  </Text>
                ) : (
                  notifications.map((n) => {
                    const rt = relativeTime(n.createdAt);
                    return (
                      <TouchableOpacity
                        key={n.id}
                        onPress={() => markRead(n.id)}
                        style={{
                          paddingHorizontal: 12,
                          paddingVertical: 8,
                          backgroundColor: n.read ? 'transparent' : C.accentBg,
                          flexDirection: 'row',
                          alignItems: 'flex-start',
                          gap: 8,
                        }}
                      >
                        {/* Unread dot */}
                        <View
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 3,
                            marginTop: 4,
                            // Spec 121 — red dot for a miss, accent for a
                            // submission; transparent once read.
                            backgroundColor: rowDotColor(C, n),
                          }}
                        />
                        <View style={{ flex: 1 }}>
                          {n.type === 'issue' ? (
                            // Spec 126 — a staff-filed report. Primary line is a
                            // category badge + the free-text message (`body`);
                            // the secondary line carries store + reporter + time.
                            // Read the message directly (zero-join denormalized
                            // onto the notification row) so the recipient sees
                            // WHAT was reported, not a bare "issue" placeholder.
                            <>
                              <View
                                style={{
                                  flexDirection: 'row',
                                  alignItems: 'flex-start',
                                  gap: 6,
                                }}
                              >
                                {n.category ? (
                                  <View
                                    style={{
                                      backgroundColor: C.accentBg,
                                      borderRadius: CmdRadius.sm,
                                      paddingHorizontal: 5,
                                      paddingVertical: 1,
                                      marginTop: 1,
                                    }}
                                  >
                                    <Text
                                      style={{
                                        fontFamily: mono(600),
                                        fontSize: 9,
                                        color: C.accent,
                                        textTransform: 'uppercase',
                                      }}
                                    >
                                      {T(`chrome.submissionBell.issueCategory.${n.category}`)}
                                    </Text>
                                  </View>
                                ) : null}
                                <Text
                                  style={{
                                    flex: 1,
                                    fontFamily: mono(n.read ? 400 : 600),
                                    fontSize: 11,
                                    color: C.fg,
                                  }}
                                  numberOfLines={2}
                                >
                                  {n.body ?? typeLabel('issue')}
                                </Text>
                              </View>
                              <Text
                                style={{ fontFamily: mono(400), fontSize: 10, color: C.fg2 }}
                                numberOfLines={1}
                              >
                                {n.storeName ? `${n.storeName} · ` : ''}
                                {n.actorName ?? T('chrome.submissionBell.unknownActor')}
                                {' · '}
                                {T(rt.key, rt.vars)}
                              </Text>
                            </>
                          ) : (
                            <>
                              <Text
                                style={{
                                  fontFamily: mono(n.read ? 400 : 600),
                                  fontSize: 11,
                                  color: C.fg,
                                }}
                                numberOfLines={1}
                              >
                                {typeLabel(n.type)}
                                {n.storeName ? ` · ${n.storeName}` : ''}
                              </Text>
                              <Text
                                style={{ fontFamily: mono(400), fontSize: 10, color: C.fg2 }}
                                numberOfLines={1}
                              >
                                {n.actorName ?? T('chrome.submissionBell.unknownActor')}
                                {' · '}
                                {T(rt.key, rt.vars)}
                              </Text>
                            </>
                          )}
                        </View>
                      </TouchableOpacity>
                    );
                  })
                )}
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
};
