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
import { useT } from '../../../hooks/useT';

// Spec 016 (REPORTS-1) — Reports section is a real runner foundation now.
// Catalog tiles derive from `templates.ts` (single source of truth shared with
// NewReportModal). Saved-report tiles open an in-section detail frame
// (`view: 'list' | 'detail'` local state) — mirrors the InventoryDesktopLayout
// drill-down pattern rather than a separate Cmd sidebar section or URL hash.
//
// Catalog tiles render no fake numbers in REPORTS-1 — every template still
// returned the `not_implemented` envelope from the dispatcher. The historical
// progression (REPORTS-2 flipped `cogs` to `'live'`, REPORTS-3 flipped
// `variance`) is captured in `templates.ts`; the remaining four templates
// (`waste` / `vendor` / `velocity` / `custom`) still return `not_implemented`
// until their own specs land.
//
// Spec 017 (REPORTS-2) — per-definition override state for the `range:` and
// `by:` chips. The override is in-memory only (never mutated onto the saved
// definition); when present, the next RUN sends merged params. Stored in a
// Map keyed by definitionId so switching between saved reports preserves
// each report's override.

interface OverrideState {
  range?: { range: string; from: string; to: string };
  // Spec 034 — `waste` runs admit a third grouping `'reason'`.
  // Spec 035 — `vendor` adds `'vendor'`.
  // Spec 036 — `velocity` adds `'recipe'`. COGS and other templates
  // continue to ignore unknown values if a user somehow saved them on
  // a non-velocity definition — the RPC coerces unknown `by:` values
  // to its own default. Keeping the union wide here avoids
  // per-template override-state shapes.
  by?: 'reason' | 'vendor' | 'recipe' | 'category' | 'item';
}

export default function ReportsSection() {
  const C = useCmdColors();
  const T = useT();
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

  // Spec 017 — chip overrides per definition. A `Map` survives re-renders
  // (we re-set into the same instance to trigger React state churn) and lets
  // us read `overrides.get(id)` cheaply without rebuilding the whole record.
  // Switching between saved reports preserves each report's override so a
  // user toggling between two open tabs (mental model) sees their state.
  const [overrides, setOverrides] = React.useState<Map<string, OverrideState>>(() => new Map());

  // Direct slice reads. The store's initial state guarantees these are
  // always defined ([] and {}). The `|| []` / `|| {}` fallback used to be
  // here was both dead AND created a fresh literal reference each render —
  // Zustand sees a new ref and notifies all subscribers, which can cascade
  // into a "Maximum update depth exceeded" loop if any consumer's deps
  // include the selected value.
  const savedReports = useStore((s) => s.savedReports);
  const reportRuns = useStore((s) => s.reportRuns);
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

  // Spec 017 — reconcile the overrides Map against the current list of
  // saved reports. Removes entries whose definitionId no longer exists in
  // `myReports` (deletion path — both the local inline-delete button and
  // a realtime delete from another tab). Prevents the Map from
  // accumulating stale entries over the component's lifetime.
  React.useEffect(() => {
    setOverrides((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(myReports.map((r) => r.id));
      let changed = false;
      const next = new Map(prev);
      for (const id of Array.from(next.keys())) {
        if (!valid.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      // Returning the same reference when nothing changed avoids a needless
      // render churn — Zustand subscribers don't care about this state.
      return changed ? next : prev;
    });
  }, [myReports]);

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

  // Spec 017 — override mutators. Each replaces the Map entry for the
  // current definition; we always clone the Map so React notices the change.
  const setOverrideRange = (range: { range: string; from: string; to: string }) => {
    if (!selectedDefinitionId) return;
    setOverrides((prev) => {
      const next = new Map(prev);
      const cur = next.get(selectedDefinitionId) || {};
      next.set(selectedDefinitionId, { ...cur, range });
      return next;
    });
  };
  const setOverrideBy = (by: 'reason' | 'vendor' | 'recipe' | 'category' | 'item') => {
    if (!selectedDefinitionId) return;
    setOverrides((prev) => {
      const next = new Map(prev);
      const cur = next.get(selectedDefinitionId) || {};
      next.set(selectedDefinitionId, { ...cur, by });
      return next;
    });
  };
  const resetOverrides = () => {
    if (!selectedDefinitionId) return;
    setOverrides((prev) => {
      const next = new Map(prev);
      next.delete(selectedDefinitionId);
      return next;
    });
  };

  const onRun = () => {
    if (!selectedDefinitionId) return;
    setRunning(true);
    // Spec 017 — build the optional override from the chip state for this
    // definition. The store's `runReport` second arg merges over the saved
    // `definition.params` for THIS run only — the saved definition is not
    // mutated. Undefined override = REPORTS-1 behaviour (no merge).
    // Spec 018 — variance ignores `range`/`by` keys (it computes anchor
    // semantics directly from `from`/`to`). We omit them from the merged
    // override to keep the persisted `report_runs.params` clean rather
    // than leaking COGS-shaped vocabulary into the variance audit trail.
    const over = overrides.get(selectedDefinitionId);
    const definitionIsVariance = selectedDefinition?.templateId === 'variance';
    const mergedOverride: Record<string, unknown> | undefined = over
      ? {
          ...(over.range
            ? (definitionIsVariance
                ? { from: over.range.from, to: over.range.to }
                : { range: over.range.range, from: over.range.from, to: over.range.to })
            : {}),
          ...(over.by && !definitionIsVariance ? { by: over.by } : {}),
        }
      : undefined;
    runReport(selectedDefinitionId, mergedOverride);
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

  // Spec 017 — derive which template the selected definition belongs to so
  // we can gate the chip-dropdown wiring on `status === 'live'`. Preview
  // templates keep the read-only chip strip behaviour from REPORTS-1.
  // Spec 018 — variance has no by-mode (per-item only); we gate the
  // overrideBy/onByChange props so the frame hides the `by:` chip and the
  // overrides map never gets a `by` key for a variance definition.
  // Spec 037 — custom has neither range nor by-axis semantics; we gate
  // BOTH override props off so the frame hides both chips AND the
  // overrides Map never gets stale entries for a custom definition.
  const selectedTemplate = selectedDefinition
    ? findTemplate(selectedDefinition.templateId)
    : undefined;
  const selectedIsLive = selectedTemplate?.status === 'live';
  const selectedSupportsBy = selectedIsLive && selectedTemplate?.id !== 'variance' && selectedTemplate?.id !== 'custom';
  const selectedSupportsRange = selectedIsLive && selectedTemplate?.id !== 'custom';
  const selectedOverride = selectedDefinitionId ? overrides.get(selectedDefinitionId) : undefined;

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
          overrideRange={selectedSupportsRange ? (selectedOverride?.range ?? null) : null}
          onRangeChange={selectedSupportsRange ? setOverrideRange : undefined}
          overrideBy={selectedSupportsBy ? (selectedOverride?.by ?? null) : null}
          onByChange={selectedSupportsBy ? setOverrideBy : undefined}
          onResetOverrides={selectedSupportsRange ? resetOverrides : undefined}
        />
      ) : (
      <ScrollView contentContainerStyle={{ padding: 22, gap: 18 }}>
        <View>
          <Text style={[Type.h1, { color: C.fg }]}>{T('section.reports.title')}</Text>
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
                        // Spec 017 — pair the deletion with an immediate
                        // overrides Map cleanup. The reconcile-on-myReports
                        // useEffect above is a belt-and-suspenders safety
                        // net for realtime deletes from another tab, but
                        // doing it inline here closes the gap during the
                        // optimistic-then-revert window.
                        setOverrides((prev) => {
                          if (!prev.has(r.id)) return prev;
                          const next = new Map(prev);
                          next.delete(r.id);
                          return next;
                        });
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
