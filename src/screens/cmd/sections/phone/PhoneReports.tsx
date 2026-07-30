// src/screens/cmd/sections/phone/PhoneReports.tsx — Spec 147.
//
// Phone tier of the Reports screen (design handoff README §7-17 — "Reports (+
// NEW REPORT; READY/RUNNING/QUEUED pills)"). The desktop TabStrip + flex-wrap
// template/saved-report card grid + desktop ReportDetailFrame becomes a
// full-width saved-report list → full-screen detail. Row = name + status pill
// (READY/RUNNING/QUEUED/FAILED) + last-run meta. Tap opens the detail, which
// lazy-loads the latest run (loadLatestRun), renders the run's KPIs (phone-safe
// label/value pairs) and offers a 48px RUN REPORT primary (runReport). The full
// result TABLE and the report BUILDER (+ NEW REPORT) stay desktop-only and
// surface an honest toast / an honest note (per the handoff's "desktop-only
// edit actions surface honest toasts" rule).
//
// PRESENTATIONAL / direct-store — reads the same savedReports / reportRuns /
// currentStore slices and reuses the same runReport / loadLatestRun store
// actions the desktop section uses (no forked orchestration).
//
// Hard Rules honored: full report names (flex:1, ellipsize past the full
// width), no card grid, one vertical scroll, every tappable ≥44×44, status
// pills use semantic tokens — never the accent.

import React from 'react';
import { View, Text, TouchableOpacity, FlatList, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useStore } from '../../../../store/useStore';
import { useT } from '../../../../hooks/useT';
import { relativeTime } from '../../../../utils/relativeTime';
import { GroupCaption, PropertyCard, TwoLineRow } from './PhoneWidgets';
import { PhoneDrillScaffold } from './PhoneDrillScaffold';
import { usePhoneDrill } from './usePhoneDrill';
import type { ReportDefinition, ReportRun } from '../../../../types';

// Run status → pill state. No run yet = QUEUED (never run); pending = RUNNING;
// ok = READY; error = FAILED. Returned as a token key so the never-the-accent
// guarantee is unit-testable.
export type ReportPillState = 'ready' | 'running' | 'queued' | 'failed';
export function reportPillState(run: ReportRun | null | undefined): ReportPillState {
  if (!run) return 'queued';
  if (run.status === 'pending') return 'running';
  if (run.status === 'error') return 'failed';
  return 'ready';
}

function ReportStatePill({ state }: { state: ReportPillState }) {
  const C = useCmdColors();
  const T = useT();
  const map = {
    ready: { fg: C.ok, bg: C.okBg, label: T('section.reports.phone.pillReady') },
    running: { fg: C.info, bg: C.infoBg, label: T('section.reports.phone.pillRunning') },
    queued: { fg: C.fg2, bg: C.panel2, label: T('section.reports.phone.pillQueued') },
    failed: { fg: C.danger, bg: C.dangerBg, label: T('section.reports.phone.pillFailed') },
  }[state];
  return (
    <View
      style={{
        flexShrink: 0,
        paddingHorizontal: 9,
        paddingVertical: 2,
        borderRadius: CmdRadius.pill,
        borderWidth: 0.5,
        borderColor: map.fg,
        backgroundColor: map.bg,
      }}
    >
      <Text style={{ fontFamily: mono(700), fontSize: 9.5, letterSpacing: 0.5, color: map.fg }}>{map.label}</Text>
    </View>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────
function ReportDetail({ definition }: { definition: ReportDefinition }) {
  const C = useCmdColors();
  const T = useT();
  const run = useStore((s) => s.reportRuns[definition.id]) as ReportRun | undefined;
  const runReport = useStore((s) => s.runReport);
  const loadLatestRun = useStore((s) => s.loadLatestRun);

  // Lazy-load the latest run when the detail opens (mirrors the desktop
  // section's `loadLatestRun` effect).
  React.useEffect(() => {
    loadLatestRun(definition.id);
  }, [definition.id, loadLatestRun]);

  const state = reportPillState(run);
  const kpis = run?.output?.kpis ?? [];
  const kpiTone = (tone?: 'ok' | 'warn' | 'danger' | null): string =>
    tone === 'ok' ? C.ok : tone === 'warn' ? C.warn : tone === 'danger' ? C.danger : C.fg2;

  return (
    <View style={{ padding: 16, gap: 16 }}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <ReportStatePill state={state} />
          <Text style={[PhoneType.microCaption, { color: C.fg3 }]} numberOfLines={1}>
            {definition.templateId.toUpperCase()} · {(definition.scope || 'this_store').toUpperCase()}
          </Text>
        </View>
        <Text style={[PhoneType.detailTitle, { color: C.fg }]} numberOfLines={2}>{definition.name}</Text>
        <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
          {run
            ? T('section.reports.phone.lastRun', { when: relativeTime(run.ranAt) || '—' })
            : T('section.reports.phone.neverRun')}
        </Text>
      </View>

      {/* KPIs — phone-safe label/value pairs from the run output. */}
      {kpis.length > 0 ? (
        <PropertyCard
          testID="phone-report-kpis"
          title={T('section.reports.phone.kpisGroup')}
          rows={kpis.map((k) => ({ label: k.label, value: String(k.value), tone: kpiTone(k.tone) }))}
        />
      ) : run?.status === 'error' ? (
        <Text style={[PhoneType.body, { color: C.danger }]}>{run.errorMessage || T('section.reports.phone.runError')}</Text>
      ) : (
        <Text style={[PhoneType.metaMono, { color: C.fg3 }]}>{T('section.reports.phone.noKpis')}</Text>
      )}

      {/* Honest note — the full result table + query builder are desktop-only. */}
      <Text style={[PhoneType.metaMono, { color: C.fg3 }]}>{T('section.reports.phone.desktopNote')}</Text>

      <TouchableOpacity
        testID="phone-report-run"
        onPress={() => runReport(definition.id)}
        disabled={state === 'running'}
        activeOpacity={0.85}
        accessibilityRole="button"
        style={{
          height: 48,
          borderRadius: CmdRadius.sm,
          backgroundColor: state === 'running' ? C.panel2 : C.accent,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: state === 'running' ? 0.7 : 1,
        }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 12, letterSpacing: 0.5, color: state === 'running' ? C.fg3 : C.accentFg }}>
          {state === 'running' ? T('section.reports.phone.runningBtn') : T('section.reports.phone.runBtn')}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────
export const PhoneReports: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  const savedReports = useStore((s) => s.savedReports);
  const reportRuns = useStore((s) => s.reportRuns);
  const currentStore = useStore((s) => s.currentStore);
  const drill = usePhoneDrill<ReportDefinition>();

  const myReports = React.useMemo(
    () => savedReports.filter((r) => r.storeId === currentStore.id),
    [savedReports, currentStore.id],
  );

  // The report builder (+ NEW REPORT) is desktop-only — honest toast.
  const onNewReport = () =>
    Toast.show({ type: 'info', text1: T('common.editOnDesktop'), text2: T('section.reports.phone.newReportToast') });

  const header = (
    <View style={{ paddingTop: 16, paddingHorizontal: 16, paddingBottom: 8, gap: 4 }}>
      <Text style={[PhoneType.screenTitle, { color: C.fg }]}>{T('section.reports.title')}</Text>
      <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
        {T('section.reports.phone.subtitle', { count: myReports.length })}
      </Text>
    </View>
  );

  const listNode = (
    <View style={{ flex: 1, minHeight: 0 }}>
      <FlatList
        testID="phone-reports-flatlist"
        style={{ flex: 1, minHeight: 0, backgroundColor: C.bg }}
        contentContainerStyle={{ paddingBottom: 88 }}
        data={myReports}
        keyExtractor={(r) => r.id}
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews={Platform.OS !== 'web'}
        ListHeaderComponent={
          <>
            {header}
            {myReports.length > 0 ? <GroupCaption>{T('section.reports.phone.savedGroup')}</GroupCaption> : null}
          </>
        }
        ListEmptyComponent={
          <Text style={[PhoneType.metaMono, { color: C.fg3, padding: 22, textAlign: 'center' }]}>
            {T('section.reports.phone.empty')}
          </Text>
        }
        renderItem={({ item: r }) => {
          const run = reportRuns[r.id];
          const state = reportPillState(run);
          return (
            <TwoLineRow
              testID={`phone-report-row-${r.id}`}
              pill={<ReportStatePill state={state} />}
              name={r.name}
              meta={
                <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
                  {r.templateId.toUpperCase()}
                  {' · '}
                  {run ? T('section.reports.phone.ranMeta', { when: relativeTime(run.ranAt) || '—' }) : T('section.reports.phone.neverRun')}
                </Text>
              }
              onPress={() => drill.open(r)}
            />
          );
        }}
      />
      {/* 48px thumb-reachable primary. */}
      <View style={{ position: 'absolute', left: 16, right: 16, bottom: 16 }}>
        <TouchableOpacity
          testID="phone-report-new"
          onPress={onNewReport}
          activeOpacity={0.85}
          accessibilityRole="button"
          style={{ height: 48, borderRadius: CmdRadius.sm, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 12, letterSpacing: 0.5, color: C.accentFg }}>
            {T('section.reports.phone.newReport')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <PhoneDrillScaffold
      testID="phone-reports"
      parentCaption={T('section.reports.phone.parentCaption')}
      onBack={drill.close}
      list={listNode}
      detail={drill.selected ? <ReportDetail definition={drill.selected} /> : null}
    />
  );
};

export default PhoneReports;
