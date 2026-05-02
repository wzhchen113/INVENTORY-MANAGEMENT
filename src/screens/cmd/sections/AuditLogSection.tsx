import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { Avatar } from '../../../components/cmd/Avatar';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { formatAuditAction } from '../../../utils/formatAuditAction';
import { AuditAction, AuditEvent } from '../../../types';

const inferInitials = (name: string): string =>
  name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

const ACTION_TONE: Partial<Record<AuditAction, 'ok' | 'warn' | 'danger' | 'info' | 'muted'>> = {
  'EOD entry':        'info',
  'Item edit':        'muted',
  'Item added':       'ok',
  'Item deleted':     'danger',
  'POS import':       'info',
  'Waste log':        'warn',
  'User invite':      'info',
  'Recipe saved':     'muted',
  'Prep recipe saved':'muted',
  'Stock adjusted':   'ok',
};

const formatDayLabel = (iso: string): string => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return `today · ${d.toLocaleString('en', { month: 'short' })} ${d.getDate()}`;
  if (diffDays === 1) return `yesterday · ${d.toLocaleString('en', { month: 'short' })} ${d.getDate()}`;
  return `${d.toLocaleString('en', { month: 'short' })} ${d.getDate()}`;
};

const formatTime = (iso: string): string => {
  const d = new Date(iso);
  return d.toTimeString().slice(0, 5);
};

// Pattern C — stream/report. Append-only event feed grouped by day. Reads
// from useStore.auditLog filtered to current store. Read-only.
export default function AuditLogSection() {
  const C = useCmdColors();
  const auditLog = useStore((s) => s.auditLog);
  const currentStore = useStore((s) => s.currentStore);

  const [tabId, setTabId] = React.useState('feed.tsx');

  const events = React.useMemo(
    () =>
      auditLog
        .filter((e) => e.storeId === currentStore.id)
        .slice()
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
    [auditLog, currentStore.id],
  );

  const grouped = React.useMemo(() => {
    const map = new Map<string, AuditEvent[]>();
    for (const e of events) {
      const iso = new Date(e.timestamp).toISOString().slice(0, 10);
      const arr = map.get(iso) || [];
      arr.push(e);
      map.set(iso, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => (a < b ? 1 : -1));
  }, [events]);

  const dayCount = grouped.length;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, minWidth: 0 }}>
      <TabStrip
        tabs={[
          { id: 'feed.tsx',     label: 'feed.tsx' },
          { id: 'byUser.tsx',   label: 'byUser.tsx' },
          { id: 'byEntity.tsx', label: 'byEntity.tsx' },
        ]}
        activeId={tabId}
        onChange={setTabId}
        rightSlot={
          <View style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}>
            <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>EXPORT</Text>
          </View>
        }
      />
      <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
        <View>
          <Text style={[Type.h1, { color: C.fg }]}>Audit log</Text>
          <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
            Append-only event stream. Every state change is recorded with actor, entity, before/after.
          </Text>
        </View>

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            backgroundColor: C.panel2,
            borderRadius: CmdRadius.md,
            borderWidth: 1,
            borderColor: C.border,
            paddingHorizontal: 12,
            paddingVertical: 7,
          }}
        >
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>filter:</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg, flex: 1 }}>
            actor:* entity:* action:*
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
            {dayCount} day{dayCount === 1 ? '' : 's'} · {events.length} events
          </Text>
        </View>

        {grouped.length === 0 ? (
          <View
            style={{
              backgroundColor: C.panel,
              borderRadius: CmdRadius.lg,
              borderWidth: 1,
              borderColor: C.border,
              padding: 22,
              alignItems: 'center',
              gap: 6,
            }}
          >
            <SectionCaption tone="fg3">empty</SectionCaption>
            <Text style={{ fontFamily: mono(400), fontSize: 12, color: C.fg3 }}>
              no events recorded for {currentStore.name || 'this store'}
            </Text>
          </View>
        ) : (
          grouped.map(([iso, dayEvents]) => (
            <View key={iso} style={{ gap: 8 }}>
              <SectionCaption tone="fg3" size={10}>{formatDayLabel(iso)}</SectionCaption>
              <View
                style={{
                  backgroundColor: C.panel,
                  borderRadius: CmdRadius.lg,
                  borderWidth: 1,
                  borderColor: C.border,
                  paddingHorizontal: 14,
                }}
              >
                {dayEvents.map((e, i) => {
                  const tone = ACTION_TONE[e.action] || 'muted';
                  const dotColor =
                    tone === 'ok' ? C.ok
                    : tone === 'warn' ? C.warn
                    : tone === 'danger' ? C.danger
                    : tone === 'info' ? C.info
                    : C.fg2;
                  return (
                    <View
                      key={e.id}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                        paddingVertical: 9,
                        borderTopWidth: i === 0 ? 0 : 1,
                        borderTopColor: C.border,
                        borderStyle: 'dashed',
                      }}
                    >
                      <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 56 }}>
                        {formatTime(e.timestamp)}
                      </Text>
                      <Avatar initials={inferInitials(e.userName || '?')} />
                      <Text style={{ fontFamily: sans(600), fontSize: 12.5, color: C.fg, width: 160 }} numberOfLines={1}>
                        {e.userName || '—'}
                      </Text>
                      <Text style={{ fontFamily: sans(400), fontSize: 12.5, color: C.fg2, flex: 1 }} numberOfLines={1}>
                        {formatAuditAction(e)}{' '}
                        <Text style={{ color: C.fg }}>
                          {e.itemRef}{e.value ? ` · ${e.value}` : ''}
                        </Text>
                      </Text>
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dotColor }} />
                    </View>
                  );
                })}
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
