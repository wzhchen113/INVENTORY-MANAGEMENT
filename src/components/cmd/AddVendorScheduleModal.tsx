import React from 'react';
import { View, Text, TextInput, Modal, TouchableOpacity, Platform, ScrollView } from 'react-native';
import { useCmdColors } from '../../theme/colors';
import { sans, mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { Vendor } from '../../types';

interface Props {
  visible: boolean;
  /** TitleCase day, e.g. "Thursday". Shown in the meta strip. */
  day: string;
  /** Vendor IDs already scheduled for (this store, this day) — excluded from results. */
  excludedVendorIds: Set<string>;
  onClose: () => void;
  /** Fired with the chosen vendor (full record so the caller can persist
   *  vendorName + deliveryDay alongside the id). */
  onAdd: (vendor: Vendor) => void;
}

// Modeled on AddCountModal — same modal shell + ↑↓⏎ keyboard wiring,
// but scoped to picking a vendor to add to the day's order schedule.
// Lists only vendors NOT currently scheduled for (store, day); brand
// scoping is implicit because `useStore.vendors` is already brand-filtered
// at load time.
export const AddVendorScheduleModal: React.FC<Props> = ({ visible, day, excludedVendorIds, onClose, onAdd }) => {
  const C = useCmdColors();
  const vendors = useStore((s) => s.vendors);

  const [query, setQuery] = React.useState('');
  const [highlightedIdx, setHighlightedIdx] = React.useState(0);
  const inputRef = React.useRef<TextInput>(null);

  React.useEffect(() => {
    if (visible) {
      setQuery('');
      setHighlightedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [visible]);

  const matches: Vendor[] = React.useMemo(() => {
    if (!visible) return [];
    const q = query.trim().toLowerCase();
    return vendors
      .filter((v) => !excludedVendorIds.has(v.id))
      .filter((v) => !q || v.name.toLowerCase().includes(q))
      .slice(0, 20);
  }, [vendors, excludedVendorIds, query, visible]);

  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        setHighlightedIdx((i) => Math.min(i + 1, Math.max(0, matches.length - 1)));
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        setHighlightedIdx((i) => Math.max(0, i - 1));
        e.preventDefault();
      } else if (e.key === 'Enter') {
        const sel = matches[highlightedIdx];
        if (sel) {
          onAdd(sel);
          onClose();
        }
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, matches, highlightedIdx, onAdd, onClose]);

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', paddingTop: '14%' }}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{ width: 560, backgroundColor: C.panel, borderWidth: 1, borderColor: C.borderStrong, borderRadius: 8, ...(Platform.OS === 'web' ? ({ boxShadow: '0 16px 48px rgba(0,0,0,0.30)' } as any) : {}), overflow: 'hidden' }}>
          {/* Search input */}
          <View style={{ paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.accent }}>+&gt;</Text>
            <TextInput
              ref={inputRef}
              value={query}
              onChangeText={(v) => { setQuery(v); setHighlightedIdx(0); }}
              placeholder="search vendors to add to this day…"
              placeholderTextColor={C.fg3}
              style={{
                flex: 1, fontFamily: mono(400), fontSize: 15, color: C.fg, letterSpacing: -0.1,
                ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
              }}
            />
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3, paddingHorizontal: 7, paddingVertical: 2, borderWidth: 1, borderColor: C.border, borderRadius: 3 }}>esc</Text>
          </View>

          {/* Meta strip */}
          <View style={{ paddingHorizontal: 16, paddingVertical: 7, backgroundColor: C.panel2, borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>scope:</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg }}>{day.toLowerCase()}</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>·</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{excludedVendorIds.size} already scheduled</Text>
            <View style={{ flex: 1 }} />
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{matches.length} matches</Text>
          </View>

          {/* Result list */}
          <ScrollView style={{ maxHeight: 380 }}>
            {matches.length === 0 ? (
              <View style={{ padding: 24, alignItems: 'center' }}>
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                  {query ? 'no matches — try a different term' : 'all vendors are already scheduled for this day'}
                </Text>
              </View>
            ) : (
              matches.map((v, i) => {
                const sel = i === highlightedIdx;
                return (
                  <TouchableOpacity
                    key={v.id}
                    onPress={() => { onAdd(v); onClose(); }}
                    style={{
                      paddingHorizontal: 16, paddingVertical: 9,
                      flexDirection: 'row', alignItems: 'center', gap: 14,
                      backgroundColor: sel ? C.accentBg : 'transparent',
                      borderLeftWidth: 2, borderLeftColor: sel ? C.accent : 'transparent',
                      borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border,
                    }}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg }} numberOfLines={1}>{v.name}</Text>
                      <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3, marginTop: 2 }}>
                        {(v.categories || []).join(', ').toLowerCase() || 'no categories'}
                        {v.orderCutoffTime ? ` · cutoff ${v.orderCutoffTime}` : ''}
                      </Text>
                    </View>
                    {v.leadTimeDays != null ? (
                      <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>lead {v.leadTimeDays}d</Text>
                    ) : null}
                    {sel ? <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.accent }}>⏎ add</Text> : null}
                  </TouchableOpacity>
                );
              })
            )}
          </ScrollView>

          {/* Footer */}
          <View style={{ paddingHorizontal: 16, paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.border, flexDirection: 'row', gap: 14 }}>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}><Text style={{ color: C.fg2 }}>↑↓</Text> nav</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}><Text style={{ color: C.fg2 }}>⏎</Text> add to schedule</Text>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};
