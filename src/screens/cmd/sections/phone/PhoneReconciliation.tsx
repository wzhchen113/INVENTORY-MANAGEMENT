// src/screens/cmd/sections/phone/PhoneReconciliation.tsx — Spec 147.
//
// Phone tier of the Reconciliation screen (design handoff README §7-17 "shared
// list shell" — "Reconciliation (theo vs actual, variance pills)"). The desktop
// 7-column fixed-width variance table becomes a full-width two-line card list →
// full-screen detail. Row = variance pill (severity by |Δ%|) + item name + Δ$
// value; meta = expected/counted. Tap opens the full-screen detail (expected /
// counted / Δ qty / Δ$ / Δ%).
//
// PRESENTATIONAL — the variance rows + net summary arrive in `model` from
// ReconciliationSection's OWN `computeVarianceLines` mapping (the spec-145
// model-lift pattern: do not re-derive the variance math on the phone side).
//
// Hard Rules honored: full item names (flex:1, ellipsize only past the full
// width), no table, one vertical scroll, every tappable ≥44×44, variance pills
// use the danger/warn/ok semantic tokens — never the accent.

import React from 'react';
import { View, Text, FlatList, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useT } from '../../../../hooks/useT';
import { TwoLineRow, GroupCaption, PropertyCard } from './PhoneWidgets';
import { PhoneDrillScaffold } from './PhoneDrillScaffold';
import { usePhoneDrill } from './usePhoneDrill';

// ── Model ──────────────────────────────────────────────────────────────────
// Structurally identical to ReconciliationSection's local `VarianceRow` so the
// host passes its computed rows straight through (no re-map, no re-derive).
export interface PhoneVarianceRow {
  id: string;
  name: string;
  category: string;
  unit: string;
  expected: number;
  counted: number;
  diff: number;
  dollar: number;
  pct: number;
}

export interface PhoneReconciliationModel {
  /** Latest EOD submission date (the header subtitle), or null when none. */
  latestDate: string | null;
  /** Variance rows, already sorted by |Δ$| desc by the host. */
  rows: PhoneVarianceRow[];
  netDollar: number;
  netPctOfInv: number;
}

// Signed money: "+$3.80" / "−$3.80" / "$0.00".
function signedMoney(n: number): string {
  const sign = n < 0 ? '−' : n > 0 ? '+' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

// Severity tone from |Δ%| (mirrors the desktop `toneFor`): ≥25% danger,
// ≥10% warn, else favorable (ok) / short (fg2). Returned as a token key so the
// never-the-accent guarantee is unit-testable.
export type VarianceTone = 'danger' | 'warn' | 'ok' | 'neutral';
export function varianceTone(row: { pct: number; diff: number }): VarianceTone {
  if (Math.abs(row.pct) >= 25) return 'danger';
  if (Math.abs(row.pct) >= 10) return 'warn';
  return row.diff > 0 ? 'ok' : 'neutral';
}

// ── Variance pill (Δ% colored by severity — never the accent) ────────────────
function VariancePill({ row }: { row: PhoneVarianceRow }) {
  const C = useCmdColors();
  const tone = varianceTone(row);
  const fg = tone === 'danger' ? C.danger : tone === 'warn' ? C.warn : tone === 'ok' ? C.ok : C.fg2;
  const bg = tone === 'danger' ? C.dangerBg : tone === 'warn' ? C.warnBg : tone === 'ok' ? C.okBg : C.panel2;
  return (
    <View
      style={{
        flexShrink: 0,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: CmdRadius.pill,
        borderWidth: 0.5,
        borderColor: fg,
        backgroundColor: bg,
      }}
    >
      <Text style={{ fontFamily: mono(700), fontSize: 9.5, letterSpacing: 0.5, color: fg, fontVariant: ['tabular-nums'] }}>
        {row.pct > 0 ? '+' : ''}{row.pct}%
      </Text>
    </View>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────
function VarianceDetail({ row }: { row: PhoneVarianceRow }) {
  const C = useCmdColors();
  const T = useT();
  const tone = varianceTone(row);
  const deltaColor = tone === 'danger' ? C.danger : tone === 'warn' ? C.warn : tone === 'ok' ? C.ok : C.fg2;

  const rows = [
    { label: T('section.reconciliation.expectedCol'), value: `${row.expected} ${row.unit}` },
    { label: T('section.reconciliation.countedCol'), value: `${row.counted} ${row.unit}` },
    { label: T('section.reconciliation.deltaQtyCol'), value: `${row.diff > 0 ? '+' : ''}${row.diff} ${row.unit}`, tone: deltaColor },
    { label: T('section.reconciliation.deltaDollarCol'), value: signedMoney(row.dollar), tone: deltaColor },
    { label: T('section.reconciliation.deltaPctCol'), value: `${row.pct > 0 ? '+' : ''}${row.pct}%`, tone: deltaColor },
    { label: T('section.reconciliation.catCol'), value: row.category ? row.category.toLowerCase() : '—' },
  ];

  return (
    <View style={{ padding: 16, gap: 16 }}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row' }}>
          <VariancePill row={row} />
        </View>
        <Text style={[PhoneType.detailTitle, { color: C.fg }]}>{row.name}</Text>
      </View>
      <PropertyCard testID="phone-recon-detail-props" title={T('section.reconciliation.phone.detailTitle')} rows={rows} />
    </View>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────
export const PhoneReconciliation: React.FC<{ model: PhoneReconciliationModel }> = ({ model }) => {
  const C = useCmdColors();
  const T = useT();
  const drill = usePhoneDrill<PhoneVarianceRow>();

  const netColor = model.netDollar < 0 ? C.warn : model.netDollar > 0 ? C.ok : C.fg;

  const header = (
    <View style={{ paddingTop: 16, paddingHorizontal: 16, paddingBottom: 8, gap: 4 }}>
      <Text style={[PhoneType.screenTitle, { color: C.fg }]}>{T('section.reconciliation.title')}</Text>
      <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
        {model.rows.length === 0
          ? T('section.reconciliation.phone.subtitleEmpty')
          : T('section.reconciliation.phone.subtitle', {
              count: model.rows.length,
              net: signedMoney(model.netDollar),
            })}
      </Text>
    </View>
  );

  const listNode = (
    <FlatList
      testID="phone-recon-flatlist"
      style={{ flex: 1, minHeight: 0, backgroundColor: C.bg }}
      data={model.rows}
      keyExtractor={(r) => r.id}
      initialNumToRender={14}
      windowSize={9}
      removeClippedSubviews={Platform.OS !== 'web'}
      ListHeaderComponent={
        <>
          {header}
          {model.rows.length > 0 ? <GroupCaption>{T('section.reconciliation.phone.linesGroup')}</GroupCaption> : null}
        </>
      }
      ListFooterComponent={
        model.rows.length > 0 ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: 1, borderTopColor: C.borderStrong, backgroundColor: C.panel2 }}>
            <Text style={[PhoneType.caption, { color: C.fg3, flex: 1 }]}>
              {T('section.reconciliation.netRow', { count: model.rows.length })}
            </Text>
            <Text style={[PhoneType.tableNum, { color: netColor }]}>{signedMoney(model.netDollar)}</Text>
            <Text style={[PhoneType.tableNum, { color: model.netPctOfInv < 0 ? C.warn : model.netPctOfInv > 0 ? C.ok : C.fg }]}>
              {model.netPctOfInv >= 0 ? '+' : ''}{model.netPctOfInv}%
            </Text>
          </View>
        ) : null
      }
      ListEmptyComponent={
        <Text style={[PhoneType.metaMono, { color: C.fg3, padding: 22, textAlign: 'center' }]}>
          {model.latestDate
            ? T('section.reconciliation.phone.noVariances')
            : T('section.reconciliation.phone.noEod')}
        </Text>
      }
      renderItem={({ item: r }) => (
        <TwoLineRow
          testID={`phone-recon-row-${r.id}`}
          pill={<VariancePill row={r} />}
          name={r.name}
          rightValue={
            <Text
              style={[
                PhoneType.tableNum,
                { color: varianceTone(r) === 'danger' ? C.danger : varianceTone(r) === 'warn' ? C.warn : varianceTone(r) === 'ok' ? C.ok : C.fg2 },
              ]}
            >
              {signedMoney(r.dollar)}
            </Text>
          }
          meta={
            <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
              {T('section.reconciliation.phone.rowMeta', {
                expected: `${r.expected} ${r.unit}`,
                counted: `${r.counted} ${r.unit}`,
              })}
            </Text>
          }
          onPress={() => drill.open(r)}
        />
      )}
    />
  );

  return (
    <PhoneDrillScaffold
      testID="phone-reconciliation"
      parentCaption={T('section.reconciliation.phone.parentCaption')}
      onBack={drill.close}
      list={listNode}
      detail={drill.selected ? <VarianceDetail row={drill.selected} /> : null}
    />
  );
};

export default PhoneReconciliation;
