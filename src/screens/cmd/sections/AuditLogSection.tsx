import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { Avatar } from '../../../components/cmd/Avatar';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { useT } from '../../../hooks/useT';
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
  'Recipe deleted':   'danger',
  'Prep recipe saved':'muted',
  'Prep recipe deleted':'danger',
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

const formatTime = (iso: string): string => new Date(iso).toTimeString().slice(0, 5);

// Coarse entity kind inference. The audit_log doesn't carry an explicit
// "kind" column, but the action verb correlates strongly with one.
function inferKind(e: AuditEvent): string {
  const a = e.action;
  if (a.startsWith('Item')) return 'item';
  if (a.startsWith('Recipe')) return 'recipe';
  if (a.startsWith('Prep recipe')) return 'prep_recipe';
  if (a === 'POS import') return 'pos_import';
  if (a === 'Waste log') return 'waste';
  if (a === 'EOD entry') return 'count';
  if (a === 'Stock adjusted') return 'stock';
  if (a === 'User invite') return 'user';
  return 'other';
}

// Pattern C — stream/report. Append-only event feed grouped by day. Reads
// from useStore.auditLog filtered to current store. Read-only.
export default function AuditLogSection() {
  const C = useCmdColors();
  const T = useT();
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
            <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>{T('common.export').toUpperCase()}</Text>
          </View>
        }
      />
      {tabId === 'feed.tsx' ? (
        <FeedTab events={events} storeName={currentStore.name} />
      ) : tabId === 'byUser.tsx' ? (
        <ByUserTab events={events} onJumpToFeed={() => setTabId('feed.tsx')} />
      ) : (
        <ByEntityTab events={events} onJumpToFeed={() => setTabId('feed.tsx')} />
      )}
    </View>
  );
}

// ─── feed.tsx (existing) ──────────────────────────────────────────────
function FeedTab({ events, storeName }: { events: AuditEvent[]; storeName: string }) {
  const C = useCmdColors();
  const T = useT();
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

  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{T('section.auditLog.title')}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          Append-only event stream. Every state change is recorded with actor, entity, before/after.
        </Text>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.panel2, borderRadius: CmdRadius.md, borderWidth: 1, borderColor: C.border, paddingHorizontal: 12, paddingVertical: 7 }}>
        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>filter:</Text>
        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg, flex: 1 }}>actor:* entity:* action:*</Text>
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
          {grouped.length} day{grouped.length === 1 ? '' : 's'} · {events.length} events
        </Text>
      </View>

      {grouped.length === 0 ? (
        <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 22, alignItems: 'center', gap: 6 }}>
          <SectionCaption tone="fg3">empty</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 12, color: C.fg3 }}>
            no events recorded for {storeName || 'this store'}
          </Text>
        </View>
      ) : (
        grouped.map(([iso, dayEvents]) => (
          <View key={iso} style={{ gap: 8 }}>
            <SectionCaption tone="fg3" size={10}>{formatDayLabel(iso)}</SectionCaption>
            <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, paddingHorizontal: 14 }}>
              {dayEvents.map((e, i) => {
                const tone = ACTION_TONE[e.action] || 'muted';
                const dotColor = tone === 'ok' ? C.ok : tone === 'warn' ? C.warn : tone === 'danger' ? C.danger : tone === 'info' ? C.info : C.fg2;
                return (
                  <View key={e.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
                    <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 56 }}>{formatTime(e.timestamp)}</Text>
                    <Avatar initials={inferInitials(e.userName || '?')} />
                    <Text style={{ fontFamily: sans(600), fontSize: 12.5, color: C.fg, width: 160 }} numberOfLines={1}>{e.userName || '—'}</Text>
                    <Text style={{ fontFamily: sans(400), fontSize: 12.5, color: C.fg2, flex: 1 }} numberOfLines={1}>
                      {formatAuditAction(e)}{' '}
                      <Text style={{ color: C.fg }}>{e.itemRef}{e.value ? ` · ${e.value}` : ''}</Text>
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
  );
}

// ─── byUser.tsx — group by actor, show selected user's recent events ──
function ByUserTab({ events, onJumpToFeed }: { events: AuditEvent[]; onJumpToFeed: () => void }) {
  const C = useCmdColors();

  // Aggregate per user with hot-action breakdown.
  const users = React.useMemo(() => {
    const map = new Map<string, { name: string; total: number; actions: Map<string, number> }>();
    for (const e of events) {
      const key = e.userName || '—';
      const u = map.get(key) || { name: key, total: 0, actions: new Map() };
      u.total += 1;
      u.actions.set(e.action, (u.actions.get(e.action) || 0) + 1);
      map.set(key, u);
    }
    return Array.from(map.values())
      .map((u) => ({
        ...u,
        hot: Array.from(u.actions.entries()).sort((a, b) => b[1] - a[1]).slice(0, 2),
      }))
      .sort((a, b) => b.total - a.total);
  }, [events]);

  const [selectedName, setSelectedName] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!selectedName && users.length > 0) setSelectedName(users[0].name);
  }, [users, selectedName]);

  const selectedEvents = React.useMemo(
    () => events.filter((e) => (e.userName || '—') === selectedName).slice(0, 30),
    [events, selectedName],
  );

  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>audit · by user</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          aggregate of feed.tsx grouped by actor · row click → feed with that actor filtered
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 14 }}>
        <Panel title="USERS.TSV" right={`${users.length} actor${users.length === 1 ? '' : 's'}`} style={{ flex: 1 }}>
          {users.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 8 }}>no events</Text>
          ) : (
            users.map((u, i) => {
              const selected = u.name === selectedName;
              return (
                <TouchableOpacity key={u.name} onPress={() => setSelectedName(u.name)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed', backgroundColor: selected ? C.accentBg : 'transparent', borderRadius: CmdRadius.sm, paddingHorizontal: 6 }}>
                  <Text style={{ fontFamily: sans(600), fontSize: 12.5, color: C.fg, flex: 1 }} numberOfLines={1}>{u.name}</Text>
                  <Text style={{ fontFamily: mono(500), fontSize: 11, color: C.fg2, width: 50, textAlign: 'right' }}>{u.total}</Text>
                  <View style={{ flexDirection: 'row', gap: 4 }}>
                    {u.hot.map(([action, count]) => (
                      <View key={action} style={{ borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.xs, paddingHorizontal: 5, paddingVertical: 1 }}>
                        <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
                          {action.toLowerCase().split(' ')[0]} {count}
                        </Text>
                      </View>
                    ))}
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </Panel>
        <Panel title={selectedName ? `${selectedName.toUpperCase()} · ${selectedEvents.length} EVENTS` : 'NO SELECTION'} style={{ flex: 1.6 }}>
          {selectedEvents.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 8 }}>—</Text>
          ) : (
            selectedEvents.map((e, i) => (
              <TouchableOpacity key={e.id} onPress={onJumpToFeed} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, width: 90 }}>{new Date(e.timestamp).toISOString().slice(5, 16).replace('T', ' ')}</Text>
                <Text style={{ fontFamily: sans(500), fontSize: 12, color: C.fg2, width: 130 }} numberOfLines={1}>{e.action}</Text>
                <Text style={{ fontFamily: sans(400), fontSize: 12, color: C.fg, flex: 1 }} numberOfLines={1}>{e.itemRef}{e.value ? ` · ${e.value}` : ''}</Text>
              </TouchableOpacity>
            ))
          )}
        </Panel>
      </View>
    </ScrollView>
  );
}

// ─── byEntity.tsx — group by inferred entity kind ─────────────────────
function ByEntityTab({ events, onJumpToFeed }: { events: AuditEvent[]; onJumpToFeed: () => void }) {
  const C = useCmdColors();

  const kinds = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const e of events) {
      const k = inferKind(e);
      map.set(k, (map.get(k) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [events]);

  const [selectedKind, setSelectedKind] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!selectedKind && kinds.length > 0) setSelectedKind(kinds[0][0]);
  }, [kinds, selectedKind]);

  const hotEntities = React.useMemo(() => {
    const filtered = selectedKind ? events.filter((e) => inferKind(e) === selectedKind) : events;
    const map = new Map<string, { ref: string; total: number; lastAt: string }>();
    for (const e of filtered) {
      const ref = e.itemRef || '—';
      const cur = map.get(ref) || { ref, total: 0, lastAt: e.timestamp };
      cur.total += 1;
      if (new Date(e.timestamp) > new Date(cur.lastAt)) cur.lastAt = e.timestamp;
      map.set(ref, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total).slice(0, 15);
  }, [events, selectedKind]);

  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>audit · by entity</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          most-touched objects · find the noise
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 14 }}>
        <Panel title="TYPES.TSV" right={`${kinds.length}`} style={{ flex: 1 }}>
          {kinds.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 8 }}>no events</Text>
          ) : (
            kinds.map(([kind, count], i) => {
              const selected = kind === selectedKind;
              return (
                <TouchableOpacity key={kind} onPress={() => setSelectedKind(kind)} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed', backgroundColor: selected ? C.accentBg : 'transparent', borderRadius: CmdRadius.sm, paddingHorizontal: 6 }}>
                  <Text style={{ fontFamily: mono(500), fontSize: 12, color: C.fg, flex: 1 }}>{kind}</Text>
                  <Text style={{ fontFamily: mono(500), fontSize: 11, color: C.fg2 }}>{count}</Text>
                </TouchableOpacity>
              );
            })
          )}
        </Panel>
        <Panel title={selectedKind ? `HOT ENTITIES · ${selectedKind}` : 'HOT ENTITIES'} right={`${hotEntities.length}`} style={{ flex: 1.5 }}>
          {hotEntities.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 8 }}>—</Text>
          ) : (
            hotEntities.map((h, i) => (
              <TouchableOpacity key={h.ref} onPress={onJumpToFeed} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
                <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1 }} numberOfLines={1}>{h.ref}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2, width: 60, textAlign: 'right' }}>{h.total} ev</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, width: 90, textAlign: 'right' }}>
                  {new Date(h.lastAt).toISOString().slice(5, 16).replace('T', ' ')}
                </Text>
              </TouchableOpacity>
            ))
          )}
        </Panel>
      </View>
    </ScrollView>
  );
}

// ─── Local Panel helper (matches the .panel + .ph/.pb pattern) ────────
function Panel({ title, right, style, children }: { title: string; right?: string; style?: any; children: React.ReactNode }) {
  const C = useCmdColors();
  return (
    <View style={[{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border }, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.border, borderStyle: 'dashed' }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>{title}</Text>
        {right ? <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{right}</Text> : null}
      </View>
      <View style={{ paddingHorizontal: 12, paddingVertical: 6 }}>{children}</View>
    </View>
  );
}
