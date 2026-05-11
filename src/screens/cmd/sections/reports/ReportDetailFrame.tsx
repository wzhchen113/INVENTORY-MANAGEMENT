// Spec 016 — generic, template-agnostic detail frame for a single saved
// report definition. Renders the latest run's output envelope (KPIs, table,
// optional line chart) plus an empty / not-implemented / error branch.
//
// REPORTS-1 ships every template's dispatcher branch as `not_implemented`, so
// the only path that actually paints data in this spec is the unit-test /
// dev `report_run_stub`. REPORTS-2 (cogs) and REPORTS-3 (variance) flip the
// dispatcher to return real envelopes and the same frame renders them as-is
// — that's the point of keeping it template-agnostic.
//
// Spec 017 (REPORTS-2) — the previously-read-only `range:` and `by:` chips
// become interactive dropdowns when the parent passes `onRangeChange` /
// `onByChange`. A subtle `·` indicator next to the chip's label means the
// in-frame override differs from the saved definition's value — the next
// press of RUN will use the override, but the saved definition is untouched.

import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, Platform, TextInput } from 'react-native';
import Svg, { Polyline, Polygon, Line as SvgLine, Circle, Text as SvgText } from 'react-native-svg';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { sans, mono, Type } from '../../../../theme/typography';
import { ReportDefinition, ReportRun, ReportRunOutput } from '../../../../types';
import { findTemplate } from './templates';
import { relativeTime } from '../../../../utils/relativeTime';
// Spec 018 round-2 — date helpers extracted to a shared module now that
// the REPORTS-3 shape is proven. NewReportModal imports the same trio.
// The frame extends the shared `PresetId` with `'custom'` for the
// manual-edit affordance — the shared union stays preset-only.
import {
  PresetId as PresetIdShared,
  isISODate,
  computePreset,
} from '../../../../utils/reportDates';

export interface ReportDetailFrameProps {
  definition: ReportDefinition;
  latestRun: ReportRun | null;
  onRun: () => void;
  onBack: () => void;
  running: boolean;
  /**
   * Spec 017 — in-frame override of the date range. When passed, the
   * `range:` chip becomes a dropdown of presets + manual edit. When
   * omitted (default), the chip stays read-only (REPORTS-1 behaviour
   * — preview templates and any template whose runner isn't `'live'`
   * yet pass nothing here).
   */
  overrideRange?: { range: string; from: string; to: string } | null;
  onRangeChange?: (override: { range: string; from: string; to: string }) => void;
  /**
   * Spec 017 — in-frame override of the `by:` group key. Same gating
   * pattern as `onRangeChange`.
   */
  overrideBy?: 'category' | 'item' | null;
  onByChange?: (by: 'category' | 'item') => void;
  /**
   * Spec 017 — reset both overrides back to the definition's saved
   * params. Wired by `ReportsSection`; the chips show a small `reset`
   * affordance when at least one override is active.
   */
  onResetOverrides?: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function isToneKey(t: unknown): t is 'ok' | 'warn' | 'danger' {
  return t === 'ok' || t === 'warn' || t === 'danger';
}

function toneColor(
  C: ReturnType<typeof useCmdColors>,
  t: unknown,
): string {
  if (t === 'ok') return C.ok;
  if (t === 'warn') return C.warn;
  if (t === 'danger') return C.danger;
  return C.fg;
}

function formatCellValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// `toISODate` / `isISODate` / `computePreset` live in
// `src/utils/reportDates.ts` (see top-of-file import). Local extension:
// the frame's manual-edit affordance adds `'custom'` to the shared
// preset union — keep `PresetId` as a local alias for that augmentation.

type PresetId = PresetIdShared | 'custom';

const PRESETS: Array<{ id: Exclude<PresetId, 'custom'>; label: string }> = [
  { id: 'last_30d',        label: 'Last 30d'        },
  { id: 'this_month',      label: 'This month'      },
  { id: 'last_full_month', label: 'Last full month' },
  { id: 'last_90d',        label: 'Last 90d'        },
];

function rangeLabel(range: string, from: string, to: string): string {
  const preset = PRESETS.find((p) => p.id === range);
  if (preset) return preset.label.toLowerCase();
  if (range === 'custom') return `${from} → ${to}`;
  // Fallback for legacy `range` values from REPORTS-1 stubs (raw strings).
  return range;
}

// Spec 018 — variance reports show two distinct anchor dates rather than a
// continuous range. The chip label re-frames the relationship as
// `prior: <date> · current: <date>` so the two-EOD-anchor semantics are
// readable at a glance. Falls back to "—" when an anchor hasn't been
// resolved yet (e.g. a fresh definition with no params).
function varianceRangeLabel(from: string, to: string): string {
  const left = from || '—';
  const right = to || '—';
  return `prior: ${left} · current: ${right}`;
}

// ─── ReportDetailFrame ───────────────────────────────────────────────────

export const ReportDetailFrame: React.FC<ReportDetailFrameProps> = ({
  definition,
  latestRun,
  onRun,
  onBack,
  running,
  overrideRange,
  onRangeChange,
  overrideBy,
  onByChange,
  onResetOverrides,
}) => {
  const C = useCmdColors();
  const template = findTemplate(definition.templateId);
  const templateName = template?.name ?? definition.templateId;
  // Spec 018 — variance reports get a re-framed `range:` chip
  // (`prior · current`), hide the `by:` chip entirely, and hide the
  // preset chip strip inside the range popover. Single-flag branch
  // gating; we don't bother with a generic "live-template-X" registry
  // since variance is the only template that interprets the date pair
  // this way for now.
  const isVariance = definition.templateId === 'variance';

  const isNotImplemented =
    latestRun?.output?._status === 'not_implemented';
  const isError = latestRun?.status === 'error';
  const isPending = running || latestRun?.status === 'pending';

  // RUN button is disabled while a run is in flight. We also disable it when
  // the dispatcher just told us the runner is not implemented — pressing it
  // again would just re-fetch the same envelope. The detail-view "retry"
  // affordance only fires when we actually saw an error envelope.
  const runDisabled = isPending || (isNotImplemented && !isError);
  const runLabel = isPending ? 'RUNNING…' : isError ? 'RETRY' : 'RUN';

  const lastRunStr = latestRun
    ? relativeTime(latestRun.ranAt) || 'just now'
    : null;

  // Saved-definition values for the chips. Falls back to the legacy
  // "last 30d" string if the saved params don't have `range`/`from`/`to`
  // (REPORTS-1 stubs and migrated rows).
  const savedRange = typeof definition.params?.['range'] === 'string'
    ? (definition.params!['range'] as string)
    : null;
  const savedFrom = typeof definition.params?.['from'] === 'string'
    ? (definition.params!['from'] as string)
    : null;
  const savedTo = typeof definition.params?.['to'] === 'string'
    ? (definition.params!['to'] as string)
    : null;
  const savedBy = definition.params?.['by'] === 'item' ? 'item' : 'category';

  // Effective values = override if present, else saved. The chips render
  // the effective value; the `·` indicator paints when override !== saved.
  const effectiveRange = overrideRange?.range ?? savedRange ?? 'last_30d';
  const effectiveFrom = overrideRange?.from ?? savedFrom ?? '';
  const effectiveTo = overrideRange?.to ?? savedTo ?? '';
  const effectiveBy: 'category' | 'item' = overrideBy ?? savedBy;

  const rangeOverridden = overrideRange != null && (
    overrideRange.range !== (savedRange ?? '') ||
    overrideRange.from  !== (savedFrom  ?? '') ||
    overrideRange.to    !== (savedTo    ?? '')
  );
  const byOverridden = overrideBy != null && overrideBy !== savedBy;
  const anyOverride = rangeOverridden || byOverridden;

  // Dropdown popover state — controlled here rather than per-chip so
  // opening the `by:` menu auto-closes the `range:` menu.
  const [openMenu, setOpenMenu] = React.useState<'range' | 'by' | null>(null);
  // Manual-edit affordance for custom range. Drafts mirror the modal's
  // pattern so a tap on the chip's date cell flips it to a TextInput.
  const [editingDate, setEditingDate] = React.useState<'from' | 'to' | null>(null);
  const [draftFrom, setDraftFrom] = React.useState<string>(effectiveFrom);
  const [draftTo, setDraftTo] = React.useState<string>(effectiveTo);
  React.useEffect(() => {
    setDraftFrom(effectiveFrom);
    setDraftTo(effectiveTo);
  }, [effectiveFrom, effectiveTo]);

  const rangeInteractive = typeof onRangeChange === 'function';
  const byInteractive = typeof onByChange === 'function';

  const onPickPreset = (id: Exclude<PresetId, 'custom'>) => {
    if (!onRangeChange) return;
    const r = computePreset(id);
    onRangeChange({ range: id, from: r.from, to: r.to });
    setEditingDate(null);
    setOpenMenu(null);
  };

  const commitDate = (which: 'from' | 'to', raw: string) => {
    if (!onRangeChange) return;
    const v = raw.trim();
    if (!isISODate(v)) {
      // Surface the validation failure via the same Toast pattern the
      // modal uses (`NewReportModal.tsx:162`) so the user gets immediate
      // feedback. Then revert the draft to the last committed value and
      // close the editor.
      Toast.show({ type: 'error', text1: 'Invalid date — must be YYYY-MM-DD' });
      if (which === 'from') setDraftFrom(effectiveFrom);
      else setDraftTo(effectiveTo);
      setEditingDate(null);
      return;
    }
    onRangeChange({
      range: 'custom',
      from: which === 'from' ? v : effectiveFrom,
      to:   which === 'to'   ? v : effectiveTo,
    });
    setEditingDate(null);
  };

  const onPickBy = (b: 'category' | 'item') => {
    if (!onByChange) return;
    onByChange(b);
    setOpenMenu(null);
  };

  return (
    <ScrollView
      contentContainerStyle={{ padding: 22, gap: 16 }}
      style={{ flex: 1, backgroundColor: C.bg }}
    >
      {/* ─── Header ──────────────────────────────────────────────────── */}
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <TouchableOpacity
            onPress={onBack}
            accessibilityLabel="Back to reports list"
            style={{
              paddingVertical: 5,
              paddingHorizontal: 9,
              borderRadius: CmdRadius.sm,
              borderWidth: 1,
              borderColor: C.border,
              backgroundColor: C.panel,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg2 }}>
              ← BACK
            </Text>
          </TouchableOpacity>

          <View
            style={{
              paddingHorizontal: 7,
              paddingVertical: 2,
              borderRadius: 3,
              backgroundColor: C.accentBg,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.accent, letterSpacing: 0.5 }}>
              {String(definition.templateId).toUpperCase()}
            </Text>
          </View>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
            {templateName}
          </Text>

          <View style={{ flex: 1 }} />

          <TouchableOpacity
            onPress={onRun}
            disabled={runDisabled}
            accessibilityLabel="Run report"
            style={{
              paddingVertical: 6,
              paddingHorizontal: 14,
              borderRadius: CmdRadius.sm,
              backgroundColor: runDisabled ? C.panel2 : C.accent,
              borderWidth: 1,
              borderColor: runDisabled ? C.border : C.accent,
              opacity: runDisabled ? 0.55 : 1,
              ...(Platform.OS === 'web'
                ? ({
                    cursor: runDisabled ? 'not-allowed' : 'pointer',
                    title: isNotImplemented ? 'Not yet wired' : '',
                  } as Record<string, unknown>)
                : {}),
            }}
          >
            <Text
              style={{
                fontFamily: mono(700),
                fontSize: 11,
                // `accentFg` flips with the palette (#FFFFFF on light,
                // #0E1014 on dark) so the RUN label always meets contrast
                // against the green accent background. Closes spec 016
                // code-reviewer Should-fix #5.
                color: runDisabled ? C.fg3 : C.accentFg,
                letterSpacing: 0.4,
              }}
            >
              {runLabel}
            </Text>
          </TouchableOpacity>
        </View>

        <Text style={[Type.h1, { color: C.fg }]}>{definition.name}</Text>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
            scope: {definition.scope || 'this_store'}
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>·</Text>

          {/* range chip */}
          <ChipButton
            C={C}
            label={
              isVariance
                ? varianceRangeLabel(effectiveFrom, effectiveTo)
                : `range: ${rangeLabel(effectiveRange, effectiveFrom, effectiveTo)}`
            }
            overridden={rangeOverridden}
            interactive={rangeInteractive}
            onPress={() => { setOpenMenu((m) => (m === 'range' ? null : 'range')); }}
          />

          {/* by chip — hidden for variance per Spec 018. */}
          {isVariance ? null : (
            <>
              <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>·</Text>
              <ChipButton
                C={C}
                label={`by: ${effectiveBy}`}
                overridden={byOverridden}
                interactive={byInteractive}
                onPress={() => { setOpenMenu((m) => (m === 'by' ? null : 'by')); }}
              />
            </>
          )}

          {anyOverride && onResetOverrides ? (
            <>
              <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>·</Text>
              <TouchableOpacity
                onPress={() => { onResetOverrides(); setOpenMenu(null); setEditingDate(null); }}
                accessibilityLabel="Reset chip overrides"
                style={{ paddingHorizontal: 7, paddingVertical: 2 }}
              >
                <Text style={{ fontFamily: mono(600), fontSize: 10.5, color: C.accent }}>reset</Text>
              </TouchableOpacity>
            </>
          ) : null}

          <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>·</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
            {lastRunStr ? `last run ${lastRunStr} ago` : 'never run'}
          </Text>
        </View>

        {/* Inline popover for range / by chips. We render below the chips
            (not as an absolute-positioned Modal) so it works identically on
            web and native without portal/positioning math. Touching outside
            closes via the chip's toggle behaviour or the panel's CLOSE. */}
        {openMenu === 'range' && rangeInteractive ? (
          <RangePopover
            C={C}
            effective={{ range: effectiveRange, from: effectiveFrom, to: effectiveTo }}
            editing={editingDate}
            draftFrom={draftFrom}
            draftTo={draftTo}
            setDraftFrom={setDraftFrom}
            setDraftTo={setDraftTo}
            setEditing={setEditingDate}
            onPickPreset={onPickPreset}
            onCommitDate={commitDate}
            onClose={() => { setOpenMenu(null); setEditingDate(null); }}
            hidePresets={isVariance}
            labels={isVariance ? { from: 'Prior EOD', to: 'Current EOD' } : undefined}
          />
        ) : null}
        {openMenu === 'by' && byInteractive ? (
          <ByPopover C={C} effective={effectiveBy} onPick={onPickBy} onClose={() => setOpenMenu(null)} />
        ) : null}
      </View>

      {/* ─── Body — branches ─────────────────────────────────────────── */}
      {!latestRun ? (
        <EmptyPanel
          C={C}
          title="No runs yet"
          message="Press RUN to compute the latest snapshot for this report."
        />
      ) : isError ? (
        <ErrorPanel C={C} message={latestRun.errorMessage} />
      ) : isNotImplemented ? (
        <NotImplementedPanel
          C={C}
          message={
            latestRun.output?._message ??
            'Runner coming soon · definition saved'
          }
        />
      ) : isPending ? (
        <EmptyPanel
          C={C}
          title="Running…"
          message="Waiting for the runner to return."
        />
      ) : (
        <ResultBody C={C} output={latestRun.output} />
      )}
    </ScrollView>
  );
};

// ─── Chip button ─────────────────────────────────────────────────────────

const ChipButton: React.FC<{
  C: ReturnType<typeof useCmdColors>;
  label: string;
  overridden: boolean;
  interactive: boolean;
  onPress: () => void;
}> = ({ C, label, overridden, interactive, onPress }) => {
  // The `·` indicator (small filled dot in the accent color) paints when
  // the effective value differs from the saved definition. Non-interactive
  // chips (preview templates) render as plain text matching the REPORTS-1
  // shape so we don't visually regress that surface.
  if (!interactive) {
    return (
      <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
        {label}
      </Text>
    );
  }
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityLabel={`Toggle ${label}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderWidth: 1,
        borderColor: overridden ? C.accent : C.border,
        backgroundColor: overridden ? C.accentBg : C.panel,
        borderRadius: 3,
      }}
    >
      <Text style={{ fontFamily: mono(overridden ? 700 : 500), fontSize: 10.5, color: overridden ? C.accent : C.fg2 }}>
        {label}
      </Text>
      {overridden ? (
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.accent, lineHeight: 11 }}>·</Text>
      ) : null}
    </TouchableOpacity>
  );
};

// ─── Range popover ───────────────────────────────────────────────────────

const RangePopover: React.FC<{
  C: ReturnType<typeof useCmdColors>;
  effective: { range: string; from: string; to: string };
  editing: 'from' | 'to' | null;
  draftFrom: string;
  draftTo: string;
  setDraftFrom: (s: string) => void;
  setDraftTo: (s: string) => void;
  setEditing: (e: 'from' | 'to' | null) => void;
  onPickPreset: (id: Exclude<PresetId, 'custom'>) => void;
  onCommitDate: (which: 'from' | 'to', raw: string) => void;
  onClose: () => void;
  /** Spec 018 — variance hides the preset chip strip (anchor pairs are
   *  not a continuous range). */
  hidePresets?: boolean;
  /** Spec 018 — variance relabels the from/to cells as "Prior EOD"/"Current EOD".
   *  When omitted the cells render without an inline column header (legacy
   *  REPORTS-2 shape). */
  labels?: { from?: string; to?: string };
}> = ({ C, effective, editing, draftFrom, draftTo, setDraftFrom, setDraftTo, setEditing, onPickPreset, onCommitDate, onClose, hidePresets, labels }) => {
  const fromLabel = labels?.from;
  const toLabel = labels?.to;
  // The header label of the popover. For variance we drop the "range"
  // header (it's misleading) and let the per-cell labels carry the
  // semantics instead.
  const headerLabel = labels ? null : 'range';
  return (
    <View
      style={{
        marginTop: 6,
        padding: 12,
        gap: 10,
        backgroundColor: C.panel,
        borderWidth: 1,
        borderColor: C.borderStrong,
        borderRadius: 6,
        alignSelf: 'flex-start',
        ...(Platform.OS === 'web' ? ({ boxShadow: '0 8px 24px rgba(0,0,0,0.18)' } as any) : {}),
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {headerLabel ? (
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 }}>{headerLabel}</Text>
        ) : null}
        {/* from cell */}
        <View style={{ gap: 3 }}>
          {fromLabel ? (
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 }}>{fromLabel}</Text>
          ) : null}
          {editing === 'from' ? (
            <TextInput
              autoFocus
              value={draftFrom}
              onChangeText={setDraftFrom}
              onBlur={() => onCommitDate('from', draftFrom)}
              onSubmitEditing={() => onCommitDate('from', draftFrom)}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={C.fg3}
              maxLength={10}
              style={{
                fontFamily: mono(500), fontSize: 11.5, color: C.fg,
                backgroundColor: C.panel, borderWidth: 1, borderColor: C.accent, borderRadius: 4,
                paddingHorizontal: 8, paddingVertical: 4, minWidth: 110,
                ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
              }}
            />
          ) : (
            <TouchableOpacity
              accessibilityLabel={fromLabel ? `Edit ${fromLabel} date` : 'Edit from date'}
              onPress={() => { setDraftFrom(effective.from); setEditing('from'); }}
              style={{ paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: C.border, borderRadius: 4, backgroundColor: C.panel }}
            >
              <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg }}>{effective.from || 'YYYY-MM-DD'}</Text>
            </TouchableOpacity>
          )}
        </View>
        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, alignSelf: 'flex-end', paddingBottom: 4 }}>→</Text>
        {/* to cell */}
        <View style={{ gap: 3 }}>
          {toLabel ? (
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 }}>{toLabel}</Text>
          ) : null}
          {editing === 'to' ? (
            <TextInput
              autoFocus
              value={draftTo}
              onChangeText={setDraftTo}
              onBlur={() => onCommitDate('to', draftTo)}
              onSubmitEditing={() => onCommitDate('to', draftTo)}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={C.fg3}
              maxLength={10}
              style={{
                fontFamily: mono(500), fontSize: 11.5, color: C.fg,
                backgroundColor: C.panel, borderWidth: 1, borderColor: C.accent, borderRadius: 4,
                paddingHorizontal: 8, paddingVertical: 4, minWidth: 110,
                ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
              }}
            />
          ) : (
            <TouchableOpacity
              accessibilityLabel={toLabel ? `Edit ${toLabel} date` : 'Edit to date'}
              onPress={() => { setDraftTo(effective.to); setEditing('to'); }}
              style={{ paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: C.border, borderRadius: 4, backgroundColor: C.panel }}
            >
              <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg }}>{effective.to || 'YYYY-MM-DD'}</Text>
            </TouchableOpacity>
          )}
        </View>
        <View style={{ flex: 1 }} />
        <TouchableOpacity onPress={onClose} accessibilityLabel="Close range popover" style={{ paddingHorizontal: 7, paddingVertical: 2 }}>
          <Text style={{ fontFamily: mono(600), fontSize: 10.5, color: C.fg3 }}>close</Text>
        </TouchableOpacity>
      </View>
      {hidePresets ? null : (
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {PRESETS.map((p) => {
            const sel = effective.range === p.id;
            return (
              <TouchableOpacity
                key={p.id}
                onPress={() => onPickPreset(p.id)}
                accessibilityLabel={`Preset ${p.label}`}
                style={{
                  paddingHorizontal: 9, paddingVertical: 4,
                  borderWidth: 1, borderColor: sel ? C.accent : C.border,
                  backgroundColor: sel ? C.accentBg : C.panel,
                  borderRadius: 3,
                }}
              >
                <Text style={{ fontFamily: mono(sel ? 700 : 500), fontSize: 10.5, color: sel ? C.accent : C.fg2 }}>{p.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
      <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
        {hidePresets
          ? 'Next RUN uses these anchor dates. The saved report keeps its original anchors.'
          : 'Next RUN uses this range. The saved report keeps its original range.'}
      </Text>
    </View>
  );
};

// ─── By popover ──────────────────────────────────────────────────────────

const ByPopover: React.FC<{
  C: ReturnType<typeof useCmdColors>;
  effective: 'category' | 'item';
  onPick: (b: 'category' | 'item') => void;
  onClose: () => void;
}> = ({ C, effective, onPick, onClose }) => (
  <View
    style={{
      marginTop: 6,
      padding: 12,
      gap: 10,
      backgroundColor: C.panel,
      borderWidth: 1,
      borderColor: C.borderStrong,
      borderRadius: 6,
      alignSelf: 'flex-start',
      ...(Platform.OS === 'web' ? ({ boxShadow: '0 8px 24px rgba(0,0,0,0.18)' } as any) : {}),
    }}
  >
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 }}>by</Text>
      {(['category', 'item'] as const).map((opt) => {
        const sel = effective === opt;
        return (
          <TouchableOpacity
            key={opt}
            onPress={() => onPick(opt)}
            accessibilityLabel={`Group by ${opt}`}
            style={{
              paddingHorizontal: 10, paddingVertical: 4,
              borderWidth: 1, borderColor: sel ? C.accent : C.border,
              backgroundColor: sel ? C.accentBg : C.panel,
              borderRadius: 3,
            }}
          >
            <Text style={{ fontFamily: mono(sel ? 700 : 500), fontSize: 10.5, color: sel ? C.accent : C.fg2 }}>{opt}</Text>
          </TouchableOpacity>
        );
      })}
      <View style={{ flex: 1 }} />
      <TouchableOpacity onPress={onClose} accessibilityLabel="Close by popover" style={{ paddingHorizontal: 7, paddingVertical: 2 }}>
        <Text style={{ fontFamily: mono(600), fontSize: 10.5, color: C.fg3 }}>close</Text>
      </TouchableOpacity>
    </View>
    <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
      Next RUN groups by this dimension. The saved report keeps its original.
    </Text>
  </View>
);

// ─── Sub-panels ──────────────────────────────────────────────────────────

interface SubProps {
  C: ReturnType<typeof useCmdColors>;
}

const EmptyPanel: React.FC<SubProps & { title: string; message: string }> = ({
  C,
  title,
  message,
}) => (
  <View
    style={{
      backgroundColor: C.panel,
      borderRadius: CmdRadius.lg,
      borderWidth: 1,
      borderColor: C.border,
      padding: 28,
      alignItems: 'center',
      gap: 8,
    }}
  >
    <Text
      style={{
        fontFamily: mono(700),
        fontSize: 10.5,
        color: C.fg3,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
      }}
    >
      {title}
    </Text>
    <Text
      style={{
        fontFamily: sans(400),
        fontSize: 13,
        color: C.fg2,
        textAlign: 'center',
        maxWidth: 480,
      }}
    >
      {message}
    </Text>
  </View>
);

const NotImplementedPanel: React.FC<SubProps & { message: string }> = ({ C, message }) => (
  <View
    style={{
      backgroundColor: C.panel,
      borderRadius: CmdRadius.lg,
      borderWidth: 1,
      borderColor: C.border,
      borderStyle: 'dashed',
      padding: 28,
      alignItems: 'center',
      gap: 8,
    }}
  >
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 3,
        backgroundColor: C.panel2,
      }}
    >
      <Text
        style={{
          fontFamily: mono(700),
          fontSize: 9.5,
          color: C.fg3,
          letterSpacing: 0.5,
        }}
      >
        NOT YET WIRED
      </Text>
    </View>
    <Text
      style={{
        fontFamily: sans(400),
        fontSize: 13,
        color: C.fg2,
        textAlign: 'center',
        maxWidth: 480,
      }}
    >
      {message}
    </Text>
  </View>
);

const ErrorPanel: React.FC<SubProps & { message: string | null }> = ({ C, message }) => (
  <View
    style={{
      backgroundColor: C.panel,
      borderRadius: CmdRadius.lg,
      borderWidth: 1,
      borderColor: C.danger,
      padding: 22,
      gap: 8,
    }}
  >
    <Text
      style={{
        fontFamily: mono(700),
        fontSize: 10.5,
        color: C.danger,
        letterSpacing: 0.5,
      }}
    >
      RUN FAILED
    </Text>
    <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg }}>
      {message || 'Unknown error. Press RETRY to try again.'}
    </Text>
  </View>
);

// ─── Result body — KPI strip + table + chart ─────────────────────────────

const ResultBody: React.FC<SubProps & { output: ReportRunOutput | null }> = ({ C, output }) => {
  if (!output) {
    return (
      <EmptyPanel
        C={C}
        title="No output"
        message="The runner returned no envelope. Press RUN again or check logs."
      />
    );
  }

  const hasKpis = Array.isArray(output.kpis) && output.kpis.length > 0;
  const hasTable =
    Array.isArray(output.columns) &&
    output.columns.length > 0 &&
    Array.isArray(output.rows);
  const hasSeries = Array.isArray(output.series) && output.series.length >= 2;

  return (
    <>
      {hasKpis ? <KpiStrip C={C} kpis={output.kpis} /> : null}
      {hasTable ? <ResultTable C={C} columns={output.columns} rows={output.rows} /> : null}
      {hasSeries ? <ResultChart C={C} series={output.series!} /> : null}
      {!hasKpis && !hasTable && !hasSeries ? (
        <EmptyPanel
          C={C}
          title="Empty result"
          message="The runner returned an envelope but no KPIs, rows, or series."
        />
      ) : null}
    </>
  );
};

const KpiStrip: React.FC<SubProps & { kpis: ReportRunOutput['kpis'] }> = ({ C, kpis }) => (
  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
    {kpis.map((k, i) => {
      const tone = isToneKey(k.tone) ? k.tone : null;
      const valueColor = toneColor(C, tone);
      return (
        <View
          key={`${k.label}-${i}`}
          style={{
            flexBasis: '23%',
            flexGrow: 1,
            minWidth: 160,
            backgroundColor: C.panel,
            borderRadius: CmdRadius.lg,
            borderWidth: 1,
            borderColor: C.border,
            padding: 14,
            gap: 4,
          }}
        >
          <Text
            style={{
              fontFamily: mono(700),
              fontSize: 9.5,
              color: C.fg3,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
          >
            {k.label}
          </Text>
          <Text
            style={{
              fontFamily: mono(600),
              fontSize: 22,
              color: valueColor,
              letterSpacing: -0.3,
              fontVariant: ['tabular-nums'],
            }}
          >
            {String(k.value)}
          </Text>
        </View>
      );
    })}
  </View>
);

const ResultTable: React.FC<
  SubProps & {
    columns: ReportRunOutput['columns'];
    rows: ReportRunOutput['rows'];
  }
> = ({ C, columns, rows }) => {
  if (rows.length === 0) {
    return (
      <View
        style={{
          backgroundColor: C.panel,
          borderRadius: CmdRadius.lg,
          borderWidth: 1,
          borderColor: C.border,
          padding: 18,
        }}
      >
        <Text
          style={{
            fontFamily: mono(400),
            fontSize: 11,
            color: C.fg3,
            textAlign: 'center',
          }}
        >
          // 0 rows
        </Text>
      </View>
    );
  }

  // Equalize all columns at flex:1; right-align numerics. Matches the dashed
  // separator + tabular-nums treatment used elsewhere in the section.
  return (
    <View
      style={{
        backgroundColor: C.panel,
        borderRadius: CmdRadius.lg,
        borderWidth: 1,
        borderColor: C.border,
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <View
        style={{
          flexDirection: 'row',
          paddingHorizontal: 14,
          paddingVertical: 10,
          backgroundColor: C.panel2,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
        }}
      >
        {columns.map((col) => (
          <Text
            key={`h-${col.key}`}
            style={{
              flex: 1,
              fontFamily: mono(700),
              fontSize: 10,
              color: C.fg3,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              textAlign: col.align === 'right' ? 'right' : 'left',
            }}
            numberOfLines={1}
          >
            {col.label}
          </Text>
        ))}
      </View>
      {/* Body rows */}
      {rows.map((row, rowIdx) => (
        <View
          key={`r-${rowIdx}`}
          style={{
            flexDirection: 'row',
            paddingHorizontal: 14,
            paddingVertical: 9,
            borderTopWidth: rowIdx === 0 ? 0 : 1,
            borderTopColor: C.border,
            borderStyle: 'dashed',
          }}
        >
          {columns.map((col) => {
            const isNumeric = col.align === 'right';
            return (
              <Text
                key={`c-${rowIdx}-${col.key}`}
                style={{
                  flex: 1,
                  fontFamily: isNumeric ? mono(500) : sans(400),
                  fontSize: 12,
                  color: C.fg,
                  textAlign: isNumeric ? 'right' : 'left',
                  fontVariant: isNumeric ? ['tabular-nums'] : undefined,
                }}
                numberOfLines={1}
              >
                {formatCellValue(row[col.key])}
              </Text>
            );
          })}
        </View>
      ))}
    </View>
  );
};

// Lightweight SVG line chart that mirrors the StockHistoryChart treatment.
// We don't pull in react-native-chart-kit because the rest of the codebase
// uses raw react-native-svg; an extra dependency would be inconsistent and
// chart-kit's web behaviour through react-native-web is fragile.
const ResultChart: React.FC<SubProps & { series: NonNullable<ReportRunOutput['series']> }> = ({
  C,
  series,
}) => {
  // Width is set after layout so the SVG fills the panel; height is fixed.
  const [width, setWidth] = React.useState<number>(640);
  const height = 220;

  // The architect's envelope flattens series into label-keyed rows. Group
  // them so a multi-series envelope can render distinct polylines.
  const grouped = React.useMemo(() => {
    const map = new Map<string, Array<{ x: string; y: number }>>();
    for (const pt of series) {
      if (!map.has(pt.label)) map.set(pt.label, []);
      map.get(pt.label)!.push({ x: pt.x, y: pt.y });
    }
    // Sort each series by `x` to keep the polyline monotonic on the time axis.
    return Array.from(map.entries()).map(([label, pts]) => ({
      label,
      pts: [...pts].sort((a, b) => (a.x < b.x ? -1 : a.x > b.x ? 1 : 0)),
    }));
  }, [series]);

  const allYs = grouped.flatMap((g) => g.pts.map((p) => p.y));
  const yMin = Math.min(0, ...allYs);
  const yMax = Math.max(...allYs);
  const yRange = yMax - yMin || 1;

  // Use the union of all xs across series for a shared x axis.
  const xUniverse = Array.from(new Set(series.map((p) => p.x))).sort();
  const xCount = Math.max(1, xUniverse.length - 1);

  const pad = { top: 14, right: 14, bottom: 24, left: 36 };
  const innerW = Math.max(10, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;

  const xAt = (xVal: string) => {
    const idx = xUniverse.indexOf(xVal);
    return pad.left + (idx / xCount) * innerW;
  };
  const yAt = (yVal: number) => pad.top + (1 - (yVal - yMin) / yRange) * innerH;

  const gridLines = 4;
  const gridYs = Array.from({ length: gridLines }, (_, i) =>
    pad.top + ((i + 1) / (gridLines + 1)) * innerH,
  );

  const palette = [C.accent, C.warn, C.ok, C.danger, C.fg2];

  // First & last x labels for orientation. Avoids overlapping middle ticks.
  const xLabels = xUniverse.length > 0
    ? [
        { x: xUniverse[0], anchor: 'start' as const },
        ...(xUniverse.length > 2
          ? [{ x: xUniverse[Math.floor((xUniverse.length - 1) / 2)], anchor: 'middle' as const }]
          : []),
        { x: xUniverse[xUniverse.length - 1], anchor: 'end' as const },
      ]
    : [];

  return (
    <View
      onLayout={(e) => setWidth(Math.max(160, e.nativeEvent.layout.width))}
      style={{
        backgroundColor: C.panel,
        borderRadius: CmdRadius.lg,
        borderWidth: 1,
        borderColor: C.border,
        padding: 14,
        gap: 6,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Text
          style={{
            fontFamily: mono(700),
            fontSize: 10,
            color: C.fg3,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          trend
        </Text>
        {grouped.length > 1
          ? grouped.map((g, i) => (
              <View key={`legend-${g.label}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 10, height: 2, backgroundColor: palette[i % palette.length] }} />
                <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg2 }}>{g.label}</Text>
              </View>
            ))
          : null}
      </View>
      <Svg width={width} height={height}>
        {/* Y-axis label ticks */}
        {[yMin, yMin + yRange / 2, yMax].map((v, i) => {
          const y = yAt(v);
          return (
            <SvgText
              key={`yl-${i}`}
              x={pad.left - 6}
              y={y + 3}
              fontSize={9}
              fontFamily={mono(400)}
              fill={C.fg3}
              textAnchor="end"
            >
              {Math.round(v * 100) / 100}
            </SvgText>
          );
        })}
        {/* Grid lines */}
        {gridYs.map((y, i) => (
          <SvgLine
            key={`grid-${i}`}
            x1={pad.left}
            x2={width - pad.right}
            y1={y}
            y2={y}
            stroke={C.border}
            strokeWidth={1}
            strokeDasharray="2 4"
          />
        ))}
        {/* Series polylines */}
        {grouped.map((g, gi) => {
          const stroke = palette[gi % palette.length];
          const points = g.pts.map((p) => `${xAt(p.x)},${yAt(p.y)}`).join(' ');
          if (g.pts.length < 2) return null;
          // Only render the area fill for the first / primary series so multi-
          // series envelopes don't paint over each other.
          const areaPoints =
            gi === 0
              ? `${xAt(g.pts[0].x)},${yAt(yMin)} ${points} ${xAt(g.pts[g.pts.length - 1].x)},${yAt(yMin)}`
              : '';
          return (
            <React.Fragment key={`series-${g.label}-${gi}`}>
              {areaPoints ? (
                <Polygon points={areaPoints} fill={stroke} fillOpacity={0.12} stroke="none" />
              ) : null}
              <Polyline
                points={points}
                fill="none"
                stroke={stroke}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {g.pts.map((p, pi) => (
                <Circle
                  key={`pt-${gi}-${pi}`}
                  cx={xAt(p.x)}
                  cy={yAt(p.y)}
                  r={pi === g.pts.length - 1 ? 3.5 : 1.8}
                  fill={stroke}
                />
              ))}
            </React.Fragment>
          );
        })}
        {/* X-axis labels */}
        {xLabels.map((tick, i) => (
          <SvgText
            key={`xl-${i}`}
            x={xAt(tick.x)}
            y={height - 6}
            fontSize={9}
            fontFamily={mono(400)}
            fill={C.fg3}
            textAnchor={tick.anchor}
          >
            {tick.x}
          </SvgText>
        ))}
      </Svg>
    </View>
  );
};
