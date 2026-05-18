import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatCard } from '../../../components/cmd/StatCard';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { useStockSeries, computeVarianceLines } from '../../../lib/cmdSelectors';
import { useT } from '../../../hooks/useT';

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
  const T = useT();
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const inventory = useStore((s) => s.inventory);
  const stores = useStore((s) => s.stores);
  const currentStore = useStore((s) => s.currentStore);

  const [tabId, setTabId] = React.useState('variance.tsx');

  // Latest EOD submission for this store — kept for the screen subtitle
  // (`Reconciliation · {date}`). The variance math itself moved to
  // computeVarianceLines() in cmdSelectors per spec 009 §2.
  const latest = React.useMemo(() => {
    const sorted = eodSubmissions
      .filter((s) => s.storeId === currentStore.id)
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date));
    return sorted[0];
  }, [eodSubmissions, currentStore.id]);

  // Spec 009 §2 / R3: rows now come from the shared selector. Map the
  // selector's VarianceLine shape to the screen's local VarianceRow
  // shape so the existing render code stays unchanged. priorEod mode
  // matches the prior inline math one-for-one (diff = counted -
  // priorEodActualRemaining, dollar = diff * costPerUnit, pct rounded).
  const rows = React.useMemo<VarianceRow[]>(() => {
    const lines = computeVarianceLines(currentStore.id, inventory, eodSubmissions, stores, 'priorEod');
    const itemsById = new Map(inventory.map((i) => [i.id, i]));
    return lines
      .map<VarianceRow>((l) => {
        const item = itemsById.get(l.itemId);
        return {
          id: l.itemId,
          name: l.itemName,
          category: item?.category || '',
          unit: l.unit,
          expected: l.expected,
          counted: l.counted,
          diff: l.delta,
          dollar: l.deltaCost,
          pct: l.expected > 0 ? Math.round((l.delta / l.expected) * 100) : 0,
        };
      })
      .sort((a, b) => Math.abs(b.dollar) - Math.abs(a.dollar));
  }, [currentStore.id, inventory, eodSubmissions, stores]);

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
              <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>{T('section.reconciliation.export')}</Text>
            </View>
            <View style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}>
              <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>{T('section.reconciliation.postToCogs')}</Text>
            </View>
          </View>
        }
      />
      {tabId === 'byCategory.tsx' ? (
        <ReconByCategoryTab />
      ) : tabId === 'timeline.tsx' ? (
        <ReconTimelineTab />
      ) : (
      <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
        <View>
          <Text style={[Type.h1, { color: C.fg }]}>
            {latest ? T('section.reconciliation.titleWithDate', { date: latest.date }) : T('section.reconciliation.title')}
          </Text>
          <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
            {T('section.reconciliation.subtitle')}
          </Text>
        </View>

        <View style={{ flexDirection: 'row', gap: 10 }}>
          <StatCard
            label={T('section.reconciliation.itemsReconciled')}
            value={`${latest?.entries?.length ?? 0} / ${latest?.entries?.length ?? 0}`}
            sub={latest ? T('section.reconciliation.percentComplete', { pct: 100 }) : T('section.reconciliation.noEod')}
          />
          <StatCard
            label={T('section.reconciliation.netVariance')}
            value={`${netDollar < 0 ? '−' : netDollar > 0 ? '+' : ''}$${Math.abs(netDollar).toFixed(2)}`}
            sub={T('section.reconciliation.percentOfInventory', { pct: `${netPctOfInv >= 0 ? '+' : ''}${netPctOfInv}` })}
          />
          <StatCard label={T('section.reconciliation.itemsOff')} value={String(rows.length)} sub={T('section.reconciliation.favorableShort', { favorable, short })} />
          <StatCard
            label={T('section.reconciliation.largest')}
            value={largest ? `${largest.dollar < 0 ? '−' : '+'}$${Math.abs(largest.dollar).toFixed(2)}` : '—'}
            sub={largest?.name || T('section.reconciliation.noVariances')}
          />
        </View>

        <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
            <SectionCaption tone="fg3" size={10.5}>{T('section.reconciliation.varianceReportTsv')}</SectionCaption>
            <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
              {T('section.reconciliation.linesSorted', { count: rows.length })}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 60 }}>{T('section.reconciliation.idCol')}</Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>{T('section.reconciliation.nameCol')}</Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>{T('section.reconciliation.expectedCol')}</Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>{T('section.reconciliation.countedCol')}</Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>{T('section.reconciliation.deltaQtyCol')}</Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>{T('section.reconciliation.deltaDollarCol')}</Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 70, textAlign: 'right' }}>{T('section.reconciliation.deltaPctCol')}</Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>{T('section.reconciliation.catCol')}</Text>
          </View>
          {rows.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              {latest ? T('section.reconciliation.noVarianceVsPrior') : T('section.reconciliation.noEodYet')}
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
                  {T('section.reconciliation.netRow', { count: rows.length })}
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
      )}
    </View>
  );
}

// ─── byCategory.tsx — net Δ$ rolled up by ingredient_categories ───────
function ReconByCategoryTab() {
  const C = useCmdColors();
  const T = useT();
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);

  const todayStr = new Date().toISOString().slice(0, 10);
  const todaySub = eodSubmissions.find((s) => s.storeId === currentStore.id && s.date === todayStr);

  const rows = React.useMemo(() => {
    const map = new Map<string, { delta: number; deltaCost: number; n: number }>();
    if (!todaySub?.entries) return [];
    for (const entry of todaySub.entries) {
      const item = inventory.find((i) => i.id === entry.itemId);
      if (!item) continue;
      const expected = item.parLevel || 0;
      const counted = entry.actualRemaining;
      const delta = counted - expected;
      const deltaCost = delta * (item.costPerUnit || 0);
      const cat = item.category || 'uncategorized';
      const cur = map.get(cat) || { delta: 0, deltaCost: 0, n: 0 };
      cur.delta += delta;
      cur.deltaCost += deltaCost;
      cur.n += 1;
      map.set(cat, cur);
    }
    return Array.from(map.entries())
      .map(([cat, v]) => ({ cat, ...v }))
      .sort((a, b) => a.deltaCost - b.deltaCost);
  }, [todaySub, inventory]);

  const drivers = rows.slice(0, 3);
  const totalDelta = rows.reduce((s, r) => s + r.deltaCost, 0);

  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{T('section.reconciliation.byCategoryTitle')}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          {T('section.reconciliation.byCategorySubtitle')}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label={T('section.reconciliation.netDollarAll')} value={`${totalDelta >= 0 ? '+' : '−'}$${Math.abs(totalDelta).toFixed(0)}`} sub={T('section.reconciliation.allCategories')} />
        <StatCard label={T('section.reconciliation.categories')} value={String(rows.length)} sub={T('section.reconciliation.affected')} />
        <StatCard label={T('section.reconciliation.topDriver')} value={drivers[0]?.cat || '—'} sub={drivers[0] ? `$${drivers[0].deltaCost.toFixed(0)}` : '—'} />
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>{T('section.reconciliation.byCategoryTsv')}</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{rows.length}</Text>
        </View>
        {rows.length === 0 ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
            {T('section.reconciliation.noCountToday')}
          </Text>
        ) : (
          rows.map((r, i) => {
            const tone = r.deltaCost <= -25 ? C.danger : r.deltaCost > 0 ? C.ok : C.fg2;
            return (
              <View key={r.cat} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 14, gap: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
                <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1 }} numberOfLines={1}>{r.cat}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 80, textAlign: 'right' }}>
                  {r.n === 1
                    ? T('section.reconciliation.itemSuffix', { count: r.n })
                    : T('section.reconciliation.itemSuffixPlural', { count: r.n })}
                </Text>
                <Text style={{ fontFamily: mono(500), fontSize: 12, color: tone, width: 100, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                  {r.deltaCost >= 0 ? '+' : '−'}${Math.abs(r.deltaCost).toFixed(0)}
                </Text>
              </View>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}

// ─── timeline.tsx — 90d calendar of net variance ──────────────────────
function ReconTimelineTab() {
  const C = useCmdColors();
  const T = useT();
  const eodSubmissions = useStore((s) => s.eodSubmissions);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);

  const days = React.useMemo(() => {
    const out: Array<{ date: string; delta: number; status: 'submitted' | 'missing' }> = [];
    const today = new Date();
    for (let i = 89; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      const sub = eodSubmissions.find((s) => s.storeId === currentStore.id && s.date === iso);
      if (!sub) {
        out.push({ date: iso, delta: 0, status: 'missing' });
        continue;
      }
      let delta = 0;
      for (const entry of sub.entries || []) {
        const item = inventory.find((it) => it.id === entry.itemId);
        if (item) delta += (entry.actualRemaining - (item.parLevel || 0)) * (item.costPerUnit || 0);
      }
      out.push({ date: iso, delta, status: 'submitted' });
    }
    return out;
  }, [eodSubmissions, inventory, currentStore.id]);

  const submittedDays = days.filter((d) => d.status === 'submitted');
  const missing = days.filter((d) => d.status === 'missing').length;

  // Streak detection: consecutive submitted days from today backward.
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].status === 'submitted') streak++;
    else break;
  }

  const max = Math.max(1, ...submittedDays.map((d) => Math.abs(d.delta)));

  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{T('section.reconciliation.timelineTitle')}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          {T('section.reconciliation.timelineSubtitle')}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label={T('section.reconciliation.submitted90d')} value={String(submittedDays.length)} sub={T('section.reconciliation.ofTotal', { total: days.length })} />
        <StatCard label={T('section.reconciliation.missing')} value={String(missing)} sub={T('section.reconciliation.missingDays')} />
        <StatCard label={T('section.reconciliation.streak')} value={`${streak}d`} sub={T('section.reconciliation.consecutive')} />
        <StatCard label={T('section.reconciliation.netDollar90d')} value={`${submittedDays.reduce((s, d) => s + d.delta, 0) >= 0 ? '+' : '−'}$${Math.abs(submittedDays.reduce((s, d) => s + d.delta, 0)).toFixed(0)}`} sub="" />
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>{T('section.reconciliation.timelineDat')}</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{T('section.reconciliation.timelineLegend')}</Text>
        </View>
        <View style={{ paddingHorizontal: 14, paddingVertical: 14, flexDirection: 'row', flexWrap: 'wrap', gap: 3 }}>
          {days.map((d) => {
            const intensity = Math.min(1, Math.abs(d.delta) / max);
            const baseColor =
              d.status === 'missing' ? C.fg3
              : d.delta < -25 ? C.danger
              : d.delta > 0 ? C.ok
              : C.warn;
            const op = d.status === 'missing' ? 0.25 : 0.4 + intensity * 0.55;
            return (
              <View
                key={d.date}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 2,
                  backgroundColor: baseColor,
                  opacity: op,
                  borderWidth: d.status === 'missing' ? 1 : 0,
                  borderColor: C.border,
                  borderStyle: 'dashed',
                }}
              />
            );
          })}
        </View>
      </View>
    </ScrollView>
  );
}
