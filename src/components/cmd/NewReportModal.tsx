import React from 'react';
import { View, Text, TouchableOpacity, TextInput, Modal, ScrollView, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { ReportDefinition } from '../../types';
import { TEMPLATES, defaultReportName, findTemplate, Template } from '../../screens/cmd/sections/reports/templates';
// Spec 018 (REPORTS-3) — variance template seeds the prior/current EOD
// inputs from the most-recent two submitted EODs.
import { fetchRecentEodDates } from '../../lib/db';
// Spec 018 round-2 — date helpers extracted to a shared module now that
// the shape is proven across REPORTS-2 / REPORTS-3.
import { PresetId, isISODate, computePreset } from '../../utils/reportDates';

// Re-export so existing consumers that imported `Template` from this module
// keep working. The single source of truth is reports/templates.ts.
export type { Template };

interface Props {
  visible: boolean;
  onClose: () => void;
  /**
   * Spec 016 — when set, seeds the picker to this template id so
   * "click a catalog tile" opens the modal pre-selected. Defaults to
   * 'variance' (the historical default) when omitted.
   */
  initialTemplateId?: ReportDefinition['templateId'];
  /**
   * Spec 016 — when set, seeds the name input to this string so the
   * caller can pre-fill "<Template> — May 2026". Defaults to the variance
   * template's default name when omitted.
   */
  initialName?: string;
}

// ─── Spec 017 (REPORTS-2) — date-range helpers ───────────────────────
//
// Date helpers (`toISODate`, `isISODate`, `computePreset`, `PresetId`) live
// in `src/utils/reportDates.ts` and are shared with `ReportDetailFrame`.
// Extracted in REPORTS-3 round-2 after the shape stabilised.

interface DateRange {
  range: PresetId | 'custom';
  from: string;
  to: string;
}

const PRESETS: Array<{ id: PresetId; label: string }> = [
  { id: 'last_30d',        label: 'Last 30d'        },
  { id: 'this_month',      label: 'This month'      },
  { id: 'last_full_month', label: 'Last full month' },
  { id: 'last_90d',        label: 'Last 90d'        },
];

// Spec 018 (REPORTS-3) — variance seeds default anchor pair from the most-
// recent two submitted EODs. When the helper returns < 2 dates (a fresh
// store) we leave the inputs blank — per spec line 263, the danger hint is
// the sufficient UX affordance; the user can still save the definition and
// pressing RUN will surface the RPC's `P0002` error through the standard
// sanitized toast path. The helper already swallows network/RLS errors to
// `[]` so a thrown error here is genuinely unexpected — we treat it the
// same as the empty-history path.
async function seedVarianceDates(storeId: string): Promise<{ from: string; to: string; eodCount: number }> {
  try {
    const dates = await fetchRecentEodDates(storeId, 2);
    if (Array.isArray(dates) && dates.length >= 2) {
      // Helper returns descending: index 0 is most-recent (current anchor),
      // index 1 is second-most-recent (prior anchor).
      return { from: dates[1], to: dates[0], eodCount: dates.length };
    }
    return { from: '', to: '', eodCount: Array.isArray(dates) ? dates.length : 0 };
  } catch {
    return { from: '', to: '', eodCount: 0 };
  }
}

export const NewReportModal: React.FC<Props> = ({
  visible,
  onClose,
  initialTemplateId,
  initialName,
}) => {
  const C = useCmdColors();
  const currentStore = useStore((s) => s.currentStore);
  const currentUser = useStore((s) => s.currentUser);
  const addReportDefinition = useStore((s) => s.addReportDefinition);

  const fallbackTemplate = findTemplate('variance') ?? TEMPLATES[0];
  const initialPicked = initialTemplateId ?? fallbackTemplate.id;
  const seededName =
    initialName ?? defaultReportName(findTemplate(initialPicked) ?? fallbackTemplate);
  const initialPreset = computePreset('last_30d');

  const [picked, setPicked] = React.useState<ReportDefinition['templateId']>(initialPicked);
  const [name, setName] = React.useState(seededName);
  const [filter, setFilter] = React.useState('');
  const [dateRange, setDateRange] = React.useState<DateRange>({
    range: 'last_30d',
    from: initialPreset.from,
    to: initialPreset.to,
  });
  const [by, setBy] = React.useState<'category' | 'item'>('category');
  // Manual-edit affordance: each cell flips to an editable TextInput on tap.
  // We track per-field edit state so tapping `from` doesn't also open `to`.
  const [editing, setEditing] = React.useState<'from' | 'to' | null>(null);
  // Working copies of the date strings while editing — commits on blur.
  const [draftFrom, setDraftFrom] = React.useState<string>(initialPreset.from);
  const [draftTo, setDraftTo] = React.useState<string>(initialPreset.to);
  // Spec 018 — known EOD-submission count for the current store. Drives the
  // "< 2 EODs" inline danger hint for variance. Per spec AC line 265 the
  // CREATE button is NOT disabled — the user can still save the definition
  // and discover the `P0002` error on RUN via the standard toast.
  // `-1` is the "not yet fetched" sentinel (variance hasn't been picked or
  // the fetch is in flight); `0`/`1` triggers the hint.
  const [eodCount, setEodCount] = React.useState<number>(-1);

  React.useEffect(() => {
    if (visible) {
      // Re-seed on each open so a second "open via catalog tile" picks up the
      // freshly-passed initialTemplateId / initialName instead of stale state
      // from a previous session. Date range and `by:` also reset to defaults
      // — REPORTS-2 doesn't preserve modal state across opens.
      setPicked(initialPicked);
      setName(seededName);
      setFilter('');
      const fresh = computePreset('last_30d');
      setDateRange({ range: 'last_30d', from: fresh.from, to: fresh.to });
      setBy('category');
      setEditing(null);
      setDraftFrom(fresh.from);
      setDraftTo(fresh.to);
      setEodCount(-1);
      // Spec 018 — variance pre-fills from the most-recent two EODs.
      if (initialPicked === 'variance' && currentStore?.id) {
        seedVarianceDates(currentStore.id).then(({ from, to, eodCount: n }) => {
          setDateRange({ range: 'custom', from, to });
          setDraftFrom(from);
          setDraftTo(to);
          setEodCount(n);
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialTemplateId, initialName]);

  // Spec 018 — when the user switches the picked template TO variance
  // mid-modal (e.g. they opened on COGS and clicked the Variance tile),
  // re-seed from EOD history. When switching AWAY from variance, restore
  // the default "Last 30d" preset so the COGS path renders normally.
  // `prevPickedRef` is reset alongside `picked` on each modal open so a
  // second open after a previous close doesn't carry stale state.
  const prevPickedRef = React.useRef<ReportDefinition['templateId']>(initialPicked);
  React.useEffect(() => {
    if (visible) prevPickedRef.current = initialPicked;
  }, [visible, initialPicked]);
  React.useEffect(() => {
    if (!visible) return;
    if (prevPickedRef.current === picked) return;
    prevPickedRef.current = picked;
    if (picked === 'variance') {
      if (currentStore?.id) {
        seedVarianceDates(currentStore.id).then(({ from, to, eodCount: n }) => {
          setDateRange({ range: 'custom', from, to });
          setDraftFrom(from);
          setDraftTo(to);
          setEodCount(n);
          setEditing(null);
        });
      }
    } else {
      const fresh = computePreset('last_30d');
      setDateRange({ range: 'last_30d', from: fresh.from, to: fresh.to });
      setDraftFrom(fresh.from);
      setDraftTo(fresh.to);
      setEodCount(-1);
      setEditing(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, visible]);

  const filteredTemplates = React.useMemo(() => {
    if (!filter.trim()) return TEMPLATES;
    const q = filter.toLowerCase();
    return TEMPLATES.filter((t) => t.name.toLowerCase().includes(q) || t.sub.toLowerCase().includes(q));
  }, [filter]);

  const onPickPreset = (id: PresetId) => {
    const r = computePreset(id);
    setDateRange({ range: id, from: r.from, to: r.to });
    setDraftFrom(r.from);
    setDraftTo(r.to);
    setEditing(null);
  };

  const commitDateEdit = (which: 'from' | 'to', raw: string) => {
    const value = raw.trim();
    if (!isISODate(value)) {
      Toast.show({ type: 'error', text1: 'Invalid date — must be YYYY-MM-DD' });
      // Revert the draft to the committed value, keep editing OFF.
      if (which === 'from') setDraftFrom(dateRange.from);
      else setDraftTo(dateRange.to);
      setEditing(null);
      return;
    }
    // Manual edit forces `range` to 'custom' so the chips deselect — the
    // detail-header chip will show the literal YYYY-MM-DD range rather than
    // a preset label.
    setDateRange((prev) => ({
      range: 'custom',
      from: which === 'from' ? value : prev.from,
      to:   which === 'to'   ? value : prev.to,
    }));
    setEditing(null);
  };

  // Spec 018 — variance has two derived flags. `isVariance` enables the
  // variance-specific layout; `varianceBlocked` drives the inline danger
  // hint when the store has < 2 submitted EODs. Per spec AC line 265 the
  // CREATE button is NOT disabled — the user is allowed to save a
  // variance definition with 0/1 EODs, and the subsequent RUN surfaces
  // the RPC's `P0001`/`P0002` error via the sanitized toast path.
  const isVariance = picked === 'variance';
  const varianceBlocked = isVariance && eodCount >= 0 && eodCount < 2;

  const onCreate = () => {
    if (!name.trim()) { Toast.show({ type: 'error', text1: 'Name required' }); return; }
    if (!isISODate(dateRange.from) || !isISODate(dateRange.to)) {
      Toast.show({ type: 'error', text1: 'Invalid date — must be YYYY-MM-DD' });
      return;
    }
    if (dateRange.from > dateRange.to) {
      Toast.show({ type: 'error', text1: 'from must be on or before to' });
      return;
    }
    if (isVariance && dateRange.from === dateRange.to) {
      Toast.show({ type: 'error', text1: 'Variance needs two distinct EOD dates' });
      return;
    }
    // Spec 017 — COGS params shape: { range, from, to, by }. `range` is
    // informational (drives the chip label); `from`/`to` are authoritative.
    // Spec 018 — variance params shape: { from, to }. Per Q3, reuse from/to
    // keys (no anchor_from / anchor_to) but drop `range` and `by` since
    // variance has no preset window and is inherently per-item.
    const params: Record<string, unknown> = isVariance
      ? { from: dateRange.from, to: dateRange.to }
      : {
          range: dateRange.range,
          from:  dateRange.from,
          to:    dateRange.to,
          by,
        };
    addReportDefinition({
      storeId: currentStore.id,
      templateId: picked,
      name: name.trim(),
      scope: 'this_store',
      params,
      createdBy: currentUser?.id,
    });
    Toast.show({ type: 'success', text1: 'Report saved', text2: name });
    onClose();
  };

  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      // Don't hijack Enter while a date cell is in edit mode — the user is
      // typing into it. ⌘⏎ still creates even from a focused TextInput.
      if (e.key === 'Escape') { onClose(); e.preventDefault(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { onCreate(); e.preventDefault(); }
      else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && editing == null) {
        // Plain Enter creates too — design says "↑↓ pick · ⏎ create"
        onCreate();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, picked, name, dateRange, by, editing]);

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.40)', alignItems: 'center', paddingTop: '10%' }}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{ width: 760, backgroundColor: C.bg, borderWidth: 1, borderColor: C.borderStrong, borderRadius: 8, overflow: 'hidden', ...(Platform.OS === 'web' ? ({ boxShadow: '0 16px 48px rgba(0,0,0,0.30)' } as any) : {}) }}>
          {/* Header */}
          <View style={{ height: 44, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.panel }}>
            <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.accent }}>
              <Text style={{ fontFamily: mono(700), fontSize: 10, color: '#000' }}>NEW</Text>
            </View>
            <Text style={{ fontWeight: '600', fontSize: 13.5, color: C.fg }}>pick a template</Text>
            <View style={{ flex: 1 }} />
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>esc</Text>
          </View>

          {/* Filter */}
          <View style={{ paddingHorizontal: 18, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border }}>
            <View style={{ height: 32, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: 5 }}>
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>filter:</Text>
              <TextInput
                value={filter}
                onChangeText={setFilter}
                placeholder="cost"
                placeholderTextColor={C.fg3}
                style={{ flex: 1, fontFamily: mono(400), fontSize: 12, color: C.fg, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}) }}
              />
              <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3, paddingHorizontal: 6, paddingVertical: 2, borderWidth: 1, borderColor: C.border, borderRadius: 3 }}>⌘K</Text>
            </View>
          </View>

          {/* Template grid */}
          <ScrollView style={{ maxHeight: 280 }} contentContainerStyle={{ padding: 18, gap: 10, flexDirection: 'row', flexWrap: 'wrap' }}>
            {filteredTemplates.map((tpl) => {
              const sel = tpl.id === picked;
              return (
                <TouchableOpacity
                  key={tpl.id}
                  activeOpacity={0.85}
                  onPress={() => setPicked(tpl.id)}
                  style={{
                    flexBasis: '48%', minWidth: 0,
                    padding: 12, borderRadius: 6,
                    borderWidth: 1, borderColor: sel ? C.accent : C.border,
                    backgroundColor: sel ? C.accentBg : C.panel,
                    flexDirection: 'row', gap: 12, alignItems: 'flex-start',
                  }}
                >
                  <View style={{
                    width: 32, height: 32, borderRadius: 5,
                    backgroundColor: sel ? C.accent : C.panel2,
                    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    <Text style={{ fontFamily: mono(700), fontSize: 16, color: sel ? '#000' : C.fg2 }}>{tpl.icon}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                      <Text style={{ fontSize: 13.5, fontWeight: '700', color: C.fg }}>{tpl.name}</Text>
                      {sel ? (
                        <View style={{ paddingHorizontal: 5, paddingVertical: 1.5, borderRadius: 3, backgroundColor: C.accent }}>
                          <Text style={{ fontFamily: mono(700), fontSize: 9, color: '#000' }}>SELECTED</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={{ fontSize: 11.5, color: C.fg2, marginTop: 2 }}>{tpl.sub}</Text>
                    <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3, marginTop: 7 }} numberOfLines={1}>{tpl.cols}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Spec 017 — date-range + by: params. Always visible regardless of
              template `status`, per AC line 173-174 ("simplifies the layout,
              keeps the UI consistent across templates").
              Spec 018 — variance branches: relabel from/to cells as
              "Prior EOD" / "Current EOD", hide preset chips, hide by:
              toggle (variance is inherently per-item). */}
          <View style={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 14, borderTopWidth: 1, borderTopColor: C.border, gap: 10 }}>
            {isVariance ? (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <View style={{ gap: 3 }}>
                    <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 }}>prior EOD</Text>
                    {editing === 'from' ? (
                      <TextInput
                        autoFocus
                        value={draftFrom}
                        onChangeText={setDraftFrom}
                        onBlur={() => commitDateEdit('from', draftFrom)}
                        onSubmitEditing={() => commitDateEdit('from', draftFrom)}
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
                        accessibilityLabel="Edit prior EOD date"
                        onPress={() => { setDraftFrom(dateRange.from); setEditing('from'); }}
                        style={{ paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: C.border, borderRadius: 4, backgroundColor: C.panel }}
                      >
                        <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg }}>{dateRange.from || 'YYYY-MM-DD'}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, alignSelf: 'flex-end', paddingBottom: 4 }}>→</Text>
                  <View style={{ gap: 3 }}>
                    <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 }}>current EOD</Text>
                    {editing === 'to' ? (
                      <TextInput
                        autoFocus
                        value={draftTo}
                        onChangeText={setDraftTo}
                        onBlur={() => commitDateEdit('to', draftTo)}
                        onSubmitEditing={() => commitDateEdit('to', draftTo)}
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
                        accessibilityLabel="Edit current EOD date"
                        onPress={() => { setDraftTo(dateRange.to); setEditing('to'); }}
                        style={{ paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: C.border, borderRadius: 4, backgroundColor: C.panel }}
                      >
                        <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg }}>{dateRange.to || 'YYYY-MM-DD'}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
                {varianceBlocked ? (
                  <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.danger }}>
                    Not enough EOD history — submit at least two EODs to compute variance.
                  </Text>
                ) : (
                  <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
                    Pick two submitted-EOD dates. Defaults to the most-recent two.
                  </Text>
                )}
              </>
            ) : (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 }}>range</Text>
                  {/* From cell */}
                  {editing === 'from' ? (
                    <TextInput
                      autoFocus
                      value={draftFrom}
                      onChangeText={setDraftFrom}
                      onBlur={() => commitDateEdit('from', draftFrom)}
                      onSubmitEditing={() => commitDateEdit('from', draftFrom)}
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
                      accessibilityLabel="Edit from date"
                      onPress={() => { setDraftFrom(dateRange.from); setEditing('from'); }}
                      style={{ paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: C.border, borderRadius: 4, backgroundColor: C.panel }}
                    >
                      <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg }}>{dateRange.from}</Text>
                    </TouchableOpacity>
                  )}
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>→</Text>
                  {/* To cell */}
                  {editing === 'to' ? (
                    <TextInput
                      autoFocus
                      value={draftTo}
                      onChangeText={setDraftTo}
                      onBlur={() => commitDateEdit('to', draftTo)}
                      onSubmitEditing={() => commitDateEdit('to', draftTo)}
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
                      accessibilityLabel="Edit to date"
                      onPress={() => { setDraftTo(dateRange.to); setEditing('to'); }}
                      style={{ paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: C.border, borderRadius: 4, backgroundColor: C.panel }}
                    >
                      <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg }}>{dateRange.to}</Text>
                    </TouchableOpacity>
                  )}
                </View>
                {/* Preset chips */}
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                  {PRESETS.map((p) => {
                    const sel = dateRange.range === p.id;
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
                {/* by: toggle */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 }}>by</Text>
                  {(['category', 'item'] as const).map((opt) => {
                    const sel = by === opt;
                    return (
                      <TouchableOpacity
                        key={opt}
                        onPress={() => setBy(opt)}
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
                </View>
              </>
            )}
          </View>

          {/* Name input */}
          <View style={{ paddingHorizontal: 18, paddingVertical: 12, borderTopWidth: 1, borderTopColor: C.border }}>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>report name</Text>
            <View style={{ height: 32, paddingHorizontal: 11, justifyContent: 'center', backgroundColor: C.panel, borderWidth: 1, borderColor: C.accent, borderRadius: 5, ...(Platform.OS === 'web' ? ({ boxShadow: `0 0 0 3px ${C.accentBg}` } as any) : {}) }}>
              <TextInput
                value={name}
                onChangeText={setName}
                style={{ fontFamily: mono(400), fontSize: 12.5, color: C.fg, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}) }}
              />
            </View>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3, marginTop: 4 }}>saved to /reports · scope: {(currentStore.name || 'store').toLowerCase()}</Text>
          </View>

          {/* Footer */}
          <View style={{ height: 54, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.panel }}>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>↑↓ pick · ⏎ create · ⌘⏎ create &amp; run</Text>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={onClose} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}>
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>CANCEL</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onCreate}
              accessibilityLabel="Create report"
              style={{
                paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm,
                backgroundColor: C.accent,
                borderWidth: 1, borderColor: C.accent,
                ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : {}),
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.accentFg }}>CREATE  ⏎</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};
