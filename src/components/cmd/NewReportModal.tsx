import React from 'react';
import { View, Text, TouchableOpacity, TextInput, Modal, ScrollView, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { ReportDefinition } from '../../types';

interface Template {
  id: ReportDefinition['templateId'];
  name: string;
  sub: string;
  cols: string;
  icon: string;
}

const TEMPLATES: Template[] = [
  { id: 'variance', name: 'Variance',             sub: 'expected vs counted',          cols: 'item · expected · counted · Δ · $impact', icon: 'Δ' },
  { id: 'waste',    name: 'Waste cost',           sub: 'by reason & category',         cols: 'date · item · qty · reason · $cost',      icon: '⌫' },
  { id: 'cogs',     name: 'COGS by category',     sub: 'over time',                    cols: 'date · category · revenue · cogs · margin', icon: '%' },
  { id: 'vendor',   name: 'Vendor performance',   sub: 'on-time, fill-rate',           cols: 'vendor · orders · fill % · late · $',     icon: '⊡' },
  { id: 'velocity', name: 'Item velocity',        sub: 'turn rate per ingredient',     cols: 'item · usage/wk · turns · DOH',           icon: '≋' },
  { id: 'custom',   name: 'Custom SQL',           sub: 'write your own',               cols: '-- SELECT … FROM inventory',              icon: '>' },
];

interface Props {
  visible: boolean;
  onClose: () => void;
}

export const NewReportModal: React.FC<Props> = ({ visible, onClose }) => {
  const C = useCmdColors();
  const currentStore = useStore((s) => s.currentStore);
  const currentUser = useStore((s) => s.currentUser);
  const addReportDefinition = useStore((s) => s.addReportDefinition);

  const [picked, setPicked] = React.useState<ReportDefinition['templateId']>('variance');
  const [name, setName] = React.useState('Variance — May 2026');
  const [filter, setFilter] = React.useState('');

  React.useEffect(() => {
    if (!visible) {
      setPicked('variance');
      setName('Variance — May 2026');
      setFilter('');
    }
  }, [visible]);

  const filteredTemplates = React.useMemo(() => {
    if (!filter.trim()) return TEMPLATES;
    const q = filter.toLowerCase();
    return TEMPLATES.filter((t) => t.name.toLowerCase().includes(q) || t.sub.toLowerCase().includes(q));
  }, [filter]);

  const onCreate = () => {
    if (!name.trim()) { Toast.show({ type: 'error', text1: 'Name required' }); return; }
    addReportDefinition({
      storeId: currentStore.id,
      templateId: picked,
      name: name.trim(),
      scope: 'this_store',
      params: {},
      createdBy: currentUser?.id,
    });
    Toast.show({ type: 'success', text1: 'Report saved', text2: name });
    onClose();
  };

  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); e.preventDefault(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { onCreate(); e.preventDefault(); }
      else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        // Plain Enter creates too — design says "↑↓ pick · ⏎ create"
        onCreate();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, picked, name]);

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
          <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ padding: 18, gap: 10, flexDirection: 'row', flexWrap: 'wrap' }}>
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
