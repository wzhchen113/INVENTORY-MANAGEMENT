// src/screens/cmd/sections/phone/PhoneDashboard.tsx — Spec 145 phone Dashboard.
//
// The phone tier of the Dashboard screen (design handoff README §5 "Dashboard").
// The desktop single-column ScrollView (KPI strip that squeezes at phone width +
// CoGS card + heatmap + per-store attention grid) becomes a thumb-first vertical
// feed: a 2×2 flex-wrap KPI grid + three grouped sections (TODAY'S EOD COUNT /
// NEEDS ATTENTION / RECENT ACTIVITY).
//
// PRESENTATIONAL — every datum arrives in `model` (the PhoneEodCount /
// PhoneWeeklyCount lift pattern). DashboardSection computes the KPI figures with
// its OWN selectors (do not re-derive) and hands them down under the isPhone
// guard, so the desktop/tablet tree stays byte-unchanged (AC-REG). The only live
// wiring PhoneDashboard owns is (a) the `usePaletteAction` cross-section jump to
// a vendor's EOD tab (same bridge as PhoneOrdering's GO TO EOD COUNT), and (b)
// the shared PhoneDrillScaffold drill-in to PhoneInventoryDetail for OUT items
// (same drill the Inventory section uses — reused, not forked).
//
// Hard Rules honored: KPI cards are flex-wrap `flex:1 0 44%` (NO CSS grid), full
// vendor + item names (flex:1, ellipsize only past the full width), one vertical
// scroll (no horizontal), every tappable ≥44×44, status colors are semantic
// tokens and never the accent.

import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { usePaletteAction } from '../../../../lib/paletteAction';
import { useT } from '../../../../hooks/useT';
import { useLocale } from '../../../../hooks/useLocale';
import { getLocalizedName } from '../../../../i18n/localizedName';
import { relativeTime } from '../../../../utils/relativeTime';
import { formatAuditAction } from '../../../../utils/formatAuditAction';
import { StatusPill } from '../../../../components/cmd/StatusPill';
import { formatCostPerEach, costPerEachLabel } from '../../lib/itemMoney';
import { TwoLineRow, GroupCaption } from './PhoneWidgets';
import { PhoneDrillScaffold } from './PhoneDrillScaffold';
import { usePhoneDrill } from './usePhoneDrill';
import { PhoneInventoryDetail } from './PhoneInventoryDetail';
import type { AuditEvent, InventoryItem } from '../../../../types';

// ── Model ──────────────────────────────────────────────────────────────────
export interface PhoneDashboardEodRow {
  vendorId: string;
  vendorName: string;
  counted: number;
  total: number;
  submitted: boolean;
  /** Representative item id used for the EOD-tab deep-link (may be undefined). */
  focusItemId?: string;
}

export interface PhoneDashboardModel {
  /** Current store name — the meta line's trailing token. */
  storeName: string;
  // KPI figures — lifted verbatim from DashboardSection's own selectors.
  totalInvValue: number;
  itemCount: number;
  outCount: number;
  lowCount: number;
  wasteWeek: number;
  wasteEventCount: number;
  /** OUT items (== outCount) for the NEEDS ATTENTION group / drill-in. */
  outItems: InventoryItem[];
  /** Per-vendor EOD progress for the current store, today. */
  eodRows: PhoneDashboardEodRow[];
  /** Current-store audit events, most-recent first, already sliced. */
  activity: AuditEvent[];
}

// Prototype money format (`IMR Phone Console.dc.html` money()): locale-grouped
// with two fraction digits.
function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Local-day date-chip meta ("SUN JUL 26"). Parse LOCAL to avoid the
// new Date().toISOString() UTC day shift.
function todayChip(): string {
  const d = new Date();
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
  const mo = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
  return `${wd} ${mo} ${d.getDate()}`;
}

// ── KPI card (flex:1 0 44%, kpiValue ramp, semantic value color) ─────────────
function KpiCard({
  testID,
  label,
  value,
  sub,
  valueColor,
}: {
  testID: string;
  label: string;
  value: string;
  sub: string;
  valueColor: string;
}) {
  const C = useCmdColors();
  return (
    <View
      testID={testID}
      style={{
        flexGrow: 1,
        flexShrink: 0,
        flexBasis: '44%',
        backgroundColor: C.panel,
        borderRadius: CmdRadius.lg,
        borderWidth: 1,
        borderColor: C.border,
        paddingVertical: 12,
        paddingHorizontal: 14,
        gap: 6,
      }}
    >
      <Text style={[PhoneType.microCaption, { color: C.fg3 }]} numberOfLines={1}>
        {label}
      </Text>
      <Text testID={`${testID}-value`} style={[PhoneType.kpiValue, { color: valueColor }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
        {sub}
      </Text>
    </View>
  );
}

// Small status badge (DONE / OPEN) — the pill slot on each EOD progress row.
function Badge({ label, tone }: { label: string; tone: 'ok' | 'warn' }) {
  const C = useCmdColors();
  const fg = tone === 'ok' ? C.ok : C.warn;
  const bg = tone === 'ok' ? C.okBg : C.warnBg;
  return (
    <View
      style={{
        flexShrink: 0,
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: CmdRadius.pill,
        borderWidth: 0.5,
        borderColor: fg,
        backgroundColor: bg,
      }}
    >
      <Text style={{ fontFamily: mono(700), fontSize: 9, letterSpacing: 0.5, color: fg }}>{label}</Text>
    </View>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────
export const PhoneDashboard: React.FC<{ model: PhoneDashboardModel }> = ({ model }) => {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();
  const drill = usePhoneDrill<InventoryItem>();

  const goEod = (focusItemId?: string) => {
    usePaletteAction.getState().request({
      section: 'EODCount',
      selectedName: null,
      eodFocusItemId: focusItemId,
    });
  };

  const list = (
    <ScrollView
      testID="phone-dash-scroll"
      style={{ flex: 1, backgroundColor: C.bg }}
      contentContainerStyle={{ paddingBottom: 32 }}
    >
      {/* Header */}
      <View style={{ paddingTop: 16, paddingHorizontal: 16, paddingBottom: 12, gap: 4 }}>
        <Text style={[PhoneType.screenTitle, { color: C.fg }]}>{T('section.dashboard.title')}</Text>
        <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
          {T('section.dashboard.phone.metaLine', { date: todayChip(), store: model.storeName || '—' })}
        </Text>
      </View>

      {/* 2×2 KPI grid — flex-wrap, 44% basis (Hard Rule / CLAUDE-CODE-INSTRUCTIONS) */}
      <View
        testID="phone-dash-kpis"
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 16, paddingBottom: 8 }}
      >
        <KpiCard
          testID="phone-dash-kpi-invValue"
          label={T('section.dashboard.phone.kpiInvValue')}
          value={money(model.totalInvValue)}
          sub={T('section.dashboard.phone.kpiInvValueSub', { count: model.itemCount })}
          valueColor={C.fg}
        />
        <KpiCard
          testID="phone-dash-kpi-out"
          label={T('section.dashboard.phone.kpiOut')}
          value={String(model.outCount)}
          sub={T('section.dashboard.phone.kpiOutSub')}
          valueColor={C.danger}
        />
        <KpiCard
          testID="phone-dash-kpi-low"
          label={T('section.dashboard.phone.kpiLow')}
          value={String(model.lowCount)}
          sub={T('section.dashboard.phone.kpiLowSub')}
          valueColor={C.warn}
        />
        <KpiCard
          testID="phone-dash-kpi-waste"
          label={T('section.dashboard.phone.kpiWaste')}
          value={money(model.wasteWeek)}
          sub={T('section.dashboard.phone.kpiWasteSub', { count: model.wasteEventCount })}
          valueColor={C.fg}
        />
      </View>

      {/* TODAY'S EOD COUNT — per-vendor progress → deep-link to the EOD tab */}
      <GroupCaption>{T('section.dashboard.phone.eodGroup')}</GroupCaption>
      {model.eodRows.length === 0 ? (
        <Text style={[PhoneType.metaMono, { color: C.fg3, paddingHorizontal: 14, paddingVertical: 12 }]}>
          {T('section.dashboard.phone.noEod')}
        </Text>
      ) : (
        model.eodRows.map((v) => (
          <TwoLineRow
            key={v.vendorId}
            testID={`phone-dash-eod-row-${v.vendorId}`}
            pill={
              <Badge
                label={v.submitted ? T('section.dashboard.phone.eodPillDone') : T('section.dashboard.phone.eodPillOpen')}
                tone={v.submitted ? 'ok' : 'warn'}
              />
            }
            name={v.vendorName || T('section.reorder.unnamedVendor')}
            rightValue={
              <Text
                style={[
                  PhoneType.tableNum,
                  { color: v.submitted ? C.ok : v.counted > 0 ? C.warn : C.fg3 },
                ]}
              >
                {v.submitted ? '✓' : `${v.counted}/${v.total}`}
              </Text>
            }
            meta={
              <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
                {v.submitted
                  ? T('section.dashboard.phone.eodSubmitted')
                  : T('section.dashboard.phone.eodProgress', { counted: v.counted, total: v.total })}
              </Text>
            }
            onPress={() => goEod(v.focusItemId)}
          />
        ))
      )}

      {/* NEEDS ATTENTION — OUT items → full-screen item detail (shared drill-in) */}
      <GroupCaption>{T('section.dashboard.phone.attentionGroup')}</GroupCaption>
      {model.outItems.length === 0 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 12 }}>
          <Text style={{ fontFamily: mono(700), fontSize: 12, color: C.ok }}>✓</Text>
          <Text style={[PhoneType.body, { color: C.ok }]}>{T('section.dashboard.phone.noAttention')}</Text>
        </View>
      ) : (
        model.outItems.map((it) => {
          const name = getLocalizedName({ name: it.name, i18nNames: it.i18nNames }, locale);
          return (
            <TwoLineRow
              key={it.id}
              testID={`phone-dash-attention-row-${it.id}`}
              pill={<StatusPill status="out" />}
              name={name}
              rightValue={
                <Text style={[PhoneType.tableNum, { color: C.danger }]}>
                  {it.currentStock} {it.unit}
                </Text>
              }
              meta={
                <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
                  {T('section.dashboard.phone.attentionMeta', {
                    par: it.parLevel,
                    cost: formatCostPerEach(it),
                    unit: costPerEachLabel(it),
                    vendor: (it.vendorName || T('section.reorder.unnamedVendor')).toUpperCase(),
                  })}
                </Text>
              }
              onPress={() => drill.open(it)}
            />
          );
        })
      )}

      {/* RECENT ACTIVITY — current-store audit feed (two-line rows, mono meta) */}
      <GroupCaption>{T('section.dashboard.phone.activityGroup')}</GroupCaption>
      {model.activity.length === 0 ? (
        <Text style={[PhoneType.metaMono, { color: C.fg3, paddingHorizontal: 14, paddingVertical: 12 }]}>
          {T('section.dashboard.phone.noActivity')}
        </Text>
      ) : (
        model.activity.map((e) => (
          <TwoLineRow
            key={e.id}
            testID={`phone-dash-activity-row-${e.id}`}
            name={formatAuditAction(e, T)}
            rightValue={<Text style={[PhoneType.metaMono, { color: C.fg3 }]}>{relativeTime(e.timestamp)}</Text>}
            meta={
              <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
                {e.userName}
                {e.value ? ` · ${e.value}` : ''}
              </Text>
            }
          />
        ))
      )}
    </ScrollView>
  );

  return (
    <PhoneDrillScaffold
      testID="phone-dashboard"
      parentCaption={T('section.dashboard.title').toUpperCase()}
      onBack={drill.close}
      list={list}
      detail={drill.selected ? <PhoneInventoryDetail item={drill.selected} /> : null}
    />
  );
};

export default PhoneDashboard;
