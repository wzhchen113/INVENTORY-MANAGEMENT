import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { NewReportModal } from '../../../components/cmd/NewReportModal';
import { useStore } from '../../../store/useStore';
import { relativeTime } from '../../../utils/relativeTime';
import { ReportDefinition } from '../../../types';
import { TEMPLATES, findTemplate, defaultReportName } from './reports/templates';
import { ReportDetailFrame } from './reports/ReportDetailFrame';

// Spec 016 (REPORTS-1) — Reports section is a real runner foundation now.
// Catalog tiles derive from `templates.ts` (single source of truth shared with
// NewReportModal). Saved-report tiles open an in-section detail frame
// (`view: 'list' | 'detail'` local state) — mirrors the InventoryDesktopLayout
// drill-down pattern rather than a separate Cmd sidebar section or URL hash.
//
// Catalog tiles render no fake numbers in REPORTS-1 — every template still
// returns the `not_implemented` envelope from the dispatcher. REPORTS-2 will
// flip `cogs` to `status: 'live'`, REPORTS-3 will flip `variance`.
export default function ReportsSection() {
  const C = useCmdColors();
  const [tabId, setTabId] = React.useState('library.tsx');

  // Section-local view state. `'list'` is the catalog + saved-reports grid;
  // `'detail'` swaps the body for ReportDetailFrame. We keep this in section
  // state (per the spec's Open question 3 resolution) so the Cmd sidebar
  // doesn't need a per-saved-report entry.
  const [view, setView] = React.useState<'list' | 'detail'>('list');
  const [selectedDefinitionId, setSelectedDefinitionId] = React.useState<string | null>(null);

  // `null` = modal closed. When set, NewReportModal opens pre-seeded with the
  // chosen template id + name (catalog-tile click) or the historical default
  // (top-right `+ NEW REPORT` button → variance).
  const [newOpenWithTemplate, setNewOpenWithTemplate] = React.useState<
    { id: ReportDefinition['templateId']; name: string } | null
  >(null);

  // RUN-button in-flight indicator surfaced to the detail frame. We track it
  // locally rather than introducing a store-level loading flag — the store
  // action already handles optimistic-then-revert via `notifyBackendError`.
  const [running, setRunning] = React.useState(false);

  const savedReports = useStore((s) => s.savedReports || []);
  const reportRuns = useStore((s) => s.reportRuns || {});
  const currentStore = useStore((s) => s.currentStore);
  const deleteReportDefinition = useStore((s) => s.deleteReportDefinition);
  const runReport = useStore((s) => s.runReport);
  const loadLatestRun = useStore((s) => s.loadLatestRun);

  const myReports = React.useMemo(
    () => savedReports.filter((r) => r.storeId === currentStore.id),
    [savedReports, currentStore.id],
  );

  // Resolve the open-detail definition. If it's been deleted (e.g. another
  // tab) while detail was open, snap back to the list view.
  const selectedDefinition = React.useMemo(
    () => (selectedDefinitionId ? myReports.find((r) => r.id === selectedDefinitionId) : undefined),
    [myReports, selectedDefinitionId],
  );

  React.useEffect(() => {
    if (view === 'detail' && selectedDefinitionId && !selectedDefinition) {
      setView('list');
      setSelectedDefinitionId(null);
    }
  }, [view, selectedDefinitionId, selectedDefinition]);

  // Lazy-load the latest run when the detail view opens for a definition.
  React.useEffect(() => {
    if (view === 'detail' && selectedDefinitionId) {
      loadLatestRun(selectedDefinitionId);
    }
  }, [view, selectedDefinitionId, loadLatestRun]);

  // Web-only Escape shortcut to close the detail view. Native back is handled
  // by the explicit BACK button in ReportDetailFrame's header.
  React.useEffect(() => {
    if (Platform.OS !== 'web' || view !== 'detail') return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setView('list');
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [view]);

  const onCatalogTilePress = (templateId: ReportDefinition['templateId']) => {
    const tpl = findTemplate(templateId);
    if (!tpl) return;
    setNewOpenWithTemplate({ id: templateId, name: defaultReportName(tpl) });
  };

  const onNewReportPress = () => {
    const tpl = findTemplate('variance');
    if (!tpl) return;
    setNewOpenWithTemplate({ id: 'variance', name: defaultReportName(tpl) });
  };

  const onSavedReportPress = (definitionId: string) => {
    setSelectedDefinitionId(definitionId);
    setView('detail');
  };

  const onRun = () => {
    if (!selectedDefinitionId) return;
    setRunning(true);
    runReport(selectedDefinitionId);
    // The store action is fire-and-forget; `runReport` keeps the optimistic
    // pending row in `reportRuns[definitionId]` until the RPC resolves. We
    // clear the local `running` flag on the next microtask — the frame will
    // continue to read `latestRun.status === 'pending'` from the store while
    // the request is in flight, so the RUN button stays disabled regardless.
    Promise.resolve().then(() => setRunning(false));
  };

  const onBack = () => {
    setView('list');
  };

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
          <TouchableOpacity onPress={onNewReportPress} style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}>
            {/* `accentFg` adapts to light/dark — closes spec 016 code-reviewer Should-fix #6. */}
            <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.accentFg }}>+ NEW REPORT</Text>
          </TouchableOpacity>
        }
      />
      {tabId === 'scheduled.tsx' ? (
        <ReportsScheduledPlaceholder />
      ) : tabId === 'custom.tsx' ? (
        <ReportsCustomPlaceholder />
      ) : view === 'detail' && selectedDefinition ? (
        <ReportDetailFrame
          definition={selectedDefinition}
          latestRun={reportRuns[selectedDefinition.id] ?? null}
          onRun={onRun}
          onBack={onBack}
          running={running}
        />
      ) : (
      <ScrollView contentContainerStyle={{ padding: 22, gap: 18 }}>
        <View>
          <Text style={[Type.h1, { color: C.fg }]}>Reports</Text>
          <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
            Pick a template to save a report, or open a saved one to run it.
          </Text>
        </View>

        {myReports.length > 0 ? (
          <View>
            <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>
              your reports · {myReports.length}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
              {myReports.map((r) => (
                <TouchableOpacity
                  key={r.id}
                  activeOpacity={0.85}
                  onPress={() => onSavedReportPress(r.id)}
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
                    <TouchableOpacity
                      onPress={(e: any) => {
                        // Prevent the parent saved-report tile from also firing
                        // (which would open the detail view for a row we just
                        // deleted). On web the synthetic event is a real DOM
                        // event; on native React Native still surfaces a
                        // PressEvent with stopPropagation. Both honour the call.
                        if (e && typeof e.stopPropagation === 'function') {
                          e.stopPropagation();
                        }
                        deleteReportDefinition(r.id);
                      }}
                      style={{ paddingHorizontal: 7, paddingVertical: 2 }}
                    >
                      <Text style={{ fontFamily: mono(600), fontSize: 11, color: C.danger }}>⌫ delete</Text>
                    </TouchableOpacity>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ) : null}

        <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: myReports.length > 0 ? 4 : 0 }}>
          template catalog
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
          {TEMPLATES.map((r) => (
            <TouchableOpacity
              key={r.id}
              activeOpacity={0.85}
              onPress={() => onCatalogTilePress(r.id)}
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
                {r.status === 'preview' ? (
                  <View
                    style={{
                      paddingHorizontal: 7,
                      paddingVertical: 2,
                      borderRadius: 3,
                      backgroundColor: C.panel2,
                    }}
                  >
                    <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg2, letterSpacing: 0.5 }}>
                      PREVIEW
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text style={{ fontFamily: sans(700), fontSize: 15, color: C.fg, letterSpacing: -0.2 }}>
                {r.name}
              </Text>
              <Text style={{ fontFamily: sans(400), fontSize: 12.5, color: C.fg2 }}>{r.sub}</Text>
              <Text
                style={{
                  fontFamily: mono(400),
                  fontSize: 10.5,
                  color: C.fg3,
                }}
                numberOfLines={1}
              >
                {r.cols}
              </Text>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'baseline',
                  borderTopWidth: 1,
                  borderTopColor: C.border,
                  borderStyle: 'dashed',
                  paddingTop: 10,
                  marginTop: 4,
                }}
              >
                <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
                  range: this month · cols: {r.cols.split('·').length}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
      )}

      <NewReportModal
        visible={newOpenWithTemplate !== null}
        initialTemplateId={newOpenWithTemplate?.id}
        initialName={newOpenWithTemplate?.name}
        onClose={() => setNewOpenWithTemplate(null)}
      />
    </View>
  );
}

// ─── scheduled.tsx + custom.tsx (Tier 2 — needs scheduling infra) ─────
function ReportsScheduledPlaceholder() {
  const C = useCmdColors();
  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>reports · scheduled</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          Recurring jobs against library.tsx templates · cadence · recipients · run log.
        </Text>
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 22, alignItems: 'center', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>NOT YET WIRED</Text>
        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 460 }}>
          Needs `report_schedules` + `report_runs` tables + a Supabase cron job — coming in a follow-up migration.
        </Text>
      </View>
    </ScrollView>
  );
}

function ReportsCustomPlaceholder() {
  const C = useCmdColors();
  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>reports · custom</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          Query builder against the underlying .tsv tables · save-as-template (→ library) or schedule.
        </Text>
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 22, alignItems: 'center', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>NOT YET WIRED</Text>
        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 460 }}>
          Needs a query-builder UI + a serverside SQL exec/sandbox — coming in a follow-up migration.
        </Text>
      </View>
    </ScrollView>
  );
}
