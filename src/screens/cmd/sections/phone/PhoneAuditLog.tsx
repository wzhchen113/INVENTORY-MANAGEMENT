// src/screens/cmd/sections/phone/PhoneAuditLog.tsx — Spec 147.
//
// Phone tier of the Audit log screen (design handoff README §7-17 — "Audit log
// (day-grouped)"). The desktop TabStrip + fixed-width feed table becomes a
// virtualized, day-grouped SectionList: mono day captions + two-line rows whose
// full message wraps (not truncated) with a "time · user" meta line, plus the
// existing bilingual text filter surfaced as a 44px input.
//
// PRESENTATIONAL / direct-store — reads the same auditLog / currentStore slices
// the desktop FeedTab reads and reuses the same `formatAuditAction` +
// `matchesQuery` helpers (no forked filter logic).
//
// DEVIATION FROM HARD RULE 1 (no drill-in): README §7-17 scopes Audit as a
// "day-grouped" list only — unlike Reconciliation / POS imports / Reports there
// is no richer per-event detail to show. Because the row renders the FULL
// message (wrapping, never truncated), a full-screen detail would be an empty
// re-print of the same text, so this screen is intentionally list-only. The
// row is non-interactive (read-only feed), matching the desktop feed.tsx.
//
// Hard Rules honored: full messages wrap (no letter-stacking — the container
// keeps its width), one vertical scroll, 44px filter input, semantic dot tones,
// never the accent.

import React from 'react';
import { View, Text, TextInput, SectionList, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useStore } from '../../../../store/useStore';
import { useT } from '../../../../hooks/useT';
import { useLocale, type Locale } from '../../../../hooks/useLocale';
import { formatAuditAction } from '../../../../utils/formatAuditAction';
import { matchesQuery } from '../../../../i18n/matchesQuery';
import { GroupCaption } from './PhoneWidgets';
import { AuditAction, AuditEvent } from '../../../../types';

type TFn = (key: string, vars?: Record<string, string | number>) => string;

// Same action→tone map + day label helper as the desktop AuditLogSection.
const ACTION_TONE: Partial<Record<AuditAction, 'ok' | 'warn' | 'danger' | 'info' | 'muted'>> = {
  'EOD entry': 'info',
  'Item edit': 'muted',
  'Item added': 'ok',
  'Item deleted': 'danger',
  'POS import': 'info',
  'Waste log': 'warn',
  'User invite': 'info',
  'Recipe saved': 'muted',
  'Recipe deleted': 'danger',
  'Prep recipe saved': 'muted',
  'Prep recipe deleted': 'danger',
  'Stock adjusted': 'ok',
  'Order missed': 'warn',
};

const formatTime = (iso: string): string => new Date(iso).toTimeString().slice(0, 5);

function formatDayLabel(iso: string, T: TFn, locale: Locale): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - d.getTime()) / 86400000);
  const monthDay = `${d.toLocaleString(locale, { month: 'short' })} ${d.getDate()}`;
  if (diffDays === 0) return T('section.auditLog.todayPrefix', { label: monthDay });
  if (diffDays === 1) return T('section.auditLog.yesterdayPrefix', { label: monthDay });
  return monthDay;
}

export const PhoneAuditLog: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();
  const auditLog = useStore((s) => s.auditLog);
  const currentStore = useStore((s) => s.currentStore);
  const [filterText, setFilterText] = React.useState('');

  const events = React.useMemo(
    () =>
      auditLog
        .filter((e) => e.storeId === currentStore.id)
        .slice()
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
    [auditLog, currentStore.id],
  );

  const filtered = React.useMemo(() => {
    if (!filterText.trim()) return events;
    return events.filter((e) => matchesQuery(filterText, [formatAuditAction(e, T), e.action, e.userName, e.itemRef, e.value]));
  }, [events, filterText, T]);

  const sections = React.useMemo(() => {
    const map = new Map<string, AuditEvent[]>();
    for (const e of filtered) {
      const iso = new Date(e.timestamp).toISOString().slice(0, 10);
      const arr = map.get(iso) || [];
      arr.push(e);
      map.set(iso, arr);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([iso, data]) => ({ iso, data }));
  }, [filtered]);

  return (
    <View testID="phone-auditlog" style={{ flex: 1, backgroundColor: C.bg }}>
      <SectionList
        style={{ flex: 1, minHeight: 0 }}
        sections={sections}
        keyExtractor={(e) => e.id}
        stickySectionHeadersEnabled={false}
        initialNumToRender={18}
        windowSize={9}
        removeClippedSubviews={Platform.OS !== 'web'}
        contentContainerStyle={{ paddingBottom: 32 }}
        ListHeaderComponent={
          <View style={{ paddingTop: 16, paddingHorizontal: 16, gap: 10 }}>
            <View style={{ gap: 4 }}>
              <Text style={[PhoneType.screenTitle, { color: C.fg }]}>{T('section.auditLog.title')}</Text>
              <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
                {sections.length === 1
                  ? T('section.auditLog.dayCount', { count: sections.length, events: filtered.length })
                  : T('section.auditLog.dayCountPlural', { count: sections.length, events: filtered.length })}
              </Text>
            </View>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                height: 44,
                backgroundColor: C.panel2,
                borderRadius: CmdRadius.md,
                borderWidth: 1,
                borderColor: C.border,
                paddingHorizontal: 12,
              }}
            >
              <Text style={{ fontFamily: mono(400), fontSize: 12, color: C.fg3 }}>{T('section.auditLog.filterLabel')}</Text>
              <TextInput
                testID="phone-auditlog-filter"
                value={filterText}
                onChangeText={setFilterText}
                placeholder={T('section.auditLog.filterPlaceholder')}
                placeholderTextColor={C.fg3}
                style={{
                  flex: 1,
                  fontFamily: mono(400),
                  fontSize: 13,
                  color: C.fg,
                  paddingVertical: 0,
                  ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                }}
              />
            </View>
          </View>
        }
        ListEmptyComponent={
          <View style={{ padding: 22, alignItems: 'center', gap: 6 }}>
            <Text style={[PhoneType.caption, { color: C.fg3 }]}>{T('section.auditLog.empty')}</Text>
            <Text style={[PhoneType.metaMono, { color: C.fg3 }]}>
              {T('section.auditLog.noEventsForStore', { storeName: currentStore.name || T('chrome.store') })}
            </Text>
          </View>
        }
        renderSectionHeader={({ section }) => <GroupCaption>{formatDayLabel(section.iso, T, locale)}</GroupCaption>}
        renderItem={({ item: e }) => {
          const tone = ACTION_TONE[e.action] || 'muted';
          const dotColor = tone === 'ok' ? C.ok : tone === 'warn' ? C.warn : tone === 'danger' ? C.danger : tone === 'info' ? C.info : C.fg2;
          return (
            <View
              testID={`phone-auditlog-row-${e.id}`}
              style={{ minHeight: 56, paddingHorizontal: 14, paddingVertical: 10, gap: 4, borderBottomWidth: 1, borderBottomColor: C.border }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dotColor, flexShrink: 0 }} />
                <Text style={[PhoneType.metaMono, { color: C.fg3, flex: 1 }]} numberOfLines={1}>
                  {formatTime(e.timestamp)} · {e.userName || '—'}
                </Text>
              </View>
              <Text style={[PhoneType.body, { color: C.fg }]}>
                {formatAuditAction(e, T)}
                {e.itemRef ? ` ${e.itemRef}` : ''}
                {e.value ? ` · ${e.value}` : ''}
              </Text>
            </View>
          );
        }}
      />
    </View>
  );
};

export default PhoneAuditLog;
