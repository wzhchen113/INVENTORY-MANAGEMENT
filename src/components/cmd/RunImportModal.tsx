import React from 'react';
import { View, Text, TextInput, Modal, TouchableOpacity, ScrollView, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { DiffSummary, commitImport } from '../../lib/csvImport';

interface Props {
  visible: boolean;
  onClose: () => void;
  filename: string;
  diff: DiffSummary | null;
}

const CONFIRM_PHRASE = 'import';

// Centered 680w confirmation modal. Big number + op breakdown +
// "type 'import' to confirm" + RUN IMPORT button.
export const RunImportModal: React.FC<Props> = ({ visible, onClose, filename, diff }) => {
  const C = useCmdColors();
  const addItem = useStore((s) => s.addItem);
  const updateItem = useStore((s) => s.updateItem);
  const currentStore = useStore((s) => s.currentStore);

  const [confirm, setConfirm] = React.useState('');
  const [createAudit, setCreateAudit] = React.useState(true);
  const [notifyChef, setNotifyChef] = React.useState(true);     // STUB — no email system here
  const [pauseAlerts, setPauseAlerts] = React.useState(false);  // STUB — no alert system here

  React.useEffect(() => {
    if (!visible) {
      setConfirm('');
      setCreateAudit(true);
      setNotifyChef(true);
      setPauseAlerts(false);
    }
  }, [visible]);

  const counts = diff?.counts || { create: 0, update: 0, archive: 0, skip: 0 };
  const total = counts.create + counts.update + counts.archive;
  const canRun = confirm.toLowerCase() === CONFIRM_PHRASE;

  const ops = diff
    ? [
        { type: 'create',  count: counts.create,  color: C.ok,
          sample: diff.ops.filter((o) => o.type === 'create').slice(0, 3).map((o) => o.payload?.name || '—') },
        { type: 'update',  count: counts.update,  color: C.info,
          sample: diff.ops.filter((o) => o.type === 'update').slice(0, 3).map((o) => o.existing?.name || '—') },
        { type: 'archive', count: counts.archive, color: C.warn,
          sample: diff.ops.filter((o) => o.type === 'archive').slice(0, 3).map((o) => o.existing?.name || '—') },
        { type: 'skip',    count: counts.skip,    color: C.fg3,
          sample: diff.ops.filter((o) => o.type === 'skip').slice(0, 3).map((o) => o.reason || '—') },
      ]
    : [];

  const onRun = () => {
    if (!canRun || !diff) return;
    const result = commitImport(diff, { addItem, updateItem, storeId: currentStore.id });
    const summary = `created ${result.created} · updated ${result.updated}` + (result.archiveSkipped > 0 ? ` · ${result.archiveSkipped} archive deferred` : '');
    Toast.show({ type: 'success', text1: 'Import complete', text2: summary });
    onClose();
  };

  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); e.preventDefault(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canRun) { onRun(); e.preventDefault(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, canRun, diff]);

  if (!visible || !diff) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.40)', alignItems: 'center', paddingTop: '10%' }}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{ width: 680, backgroundColor: C.bg, borderWidth: 1, borderColor: C.borderStrong, borderRadius: 8, overflow: 'hidden', ...(Platform.OS === 'web' ? ({ boxShadow: '0 16px 48px rgba(0,0,0,0.30)' } as any) : {}) }}>
          {/* Header */}
          <View style={{ height: 44, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.panel }}>
            <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.fg }}>
              <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.bg }}>RUN</Text>
            </View>
            <Text style={{ fontWeight: '600', fontSize: 13.5, color: C.fg }}>confirm import</Text>
            <View style={{ flex: 1 }} />
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>esc</Text>
          </View>

          {/* Big number */}
          <View style={{ paddingHorizontal: 22, paddingTop: 18, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: 'row', alignItems: 'baseline', gap: 14 }}>
            <Text style={{ fontFamily: mono(700), fontSize: 48, color: C.fg, letterSpacing: -1 }}>{total}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: C.fg }}>changes will be applied</Text>
              <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, marginTop: 2 }}>{filename} → {(currentStore.name || 'store').toLowerCase()}</Text>
            </View>
            <View style={{ paddingHorizontal: 9, paddingVertical: 4, borderRadius: 4, backgroundColor: C.warnBg }}>
              <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.warn, letterSpacing: 0.4 }}>NOT REVERSIBLE</Text>
            </View>
          </View>

          {/* Op breakdown */}
          <View style={{ paddingHorizontal: 22, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border }}>
            {ops.map((o, i) => (
              <View key={o.type} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 9, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
                <Text style={{ fontFamily: mono(700), fontSize: 11, color: o.color, letterSpacing: 0.5, textTransform: 'uppercase', width: 80 }}>{o.type}</Text>
                <Text style={{ fontFamily: mono(700), fontSize: 18, color: C.fg, width: 38, textAlign: 'right' }}>{o.count}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, flex: 1 }} numberOfLines={1}>
                  {o.sample.length === 0 ? '—' : o.sample.join(' · ')}{o.count > o.sample.length ? ` · +${o.count - o.sample.length} more` : ''}
                </Text>
              </View>
            ))}
            {counts.archive > 0 ? (
              <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.warn, marginTop: 6 }}>
                ● archive ops are surfaced in the diff but deferred — soft-delete column (is_archived) not yet in schema
              </Text>
            ) : null}
          </View>

          {/* Options */}
          <View style={{ paddingHorizontal: 22, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border, gap: 7 }}>
            {[
              { v: createAudit, set: setCreateAudit, k: 'create_audit_entry', d: 'log who/when/diff to audit log' },
              { v: notifyChef,  set: setNotifyChef,  k: 'notify_chef',          d: 'email Maria G. when complete (stub: no mailer)' },
              { v: pauseAlerts, set: setPauseAlerts, k: 'pause_low_stock_alerts', d: 'until next EOD count finishes (stub: no alert system)' },
            ].map((f) => (
              <TouchableOpacity key={f.k} activeOpacity={0.85} onPress={() => f.set(!f.v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ width: 14, height: 14, borderRadius: 3, borderWidth: 1, borderColor: f.v ? C.accent : C.borderStrong, backgroundColor: f.v ? C.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                  {f.v ? <Text style={{ fontSize: 9, color: '#000', fontFamily: mono(700) }}>✓</Text> : null}
                </View>
                <Text style={{ fontFamily: mono(600), fontSize: 11.5, color: C.fg }}>{f.k}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>· {f.d}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Type-to-confirm + actions */}
          <View style={{ paddingHorizontal: 22, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.panel }}>
            <View style={{ gap: 3 }}>
              <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                type "{CONFIRM_PHRASE}" to confirm
              </Text>
              <View style={{ width: 160, height: 28, paddingHorizontal: 9, justifyContent: 'center', backgroundColor: C.panel2, borderWidth: 1, borderColor: canRun ? C.accent : C.border, borderRadius: 4, ...(canRun && Platform.OS === 'web' ? ({ boxShadow: `0 0 0 3px ${C.accentBg}` } as any) : {}) }}>
                <TextInput
                  value={confirm}
                  onChangeText={setConfirm}
                  placeholder=""
                  style={{ fontFamily: mono(400), fontSize: 12.5, color: C.fg, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}) }}
                />
              </View>
            </View>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={onClose} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}>
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>CANCEL  esc</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onRun} disabled={!canRun} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, backgroundColor: canRun ? C.accent : C.panel2, opacity: canRun ? 1 : 0.6 }}>
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: canRun ? '#000' : C.fg3 }}>RUN IMPORT  ⌘⏎</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};
