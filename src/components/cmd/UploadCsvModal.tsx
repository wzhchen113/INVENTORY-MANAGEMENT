import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, Modal, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { ColumnMapping, parseCsv, inferColumnMapping } from '../../lib/csvImport';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called once the user clicks PREVIEW IMPORT — hands off to RunImportModal. */
  onContinue: (file: File, rows: any[], mapping: ColumnMapping[]) => void;
}

const matchToColors = (m: ColumnMapping['match'], C: any) => {
  if (m === 'auto') return { fg: C.ok, bg: C.okBg };
  if (m === 'fuzzy') return { fg: C.warn, bg: C.warnBg };
  if (m === 'manual') return { fg: C.info, bg: C.infoBg };
  return { fg: C.fg3, bg: C.panel2 };
};

// Centered modal (880w). Two states: empty (drop a file) → file ribbon +
// column-mapping table.
export const UploadCsvModal: React.FC<Props> = ({ visible, onClose, onContinue }) => {
  const C = useCmdColors();
  const [file, setFile] = React.useState<File | null>(null);
  const [rows, setRows] = React.useState<any[]>([]);
  const [mapping, setMapping] = React.useState<ColumnMapping[]>([]);
  const [parsing, setParsing] = React.useState(false);

  React.useEffect(() => {
    if (!visible) {
      setFile(null);
      setRows([]);
      setMapping([]);
      setParsing(false);
    }
  }, [visible]);

  const handleFile = async (f: File) => {
    setFile(f);
    setParsing(true);
    try {
      const res = await parseCsv(f);
      const headers = (res.meta.fields as string[]) || [];
      setRows(res.data);
      setMapping(inferColumnMapping(headers, res.data));
    } catch (e: any) {
      Toast.show({ type: 'error', text1: 'CSV parse failed', text2: e?.message || String(e) });
      setFile(null);
    } finally {
      setParsing(false);
    }
  };

  // Web file picker
  const openPicker = () => {
    if (Platform.OS !== 'web') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv';
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) handleFile(f);
    };
    input.click();
  };

  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); e.preventDefault(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  if (!visible) return null;

  const fuzzyCount = mapping.filter((m) => m.match === 'fuzzy').length;
  const manualCount = mapping.filter((m) => m.match === 'manual').length;
  const sizeKb = file ? Math.round(file.size / 1024 * 10) / 10 : 0;
  const colCount = (mapping.length);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.40)', alignItems: 'center', paddingTop: '7%' }}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{ width: 880, maxHeight: '88%', backgroundColor: C.bg, borderWidth: 1, borderColor: C.borderStrong, borderRadius: 8, overflow: 'hidden', ...(Platform.OS === 'web' ? ({ boxShadow: '0 16px 48px rgba(0,0,0,0.30)' } as any) : {}) }}>
          {/* Header */}
          <View style={{ height: 44, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.panel }}>
            <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.fg }}>
              <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.bg }}>UPLOAD</Text>
            </View>
            <Text style={{ fontWeight: '600', fontSize: 13.5, color: C.fg }}>
              {file ? 'map columns → ingredient fields' : 'drop a CSV to begin'}
            </Text>
            <View style={{ flex: 1 }} />
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{file ? 'step 2 of 3' : 'step 1 of 3'}</Text>
          </View>

          {!file ? (
            <View style={{ padding: 50, alignItems: 'center', gap: 16 }}>
              <View style={{ width: 80, height: 80, borderRadius: 8, borderWidth: 2, borderColor: C.borderStrong, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontFamily: mono(700), fontSize: 14, color: C.fg2 }}>CSV</Text>
              </View>
              <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2, textAlign: 'center' }}>
                {parsing ? 'parsing…' : 'Click to pick a CSV file from your computer.'}
              </Text>
              <TouchableOpacity onPress={openPicker} style={{ paddingVertical: 8, paddingHorizontal: 16, borderRadius: CmdRadius.sm, backgroundColor: C.accent }}>
                <Text style={{ fontFamily: mono(700), fontSize: 12, color: '#000' }}>BROWSE…</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {/* File ribbon */}
              <View style={{ paddingHorizontal: 18, paddingVertical: 10, backgroundColor: C.panel2, borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ width: 32, height: 32, borderRadius: 5, backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.accent }}>CSV</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: C.fg }}>{file.name}</Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3, marginTop: 2 }}>
                    {colCount} columns · {rows.length} rows · {sizeKb} KB
                  </Text>
                </View>
                <TouchableOpacity onPress={openPicker} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>REPLACE</Text>
                </TouchableOpacity>
              </View>

              {/* Mapping table */}
              <ScrollView style={{ flex: 1, maxHeight: 480 }} contentContainerStyle={{ paddingHorizontal: 18, paddingVertical: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border, borderStyle: 'dashed' }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5, flex: 1.4 }}>csv column</Text>
                  <View style={{ width: 24 }} />
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5, flex: 1.4 }}>maps to</Text>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5, flex: 1.2 }}>sample</Text>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5, width: 80, textAlign: 'right' }}>match</Text>
                </View>
                {mapping.map((m, i) => {
                  const cc = matchToColors(m.match, C);
                  return (
                    <View key={m.csv} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed', opacity: m.match === 'skip' ? 0.55 : 1 }}>
                      <Text style={{ fontFamily: mono(600), fontSize: 12, color: C.fg, flex: 1.4 }}>{m.csv}</Text>
                      <Text style={{ fontFamily: mono(400), fontSize: 13, color: C.fg3, width: 24, textAlign: 'center' }}>→</Text>
                      <View style={{ flex: 1.4, height: 28, paddingHorizontal: 9, justifyContent: 'center', backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: 4, flexDirection: 'row', alignItems: 'center' }}>
                        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: m.field === '(skip)' ? C.fg3 : C.fg, flex: 1 }}>{m.field}</Text>
                        <Text style={{ color: C.fg3, fontFamily: mono(400) }}>▾</Text>
                      </View>
                      <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, flex: 1.2 }} numberOfLines={1}>"{m.sample || ''}"</Text>
                      <View style={{ width: 80, alignItems: 'flex-end' }}>
                        <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: cc.bg }}>
                          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: cc.fg, letterSpacing: 0.4 }}>{m.match.toUpperCase()}</Text>
                        </View>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>

              {/* Footer */}
              <View style={{ height: 54, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.panel }}>
                <Text style={{ fontFamily: mono(400), fontSize: 10, color: fuzzyCount + manualCount > 0 ? C.warn : C.fg3 }}>
                  {fuzzyCount + manualCount === 0 ? '✓ all columns mapped' : `● ${fuzzyCount + manualCount} column${fuzzyCount + manualCount === 1 ? '' : 's'} need${fuzzyCount + manualCount === 1 ? 's' : ''} review`}
                </Text>
                <View style={{ flex: 1 }} />
                <TouchableOpacity onPress={onClose} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>CANCEL</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => onContinue(file, rows, mapping)} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, backgroundColor: C.accent }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 11, color: '#000' }}>PREVIEW IMPORT  →</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};
