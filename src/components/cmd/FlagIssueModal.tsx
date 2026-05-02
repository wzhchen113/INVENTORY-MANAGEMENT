import React from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { SectionCaption } from './SectionCaption';
import { KbdHint } from './KbdHint';
import { useStore } from '../../store/useStore';
import { supabase } from '../../lib/supabase';

const FLAG_TYPES: { id: 'damage' | 'quality' | 'out' | 'wrong-item' | 'other'; label: string }[] = [
  { id: 'damage',     label: 'damage' },
  { id: 'quality',    label: 'quality' },
  { id: 'out',        label: 'out' },
  { id: 'wrong-item', label: 'wrong-item' },
  { id: 'other',      label: 'other' },
];

interface Props {
  visible: boolean;
  onClose: () => void;
  itemId: string;
  itemName: string;
}

// Minimal form for FLAG ISSUE per design handoff §"Interactions". Inserts
// into the local flags table (added via the sibling worktree's
// 20260502190001_flags_table.sql migration). Photo upload UI is intentionally
// deferred — Storage wiring is a separate ticket; the column exists.
export const FlagIssueModal: React.FC<Props> = ({ visible, onClose, itemId, itemName }) => {
  const C = useCmdColors();
  const currentStore = useStore((s) => s.currentStore);
  const currentUser = useStore((s) => s.currentUser);
  const [type, setType] = React.useState<typeof FLAG_TYPES[number]['id']>('damage');
  const [note, setNote] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (visible) {
      setType('damage');
      setNote('');
      setSubmitting(false);
    }
  }, [visible]);

  // Web-only Escape-to-close so keyboard users aren't stuck inside.
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  const submit = async () => {
    if (!currentUser?.id || !currentStore?.id) {
      Toast.show({ type: 'error', text1: 'Not signed in' });
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.from('flags').insert({
      store_id: currentStore.id,
      item_id: itemId,
      user_id: currentUser.id,
      type,
      note: note.trim() || null,
    });
    setSubmitting(false);
    if (error) {
      Toast.show({ type: 'error', text1: 'Flag failed', text2: error.message });
      return;
    }
    Toast.show({ type: 'success', text1: 'Flag submitted', text2: `${type} · ${itemName}` });
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 16 }}
        activeOpacity={1}
        onPress={onClose}
      >
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{ width: '100%', maxWidth: 480 }}>
          <View
            style={{
              backgroundColor: C.panel,
              borderRadius: CmdRadius.lg,
              borderWidth: 1,
              borderColor: C.borderStrong,
              overflow: 'hidden',
            }}
          >
            {/* Header */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 14,
                paddingVertical: 12,
                borderBottomWidth: 1,
                borderBottomColor: C.border,
                gap: 10,
              }}
            >
              <SectionCaption tone="fg3" size={10.5}>flag_issue.tsx</SectionCaption>
              <View style={{ flex: 1 }} />
              <KbdHint size="sm">esc</KbdHint>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={{ fontFamily: mono(400), fontSize: 16, color: C.fg2 }}>✕</Text>
              </TouchableOpacity>
            </View>

            <View style={{ padding: 14, gap: 14 }}>
              <Text style={{ fontFamily: sans(700), fontSize: 18, color: C.fg, letterSpacing: -0.3 }}>
                Flag issue · {itemName}
              </Text>

              {/* Type picker */}
              <View style={{ gap: 6 }}>
                <SectionCaption tone="fg3" size={10}>type</SectionCaption>
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  {FLAG_TYPES.map((t) => {
                    const sel = t.id === type;
                    return (
                      <TouchableOpacity
                        key={t.id}
                        onPress={() => setType(t.id)}
                        style={{
                          paddingHorizontal: 10,
                          paddingVertical: 5,
                          borderRadius: CmdRadius.md,
                          borderWidth: 1,
                          borderColor: sel ? C.accent : C.border,
                          backgroundColor: sel ? C.accentBg : C.panel2,
                        }}
                      >
                        <Text
                          style={{
                            fontFamily: mono(600),
                            fontSize: 11,
                            color: sel ? C.accent : C.fg2,
                          }}
                        >
                          {t.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* Note */}
              <View style={{ gap: 6 }}>
                <SectionCaption tone="fg3" size={10}>note (optional)</SectionCaption>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="What happened? Where in walk-in / storage?"
                  placeholderTextColor={C.fg3}
                  multiline
                  numberOfLines={3}
                  style={{
                    fontFamily: mono(400),
                    fontSize: 12,
                    color: C.fg,
                    backgroundColor: C.panel2,
                    borderRadius: CmdRadius.md,
                    borderWidth: 1,
                    borderColor: C.border,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    minHeight: 70,
                    textAlignVertical: 'top',
                    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
                  }}
                />
              </View>

              {/* Actions */}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                <TouchableOpacity
                  onPress={onClose}
                  style={{
                    flex: 1,
                    paddingVertical: 10,
                    alignItems: 'center',
                    borderRadius: CmdRadius.md,
                    borderWidth: 1,
                    borderColor: C.borderStrong,
                    backgroundColor: C.panel,
                  }}
                >
                  <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg, letterSpacing: 0.5 }}>
                    CANCEL
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={submit}
                  disabled={submitting}
                  style={{
                    flex: 1,
                    paddingVertical: 10,
                    alignItems: 'center',
                    borderRadius: CmdRadius.md,
                    backgroundColor: C.accent,
                    opacity: submitting ? 0.6 : 1,
                  }}
                >
                  <Text style={{ fontFamily: mono(700), fontSize: 11, color: '#000', letterSpacing: 0.5 }}>
                    {submitting ? 'SUBMITTING…' : 'SUBMIT FLAG'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};
