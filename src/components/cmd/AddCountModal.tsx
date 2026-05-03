import React from 'react';
import { View, Text, TextInput, Modal, TouchableOpacity, Platform, ScrollView } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { sans, mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { InventoryItem } from '../../types';

interface Match {
  item: InventoryItem;
  vendor: string;
}

interface Props {
  visible: boolean;
  /** Items already showing in the current EOD worksheet — excluded from results. */
  excludedItemIds: Set<string>;
  /** Optional vendor scope chip ("BJS" / "any"). When set, narrows matches to
      items belonging to that vendor. */
  vendorName?: string;
  onClose: () => void;
  /** Fired with the chosen item id; jump=true on ⇧⏎ ("add & jump"). */
  onAdd: (itemId: string, jump: boolean) => void;
}

// Quick-add palette: search items not currently in the day's count, ⏎
// adds, ⇧⏎ adds + jumps focus to that item's qty input. Same modal +
// keyboard shape as CommandPalette but scoped to inventory.
export const AddCountModal: React.FC<Props> = ({ visible, excludedItemIds, vendorName, onClose, onAdd }) => {
  const C = useCmdColors();
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);

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

  const matches: Match[] = React.useMemo(() => {
    if (!visible) return [];
    const q = query.trim().toLowerCase();
    return inventory
      .filter((i) => i.storeId === currentStore.id)
      .filter((i) => !excludedItemIds.has(i.id))
      .filter((i) => !vendorName || i.vendorName === vendorName)
      .filter((i) => !q || i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q))
      .slice(0, 10)
      .map((item) => ({ item, vendor: item.vendorName || '—' }));
  }, [inventory, currentStore.id, excludedItemIds, vendorName, query, visible]);

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
          onAdd(sel.item.id, e.shiftKey);
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
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{ width: 680, backgroundColor: C.panel, borderWidth: 1, borderColor: C.borderStrong, borderRadius: 8, ...(Platform.OS === 'web' ? ({ boxShadow: '0 16px 48px rgba(0,0,0,0.30)' } as any) : {}), overflow: 'hidden' }}>
          {/* Search input */}
          <View style={{ paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.accent }}>+&gt;</Text>
            <TextInput
              ref={inputRef}
              value={query}
              onChangeText={(v) => { setQuery(v); setHighlightedIdx(0); }}
              placeholder="search ingredients to add to count…"
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
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg }}>this count</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>·</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>vendor:</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg }}>{vendorName || 'any'}</Text>
            <View style={{ flex: 1 }} />
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{matches.length} matches</Text>
          </View>

          {/* Result list */}
          <ScrollView style={{ maxHeight: 380 }}>
            {matches.length === 0 ? (
              <View style={{ padding: 24, alignItems: 'center' }}>
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                  {query ? 'no matches — try a different term' : 'all items in this scope are already counted'}
                </Text>
              </View>
            ) : (
              matches.map((m, i) => {
                const sel = i === highlightedIdx;
                return (
                  <TouchableOpacity
                    key={m.item.id}
                    onPress={() => { onAdd(m.item.id, false); onClose(); }}
                    style={{
                      paddingHorizontal: 16, paddingVertical: 9,
                      flexDirection: 'row', alignItems: 'center', gap: 14,
                      backgroundColor: sel ? C.accentBg : 'transparent',
                      borderLeftWidth: 2, borderLeftColor: sel ? C.accent : 'transparent',
                      borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border,
                    }}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg }} numberOfLines={1}>{m.item.name}</Text>
                      <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3, marginTop: 2 }}>
                        {m.item.id.slice(0, 8)} · {m.item.category.toLowerCase()}
                      </Text>
                    </View>
                    <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>par {m.item.parLevel} {m.item.unit}</Text>
                    <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3, backgroundColor: C.panel2 }}>
                      <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg2 }}>{m.vendor}</Text>
                    </View>
                    {sel ? <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.accent }}>⏎ add</Text> : null}
                  </TouchableOpacity>
                );
              })
            )}
          </ScrollView>

          {/* Footer */}
          <View style={{ paddingHorizontal: 16, paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.border, flexDirection: 'row', gap: 14 }}>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}><Text style={{ color: C.fg2 }}>↑↓</Text> nav</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}><Text style={{ color: C.fg2 }}>⏎</Text> add to count</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}><Text style={{ color: C.fg2 }}>⇧⏎</Text> add &amp; jump</Text>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};
