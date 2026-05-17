import React from 'react';
import { View, Text, TouchableOpacity, Platform, TextInput, ScrollView } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { ResponsiveSheet } from './ResponsiveSheet';
import { useIsPhone } from '../../theme/breakpoints';
import { copyBrandCatalog } from '../../lib/db';

interface Props {
  visible: boolean;
  onClose: () => void;
}

// Spec 012b §3 — minimal v1 brand-creation form. One field (name).
// Renaming + soft-delete + restore are out of scope for 012b — those
// land in 012c. Per ResponsiveSheet idiom: right-anchored 480w on
// desktop, bottom-sheet on tablet, full-screen on phone.
export const BrandFormDrawer: React.FC<Props> = ({ visible, onClose }) => {
  const C = useCmdColors();
  const isPhone = useIsPhone();
  const createBrand = useStore((s) => s.createBrand);
  const brandsList = useStore((s) => s.brandsList);
  const [name, setName] = React.useState('');
  const [seedFromBrandId, setSeedFromBrandId] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (visible) {
      setName('');
      setSeedFromBrandId(null);
      setSubmitting(false);
    }
  }, [visible]);

  const requiredValid = name.trim().length > 0;
  const seedableBrands = brandsList.filter((b) => !b.deletedAt);

  const handleSave = async () => {
    if (!requiredValid || submitting) return;
    setSubmitting(true);
    const created = await createBrand(name.trim());
    if (created && seedFromBrandId) {
      try {
        const copied = await copyBrandCatalog(seedFromBrandId, created.id);
        Toast.show({
          type: 'success',
          text1: 'Created brand',
          text2: `${created.name} · seeded ${copied} catalog item${copied === 1 ? '' : 's'}`,
        });
      } catch (e: any) {
        Toast.show({
          type: 'error',
          text1: 'Brand created — seed failed',
          text2: e?.message || 'See console for details.',
        });
      }
    } else if (created) {
      Toast.show({ type: 'success', text1: 'Created brand', text2: created.name });
    }
    setSubmitting(false);
    if (created) onClose();
    // Failure path: createBrand already surfaced via notifyBackendError.
    // Keep the drawer open so the operator can retry without retyping.
  };

  // Cmd+S / Cmd+Enter saves, Esc closes. Cleanup #7 — handleSave is held
  // in a ref so the keydown handler always reads the latest closure
  // without re-binding (and without the eslint-disable that masked a real
  // stale-closure bug — typing between renders would otherwise fire the
  // handler with stale form state).
  const handleSaveRef = React.useRef(handleSave);
  handleSaveRef.current = handleSave;
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); e.preventDefault(); }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S' || e.key === 'Enter')) {
        handleSaveRef.current();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  if (!visible) return null;

  const header = (
    <View
      style={{
        height: 44,
        paddingHorizontal: 18,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: C.panel,
      }}
    >
      <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.accent }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.accentFg }}>NEW</Text>
      </View>
      <Text style={{ fontFamily: sans(600), fontSize: 13.5, color: C.fg }} numberOfLines={1}>
        new-brand
      </Text>
      <View style={{ flex: 1 }} />
      <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.warnBg }}>
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.warn }}>● unsaved</Text>
      </View>
      {isPhone ? (
        <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={6}>
          <Text style={{ fontFamily: mono(400), fontSize: 16, color: C.fg2 }}>✕</Text>
        </TouchableOpacity>
      ) : (
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>esc</Text>
      )}
    </View>
  );

  const footer = (
    <View
      style={{
        minHeight: 54,
        paddingHorizontal: 18,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: C.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: C.panel,
        flexWrap: 'wrap',
      }}
    >
      <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
        {requiredValid ? '1/1 required valid' : '0/1 required valid'}
      </Text>
      <View style={{ flex: 1 }} />
      <TouchableOpacity
        onPress={onClose}
        style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>CANCEL</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={handleSave}
        disabled={!requiredValid || submitting}
        style={{
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: CmdRadius.sm,
          backgroundColor: requiredValid && !submitting ? C.accent : C.panel2,
          opacity: requiredValid && !submitting ? 1 : 0.6,
        }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: requiredValid && !submitting ? C.accentFg : C.fg3 }}>
          {submitting ? 'SAVING…' : 'CREATE  ⌘⏎'}
        </Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <ResponsiveSheet
      visible={visible}
      onClose={onClose}
      desktopWidth={480}
      tabletSheetHeight={0.5}
      header={header}
      footer={footer}
      accessibilityLabel="New brand"
    >
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
        <View style={{ gap: 4 }}>
          <Text
            style={{
              fontFamily: mono(700),
              fontSize: 9.5,
              color: C.fg3,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
          >
            Brand name
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Baltimore Seafood"
            placeholderTextColor={C.fg3}
            autoFocus
            style={{
              fontFamily: sans(400),
              fontSize: 14,
              color: C.fg,
              backgroundColor: C.panel2,
              borderWidth: 1,
              borderColor: C.border,
              borderRadius: CmdRadius.sm,
              paddingHorizontal: 10,
              paddingVertical: 9,
              ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
            }}
          />
          <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
            Must be unique. Case-sensitive.
          </Text>
        </View>

        {seedableBrands.length > 0 ? (
          <View style={{ gap: 6 }}>
            <Text
              style={{
                fontFamily: mono(700),
                fontSize: 9.5,
                color: C.fg3,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
              }}
            >
              Seed catalog from existing brand (optional)
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              <TouchableOpacity
                onPress={() => setSeedFromBrandId(null)}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  borderRadius: CmdRadius.sm,
                  borderWidth: 1,
                  borderColor: seedFromBrandId === null ? C.accent : C.border,
                  backgroundColor: seedFromBrandId === null ? C.accentBg : C.panel2,
                }}
              >
                <Text
                  style={{
                    fontFamily: mono(seedFromBrandId === null ? 700 : 500),
                    fontSize: 11,
                    color: seedFromBrandId === null ? C.accent : C.fg2,
                  }}
                >
                  none (start empty)
                </Text>
              </TouchableOpacity>
              {seedableBrands.map((b) => {
                const sel = seedFromBrandId === b.id;
                return (
                  <TouchableOpacity
                    key={b.id}
                    onPress={() => setSeedFromBrandId(b.id)}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                      borderRadius: CmdRadius.sm,
                      borderWidth: 1,
                      borderColor: sel ? C.accent : C.border,
                      backgroundColor: sel ? C.accentBg : C.panel2,
                    }}
                  >
                    <Text
                      style={{
                        fontFamily: mono(sel ? 700 : 500),
                        fontSize: 11,
                        color: sel ? C.accent : C.fg2,
                      }}
                    >
                      {b.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3, lineHeight: 16 }}>
              Copies every catalog ingredient (name, unit, category, costs,
              translations) into the new brand. The two brands stay
              independent after — editing one does not affect the other.
            </Text>
          </View>
        ) : null}

        <View
          style={{
            backgroundColor: C.panel2,
            borderRadius: CmdRadius.sm,
            borderWidth: 1,
            borderColor: C.border,
            padding: 12,
            gap: 6,
          }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>
            What happens next
          </Text>
          <Text style={{ fontFamily: sans(400), fontSize: 12, color: C.fg2, lineHeight: 18 }}>
            A new tenant row is created in the brands table. The brand picker
            updates immediately. To onboard a brand-admin, switch to the new
            brand and use "+ INVITE ADMIN" on the members tab.
          </Text>
        </View>
      </ScrollView>
    </ResponsiveSheet>
  );
};
