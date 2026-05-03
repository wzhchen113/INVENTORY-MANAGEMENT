import React from 'react';
import { View, Text, ScrollView, Modal, TouchableOpacity, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { toCSV, downloadCSV } from '../../utils';
import { SectionCaption } from './SectionCaption';
import { InventoryItem } from '../../types';

interface ColumnDef {
  key: string;
  type: 'string' | 'enum' | 'decimal' | 'currency' | 'datetime';
  /** How to extract the value from an InventoryItem. */
  pick: (i: InventoryItem) => string | number;
}

const COLUMN_DEFS: ColumnDef[] = [
  { key: 'sku',        type: 'string',   pick: (i) => i.id.slice(0, 11) },
  { key: 'name',       type: 'string',   pick: (i) => i.name },
  { key: 'category',   type: 'enum',     pick: (i) => i.category },
  { key: 'unit',       type: 'string',   pick: (i) => i.unit },
  { key: 'on_hand',    type: 'decimal',  pick: (i) => i.currentStock },
  { key: 'par',        type: 'decimal',  pick: (i) => i.parLevel },
  { key: 'last_cost',  type: 'currency', pick: (i) => i.costPerUnit },
  { key: 'value',      type: 'currency', pick: (i) => (i.currentStock * (i.costPerUnit || 0)).toFixed(2) },
  { key: 'vendor',     type: 'string',   pick: (i) => i.vendorName || '' },
  { key: 'updated_at', type: 'datetime', pick: (i) => i.lastUpdatedAt || '' },
  { key: 'notes',      type: 'string',   pick: () => '' },
];

const DEFAULT_ON = new Set(['sku', 'name', 'category', 'unit', 'on_hand', 'par', 'last_cost', 'value']);
const RANGES = ['7d', '30d', '90d', 'wtd', 'mtd', 'ytd', 'custom'];

interface Props {
  visible: boolean;
  onClose: () => void;
}

// Right-anchored 520w drawer. Scope/range pills are visual today; column
// checkboxes drive the actual download. Calls existing toCSV/downloadCSV
// from src/utils.
export const ExportCsvDrawer: React.FC<Props> = ({ visible, onClose }) => {
  const C = useCmdColors();
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);

  const [enabled, setEnabled] = React.useState<Set<string>>(new Set(DEFAULT_ON));
  const [range, setRange] = React.useState('30d');
  const [includeHeader, setIncludeHeader] = React.useState(true);
  const [maskCosts, setMaskCosts] = React.useState(false);

  const rows = React.useMemo(
    () => inventory.filter((i) => i.storeId === currentStore.id),
    [inventory, currentStore.id],
  );
  const enabledCols = COLUMN_DEFS.filter((c) => enabled.has(c.key));
  const sizeKb = Math.max(1, Math.round((enabledCols.length * rows.length * 16) / 1024));

  const onDownload = () => {
    if (rows.length === 0 || enabledCols.length === 0) {
      Toast.show({ type: 'error', text1: 'Nothing to export' });
      return;
    }
    const data = rows.map((r) => {
      const obj: Record<string, any> = {};
      for (const col of enabledCols) {
        let v = col.pick(r);
        if (maskCosts && (col.key === 'last_cost' || col.key === 'value')) v = '—';
        obj[col.key] = v;
      }
      return obj;
    });
    let csv = toCSV(data, enabledCols.map((c) => c.key));
    if (!includeHeader) csv = csv.split('\n').slice(1).join('\n');
    const fname = `inventory_${(currentStore.name || 'store').toLowerCase().replace(/\s+/g, '-')}_${new Date().toISOString().slice(0, 10)}.csv`;
    downloadCSV(fname, csv);
    Toast.show({ type: 'success', text1: 'Downloaded', text2: `${data.length} rows · ${enabledCols.length} columns` });
    onClose();
  };

  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); e.preventDefault(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { onDownload(); e.preventDefault(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, enabled, includeHeader, maskCosts]);

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.32)', flexDirection: 'row', justifyContent: 'flex-end' }}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{ width: 520, height: '100%', backgroundColor: C.bg, borderLeftWidth: 1, borderLeftColor: C.borderStrong, ...(Platform.OS === 'web' ? ({ boxShadow: '-12px 0 40px rgba(0,0,0,0.18)' } as any) : {}) }}>
          {/* Header */}
          <View style={{ height: 44, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.panel }}>
            <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.fg }}>
              <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.bg }}>EXPORT</Text>
            </View>
            <Text style={{ fontWeight: '600', fontSize: 13.5, color: C.fg }}>inventory.csv</Text>
            <View style={{ flex: 1 }} />
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>esc</Text>
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 18 }}>
            <SectionCaption tone="fg3" size={9.5}>SCOPE</SectionCaption>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 8, marginBottom: 14 }}>
              <View style={{ flex: 1, height: 32, paddingHorizontal: 11, justifyContent: 'center', backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm }}>
                <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg }}>{(currentStore.name || 'store').toLowerCase()}</Text>
              </View>
              <View style={{ flex: 1, height: 32, paddingHorizontal: 11, justifyContent: 'center', backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.sm }}>
                <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg }}>csv (utf-8)</Text>
              </View>
            </View>

            <SectionCaption tone="fg3" size={9.5}>RANGE</SectionCaption>
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, marginBottom: 14, flexWrap: 'wrap' }}>
              {RANGES.map((p) => {
                const sel = p === range;
                return (
                  <TouchableOpacity key={p} onPress={() => setRange(p)} style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99, borderWidth: 1, borderColor: sel ? C.accent : C.border, backgroundColor: sel ? C.accentBg : C.panel }}>
                    <Text style={{ fontFamily: mono(sel ? 700 : 500), fontSize: 11, color: sel ? C.accent : C.fg2 }}>{p}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <SectionCaption tone="fg3" size={9.5}>COLUMNS</SectionCaption>
              <View style={{ flex: 1 }} />
              <Text style={{ fontFamily: mono(500), fontSize: 9.5, color: C.fg3 }}>{enabledCols.length} of {COLUMN_DEFS.length}</Text>
            </View>
            <View style={{ marginTop: 4, marginBottom: 14, backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.md, overflow: 'hidden' }}>
              {COLUMN_DEFS.map((col, i) => {
                const on = enabled.has(col.key);
                return (
                  <TouchableOpacity
                    key={col.key}
                    activeOpacity={0.85}
                    onPress={() => setEnabled((prev) => {
                      const next = new Set(prev);
                      if (next.has(col.key)) next.delete(col.key); else next.add(col.key);
                      return next;
                    })}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 10,
                      paddingHorizontal: 11, paddingVertical: 8,
                      borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed',
                      opacity: on ? 1 : 0.5,
                    }}
                  >
                    <View style={{ width: 14, height: 14, borderRadius: 3, borderWidth: 1, borderColor: on ? C.accent : C.borderStrong, backgroundColor: on ? C.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                      {on ? <Text style={{ fontSize: 9, color: '#000', fontFamily: mono(700) }}>✓</Text> : null}
                    </View>
                    <Text style={{ fontFamily: mono(600), fontSize: 12, color: C.fg, flex: 1 }}>{col.key}</Text>
                    <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{col.type}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <SectionCaption tone="fg3" size={9.5}>OPTIONS</SectionCaption>
            <View style={{ marginTop: 4, gap: 6 }}>
              {[
                { k: 'include_header',       v: includeHeader, set: setIncludeHeader, label: 'include_header' },
                { k: 'mask_costs_for_staff', v: maskCosts,     set: setMaskCosts,     label: 'mask_costs_for_staff' },
              ].map((f) => (
                <TouchableOpacity key={f.k} activeOpacity={0.85} onPress={() => f.set(!f.v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}>
                  <View style={{ width: 14, height: 14, borderRadius: 3, borderWidth: 1, borderColor: f.v ? C.accent : C.borderStrong, backgroundColor: f.v ? C.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                    {f.v ? <Text style={{ fontSize: 9, color: '#000', fontFamily: mono(700) }}>✓</Text> : null}
                  </View>
                  <Text style={{ fontFamily: mono(600), fontSize: 11.5, color: C.fg }}>{f.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>

          {/* Footer */}
          <View style={{ height: 54, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.panel }}>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>est. {rows.length} rows · ~{sizeKb} KB</Text>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={onClose} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}>
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>CANCEL</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onDownload} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, backgroundColor: C.accent }}>
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: '#000' }}>DOWNLOAD  ⌘⏎</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};
