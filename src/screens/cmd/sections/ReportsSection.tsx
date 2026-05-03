import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { NewReportModal } from '../../../components/cmd/NewReportModal';
import { useStore } from '../../../store/useStore';
import { relativeTime } from '../../../utils/relativeTime';

interface ReportTile {
  id: string;
  name: string;
  desc: string;
  schedule: 'daily' | 'weekly' | 'monthly' | 'on-demand';
  owner: string;
  updated: string;
  sample: string;
  tone?: 'ok' | 'warn' | 'danger';
}

const REPORTS: ReportTile[] = [
  { id: 'r-01', name: 'Food cost trend',      desc: 'COGS % vs target over 90d',  schedule: 'weekly',    owner: 'AD', updated: '12m', sample: '31.4%',     tone: 'warn' },
  { id: 'r-02', name: 'Top movers',           desc: 'Items by qty depleted (7d)', schedule: 'on-demand', owner: 'AD', updated: '2h',  sample: 'salmon' },
  { id: 'r-03', name: 'Waste analysis',       desc: '$ + reasons by category',    schedule: 'weekly',    owner: 'AD', updated: '1d',  sample: '$412/wk',   tone: 'warn' },
  { id: 'r-04', name: 'Vendor scorecard',     desc: 'On-time, cost, quality',     schedule: 'monthly',   owner: 'AD', updated: '5d',  sample: '96% OTD',   tone: 'ok' },
  { id: 'r-05', name: 'Recipe profitability', desc: 'Margin × volume',            schedule: 'on-demand', owner: 'AD', updated: '1d',  sample: 'salmon top' },
  { id: 'r-06', name: 'Variance summary',     desc: 'EOD shrink trends',          schedule: 'daily',     owner: 'AD', updated: '8h',  sample: '−0.5%',     tone: 'warn' },
  { id: 'r-07', name: 'Inventory aging',      desc: 'Days on hand by category',   schedule: 'weekly',    owner: 'AD', updated: '2d',  sample: '4.2d avg' },
  { id: 'r-08', name: 'Reorder forecast',     desc: 'Predicted needs (14d)',      schedule: 'daily',     owner: 'AD', updated: '1h',  sample: '$2,148' },
];

// Pattern C — stream/report. 2-column grid of report tiles. Tiles render
// as static panels for Phase 10a — the real report-runner UI is a separate
// surface that hasn't been designed yet.
export default function ReportsSection() {
  const C = useCmdColors();
  const [tabId, setTabId] = React.useState('library.tsx');
  const [newOpen, setNewOpen] = React.useState(false);
  const savedReports = useStore((s) => s.savedReports || []);
  const currentStore = useStore((s) => s.currentStore);
  const deleteReportDefinition = useStore((s) => s.deleteReportDefinition);
  const myReports = React.useMemo(
    () => savedReports.filter((r) => r.storeId === currentStore.id),
    [savedReports, currentStore.id],
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, minWidth: 0 }}>
      <TabStrip
        tabs={[
          { id: 'library.tsx',   label: 'library.tsx' },
          { id: 'scheduled.tsx', label: 'scheduled.tsx' },
          { id: 'custom.tsx',    label: 'custom.tsx' },
        ]}
        activeId={tabId}
        onChange={setTabId}
        rightSlot={
          <TouchableOpacity onPress={() => setNewOpen(true)} style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}>
            <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>+ NEW REPORT</Text>
          </TouchableOpacity>
        }
      />
      <ScrollView contentContainerStyle={{ padding: 22, gap: 18 }}>
        <View>
          <Text style={[Type.h1, { color: C.fg }]}>Reports</Text>
          <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
            Pre-built dashboards. The report-runner UI is awaiting design handoff — tiles preview the catalog.
          </Text>
        </View>

        {myReports.length > 0 ? (
          <View>
            <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>
              your reports · {myReports.length}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
              {myReports.map((r) => (
                <View
                  key={r.id}
                  style={{
                    flexBasis: '48%', flexGrow: 1, minWidth: 320,
                    backgroundColor: C.panel, borderRadius: CmdRadius.lg,
                    borderWidth: 1, borderColor: C.accent,
                    padding: 14, gap: 6,
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
                    <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>{r.id.slice(0, 8)}</Text>
                    <View style={{ flex: 1 }} />
                    <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.accentBg }}>
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.accent, letterSpacing: 0.4 }}>{r.templateId.toUpperCase()}</Text>
                    </View>
                  </View>
                  <Text style={{ fontFamily: sans(700), fontSize: 15, color: C.fg, letterSpacing: -0.2 }}>{r.name}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: C.border, borderStyle: 'dashed', paddingTop: 10, marginTop: 4 }}>
                    <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>saved {relativeTime(r.createdAt) || 'just now'} ago · scope: {r.scope || 'this_store'}</Text>
                    <View style={{ flex: 1 }} />
                    <TouchableOpacity onPress={() => deleteReportDefinition(r.id)} style={{ paddingHorizontal: 7, paddingVertical: 2 }}>
                      <Text style={{ fontFamily: mono(600), fontSize: 11, color: C.danger }}>⌫ delete</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: myReports.length > 0 ? 4 : 0 }}>
          template catalog
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
          {REPORTS.map((r) => (
            <View
              key={r.id}
              style={{
                flexBasis: '48%',
                flexGrow: 1,
                minWidth: 320,
                backgroundColor: C.panel,
                borderRadius: CmdRadius.lg,
                borderWidth: 1,
                borderColor: C.border,
                padding: 14,
                gap: 8,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>{r.id}</Text>
                <View
                  style={{
                    paddingHorizontal: 7,
                    paddingVertical: 2,
                    borderRadius: 3,
                    backgroundColor: C.panel2,
                  }}
                >
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg2, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                    {r.schedule}
                  </Text>
                </View>
              </View>
              <Text style={{ fontFamily: sans(700), fontSize: 15, color: C.fg, letterSpacing: -0.2 }}>
                {r.name}
              </Text>
              <Text style={{ fontFamily: sans(400), fontSize: 12.5, color: C.fg2 }}>{r.desc}</Text>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  borderTopWidth: 1,
                  borderTopColor: C.border,
                  borderStyle: 'dashed',
                  paddingTop: 10,
                  marginTop: 4,
                }}
              >
                <Text
                  style={{
                    fontFamily: mono(600),
                    fontSize: 18,
                    color: r.tone === 'warn' ? C.warn : r.tone === 'ok' ? C.ok : r.tone === 'danger' ? C.danger : C.fg,
                    letterSpacing: -0.3,
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {r.sample}
                </Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
                  updated {r.updated} · {r.owner}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>

      <NewReportModal visible={newOpen} onClose={() => setNewOpen(false)} />
    </View>
  );
}
