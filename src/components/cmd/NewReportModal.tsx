import React from 'react';
import { View, Text, TouchableOpacity, TextInput, Modal, ScrollView, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { ReportDefinition } from '../../types';
import { TEMPLATES, defaultReportName, findTemplate, Template } from '../../screens/cmd/sections/reports/templates';

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
// All date helpers operate on local Date objects formatted to ISO YYYY-MM-DD
// strings. We do NOT pull in a date-picker library — the modal's manual-edit
// affordance is a plain TextInput validated by `isISODate`. The four preset
// chips compute against today's local date so a user in Eastern time sees
// "Last 30d" ending at their local today, not UTC's.

type PresetId = 'last_30d' | 'this_month' | 'last_full_month' | 'last_90d';

interface DateRange {
  range: PresetId | 'custom';
  from: string;
  to: string;
}

function toISODate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isISODate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  // Reject e.g. "2026-02-31" — JS Date will roll over silently.
  const [y, m, d] = s.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function computePreset(id: PresetId, now: Date = new Date()): { from: string; to: string } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (id === 'last_30d') {
    const from = new Date(today);
    from.setDate(from.getDate() - 30);
    return { from: toISODate(from), to: toISODate(today) };
  }
  if (id === 'this_month') {
    const from = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: toISODate(from), to: toISODate(today) };
  }
  if (id === 'last_full_month') {
    const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const to = new Date(today.getFullYear(), today.getMonth(), 0);
    return { from: toISODate(from), to: toISODate(to) };
  }
  // last_90d
  const from = new Date(today);
  from.setDate(from.getDate() - 90);
  return { from: toISODate(from), to: toISODate(today) };
}

const PRESETS: Array<{ id: PresetId; label: string }> = [
  { id: 'last_30d',        label: 'Last 30d'        },
  { id: 'this_month',      label: 'This month'      },
  { id: 'last_full_month', label: 'Last full month' },
  { id: 'last_90d',        label: 'Last 90d'        },
];

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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialTemplateId, initialName]);

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
    // Spec 017 — params shape: { range, from, to, by }. `range` is the
    // informational preset id (or 'custom'); `from` / `to` are the
    // authoritative ISO dates the RPC reads.
    addReportDefinition({
      storeId: currentStore.id,
      templateId: picked,
      name: name.trim(),
      scope: 'this_store',
      params: {
        range: dateRange.range,
        from:  dateRange.from,
        to:    dateRange.to,
        by,
      },
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
              keeps the UI consistent across templates"). */}
          <View style={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 14, borderTopWidth: 1, borderTopColor: C.border, gap: 10 }}>
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
            <TouchableOpacity onPress={onCreate} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, backgroundColor: C.accent }}>
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: '#000' }}>CREATE  ⏎</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};
