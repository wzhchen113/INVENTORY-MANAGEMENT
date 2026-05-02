import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatCard } from '../../../components/cmd/StatCard';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { useStockSeries } from '../../../lib/cmdSelectors';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

interface VarianceRow {
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

// Pattern C — stream/report. Variance report comparing latest EOD count
// against the previous period's count (the closest available proxy for
// "expected from POS depletion + waste log + receiving" until POS data
// lands). Single full-width table with a NET footer row.
export default function ReconciliationSection() {
  const C = useCmdColors();
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);

  const [tabId, setTabId] = React.useState('variance.tsx');

  // Latest EOD submission for this store
  const latest = React.useMemo(() => {
    const sorted = eodSubmissions
      .filter((s) => s.storeId === currentStore.id)
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date));
    return sorted[0];
  }, [eodSubmissions, currentStore.id]);

  // Previous EOD (immediately before latest, same store) to derive "expected"
  const previous = React.useMemo(() => {
    if (!latest) return undefined;
    const sorted = eodSubmissions
      .filter((s) => s.storeId === currentStore.id && s.date < latest.date)
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date));
    return sorted[0];
  }, [eodSubmissions, latest, currentStore.id]);

  const rows = React.useMemo<VarianceRow[]>(() => {
    if (!latest) return [];
    const itemsById = new Map(inventory.map((i) => [i.id, i]));
    const prevById = new Map((previous?.entries || []).map((e) => [e.itemId, e.actualRemaining]));
    const out: VarianceRow[] = [];
    for (const e of latest.entries || []) {
      const item = itemsById.get(e.itemId);
      if (!item) continue;
      const expected = prevById.get(e.itemId) ?? e.actualRemaining;
      const counted = e.actualRemaining;
      const diff = +(counted - expected).toFixed(2);
      const dollar = +(diff * item.costPerUnit).toFixed(2);
      const pct = expected > 0 ? Math.round((diff / expected) * 100) : 0;
      out.push({
        id: e.itemId,
        name: e.itemName,
        category: item.category,
        unit: item.unit,
        expected,
        counted,
        diff,
        dollar,
        pct,
      });
    }
    return out
      .filter((r) => r.diff !== 0)
      .sort((a, b) => Math.abs(b.dollar) - Math.abs(a.dollar));
  }, [latest, previous, inventory]);

  const netDollar = rows.reduce((s, r) => s + r.dollar, 0);
  const netPct =
    rows.length > 0
      ? Math.round(rows.reduce((s, r) => s + r.pct, 0) / rows.length * 10) / 10
      : 0;
  const inventoryValue = inventory
    .filter((i) => i.storeId === currentStore.id)
    .reduce((s, i) => s + i.currentStock * i.costPerUnit, 0);
  const netPctOfInv = inventoryValue > 0 ? +(netDollar / inventoryValue * 100).toFixed(1) : 0;
  const favorable = rows.filter((r) => r.diff > 0).length;
  const short = rows.filter((r) => r.diff < 0).length;
  const largest = rows[0];

  const toneFor = (r: VarianceRow): string => {
    if (Math.abs(r.pct) >= 25) return C.danger;
    if (Math.abs(r.pct) >= 10) return C.warn;
    return r.diff > 0 ? C.ok : C.fg2;
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, minWidth: 0 }}>
      <TabStrip
        tabs={[
          { id: 'variance.tsx',   label: 'variance.tsx' },
          { id: 'byCategory.tsx', label: 'byCategory.tsx' },
          { id: 'timeline.tsx',   label: 'timeline.tsx' },
        ]}
        activeId={tabId}
        onChange={setTabId}
        rightSlot={
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}>
              <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>EXPORT</Text>
            </View>
            <View style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}>
              <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>POST → COGS</Text>
            </View>
          </View>
        }
      />
      <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
        <View>
          <Text style={[Type.h1, { color: C.fg }]}>
            Reconciliation{latest ? ` · ${latest.date}` : ''}
          </Text>
          <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
            Counted EOD vs expected (prior period). Post-shrink to GL when reviewed.
          </Text>
        </View>

        <View style={{ flexDirection: 'row', gap: 10 }}>
          <StatCard
            label="Items reconciled"
            value={`${latest?.entries?.length ?? 0} / ${latest?.entries?.length ?? 0}`}
            sub={latest ? '100% complete' : 'no EOD yet'}
          />
          <StatCard
            label="Net variance"
            value={`${netDollar < 0 ? '−' : netDollar > 0 ? '+' : ''}$${Math.abs(netDollar).toFixed(2)}`}
            sub={`${netPctOfInv >= 0 ? '+' : ''}${netPctOfInv}% of inventory`}
          />
          <StatCard label="Items off" value={String(rows.length)} sub={`${favorable} favorable · ${short} short`} />
          <StatCard
            label="Largest"
            value={largest ? `${largest.dollar < 0 ? '−' : '+'}$${Math.abs(largest.dollar).toFixed(2)}` : '—'}
            sub={largest?.name || 'no variances'}
          />
        </View>

        <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
            <SectionCaption tone="fg3" size={10.5}>variance_report.tsv</SectionCaption>
            <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
              {rows.length} lines · sorted by |Δ$|
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 60 }}>id</Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>name</Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>expected</Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>counted</Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>Δ qty</Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>Δ $</Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 70, textAlign: 'right' }}>Δ %</Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>cat</Text>
          </View>
          {rows.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              {latest ? 'no variances vs prior period' : 'no EOD submissions yet'}
            </Text>
          ) : (
            <>
              {rows.map((r, i) => {
                const tone = toneFor(r);
                return (
                  <View
                    key={r.id}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingVertical: 9,
                      paddingHorizontal: 14,
                      gap: 10,
                      borderTopWidth: i === 0 ? 0 : 1,
                      borderTopColor: C.border,
                    }}
                  >
                    <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 60 }}>{shortId(r.id)}</Text>
                    <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1 }} numberOfLines={1}>
                      {r.name}
                    </Text>
                    <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 90, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                      {r.expected} {r.unit}
                    </Text>
                    <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg, width: 90, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                      {r.counted} {r.unit}
                    </Text>
                    <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: tone, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                      {r.diff > 0 ? '+' : ''}{r.diff}
                    </Text>
                    <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: tone, width: 90, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                      {r.dollar > 0 ? '+$' : '−$'}{Math.abs(r.dollar).toFixed(2)}
                    </Text>
                    <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: tone, width: 70, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                      {r.pct > 0 ? '+' : ''}{r.pct}%
                    </Text>
                    <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, width: 80, textAlign: 'right' }}>
                      {r.category.toLowerCase()}
                    </Text>
                  </View>
                );
              })}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  padding: 14,
                  gap: 10,
                  borderTopWidth: 1,
                  borderTopColor: C.borderStrong,
                  backgroundColor: C.panel2,
                }}
              >
                <View style={{ width: 60 }} />
                <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>
                  Net · {rows.length} lines
                </Text>
                <View style={{ width: 90 }} />
                <View style={{ width: 90 }} />
                <View style={{ width: 80 }} />
                <Text style={{ fontFamily: mono(700), fontSize: 12, color: netDollar < 0 ? C.warn : netDollar > 0 ? C.ok : C.fg, width: 90, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                  {netDollar < 0 ? '−' : netDollar > 0 ? '+' : ''}${Math.abs(netDollar).toFixed(2)}
                </Text>
                <Text style={{ fontFamily: mono(700), fontSize: 12, color: netPctOfInv < 0 ? C.warn : netPctOfInv > 0 ? C.ok : C.fg, width: 70, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                  {netPctOfInv >= 0 ? '+' : ''}{netPctOfInv}%
                </Text>
                <View style={{ width: 80 }} />
              </View>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
